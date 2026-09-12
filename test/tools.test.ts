import { describe, expect, it } from "vitest";
import type { ChatPlatformAdapter } from "../src/platforms/types.js";
import { buildSimulationTools } from "../src/agents/simulation-tools.js";
import { buildSynthesisTools } from "../src/agents/synthesis-tools.js";
import { testDatabase, textOf } from "./helpers.js";

function platform(send: ChatPlatformAdapter["sendText"] = async () => ({ platformMessageId: "sent-1" })): ChatPlatformAdapter {
  return {
    id: "fake", status: () => ({ connected: true, selfId: "bot", roles: ["universal"] }),
    sendText: send, syncRoster: async () => undefined, close: async () => undefined,
  };
}

async function execute(tool: any, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  return await tool.execute("call", params, signal);
}

describe("simulation tools", () => {
  it("independently rejects illegal phone operations and duration bounds", async () => {
    const fixture = testDatabase();
    try {
      const [, perform] = buildSimulationTools(fixture.db, platform());
      await expect(execute(perform, { action: "send_messages", messages: ["no"] })).rejects.toThrow(/当前状态/);
      await expect(execute(perform, { action: "idle", durationMinutes: 29 })).rejects.toThrow(/30/);
      const sleeping = await execute(perform, { action: "sleep", durationMinutes: 30 });
      expect(sleeping.terminate).toBe(true);
      expect(fixture.db.getRuntime().mode).toBe("sleeping");
      expect(fixture.db.getRuntime().nextWakeAt).toBeTypeOf("number");
    } finally { fixture.cleanup(); }
  });

  it("opens the phone and chat, loads local history, sends in order, and closes", async () => {
    const fixture = testDatabase();
    const sent: string[] = [];
    try {
      fixture.db.upsertContact({ platform: "onebot", id: "7", name: "Seven", aliases: [], summary: "", importance: "normal", isFriend: true });
      const settings = fixture.db.getSettings();
      settings.value.simulation.messageIntervalMs = 0;
      fixture.db.updateSettings(settings.value, settings.version);
      const [, perform] = buildSimulationTools(fixture.db, platform(async (_target, text) => { sent.push(text); return { platformMessageId: `p-${sent.length}` }; }));
      expect(textOf(await execute(perform, { action: "open_phone" }))).toContain("当前时间");
      await execute(perform, { action: "open_chat", kind: "private", targetId: "7" });
      await execute(perform, { action: "send_messages", messages: ["one", "two"] });
      expect(sent).toEqual(["one", "two"]);
      expect(fixture.db.listMessages({ platform: "onebot", kind: "private", id: "7" }, 10).map((item) => item.deliveryStatus)).toEqual(["sent", "sent"]);
      expect(textOf(await execute(perform, { action: "load_history", count: 9_999 }))).toContain("本地已观测历史");
      await execute(perform, { action: "close_phone" });
      expect(fixture.db.getRuntime().phone.kind).toBe("closed");
    } finally { fixture.cleanup(); }
  });

  it("marks uncertain delivery unknown and never silently retries", async () => {
    const fixture = testDatabase();
    let calls = 0;
    try {
      const [, perform] = buildSimulationTools(fixture.db, platform(async () => { calls += 1; throw new Error("link lost"); }));
      await execute(perform, { action: "open_phone" });
      await execute(perform, { action: "open_chat", kind: "private", targetId: "7" });
      await expect(execute(perform, { action: "send_messages", messages: ["once"] })).rejects.toThrow("发送结果未知");
      expect(calls).toBe(1);
      expect(fixture.db.listMessages({ platform: "onebot", kind: "private", id: "7" }, 10)[0]?.deliveryStatus).toBe("unknown");
    } finally { fixture.cleanup(); }
  });

  it("enforces per-message and aggregate payload limits", async () => {
    const fixture = testDatabase();
    try {
      await execute(buildSimulationTools(fixture.db, platform())[1], { action: "open_phone" });
      const perform = buildSimulationTools(fixture.db, platform())[1];
      await execute(perform, { action: "open_chat", kind: "private", targetId: "7" });
      await expect(execute(perform, { action: "send_messages", messages: ["x".repeat(2_001)] })).rejects.toThrow(/2000/);
      await expect(execute(perform, { action: "send_messages", messages: Array(140).fill("界".repeat(1_000)) })).rejects.toThrow(/256 KiB/);
    } finally { fixture.cleanup(); }
  });
});

describe("synthesis tools", () => {
  it("stages changes until finish, then commits all of them atomically", async () => {
    const fixture = testDatabase();
    try {
      const first = buildSynthesisTools(fixture.db);
      const memory = first.tools.find((item) => item.name === "manage_memory")!;
      await execute(memory, { operation: "upsert", occurredAt: 1, summary: "not committed" });
      expect(fixture.db.listMemories()).toHaveLength(0);
      expect(() => first.staging.commit()).toThrow("finish_synthesis_not_called");

      fixture.db.upsertContact({ platform: "onebot", id: "7", name: "Seven", aliases: [], summary: "old", importance: "priority_plus", isFriend: true });
      const second = buildSynthesisTools(fixture.db);
      await execute(second.tools.find((item) => item.name === "manage_memory")!, { operation: "upsert", id: "m1", occurredAt: 2, summary: "committed" });
      await execute(second.tools.find((item) => item.name === "manage_relationship")!, { operation: "upsert", id: "7", summary: "new" });
      const result = await execute(second.tools.find((item) => item.name === "finish_synthesis")!, { summary: "done" });
      expect(result.terminate).toBe(true);
      second.staging.commit();
      expect(fixture.db.listMemories()[0]?.summary).toBe("committed");
      expect(fixture.db.getContact("7")).toMatchObject({ summary: "new", importance: "priority_plus" });
    } finally { fixture.cleanup(); }
  });

  it("enforces soft and hard memory limits with an explicit raise path", async () => {
    const fixture = testDatabase();
    try {
      const settings = fixture.db.getSettings();
      settings.value.synthesis.memorySoftTokens = 20;
      settings.value.synthesis.memoryHardTokens = 80;
      fixture.db.updateSettings(settings.value, settings.version);
      const tools = buildSynthesisTools(fixture.db).tools;
      const memory = tools.find((item) => item.name === "manage_memory")!;
      await expect(execute(memory, { operation: "upsert", id: "large", occurredAt: 1, summary: "x".repeat(200) })).rejects.toThrow(/上限/);
      await execute(memory, { operation: "raise_soft_limit", softTokens: 80 });
      await expect(execute(memory, { operation: "raise_soft_limit", softTokens: 81 })).rejects.toThrow(/硬上限/);
      await expect(execute(memory, { operation: "upsert", id: "huge", occurredAt: 1, summary: "x".repeat(1_000) })).rejects.toThrow(/硬上限/);
    } finally { fixture.cleanup(); }
  });
});

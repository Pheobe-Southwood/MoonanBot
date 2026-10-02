import { describe, expect, it } from "vitest";
import type { ChatPlatformAdapter } from "../src/platforms/types.js";
import { buildSimulationTools } from "../src/agents/simulation-tools.js";
import { buildSynthesisTools } from "../src/agents/synthesis-tools.js";
import type { ConversationTarget } from "../src/domain/types.js";
import { stubMediaView, testDatabase, textOf } from "./helpers.js";

function platform(send: ChatPlatformAdapter["sendText"] = async () => ({ platformMessageId: "sent-1" })): ChatPlatformAdapter {
  return {
    id: "fake", status: () => ({ connected: true, selfId: "bot", roles: ["universal"] }),
    sendText: send, syncRoster: async () => ({ groupsAdded: 0, groupsRemoved: 0, contactsUpdated: 0 }), close: async () => undefined,
  };
}

async function execute(tool: any, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  return await tool.execute("call", params, signal);
}

const seven = { platform: "onebot" as const, id: "7", name: "Seven", aliases: [] as string[], summary: "", importance: "normal" as const, isFriend: true };
const sevenTarget: ConversationTarget = { platform: "onebot", kind: "private", id: "7", name: "Seven" };

describe("simulation tools", () => {
  it("exposes only perform_action and appends the action menu to results and errors", async () => {
    const fixture = testDatabase();
    try {
      const tools = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));
      expect(tools.map((tool) => tool.name)).toEqual(["perform_action"]);
      const opened = await execute(tools[0]!, { action: "open_phone" });
      expect(textOf(opened)).toContain("接下来可用的动作:");
      expect(textOf(opened)).toContain("view_contacts");
      await expect(execute(tools[0]!, { action: "send_messages", messages: ["no"] })).rejects.toThrow(/当前状态不能执行 send_messages/);
      await expect(execute(tools[0]!, { action: "send_messages", messages: ["no"] })).rejects.toThrow(/接下来可用的动作/);
    } finally { fixture.cleanup(); }
  });

  it("independently rejects illegal phone operations and duration bounds", async () => {
    const fixture = testDatabase();
    try {
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));
      await expect(execute(perform, { action: "idle", durationMinutes: 29 })).rejects.toThrow(/30/);
      await execute(perform!, { action: "open_phone" });
      const idled = await execute(perform!, { action: "idle", durationMinutes: 30 });
      expect(idled.terminate).toBe(true);
      expect(fixture.db.getRuntime().mode).toBe("entertaining");
      expect(fixture.db.getRuntime().phone.kind).toBe("closed");
      expect(fixture.db.getRuntime().nextWakeAt).toBeTypeOf("number");
    } finally { fixture.cleanup(); }
  });

  it("closes the phone when sleeping", async () => {
    const fixture = testDatabase();
    try {
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));
      await execute(perform!, { action: "open_phone" });
      const sleeping = await execute(perform!, { action: "sleep", durationMinutes: 30 });
      expect(sleeping.terminate).toBe(true);
      expect(fixture.db.getRuntime().mode).toBe("sleeping");
      expect(fixture.db.getRuntime().phone.kind).toBe("closed");
      expect(fixture.db.listPendingTimers("alarm")).toHaveLength(1);
    } finally { fixture.cleanup(); }
  });

  it("walks the phone state machine, marks chats read, and pages through history", async () => {
    const fixture = testDatabase();
    try {
      fixture.db.upsertContact(seven);
      for (const [index, occurredAt] of [100, 200, 300].entries()) {
        fixture.db.insertMessage({
          id: `m-${index}`, platformMessageId: `p-${index}`, target: sevenTarget, senderId: "7", senderName: "Seven",
          direction: "incoming", content: `msg ${index}`, segments: [], occurredAt, observedAt: occurredAt,
          deliveryStatus: "received", readAt: null,
        });
      }
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));

      const home = textOf(await execute(perform!, { action: "open_phone" }));
      expect(home).toContain("当前手机状态：主页");
      expect(home).toContain("有一些未读消息");
      expect(fixture.db.getRuntime().phone.kind).toBe("home");

      // the contact list cannot be skipped
      await expect(execute(perform!, { action: "open_chat", kind: "private", targetId: "7" })).rejects.toThrow(/当前状态不能执行 open_chat/);

      const contacts = textOf(await execute(perform!, { action: "view_contacts" }));
      expect(contacts).toContain("当前手机状态：好友和群聊列表");
      expect(contacts).toContain("Seven（7）（有3条未读消息）");
      expect(fixture.db.getRuntime().phone.kind).toBe("contacts");

      await expect(execute(perform!, { action: "open_chat", kind: "private", targetId: "404" })).rejects.toThrow(/未知联系人或群聊/);

      const chat = textOf(await execute(perform!, { action: "open_chat", kind: "private", targetId: "7" }));
      expect(chat).toContain("有 3 条新消息");
      expect(chat).toContain("msg 2");
      expect(fixture.db.unreadSummary(true)).toHaveLength(0);
      expect(fixture.db.getRuntime().phone).toMatchObject({ kind: "chat", cursor: 100 });

      fixture.db.insertMessage({
        id: "m-old", platformMessageId: "p-old", target: sevenTarget, senderId: "7", senderName: "Seven",
        direction: "incoming", content: "older", segments: [], occurredAt: 50, observedAt: 50,
        deliveryStatus: "received", readAt: Date.now(),
      });
      const history = textOf(await execute(perform!, { action: "load_history", count: 10 }));
      expect(history).toContain("older");
      expect(fixture.db.getRuntime().phone).toMatchObject({ kind: "chat", cursor: 50 });
      expect(textOf(await execute(perform!, { action: "load_history", count: 10 }))).toContain("已经到最早的本地已观测消息");

      await execute(perform!, { action: "close_phone" });
      expect(fixture.db.getRuntime().phone.kind).toBe("closed");
    } finally { fixture.cleanup(); }
  });

  it("folds long contact lists but keeps every unread entry", async () => {
    const fixture = testDatabase();
    try {
      const settings = fixture.db.getSettings();
      settings.value.simulation.contactListMaxEntries = 2;
      fixture.db.updateSettings(settings.value, settings.version);
      for (const id of ["a", "b", "c"]) {
        fixture.db.upsertContact({ platform: "onebot", id, name: `User ${id}`, aliases: [], summary: "", importance: "normal", isFriend: true });
      }
      fixture.db.insertMessage({
        id: "mc", platformMessageId: "pc", target: { platform: "onebot", kind: "private", id: "c", name: "User c" },
        senderId: "c", senderName: "User c", direction: "incoming", content: "unread me", segments: [],
        occurredAt: Date.now(), observedAt: Date.now(), deliveryStatus: "received", readAt: null,
      });
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));
      await execute(perform!, { action: "open_phone" });
      const text = textOf(await execute(perform!, { action: "view_contacts" }));
      expect(text).toContain("User c");
      expect(text).toContain("有1条未读消息");
      expect(text).toContain("另有 1 个无未读消息的好友/群聊未显示");
    } finally { fixture.cleanup(); }
  });

  it("sends in order and records delivery", async () => {
    const fixture = testDatabase();
    const sent: string[] = [];
    try {
      fixture.db.upsertContact(seven);
      const settings = fixture.db.getSettings();
      settings.value.simulation.messageIntervalMs = 0;
      fixture.db.updateSettings(settings.value, settings.version);
      const [perform] = buildSimulationTools(fixture.db, platform(async (_target, text) => { sent.push(text); return { platformMessageId: `p-${sent.length}` }; }), stubMediaView(fixture.db));
      await execute(perform!, { action: "open_phone" });
      await execute(perform!, { action: "view_contacts" });
      await execute(perform!, { action: "open_chat", kind: "private", targetId: "7" });
      await execute(perform!, { action: "send_messages", messages: ["one", "two"] });
      expect(sent).toEqual(["one", "two"]);
      expect(fixture.db.listMessages(sevenTarget, 10).map((item) => item.deliveryStatus)).toEqual(["sent", "sent"]);
    } finally { fixture.cleanup(); }
  });

  it("marks uncertain delivery unknown and never silently retries", async () => {
    const fixture = testDatabase();
    let calls = 0;
    try {
      fixture.db.upsertContact(seven);
      const [perform] = buildSimulationTools(fixture.db, platform(async () => { calls += 1; throw new Error("link lost"); }), stubMediaView(fixture.db));
      await execute(perform!, { action: "open_phone" });
      await execute(perform!, { action: "view_contacts" });
      await execute(perform!, { action: "open_chat", kind: "private", targetId: "7" });
      await expect(execute(perform!, { action: "send_messages", messages: ["once"] })).rejects.toThrow("发送结果未知");
      expect(calls).toBe(1);
      expect(fixture.db.listMessages(sevenTarget, 10)[0]?.deliveryStatus).toBe("unknown");
    } finally { fixture.cleanup(); }
  });

  it("enforces per-message and aggregate payload limits", async () => {
    const fixture = testDatabase();
    try {
      fixture.db.upsertContact(seven);
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));
      await execute(perform!, { action: "open_phone" });
      await execute(perform!, { action: "view_contacts" });
      await execute(perform!, { action: "open_chat", kind: "private", targetId: "7" });
      await expect(execute(perform!, { action: "send_messages", messages: ["x".repeat(2_001)] })).rejects.toThrow(/2000/);
      await expect(execute(perform!, { action: "send_messages", messages: Array(140).fill("界".repeat(1_000)) })).rejects.toThrow(/256 KiB/);
    } finally { fixture.cleanup(); }
  });

  it("waits inside an open chat and terminates the run", async () => {
    const fixture = testDatabase();
    try {
      fixture.db.upsertContact(seven);
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));
      await execute(perform!, { action: "open_phone" });
      await execute(perform!, { action: "view_contacts" });
      await execute(perform!, { action: "open_chat", kind: "private", targetId: "7" });

      await expect(execute(perform!, { action: "wait_messages", durationSeconds: 10, messageCount: 2 })).rejects.toThrow(/二选一/);
      await expect(execute(perform!, { action: "wait_messages", durationSeconds: 61 })).rejects.toThrow(/60/);
      await expect(execute(perform!, { action: "wait_messages", messageCount: 6 })).rejects.toThrow(/5/);

      const waited = await execute(perform!, { action: "wait_messages", durationSeconds: 10 });
      expect(waited.terminate).toBe(true);
      const runtime = fixture.db.getRuntime();
      expect(runtime.mode).toBe("waiting");
      expect(runtime.phone).toMatchObject({ kind: "chat" });
      expect(runtime.nextWakeAt).toBeTypeOf("number");
      const timers = fixture.db.listPendingTimers("wait");
      expect(timers).toHaveLength(1);
      expect(timers[0]!.payload).toMatchObject({ mode: "seconds", seconds: 10 });
      expect((timers[0]!.payload.watch as ConversationTarget).id).toBe("7");

      // a second wait replaces the first timer
      await execute(perform!, { action: "wait_messages", messageCount: 3 });
      const replaced = fixture.db.listPendingTimers("wait");
      expect(replaced).toHaveLength(1);
      expect(replaced[0]!.payload).toMatchObject({ mode: "count", count: 3 });
      expect(replaced[0]!.dueAt - Date.now()).toBeGreaterThan(170_000);
    } finally { fixture.cleanup(); }
  });

  it("anchors the wait window to unread messages that arrived during model latency", async () => {
    const fixture = testDatabase();
    try {
      fixture.db.upsertContact(seven);
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));
      await execute(perform!, { action: "open_phone" });
      await execute(perform!, { action: "view_contacts" });
      await execute(perform!, { action: "open_chat", kind: "private", targetId: "7" });

      // A reply lands between open_chat and wait_messages, i.e. during the provider round-trip.
      const gapAt = Date.now() - 5_000;
      fixture.db.insertMessage({
        id: "gap-1", platformMessageId: "gap-1", target: sevenTarget, senderId: "7", senderName: "Seven",
        direction: "incoming", content: "延迟期间的回复", segments: [], occurredAt: gapAt, observedAt: gapAt,
        deliveryStatus: "received", readAt: null,
      });

      // seconds mode: the window covers the gap message but the duration is not shortened
      await execute(perform!, { action: "wait_messages", durationSeconds: 10 });
      const secondsTimer = fixture.db.listPendingTimers("wait")[0]!;
      expect(Number(secondsTimer.payload.since)).toBeLessThanOrEqual(gapAt);
      expect(secondsTimer.dueAt - Date.now()).toBeGreaterThan(9_000);

      // count mode already satisfied by the gap message: the timer expires immediately
      await execute(perform!, { action: "wait_messages", messageCount: 1 });
      const satisfied = fixture.db.listPendingTimers("wait")[0]!;
      expect(Number(satisfied.payload.since)).toBeLessThanOrEqual(gapAt);
      expect(satisfied.dueAt - Date.now()).toBeLessThanOrEqual(0);

      // a count beyond the gap message still waits the full timeout from now
      await execute(perform!, { action: "wait_messages", messageCount: 2 });
      const waiting = fixture.db.listPendingTimers("wait")[0]!;
      expect(Number(waiting.payload.since)).toBeLessThanOrEqual(gapAt);
      expect(waiting.dueAt - Date.now()).toBeGreaterThan(170_000);
    } finally { fixture.cleanup(); }
  });

  it("locks set_contact_importance to the contact list or the friend's own chat", async () => {
    const fixture = testDatabase();
    try {
      fixture.db.upsertContact(seven);
      fixture.db.upsertContact({ platform: "onebot", id: "8", name: "Eight", aliases: [], summary: "", importance: "normal", isFriend: true });
      fixture.db.upsertGroup({ platform: "onebot", id: "g1", name: "Group", summary: "" });
      const [perform] = buildSimulationTools(fixture.db, platform(), stubMediaView(fixture.db));

      await expect(execute(perform!, { action: "set_contact_importance", contactId: "7", importance: "priority" })).rejects.toThrow(/当前状态/);
      await execute(perform!, { action: "open_phone" });
      await expect(execute(perform!, { action: "set_contact_importance", contactId: "7", importance: "priority" })).rejects.toThrow(/当前状态/);

      await execute(perform!, { action: "view_contacts" });
      await execute(perform!, { action: "set_contact_importance", contactId: "8", importance: "priority_plus" });
      expect(fixture.db.getContact("8")?.importance).toBe("priority_plus");
      await expect(execute(perform!, { action: "set_contact_importance", contactId: "404", importance: "priority" })).rejects.toThrow(/未知联系人/);

      await execute(perform!, { action: "open_chat", kind: "private", targetId: "7" });
      await expect(execute(perform!, { action: "set_contact_importance", contactId: "8", importance: "normal" })).rejects.toThrow(/只能设置该好友/);
      await execute(perform!, { action: "set_contact_importance", contactId: "7", importance: "do_not_disturb" });
      expect(fixture.db.getContact("7")?.importance).toBe("do_not_disturb");

      await execute(perform!, { action: "view_contacts" });
      await execute(perform!, { action: "open_chat", kind: "group", targetId: "g1" });
      await expect(execute(perform!, { action: "set_contact_importance", contactId: "7", importance: "normal" })).rejects.toThrow(/当前状态/);
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

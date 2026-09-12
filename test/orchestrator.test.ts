import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeOrchestrator } from "../src/agents/orchestrator.js";
import type { ChatPlatformAdapter, PlatformMessageEvent } from "../src/platforms/types.js";
import type { ProviderRegistry } from "../src/providers/registry.js";
import { testDatabase } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

function fakePlatform(): ChatPlatformAdapter {
  return {
    id: "fake", status: () => ({ connected: true, selfId: "bot", roles: ["universal"] }),
    sendText: async () => ({ platformMessageId: "1" }), syncRoster: async () => undefined, close: async () => undefined,
  };
}

function configured() {
  const fixture = testDatabase();
  cleanups.push(fixture.cleanup);
  const profile = fixture.db.getProfile();
  fixture.db.updateProfile({ ...profile, soul: "安静、谨慎、会主动安排自己的生活。" }, profile.version);
  const faux = fauxProvider({ provider: "faux-moonan", models: [{ id: "faux-life", reasoning: true, contextWindow: 400_000 }] });
  const models = createModels();
  models.setProvider(faux.provider);
  const settings = fixture.db.getSettings();
  settings.value.agents.default = { providerId: "faux-moonan", modelId: "faux-life", thinkingLevel: "medium" };
  settings.value.simulation.messageIntervalMs = 0;
  settings.value.synthesis.retryBaseDelayMs = 0;
  fixture.db.updateSettings(settings.value, settings.version);
  return { ...fixture, faux, providers: { models } as unknown as ProviderRegistry };
}

async function eventually(assertion: () => void, timeout = 2_000): Promise<void> {
  const start = Date.now();
  while (true) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("runtime orchestration with pi faux provider", () => {
  it("runs a multi-turn simulation, terminates in sleep, and synthesizes memory", async () => {
    const { db, faux, providers } = configured();
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("先查看可用动作。"), fauxToolCall("list_available_actions", {})], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxThinking("角色需要休息。"), fauxToolCall("perform_action", { action: "sleep", durationMinutes: 30 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([
        fauxToolCall("manage_memory", { operation: "upsert", id: "sleep-memory", occurredAt: Date.now(), summary: "主动安排了一次休息" }),
        fauxToolCall("finish_synthesis", { summary: "记录休息安排，无关系变化。" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("归纳完成。"),
    ]);
    const orchestrator = new RuntimeOrchestrator(db, providers, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.startBot();
    expect(db.getRuntime().mode).toBe("sleeping");
    await eventually(() => expect(db.listMemories().some((item) => item.id === "sleep-memory")).toBe(true));
    expect(db.listAgentRuns(20).map((run) => run.agent)).toEqual(expect.arrayContaining(["simulation", "synthesis"]));
    const trace = db.listAgentRuns(20).flatMap((run) => db.listAgentMessages(run.id));
    expect(trace.some((message) => message.role === "reasoning")).toBe(true);
    expect(trace.some((message) => message.role === "tool" && message.name === "perform_action")).toBe(true);
  });

  it("corrects two missing-action turns and then forces a safe idle", async () => {
    const { db, faux, providers } = configured();
    faux.setResponses([
      fauxAssistantMessage("今天可以做点什么。"),
      fauxAssistantMessage("再观察一下。"),
      fauxAssistantMessage("暂时没有决定。"),
    ]);
    const orchestrator = new RuntimeOrchestrator(db, providers, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.startBot();
    expect(db.getRuntime()).toMatchObject({ mode: "entertaining", health: "degraded", lastError: "推演 Agent 连续未执行动作" });
    expect(db.eventsSince(0).some((event) => event.type === "system_warning")).toBe(true);
    expect(faux.state.callCount).toBe(3);
  });

  it("retries failed synthesis batches and compacts old context only after commit", async () => {
    const { db, faux, providers } = configured();
    const settings = db.getSettings();
    settings.value.synthesis.retryCount = 2;
    db.updateSettings(settings.value, settings.version);
    db.setAgentState("simulation", Array.from({ length: 30 }, (_, index) => ({ role: "user", content: `old-${index}`, timestamp: index + 1 })));
    faux.setResponses([
      fauxAssistantMessage("没有调用完成工具。"),
      fauxAssistantMessage(fauxToolCall("finish_synthesis", { summary: "第二次尝试成功。" }), { stopReason: "toolUse" }),
    ]);
    const orchestrator = new RuntimeOrchestrator(db, providers, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.runSynthesis("test_retry");
    const synthesisRuns = db.listAgentRuns(10, "synthesis");
    expect(synthesisRuns.map((run) => run.status)).toEqual(["completed", "failed"]);
    const compacted = db.getAgentState<any>("simulation");
    expect(compacted).toHaveLength(21);
    expect(compacted[0].content).toContain("更久远的行为已归纳");
    expect(compacted.at(-1).content).toBe("old-29");
  });

  it("coalesces notifications into the highest level within the configured window", async () => {
    vi.useFakeTimers();
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    fixture.db.setRuntime({ mode: "awake" });
    fixture.db.upsertContact({ platform: "onebot", id: "normal", name: "Normal", aliases: [], summary: "", importance: "normal", isFriend: true });
    fixture.db.upsertContact({ platform: "onebot", id: "plus", name: "Plus", aliases: [], summary: "", importance: "priority_plus", isFriend: true });
    const orchestrator = new RuntimeOrchestrator(fixture.db, { models: createModels() } as unknown as ProviderRegistry, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    const incoming = (id: string, messageId: string): PlatformMessageEvent => ({
      selfId: "bot", platformMessageId: messageId, target: { platform: "onebot", kind: "private", id, name: id },
      senderId: id, senderName: id, occurredAt: Date.now(), content: "ping", segments: [], raw: {},
    });
    await orchestrator.handleIncoming(incoming("normal", "1"));
    await orchestrator.handleIncoming(incoming("plus", "2"));
    await vi.advanceTimersByTimeAsync(5_001);
    const signals = fixture.db.eventsSince(0).filter((event) => ["phone_alarm", "phone_ring", "phone_vibration"].includes(event.type));
    expect(signals.map((event) => event.type)).toEqual(["phone_alarm"]);
  });
});

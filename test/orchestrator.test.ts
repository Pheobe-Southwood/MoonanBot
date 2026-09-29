import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeOrchestrator } from "../src/agents/orchestrator.js";
import type { ChatPlatformAdapter, PlatformMessageEvent } from "../src/platforms/types.js";
import type { ConversationTarget } from "../src/domain/types.js";
import type { ProviderRegistry } from "../src/providers/registry.js";
import { testDatabase } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });

function fakePlatform(): ChatPlatformAdapter {
  return {
    id: "fake", status: () => ({ connected: true, selfId: "bot", roles: ["universal"] }),
    sendText: async () => ({ platformMessageId: "1" }), syncRoster: async () => ({ groupsAdded: 0, groupsRemoved: 0, contactsUpdated: 0 }), close: async () => undefined,
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

const sevenTarget: ConversationTarget = { platform: "onebot", kind: "private", id: "7", name: "Seven" };

function privateEvent(senderId: string, messageId: string, overrides: Partial<PlatformMessageEvent> = {}): PlatformMessageEvent {
  return {
    selfId: "bot", platformMessageId: messageId, target: { platform: "onebot", kind: "private", id: senderId, name: senderId },
    senderId, senderName: senderId, occurredAt: Date.now(), content: "ping", segments: [], raw: {}, ...overrides,
  };
}

describe("runtime orchestration with pi faux provider", () => {
  it("runs a multi-turn simulation, terminates in sleep, and synthesizes memory", async () => {
    const { db, faux, providers } = configured();
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("先打开手机看看。"), fauxToolCall("perform_action", { action: "open_phone" })], { stopReason: "toolUse" }),
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
    expect(trace.some((message) => message.role === "user" && message.content.includes("接下来可用的动作"))).toBe(true);
  });

  it("corrects two missing-action turns and then forces a safe idle", async () => {
    const { db, faux, providers } = configured();
    faux.setResponses([
      fauxAssistantMessage("纯文本回应一。"),
      fauxAssistantMessage("纯文本回应二。"),
      fauxAssistantMessage("纯文本回应三。"),
    ]);
    const orchestrator = new RuntimeOrchestrator(db, providers, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.startBot();
    const runtime = db.getRuntime();
    expect(runtime).toMatchObject({ mode: "entertaining", health: "degraded", lastError: "推演 Agent 连续未安排下一步行动" });
    expect(db.eventsSince(0).some((event) => event.type === "system_warning")).toBe(true);
    expect(faux.state.callCount).toBe(3);
  });

  it("corrects a run that acted but scheduled no continuation, then accepts an idle", async () => {
    const { db, faux, providers } = configured();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("perform_action", { action: "open_phone" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("我查看手机后直接停下了，没有安排唤醒。"),
      fauxAssistantMessage([fauxToolCall("perform_action", { action: "idle", durationMinutes: 30 })], { stopReason: "toolUse" }),
    ]);
    const orchestrator = new RuntimeOrchestrator(db, providers, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.startBot();
    expect(faux.state.callCount).toBe(3);
    const trace = db.listAgentRuns(20).flatMap((run) => db.listAgentMessages(run.id));
    const corrections = trace.filter((message) => message.role === "user" && message.content.includes("本轮动作已结束"));
    expect(corrections).toHaveLength(1);
    expect(db.getRuntime()).toMatchObject({ mode: "entertaining", health: "healthy" });
    expect(db.getRuntime().nextWakeAt).not.toBeNull();
  });

  it("wakes from a seconds wait through the durable timer loop", async () => {
    const { db, faux, providers } = configured();
    const settings = db.getSettings();
    settings.value.simulation.waitMinSeconds = 1;
    db.updateSettings(settings.value, settings.version);
    db.upsertContact({ platform: "onebot", id: "7", name: "Seven", aliases: [], summary: "", importance: "normal", isFriend: true });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("perform_action", { action: "open_phone" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("perform_action", { action: "view_contacts" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("perform_action", { action: "open_chat", kind: "private", targetId: "7" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("perform_action", { action: "wait_messages", durationSeconds: 1 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("perform_action", { action: "sleep", durationMinutes: 30 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("finish_synthesis", { summary: "等待之后入睡。" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("归纳完成。"),
    ]);
    const orchestrator = new RuntimeOrchestrator(db, providers, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.startBot();
    expect(db.getRuntime().mode).toBe("waiting");
    expect(db.getRuntime().phone).toMatchObject({ kind: "chat" });
    orchestrator.start();
    await eventually(() => expect(db.getRuntime().mode).toBe("sleeping"), 10_000);
    expect(db.eventsSince(0).some((event) => event.type === "wait_elapsed")).toBe(true);
    const wakeRun = db.listAgentRuns(20).flatMap((run) => db.listAgentMessages(run.id));
    expect(wakeRun.some((message) => message.role === "user" && message.content.includes("等待时间已到"))).toBe(true);
  });

  it("counts silent messages toward a count-mode wait and wakes at the target count", async () => {
    const { db, faux, providers } = configured();
    db.upsertContact({ platform: "onebot", id: "7", name: "Seven", aliases: [], summary: "", importance: "do_not_disturb", isFriend: true });
    db.setRuntime({ mode: "waiting", phone: { kind: "chat", target: sevenTarget } });
    db.createTimer("wait", Date.now() + 60_000, { watch: sevenTarget, mode: "count", count: 2, since: Date.now() - 1 });
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("perform_action", { action: "sleep", durationMinutes: 30 })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("finish_synthesis", { summary: "无。" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("完成。"),
    ]);
    const orchestrator = new RuntimeOrchestrator(db, providers, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.handleIncoming(privateEvent("7", "m1", { target: sevenTarget, content: "quiet one" }));
    expect(db.getRuntime().mode).toBe("waiting");
    await orchestrator.handleIncoming(privateEvent("7", "m2", { target: sevenTarget, content: "quiet two" }));
    await eventually(() => expect(db.getRuntime().mode).toBe("sleeping"));
    expect(db.listPendingTimers("wait")).toHaveLength(0);
    const waitEvents = db.eventsSince(0).filter((event) => event.type === "wait_elapsed");
    expect(waitEvents[0]?.text).toContain("等待的 2 条新消息已到达");
    expect(waitEvents[0]?.text).toContain("quiet two");
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
    fixture.db.upsertContact({ platform: "onebot", id: "normal", name: "normal", aliases: [], summary: "", importance: "normal", isFriend: true });
    fixture.db.upsertContact({ platform: "onebot", id: "plus", name: "plus", aliases: [], summary: "", importance: "priority_plus", isFriend: true });
    const orchestrator = new RuntimeOrchestrator(fixture.db, { models: createModels() } as unknown as ProviderRegistry, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.handleIncoming(privateEvent("normal", "1"));
    await orchestrator.handleIncoming(privateEvent("plus", "2"));
    await vi.advanceTimersByTimeAsync(5_001);
    const signals = fixture.db.eventsSince(0).filter((event) => ["phone_alarm", "phone_ring", "phone_vibration"].includes(event.type));
    expect(signals.map((event) => event.type)).toEqual(["phone_alarm"]);
  });

  it("ends a wait early on any notification and merges the watched messages", async () => {
    vi.useFakeTimers();
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const db = fixture.db;
    db.upsertContact({ platform: "onebot", id: "7", name: "Seven", aliases: [], summary: "", importance: "normal", isFriend: true });
    db.upsertContact({ platform: "onebot", id: "9", name: "Nine", aliases: [], summary: "", importance: "priority_plus", isFriend: true });
    db.setRuntime({ mode: "waiting", phone: { kind: "chat", target: sevenTarget } });
    db.insertMessage({
      id: "watched-1", platformMessageId: "w1", target: sevenTarget, senderId: "7", senderName: "Seven",
      direction: "incoming", content: "盯着屏幕时来的消息", segments: [], occurredAt: Date.now(), observedAt: Date.now(),
      deliveryStatus: "received", readAt: null,
    });
    db.createTimer("wait", Date.now() + 60_000, { watch: sevenTarget, mode: "count", count: 5, since: Date.now() - 1 });
    const orchestrator = new RuntimeOrchestrator(db, { models: createModels() } as unknown as ProviderRegistry, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.handleIncoming(privateEvent("9", "loud"));
    await vi.advanceTimersByTimeAsync(5_001);
    const alarm = db.eventsSince(0).find((event) => event.type === "phone_alarm");
    expect(alarm?.text).toContain("手机闹钟响了");
    expect(alarm?.text).toContain("盯着屏幕时来的消息");
    expect(db.listPendingTimers("wait")).toHaveLength(0);
    expect(db.getRuntime().mode).toBe("awake");
  });

  it("drops platform echoes of the character's own messages", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const db = fixture.db;
    db.setRuntime({ mode: "awake", activeSelfId: "bot-self" });
    const orchestrator = new RuntimeOrchestrator(db, { models: createModels() } as unknown as ProviderRegistry, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.handleIncoming(privateEvent("bot-self", "echo-1", { target: sevenTarget, content: "echo" }));
    expect(db.listMessages(sevenTarget, 10)).toHaveLength(0);
    expect(db.eventsSince(0)).toHaveLength(0);
    expect(db.listContacts()).toHaveLength(0);
  });

  it("notifies for group mentions by sender importance, including @all", async () => {
    vi.useFakeTimers();
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const db = fixture.db;
    db.setRuntime({ mode: "awake", activeSelfId: "me" });
    const orchestrator = new RuntimeOrchestrator(db, { models: createModels() } as unknown as ProviderRegistry, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    const group: ConversationTarget = { platform: "onebot", kind: "group", id: "g1", name: "Group" };
    const groupEvent = (messageId: string, segments: unknown[]): PlatformMessageEvent => ({
      selfId: "me", platformMessageId: messageId, target: group, senderId: "7", senderName: "Seven",
      occurredAt: Date.now(), content: "hi", segments, raw: {},
    });

    await orchestrator.handleIncoming(groupEvent("1", [{ type: "text", data: { text: "hi" } }]));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(db.eventsSince(0).filter((event) => event.type.startsWith("phone_"))).toHaveLength(0);

    await orchestrator.handleIncoming(groupEvent("2", [{ type: "at", data: { qq: "me" } }]));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(db.eventsSince(0).filter((event) => event.type === "phone_vibration")).toHaveLength(1);

    await orchestrator.handleIncoming(groupEvent("3", [{ type: "at", data: { qq: "all" } }]));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(db.eventsSince(0).filter((event) => event.type === "phone_vibration")).toHaveLength(2);
  });

  it("cancels the pending wait when the operator wakes the character", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const db = fixture.db;
    db.setRuntime({ mode: "waiting", phone: { kind: "chat", target: sevenTarget } });
    db.insertMessage({
      id: "watched-2", platformMessageId: "w2", target: sevenTarget, senderId: "7", senderName: "Seven",
      direction: "incoming", content: "等待期间来的消息", segments: [], occurredAt: Date.now(), observedAt: Date.now(),
      deliveryStatus: "received", readAt: null,
    });
    db.createTimer("wait", Date.now() + 60_000, { watch: sevenTarget, mode: "seconds", seconds: 30, since: Date.now() - 1 });
    const orchestrator = new RuntimeOrchestrator(db, { models: createModels() } as unknown as ProviderRegistry, fakePlatform());
    cleanups.push(() => { void orchestrator.close(); });
    await orchestrator.wakeBot();
    expect(db.listPendingTimers("wait")).toHaveLength(0);
    expect(db.getRuntime().mode).toBe("awake");
    const wake = db.eventsSince(0).find((event) => event.type === "operator_wake");
    expect(wake?.text).toContain("你被唤醒了");
    expect(wake?.text).toContain("等待期间来的消息");
  });
});

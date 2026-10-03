import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { archiveThreshold, estimateContextTokens, formatAvailableActions, listAvailableActions, notificationFor, pruneStaleActionMenus, segmentsMention } from "../domain/behavior.js";
import type { AgentSelection, ConversationTarget, Importance, NotificationDecision, StoredMessage } from "../domain/types.js";
import { MediaPipeline } from "../media/pipeline.js";
import { renderMessagePreview, renderObservedMessages, renderSynthesisEvents, stripImageBlocks, type MediaView, type RenderedMessages } from "../media/render.js";
import type { PlatformMessageEvent } from "../platforms/types.js";
import type { ChatPlatformAdapter } from "../platforms/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { MoonanDatabase, TimerRecord } from "../storage/database.js";
import { renderPrompt } from "./prompts.js";
import { buildSimulationTools } from "./simulation-tools.js";
import { buildSynthesisTools } from "./synthesis-tools.js";
import { applySlotOverrides, currentCapabilities, describeMedia, effectiveSelection, formatWorld, selectionSeesImages } from "./vision.js";

function userMessage(text: string, images: ImageContent[] = []): UserMessage {
  return images.length
    ? { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() }
    : { role: "user", content: text, timestamp: Date.now() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === "string" ? content : content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
}

export class RuntimeOrchestrator {
  private simulationAgent?: Agent;
  private simulationRunId: string | null = null;
  private simulationActionCalls = 0;
  private timerLoop: NodeJS.Timeout | undefined;
  private notificationTimer: NodeJS.Timeout | undefined;
  private pendingSignal: "alarm" | "ring" | "vibration" | null = null;
  private synthesisPromise: Promise<void> | null = null;
  private stopped = false;
  private readonly media: MediaPipeline;

  constructor(
    private readonly db: MoonanDatabase,
    private readonly providers: ProviderRegistry,
    private readonly platform: ChatPlatformAdapter,
    private readonly random: () => number = Math.random,
  ) {
    this.media = new MediaPipeline(db, platform, () => db.getSettings().value, (item) => describeMedia(db, providers, item));
  }

  start(): void {
    if (this.timerLoop) return;
    this.stopped = false;
    this.media.start();
    this.timerLoop = setInterval(() => { void this.tick(); }, 1_000);
    void this.tick();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timerLoop) clearInterval(this.timerLoop);
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.media.close();
    this.simulationAgent?.abort();
    await this.simulationAgent?.waitForIdle().catch(() => undefined);
    await this.synthesisPromise?.catch(() => undefined);
  }

  readiness(): { ready: boolean; problems: string[]; warnings: string[] } {
    const profile = this.db.getProfile();
    const problems: string[] = [];
    if (!profile.name.trim()) problems.push("角色名称不能为空");
    if (!profile.soul.trim()) problems.push("请先填写 SOUL");
    for (const agent of ["simulation", "synthesis"] as const) {
      const selection = effectiveSelection(this.db, agent);
      if (!selection.providerId || !selection.modelId) problems.push(`请为${agent === "simulation" ? "推演" : "归纳"} Agent 选择模型`);
      else if (!this.providers.models.getModel(selection.providerId, selection.modelId)) problems.push(`${agent} 模型不存在：${selection.providerId}/${selection.modelId}`);
    }
    const warnings: string[] = [];
    const capabilities = currentCapabilities(this.db, this.providers);
    if ((!capabilities.simulation || !capabilities.synthesis) && !capabilities.visionConfigured) {
      warnings.push("图片识别 Agent 未配置模型：不支持图片输入的模型将只看到 [图片] 占位符");
    }
    if (capabilities.visionConfigured && !capabilities.visionSeesImages) {
      warnings.push("图片识别 Agent 所选模型未声明图片输入且未强制启用，识别调用可能失败");
    }
    return { ready: problems.length === 0, problems, warnings };
  }

  async startBot(): Promise<void> {
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(readiness.problems.join("；"));
    this.db.cancelPendingTimers("wait");
    this.db.setRuntime({ mode: "awake", health: "healthy", nextWakeAt: null, lastError: null });
    const name = this.db.getProfile().name;
    this.db.addEvent("character_started", `${name}醒来了`, {});
    await this.activate(`${name}醒来了`);
  }

  pauseBot(): void {
    this.db.setRuntime({ mode: "paused" });
    this.simulationAgent?.abort();
  }

  async wakeBot(): Promise<void> {
    const [wait] = this.db.listPendingTimers("wait");
    this.db.cancelPendingTimers("wait");
    this.db.setRuntime({ mode: "awake", nextWakeAt: null });
    const name = this.db.getProfile().name;
    const head = `${name}被唤醒了，请决定下一步行动。`;
    const merged = wait
      ? await this.waitMergeText(wait, head)
      : { text: head, images: [] as ImageContent[], messageIds: [] as string[] };
    this.db.markMessagesRead(merged.messageIds);
    this.db.addEvent("operator_wake", merged.text, {});
    await this.activate(merged.text, false, merged.images);
  }

  setOutbound(enabled: boolean): void {
    this.db.setRuntime({ outboundEnabled: enabled });
  }

  async handleIncoming(event: PlatformMessageEvent): Promise<void> {
    const observed = this.db.getRuntime();
    if (observed.activeSelfId && event.senderId === observed.activeSelfId) return;
    const existing = this.db.getContact(event.senderId);
    this.db.upsertContact({
      platform: "onebot", id: event.senderId, name: event.senderName, aliases: existing?.aliases ?? [],
      summary: existing?.summary ?? "", importance: existing?.importance ?? "normal", isFriend: existing?.isFriend ?? event.target.kind === "private",
    });
    if (event.target.kind === "group") {
      const group = this.db.listGroups().find((item) => item.id === event.target.id);
      this.db.upsertGroup({ platform: "onebot", id: event.target.id, name: event.target.name ?? group?.name ?? event.target.id, summary: group?.summary ?? "" });
    }
    const stored: StoredMessage = {
      id: randomUUID(), platformMessageId: event.platformMessageId, target: event.target,
      senderId: event.senderId, senderName: event.senderName, direction: "incoming", content: event.content,
      segments: event.segments, occurredAt: event.occurredAt, observedAt: Date.now(), deliveryStatus: "received", readAt: null,
    };
    if (!this.db.insertMessage(stored)) return;
    this.media.ingest(stored);
    this.db.addEvent("message_observed", `${event.senderName}在${event.target.kind === "group" ? "群聊" : "私聊"}中发来：${event.content}`, {
      target: event.target, senderId: event.senderId, messageId: event.platformMessageId, messageRowId: stored.id,
    }, event.occurredAt);
    const runtime = this.db.getRuntime();
    if (runtime.mode === "paused") return;
    const importance: Importance = existing?.importance ?? "normal";
    const mention = event.target.kind === "group" && segmentsMention(event.segments, runtime.activeSelfId);
    const decision = notificationFor(event.target.kind, importance, runtime.mode === "sleeping", this.random, this.db.getSettings().value.simulation.priorityWakeProbability, mention);
    if (runtime.mode === "waiting") { void this.advanceWait(event, decision); return; }
    if (decision.signal === "none" || !decision.wakes) return;
    this.queueNotification(decision.signal);
  }

  /** While waiting: any notification-level message ends the wait early (q5+q22); silent visible messages in the watched chat count toward messageCount. */
  private async advanceWait(event: PlatformMessageEvent, decision: NotificationDecision): Promise<void> {
    const [wait] = this.db.listPendingTimers("wait");
    if (decision.signal !== "none" && decision.wakes) { this.queueNotification(decision.signal); return; }
    if (!wait || !decision.visibleOnPhone || wait.payload.mode !== "count") return;
    const watch = wait.payload.watch as ConversationTarget | undefined;
    if (!watch || watch.kind !== event.target.kind || watch.id !== event.target.id) return;
    const since = Number(wait.payload.since ?? wait.dueAt);
    const arrived = this.db.listMessagesSince(watch, since).length;
    const needed = Number(wait.payload.count ?? 1);
    if (arrived < needed) return;
    this.db.cancelPendingTimers("wait");
    this.db.setRuntime({ mode: "awake", nextWakeAt: null });
    const merged = await this.waitText(watch, since, `等待的 ${needed} 条新消息已到达。`);
    this.db.markMessagesRead(merged.messageIds);
    this.db.addEvent("wait_elapsed", merged.text, wait.payload);
    await this.activate(merged.text, false, merged.images);
  }

  private simulationSeesImages(): boolean {
    return selectionSeesImages(this.providers, effectiveSelection(this.db, "simulation"));
  }

  private async renderForSimulation(messages: StoredMessage[]): Promise<RenderedMessages> {
    return renderObservedMessages(this.db, this.media, messages, {
      seesImages: this.simulationSeesImages(),
      describeLazily: true,
    });
  }

  private mediaView(): MediaView {
    return {
      seesImages: () => this.simulationSeesImages(),
      render: (messages, options) => renderObservedMessages(this.db, this.media, messages, {
        seesImages: this.simulationSeesImages(),
        describeLazily: options?.describeLazily ?? false,
      }),
      preview: (message) => renderMessagePreview(this.db, message),
    };
  }

  private async waitText(watch: ConversationTarget, since: number, head: string): Promise<{ text: string; images: ImageContent[]; messageIds: string[] }> {
    const profile = this.db.getProfile();
    const messages = this.db.listMessagesSince(watch, since);
    const otherUnread = this.db.unreadSummary(false)
      .filter((item) => !(item.target.kind === watch.kind && item.target.id === watch.id))
      .reduce((sum, item) => sum + item.count, 0);
    const rendered = await this.renderForSimulation(messages);
    const text = [
      head,
      `等待期间${watch.name ?? watch.id}的新消息：`,
      messages.length ? rendered.text : "没有新消息。",
      `${profile.name}的其他好友/群聊存在 ${otherUnread} 条未读消息。`,
    ].join("\n");
    return { text, images: rendered.images, messageIds: messages.map((message) => message.id) };
  }

  private async waitMergeText(wait: TimerRecord, head: string): Promise<{ text: string; images: ImageContent[]; messageIds: string[] }> {
    const watch = wait.payload.watch as ConversationTarget | undefined;
    return watch
      ? this.waitText(watch, Number(wait.payload.since ?? wait.dueAt), head)
      : Promise.resolve({ text: head, images: [] as ImageContent[], messageIds: [] as string[] });
  }

  private async waitElapsedText(timer: TimerRecord): Promise<{ text: string; images: ImageContent[]; messageIds: string[] }> {
    const watch = timer.payload.watch as ConversationTarget | undefined;
    const since = Number(timer.payload.since ?? timer.dueAt);
    if (!watch) return { text: "等待结束，请决定下一步行动。", images: [], messageIds: [] };
    if (timer.payload.mode === "count") {
      const needed = Number(timer.payload.count ?? 1);
      const arrived = this.db.listMessagesSince(watch, since).length;
      const head = arrived >= needed
        ? `等待的 ${needed} 条新消息已到达。`
        : `等待超时：只收到 ${arrived}/${needed} 条新消息。`;
      return this.waitText(watch, since, head);
    }
    return this.waitText(watch, since, `等待时间已到（${Number(timer.payload.seconds ?? 0)} 秒）。`);
  }

  private queueNotification(signal: "alarm" | "ring" | "vibration"): void {
    const order = { vibration: 1, ring: 2, alarm: 3 } as const;
    if (!this.pendingSignal || order[signal] > order[this.pendingSignal]) this.pendingSignal = signal;
    if (this.notificationTimer) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      const selected = this.pendingSignal;
      this.pendingSignal = null;
      if (!selected) return;
      void (async () => {
        let text = selected === "alarm" ? "手机闹钟响了" : selected === "ring" ? "手机响了" : "手机振动了";
        const type = selected === "alarm" ? "phone_alarm" : selected === "ring" ? "phone_ring" : "phone_vibration";
        let images: ImageContent[] = [];
        const [wait] = this.db.listPendingTimers("wait");
        if (wait) {
          this.db.cancelPendingTimers("wait");
          const merged = await this.waitMergeText(wait, text);
          text = merged.text;
          images = merged.images;
          this.db.markMessagesRead(merged.messageIds);
        }
        this.db.addEvent(type, text, {});
        const mode = this.db.getRuntime().mode;
        if (mode === "sleeping" || mode === "waiting") this.db.setRuntime({ mode: "awake", nextWakeAt: null });
        await this.activate(text, selected !== "vibration", images);
      })();
    }, this.db.getSettings().value.simulation.notificationWindowMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    for (const timer of this.db.claimDueTimers()) {
      const wasPaused = this.db.getRuntime().mode === "paused";
      if (timer.kind === "wait") {
        const merged = await this.waitElapsedText(timer);
        this.db.setRuntime({ ...(wasPaused ? {} : { mode: "awake" as const }), nextWakeAt: null });
        this.db.addEvent("wait_elapsed", merged.text, timer.payload, timer.dueAt);
        if (!wasPaused) {
          // Only a delivered summary advances the read watermark; a paused fire stays unread and resurfaces later.
          this.db.markMessagesRead(merged.messageIds);
          await this.activate(merged.text, false, merged.images);
        }
        continue;
      }
      const isAlarm = timer.kind === "alarm";
      const text = isAlarm ? "闹钟响了" : "你设置的自娱自乐时间到了，请进行下一步动作";
      this.db.setRuntime({ ...(wasPaused ? {} : { mode: "awake" as const }), nextWakeAt: null });
      this.db.addEvent(isAlarm ? "alarm_elapsed" : "idle_elapsed", text, timer.payload, timer.dueAt);
      if (!wasPaused) await this.activate(text, isAlarm);
    }
  }

  private selectedModel(agent: "simulation" | "synthesis"): { model: Model<any>; thinkingLevel: AgentSelection["thinkingLevel"] } {
    const selected = effectiveSelection(this.db, agent);
    const resolved = selected.providerId && selected.modelId ? this.providers.models.getModel(selected.providerId, selected.modelId) : undefined;
    if (!resolved) throw new Error(`${agent}_model_not_configured`);
    return { model: applySlotOverrides(this.providers, resolved, selected), thinkingLevel: selected.thinkingLevel };
  }

  private ensureSimulationAgent(): Agent {
    const selected = this.selectedModel("simulation");
    const prompt = renderPrompt(this.db.getPrompt("simulation").template, formatWorld(this.db));
    if (!this.simulationAgent) {
      const tools = buildSimulationTools(this.db, this.platform, this.mediaView());
      this.simulationAgent = new Agent({
        initialState: {
          systemPrompt: prompt, model: selected.model, thinkingLevel: selected.thinkingLevel,
          tools, messages: pruneStaleActionMenus(this.db.getAgentState<AgentMessage>("simulation")),
        },
        streamFn: this.providers.models.streamSimple.bind(this.providers.models),
        // Only the newest Action Menu reaches the model (issue #6, ADR-0009); the hook must not throw.
        transformContext: async (messages) => {
          try { return pruneStaleActionMenus(messages); } catch { return messages; }
        },
        toolExecution: "sequential",
        steeringMode: "all",
        followUpMode: "all",
        sessionId: "moonanbot-simulation",
      });
      this.simulationAgent.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "perform_action") this.simulationActionCalls += 1;
        if (event.type === "message_end" && this.simulationRunId) this.traceMessage(this.simulationRunId, event.message, "simulation");
        if (event.type === "agent_end") {
          if (this.simulationAgent) this.simulationAgent.state.messages = pruneStaleActionMenus(this.simulationAgent.state.messages);
          this.db.setAgentState("simulation", stripImageBlocks(pruneStaleActionMenus(event.messages)));
        }
      });
    }
    this.simulationAgent.state.systemPrompt = prompt;
    this.simulationAgent.state.model = selected.model;
    this.simulationAgent.state.thinkingLevel = selected.thinkingLevel;
    this.simulationAgent.state.tools = buildSimulationTools(this.db, this.platform, this.mediaView());
    return this.simulationAgent;
  }

  /** A run that ends while the Character is still awake scheduled no continuation (no Terminating Action) and must be corrected. */
  private needsContinuation(): boolean {
    return this.db.getRuntime().mode === "awake";
  }

  async activate(text: string, urgent = false, images: ImageContent[] = []): Promise<void> {
    if (this.db.getRuntime().mode === "paused") return;
    const message = `${text}\n\n${formatAvailableActions(listAvailableActions(this.db.getRuntime()))}`;
    let agent: Agent;
    try { agent = this.ensureSimulationAgent(); } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      this.db.setRuntime({ health: "degraded", lastError: problem });
      return;
    }
    if (agent.state.isStreaming) {
      const steering = userMessage(message, images);
      if (urgent) agent.steer(steering);
      else agent.followUp(steering);
      return;
    }
    const runId = this.db.beginAgentRun("simulation", text);
    this.simulationRunId = runId;
    this.simulationActionCalls = 0;
    try {
      if (images.length) await agent.prompt(message, images);
      else await agent.prompt(message);
      const settings = this.db.getSettings().value;
      for (let attempt = 0; this.needsContinuation() && attempt < settings.simulation.missingActionRetries; attempt += 1) {
        const name = this.db.getProfile().name;
        const correction = this.simulationActionCalls === 0
          ? `请让${name}执行一个动作，若你想暂时结束本轮，请让${name}自娱自乐、睡觉或在聊天窗口等待新消息`
          : `本轮动作已结束，但${name}没有安排下一步行动；请让${name}自娱自乐、睡觉或等待新消息以结束本轮。`;
        await agent.prompt(correction);
      }
      if (this.needsContinuation()) {
        const dueAt = Date.now() + 30 * 60_000;
        this.db.cancelPendingTimers();
        this.db.createTimer("idle", dueAt, { forced: true });
        this.db.setRuntime({ mode: "entertaining", health: "degraded", nextWakeAt: dueAt, lastError: "推演 Agent 连续未安排下一步行动" });
        this.db.addEvent("system_warning", "推演 Agent 连续未安排下一步行动，系统强制待机30分钟。", {});
      }
      const usage = this.usage(agent.state.messages);
      this.db.endAgentRun(runId, "completed", usage);
      if (this.db.getRuntime().mode === "sleeping") void this.scheduleSynthesis("sleep");
      const threshold = archiveThreshold(
        settings.simulation.contextArchiveTokens,
        selectedContext(agent.state.model),
        settings.simulation.contextModelRatio,
      );
      if (estimateContextTokens(agent.state.messages) >= threshold) void this.scheduleSynthesis("context_threshold");
    } catch (error) {
      const problem = error instanceof Error ? error.message : String(error);
      this.db.endAgentRun(runId, "failed", { input: 0, output: 0 }, problem);
      this.db.setRuntime({ health: "degraded", lastError: problem });
    } finally {
      this.simulationRunId = null;
    }
  }

  private scheduleSynthesis(trigger: string): Promise<void> {
    if (this.synthesisPromise) return this.synthesisPromise;
    this.synthesisPromise = this.runSynthesis(trigger).finally(() => { this.synthesisPromise = null; });
    return this.synthesisPromise;
  }

  async runSynthesis(trigger: string): Promise<void> {
    const end = Date.now();
    const start = this.db.lastSynthesisEnd();
    const events = this.db.eventsSince(start, end);
    const config = this.db.getSettings().value;
    const synthesisSeesImages = selectionSeesImages(this.providers, effectiveSelection(this.db, "synthesis"));
    const rendered = await renderSynthesisEvents(this.db, this.media, events, synthesisSeesImages);
    let lastError = "";
    for (let attempt = 1; attempt <= config.synthesis.retryCount; attempt += 1) {
      const runId = this.db.beginAgentRun("synthesis", trigger);
      const { tools, staging } = buildSynthesisTools(this.db);
      try {
        const selected = this.selectedModel("synthesis");
        const systemPrompt = renderPrompt(this.db.getPrompt("synthesis").template, formatWorld(this.db));
        const agent = new Agent({
          initialState: { systemPrompt, model: selected.model, thinkingLevel: selected.thinkingLevel, tools },
          streamFn: this.providers.models.streamSimple.bind(this.providers.models),
          toolExecution: "sequential",
          sessionId: `moonanbot-synthesis-${end}-${attempt}`,
        });
        agent.subscribe((event) => {
          if (event.type === "message_end") this.traceMessage(runId, event.message, "synthesis");
        });
        const period = `${new Date(start).toISOString()} 至 ${new Date(end).toISOString()}`;
        const input = `过去 ${period} 经历的事件：\n${events.length ? rendered.lines.join("\n") : "没有外部消息或其他已记录事件。"}\n请利用工具修改记忆和关系网，并调用 finish_synthesis。`;
        if (rendered.images.length) await agent.prompt(input, rendered.images);
        else await agent.prompt(input);
        staging.commit();
        const usage = this.usage(agent.state.messages);
        this.db.endAgentRun(runId, "completed", usage);
        this.db.setLastSynthesisEnd(end);
        this.trimSimulationContext();
        this.db.setRuntime({ health: "healthy", lastError: null });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.db.endAgentRun(runId, "failed", { input: 0, output: 0 }, lastError);
        if (attempt < config.synthesis.retryCount) await sleep(config.synthesis.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    this.db.setRuntime({ health: "degraded", lastError: `归纳失败：${lastError}` });
  }

  private trimSimulationContext(): void {
    const count = this.db.getSettings().value.simulation.retainedContextMessages;
    const existing = this.simulationAgent?.state.messages ?? this.db.getAgentState<AgentMessage>("simulation");
    let recent = existing.slice(-count);
    while (recent[0]?.role === "toolResult") recent = recent.slice(1);
    const handoff = userMessage("更久远的行为已归纳进长期记忆，以当前记忆为准。");
    const next = pruneStaleActionMenus([handoff, ...recent]);
    this.db.setAgentState("simulation", stripImageBlocks(next));
    if (this.simulationAgent) this.simulationAgent.state.messages = next;
  }

  private traceMessage(runId: string, message: AgentMessage, agent: "simulation" | "synthesis"): void {
    const standard = message as Message;
    if (standard.role === "user") {
      this.db.addAgentMessage(runId, "user", messageText(standard.content as any));
      return;
    }
    if (standard.role === "toolResult") {
      const tool = standard as ToolResultMessage;
      this.db.addAgentMessage(runId, "tool", messageText(tool.content as any), tool.toolName, { isError: tool.isError, details: tool.details ?? null });
      return;
    }
    if (standard.role === "assistant") {
      const assistant = standard as AssistantMessage;
      for (const block of assistant.content) {
        if (block.type === "thinking") this.db.addAgentMessage(runId, "reasoning", block.thinking, undefined, { redacted: block.redacted ?? false });
        else if (block.type === "text") this.db.addAgentMessage(runId, agent === "simulation" ? "director" : "assistant", block.text);
        else this.db.addAgentMessage(runId, "assistant", JSON.stringify(block.arguments), block.name, { toolCallId: block.id });
      }
    }
  }

  private usage(messages: AgentMessage[]): { input: number; output: number } {
    let input = 0;
    let output = 0;
    for (const message of messages as Message[]) {
      if (message.role === "assistant") {
        input += message.usage.input;
        output += message.usage.output;
      }
    }
    return { input, output };
  }
}

function selectedContext(model: Model<any>): number {
  return Number.isFinite(model.contextWindow) ? model.contextWindow : 128_000;
}

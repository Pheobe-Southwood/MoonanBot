import { randomUUID } from "node:crypto";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { archiveThreshold, estimateTokens, notificationFor } from "../domain/behavior.js";
import type { AgentSelection, Importance, StoredMessage } from "../domain/types.js";
import type { PlatformMessageEvent } from "../platforms/types.js";
import type { ChatPlatformAdapter } from "../platforms/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { MoonanDatabase } from "../storage/database.js";
import { renderPrompt } from "./prompts.js";
import { buildSimulationTools } from "./simulation-tools.js";
import { buildSynthesisTools } from "./synthesis-tools.js";

function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(content: string | Array<{ type: string; text?: string }>): string {
  return typeof content === "string" ? content : content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("");
}

function formatWorld(db: MoonanDatabase): Record<string, string> {
  const profile = db.getProfile();
  return {
    botName: profile.name,
    soul: profile.soul || "（尚未填写）",
    environment: profile.environment || "（尚未填写）",
    memory: JSON.stringify(db.listMemories(), null, 2),
    relationships: JSON.stringify(db.listContacts(), null, 2),
    groups: JSON.stringify(db.listGroups(), null, 2),
  };
}

function resolveSelection(selection: AgentSelection, fallback: AgentSelection): AgentSelection {
  return {
    providerId: selection.providerId ?? fallback.providerId,
    modelId: selection.modelId ?? fallback.modelId,
    thinkingLevel: selection.thinkingLevel ?? fallback.thinkingLevel,
  };
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

  constructor(
    private readonly db: MoonanDatabase,
    private readonly providers: ProviderRegistry,
    private readonly platform: ChatPlatformAdapter,
    private readonly random: () => number = Math.random,
  ) {}

  start(): void {
    if (this.timerLoop) return;
    this.stopped = false;
    this.timerLoop = setInterval(() => { void this.tick(); }, 1_000);
    void this.tick();
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timerLoop) clearInterval(this.timerLoop);
    if (this.notificationTimer) clearTimeout(this.notificationTimer);
    this.simulationAgent?.abort();
    await this.simulationAgent?.waitForIdle().catch(() => undefined);
    await this.synthesisPromise?.catch(() => undefined);
  }

  readiness(): { ready: boolean; problems: string[] } {
    const settings = this.db.getSettings().value;
    const profile = this.db.getProfile();
    const problems: string[] = [];
    if (!profile.name.trim()) problems.push("角色名称不能为空");
    if (!profile.soul.trim()) problems.push("请先填写 SOUL");
    for (const agent of ["simulation", "synthesis"] as const) {
      const selection = resolveSelection(settings.agents[agent], settings.agents.default);
      if (!selection.providerId || !selection.modelId) problems.push(`请为${agent === "simulation" ? "推演" : "归纳"} Agent 选择模型`);
      else if (!this.providers.models.getModel(selection.providerId, selection.modelId)) problems.push(`${agent} 模型不存在：${selection.providerId}/${selection.modelId}`);
    }
    return { ready: problems.length === 0, problems };
  }

  async startBot(): Promise<void> {
    const readiness = this.readiness();
    if (!readiness.ready) throw new Error(readiness.problems.join("；"));
    this.db.setRuntime({ mode: "awake", health: "healthy", nextWakeAt: null, lastError: null });
    this.db.addEvent("character_started", "你醒来了", {});
    await this.activate("你醒来了");
  }

  pauseBot(): void {
    this.db.setRuntime({ mode: "paused" });
    this.simulationAgent?.abort();
  }

  async wakeBot(): Promise<void> {
    this.db.setRuntime({ mode: "awake", nextWakeAt: null });
    this.db.addEvent("operator_wake", "你被唤醒了，请决定下一步行动。", {});
    await this.activate("你被唤醒了，请决定下一步行动。");
  }

  setOutbound(enabled: boolean): void {
    this.db.setRuntime({ outboundEnabled: enabled });
  }

  async handleIncoming(event: PlatformMessageEvent): Promise<void> {
    const existing = this.db.getContact(event.senderId);
    this.db.upsertContact({
      platform: "onebot", id: event.senderId, name: event.senderName, aliases: existing?.aliases ?? [],
      summary: existing?.summary ?? "", importance: existing?.importance ?? "normal", isFriend: existing?.isFriend ?? event.target.kind === "private",
    }, "observation", false);
    if (event.target.kind === "group") {
      const group = this.db.listGroups().find((item) => item.id === event.target.id);
      this.db.upsertGroup({ platform: "onebot", id: event.target.id, name: event.target.name ?? group?.name ?? event.target.id, summary: group?.summary ?? "" }, "observation");
    }
    const stored: StoredMessage = {
      id: randomUUID(), platformMessageId: event.platformMessageId, target: event.target,
      senderId: event.senderId, senderName: event.senderName, direction: "incoming", content: event.content,
      segments: event.segments, occurredAt: event.occurredAt, observedAt: Date.now(), deliveryStatus: "received", readAt: null,
    };
    if (!this.db.insertMessage(stored)) return;
    this.db.addEvent("message_observed", `${event.senderName}在${event.target.kind === "group" ? "群聊" : "私聊"}中发来：${event.content}`, {
      target: event.target, senderId: event.senderId, messageId: event.platformMessageId,
    }, event.occurredAt);
    const runtime = this.db.getRuntime();
    if (runtime.mode === "paused") return;
    const importance: Importance = existing?.importance ?? "normal";
    const decision = notificationFor(event.target.kind, importance, runtime.mode === "sleeping", this.random, this.db.getSettings().value.simulation.priorityWakeProbability);
    if (decision.signal === "none" || !decision.wakes) return;
    this.queueNotification(decision.signal);
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
      const text = selected === "alarm" ? "手机闹钟响了" : selected === "ring" ? "手机响了" : "手机振动了";
      const type = selected === "alarm" ? "phone_alarm" : selected === "ring" ? "phone_ring" : "phone_vibration";
      this.db.addEvent(type, text, {});
      if (this.db.getRuntime().mode === "sleeping") this.db.setRuntime({ mode: "awake" });
      void this.activate(text, selected !== "vibration");
    }, this.db.getSettings().value.simulation.notificationWindowMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    for (const timer of this.db.claimDueTimers()) {
      const wasPaused = this.db.getRuntime().mode === "paused";
      const isAlarm = timer.kind === "alarm";
      const text = isAlarm ? "闹钟响了" : "你设置的自娱自乐时间到了，请进行下一步动作";
      this.db.setRuntime({ ...(wasPaused ? {} : { mode: "awake" as const }), nextWakeAt: null });
      this.db.addEvent(isAlarm ? "alarm_elapsed" : "idle_elapsed", text, timer.payload, timer.dueAt);
      if (!wasPaused) await this.activate(text, isAlarm);
    }
  }

  private selectedModel(agent: "simulation" | "synthesis"): { model: Model<any>; thinkingLevel: AgentSelection["thinkingLevel"] } {
    const config = this.db.getSettings().value.agents;
    const selected = resolveSelection(config[agent], config.default);
    const model = selected.providerId && selected.modelId ? this.providers.models.getModel(selected.providerId, selected.modelId) : undefined;
    if (!model) throw new Error(`${agent}_model_not_configured`);
    return { model, thinkingLevel: selected.thinkingLevel };
  }

  private ensureSimulationAgent(): Agent {
    const selected = this.selectedModel("simulation");
    const prompt = renderPrompt(this.db.getPrompt("simulation").template, formatWorld(this.db));
    if (!this.simulationAgent) {
      const tools = buildSimulationTools(this.db, this.platform);
      this.simulationAgent = new Agent({
        initialState: {
          systemPrompt: prompt, model: selected.model, thinkingLevel: selected.thinkingLevel,
          tools, messages: this.db.getAgentState<AgentMessage>("simulation"),
        },
        streamFn: this.providers.models.streamSimple.bind(this.providers.models),
        toolExecution: "sequential",
        steeringMode: "all",
        followUpMode: "all",
        sessionId: "moonanbot-simulation",
      });
      this.simulationAgent.subscribe((event) => {
        if (event.type === "tool_execution_end" && event.toolName === "perform_action") this.simulationActionCalls += 1;
        if (event.type === "message_end" && this.simulationRunId) this.traceMessage(this.simulationRunId, event.message, "simulation");
        if (event.type === "agent_end") this.db.setAgentState("simulation", event.messages);
      });
    }
    this.simulationAgent.state.systemPrompt = prompt;
    this.simulationAgent.state.model = selected.model;
    this.simulationAgent.state.thinkingLevel = selected.thinkingLevel;
    this.simulationAgent.state.tools = buildSimulationTools(this.db, this.platform);
    return this.simulationAgent;
  }

  async activate(text: string, urgent = false): Promise<void> {
    if (this.db.getRuntime().mode === "paused") return;
    let agent: Agent;
    try { agent = this.ensureSimulationAgent(); } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.setRuntime({ health: "degraded", lastError: message });
      return;
    }
    if (agent.state.isStreaming) {
      if (urgent) agent.steer(userMessage(text));
      else agent.followUp(userMessage(text));
      return;
    }
    const runId = this.db.beginAgentRun("simulation", text);
    this.simulationRunId = runId;
    this.simulationActionCalls = 0;
    this.db.addAgentMessage(runId, "user", text);
    try {
      await agent.prompt(text);
      const settings = this.db.getSettings().value;
      for (let attempt = 0; this.simulationActionCalls === 0 && attempt < settings.simulation.missingActionRetries; attempt += 1) {
        const correction = `请让${this.db.getProfile().name}执行一个动作，若你想暂时结束会话，请让${this.db.getProfile().name}自娱自乐或睡觉`;
        this.db.addAgentMessage(runId, "user", correction);
        await agent.prompt(correction);
      }
      if (this.simulationActionCalls === 0) {
        const dueAt = Date.now() + 30 * 60_000;
        this.db.cancelPendingTimers();
        this.db.createTimer("idle", dueAt, { forced: true });
        this.db.setRuntime({ mode: "entertaining", health: "degraded", nextWakeAt: dueAt, lastError: "推演 Agent 连续未执行动作" });
        this.db.addEvent("system_warning", "推演 Agent 连续未执行动作，系统强制待机30分钟。", {});
      }
      const usage = this.usage(agent.state.messages);
      this.db.endAgentRun(runId, "completed", usage);
      if (this.db.getRuntime().mode === "sleeping") void this.scheduleSynthesis("sleep");
      const threshold = archiveThreshold(
        settings.simulation.contextArchiveTokens,
        selectedContext(agent.state.model),
        settings.simulation.contextModelRatio,
      );
      if (estimateTokens(JSON.stringify(agent.state.messages)) >= threshold) void this.scheduleSynthesis("context_threshold");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.endAgentRun(runId, "failed", { input: 0, output: 0 }, message);
      this.db.setRuntime({ health: "degraded", lastError: message });
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
    const batchId = this.db.createSynthesisBatch(start, end);
    const config = this.db.getSettings().value;
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
          sessionId: `moonanbot-synthesis-${batchId}-${attempt}`,
        });
        agent.subscribe((event) => {
          if (event.type === "message_end") this.traceMessage(runId, event.message, "synthesis");
        });
        const period = `${new Date(start).toISOString()} 至 ${new Date(end).toISOString()}`;
        const input = `过去 ${period} 经历的事件：\n${events.length ? events.map((event) => `[${new Date(event.occurredAt).toISOString()}] ${event.text}`).join("\n") : "没有外部消息或其他已记录事件。"}\n请利用工具修改记忆和关系网，并调用 finish_synthesis。`;
        this.db.addAgentMessage(runId, "user", input);
        await agent.prompt(input);
        staging.commit();
        const usage = this.usage(agent.state.messages);
        this.db.endAgentRun(runId, "completed", usage);
        this.db.updateSynthesisBatch(batchId, "completed", attempt, staging.summary);
        this.trimSimulationContext();
        this.db.setRuntime({ health: "healthy", lastError: null });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.db.endAgentRun(runId, "failed", { input: 0, output: 0 }, lastError);
        this.db.updateSynthesisBatch(batchId, "retrying", attempt, undefined, lastError);
        if (attempt < config.synthesis.retryCount) await sleep(config.synthesis.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }
    this.db.updateSynthesisBatch(batchId, "pending", config.synthesis.retryCount, undefined, lastError);
    this.db.setRuntime({ health: "degraded", lastError: `归纳失败：${lastError}` });
  }

  private trimSimulationContext(): void {
    const count = this.db.getSettings().value.simulation.retainedContextMessages;
    const existing = this.simulationAgent?.state.messages ?? this.db.getAgentState<AgentMessage>("simulation");
    let recent = existing.slice(-count);
    while (recent[0]?.role === "toolResult") recent = recent.slice(1);
    const handoff = userMessage("更久远的行为已归纳进长期记忆，以当前记忆为准。");
    const next = [handoff, ...recent];
    this.db.setAgentState("simulation", next);
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

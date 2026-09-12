export type RuntimeMode = "paused" | "awake" | "entertaining" | "sleeping";
export type RuntimeHealth = "healthy" | "degraded" | "faulted";
export type Importance = "priority_plus" | "priority" | "normal" | "do_not_disturb" | "no_push";
export type TargetKind = "private" | "group";
export type PhoneState =
  | { kind: "closed" }
  | { kind: "home" }
  | { kind: "chat"; target: ConversationTarget };

export interface ConversationTarget {
  platform: "onebot";
  kind: TargetKind;
  id: string;
  name?: string;
}

export interface RuntimeState {
  mode: RuntimeMode;
  health: RuntimeHealth;
  phone: PhoneState;
  outboundEnabled: boolean;
  activeSelfId: string | null;
  nextWakeAt: number | null;
  lastError: string | null;
  updatedAt: number;
}

export interface CharacterProfile {
  name: string;
  timezone: string;
  locale: "zh-CN" | "en";
  soul: string;
  environment: string;
  version: number;
  updatedAt: number;
}

export interface MemoryRecord {
  id: string;
  occurredAt: number;
  summary: string;
  details: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ContactRecord {
  platform: "onebot";
  id: string;
  name: string;
  aliases: string[];
  summary: string;
  importance: Importance;
  isFriend: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface GroupRecord {
  platform: "onebot";
  id: string;
  name: string;
  summary: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredMessage {
  id: string;
  platformMessageId: string | null;
  target: ConversationTarget;
  senderId: string;
  senderName: string;
  direction: "incoming" | "outgoing";
  content: string;
  segments: unknown[];
  occurredAt: number;
  observedAt: number;
  deliveryStatus: "received" | "pending" | "sent" | "failed" | "unknown";
  readAt: number | null;
}

export type WorldEventType =
  | "character_started"
  | "operator_wake"
  | "phone_alarm"
  | "phone_ring"
  | "phone_vibration"
  | "idle_elapsed"
  | "alarm_elapsed"
  | "action_completed"
  | "message_observed"
  | "system_warning";

export interface WorldEvent {
  id: string;
  type: WorldEventType;
  occurredAt: number;
  text: string;
  data: Record<string, unknown>;
}

export interface AgentSelection {
  providerId: string | null;
  modelId: string | null;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
}

export interface AppSettings {
  web: { host: string; port: number; locale: "auto" | "zh-CN" | "en" };
  onebot: {
    accessToken: string;
    apiTimeoutMs: number;
    privateAllowlist: string[];
    groupAllowlist: string[];
  };
  simulation: {
    idleMinMinutes: number;
    idleMaxMinutes: number;
    sleepMinMinutes: number;
    sleepMaxMinutes: number;
    notificationWindowMs: number;
    priorityWakeProbability: number;
    chatPreviewMessages: number;
    historyMaxMessages: number;
    messageIntervalMs: number;
    maxMessageCharacters: number;
    maxSendPayloadBytes: number;
    missingActionRetries: number;
    contextArchiveTokens: number;
    contextModelRatio: number;
    retainedContextMessages: number;
  };
  synthesis: {
    memorySoftTokens: number;
    memoryHardTokens: number;
    retryCount: number;
    retryBaseDelayMs: number;
  };
  agents: {
    default: AgentSelection;
    simulation: AgentSelection;
    synthesis: AgentSelection;
  };
}

export interface SettingsEnvelope {
  value: AppSettings;
  version: number;
  updatedAt: number;
}

export interface AgentTraceMessage {
  id: string;
  runId: string;
  role: "system" | "user" | "assistant" | "tool" | "director" | "reasoning";
  content: string;
  name: string | null;
  occurredAt: number;
  metadata: Record<string, unknown>;
}

export interface AgentRunSummary {
  id: string;
  agent: "simulation" | "synthesis";
  status: "running" | "completed" | "failed" | "aborted" | "skipped";
  trigger: string;
  startedAt: number;
  endedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
}

export interface NotificationDecision {
  signal: "alarm" | "ring" | "vibration" | "none";
  wakes: boolean;
  visibleOnPhone: boolean;
}

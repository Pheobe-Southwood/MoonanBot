export type RuntimeMode = "paused" | "awake" | "entertaining" | "sleeping" | "waiting";
export type RuntimeHealth = "healthy" | "degraded" | "faulted";
export type Importance = "priority_plus" | "priority" | "normal" | "do_not_disturb" | "no_push";
export type TargetKind = "private" | "group";
export type PhoneState =
  | { kind: "closed" }
  | { kind: "home" }
  | { kind: "contacts" }
  | { kind: "chat"; target: ConversationTarget; cursor?: number | null };

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
  | "wait_elapsed"
  | "action_completed"
  | "message_observed"
  | "roster_sync"
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
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Operator override: treat the selected model as image-capable even when its catalog entry says otherwise. */
  forceImageInput?: boolean;
}

export type AgentKind = "simulation" | "synthesis" | "vision";

/** One inbound image tracked in the media cache: raw bytes (TTL-bound) plus the permanent text description. */
export interface MessageMedia {
  id: string;
  messageId: string;
  segmentIndex: number;
  kind: "image";
  fileId: string;
  url: string | null;
  mime: string | null;
  byteSize: number;
  bytes: Uint8Array | null;
  status: "pending" | "cached" | "failed";
  error: string | null;
  description: string | null;
  describedAt: number | null;
  fetchedAt: number | null;
  purgedAt: number | null;
  createdAt: number;
}

export interface OneBotOutboundClient {
  name: string;
  url: string;
  accessToken: string;
  selfId: string;
  role: OneBotRole;
  reconnectIntervalMs: number;
  enabled: boolean;
}

export type OneBotRole = "event" | "api" | "universal";

export interface AppSettings {
  web: { host: string; port: number };
  onebot: {
    accessToken: string;
    apiTimeoutMs: number;
    privateAllowlist: string[];
    groupAllowlist: string[];
    acceptReverse: boolean;
    outbound: OneBotOutboundClient[];
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
    waitMinSeconds: number;
    waitMaxSeconds: number;
    waitMinMessages: number;
    waitMaxMessages: number;
    waitMessageTimeoutSeconds: number;
    contactListMaxEntries: number;
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
  media: {
    enabled: boolean;
    downloadTimeoutMs: number;
    byteTtlDays: number;
    maxInjectedImages: number;
  };
  agents: {
    default: AgentSelection;
    simulation: AgentSelection;
    synthesis: AgentSelection;
    vision: AgentSelection;
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
  agent: AgentKind;
  status: "running" | "completed" | "failed";
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

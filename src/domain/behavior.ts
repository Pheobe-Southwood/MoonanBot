import type {
  AppSettings,
  Importance,
  NotificationDecision,
  RuntimeState,
  TargetKind,
} from "./types.js";

export type ActionId =
  | "idle"
  | "sleep"
  | "set_contact_importance"
  | "open_phone"
  | "view_contacts"
  | "open_chat"
  | "load_history"
  | "send_messages"
  | "wait_messages"
  | "close_phone";

export interface AvailableAction {
  id: ActionId;
  description: string;
  parameters: Record<string, unknown>;
}

export function listAvailableActions(runtime: RuntimeState): AvailableAction[] {
  const actions: AvailableAction[] = [
    { id: "idle", description: "自娱自乐一会并设置再次行动的时间；手机会被收起。", parameters: { durationMinutes: "number", activity: "string?" } },
    { id: "sleep", description: "睡觉并设置闹钟；手机会被收起。", parameters: { durationMinutes: "number" } },
  ];
  const phone = runtime.phone;
  if (phone.kind === "closed") {
    actions.push({ id: "open_phone", description: "打开手机并查看时间与未读提示。", parameters: {} });
    return actions;
  }
  actions.push({ id: "view_contacts", description: "查看好友和群聊列表，含未读数与最近一条消息。", parameters: {} });
  if (phone.kind === "contacts") {
    actions.push(
      { id: "open_chat", description: "进入好友或群聊的聊天窗口。", parameters: { kind: "private|group", targetId: "string" } },
      { id: "set_contact_importance", description: "更改任意一个好友的消息重要程度。", parameters: { contactId: "string", importance: "importance" } },
    );
  }
  if (phone.kind === "chat") {
    actions.push(
      { id: "load_history", description: "从读取游标继续向上查看当前聊天的本地历史。", parameters: { count: "number?" } },
      { id: "send_messages", description: "向当前聊天逐条发送文本。", parameters: { messages: "string[]" } },
      { id: "wait_messages", description: "盯着当前聊天窗口等待新消息并结束本轮：durationSeconds 与 messageCount 二选一。", parameters: { durationSeconds: "number?", messageCount: "number?" } },
    );
    if (phone.target.kind === "private") {
      actions.push({ id: "set_contact_importance", description: "更改当前聊天好友的消息重要程度。", parameters: { contactId: "string", importance: "importance" } });
    }
  }
  actions.push({ id: "close_phone", description: "关闭手机。", parameters: {} });
  return actions;
}

export function formatAvailableActions(actions: AvailableAction[]): string {
  const lines = actions.map((action) => {
    const parameters = Object.entries(action.parameters).map(([key, value]) => `${key}: ${String(value)}`).join(", ");
    return `- ${action.id}${parameters ? `(${parameters})` : ""}：${action.description}`;
  });
  return `接下来可用的动作:\n${lines.join("\n")}`;
}

export function validateDuration(action: "idle" | "sleep", minutes: number, settings: AppSettings): void {
  const minimum = action === "idle" ? settings.simulation.idleMinMinutes : settings.simulation.sleepMinMinutes;
  const maximum = action === "idle" ? settings.simulation.idleMaxMinutes : settings.simulation.sleepMaxMinutes;
  if (!Number.isFinite(minutes) || minutes < minimum || minutes > maximum) {
    throw new Error(`${action} 时长必须在 ${minimum} 到 ${maximum} 分钟之间`);
  }
}

export type WaitPlan = { mode: "seconds"; seconds: number } | { mode: "count"; count: number };

export function validateWait(input: { durationSeconds?: number; messageCount?: number }, settings: AppSettings): WaitPlan {
  const hasSeconds = input.durationSeconds !== undefined;
  const hasCount = input.messageCount !== undefined;
  if (hasSeconds === hasCount) throw new Error("wait_messages 需要 durationSeconds 与 messageCount 二选一");
  if (hasSeconds) {
    const seconds = input.durationSeconds!;
    const { waitMinSeconds, waitMaxSeconds } = settings.simulation;
    if (!Number.isFinite(seconds) || seconds < waitMinSeconds || seconds > waitMaxSeconds) {
      throw new Error(`durationSeconds 必须在 ${waitMinSeconds} 到 ${waitMaxSeconds} 秒之间`);
    }
    return { mode: "seconds", seconds };
  }
  const count = input.messageCount!;
  const { waitMinMessages, waitMaxMessages } = settings.simulation;
  if (!Number.isInteger(count) || count < waitMinMessages || count > waitMaxMessages) {
    throw new Error(`messageCount 必须是 ${waitMinMessages} 到 ${waitMaxMessages} 之间的整数`);
  }
  return { mode: "count", count };
}

/** True when a group message's segments @ the Character's own account, including @all. */
export function segmentsMention(segments: unknown[], selfId: string | null): boolean {
  if (!selfId) return false;
  return segments.some((segment) => {
    if (!segment || typeof segment !== "object") return false;
    const candidate = segment as { type?: unknown; data?: unknown };
    if (candidate.type !== "at" || !candidate.data || typeof candidate.data !== "object") return false;
    const qq = (candidate.data as { qq?: unknown }).qq;
    return qq === "all" || String(qq ?? "") === selfId;
  });
}

export function notificationFor(
  kind: TargetKind,
  importance: Importance,
  sleeping: boolean,
  random: () => number,
  priorityWakeProbability: number,
  mention = false,
): NotificationDecision {
  if (importance === "no_push") return { signal: "none", wakes: false, visibleOnPhone: false };
  if (importance === "do_not_disturb") return { signal: "none", wakes: false, visibleOnPhone: true };
  if (kind === "group" && !mention) {
    if (importance === "priority_plus") return { signal: "vibration", wakes: !sleeping, visibleOnPhone: true };
    return { signal: "none", wakes: false, visibleOnPhone: true };
  }
  if (importance === "priority_plus") return { signal: "alarm", wakes: true, visibleOnPhone: true };
  if (importance === "priority") {
    return { signal: "ring", wakes: !sleeping || random() < priorityWakeProbability, visibleOnPhone: true };
  }
  return { signal: "vibration", wakes: !sleeping, visibleOnPhone: true };
}

export function archiveThreshold(configured: number, modelContext: number, modelRatio = 0.8): number {
  if (!Number.isFinite(modelRatio) || modelRatio <= 0 || modelRatio > 1) throw new Error("模型上下文归档比例必须在 0 到 1 之间");
  return Math.max(1, Math.floor(Math.min(configured, modelContext * modelRatio)));
}

export function estimateTokens(text: string): number {
  let ascii = 0;
  for (const character of text) if (character.charCodeAt(0) <= 0x7f) ascii += 1;
  const nonAscii = text.length - ascii;
  return Math.ceil(ascii / 4 + nonAscii * 0.6);
}

/** Flat per-image budget used when estimating context size, so base64 payloads never reach the token math. */
export const IMAGE_TOKEN_ESTIMATE = 1_500;

/** Context-size estimate over agent messages that counts image blocks as a flat value instead of their base64 length. */
export function estimateContextTokens(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") { total += estimateTokens(content); continue; }
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string; thinking?: string; arguments?: unknown }>) {
      if (block?.type === "image") total += IMAGE_TOKEN_ESTIMATE;
      else if (typeof block?.text === "string") total += estimateTokens(block.text);
      else if (typeof block?.thinking === "string") total += estimateTokens(block.thinking);
      else if (block?.type === "toolCall") total += estimateTokens(JSON.stringify(block.arguments ?? {}));
    }
  }
  return total;
}

/** Effective image capability of one agent slot: the model's catalog modalities or the operator's per-slot override. */
export function supportsImageInput(
  model: { input?: readonly string[] } | undefined,
  selection: { forceImageInput?: boolean } | undefined,
): boolean {
  return (model?.input?.includes("image") ?? false) || selection?.forceImageInput === true;
}

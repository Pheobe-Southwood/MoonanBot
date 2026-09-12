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
  | "open_chat"
  | "load_history"
  | "send_messages"
  | "close_phone";

export interface AvailableAction {
  id: ActionId;
  description: string;
  parameters: Record<string, unknown>;
}

export function listAvailableActions(runtime: RuntimeState): AvailableAction[] {
  const base: AvailableAction[] = [
    { id: "idle", description: "自娱自乐一会并设置再次行动的时间。", parameters: { durationMinutes: "number", activity: "string" } },
    { id: "sleep", description: "睡觉并设置闹钟。", parameters: { durationMinutes: "number" } },
    { id: "set_contact_importance", description: "更改一个人的消息重要程度。", parameters: { contactId: "string", importance: "importance" } },
  ];
  if (runtime.phone.kind === "closed") {
    base.push({ id: "open_phone", description: "打开手机并查看时间和未读摘要。", parameters: {} });
  } else {
    base.push({ id: "open_chat", description: "打开好友或群聊窗口。", parameters: { kind: "private|group", targetId: "string" } });
    base.push({ id: "close_phone", description: "关闭手机。", parameters: {} });
  }
  if (runtime.phone.kind === "chat") {
    base.push({ id: "load_history", description: "查看更多当前聊天的本地历史。", parameters: { count: "number" } });
    base.push({ id: "send_messages", description: "向当前聊天逐条发送文本。", parameters: { messages: "string[]" } });
  }
  return base;
}

export function validateDuration(action: "idle" | "sleep", minutes: number, settings: AppSettings): void {
  const minimum = action === "idle" ? settings.simulation.idleMinMinutes : settings.simulation.sleepMinMinutes;
  const maximum = action === "idle" ? settings.simulation.idleMaxMinutes : settings.simulation.sleepMaxMinutes;
  if (!Number.isFinite(minutes) || minutes < minimum || minutes > maximum) {
    throw new Error(`${action} 时长必须在 ${minimum} 到 ${maximum} 分钟之间`);
  }
}

export function notificationFor(
  kind: TargetKind,
  importance: Importance,
  sleeping: boolean,
  random: () => number,
  priorityWakeProbability: number,
): NotificationDecision {
  if (importance === "no_push") return { signal: "none", wakes: false, visibleOnPhone: false };
  if (importance === "do_not_disturb") return { signal: "none", wakes: false, visibleOnPhone: true };
  if (kind === "group") {
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

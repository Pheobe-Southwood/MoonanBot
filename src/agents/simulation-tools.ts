import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { listAvailableActions, validateDuration } from "../domain/behavior.js";
import type { ConversationTarget, Importance, StoredMessage } from "../domain/types.js";
import type { ChatPlatformAdapter } from "../platforms/types.js";
import type { MoonanDatabase } from "../storage/database.js";

function result(text: string, details: Record<string, unknown> = {}, terminate = false): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details, ...(terminate ? { terminate: true } : {}) };
}

function formatMessages(messages: StoredMessage[]): string {
  if (!messages.length) return "没有本地已观测消息。";
  return messages.map((message) => {
    const time = new Date(message.occurredAt).toISOString();
    return `[${time}] ${message.senderName}(${message.senderId}): ${message.content}`;
  }).join("\n");
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(new Error("发送已中止")); };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

const actionSchema = Type.Object({
  action: Type.Union([
    Type.Literal("idle"), Type.Literal("sleep"), Type.Literal("set_contact_importance"), Type.Literal("open_phone"),
    Type.Literal("open_chat"), Type.Literal("load_history"), Type.Literal("send_messages"), Type.Literal("close_phone"),
  ]),
  durationMinutes: Type.Optional(Type.Number()),
  activity: Type.Optional(Type.String({ maxLength: 2_000 })),
  contactId: Type.Optional(Type.String({ minLength: 1 })),
  importance: Type.Optional(Type.Union([
    Type.Literal("priority_plus"), Type.Literal("priority"), Type.Literal("normal"),
    Type.Literal("do_not_disturb"), Type.Literal("no_push"),
  ])),
  kind: Type.Optional(Type.Union([Type.Literal("private"), Type.Literal("group")])),
  targetId: Type.Optional(Type.String({ minLength: 1 })),
  count: Type.Optional(Type.Integer({ minimum: 1 })),
  messages: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
}, { additionalProperties: false });

export function buildSimulationTools(db: MoonanDatabase, platform: ChatPlatformAdapter): AgentTool[] {
  const listTool: AgentTool = {
    name: "list_available_actions",
    label: "列出可用动作",
    description: "列出角色在当前手机与运行状态下可以执行的动作及其参数。",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => result(JSON.stringify(listAvailableActions(db.getRuntime()), null, 2), { actions: listAvailableActions(db.getRuntime()) }),
  };

  const performTool: AgentTool<typeof actionSchema> = {
    name: "perform_action",
    label: "执行角色动作",
    description: "让角色执行一个经过状态校验的具体动作。只有 send_messages 会向外部聊天发送文字。",
    parameters: actionSchema,
    executionMode: "sequential",
    replay: "never",
    execute: async (_toolCallId, params, signal) => {
      const settings = db.getSettings().value;
      let runtime = db.getRuntime();
      const profile = db.getProfile();
      const allowed = new Set(listAvailableActions(runtime).map((item) => item.id));
      if (!allowed.has(params.action)) throw new Error(`当前状态不能执行 ${params.action}`);

      if (params.action === "idle") {
        if (params.durationMinutes === undefined) throw new Error("idle 需要 durationMinutes");
        validateDuration("idle", params.durationMinutes, settings);
        db.cancelPendingTimers();
        const dueAt = Date.now() + params.durationMinutes * 60_000;
        db.createTimer("idle", dueAt, { activity: params.activity ?? "自娱自乐" });
        runtime = db.setRuntime({ mode: "entertaining", nextWakeAt: dueAt });
        db.addEvent("action_completed", `${profile.name}${params.activity ?? "自娱自乐"}，预计 ${params.durationMinutes} 分钟后结束。`, { action: "idle", dueAt });
        return result(`${profile.name}开始${params.activity ?? "自娱自乐"}，将在设定时间结束后继续行动。`, { runtime }, true);
      }

      if (params.action === "sleep") {
        if (params.durationMinutes === undefined) throw new Error("sleep 需要 durationMinutes");
        validateDuration("sleep", params.durationMinutes, settings);
        db.cancelPendingTimers();
        const dueAt = Date.now() + params.durationMinutes * 60_000;
        db.createTimer("alarm", dueAt);
        runtime = db.setRuntime({ mode: "sleeping", phone: { kind: "closed" }, nextWakeAt: dueAt });
        db.addEvent("action_completed", `${profile.name}睡觉并设置了 ${params.durationMinutes} 分钟后的闹钟。`, { action: "sleep", dueAt });
        return result(`${profile.name}睡着了，闹钟已经设置。`, { runtime }, true);
      }

      if (params.action === "set_contact_importance") {
        if (!params.contactId || !params.importance) throw new Error("需要 contactId 和 importance");
        const contact = db.setContactImportance(params.contactId, params.importance as Importance);
        db.addEvent("action_completed", `${profile.name}将${contact.name}的消息重要度设为 ${contact.importance}。`, { action: params.action, contactId: contact.id });
        return result(`已将 ${contact.name} 的消息重要度设为 ${contact.importance}。`, { contact });
      }

      if (params.action === "open_phone") {
        runtime = db.setRuntime({ phone: { kind: "home" } });
        const unread = db.unreadSummary(false);
        const localTime = new Intl.DateTimeFormat(profile.locale, { dateStyle: "full", timeStyle: "long", timeZone: profile.timezone }).format(new Date());
        const friends = unread.filter((item) => item.target.kind === "private").map((item) => `${item.target.name ?? item.target.id}：${item.count} 条`).join("；") || "无";
        const groups = unread.filter((item) => item.target.kind === "group").map((item) => `${item.target.name ?? item.target.id}：${item.count} 条`).join("；") || "无";
        db.addEvent("action_completed", `${profile.name}打开了手机。`, { action: params.action });
        return result(`${profile.name}打开了手机，当前时间为 ${localTime}。\n以下好友有新消息：${friends}\n以下群聊有新消息：${groups}`, { runtime, unread });
      }

      if (params.action === "open_chat") {
        if (!params.kind || !params.targetId) throw new Error("需要 kind 和 targetId");
        const targetName = params.kind === "private"
          ? db.getContact(params.targetId)?.name
          : db.listGroups().find((item) => item.id === params.targetId)?.name;
        const target: ConversationTarget = {
          platform: "onebot", kind: params.kind, id: params.targetId,
          ...(targetName ? { name: targetName } : {}),
        };
        runtime = db.setRuntime({ phone: { kind: "chat", target } });
        const messages = db.listMessages(target, settings.simulation.chatPreviewMessages);
        db.markTargetRead(target);
        db.addEvent("action_completed", `${profile.name}打开了${target.name ?? target.id}的聊天窗口。`, { action: params.action, target });
        return result(`${profile.name}打开了${target.name ?? target.id}的聊天窗口，以下是最近 ${messages.length} 条本地已观测消息：\n${formatMessages(messages)}`, { runtime, messages });
      }

      if (params.action === "load_history") {
        if (runtime.phone.kind !== "chat") throw new Error("需要先打开目标聊天窗口");
        const count = Math.min(params.count ?? settings.simulation.chatPreviewMessages, settings.simulation.historyMaxMessages);
        const messages = db.listMessages(runtime.phone.target, count);
        return result(`以下是 ${messages.length} 条本地已观测历史（MoonanBot 不保证包含首次运行前的记录）：\n${formatMessages(messages)}`, { messages, localOnly: true });
      }

      if (params.action === "send_messages") {
        if (runtime.phone.kind !== "chat") throw new Error("需要先打开目标聊天窗口");
        if (!runtime.outboundEnabled) throw new Error("出站消息总开关已关闭");
        const messages = params.messages ?? [];
        if (!messages.length) throw new Error("messages 不能为空");
        if (Buffer.byteLength(JSON.stringify(messages), "utf8") > settings.simulation.maxSendPayloadBytes) throw new Error("消息参数超过 256 KiB 上限");
        if (messages.some((message) => [...message].length > settings.simulation.maxMessageCharacters)) throw new Error(`单条消息不能超过 ${settings.simulation.maxMessageCharacters} 字符`);
        const sent: Array<{ id: string; status: string; platformMessageId: string | null }> = [];
        for (let index = 0; index < messages.length; index += 1) {
          if (signal?.aborted) throw new Error("发送已中止");
          const content = messages[index]!;
          const id = randomUUID();
          db.insertMessage({
            id, platformMessageId: null, target: runtime.phone.target, senderId: runtime.activeSelfId ?? profile.name,
            senderName: profile.name, direction: "outgoing", content, segments: [{ type: "text", data: { text: content } }],
            occurredAt: Date.now(), observedAt: Date.now(), deliveryStatus: "pending", readAt: Date.now(),
          });
          db.updateMessageDelivery(id, "unknown");
          try {
            const response = await platform.sendText(runtime.phone.target, content, signal);
            db.updateMessageDelivery(id, "sent", response.platformMessageId ?? undefined);
            sent.push({ id, status: "sent", platformMessageId: response.platformMessageId });
          } catch (error) {
            sent.push({ id, status: "unknown", platformMessageId: null });
            throw new Error(`发送结果未知：${error instanceof Error ? error.message : String(error)}`);
          }
          if (index < messages.length - 1) await pause(settings.simulation.messageIntervalMs, signal);
        }
        db.addEvent("action_completed", `${profile.name}向${runtime.phone.target.name ?? runtime.phone.target.id}发送了 ${sent.length} 条消息。`, { action: params.action, target: runtime.phone.target, sent });
        return result(`已按顺序发送 ${sent.length} 条消息。`, { sent });
      }

      runtime = db.setRuntime({ phone: { kind: "closed" } });
      db.addEvent("action_completed", `${profile.name}关闭了手机。`, { action: "close_phone" });
      return result(`${profile.name}关闭了手机。`, { runtime });
    },
  };
  return [listTool, performTool];
}

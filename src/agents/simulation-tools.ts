import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { formatAvailableActions, formatObservedMessages, listAvailableActions, validateDuration, validateWait } from "../domain/behavior.js";
import type { ConversationTarget, Importance, StoredMessage } from "../domain/types.js";
import type { ChatPlatformAdapter } from "../platforms/types.js";
import type { MoonanDatabase } from "../storage/database.js";

function result(text: string, details: Record<string, unknown> = {}, terminate = false): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details, ...(terminate ? { terminate: true } : {}) };
}

function localTime(locale: string, timezone: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "long", timeZone: timezone }).format(new Date());
}

function truncate(text: string, max: number): string {
  const characters = [...text.replace(/\s+/gu, " ").trim()];
  return characters.length > max ? `${characters.slice(0, max).join("")}…` : characters.join("");
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
    Type.Literal("view_contacts"), Type.Literal("open_chat"), Type.Literal("load_history"), Type.Literal("send_messages"),
    Type.Literal("wait_messages"), Type.Literal("close_phone"),
  ]),
  durationMinutes: Type.Optional(Type.Number()),
  durationSeconds: Type.Optional(Type.Number()),
  messageCount: Type.Optional(Type.Integer({ minimum: 1 })),
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
  const actionsFooter = (): string => formatAvailableActions(listAvailableActions(db.getRuntime()));

  const performTool: AgentTool<typeof actionSchema> = {
    name: "perform_action",
    label: "执行角色动作",
    description: "让角色执行一个经过状态校验的具体动作。每条结果（含错误）都会附上接下来可用的动作。只有 send_messages 会向外部聊天发送文字。",
    parameters: actionSchema,
    executionMode: "sequential",
    replay: "never",
    execute: async (_toolCallId, params, signal) => {
      try {
        const settings = db.getSettings().value;
        let runtime = db.getRuntime();
        const profile = db.getProfile();
        const allowed = new Set(listAvailableActions(runtime).map((item) => item.id));
        if (!allowed.has(params.action)) throw new Error(`当前状态不能执行 ${params.action}`);
        const withFooter = (text: string): string => `${text}\n\n${actionsFooter()}`;

        if (params.action === "idle") {
          if (params.durationMinutes === undefined) throw new Error("idle 需要 durationMinutes");
          validateDuration("idle", params.durationMinutes, settings);
          db.cancelPendingTimers();
          const dueAt = Date.now() + params.durationMinutes * 60_000;
          db.createTimer("idle", dueAt, { activity: params.activity ?? "自娱自乐" });
          runtime = db.setRuntime({ mode: "entertaining", phone: { kind: "closed" }, nextWakeAt: dueAt });
          db.addEvent("action_completed", `${profile.name}${params.activity ?? "自娱自乐"}，预计 ${params.durationMinutes} 分钟后结束。`, { action: "idle", dueAt });
          return result(withFooter(`${profile.name}收起手机开始${params.activity ?? "自娱自乐"}，将在设定时间结束后继续行动。`), { runtime }, true);
        }

        if (params.action === "sleep") {
          if (params.durationMinutes === undefined) throw new Error("sleep 需要 durationMinutes");
          validateDuration("sleep", params.durationMinutes, settings);
          db.cancelPendingTimers();
          const dueAt = Date.now() + params.durationMinutes * 60_000;
          db.createTimer("alarm", dueAt);
          runtime = db.setRuntime({ mode: "sleeping", phone: { kind: "closed" }, nextWakeAt: dueAt });
          db.addEvent("action_completed", `${profile.name}睡觉并设置了 ${params.durationMinutes} 分钟后的闹钟。`, { action: "sleep", dueAt });
          return result(withFooter(`${profile.name}收起手机睡着了，闹钟已经设置。`), { runtime }, true);
        }

        if (params.action === "set_contact_importance") {
          if (!params.contactId || !params.importance) throw new Error("需要 contactId 和 importance");
          if (runtime.phone.kind === "chat" && params.contactId !== runtime.phone.target.id) {
            throw new Error("在当前聊天窗口只能设置该好友的消息重要度");
          }
          let contact;
          try {
            contact = db.setContactImportance(params.contactId, params.importance as Importance);
          } catch {
            throw new Error(`未知联系人：${params.contactId}`);
          }
          db.addEvent("action_completed", `${profile.name}将${contact.name}的消息重要度设为 ${contact.importance}。`, { action: params.action, contactId: contact.id });
          return result(withFooter(`已将 ${contact.name} 的消息重要度设为 ${contact.importance}。`), { contact });
        }

        if (params.action === "open_phone") {
          runtime = db.setRuntime({ phone: { kind: "home" } });
          const unread = db.unreadSummary(false);
          const unreadTotal = unread.reduce((sum, item) => sum + item.count, 0);
          db.addEvent("action_completed", `${profile.name}打开了手机。`, { action: params.action });
          const text = [
            `${profile.name}打开了手机。`,
            "当前手机状态：主页",
            `当前时间：${localTime(profile.locale, profile.timezone)}`,
            unreadTotal > 0
              ? `${profile.name}有一些未读消息，可调用 view_contacts 查看详细内容。`
              : "没有未读消息。",
          ].join("\n");
          return result(withFooter(text), { runtime, unread });
        }

        if (params.action === "view_contacts") {
          runtime = db.setRuntime({ phone: { kind: "contacts" } });
          const unread = db.unreadSummary(false);
          const unreadByKey = new Map(unread.map((item) => [`${item.target.kind}:${item.target.id}`, item.count]));
          interface Entry { kind: "private" | "group"; id: string; name: string; unread: number; latest: StoredMessage | null }
          const entries: Entry[] = [];
          for (const contact of db.listContacts()) {
            const target: ConversationTarget = { platform: "onebot", kind: "private", id: contact.id, name: contact.name };
            entries.push({ kind: "private", id: contact.id, name: contact.name, unread: unreadByKey.get(`private:${contact.id}`) ?? 0, latest: db.listMessages(target, 1).at(-1) ?? null });
          }
          for (const group of db.listGroups()) {
            const target: ConversationTarget = { platform: "onebot", kind: "group", id: group.id, name: group.name };
            entries.push({ kind: "group", id: group.id, name: group.name, unread: unreadByKey.get(`group:${group.id}`) ?? 0, latest: db.listMessages(target, 1).at(-1) ?? null });
          }
          entries.sort((left, right) => (right.latest?.occurredAt ?? 0) - (left.latest?.occurredAt ?? 0));
          const limit = settings.simulation.contactListMaxEntries;
          let shown = entries;
          let folded = 0;
          if (entries.length > limit) {
            const withUnread = entries.filter((entry) => entry.unread > 0);
            const withoutUnread = entries.filter((entry) => entry.unread === 0);
            shown = [...withUnread, ...withoutUnread.slice(0, Math.max(0, limit - withUnread.length))];
            folded = entries.length - shown.length;
          }
          const lines = shown.map((entry) => {
            const label = entry.kind === "group" ? "群聊" : "好友";
            const unreadText = entry.unread > 0 ? `有${entry.unread}条未读消息` : "没有未读消息";
            const latestText = entry.latest
              ? `[${new Date(entry.latest.occurredAt).toISOString()}] ${entry.latest.senderName}: ${truncate(entry.latest.content, 50)}`
              : "无消息记录";
            return `（${label}）${entry.name}（${entry.id}）（${unreadText}）（最近一条：${latestText}）`;
          });
          if (folded > 0) lines.push(`（另有 ${folded} 个无未读消息的好友/群聊未显示）`);
          db.addEvent("action_completed", `${profile.name}查看了好友和群聊列表。`, { action: params.action });
          const text = [
            "当前手机状态：好友和群聊列表",
            `当前时间：${localTime(profile.locale, profile.timezone)}`,
            `以下为${profile.name}的好友/群聊列表：`,
            ...(lines.length ? lines : ["（列表为空）"]),
          ].join("\n");
          return result(withFooter(text), { runtime, shown: shown.length, folded });
        }

        if (params.action === "open_chat") {
          if (!params.kind || !params.targetId) throw new Error("需要 kind 和 targetId");
          const known = params.kind === "private"
            ? db.getContact(params.targetId)
            : db.listGroups().find((item) => item.id === params.targetId);
          if (!known) throw new Error(`未知联系人或群聊：${params.targetId}`);
          const target: ConversationTarget = { platform: "onebot", kind: params.kind, id: params.targetId, name: known.name };
          const isTarget = (item: { target: ConversationTarget }): boolean => item.target.kind === target.kind && item.target.id === target.id;
          const unreadCount = db.unreadSummary(true).find(isTarget)?.count ?? 0;
          const otherUnread = db.unreadSummary(false).filter((item) => !isTarget(item)).reduce((sum, item) => sum + item.count, 0);
          const messages = db.listMessages(target, settings.simulation.chatPreviewMessages);
          runtime = db.setRuntime({ phone: { kind: "chat", target, cursor: messages.length ? messages[0]!.occurredAt : null } });
          db.markTargetRead(target);
          db.addEvent("action_completed", `${profile.name}打开了${target.name ?? target.id}的聊天窗口。`, { action: params.action, target });
          const header = unreadCount > 0
            ? `截止到上次打开，有 ${unreadCount} 条新消息；以下为最新的 ${messages.length} 条（旧→新）：`
            : `没有新消息；以下为最近的 ${messages.length} 条（旧→新）：`;
          const text = [
            `${profile.name}打开了${target.name ?? target.id}的聊天窗口。`,
            `当前手机状态：聊天窗口（${target.name ?? target.id}）`,
            `当前时间：${localTime(profile.locale, profile.timezone)}`,
            header,
            formatObservedMessages(messages),
            "可以使用 load_history 查看更早的消息。",
            `${profile.name}的其他好友/群聊存在 ${otherUnread} 条未读消息。`,
          ].join("\n");
          return result(withFooter(text), { runtime, messages });
        }

        if (params.action === "load_history") {
          if (runtime.phone.kind !== "chat") throw new Error("需要先打开目标聊天窗口");
          const phone = runtime.phone;
          const count = Math.min(params.count ?? settings.simulation.chatPreviewMessages, settings.simulation.historyMaxMessages);
          const messages = db.listMessages(phone.target, count, phone.cursor ?? undefined);
          if (messages.length) runtime = db.setRuntime({ phone: { ...phone, cursor: messages[0]!.occurredAt } });
          const otherUnread = db.unreadSummary(false)
            .filter((item) => !(item.target.kind === phone.target.kind && item.target.id === phone.target.id))
            .reduce((sum, item) => sum + item.count, 0);
          const body = messages.length
            ? `以下是更早的 ${messages.length} 条本地已观测历史（旧→新）：\n${formatObservedMessages(messages)}`
            : "已经到最早的本地已观测消息。";
          const text = `${body}\n${profile.name}的其他好友/群聊存在 ${otherUnread} 条未读消息。`;
          return result(withFooter(text), { messages, localOnly: true });
        }

        if (params.action === "send_messages") {
          if (runtime.phone.kind !== "chat") throw new Error("需要先打开目标聊天窗口");
          const phone = runtime.phone;
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
              id, platformMessageId: null, target: phone.target, senderId: runtime.activeSelfId ?? profile.name,
              senderName: profile.name, direction: "outgoing", content, segments: [{ type: "text", data: { text: content } }],
              occurredAt: Date.now(), observedAt: Date.now(), deliveryStatus: "pending", readAt: Date.now(),
            });
            db.updateMessageDelivery(id, "unknown");
            try {
              const response = await platform.sendText(phone.target, content, signal);
              db.updateMessageDelivery(id, "sent", response.platformMessageId ?? undefined);
              sent.push({ id, status: "sent", platformMessageId: response.platformMessageId });
            } catch (error) {
              sent.push({ id, status: "unknown", platformMessageId: null });
              throw new Error(`发送结果未知：${error instanceof Error ? error.message : String(error)}`);
            }
            if (index < messages.length - 1) await pause(settings.simulation.messageIntervalMs, signal);
          }
          db.addEvent("action_completed", `${profile.name}向${phone.target.name ?? phone.target.id}发送了 ${sent.length} 条消息。`, { action: params.action, target: phone.target, sent });
          return result(withFooter(`已按顺序发送 ${sent.length} 条消息。`), { sent });
        }

        if (params.action === "wait_messages") {
          if (runtime.phone.kind !== "chat") throw new Error("需要先打开目标聊天窗口");
          const phone = runtime.phone;
          const plan = validateWait(params, settings);
          db.cancelPendingTimers();
          const since = Date.now();
          const dueAt = plan.mode === "seconds" ? since + plan.seconds * 1_000 : since + settings.simulation.waitMessageTimeoutSeconds * 1_000;
          db.createTimer("wait", dueAt, {
            watch: phone.target, mode: plan.mode, since,
            ...(plan.mode === "seconds" ? { seconds: plan.seconds } : { count: plan.count }),
          });
          runtime = db.setRuntime({ mode: "waiting", nextWakeAt: dueAt });
          const targetName = phone.target.name ?? phone.target.id;
          db.addEvent("action_completed", `${profile.name}开始在${targetName}的聊天窗口等待新消息。`, { action: params.action, target: phone.target, plan });
          const text = plan.mode === "seconds"
            ? `${profile.name}盯着${targetName}的聊天窗口，等待 ${plan.seconds} 秒。`
            : `${profile.name}盯着${targetName}的聊天窗口，等待 ${plan.count} 条新消息（最多 ${settings.simulation.waitMessageTimeoutSeconds} 秒）。`;
          return result(withFooter(text), { runtime }, true);
        }

        runtime = db.setRuntime({ phone: { kind: "closed" } });
        db.addEvent("action_completed", `${profile.name}关闭了手机。`, { action: "close_phone" });
        return result(withFooter(`${profile.name}关闭了手机。`), { runtime });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}\n\n${actionsFooter()}`);
      }
    },
  };
  return [performTool];
}

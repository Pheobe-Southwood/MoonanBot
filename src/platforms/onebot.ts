import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { AppSettings, ConversationTarget } from "../domain/types.js";
import type { MoonanDatabase } from "../storage/database.js";
import type { ChatPlatformAdapter, PlatformMessageEvent, PlatformStatus, SendResult } from "./types.js";

type Role = "event" | "api" | "universal";

interface Connection {
  socket: WebSocket;
  selfId: string;
  role: Role;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface OneBotAttach {
  selfId: string;
  role: Role;
  authorization?: string;
}

function plainText(segments: unknown): { text: string; normalized: unknown[] } {
  const list = Array.isArray(segments) ? segments : typeof segments === "string" ? [{ type: "text", data: { text: segments } }] : [];
  const parts = list.map((segment: any) => {
    const type = typeof segment?.type === "string" ? segment.type : "unknown";
    const data = segment?.data && typeof segment.data === "object" ? segment.data : {};
    switch (type) {
      case "text": return String(data.text ?? "");
      case "at": return data.qq === "all" ? "[@全体成员]" : `[@${String(data.qq ?? "未知")}]`;
      case "reply": return `[回复消息 ${String(data.id ?? "未知")}]`;
      case "image": return `[图片${data.file ? `：${String(data.file)}` : ""}]`;
      case "record": return "[语音]";
      case "video": return "[视频]";
      case "file": return `[文件${data.name ? `：${String(data.name)}` : ""}]`;
      case "face": return `[表情 ${String(data.id ?? "")}]`;
      default: return `[${type}消息]`;
    }
  });
  return { text: parts.join("").trim() || "[空消息]", normalized: list };
}

function tokenAccepted(header: string | undefined, expected: string): boolean {
  if (!expected) return true;
  if (!header) return false;
  return header === `Bearer ${expected}` || header === `Token ${expected}`;
}

export class OneBotV11Adapter implements ChatPlatformAdapter {
  readonly id = "onebot";
  private readonly connections = new Set<Connection>();
  private readonly pending = new Map<string, PendingRequest>();
  private sequence = 0;

  constructor(
    private readonly db: MoonanDatabase,
    private readonly settings: () => AppSettings,
    private readonly onMessage: (event: PlatformMessageEvent) => Promise<void>,
  ) {}

  attach(socket: WebSocket, input: OneBotAttach): { ok: true } | { ok: false; code: number; reason: string } {
    if (!input.selfId) return { ok: false, code: 4400, reason: "Missing X-Self-ID" };
    if (!["event", "api", "universal"].includes(input.role)) return { ok: false, code: 4400, reason: "Invalid X-Client-Role" };
    if (!tokenAccepted(input.authorization, this.settings().onebot.accessToken)) return { ok: false, code: 4403, reason: "Invalid access token" };
    const existingSelfId = this.status().selfId;
    if (existingSelfId && existingSelfId !== input.selfId) return { ok: false, code: 4409, reason: "Only one self_id is supported" };
    const connection: Connection = { socket, selfId: input.selfId, role: input.role };
    this.connections.add(connection);
    this.db.setRuntime({ activeSelfId: input.selfId });
    socket.on("message", (data) => { void this.receive(connection, data.toString()); });
    socket.on("close", () => this.detach(connection));
    socket.on("error", () => this.detach(connection));
    queueMicrotask(() => { void this.syncRoster().catch(() => undefined); });
    return { ok: true };
  }

  status(): PlatformStatus {
    const connections = [...this.connections].filter((item) => item.socket.readyState === item.socket.OPEN);
    return { connected: connections.length > 0, selfId: connections[0]?.selfId ?? null, roles: connections.map((item) => item.role) };
  }

  private detach(connection: Connection): void {
    this.connections.delete(connection);
    if (this.connections.size === 0) this.db.setRuntime({ activeSelfId: null });
    if (![...this.connections].some((item) => item.role === "api" || item.role === "universal")) {
      for (const [echo, request] of this.pending) {
        clearTimeout(request.timer);
        request.reject(new Error("OneBot API connection disconnected"));
        this.pending.delete(echo);
      }
    }
  }

  private async receive(_connection: Connection, raw: string): Promise<void> {
    let event: any;
    try { event = JSON.parse(raw); } catch { return; }
    const echo = typeof event?.echo === "string" ? event.echo : event?.echo?.id;
    if (echo && this.pending.has(echo)) {
      const request = this.pending.get(echo)!;
      clearTimeout(request.timer);
      this.pending.delete(echo);
      if (event.status === "failed" || (typeof event.retcode === "number" && event.retcode !== 0)) {
        request.reject(new Error(String(event.message ?? event.wording ?? `OneBot retcode ${event.retcode}`)));
      } else request.resolve(event.data);
      return;
    }
    if (event?.post_type !== "message" || !["private", "group"].includes(event.message_type)) return;
    const kind = event.message_type as "private" | "group";
    const senderId = String(event.sender?.user_id ?? event.user_id ?? "");
    if (!senderId) return;
    const targetId = kind === "group" ? String(event.group_id ?? "") : senderId;
    if (!targetId || !this.allowed(kind, targetId)) return;
    const parsed = plainText(event.message);
    const targetName = kind === "group" ? String(event.group_name ?? targetId) : String(event.sender?.nickname ?? senderId);
    await this.onMessage({
      selfId: String(event.self_id ?? _connection.selfId),
      platformMessageId: String(event.message_id ?? randomUUID()),
      target: { platform: "onebot", kind, id: targetId, name: targetName },
      senderId,
      senderName: String(event.sender?.card || event.sender?.nickname || senderId),
      occurredAt: Number(event.time ? event.time * 1000 : Date.now()),
      content: parsed.text,
      segments: parsed.normalized,
      raw: event,
    });
  }

  private allowed(kind: "private" | "group", id: string): boolean {
    const list = kind === "private" ? this.settings().onebot.privateAllowlist : this.settings().onebot.groupAllowlist;
    return list.length === 0 || list.includes(id);
  }

  async call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const connection = [...this.connections].find((item) =>
      (item.role === "api" || item.role === "universal") && item.socket.readyState === item.socket.OPEN,
    );
    if (!connection) throw new Error("OneBot API connection is not available");
    const echo = `moonanbot-${++this.sequence}-${randomUUID()}`;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot API timeout: ${action}`));
      }, this.settings().onebot.apiTimeoutMs);
      const abort = () => {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(new Error("OneBot request aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(echo, {
        resolve: (value) => { signal?.removeEventListener("abort", abort); resolve(value); },
        reject: (error) => { signal?.removeEventListener("abort", abort); reject(error); },
        timer,
      });
      connection.socket.send(JSON.stringify({ action, params, echo }));
    });
  }

  async sendText(target: ConversationTarget, text: string, signal?: AbortSignal): Promise<SendResult> {
    if (!this.allowed(target.kind, target.id)) throw new Error("Target is not in the OneBot allowlist");
    const action = target.kind === "group" ? "send_group_msg" : "send_private_msg";
    const key = target.kind === "group" ? "group_id" : "user_id";
    const data = await this.call(action, { [key]: Number.isSafeInteger(Number(target.id)) ? Number(target.id) : target.id, message: [{ type: "text", data: { text } }] }, signal);
    return { platformMessageId: data?.message_id === undefined ? null : String(data.message_id) };
  }

  async syncRoster(): Promise<void> {
    const [friends, groups] = await Promise.allSettled([this.call("get_friend_list", {}), this.call("get_group_list", {})]);
    if (friends.status === "fulfilled" && Array.isArray(friends.value)) {
      for (const friend of friends.value) {
        const id = String(friend.user_id ?? "");
        if (!id) continue;
        const existing = this.db.getContact(id);
        this.db.upsertContact({
          platform: "onebot", id, name: String(friend.remark || friend.nickname || id), aliases: existing?.aliases ?? [],
          summary: existing?.summary ?? "", importance: existing?.importance ?? "normal", isFriend: true,
        }, "roster", false);
      }
    }
    if (groups.status === "fulfilled" && Array.isArray(groups.value)) {
      for (const group of groups.value) {
        const id = String(group.group_id ?? "");
        if (!id) continue;
        const existing = this.db.listGroups().find((item) => item.id === id);
        this.db.upsertGroup({ platform: "onebot", id, name: String(group.group_name || id), summary: existing?.summary ?? "" }, "roster");
      }
    }
  }

  async close(): Promise<void> {
    for (const connection of this.connections) connection.socket.close(1001, "MoonanBot shutting down");
    this.connections.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("MoonanBot shutting down"));
    }
    this.pending.clear();
  }
}

export { plainText, tokenAccepted };

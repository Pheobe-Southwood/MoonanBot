import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { AppSettings, ConversationTarget, OneBotRole } from "../domain/types.js";
import type { MoonanDatabase } from "../storage/database.js";
import type { ChatPlatformAdapter, PlatformMessageEvent, PlatformStatus, SendResult } from "./types.js";

type Role = OneBotRole;

const ROLES: readonly Role[] = ["event", "api", "universal"];
const OUTBOUND_OPEN_TIMEOUT_MS = 30_000;
const OUTBOUND_BACKOFF_MAX_MS = 30_000;

interface Connection {
  socket: WebSocket;
  selfId: string;
  role: Role;
  source: "reverse" | "outbound";
}

interface OutboundEntry {
  configIndex: number;
  name: string;
  url: string;
  accessToken: string;
  selfId: string;
  role: Role;
  reconnectIntervalMs: number;
  enabled: boolean;
  generation: number;
  socket: WebSocket | null;
  connected: boolean;
  attempts: number;
  reconnectTimer: NodeJS.Timeout | null;
  lastError: string | null;
}

export interface OneBotOutboundStatus {
  name: string;
  url: string;
  enabled: boolean;
  connected: boolean;
  selfId: string | null;
  attempts: number;
  lastError: string | null;
}

/** Stable identity for an outbound entry, so renames reconnect and edits reload. */
function outboundFingerprint(entry: { url: string; accessToken: string; selfId: string; role: string; reconnectIntervalMs: number; enabled: boolean }): string {
  return [entry.url, entry.accessToken, entry.selfId, entry.role, String(entry.reconnectIntervalMs), String(entry.enabled)].join("\u0000");
}

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
  role: string;
  authorization?: string;
}

function normalizeRole(raw: string | undefined): Role | null {
  const value = String(raw ?? "").trim().toLowerCase();
  return (ROLES as readonly string[]).includes(value) ? value as Role : null;
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
  private readonly outbound = new Map<string, OutboundEntry>();
  private stopped = false;
  private sequence = 0;

  constructor(
    private readonly db: MoonanDatabase,
    private readonly settings: () => AppSettings,
    private readonly onMessage: (event: PlatformMessageEvent) => Promise<void>,
  ) {}

  attach(socket: WebSocket, input: OneBotAttach): { ok: true } | { ok: false; code: number; reason: string } {
    if (!input.selfId) return { ok: false, code: 4400, reason: "Missing X-Self-ID" };
    if (!this.settings().onebot.acceptReverse) return { ok: false, code: 4403, reason: "Reverse connections are disabled" };
    const role = normalizeRole(input.role);
    if (!role) return { ok: false, code: 4400, reason: "Invalid X-Client-Role" };
    if (!tokenAccepted(input.authorization, this.settings().onebot.accessToken)) return { ok: false, code: 4403, reason: "Invalid access token" };
    const existingSelfId = this.status().selfId;
    if (existingSelfId && existingSelfId !== input.selfId) return { ok: false, code: 4409, reason: "Only one self_id is supported" };
    this.register(socket, { selfId: input.selfId, role, source: "reverse" });
    this.db.setRuntime({ activeSelfId: input.selfId });
    queueMicrotask(() => { void this.syncRoster().catch(() => undefined); });
    return { ok: true };  }

  /** Adds the socket to the shared connection set and wires message/close handling. */
  private register(socket: WebSocket, input: { selfId: string; role: Role; source: Connection["source"] }): Connection {
    const connection: Connection = { socket, selfId: input.selfId, role: input.role, source: input.source };
    this.connections.add(connection);
    socket.on("message", (data) => { void this.receive(connection, data.toString()); });
    socket.on("close", () => this.detach(connection));
    socket.on("error", () => this.detach(connection));
    return connection;
  }

  /** Aligns live outbound sockets with settings.onebot.outbound: opens new entries, closes removed or changed ones. */
  reconcileOutbound(): void {
    const desired = this.settings().onebot.outbound ?? [];
    const wantedNames = new Set(desired.map((entry) => entry.name));
    for (const [name, entry] of [...this.outbound]) {
      if (!wantedNames.has(name)) this.dropOutbound(entry);
    }
    desired.forEach((config, configIndex) => {
      const existing = this.outbound.get(config.name);
      if (!existing) {
        this.outbound.set(config.name, {
          configIndex, name: config.name, url: config.url, accessToken: config.accessToken, selfId: config.selfId,
          role: config.role, reconnectIntervalMs: config.reconnectIntervalMs, enabled: config.enabled,
          generation: 0, socket: null, connected: false, attempts: 0, reconnectTimer: null, lastError: null,
        });
        this.openOutbound(this.outbound.get(config.name)!);
        return;
      }
      const previous = outboundFingerprint(existing);
      const next = outboundFingerprint(config);
      existing.configIndex = configIndex;
      if (previous === next) return;
      existing.url = config.url;
      existing.accessToken = config.accessToken;
      existing.selfId = config.selfId;
      existing.role = config.role;
      existing.reconnectIntervalMs = config.reconnectIntervalMs;
      existing.enabled = config.enabled;
      existing.lastError = null;
      existing.attempts = 0;
      this.closeOutboundSocket(existing);
      this.openOutbound(existing);
    });
  }

  private openOutbound(entry: OutboundEntry): void {
    if (this.stopped || !entry.enabled) return;
    const generation = ++entry.generation;
    const headers: Record<string, string> = { "X-Client-Role": entry.role };
    if (entry.selfId) headers["X-Self-ID"] = entry.selfId;
    if (entry.accessToken) headers.Authorization = `Bearer ${entry.accessToken}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(entry.url, { headers });
    } catch (error) {
      this.scheduleOutboundReconnect(entry, error instanceof Error ? error.message : String(error));
      return;
    }
    entry.socket = socket;
    let registered = false;
    let connection: Connection | null = null;
    const openTimer = setTimeout(() => {
      if (generation === entry.generation) socket.terminate();
    }, OUTBOUND_OPEN_TIMEOUT_MS);
    socket.on("open", () => {
      clearTimeout(openTimer);
      if (generation !== entry.generation || this.stopped) { socket.close(1000, "superseded"); return; }
      registered = true;
      entry.connected = true;
      entry.attempts = 0;
      entry.lastError = null;
      connection = this.register(socket, { selfId: entry.selfId, role: entry.role, source: "outbound" });
      if (entry.selfId) this.db.setRuntime({ activeSelfId: entry.selfId });
      queueMicrotask(() => { void this.syncRoster().catch(() => undefined); });
    });
    socket.on("error", (error: Error) => {
      if (generation !== entry.generation) return;
      entry.lastError = error instanceof Error ? error.message : String(error);
    });
    socket.on("close", () => {
      clearTimeout(openTimer);
      if (registered) this.detach(connection!);
      if (generation !== entry.generation || this.stopped) return;
      entry.connected = false;
      entry.socket = null;
      this.scheduleOutboundReconnect(entry, entry.lastError ?? `connection closed: ${entry.url}`);
    });
  }

  private scheduleOutboundReconnect(entry: OutboundEntry, reason: string): void {
    if (this.stopped || !entry.enabled || entry.reconnectTimer) return;
    entry.lastError = reason;
    entry.attempts += 1;
    const base = Math.min(entry.reconnectIntervalMs * 2 ** (entry.attempts - 1), OUTBOUND_BACKOFF_MAX_MS);
    const delay = Math.round(base * (1 + Math.random() * 0.2));
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      this.openOutbound(entry);
    }, delay);
    entry.reconnectTimer.unref?.();
  }

  private closeOutboundSocket(entry: OutboundEntry): void {
    entry.generation += 1;
    if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
    entry.connected = false;
    const socket = entry.socket;
    entry.socket = null;
    if (socket && socket.readyState !== socket.CLOSED) socket.close(1000, "configuration changed");
  }

  private dropOutbound(entry: OutboundEntry): void {
    this.closeOutboundSocket(entry);
    this.outbound.delete(entry.name);
  }

  outboundStatus(): OneBotOutboundStatus[] {
    return [...this.outbound.values()].map((entry) => ({
      name: entry.name, url: entry.url, enabled: entry.enabled, connected: entry.connected,
      selfId: entry.selfId || null, attempts: entry.attempts, lastError: entry.lastError,
    }));
  }

  status(): PlatformStatus {
    const connections = [...this.connections].filter((item) => item.socket.readyState === item.socket.OPEN);
    return { connected: connections.length > 0, selfId: connections[0]?.selfId || null, roles: connections.map((item) => item.role) };
  }

  private apiConnection(): Connection | undefined {
    return [...this.connections].find((item) =>
      (item.role === "api" || item.role === "universal") && item.socket.readyState === item.socket.OPEN,
    );
  }

  private detach(connection: Connection): void {
    this.connections.delete(connection);
    try {
      if (this.connections.size === 0) this.db.setRuntime({ activeSelfId: null });
    } catch { /* the database may already be closed during shutdown */ }
    if (!this.apiConnection()) {
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
    const eventSelfId = String(event.self_id ?? "");
    const kind = event.message_type as "private" | "group";
    const senderId = String(event.sender?.user_id ?? event.user_id ?? "");
    if (!senderId) return;
    const targetId = kind === "group" ? String(event.group_id ?? "") : senderId;
    if (!targetId || !this.allowed(kind, targetId)) return;
    const parsed = plainText(event.message);
    const targetName = kind === "group" ? String(event.group_name ?? targetId) : String(event.sender?.nickname ?? senderId);
    if (!_connection.selfId && eventSelfId) this.learnSelfId(_connection, eventSelfId);
    await this.onMessage({
      selfId: eventSelfId || _connection.selfId,
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

  /** Outbound clients may omit X-Self-ID, so the account is learned from the first event. */
  private learnSelfId(connection: Connection, selfId: string): void {
    const existing = this.status().selfId;
    if (existing && existing !== selfId) return;
    connection.selfId = selfId;
    for (const entry of this.outbound.values()) if (entry.socket === connection.socket) entry.selfId = selfId;
    this.db.setRuntime({ activeSelfId: selfId });
  }

  private allowed(kind: "private" | "group", id: string): boolean {
    const list = kind === "private" ? this.settings().onebot.privateAllowlist : this.settings().onebot.groupAllowlist;
    return list.length === 0 || list.includes(id);
  }

  async call(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    const connection = this.apiConnection();
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
    this.stopped = true;
    for (const entry of this.outbound.values()) this.closeOutboundSocket(entry);
    this.outbound.clear();
    for (const connection of this.connections) connection.socket.close(1001, "MoonanBot shutting down");
    this.connections.clear();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("MoonanBot shutting down"));
    }
    this.pending.clear();
  }
}

export { normalizeRole, plainText, tokenAccepted };

import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import { OneBotV11Adapter, normalizeRole, plainText, tokenAccepted } from "../src/platforms/onebot.js";
import { assertOutbound, normalizeSettings } from "../src/domain/settings.js";
import type { AppSettings } from "../src/domain/types.js";
import { testDatabase } from "./helpers.js";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lets closed sockets finish their close handshake before the test database is torn down. */
async function settleSockets(sockets: any[]): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (sockets.every((socket) => socket.readyState === 3)) return;
    await wait(10);
  }
}

/** Waits for the adapter to observe its own outbound socket as open. */
async function waitUntilConnected(adapter: OneBotV11Adapter): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (adapter.outboundStatus()[0]?.connected) return true;
    await wait(10);
  }
  return false;
}

/** Minimal OneBot WebSocket server that records handshakes and answers API calls. */
async function oneBotServer(): Promise<{
  url: string;
  handshakes: Array<Record<string, any>>;
  sockets: any[];
  waitForConnection(count?: number): Promise<any>;
  close(): Promise<void>;
}> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  const handshakes: Array<Record<string, any>> = [];
  const sockets: any[] = [];
  wss.on("connection", (socket: any, request: any) => {
    handshakes.push(request.headers);
    sockets.push(socket);
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(raw.toString());
      socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: frame.echo, data: { message_id: 77, nickname: "SnowLuma" } }));
    });
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const address = wss.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${address.port}/`,
    handshakes,
    sockets,
    async waitForConnection(count = 1) {
      for (let i = 0; i < 200; i += 1) {
        if (sockets.length >= count && sockets[sockets.length - 1].readyState === 1) return sockets[sockets.length - 1];
        await wait(10);
      }
      throw new Error(`expected ${count} outbound connection(s), saw ${sockets.length}`);
    },
    close: () => new Promise<void>((resolve) => { for (const socket of sockets) socket.terminate(); wss.close(() => resolve()); }),
  };
}

function outboundSettings(overrides: Partial<AppSettings["onebot"]> = {}): AppSettings["onebot"] {
  return {
    accessToken: "reverse-token",
    apiTimeoutMs: 2_000,
    privateAllowlist: [],
    groupAllowlist: [],
    acceptReverse: true,
    outbound: [],
    ...overrides,
  };
}

function outboundClient(url: string, overrides: Record<string, any> = {}) {
  return {
    name: "snowluma", url, accessToken: "outbound-token", selfId: "", role: "universal" as const,
    reconnectIntervalMs: 1_000, enabled: true, ...overrides,
  };
}

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: any[] = [];
  closeCode: number | null = null;

  send(raw: string): void {
    const request = JSON.parse(raw);
    this.sent.push(request);
    queueMicrotask(() => this.emit("message", JSON.stringify({
      status: "ok", retcode: 0, echo: request.echo,
      data: request.action === "send_private_msg" || request.action === "send_group_msg" ? { message_id: 88 } : [],
    })));
  }

  close(code?: number): void {
    this.closeCode = code ?? 1000;
    this.readyState = 3;
    this.emit("close");
  }
}

describe("OneBot v11 adapter", () => {
  it("normalizes text, mentions, replies, and unsupported media placeholders", () => {
    expect(plainText([
      { type: "text", data: { text: "hi" } }, { type: "at", data: { qq: "7" } },
      { type: "reply", data: { id: "9" } }, { type: "image", data: { file: "a.jpg" } },
      { type: "record", data: {} }, { type: "video", data: {} }, { type: "file", data: { name: "x.zip" } },
    ]).text).toBe("hi[@7][回复消息 9][图片：a.jpg][语音][视频][文件：x.zip]");
    expect(tokenAccepted("Bearer abc", "abc")).toBe(true);
    expect(tokenAccepted("Token abc", "abc")).toBe(true);
    expect(tokenAccepted(undefined, "abc")).toBe(false);
  });

  it("normalizes the role header case-insensitively", () => {
    for (const role of ["universal", "Universal", "UNIVERSAL", " api ", "Event", "API"]) {
      expect(normalizeRole(role)).toBe(role.trim().toLowerCase());
    }
    for (const role of ["", "   ", "guest", "universal-api", undefined]) {
      expect(normalizeRole(role)).toBeNull();
    }
  });

  it("authenticates roles, rejects a second account, matches echo, and sends text", async () => {
    const fixture = testDatabase();
    const received: any[] = [];
    try {
      const adapter = new OneBotV11Adapter(fixture.db, () => fixture.db.getSettings().value, async (event) => { received.push(event); });
      const token = fixture.db.getSettings().value.onebot.accessToken;
      expect(adapter.attach(new FakeSocket() as any, { selfId: "1", role: "event", authorization: "bad" })).toMatchObject({ ok: false, code: 4403 });
      const socket = new FakeSocket();
      expect(adapter.attach(socket as any, { selfId: "1", role: "universal", authorization: `Bearer ${token}` })).toEqual({ ok: true });
      expect(adapter.status().roles).toEqual(["universal"]);
      expect(adapter.attach(new FakeSocket() as any, { selfId: "2", role: "event", authorization: `Token ${token}` })).toMatchObject({ ok: false, code: 4409 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const result = await adapter.sendText({ platform: "onebot", kind: "private", id: "7" }, "hello");
      expect(result.platformMessageId).toBe("88");
      expect(socket.sent.some((item) => item.action === "send_private_msg" && item.params.message[0].data.text === "hello")).toBe(true);
      socket.emit("message", JSON.stringify({
        post_type: "message", message_type: "private", self_id: 1, message_id: 5, user_id: 7, time: 100,
        sender: { user_id: 7, nickname: "Seven" }, message: [{ type: "text", data: { text: "ping" } }],
      }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(received[0]).toMatchObject({ platformMessageId: "5", senderName: "Seven", content: "ping", target: { kind: "private", id: "7" } });
      await adapter.close();
    } finally { fixture.cleanup(); }
  });

  it("accepts a capitalized Universal role from OneBot implementations such as SnowLuma", async () => {
    const fixture = testDatabase();
    try {
      const adapter = new OneBotV11Adapter(fixture.db, () => fixture.db.getSettings().value, async () => undefined);
      const socket = new FakeSocket();
      const token = fixture.db.getSettings().value.onebot.accessToken;
      expect(adapter.attach(socket as any, { selfId: "1", role: "Universal", authorization: `Bearer ${token}` })).toEqual({ ok: true });
      expect(adapter.status().roles).toEqual(["universal"]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await expect(adapter.sendText({ platform: "onebot", kind: "private", id: "7" }, "hello")).resolves.toMatchObject({ platformMessageId: "88" });
      await adapter.close();
    } finally { fixture.cleanup(); }
  });

  it("honors separate private and group allowlists", async () => {
    const fixture = testDatabase();
    const received: any[] = [];
    try {
      const settings = fixture.db.getSettings();
      settings.value.onebot.privateAllowlist = ["7"];
      settings.value.onebot.groupAllowlist = ["9"];
      fixture.db.updateSettings(settings.value, settings.version);
      const socket = new FakeSocket();
      const adapter = new OneBotV11Adapter(fixture.db, () => fixture.db.getSettings().value, async (event) => { received.push(event); });
      adapter.attach(socket as any, { selfId: "1", role: "event", authorization: `Bearer ${settings.value.onebot.accessToken}` });
      for (const event of [
        { post_type: "message", message_type: "private", message_id: 1, user_id: 8, sender: { user_id: 8 }, message: "blocked" },
        { post_type: "message", message_type: "group", message_id: 2, group_id: 9, user_id: 8, sender: { user_id: 8 }, message: "allowed" },
      ]) socket.emit("message", JSON.stringify(event));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(received).toHaveLength(1);
      expect(received[0].target).toMatchObject({ kind: "group", id: "9" });
      await adapter.close();
    } finally { fixture.cleanup(); }
  });
});

describe("OneBot outbound clients", () => {
  it("dials the configured server with OneBot headers, receives events, and learns self_id", async () => {
    const server = await oneBotServer();
    const fixture = testDatabase();
    try {
      const received: any[] = [];
      const onebot = outboundSettings({ acceptReverse: false, outbound: [outboundClient(server.url, { accessToken: "outbound-token" })] });
      const adapter = new OneBotV11Adapter(fixture.db, () => ({ ...fixture.db.getSettings().value, onebot }), async (event) => { received.push(event); });
      adapter.reconcileOutbound();
      const socket = await server.waitForConnection();
      expect(server.handshakes[0]).toMatchObject({
        "x-client-role": "universal",
        authorization: "Bearer outbound-token",
      });
      expect(await waitUntilConnected(adapter)).toBe(true);
      expect(adapter.status()).toMatchObject({ connected: true, roles: ["universal"] });

      socket.send(JSON.stringify({
        post_type: "message", message_type: "group", self_id: 3665494712, message_id: 12, group_id: 999,
        group_name: "Moonan Fan Club", user_id: 7, time: 100, sender: { user_id: 7, nickname: "Seven" },
        message: [{ type: "text", data: { text: "hello moonan" } }],
      }));
      await wait(60);
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ selfId: "3665494712", content: "hello moonan", target: { kind: "group", id: "999" } });
      expect(await waitUntilConnected(adapter)).toBe(true);
      expect(adapter.outboundStatus()[0]).toMatchObject({ name: "snowluma", connected: true, selfId: "3665494712" });
      expect(fixture.db.getRuntime().activeSelfId).toBe("3665494712");

      const sent = await adapter.sendText({ platform: "onebot", kind: "private", id: "7" }, "hi");
      expect(sent.platformMessageId).toBe("77");
      await adapter.close();
      await settleSockets(server.sockets);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  it("reconnects after the server drops the socket", async () => {
    const server = await oneBotServer();
    const fixture = testDatabase();
    try {
      const onebot = outboundSettings({ outbound: [outboundClient(server.url, { reconnectIntervalMs: 1_000 })] });
      const adapter = new OneBotV11Adapter(fixture.db, () => ({ ...fixture.db.getSettings().value, onebot }), async () => undefined);
      adapter.reconcileOutbound();
      const first = await server.waitForConnection();
      first.terminate();
      const second = await server.waitForConnection(2);
      expect(second.readyState).toBe(1);
      expect(await waitUntilConnected(adapter)).toBe(true);
      await adapter.close();
      await settleSockets(server.sockets);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });

  it("rejects reverse connections when acceptReverse is false", async () => {
    const fixture = testDatabase();
    try {
      const onebot = outboundSettings({ acceptReverse: false });
      const adapter = new OneBotV11Adapter(fixture.db, () => ({ ...fixture.db.getSettings().value, onebot }), async () => undefined);
      const token = fixture.db.getSettings().value.onebot.accessToken;
      expect(adapter.attach(new FakeSocket() as any, { selfId: "1", role: "universal", authorization: `Bearer ${token}` }))
        .toMatchObject({ ok: false, code: 4403 });
      await adapter.close();
    } finally { fixture.cleanup(); }
  });

  it("closes and reopens a connection when its configuration changes", async () => {
    const server = await oneBotServer();
    const fixture = testDatabase();
    try {
      let onebot = outboundSettings({ outbound: [outboundClient(server.url, { accessToken: "first-token" })] });
      const adapter = new OneBotV11Adapter(fixture.db, () => ({ ...fixture.db.getSettings().value, onebot }), async () => undefined);
      adapter.reconcileOutbound();
      await server.waitForConnection();
      onebot = outboundSettings({ outbound: [outboundClient(server.url, { accessToken: "second-token" })] });
      adapter.reconcileOutbound();
      await server.waitForConnection(2);
      expect(server.handshakes[1]!.authorization).toBe("Bearer second-token");
      await adapter.close();
      await settleSockets(server.sockets);
    } finally {
      await server.close();
      fixture.cleanup();
    }
  });
});

describe("OneBot settings normalization", () => {
  it("backfills outbound defaults for rows written by older releases", () => {
    const legacy = {
      web: { host: "127.0.0.1", port: 21314, locale: "auto" as const },
      onebot: { accessToken: "legacy", apiTimeoutMs: 30_000, privateAllowlist: [], groupAllowlist: [] },
    };
    const normalized = normalizeSettings(legacy as any);
    expect(normalized.onebot).toMatchObject({ accessToken: "legacy", acceptReverse: true, outbound: [] });
  });

  it("drops unusable outbound entries but keeps valid ones", () => {
    const normalized = normalizeSettings({
      onebot: {
        accessToken: "t", apiTimeoutMs: 30_000, privateAllowlist: [], groupAllowlist: [], acceptReverse: false,
        outbound: [
          { name: "ok", url: "ws://127.0.0.1:3001/", role: "Universal", reconnectIntervalMs: 5_000 },
          { name: "", url: "ws://127.0.0.1:3001/" },
          { name: "http", url: "http://127.0.0.1:3000/" },
          { name: "ok", url: "ws://127.0.0.1:3002/" },
          { name: "bad-role", url: "ws://127.0.0.1:3003/", role: "guest" },
        ],
      },
    } as any);
    expect(normalized.onebot.outbound.map((entry) => entry.name)).toEqual(["ok", "bad-role"]);
    expect(normalized.onebot.outbound[0]).toMatchObject({ role: "universal", enabled: true, selfId: "" });
    expect(normalized.onebot.outbound[1]!.role).toBe("universal");
  });

  it("rejects invalid outbound payloads instead of coercing them", () => {
    const base = outboundClient("ws://127.0.0.1:3001/");
    expect(() => assertOutbound([base])).not.toThrow();
    expect(() => assertOutbound([{ ...base, url: "http://127.0.0.1:3001/" }])).toThrow(/invalid_onebot_outbound_url_1/);
    expect(() => assertOutbound([base, { ...base }])).toThrow(/duplicate_onebot_outbound_name_2/);
    expect(() => assertOutbound([{ ...base, reconnectIntervalMs: 10 }])).toThrow(/invalid_onebot_outbound_reconnect_1/);
    expect(() => assertOutbound([{ ...base, name: "" }])).toThrow(/invalid_onebot_outbound_name_1/);
    expect(() => assertOutbound([{ ...base, role: "guest" as any }])).toThrow(/invalid_onebot_outbound_role_1/);
  });
});

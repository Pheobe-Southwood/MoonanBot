import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { OneBotV11Adapter, normalizeRole, plainText, tokenAccepted } from "../src/platforms/onebot.js";
import { testDatabase } from "./helpers.js";

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

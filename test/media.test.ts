import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaPipeline, decodeBase64, sniffImageMime } from "../src/media/pipeline.js";
import { renderMessagePreview, renderObservedMessages, renderSynthesisEvents, stripImageBlocks } from "../src/media/render.js";
import type { ChatPlatformAdapter, PlatformFilePayload } from "../src/platforms/types.js";
import type { StoredMessage, WorldEvent } from "../src/domain/types.js";
import type { MoonanDatabase } from "../src/storage/database.js";
import { testDatabase } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const bmp = new Uint8Array([0x42, 0x4d, 0x01, 0x02]);
const notImage = new TextEncoder().encode("<html>expired</html>");

function fakePlatform(fetchFile?: ChatPlatformAdapter["fetchFile"]): ChatPlatformAdapter {
  return {
    id: "fake", status: () => ({ connected: true, selfId: "bot", roles: ["universal"] }),
    sendText: async () => ({ platformMessageId: "1" }), syncRoster: async () => ({ groupsAdded: 0, groupsRemoved: 0, contactsUpdated: 0 }),
    ...(fetchFile ? { fetchFile } : {}),
    close: async () => undefined,
  };
}

function stubFetch(payload: Uint8Array, ok = true): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok,
    arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  })));
}

function imageMessage(db: MoonanDatabase, id: string, segments: unknown[], content = "[图片：a.png]"): StoredMessage {
  const message: StoredMessage = {
    id, platformMessageId: `p-${id}`, target: { platform: "onebot", kind: "private", id: "7", name: "Seven" },
    senderId: "7", senderName: "Seven", direction: "incoming", content, segments,
    occurredAt: Date.now(), observedAt: Date.now(), deliveryStatus: "received", readAt: null,
  };
  db.insertMessage(message);
  return message;
}

function cachedMedia(db: MoonanDatabase, messageId: string, segmentIndex = 0, bytes = png, mime = "image/png") {
  const media = db.createMedia({ messageId, segmentIndex, fileId: "a.png", url: null });
  db.setMediaCached(media.id, { mime, bytes });
  return db.getMedia(media.id)!;
}

function pipelineFor(db: MoonanDatabase, describe: (media: any) => Promise<string | null> = async () => null, fetchFile?: ChatPlatformAdapter["fetchFile"]) {
  return new MediaPipeline(db, fakePlatform(fetchFile), () => db.getSettings().value, describe);
}

async function eventually(assertion: () => void, timeout = 2_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try { assertion(); return; } catch (error) {
      if (Date.now() - start > timeout) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

describe("media pipeline", () => {
  it("sniffs image formats from magic bytes and rejects everything else", () => {
    expect(sniffImageMime(png)).toBe("image/png");
    expect(sniffImageMime(jpeg)).toBe("image/jpeg");
    expect(sniffImageMime(gif)).toBe("image/gif");
    expect(sniffImageMime(webp)).toBe("image/webp");
    expect(sniffImageMime(bmp)).toBe("image/bmp");
    expect(sniffImageMime(notImage)).toBeNull();
    expect(sniffImageMime(new Uint8Array([1]))).toBeNull();
  });

  it("decodes base64 payloads with or without data-URI prefixes", () => {
    const encoded = Buffer.from(png).toString("base64");
    expect(decodeBase64(encoded)).toEqual(png);
    expect(decodeBase64(`data:image/png;base64,${encoded}`)).toEqual(png);
    expect(decodeBase64("")).toBeNull();
  });

  it("ingests image segments on receipt and downloads them through the segment URL", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    stubFetch(png);
    const pipeline = pipelineFor(fixture.db);
    const message = imageMessage(fixture.db, "m-1", [
      { type: "text", data: { text: "看这个" } },
      { type: "image", data: { file: "a.png", url: "http://img.test/a.png" } },
    ]);
    pipeline.ingest(message);
    await pipeline.waitForFetches([message.id], 1_000);
    const rows = fixture.db.listMediaForMessages([message.id]).get(message.id)!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ segmentIndex: 1, status: "cached", mime: "image/png", byteSize: png.byteLength });
    expect(pipeline.imageContent(rows[0]!)).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  it("skips ingestion entirely when media handling is disabled", () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const settings = fixture.db.getSettings();
    settings.value.media.enabled = false;
    fixture.db.updateSettings(settings.value, settings.version);
    const message = imageMessage(fixture.db, "m-off", [{ type: "image", data: { file: "a.png" } }]);
    pipelineFor(fixture.db).ingest(message);
    expect(fixture.db.listMediaForMessages([message.id]).size).toBe(0);
  });

  it("falls back to the platform get_image API when the URL expires or serves garbage", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    stubFetch(notImage);
    let askedFor = "";
    const fetchFile = async (fileId: string): Promise<PlatformFilePayload> => {
      askedFor = fileId;
      return { base64: Buffer.from(png).toString("base64") };
    };
    const pipeline = pipelineFor(fixture.db, async () => null, fetchFile);
    const message = imageMessage(fixture.db, "m-2", [{ type: "image", data: { file: "hash-2", url: "http://img.test/gone.png" } }]);
    pipeline.ingest(message);
    await pipeline.waitForFetches([message.id], 1_000);
    const rows = fixture.db.listMediaForMessages([message.id]).get(message.id)!;
    expect(askedFor).toBe("hash-2");
    expect(rows[0]).toMatchObject({ status: "cached", mime: "image/png" });
  });

  it("marks media failed when no source yields an image and never throws into the caller", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    stubFetch(notImage, false);
    const pipeline = pipelineFor(fixture.db);
    const message = imageMessage(fixture.db, "m-3", [{ type: "image", data: { file: "hash-3", url: "http://img.test/x.png" } }]);
    pipeline.ingest(message);
    await pipeline.waitForFetches([message.id], 1_000);
    expect(fixture.db.listMediaForMessages([message.id]).get(message.id)![0]!.status).toBe("failed");
  });

  it("re-enqueues pending downloads after a restart and purges bytes by TTL while keeping descriptions", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    stubFetch(png);
    const message = imageMessage(fixture.db, "m-4", [{ type: "image", data: { file: "a.png", url: "http://img.test/a.png" } }]);
    const first = pipelineFor(fixture.db);
    first.ingest(message);
    await first.waitForFetches([message.id], 1_000);
    const media = fixture.db.listMediaForMessages([message.id]).get(message.id)![0]!;
    fixture.db.setMediaDescription(media.id, "一只橘猫");
    fixture.db.sqlite.prepare("UPDATE message_media SET created_at=? WHERE id=?").run(Date.now() - 8 * 24 * 60 * 60_000, media.id);
    expect(fixture.db.purgeExpiredMedia(Date.now() - 7 * 24 * 60 * 60_000)).toBe(1);
    const purged = fixture.db.getMedia(media.id)!;
    expect(purged.bytes).toBeNull();
    expect(purged.description).toBe("一只橘猫");
    expect(purged.purgedAt).toBeTypeOf("number");
    expect(pipelineFor(fixture.db).imageContent(purged)).toBeNull();

    const interrupted = imageMessage(fixture.db, "m-5", [{ type: "image", data: { file: "b.png", url: "http://img.test/b.png" } }]);
    fixture.db.createMedia({ messageId: interrupted.id, segmentIndex: 0, fileId: "b.png", url: "http://img.test/b.png" });
    expect(fixture.db.listPendingMedia()).toHaveLength(1);
    const restarted = pipelineFor(fixture.db);
    restarted.start();
    await restarted.waitForFetches([interrupted.id], 1_000);
    restarted.close();
    await eventually(() => {
      expect(fixture.db.listMediaForMessages([interrupted.id]).get(interrupted.id)![0]!.status).toBe("cached");
    });
  });

  it("generates each description at most once and caches it permanently", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const message = imageMessage(fixture.db, "m-6", [{ type: "image", data: { file: "a.png" } }]);
    const media = cachedMedia(fixture.db, message.id);
    let calls = 0;
    const pipeline = pipelineFor(fixture.db, async () => { calls += 1; return "一只橘猫趴在窗台上"; });
    const [first, second] = await Promise.all([pipeline.ensureDescription(media.id), pipeline.ensureDescription(media.id)]);
    expect(first).toBe("一只橘猫趴在窗台上");
    expect(second).toBe("一只橘猫趴在窗台上");
    expect(calls).toBe(1);
    expect(fixture.db.getMedia(media.id)!.description).toBe("一只橘猫趴在窗台上");
    expect(await pipeline.ensureDescription(media.id)).toBe("一只橘猫趴在窗台上");
    expect(calls).toBe(1);
  });

  it("declines to describe media without cached bytes", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const message = imageMessage(fixture.db, "m-7", [{ type: "image", data: { file: "a.png" } }]);
    const media = fixture.db.createMedia({ messageId: message.id, segmentIndex: 0, fileId: "a.png", url: null });
    let calls = 0;
    const pipeline = pipelineFor(fixture.db, async () => { calls += 1; return "x"; });
    expect(await pipeline.ensureDescription(media.id)).toBeNull();
    expect(calls).toBe(0);
  });
});

describe("media rendering", () => {
  it("renders real images inline for image-capable consumers", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const pipeline = pipelineFor(fixture.db);
    const message = imageMessage(fixture.db, "r-1", [
      { type: "text", data: { text: "看这个" } },
      { type: "image", data: { file: "a.png" } },
    ]);
    cachedMedia(fixture.db, message.id, 1);
    const rendered = await renderObservedMessages(fixture.db, pipeline, [message], { seesImages: true, describeLazily: true });
    expect(rendered.images).toHaveLength(1);
    expect(rendered.text).toContain("看这个[图片]");
    expect(rendered.omitted).toBe(0);
    const types = rendered.content.map((block) => block.type);
    expect(types).toEqual(["text", "image"]);
  });

  it("caps injected images newest-first and notes the overflow", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const settings = fixture.db.getSettings();
    settings.value.media.maxInjectedImages = 1;
    fixture.db.updateSettings(settings.value, settings.version);
    const pipeline = pipelineFor(fixture.db, async () => "老图的描述");
    const message = imageMessage(fixture.db, "r-2", [
      { type: "image", data: { file: "old.png" } },
      { type: "image", data: { file: "new.png" } },
    ]);
    cachedMedia(fixture.db, message.id, 0);
    cachedMedia(fixture.db, message.id, 1);
    const rendered = await renderObservedMessages(fixture.db, pipeline, [message], { seesImages: true, describeLazily: true });
    expect(rendered.images).toHaveLength(1);
    expect(rendered.omitted).toBe(1);
    expect(rendered.text).toContain("（另有 1 张图片未附上）");
    expect(rendered.text).toContain("[图片：老图的描述]");
  });

  it("replaces placeholders with lazy descriptions for image-blind consumers and caches them", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    let calls = 0;
    const pipeline = pipelineFor(fixture.db, async () => { calls += 1; return "聊天记录截图：Seven 说明天见"; });
    const message = imageMessage(fixture.db, "r-3", [{ type: "image", data: { file: "a.png" } }]);
    cachedMedia(fixture.db, message.id, 0);
    const rendered = await renderObservedMessages(fixture.db, pipeline, [message], { seesImages: false, describeLazily: true });
    expect(rendered.images).toHaveLength(0);
    expect(rendered.text).toContain("[图片：聊天记录截图：Seven 说明天见]");
    const again = await renderObservedMessages(fixture.db, pipeline, [message], { seesImages: false, describeLazily: true });
    expect(again.text).toContain("聊天记录截图");
    expect(calls).toBe(1);
  });

  it("keeps the raw placeholder when description is unavailable or laziness is off", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const pipeline = pipelineFor(fixture.db);
    const message = imageMessage(fixture.db, "r-4", [{ type: "image", data: { file: "a.png" } }]);
    cachedMedia(fixture.db, message.id, 0);
    const rendered = await renderObservedMessages(fixture.db, pipeline, [message], { seesImages: false, describeLazily: false });
    expect(rendered.text).toContain("[图片：a.png]");
    const failed = imageMessage(fixture.db, "r-5", [{ type: "image", data: { file: "gone.png" } }]);
    const media = fixture.db.createMedia({ messageId: failed.id, segmentIndex: 0, fileId: "gone.png", url: null });
    fixture.db.setMediaFailed(media.id, "no_image_payload");
    const renderedFailed = await renderObservedMessages(fixture.db, pipeline, [failed], { seesImages: false, describeLazily: true });
    expect(renderedFailed.text).toContain("[图片：gone.png]");
  });

  it("renders list previews from cached descriptions only", () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const message = imageMessage(fixture.db, "r-6", [
      { type: "image", data: { file: "a.png" } },
      { type: "text", data: { text: " 早安" } },
    ]);
    expect(renderMessagePreview(fixture.db, message)).toBe("[图片：a.png] 早安");
    const media = cachedMedia(fixture.db, message.id, 0);
    fixture.db.setMediaDescription(media.id, "日出照片");
    expect(renderMessagePreview(fixture.db, message)).toBe("[图片：日出照片] 早安");
  });

  it("strips image blocks from persisted agent state", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "看" }, { type: "image", data: "AAAA", mimeType: "image/png" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 2 },
      { role: "toolResult", toolCallId: "t", toolName: "perform_action", content: [{ type: "image", data: "BBBB", mimeType: "image/png" }], isError: false, timestamp: 3 },
      { role: "user", content: "纯文本", timestamp: 4 },
    ];
    const stripped = JSON.stringify(stripImageBlocks(messages));
    expect(stripped).not.toContain("AAAA");
    expect(stripped).not.toContain("BBBB");
    expect(stripped).toContain("[图片]");
    expect(stripped).toContain("纯文本");
  });

  it("annotates synthesis events with descriptions for blind models and attaches images for seeing ones", async () => {
    const fixture = testDatabase();
    cleanups.push(fixture.cleanup);
    const pipeline = pipelineFor(fixture.db, async () => "一张日落照片");
    const message = imageMessage(fixture.db, "s-1", [{ type: "image", data: { file: "a.png" } }]);
    cachedMedia(fixture.db, message.id, 0);
    const event: WorldEvent = {
      id: "e-1", type: "message_observed", occurredAt: Date.now(),
      text: "Seven在私聊中发来：[图片：a.png]", data: { messageRowId: message.id },
    };
    const blind = await renderSynthesisEvents(fixture.db, pipeline, [event], false);
    expect(blind.images).toHaveLength(0);
    expect(blind.lines[0]).toContain("（图片内容：一张日落照片）");
    const seeing = await renderSynthesisEvents(fixture.db, pipeline, [event], true);
    expect(seeing.images).toHaveLength(1);
    expect(seeing.lines[0]).not.toContain("图片内容");
  });
});

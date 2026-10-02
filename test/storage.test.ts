import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MoonanDatabase } from "../src/storage/database.js";
import { LEGACY_SIMULATION_PROMPT_V0_0_1, SIMULATION_SYSTEM_PROMPT, VISION_SYSTEM_PROMPT } from "../src/agents/prompts.js";
import { testDatabase } from "./helpers.js";

describe("SQLite source of truth", () => {
  it("migrates, seeds paused state, uses WAL, and restricts the database mode", () => {
    const fixture = testDatabase();
    try {
      expect(fixture.db.getRuntime().mode).toBe("paused");
      expect(fixture.db.getSettings().value.web.port).toBe(21314);
      expect((fixture.db.sqlite.prepare("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
      expect(statSync(fixture.path).mode & 0o777).toBe(0o600);
    } finally { fixture.cleanup(); }
  });

  it("carries the synthesis watermark from legacy batch rows and drops unread tables", () => {
    const directory = mkdtempSync(join(tmpdir(), "moonanbot-legacy-"));
    const path = join(directory, "legacy.sqlite");
    const bare = new DatabaseSync(path);
    bare.exec(`
      CREATE TABLE synthesis_batches (id TEXT PRIMARY KEY, window_start INTEGER NOT NULL, window_end INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, summary TEXT, error TEXT, created_at INTEGER NOT NULL, completed_at INTEGER);
      INSERT INTO synthesis_batches(id,window_start,window_end,status,created_at) VALUES('old',0,4242,'completed',1);
      CREATE TABLE document_revisions (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL);
    `);
    bare.close();
    const db = new MoonanDatabase(path);
    try {
      expect(db.lastSynthesisEnd()).toBe(4242);
      expect(db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='synthesis_batches'").get()).toBeUndefined();
      expect(db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_revisions'").get()).toBeUndefined();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back nested transactions and detects optimistic conflicts", () => {
    const fixture = testDatabase();
    try {
      const before = fixture.db.getProfile();
      expect(() => fixture.db.transaction(() => {
        fixture.db.updateProfile({ ...before, name: "Changed" }, before.version);
        fixture.db.transaction(() => fixture.db.upsertMemory({ id: "temp", occurredAt: 1, summary: "temporary", details: null }));
        throw new Error("rollback");
      })).toThrow("rollback");
      expect(fixture.db.getProfile().name).toBe(before.name);
      expect(fixture.db.listMemories()).toHaveLength(0);
      const current = fixture.db.getSettings();
      fixture.db.updateSettings(current.value, current.version);
      expect(() => fixture.db.updateSettings(current.value, current.version)).toThrow("settings_version_conflict");
    } finally { fixture.cleanup(); }
  });

  it("deduplicates platform messages and hides no-push unread summaries", () => {
    const fixture = testDatabase();
    try {
      fixture.db.upsertContact({ platform: "onebot", id: "7", name: "Seven", aliases: [], summary: "", importance: "no_push", isFriend: true });
      const message = {
        id: "local-1", platformMessageId: "remote-1", target: { platform: "onebot" as const, kind: "private" as const, id: "7", name: "Seven" },
        senderId: "7", senderName: "Seven", direction: "incoming" as const, content: "hello", segments: [],
        occurredAt: 100, observedAt: 101, deliveryStatus: "received" as const, readAt: null,
      };
      expect(fixture.db.insertMessage(message)).toBe(true);
      expect(fixture.db.insertMessage({ ...message, id: "local-2" })).toBe(false);
      expect(fixture.db.unreadSummary()).toHaveLength(0);
      expect(fixture.db.unreadSummary(true)[0]?.count).toBe(1);
      fixture.db.markTargetRead(message.target);
      expect(fixture.db.unreadSummary(true)).toHaveLength(0);
    } finally { fixture.cleanup(); }
  });

  it("persists timers and claims each one exactly once after restart", () => {
    const fixture = testDatabase();
    const dueAt = Date.now() - 1;
    fixture.db.createTimer("alarm", dueAt, { reason: "test" });
    fixture.db.close();
    const reopened = new MoonanDatabase(fixture.path);
    try {
      expect(reopened.claimDueTimers()).toMatchObject([{ kind: "alarm", dueAt, payload: { reason: "test" } }]);
      expect(reopened.claimDueTimers()).toHaveLength(0);
    } finally {
      reopened.close();
      fixture.cleanup();
    }
  });

  it("cancels only the requested timer kind and lists pending timers", () => {
    const fixture = testDatabase();
    try {
      fixture.db.createTimer("idle", Date.now() + 1_000, {});
      fixture.db.createTimer("wait", Date.now() + 2_000, { mode: "count" });
      expect(fixture.db.listPendingTimers()).toHaveLength(2);
      expect(fixture.db.listPendingTimers("wait")[0]?.payload).toMatchObject({ mode: "count" });
      fixture.db.cancelPendingTimers("wait");
      expect(fixture.db.listPendingTimers("wait")).toHaveLength(0);
      expect(fixture.db.listPendingTimers("idle")).toHaveLength(1);
      fixture.db.cancelPendingTimers();
      expect(fixture.db.listPendingTimers()).toHaveLength(0);
    } finally { fixture.cleanup(); }
  });

  it("lists incoming messages since a timestamp in ascending order", () => {
    const fixture = testDatabase();
    try {
      const target = { platform: "onebot" as const, kind: "private" as const, id: "7", name: "Seven" };
      const message = (id: string, direction: "incoming" | "outgoing", occurredAt: number) => ({
        id, platformMessageId: `p-${id}`, target, senderId: "7", senderName: "Seven", direction,
        content: id, segments: [], occurredAt, observedAt: occurredAt, deliveryStatus: "received" as const, readAt: null,
      });
      fixture.db.insertMessage(message("a", "incoming", 100));
      fixture.db.insertMessage(message("b", "outgoing", 200));
      fixture.db.insertMessage(message("c", "incoming", 300));
      expect(fixture.db.listMessagesSince(target, 100).map((item) => item.id)).toEqual(["a", "c"]);
      expect(fixture.db.listMessagesSince(target, 150).map((item) => item.id)).toEqual(["c"]);
    } finally { fixture.cleanup(); }
  });

  it("migrates untouched legacy simulation prompts and preserves edited ones", () => {
    const fixture = testDatabase();
    fixture.db.setPrompt("simulation", LEGACY_SIMULATION_PROMPT_V0_0_1);
    fixture.db.close();
    const reopened = new MoonanDatabase(fixture.path);
    try {
      expect(reopened.getPrompt("simulation").template).toBe(SIMULATION_SYSTEM_PROMPT);
      expect(reopened.listPromptVersions("simulation").length).toBeGreaterThanOrEqual(2);
    } finally {
      reopened.close();
      fixture.cleanup();
    }

    const second = testDatabase();
    second.db.setPrompt("simulation", "自定义 {{botName}} {{soul}} {{environment}} {{memory}} {{relationships}} {{groups}}");
    second.db.close();
    const reopenedSecond = new MoonanDatabase(second.path);
    try {
      expect(reopenedSecond.getPrompt("simulation").template).toContain("自定义");
    } finally {
      reopenedSecond.close();
      second.cleanup();
    }
  });

  it("keeps secrets and histories out of character exports while preserving raw events", () => {
    const fixture = testDatabase();
    try {
      fixture.db.setCredential("deepseek", { type: "api_key", key: "secret-value" });
      fixture.db.addEvent("message_observed", "raw event", { private: true });
      fixture.db.upsertMemory({ id: "m1", occurredAt: 1, summary: "remember", details: null });
      fixture.db.forgetMemory("m1");
      expect(fixture.db.listMemories()).toHaveLength(0);
      expect(fixture.db.listMemories(true)).toHaveLength(1);
      const exported = JSON.stringify(fixture.db.exportCharacter());
      expect(exported).not.toContain("secret-value");
      expect(exported).not.toContain("raw event");
      expect(JSON.parse(exported).prompts.vision).toBe(VISION_SYSTEM_PROMPT);
    } finally { fixture.cleanup(); }
  });

  it("seeds the vision prompt and versions it like the other agents", () => {
    const fixture = testDatabase();
    try {
      expect(fixture.db.getPrompt("vision").template).toBe(VISION_SYSTEM_PROMPT);
      fixture.db.setPrompt("vision", "自定义识图提示词");
      expect(fixture.db.getPrompt("vision").template).toBe("自定义识图提示词");
      expect(fixture.db.listPromptVersions("vision")).toHaveLength(2);
      expect(fixture.db.getPrompt("simulation").template).toBe(SIMULATION_SYSTEM_PROMPT);
    } finally { fixture.cleanup(); }
  });

  it("round-trips media bytes through SQLite and records vision runs", () => {
    const fixture = testDatabase();
    try {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      const media = fixture.db.createMedia({ messageId: "msg-1", segmentIndex: 0, fileId: "a.png", url: "http://img.test/a.png" });
      expect(media.status).toBe("pending");
      expect(fixture.db.listPendingMedia().map((item) => item.id)).toEqual([media.id]);
      fixture.db.setMediaCached(media.id, { mime: "image/png", bytes });
      const cached = fixture.db.getMedia(media.id)!;
      expect(cached.bytes).toEqual(bytes);
      expect(cached.byteSize).toBe(bytes.byteLength);
      expect(cached.status).toBe("cached");
      expect(fixture.db.listPendingMedia()).toHaveLength(0);
      fixture.db.setMediaDescription(media.id, "一张测试图");
      expect(fixture.db.listMediaForMessages(["msg-1", "missing"]).get("msg-1")![0]!.description).toBe("一张测试图");
      expect(fixture.db.listMediaForMessages([]).size).toBe(0);
      const runId = fixture.db.beginAgentRun("vision", "描述图片 a.png");
      fixture.db.endAgentRun(runId, "completed", { input: 10, output: 20 });
      expect(fixture.db.listAgentRuns(10, "vision")).toMatchObject([{ agent: "vision", status: "completed", inputTokens: 10, outputTokens: 20 }]);
      const failed = fixture.db.createMedia({ messageId: "msg-1", segmentIndex: 1, fileId: "b.png", url: null });
      fixture.db.setMediaFailed(failed.id, "no_image_payload");
      expect(fixture.db.getMedia(failed.id)).toMatchObject({ status: "failed", error: "no_image_payload", bytes: null });
    } finally { fixture.cleanup(); }
  });
});

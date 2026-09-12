import { statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MoonanDatabase } from "../src/storage/database.js";
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
    } finally { fixture.cleanup(); }
  });
});

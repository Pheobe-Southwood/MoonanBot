import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaPipeline } from "../src/media/pipeline.js";
import { renderMessagePreview, renderObservedMessages, type MediaView } from "../src/media/render.js";
import type { ChatPlatformAdapter } from "../src/platforms/types.js";
import { MoonanDatabase } from "../src/storage/database.js";

export function testDatabase(): { db: MoonanDatabase; path: string; cleanup(): void } {
  const directory = mkdtempSync(join(tmpdir(), "moonanbot-test-"));
  const path = join(directory, "moonanbot.sqlite");
  const db = new MoonanDatabase(path);
  return {
    db,
    path,
    cleanup: () => {
      try { db.close(); } catch { /* already closed */ }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function textOf(result: any): string {
  return result.content.map((item: any) => item.text ?? "").join("");
}

const silentPlatform: ChatPlatformAdapter = {
  id: "silent",
  status: () => ({ connected: false, selfId: null, roles: [] }),
  sendText: async () => ({ platformMessageId: null }),
  syncRoster: async () => ({ groupsAdded: 0, groupsRemoved: 0, contactsUpdated: 0 }),
  close: async () => undefined,
};

/** Text-only media view over a real pipeline whose Vision calls always decline. */
export function stubMediaView(db: MoonanDatabase): MediaView {
  const pipeline = new MediaPipeline(db, silentPlatform, () => db.getSettings().value, async () => null);
  return {
    seesImages: () => false,
    render: (messages, options) => renderObservedMessages(db, pipeline, messages, {
      seesImages: false,
      describeLazily: options?.describeLazily ?? false,
    }),
    preview: (message) => renderMessagePreview(db, message),
  };
}

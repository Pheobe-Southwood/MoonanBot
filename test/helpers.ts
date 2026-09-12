import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

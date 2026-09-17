#!/usr/bin/env node
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { MoonanDatabase } from "./storage/database.js";
import { WebAuth } from "./http/auth.js";
import { dataDirectory, main } from "./index.js";

function usage(): never {
  process.stderr.write(`MoonanBot v0.0.1-rc.4\n\nUsage:\n  moonanbot serve\n  moonanbot reset-password [new-password]\n  moonanbot backup <destination.sqlite>\n  moonanbot status\n`);
  process.exit(2);
}

async function cli(): Promise<void> {
  const [command = "serve", argument] = process.argv.slice(2);
  if (command === "serve") return main();
  const databasePath = join(dataDirectory(), "moonanbot.sqlite");
  if (!existsSync(databasePath) && command !== "reset-password") throw new Error(`MoonanBot database does not exist: ${databasePath}`);
  const db = new MoonanDatabase(databasePath);
  try {
    if (command === "reset-password") {
      const password = await new WebAuth(db).resetPassword(argument);
      process.stdout.write(`New MoonanBot password: ${password}\n`);
      return;
    }
    if (command === "backup") {
      if (!argument) usage();
      const target = resolve(argument);
      if (target === db.path || basename(target) === "") throw new Error("Invalid backup destination");
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      db.sqlite.exec("PRAGMA wal_checkpoint(FULL)");
      db.sqlite.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
      process.stdout.write(`Full backup written to ${target}. WARNING: it contains plaintext provider credentials.\n`);
      return;
    }
    if (command === "status") {
      process.stdout.write(`${JSON.stringify({ runtime: db.getRuntime(), readinessData: db.getStats(), database: db.path }, null, 2)}\n`);
      return;
    }
    usage();
  } finally {
    db.close();
  }
}

void cli().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

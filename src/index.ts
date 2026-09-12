import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "./http/app.js";

export function dataDirectory(): string {
  return resolve(process.env.MOONANBOT_DATA_DIR ?? join(homedir(), ".moonanbot"));
}

export async function main(): Promise<void> {
  const app = await createApp({
    databasePath: join(dataDirectory(), "moonanbot.sqlite"),
    logger: process.env.NODE_ENV !== "test",
  });
  const settings = app.db.getSettings().value;
  await app.server.listen({ host: process.env.MOONANBOT_HOST ?? settings.web.host, port: Number(process.env.MOONANBOT_PORT ?? settings.web.port) });
  if (app.bootstrapPassword) {
    app.server.log.warn("A new WebUI password was generated. Store it now; it remains valid until reset.");
    process.stdout.write(`MOONANBOT_INITIAL_PASSWORD=${app.bootstrapPassword}\n`);
  }
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  void main();
}

export * from "./agents/index.js";
export * from "./domain/index.js";
export * from "./http/index.js";
export * from "./platforms/index.js";
export * from "./providers/index.js";
export * from "./storage/index.js";

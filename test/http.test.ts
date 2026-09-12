import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type MoonanApp } from "../src/http/app.js";

const apps: Array<{ app: MoonanApp; directory: string }> = [];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "moonanbot-http-"));
  const app = await createApp({ databasePath: join(directory, "db.sqlite"), logger: false, initialPassword: "correct horse battery staple" });
  apps.push({ app, directory });
  return app;
}

afterEach(async () => {
  for (const item of apps.splice(0)) {
    await item.app.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
});

async function login(app: MoonanApp): Promise<string> {
  const response = await app.server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: "correct horse battery staple" } });
  expect(response.statusCode).toBe(200);
  const header = response.headers["set-cookie"]!;
  return (Array.isArray(header) ? header[0]! : header).split(";")[0]!;
}

describe("Web API", () => {
  it("keeps health public and requires password sessions everywhere else", async () => {
    const app = await fixture();
    expect((await app.server.inject({ method: "GET", url: "/api/v1/health" })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/v1/runtime" })).statusCode).toBe(401);
    expect((await app.server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: "wrong-password" } })).statusCode).toBe(401);
    const cookie = await login(app);
    expect((await app.server.inject({ method: "GET", url: "/api/v1/runtime", headers: { cookie } })).statusCode).toBe(200);
  });

  it("validates origins, profile versions, prompt placeholders, and setting versions", async () => {
    const app = await fixture();
    const cookie = await login(app);
    const profile = (await app.server.inject({ method: "GET", url: "/api/v1/profile", headers: { cookie } })).json();
    const badOrigin = await app.server.inject({ method: "PUT", url: "/api/v1/profile", headers: { cookie, origin: "https://evil.example", host: "local.test" }, payload: profile });
    expect(badOrigin.statusCode).toBe(403);
    const updated = await app.server.inject({ method: "PUT", url: "/api/v1/profile", headers: { cookie }, payload: { ...profile, name: "Luna", soul: "curious" } });
    expect(updated.statusCode).toBe(200);
    expect((await app.server.inject({ method: "PUT", url: "/api/v1/profile", headers: { cookie }, payload: profile })).statusCode).toBe(409);
    expect((await app.server.inject({ method: "PUT", url: "/api/v1/prompts/simulation", headers: { cookie }, payload: { template: "missing everything" } })).statusCode).toBe(400);
    const settings = (await app.server.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie } })).json();
    expect((await app.server.inject({ method: "PUT", url: "/api/v1/settings", headers: { cookie }, payload: { value: { ...settings.value, web: { ...settings.value.web, port: 99_999 } }, version: settings.version } })).statusCode).toBe(400);
  });

  it("masks credentials and exports/imports only the versioned character package", async () => {
    const app = await fixture();
    const cookie = await login(app);
    const key = "very-secret-provider-key";
    expect((await app.server.inject({ method: "PUT", url: "/api/v1/providers/deepseek/key", headers: { cookie }, payload: { key } })).json()).toMatchObject({ masked: "ver••••key" });
    await app.server.inject({ method: "POST", url: "/api/v1/memories", headers: { cookie }, payload: { occurredAt: 10, summary: "first", details: "detail" } });
    const exportedResponse = await app.server.inject({ method: "GET", url: "/api/v1/export/character", headers: { cookie } });
    const exported = exportedResponse.json();
    expect(exported.schemaVersion).toBe(1);
    expect(exportedResponse.body).not.toContain(key);
    expect(exported).not.toHaveProperty("messages");
    const imported = await app.server.inject({ method: "POST", url: "/api/v1/import/character", headers: { cookie }, payload: { ...exported, profile: { ...exported.profile, name: "Imported" } } });
    expect(imported.statusCode).toBe(200);
    expect(app.db.getProfile().name).toBe("Imported");
    expect((app.db.getCredential<any>("deepseek")).key).toBe(key);
  });

  it("starts paused and refuses to run before both agents are configured", async () => {
    const app = await fixture();
    const cookie = await login(app);
    expect(app.db.getRuntime().mode).toBe("paused");
    const response = await app.server.inject({ method: "POST", url: "/api/v1/runtime/start", headers: { cookie } });
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("SOUL");
  });
});

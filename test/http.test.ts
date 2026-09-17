import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
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

  it("keeps a OneBot socket open when the client sends a capitalized X-Client-Role", async () => {
    const app = await fixture();
    const token = app.db.getSettings().value.onebot.accessToken;
    await app.server.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/onebot/v11/ws`, {
      headers: { "x-self-id": "3665494712", "x-client-role": "Universal", authorization: `Bearer ${token}` },
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("close", (code: number, reason: Buffer) => reject(new Error(`closed ${code} ${reason.toString()}`)));
        socket.once("error", reject);
      });
      expect(app.onebot.status()).toMatchObject({ connected: true, selfId: "3665494712", roles: ["universal"] });
      expect(app.db.getRuntime().activeSelfId).toBe("3665494712");
    } finally {
      if (socket.readyState === WebSocket.OPEN) {
        await new Promise<void>((resolve) => { socket.once("close", () => resolve()); socket.close(); });
      }
    }
  });

  it("validates outbound OneBot settings and reports their live status", async () => {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    const sockets: any[] = [];
    server.on("connection", (socket: any) => { sockets.push(socket); });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    const serverUrl = `ws://127.0.0.1:${(server.address() as { port: number }).port}/`;
    const app = await fixture();
    try {
      const cookie = await login(app);
      const settings = (await app.server.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie } })).json();
      const outbound = [{ name: "snowluma", url: serverUrl, accessToken: "snow-token", selfId: "3665494712", role: "universal", reconnectIntervalMs: 5_000, enabled: true }];

      const rejected = await app.server.inject({
        method: "PUT", url: "/api/v1/settings", headers: { cookie },
        payload: { value: { ...settings.value, onebot: { ...settings.value.onebot, outbound: [{ ...outbound[0], url: "http://127.0.0.1:3000/" }] } }, version: settings.version },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json().error).toMatch(/invalid_onebot_outbound_url_1/);

      const saved = await app.server.inject({
        method: "PUT", url: "/api/v1/settings", headers: { cookie },
        payload: { value: { ...settings.value, onebot: { ...settings.value.onebot, acceptReverse: false, outbound } }, version: settings.version },
      });
      expect(saved.statusCode).toBe(200);

      let connected = false;
      for (let i = 0; i < 100 && !connected; i += 1) {
        const runtime = (await app.server.inject({ method: "GET", url: "/api/v1/runtime", headers: { cookie } })).json();
        connected = runtime.outbound[0]?.connected === true && runtime.runtime.activeSelfId === "3665494712";
        if (!connected) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(connected).toBe(true);
      expect(app.db.getSettings().value.onebot.acceptReverse).toBe(false);
      expect(app.onebot.status().roles).toEqual(["universal"]);
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

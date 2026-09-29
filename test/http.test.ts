import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const healthResponse = await app.server.inject({ method: "GET", url: "/api/v1/health" });
    expect(healthResponse.statusCode).toBe(200);
    const health = healthResponse.json();
    expect(health.status).toBe("ok");
    expect(health.version).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
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

  it("versions the vision prompt without required placeholders and rejects unknown agents", async () => {
    const app = await fixture();
    const cookie = await login(app);
    const current = await app.server.inject({ method: "GET", url: "/api/v1/prompts/vision", headers: { cookie } });
    expect(current.statusCode).toBe(200);
    expect(current.json().current.template).toContain("图片信息提取器");
    const saved = await app.server.inject({ method: "PUT", url: "/api/v1/prompts/vision", headers: { cookie }, payload: { template: "只看构图与色彩。" } });
    expect(saved.statusCode).toBe(200);
    const versions = (await app.server.inject({ method: "GET", url: "/api/v1/prompts/vision", headers: { cookie } })).json();
    expect(versions.current.template).toBe("只看构图与色彩。");
    expect(versions.versions.length).toBeGreaterThanOrEqual(2);
    expect((await app.server.inject({ method: "POST", url: "/api/v1/prompts/vision/reset", headers: { cookie } })).json().template).toContain("图片信息提取器");
    expect((await app.server.inject({ method: "GET", url: "/api/v1/prompts/unknown", headers: { cookie } })).statusCode).toBe(404);
    expect((await app.server.inject({ method: "PUT", url: "/api/v1/prompts/unknown", headers: { cookie }, payload: { template: "x" } })).statusCode).toBe(404);
  });

  it("exposes model input modalities and round-trips media settings and the force override", async () => {
    const app = await fixture();
    const cookie = await login(app);
    const providers = (await app.server.inject({ method: "GET", url: "/api/v1/providers", headers: { cookie } })).json();
    const deepseek = providers.find((item: any) => item.id === "deepseek");
    expect(deepseek.models.length).toBeGreaterThan(0);
    for (const model of deepseek.models) expect(Array.isArray(model.input)).toBe(true);
    const settings = (await app.server.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie } })).json();
    expect(settings.value.media).toEqual({ enabled: true, downloadTimeoutMs: 30_000, byteTtlDays: 7, maxInjectedImages: 10 });
    expect(settings.value.agents.vision).toMatchObject({ providerId: null, modelId: null, forceImageInput: false });
    const next = {
      value: {
        ...settings.value,
        media: { ...settings.value.media, byteTtlDays: 3, maxInjectedImages: 5, enabled: false },
        agents: { ...settings.value.agents, simulation: { ...settings.value.agents.simulation, forceImageInput: true } },
      },
      version: settings.version,
    };
    const saved = (await app.server.inject({ method: "PUT", url: "/api/v1/settings", headers: { cookie }, payload: next })).json();
    expect(saved.value.media).toMatchObject({ byteTtlDays: 3, maxInjectedImages: 5, enabled: false });
    expect(saved.value.agents.simulation.forceImageInput).toBe(true);
    const invalid = await app.server.inject({
      method: "PUT", url: "/api/v1/settings", headers: { cookie },
      payload: { value: { ...next.value, media: { ...next.value.media, byteTtlDays: 0 } }, version: saved.version },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_media_ttl");
  });

  it("imports character packages with or without the optional vision prompt", async () => {
    const app = await fixture();
    const cookie = await login(app);
    const exported = (await app.server.inject({ method: "GET", url: "/api/v1/export/character", headers: { cookie } })).json();
    expect(exported.prompts.vision).toBeTypeOf("string");
    const legacy = { ...exported, prompts: { simulation: exported.prompts.simulation, synthesis: exported.prompts.synthesis } };
    expect((await app.server.inject({ method: "POST", url: "/api/v1/import/character", headers: { cookie }, payload: legacy })).statusCode).toBe(200);
    expect((await app.server.inject({ method: "GET", url: "/api/v1/prompts/vision", headers: { cookie } })).json().current.template).toBe(exported.prompts.vision);
    const custom = { ...exported, prompts: { ...exported.prompts, vision: "自定义识图提示词" } };
    expect((await app.server.inject({ method: "POST", url: "/api/v1/import/character", headers: { cookie }, payload: custom })).statusCode).toBe(200);
    const after = (await app.server.inject({ method: "GET", url: "/api/v1/prompts/vision", headers: { cookie } })).json();
    expect(after.current.template).toBe("自定义识图提示词");
  });

  it("reports vision-related readiness warnings without blocking start", async () => {
    const app = await fixture();
    const cookie = await login(app);
    const profile = (await app.server.inject({ method: "GET", url: "/api/v1/profile", headers: { cookie } })).json();
    await app.server.inject({ method: "PUT", url: "/api/v1/profile", headers: { cookie }, payload: { ...profile, soul: "谨慎。" } });
    const settings = (await app.server.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie } })).json();
    await app.server.inject({
      method: "PUT", url: "/api/v1/settings", headers: { cookie },
      payload: { value: { ...settings.value, agents: { ...settings.value.agents, default: { providerId: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "medium" } } }, version: settings.version },
    });
    const runtime = (await app.server.inject({ method: "GET", url: "/api/v1/runtime", headers: { cookie } })).json();
    expect(runtime.readiness.problems).toHaveLength(0);
    expect(runtime.readiness.ready).toBe(true);
    expect(runtime.readiness.warnings.join(" ")).toContain("图片识别");
    const current = (await app.server.inject({ method: "GET", url: "/api/v1/settings", headers: { cookie } })).json();
    const forced = {
      value: { ...current.value, agents: { ...current.value.agents, vision: { ...current.value.agents.vision, forceImageInput: true } } },
      version: current.version,
    };
    const saved = await app.server.inject({ method: "PUT", url: "/api/v1/settings", headers: { cookie }, payload: forced });
    expect(saved.statusCode).toBe(200);
    const after = (await app.server.inject({ method: "GET", url: "/api/v1/runtime", headers: { cookie } })).json();
    expect(after.readiness.warnings.join(" ")).not.toContain("图片识别");
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

  it("accepts bodyless runtime posts and guards manual roster sync behind auth", async () => {
    const app = await fixture();
    const cookie = await login(app);
    const bodyless = await app.server.inject({ method: "POST", url: "/api/v1/runtime/pause", headers: { cookie } });
    expect(bodyless.statusCode).toBe(200);
    expect((await app.server.inject({ method: "POST", url: "/api/v1/platform/sync" })).statusCode).toBe(401);
    const sync = await app.server.inject({ method: "POST", url: "/api/v1/platform/sync", headers: { cookie } });
    expect(sync.statusCode).toBe(503);
    expect(sync.json().error).toContain("OneBot API connection is not available");
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

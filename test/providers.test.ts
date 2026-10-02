import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, type MoonanApp } from "../src/http/app.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { MoonanDatabase } from "../src/storage/database.js";
import { testDatabase } from "./helpers.js";

const cleanups: Array<() => void> = [];
const apps: Array<{ app: MoonanApp; directory: string }> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const item of apps.splice(0)) {
    await item.app.close();
    rmSync(item.directory, { recursive: true, force: true });
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface FetchCall { url: string; headers: Record<string, string> | undefined }

/** Stubs the global fetch with an OpenAI-compatible /models endpoint and records every call. */
function stubModelsEndpoint(responder: (url: string) => { ok: boolean; status?: number; ids?: string[] }): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), headers: init?.headers });
    const answer = responder(String(url));
    return { ok: answer.ok, status: answer.status ?? 200, json: async () => ({ data: (answer.ids ?? []).map((id) => ({ id })) }) };
  }));
  return calls;
}

function registryFixture() {
  const fixture = testDatabase();
  cleanups.push(fixture.cleanup);
  return { db: fixture.db, providers: new ProviderRegistry(fixture.db) };
}

async function appFixture(): Promise<{ app: MoonanApp; cookie: string }> {
  const directory = mkdtempSync(join(tmpdir(), "moonanbot-providers-"));
  const app = await createApp({ databasePath: join(directory, "db.sqlite"), logger: false, initialPassword: "test-password" });
  apps.push({ app, directory });
  const response = await app.server.inject({ method: "POST", url: "/api/v1/auth/login", payload: { password: "test-password" } });
  const header = response.headers["set-cookie"]!;
  return { app, cookie: (Array.isArray(header) ? header[0]! : header).split(";")[0]! };
}

describe("custom provider model persistence", () => {
  it("persists a successful refresh and serves the models after a registry restart without network", async () => {
    const { db, providers } = registryFixture();
    providers.saveCustom({ id: "proxy-a", name: "Proxy A", baseUrl: "http://127.0.0.1:9/v1", apiKey: "key-a", models: [] });
    const calls = stubModelsEndpoint(() => ({ ok: true, ids: ["m1", "m2"] }));

    const result = await providers.refresh("proxy-a");
    expect(result.error).toBeUndefined();
    expect(result.models.map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9/v1/models");
    expect(calls[0]!.headers?.Authorization).toBe("Bearer key-a");

    const record = db.listCustomProviders().find((item) => item.id === "proxy-a")!;
    expect(record.models.map((model) => model.id)).toEqual(["m1", "m2"]);
    expect(record.models[0]!.contextWindow).toBe(128_000);
    expect(record.lastRefreshError).toBeNull();
    expect(record.lastRefreshAt).toBeTypeOf("number");

    // Simulate a version-update restart: a fresh registry must see the models with the network unavailable.
    stubModelsEndpoint(() => { throw new Error("boot must not need the network"); });
    const restarted = new ProviderRegistry(db);
    expect(restarted.models.getModel("proxy-a", "m1")).toBeDefined();
    const view = (await restarted.list()).find((item) => item.id === "proxy-a")!;
    expect(view.models.length).toBe(2);
    expect(view.lastRefreshAt).toBe(record.lastRefreshAt);
  });

  it("keeps configured metadata for known ids when the remote list changes", async () => {
    const { db, providers } = registryFixture();
    providers.saveCustom({
      id: "proxy-b", name: "Proxy B", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k",
      models: [{ id: "m1", name: "Configured", contextWindow: 32_000, maxTokens: 4_096, reasoning: true }],
    });
    stubModelsEndpoint(() => ({ ok: true, ids: ["m1", "fresh"] }));
    await providers.refresh("proxy-b");
    const models = db.listCustomProviders().find((item) => item.id === "proxy-b")!.models;
    expect(models.find((model) => model.id === "m1")).toEqual({ id: "m1", name: "Configured", contextWindow: 32_000, maxTokens: 4_096, reasoning: true });
    expect(models.find((model) => model.id === "fresh")).toEqual({ id: "fresh", name: "fresh", contextWindow: 128_000, maxTokens: 8_192, reasoning: false });
  });

  it("never lets an empty remote list clear the stored models", async () => {
    const { db, providers } = registryFixture();
    providers.saveCustom({
      id: "proxy-c", name: "Proxy C", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k",
      models: [{ id: "m1", name: "m1", contextWindow: 128_000, maxTokens: 8_192, reasoning: false }],
    });
    stubModelsEndpoint(() => ({ ok: true, ids: [] }));

    const result = await providers.refresh("proxy-c");
    expect(result.error).toContain("empty list");
    expect(result.models.map((model) => model.id)).toEqual(["m1"]);
    const record = db.listCustomProviders().find((item) => item.id === "proxy-c")!;
    expect(record.models.map((model) => model.id)).toEqual(["m1"]);
    expect(record.lastRefreshError).toContain("empty list");
    expect(providers.models.getModel("proxy-c", "m1")).toBeDefined();
  });

  it("keeps the stored models and records the error when the remote fetch fails", async () => {
    const { db, providers } = registryFixture();
    providers.saveCustom({
      id: "proxy-d", name: "Proxy D", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k",
      models: [{ id: "m1", name: "m1", contextWindow: 128_000, maxTokens: 8_192, reasoning: false }],
    });
    stubModelsEndpoint(() => ({ ok: false, status: 503 }));

    const result = await providers.refresh("proxy-d");
    expect(result.error).toContain("HTTP 503");
    expect(result.models.map((model) => model.id)).toEqual(["m1"]);
    expect(db.listCustomProviders().find((item) => item.id === "proxy-d")!.lastRefreshError).toContain("HTTP 503");
  });

  it("refreshes a keyless endpoint without an Authorization header", async () => {
    const { db, providers } = registryFixture();
    providers.saveCustom({ id: "local-lm", name: "Local LM", baseUrl: "http://127.0.0.1:1234/v1", apiKey: null, models: [] });
    const calls = stubModelsEndpoint(() => ({ ok: true, ids: ["local-model"] }));

    const result = await providers.refresh("local-lm");
    expect(result.error).toBeUndefined();
    expect(calls[0]!.headers).toBeUndefined();
    expect(db.listCustomProviders().find((item) => item.id === "local-lm")!.models.map((model) => model.id)).toEqual(["local-model"]);
  });

  it("prefers the stored credential over the record key when both exist", async () => {
    const { db, providers } = registryFixture();
    providers.saveCustom({ id: "proxy-e", name: "Proxy E", baseUrl: "http://127.0.0.1:9/v1", apiKey: "record-key", models: [] });
    db.setCredential("proxy-e", { type: "api_key", key: "credential-key" });
    const calls = stubModelsEndpoint(() => ({ ok: true, ids: ["m1"] }));
    await providers.refresh("proxy-e");
    expect(calls[0]!.headers?.Authorization).toBe("Bearer credential-key");
  });

  it("isolates per-provider failures during the boot-time sync", async () => {
    const { db, providers } = registryFixture();
    providers.saveCustom({ id: "good", name: "Good", baseUrl: "http://good.test/v1", apiKey: "k", models: [] });
    providers.saveCustom({ id: "bad", name: "Bad", baseUrl: "http://bad.test/v1", apiKey: "k", models: [] });
    stubModelsEndpoint((url) => url.startsWith("http://good.test") ? { ok: true, ids: ["g1"] } : { ok: false, status: 500 });

    await providers.refreshCustomProviders();
    const records = new Map(db.listCustomProviders().map((item) => [item.id, item]));
    expect(records.get("good")!.models.map((model) => model.id)).toEqual(["g1"]);
    expect(records.get("good")!.lastRefreshError).toBeNull();
    expect(records.get("bad")!.lastRefreshError).toContain("HTTP 500");
  });

  it("no-ops the boot-time sync when no custom provider exists", async () => {
    const { providers } = registryFixture();
    await expect(providers.refreshCustomProviders()).resolves.toBeUndefined();
  });

  it("rethrows an aborted refresh without touching the stored state", async () => {
    const { db, providers } = registryFixture();
    providers.saveCustom({ id: "proxy-f", name: "Proxy F", baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", models: [] });
    const controller = new AbortController();
    controller.abort();
    await expect(providers.refresh("proxy-f", controller.signal)).rejects.toThrow();
    const record = db.listCustomProviders().find((item) => item.id === "proxy-f")!;
    expect(record.lastRefreshAt).toBeNull();
    expect(record.lastRefreshError).toBeNull();
  });

  it("keeps the DeepSeek static catalog when its live overlay refresh comes back empty", async () => {
    const { db, providers } = registryFixture();
    db.setCredential("deepseek", { type: "api_key", key: "test-key" });
    stubModelsEndpoint(() => ({ ok: true, ids: [] }));

    const result = await providers.refresh("deepseek");
    expect(result.error).toContain("empty list");
    expect(result.models.length).toBeGreaterThan(0);
  });
});

describe("custom provider edit semantics", () => {
  it("treats a PUT as an operator edit: models and key survive unless explicitly replaced", async () => {
    const { app, cookie } = await appFixture();
    const put = (payload: Record<string, unknown>) => app.server.inject({ method: "PUT", url: "/api/v1/custom-providers/merge-test", headers: { cookie }, payload });
    const stored = () => app.db.listCustomProviders().find((item) => item.id === "merge-test")!;

    const created = await put({ name: "Merge", baseUrl: "http://merge.test/v1", apiKey: "secret-key", models: [{ id: "m1", name: "M1", contextWindow: 32_000, maxTokens: 4_096, reasoning: true }] });
    expect(created.statusCode).toBe(200);
    expect(stored().models.map((model) => model.id)).toEqual(["m1"]);

    // The new UI edit payload: no models field, blank key.
    await put({ name: "Renamed", baseUrl: "http://merge.test/v2" });
    expect(stored().name).toBe("Renamed");
    expect(stored().baseUrl).toBe("http://merge.test/v2");
    expect(stored().apiKey).toBe("secret-key");
    expect(stored().models.map((model) => model.id)).toEqual(["m1"]);

    // A stale cached UI bundle still sends models: [] — it must not wipe anything.
    await put({ name: "Renamed", baseUrl: "http://merge.test/v2", apiKey: "", models: [] });
    expect(stored().models.map((model) => model.id)).toEqual(["m1"]);
    expect(stored().apiKey).toBe("secret-key");

    // All-invalid entries count as no list at all.
    await put({ name: "Renamed", baseUrl: "http://merge.test/v2", models: [{ nope: true }, { id: "  " }] });
    expect(stored().models.map((model) => model.id)).toEqual(["m1"]);

    // An explicit non-empty array replaces the list, coercing missing capability fields.
    await put({ name: "Renamed", baseUrl: "http://merge.test/v2", models: [{ id: "m2" }] });
    expect(stored().models).toEqual([{ id: "m2", name: "m2", contextWindow: 128_000, maxTokens: 8_192, reasoning: false }]);

    // Duplicate ids collapse to the first entry.
    await put({ name: "Renamed", baseUrl: "http://merge.test/v2", models: [{ id: "d1" }, { id: "d1", name: "second" }] });
    expect(stored().models).toEqual([{ id: "d1", name: "d1", contextWindow: 128_000, maxTokens: 8_192, reasoning: false }]);

    // A new key replaces the stored one.
    await put({ name: "Renamed", baseUrl: "http://merge.test/v2", apiKey: "rotated" });
    expect(stored().apiKey).toBe("rotated");

    // A partial edit without a name keeps the stored display name; a nameless create is rejected.
    await put({ baseUrl: "http://merge.test/v3" });
    expect(stored().name).toBe("Renamed");
    expect(stored().baseUrl).toBe("http://merge.test/v3");
    const nameless = await app.server.inject({ method: "PUT", url: "/api/v1/custom-providers/no-name", headers: { cookie }, payload: { baseUrl: "http://nameless.test/v1" } });
    expect(nameless.statusCode).toBe(500);
    expect(nameless.json().message).toContain("name_required");

    // Edits never touch the refresh state.
    stubModelsEndpoint(() => ({ ok: true, ids: ["r1"] }));
    const refreshed = await app.server.inject({ method: "POST", url: "/api/v1/providers/merge-test/refresh", headers: { cookie } });
    expect(refreshed.statusCode).toBe(200);
    expect(stored().lastRefreshAt).toBeTypeOf("number");
    const syncState = { at: stored().lastRefreshAt, error: stored().lastRefreshError };
    await put({ name: "Renamed again", baseUrl: "http://merge.test/v2" });
    expect(stored().lastRefreshAt).toBe(syncState.at);
    expect(stored().lastRefreshError).toBe(syncState.error);
  });

  it("exposes the refresh state and masked key through the provider APIs", async () => {
    const { app, cookie } = await appFixture();
    await app.server.inject({ method: "PUT", url: "/api/v1/custom-providers/state-test", headers: { cookie }, payload: { name: "State", baseUrl: "http://state.test/v1", apiKey: "super-secret-key" } });
    // Creating without a models field starts from an empty list, not an error.
    expect(app.db.listCustomProviders().find((item) => item.id === "state-test")!.models).toEqual([]);
    stubModelsEndpoint(() => ({ ok: false, status: 502 }));
    await app.server.inject({ method: "POST", url: "/api/v1/providers/state-test/refresh", headers: { cookie } });

    const view = (await app.server.inject({ method: "GET", url: "/api/v1/providers", headers: { cookie } })).json()
      .find((item: any) => item.id === "state-test");
    expect(view.custom).toBe(true);
    expect(view.lastRefreshError).toContain("HTTP 502");
    expect(view.lastRefreshAt).toBeTypeOf("number");

    const custom = (await app.server.inject({ method: "GET", url: "/api/v1/custom-providers", headers: { cookie } })).json()
      .find((item: any) => item.id === "state-test");
    expect(custom.apiKey).not.toContain("super-secret-key");
    expect(custom.lastRefreshError).toContain("HTTP 502");
  });
});

describe("custom_providers schema migration", () => {
  it("adds the nullable refresh-state columns to databases written by older releases", () => {
    const directory = mkdtempSync(join(tmpdir(), "moonanbot-legacy-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(path);
    legacy.exec(`CREATE TABLE custom_providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT,
      models_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    legacy.prepare("INSERT INTO custom_providers VALUES('old','Old','http://old.test/v1',NULL,'[]',1,1)").run();
    legacy.close();

    const db = new MoonanDatabase(path);
    cleanups.push(() => { try { db.close(); } catch { /* already closed */ } });
    const record = db.listCustomProviders().find((item) => item.id === "old")!;
    expect(record.lastRefreshAt).toBeNull();
    expect(record.lastRefreshError).toBeNull();

    // Opening an already-migrated database again is a no-op for the columns.
    db.close();
    const reopened = new MoonanDatabase(path);
    expect(reopened.listCustomProviders().find((item) => item.id === "old")!.name).toBe("Old");
    reopened.close();
  });
});

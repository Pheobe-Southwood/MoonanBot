import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import type WebSocket from "ws";
import { RuntimeOrchestrator } from "../agents/orchestrator.js";
import { SIMULATION_SYSTEM_PROMPT, SYNTHESIS_SYSTEM_PROMPT, validatePromptTemplate } from "../agents/prompts.js";
import type { AppSettings, CharacterProfile, ContactRecord, GroupRecord, Importance } from "../domain/types.js";
import { OneBotV11Adapter } from "../platforms/onebot.js";
import { ProviderRegistry } from "../providers/registry.js";
import { MoonanDatabase } from "../storage/database.js";
import { WebAuth } from "./auth.js";
import { OAuthFlowManager } from "./oauth-flows.js";

export interface AppOptions {
  databasePath: string;
  logger?: boolean;
  initialPassword?: string;
  random?: () => number;
}

export interface MoonanApp {
  server: FastifyInstance;
  db: MoonanDatabase;
  providers: ProviderRegistry;
  onebot: OneBotV11Adapter;
  orchestrator: RuntimeOrchestrator;
  bootstrapPassword: string | null;
  close(): Promise<void>;
}

function isUnsafe(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

function validateSettings(settings: AppSettings): void {
  if (!Number.isInteger(settings.web.port) || settings.web.port < 1 || settings.web.port > 65_535) throw new Error("invalid_port");
  if (settings.simulation.idleMinMinutes < 1 || settings.simulation.idleMaxMinutes < settings.simulation.idleMinMinutes) throw new Error("invalid_idle_bounds");
  if (settings.simulation.sleepMinMinutes < 1 || settings.simulation.sleepMaxMinutes < settings.simulation.sleepMinMinutes) throw new Error("invalid_sleep_bounds");
  if (settings.simulation.priorityWakeProbability < 0 || settings.simulation.priorityWakeProbability > 1) throw new Error("invalid_wake_probability");
  if (settings.simulation.contextModelRatio <= 0 || settings.simulation.contextModelRatio > 1) throw new Error("invalid_context_ratio");
  if (settings.synthesis.memorySoftTokens < 1 || settings.synthesis.memoryHardTokens < settings.synthesis.memorySoftTokens) throw new Error("invalid_memory_limits");
  if (settings.synthesis.retryCount < 0 || settings.synthesis.retryCount > 10) throw new Error("invalid_retry_count");
}

function maskSecret(value: string | null): string | null {
  if (!value) return null;
  return value.length < 8 ? "••••••••" : `${value.slice(0, 3)}••••${value.slice(-3)}`;
}

export async function createApp(options: AppOptions): Promise<MoonanApp> {
  const db = new MoonanDatabase(options.databasePath);
  const providers = new ProviderRegistry(db);
  let dispatchOneBotMessage = async (_event: Parameters<RuntimeOrchestrator["handleIncoming"]>[0]): Promise<void> => undefined;
  const onebot = new OneBotV11Adapter(db, () => db.getSettings().value, async (event) => dispatchOneBotMessage(event));
  const orchestrator = new RuntimeOrchestrator(db, providers, onebot, options.random);
  dispatchOneBotMessage = async (event) => orchestrator.handleIncoming(event);
  const auth = new WebAuth(db);
  const bootstrapPassword = await auth.ensurePassword(options.initialPassword ?? process.env.MOONANBOT_INITIAL_PASSWORD);
  const oauthFlows = new OAuthFlowManager();
  const server = Fastify({ logger: options.logger ?? true, bodyLimit: 512 * 1024 });
  await server.register(cookie);
  await server.register(websocket);

  const failures = new Map<string, { count: number; resetAt: number }>();
  server.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/v1") || path === "/api/v1/auth/login" || path === "/api/v1/health") return;
    if (!auth.authenticated(request.cookies.moonan_session)) return reply.code(401).send({ error: "unauthorized" });
    if (isUnsafe(request.method)) {
      const origin = request.headers.origin;
      const host = request.headers.host;
      if (origin && host && new URL(origin).host !== host) return reply.code(403).send({ error: "origin_mismatch" });
    }
  });

  server.get("/api/v1/health", async () => ({ status: "ok", version: "0.0.1-rc.3" }));
  server.post("/api/v1/auth/login", async (request, reply) => {
    const address = request.ip;
    const state = failures.get(address);
    if (state && state.resetAt > Date.now() && state.count >= 5) return reply.code(429).send({ error: "too_many_attempts" });
    const password = (request.body as any)?.password;
    const token = typeof password === "string" ? await auth.login(password) : null;
    if (!token) {
      const current = state && state.resetAt > Date.now() ? state : { count: 0, resetAt: Date.now() + 15 * 60_000 };
      current.count += 1; failures.set(address, current);
      return reply.code(401).send({ error: "invalid_password" });
    }
    failures.delete(address);
    reply.setCookie("moonan_session", token, { path: "/", httpOnly: true, sameSite: "strict", secure: process.env.MOONANBOT_COOKIE_SECURE === "1", maxAge: 30 * 24 * 60 * 60 });
    return { ok: true };
  });
  server.get("/api/v1/auth/session", async () => ({ authenticated: true }));
  server.post("/api/v1/auth/logout", async (request, reply) => {
    auth.logout(request.cookies.moonan_session);
    reply.clearCookie("moonan_session", { path: "/" });
    return { ok: true };
  });
  server.put("/api/v1/auth/password", async (request) => ({ password: await auth.resetPassword((request.body as any)?.password) }));

  server.get("/api/v1/runtime", async () => ({
    runtime: db.getRuntime(), readiness: orchestrator.readiness(), onebot: onebot.status(), stats: db.getStats(),
    databaseBytes: existsSync(db.path) ? statSync(db.path).size : 0,
  }));
  server.post("/api/v1/runtime/start", async () => { await orchestrator.startBot(); return { runtime: db.getRuntime() }; });
  server.post("/api/v1/runtime/pause", async () => { orchestrator.pauseBot(); return { runtime: db.getRuntime() }; });
  server.post("/api/v1/runtime/wake", async () => { await orchestrator.wakeBot(); return { runtime: db.getRuntime() }; });
  server.put("/api/v1/runtime/outbound", async (request) => { orchestrator.setOutbound(Boolean((request.body as any)?.enabled)); return { runtime: db.getRuntime() }; });

  server.get("/api/v1/profile", async () => db.getProfile());
  server.put("/api/v1/profile", async (request, reply) => {
    try {
      const body = request.body as CharacterProfile;
      if (!body.name?.trim()) return reply.code(400).send({ error: "name_required" });
      return db.updateProfile(body, body.version);
    } catch (error) { return reply.code(String(error).includes("conflict") ? 409 : 400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  server.get("/api/v1/memories", async () => db.listMemories());
  server.post("/api/v1/memories", async (request) => {
    const body = request.body as any;
    return db.upsertMemory({ id: body.id || crypto.randomUUID(), occurredAt: Number(body.occurredAt), summary: String(body.summary), details: body.details ?? null });
  });
  server.put("/api/v1/memories/:id", async (request) => {
    const body = request.body as any;
    return db.upsertMemory({ id: (request.params as any).id, occurredAt: Number(body.occurredAt), summary: String(body.summary), details: body.details ?? null });
  });
  server.delete("/api/v1/memories/:id", async (request) => ({ deleted: db.forgetMemory((request.params as any).id) }));

  server.get("/api/v1/contacts", async () => db.listContacts());
  server.put("/api/v1/contacts/:id", async (request) => {
    const body = request.body as any;
    const existing = db.getContact((request.params as any).id);
    const input: Omit<ContactRecord, "createdAt" | "updatedAt"> = {
      platform: "onebot", id: (request.params as any).id, name: String(body.name), aliases: Array.isArray(body.aliases) ? body.aliases.map(String) : [],
      summary: String(body.summary ?? ""), importance: body.importance as Importance, isFriend: Boolean(body.isFriend ?? existing?.isFriend),
    };
    return db.upsertContact(input);
  });
  server.delete("/api/v1/contacts/:id", async (request) => ({ deleted: db.deleteContact((request.params as any).id) }));
  server.get("/api/v1/groups", async () => db.listGroups());
  server.put("/api/v1/groups/:id", async (request) => {
    const body = request.body as any;
    const input: Omit<GroupRecord, "createdAt" | "updatedAt"> = { platform: "onebot", id: (request.params as any).id, name: String(body.name), summary: String(body.summary ?? "") };
    return db.upsertGroup(input);
  });
  server.delete("/api/v1/groups/:id", async (request) => ({ deleted: db.deleteGroup((request.params as any).id) }));

  server.get("/api/v1/settings", async () => db.getSettings());
  server.put("/api/v1/settings", async (request, reply) => {
    try {
      const body = request.body as { value: AppSettings; version: number };
      validateSettings(body.value);
      return db.updateSettings(body.value, body.version);
    } catch (error) { return reply.code(String(error).includes("conflict") ? 409 : 400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  server.get("/api/v1/prompts/:agent", async (request) => {
    const agent = (request.params as any).agent as "simulation" | "synthesis";
    return { current: db.getPrompt(agent), versions: db.listPromptVersions(agent) };
  });
  server.put("/api/v1/prompts/:agent", async (request, reply) => {
    const agent = (request.params as any).agent as "simulation" | "synthesis";
    const template = String((request.body as any)?.template ?? "");
    const required = agent === "simulation" ? ["botName", "soul", "environment", "memory", "relationships", "groups"] : ["botName", "soul", "memory", "relationships", "groups"];
    const missing = validatePromptTemplate(template, required);
    if (missing.length) return reply.code(400).send({ error: "missing_placeholders", missing });
    return db.setPrompt(agent, template);
  });
  server.post("/api/v1/prompts/:agent/reset", async (request) => {
    const agent = (request.params as any).agent as "simulation" | "synthesis";
    return db.setPrompt(agent, agent === "simulation" ? SIMULATION_SYSTEM_PROMPT : SYNTHESIS_SYSTEM_PROMPT);
  });

  server.get("/api/v1/activity/runs", async (request) => {
    const query = request.query as any;
    return db.listAgentRuns(Math.min(Number(query.limit ?? 100), 500), query.agent);
  });
  server.get("/api/v1/activity/runs/:id", async (request) => ({ messages: db.listAgentMessages((request.params as any).id) }));
  server.get("/api/v1/events", async (request) => {
    const since = Number((request.query as any)?.since ?? 0);
    return db.eventsSince(since);
  });
  server.get("/api/v1/stream", async (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    const send = () => reply.raw.write(`data: ${JSON.stringify({ runtime: db.getRuntime(), onebot: onebot.status(), at: Date.now() })}\n\n`);
    send();
    const timer = setInterval(send, 2_000);
    request.raw.on("close", () => clearInterval(timer));
  });

  server.get("/api/v1/providers", async () => providers.list());
  server.put("/api/v1/providers/:id/key", async (request) => {
    const key = String((request.body as any)?.key ?? "").trim();
    if (!key) throw new Error("api_key_required");
    providers.setApiKey((request.params as any).id, key);
    return { ok: true, masked: maskSecret(key) };
  });
  server.delete("/api/v1/providers/:id/credential", async (request) => { await providers.logout((request.params as any).id); return { ok: true }; });
  server.post("/api/v1/providers/:id/refresh", async (request) => providers.refresh((request.params as any).id));
  server.post("/api/v1/providers/:id/login", async (request) => {
    const providerId = (request.params as any).id;
    const type = ((request.body as any)?.type ?? "oauth") as "api_key" | "oauth";
    return { flowId: oauthFlows.create(providerId, (interaction) => providers.login(providerId, type, interaction)) };
  });
  server.get("/api/v1/auth-flows/:id", async (request, reply) => {
    const flow = oauthFlows.get((request.params as any).id);
    return flow ? { id: flow.id, providerId: flow.providerId, state: flow.state, events: flow.events } : reply.code(404).send({ error: "not_found" });
  });
  server.post("/api/v1/auth-flows/:id/answer", async (request) => { oauthFlows.answer((request.params as any).id, String((request.body as any)?.answer ?? "")); return { ok: true }; });
  server.delete("/api/v1/auth-flows/:id", async (request) => { oauthFlows.cancel((request.params as any).id); return { ok: true }; });
  server.get("/api/v1/auth-flows/:id/events", async (request, reply) => {
    const flow = oauthFlows.get((request.params as any).id);
    if (!flow) return reply.code(404).send({ error: "not_found" });
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const event of flow.events) reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    const unsubscribe = oauthFlows.subscribe(flow.id, (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`));
    request.raw.on("close", unsubscribe);
  });
  server.get("/api/v1/custom-providers", async () => db.listCustomProviders().map((item) => ({ ...item, apiKey: maskSecret(item.apiKey) })));
  server.put("/api/v1/custom-providers/:id", async (request) => {
    const body = request.body as any;
    const baseUrl = String(body.baseUrl ?? "");
    try { new URL(baseUrl); } catch { throw new Error("invalid_base_url"); }
    const saved = providers.saveCustom({ id: (request.params as any).id, name: String(body.name), baseUrl, apiKey: body.apiKey ? String(body.apiKey) : null, models: Array.isArray(body.models) ? body.models : [] });
    return { ...saved, apiKey: maskSecret(saved.apiKey) };
  });
  server.delete("/api/v1/custom-providers/:id", async (request) => { providers.deleteCustom((request.params as any).id); return { ok: true }; });

  server.get("/api/v1/export/character", async (_request, reply) => {
    reply.header("Content-Disposition", "attachment; filename=moonanbot-character-v1.json");
    return db.exportCharacter();
  });
  server.post("/api/v1/import/character", async (request, reply) => {
    const body = request.body as any;
    if (body?.schemaVersion !== 1 || !body.profile || !Array.isArray(body.memories) || !Array.isArray(body.contacts) || !Array.isArray(body.groups)) {
      return reply.code(400).send({ error: "invalid_character_bundle" });
    }
    const simulationPrompt = String(body.prompts?.simulation ?? "");
    const synthesisPrompt = String(body.prompts?.synthesis ?? "");
    if (validatePromptTemplate(simulationPrompt, ["botName", "soul", "environment", "memory", "relationships", "groups"]).length
      || validatePromptTemplate(synthesisPrompt, ["botName", "soul", "memory", "relationships", "groups"]).length) {
      return reply.code(400).send({ error: "invalid_prompt_template" });
    }
    try {
      db.transaction(() => {
        const current = db.getProfile();
        db.updateProfile({
          name: String(body.profile.name), timezone: String(body.profile.timezone),
          locale: body.profile.locale === "en" ? "en" : "zh-CN",
          soul: String(body.profile.soul ?? ""), environment: String(body.profile.environment ?? ""),
          version: current.version,
        }, current.version);
        db.sqlite.exec("DELETE FROM memories; DELETE FROM contacts; DELETE FROM chat_groups;");
        for (const memory of body.memories) db.upsertMemory({
          id: String(memory.id || crypto.randomUUID()), occurredAt: Number(memory.occurredAt),
          summary: String(memory.summary), details: memory.details === null || memory.details === undefined ? null : String(memory.details),
        }, "import");
        for (const contact of body.contacts) db.upsertContact({
          platform: "onebot", id: String(contact.id), name: String(contact.name),
          aliases: Array.isArray(contact.aliases) ? contact.aliases.map(String) : [], summary: String(contact.summary ?? ""),
          importance: (["priority_plus", "priority", "normal", "do_not_disturb", "no_push"].includes(contact.importance) ? contact.importance : "normal") as Importance,
          isFriend: Boolean(contact.isFriend),
        }, "import");
        for (const group of body.groups) db.upsertGroup({
          platform: "onebot", id: String(group.id), name: String(group.name), summary: String(group.summary ?? ""),
        }, "import");
        db.setPrompt("simulation", simulationPrompt);
        db.setPrompt("synthesis", synthesisPrompt);
        db.addEvent("system_warning", "角色包已导入；消息、凭据与运行历史未被修改。", {});
      });
      return { ok: true, profile: db.getProfile() };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  server.get("/onebot/v11/ws", { websocket: true }, (socket: WebSocket, request) => {
    const role = String(request.headers["x-client-role"] ?? "universal");
    const authorization = request.headers.authorization;
    const attached = onebot.attach(socket, {
      selfId: String(request.headers["x-self-id"] ?? ""), role,
      ...(authorization ? { authorization } : {}),
    });
    if (!attached.ok) socket.close(attached.code, attached.reason);
  });

  const publicRoot = join(dirname(fileURLToPath(import.meta.url)), "public");
  if (existsSync(publicRoot)) {
    await server.register(fastifyStatic, { root: publicRoot, prefix: "/" });
    server.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && request.headers.accept?.includes("text/html")) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not_found" });
    });
  }

  orchestrator.start();
  return {
    server, db, providers, onebot, orchestrator, bootstrapPassword,
    close: async () => {
      await orchestrator.close();
      await onebot.close();
      await server.close();
      db.close();
    },
  };
}

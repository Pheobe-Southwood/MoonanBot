import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { defaultProfile, defaultRuntime, defaultSettings } from "../domain/defaults.js";
import type {
  AgentRunSummary,
  AgentTraceMessage,
  AppSettings,
  CharacterProfile,
  ContactRecord,
  ConversationTarget,
  GroupRecord,
  Importance,
  MemoryRecord,
  RuntimeState,
  SettingsEnvelope,
  StoredMessage,
  WorldEvent,
  WorldEventType,
} from "../domain/types.js";
import { SIMULATION_SYSTEM_PROMPT, SYNTHESIS_SYSTEM_PROMPT } from "../agents/prompts.js";

type SqlValue = string | number | bigint | Uint8Array | null;

function json<T>(value: string): T {
  return JSON.parse(value) as T;
}

function now(): number {
  return Date.now();
}

export interface CustomProviderRecord {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string | null;
  models: Array<{
    id: string;
    name: string;
    contextWindow: number;
    maxTokens: number;
    reasoning: boolean;
  }>;
  createdAt: number;
  updatedAt: number;
}

export class MoonanDatabase {
  readonly path: string;
  readonly sqlite: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.sqlite = new DatabaseSync(this.path);
    this.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
    try { chmodSync(this.path, 0o600); } catch { /* best effort on non-POSIX tests */ }
  }

  close(): void {
    this.sqlite.close();
  }

  transaction<T>(operation: () => T): T {
    const depth = this.transactionDepth;
    const savepoint = `moonan_nested_${depth}`;
    this.sqlite.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const value = operation();
      this.sqlite.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return value;
    } catch (error) {
      if (depth === 0) this.sqlite.exec("ROLLBACK");
      else this.sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private migrate(): void {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value_json TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS character_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        locale TEXT NOT NULL,
        soul TEXT NOT NULL,
        environment TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runtime_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        occurred_at INTEGER NOT NULL,
        summary TEXT NOT NULL,
        details TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        forgotten_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS contacts (
        platform TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        summary TEXT NOT NULL,
        importance TEXT NOT NULL,
        is_friend INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, id)
      );
      CREATE TABLE IF NOT EXISTS chat_groups (
        platform TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (platform, id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        platform_message_id TEXT,
        platform TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_name TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        direction TEXT NOT NULL,
        content TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL,
        delivery_status TEXT NOT NULL,
        read_at INTEGER,
        UNIQUE(platform, platform_message_id, direction)
      );
      CREATE INDEX IF NOT EXISTS idx_messages_target ON messages(platform, target_kind, target_id, occurred_at DESC);
      CREATE TABLE IF NOT EXISTS event_records (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        text TEXT NOT NULL,
        data_json TEXT NOT NULL,
        synthesis_batch_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_time ON event_records(occurred_at);
      CREATE TABLE IF NOT EXISTS timers (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_timers_due ON timers(state, due_at);
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS agent_messages (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        name TEXT,
        occurred_at INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_messages_run ON agent_messages(run_id, occurred_at);
      CREATE TABLE IF NOT EXISTS agent_state (
        agent TEXT PRIMARY KEY,
        messages_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS synthesis_batches (
        id TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        window_end INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS provider_credentials (
        provider_id TEXT PRIMARY KEY,
        credential_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS custom_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        api_key TEXT,
        models_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prompt_versions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        template TEXT NOT NULL,
        active INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_auth (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS web_sessions (
        token_hash TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_sessions (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        state TEXT NOT NULL,
        events_json TEXT NOT NULL,
        prompt_json TEXT,
        answer TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_revisions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const applied = this.sqlite.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get();
    if (!applied) this.sqlite.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)").run(now());
    this.seed();
  }

  private seed(): void {
    const timestamp = now();
    if (!this.sqlite.prepare("SELECT 1 FROM settings WHERE id=1").get()) {
      this.sqlite.prepare("INSERT INTO settings(id,value_json,version,updated_at) VALUES(1,?,?,?)")
        .run(JSON.stringify(defaultSettings()), 1, timestamp);
    }
    if (!this.sqlite.prepare("SELECT 1 FROM character_profile WHERE id=1").get()) {
      const profile = defaultProfile(timestamp);
      this.sqlite.prepare("INSERT INTO character_profile VALUES(1,?,?,?,?,?,?,?)")
        .run(profile.name, profile.timezone, profile.locale, profile.soul, profile.environment, profile.version, profile.updatedAt);
    }
    if (!this.sqlite.prepare("SELECT 1 FROM runtime_state WHERE id=1").get()) {
      this.sqlite.prepare("INSERT INTO runtime_state(id,value_json,updated_at) VALUES(1,?,?)")
        .run(JSON.stringify(defaultRuntime(timestamp)), timestamp);
    }
    for (const [agent, template] of [["simulation", SIMULATION_SYSTEM_PROMPT], ["synthesis", SYNTHESIS_SYSTEM_PROMPT]] as const) {
      if (!this.sqlite.prepare("SELECT 1 FROM prompt_versions WHERE agent=? AND active=1").get(agent)) {
        this.sqlite.prepare("INSERT INTO prompt_versions(id,agent,template,active,created_at) VALUES(?,?,?,?,?)")
          .run(randomUUID(), agent, template, 1, timestamp);
      }
    }
  }

  getSettings(): SettingsEnvelope {
    const row = this.sqlite.prepare("SELECT value_json,version,updated_at FROM settings WHERE id=1").get() as any;
    return { value: json<AppSettings>(row.value_json), version: Number(row.version), updatedAt: Number(row.updated_at) };
  }

  updateSettings(value: AppSettings, expectedVersion: number): SettingsEnvelope {
    const timestamp = now();
    const result = this.sqlite.prepare("UPDATE settings SET value_json=?,version=version+1,updated_at=? WHERE id=1 AND version=?")
      .run(JSON.stringify(value), timestamp, expectedVersion);
    if (Number(result.changes) !== 1) throw new Error("settings_version_conflict");
    return this.getSettings();
  }

  getProfile(): CharacterProfile {
    const row = this.sqlite.prepare("SELECT * FROM character_profile WHERE id=1").get() as any;
    return {
      name: row.name, timezone: row.timezone, locale: row.locale, soul: row.soul,
      environment: row.environment, version: Number(row.version), updatedAt: Number(row.updated_at),
    };
  }

  updateProfile(input: Omit<CharacterProfile, "updatedAt">, expectedVersion: number): CharacterProfile {
    try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }); } catch { throw new Error("invalid_timezone"); }
    const timestamp = now();
    const result = this.sqlite.prepare(`UPDATE character_profile SET name=?,timezone=?,locale=?,soul=?,environment=?,version=version+1,updated_at=? WHERE id=1 AND version=?`)
      .run(input.name.trim(), input.timezone, input.locale, input.soul, input.environment, timestamp, expectedVersion);
    if (Number(result.changes) !== 1) throw new Error("profile_version_conflict");
    this.addRevision("profile", "singleton", this.getProfile(), "operator");
    return this.getProfile();
  }

  getRuntime(): RuntimeState {
    const row = this.sqlite.prepare("SELECT value_json FROM runtime_state WHERE id=1").get() as any;
    return json<RuntimeState>(row.value_json);
  }

  setRuntime(patch: Partial<RuntimeState>): RuntimeState {
    const value = { ...this.getRuntime(), ...patch, updatedAt: now() } as RuntimeState;
    this.sqlite.prepare("UPDATE runtime_state SET value_json=?,updated_at=? WHERE id=1").run(JSON.stringify(value), value.updatedAt);
    return value;
  }

  listMemories(includeForgotten = false): MemoryRecord[] {
    const where = includeForgotten ? "" : "WHERE forgotten_at IS NULL";
    return (this.sqlite.prepare(`SELECT * FROM memories ${where} ORDER BY occurred_at DESC`).all() as any[]).map((row) => ({
      id: row.id, occurredAt: Number(row.occurred_at), summary: row.summary, details: row.details,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }));
  }

  upsertMemory(input: Pick<MemoryRecord, "id" | "occurredAt" | "summary" | "details">, source = "operator"): MemoryRecord {
    const timestamp = now();
    this.sqlite.prepare(`INSERT INTO memories(id,occurred_at,summary,details,created_at,updated_at,forgotten_at)
      VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET occurred_at=excluded.occurred_at,summary=excluded.summary,details=excluded.details,updated_at=excluded.updated_at,forgotten_at=NULL`)
      .run(input.id, input.occurredAt, input.summary, input.details, timestamp, timestamp);
    const result = this.listMemories().find((item) => item.id === input.id)!;
    this.addRevision("memory", input.id, result, source);
    return result;
  }

  forgetMemory(id: string, source = "operator"): boolean {
    const snapshot = this.listMemories().find((item) => item.id === id);
    if (snapshot) this.addRevision("memory", id, snapshot, source);
    return Number(this.sqlite.prepare("UPDATE memories SET forgotten_at=?,updated_at=? WHERE id=? AND forgotten_at IS NULL").run(now(), now(), id).changes) === 1;
  }

  listContacts(): ContactRecord[] {
    return (this.sqlite.prepare("SELECT * FROM contacts ORDER BY updated_at DESC").all() as any[]).map((row) => ({
      platform: "onebot", id: row.id, name: row.name, aliases: json<string[]>(row.aliases_json), summary: row.summary,
      importance: row.importance as Importance, isFriend: Boolean(row.is_friend), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }));
  }

  getContact(id: string): ContactRecord | undefined {
    return this.listContacts().find((item) => item.id === id);
  }

  upsertContact(input: Omit<ContactRecord, "createdAt" | "updatedAt">, source = "operator", preserveImportance = false): ContactRecord {
    const timestamp = now();
    const existing = this.getContact(input.id);
    const importance = preserveImportance && existing ? existing.importance : input.importance;
    this.sqlite.prepare(`INSERT INTO contacts(platform,id,name,aliases_json,summary,importance,is_friend,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(platform,id) DO UPDATE SET name=excluded.name,aliases_json=excluded.aliases_json,summary=excluded.summary,importance=excluded.importance,is_friend=excluded.is_friend,updated_at=excluded.updated_at`)
      .run("onebot", input.id, input.name, JSON.stringify(input.aliases), input.summary, importance, input.isFriend ? 1 : 0, existing?.createdAt ?? timestamp, timestamp);
    const result = this.getContact(input.id)!;
    this.addRevision("contact", input.id, result, source);
    return result;
  }

  setContactImportance(id: string, importance: Importance): ContactRecord {
    const result = this.sqlite.prepare("UPDATE contacts SET importance=?,updated_at=? WHERE platform='onebot' AND id=?").run(importance, now(), id);
    if (Number(result.changes) !== 1) throw new Error("contact_not_found");
    return this.getContact(id)!;
  }

  deleteContact(id: string): boolean {
    return Number(this.sqlite.prepare("DELETE FROM contacts WHERE platform='onebot' AND id=?").run(id).changes) === 1;
  }

  listGroups(): GroupRecord[] {
    return (this.sqlite.prepare("SELECT * FROM chat_groups ORDER BY updated_at DESC").all() as any[]).map((row) => ({
      platform: "onebot", id: row.id, name: row.name, summary: row.summary,
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }));
  }

  upsertGroup(input: Omit<GroupRecord, "createdAt" | "updatedAt">, source = "operator"): GroupRecord {
    const timestamp = now();
    const existing = this.listGroups().find((item) => item.id === input.id);
    this.sqlite.prepare(`INSERT INTO chat_groups(platform,id,name,summary,created_at,updated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(platform,id) DO UPDATE SET name=excluded.name,summary=excluded.summary,updated_at=excluded.updated_at`)
      .run("onebot", input.id, input.name, input.summary, existing?.createdAt ?? timestamp, timestamp);
    const result = this.listGroups().find((item) => item.id === input.id)!;
    this.addRevision("group", input.id, result, source);
    return result;
  }

  deleteGroup(id: string): boolean {
    return Number(this.sqlite.prepare("DELETE FROM chat_groups WHERE platform='onebot' AND id=?").run(id).changes) === 1;
  }

  insertMessage(message: StoredMessage): boolean {
    const result = this.sqlite.prepare(`INSERT OR IGNORE INTO messages(id,platform_message_id,platform,target_kind,target_id,target_name,sender_id,sender_name,direction,content,segments_json,occurred_at,observed_at,delivery_status,read_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      message.id, message.platformMessageId, message.target.platform, message.target.kind, message.target.id, message.target.name ?? null,
      message.senderId, message.senderName, message.direction, message.content, JSON.stringify(message.segments), message.occurredAt,
      message.observedAt, message.deliveryStatus, message.readAt,
    );
    return Number(result.changes) === 1;
  }

  updateMessageDelivery(id: string, status: StoredMessage["deliveryStatus"], platformMessageId?: string): void {
    this.sqlite.prepare("UPDATE messages SET delivery_status=?, platform_message_id=COALESCE(?,platform_message_id) WHERE id=?")
      .run(status, platformMessageId ?? null, id);
  }

  listMessages(target: ConversationTarget, limit: number, before?: number): StoredMessage[] {
    const rows = this.sqlite.prepare(`SELECT * FROM messages WHERE platform=? AND target_kind=? AND target_id=? AND occurred_at < ? ORDER BY occurred_at DESC LIMIT ?`)
      .all(target.platform, target.kind, target.id, before ?? Number.MAX_SAFE_INTEGER, limit) as any[];
    return rows.reverse().map((row) => this.mapMessage(row));
  }

  markTargetRead(target: ConversationTarget): void {
    this.sqlite.prepare("UPDATE messages SET read_at=? WHERE platform=? AND target_kind=? AND target_id=? AND direction='incoming' AND read_at IS NULL")
      .run(now(), target.platform, target.kind, target.id);
  }

  unreadSummary(includeNoPush = false): Array<{ target: ConversationTarget; count: number }> {
    const rows = this.sqlite.prepare(`SELECT m.platform,m.target_kind,m.target_id,MAX(m.target_name) AS target_name,COUNT(*) AS count
      FROM messages m LEFT JOIN contacts c ON m.target_kind='private' AND c.platform=m.platform AND c.id=m.target_id
      WHERE m.direction='incoming' AND m.read_at IS NULL AND (?=1 OR COALESCE(c.importance,'normal') != 'no_push')
      GROUP BY m.platform,m.target_kind,m.target_id ORDER BY MAX(m.occurred_at) DESC`).all(includeNoPush ? 1 : 0) as any[];
    return rows.map((row) => ({ target: { platform: "onebot", kind: row.target_kind, id: row.target_id, name: row.target_name ?? undefined }, count: Number(row.count) }));
  }

  private mapMessage(row: any): StoredMessage {
    return {
      id: row.id, platformMessageId: row.platform_message_id,
      target: { platform: "onebot", kind: row.target_kind, id: row.target_id, ...(row.target_name ? { name: row.target_name } : {}) },
      senderId: row.sender_id, senderName: row.sender_name, direction: row.direction, content: row.content,
      segments: json<unknown[]>(row.segments_json), occurredAt: Number(row.occurred_at), observedAt: Number(row.observed_at),
      deliveryStatus: row.delivery_status, readAt: row.read_at === null ? null : Number(row.read_at),
    };
  }

  addEvent(type: WorldEventType, text: string, data: Record<string, unknown> = {}, occurredAt = now()): WorldEvent {
    const event: WorldEvent = { id: randomUUID(), type, text, data, occurredAt };
    this.sqlite.prepare("INSERT INTO event_records(id,type,occurred_at,text,data_json) VALUES(?,?,?,?,?)")
      .run(event.id, event.type, event.occurredAt, event.text, JSON.stringify(event.data));
    return event;
  }

  eventsSince(since: number, until = Number.MAX_SAFE_INTEGER): WorldEvent[] {
    return (this.sqlite.prepare("SELECT * FROM event_records WHERE occurred_at>=? AND occurred_at<=? ORDER BY occurred_at").all(since, until) as any[])
      .map((row) => ({ id: row.id, type: row.type, occurredAt: Number(row.occurred_at), text: row.text, data: json(row.data_json) }));
  }

  createTimer(kind: "idle" | "alarm", dueAt: number, payload: Record<string, unknown> = {}): string {
    const id = randomUUID();
    this.sqlite.prepare("INSERT INTO timers(id,kind,due_at,payload_json,state,created_at) VALUES(?,?,?,?,?,?)")
      .run(id, kind, dueAt, JSON.stringify(payload), "pending", now());
    return id;
  }

  claimDueTimers(timestamp = now()): Array<{ id: string; kind: "idle" | "alarm"; dueAt: number; payload: Record<string, unknown> }> {
    return this.transaction(() => {
      const rows = this.sqlite.prepare("SELECT * FROM timers WHERE state='pending' AND due_at<=? ORDER BY due_at").all(timestamp) as any[];
      const update = this.sqlite.prepare("UPDATE timers SET state='fired' WHERE id=? AND state='pending'");
      const claimed = rows.filter((row) => Number(update.run(row.id).changes) === 1);
      return claimed.map((row) => ({ id: row.id, kind: row.kind, dueAt: Number(row.due_at), payload: json(row.payload_json) }));
    });
  }

  cancelPendingTimers(): void {
    this.sqlite.prepare("UPDATE timers SET state='cancelled' WHERE state='pending'").run();
  }

  beginAgentRun(agent: "simulation" | "synthesis", trigger: string): string {
    const id = randomUUID();
    this.sqlite.prepare("INSERT INTO agent_runs(id,agent,status,trigger,started_at) VALUES(?,?,?,?,?)")
      .run(id, agent, "running", trigger, now());
    return id;
  }

  endAgentRun(id: string, status: AgentRunSummary["status"], usage = { input: 0, output: 0 }, error?: string): void {
    this.sqlite.prepare("UPDATE agent_runs SET status=?,ended_at=?,input_tokens=?,output_tokens=?,error=? WHERE id=?")
      .run(status, now(), usage.input, usage.output, error ?? null, id);
  }

  addAgentMessage(runId: string, role: AgentTraceMessage["role"], content: string, name?: string, metadata: Record<string, unknown> = {}): string {
    const id = randomUUID();
    this.sqlite.prepare("INSERT INTO agent_messages(id,run_id,role,content,name,occurred_at,metadata_json) VALUES(?,?,?,?,?,?,?)")
      .run(id, runId, role, content, name ?? null, now(), JSON.stringify(metadata));
    return id;
  }

  listAgentRuns(limit = 100, agent?: "simulation" | "synthesis"): AgentRunSummary[] {
    const rows = agent
      ? this.sqlite.prepare("SELECT * FROM agent_runs WHERE agent=? ORDER BY started_at DESC LIMIT ?").all(agent, limit)
      : this.sqlite.prepare("SELECT * FROM agent_runs ORDER BY started_at DESC LIMIT ?").all(limit);
    return (rows as any[]).map((row) => ({
      id: row.id, agent: row.agent, status: row.status, trigger: row.trigger, startedAt: Number(row.started_at),
      endedAt: row.ended_at === null ? null : Number(row.ended_at), inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens), error: row.error,
    }));
  }

  listAgentMessages(runId: string): AgentTraceMessage[] {
    return (this.sqlite.prepare("SELECT * FROM agent_messages WHERE run_id=? ORDER BY occurred_at").all(runId) as any[]).map((row) => ({
      id: row.id, runId: row.run_id, role: row.role, content: row.content, name: row.name,
      occurredAt: Number(row.occurred_at), metadata: json(row.metadata_json),
    }));
  }

  getAgentState<T = unknown>(agent: "simulation" | "synthesis"): T[] {
    const row = this.sqlite.prepare("SELECT messages_json FROM agent_state WHERE agent=?").get(agent) as any;
    return row ? json<T[]>(row.messages_json) : [];
  }

  setAgentState(agent: "simulation" | "synthesis", messages: unknown[]): void {
    this.sqlite.prepare(`INSERT INTO agent_state(agent,messages_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(agent) DO UPDATE SET messages_json=excluded.messages_json,updated_at=excluded.updated_at`)
      .run(agent, JSON.stringify(messages), now());
  }

  getPrompt(agent: "simulation" | "synthesis"): { id: string; template: string; createdAt: number } {
    const row = this.sqlite.prepare("SELECT id,template,created_at FROM prompt_versions WHERE agent=? AND active=1 ORDER BY created_at DESC LIMIT 1").get(agent) as any;
    return { id: row.id, template: row.template, createdAt: Number(row.created_at) };
  }

  setPrompt(agent: "simulation" | "synthesis", template: string): ReturnType<MoonanDatabase["getPrompt"]> {
    return this.transaction(() => {
      this.sqlite.prepare("UPDATE prompt_versions SET active=0 WHERE agent=?").run(agent);
      this.sqlite.prepare("INSERT INTO prompt_versions(id,agent,template,active,created_at) VALUES(?,?,?,?,?)")
        .run(randomUUID(), agent, template, 1, now());
      return this.getPrompt(agent);
    });
  }

  listPromptVersions(agent: "simulation" | "synthesis"): Array<{ id: string; template: string; active: boolean; createdAt: number }> {
    return (this.sqlite.prepare("SELECT * FROM prompt_versions WHERE agent=? ORDER BY created_at DESC").all(agent) as any[])
      .map((row) => ({ id: row.id, template: row.template, active: Boolean(row.active), createdAt: Number(row.created_at) }));
  }

  setCredential(providerId: string, credential: unknown): void {
    this.sqlite.prepare(`INSERT INTO provider_credentials(provider_id,credential_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(provider_id) DO UPDATE SET credential_json=excluded.credential_json,updated_at=excluded.updated_at`)
      .run(providerId, JSON.stringify(credential), now());
  }

  getCredential<T = unknown>(providerId: string): T | undefined {
    const row = this.sqlite.prepare("SELECT credential_json FROM provider_credentials WHERE provider_id=?").get(providerId) as any;
    return row ? json<T>(row.credential_json) : undefined;
  }

  listCredentialInfo(): Array<{ providerId: string; type: string; updatedAt: number }> {
    return (this.sqlite.prepare("SELECT provider_id,credential_json,updated_at FROM provider_credentials ORDER BY provider_id").all() as any[])
      .map((row) => ({ providerId: row.provider_id, type: json<any>(row.credential_json).type ?? "unknown", updatedAt: Number(row.updated_at) }));
  }

  deleteCredential(providerId: string): void {
    this.sqlite.prepare("DELETE FROM provider_credentials WHERE provider_id=?").run(providerId);
  }

  listCustomProviders(): CustomProviderRecord[] {
    return (this.sqlite.prepare("SELECT * FROM custom_providers ORDER BY name").all() as any[]).map((row) => ({
      id: row.id, name: row.name, baseUrl: row.base_url, apiKey: row.api_key, models: json(row.models_json),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    }));
  }

  upsertCustomProvider(input: Omit<CustomProviderRecord, "createdAt" | "updatedAt">): CustomProviderRecord {
    if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(input.id)) throw new Error("invalid_provider_id");
    const timestamp = now();
    const existing = this.listCustomProviders().find((item) => item.id === input.id);
    this.sqlite.prepare(`INSERT INTO custom_providers(id,name,base_url,api_key,models_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,base_url=excluded.base_url,api_key=excluded.api_key,models_json=excluded.models_json,updated_at=excluded.updated_at`)
      .run(input.id, input.name, input.baseUrl.replace(/\/$/, ""), input.apiKey, JSON.stringify(input.models), existing?.createdAt ?? timestamp, timestamp);
    return this.listCustomProviders().find((item) => item.id === input.id)!;
  }

  deleteCustomProvider(id: string): void {
    this.sqlite.prepare("DELETE FROM custom_providers WHERE id=?").run(id);
  }

  createSynthesisBatch(windowStart: number, windowEnd: number): string {
    const id = randomUUID();
    this.sqlite.prepare("INSERT INTO synthesis_batches(id,window_start,window_end,status,created_at) VALUES(?,?,?,?,?)")
      .run(id, windowStart, windowEnd, "pending", now());
    return id;
  }

  updateSynthesisBatch(id: string, status: string, attempts: number, summary?: string, error?: string): void {
    this.sqlite.prepare("UPDATE synthesis_batches SET status=?,attempts=?,summary=?,error=?,completed_at=? WHERE id=?")
      .run(status, attempts, summary ?? null, error ?? null, status === "completed" ? now() : null, id);
  }

  lastSynthesisEnd(): number {
    const row = this.sqlite.prepare("SELECT MAX(window_end) AS value FROM synthesis_batches WHERE status='completed'").get() as any;
    return row?.value ? Number(row.value) : 0;
  }

  getAdminAuth(): { hash: string; salt: string } | undefined {
    const row = this.sqlite.prepare("SELECT password_hash,password_salt FROM admin_auth WHERE id=1").get() as any;
    return row ? { hash: row.password_hash, salt: row.password_salt } : undefined;
  }

  setAdminAuth(hash: string, salt: string): void {
    this.sqlite.prepare(`INSERT INTO admin_auth(id,password_hash,password_salt,updated_at) VALUES(1,?,?,?)
      ON CONFLICT(id) DO UPDATE SET password_hash=excluded.password_hash,password_salt=excluded.password_salt,updated_at=excluded.updated_at`)
      .run(hash, salt, now());
  }

  createWebSession(tokenHash: string, expiresAt: number): void {
    this.sqlite.prepare("DELETE FROM web_sessions WHERE expires_at<?").run(now());
    this.sqlite.prepare("INSERT INTO web_sessions(token_hash,created_at,expires_at) VALUES(?,?,?)").run(tokenHash, now(), expiresAt);
  }

  hasWebSession(tokenHash: string): boolean {
    return Boolean(this.sqlite.prepare("SELECT 1 FROM web_sessions WHERE token_hash=? AND expires_at>?").get(tokenHash, now()));
  }

  deleteWebSession(tokenHash: string): void {
    this.sqlite.prepare("DELETE FROM web_sessions WHERE token_hash=?").run(tokenHash);
  }

  getStats(): Record<string, number> {
    const names = ["memories", "contacts", "chat_groups", "messages", "event_records", "agent_runs", "agent_messages"];
    return Object.fromEntries(names.map((name) => {
      const row = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${name}`).get() as any;
      return [name, Number(row.count)];
    }));
  }

  exportCharacter(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      profile: this.getProfile(),
      memories: this.listMemories(),
      contacts: this.listContacts(),
      groups: this.listGroups(),
      prompts: { simulation: this.getPrompt("simulation").template, synthesis: this.getPrompt("synthesis").template },
    };
  }

  private addRevision(kind: string, entityId: string, snapshot: unknown, source: string): void {
    this.sqlite.prepare("INSERT INTO document_revisions(id,kind,entity_id,snapshot_json,source,created_at) VALUES(?,?,?,?,?,?)")
      .run(randomUUID(), kind, entityId, JSON.stringify(snapshot), source, now());
  }
}

export function bindParams(values: SqlValue[]): SqlValue[] {
  return values;
}

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  type AuthContext,
  type AuthInteraction,
  type Credential,
  type CredentialInfo,
  type CredentialStore,
  type Model,
  type Models,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { MoonanDatabase, type CustomProviderRecord } from "../storage/database.js";

class SqliteCredentialStore implements CredentialStore {
  constructor(private readonly db: MoonanDatabase) {}

  async read(providerId: string): Promise<Credential | undefined> {
    return this.db.getCredential<Credential>(providerId);
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return this.db.listCredentialInfo().map(({ providerId, type }) => ({ providerId, type: type as Credential["type"] }));
  }

  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    const current = this.db.getCredential<Credential>(providerId);
    const next = await fn(current);
    if (next !== undefined) this.db.setCredential(providerId, next);
    return next ?? current;
  }

  async delete(providerId: string): Promise<void> {
    this.db.deleteCredential(providerId);
  }
}

const authContext: AuthContext = {
  env: async (name) => process.env[name],
  fileExists: async (path) => {
    const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
    try { await access(expanded); return true; } catch { return false; }
  },
};

/** OpenAI-compatible `GET {baseUrl}/models` id listing, shared by the DeepSeek overlay and custom endpoints. */
async function listRemoteModelIds(baseUrl: string, key: string | undefined, signal: AbortSignal): Promise<string[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
    ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    signal,
  });
  if (!response.ok) throw new Error(`model refresh failed: HTTP ${response.status}`);
  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return (payload.data ?? []).flatMap((entry) => entry.id ? [entry.id] : []);
}

/** Bound on one custom-provider sync so a single black-hole endpoint cannot stall the boot sync or hang the HTTP request. */
const REFRESH_TIMEOUT_MS = 15_000;

/** Readable refresh failure: bare "fetch failed" tells the operator nothing, so surface the underlying cause (ECONNREFUSED, timeout, …). */
function refreshErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const inner = (cause as { cause?: { message?: unknown } } | null)?.cause;
  const detail = typeof inner?.message === "string" ? inner.message : undefined;
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

/** DeepSeek with a live model overlay: remote ids join the static catalog so freshly released models are selectable. */
function liveDeepSeekProvider(base: Provider): Provider {
  const baseUrl = base.baseUrl ?? "https://api.deepseek.com";
  return createProvider({
    id: base.id,
    name: base.name,
    baseUrl,
    auth: base.auth,
    models: base.getModels(),
    api: openAICompletionsApi(),
    fetchModels: async (context) => {
      if (!context.allowNetwork) return [];
      const credential = context.credential;
      const key = credential?.type === "api_key" ? credential.key : await authContext.env("DEEPSEEK_API_KEY");
      if (!key) return [];
      const ids = await listRemoteModelIds(baseUrl, key, context.signal);
      // An empty remote answer is a glitch, not a catalog wipe: keep the previous overlay.
      if (!ids.length) throw new Error("model refresh returned an empty list");
      const known = new Map(base.getModels().map((model) => [model.id, model]));
      return ids.map((id): Model<any> => known.get(id) ?? {
        id,
        name: id,
        api: "openai-completions",
        provider: base.id,
        baseUrl,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
      });
    },
  });
}

function customProvider(record: CustomProviderRecord): Provider {
  const models: Model<"openai-completions">[] = record.models.map((model) => ({
    id: model.id,
    name: model.name,
    api: "openai-completions",
    provider: record.id,
    baseUrl: record.baseUrl,
    reasoning: model.reasoning,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
  // No pi-ai fetchModels on purpose: custom providers refresh through ProviderRegistry.refreshCustom,
  // which persists the result; a memory-only overlay here would fork from the stored list (ADR-0010).
  return createProvider({
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${record.name} API key`, []) },
    models,
    api: openAICompletionsApi(),
  });
}

export interface ProviderView {
  id: string;
  name: string;
  baseUrl: string | null;
  auth: { apiKey: string | null; oauth: string | null; configured: boolean };
  models: Array<{ id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: ("text" | "image")[]; source: "catalog" | "remote" }>;
  custom: boolean;
  /** Custom providers only: when the remote list was last fetched, and why a refresh kept the stored list. */
  lastRefreshAt: number | null;
  lastRefreshError: string | null;
}

/** Stored custom-provider models as the API presents them; capability fields are the fabricated defaults. */
function viewModels(models: CustomProviderRecord["models"]): ProviderView["models"] {
  return models.map((model) => ({
    id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    reasoning: model.reasoning, input: ["text"] as ("text" | "image")[], source: "remote" as const,
  }));
}

export class ProviderRegistry {
  private modelsValue: MutableModels;
  private readonly credentials: SqliteCredentialStore;

  constructor(private readonly db: MoonanDatabase) {
    this.credentials = new SqliteCredentialStore(db);
    this.modelsValue = createModels({ credentials: this.credentials, authContext });
    this.rebuild();
  }

  get models(): Models {
    return this.modelsValue;
  }

  /** Whether a provider id was registered from the operator's custom-provider records (fabricated capability metadata). */
  isCustomProvider(providerId: string): boolean {
    return this.db.listCustomProviders().some((item) => item.id === providerId);
  }

  rebuild(): void {
    const models = createModels({ credentials: this.credentials, authContext });
    for (const provider of builtinProviders()) {
      models.setProvider(provider.id === "deepseek" ? liveDeepSeekProvider(provider) : provider);
    }
    for (const record of this.db.listCustomProviders()) {
      models.setProvider(customProvider(record));
      if (record.apiKey) this.db.setCredential(record.id, { type: "api_key", key: record.apiKey });
    }
    this.modelsValue = models;
  }

  async list(): Promise<ProviderView[]> {
    const custom = new Map(this.db.listCustomProviders().map((item) => [item.id, item]));
    const result: ProviderView[] = [];
    for (const provider of this.modelsValue.getProviders()) {
      const auth = await this.modelsValue.checkAuth(provider.id).catch(() => undefined);
      const record = custom.get(provider.id);
      result.push({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl ?? null,
        auth: {
          apiKey: provider.auth.apiKey?.name ?? null,
          oauth: provider.auth.oauth?.name ?? null,
          configured: Boolean(auth),
        },
        models: provider.getModels().map((model) => ({
          id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
          reasoning: model.reasoning, input: model.input ?? ["text"], source: "catalog" as const,
        })),
        custom: Boolean(record),
        lastRefreshAt: record?.lastRefreshAt ?? null,
        lastRefreshError: record?.lastRefreshError ?? null,
      });
    }
    return result;
  }

  async refresh(providerId: string, signal?: AbortSignal): Promise<{ error?: string; models: ProviderView["models"] }> {
    if (this.isCustomProvider(providerId)) return this.refreshCustom(providerId, signal);
    const refresh = await this.modelsValue.refresh({ providers: [providerId], allowNetwork: true, force: true, ...(signal ? { signal } : {}) });
    const error = refresh.errors.get(providerId)?.message;
    const models = this.modelsValue.getModels(providerId).map((model) => ({
      id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      reasoning: model.reasoning, input: model.input ?? ["text"] as ("text" | "image")[], source: "remote" as const,
    }));
    return { ...(error ? { error } : {}), models };
  }

  /**
   * Custom providers refresh outside pi-ai: the registry fetches and persists the list itself, so the
   * last-known-good model set survives restarts and rebuilds, and keyless endpoints are not locked out
   * by pi-ai's credential gate. An empty or failed remote answer never clears the stored list (ADR-0010).
   */
  private async refreshCustom(providerId: string, signal?: AbortSignal): Promise<{ error?: string; models: ProviderView["models"] }> {
    const found = this.db.listCustomProviders().find((item) => item.id === providerId);
    if (!found) throw new Error("provider_not_found");
    const stored = this.db.getCredential<{ type: string; key?: string }>(providerId);
    const key = stored?.type === "api_key" && stored.key ? stored.key : found.apiKey ?? undefined;
    // Bound the wait so one black-hole endpoint cannot starve the boot-time sync or hang the HTTP request.
    const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    let record = found;
    let error: string | undefined;
    try {
      const ids = await listRemoteModelIds(found.baseUrl, key, signal ? AbortSignal.any([signal, timeout]) : timeout);
      if (!ids.length) throw new Error("model refresh returned an empty list; keeping the stored models");
      record = this.db.setCustomProviderRefreshState(providerId, {
        models: ids.map((id) => found.models.find((model) => model.id === id) ?? { id, name: id, contextWindow: 128_000, maxTokens: 8_192, reasoning: false }),
        lastRefreshAt: Date.now(),
        lastRefreshError: null,
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      error = refreshErrorMessage(cause);
      record = this.db.setCustomProviderRefreshState(providerId, { lastRefreshAt: Date.now(), lastRefreshError: error });
    }
    // Re-register only this provider; a full rebuild would drop every other provider's live overlay.
    this.modelsValue.setProvider(customProvider(record));
    return { ...(error ? { error } : {}), models: viewModels(record.models) };
  }

  /** Boot-time sync: refresh every custom provider; one failure stays isolated in that provider's refresh state. */
  async refreshCustomProviders(): Promise<void> {
    for (const record of this.db.listCustomProviders()) {
      await this.refreshCustom(record.id).catch(() => undefined);
    }
  }

  setApiKey(providerId: string, key: string): void {
    if (!this.modelsValue.getProvider(providerId)) throw new Error("provider_not_found");
    this.db.setCredential(providerId, { type: "api_key", key });
  }

  async login(providerId: string, type: "api_key" | "oauth", interaction: AuthInteraction): Promise<void> {
    await this.modelsValue.login(providerId, type, interaction);
  }

  async logout(providerId: string): Promise<void> {
    await this.modelsValue.logout(providerId);
  }

  saveCustom(input: Omit<CustomProviderRecord, "createdAt" | "updatedAt" | "lastRefreshAt" | "lastRefreshError">): CustomProviderRecord {
    if (builtinProviders().some((item: Provider) => item.id === input.id)) throw new Error("provider_id_reserved");
    const result = this.db.upsertCustomProvider(input);
    this.rebuild();
    return result;
  }

  deleteCustom(id: string): void {
    this.db.deleteCustomProvider(id);
    this.db.deleteCredential(id);
    this.rebuild();
  }
}

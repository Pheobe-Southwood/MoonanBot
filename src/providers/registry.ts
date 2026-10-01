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
  return createProvider({
    id: record.id,
    name: record.name,
    baseUrl: record.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${record.name} API key`, []) },
    models,
    fetchModels: async (context) => {
      const credential = context.credential;
      const key = credential?.type === "api_key" ? credential.key : undefined;
      const ids = await listRemoteModelIds(record.baseUrl, key, context.signal);
      return ids.map((id): Model<"openai-completions"> => {
        const configured = models.find((model) => model.id === id);
        return configured ?? {
          id, name: id, api: "openai-completions", provider: record.id,
          baseUrl: record.baseUrl, reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8_192,
        };
      });
    },
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
    const result: ProviderView[] = [];
    for (const provider of this.modelsValue.getProviders()) {
      const auth = await this.modelsValue.checkAuth(provider.id).catch(() => undefined);
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
        custom: this.db.listCustomProviders().some((item) => item.id === provider.id),
      });
    }
    return result;
  }

  async refresh(providerId: string, signal?: AbortSignal): Promise<{ error?: string; models: ProviderView["models"] }> {
    const refresh = await this.modelsValue.refresh({ providers: [providerId], allowNetwork: true, force: true, ...(signal ? { signal } : {}) });
    const error = refresh.errors.get(providerId)?.message;
    const models = this.modelsValue.getModels(providerId).map((model) => ({
      id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      reasoning: model.reasoning, input: model.input ?? ["text"] as ("text" | "image")[], source: "remote" as const,
    }));
    return { ...(error ? { error } : {}), models };
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

  saveCustom(input: Omit<CustomProviderRecord, "createdAt" | "updatedAt">): CustomProviderRecord {
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

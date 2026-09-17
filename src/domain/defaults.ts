import { randomBytes } from "node:crypto";
import type { AppSettings, CharacterProfile, RuntimeState } from "./types.js";

export function randomSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function defaultSettings(accessToken = randomSecret()): AppSettings {
  const emptyAgent = { providerId: null, modelId: null, thinkingLevel: "medium" as const };
  return {
    web: { host: "127.0.0.1", port: 21314, locale: "auto" },
    onebot: {
      accessToken,
      apiTimeoutMs: 30_000,
      privateAllowlist: [],
      groupAllowlist: [],
      acceptReverse: true,
      outbound: [],
    },
    simulation: {
      idleMinMinutes: 30,
      idleMaxMinutes: 8 * 60,
      sleepMinMinutes: 30,
      sleepMaxMinutes: 16 * 60,
      notificationWindowMs: 5_000,
      priorityWakeProbability: 0.5,
      chatPreviewMessages: 20,
      historyMaxMessages: 200,
      messageIntervalMs: 1_000,
      maxMessageCharacters: 2_000,
      maxSendPayloadBytes: 256 * 1024,
      missingActionRetries: 2,
      contextArchiveTokens: 272_000,
      contextModelRatio: 0.8,
      retainedContextMessages: 20,
    },
    synthesis: {
      memorySoftTokens: 4_000,
      memoryHardTokens: 16_000,
      retryCount: 5,
      retryBaseDelayMs: 1_000,
    },
    agents: {
      default: { ...emptyAgent },
      simulation: { ...emptyAgent },
      synthesis: { ...emptyAgent },
    },
  };
}

export function defaultProfile(now = Date.now()): CharacterProfile {
  return {
    name: "Moonan",
    timezone: "Etc/UTC",
    locale: "zh-CN",
    soul: "",
    environment: "",
    version: 1,
    updatedAt: now,
  };
}

export function defaultRuntime(now = Date.now()): RuntimeState {
  return {
    mode: "paused",
    health: "healthy",
    phone: { kind: "closed" },
    outboundEnabled: true,
    activeSelfId: null,
    nextWakeAt: null,
    lastError: null,
    updatedAt: now,
  };
}

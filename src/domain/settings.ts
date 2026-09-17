import { defaultSettings } from "./defaults.js";
import type { AppSettings, OneBotOutboundClient, OneBotRole } from "./types.js";

export const OUTBOUND_ROLES: readonly OneBotRole[] = ["event", "api", "universal"];
export const OUTBOUND_RECONNECT_MIN_MS = 1_000;
export const OUTBOUND_RECONNECT_MAX_MS = 600_000;
const OUTBOUND_ROLE_FALLBACK: OneBotRole = "universal";

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function inRange(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : fallback;
}

function roleOr(value: unknown, fallback: OneBotRole): OneBotRole {
  const role = String(value ?? "").trim().toLowerCase();
  return (OUTBOUND_ROLES as readonly string[]).includes(role) ? role as OneBotRole : fallback;
}

/** Rejects the settings payload with a stable error code instead of silently coercing it. */
export function assertValidSettings(settings: AppSettings): void {
  if (!Number.isInteger(settings.web.port) || settings.web.port < 1 || settings.web.port > 65_535) throw new Error("invalid_port");
  if (settings.simulation.idleMinMinutes < 1 || settings.simulation.idleMaxMinutes < settings.simulation.idleMinMinutes) throw new Error("invalid_idle_bounds");
  if (settings.simulation.sleepMinMinutes < 1 || settings.simulation.sleepMaxMinutes < settings.simulation.sleepMinMinutes) throw new Error("invalid_sleep_bounds");
  if (settings.simulation.priorityWakeProbability < 0 || settings.simulation.priorityWakeProbability > 1) throw new Error("invalid_wake_probability");
  if (settings.simulation.contextModelRatio <= 0 || settings.simulation.contextModelRatio > 1) throw new Error("invalid_context_ratio");
  if (settings.synthesis.memorySoftTokens < 1 || settings.synthesis.memoryHardTokens < settings.synthesis.memorySoftTokens) throw new Error("invalid_memory_limits");
  if (settings.synthesis.retryCount < 0 || settings.synthesis.retryCount > 10) throw new Error("invalid_retry_count");
  assertOutbound(settings.onebot.outbound);
}

/** Validates the outbound OneBot client list: names must be unique, URLs must be WebSocket endpoints. */
export function assertOutbound(outbound: OneBotOutboundClient[]): void {
  if (!Array.isArray(outbound)) throw new Error("invalid_onebot_outbound");
  const names = new Set<string>();
  outbound.forEach((entry, index) => {
    const position = index + 1;
    const name = stringOr(entry?.name, "").trim();
    if (!name) throw new Error(`invalid_onebot_outbound_name_${position}`);
    if (names.has(name)) throw new Error(`duplicate_onebot_outbound_name_${position}`);
    names.add(name);
    const url = stringOr(entry?.url, "").trim();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`invalid_onebot_outbound_url_${position}`);
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") throw new Error(`invalid_onebot_outbound_url_${position}`);
    if (!OUTBOUND_ROLES.includes(entry?.role)) throw new Error(`invalid_onebot_outbound_role_${position}`);
    if (!Number.isFinite(entry?.reconnectIntervalMs) || entry.reconnectIntervalMs < OUTBOUND_RECONNECT_MIN_MS || entry.reconnectIntervalMs > OUTBOUND_RECONNECT_MAX_MS) {
      throw new Error(`invalid_onebot_outbound_reconnect_${position}`);
    }
  });
}

function normalizeOutboundEntry(value: unknown): OneBotOutboundClient | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  const name = stringOr(entry.name, "").trim();
  const url = stringOr(entry.url, "").trim();
  if (!name || !url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return null;
  } catch {
    return null;
  }
  return {
    name,
    url,
    accessToken: stringOr(entry.accessToken, ""),
    selfId: stringOr(entry.selfId, "").trim(),
    role: roleOr(entry.role, OUTBOUND_ROLE_FALLBACK),
    reconnectIntervalMs: Math.trunc(inRange(entry.reconnectIntervalMs, OUTBOUND_RECONNECT_MIN_MS, OUTBOUND_RECONNECT_MAX_MS, 5_000)),
    enabled: entry.enabled === undefined ? true : Boolean(entry.enabled),
  };
}

/** Fills missing fields so rows written by older releases stay readable, without a schema migration. */
export function normalizeSettings(value: unknown): AppSettings {
  const base = defaultSettings();
  if (!value || typeof value !== "object") return base;
  const input = value as Partial<AppSettings>;
  const onebot = (input.onebot ?? {}) as Partial<AppSettings["onebot"]>;
  const seen = new Set<string>();
  const outbound = (Array.isArray(onebot.outbound) ? onebot.outbound : [])
    .map(normalizeOutboundEntry)
    .filter((entry): entry is OneBotOutboundClient => {
      if (!entry || seen.has(entry.name)) return false;
      seen.add(entry.name);
      return true;
    });
  return {
    ...base,
    ...input,
    web: { ...base.web, ...(input.web ?? {}) },
    onebot: {
      accessToken: stringOr(onebot.accessToken, base.onebot.accessToken),
      apiTimeoutMs: inRange(onebot.apiTimeoutMs, 1_000, 600_000, base.onebot.apiTimeoutMs),
      privateAllowlist: stringList(onebot.privateAllowlist),
      groupAllowlist: stringList(onebot.groupAllowlist),
      acceptReverse: onebot.acceptReverse === undefined ? true : Boolean(onebot.acceptReverse),
      outbound,
    },
    simulation: { ...base.simulation, ...(input.simulation ?? {}) },
    synthesis: { ...base.synthesis, ...(input.synthesis ?? {}) },
    agents: { ...base.agents, ...(input.agents ?? {}) },
  };
}

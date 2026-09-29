import type { ConversationTarget } from "../domain/types.js";

export interface PlatformMessageEvent {
  selfId: string;
  platformMessageId: string;
  target: ConversationTarget;
  senderId: string;
  senderName: string;
  occurredAt: number;
  content: string;
  segments: unknown[];
  raw: Record<string, unknown>;
}

export interface SendResult {
  platformMessageId: string | null;
}

export interface PlatformStatus {
  connected: boolean;
  selfId: string | null;
  roles: string[];
}

export interface RosterSyncSummary {
  groupsAdded: number;
  groupsRemoved: number;
  contactsUpdated: number;
}

/** Platform-provided fallback payload for a media file id, e.g. OneBot's `get_image` response. */
export interface PlatformFilePayload {
  base64?: string | null;
  url?: string | null;
}

export interface ChatPlatformAdapter {
  readonly id: string;
  status(): PlatformStatus;
  sendText(target: ConversationTarget, text: string, signal?: AbortSignal): Promise<SendResult>;
  syncRoster(): Promise<RosterSyncSummary>;
  /** Resolves a media file id to a fresh download payload when the platform exposes such an API. */
  fetchFile?(fileId: string, signal?: AbortSignal): Promise<PlatformFilePayload | null>;
  fetchHistory?(target: ConversationTarget, count: number): Promise<never>;
  close(): Promise<void>;
}

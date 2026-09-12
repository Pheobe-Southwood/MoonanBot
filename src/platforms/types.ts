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

export interface ChatPlatformAdapter {
  readonly id: string;
  status(): PlatformStatus;
  sendText(target: ConversationTarget, text: string, signal?: AbortSignal): Promise<SendResult>;
  syncRoster(): Promise<void>;
  fetchHistory?(target: ConversationTarget, count: number): Promise<never>;
  close(): Promise<void>;
}

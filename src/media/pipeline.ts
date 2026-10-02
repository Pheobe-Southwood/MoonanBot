import type { ImageContent } from "@earendil-works/pi-ai";
import type { AppSettings, MessageMedia, StoredMessage } from "../domain/types.js";
import type { ChatPlatformAdapter } from "../platforms/types.js";
import type { MoonanDatabase } from "../storage/database.js";

const FETCH_CONCURRENCY = 2;
const PURGE_INTERVAL_MS = 24 * 60 * 60_000;

/** Generates and caches the Vision Agent description for one media row; returns null when unavailable. */
export type MediaDescriber = (media: MessageMedia) => Promise<string | null>;

/**
 * Media Cache: downloads inbound QQ images as soon as they are observed (platform URLs expire),
 * keeps raw bytes for a TTL while descriptions are permanent, and serializes lazy vision calls.
 */
export class MediaPipeline {
  private readonly queue: string[] = [];
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly describeInflight = new Map<string, Promise<string | null>>();
  private active = 0;
  private purgeTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly db: MoonanDatabase,
    private readonly platform: ChatPlatformAdapter,
    private readonly settings: () => AppSettings,
    private readonly describe: MediaDescriber,
  ) {}

  /** Re-enqueues downloads interrupted by a restart, purges once, and schedules the daily purge. */
  start(): void {
    for (const media of this.db.listPendingMedia()) this.enqueue(media.id);
    this.purge();
    if (!this.purgeTimer) {
      this.purgeTimer = setInterval(() => this.purge(), PURGE_INTERVAL_MS);
      this.purgeTimer.unref?.();
    }
  }

  close(): void {
    this.stopped = true;
    if (this.purgeTimer) clearInterval(this.purgeTimer);
    this.purgeTimer = undefined;
    this.queue.length = 0;
  }

  private purge(): void {
    const ttl = this.settings().media.byteTtlDays * 24 * 60 * 60_000;
    this.db.purgeExpiredMedia(Date.now() - ttl);
  }

  /** Creates media rows for every image segment of a newly stored message and queues their downloads. */
  ingest(message: StoredMessage): void {
    if (this.stopped || !this.settings().media.enabled) return;
    const segments = Array.isArray(message.segments) ? message.segments : [];
    segments.forEach((segment, index) => {
      const candidate = segment as { type?: unknown; data?: unknown } | null;
      if (candidate?.type !== "image" || !candidate.data || typeof candidate.data !== "object") return;
      const data = candidate.data as { file?: unknown; url?: unknown };
      const fileId = typeof data.file === "string" && data.file.trim() ? data.file.trim() : `segment-${index}`;
      const url = typeof data.url === "string" && /^https?:\/\//.test(data.url) ? data.url : null;
      this.enqueue(this.db.createMedia({ messageId: message.id, segmentIndex: index, fileId, url }).id);
    });
  }

  private enqueue(mediaId: string): void {
    this.queue.push(mediaId);
    this.pump();
  }

  private pump(): void {
    while (!this.stopped && this.active < FETCH_CONCURRENCY && this.queue.length) {
      const mediaId = this.queue.shift()!;
      if (this.inflight.has(mediaId)) continue;
      this.active += 1;
      const task = this.fetch(mediaId).finally(() => {
        this.active -= 1;
        this.inflight.delete(mediaId);
        this.pump();
      });
      this.inflight.set(mediaId, task);
    }
  }

  /** Segment URL first (fast path), then the platform `get_image`-style fallback; failures degrade to placeholders. */
  private async fetch(mediaId: string): Promise<void> {
    const timeoutMs = this.settings().media.downloadTimeoutMs;
    const media = this.db.getMedia(mediaId);
    if (!media || media.status !== "pending") return;
    let lastError = "no_image_payload";
    try {
      if (media.url) {
        try {
          const downloaded = await this.downloadUrl(media.url, timeoutMs);
          if (downloaded) { this.db.setMediaCached(mediaId, downloaded); return; }
          lastError = "url_payload_not_an_image";
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      if (this.platform.fetchFile) {
        const payload = await this.platform.fetchFile(media.fileId, AbortSignal.timeout(timeoutMs));
        if (payload?.base64) {
          const bytes = decodeBase64(payload.base64);
          const mime = bytes ? sniffImageMime(bytes) : null;
          if (bytes && mime) { this.db.setMediaCached(mediaId, { mime, bytes }); return; }
          lastError = "api_payload_not_an_image";
        }
        if (payload?.url) {
          try {
            const downloaded = await this.downloadUrl(payload.url, timeoutMs);
            if (downloaded) { this.db.setMediaCached(mediaId, downloaded); return; }
            lastError = "api_url_payload_not_an_image";
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      this.db.setMediaFailed(mediaId, lastError);
    } catch (error) {
      this.db.setMediaFailed(mediaId, error instanceof Error ? error.message : String(error));
    }
  }

  private async downloadUrl(url: string, timeoutMs: number): Promise<{ mime: string; bytes: Uint8Array } | null> {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const mime = sniffImageMime(bytes);
    if (!mime) return null;
    return { mime, bytes };
  }

  /** Bounded wait so renders observe fresh bytes: resolves when this batch's downloads settle or the timeout hits. */
  async waitForFetches(messageIds: string[], timeoutMs: number): Promise<void> {
    if (!this.inflight.size || !messageIds.length) return;
    const media = this.db.listMediaForMessages(messageIds);
    const relevant: Promise<void>[] = [];
    for (const list of media.values()) {
      for (const item of list) {
        const task = this.inflight.get(item.id);
        if (task) relevant.push(task);
      }
    }
    if (!relevant.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(relevant),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  /** Lazy description with dedup: cached forever in the database, generated at most once per media row per process. */
  async ensureDescription(mediaId: string): Promise<string | null> {
    const media = this.db.getMedia(mediaId);
    if (!media) return null;
    if (media.description) return media.description;
    if (media.status !== "cached" || !media.bytes) return null;
    const existing = this.describeInflight.get(mediaId);
    if (existing) return existing;
    const task = (async () => {
      try {
        const description = await this.describe(media);
        if (description) this.db.setMediaDescription(mediaId, description);
        return description;
      } catch { return null; }
    })().finally(() => this.describeInflight.delete(mediaId));
    this.describeInflight.set(mediaId, task);
    return task;
  }

  /** The pi-ai image block for a cached row, or null when bytes were purged or never fetched. */
  imageContent(media: MessageMedia): ImageContent | null {
    if (media.status !== "cached" || !media.bytes || !media.mime) return null;
    return { type: "image", data: Buffer.from(media.bytes).toString("base64"), mimeType: media.mime };
  }
}

export function decodeBase64(value: string): Uint8Array | null {
  const buffer = Buffer.from(value.replace(/^data:[^;]*;base64,/, ""), "base64");
  return buffer.length ? new Uint8Array(buffer) : null;
}

/** Magic-byte sniffing for the raster formats QQ actually carries; the payload decides, never the URL. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return null;
}

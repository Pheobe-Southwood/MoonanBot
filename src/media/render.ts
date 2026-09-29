import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { MessageMedia, StoredMessage, WorldEvent } from "../domain/types.js";
import { segmentText } from "../platforms/onebot.js";
import type { MoonanDatabase } from "../storage/database.js";
import type { MediaPipeline } from "./pipeline.js";

export interface RenderedMessages {
  /** Plain-text form: image segments become `[图片：<描述>]` or keep the raw placeholder. */
  text: string;
  /** Real images in render order, for `prompt(text, images)` style injection. */
  images: ImageContent[];
  /** Interleaved text/image blocks for tool-result content. */
  content: Array<TextContent | ImageContent>;
  /** Attachable images dropped by the per-request cap; represented by description or placeholder instead. */
  omitted: number;
}

export interface RenderOptions {
  seesImages: boolean;
  describeLazily: boolean;
}

/** The media-facing surface simulation tools receive, closing over orchestrator wiring. */
export interface MediaView {
  seesImages(): boolean;
  render(messages: StoredMessage[], options?: Partial<RenderOptions>): Promise<RenderedMessages>;
  preview(message: StoredMessage): string;
}

function isImageSegment(segment: unknown): boolean {
  return (segment as { type?: unknown } | null)?.type === "image";
}

function segmentsOf(message: StoredMessage): unknown[] {
  return Array.isArray(message.segments) && message.segments.length
    ? message.segments
    : [{ type: "text", data: { text: message.content } }];
}

function prefixOf(message: StoredMessage): string {
  return `[${new Date(message.occurredAt).toISOString()}] ${message.senderName}(${message.senderId}): `;
}

interface Candidate {
  media: MessageMedia;
  segment: unknown;
}

function candidatesOf(message: StoredMessage, mediaByMessage: Map<string, MessageMedia[]>): Candidate[] {
  const rows = mediaByMessage.get(message.id) ?? [];
  const bySegment = new Map(rows.map((row) => [row.segmentIndex, row]));
  const candidates: Candidate[] = [];
  segmentsOf(message).forEach((segment, index) => {
    if (!isImageSegment(segment)) return;
    const media = bySegment.get(index);
    if (media) candidates.push({ media, segment });
  });
  return candidates;
}

/**
 * Renders observed messages for one consumer. Image-capable consumers get real `ImageContent`
 * blocks inline (newest-first up to the cap, the rest degrade to cached text); image-blind
 * consumers get lazily generated, permanently cached Vision Agent descriptions.
 */
export async function renderObservedMessages(
  db: MoonanDatabase,
  pipeline: MediaPipeline,
  messages: StoredMessage[],
  options: RenderOptions,
): Promise<RenderedMessages> {
  const settings = db.getSettings().value.media;
  if (!messages.length) {
    const placeholder: TextContent = { type: "text", text: "（没有消息）" };
    return { text: "（没有消息）", images: [], content: [placeholder], omitted: 0 };
  }
  await pipeline.waitForFetches(messages.map((message) => message.id), settings.downloadTimeoutMs);
  const mediaByMessage = db.listMediaForMessages(messages.map((message) => message.id));

  const all: Candidate[] = messages.flatMap((message) => candidatesOf(message, mediaByMessage));
  const attachable = options.seesImages
    ? all.filter((candidate) => pipeline.imageContent(candidate.media) !== null)
    : [];
  const selected = new Set(attachable.slice(-Math.max(1, settings.maxInjectedImages)).map((candidate) => candidate.media.id));

  const images: ImageContent[] = [];
  const content: Array<TextContent | ImageContent> = [];
  const lines: string[] = [];
  let omitted = 0;
  let buffer = "";
  const pushText = (): void => {
    if (buffer) {
      content.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  for (const message of messages) {
    buffer += prefixOf(message);
    let line = prefixOf(message);
    const rows = mediaByMessage.get(message.id) ?? [];
    const bySegment = new Map(rows.map((row) => [row.segmentIndex, row]));
    const segments = segmentsOf(message);
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (!isImageSegment(segment)) {
        const text = segmentText(segment);
        buffer += text;
        line += text;
        continue;
      }
      const media = bySegment.get(index);
      if (media && options.seesImages && selected.has(media.id)) {
        const image = pipeline.imageContent(media)!;
        images.push(image);
        pushText();
        content.push(image);
        line += "[图片]";
        continue;
      }
      if (media && options.seesImages && pipeline.imageContent(media) !== null) omitted += 1;
      const description = media?.description
        ?? (media && options.describeLazily ? await pipeline.ensureDescription(media.id) : null);
      const text = description ? `[图片：${description}]` : segmentText(segment);
      buffer += text;
      line += text;
    }
    buffer += "\n";
    lines.push(line);
  }

  pushText();
  const last = content.at(-1);
  if (last?.type === "text") {
    last.text = last.text.replace(/\n$/, "");
    if (!last.text) content.pop();
  }
  if (omitted > 0) {
    const note = `（另有 ${omitted} 张图片未附上）`;
    content.push({ type: "text", text: note });
    lines.push(note);
  }
  return { text: lines.join("\n"), images, content, omitted };
}

/** Synchronous preview form for list views: cached descriptions only, never a lazy Vision call. */
export function renderMessagePreview(db: MoonanDatabase, message: StoredMessage): string {
  const rows = db.listMediaForMessages([message.id]).get(message.id) ?? [];
  const bySegment = new Map(rows.map((row) => [row.segmentIndex, row]));
  let text = "";
  segmentsOf(message).forEach((segment, index) => {
    if (isImageSegment(segment)) {
      const description = bySegment.get(index)?.description;
      text += description ? `[图片：${description}]` : segmentText(segment);
      return;
    }
    text += segmentText(segment);
  });
  return text.trim() || "[空消息]";
}

/** Replaces image blocks with `[图片]` markers so persisted agent state never carries base64. */
export function stripImageBlocks(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    const content = (message as { content?: unknown } | null)?.content;
    if (!Array.isArray(content)) return message;
    let changed = false;
    const next = (content as Array<{ type?: string }>).map((block) => {
      if (block?.type === "image") {
        changed = true;
        return { type: "text", text: "[图片]" };
      }
      return block;
    });
    return changed ? { ...(message as object), content: next } : message;
  });
}

export interface SynthesisMediaInput {
  /** Event lines with `（图片内容：…）` annotations where the model cannot see the real image. */
  lines: string[];
  /** Real images for a synthesis model that sees images, newest-first capped then re-ordered chronologically. */
  images: ImageContent[];
}

/** Prepares the event list of one synthesis batch: real images when the model sees them, descriptions otherwise. */
export async function renderSynthesisEvents(
  db: MoonanDatabase,
  pipeline: MediaPipeline,
  events: WorldEvent[],
  seesImages: boolean,
): Promise<SynthesisMediaInput> {
  const settings = db.getSettings().value.media;
  const rowIdOf = (event: WorldEvent): string | null => {
    const value = (event.data as Record<string, unknown> | undefined)?.messageRowId;
    return typeof value === "string" && value ? value : null;
  };
  const ids = events.map(rowIdOf).filter((value): value is string => value !== null);
  if (ids.length) await pipeline.waitForFetches(ids, settings.downloadTimeoutMs);
  const mediaByMessage = db.listMediaForMessages(ids);

  const annotations = new Map<string, string[]>();
  const annotate = (event: WorldEvent, description: string): void => {
    const list = annotations.get(event.id) ?? [];
    list.push(description);
    annotations.set(event.id, list);
  };

  const candidates: Array<{ event: WorldEvent; media: MessageMedia }> = [];
  for (const event of events) {
    const rowId = rowIdOf(event);
    if (!rowId) continue;
    for (const media of mediaByMessage.get(rowId) ?? []) candidates.push({ event, media });
  }

  const images: ImageContent[] = [];
  if (seesImages) {
    const attachable = candidates.filter((candidate) => pipeline.imageContent(candidate.media) !== null);
    const selected = attachable.slice(-Math.max(1, settings.maxInjectedImages));
    const selectedMedia = new Set(selected.map((candidate) => candidate.media.id));
    for (const candidate of selected) images.push(pipeline.imageContent(candidate.media)!);
    for (const candidate of candidates) {
      if (selectedMedia.has(candidate.media.id)) continue;
      const description = candidate.media.description ?? await pipeline.ensureDescription(candidate.media.id);
      if (description) annotate(candidate.event, description);
    }
  } else {
    for (const candidate of candidates) {
      const description = candidate.media.description ?? await pipeline.ensureDescription(candidate.media.id);
      if (description) annotate(candidate.event, description);
    }
  }

  const lines = events.map((event) => {
    const head = `[${new Date(event.occurredAt).toISOString()}] ${event.text}`;
    const notes = annotations.get(event.id) ?? [];
    return notes.length ? `${head}\n${notes.map((note) => `（图片内容：${note}）`).join("\n")}` : head;
  });
  return { lines, images };
}

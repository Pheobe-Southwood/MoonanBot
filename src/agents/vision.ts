import type { AssistantMessage, Model, TextContent } from "@earendil-works/pi-ai";
import { supportsImageInput } from "../domain/behavior.js";
import type { AgentSelection, MessageMedia } from "../domain/types.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { MoonanDatabase } from "../storage/database.js";
import { renderPrompt } from "./prompts.js";

/** Renders the shared world placeholders (soul, memory, relationships, …) for any system prompt. */
export function formatWorld(db: MoonanDatabase): Record<string, string> {
  const profile = db.getProfile();
  return {
    botName: profile.name,
    soul: profile.soul || "（尚未填写）",
    environment: profile.environment || "（尚未填写）",
    memory: JSON.stringify(db.listMemories(), null, 2),
    relationships: JSON.stringify(db.listContacts(), null, 2),
    groups: JSON.stringify(db.listGroups(), null, 2),
  };
}

/** Per-slot merge over the default selection; forceImageInput falls back like the model fields. */
export function resolveSelection(selection: AgentSelection, fallback: AgentSelection): AgentSelection {
  return {
    providerId: selection.providerId ?? fallback.providerId,
    modelId: selection.modelId ?? fallback.modelId,
    thinkingLevel: selection.thinkingLevel ?? fallback.thinkingLevel,
    forceImageInput: selection.forceImageInput ?? fallback.forceImageInput ?? false,
  };
}

export function effectiveSelection(db: MoonanDatabase, agent: "simulation" | "synthesis" | "vision"): AgentSelection {
  const agents = db.getSettings().value.agents;
  return resolveSelection(agents[agent], agents.default);
}

/**
 * Rewrites the pi-ai Model record so the operator's per-slot intent survives serialization.
 *
 * pi-ai strips images when `model.input` lacks "image" and clamps a thinking level to "off"
 * when `model.reasoning` is false (and drops xhigh/max without an explicit map entry). Custom
 * providers fabricate both fields — remote models are hardcoded `reasoning:false, input:["text"]` —
 * so the operator's slot selection is the only trustworthy signal there. Catalog metadata stays
 * authoritative: we force images only under the explicit `forceImageInput` flag, and never force
 * reasoning on a catalog model (that would 400 on a provider that genuinely lacks it).
 */
export function applySlotOverrides(providers: ProviderRegistry, model: Model<any>, selection: AgentSelection): Model<any> {
  let next = model;
  const input = next.input ?? ["text"];
  if (selection.forceImageInput && !input.includes("image")) {
    next = { ...next, input: [...input, "image"] as ("text" | "image")[] };
  }
  const level = selection.thinkingLevel;
  if (level !== "off" && providers.isCustomProvider(model.provider)) {
    const map = { ...next.thinkingLevelMap };
    if (map.xhigh === undefined) map.xhigh = "xhigh";
    if (map.max === undefined) map.max = "max";
    next = { ...next, reasoning: true, thinkingLevelMap: map };
  }
  return next;
}

/** Effective image capability of one agent slot: catalog modalities or the operator's force override. */
export function selectionSeesImages(providers: ProviderRegistry, selection: AgentSelection): boolean {
  const model = selection.providerId && selection.modelId
    ? providers.models.getModel(selection.providerId, selection.modelId)
    : undefined;
  return supportsImageInput(model, selection);
}

export interface ImageCapabilities {
  simulation: boolean;
  synthesis: boolean;
  visionConfigured: boolean;
  visionSeesImages: boolean;
}

export function currentCapabilities(db: MoonanDatabase, providers: ProviderRegistry): ImageCapabilities {
  const simulation = effectiveSelection(db, "simulation");
  const synthesis = effectiveSelection(db, "synthesis");
  const vision = effectiveSelection(db, "vision");
  return {
    simulation: selectionSeesImages(providers, simulation),
    synthesis: selectionSeesImages(providers, synthesis),
    visionConfigured: Boolean(vision.providerId && vision.modelId),
    visionSeesImages: selectionSeesImages(providers, vision),
  };
}

/**
 * One Vision Agent call: describes a cached image with the configured vision model and records the run
 * in the activity trace. Null on any unavailability — the caller degrades to the `[图片：file]`
 * placeholder instead of failing the render. The media pipeline persists the returned description.
 */
export async function describeMedia(db: MoonanDatabase, providers: ProviderRegistry, media: MessageMedia): Promise<string | null> {
  if (media.status !== "cached" || !media.bytes || !media.mime) return null;
  const selection = effectiveSelection(db, "vision");
  const resolved = selection.providerId && selection.modelId
    ? providers.models.getModel(selection.providerId, selection.modelId)
    : undefined;
  if (!resolved) return null;
  const model = applySlotOverrides(providers, resolved, selection);
  const systemPrompt = renderPrompt(db.getPrompt("vision").template, formatWorld(db));
  const runId = db.beginAgentRun("vision", `描述图片 ${media.fileId}`);
  db.addAgentMessage(runId, "user", "[图片]");
  try {
    const stream = providers.models.streamSimple(model, {
      systemPrompt,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "请按系统提示的要求描述这张图片。" },
          { type: "image", data: Buffer.from(media.bytes).toString("base64"), mimeType: media.mime },
        ],
        timestamp: Date.now(),
      }],
    }, selection.thinkingLevel === "off" ? {} : { reasoning: selection.thinkingLevel });
    const message: AssistantMessage = await stream.result();
    const text = message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new Error(message.errorMessage || "empty_description");
    db.addAgentMessage(runId, "assistant", text);
    db.endAgentRun(runId, "completed", { input: message.usage.input, output: message.usage.output });
    return text;
  } catch (error) {
    const problem = error instanceof Error ? error.message : String(error);
    db.addAgentMessage(runId, "assistant", problem);
    db.endAgentRun(runId, "failed", { input: 0, output: 0 }, problem);
    return null;
  }
}

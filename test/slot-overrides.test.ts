import { afterEach, describe, expect, it, vi } from "vitest";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { applySlotOverrides, describeMedia } from "../src/agents/vision.js";
import type { AgentSelection } from "../src/domain/types.js";
import { ProviderRegistry } from "../src/providers/registry.js";
import { testDatabase } from "./helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.unstubAllGlobals(); });

/** A real registry whose only custom provider fabricates a text-only, non-reasoning remote-style model. */
function registryWithCustom() {
  const fixture = testDatabase();
  cleanups.push(fixture.cleanup);
  const providers = new ProviderRegistry(fixture.db);
  providers.saveCustom({
    id: "proxy-test",
    name: "Proxy",
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "test-key",
    models: [{ id: "gem", name: "gem", contextWindow: 128_000, maxTokens: 8_192, reasoning: false }],
  });
  return { db: fixture.db, providers };
}

function selection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return { providerId: "proxy-test", modelId: "gem", thinkingLevel: "off", forceImageInput: false, ...overrides };
}

const catalogModel = {
  id: "catalog-model", name: "catalog-model", api: "openai-completions", provider: "deepseek",
  baseUrl: "https://api.deepseek.com", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000, maxTokens: 100,
} as any;

describe("applySlotOverrides", () => {
  it("adds image input under the forceImageInput flag even for a text-only model", () => {
    const { providers } = registryWithCustom();
    const model = providers.models.getModel("proxy-test", "gem")!;
    expect(model.input).toEqual(["text"]);
    const patched = applySlotOverrides(providers, model, selection({ forceImageInput: true }));
    expect(patched.input).toContain("image");
  });

  it("forces reasoning and unlocks xhigh/max for custom providers when a level is selected", () => {
    const { providers } = registryWithCustom();
    const model = providers.models.getModel("proxy-test", "gem")!;
    expect(model.reasoning).toBe(false);
    const patched = applySlotOverrides(providers, model, selection({ thinkingLevel: "max" }));
    expect(patched.reasoning).toBe(true);
    expect(patched.thinkingLevelMap?.max).toBe("max");
    expect(patched.thinkingLevelMap?.xhigh).toBe("xhigh");
  });

  it("leaves the model untouched when nothing needs overriding", () => {
    const { providers } = registryWithCustom();
    const model = providers.models.getModel("proxy-test", "gem")!;
    const patched = applySlotOverrides(providers, model, selection());
    expect(patched).toBe(model);
    expect(patched.reasoning).toBe(false);
  });

  it("forces images by flag but never forces reasoning on a catalog provider", () => {
    const { providers } = registryWithCustom();
    expect(providers.isCustomProvider("deepseek")).toBe(false);
    const patched = applySlotOverrides(providers, catalogModel, selection({ providerId: "deepseek", modelId: "catalog-model", thinkingLevel: "max", forceImageInput: true }));
    expect(patched.input).toContain("image");
    expect(patched.reasoning).toBe(false);
    expect(patched.thinkingLevelMap).toBeUndefined();
  });
});

describe("pi-ai image serialization gate", () => {
  const imageMessage = {
    role: "user",
    content: [{ type: "text", text: "看图" }, { type: "image", data: "AAAA", mimeType: "image/png" }],
    timestamp: Date.now(),
  } as any;

  it("replaces images with a placeholder for a text-only model", () => {
    const out = transformMessages([imageMessage], { input: ["text"] } as any);
    const serialized = JSON.stringify(out);
    expect(serialized).toContain("image omitted");
    expect(serialized).not.toContain('"type":"image"');
  });

  it("preserves image blocks once the model is patched to accept image input", () => {
    const out = transformMessages([imageMessage], { input: ["text", "image"] } as any);
    const serialized = JSON.stringify(out);
    expect(serialized).toContain('"type":"image"');
    expect(serialized).not.toContain("image omitted");
  });
});

describe("describeMedia wire serialization", () => {
  it("sends reasoning_effort and the image data URI for a forced custom-provider vision slot", async () => {
    const { db, providers } = registryWithCustom();
    const settings = db.getSettings();
    settings.value.agents.vision = { providerId: "proxy-test", modelId: "gem", thinkingLevel: "max", forceImageInput: true };
    db.updateSettings(settings.value, settings.version);

    const media = db.createMedia({ messageId: "m1", segmentIndex: 0, fileId: "a.png", url: null });
    db.setMediaCached(media.id, { mime: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
    const cached = db.getMedia(media.id)!;

    let captured: any = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: any, init: any) => {
      captured = init?.body ? JSON.parse(String(init.body)) : null;
      const sse = [
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gem","choices":[{"index":0,"delta":{"role":"assistant","content":"红色轿车。"},"finish_reason":null}]}',
        'data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"gem","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}',
        "data: [DONE]",
      ].join("\n\n") + "\n\n";
      const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(sse)); controller.close(); } });
      return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
    }));

    await describeMedia(db, providers, cached);

    expect(captured).not.toBeNull();
    expect(captured.reasoning_effort).toBe("max");
    const userMessage = captured.messages.find((message: any) => message.role === "user");
    const imagePart = userMessage.content.find((part: any) => part.type === "image_url");
    expect(imagePart?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });
});

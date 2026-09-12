import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSimulationTools } from "../../src/agents/simulation-tools.js";
import { buildSynthesisTools } from "../../src/agents/synthesis-tools.js";
import type { ChatPlatformAdapter } from "../../src/platforms/types.js";
import { ProviderRegistry } from "../../src/providers/registry.js";
import { MoonanDatabase } from "../../src/storage/database.js";

const enabled = Boolean(process.env.DEEPSEEK_API_KEY);
const longEnabled = process.env.MOONAN_LIVE_LONG === "1";
const suite = enabled ? describe : describe.skip;
let directory = "";
let db: MoonanDatabase;
let providers: ProviderRegistry;
let modelId = "";

function text(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function platform(): ChatPlatformAdapter {
  return {
    id: "live-fake", status: () => ({ connected: true, selfId: "bot", roles: ["universal"] }),
    sendText: async () => ({ platformMessageId: "live-simulated" }), syncRoster: async () => undefined, close: async () => undefined,
  };
}

suite.sequential("DeepSeek live integration", () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "moonanbot-deepseek-live-"));
    db = new MoonanDatabase(join(directory, "ephemeral.sqlite"));
    providers = new ProviderRegistry(db);
    const refreshed = await providers.refresh("deepseek");
    const ids = refreshed.models.map((model) => model.id);
    modelId = ids.includes("deepseek-flash") ? "deepseek-flash" : ids.find((id) => /flash/i.test(id) && !/vision/i.test(id)) ?? "";
    if (!modelId) throw new Error(`No current DeepSeek Flash model found. Returned: ${ids.join(", ")}`);
    process.stdout.write(`\nDeepSeek live model: ${modelId}\n`);
  });

  afterAll(() => {
    db?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("refreshes models and completes a streamed reasoning request", async () => {
    const model = providers.models.getModel("deepseek", modelId)!;
    const stream = providers.models.streamSimple(model, {
      systemPrompt: "Answer briefly and follow the marker instruction.",
      messages: [{ role: "user", content: "Think carefully, then reply with exactly MOONAN_STREAM_OK.", timestamp: Date.now() }],
    }, { reasoning: "medium", maxTokens: 256 });
    const events: string[] = [];
    for await (const event of stream) events.push(event.type);
    const message = await stream.result();
    expect(message.stopReason).not.toBe("error");
    expect(events).toContain("start");
    expect(events).toContain("done");
    expect(text(message)).toContain("MOONAN_STREAM_OK");
    expect(model.contextWindow).toBeGreaterThanOrEqual(300_000);
  });

  it("executes tools, preserves reasoning traces, terminates an action, and continues context", async () => {
    const model = providers.models.getModel("deepseek", modelId)!;
    let marker = "";
    const finishTool = {
      name: "finish_live_test", label: "Finish live test", description: "Record the exact marker and finish.",
      parameters: Type.Object({ marker: Type.Literal("TOOL_OK") }), replay: "never" as const,
      execute: async (_id: string, params: any) => { marker = params.marker; return { content: [{ type: "text" as const, text: "Recorded." }], details: {}, terminate: true }; },
    };
    const agent = new Agent({ initialState: { systemPrompt: "Always use the requested tool. Do not merely describe it.", model, tools: [finishTool] }, streamFn: providers.models.streamSimple.bind(providers.models), sessionId: "moonan-live-tool" });
    await agent.prompt("Call finish_live_test with marker TOOL_OK now.");
    expect(marker).toBe("TOOL_OK");
    expect(agent.state.messages.some((message: any) => message.role === "assistant" && message.content.some((block: any) => block.type === "toolCall"))).toBe(true);

    const continuation = new Agent({ initialState: { systemPrompt: "Remember information across turns.", model }, streamFn: providers.models.streamSimple.bind(providers.models), sessionId: "moonan-live-continuation" });
    await continuation.prompt("The continuity marker is cedar-427. Acknowledge briefly.");
    await continuation.prompt("What is the continuity marker? Reply with only the marker.");
    const final = continuation.state.messages.at(-1) as AssistantMessage;
    expect(text(final)).toContain("cedar-427");
  });

  it("runs MoonanBot simulation and synthesis tools against the live model", async () => {
    const model = providers.models.getModel("deepseek", modelId)!;
    const profile = db.getProfile();
    db.updateProfile({ ...profile, soul: "谨慎、有规律，收到明确休息安排时会设置闹钟睡觉。", environment: "安静的卧室。" }, profile.version);
    const simulation = new Agent({
      initialState: {
        systemPrompt: "你控制一个角色。必须使用工具实际行动。先查询动作，然后睡觉并设置30分钟闹钟。",
        model, tools: buildSimulationTools(db, platform()), thinkingLevel: "medium",
      },
      streamFn: providers.models.streamSimple.bind(providers.models), toolExecution: "sequential", sessionId: "moonan-live-simulation",
    });
    await simulation.prompt("夜深了，请进行下一步动作。");
    expect(db.getRuntime().mode).toBe("sleeping");

    const synthesisTools = buildSynthesisTools(db);
    const synthesis = new Agent({
      initialState: {
        systemPrompt: "使用工具把明确事件写入长期记忆，最后必须调用 finish_synthesis。",
        model, tools: synthesisTools.tools, thinkingLevel: "medium",
      },
      streamFn: providers.models.streamSimple.bind(providers.models), toolExecution: "sequential", sessionId: "moonan-live-synthesis",
    });
    await synthesis.prompt(`事件时间 ${new Date().toISOString()}：角色主动睡觉并设置了闹钟。请写入一条简短记忆并完成归纳。`);
    synthesisTools.staging.commit();
    expect(db.listMemories().length).toBeGreaterThan(0);
  });

  (longEnabled ? it : it.skip)("accepts an approximately 300k-token input", async () => {
    const model = providers.models.getModel("deepseek", modelId)!;
    const longContext = `Remember the final marker after this repeated context.\n${"context ".repeat(300_000)}\nFinal marker: MOONAN_300K_OK`;
    const response = await providers.models.completeSimple(model, {
      systemPrompt: "Return only the final marker from the user input.",
      messages: [{ role: "user", content: longContext, timestamp: Date.now() }],
    }, { reasoning: "off" as never, maxTokens: 512 });
    expect(response.stopReason).not.toBe("error");
    expect(text(response)).toContain("MOONAN_300K_OK");
  });
});

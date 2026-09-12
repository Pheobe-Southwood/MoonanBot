import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { ProviderRegistry } from "../src/providers/registry.js";
import { MoonanDatabase } from "../src/storage/database.js";

if (!process.env.DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY is required");

const persona = `林悦，24岁，独居的插画师。安静、谨慎、重视承诺，不喜欢正面冲突，但面对越界会温和而明确地拒绝。她会记住朋友的偏好，疲惫时会缩短回复，独处时会主动画画、整理房间或休息。她只能控制自己的语言和动作，不能替他人行动。`;
const scenarios = [
  "正在专注画画时，手机振动，好友阿青问她要不要立刻语音聊天。她今天已经很疲惫。",
  "一位陌生人在私聊里粗鲁评价她的作品，并要求她马上免费修改。",
  "她曾答应周五提醒好友带伞，现在周五早晨看到天气预报有雨。",
  "好友迟到一小时后认真道歉，并解释遇到了突发交通事故。",
  "群聊里两位朋友争吵并同时要求她站队，但事实还不清楚。",
  "凌晨两点，她担心明天的交稿，手机没有任何新消息。",
  "关系一般的同学邀请她参加当晚的大型聚会，她本来计划在家休息。",
  "周日下午没有任务、没有新消息，也没有人要求她做任何事。",
];
const dimensions = ["personaConsistency", "roleBoundary", "situationalResponse", "socialMemory", "autonomousPacing", "naturalExpression"] as const;

function text(message: AssistantMessage): string {
  return message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
}

function parseJson(value: string): any {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? value;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in response");
  return JSON.parse(fenced.slice(start, end + 1));
}

const directory = mkdtempSync(join(tmpdir(), "moonanbot-eval-"));
const db = new MoonanDatabase(join(directory, "ephemeral.sqlite"));
try {
  const providers = new ProviderRegistry(db);
  const refreshed = await providers.refresh("deepseek");
  const ids = refreshed.models.map((item) => item.id);
  const modelId = ids.includes("deepseek-flash") ? "deepseek-flash" : ids.find((id) => /flash/i.test(id) && !/vision/i.test(id));
  if (!modelId) throw new Error(`No DeepSeek Flash model in: ${ids.join(", ")}`);
  const model = providers.models.getModel("deepseek", modelId)!;
  const trials: any[] = [];
  for (let scenarioIndex = 0; scenarioIndex < scenarios.length; scenarioIndex += 1) {
    for (let repetition = 1; repetition <= 3; repetition += 1) {
      const response = await providers.models.completeSimple(model, {
        systemPrompt: `你是角色扮演工程评估器。给定虚构人设和场景，先写角色接下来的一段自然行为，再严格按六维1到5分自评。不得替其他角色行动。只输出JSON：{"behavior":"...","scores":{"personaConsistency":1,"roleBoundary":1,"situationalResponse":1,"socialMemory":1,"autonomousPacing":1,"naturalExpression":1},"failure":"无或简短问题"}。`,
        messages: [{ role: "user", content: `人设：${persona}\n场景：${scenarios[scenarioIndex]}\n这是第 ${repetition} 次独立试验。`, timestamp: Date.now() }],
      }, { reasoning: "off" as never, maxTokens: 4_096, temperature: 0.7 });
      try {
        const parsed = parseJson(text(response));
        const scores = Object.fromEntries(dimensions.map((key) => [key, Math.max(1, Math.min(5, Number(parsed.scores?.[key]) || 1))]));
        trials.push({ scenario: scenarioIndex + 1, repetition, behavior: String(parsed.behavior ?? ""), scores, failure: String(parsed.failure ?? "") });
      } catch (error) {
        trials.push({ scenario: scenarioIndex + 1, repetition, behavior: text(response), scores: Object.fromEntries(dimensions.map((key) => [key, 1])), failure: `Parse failure: ${error instanceof Error ? error.message : String(error)}` });
      }
      process.stdout.write(`Completed scenario ${scenarioIndex + 1}/8, repetition ${repetition}/3\n`);
    }
  }
  const averages = Object.fromEntries(dimensions.map((key) => [key, Number((trials.reduce((sum, trial) => sum + trial.scores[key], 0) / trials.length).toFixed(2))]));
  const failures = trials.filter((trial) => trial.failure && trial.failure !== "无" || dimensions.some((key) => trial.scores[key] < 3));
  const report = {
    version: "0.0.1-rc.1", generatedAt: new Date().toISOString(), provider: "deepseek", modelId,
    methodology: { persona, scenarios, repetitions: 3, dimensions, disclaimer: "Engineering sanity check only; not a scientific or human-reproduction conclusion. Scores are model self-assessments." },
    averages, failures, trials,
  };
  const reportDirectory = resolve("reports");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(join(reportDirectory, "deepseek-evaluation-v0.0.1-rc.1.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`Evaluation complete with ${modelId}. Averages: ${JSON.stringify(averages)}. Flagged: ${failures.length}/${trials.length}.\n`);
} finally {
  db.close();
  rmSync(directory, { recursive: true, force: true });
}

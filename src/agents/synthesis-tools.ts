import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { estimateTokens } from "../domain/behavior.js";
import type { ContactRecord, GroupRecord, MemoryRecord } from "../domain/types.js";
import type { MoonanDatabase } from "../storage/database.js";

function output(text: string, details: Record<string, unknown> = {}, terminate = false): AgentToolResult<Record<string, unknown>> {
  return { content: [{ type: "text", text }], details, ...(terminate ? { terminate: true } : {}) };
}

export interface SynthesisStaging {
  finished: boolean;
  summary: string;
  commit(): void;
}

export function buildSynthesisTools(db: MoonanDatabase): { tools: AgentTool[]; staging: SynthesisStaging } {
  const settingsEnvelope = db.getSettings();
  const settings = structuredClone(settingsEnvelope.value);
  const memories = new Map(db.listMemories().map((item) => [item.id, { ...item }]));
  const forgotten = new Set<string>();
  const contacts = new Map(db.listContacts().map((item) => [item.id, { ...item }]));
  const removedContacts = new Set<string>();
  const groups = new Map(db.listGroups().map((item) => [item.id, { ...item }]));
  const removedGroups = new Set<string>();
  let finished = false;
  let summary = "";

  const memoryTokens = (values = memories): number => estimateTokens(JSON.stringify([...values.values()]));

  const memoryTool: AgentTool = {
    name: "manage_memory",
    label: "管理长期记忆",
    description: "新增或更新记忆、遗忘一条活动记忆，或在硬上限内提高软上限。",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("upsert"), Type.Literal("forget"), Type.Literal("raise_soft_limit")]),
      id: Type.Optional(Type.String()),
      occurredAt: Type.Optional(Type.Number()),
      summary: Type.Optional(Type.String({ minLength: 1 })),
      details: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      softTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_id, params: any) => {
      if (params.operation === "raise_soft_limit") {
        if (!params.softTokens || params.softTokens > settings.synthesis.memoryHardTokens || params.softTokens < settings.synthesis.memorySoftTokens) {
          throw new Error(`新的软上限必须在 ${settings.synthesis.memorySoftTokens} 与硬上限 ${settings.synthesis.memoryHardTokens} Token 之间`);
        }
        settings.synthesis.memorySoftTokens = params.softTokens;
        return output(`记忆软上限已暂存为 ${params.softTokens} Token。`);
      }
      if (params.operation === "forget") {
        if (!params.id) throw new Error("遗忘记忆需要 id");
        if (!memories.has(params.id)) throw new Error("memory_not_found");
        memories.delete(params.id);
        forgotten.add(params.id);
        return output(`已暂存遗忘记忆 ${params.id}，原始事件仍会保留。`);
      }
      if (!params.summary || params.occurredAt === undefined) throw new Error("upsert 需要 occurredAt 和 summary");
      const timestamp = Date.now();
      const id = params.id ?? randomUUID();
      const existing = memories.get(id);
      const value: MemoryRecord = {
        id, occurredAt: params.occurredAt, summary: params.summary, details: params.details ?? null,
        createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
      };
      const candidate = new Map(memories);
      candidate.set(value.id, value);
      const tokens = memoryTokens(candidate);
      if (tokens > settings.synthesis.memoryHardTokens) throw new Error(`记忆达到硬上限 ${settings.synthesis.memoryHardTokens} Token，请先遗忘或压缩`);
      if (tokens > settings.synthesis.memorySoftTokens) throw new Error(`记忆内容太多了（${tokens}/${settings.synthesis.memorySoftTokens} Token），请先让角色遗忘一些久远事件的细节；若都印象深刻，请提高记忆软上限`);
      memories.set(value.id, value);
      forgotten.delete(value.id);
      return output(`已暂存记忆 ${value.id}。`, { tokens });
    },
  };

  const relationshipTool: AgentTool = {
    name: "manage_relationship",
    label: "管理关系",
    description: "根据事件证据新增、更新或删除联系人关系摘要；不能修改消息重要度。",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("upsert"), Type.Literal("remove")]),
      id: Type.String({ minLength: 1 }),
      name: Type.Optional(Type.String({ minLength: 1 })),
      aliases: Type.Optional(Type.Array(Type.String())),
      summary: Type.Optional(Type.String()),
      isFriend: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_id, params: any) => {
      if (params.operation === "remove") {
        contacts.delete(params.id); removedContacts.add(params.id);
        return output(`已暂存删除联系人 ${params.id}。`);
      }
      const existing = contacts.get(params.id);
      if (!params.name && !existing) throw new Error("新联系人需要 name");
      const timestamp = Date.now();
      const value: ContactRecord = {
        platform: "onebot", id: params.id, name: params.name ?? existing!.name, aliases: params.aliases ?? existing?.aliases ?? [],
        summary: params.summary ?? existing?.summary ?? "", importance: existing?.importance ?? "normal",
        isFriend: params.isFriend ?? existing?.isFriend ?? false, createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
      };
      contacts.set(value.id, value); removedContacts.delete(value.id);
      return output(`已暂存联系人 ${value.name}。`);
    },
  };

  const groupTool: AgentTool = {
    name: "manage_group",
    label: "管理群聊",
    description: "根据事件证据新增、更新或删除群聊记录。",
    parameters: Type.Object({
      operation: Type.Union([Type.Literal("upsert"), Type.Literal("remove")]),
      id: Type.String({ minLength: 1 }),
      name: Type.Optional(Type.String({ minLength: 1 })),
      summary: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    executionMode: "sequential",
    execute: async (_id, params: any) => {
      if (params.operation === "remove") {
        groups.delete(params.id); removedGroups.add(params.id);
        return output(`已暂存删除群聊 ${params.id}。`);
      }
      const existing = groups.get(params.id);
      if (!params.name && !existing) throw new Error("新群聊需要 name");
      const timestamp = Date.now();
      const value: GroupRecord = {
        platform: "onebot", id: params.id, name: params.name ?? existing!.name,
        summary: params.summary ?? existing?.summary ?? "", createdAt: existing?.createdAt ?? timestamp, updatedAt: timestamp,
      };
      groups.set(value.id, value); removedGroups.delete(value.id);
      return output(`已暂存群聊 ${value.name}。`);
    },
  };

  const finishTool: AgentTool = {
    name: "finish_synthesis",
    label: "提交归纳",
    description: "校验并原子提交本次所有暂存修改。即使没有变化也必须调用。",
    parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: 4_000 }) }, { additionalProperties: false }),
    executionMode: "sequential",
    replay: "never",
    execute: async (_id, params: any) => {
      const tokens = memoryTokens();
      if (tokens > settings.synthesis.memorySoftTokens) throw new Error(`活动记忆仍超过软上限：${tokens}/${settings.synthesis.memorySoftTokens} Token`);
      summary = params.summary;
      db.transaction(() => {
        for (const id of forgotten) db.forgetMemory(id, "synthesis");
        for (const memory of memories.values()) db.upsertMemory(memory, "synthesis");
        for (const id of removedContacts) db.deleteContact(id);
        for (const contact of contacts.values()) db.upsertContact(contact, "synthesis", true);
        for (const id of removedGroups) db.deleteGroup(id);
        for (const group of groups.values()) db.upsertGroup(group, "synthesis");
        if (settings.synthesis.memorySoftTokens !== settingsEnvelope.value.synthesis.memorySoftTokens) {
          db.updateSettings(settings, settingsEnvelope.version);
        }
      });
      finished = true;
      return output("归纳修改已原子提交。", { summary, memoryTokens: tokens }, true);
    },
  };

  return {
    tools: [memoryTool, relationshipTool, groupTool, finishTool],
    staging: {
      get finished() { return finished; },
      get summary() { return summary; },
      commit: () => { if (!finished) throw new Error("finish_synthesis_not_called"); },
    },
  };
}

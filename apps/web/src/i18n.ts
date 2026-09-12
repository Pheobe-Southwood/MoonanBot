export type Locale = "en" | "zh-CN";

const messages = {
  en: {
    overview: "Overview", character: "Character", agents: "Agents", connections: "Connections", activity: "Activity", settings: "Settings",
    welcome: "A life unfolding", signIn: "Sign in", password: "Password", signOut: "Sign out", save: "Save", refresh: "Refresh",
    start: "Start", pause: "Pause", wake: "Wake now", ready: "Ready", attention: "Needs attention", online: "Online", offline: "Offline",
    runtime: "Character state", nextWake: "Next wake", phone: "Phone", database: "Database", records: "records", noData: "Nothing here yet",
    identity: "Identity", memories: "Memories", relationships: "Relationships", groups: "Groups", soul: "Soul", environment: "Environment",
    name: "Name", timezone: "Timezone", summary: "Summary", details: "Details", add: "Add", delete: "Delete", importance: "Importance",
    providers: "LLM providers", custom: "Custom endpoint", connected: "Configured", notConnected: "Not configured", models: "models", apiKey: "API key",
    simulation: "Simulation Agent", synthesis: "Synthesis Agent", prompt: "System prompt", restore: "Restore default", model: "Model", thinking: "Thinking",
    allRuns: "Agent runs", director: "Director note", reasoning: "Provider reasoning", tool: "Tool", exportCharacter: "Export character package",
    language: "Language", outbound: "Outbound messages", enabled: "Enabled", disabled: "Disabled", onebot: "OneBot v11", allowlists: "Allowlists",
  },
  "zh-CN": {
    overview: "概览", character: "角色", agents: "Agents", connections: "连接", activity: "活动", settings: "设置",
    welcome: "一段正在发生的生命", signIn: "登录", password: "密码", signOut: "退出登录", save: "保存", refresh: "刷新",
    start: "启动", pause: "暂停", wake: "立即唤醒", ready: "就绪", attention: "需要处理", online: "在线", offline: "离线",
    runtime: "角色状态", nextWake: "下次唤醒", phone: "手机", database: "数据库", records: "条记录", noData: "这里还没有内容",
    identity: "身份", memories: "记忆", relationships: "关系", groups: "群聊", soul: "灵魂设定", environment: "居住环境",
    name: "名称", timezone: "时区", summary: "摘要", details: "细节", add: "添加", delete: "删除", importance: "消息重要度",
    providers: "LLM 提供商", custom: "自定义端点", connected: "已配置", notConnected: "未配置", models: "个模型", apiKey: "API Key",
    simulation: "推演 Agent", synthesis: "归纳 Agent", prompt: "System Prompt", restore: "恢复默认", model: "模型", thinking: "思考等级",
    allRuns: "Agent 运行历史", director: "导演日志", reasoning: "供应商推理", tool: "工具", exportCharacter: "导出角色包",
    language: "语言", outbound: "出站消息", enabled: "已开启", disabled: "已关闭", onebot: "OneBot v11", allowlists: "白名单",
  },
} as const;

export function useCopy(locale: Locale) {
  return (key: keyof typeof messages.en): string => messages[locale][key];
}

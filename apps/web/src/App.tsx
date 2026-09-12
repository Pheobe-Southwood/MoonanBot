import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity, BrainCircuit, ChevronRight, CircleDot, Database, Download, Globe2, KeyRound, Languages,
  LayoutDashboard, LogOut, MessageCircle, Moon, Pause, Play, Plus, RefreshCw, Save, Settings, Upload,
  Sparkles, Trash2, Wifi, WifiOff, Zap,
} from "lucide-react";
import { api, session } from "./api";
import { Button, Card, Empty, Field, Pill } from "./components";
import { type Locale, useCopy } from "./i18n";

type Section = "overview" | "character" | "agents" | "connections" | "activity" | "settings";
type AnyRecord = Record<string, any>;

function useLoad<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const reload = useCallback(async () => {
    try { setData(await loader()); setError(""); } catch (value) { setError(value instanceof Error ? value.message : String(value)); }
  }, dependencies);
  useEffect(() => { void reload(); }, [reload]);
  return { data, setData, error, reload };
}

function Login({ onLogin, locale, setLocale }: { onLogin: () => void; locale: Locale; setLocale: (value: Locale) => void }) {
  const t = useCopy(locale);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await api("/auth/login", { method: "POST", body: JSON.stringify({ password }) }); onLogin(); }
    catch (value) { setError(value instanceof Error ? value.message : String(value)); }
    finally { setBusy(false); }
  };
  return <main className="login-page">
    <div className="orb one"/><div className="orb two"/>
    <form className="login-window" onSubmit={submit}>
      <div className="traffic"><i/><i/><i/></div>
      <div className="app-mark"><Moon size={28}/></div>
      <h1>MoonanBot</h1><p>{t("welcome")}</p>
      <Field label={t("password")}><input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
      {error && <div className="error-banner">{error}</div>}
      <Button tone="primary" busy={busy} type="submit">{t("signIn")} <ChevronRight size={16}/></Button>
      <button type="button" className="locale-link" onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}><Languages size={14}/>{locale === "en" ? "简体中文" : "English"}</button>
    </form>
  </main>;
}

const navIcons: Record<Section, ReactNode> = {
  overview: <LayoutDashboard/>, character: <Sparkles/>, agents: <BrainCircuit/>, connections: <Wifi/>, activity: <Activity/>, settings: <Settings/>,
};

function Shell({ section, setSection, locale, setLocale, children, logout }: { section: Section; setSection: (value: Section) => void; locale: Locale; setLocale: (value: Locale) => void; children: ReactNode; logout: () => void }) {
  const t = useCopy(locale);
  const nav = ["overview", "character", "agents", "connections", "activity", "settings"] as Section[];
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Moon size={19}/></div><div><strong>MoonanBot</strong><small>v0.0.1 RC</small></div></div>
      <nav>{nav.map((item) => <button key={item} className={section === item ? "active" : ""} onClick={() => setSection(item)}>{navIcons[item]}<span>{t(item)}</span></button>)}</nav>
      <div className="sidebar-footer">
        <button onClick={() => setLocale(locale === "en" ? "zh-CN" : "en")}><Globe2/>{locale === "en" ? "简体中文" : "English"}</button>
        <button onClick={logout}><LogOut/>{t("signOut")}</button>
      </div>
    </aside>
    <section className="workspace"><div className="titlebar"><div className="traffic"><i/><i/><i/></div><span>{t(section)}</span></div><div className="content">{children}</div></section>
  </div>;
}

function PageTitle({ eyebrow, title, detail, action }: { eyebrow: string; title: string; detail: string; action?: ReactNode }) {
  return <header className="page-title"><div><small>{eyebrow}</small><h1>{title}</h1><p>{detail}</p></div>{action}</header>;
}

function OverviewPage({ locale }: { locale: Locale }) {
  const t = useCopy(locale);
  const { data, error, reload } = useLoad<AnyRecord>(() => api("/runtime"), []);
  const act = async (action: string, body?: unknown) => { await api(`/runtime/${action}`, { method: action === "outbound" ? "PUT" : "POST", body: body ? JSON.stringify(body) : undefined }); await reload(); };
  useEffect(() => { const timer = setInterval(() => { void reload(); }, 3_000); return () => clearInterval(timer); }, [reload]);
  if (!data) return <Empty>{error || "Loading…"}</Empty>;
  const runtime = data.runtime;
  return <>
    <PageTitle eyebrow="MOONANBOT" title={locale === "en" ? `Good to see you.` : "很高兴见到你。"} detail={locale === "en" ? "Your character's world, at a glance." : "角色世界的此刻，一目了然。"} action={<Button onClick={() => reload()}><RefreshCw size={15}/>{t("refresh")}</Button>}/>
    {error && <div className="error-banner">{error}</div>}
    {!data.readiness.ready && <div className="notice"><CircleDot/><div><strong>{t("attention")}</strong><p>{data.readiness.problems.join(" · ")}</p></div></div>}
    <div className="metric-grid">
      <Card className="metric" title={t("runtime")}><strong>{runtime.mode}</strong><Pill tone={runtime.health === "healthy" ? "good" : "warn"}>{runtime.health}</Pill></Card>
      <Card className="metric" title={t("phone")}><strong>{runtime.phone.kind}</strong><span>{runtime.phone.target?.name ?? "—"}</span></Card>
      <Card className="metric" title={t("nextWake")}><strong className="small-value">{runtime.nextWakeAt ? new Date(runtime.nextWakeAt).toLocaleString(locale) : "—"}</strong></Card>
      <Card className="metric" title="OneBot"><strong>{data.onebot.connected ? t("online") : t("offline")}</strong>{data.onebot.connected ? <Wifi size={18}/> : <WifiOff size={18}/>}</Card>
    </div>
    <div className="split">
      <Card title={locale === "en" ? "Controls" : "运行控制"} subtitle={locale === "en" ? "Changes take effect without restarting the service." : "无需重启服务即可控制角色。"}>
        <div className="button-row"><Button tone="primary" onClick={() => act("start")}><Play size={16}/>{t("start")}</Button><Button onClick={() => act("pause")}><Pause size={16}/>{t("pause")}</Button><Button onClick={() => act("wake")}><Zap size={16}/>{t("wake")}</Button></div>
        <div className="setting-line"><div><strong>{t("outbound")}</strong><small>{runtime.outboundEnabled ? t("enabled") : t("disabled")}</small></div><button className={`switch ${runtime.outboundEnabled ? "on" : ""}`} onClick={() => act("outbound", { enabled: !runtime.outboundEnabled })}><span/></button></div>
      </Card>
      <Card title={t("database")} subtitle={`${(data.databaseBytes / 1024 / 1024).toFixed(2)} MB`}>
        <div className="stats">{Object.entries(data.stats as Record<string, number>).map(([key, value]) => <div key={key}><span>{key.replaceAll("_", " ")}</span><strong>{value}</strong></div>)}</div>
      </Card>
    </div>
  </>;
}

function CharacterPage({ locale }: { locale: Locale }) {
  const t = useCopy(locale);
  const [tab, setTab] = useState("identity");
  const profile = useLoad<AnyRecord>(() => api("/profile"), []);
  const memories = useLoad<any[]>(() => api("/memories"), []);
  const contacts = useLoad<any[]>(() => api("/contacts"), []);
  const groups = useLoad<any[]>(() => api("/groups"), []);
  const [draft, setDraft] = useState<AnyRecord | null>(null);
  useEffect(() => { if (profile.data) setDraft(profile.data); }, [profile.data]);
  const tabs = [["identity", t("identity")], ["memories", t("memories")], ["relationships", t("relationships")], ["groups", t("groups")]];
  return <>
    <PageTitle eyebrow={locale === "en" ? "CHARACTER MODEL" : "角色模型"} title={t("character")} detail={locale === "en" ? "Shape identity, memory, and the social world without editing raw files." : "通过清晰的表单塑造身份、记忆和社交世界。"}/>
    <div className="segmented">{tabs.map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</div>
    {tab === "identity" && draft && <Card title={t("identity")} action={<Button tone="primary" onClick={async () => { const next = await api<AnyRecord>("/profile", { method: "PUT", body: JSON.stringify(draft) }); setDraft(next); }}><Save size={15}/>{t("save")}</Button>}>
      <div className="form-grid"><Field label={t("name")}><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}/></Field><Field label={t("timezone")}><input value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}/></Field></div>
      <Field label={t("soul")}><textarea className="editor" value={draft.soul} onChange={(e) => setDraft({ ...draft, soul: e.target.value })} placeholder="# Personality&#10;Describe values, voice, habits, and boundaries…"/></Field>
      <Field label={t("environment")}><textarea value={draft.environment} onChange={(e) => setDraft({ ...draft, environment: e.target.value })}/></Field>
    </Card>}
    {tab === "memories" && <RecordList rows={memories.data ?? []} empty={t("noData")} render={(row) => <MemoryEditor row={row} reload={memories.reload} locale={locale}/>} add={<Button onClick={async () => { await api("/memories", { method: "POST", body: JSON.stringify({ occurredAt: Date.now(), summary: locale === "en" ? "New memory" : "新的记忆", details: "" }) }); await memories.reload(); }}><Plus size={15}/>{t("add")}</Button>} />}
    {tab === "relationships" && <RecordList rows={contacts.data ?? []} empty={t("noData")} render={(row) => <ContactEditor row={row} reload={contacts.reload} locale={locale}/>} add={<Button onClick={async () => { const id = window.prompt(locale === "en" ? "OneBot user ID" : "OneBot 用户 ID"); if (!id) return; await api(`/contacts/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: id, aliases: [], summary: "", importance: "normal", isFriend: false }) }); await contacts.reload(); }}><Plus size={15}/>{t("add")}</Button>} />}
    {tab === "groups" && <RecordList rows={groups.data ?? []} empty={t("noData")} render={(row) => <GroupEditor row={row} reload={groups.reload}/>} add={<Button onClick={async () => { const id = window.prompt(locale === "en" ? "OneBot group ID" : "OneBot 群 ID"); if (!id) return; await api(`/groups/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ name: id, summary: "" }) }); await groups.reload(); }}><Plus size={15}/>{t("add")}</Button>} />}
  </>;
}

function RecordList({ rows, render, empty, add }: { rows: any[]; render: (row: any) => ReactNode; empty: string; add?: ReactNode }) {
  return <Card title={`${rows.length}`} action={add}>{rows.length ? <div className="record-list">{rows.map((row) => <article key={row.id}>{render(row)}</article>)}</div> : <Empty>{empty}</Empty>}</Card>;
}

function MemoryEditor({ row, reload, locale }: { row: AnyRecord; reload: () => Promise<void>; locale: Locale }) {
  const [draft, setDraft] = useState(row);
  return <div className="record-editor"><div className="record-fields"><input value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })}/><textarea value={draft.details ?? ""} onChange={(event) => setDraft({ ...draft, details: event.target.value })}/><small>{new Date(draft.occurredAt).toLocaleString(locale)}</small></div><div className="record-actions"><Button onClick={async () => { await api(`/memories/${row.id}`, { method: "PUT", body: JSON.stringify(draft) }); await reload(); }}><Save size={15}/></Button><Button tone="danger" onClick={async () => { await api(`/memories/${row.id}`, { method: "DELETE" }); await reload(); }}><Trash2 size={15}/></Button></div></div>;
}

function ContactEditor({ row, reload, locale }: { row: AnyRecord; reload: () => Promise<void>; locale: Locale }) {
  const [draft, setDraft] = useState(row);
  return <div className="record-editor"><div className="record-fields"><div className="inline-fields"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/><select value={draft.importance} onChange={(event) => setDraft({ ...draft, importance: event.target.value })}>{["priority_plus", "priority", "normal", "do_not_disturb", "no_push"].map((value) => <option key={value}>{value}</option>)}</select></div><textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })}/><small>{row.id} · {locale === "en" ? "aliases" : "别名"}: {(draft.aliases ?? []).join(", ") || "—"}</small></div><div className="record-actions"><Button onClick={async () => { await api(`/contacts/${row.id}`, { method: "PUT", body: JSON.stringify(draft) }); await reload(); }}><Save size={15}/></Button><Button tone="danger" onClick={async () => { await api(`/contacts/${row.id}`, { method: "DELETE" }); await reload(); }}><Trash2 size={15}/></Button></div></div>;
}

function GroupEditor({ row, reload }: { row: AnyRecord; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState(row);
  return <div className="record-editor"><div className="record-fields"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })}/><textarea value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })}/><small>{row.id}</small></div><div className="record-actions"><Button onClick={async () => { await api(`/groups/${row.id}`, { method: "PUT", body: JSON.stringify(draft) }); await reload(); }}><Save size={15}/></Button><Button tone="danger" onClick={async () => { await api(`/groups/${row.id}`, { method: "DELETE" }); await reload(); }}><Trash2 size={15}/></Button></div></div>;
}

function AgentsPage({ locale }: { locale: Locale }) {
  const t = useCopy(locale);
  const settings = useLoad<AnyRecord>(() => api("/settings"), []);
  const providers = useLoad<any[]>(() => api("/providers"), []);
  const [active, setActive] = useState<"simulation" | "synthesis">("simulation");
  const prompt = useLoad<AnyRecord>(() => api(`/prompts/${active}`), [active]);
  const [promptDraft, setPromptDraft] = useState("");
  useEffect(() => { setPromptDraft(prompt.data?.current.template ?? ""); }, [prompt.data]);
  const updateAgent = async (field: string, value: string) => {
    if (!settings.data) return;
    const next = structuredClone(settings.data);
    const selected = next.value.agents[active];
    if (field === "providerId") { selected.providerId = value; selected.modelId = null; }
    else selected[field] = value;
    settings.setData(await api("/settings", { method: "PUT", body: JSON.stringify(next) }));
  };
  const selected = settings.data?.value.agents[active];
  const provider = providers.data?.find((item) => item.id === selected?.providerId);
  return <>
    <PageTitle eyebrow={locale === "en" ? "INTELLIGENCE" : "智能"} title={t("agents")} detail={locale === "en" ? "Two minds, each with its own model and responsibility." : "两个职责清晰、可独立选择模型的 Agent。"}/>
    <div className="segmented"><button className={active === "simulation" ? "active" : ""} onClick={() => setActive("simulation")}>{t("simulation")}</button><button className={active === "synthesis" ? "active" : ""} onClick={() => setActive("synthesis")}>{t("synthesis")}</button></div>
    <Card title={active === "simulation" ? t("simulation") : t("synthesis")} subtitle={active === "simulation" ? "SimulationAgent" : "SynthesisAgent"}>
      <div className="form-grid"><Field label={locale === "en" ? "Provider" : "提供商"}><select value={selected?.providerId ?? ""} onChange={(e) => updateAgent("providerId", e.target.value)}><option value="">—</option>{providers.data?.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label={t("model")}><select value={selected?.modelId ?? ""} onChange={(e) => updateAgent("modelId", e.target.value)}><option value="">—</option>{provider?.models.map((item: any) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></Field><Field label={t("thinking")}><select value={selected?.thinkingLevel ?? "medium"} onChange={(e) => updateAgent("thinkingLevel", e.target.value)}>{["off", "minimal", "low", "medium", "high", "xhigh"].map((item) => <option key={item}>{item}</option>)}</select></Field></div>
    </Card>
    <Card title={t("prompt")} subtitle={locale === "en" ? "Changes apply on the next run. Required placeholders are validated." : "修改在下次运行生效，必需占位符会被校验。"} action={<div className="button-row"><Button onClick={async () => { await api(`/prompts/${active}/reset`, { method: "POST" }); await prompt.reload(); }}><RefreshCw size={15}/>{t("restore")}</Button><Button tone="primary" onClick={async () => { await api(`/prompts/${active}`, { method: "PUT", body: JSON.stringify({ template: promptDraft }) }); await prompt.reload(); }}><Save size={15}/>{t("save")}</Button></div>}>
      <textarea className="prompt-editor" value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)}/>
      <small className="muted">{prompt.data?.versions.length ?? 0} versions</small>
    </Card>
  </>;
}

function ConnectionsPage({ locale }: { locale: Locale }) {
  const t = useCopy(locale);
  const providers = useLoad<any[]>(() => api("/providers"), []);
  const runtime = useLoad<AnyRecord>(() => api("/runtime"), []);
  const settings = useLoad<AnyRecord>(() => api("/settings"), []);
  const [search, setSearch] = useState("");
  const [keyFor, setKeyFor] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [onebotDraft, setOnebotDraft] = useState<AnyRecord | null>(null);
  const [oauthFlow, setOauthFlow] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [custom, setCustom] = useState({ id: "", name: "", baseUrl: "", apiKey: "" });
  useEffect(() => { if (settings.data) setOnebotDraft(structuredClone(settings.data)); }, [settings.data]);
  const visible = useMemo(() => providers.data?.filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase())) ?? [], [providers.data, search]);
  return <>
    <PageTitle eyebrow={locale === "en" ? "INTEGRATIONS" : "集成"} title={t("connections")} detail={locale === "en" ? "Models and messages meet here." : "模型与消息平台在这里汇合。"}/>
    <Card title={t("onebot")} action={<div className="button-row"><Pill tone={runtime.data?.onebot.connected ? "good" : "neutral"}>{runtime.data?.onebot.connected ? t("online") : t("offline")}</Pill>{onebotDraft && <Button tone="primary" onClick={async () => { const saved = await api<AnyRecord>("/settings", { method: "PUT", body: JSON.stringify(onebotDraft) }); settings.setData(saved); setOnebotDraft(structuredClone(saved)); }}><Save size={14}/>{t("save")}</Button>}</div>}>
      <div className="connection-row"><div className="connection-icon"><MessageCircle/></div><div><strong>ws://127.0.0.1:21314/onebot/v11/ws</strong><small>X-Self-ID · X-Client-Role · Bearer Token</small></div></div>
      {onebotDraft && <><Field label={locale === "en" ? "Access token" : "接入 Token"}><input type="password" value={onebotDraft.value.onebot.accessToken} onChange={(event) => setOnebotDraft({ ...onebotDraft, value: { ...onebotDraft.value, onebot: { ...onebotDraft.value.onebot, accessToken: event.target.value } } })}/></Field><div className="form-grid"><Field label={locale === "en" ? "Private allowlist (comma separated; empty = all)" : "私聊白名单（逗号分隔；空为全部）"}><input value={onebotDraft.value.onebot.privateAllowlist.join(", ")} onChange={(event) => setOnebotDraft({ ...onebotDraft, value: { ...onebotDraft.value, onebot: { ...onebotDraft.value.onebot, privateAllowlist: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } } })}/></Field><Field label={locale === "en" ? "Group allowlist (comma separated; empty = all)" : "群聊白名单（逗号分隔；空为全部）"}><input value={onebotDraft.value.onebot.groupAllowlist.join(", ")} onChange={(event) => setOnebotDraft({ ...onebotDraft, value: { ...onebotDraft.value, onebot: { ...onebotDraft.value.onebot, groupAllowlist: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } } })}/></Field></div></>}
    </Card>
    <Card title={t("providers")} action={<div className="button-row"><input className="search" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)}/><Button onClick={() => setShowCustom((value) => !value)}><Plus size={14}/>{t("custom")}</Button></div>}>
      {showCustom && <form className="custom-provider" onSubmit={async (event) => { event.preventDefault(); await api(`/custom-providers/${encodeURIComponent(custom.id)}`, { method: "PUT", body: JSON.stringify({ ...custom, models: [] }) }); setCustom({ id: "", name: "", baseUrl: "", apiKey: "" }); setShowCustom(false); await providers.reload(); }}><div className="form-grid three"><Field label="Provider ID"><input required pattern="[A-Za-z0-9][A-Za-z0-9_-]+" value={custom.id} onChange={(event) => setCustom({ ...custom, id: event.target.value })}/></Field><Field label={locale === "en" ? "Display name" : "显示名称"}><input required value={custom.name} onChange={(event) => setCustom({ ...custom, name: event.target.value })}/></Field><Field label="Base URL"><input required type="url" value={custom.baseUrl} onChange={(event) => setCustom({ ...custom, baseUrl: event.target.value })}/></Field></div><div className="inline-fields"><input type="password" placeholder={t("apiKey")} value={custom.apiKey} onChange={(event) => setCustom({ ...custom, apiKey: event.target.value })}/><Button tone="primary" type="submit"><Save size={14}/>{t("save")}</Button></div></form>}
      {oauthFlow && <OAuthFlow flowId={oauthFlow} locale={locale} close={() => setOauthFlow(null)}/>}
      <div className="provider-grid">{visible.map((item) => <article className="provider" key={item.id}><div className="provider-top"><div className="provider-logo">{item.name.slice(0, 1)}</div><Pill tone={item.auth.configured ? "good" : "neutral"}>{item.auth.configured ? t("connected") : t("notConnected")}</Pill></div><strong>{item.name}</strong><small>{item.id} · {item.models.length} {t("models")}</small><div className="provider-actions">{item.auth.apiKey && <Button onClick={() => { setKeyFor(item.id); setKey(""); }}><KeyRound size={14}/>{t("apiKey")}</Button>}{item.auth.oauth && <Button onClick={async () => { const flow = await api<AnyRecord>(`/providers/${item.id}/login`, { method: "POST", body: JSON.stringify({ type: "oauth" }) }); setOauthFlow(flow.flowId); }}><Globe2 size={14}/>OAuth</Button>}<Button onClick={async () => { await api(`/providers/${item.id}/refresh`, { method: "POST" }); await providers.reload(); }}><RefreshCw size={14}/></Button></div>{keyFor === item.id && <form onSubmit={async (event) => { event.preventDefault(); await api(`/providers/${item.id}/key`, { method: "PUT", body: JSON.stringify({ key }) }); setKeyFor(null); await providers.reload(); }} className="inline-key"><input autoFocus type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={t("apiKey")}/><Button tone="primary" type="submit">{t("save")}</Button></form>}</article>)}</div>
    </Card>
  </>;
}

function OAuthFlow({ flowId, locale, close }: { flowId: string; locale: Locale; close: () => void }) {
  const [flow, setFlow] = useState<AnyRecord | null>(null);
  const [answer, setAnswer] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => { const value = await api<AnyRecord>(`/auth-flows/${flowId}`); if (active) setFlow(value); };
    void refresh(); const timer = setInterval(() => { void refresh(); }, 1_000);
    return () => { active = false; clearInterval(timer); };
  }, [flowId]);
  const prompt = [...(flow?.events ?? [])].reverse().find((event: AnyRecord) => event.type === "prompt");
  return <div className="oauth-panel"><div><strong>OAuth · {flow?.providerId}</strong><small>{flow?.state ?? "starting"}</small></div><pre>{JSON.stringify(flow?.events ?? [], null, 2)}</pre>{prompt && flow?.state === "running" && <form className="inline-key" onSubmit={async (event) => { event.preventDefault(); await api(`/auth-flows/${flowId}/answer`, { method: "POST", body: JSON.stringify({ answer }) }); setAnswer(""); }}><input value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder={locale === "en" ? "Authorization answer or code" : "授权回答或验证码"}/><Button tone="primary" type="submit">{locale === "en" ? "Answer" : "提交"}</Button></form>}<Button onClick={async () => { if (flow?.state === "running") await api(`/auth-flows/${flowId}`, { method: "DELETE" }); close(); }}>{flow?.state === "running" ? (locale === "en" ? "Cancel" : "取消") : (locale === "en" ? "Close" : "关闭")}</Button></div>;
}

function ActivityPage({ locale }: { locale: Locale }) {
  const t = useCopy(locale);
  const runs = useLoad<any[]>(() => api("/activity/runs?limit=100"), []);
  const [selected, setSelected] = useState<any | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const open = async (run: any) => { setSelected(run); const result = await api<AnyRecord>(`/activity/runs/${run.id}`); setMessages(result.messages); };
  return <>
    <PageTitle eyebrow="TRACE" title={t("activity")} detail={locale === "en" ? "Every run, thought, tool, and outcome remains inspectable." : "每次运行、推理、工具与结果都可以追溯。"} action={<Button onClick={() => runs.reload()}><RefreshCw size={15}/>{t("refresh")}</Button>}/>
    <div className="activity-layout"><Card title={t("allRuns")} className="run-list">{runs.data?.length ? runs.data.map((run) => <button key={run.id} className={selected?.id === run.id ? "active" : ""} onClick={() => open(run)}><span className={`run-dot ${run.status}`}/><div><strong>{run.agent === "simulation" ? t("simulation") : t("synthesis")}</strong><small>{new Date(run.startedAt).toLocaleString(locale)}</small><p>{run.trigger}</p></div><Pill tone={run.status === "completed" ? "good" : run.status === "failed" ? "bad" : "neutral"}>{run.status}</Pill></button>) : <Empty>{t("noData")}</Empty>}</Card><Card title={selected ? selected.trigger : "Trace"} className="trace">{selected ? <div className="timeline">{messages.map((message) => <article key={message.id} className={message.role}><header><Pill tone={message.role === "reasoning" ? "warn" : "neutral"}>{message.role === "director" ? t("director") : message.role === "reasoning" ? t("reasoning") : message.role}</Pill><time>{new Date(message.occurredAt).toLocaleTimeString(locale)}</time></header>{message.role === "reasoning" ? <details><summary>{locale === "en" ? "Show reasoning" : "展开推理"}</summary><pre>{message.content}</pre></details> : <pre>{message.content}</pre>}</article>)}</div> : <Empty>{locale === "en" ? "Select a run." : "选择一次运行查看详情。"}</Empty>}</Card></div>
  </>;
}

function SettingsPage({ locale, setLocale }: { locale: Locale; setLocale: (value: Locale) => void }) {
  const t = useCopy(locale);
  const settings = useLoad<AnyRecord>(() => api("/settings"), []);
  const [draft, setDraft] = useState<AnyRecord | null>(null);
  useEffect(() => { if (settings.data) setDraft(structuredClone(settings.data)); }, [settings.data]);
  if (!draft) return <Empty>Loading…</Empty>;
  const set = (path: string, value: number | string) => {
    const next = structuredClone(draft); const keys = path.split("."); let cursor = next.value;
    for (const key of keys.slice(0, -1)) cursor = cursor[key]; cursor[keys.at(-1)!] = value; setDraft(next);
  };
  return <>
    <PageTitle eyebrow={locale === "en" ? "PREFERENCES" : "偏好设置"} title={t("settings")} detail={locale === "en" ? "Safe defaults, adjustable when your character needs more room." : "安全默认值，也为角色保留足够的调整空间。"} action={<Button tone="primary" onClick={async () => setDraft(await api("/settings", { method: "PUT", body: JSON.stringify(draft) }))}><Save size={15}/>{t("save")}</Button>}/>
    <div className="split"><Card title={t("language")}><div className="setting-line"><div><Languages/><strong>English / 简体中文</strong></div><select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}><option value="en">English</option><option value="zh-CN">简体中文</option></select></div><div className="form-grid"><Field label={locale === "en" ? "Bind address (restart required)" : "监听地址（需重启）"}><input value={draft.value.web.host} onChange={(event) => set("web.host", event.target.value)}/></Field><NumberField label={locale === "en" ? "Port (restart required)" : "端口（需重启）"} value={draft.value.web.port} onChange={(value) => set("web.port", value)}/></div></Card><Card title={locale === "en" ? "Portability" : "迁移与备份"}><div className="button-stack"><a className="download" href="/api/v1/export/character"><Download size={17}/>{t("exportCharacter")}</a><label className="download upload"><Upload size={17}/>{locale === "en" ? "Import character package" : "导入角色包"}<input hidden type="file" accept="application/json,.json" onChange={async (event) => { const file = event.target.files?.[0]; if (!file) return; await api("/import/character", { method: "POST", body: await file.text() }); window.location.reload(); }}/></label></div></Card></div>
    <Card title={locale === "en" ? "Simulation boundaries" : "推演边界"}><div className="form-grid three"><NumberField label={locale === "en" ? "Idle minimum (min)" : "自娱最短（分钟）"} value={draft.value.simulation.idleMinMinutes} onChange={(v) => set("simulation.idleMinMinutes", v)}/><NumberField label={locale === "en" ? "Idle maximum (min)" : "自娱最长（分钟）"} value={draft.value.simulation.idleMaxMinutes} onChange={(v) => set("simulation.idleMaxMinutes", v)}/><NumberField label={locale === "en" ? "Notification window (ms)" : "通知合并窗口（毫秒）"} value={draft.value.simulation.notificationWindowMs} onChange={(v) => set("simulation.notificationWindowMs", v)}/><NumberField label={locale === "en" ? "Sleep minimum (min)" : "睡眠最短（分钟）"} value={draft.value.simulation.sleepMinMinutes} onChange={(v) => set("simulation.sleepMinMinutes", v)}/><NumberField label={locale === "en" ? "Sleep maximum (min)" : "睡眠最长（分钟）"} value={draft.value.simulation.sleepMaxMinutes} onChange={(v) => set("simulation.sleepMaxMinutes", v)}/><NumberField label={locale === "en" ? "Priority wake probability" : "特别关心唤醒概率"} value={draft.value.simulation.priorityWakeProbability} step={0.05} onChange={(v) => set("simulation.priorityWakeProbability", v)}/></div></Card>
    <Card title={locale === "en" ? "Memory & synthesis" : "记忆与归纳"}><div className="form-grid three"><NumberField label={locale === "en" ? "Memory soft tokens" : "记忆软上限"} value={draft.value.synthesis.memorySoftTokens} onChange={(v) => set("synthesis.memorySoftTokens", v)}/><NumberField label={locale === "en" ? "Memory hard tokens" : "记忆硬上限"} value={draft.value.synthesis.memoryHardTokens} onChange={(v) => set("synthesis.memoryHardTokens", v)}/><NumberField label={locale === "en" ? "Retries" : "重试次数"} value={draft.value.synthesis.retryCount} onChange={(v) => set("synthesis.retryCount", v)}/></div><div className="warning"><Database size={18}/>{locale === "en" ? "Full database backups contain plaintext provider credentials." : "完整数据库备份包含明文提供商凭据。"}</div></Card>
    <details className="advanced"><summary>{locale === "en" ? "Advanced context and message controls" : "高级上下文与消息参数"}</summary><Card title={locale === "en" ? "Advanced" : "高级参数"}><div className="form-grid three"><NumberField label={locale === "en" ? "Chat preview messages" : "聊天预览条数"} value={draft.value.simulation.chatPreviewMessages} onChange={(v) => set("simulation.chatPreviewMessages", v)}/><NumberField label={locale === "en" ? "History maximum" : "历史加载上限"} value={draft.value.simulation.historyMaxMessages} onChange={(v) => set("simulation.historyMaxMessages", v)}/><NumberField label={locale === "en" ? "Message interval (ms)" : "消息发送间隔（毫秒）"} value={draft.value.simulation.messageIntervalMs} onChange={(v) => set("simulation.messageIntervalMs", v)}/><NumberField label={locale === "en" ? "Archive tokens" : "归纳触发 Token"} value={draft.value.simulation.contextArchiveTokens} onChange={(v) => set("simulation.contextArchiveTokens", v)}/><NumberField label={locale === "en" ? "Model context ratio" : "模型上下文比例"} value={draft.value.simulation.contextModelRatio} step={0.05} onChange={(v) => set("simulation.contextModelRatio", v)}/><NumberField label={locale === "en" ? "Retained messages" : "保留完整消息数"} value={draft.value.simulation.retainedContextMessages} onChange={(v) => set("simulation.retainedContextMessages", v)}/><NumberField label={locale === "en" ? "Synthesis retry base (ms)" : "归纳重试基数（毫秒）"} value={draft.value.synthesis.retryBaseDelayMs} onChange={(v) => set("synthesis.retryBaseDelayMs", v)}/><NumberField label={locale === "en" ? "OneBot API timeout (ms)" : "OneBot API 超时（毫秒）"} value={draft.value.onebot.apiTimeoutMs} onChange={(v) => set("onebot.apiTimeoutMs", v)}/></div></Card></details>
  </>;
}

function NumberField({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (value: number) => void; step?: number }) {
  return <Field label={label}><input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}/></Field>;
}

export function App() {
  const guessed = navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  const [locale, setLocaleState] = useState<Locale>((localStorage.getItem("moonan-locale") as Locale) || guessed);
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [section, setSection] = useState<Section>("overview");
  const setLocale = (value: Locale) => { localStorage.setItem("moonan-locale", value); setLocaleState(value); };
  useEffect(() => { void session().then(setAuthenticated); }, []);
  if (authenticated === null) return <main className="splash"><Moon className="pulse"/></main>;
  if (!authenticated) return <Login locale={locale} setLocale={setLocale} onLogin={() => setAuthenticated(true)}/>;
  const logout = async () => { await api("/auth/logout", { method: "POST" }); setAuthenticated(false); };
  return <Shell section={section} setSection={setSection} locale={locale} setLocale={setLocale} logout={logout}>
    {section === "overview" && <OverviewPage locale={locale}/>} {section === "character" && <CharacterPage locale={locale}/>} {section === "agents" && <AgentsPage locale={locale}/>} {section === "connections" && <ConnectionsPage locale={locale}/>} {section === "activity" && <ActivityPage locale={locale}/>} {section === "settings" && <SettingsPage locale={locale} setLocale={setLocale}/>}
  </Shell>;
}

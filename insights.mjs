import { readFile, readdir, stat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DAY_MS = 86_400_000;
const MAX_INVENTORY_FILES = 2_000;
const MAX_PAYLOAD_BYTES = 1_000_000;

export function localDate(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function defaultSettings(dataRoot) {
  return {
    scheduleTime: "23:30",
    enabled: true,
    inactiveToolDays: 30,
    inactiveSkillDays: 30,
    inactiveMcpDays: 30,
    retentionDays: 365,
    llmEnabled: false,
    llmBaseUrl: "https://api.openai.com/v1",
    llmModel: "",
    llmApiKey: "",
    llmTimeoutSeconds: 60,
    agentEnabled: false,
    agentMaxRounds: 40,
    agentMaxTokens: 200_000,
    agentMaxInputBytes: 2_000_000,
    agentMaxPayloadBytes: 1_000_000,
    agentMaxDurationMinutes: 30,
    agentLookbackDays: 0,
    agentProjectAllowlist: [],
    agentAllowPayloads: true,
    dataRoot,
    lastScheduledRunDate: null,
  };
}

export function validateSettings(input, current) {
  const next = { ...current };
  const legacyAgentOnly = Boolean(input.agentModel) && (!input.llmModel || (input.agentEnabled && !input.llmEnabled));
  const sharedInput = legacyAgentOnly ? {
    ...input,
    llmBaseUrl: input.agentBaseUrl ?? input.llmBaseUrl,
    llmModel: input.agentModel,
    llmApiKey: input.agentApiKey ?? input.llmApiKey,
    llmTimeoutSeconds: input.agentTimeoutSeconds ?? input.llmTimeoutSeconds,
  } : input;
  if (typeof input.enabled === "boolean") next.enabled = input.enabled;
  if (typeof input.scheduleTime === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(input.scheduleTime)) {
    next.scheduleTime = input.scheduleTime;
  } else if (input.scheduleTime !== undefined) {
    throw new Error("scheduleTime must use HH:MM in local time");
  }
  for (const key of ["inactiveToolDays", "inactiveSkillDays", "inactiveMcpDays", "retentionDays"]) {
    if (input[key] !== undefined) {
      const value = Number(input[key]);
      if (!Number.isInteger(value) || value < 1 || value > 3_650) throw new Error(`${key} must be an integer from 1 to 3650`);
      next[key] = value;
    }
  }
  if (typeof input.llmEnabled === "boolean") next.llmEnabled = input.llmEnabled;
  if (sharedInput.llmBaseUrl !== undefined) next.llmBaseUrl = validateLlmBaseUrl(sharedInput.llmBaseUrl);
  if (sharedInput.llmModel !== undefined) {
    if (typeof sharedInput.llmModel !== "string" || sharedInput.llmModel.trim().length > 200) throw new Error("llmModel must be a string up to 200 characters");
    next.llmModel = sharedInput.llmModel.trim();
  }
  if (sharedInput.clearLlmApiKey === true || sharedInput.clearAgentApiKey === true) next.llmApiKey = "";
  else if (sharedInput.llmApiKey !== undefined) {
    if (typeof sharedInput.llmApiKey !== "string" || sharedInput.llmApiKey.trim().length > 4_096) throw new Error("llmApiKey must be a string up to 4096 characters");
    next.llmApiKey = sharedInput.llmApiKey.trim();
  }
  if (sharedInput.llmTimeoutSeconds !== undefined) {
    const value = Number(sharedInput.llmTimeoutSeconds);
    if (!Number.isInteger(value) || value < 5 || value > 600) throw new Error("llmTimeoutSeconds must be an integer from 5 to 600");
    next.llmTimeoutSeconds = value;
  }
  if (typeof input.agentEnabled === "boolean") next.agentEnabled = input.agentEnabled;
  for (const [key, min, max] of [
    ["agentMaxRounds", 1, 200],
    ["agentMaxTokens", 1_000, 10_000_000],
    ["agentMaxInputBytes", 16_384, 50_000_000],
    ["agentMaxPayloadBytes", 1_024, 5_000_000],
    ["agentMaxDurationMinutes", 1, 1_440],
    ["agentLookbackDays", 0, 3_650],
  ]) {
    if (input[key] === undefined) continue;
    const value = Number(input[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
    next[key] = value;
  }
  if (input.agentProjectAllowlist !== undefined) {
    if (!Array.isArray(input.agentProjectAllowlist) || input.agentProjectAllowlist.length > 100) throw new Error("agentProjectAllowlist must be an array with at most 100 paths");
    next.agentProjectAllowlist = [...new Set(input.agentProjectAllowlist.map((item) => {
      if (typeof item !== "string" || !item.trim() || item.trim().length > 2_048) throw new Error("agentProjectAllowlist entries must be non-empty paths up to 2048 characters");
      return path.resolve(item.trim());
    }))];
  }
  if (typeof input.agentAllowPayloads === "boolean") next.agentAllowPayloads = input.agentAllowPayloads;
  if ((next.llmEnabled || next.agentEnabled) && !next.llmModel) throw new Error("启用模型功能时必须先发现并选择模型");
  delete next.agentBaseUrl;
  delete next.agentModel;
  delete next.agentApiKey;
  delete next.agentTimeoutSeconds;
  return next;
}

export function settingsForClient(settings) {
  const { llmApiKey, agentApiKey: _agentApiKey, agentBaseUrl: _agentBaseUrl, agentModel: _agentModel, agentTimeoutSeconds: _agentTimeoutSeconds, ...visible } = settings;
  return { ...visible, llmApiKeyConfigured: Boolean(llmApiKey) };
}

function validateLlmBaseUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 2_048) throw new Error("llmBaseUrl must be a URL up to 2048 characters");
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("llmBaseUrl must be a valid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("llmBaseUrl must use http or https");
  if (parsed.username || parsed.password) throw new Error("llmBaseUrl must not contain credentials");
  return value.trim().replace(/\/+$/, "");
}

export async function loadSettings(dataRoot) {
  const file = path.join(dataRoot, "settings.json");
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const settings = validateSettings(parsed, defaultSettings(dataRoot));
    if (/^\d{4}-\d{2}-\d{2}$/.test(parsed.lastScheduledRunDate || "")) settings.lastScheduledRunDate = parsed.lastScheduledRunDate;
    return settings;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return defaultSettings(dataRoot);
  }
}

export async function saveSettings(settings) {
  await writeJsonAtomic(path.join(settings.dataRoot, "settings.json"), settings);
}

export function shouldRunScheduledReview(settings, now = new Date()) {
  if (!settings.enabled || settings.lastScheduledRunDate === localDate(now.getTime())) return false;
  const [hour, minute] = settings.scheduleTime.split(":").map(Number);
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

export async function listReviews(dataRoot) {
  const reportsDir = path.join(dataRoot, "reports");
  try {
    const entries = await readdir(reportsDir, { withFileTypes: true });
    const reviews = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name)) continue;
      const report = JSON.parse(await readFile(path.join(reportsDir, entry.name), "utf8"));
      reviews.push(report);
    }
    return reviews.sort((a, b) => b.date.localeCompare(a.date));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function collectInventory(codexHome) {
  const [skills, mcpServers] = await Promise.all([
    collectSkills(codexHome),
    collectMcpServers(path.join(codexHome, "config.toml")),
  ]);
  return { skills, mcpServers };
}

async function collectSkills(codexHome) {
  const roots = [path.join(codexHome, "skills"), path.join(codexHome, "plugins", "cache")];
  const found = [];
  for (const root of roots) await walkSkillFiles(root, root, found);
  const unique = new Map();
  for (const skill of found) if (!unique.has(skill.id)) unique.set(skill.id, skill);
  return [...unique.values()].sort((a, b) => a.id.localeCompare(b.id));
}

async function walkSkillFiles(root, current, found) {
  if (found.length >= MAX_INVENTORY_FILES) return;
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (found.length >= MAX_INVENTORY_FILES) return;
    const file = path.join(current, entry.name);
    if (entry.isDirectory()) await walkSkillFiles(root, file, found);
    else if (entry.isFile() && entry.name === "SKILL.md") {
      const info = await stat(file);
      const relative = path.relative(root, path.dirname(file)).replaceAll("\\", "/");
      found.push({ id: relative || path.basename(path.dirname(file)), path: file, modifiedAtUnixMs: info.mtimeMs });
    }
  }
}

async function collectMcpServers(configPath) {
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch {
    return [];
  }
  const servers = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.trim().match(/^\[mcp_servers\.([^\]]+)\]$/);
    if (!match) continue;
    const rawId = match[1];
    const quoted = /^(['"]).*\1$/.test(rawId);
    if (!quoted && rawId.includes(".")) continue;
    const id = rawId.replace(/^['"]|['"]$/g, "");
    servers.set(id, { id });
  }
  return [...servers.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function buildDailyReview({ date, traces, inventory, previousReviews, bundleRoot, settings = defaultSettings("") }) {
  const selected = traces.filter((trace) => localDate(trace.started_at_unix_ms) === date);
  const report = {
    schemaVersion: 1,
    date,
    generatedAtUnixMs: Date.now(),
    summary: emptySummary(),
    sessions: [],
    models: {},
    providers: {},
    projects: {},
    toolKinds: {},
    toolUsage: {},
    mcpUsage: {},
    skillUsage: {},
    scenarioUsage: {},
    hourlyStarts: Array(24).fill(0),
    habits: [],
    cleanupRecommendations: [],
  };
  for (const trace of selected) await addTrace(report, trace, bundleRoot, inventory);
  report.habits = buildHabits(report, previousReviews);
  report.cleanupRecommendations = buildCleanupRecommendations(report, inventory, previousReviews, settings);
  return report;
}

function emptySummary() {
  return {
    sessions: 0, completedSessions: 0, activeMs: 0, runtimeTurns: 0, modelCalls: 0, toolCalls: 0,
    inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    userMessages: 0, userCharacters: 0,
  };
}

async function addTrace(report, trace, bundleRoot, inventory) {
  const calls = Object.values(trace.inference_calls || {});
  const tools = Object.values(trace.tool_calls || {});
  const turns = Object.values(trace.codex_turns || {});
  const ended = trace.ended_at_unix_ms || Math.max(trace.started_at_unix_ms, ...turns.map((turn) => turn.execution?.ended_at_unix_ms || 0));
  const activeMs = Math.max(0, ended - trace.started_at_unix_ms);
  const session = {
    traceId: trace.trace_id, rolloutId: trace.rollout_id, status: trace.status,
    startedAtUnixMs: trace.started_at_unix_ms, endedAtUnixMs: trace.ended_at_unix_ms,
    activeMs, runtimeTurns: turns.length, modelCalls: calls.length, toolCalls: tools.length,
    project: await traceProject(trace, bundleRoot),
  };
  const userText = traceUserText(trace);
  const scenario = classifyScenario(userText, tools);
  const scenarioStats = report.scenarioUsage[scenario] || {
    sessions: 0, modelCalls: 0, toolCalls: 0, tools: {}, skills: {}, projects: {}, examples: [],
  };
  scenarioStats.sessions += 1;
  scenarioStats.modelCalls += calls.length;
  scenarioStats.toolCalls += tools.length;
  if (session.project) increment(scenarioStats.projects, session.project);
  if (userText && scenarioStats.examples.length < 3) scenarioStats.examples.push(truncateText(redactSensitiveText(userText), 160));
  report.scenarioUsage[scenario] = scenarioStats;
  report.sessions.push(session);
  report.summary.sessions += 1;
  if (trace.status === "completed") report.summary.completedSessions += 1;
  report.summary.activeMs += activeMs;
  report.summary.runtimeTurns += turns.length;
  report.summary.modelCalls += calls.length;
  report.summary.toolCalls += tools.length;
  const userMessages = traceUserMessages(trace);
  report.summary.userMessages += userMessages.length;
  report.summary.userCharacters += userMessages.reduce((sum, message) => sum + message.length, 0);
  if (session.project) increment(report.projects, session.project);
  report.hourlyStarts[new Date(trace.started_at_unix_ms).getHours()] += 1;
  for (const call of calls) {
    increment(report.models, call.model || "unknown");
    increment(report.providers, call.provider_name || "unknown");
    report.summary.inputTokens += call.usage?.input_tokens || 0;
    report.summary.cachedInputTokens += call.usage?.cached_input_tokens || 0;
    report.summary.outputTokens += call.usage?.output_tokens || 0;
    report.summary.reasoningTokens += call.usage?.reasoning_output_tokens || 0;
  }
  for (const tool of tools) {
    const descriptor = describeTool(tool);
    increment(report.toolKinds, descriptor.kind);
    increment(report.toolUsage, descriptor.label);
    increment(scenarioStats.tools, descriptor.label);
    if (descriptor.mcpServer) increment(report.mcpUsage, descriptor.mcpServer);
  }
  await scanSkillUsage(report, trace, bundleRoot, inventory.skills, scenarioStats);
}

function traceUserText(trace) {
  return traceUserMessages(trace).join(" ");
}

function traceUserMessages(trace) {
  return Object.values(trace.conversation_items || {})
    .filter((item) => item.role === "user")
    .sort((left, right) => (left.first_seen_at_unix_ms || 0) - (right.first_seen_at_unix_ms || 0))
    .map(conversationItemText)
    .map(cleanUserMessage)
    .filter(Boolean)
}

function conversationItemText(item) {
  return (item.body?.parts || [])
    .map((part) => part.text || part.summary || part.source || part.value || "")
    .filter(Boolean)
    .join(" ");
}

function cleanUserMessage(value) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (/^(?:<environment_context>|<system(?:\s|>)|# AGENTS(?:\.md)?\b|# Files mentioned by the user:|You are a helpful assistant\. You will be presented with a user prompt)/i.test(normalized)) return "";
  return normalized;
}

function redactSensitiveText(value) {
  return value
    .replace(/((?:password|passwd|token|api[_ -]?key|secret|密码|口令)\s*(?:(?:是|为)|[:：=])\s*)[^\s,，;；]+/gi, "$1[已隐藏]")
    .replace(/(sk-[a-z0-9_-]{8,})/gi, "[已隐藏密钥]");
}

function classifyScenario(userText, tools) {
  const text = userText.toLowerCase();
  const rules = [
    ["部署运维", ["deploy", "deployment", "server", "ssh", "docker", "kubernetes", "port", "service", "上线", "部署", "服务器", "运维", "进程"]],
    ["问题排查", ["bug", "error", "failed", "failure", "debug", "issue", "broken", "报错", "错误", "失败", "故障", "排查", "修复"]],
    ["研究分析", ["research", "analyze", "analysis", "review", "compare", "explain", "summary", "investigate", "研究", "分析", "审查", "对比", "解释", "总结", "检查"]],
    ["代码开发", ["code", "coding", "implement", "refactor", "function", "api", "typescript", "javascript", "rust", "python", "编程", "代码", "实现", "重构", "开发"]],
    ["文档内容", ["readme", "document", "docs", "report", "write", "translate", "文章", "文档", "报告", "翻译", "写作"]],
    ["自动化流程", ["script", "automation", "automate", "workflow", "pipeline", "cron", "batch", "脚本", "自动化", "流程", "定时"]],
  ];
  for (const [scenario, keywords] of rules) if (keywords.some((keyword) => text.includes(keyword))) return scenario;
  const toolKinds = tools.map((tool) => describeTool(tool).kind);
  if (toolKinds.some((kind) => kind.includes("exec") || kind.includes("shell"))) return "代码开发";
  if (toolKinds.some((kind) => kind.startsWith("mcp:"))) return "研究分析";
  return "日常问答";
}

function describeTool(tool) {
  const rawKind = tool.kind;
  let kind = typeof rawKind === "string" ? rawKind : rawKind?.type || rawKind?.name || "unknown";
  let mcpServer = kind === "mcp" ? rawKind?.server : null;
  let mcpTool = kind === "mcp" ? rawKind?.tool : null;
  const summaryLabel = tool.summary?.label || "";
  const bridgedMcp = summaryLabel.match(/^mcp__([^.]*)\.(.+)$/);
  if (!mcpServer && bridgedMcp) {
    mcpServer = bridgedMcp[1];
    mcpTool = bridgedMcp[2];
    kind = `mcp:${mcpServer}`;
  }
  if (mcpServer) return { kind, mcpServer, label: `MCP ${mcpServer}/${mcpTool || "call"}` };
  if ((kind === "other" || kind === "unknown") && summaryLabel) return { kind, mcpServer: null, label: summaryLabel };
  return { kind, mcpServer: null, label: kind };
}

function truncateText(value, length) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

async function traceProject(trace, bundleRoot) {
  for (const reference of Object.values(trace.raw_payloads || {})) {
    if (reference.kind?.type !== "session_metadata") continue;
    const payload = await readPayload(reference, trace, bundleRoot);
    if (payload?.cwd) return payload.cwd;
    if (payload?.config?.cwd) return payload.config.cwd;
  }
  return null;
}

async function scanSkillUsage(report, trace, bundleRoot, skills, scenarioStats = null) {
  for (const reference of Object.values(trace.raw_payloads || {})) {
    if (reference.kind?.type !== "tool_invocation") continue;
    const payload = await readPayload(reference, trace, bundleRoot);
    for (const text of stringValues(payload)) {
      if (!/SKILL\.md/i.test(text)) continue;
      const normalized = normalizePathText(text);
      const matched = skills.filter((skill) => normalized.includes(normalizePathText(skill.path)));
      if (matched.length) {
        for (const skill of matched) {
          increment(report.skillUsage, skill.id);
          if (scenarioStats) increment(scenarioStats.skills, skill.id);
        }
      } else {
        const fallback = normalized.match(/\/([^/]+)\/skill\.md/i)?.[1];
        if (fallback) {
          increment(report.skillUsage, fallback);
          if (scenarioStats) increment(scenarioStats.skills, fallback);
        }
      }
    }
  }
}

function normalizePathText(value) {
  return value.replaceAll("\\", "/").replace(/\/{2,}/g, "/").toLowerCase();
}

function stringValues(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) for (const item of value) stringValues(item, output);
  else if (value && typeof value === "object") for (const item of Object.values(value)) stringValues(item, output);
  return output;
}

async function readPayload(reference, trace, bundleRoot) {
  if (!bundleRoot || !trace.__bundleId || !reference.path) return null;
  const file = path.join(bundleRoot, trace.__bundleId, reference.path);
  try {
    const info = await stat(file);
    if (info.size > MAX_PAYLOAD_BYTES) return null;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function buildHabits(report, previousReviews) {
  const habits = [];
  const busiestHour = report.hourlyStarts.indexOf(Math.max(...report.hourlyStarts));
  if (report.summary.sessions) habits.push(`今天启动了 ${report.summary.sessions} 个 session，最常开始工作的时段是 ${String(busiestHour).padStart(2, "0")}:00。`);
  if (report.summary.modelCalls) {
    const callsPerTurn = report.summary.modelCalls / Math.max(1, report.summary.runtimeTurns);
    habits.push(`每个 runtime turn 平均触发 ${callsPerTurn.toFixed(1)} 次模型调用。`);
  }
  const topScenario = Object.entries(report.scenarioUsage || {}).sort(([, left], [, right]) => right.sessions - left.sessions)[0];
  if (topScenario) habits.push(`最常见的使用场景是 ${topScenario[0]}，涉及 ${topScenario[1].sessions} 个 session。`);
  const topTool = topEntry(report.toolUsage || report.toolKinds);
  if (topTool) habits.push(`最常用工具是 ${topTool[0]}，共 ${topTool[1]} 次。`);
  const topSkill = topEntry(report.skillUsage);
  if (topSkill) habits.push(`最常使用的 Skill 是 ${skillDisplayName(topSkill[0])}，共观察到 ${topSkill[1]} 次。`);
  const topMcp = topEntry(report.mcpUsage);
  if (topMcp) habits.push(`最常使用的 MCP 服务是 ${topMcp[0]}，共 ${topMcp[1]} 次调用。`);
  if (report.summary.userMessages) habits.push(`共发送 ${report.summary.userMessages} 条用户消息，平均每条 ${Math.round(report.summary.userCharacters / report.summary.userMessages)} 个字符。`);
  const topProject = topEntry(report.projects);
  if (topProject) habits.push(`最常使用 Codex 的项目是 ${projectDisplayName(topProject[0])}，涉及 ${topProject[1]} 个 session。`);
  if (report.summary.inputTokens) {
    const cacheRate = report.summary.cachedInputTokens / report.summary.inputTokens * 100;
    habits.push(`输入 token 缓存命中占比约 ${cacheRate.toFixed(1)}%。`);
  }
  const recent = previousReviews.slice(0, 7);
  if (recent.length) {
    const averageSessions = recent.reduce((sum, item) => sum + item.summary.sessions, 0) / recent.length;
    habits.push(`过去 ${recent.length} 个有记录日平均 ${averageSessions.toFixed(1)} 个 session。`);
  }
  return habits;
}

function buildCleanupRecommendations(report, inventory, previousReviews, settings) {
  const recommendations = [];
  const oldestDate = [report, ...previousReviews].map((item) => item.date).sort()[0];
  const observedDays = Math.floor((new Date(`${report.date}T00:00:00`).getTime() - new Date(`${oldestDate}T00:00:00`).getTime()) / DAY_MS) + 1;
  const toolLastUsed = historicalLastUsed("toolUsage", report, previousReviews);
  for (const [id, date] of historicalLastUsed("toolKinds", report, previousReviews)) if (!toolLastUsed.has(id)) toolLastUsed.set(id, date);
  const skillLastUsed = historicalLastUsed("skillUsage", report, previousReviews);
  const mcpLastUsed = historicalLastUsed("mcpUsage", report, previousReviews);
  for (const [id, lastUsed] of toolLastUsed) {
    const item = cleanupItem("tool", id, lastUsed, report.date, observedDays);
    if (item.inactiveDays >= settings.inactiveToolDays) recommendations.push(item);
  }
  for (const skill of inventory.skills) {
    const lastUsed = skillLastUsed.get(skill.id) || matchLastUsed(skillLastUsed, skill.id);
    if (!lastUsed && observedDays < settings.inactiveSkillDays) continue;
    const item = cleanupItem("skill", skill.id, lastUsed, report.date, observedDays);
    if (item.inactiveDays >= settings.inactiveSkillDays) recommendations.push(item);
  }
  for (const server of inventory.mcpServers) {
    const lastUsed = mcpLastUsed.get(server.id);
    if (!lastUsed && observedDays < settings.inactiveMcpDays) continue;
    const item = cleanupItem("mcp", server.id, lastUsed, report.date, observedDays);
    if (item.inactiveDays >= settings.inactiveMcpDays) recommendations.push(item);
  }
  return recommendations.filter(Boolean).sort((a, b) => b.inactiveDays - a.inactiveDays).slice(0, 50);
}

function historicalLastUsed(field, report, previousReviews) {
  const result = new Map();
  for (const item of [report, ...previousReviews]) {
    for (const [id, count] of Object.entries(item[field] || {})) if (count && !result.has(id)) result.set(id, item.date);
  }
  return result;
}

function matchLastUsed(map, id) {
  const normalized = id.toLowerCase();
  for (const [key, value] of map) if (normalized.includes(key.toLowerCase()) || key.toLowerCase().includes(normalized)) return value;
  return null;
}

function cleanupItem(type, id, lastUsed, reportDate, observedDays) {
  const inactiveDays = lastUsed
    ? Math.floor((new Date(`${reportDate}T00:00:00`).getTime() - new Date(`${lastUsed}T00:00:00`).getTime()) / DAY_MS)
    : observedDays;
  return { type, id, lastUsed, inactiveDays, reason: lastUsed ? `已 ${inactiveDays} 天未观察到使用` : `连续 ${observedDays} 天未观察到使用` };
}

function topEntry(record) {
  return Object.entries(record).sort((a, b) => b[1] - a[1])[0] || null;
}

function topEntries(record, limit = 3) {
  return Object.entries(record || {})
    .sort(([, left], [, right]) => right - left)
    .slice(0, limit)
    .map(([name, count]) => `${name} (${count})`);
}

function skillDisplayName(value) {
  const normalized = String(value).replaceAll("\\", "/");
  const marker = normalized.toLowerCase().lastIndexOf("/skills/");
  return marker >= 0 ? normalized.slice(marker + "/skills/".length) : normalized.split("/").at(-1) || normalized;
}

function projectDisplayName(value) {
  const normalized = String(value).replaceAll("\\", "/");
  return normalized.split("/").filter(Boolean).at(-1) || normalized;
}

function entriesAsMarkdown(record) {
  return Object.entries(record || {})
    .sort(([, left], [, right]) => right - left)
    .map(([name, count]) => `- ${name}: ${count}`);
}

export async function storeReview(report, dataRoot) {
  const reportsDir = path.join(dataRoot, "reports");
  await mkdir(reportsDir, { recursive: true });
  await writeJsonAtomic(path.join(reportsDir, `${report.date}.json`), report);
  await writeFile(path.join(reportsDir, `${report.date}.md`), renderMarkdown(report), "utf8");
}

export async function pruneReviews(dataRoot, retentionDays, now = Date.now()) {
  const reportsDir = path.join(dataRoot, "reports");
  let entries;
  try {
    entries = await readdir(reportsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const cutoff = now - retentionDays * DAY_MS;
  for (const entry of entries) {
    const match = entry.name.match(/^(\d{4}-\d{2}-\d{2})\.(json|md)$/);
    if (entry.isFile() && match && new Date(`${match[1]}T00:00:00`).getTime() < cutoff) {
      await unlink(path.join(reportsDir, entry.name));
    }
  }
}

export function renderMarkdown(report) {
  const summary = report.summary;
  const llm = report.llmAnalysis;
  const llmLines = llm?.status === "completed" ? [
    "", `## LLM Analysis (${llm.model || "unknown"})`, "", llm.overview || "",
    "", "### Inferred Scenarios", "",
    ...(llm.scenarios || []).map((item) => `- ${item.name}: ${item.summary || item.evidence?.join("; ") || ""}`),
    "", "### LLM Habits", "", ...(llm.habits || []).map((item) => `- ${item}`),
    "", "### Recommendations", "", ...(llm.recommendations || []).map((item) => `- ${item}`),
  ] : llm?.status === "failed" ? ["", "## LLM Analysis", "", `- Failed: ${llm.error}`] : [];
  const lines = [
    `# Codex Daily Review - ${report.date}`, "",
    `- Sessions: ${summary.sessions} (${summary.completedSessions} completed)`,
    `- Active time: ${(summary.activeMs / 3_600_000).toFixed(2)} hours`,
    `- Runtime turns: ${summary.runtimeTurns}`,
    `- Model calls: ${summary.modelCalls}`,
    `- Tool calls: ${summary.toolCalls}`,
    `- Tokens: ${summary.inputTokens} input / ${summary.outputTokens} output / ${summary.reasoningTokens} reasoning`,
    `- User messages: ${summary.userMessages} (${summary.userCharacters} characters)`,
    "", "## Scenarios", "",
    ...Object.entries(report.scenarioUsage || {})
      .sort(([, left], [, right]) => right.sessions - left.sessions)
      .map(([name, value]) => `- ${name}: ${value.sessions} sessions, ${value.toolCalls} tool calls; top tools: ${topEntries(value.tools).join(", ") || "none"}`),
    "", "## Tool Usage", "", ...entriesAsMarkdown(report.toolUsage),
    "", "## Skill Usage", "", ...entriesAsMarkdown(report.skillUsage),
    "", "## MCP Usage", "", ...entriesAsMarkdown(report.mcpUsage),
    "", "## Habits", "", ...report.habits.map((item) => `- ${item}`),
    ...llmLines,
    "", "## Cleanup Candidates", "",
    ...report.cleanupRecommendations.map((item) => `- ${item.type}: ${item.id} - ${item.reason}`), "",
  ];
  return lines.join("\n");
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

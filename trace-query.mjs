import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { sha256 } from "./agent-schema.mjs";
import { readAnalysisIndex, writeAnalysisIndex } from "./agent-store.mjs";

const INDEX_SCHEMA_VERSION = 3;
const DEFAULT_PAYLOAD_LIMIT = 1_000_000;
const DEFAULT_SEARCH_LIMIT = 100;

const indexRefreshes = new Map();

export function refreshTraceIndex({ traceRoot, dataRoot }) {
  traceRoot = path.resolve(traceRoot);
  dataRoot = path.resolve(dataRoot);
  const key = `${dataRoot}\0${traceRoot}`;
  if (indexRefreshes.has(key)) return indexRefreshes.get(key);
  const pending = rebuildTraceIndex({ traceRoot, dataRoot }).finally(() => indexRefreshes.delete(key));
  indexRefreshes.set(key, pending);
  return pending;
}

async function rebuildTraceIndex({ traceRoot, dataRoot }) {
  const stored = await readAnalysisIndex(dataRoot, "trace-index");
  const previous = stored?.schemaVersion === INDEX_SCHEMA_VERSION && stored.traceRoot === traceRoot ? stored : null;
  const previousByBundle = new Map((previous?.sessions || []).map((item) => [item.bundleId, item]));
  const entries = await safeDirectoryEntries(traceRoot);
  const sessions = [];
  const errors = [];
  let changed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bundleDir = path.join(traceRoot, entry.name);
    const stateFile = path.join(bundleDir, "state.json");
    let info;
    try {
      info = await stat(stateFile, { bigint: true });
    } catch {
      continue;
    }
    const cursor = `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
    const cached = previousByBundle.get(entry.name);
    if (cached?.cursor === cursor) {
      sessions.push(cached);
      continue;
    }
    try {
      const state = await readJson(stateFile);
      sessions.push(await summarizeSession(entry.name, bundleDir, state, cursor));
      changed += 1;
    } catch (error) {
      // Incomplete/corrupt bundles must not prevent other sessions from being indexed.
      errors.push({ bundleId: entry.name, code: error.code || "INVALID_STATE" });
    }
  }
  sessions.sort((left, right) => right.startedAtUnixMs - left.startedAtUnixMs);
  const index = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    generatedAtUnixMs: Date.now(),
    traceRoot,
    cursor: sha256(sessions.map((item) => `${item.bundleId}:${item.cursor}`).join("\n")),
    changedSessions: changed,
    history: buildIndexHistory(previous, sessions),
    sessions,
    errors,
  };
  if (index.cursor !== previous?.cursor || JSON.stringify(errors) !== JSON.stringify(previous?.errors)) {
    await writeAnalysisIndex(dataRoot, "trace-index", index);
  }
  return index;
}

export function traceBundleIdsSince(index, cursor) {
  if (!cursor) return index.sessions.map((item) => item.bundleId);
  if (cursor === index.cursor) return [];
  const previous = (index.history || []).find((item) => item.cursor === cursor);
  if (!previous) return index.sessions.map((item) => item.bundleId);
  const old = new Map(Object.entries(previous.sessionCursors || {}));
  return index.sessions.filter((item) => old.get(item.bundleId) !== item.cursor).map((item) => item.bundleId);
}

export async function listTraceSessions(context, filters = {}) {
  const limit = boundedLimit(filters.limit, 1, 1_000, 200);
  return (await matchingTraceSessions(context, filters)).slice(0, limit);
}

async function matchingTraceSessions(context, filters = {}) {
  const index = await currentIndex(context);
  const query = String(filters.query || "").trim().toLowerCase();
  return index.sessions.filter((session) => {
    if (context.allowedBundleIds && !context.allowedBundleIds.has(session.bundleId)) return false;
    if (filters.project && session.project !== filters.project) return false;
    if (filters.status && session.status !== filters.status) return false;
    if (filters.afterUnixMs && session.startedAtUnixMs < Number(filters.afterUnixMs)) return false;
    if (filters.beforeUnixMs && session.startedAtUnixMs > Number(filters.beforeUnixMs)) return false;
    if (filters.intent && !(session.intents || []).includes(String(filters.intent))) return false;
    if (filters.tool && !Object.keys(session.tools || {}).some((name) => toolFilterMatches(name, filters.tool))) return false;
    if (query && !`${session.firstUserMessage} ${session.project} ${session.rolloutId}`.toLowerCase().includes(query)) return false;
    return true;
  });
}

export async function assertTraceBundleInScope(context, bundleId) {
  if (context.allowedBundleIds && !context.allowedBundleIds.has(bundleId)) throw new Error(`trace bundle is outside this analysis scope: ${bundleId}`);
  const index = await currentIndex(context);
  if (!index.sessions.some((item) => item.bundleId === bundleId)) throw notFound("trace bundle");
}

export async function getTraceTurn(context, bundleId, turnId) {
  const state = await loadState(context.traceRoot, bundleId);
  const turn = state.codex_turns?.[turnId];
  if (!turn) throw notFound("turn");
  const messages = queryConversationItems(state).filter((item) => item.codex_turn_id === turnId).map(publicConversationItem);
  const toolCalls = Object.values(state.tool_calls || {})
    .filter((tool) => tool.started_by_codex_turn_id === turnId)
    .map(publicToolCall);
  return { bundleId, traceId: state.trace_id, rolloutId: state.rollout_id, turn, messages, toolCalls };
}

export async function getConversationWindow(context, input) {
  const state = await loadState(context.traceRoot, input.bundleId);
  const items = queryConversationItems(state);
  let center = input.itemId ? items.findIndex((item) => item.item_id === input.itemId) : -1;
  if (center < 0 && input.turnId) center = items.findIndex((item) => item.codex_turn_id === input.turnId);
  if (center < 0) throw notFound("conversation item");
  const radius = boundedLimit(input.radius, 1, 20, 3);
  return {
    bundleId: input.bundleId,
    traceId: state.trace_id,
    items: items.slice(Math.max(0, center - radius), center + radius + 1).map(publicConversationItem),
  };
}

export async function searchTraces(context, input = {}) {
  const query = String(input.query || "").trim();
  if (!query) throw new Error("trace search query is required");
  const sessions = await matchingTraceSessions(context, { ...input, query: "" });
  const results = [];
  const limit = boundedLimit(input.limit, 1, 500, DEFAULT_SEARCH_LIMIT);
  const needle = query.toLowerCase();
  for (const session of sessions) {
    const state = await loadState(context.traceRoot, session.bundleId);
    for (const item of queryConversationItems(state)) {
      const text = conversationItemText(item);
      if (!text.toLowerCase().includes(needle)) continue;
      results.push({
        kind: "message",
        bundleId: session.bundleId,
        traceId: state.trace_id,
        turnId: item.codex_turn_id || null,
        itemId: item.item_id,
        role: item.role,
        channel: item.channel || null,
        excerpt: redactSensitiveText(excerptAround(text, needle, 500)),
      });
      if (results.length >= limit) return results;
    }
    for (const tool of Object.values(state.tool_calls || {})) {
      const text = JSON.stringify(tool.summary || {});
      if (!text.toLowerCase().includes(needle)) continue;
      results.push({
        kind: "tool_call",
        bundleId: session.bundleId,
        traceId: state.trace_id,
        turnId: tool.started_by_codex_turn_id || null,
        toolCallId: tool.tool_call_id,
        excerpt: redactSensitiveText(excerptAround(text, needle, 500)),
      });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

export async function getTraceToolCalls(context, input = {}) {
  const state = await loadState(context.traceRoot, input.bundleId);
  let tools = Object.values(state.tool_calls || {});
  if (input.turnId) tools = tools.filter((tool) => tool.started_by_codex_turn_id === input.turnId);
  if (input.status) tools = tools.filter((tool) => tool.execution?.status === input.status);
  return tools.slice(0, boundedLimit(input.limit, 1, 2_000, 500)).map(publicToolCall);
}

export async function getTracePayload(context, input) {
  if (context.allowPayloads === false) throw new Error("Payload reading is disabled for this Agent analysis scope");
  const state = await loadState(context.traceRoot, input.bundleId);
  const reference = state.raw_payloads?.[input.payloadId];
  if (!reference?.path) throw notFound("payload");
  const bundleDir = safeBundle(context.traceRoot, input.bundleId);
  const file = safeDescendant(bundleDir, reference.path);
  const info = await stat(file);
  const scopeLimit = boundedLimit(context.maxPayloadBytes, 1, 5_000_000, DEFAULT_PAYLOAD_LIMIT);
  const maxBytes = Math.min(scopeLimit, boundedLimit(input.maxBytes, 1, 5_000_000, scopeLimit));
  if (info.size > maxBytes) throw new Error(`payload exceeds ${maxBytes} bytes`);
  const source = await readFile(file, "utf8");
  const byteLength = Buffer.byteLength(source, "utf8");
  if (byteLength > maxBytes) throw new Error(`payload exceeds ${maxBytes} bytes`);
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    value = source;
  }
  return {
    bundleId: input.bundleId,
    payloadId: input.payloadId,
    kind: reference.kind,
    byteLength,
    value: redactSensitiveValue(value),
  };
}

export async function aggregateTraces(context, filters = {}) {
  const sessions = await matchingTraceSessions(context, filters);
  const totals = { sessions: sessions.length, turns: 0, userMessages: 0, assistantMessages: 0, toolCalls: 0, failedTools: 0, cancelledTurns: 0, repeatedToolCalls: 0 };
  const projects = {};
  const tools = {};
  const intents = {};
  for (const session of sessions) {
    totals.turns += session.turns;
    totals.userMessages += session.userMessages;
    totals.assistantMessages += session.assistantMessages;
    totals.toolCalls += session.toolCalls;
    totals.failedTools += session.failedTools;
    totals.cancelledTurns += session.cancelledTurns;
    totals.repeatedToolCalls += session.repeatedToolCalls || 0;
    increment(projects, session.project || "unknown");
    for (const [name, count] of Object.entries(session.tools || {})) tools[name] = (tools[name] || 0) + count;
    for (const intent of session.intents || []) increment(intents, intent);
  }
  return { cursor: (await currentIndex(context)).cursor, totals, projects, tools, intents };
}

export async function findTraceFeedback(context, input = {}) {
  const sessions = await matchingTraceSessions(context, input);
  const output = [];
  const limit = boundedLimit(input.limit, 1, 500, 100);
  for (const session of sessions) {
    const state = await loadState(context.traceRoot, session.bundleId);
    const items = sortedItems(state).filter((item) => ["user", "assistant"].includes(item.role));
    for (let index = 0; index < items.length; index += 1) {
      const user = items[index];
      if (user.role !== "user" || isSyntheticUserMessage(conversationItemText(user))) continue;
      const text = conversationItemText(user);
      const signal = feedbackSignal(text);
      if (!signal) continue;
      let assistant = null;
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (items[cursor].role === "assistant") {
          assistant = items[cursor];
          break;
        }
      }
      if (!assistant) continue;
      output.push({
        bundleId: session.bundleId,
        traceId: state.trace_id,
        project: session.project,
        signal,
        assistant: {
          turnId: assistant.codex_turn_id || null,
          itemId: assistant.item_id,
          channel: assistant.channel || null,
          excerpt: redactSensitiveText(truncate(conversationItemText(assistant), 800)),
        },
        user: {
          turnId: user.codex_turn_id || null,
          itemId: user.item_id,
          excerpt: redactSensitiveText(truncate(text, 800)),
        },
      });
      if (output.length >= limit) return output;
    }
  }
  return output;
}

export async function findCancelledTurns(context, input = {}) {
  const sessions = await matchingTraceSessions(context, input);
  const output = [];
  const limit = boundedLimit(input.limit, 1, 500, 100);
  for (const session of sessions) {
    const state = await loadState(context.traceRoot, session.bundleId);
    for (const turn of Object.values(state.codex_turns || {})) {
      if (!["cancelled", "canceled", "aborted"].includes(turn.execution?.status)) continue;
      const items = sortedItems(state).filter((item) => item.codex_turn_id === turn.codex_turn_id);
      output.push({
        bundleId: session.bundleId,
        traceId: state.trace_id,
        project: session.project,
        turnId: turn.codex_turn_id,
        status: turn.execution.status,
        startedAtUnixMs: turn.execution.started_at_unix_ms || null,
        endedAtUnixMs: turn.execution.ended_at_unix_ms || null,
        userExcerpt: redactSensitiveText(truncate(items.filter((item) => item.role === "user").map(conversationItemText).join(" "), 800)),
        assistantExcerpt: redactSensitiveText(truncate(items.filter((item) => item.role === "assistant").map(conversationItemText).join(" "), 800)),
      });
      if (output.length >= limit) return output;
    }
  }
  return output;
}

async function currentIndex(context) {
  const existing = await readAnalysisIndex(context.dataRoot, "trace-index");
  return existing?.schemaVersion === INDEX_SCHEMA_VERSION && existing?.traceRoot === path.resolve(context.traceRoot) ? existing : refreshTraceIndex(context);
}

function buildIndexHistory(previous, sessions) {
  const history = [...new Map((previous?.history || []).map((item) => [item.cursor, item])).values()];
  if (previous?.cursor && !history.some((item) => item.cursor === previous.cursor)) {
    history.push({ cursor: previous.cursor, sessionCursors: Object.fromEntries((previous.sessions || []).map((item) => [item.bundleId, item.cursor])) });
  }
  const currentCursor = sha256(sessions.map((item) => `${item.bundleId}:${item.cursor}`).join("\n"));
  if (!history.some((item) => item.cursor === currentCursor)) {
    history.push({ cursor: currentCursor, sessionCursors: Object.fromEntries(sessions.map((item) => [item.bundleId, item.cursor])) });
  }
  return history.slice(-20);
}

async function summarizeSession(bundleId, bundleDir, state, cursor) {
  const items = sortedItems(state);
  const userMessages = items.filter((item) => item.role === "user" && !isSyntheticUserMessage(conversationItemText(item)));
  const assistantMessages = items.filter((item) => item.role === "assistant");
  const tools = Object.values(state.tool_calls || {});
  const toolUsage = {};
  for (const tool of tools) increment(toolUsage, toolName(tool));
  const turns = Object.values(state.codex_turns || {});
  const messageIndex = items
    .filter((item) => ["user", "assistant"].includes(item.role) && !(item.role === "user" && isSyntheticUserMessage(conversationItemText(item))))
    .map((item) => ({
      itemId: item.item_id,
      turnId: item.codex_turn_id || null,
      role: item.role,
      channel: item.channel || null,
      seenAtUnixMs: item.first_seen_at_unix_ms || null,
      excerpt: redactSensitiveText(truncate(conversationItemText(item), 240)),
    }));
  const turnIndex = turns.map((turn) => ({
    turnId: turn.codex_turn_id,
    status: turn.execution?.status || null,
    startedAtUnixMs: turn.execution?.started_at_unix_ms || null,
    endedAtUnixMs: turn.execution?.ended_at_unix_ms || null,
  }));
  const toolCallIndex = tools.map((tool) => ({
    toolCallId: tool.tool_call_id,
    turnId: tool.started_by_codex_turn_id || null,
    label: toolName(tool),
    status: tool.execution?.status || null,
    signature: toolSignature(tool),
  }));
  const retryGroups = repeatedToolGroups(toolCallIndex);
  const intents = [...new Set(userMessages.flatMap((item) => classifyIntents(conversationItemText(item))))];
  return {
    bundleId,
    cursor,
    traceId: state.trace_id,
    rolloutId: state.rollout_id,
    status: state.status || "unknown",
    startedAtUnixMs: state.started_at_unix_ms || 0,
    endedAtUnixMs: state.ended_at_unix_ms || null,
    project: await sessionProject(bundleDir, state),
    firstUserMessage: redactSensitiveValueForIndex(conversationItemText(userMessages[0])),
    turns: turns.length,
    userMessages: userMessages.length,
    assistantMessages: assistantMessages.length,
    toolCalls: tools.length,
    failedTools: tools.filter((tool) => tool.execution?.status === "failed").length,
    cancelledTurns: turns.filter((turn) => ["cancelled", "canceled", "aborted"].includes(turn.execution?.status)).length,
    repeatedToolCalls: retryGroups.reduce((sum, group) => sum + group.count - 1, 0),
    tools: toolUsage,
    intents,
    turnIndex,
    messageIndex,
    toolCallIndex,
    retryGroups,
  };
}

async function sessionProject(bundleDir, state) {
  if (state.project || state.cwd || state.root_thread?.cwd) return state.project || state.cwd || state.root_thread.cwd;
  const reference = Object.values(state.raw_payloads || {}).find((item) => item.kind?.type === "session_metadata");
  if (!reference?.path) return "";
  try {
    const file = safeDescendant(bundleDir, reference.path);
    const info = await stat(file);
    if (info.size > DEFAULT_PAYLOAD_LIMIT) return "";
    const payload = await readJson(file);
    return payload.cwd || payload.config?.cwd || "";
  } catch {
    return "";
  }
}

function publicConversationItem(item) {
  return {
    itemId: item.item_id,
    turnId: item.codex_turn_id || null,
    seenAtUnixMs: item.first_seen_at_unix_ms || null,
    role: item.role,
    channel: item.channel || null,
    kind: item.kind,
    text: redactSensitiveText(conversationItemText(item)),
    producedBy: item.produced_by || [],
  };
}

function publicToolCall(tool) {
  return {
    toolCallId: tool.tool_call_id,
    turnId: tool.started_by_codex_turn_id || null,
    status: tool.execution?.status || null,
    startedAtUnixMs: tool.execution?.started_at_unix_ms || null,
    endedAtUnixMs: tool.execution?.ended_at_unix_ms || null,
    kind: tool.kind,
    label: toolName(tool),
    summary: redactSensitiveValue(tool.summary || null),
    rawPayloadIds: [tool.raw_invocation_payload_id, tool.raw_result_payload_id, ...(tool.raw_runtime_payload_ids || [])].filter(Boolean),
  };
}

function sortedItems(state) {
  return Object.values(state.conversation_items || {}).sort((left, right) => {
    const time = (left.first_seen_at_unix_ms || 0) - (right.first_seen_at_unix_ms || 0);
    return time || String(left.item_id).localeCompare(String(right.item_id));
  });
}

function queryConversationItems(state) {
  return sortedItems(state).filter((item) => {
    if (!["user", "assistant"].includes(item.role)) return false;
    if (item.role === "user" && isSyntheticUserMessage(conversationItemText(item))) return false;
    return true;
  });
}

function conversationItemText(item) {
  if (!item) return "";
  return (item.body?.parts || []).map((part) => part.text || part.summary || part.source || part.value || "").filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function isSyntheticUserMessage(value) {
  return /^(?:<(?:environment_context|system|developer|codex_internal_context|permissions|plugins_instructions|skills_instructions)(?:\s|>)|# AGENTS(?:\.md)?\b|# Files mentioned by the user:|You are a helpful assistant\. You will be presented with a user prompt)/i.test(value.trim());
}

function feedbackSignal(value) {
  const text = value.trim();
  const rules = [
    ["stop_or_boundary", /(?:不要|别|先不|不用|停止|停一下|不要急着|do not|don't|stop|hold off)/i],
    ["correction", /(?:不是|不对|错了|我说的是|我的意思是|并非|rather than|that's not|not what i)/i],
    ["autonomy_request", /(?:直接做|不用问|继续做|你决定|自己处理|go ahead|just do|don't ask)/i],
    ["style_preference", /(?:太啰嗦|简洁|详细一点|不要解释|少说|格式|语气|verbose|concise|shorter)/i],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || null;
}

function toolName(tool) {
  const kind = typeof tool.kind === "string" ? tool.kind : tool.kind?.type || tool.kind?.name || "unknown";
  if (kind === "mcp") return `mcp:${tool.kind?.server || "unknown"}/${tool.kind?.tool || "call"}`;
  return tool.summary?.label || kind;
}

function toolSignature(tool) {
  const summary = tool.summary || {};
  return sha256(JSON.stringify({ label: toolName(tool), input: summary.input_preview || summary.input || summary.command || null }));
}

function repeatedToolGroups(toolCalls) {
  const counts = new Map();
  for (const call of toolCalls) {
    const key = `${call.turnId || ""}:${call.signature}`;
    const current = counts.get(key) || { turnId: call.turnId, label: call.label, signature: call.signature, count: 0, failures: 0 };
    current.count += 1;
    if (call.status === "failed") current.failures += 1;
    counts.set(key, current);
  }
  return [...counts.values()].filter((item) => item.count > 1);
}

function classifyIntents(value) {
  const text = String(value || "");
  const rules = [
    ["discussion", /(?:讨论|聊聊|先看看|不要动手|方案|设计|brainstorm|discuss|plan)/i],
    ["implementation", /(?:实现|修改|修复|增加|删除|重构|build|implement|fix|change|refactor)/i],
    ["review", /(?:审查|review|检查代码|风险|bug)/i],
    ["research", /(?:调研|搜索|查资料|对比|research|search|compare)/i],
    ["explanation", /(?:解释|说明|为什么|怎么工作|explain|how does|why)/i],
    ["operations", /(?:部署|升级|回滚|启动服务|deploy|upgrade|rollback|restart)/i],
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function toolFilterMatches(name, filter) {
  const needle = String(filter || "").trim().toLowerCase();
  return !needle || String(name).toLowerCase() === needle || String(name).toLowerCase().includes(needle);
}

function redactSensitiveValue(value) {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactSensitiveValue);
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(?:password|passwd|token|api[_-]?key|secret|authorization|cookie)/i.test(key)) output[key] = "[已隐藏]";
    else output[key] = redactSensitiveValue(item);
  }
  return output;
}

function redactSensitiveText(value) {
  return String(value || "")
    .replace(/((?:password|passwd|token|api[_ -]?key|secret|authorization|密码|口令)\s*(?:(?:是|为)|[:：=])\s*)[^\s,，;；]+/gi, "$1[已隐藏]")
    .replace(/\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi, "[已隐藏密钥]")
    .replace(/Bearer\s+[a-z0-9._~+/-]+=*/gi, "Bearer [已隐藏]");
}

function redactSensitiveValueForIndex(value) {
  return redactSensitiveText(truncate(value, 500));
}

function excerptAround(value, needle, length) {
  const lower = value.toLowerCase();
  const index = lower.indexOf(needle);
  if (index < 0) return truncate(value, length);
  const start = Math.max(0, index - Math.floor(length / 3));
  return truncate(value.slice(start), length);
}

function truncate(value, length) {
  const text = String(value || "");
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function safeBundle(traceRoot, bundleId) {
  if (typeof bundleId !== "string" || !/^[a-zA-Z0-9._-]+$/.test(bundleId)) throw new Error("invalid trace bundle id");
  return safeDescendant(traceRoot, bundleId);
}

function safeDescendant(root, child) {
  const resolved = path.resolve(root, child);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escapes allowed root");
  return resolved;
}

async function loadState(traceRoot, bundleId) {
  return readJson(path.join(safeBundle(traceRoot, bundleId), "state.json"));
}

async function safeDirectoryEntries(root) {
  try {
    return await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function increment(record, key) {
  record[key] = (record[key] || 0) + 1;
}

function boundedLimit(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function notFound(label) {
  const error = new Error(`${label} not found`);
  error.code = "NOT_FOUND";
  return error;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

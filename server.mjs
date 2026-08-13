import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, copyFile, cp, mkdtemp, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildDailyReview,
  collectInventory,
  listReviews,
  loadSettings,
  localDate,
  pruneReviews,
  saveSettings,
  settingsForClient,
  shouldRunScheduledReview,
  storeReview,
  validateSettings,
} from "./insights.mjs";
import { analyzeDailyReview, discoverModels, testLlmConnection } from "./llm-review.mjs";
import { createAgentAnalysisRun, executeAgentRun, testAgentConnection } from "./agent-engine.mjs";
import {
  agentDashboard,
  agentEvidenceDetail,
  agentEvidenceSummary,
  applyAgentProposal,
  decideAgentProposal,
  proposalDetail,
  recoverInterruptedAgentState,
  rollbackAgentChange,
} from "./agent-service.mjs";
import { getRun, updateRun } from "./agent-store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(here, "public");
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

export function parseArgs(argv) {
  const options = {
    traceRoot: process.env.CODEX_ROLLOUT_TRACE_ROOT || path.join(process.cwd(), "traces"),
    host: "127.0.0.1",
    port: 4319,
    codex: process.env.CODEX_TRACE_VIEWER_CODEX || "codex",
    dataRoot: process.env.CODEX_INSIGHTS_ROOT || path.resolve(process.cwd(), ".codex-insights"),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--trace-root") options.traceRoot = argv[++index];
    else if (value === "--host") options.host = argv[++index];
    else if (value === "--port") options.port = Number(argv[++index]);
    else if (value === "--codex") options.codex = argv[++index];
    else if (value === "--data-root") options.dataRoot = argv[++index];
    else if (value === "--codex-home") options.codexHome = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  options.traceRoot = path.resolve(options.traceRoot);
  options.dataRoot = path.resolve(options.dataRoot);
  options.codexHome = path.resolve(options.codexHome);
  return options;
}

export function safeChild(root, child) {
  const resolved = path.resolve(root, child);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("path escapes trace root");
  }
  return resolved;
}

function decorateTraceState(trace, bundle) {
  trace.rollout_status = bundle.rolloutStatus;
  trace.turn_status = bundle.turnStatus;
  trace.display_status = bundle.displayStatus;
  trace.turn_started_at_unix_ms = bundle.turnStartedAtUnixMs;
  trace.turn_ended_at_unix_ms = bundle.turnEndedAtUnixMs;
  trace.turn_duration_ms = bundle.turnDurationMs;
  return trace;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

const rawEventTailBytes = 256 * 1024;

function normalizeEventStatus(value) {
  if (typeof value !== "string") return null;
  const status = value.toLowerCase();
  if (["complete", "completed", "success", "succeeded"].includes(status)) return "completed";
  if (["cancelled", "canceled"].includes(status)) return "cancelled";
  if (["abort", "aborted"].includes(status)) return "aborted";
  if (["fail", "failed", "error"].includes(status)) return "failed";
  if (["running", "started", "in_progress"].includes(status)) return "running";
  return null;
}

function eventTurnState(event) {
  const payload = event.payload || {};
  const eventType = payload.type === "protocol_event_observed" ? payload.event_type : payload.type;
  const eventTime = Number.isFinite(event.wall_time_unix_ms) ? event.wall_time_unix_ms : null;
  if (eventType === "codex_turn_started" || eventType === "turn_started") {
    return { status: "running", startedAtUnixMs: eventTime, endedAtUnixMs: null };
  }
  if (eventType === "codex_turn_ended") {
    return { status: normalizeEventStatus(payload.status) || "completed", startedAtUnixMs: null, endedAtUnixMs: eventTime };
  }
  if (eventType === "turn_complete") {
    return { status: "completed", startedAtUnixMs: null, endedAtUnixMs: eventTime };
  }
  if (eventType === "turn_aborted") {
    return { status: "aborted", startedAtUnixMs: null, endedAtUnixMs: eventTime };
  }
  return null;
}

function isTerminalTurnStatus(status) {
  return ["completed", "cancelled", "aborted", "failed"].includes(status);
}

async function readRawEventState(bundleDir) {
  const eventLogPath = path.join(bundleDir, "trace.jsonl");
  let eventLogInfo;
  try {
    eventLogInfo = await stat(eventLogPath);
  } catch {
    return null;
  }
  if (!eventLogInfo.isFile() || eventLogInfo.size === 0) return null;

  const bytesToRead = Math.min(eventLogInfo.size, rawEventTailBytes);
  const handle = await open(eventLogPath, "r");
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, eventLogInfo.size - bytesToRead);
    const lines = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/);
    let rolloutEnded = false;
    let rolloutStatus = null;
    let latestTurn = null;
    let currentTurnStartedAtUnixMs = null;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const payload = event.payload || {};
        if (payload.type === "rollout_ended") {
          rolloutEnded = true;
          rolloutStatus = normalizeEventStatus(payload.status) || "completed";
        }
        const turn = eventTurnState(event);
        if (!turn) continue;
        if (turn.status === "running") {
          currentTurnStartedAtUnixMs = turn.startedAtUnixMs;
          latestTurn = { ...turn };
        } else {
          latestTurn = {
            ...turn,
            startedAtUnixMs: currentTurnStartedAtUnixMs ?? latestTurn?.startedAtUnixMs ?? null,
          };
          currentTurnStartedAtUnixMs = null;
        }
      } catch {
        // Ignore a partial line while Codex is appending the event.
      }
    }
    const turnEnded = Boolean(latestTurn && isTerminalTurnStatus(latestTurn.status));
    const turnDurationMs = latestTurn?.startedAtUnixMs != null && latestTurn.endedAtUnixMs != null
      ? Math.max(0, latestTurn.endedAtUnixMs - latestTurn.startedAtUnixMs)
      : null;
    return {
      rolloutEnded,
      rolloutStatus,
      turnStatus: latestTurn?.status || null,
      turnStartedAtUnixMs: latestTurn?.startedAtUnixMs ?? null,
      turnEndedAtUnixMs: latestTurn?.endedAtUnixMs ?? null,
      turnDurationMs,
      turnEnded,
      mtimeMs: eventLogInfo.mtimeMs,
      size: eventLogInfo.size,
    };
  } finally {
    await handle.close();
  }
}

async function rawLogStable(bundleDir, waitMs) {
  const eventLogPath = path.join(bundleDir, "trace.jsonl");
  let before;
  try {
    before = await stat(eventLogPath);
  } catch {
    return false;
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  try {
    const after = await stat(eventLogPath);
    return before.size === after.size && before.mtimeMs === after.mtimeMs;
  } catch {
    return false;
  }
}

async function discoverBundles(traceRoot, reductionStates = null) {
  if (!(await exists(traceRoot))) return [];
  const entries = await readdir(traceRoot, { withFileTypes: true });
  const bundles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const bundleDir = safeChild(traceRoot, entry.name);
    const manifestPath = path.join(bundleDir, "manifest.json");
    if (!(await exists(manifestPath))) continue;
    try {
      const manifest = await readJson(manifestPath);
      const statePath = path.join(bundleDir, "state.json");
      const stateInfo = (await exists(statePath)) ? await stat(statePath) : null;
      const summary = stateInfo ? await summarizeState(statePath) : null;
      const reduction = reductionStates?.get(bundleDir);
      const rawEventState = await readRawEventState(bundleDir);
      const rawComplete = Boolean(rawEventState?.rolloutEnded || rawEventState?.turnEnded);
      const needsReduction = Boolean(stateInfo && rawEventState && rawEventState.mtimeMs > stateInfo.mtimeMs && rawComplete);
      const reduced = Boolean(stateInfo) && !needsReduction;
      if (reduced && reduction) reductionStates.delete(bundleDir);
      const complete = reduced || rawComplete;
      const reductionStatus = reduced ? "ready" : reduction?.status || "raw";
      const rolloutStatus = summary?.status || (stateInfo ? "corrupt" : rawEventState?.rolloutStatus || (rawEventState?.rolloutEnded ? "completed" : "running"));
      const turnStatus = rawEventState?.turnStatus || (rolloutStatus === "completed" ? "completed" : null);
      const displayStatus = reduced
        ? rolloutStatus === "corrupt" ? "corrupt" : rawEventState?.rolloutEnded ? rolloutStatus : turnStatus || rolloutStatus
        : reductionStatus === "failed" ? "failed" : reductionStatus === "reducing" ? "reducing" : "raw";
      bundles.push({
        id: entry.name,
        traceId: manifest.trace_id,
        rolloutId: manifest.rollout_id,
        rootThreadId: manifest.root_thread_id,
        startedAtUnixMs: manifest.started_at_unix_ms,
        endedAtUnixMs: summary?.endedAtUnixMs ?? null,
        status: reduced ? (summary?.status || "corrupt") : reductionStatus === "failed" ? "failed" : reductionStatus === "reducing" ? "reducing" : "raw",
        rolloutStatus,
        turnStatus,
        displayStatus,
        turnStartedAtUnixMs: rawEventState?.turnStartedAtUnixMs ?? null,
        turnEndedAtUnixMs: rawEventState?.turnEndedAtUnixMs ?? null,
        turnDurationMs: rawEventState?.turnDurationMs ?? null,
        durationMs: summary?.durationMs ?? null,
        firstUserMessage: summary?.firstUserMessage || "",
        models: summary?.models || [],
        tools: summary?.tools ?? 0,
        inputTokens: summary?.inputTokens ?? 0,
        outputTokens: summary?.outputTokens ?? 0,
        reasoningTokens: summary?.reasoningTokens ?? 0,
        project: summary?.project || "",
        reducedAtUnixMs: reduced ? stateInfo.mtimeMs : null,
        reductionStatus,
        reductionError: reduction?.error || null,
        complete,
        needsReduction,
        canReduce: !reduced && complete && reductionStatus !== "reducing",
      });
    } catch {
      // A writer may be between its atomic filesystem operations. Retry next poll.
    }
  }
  return bundles.sort((a, b) => b.startedAtUnixMs - a.startedAtUnixMs);
}

async function summarizeState(statePath) {
  try {
    const state = await readJson(statePath);
    const calls = Object.values(state.inference_calls || {});
    const usage = calls.reduce((totals, call) => {
      totals.inputTokens += call.usage?.input_tokens || 0;
      totals.outputTokens += call.usage?.output_tokens || 0;
      totals.reasoningTokens += call.usage?.reasoning_output_tokens || 0;
      return totals;
    }, { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 });
    const users = Object.values(state.conversation_items || {})
      .filter((item) => item.role === "user")
      .sort((left, right) => (left.first_seen_at_unix_ms || 0) - (right.first_seen_at_unix_ms || 0));
    const userMessages = users.map(summarizeItem).filter(Boolean);
    const firstUserMessage = userMessages.find((message) => !message.startsWith("<environment_context>") && !message.startsWith("<system>") && !message.startsWith("# AGENTS")) || userMessages[0] || "";
    const startedAtUnixMs = state.started_at_unix_ms;
    const endedAtUnixMs = state.ended_at_unix_ms;
    const project = await stateProject(state, path.dirname(statePath));
    return {
      status: state.status || "unknown",
      endedAtUnixMs: endedAtUnixMs ?? null,
      durationMs: endedAtUnixMs == null ? null : Math.max(0, endedAtUnixMs - startedAtUnixMs),
      firstUserMessage,
      models: [...new Set(calls.map((call) => call.model).filter(Boolean))],
      tools: Object.keys(state.tool_calls || {}).length,
      ...usage,
      project: project || state.project || state.cwd || state.root_thread?.cwd || "",
    };
  } catch {
    return null;
  }
}

async function stateProject(state, bundleDir) {
  const reference = Object.values(state.raw_payloads || {}).find((item) => item.kind?.type === "session_metadata");
  if (!reference?.path) return "";
  try {
    const payload = await readJson(safeChild(bundleDir, reference.path));
    return payload.cwd || payload.config?.cwd || "";
  } catch {
    return "";
  }
}

function summarizeItem(item) {
  const text = (item.body?.parts || [])
    .map((part) => part.text || part.summary || part.source || part.value || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 180 ? `${text.slice(0, 179)}…` : text;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 65_536) throw new Error("request body exceeds 64 KiB");
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function runReducer(codex, bundleDir) {
  return new Promise((resolve, reject) => {
    const args = ["debug", "trace-reduce", bundleDir];
    const powershellScript = process.platform === "win32" && path.extname(codex).toLowerCase() === ".ps1";
    const executable = process.platform !== "win32"
      ? codex
      : powershellScript
        ? "powershell.exe"
        : process.env.ComSpec || "cmd.exe";
    const executableArgs = process.platform !== "win32"
      ? args
      : powershellScript
        ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", codex, ...args]
        : ["/d", "/c", codex, ...args];
    const child = spawn(executable, executableArgs, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 8_192) stderr = stderr.slice(-8_192);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `trace reducer exited with code ${code}`));
    });
  });
}

function duplicateModelCallIdError(error) {
  return /model-visible call id .* was reused with different content/i.test(error instanceof Error ? error.message : String(error));
}

function removeReducerIncompatibleMetadata(value) {
  if (!value || typeof value !== "object") return 0;
  let removed = 0;
  if (!Array.isArray(value) && Object.hasOwn(value, "internal_chat_message_metadata_passthrough")) {
    delete value.internal_chat_message_metadata_passthrough;
    removed += 1;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    removed += removeReducerIncompatibleMetadata(child);
  }
  return removed;
}

function removeReducerIncompatibleImageFields(value) {
  if (!value || typeof value !== "object") return 0;
  let removed = 0;
  if (!Array.isArray(value) && value.type === "input_image" && Object.hasOwn(value, "image_url")) {
    delete value.image_url;
    removed += 1;
  }
  if (!Array.isArray(value) && value.type === "input_image" && Object.hasOwn(value, "detail")) {
    delete value.detail;
    removed += 1;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    removed += removeReducerIncompatibleImageFields(child);
  }
  return removed;
}

function removeReducerIncompatibleItemIds(value) {
  if (!value || typeof value !== "object") return 0;
  let removed = 0;
  if (
    !Array.isArray(value)
    && typeof value.call_id === "string"
    && ["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(value.type)
    && Object.hasOwn(value, "id")
  ) {
    delete value.id;
    removed += 1;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    removed += removeReducerIncompatibleItemIds(child);
  }
  return removed;
}

function removeReducerIncompatibleToolItems(value) {
  if (!value || typeof value !== "object") return 0;
  let removed = 0;
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const item = value[index];
      if (["function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"].includes(item?.type)) {
        value.splice(index, 1);
        removed += 1;
        continue;
      }
      removed += removeReducerIncompatibleToolItems(item);
    }
    return removed;
  }
  for (const child of Object.values(value)) {
    removed += removeReducerIncompatibleToolItems(child);
  }
  return removed;
}

export async function rewritePayloadForCompatibility(source, destination = source, { dropCustomToolItems = false } = {}) {
  const payload = JSON.parse(await readFile(source, "utf8"));
  let changed = removeReducerIncompatibleMetadata(payload);
  changed += removeReducerIncompatibleImageFields(payload);
  changed += removeReducerIncompatibleItemIds(payload);
  if (dropCustomToolItems) changed += removeReducerIncompatibleToolItems(payload);
  if (changed) await writeFile(destination, JSON.stringify(payload), "utf8");
  else if (destination !== source) await copyFile(source, destination);
  return changed;
}

export async function rewriteTraceLogForCompatibility(source, destination = source) {
  const raw = await readFile(source, "utf8");
  let changed = 0;
  const lines = raw.split(/\r?\n/).map((line, index) => {
    if (!line) return line;
    try {
      const event = JSON.parse(line);
      const payload = event?.payload;
      if (!payload || typeof payload.model_visible_call_id !== "string") return line;
      if (!["code_cell_started", "tool_call_started"].includes(payload.type)) return line;
      const suffix = String(payload.runtime_cell_id || payload.tool_call_id || index + 1).replace(/[^a-zA-Z0-9_-]/g, "_");
      payload.model_visible_call_id = `call_viewer_${event.seq || index + 1}_${suffix}`;
      changed += 1;
      return JSON.stringify(event);
    } catch {
      return line;
    }
  });
  if (changed) await writeFile(destination, lines.join("\n"), "utf8");
  else if (destination !== source) await copyFile(source, destination);
  return changed;
}

export async function runReducerWithCompatibility(codex, bundleDir) {
  try {
    await runReducer(codex, bundleDir);
    return;
  } catch (error) {
    if (!duplicateModelCallIdError(error)) throw error;
  }

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "codex-trace-reduce-"));
  const temporaryBundle = path.join(temporaryRoot, "bundle");
  try {
    await cp(bundleDir, temporaryBundle, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(temporaryBundle, "manifest.json"), "utf8"));
    const rawEventLog = path.join(temporaryBundle, manifest.raw_event_log || "trace.jsonl");
    await rewriteTraceLogForCompatibility(rawEventLog);
    const payloadsDir = path.join(temporaryBundle, manifest.payloads_dir || "payloads");
    const payloadEntries = await readdir(payloadsDir, { withFileTypes: true });
    for (const entry of payloadEntries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
      const payloadPath = path.join(payloadsDir, entry.name);
      await rewritePayloadForCompatibility(payloadPath);
    }
    await rm(path.join(temporaryBundle, "state.json"), { force: true });
    try {
      await runReducer(codex, temporaryBundle);
    } catch (error) {
      if (!duplicateModelCallIdError(error)) throw error;
      for (const entry of payloadEntries) {
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".json") continue;
        await rewritePayloadForCompatibility(path.join(payloadsDir, entry.name), undefined, { dropCustomToolItems: true });
      }
      await rm(path.join(temporaryBundle, "state.json"), { force: true });
      await runReducer(codex, temporaryBundle);
    }
    await copyFile(path.join(temporaryBundle, "state.json"), path.join(bundleDir, "state.json"));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": contentTypes[".json"],
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function serveStatic(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  let file;
  try {
    file = safeChild(publicRoot, relative);
  } catch {
    json(response, 404, { error: "not found" });
    return;
  }
  if (!(await exists(file)) || !(await stat(file)).isFile()) {
    json(response, 404, { error: "not found" });
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-cache",
  });
  createReadStream(file).pipe(response);
}

export function createViewerServer(options) {
  options = {
    dataRoot: path.join(here, ".codex-insights"),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    reductionPollMs: 1_500,
    reductionStabilityMs: 250,
    reductionRetryMs: 30 * 60_000,
    reviewRefreshMs: 30 * 60_000,
    initialReviewDelayMs: 5_000,
    runReducerImpl: runReducerWithCompatibility,
    fetchImpl: globalThis.fetch,
    ...options,
  };
  const reducing = new Map();
  const reductionChecks = new Map();
  const reductionStates = new Map();
  let settingsPromise = loadSettings(options.dataRoot);
  let reviewRunChain = Promise.resolve();
  const activeAgentRuns = new Map();

  function agentContext(settings) {
    return {
      traceRoot: options.traceRoot,
      dataRoot: options.dataRoot,
      codexHome: options.codexHome,
      codex: options.codex,
      projects: [],
      settings,
      fetchImpl: options.fetchImpl,
    };
  }

  function launchAgentRun(run, settings) {
    const active = activeAgentRuns.get(run.id);
    if (active) return active.promise;
    const controller = new AbortController();
    const pending = executeAgentRun({ ...agentContext(settings), signal: controller.signal }, run.id)
      .catch((error) => console.error(`Agent run ${run.id} failed: ${reductionError(error)}`))
      .finally(() => activeAgentRuns.delete(run.id));
    activeAgentRuns.set(run.id, { promise: pending, controller });
    return pending;
  }

  function reductionError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 600 ? `${message.slice(0, 599)}…` : message;
  }

  function startReduction(bundle, { force = false } = {}) {
    const bundleDir = safeChild(options.traceRoot, bundle.id);
    let pending = reducing.get(bundleDir);
    if (pending) return pending;
    const previous = reductionStates.get(bundleDir);
    if (!force && previous?.status === "failed") {
      return Promise.reject(new Error(previous.error));
    }
    reductionStates.set(bundleDir, { status: "reducing", startedAtUnixMs: Date.now() });
    pending = Promise.resolve()
      .then(() => options.runReducerImpl(options.codex, bundleDir))
      .then(() => reductionStates.delete(bundleDir))
      .catch((error) => {
        reductionStates.set(bundleDir, { status: "failed", error: reductionError(error), failedAtUnixMs: Date.now() });
        throw error;
      })
      .finally(() => reducing.delete(bundleDir));
    reducing.set(bundleDir, pending);
    return pending;
  }

  async function reduceBundle(bundle, { force = false } = {}) {
    const bundleDir = safeChild(options.traceRoot, bundle.id);
    const statePath = path.join(bundleDir, "state.json");
    if (await exists(statePath) && !bundle.needsReduction) {
      const trace = await readJson(statePath);
      decorateTraceState(trace, bundle);
      Object.defineProperty(trace, "__bundleId", { value: bundle.id, enumerable: false });
      return trace;
    }
    if (!bundle.complete) {
      const error = new Error("会话仍在采集，完成后会自动归约");
      error.code = "TRACE_ACTIVE";
      throw error;
    }
    await startReduction(bundle, { force });
    const trace = await readJson(statePath);
    decorateTraceState(trace, bundle);
    Object.defineProperty(trace, "__bundleId", { value: bundle.id, enumerable: false });
    return trace;
  }

  async function queueCompletedRawBundles() {
    const bundles = await discoverBundles(options.traceRoot, reductionStates);
    for (const bundle of bundles) {
      if (bundle.reducedAtUnixMs || !bundle.complete || bundle.status === "reducing") continue;
      const bundleDir = safeChild(options.traceRoot, bundle.id);
      const failedState = reductionStates.get(bundleDir);
      if (failedState?.status === "failed" && Date.now() - failedState.failedAtUnixMs < options.reductionRetryMs) continue;
      if (reductionChecks.has(bundleDir)) continue;
      const check = rawLogStable(bundleDir, options.reductionStabilityMs)
        .then((stable) => stable ? startReduction(bundle, { force: failedState?.status === "failed" }).catch(() => {}) : undefined)
        .finally(() => reductionChecks.delete(bundleDir));
      reductionChecks.set(bundleDir, check);
    }
  }

  function bundleDates(bundles) {
    return [...new Set(bundles.map((bundle) => localDate(bundle.startedAtUnixMs)))].sort((left, right) => right.localeCompare(left));
  }

  async function relevantReviews(bundles = null) {
    const discovered = bundles || await discoverBundles(options.traceRoot, reductionStates);
    const dates = new Set(bundleDates(discovered));
    return (await listReviews(options.dataRoot)).filter((review) => dates.has(review.date));
  }

  function reviewNeedsRefresh(date, dayBundles, review) {
    const readyBundles = dayBundles.filter((bundle) => bundle.reducedAtUnixMs && !bundle.needsReduction);
    if (!review) return dayBundles.length > 0;
    if (date === localDate()) return true;
    if ((review.summary?.sessions || 0) < readyBundles.length) return true;
    if (review.collection && (
      review.collection.totalBundles !== dayBundles.length
      || review.collection.includedBundles < readyBundles.length
    )) return true;
    return readyBundles.some((bundle) => bundle.reducedAtUnixMs > (review.generatedAtUnixMs || 0));
  }

  async function runDailyReviewNow(date = localDate(), { markScheduled = false, includeLlm = true } = {}) {
    await queueCompletedRawBundles();
    const bundles = await discoverBundles(options.traceRoot, reductionStates);
    const dayBundles = bundles.filter((bundle) => localDate(bundle.startedAtUnixMs) === date);
    const traces = [];
    const reductionErrors = [];
    for (const bundle of dayBundles) {
      if (!bundle.complete) continue;
      try {
        traces.push(await reduceBundle(bundle, { force: bundle.reductionStatus === "failed" || bundle.status === "failed" }));
      } catch (error) {
        const message = reductionError(error);
        reductionErrors.push({ id: bundle.id, error: message });
        console.error(`trace reduction failed for ${bundle.id}: ${message}`);
      }
    }
    const [inventory, storedReviews] = await Promise.all([
      collectInventory(options.codexHome),
      listReviews(options.dataRoot),
    ]);
    const previousReviews = storedReviews.filter((review) => review.date !== date);
    const existingReview = storedReviews.find((review) => review.date === date);
    const settings = await settingsPromise;
    const report = await buildDailyReview({ date, traces, inventory, previousReviews, bundleRoot: options.traceRoot, settings });
    report.collection = {
      totalBundles: dayBundles.length,
      includedBundles: traces.length,
      failedBundles: reductionErrors.length,
      activeBundles: dayBundles.filter((bundle) => !bundle.complete).length,
      refreshIntervalMinutes: Math.max(1, Math.round(options.reviewRefreshMs / 60_000)),
      reductionErrors: reductionErrors.slice(0, 10),
    };
    if (
      existingReview?.summary?.sessions > report.summary.sessions
      && (report.collection.failedBundles > 0 || report.collection.activeBundles > 0)
    ) {
      return existingReview;
    }
    if (settings.llmEnabled && includeLlm) {
      if (report.summary.sessions === 0) {
        report.llmAnalysis = { status: "skipped", model: settings.llmModel, reason: "当天没有可分析的会话" };
      } else {
        try {
          report.llmAnalysis = await analyzeDailyReview(report, settings, { fetchImpl: options.fetchImpl });
        } catch (error) {
          report.llmAnalysis = {
            status: "failed",
            model: settings.llmModel,
            generatedAtUnixMs: Date.now(),
            error: safeLlmError(error, settings.llmApiKey),
          };
        }
      }
    } else if (settings.llmEnabled) {
      report.llmAnalysis = {
        status: "skipped",
        model: settings.llmModel,
        reason: "半小时自动更新只刷新本地统计；手动或每日计划复盘会重新执行 LLM 分析",
      };
    }
    await storeReview(report, options.dataRoot);
    await pruneReviews(options.dataRoot, settings.retentionDays);
    if (markScheduled) {
      settings.lastScheduledRunDate = date;
      await saveSettings(settings);
    }
    return report;
  }

  function runDailyReview(date = localDate(), options = {}) {
    const run = reviewRunChain.then(() => runDailyReviewNow(date, options));
    reviewRunChain = run.catch(() => {});
    return run;
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (url.pathname === "/api/config") {
        json(response, 200, {
          traceRoot: options.traceRoot,
          dataRoot: options.dataRoot,
          codexHome: options.codexHome,
          codexExecutable: options.codex,
          traceCaptureEnabled: Boolean(process.env.CODEX_ROLLOUT_TRACE_ROOT),
          reviewRefreshMinutes: Math.max(1, Math.round(options.reviewRefreshMs / 60_000)),
          refreshedAtUnixMs: Date.now(),
        });
        return;
      }
      if (url.pathname === "/api/settings") {
        const settings = await settingsPromise;
        if (request.method === "PUT") {
          const updated = validateSettings(await readBody(request), settings);
          await saveSettings(updated);
          settingsPromise = Promise.resolve(updated);
          json(response, 200, settingsForClient(updated));
        } else {
          json(response, 200, settingsForClient(settings));
        }
        return;
      }
      if (url.pathname === "/api/settings/test-llm" && request.method === "POST") {
        const current = await settingsPromise;
        const draft = validateSettings({ ...await readBody(request), llmEnabled: true }, current);
        json(response, 200, await testLlmConnection(draft, { fetchImpl: options.fetchImpl }));
        return;
      }
      if (url.pathname === "/api/settings/models" && request.method === "POST") {
        const current = await settingsPromise;
        const draft = validateSettings({ ...await readBody(request), llmEnabled: false, agentEnabled: false }, current);
        json(response, 200, await discoverModels(draft, { fetchImpl: options.fetchImpl }));
        return;
      }
      if (url.pathname === "/api/settings/test-agent" && request.method === "POST") {
        const current = await settingsPromise;
        const draft = validateSettings({ ...await readBody(request), agentEnabled: true }, current);
        json(response, 200, await testAgentConnection(draft, { fetchImpl: options.fetchImpl }));
        return;
      }
      if (url.pathname === "/api/agent") {
        const settings = await settingsPromise;
        json(response, 200, await agentDashboard(agentContext(settings)));
        return;
      }
      if (url.pathname === "/api/agent/evidence") {
        const settings = await settingsPromise;
        if (url.searchParams.get("bundleId")) {
          json(response, 200, await agentEvidenceDetail(agentContext(settings), Object.fromEntries(url.searchParams.entries())));
        } else {
          json(response, 200, await agentEvidenceSummary(agentContext(settings)));
        }
        return;
      }
      if (url.pathname === "/api/agent/runs" && request.method === "POST") {
        const settings = await settingsPromise;
        const input = await readBody(request);
        const run = await createAgentAnalysisRun(agentContext(settings), input);
        launchAgentRun(run, settings);
        json(response, 202, run);
        return;
      }
      const agentRunMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)$/);
      if (agentRunMatch) {
        const id = decodeURIComponent(agentRunMatch[1]);
        if (request.method === "DELETE") {
          const run = await getRun(options.dataRoot, id);
          if (!["idle", "analyzing"].includes(run.state)) throw new Error(`Agent run cannot be stopped from ${run.state}`);
          activeAgentRuns.get(id)?.controller.abort(new Error("用户已停止分析"));
          json(response, 200, await updateRun(options.dataRoot, id, { state: "failed", error: "用户已停止分析", progress: { phase: "failed", completed: 0, total: null, message: "用户已停止分析" } }));
        } else {
          json(response, 200, await getRun(options.dataRoot, id));
        }
        return;
      }
      const agentResumeMatch = url.pathname.match(/^\/api\/agent\/runs\/([^/]+)\/resume$/);
      if (agentResumeMatch && request.method === "POST") {
        const source = await getRun(options.dataRoot, decodeURIComponent(agentResumeMatch[1]));
        if (source.state !== "failed") throw new Error("only failed Agent runs can be resumed");
        const settings = await settingsPromise;
        const run = await createAgentAnalysisRun(agentContext(settings), { mode: source.mode, cursor: source.baseCursor, resumedFromRunId: source.id, scope: source.scope });
        launchAgentRun(run, settings);
        json(response, 202, run);
        return;
      }
      const proposalDecisionMatch = url.pathname.match(/^\/api\/agent\/proposals\/([^/]+)\/decision$/);
      if (proposalDecisionMatch && request.method === "POST") {
        const settings = await settingsPromise;
        json(response, 200, await decideAgentProposal(agentContext(settings), decodeURIComponent(proposalDecisionMatch[1]), await readBody(request)));
        return;
      }
      const proposalApplyMatch = url.pathname.match(/^\/api\/agent\/proposals\/([^/]+)\/apply$/);
      if (proposalApplyMatch && request.method === "POST") {
        const settings = await settingsPromise;
        const body = await readBody(request);
        json(response, 200, await applyAgentProposal(agentContext(settings), decodeURIComponent(proposalApplyMatch[1]), body.token));
        return;
      }
      const proposalMatch = url.pathname.match(/^\/api\/agent\/proposals\/([^/]+)$/);
      if (proposalMatch) {
        const settings = await settingsPromise;
        json(response, 200, await proposalDetail(agentContext(settings), decodeURIComponent(proposalMatch[1])));
        return;
      }
      const rollbackMatch = url.pathname.match(/^\/api\/agent\/changes\/([^/]+)\/rollback$/);
      if (rollbackMatch && request.method === "POST") {
        const settings = await settingsPromise;
        const body = await readBody(request);
        json(response, 200, await rollbackAgentChange(agentContext(settings), decodeURIComponent(rollbackMatch[1]), body.confirm === true));
        return;
      }
      if (url.pathname === "/api/inventory") {
        json(response, 200, await collectInventory(options.codexHome));
        return;
      }
      if (url.pathname === "/api/reviews") {
        json(response, 200, { reviews: await relevantReviews() });
        return;
      }
      if (url.pathname === "/api/reviews/run" && request.method === "POST") {
        json(response, 200, await runDailyReview(url.searchParams.get("date") || localDate(), { includeLlm: true }));
        return;
      }
      const reviewMatch = url.pathname.match(/^\/api\/reviews\/(\d{4}-\d{2}-\d{2})$/);
      if (reviewMatch) {
        const reviews = await relevantReviews();
        const review = reviews.find((item) => item.date === reviewMatch[1]);
        json(response, review ? 200 : 404, review || { error: "review not found" });
        return;
      }
      if (url.pathname === "/api/traces") {
        void queueCompletedRawBundles().catch((error) => console.error(`trace reduction queue failed: ${reductionError(error)}`));
        json(response, 200, { traces: await discoverBundles(options.traceRoot, reductionStates) });
        return;
      }
      const stateMatch = url.pathname.match(/^\/api\/traces\/([^/]+)$/);
      if (stateMatch) {
        const id = decodeURIComponent(stateMatch[1]);
        const bundleDir = safeChild(options.traceRoot, id);
        const statePath = path.join(bundleDir, "state.json");
        if (!(await exists(bundleDir))) {
          json(response, 404, { error: "trace bundle not found" });
          return;
        }
        const bundles = await discoverBundles(options.traceRoot, reductionStates);
        let bundle = bundles.find((item) => item.id === id);
        if (!bundle) {
          json(response, 404, { error: "trace bundle not found" });
          return;
        }
        const shouldReduce = url.searchParams.get("reduce") === "1";
        if (shouldReduce && (bundle.needsReduction || !(await exists(statePath)))) {
          try {
            await reduceBundle(bundle, { force: true });
            bundle = (await discoverBundles(options.traceRoot, reductionStates)).find((item) => item.id === id) || bundle;
          } catch (error) {
            if (error?.code === "TRACE_ACTIVE") {
              json(response, 409, { error: error.message, canReduce: false, complete: false, status: "raw" });
              return;
            }
            json(response, 500, { error: reductionError(error), canReduce: true, complete: bundle.complete, status: "failed" });
            return;
          }
        }
        if (bundle.needsReduction && !shouldReduce) {
          json(response, 409, {
            error: bundle.reductionError || "Trace 有新的已完成 turn，等待归约",
            canReduce: bundle.canReduce,
            complete: bundle.complete,
            status: bundle.status,
          });
          return;
        }
        if (!(await exists(statePath))) {
          json(response, 409, {
            error: bundle.reductionError || "state.json is missing",
            canReduce: bundle.canReduce,
            complete: bundle.complete,
            status: bundle.status,
          });
          return;
        }
        const trace = await readJson(statePath);
        decorateTraceState(trace, bundle);
        json(response, 200, trace);
        return;
      }
      const payloadMatch = url.pathname.match(/^\/api\/traces\/([^/]+)\/payloads\/([^/]+)$/);
      if (payloadMatch) {
        const id = decodeURIComponent(payloadMatch[1]);
        const payloadId = decodeURIComponent(payloadMatch[2]);
        const bundleDir = safeChild(options.traceRoot, id);
        const state = await readJson(path.join(bundleDir, "state.json"));
        const reference = state.raw_payloads?.[payloadId];
        if (!reference?.path) {
          json(response, 404, { error: "payload not found" });
          return;
        }
        const payloadFile = safeChild(bundleDir, reference.path);
        response.writeHead(200, {
          "content-type": contentTypes[".json"],
          "cache-control": "no-store",
        });
        createReadStream(payloadFile).pipe(response);
        return;
      }
      await serveStatic(response, url.pathname);
    } catch (error) {
      json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  const reductionScheduler = setInterval(() => {
    queueCompletedRawBundles().catch((error) => console.error(`trace reduction queue failed: ${reductionError(error)}`));
  }, options.reductionPollMs);
  reductionScheduler.unref();
  const scheduler = setInterval(async () => {
    try {
      const settings = await settingsPromise;
      if (shouldRunScheduledReview(settings)) await runDailyReview(localDate(), { markScheduled: true, includeLlm: true });
    } catch (error) {
      console.error(`daily review failed: ${error instanceof Error ? error.message : error}`);
    }
  }, 30_000);
  scheduler.unref();
  const refreshReview = async () => {
    try {
      const settings = await settingsPromise;
      if (!settings.enabled) return;
      await queueCompletedRawBundles();
      const bundles = await discoverBundles(options.traceRoot, reductionStates);
      const reviews = await relevantReviews(bundles);
      const reviewsByDate = new Map(reviews.map((review) => [review.date, review]));
      for (const date of bundleDates(bundles)) {
        const dayBundles = bundles.filter((bundle) => localDate(bundle.startedAtUnixMs) === date);
        if (!reviewNeedsRefresh(date, dayBundles, reviewsByDate.get(date))) continue;
        await runDailyReview(date, { includeLlm: false });
      }
    } catch (error) {
      console.error(`automatic review refresh failed: ${error instanceof Error ? error.message : error}`);
    }
  };
  const reviewRefreshScheduler = setInterval(refreshReview, options.reviewRefreshMs);
  reviewRefreshScheduler.unref();
  const initialReviewTimer = setTimeout(refreshReview, options.initialReviewDelayMs);
  initialReviewTimer.unref();
  server.on("close", () => {
    clearInterval(scheduler);
    clearInterval(reductionScheduler);
    clearInterval(reviewRefreshScheduler);
    clearTimeout(initialReviewTimer);
  });
  void queueCompletedRawBundles().catch((error) => console.error(`trace reduction queue failed: ${reductionError(error)}`));
  void settingsPromise.then((settings) => recoverInterruptedAgentState(agentContext(settings))).catch((error) => console.error(`Agent store recovery failed: ${reductionError(error)}`));
  return server;
}

function safeLlmError(error, apiKey) {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) message = message.replaceAll(apiKey, "[已隐藏密钥]");
  return message.length > 600 ? `${message.slice(0, 599)}…` : message;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const server = createViewerServer(options);
    server.listen(options.port, options.host, () => {
      console.log(`Codex Trace Viewer: http://${options.host}:${options.port}`);
      console.log(`Trace root: ${options.traceRoot}`);
      console.log(`Insights repository: ${options.dataRoot}`);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

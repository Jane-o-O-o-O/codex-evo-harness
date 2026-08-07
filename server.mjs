import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, open, readFile, readdir, stat } from "node:fs/promises";
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
import { analyzeDailyReview, testLlmConnection } from "./llm-review.mjs";

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
    runReducerImpl: runReducer,
    fetchImpl: globalThis.fetch,
    ...options,
  };
  const reducing = new Map();
  const reductionChecks = new Map();
  const reductionStates = new Map();
  let settingsPromise = loadSettings(options.dataRoot);

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
      if (bundle.reducedAtUnixMs || !bundle.complete || bundle.status === "reducing" || bundle.status === "failed") continue;
      const bundleDir = safeChild(options.traceRoot, bundle.id);
      if (reductionChecks.has(bundleDir)) continue;
      const check = rawLogStable(bundleDir, options.reductionStabilityMs)
        .then((stable) => stable ? startReduction(bundle).catch(() => {}) : undefined)
        .finally(() => reductionChecks.delete(bundleDir));
      reductionChecks.set(bundleDir, check);
    }
  }

  async function runDailyReview(date = localDate(), markScheduled = false) {
    await queueCompletedRawBundles();
    const bundles = await discoverBundles(options.traceRoot, reductionStates);
    const dayBundles = bundles.filter((bundle) => localDate(bundle.startedAtUnixMs) === date);
    const traces = [];
    for (const bundle of dayBundles) {
      if (!bundle.complete) continue;
      try {
        traces.push(await reduceBundle(bundle));
      } catch (error) {
        console.error(`trace reduction failed for ${bundle.id}: ${reductionError(error)}`);
      }
    }
    const [inventory, storedReviews] = await Promise.all([
      collectInventory(options.codexHome),
      listReviews(options.dataRoot),
    ]);
    const previousReviews = storedReviews.filter((review) => review.date !== date);
    const settings = await settingsPromise;
    const report = await buildDailyReview({ date, traces, inventory, previousReviews, bundleRoot: options.traceRoot, settings });
    if (settings.llmEnabled) {
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
    }
    await storeReview(report, options.dataRoot);
    await pruneReviews(options.dataRoot, settings.retentionDays);
    if (markScheduled) {
      settings.lastScheduledRunDate = date;
      await saveSettings(settings);
    }
    return report;
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
      if (url.pathname === "/api/inventory") {
        json(response, 200, await collectInventory(options.codexHome));
        return;
      }
      if (url.pathname === "/api/reviews") {
        json(response, 200, { reviews: await listReviews(options.dataRoot) });
        return;
      }
      if (url.pathname === "/api/reviews/run" && request.method === "POST") {
        json(response, 200, await runDailyReview(url.searchParams.get("date") || localDate()));
        return;
      }
      const reviewMatch = url.pathname.match(/^\/api\/reviews\/(\d{4}-\d{2}-\d{2})$/);
      if (reviewMatch) {
        const reviews = await listReviews(options.dataRoot);
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
      if (shouldRunScheduledReview(settings)) await runDailyReview(localDate(), true);
    } catch (error) {
      console.error(`daily review failed: ${error instanceof Error ? error.message : error}`);
    }
  }, 30_000);
  scheduler.unref();
  server.on("close", () => {
    clearInterval(scheduler);
    clearInterval(reductionScheduler);
  });
  void queueCompletedRawBundles().catch((error) => console.error(`trace reduction queue failed: ${reductionError(error)}`));
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

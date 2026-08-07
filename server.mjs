import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
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

async function discoverBundles(traceRoot) {
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
      bundles.push({
        id: entry.name,
        traceId: manifest.trace_id,
        rolloutId: manifest.rollout_id,
        rootThreadId: manifest.root_thread_id,
        startedAtUnixMs: manifest.started_at_unix_ms,
        endedAtUnixMs: summary?.endedAtUnixMs ?? null,
        status: stateInfo ? (summary?.status || "corrupt") : "raw",
        durationMs: summary?.durationMs ?? null,
        firstUserMessage: summary?.firstUserMessage || "",
        models: summary?.models || [],
        tools: summary?.tools ?? 0,
        inputTokens: summary?.inputTokens ?? 0,
        outputTokens: summary?.outputTokens ?? 0,
        reasoningTokens: summary?.reasoningTokens ?? 0,
        project: summary?.project || "",
        reducedAtUnixMs: stateInfo?.mtimeMs ?? null,
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
    fetchImpl: globalThis.fetch,
    ...options,
  };
  const reducing = new Map();
  let settingsPromise = loadSettings(options.dataRoot);

  async function reduceBundle(bundle) {
    const bundleDir = safeChild(options.traceRoot, bundle.id);
    const statePath = path.join(bundleDir, "state.json");
    if (await exists(statePath)) {
      const trace = await readJson(statePath);
      Object.defineProperty(trace, "__bundleId", { value: bundle.id, enumerable: false });
      return trace;
    }
    let pending = reducing.get(bundleDir);
    if (!pending) {
      pending = runReducer(options.codex, bundleDir).finally(() => reducing.delete(bundleDir));
      reducing.set(bundleDir, pending);
    }
    await pending;
    const trace = await readJson(statePath);
    Object.defineProperty(trace, "__bundleId", { value: bundle.id, enumerable: false });
    return trace;
  }

  async function runDailyReview(date = localDate(), markScheduled = false) {
    const bundles = await discoverBundles(options.traceRoot);
    const dayBundles = bundles.filter((bundle) => localDate(bundle.startedAtUnixMs) === date);
    const traces = [];
    for (const bundle of dayBundles) traces.push(await reduceBundle(bundle));
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
        json(response, 200, { traces: await discoverBundles(options.traceRoot) });
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
        if (url.searchParams.get("reduce") === "1" && !(await exists(statePath))) {
          let pending = reducing.get(bundleDir);
          if (!pending) {
            pending = runReducer(options.codex, bundleDir).finally(() => reducing.delete(bundleDir));
            reducing.set(bundleDir, pending);
          }
          await pending;
        }
        if (!(await exists(statePath))) {
          json(response, 409, { error: "state.json is missing", canReduce: true });
          return;
        }
        json(response, 200, await readJson(statePath));
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
  const scheduler = setInterval(async () => {
    try {
      const settings = await settingsPromise;
      if (shouldRunScheduledReview(settings)) await runDailyReview(localDate(), true);
    } catch (error) {
      console.error(`daily review failed: ${error instanceof Error ? error.message : error}`);
    }
  }, 30_000);
  scheduler.unref();
  server.on("close", () => clearInterval(scheduler));
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

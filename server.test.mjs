import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { createViewerServer, parseArgs, safeChild } from "./server.mjs";
import { localDate } from "./insights.mjs";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

test("parseArgs resolves trace root and overrides options", () => {
  const options = parseArgs([
    "--trace-root",
    "fixtures",
    "--host",
    "0.0.0.0",
    "--port",
    "9000",
    "--codex",
    "codex-dev",
  ]);
  assert.equal(options.traceRoot, path.resolve("fixtures"));
  assert.equal(options.host, "0.0.0.0");
  assert.equal(options.port, 9000);
  assert.equal(options.codex, "codex-dev");
});

test("safeChild accepts descendants and rejects traversal", () => {
  const root = path.resolve("trace-root");
  assert.equal(safeChild(root, "bundle/state.json"), path.join(root, "bundle", "state.json"));
  assert.throws(() => safeChild(root, "../secret"), /escapes trace root/);
});

test("parseArgs rejects invalid ports and unknown arguments", () => {
  assert.throws(() => parseArgs(["--port", "0"]), /--port/);
  assert.throws(() => parseArgs(["--wat"]), /unknown argument/);
});

test("viewer serves trace state and referenced payloads", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-"));
  const llmRequests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    llmRequests.push({ url, headers: options.headers, body });
    const isConnectionTest = body.messages[0].content.includes("连接测试");
    const content = isConnectionTest ? "OK" : JSON.stringify({
      overview: "主要用于项目检查",
      scenarios: [{ name: "代码质量", summary: "检查项目风险", evidence: ["检查会话"], tools: ["exec_command"], skills: [] }],
      habits: ["偏好先分析再修改"],
      recommendations: ["继续补充自动化测试"],
    });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  const server = createViewerServer({
    traceRoot: fixtureRoot,
    dataRoot,
    codexHome: dataRoot,
    codex: path.join(dataRoot, "missing-codex"),
    fetchImpl,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const manifestResponse = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(manifestResponse.headers.get("content-type"), "application/manifest+json; charset=utf-8");
  assert.equal((await manifestResponse.json()).display, "standalone");
  const iconResponse = await fetch(`${base}/icon.svg`);
  assert.equal(iconResponse.headers.get("content-type"), "image/svg+xml");

  const traces = await fetch(`${base}/api/traces`).then((response) => response.json());
  assert.equal(traces.traces[0].rolloutId, "rollout-sample");
  assert.equal(traces.traces[0].status, "completed");
  assert.deepEqual(traces.traces[0].models, ["gpt-5"]);
  assert.equal(traces.traces[0].tools, 1);
  assert.equal(traces.traces[0].inputTokens, 1420);
  assert.equal(traces.traces[0].firstUserMessage, "检查项目并总结关键风险");
  assert.equal(traces.traces[0].rolloutStatus, "completed");
  assert.equal(traces.traces[0].displayStatus, "completed");

  const trace = await fetch(`${base}/api/traces/sample`).then((response) => response.json());
  assert.equal(trace.inference_calls["inference-1"].usage.input_tokens, 1420);

  const readyTrace = await fetch(`${base}/api/traces/sample?reduce=1`);
  assert.equal(readyTrace.status, 200);

  const payload = await fetch(`${base}/api/traces/sample/payloads/payload-request`).then((response) => response.json());
  assert.equal(payload.model, "gpt-5");

  const settings = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      scheduleTime: "08:45",
      inactiveSkillDays: 60,
      llmEnabled: true,
      llmBaseUrl: "https://llm.example/v1",
      llmModel: "analysis-model",
      llmApiKey: "private-key",
    }),
  }).then((response) => response.json());
  assert.equal(settings.scheduleTime, "08:45");
  assert.equal(settings.inactiveSkillDays, 60);
  assert.equal(settings.llmApiKeyConfigured, true);
  assert.equal("llmApiKey" in settings, false);

  const connection = await fetch(`${base}/api/settings/test-llm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }).then((response) => response.json());
  assert.equal(connection.ok, true);

  const review = await fetch(`${base}/api/reviews/run?date=${localDate(traces.traces[0].startedAtUnixMs)}`, {
    method: "POST",
  }).then((response) => response.json());
  assert.equal(review.error, undefined, review.error);
  assert.equal(review.llmAnalysis.status, "completed");
  assert.equal(review.llmAnalysis.scenarios[0].name, "代码质量");
  assert.equal(llmRequests.length, 2);
  assert.equal(llmRequests[0].headers.authorization, "Bearer private-key");
});

test("viewer automatically reduces completed raw bundles and leaves active bundles alone", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-raw-traces-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-raw-data-"));
  const sampleState = await readFile(path.join(fixtureRoot, "sample", "state.json"), "utf8");
  const manifest = JSON.stringify({
    schema_version: 1,
    trace_id: "trace-raw",
    rollout_id: "rollout-raw",
    root_thread_id: "thread-root",
    started_at_unix_ms: Date.now(),
    raw_event_log: "trace.jsonl",
    payloads_dir: "payloads",
  });
  for (const id of ["active", "complete"]) {
    const bundleDir = path.join(traceRoot, id);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "manifest.json"), manifest);
  }
  await writeFile(path.join(traceRoot, "active", "trace.jsonl"), `${JSON.stringify({ payload: { type: "thread_started" } })}\n`);
  await writeFile(path.join(traceRoot, "complete", "trace.jsonl"), `${JSON.stringify({ seq: 1, payload: { type: "codex_turn_started" } })}\n${JSON.stringify({ seq: 2, payload: { type: "codex_turn_ended" } })}\n`);
  let reducerCalls = 0;
  const server = createViewerServer({
    traceRoot,
    dataRoot,
    codex: "unused",
    reductionPollMs: 20,
    runReducerImpl: async (_codex, bundleDir) => {
      reducerCalls += 1;
      await writeFile(path.join(bundleDir, "state.json"), sampleState);
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const deadline = Date.now() + 1_000;
  let traces;
  do {
    traces = await fetch(`${base}/api/traces`).then((response) => response.json());
    if (traces.traces.find((trace) => trace.id === "complete")?.reducedAtUnixMs) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  const active = traces.traces.find((trace) => trace.id === "active");
  const complete = traces.traces.find((trace) => trace.id === "complete");
  assert.equal(active.complete, false);
  assert.equal(active.canReduce, false);
  assert.equal(complete.reducedAtUnixMs > 0, true);
  assert.equal(reducerCalls, 1);

  const activeResponse = await fetch(`${base}/api/traces/active?reduce=1`);
  assert.equal(activeResponse.status, 409);
  assert.equal((await activeResponse.json()).canReduce, false);

  await new Promise((resolve) => setTimeout(resolve, 20));
  await appendFile(path.join(traceRoot, "complete", "trace.jsonl"), `${JSON.stringify({ seq: 3, payload: { type: "codex_turn_started" } })}\n${JSON.stringify({ seq: 4, payload: { type: "codex_turn_ended" } })}\n`);
  const secondDeadline = Date.now() + 1_000;
  while (reducerCalls < 2 && Date.now() < secondDeadline) {
    await fetch(`${base}/api/traces`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(reducerCalls, 2);
});

test("viewer separates the latest turn status from an open rollout", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-status-traces-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-status-data-"));
  const startedAtUnixMs = Date.now();
  const bundles = [
    {
      id: "turn-complete",
      traceId: "trace-turn-complete",
      rolloutId: "rollout-turn-complete",
      turnStatus: "completed",
      events: [
        { wall_time_unix_ms: startedAtUnixMs, payload: { type: "codex_turn_started" } },
        { wall_time_unix_ms: startedAtUnixMs + 200, payload: { type: "codex_turn_ended", status: "completed" } },
        { wall_time_unix_ms: startedAtUnixMs + 201, payload: { type: "protocol_event_observed", event_type: "turn_complete" } },
      ],
    },
    {
      id: "turn-aborted",
      traceId: "trace-turn-aborted",
      rolloutId: "rollout-turn-aborted",
      turnStatus: "aborted",
      events: [
        { wall_time_unix_ms: startedAtUnixMs + 10, payload: { type: "codex_turn_started" } },
        { wall_time_unix_ms: startedAtUnixMs + 310, payload: { type: "codex_turn_ended", status: "cancelled" } },
        { wall_time_unix_ms: startedAtUnixMs + 311, payload: { type: "protocol_event_observed", event_type: "turn_aborted" } },
      ],
    },
  ];
  for (const bundle of bundles) {
    const bundleDir = path.join(traceRoot, bundle.id);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "manifest.json"), JSON.stringify({
      schema_version: 1,
      trace_id: bundle.traceId,
      rollout_id: bundle.rolloutId,
      root_thread_id: bundle.rolloutId,
      started_at_unix_ms: startedAtUnixMs,
      raw_event_log: "trace.jsonl",
      payloads_dir: "payloads",
    }));
    await writeFile(path.join(bundleDir, "trace.jsonl"), `${bundle.events.map((event, seq) => JSON.stringify({ seq: seq + 1, ...event })).join("\n")}\n`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(path.join(bundleDir, "state.json"), JSON.stringify({
      schema_version: 1,
      trace_id: bundle.traceId,
      rollout_id: bundle.rolloutId,
      status: "running",
      started_at_unix_ms: startedAtUnixMs,
      ended_at_unix_ms: null,
      inference_calls: {},
      tool_calls: {},
      codex_turns: {},
      conversation_items: {},
      raw_payloads: {},
    }));
  }
  const server = createViewerServer({ traceRoot, dataRoot, codex: "unused" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const traces = await fetch(`${base}/api/traces`).then((response) => response.json());
  const complete = traces.traces.find((trace) => trace.id === "turn-complete");
  const aborted = traces.traces.find((trace) => trace.id === "turn-aborted");
  assert.equal(complete.status, "running");
  assert.equal(complete.rolloutStatus, "running");
  assert.equal(complete.turnStatus, "completed");
  assert.equal(complete.displayStatus, "completed");
  assert.equal(complete.turnDurationMs, 201);
  assert.equal(aborted.status, "running");
  assert.equal(aborted.rolloutStatus, "running");
  assert.equal(aborted.turnStatus, "aborted");
  assert.equal(aborted.displayStatus, "aborted");
  const detail = await fetch(`${base}/api/traces/turn-complete`).then((response) => response.json());
  assert.equal(detail.display_status, "completed");
  assert.equal(detail.rollout_status, "running");
  assert.equal(detail.turn_status, "completed");
});

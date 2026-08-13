import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import test from "node:test";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { createViewerServer, parseArgs, rewritePayloadForCompatibility, rewriteTraceLogForCompatibility, safeChild } from "./server.mjs";
import { localDate } from "./insights.mjs";
import { sha256 } from "./agent-schema.mjs";
import { createProposal, createRun, updateRun } from "./agent-store.mjs";

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

test("compatibility rewrite removes only reducer-incompatible internal metadata", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-trace-compat-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.json");
  const destination = path.join(root, "destination.json");
  const payload = {
    output_items: [{
      type: "custom_tool_call",
      call_id: "call_duplicate",
      id: "ctc-response-id",
      input: "work()",
      internal_chat_message_metadata_passthrough: { code_mode_runtime_tool_id: "tool-1" },
    }],
    response_item: {
      type: "function_call_output",
      id: "fc-output-id",
      call_id: "call_duplicate",
      output: [{ type: "input_image", image_url: "data:image/png;base64,abc", detail: "original" }],
    },
    untouched: { value: 42 },
  };
  await writeFile(source, JSON.stringify(payload));
  assert.equal(await rewritePayloadForCompatibility(source, destination), 5);
  const rewritten = JSON.parse(await readFile(destination, "utf8"));
  assert.equal("internal_chat_message_metadata_passthrough" in rewritten.output_items[0], false);
  assert.equal("id" in rewritten.output_items[0], false);
  assert.equal(rewritten.output_items[0].call_id, "call_duplicate");
  assert.equal(rewritten.output_items[0].input, "work()");
  assert.deepEqual(rewritten.response_item.output, [{ type: "input_image" }]);
  assert.equal("id" in rewritten.response_item, false);
  assert.deepEqual(rewritten.untouched, { value: 42 });

  const customToolSource = path.join(root, "custom-tool-source.json");
  const customToolDestination = path.join(root, "custom-tool-destination.json");
  await writeFile(customToolSource, JSON.stringify({
    input: [
      { type: "message", role: "user", content: "keep" },
      { type: "custom_tool_call", call_id: "call_duplicate", input: "work()" },
      { type: "custom_tool_call_output", call_id: "call_duplicate", output: [{ type: "text", text: "done" }] },
      { type: "function_call", call_id: "call_function", name: "wait", arguments: "{}" },
      { type: "function_call_output", call_id: "call_function", output: "done" },
    ],
  }));
  assert.equal(await rewritePayloadForCompatibility(customToolSource, customToolDestination, { dropCustomToolItems: true }), 4);
  const customToolRewritten = JSON.parse(await readFile(customToolDestination, "utf8"));
  assert.deepEqual(customToolRewritten.input, [{ type: "message", role: "user", content: "keep" }]);

  const traceSource = path.join(root, "trace-source.jsonl");
  const traceDestination = path.join(root, "trace-destination.jsonl");
  const events = [
    { seq: 10, payload: { type: "code_cell_started", runtime_cell_id: "31", model_visible_call_id: "call_duplicate", source_js: "work()" } },
    { seq: 11, payload: { type: "tool_call_started", tool_call_id: "call_duplicate", model_visible_call_id: "call_duplicate" } },
  ];
  await writeFile(traceSource, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  assert.equal(await rewriteTraceLogForCompatibility(traceSource, traceDestination), 2);
  const traceEvents = (await readFile(traceDestination, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(traceEvents[0].payload.model_visible_call_id, "call_viewer_10_31");
  assert.equal(traceEvents[0].payload.source_js, "work()");
  assert.equal(traceEvents[1].payload.model_visible_call_id, "call_viewer_11_call_duplicate");
  assert.equal(traceEvents[1].payload.tool_call_id, "call_duplicate");
});

test("viewer serves trace state and referenced payloads", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-viewer-"));
  const llmRequests = [];
  const fetchImpl = async (url, options) => {
    if (String(url).endsWith("/models")) {
      llmRequests.push({ url, headers: options.headers, method: "GET" });
      return new Response(JSON.stringify({ data: [{ id: "analysis-model" }, { id: "backup-model" }] }), { status: 200 });
    }
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
      agentEnabled: true,
      agentMaxTokens: 120_000,
      agentLookbackDays: 45,
      agentProjectAllowlist: [fixtureRoot],
      agentAllowPayloads: false,
    }),
  }).then((response) => response.json());
  assert.equal(settings.scheduleTime, "08:45");
  assert.equal(settings.inactiveSkillDays, 60);
  assert.equal(settings.llmApiKeyConfigured, true);
  assert.equal("llmApiKey" in settings, false);
  assert.equal(settings.agentMaxTokens, 120_000);
  assert.equal(settings.agentLookbackDays, 45);
  assert.deepEqual(settings.agentProjectAllowlist, [path.resolve(fixtureRoot)]);
  assert.equal(settings.agentAllowPayloads, false);
  assert.equal("agentModel" in settings, false);

  const persistedSettings = JSON.parse(await readFile(path.join(dataRoot, "settings.json"), "utf8"));
  assert.equal(persistedSettings.llmApiKey, "private-key");
  assert.equal("agentApiKey" in persistedSettings, false);
  assert.equal(persistedSettings.agentMaxTokens, 120_000);

  const models = await fetch(`${base}/api/settings/models`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ llmBaseUrl: "https://llm.example/v1" }),
  }).then((response) => response.json());
  assert.deepEqual(models.models, ["analysis-model", "backup-model"]);

  const evidence = await fetch(`${base}/api/agent/evidence?bundleId=sample&itemId=item-user`).then((response) => response.json());
  assert.equal(evidence.kind, "conversation_window");
  assert.equal(evidence.value.items[0].itemId, "item-user");

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
  assert.equal(llmRequests.length, 3);
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

test("viewer refreshes the current daily review automatically", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-review-traces-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-review-data-"));
  const now = Date.now();
  const bundleDir = path.join(traceRoot, "today");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(path.join(bundleDir, "manifest.json"), JSON.stringify({
    schema_version: 1,
    trace_id: "trace-today",
    rollout_id: "rollout-today",
    root_thread_id: "thread-root",
    started_at_unix_ms: now,
    raw_event_log: "trace.jsonl",
    payloads_dir: "payloads",
  }));
  const state = JSON.parse(await readFile(path.join(fixtureRoot, "sample", "state.json"), "utf8"));
  state.trace_id = "trace-today";
  state.rollout_id = "rollout-today";
  state.started_at_unix_ms = now;
  state.ended_at_unix_ms = now + 4_200;
  await writeFile(path.join(bundleDir, "state.json"), JSON.stringify(state));

  const server = createViewerServer({
    traceRoot,
    dataRoot,
    codexHome: dataRoot,
    codex: "unused",
    initialReviewDelayMs: 10,
    reviewRefreshMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const date = localDate(now);
  const deadline = Date.now() + 1_000;
  let review;
  do {
    const reviews = await fetch(`${base}/api/reviews`).then((response) => response.json());
    review = reviews.reviews.find((item) => item.date === date);
    if (review) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  assert.equal(review?.summary.sessions, 1);
  assert.equal(review?.collection.totalBundles, 1);
  assert.equal(review?.collection.includedBundles, 1);
  assert.equal(review?.collection.refreshIntervalMinutes, 1);
});

test("viewer backfills historical reviews and hides reports without trace bundles", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-review-history-traces-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-review-history-data-"));
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const sampleState = JSON.parse(await readFile(path.join(fixtureRoot, "sample", "state.json"), "utf8"));
  for (const [id, startedAt] of [["today", today.getTime()], ["yesterday", yesterday.getTime()]]) {
    const bundleDir = path.join(traceRoot, id);
    await mkdir(bundleDir, { recursive: true });
    await writeFile(path.join(bundleDir, "manifest.json"), JSON.stringify({
      schema_version: 1,
      trace_id: `trace-${id}`,
      rollout_id: `rollout-${id}`,
      root_thread_id: "thread-root",
      started_at_unix_ms: startedAt,
      raw_event_log: "trace.jsonl",
      payloads_dir: "payloads",
    }));
    await writeFile(path.join(bundleDir, "state.json"), JSON.stringify({
      ...sampleState,
      trace_id: `trace-${id}`,
      rollout_id: `rollout-${id}`,
      started_at_unix_ms: startedAt,
      ended_at_unix_ms: startedAt + 4_200,
    }));
  }
  await mkdir(path.join(dataRoot, "reports"), { recursive: true });
  const emptyReport = (date) => ({
    schemaVersion: 1,
    date,
    generatedAtUnixMs: Date.now() - 60_000,
    summary: { sessions: 0, modelCalls: 0 },
  });
  await writeFile(path.join(dataRoot, "reports", `${localDate(yesterday.getTime())}.json`), JSON.stringify(emptyReport(localDate(yesterday.getTime()))));
  await writeFile(path.join(dataRoot, "reports", "2020-01-01.json"), JSON.stringify(emptyReport("2020-01-01")));

  const server = createViewerServer({
    traceRoot,
    dataRoot,
    codexHome: dataRoot,
    codex: "unused",
    initialReviewDelayMs: 10,
    reviewRefreshMs: 60_000,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const deadline = Date.now() + 1_500;
  let reviews = [];
  do {
    reviews = (await fetch(`${base}/api/reviews`).then((response) => response.json())).reviews;
    if (reviews.length === 2 && reviews.every((review) => review.summary.sessions === 1)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);

  assert.deepEqual(reviews.map((review) => review.date), [localDate(today.getTime()), localDate(yesterday.getTime())]);
  assert.deepEqual(reviews.map((review) => review.summary.sessions), [1, 1]);
  assert.equal(reviews.some((review) => review.date === "2020-01-01"), false);
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

test("Agent HTTP flow requires approval, applies the exact operation, and rolls back", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-http-traces-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-http-data-"));
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "codex-agent-http-home-"));
  const targetPath = path.join(codexHome, "AGENTS.md");
  await writeFile(targetPath, "Before.\n");
  const run = await createRun(dataRoot);
  await updateRun(dataRoot, run.id, { state: "analyzing" });
  await updateRun(dataRoot, run.id, { state: "awaiting_approval" });
  const proposal = await createProposal(dataRoot, {
    runId: run.id,
    title: "Use preferred guidance",
    summary: "Update global instructions.",
    rationale: "Explicit user correction.",
    target: { type: "global_instructions", scope: "global", path: targetPath, id: "global-agents" },
    operation: { kind: "instructions.patch", content: "After.\n" },
    expectedTargetHash: sha256("Before.\n"),
    evidence: [{ bundleId: "bundle-evidence", signal: "correction", excerpt: "不要这样做" }],
    risk: "low",
  });
  const server = createViewerServer({ traceRoot, dataRoot, codexHome, codex: "unused", initialReviewDelayMs: 60_000 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  context.after(() => rm(codexHome, { recursive: true, force: true }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const dashboard = await fetch(`${base}/api/agent`).then((response) => response.json());
  assert.equal(dashboard.proposals[0].id, proposal.id);
  const denied = await fetch(`${base}/api/agent/proposals/${proposal.id}/apply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "missing" }),
  });
  assert.equal(denied.status, 500);
  assert.equal(await readFile(targetPath, "utf8"), "Before.\n");

  const decision = await fetch(`${base}/api/agent/proposals/${proposal.id}/decision`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "approved" }),
  }).then((response) => response.json());
  assert.ok(decision.token);
  const applied = await fetch(`${base}/api/agent/proposals/${proposal.id}/apply`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: decision.token }),
  }).then((response) => response.json());
  assert.equal(applied.change.state, "completed");
  assert.equal(await readFile(targetPath, "utf8"), "After.\n");

  const rollback = await fetch(`${base}/api/agent/changes/${applied.change.id}/rollback`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true }),
  }).then((response) => response.json());
  assert.equal(rollback.state, "rolled_back");
  assert.equal(await readFile(targetPath, "utf8"), "Before.\n");
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJsonAtomic } from "./agent-store.mjs";
import {
  aggregateTraces, findCancelledTurns, findTraceFeedback, getTracePayload,
  listTraceSessions, refreshTraceIndex, searchTraces, traceBundleIdsSince,
} from "./trace-query.mjs";

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "trace-query-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { traceRoot: path.join(root, "traces"), dataRoot: path.join(root, "data") };
  await mkdir(context.traceRoot);
  return context;
}

async function bundle(context, id, state) {
  const directory = path.join(context.traceRoot, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "state.json"), JSON.stringify(state));
  return directory;
}

test("aggregate and evidence searches include sessions beyond the list limit", async (t) => {
  const context = await workspace(t);
  for (let offset = 0; offset < 1_001; offset += 32) {
    await Promise.all(Array.from({ length: Math.min(32, 1_001 - offset) }, (_, n) => {
      const i = offset + n;
      return bundle(context, `bundle-${i}`, { started_at_unix_ms: i + 1 });
    }));
  }
  await bundle(context, "oldest", {
    started_at_unix_ms: 0,
    codex_turns: { turn: { codex_turn_id: "turn", execution: { status: "cancelled" } } },
    conversation_items: {
      assistant: { item_id: "assistant", role: "assistant", first_seen_at_unix_ms: 1, body: { parts: [{ text: "Proposed answer" }] } },
      user: { item_id: "user", role: "user", first_seen_at_unix_ms: 2, body: { parts: [{ text: "不对，oldest-marker" }] } },
    },
  });
  await refreshTraceIndex(context);
  assert.equal((await listTraceSessions(context)).length, 200);
  assert.equal((await listTraceSessions(context, { limit: 1_000 })).length, 1_000);
  assert.equal((await aggregateTraces(context)).totals.sessions, 1_002);
  assert.equal((await searchTraces(context, { query: "oldest-marker", limit: 1 }))[0].bundleId, "oldest");
  assert.equal((await findTraceFeedback(context, { limit: 1 }))[0].bundleId, "oldest");
  assert.equal((await findCancelledTurns(context, { limit: 1 }))[0].bundleId, "oldest");
  assert.equal((await aggregateTraces({ ...context, allowedBundleIds: new Set(["oldest"]) })).totals.sessions, 1);
});

test("unchanged polls preserve cursor history and do not rewrite the index", async (t) => {
  const context = await workspace(t);
  await bundle(context, "first", { started_at_unix_ms: 1 });
  const initial = await refreshTraceIndex(context);
  await bundle(context, "second", { started_at_unix_ms: 2 });
  const changed = await refreshTraceIndex(context);
  const file = path.join(context.dataRoot, "agent", "analysis-index", "trace-index.json");
  const before = await stat(file, { bigint: true });
  let current;
  for (let i = 0; i < 25; i++) current = await refreshTraceIndex(context);
  assert.equal(current.cursor, changed.cursor);
  assert.equal(current.changedSessions, 0);
  assert.equal(current.history.length, 2);
  assert.deepEqual(traceBundleIdsSince(current, initial.cursor), ["second"]);
  assert.equal((await stat(file, { bigint: true })).mtimeNs, before.mtimeNs);
  const requests = Array.from({ length: 10 }, () => refreshTraceIndex(context));
  assert.ok(requests.every((pending) => pending === requests[0]));
  await Promise.all(requests);
});

test("corrupt state is reported without blocking valid bundles and is retried", async (t) => {
  const context = await workspace(t);
  await bundle(context, "valid", { started_at_unix_ms: 1 });
  const broken = await bundle(context, "broken", {});
  await writeFile(path.join(broken, "state.json"), "{");
  const index = await refreshTraceIndex(context);
  assert.deepEqual(index.sessions.map((item) => item.bundleId), ["valid"]);
  assert.deepEqual(index.errors, [{ bundleId: "broken", code: "INVALID_STATE" }]);
  await bundle(context, "broken", { started_at_unix_ms: 2 });
  const repaired = await refreshTraceIndex(context);
  assert.equal(repaired.sessions.length, 2);
  assert.deepEqual(repaired.errors, []);
});

test("index rebuilds incompatible schemas and redacts the first user message", async (t) => {
  const context = await workspace(t);
  await bundle(context, "first", {
    conversation_items: { user: { role: "user", body: { parts: [{ text: "api_key=super-secret" }] } } },
  });
  const index = await refreshTraceIndex(context);
  assert.doesNotMatch(index.sessions[0].firstUserMessage, /super-secret/);
  const file = path.join(context.dataRoot, "agent", "analysis-index", "trace-index.json");
  await writeJsonAtomic(file, { ...index, schemaVersion: 2, sessions: [{ ...index.sessions[0], firstUserMessage: "outdated" }] });
  assert.doesNotMatch((await refreshTraceIndex(context)).sessions[0].firstUserMessage, /outdated/);
});

test("payload callers can lower but cannot raise the configured byte budget", async (t) => {
  const context = await workspace(t);
  const directory = await bundle(context, "payload", { raw_payloads: { one: { path: "one.json" } } });
  await writeFile(path.join(directory, "one.json"), JSON.stringify({ text: "测".repeat(500) }));
  const input = { bundleId: "payload", payloadId: "one", maxBytes: 5_000_000 };
  await assert.rejects(getTracePayload({ ...context, maxPayloadBytes: 1_024 }, input), /exceeds 1024/);
  await assert.rejects(getTracePayload(context, { ...input, maxBytes: 100 }), /exceeds 100/);
  assert.ok((await getTracePayload(context, input)).byteLength > 1_024);
});

test("simultaneous atomic writes leave one complete JSON file and no temporary files", async (t) => {
  const context = await workspace(t);
  const file = path.join(context.dataRoot, "concurrent.json");
  await Promise.all(Array.from({ length: 32 }, (_, id) => writeJsonAtomic(file, { id, text: String(id).repeat(10_000) })));
  const value = JSON.parse(await readFile(file, "utf8"));
  assert.equal(value.text, String(value.id).repeat(10_000));
  assert.deepEqual(await readdir(context.dataRoot), ["concurrent.json"]);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { assertProposalTransition, assertRunTransition, createProposalRecord, sha256 } from "./agent-schema.mjs";
import {
  consumeApproval,
  createChange,
  createProposal,
  createRun,
  decideProposal,
  getRun,
  initializeAgentStore,
  listChanges,
  listProposals,
  listRuns,
  updateChange,
  updateRun,
} from "./agent-store.mjs";
import { findTraceFeedback, getConversationWindow, getTracePayload, listTraceSessions, refreshTraceIndex } from "./trace-query.mjs";
import { createHarnessSnapshot, inspectConfig, listInstructions, listPlugins, listSkills, readInstruction } from "./harness-tools.mjs";
import { applyHarnessOperation, rollbackHarnessChange, verifyHarnessChange } from "./harness-mutations.mjs";
import { startAgentAnalysis, testAgentConnection } from "./agent-engine.mjs";
import { agentDashboard, agentEvidenceDetail, applyAgentProposal, decideAgentProposal, recoverInterruptedAgentState } from "./agent-service.mjs";
import { resolveCodexLaunch } from "./codex-cli.mjs";

test("Agent model calls prefer the shared model service configuration", async () => {
  let request;
  const result = await testAgentConnection({
    llmBaseUrl: "https://shared.example/v1",
    llmModel: "shared-model",
    llmApiKey: "shared-key",
    llmTimeoutSeconds: 30,
    agentBaseUrl: "https://legacy.example/v1",
    agentModel: "legacy-model",
    agentApiKey: "legacy-key",
    agentTimeoutSeconds: 60,
  }, {
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
    },
  });
  assert.equal(request.url, "https://shared.example/v1/chat/completions");
  assert.equal(request.options.headers.authorization, "Bearer shared-key");
  assert.equal(JSON.parse(request.options.body).model, "shared-model");
  assert.equal(result.model, "shared-model");
});

test("Agent run state machine rejects invalid transitions", () => {
  assert.doesNotThrow(() => assertRunTransition("idle", "analyzing"));
  assert.doesNotThrow(() => assertRunTransition("verifying", "awaiting_approval"));
  assert.throws(() => assertRunTransition("idle", "applying"), /invalid Agent run transition/);
  assert.throws(() => assertRunTransition("completed", "analyzing"), /invalid Agent run transition/);
});

test("Proposal state machine rejects invalid transitions", () => {
  assert.doesNotThrow(() => assertProposalTransition("pending", "approved"));
  assert.doesNotThrow(() => assertProposalTransition("approved", "applying"));
  assert.throws(() => assertProposalTransition("applied", "pending"), /invalid Proposal transition/);
  assert.throws(() => assertProposalTransition("rejected", "approved"), /invalid Proposal transition/);
});

test("Harness proposals are always marked as requiring a new Session", () => {
  const proposal = createProposalRecord(proposalInput("run-one", "C:\\Users\\qa\\.codex\\AGENTS.md"));
  assert.equal(proposal.requiresRestart, true);
  const explicitlyFalse = createProposalRecord({ ...proposalInput("run-two", "C:\\Users\\qa\\.codex\\AGENTS.md"), requiresRestart: false });
  assert.equal(explicitlyFalse.requiresRestart, true);
});

test("Agent records persist across store initialization", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-store-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const run = await createRun(dataRoot, { mode: "full" });
  await updateRun(dataRoot, run.id, { state: "analyzing" });
  await initializeAgentStore(dataRoot);
  assert.equal((await getRun(dataRoot, run.id)).state, "analyzing");
  assert.equal(JSON.parse(await readFile(path.join(dataRoot, "agent", "metadata.json"), "utf8")).schemaVersion, 2);
});

test("Agent store migrates older metadata schemas", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-migration-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const root = path.join(dataRoot, "agent");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "metadata.json"), JSON.stringify({ schemaVersion: 0, createdAtUnixMs: 1 }));
  const initialized = await initializeAgentStore(dataRoot);
  assert.equal(initialized.metadata.schemaVersion, 2);
  assert.deepEqual(initialized.metadata.migrationHistory.map(({ from, to }) => ({ from, to })), [{ from: 0, to: 1 }, { from: 1, to: 2 }]);
});

test("Agent store migrates v1 run records without discarding completed analysis", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-record-migration-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const root = path.join(dataRoot, "agent");
  await mkdir(path.join(root, "runs"), { recursive: true });
  await writeFile(path.join(root, "metadata.json"), JSON.stringify({ schemaVersion: 1, createdAtUnixMs: 1 }));
  await writeFile(path.join(root, "runs", "run-analysis-failed.json"), JSON.stringify({ schemaVersion: 1, id: "run-analysis-failed", state: "failed", analysisCursor: "input-cursor", progress: { phase: "failed" }, proposalIds: [] }));
  await writeFile(path.join(root, "runs", "run-apply-failed.json"), JSON.stringify({ schemaVersion: 1, id: "run-apply-failed", state: "failed", analysisCursor: "completed-cursor", progress: { phase: "applying" }, proposalIds: ["proposal-one"] }));
  await initializeAgentStore(dataRoot);
  const analysisFailed = JSON.parse(await readFile(path.join(root, "runs", "run-analysis-failed.json"), "utf8"));
  const applyFailed = JSON.parse(await readFile(path.join(root, "runs", "run-apply-failed.json"), "utf8"));
  assert.equal(analysisFailed.baseCursor, "input-cursor");
  assert.equal(analysisFailed.analysisCursor, null);
  assert.equal(applyFailed.baseCursor, null);
  assert.equal(applyFailed.analysisCursor, "completed-cursor");
});

test("proposal approval is scoped, expiring, and single use", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-approval-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, proposalInput(run.id, path.join(dataRoot, "AGENTS.md")));
  const decided = await decideProposal(dataRoot, proposal.id, { decision: "approved", expiresInMs: 60_000 });
  assert.ok(decided.token);
  await assert.rejects(() => consumeApproval(dataRoot, proposal.id, "wrong-token"), /invalid approval token/);
  const approval = await consumeApproval(dataRoot, proposal.id, decided.token);
  assert.equal(approval.operationHash, proposal.operationHash);
  await assert.rejects(() => consumeApproval(dataRoot, proposal.id, decided.token), /already been consumed/);
  assert.equal((await listProposals(dataRoot, { runId: run.id }))[0].status, "approved");
});

test("only the latest approval token can authorize a proposal", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-reauthorize-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, proposalInput(run.id, path.join(dataRoot, "AGENTS.md")));
  const first = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const second = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  await assert.rejects(() => consumeApproval(dataRoot, proposal.id, first.token), /invalid approval token/);
  const approval = await consumeApproval(dataRoot, proposal.id, second.token);
  assert.equal(approval.id, (await listProposals(dataRoot, { runId: run.id }))[0].latestApprovalId);
});

test("approval token expires and binding rejects proposal tampering", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-expiry-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, proposalInput(run.id, path.join(dataRoot, "AGENTS.md")));
  const expired = await decideProposal(dataRoot, proposal.id, { decision: "approved", expiresInMs: 60_000 });
  const approvalFile = path.join(dataRoot, "agent", "approvals", `${expired.approval.id}.json`);
  const record = JSON.parse(await readFile(approvalFile, "utf8"));
  record.expiresAtUnixMs = Date.now() - 1;
  await writeFile(approvalFile, JSON.stringify(record));
  await assert.rejects(() => consumeApproval(dataRoot, proposal.id, expired.token), /expired/);

  const fresh = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const proposalFile = path.join(dataRoot, "agent", "proposals", `${proposal.id}.json`);
  const tampered = JSON.parse(await readFile(proposalFile, "utf8"));
  tampered.target.path = path.join(dataRoot, "other.md");
  await writeFile(proposalFile, JSON.stringify(tampered));
  await assert.rejects(() => consumeApproval(dataRoot, proposal.id, fresh.token), /binding no longer matches/);
});

test("Trace index is incremental and feedback preserves evidence locators", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-traces-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-index-"));
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  await writeTrace(traceRoot, "bundle-one", {
    trace_id: "trace-one",
    rollout_id: "rollout-one",
    status: "completed",
    started_at_unix_ms: 100,
    ended_at_unix_ms: 300,
    codex_turns: {
      one: { codex_turn_id: "one", execution: { status: "completed" } },
      two: { codex_turn_id: "two", execution: { status: "completed" } },
    },
    conversation_items: {
      user1: message("user1", "one", "user", "先看看这个设计"),
      answer1: message("answer1", "one", "assistant", "我现在直接修改代码。", "final", 120),
      user2: message("user2", "two", "user", "先不要动手，我们只讨论。", null, 200),
    },
    tool_calls: {}, raw_payloads: {},
  });
  const first = await refreshTraceIndex({ traceRoot, dataRoot });
  const second = await refreshTraceIndex({ traceRoot, dataRoot });
  assert.equal(first.changedSessions, 1);
  assert.equal(second.changedSessions, 0);
  const feedback = await findTraceFeedback({ traceRoot, dataRoot });
  assert.equal(feedback[0].signal, "stop_or_boundary");
  assert.equal(feedback[0].assistant.itemId, "answer1");
  assert.equal(feedback[0].user.itemId, "user2");
  assert.equal(feedback[0].bundleId, "bundle-one");
});

test("Trace index detects same-size state rewrites", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-rewrite-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-rewrite-data-"));
  const bundle = path.join(traceRoot, "bundle-rewrite");
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  await mkdir(bundle, { recursive: true });
  const stateA = JSON.stringify({ trace_id: "trace-a", rollout_id: "rollout", started_at_unix_ms: 1, conversation_items: {}, codex_turns: {}, tool_calls: {}, raw_payloads: {} });
  const stateB = JSON.stringify({ trace_id: "trace-b", rollout_id: "rollout", started_at_unix_ms: 1, conversation_items: {}, codex_turns: {}, tool_calls: {}, raw_payloads: {} });
  assert.equal(Buffer.byteLength(stateA), Buffer.byteLength(stateB));
  await writeFile(path.join(bundle, "state.json"), stateA);
  const first = await refreshTraceIndex({ traceRoot, dataRoot });
  await writeFile(path.join(bundle, "state.json"), stateB);
  const second = await refreshTraceIndex({ traceRoot, dataRoot });
  assert.equal(first.schemaVersion, 2);
  assert.equal(second.changedSessions, 1);
  assert.equal(second.sessions[0].traceId, "trace-b");
  assert.notEqual(second.cursor, first.cursor);
});

test("Trace query supports intent and tool filters, retry groups, and synthetic-message filtering", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-query-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-query-data-"));
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  await writeTrace(traceRoot, "bundle-query", {
    trace_id: "trace-query", rollout_id: "rollout-query", status: "completed", started_at_unix_ms: Date.now(), ended_at_unix_ms: Date.now(), project: "C:\\repo",
    codex_turns: { one: { codex_turn_id: "one", execution: { status: "completed" } } },
    conversation_items: {
      synthetic: message("synthetic", "one", "user", "<environment_context>secret setup</environment_context>", null, 1),
      developer: message("developer", "one", "user", "<developer>internal instruction</developer>", null, 1),
      internal: message("internal", "one", "user", "<codex_internal_context source=\"goal\">internal goal</codex_internal_context>", null, 1),
      user: message("user", "one", "user", "先讨论方案，不要动手", null, 2),
      answer: message("answer", "one", "assistant", "好的", "final", 3),
    },
    tool_calls: {
      a: { tool_call_id: "a", started_by_codex_turn_id: "one", execution: { status: "failed" }, kind: { type: "exec_command" }, summary: { label: "rg search", input_preview: "rg TODO" } },
      b: { tool_call_id: "b", started_by_codex_turn_id: "one", execution: { status: "completed" }, kind: { type: "exec_command" }, summary: { label: "rg search", input_preview: "rg TODO" } },
    }, raw_payloads: {},
  });
  const index = await refreshTraceIndex({ traceRoot, dataRoot });
  assert.equal(index.sessions[0].repeatedToolCalls, 1);
  assert.ok(index.sessions[0].intents.includes("discussion"));
  assert.equal((await listTraceSessions({ traceRoot, dataRoot }, { intent: "discussion", tool: "rg search" })).length, 1);
  assert.equal((await listTraceSessions({ traceRoot, dataRoot }, { intent: "implementation" })).length, 0);
  const window = await getConversationWindow({ traceRoot, dataRoot }, { bundleId: "bundle-query", itemId: "user", radius: 3 });
  assert.equal(window.items.some((item) => item.itemId === "synthetic"), false);
  assert.equal(window.items.some((item) => item.itemId === "developer"), false);
  assert.equal(window.items.some((item) => item.itemId === "internal"), false);
});

test("Trace payload access can be disabled by the analysis scope", async (context) => {
  const traceRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-payload-"));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-agent-payload-data-"));
  context.after(() => rm(traceRoot, { recursive: true, force: true }));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const bundle = path.join(traceRoot, "bundle-payload");
  await mkdir(path.join(bundle, "payloads"), { recursive: true });
  await writeFile(path.join(bundle, "payloads", "one.json"), JSON.stringify({ api_key: "secret" }));
  await writeFile(path.join(bundle, "state.json"), JSON.stringify({ trace_id: "trace", rollout_id: "rollout", conversation_items: {}, codex_turns: {}, tool_calls: {}, raw_payloads: { one: { path: "payloads/one.json", kind: { type: "test" } } } }));
  await assert.rejects(() => getTracePayload({ traceRoot, dataRoot, allowPayloads: false }, { bundleId: "bundle-payload", payloadId: "one" }), /disabled/);
  await assert.rejects(() => agentEvidenceDetail({ traceRoot, dataRoot, settings: { agentAllowPayloads: false, agentMaxPayloadBytes: 1_000_000 } }, { bundleId: "bundle-payload", payloadId: "one" }), /disabled/);
});

test("Harness snapshot discovers instructions, skills, MCP, plugins and redacts secrets", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-"));
  const codexHome = path.join(root, ".codex");
  const project = path.join(root, "repo");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(path.join(codexHome, "skills", "review"), { recursive: true });
  await writeFile(path.join(codexHome, "AGENTS.md"), "Keep replies concise.\n");
  await writeFile(path.join(project, "AGENTS.md"), "Run tests.\n");
  await writeFile(path.join(codexHome, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nDo it.\n");
  await writeFile(path.join(codexHome, "config.toml"), [
    "api_key = \"secret-value\"",
    "[mcp_servers.docs]",
    "command = \"docs-server\"",
    "[plugins.\"browser@bundled\"]",
    "enabled = true",
  ].join("\n"));
  const snapshot = await createHarnessSnapshot({ codexHome, projects: [project] });
  assert.equal(snapshot.instructions.length, 2);
  assert.equal(snapshot.skills[0].id, "review");
  assert.equal(snapshot.mcpServers[0].id, "docs");
  assert.equal(snapshot.plugins[0].id, "browser@bundled");
  assert.doesNotMatch(snapshot.config.source, /secret-value/);
  assert.match(snapshot.config.source, /\[已隐藏\]/);
});

test("Harness snapshot includes Skills from the current configured Plugin cache version", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-plugin-skills-"));
  const codexHome = path.join(root, ".codex");
  const pluginRoot = path.join(codexHome, "plugins", "cache", "market", "browser");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(pluginRoot, "1.0.0", "skills", "control", "scripts"), { recursive: true });
  await mkdir(path.join(pluginRoot, "2.0.0", "skills", "control", "scripts"), { recursive: true });
  await mkdir(path.join(codexHome, "plugins", "cache", "market", "plugin-backup-old", "browser", "9.0.0", "skills", "ignored"), { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), '[plugins."browser@market"]\nenabled = true\n');
  await writeFile(path.join(pluginRoot, "1.0.0", "skills", "control", "SKILL.md"), "---\nname: control\ndescription: Old plugin Skill\n---\n");
  await writeFile(path.join(pluginRoot, "2.0.0", "skills", "control", "SKILL.md"), "---\nname: control\ndescription: Current plugin Skill\n---\nUse [helper](scripts/helper.js).\n");
  await writeFile(path.join(pluginRoot, "2.0.0", "skills", "control", "scripts", "helper.js"), "export const current = true;\n");
  const snapshot = await createHarnessSnapshot({ codexHome, projects: [] });
  const skill = snapshot.skills.find((item) => item.pluginId === "browser@market");
  assert.ok(skill);
  assert.equal(skill.id, "browser@market:control");
  assert.equal(skill.pluginVersion, "2.0.0");
  assert.equal(skill.source, "plugin");
  assert.equal(skill.readOnly, true);
  assert.ok(skill.files.includes("scripts/helper.js"));
  assert.equal(skill.validation.valid, true);
  assert.equal(snapshot.skills.filter((item) => item.pluginId === "browser@market").length, 1);
});

test("Plugin inspection merges fixed-argument CLI installation metadata with config", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-plugin-inspection-"));
  const codexHome = path.join(root, ".codex");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), '[plugins."browser@bundled"]\nenabled = true\n');
  const calls = [];
  const runCodexCommand = async (args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ installed: [
      { pluginId: "browser@bundled", installed: true, enabled: true, version: "2.0.0", marketplaceName: "bundled", source: { source: "local", path: "C:\\plugin" }, installPolicy: "AVAILABLE", authPolicy: "ON_INSTALL" },
      { pluginId: "runtime@market", installed: true, enabled: true, version: "1.0.0", marketplaceName: "market" },
    ] }) };
  };
  const snapshot = await createHarnessSnapshot({ codexHome, projects: [], runCodexCommand });
  assert.deepEqual(calls, [["plugin", "list", "--available", "--json"]]);
  assert.equal(snapshot.pluginInspection.status, "checked");
  assert.equal(snapshot.plugins.find((item) => item.id === "browser@bundled").version, "2.0.0");
  assert.equal(snapshot.plugins.find((item) => item.id === "runtime@market").installed, true);
  assert.equal(snapshot.plugins.find((item) => item.id === "browser@bundled").hash, snapshot.config.plugins[0].hash);
  const fallback = await listPlugins({ codexHome, runCodexCommand: async () => { throw new Error("CLI unavailable"); } });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].id, "browser@bundled");
});

test("instruction discovery follows override, fallback, root-to-cwd, and byte-budget rules", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-instruction-order-"));
  const codexHome = path.join(root, ".codex");
  const project = path.join(root, "repo");
  const workdir = path.join(project, "services", "api");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(workdir, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), "project_doc_fallback_filenames = [\"TEAM_GUIDE.md\"]\nproject_doc_max_bytes = 18\n");
  await writeFile(path.join(project, "AGENTS.md"), "root-standard-ignored\n");
  await writeFile(path.join(project, "AGENTS.override.md"), "root-override\n");
  await writeFile(path.join(project, "services", "TEAM_GUIDE.md"), "service-fallback\n");
  await writeFile(path.join(workdir, "AGENTS.md"), "api-standard\n");
  const instructions = await listInstructions({ codexHome, projects: [workdir] });
  assert.deepEqual(instructions.map((item) => path.basename(item.path)), ["AGENTS.override.md", "TEAM_GUIDE.md"]);
  assert.equal(instructions[0].effectiveOrder, 1);
  assert.equal(instructions[1].fallback, true);
  assert.equal(instructions[1].truncated, true);
  const fallback = await readInstruction({ codexHome, projects: [workdir] }, instructions[1].path);
  assert.equal(Buffer.byteLength(fallback.content, "utf8"), instructions[1].includedBytes);
});

test("approved instruction mutation validates hash and rolls back", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-write-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(targetPath, "Old guidance.\n");
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, proposalInput(run.id, targetPath, sha256("Old guidance.\n")));
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  const contextValue = { dataRoot, codexHome, projects: [] };
  const applied = await applyHarnessOperation(contextValue, proposal, approval);
  assert.equal(await readFile(targetPath, "utf8"), "New guidance.\n");
  assert.equal((await verifyHarnessChange(contextValue, proposal.target, approval.operation, applied.afterHash)).status, "passed");
  const change = { id: "change-one", snapshotId: applied.snapshot.id, target: proposal.target, afterHash: applied.afterHash };
  await rollbackHarnessChange(contextValue, change);
  assert.equal(await readFile(targetPath, "utf8"), "Old guidance.\n");
});

test("approved Skill removal verifies absence and rolls back the directory", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-skill-remove-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "skills", "review");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(targetPath, { recursive: true });
  await writeFile(path.join(targetPath, "SKILL.md"), "---\nname: review\ndescription: Review\n---\nDo it.\n");
  const target = (await createHarnessSnapshot({ codexHome, projects: [] })).skills[0];
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, targetPath, target.hash),
    target,
    operation: { kind: "skill.remove" },
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  const contextValue = { dataRoot, codexHome, projects: [] };
  const applied = await applyHarnessOperation(contextValue, proposal, approval);
  assert.equal((await verifyHarnessChange(contextValue, proposal.target, approval.operation, applied.afterHash)).status, "passed");
  await rollbackHarnessChange(contextValue, { id: "skill-change", snapshotId: applied.snapshot.id, target, operation: approval.operation, afterHash: null });
  assert.match(await readFile(path.join(targetPath, "SKILL.md"), "utf8"), /name: review/);
});

test("approved Skill disable moves it out of discovery and rolls back", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-skill-disable-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "skills", "review");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(targetPath, { recursive: true });
  await writeFile(path.join(targetPath, "SKILL.md"), "---\nname: review\ndescription: Review\n---\nDo it.\n");
  const target = (await createHarnessSnapshot({ codexHome, projects: [] })).skills[0];
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, targetPath, target.hash),
    target,
    operation: { kind: "skill.disable" },
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  const contextValue = { dataRoot, codexHome, projects: [] };
  const applied = await applyHarnessOperation(contextValue, proposal, approval);
  assert.equal((await verifyHarnessChange(contextValue, proposal.target, approval.operation, applied.afterHash)).status, "passed");
  assert.equal((await listSkills(contextValue)).some((item) => item.id === "review"), false);
  await rollbackHarnessChange(contextValue, { id: "skill-disable-change", snapshotId: applied.snapshot.id, target, operation: approval.operation, afterHash: null });
  assert.match(await readFile(path.join(targetPath, "SKILL.md"), "utf8"), /name: review/);
});

test("approved mutation refuses stale target content", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-conflict-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(targetPath, "Old guidance.\n");
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, proposalInput(run.id, targetPath, sha256("Old guidance.\n")));
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  await writeFile(targetPath, "External edit.\n");
  await assert.rejects(() => applyHarnessOperation({ dataRoot, codexHome, projects: [] }, proposal, approval), /target changed/);
});

test("approved operation cannot cross its Harness target type", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-scope-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(targetPath, "Guidance.\n");
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, targetPath, sha256("Guidance.\n")),
    operation: { kind: "plugin.install", selector: "browser@bundled" },
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  await assert.rejects(
    () => applyHarnessOperation({ dataRoot, codexHome, projects: [], runCodexCommand: () => assert.fail("CLI must not run") }, proposal, approval),
    /not allowed for Harness target global_instructions/,
  );
});

test("Agent Proposal creation rejects an operation outside the target type", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-invalid-proposal-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const agentsPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(agentsPath, "Guidance.\n");
  await writeTrace(traceRoot, "bundle-invalid-proposal", {
    trace_id: "trace-invalid", rollout_id: "rollout-invalid", status: "completed", started_at_unix_ms: 100,
    codex_turns: { one: { codex_turn_id: "one", execution: { status: "completed" } } },
    conversation_items: { feedback: message("feedback", "one", "user", "不要这样做。", null, 100) }, tool_calls: {}, raw_payloads: {},
  });
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{
    id: "call-invalid", type: "function", function: { name: "proposal_create", arguments: JSON.stringify({
      title: "无效建议", summary: "目标和操作不匹配。", rationale: "测试后端校验。",
      target: { type: "global_instructions", scope: "global", path: agentsPath, id: "global-agents" },
      operation: { kind: "plugin.install", selector: "browser@bundled" },
      evidence: [{ bundleId: "bundle-invalid-proposal", itemId: "feedback", excerpt: "不要这样做。" }],
    }) },
  }] } }] }), { status: 200 });
  const settings = {
    agentEnabled: true, agentBaseUrl: "https://example.test/v1", agentModel: "agent-model", agentApiKey: "", agentTimeoutSeconds: 30,
    agentMaxRounds: 2, agentMaxTokens: 10_000, agentMaxInputBytes: 2_000_000, agentMaxPayloadBytes: 1_000_000, agentMaxDurationMinutes: 5,
  };
  await assert.rejects(() => startAgentAnalysis({ traceRoot, dataRoot, codexHome, settings, fetchImpl }, { mode: "full" }), /not allowed for Harness target global_instructions/);
  assert.equal((await listProposals(dataRoot)).length, 0);
});

test("edited approval cannot change a Proposal to an operation outside its target", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-edited-scope-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(targetPath, "Old guidance.\n");
  const run = await createRun(dataRoot);
  await updateRun(dataRoot, run.id, { state: "analyzing" });
  await updateRun(dataRoot, run.id, { state: "awaiting_approval" });
  const proposal = await createProposal(dataRoot, proposalInput(run.id, targetPath, sha256("Old guidance.\n")));
  await assert.rejects(
    () => decideAgentProposal({ dataRoot, codexHome, projects: [] }, proposal.id, { decision: "approved", editedOperation: { kind: "plugin.install", selector: "browser@bundled" } }),
    /not allowed for Harness target global_instructions/,
  );
  assert.equal((await listProposals(dataRoot))[0].status, "pending");
});

test("approved Plugin operation selector must match its target", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-plugin-target-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, '[plugins."browser@bundled"]\nenabled = true\n');
  const target = (await createHarnessSnapshot({ codexHome, projects: [] })).plugins[0];
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, configPath, target.hash),
    target,
    operation: { kind: "plugin.update", selector: "chrome@bundled" },
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  await assert.rejects(
    () => applyHarnessOperation({ dataRoot, codexHome, projects: [], runCodexCommand: () => assert.fail("CLI must not run") }, proposal, approval),
    /selector must match the approved target/,
  );
});

test("MCP and Plugin disable preserve their existing TOML fields and roll back", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-disable-config-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const source = [
    "[mcp_servers.docs]",
    'command = "docs-server"',
    'args = ["--stdio"]',
    "enabled = true",
    "",
    '[plugins."browser@bundled"]',
    'marketplace = "bundled"',
    "enabled = true",
    "",
  ].join("\n");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, source);
  const snapshot = await createHarnessSnapshot({ codexHome, projects: [] });
  for (const [target, operation] of [
    [snapshot.mcpServers[0], { kind: "mcp.disable" }],
    [snapshot.plugins[0], { kind: "plugin.disable" }],
  ]) {
    const current = await createHarnessSnapshot({ codexHome, projects: [] });
    const refreshedTarget = target.type === "mcp_server" ? current.mcpServers[0] : current.plugins[0];
    const run = await createRun(dataRoot);
    const proposal = await createProposal(dataRoot, {
      ...proposalInput(run.id, configPath, refreshedTarget.hash),
      target: refreshedTarget,
      operation,
    });
    const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
    const approval = await consumeApproval(dataRoot, proposal.id, token);
    const contextValue = { dataRoot, codexHome, projects: [] };
    const applied = await applyHarnessOperation(contextValue, proposal, approval);
    assert.equal((await verifyHarnessChange(contextValue, refreshedTarget, approval.operation, applied.afterHash)).status, "passed");
    const disabledSource = await readFile(configPath, "utf8");
    assert.match(disabledSource, /command = "docs-server"/);
    assert.match(disabledSource, /args = \["--stdio"\]/);
    assert.match(disabledSource, /marketplace = "bundled"/);
    await rollbackHarnessChange(contextValue, { id: `disable-${target.type}`, snapshotId: applied.snapshot.id, target: refreshedTarget, operation: approval.operation, afterHash: applied.afterHash });
  }
  assert.equal(await readFile(configPath, "utf8"), source);
});

test("external MCP update restores the previous configuration when add fails", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-compensate-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, "[mcp_servers.docs]\ncommand = \"old-server\"\n");
  const target = (await createHarnessSnapshot({ codexHome, projects: [] })).mcpServers[0];
  const run = await createRun(dataRoot);
  const operation = {
    kind: "mcp.update",
    cli: true,
    name: "docs",
    command: ["new-server", "--mode", "safe"],
    env: { DOCS_MODE: "local" },
    previous: { command: ["old-server"], env: {} },
  };
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, configPath, target.hash),
    target,
    operation,
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  const calls = [];
  const runCodexCommand = async (args) => {
    calls.push(args);
    if (calls.length === 2) throw new Error("new MCP failed");
    return { code: 0, args };
  };
  await assert.rejects(
    () => applyHarnessOperation({ dataRoot, codexHome, projects: [], runCodexCommand }, proposal, approval),
    /previous configuration was restored/,
  );
  assert.deepEqual(calls, [
    ["mcp", "remove", "docs"],
    ["mcp", "add", "docs", "--env", "DOCS_MODE=local", "--", "new-server", "--mode", "safe"],
    ["mcp", "add", "docs", "--", "old-server"],
  ]);
});

test("external Plugin update uses fixed CLI arguments and restores installed state on failure", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-plugin-compensate-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, "[plugins.\"browser@bundled\"]\nenabled = true\n");
  const target = (await createHarnessSnapshot({ codexHome, projects: [] })).plugins[0];
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, configPath, target.hash),
    target,
    operation: { kind: "plugin.update", selector: "browser@bundled" },
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  const calls = [];
  await assert.rejects(() => applyHarnessOperation({
    dataRoot,
    codexHome,
    projects: [],
    runCodexCommand: async (args) => {
      calls.push(args);
      if (calls.length === 2) throw new Error("marketplace install failed");
      return { code: 0, args };
    },
  }, proposal, approval), /installed state was restored/);
  assert.deepEqual(calls, [
    ["plugin", "remove", "browser@bundled", "--json"],
    ["plugin", "add", "browser@bundled", "--json"],
    ["plugin", "add", "browser@bundled", "--json"],
  ]);
});

test("failed Harness verification automatically restores the snapshot", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-auto-rollback-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "rules", "invalid.txt");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(traceRoot, { recursive: true });
  const run = await createRun(dataRoot);
  await updateRun(dataRoot, run.id, { state: "analyzing" });
  await updateRun(dataRoot, run.id, { state: "awaiting_approval" });
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, targetPath, null),
    target: { type: "rules", scope: "global", path: targetPath, id: "invalid.txt" },
    operation: { kind: "rules.patch", content: "allow = true\n" },
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  await assert.rejects(
    () => applyAgentProposal({ traceRoot, dataRoot, codexHome, projects: [], settings: {} }, proposal.id, token),
    /验证失败/,
  );
  await assert.rejects(() => readFile(targetPath, "utf8"), { code: "ENOENT" });
  const change = (await listChanges(dataRoot))[0];
  assert.equal(change.state, "failed");
  assert.equal(change.rollback.status, "restored");
});

test("startup recovery restores an interrupted local Harness change", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-restart-rollback-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(traceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(targetPath, "Before restart.\n");
  const run = await createRun(dataRoot);
  await updateRun(dataRoot, run.id, { state: "analyzing" });
  await updateRun(dataRoot, run.id, { state: "awaiting_approval" });
  const proposal = await createProposal(dataRoot, proposalInput(run.id, targetPath, sha256("Before restart.\n")));
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  await updateRun(dataRoot, run.id, { state: "applying" });
  let change = await createChange(dataRoot, {
    runId: run.id, proposalId: proposal.id, approvalId: approval.id, target: proposal.target,
    operationHash: proposal.operationHash, operation: approval.operation,
  });
  const applied = await applyHarnessOperation({ dataRoot, codexHome, projects: [] }, proposal, approval, {
    onSnapshot: async ({ snapshot, beforeHash }) => {
      change = await updateChange(dataRoot, change.id, { snapshotId: snapshot.id, beforeHash });
    },
  });
  await updateChange(dataRoot, change.id, { afterHash: applied.afterHash });
  assert.equal(await readFile(targetPath, "utf8"), "New guidance.\n");
  await recoverInterruptedAgentState({ traceRoot, dataRoot, codexHome, projects: [], settings: {} });
  assert.equal(await readFile(targetPath, "utf8"), "Before restart.\n");
  const recovered = (await listChanges(dataRoot))[0];
  assert.equal(recovered.state, "failed");
  assert.equal(recovered.rollback.status, "restored");
});

test("config inspection warns about duplicate top-level keys without rewriting", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-config-inspect-"));
  const file = path.join(root, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(file, "model = \"one\"\nmodel = \"two\"\n[mcp_servers.docs]\ncommand = \"docs\"\n");
  const config = await inspectConfig(file);
  assert.match(config.warnings[0], /model/);
  assert.equal(config.parseMode, "lossless-sections");
  assert.equal(config.valid, true);
  assert.equal(config.structure.model, "two");
});

test("Skill inspection reports missing referenced files", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-skill-reference-"));
  const codexHome = path.join(root, ".codex");
  const skillRoot = path.join(codexHome, "skills", "review");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(skillRoot, { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: review\ndescription: Review code\n---\nRead [guide](references/guide.md).\n");
  const skill = (await createHarnessSnapshot({ codexHome, projects: [] })).skills[0];
  assert.equal(skill.validation.valid, false);
  assert.deepEqual(skill.validation.missingReferences, ["references/guide.md"]);
});

test("TOML parser rejects invalid approved section before writing", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-config-parser-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, "model = \"gpt-5\"\n");
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, configPath, sha256("model = \"gpt-5\"\n")),
    target: { type: "config", scope: "global", path: configPath, id: "config.toml" },
    operation: { kind: "config.replace_section", section: "features", content: "this is not toml" },
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const approval = await consumeApproval(dataRoot, proposal.id, token);
  await assert.rejects(() => applyHarnessOperation({ dataRoot, codexHome, projects: [] }, proposal, approval), /TOML validation failed/);
  assert.equal(await readFile(configPath, "utf8"), "model = \"gpt-5\"\n");
});

test("MCP verification performs CLI inspection and HTTP initialize", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-verify-"));
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  const source = "[mcp_servers.docs]\nurl = \"https://mcp.example.test/\"\n";
  await writeFile(configPath, source);
  const calls = [];
  const fetchCalls = [];
  const target = (await createHarnessSnapshot({ codexHome, projects: [] })).mcpServers[0];
  const verification = await verifyHarnessChange({
    codexHome,
    projects: [],
    runCodexCommand: async (args) => { calls.push(args); return { stdout: JSON.stringify({ name: "docs" }) }; },
    fetchImpl: async (url, options) => { fetchCalls.push({ url: String(url), body: JSON.parse(options.body) }); return new Response("{}", { status: 200 }); },
  }, target, { kind: "mcp.update", cli: true, name: "docs", url: "https://mcp.example.test/", previous: { url: "https://old.example.test/" } }, sha256(source));
  assert.equal(verification.status, "passed");
  assert.deepEqual(calls, [["mcp", "get", "docs", "--json"]]);
  assert.equal(fetchCalls[0].body.method, "initialize");
});

test("Harness verification checks Hooks discovery and Plugin CLI installation", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-harness-object-verify-"));
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  const source = "[hooks]\nenabled = true\n\n[plugins.\"browser@bundled\"]\nenabled = true\n";
  await writeFile(configPath, source);
  const snapshot = await createHarnessSnapshot({ codexHome, projects: [] });
  const hooks = await verifyHarnessChange({ codexHome, projects: [] }, snapshot.hooks[0], { kind: "hooks.patch", content: "enabled = true" }, sha256(source));
  assert.equal(hooks.status, "passed");
  assert.equal(hooks.checks.some((item) => item.name === "hooks_discovery" && item.ok), true);
  const calls = [];
  const plugin = await verifyHarnessChange({
    codexHome,
    projects: [],
    runCodexCommand: async (args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ installed: [{ pluginId: "browser@bundled", installed: true, enabled: true, version: "1.2.3" }] }) };
    },
  }, snapshot.plugins[0], { kind: "plugin.update", selector: "browser@bundled" }, sha256(source));
  assert.equal(plugin.status, "passed");
  assert.deepEqual(calls, [["plugin", "list", "--available", "--json"]]);
});

test("config inspection exposes MCP env only to internal verification", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-mcp-env-"));
  const configPath = path.join(root, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(configPath, "[mcp_servers.docs]\ncommand = \"docs-server\"\nargs = [\"--stdio\"]\n[mcp_servers.docs.env]\nDOCS_TOKEN = \"secret-value\"\n");
  const visible = await inspectConfig(configPath);
  const internal = await inspectConfig(configPath, { redactSecrets: false });
  assert.equal(visible.mcpServers[0].env.DOCS_TOKEN, "[已隐藏]");
  assert.equal(internal.mcpServers[0].env.DOCS_TOKEN, "secret-value");
  assert.deepEqual(internal.mcpServers[0].args, ["--stdio"]);
});

test("Agent loop uses read-only tools, creates an evidence-backed proposal, and waits for approval", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-loop-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const agentsPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(agentsPath, "Existing guidance.\n");
  await writeTrace(traceRoot, "bundle-loop", {
    trace_id: "trace-loop", rollout_id: "rollout-loop", status: "completed", started_at_unix_ms: 100, ended_at_unix_ms: 300,
    codex_turns: { one: { codex_turn_id: "one", execution: { status: "completed" } }, two: { codex_turn_id: "two", execution: { status: "completed" } } },
    conversation_items: {
      answer: message("answer", "one", "assistant", "我直接修改。", "final", 120),
      feedback: message("feedback", "two", "user", "先不要动手，只讨论。", null, 200),
    }, tool_calls: {}, raw_payloads: {},
  });
  const requests = [];
  const responses = [
    { choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "trace_find_feedback", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "", tool_calls: [{ id: "call-2", type: "function", function: { name: "harness_snapshot", arguments: "{}" } }] } }] },
    { choices: [{ message: { content: "", tool_calls: [{ id: "call-3", type: "function", function: { name: "proposal_create", arguments: JSON.stringify({
      title: "讨论阶段保持只读", summary: "在讨论型请求中不修改文件。", rationale: "用户明确纠正了过早执行。",
      target: { type: "global_instructions", scope: "global", path: agentsPath, id: "global-agents" },
      operation: { kind: "instructions.patch", content: "Existing guidance.\n- 在明确讨论阶段不要修改文件。\n" },
      expectedTargetHash: sha256("Existing guidance.\n"),
      evidence: [{ bundleId: "bundle-loop", traceId: "trace-loop", turnId: "two", itemId: "feedback", signal: "stop_or_boundary", excerpt: "先不要动手，只讨论。" }],
      risk: "low", requiresRestart: true, verificationPlan: ["验证全局 AGENTS.md 可发现"],
    }) } }] } }] },
    { choices: [{ message: { content: "已提出 1 条建议，等待用户审批。" } }] },
  ];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
  };
  const settings = {
    agentEnabled: true, agentBaseUrl: "https://example.test/v1", agentModel: "agent-model", agentApiKey: "",
    agentTimeoutSeconds: 30, agentMaxRounds: 10, agentMaxInputBytes: 2_000_000, agentMaxPayloadBytes: 1_000_000, agentMaxDurationMinutes: 5,
  };
  const run = await startAgentAnalysis({ traceRoot, dataRoot, codexHome, projects: [], settings, fetchImpl }, { mode: "full" });
  assert.equal(run.state, "awaiting_approval");
  const proposals = await listProposals(dataRoot, { runId: run.id });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].evidence[0].itemId, "feedback");
  assert.equal(await readFile(agentsPath, "utf8"), "Existing guidance.\n");
  const toolNames = requests[0].tools.map((item) => item.function.name);
  assert.ok(toolNames.includes("proposal_create"));
  assert.equal(toolNames.some((name) => /patch|remove|install|update/.test(name)), false);
  assert.ok(proposals[0].harnessEvidence.hash);
});

test("Agent suppresses an equivalent rejected Proposal regardless of object key order", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-deduplicate-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const agentsPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(agentsPath, "Existing guidance.\n");
  await writeTrace(traceRoot, "bundle-deduplicate", {
    trace_id: "trace-deduplicate", rollout_id: "rollout-deduplicate", status: "completed", started_at_unix_ms: 100,
    codex_turns: { one: { codex_turn_id: "one", execution: { status: "completed" } } },
    conversation_items: { feedback: message("feedback", "one", "user", "先不要动手。", null, 100) }, tool_calls: {}, raw_payloads: {},
  });
  const previousRun = await createRun(dataRoot);
  const target = { type: "global_instructions", scope: "global", path: agentsPath, id: "global-agents" };
  const operation = { kind: "instructions.patch", content: "Existing guidance.\n- 先讨论再执行。\n" };
  const previous = await createProposal(dataRoot, {
    runId: previousRun.id, title: "旧建议", summary: "相同建议。", rationale: "用户曾明确纠正。", target, operation,
    expectedTargetHash: sha256("Existing guidance.\n"), evidence: [{ bundleId: "bundle-deduplicate", itemId: "feedback", excerpt: "先不要动手。" }],
  });
  await decideProposal(dataRoot, previous.id, { decision: "rejected" });
  const reorderedTarget = { id: "global-agents", path: agentsPath, scope: "global", type: "global_instructions" };
  const reorderedOperation = { content: operation.content, kind: "instructions.patch" };
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{
    id: "call-duplicate", type: "function", function: { name: "proposal_create", arguments: JSON.stringify({
      title: "重复建议", summary: "相同建议。", rationale: "用户曾明确纠正。", target: reorderedTarget, operation: reorderedOperation,
      expectedTargetHash: sha256("Existing guidance.\n"), evidence: [{ bundleId: "bundle-deduplicate", itemId: "feedback", excerpt: "先不要动手。" }],
    }) },
  }] } }] }), { status: 200 });
  const settings = {
    agentEnabled: true, agentBaseUrl: "https://example.test/v1", agentModel: "agent-model", agentApiKey: "", agentTimeoutSeconds: 30,
    agentMaxRounds: 2, agentMaxTokens: 10_000, agentMaxInputBytes: 2_000_000, agentMaxPayloadBytes: 1_000_000, agentMaxDurationMinutes: 5,
  };
  await assert.rejects(() => startAgentAnalysis({ traceRoot, dataRoot, codexHome, settings, fetchImpl }, { mode: "full" }), /equivalent proposal already exists/);
  assert.equal((await listProposals(dataRoot)).length, 1);
});

test("Agent loop enforces disabled Payload access in the tool backend", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-payload-loop-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const bundle = path.join(traceRoot, "bundle-payload-loop");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(bundle, "payloads"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(path.join(bundle, "payloads", "one.json"), JSON.stringify({ api_key: "secret" }));
  await writeFile(path.join(bundle, "state.json"), JSON.stringify({
    trace_id: "trace-payload-loop", rollout_id: "rollout-payload-loop", status: "completed", started_at_unix_ms: Date.now(),
    conversation_items: {}, codex_turns: {}, tool_calls: {},
    raw_payloads: { one: { path: "payloads/one.json", kind: { type: "test" } } },
  }));
  const settings = {
    agentEnabled: true, agentBaseUrl: "https://example.test/v1", agentModel: "agent-model", agentApiKey: "",
    agentTimeoutSeconds: 30, agentMaxRounds: 3, agentMaxTokens: 10_000, agentMaxInputBytes: 2_000_000,
    agentMaxPayloadBytes: 1_000_000, agentMaxDurationMinutes: 5, agentAllowPayloads: false,
  };
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{
    id: "call-payload", type: "function", function: { name: "trace_get_payload", arguments: JSON.stringify({ bundleId: "bundle-payload-loop", payloadId: "one" }) },
  }] } }] }), { status: 200 });
  await assert.rejects(() => startAgentAnalysis({ traceRoot, dataRoot, codexHome, settings, fetchImpl }, { mode: "full" }), /Payload reading is disabled/);
  const run = (await listRuns(dataRoot))[0];
  assert.equal(run.state, "failed");
  assert.equal(run.scope.allowPayloads, false);
  assert.match(run.error, /Payload reading is disabled/);
});

test("Agent enforces project, time, and Token analysis budgets", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-budget-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeTrace(traceRoot, "included", { trace_id: "included", rollout_id: "included", project: "C:\\allowed", status: "completed", started_at_unix_ms: Date.now(), ended_at_unix_ms: Date.now(), codex_turns: {}, conversation_items: {}, tool_calls: {}, raw_payloads: {} });
  await writeTrace(traceRoot, "old", { trace_id: "old", rollout_id: "old", project: "C:\\allowed", status: "completed", started_at_unix_ms: Date.now() - 10 * 86_400_000, ended_at_unix_ms: Date.now(), codex_turns: {}, conversation_items: {}, tool_calls: {}, raw_payloads: {} });
  await writeTrace(traceRoot, "other", { trace_id: "other", rollout_id: "other", project: "C:\\other", status: "completed", started_at_unix_ms: Date.now(), ended_at_unix_ms: Date.now(), codex_turns: {}, conversation_items: {}, tool_calls: {}, raw_payloads: {} });
  const requests = [];
  const settings = {
    agentEnabled: true, agentBaseUrl: "https://example.test/v1", agentModel: "agent-model", agentApiKey: "", agentTimeoutSeconds: 30,
    agentMaxRounds: 10, agentMaxTokens: 1_000, agentMaxInputBytes: 2_000_000, agentMaxPayloadBytes: 1_000_000, agentMaxDurationMinutes: 5,
    agentLookbackDays: 2, agentProjectAllowlist: ["C:\\allowed"], agentAllowPayloads: false,
  };
  await assert.rejects(() => startAgentAnalysis({ traceRoot, dataRoot, codexHome, settings, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "done" } }], usage: { prompt_tokens: 900, completion_tokens: 200 } }), { status: 200 });
  } }, { mode: "full" }), /Token 预算/);
  const requestTask = JSON.parse(requests[0].messages[1].content);
  assert.equal(requestTask.sessions, 1);
  assert.deepEqual(requestTask.allowedBundleIds, ["included"]);
  const failed = (await listRuns(dataRoot))[0];
  assert.equal(failed.scope.allowPayloads, false);
  assert.deepEqual(failed.scope.observedProjects, ["C:\\allowed"]);
  assert.deepEqual(failed.usage, { inputTokens: 900, outputTokens: 200, totalTokens: 1_100, modelCalls: 1 });
});

test("incremental Agent runs establish and advance the successful analysis cursor", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-incremental-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeTrace(traceRoot, "bundle-one", { trace_id: "one", rollout_id: "one", project: "C:\\one", status: "completed", started_at_unix_ms: Date.now(), ended_at_unix_ms: Date.now(), codex_turns: {}, conversation_items: {}, tool_calls: {}, raw_payloads: {} });
  const settings = {
    agentEnabled: true, agentBaseUrl: "https://example.test/v1", agentModel: "agent-model", agentApiKey: "", agentTimeoutSeconds: 30,
    agentMaxRounds: 5, agentMaxTokens: 100_000, agentMaxInputBytes: 2_000_000, agentMaxPayloadBytes: 1_000_000, agentMaxDurationMinutes: 5,
    agentLookbackDays: 0, agentProjectAllowlist: [], agentAllowPayloads: false,
  };
  const requests = [];
  const fetchImpl = async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "暂无可靠建议" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 });
  };
  const first = await startAgentAnalysis({ traceRoot, dataRoot, codexHome, settings, fetchImpl }, { mode: "incremental", cursor: null });
  assert.equal(first.state, "completed");
  assert.equal(first.baseCursor, null);
  assert.ok(first.analysisCursor);
  assert.deepEqual(JSON.parse(requests[0].messages[1].content).allowedBundleIds, ["bundle-one"]);
  assert.equal((await agentDashboard({ traceRoot, dataRoot, codexHome, settings })).incrementalCursor, first.analysisCursor);

  await writeTrace(traceRoot, "bundle-two", { trace_id: "two", rollout_id: "two", project: "C:\\two", status: "completed", started_at_unix_ms: Date.now(), ended_at_unix_ms: Date.now(), codex_turns: {}, conversation_items: {}, tool_calls: {}, raw_payloads: {} });
  const second = await startAgentAnalysis({ traceRoot, dataRoot, codexHome, settings, fetchImpl }, { mode: "incremental", cursor: first.analysisCursor });
  assert.equal(second.state, "completed");
  assert.equal(second.baseCursor, first.analysisCursor);
  assert.deepEqual(JSON.parse(requests[1].messages[1].content).allowedBundleIds, ["bundle-two"]);
  assert.deepEqual(second.scope.observedProjects, ["C:\\two"]);
});

test("project AGENTS change applies only within the Run observed project set", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-project-instructions-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const project = path.join(root, "repo");
  const targetPath = path.join(project, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(traceRoot, { recursive: true });
  await mkdir(path.join(project, ".git"), { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(targetPath, "Before.\n");
  const run = await createRun(dataRoot, { scope: { observedProjects: [project] } });
  await updateRun(dataRoot, run.id, { state: "analyzing" });
  await updateRun(dataRoot, run.id, { state: "awaiting_approval" });
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, targetPath, sha256("Before.\n")),
    target: { type: "project_instructions", scope: "project", project, path: targetPath, id: "project-agents" },
    operation: { kind: "instructions.patch", content: "After.\n" },
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  const result = await applyAgentProposal({ traceRoot, dataRoot, codexHome, projects: [], settings: {} }, proposal.id, token);
  assert.equal(result.change.state, "completed");
  assert.equal(await readFile(targetPath, "utf8"), "After.\n");
});

test("desktop package includes every Agent runtime module", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const files = new Set(packageJson.build.files);
  for (const file of ["agent-schema.mjs", "agent-store.mjs", "trace-query.mjs", "harness-tools.mjs", "harness-mutations.mjs", "agent-engine.mjs", "agent-service.mjs", "codex-cli.mjs"]) assert.ok(files.has(file), file);
  assert.equal(packageJson.dependencies["smol-toml"], "^1.8.0");
});

test("Codex CLI launcher resolves the Windows npm shim without a shell", async (context) => {
  if (process.platform !== "win32") {
    context.skip("Windows npm shim behavior");
    return;
  }
  const launch = await resolveCodexLaunch("codex");
  assert.equal(launch.executable, process.execPath);
  assert.equal(launch.prefixArgs.length, 1);
  assert.match(launch.prefixArgs[0].replaceAll("\\", "/"), /node_modules\/@openai\/codex\/bin\/codex\.js$/i);
});

test("approved Skill create and update are verified and independently reversible", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-skill-lifecycle-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "skills", "review");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  const target = { type: "skill", id: "review", scope: "global", path: targetPath };
  const contextValue = { dataRoot, codexHome, projects: [] };
  const created = await approveAndApply(contextValue, target, {
    kind: "skill.create",
    files: [{ path: "SKILL.md", content: "---\nname: review\ndescription: Review code\n---\nRead [the guide](references/guide.md).\n" }, { path: "references/guide.md", content: "Version one.\n" }],
  }, null);
  const createVerification = await verifyHarnessChange(contextValue, target, created.approval.operation, created.applied.afterHash);
  assert.equal(createVerification.status, "passed", JSON.stringify(createVerification.checks));
  const discovered = (await listSkills(contextValue)).find((item) => item.id === "review");
  assert.ok(discovered);
  const updated = await approveAndApply(contextValue, discovered, {
    kind: "skill.update",
    files: [{ path: "SKILL.md", content: "---\nname: review\ndescription: Review code carefully\n---\nRead [the guide](references/guide.md).\n" }, { path: "references/guide.md", content: "Version two.\n" }],
  }, discovered.hash);
  assert.equal((await verifyHarnessChange(contextValue, discovered, updated.approval.operation, updated.applied.afterHash)).status, "passed");
  assert.equal(await readFile(path.join(targetPath, "references", "guide.md"), "utf8"), "Version two.\n");
  await rollbackHarnessChange(contextValue, changeFromApplied("skill-update", discovered, updated));
  assert.equal(await readFile(path.join(targetPath, "references", "guide.md"), "utf8"), "Version one.\n");
  await rollbackHarnessChange(contextValue, changeFromApplied("skill-create", target, created));
  await assert.rejects(() => readFile(path.join(targetPath, "SKILL.md"), "utf8"), { code: "ENOENT" });
});

test("approved config, Rules, Hooks, and local MCP mutations complete and roll back", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-local-mutations-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  const rulesPath = path.join(codexHome, "rules", "default.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.dirname(rulesPath), { recursive: true });
  await writeFile(configPath, "model = \"before\"\n\n[hooks]\nenabled = false\n");
  await writeFile(rulesPath, "allow = false\n");
  const contextValue = { dataRoot, codexHome, projects: [], fetchImpl: async () => new Response("{}", { status: 200 }) };

  let snapshot = await createHarnessSnapshot({ codexHome, projects: [] });
  const configChange = await approveAndApply(contextValue, snapshot.config, { kind: "config.patch", updates: { model: "after" } }, snapshot.config.hash);
  assert.equal((await verifyHarnessChange(contextValue, snapshot.config, configChange.approval.operation, configChange.applied.afterHash)).status, "passed");
  assert.match(await readFile(configPath, "utf8"), /model = "after"/);
  await rollbackHarnessChange(contextValue, changeFromApplied("config-patch", snapshot.config, configChange));

  snapshot = await createHarnessSnapshot({ codexHome, projects: [] });
  const ruleTarget = snapshot.rules[0];
  const rulesChange = await approveAndApply(contextValue, ruleTarget, { kind: "rules.patch", content: "allow = true\n" }, ruleTarget.hash);
  assert.equal((await verifyHarnessChange(contextValue, ruleTarget, rulesChange.approval.operation, rulesChange.applied.afterHash)).status, "passed");
  await rollbackHarnessChange(contextValue, changeFromApplied("rules-patch", ruleTarget, rulesChange));
  assert.equal(await readFile(rulesPath, "utf8"), "allow = false\n");

  snapshot = await createHarnessSnapshot({ codexHome, projects: [] });
  const hookTarget = snapshot.hooks[0];
  const hooksChange = await approveAndApply(contextValue, hookTarget, { kind: "hooks.patch", content: "enabled = true" }, hookTarget.hash);
  assert.equal((await verifyHarnessChange(contextValue, hookTarget, hooksChange.approval.operation, hooksChange.applied.afterHash)).status, "passed");
  await rollbackHarnessChange(contextValue, changeFromApplied("hooks-patch", hookTarget, hooksChange));

  const mcpTarget = { type: "mcp_server", id: "docs", scope: "global", path: configPath, section: "mcp_servers.docs" };
  const added = await approveAndApply(contextValue, mcpTarget, { kind: "mcp.add", content: 'url = "https://mcp.example.test/"', probe: { url: "https://mcp.example.test/" } }, null);
  assert.equal((await verifyHarnessChange(contextValue, mcpTarget, added.approval.operation, added.applied.afterHash)).status, "passed");
  const addedTarget = (await createHarnessSnapshot({ codexHome, projects: [] })).mcpServers[0];
  const updated = await approveAndApply(contextValue, addedTarget, { kind: "mcp.update", content: 'url = "https://mcp2.example.test/"', probe: { url: "https://mcp2.example.test/" } }, addedTarget.hash);
  assert.equal((await verifyHarnessChange(contextValue, addedTarget, updated.approval.operation, updated.applied.afterHash)).status, "passed");
  const updatedTarget = (await createHarnessSnapshot({ codexHome, projects: [] })).mcpServers[0];
  const removed = await approveAndApply(contextValue, updatedTarget, { kind: "mcp.remove" }, updatedTarget.hash);
  assert.equal((await verifyHarnessChange(contextValue, updatedTarget, removed.approval.operation, removed.applied.afterHash)).status, "passed");
  await rollbackHarnessChange(contextValue, changeFromApplied("mcp-remove", updatedTarget, removed));
  assert.match(await readFile(configPath, "utf8"), /mcp2\.example\.test/);
  await rollbackHarnessChange(contextValue, changeFromApplied("mcp-update", addedTarget, updated));
  assert.match(await readFile(configPath, "utf8"), /mcp\.example\.test/);
  await rollbackHarnessChange(contextValue, changeFromApplied("mcp-add", mcpTarget, added));
  assert.doesNotMatch(await readFile(configPath, "utf8"), /mcp_servers\.docs/);
});

test("external MCP add, update, and remove use fixed arguments and reversible state", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-external-mcp-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, "");
  const calls = [];
  const runCodexCommand = async (args) => {
    calls.push(args);
    if (args[0] === "mcp" && args[1] === "remove") await writeFile(configPath, "");
    if (args[0] === "mcp" && args[1] === "add") {
      const separator = args.indexOf("--");
      const command = separator >= 0 ? args[separator + 1] : null;
      const urlIndex = args.indexOf("--url");
      await writeFile(configPath, command ? `[mcp_servers.docs]\ncommand = ${JSON.stringify(command)}\n` : `[mcp_servers.docs]\nurl = ${JSON.stringify(args[urlIndex + 1])}\n`);
    }
    return { code: 0, stdout: "{}", args };
  };
  const contextValue = { dataRoot, codexHome, projects: [], runCodexCommand };
  const target = { type: "mcp_server", id: "docs", scope: "global", path: configPath, section: "mcp_servers.docs" };
  const added = await approveAndApply(contextValue, target, { kind: "mcp.add", cli: true, name: "docs", url: "https://mcp.example.test/" }, null);
  await rollbackHarnessChange(contextValue, changeFromApplied("external-mcp-add", target, added));

  await writeFile(configPath, '[mcp_servers.docs]\ncommand = "old-server"\n');
  let current = (await createHarnessSnapshot({ codexHome, projects: [] })).mcpServers[0];
  const removed = await approveAndApply(contextValue, current, { kind: "mcp.remove", cli: true, name: "docs", previous: { command: ["old-server"] } }, current.hash);
  await rollbackHarnessChange(contextValue, changeFromApplied("external-mcp-remove", current, removed));

  current = (await createHarnessSnapshot({ codexHome, projects: [] })).mcpServers[0];
  const updated = await approveAndApply(contextValue, current, { kind: "mcp.update", cli: true, name: "docs", command: ["new-server", "--safe"], previous: { command: ["old-server"] } }, current.hash);
  await rollbackHarnessChange(contextValue, changeFromApplied("external-mcp-update", current, updated));
  assert.deepEqual(calls, [
    ["mcp", "add", "docs", "--url", "https://mcp.example.test/"], ["mcp", "remove", "docs"],
    ["mcp", "remove", "docs"], ["mcp", "add", "docs", "--", "old-server"],
    ["mcp", "remove", "docs"], ["mcp", "add", "docs", "--", "new-server", "--safe"],
    ["mcp", "remove", "docs"], ["mcp", "add", "docs", "--", "old-server"],
  ]);
});

test("external Plugin install, update, and uninstall are reversible at installed-state level", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-external-plugin-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const configPath = path.join(codexHome, "config.toml");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeFile(configPath, "");
  const calls = [];
  const runCodexCommand = async (args) => {
    calls.push(args);
    if (args[0] === "plugin" && args[1] === "remove") await writeFile(configPath, "");
    if (args[0] === "plugin" && args[1] === "add") await writeFile(configPath, '[plugins."browser@bundled"]\nenabled = true\n');
    return { code: 0, stdout: "{}", args };
  };
  const contextValue = { dataRoot, codexHome, projects: [], runCodexCommand };
  const target = { type: "plugin", id: "browser@bundled", scope: "global", path: configPath, section: 'plugins."browser@bundled"' };
  const installed = await approveAndApply(contextValue, target, { kind: "plugin.install", selector: "browser@bundled" }, null);
  await rollbackHarnessChange(contextValue, changeFromApplied("plugin-install", target, installed));

  await writeFile(configPath, '[plugins."browser@bundled"]\nenabled = true\n');
  let current = (await createHarnessSnapshot({ codexHome, projects: [] })).plugins[0];
  const updated = await approveAndApply(contextValue, current, { kind: "plugin.update", selector: "browser@bundled" }, current.hash);
  await rollbackHarnessChange(contextValue, changeFromApplied("plugin-update", current, updated));

  current = (await createHarnessSnapshot({ codexHome, projects: [] })).plugins[0];
  const uninstalled = await approveAndApply(contextValue, current, { kind: "plugin.uninstall", selector: "browser@bundled" }, current.hash);
  await rollbackHarnessChange(contextValue, changeFromApplied("plugin-uninstall", current, uninstalled));
  assert.deepEqual(calls, [
    ["plugin", "add", "browser@bundled", "--json"], ["plugin", "remove", "browser@bundled", "--json"],
    ["plugin", "remove", "browser@bundled", "--json"], ["plugin", "add", "browser@bundled", "--json"],
    ["plugin", "remove", "browser@bundled", "--json"], ["plugin", "add", "browser@bundled", "--json"],
    ["plugin", "remove", "browser@bundled", "--json"], ["plugin", "add", "browser@bundled", "--json"],
  ]);
});

test("Plugin-owned Skills are read-only and cannot be mutated through skill operations", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-plugin-skill-readonly-"));
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const skillPath = path.join(codexHome, "plugins", "cache", "bundled", "browser", "1.0.0", "skills", "browse");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(skillPath, { recursive: true });
  await writeFile(path.join(codexHome, "config.toml"), '[plugins."browser@bundled"]\nenabled = true\n');
  await writeFile(path.join(skillPath, "SKILL.md"), "---\nname: browse\ndescription: Browse\n---\nUse browser.\n");
  const target = (await createHarnessSnapshot({ codexHome, projects: [] })).skills.find((item) => item.pluginId === "browser@bundled");
  assert.equal(target.readOnly, true);
  const approved = await approvedHarnessOperation(dataRoot, target, { kind: "skill.update", files: [{ path: "SKILL.md", content: "changed\n" }] }, target.hash);
  await assert.rejects(() => applyHarnessOperation({ dataRoot, codexHome, projects: [] }, approved.proposal, approved.approval), /outside allowed roots/);
  assert.match(await readFile(path.join(skillPath, "SKILL.md"), "utf8"), /name: browse/);
});

test("service-layer application without explicit approval cannot write", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-unapproved-write-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  const targetPath = path.join(codexHome, "AGENTS.md");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(traceRoot, { recursive: true });
  await mkdir(codexHome, { recursive: true });
  await writeFile(targetPath, "Before.\n");
  const run = await createRun(dataRoot);
  await updateRun(dataRoot, run.id, { state: "analyzing" });
  await updateRun(dataRoot, run.id, { state: "awaiting_approval" });
  const proposal = await createProposal(dataRoot, proposalInput(run.id, targetPath, sha256("Before.\n")));
  await assert.rejects(() => applyAgentProposal({ traceRoot, dataRoot, codexHome, settings: {} }, proposal.id, "not-approved"), /cannot be applied from pending/);
  assert.equal(await readFile(targetPath, "utf8"), "Before.\n");
  assert.equal((await listChanges(dataRoot)).length, 0);
});

test("failed incremental analysis keeps its original cursor for recovery", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-agent-cursor-"));
  const traceRoot = path.join(root, "traces");
  const dataRoot = path.join(root, "data");
  const codexHome = path.join(root, ".codex");
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(codexHome, { recursive: true });
  await writeTrace(traceRoot, "bundle-cursor", {
    trace_id: "trace-cursor", rollout_id: "rollout-cursor", status: "completed", started_at_unix_ms: 100, ended_at_unix_ms: 200,
    codex_turns: { one: { codex_turn_id: "one", execution: { status: "completed" } } },
    conversation_items: { user: message("user", "one", "user", "Analyze this", null, 100) }, tool_calls: {}, raw_payloads: {},
  });
  const settings = {
    agentEnabled: true, agentBaseUrl: "https://example.test/v1", agentModel: "agent-model", agentApiKey: "",
    agentTimeoutSeconds: 30, agentMaxRounds: 10, agentMaxInputBytes: 2_000_000, agentMaxPayloadBytes: 1_000_000, agentMaxDurationMinutes: 5,
  };
  await assert.rejects(
    () => startAgentAnalysis({ traceRoot, dataRoot, codexHome, projects: [], settings, fetchImpl: async () => { throw new Error("network unavailable"); } }, { mode: "incremental", cursor: "cursor-before-run" }),
    /network unavailable/,
  );
  const failedRun = (await listRuns(dataRoot))[0];
  assert.equal(failedRun.state, "failed");
  assert.equal(failedRun.baseCursor, "cursor-before-run");
  assert.equal(failedRun.analysisCursor, null);
});

function proposalInput(runId, targetPath, expectedTargetHash = null) {
  return {
    runId,
    title: "Update global guidance",
    summary: "Use the preferred collaboration style.",
    rationale: "The user corrected the same behavior in several sessions.",
    target: { type: "global_instructions", scope: "global", path: targetPath, id: "global-agents" },
    operation: { kind: "text.replace", content: "New guidance.\n" },
    expectedTargetHash,
    evidence: [{ bundleId: "bundle-one", traceId: "trace-one", turnId: "turn-two", itemId: "user-two", signal: "correction", excerpt: "先不要动手" }],
    risk: "low",
    verificationPlan: ["Confirm AGENTS.md discovery"],
  };
}

function message(itemId, turnId, role, text, channel = null, time = 100) {
  return {
    item_id: itemId,
    codex_turn_id: turnId,
    first_seen_at_unix_ms: time,
    role,
    channel,
    kind: "message",
    body: { parts: [{ type: "text", text }] },
    produced_by: [],
  };
}

async function writeTrace(traceRoot, bundleId, state) {
  const bundle = path.join(traceRoot, bundleId);
  await mkdir(bundle, { recursive: true });
  await writeFile(path.join(bundle, "state.json"), JSON.stringify(state));
}

async function approvedHarnessOperation(dataRoot, target, operation, expectedTargetHash) {
  const run = await createRun(dataRoot);
  const proposal = await createProposal(dataRoot, {
    ...proposalInput(run.id, target.path, expectedTargetHash),
    title: `Apply ${operation.kind}`,
    target,
    operation,
    expectedTargetHash,
  });
  const { token } = await decideProposal(dataRoot, proposal.id, { decision: "approved" });
  return { proposal, approval: await consumeApproval(dataRoot, proposal.id, token) };
}

async function approveAndApply(context, target, operation, expectedTargetHash) {
  const approved = await approvedHarnessOperation(context.dataRoot, target, operation, expectedTargetHash);
  return { ...approved, applied: await applyHarnessOperation(context, approved.proposal, approved.approval) };
}

function changeFromApplied(id, target, value) {
  return { id, snapshotId: value.applied.snapshot.id, target, operation: value.approval.operation, afterHash: value.applied.afterHash };
}

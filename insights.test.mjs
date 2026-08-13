import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildDailyReview,
  defaultSettings,
  listReviews,
  loadSettings,
  saveSettings,
  settingsForClient,
  shouldRunScheduledReview,
  storeReview,
  validateSettings,
} from "./insights.mjs";

test("schedule runs once after the configured local time", () => {
  const settings = { ...defaultSettings("data"), scheduleTime: "20:30", lastScheduledRunDate: null };
  assert.equal(shouldRunScheduledReview(settings, new Date(2026, 7, 4, 20, 29)), false);
  assert.equal(shouldRunScheduledReview(settings, new Date(2026, 7, 4, 20, 30)), true);
  settings.lastScheduledRunDate = "2026-08-04";
  assert.equal(shouldRunScheduledReview(settings, new Date(2026, 7, 4, 23, 0)), false);
});

test("settings validation accepts schedule changes and rejects bad values", () => {
  const current = defaultSettings("data");
  const projectPath = path.resolve("repo");
  assert.equal(validateSettings({ scheduleTime: "08:15", inactiveSkillDays: 45 }, current).scheduleTime, "08:15");
  const llmSettings = validateSettings({
    llmEnabled: true,
    llmBaseUrl: "http://127.0.0.1:11434/v1/",
    llmModel: "local-model",
    llmApiKey: "secret",
    llmTimeoutSeconds: 90,
  }, current);
  const { llmApiKey: _llmApiKey, ...visibleLlmSettings } = llmSettings;
  assert.deepEqual(settingsForClient(llmSettings), {
    ...visibleLlmSettings,
    llmApiKeyConfigured: true,
  });
  assert.equal(validateSettings({ clearLlmApiKey: true }, llmSettings).llmApiKey, "");
  assert.throws(() => validateSettings({ scheduleTime: "25:00" }, current), /HH:MM/);
  assert.throws(() => validateSettings({ inactiveMcpDays: 0 }, current), /inactiveMcpDays/);
  assert.throws(() => validateSettings({ llmBaseUrl: "file:///tmp/model" }, current), /http or https/);
  assert.throws(() => validateSettings({ llmEnabled: true }, current), /发现并选择模型/);
  const agentSettings = validateSettings({
    agentEnabled: true,
    agentBaseUrl: "http://127.0.0.1:11434/v1",
    agentModel: "agent-model",
    agentApiKey: "agent-secret",
    agentMaxRounds: 25,
    agentMaxTokens: 120_000,
    agentLookbackDays: 90,
    agentProjectAllowlist: [projectPath],
    agentAllowPayloads: false,
  }, current);
  assert.equal(agentSettings.llmBaseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(agentSettings.llmModel, "agent-model");
  assert.equal(agentSettings.llmApiKey, "agent-secret");
  assert.equal("agentModel" in agentSettings, false);
  assert.equal(agentSettings.agentMaxTokens, 120_000);
  assert.equal(agentSettings.agentLookbackDays, 90);
  assert.equal(agentSettings.agentAllowPayloads, false);
  assert.deepEqual(agentSettings.agentProjectAllowlist, [projectPath]);
  assert.equal(settingsForClient(agentSettings).llmApiKeyConfigured, true);
  assert.throws(() => validateSettings({ agentEnabled: true }, current), /发现并选择模型/);
});

test("legacy Agent-only model settings migrate into the shared model service", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-legacy-model-settings-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  await writeFile(path.join(dataRoot, "settings.json"), JSON.stringify({
    ...defaultSettings(dataRoot),
    llmEnabled: false,
    llmBaseUrl: "https://review.example/v1",
    llmModel: "review-model",
    agentEnabled: true,
    agentBaseUrl: "https://agent.example/v1",
    agentModel: "agent-model",
    agentApiKey: "agent-key",
    agentTimeoutSeconds: 120,
  }));
  const migrated = await loadSettings(dataRoot);
  assert.equal(migrated.llmBaseUrl, "https://agent.example/v1");
  assert.equal(migrated.llmModel, "agent-model");
  assert.equal(migrated.llmApiKey, "agent-key");
  assert.equal(migrated.llmTimeoutSeconds, 120);
  assert.equal("agentModel" in migrated, false);
});

test("scheduled run date persists across service restarts", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-settings-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  const settings = { ...defaultSettings(dataRoot), lastScheduledRunDate: "2026-08-04" };
  await saveSettings(settings);
  assert.equal((await loadSettings(dataRoot)).lastScheduledRunDate, "2026-08-04");
});

test("daily review aggregates sessions and stores JSON and Markdown", async (context) => {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "codex-insights-"));
  context.after(() => rm(dataRoot, { recursive: true, force: true }));
  await mkdir(path.join(dataRoot, "bundle-1"), { recursive: true });
  await writeFile(path.join(dataRoot, "bundle-1", "tool.json"), JSON.stringify({ command: "cat E:\\codex\\skills\\code-review\\SKILL.md" }));
  const timestamp = new Date(2026, 7, 4, 10, 0).getTime();
  const trace = {
    trace_id: "trace-1", rollout_id: "rollout-1", started_at_unix_ms: timestamp,
    ended_at_unix_ms: timestamp + 5_000, status: "completed", codex_turns: { turn: { execution: {} } },
    inference_calls: {
      call: { model: "gpt-5", provider_name: "openai", usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 30, reasoning_output_tokens: 10 } },
    },
    tool_calls: { tool: { kind: { type: "mcp", server: "docs", tool: "search" } } },
    conversation_items: {
      context: { role: "user", body: { parts: [{ text: "<environment_context>\n  <cwd>E:\\codex</cwd>\n</environment_context>" }] } },
      metadata: { role: "user", body: { parts: [{ text: "# Files mentioned by the user: ## screenshot.png" }] } },
      generated: { role: "user", body: { parts: [{ text: "You are a helpful assistant. You will be presented with a user prompt." }] } },
      user: { role: "user", body: { parts: [{ text: "审查项目中的代码并总结风险" }] } },
    },
    raw_payloads: { invocation: { kind: { type: "tool_invocation" }, path: "tool.json" } },
  };
  Object.defineProperty(trace, "__bundleId", { value: "bundle-1" });
  const report = await buildDailyReview({
    date: "2026-08-04", traces: [trace], inventory: {
      skills: [{ id: "code-review", path: "E:\\codex\\skills\\code-review\\SKILL.md" }],
      mcpServers: [{ id: "docs" }],
    },
    previousReviews: [], bundleRoot: dataRoot, settings: defaultSettings(dataRoot),
  });
  assert.deepEqual(report.summary, {
    sessions: 1, completedSessions: 1, activeMs: 5_000, runtimeTurns: 1, modelCalls: 1, toolCalls: 1,
    inputTokens: 100, cachedInputTokens: 20, outputTokens: 30, reasoningTokens: 10, userMessages: 1, userCharacters: 13,
  });
  assert.deepEqual(report.toolUsage, { "MCP docs/search": 1 });
  assert.deepEqual(report.skillUsage, { "code-review": 1 });
  assert.equal(report.scenarioUsage["研究分析"].sessions, 1);
  assert.equal(report.scenarioUsage["研究分析"].examples[0], "审查项目中的代码并总结风险");
  assert.deepEqual(report.scenarioUsage["研究分析"].tools, { "MCP docs/search": 1 });
  assert.deepEqual(report.scenarioUsage["研究分析"].skills, { "code-review": 1 });
  assert.deepEqual(report.mcpUsage, { docs: 1 });
  assert.deepEqual(report.cleanupRecommendations, []);
  await storeReview(report, dataRoot);
  assert.equal((await listReviews(dataRoot))[0].date, "2026-08-04");
  assert.match(await readFile(path.join(dataRoot, "reports", "2026-08-04.md"), "utf8"), /Codex Daily Review/);
});

test("daily review uses concrete labels for generic tool calls", async () => {
  const timestamp = new Date(2026, 7, 4, 10, 0).getTime();
  const report = await buildDailyReview({
    date: "2026-08-04",
    traces: [{
      trace_id: "trace-generic", rollout_id: "rollout-generic", started_at_unix_ms: timestamp,
      ended_at_unix_ms: timestamp + 1_000, status: "completed", codex_turns: {}, inference_calls: {},
      tool_calls: { wait: { kind: { type: "other" }, summary: { type: "generic", label: "wait" } } },
      conversation_items: { user: { role: "user", body: { parts: [{ text: "部署服务器 密码是secret" }] } } },
    }],
    inventory: { skills: [], mcpServers: [] }, previousReviews: [], bundleRoot: "data", settings: defaultSettings("data"),
  });
  assert.deepEqual(report.toolUsage, { wait: 1 });
  assert.equal(report.scenarioUsage["部署运维"].examples[0], "部署服务器 密码是[已隐藏]");
});

test("daily review identifies long-unused tools, Skills, and MCP servers", async () => {
  const dataRoot = "data";
  const report = await buildDailyReview({
    date: "2026-08-04",
    traces: [],
    inventory: {
      skills: [{ id: "old-skill", path: "E:\\codex\\skills\\old-skill\\SKILL.md" }],
      mcpServers: [{ id: "old-server" }],
    },
    previousReviews: [{
      date: "2026-06-01",
      summary: { sessions: 1 },
      toolUsage: { exec_command: 3 },
      skillUsage: { "old-skill": 1 },
      mcpUsage: { "old-server": 2 },
    }],
    bundleRoot: dataRoot,
    settings: { ...defaultSettings(dataRoot), inactiveToolDays: 30, inactiveSkillDays: 30, inactiveMcpDays: 30 },
  });
  assert.deepEqual(report.cleanupRecommendations.map(({ type, id }) => `${type}:${id}`).sort(), [
    "mcp:old-server", "skill:old-skill", "tool:exec_command",
  ]);
});

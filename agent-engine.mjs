import {
  aggregateTraces,
  assertTraceBundleInScope,
  findCancelledTurns,
  findTraceFeedback,
  getConversationWindow,
  getTracePayload,
  getTraceToolCalls,
  getTraceTurn,
  listTraceSessions,
  refreshTraceIndex,
  searchTraces,
  traceBundleIdsSince,
} from "./trace-query.mjs";
import path from "node:path";
import { hashObject } from "./agent-schema.mjs";
import { createHarnessSnapshot, inspectConfig, listInstructions, listPlugins, listRules, listSkills, readHarnessObject, readInstruction, readSkill } from "./harness-tools.mjs";
import { validateHarnessOperation } from "./harness-mutations.mjs";
import { appendRunMessage, createProposal, createRun, getRun, listProposals, updateRun } from "./agent-store.mjs";

const MAX_RESPONSE_BYTES = 1_000_000;

export async function startAgentAnalysis(context, input = {}) {
  if (!context.settings.agentEnabled) throw new Error("Agent 尚未启用，请先配置模型与 API");
  const run = await createRun(context.dataRoot, {
    mode: input.mode,
    baseCursor: input.mode === "incremental" ? input.cursor || null : null,
    resumedFromRunId: input.resumedFromRunId || null,
    scope: analysisScope(context.settings, input.scope),
    budgets: {
      maxRounds: context.settings.agentMaxRounds,
      maxTokens: context.settings.agentMaxTokens,
      maxInputBytes: context.settings.agentMaxInputBytes,
      maxPayloadBytes: context.settings.agentMaxPayloadBytes,
      maxDurationMs: context.settings.agentMaxDurationMinutes * 60_000,
    },
  });
  return executeAgentRun(context, run.id);
}

export async function createAgentAnalysisRun(context, input = {}) {
  if (!context.settings.agentEnabled) throw new Error("Agent 尚未启用，请先配置模型与 API");
  return createRun(context.dataRoot, {
    mode: input.mode,
    baseCursor: input.mode === "incremental" ? input.cursor || null : null,
    resumedFromRunId: input.resumedFromRunId || null,
    scope: analysisScope(context.settings, input.scope),
    budgets: {
      maxRounds: context.settings.agentMaxRounds,
      maxTokens: context.settings.agentMaxTokens,
      maxInputBytes: context.settings.agentMaxInputBytes,
      maxPayloadBytes: context.settings.agentMaxPayloadBytes,
      maxDurationMs: context.settings.agentMaxDurationMinutes * 60_000,
    },
  });
}

export async function executeAgentRun(context, runId) {
  let run = await getRun(context.dataRoot, runId);
  if (!["idle", "analyzing"].includes(run.state)) throw new Error(`Agent run cannot execute from ${run.state}`);
  if (run.state === "idle") run = await updateRun(context.dataRoot, runId, { state: "analyzing", progress: { phase: "indexing", completed: 0, total: null, message: "正在建立 Trace 索引" } });
  const started = Date.now();
  try {
    const index = await refreshTraceIndex({ traceRoot: context.traceRoot, dataRoot: context.dataRoot });
    const scopedSessions = sessionsInScope(index.sessions, run.scope);
    const scopedIds = new Set(scopedSessions.map((item) => item.bundleId));
    const changedIds = run.mode === "incremental" ? traceBundleIdsSince(index, run.baseCursor) : index.sessions.map((item) => item.bundleId);
    const allowedBundleIds = changedIds.filter((id) => scopedIds.has(id));
    const analyzedSessions = scopedSessions.filter((item) => allowedBundleIds.includes(item.bundleId));
    const projects = [...new Set(analyzedSessions.map((item) => item.project).filter(Boolean))];
    run = await updateRun(context.dataRoot, runId, { scope: { ...run.scope, observedProjects: projects } });
    if (run.mode === "incremental" && allowedBundleIds.length === 0) {
      await appendRunMessage(context.dataRoot, runId, { role: "assistant", content: "自上次 Cursor 后没有新增或变更的 Trace。", kind: "message" });
      return updateRun(context.dataRoot, runId, { state: "completed", analysisCursor: index.cursor, progress: { phase: "completed", completed: 1, total: 1, message: "没有新增或变更的 Trace" } });
    }
    context = { ...context, projects, maxPayloadBytes: run.budgets.maxPayloadBytes, allowPayloads: run.scope.allowPayloads, allowedBundleIds: new Set(allowedBundleIds) };
    await updateRun(context.dataRoot, runId, { progress: { phase: "analyzing", completed: 0, total: run.budgets.maxRounds, message: `已索引 ${index.sessions.length} 个 session` } });
    const messages = [
      { role: "system", content: agentSystemPrompt() },
      { role: "user", content: JSON.stringify({
        task: run.mode === "full" ? "分析全部 Codex Trace 和当前 Harness，提出少量高置信度改进建议。" : "只分析增量 Trace，并结合当前 Harness 提出高置信度改进建议。",
        runId,
        traceCursor: index.cursor,
        sessions: allowedBundleIds.length,
        allowedBundleIds,
        projects: projects.map(displayName),
        scope: run.scope,
        constraints: ["每条建议必须包含 Trace 证据 locator", "禁止直接修改 Harness", "没有可靠证据时返回暂无建议"],
      }) },
    ];
    await appendRunMessage(context.dataRoot, runId, { role: "user", content: messages[1].content });
    for (let round = 0; round < run.budgets.maxRounds; round += 1) {
      if (context.signal?.aborted) throw new Error("用户已停止分析");
      const persistedRun = await getRun(context.dataRoot, runId);
      if (persistedRun.state === "failed") throw new Error(persistedRun.error || "Agent run 已停止");
      if (Date.now() - started > run.budgets.maxDurationMs) throw new Error("Agent 分析超过时间预算");
      const beforeCallEstimate = estimateMessageTokens(messages);
      if ((persistedRun.usage?.totalTokens || 0) + beforeCallEstimate > run.budgets.maxTokens) throw new Error("Agent 达到 Token 预算");
      const response = await callAgentModel(context.settings, messages, agentToolDefinitions(), { fetchImpl: context.fetchImpl, signal: context.signal, maxOutputTokens: Math.max(1, run.budgets.maxTokens - (persistedRun.usage?.totalTokens || 0) - beforeCallEstimate) });
      if (context.signal?.aborted) throw new Error("用户已停止分析");
      const usage = addUsage(persistedRun.usage, response.usage);
      await updateRun(context.dataRoot, runId, { usage });
      if (usage.totalTokens > run.budgets.maxTokens) throw new Error("Agent 达到 Token 预算");
      messages.push(response.message);
      await appendRunMessage(context.dataRoot, runId, { role: "assistant", content: response.message.content || "", kind: response.message.tool_calls?.length ? "tool_request" : "message" });
      if (!response.message.tool_calls?.length) {
        const proposals = await listProposals(context.dataRoot, { runId });
        const nextState = proposals.some((item) => item.status === "pending") ? "awaiting_approval" : "completed";
        return updateRun(context.dataRoot, runId, {
          state: nextState,
          analysisCursor: index.cursor,
          progress: { phase: nextState, completed: round + 1, total: run.budgets.maxRounds, message: response.message.content || "分析完成" },
        });
      }
      for (const call of response.message.tool_calls) {
        if (context.signal?.aborted) throw new Error("用户已停止分析");
        const args = parseToolArguments(call.function?.arguments);
        const result = await executeAnalysisTool(context, runId, call.function?.name, args);
        const content = boundedJson(result, run.budgets.maxInputBytes);
        messages.push({ role: "tool", tool_call_id: call.id, content });
        await appendRunMessage(context.dataRoot, runId, { role: "tool", toolName: call.function?.name, content, kind: "tool_result" });
      }
      await updateRun(context.dataRoot, runId, { progress: { phase: "analyzing", completed: round + 1, total: run.budgets.maxRounds, message: `完成第 ${round + 1} 轮分析` } });
    }
    throw new Error("Agent 达到最大分析轮次");
  } catch (error) {
    const current = await getRun(context.dataRoot, runId);
    if (current.state === "failed" && current.error === "用户已停止分析") return current;
    await updateRun(context.dataRoot, runId, { state: "failed", error: boundedError(error), progress: { phase: "failed", completed: 0, total: null, message: boundedError(error) } });
    throw error;
  }
}

export async function testAgentConnection(settings, { fetchImpl = globalThis.fetch } = {}) {
  const startedAt = Date.now();
  const response = await callAgentModel(settings, [{ role: "user", content: "只回复 OK" }], [], { fetchImpl });
  return { ok: Boolean(response.message.content), model: sharedModelSetting(settings, "Model"), latencyMs: Date.now() - startedAt };
}

async function executeAnalysisTool(context, runId, name, args) {
  const traceContext = {
    traceRoot: context.traceRoot,
    dataRoot: context.dataRoot,
    maxPayloadBytes: context.maxPayloadBytes,
    allowPayloads: context.allowPayloads,
  };
  traceContext.allowedBundleIds = context.allowedBundleIds;
  if (args.bundleId) await assertTraceBundleInScope(traceContext, args.bundleId);
  if (name === "trace_list_sessions") return listTraceSessions(traceContext, args);
  if (name === "trace_search") return searchTraces(traceContext, args);
  if (name === "trace_get_turn") return getTraceTurn(traceContext, args.bundleId, args.turnId);
  if (name === "trace_get_conversation_window") return getConversationWindow(traceContext, args);
  if (name === "trace_get_tool_calls") return getTraceToolCalls(traceContext, args);
  if (name === "trace_get_payload") return getTracePayload(traceContext, args);
  if (name === "trace_aggregate") return aggregateTraces(traceContext, args);
  if (name === "trace_find_feedback") return findTraceFeedback(traceContext, args);
  if (name === "trace_find_cancelled_turns") return findCancelledTurns(traceContext, args);
  if (name === "harness_snapshot") return createHarnessSnapshot(context);
  if (name === "harness_read") return readHarnessObject(context, args.target);
  if (name === "instructions_list") return listInstructions(context);
  if (name === "instructions_read") return readInstruction(context, args.path);
  if (name === "skills_list") return listSkills(context);
  if (name === "skills_read") return readSkill(context, args.id || args.path);
  if (name === "mcp_list") return (await inspectConfig(path.join(context.codexHome, "config.toml"))).mcpServers;
  if (name === "mcp_inspect") return readHarnessObject(context, { type: "mcp_server", scope: "global", path: path.join(context.codexHome, "config.toml"), id: args.id });
  if (name === "config_read") return inspectConfig(path.join(context.codexHome, "config.toml"));
  if (name === "rules_list") return listRules(context);
  if (name === "hooks_list") return (await inspectConfig(path.join(context.codexHome, "config.toml"))).hooks;
  if (name === "plugins_list") return listPlugins(context);
  if (name === "proposal_create") {
    await validateEvidenceLocators(traceContext, args.evidence);
    await validateHarnessOperation(context, args.target, args.operation);
    let current = null;
    try { current = await readHarnessObject(context, args.target); } catch { current = null; }
    const expectedTargetHash = current?.hash || null;
    if (args.expectedTargetHash !== undefined && args.expectedTargetHash !== expectedTargetHash) throw new Error("proposal expectedTargetHash does not match the current Harness object");
    const existing = await listProposals(context.dataRoot);
    const operationKey = hashObject({ target: args.target, operation: args.operation });
    if (existing.some((item) => hashObject({ target: item.target, operation: item.operation }) === operationKey)) {
      throw new Error("an equivalent proposal already exists or was already decided");
    }
    const proposal = await createProposal(context.dataRoot, {
      ...args,
      runId,
      expectedTargetHash,
      harnessEvidence: { targetType: args.target.type, targetId: args.target.id, targetPath: args.target.path, scope: args.target.scope, hash: expectedTargetHash, observedAtUnixMs: Date.now() },
      diff: buildOperationDiff(current, args.operation),
    });
    return { proposalId: proposal.id, status: proposal.status, operationHash: proposal.operationHash };
  }
  if (name === "analysis_finish") return { ok: true, message: String(args.message || "分析完成") };
  throw new Error(`unknown Agent analysis tool: ${name}`);
}

async function callAgentModel(settings, messages, tools, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("当前 Node.js 环境不支持 fetch");
  const url = chatCompletionsUrl(sharedModelSetting(settings, "BaseUrl"));
  const body = JSON.stringify({ model: sharedModelSetting(settings, "Model"), messages, tools, tool_choice: tools.length ? "auto" : undefined, max_completion_tokens: options.maxOutputTokens ? Math.min(options.maxOutputTokens, 100_000) : undefined });
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) controller.abort(options.signal.reason);
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, sharedModelSetting(settings, "TimeoutSeconds") * 1_000);
  try {
    const headers = { "content-type": "application/json" };
    const apiKey = sharedModelSetting(settings, "ApiKey");
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(url, { method: "POST", headers, body, signal: controller.signal });
    const text = await readBoundedResponse(response);
    if (!response.ok) throw new Error(`Agent API 返回 HTTP ${response.status}：${text.slice(0, 500)}`);
    const payload = JSON.parse(text);
    const message = payload?.choices?.[0]?.message;
    if (!message) throw new Error("Agent API 响应缺少 choices[0].message");
    const normalizedMessage = { role: "assistant", content: normalizeContent(message.content), tool_calls: normalizeToolCalls(message.tool_calls) };
    return { message: normalizedMessage, usage: normalizeModelUsage(payload.usage, messages, normalizedMessage) };
  } catch (error) {
    if (options.signal?.aborted) throw new Error("用户已停止分析");
    if (timedOut) throw new Error(`Agent 请求超过 ${sharedModelSetting(settings, "TimeoutSeconds")} 秒`);
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function sharedModelSetting(settings, suffix) {
  return settings[`llm${suffix}`] ?? settings[`agent${suffix}`];
}

function agentSystemPrompt() {
  return `你是 Codex Harness 审计 Agent。你的目标不是判断模型是否聪明，而是根据用户的全部历史 Trace，找出能够让 Codex 更符合用户使用习惯的改进。\n\n硬性规则：\n1. 只能调用提供的只读 Trace、只读 Harness、proposal.create 和 analysis.finish 工具。\n2. 绝不能直接修改任何 Harness 对象。修改只能形成 proposal，等待用户逐项审批。\n3. 每个 proposal 必须绑定至少一条可回溯的 Trace evidence locator，并检查是否存在反例。\n4. 单次偶发现象不要泛化为全局偏好。优先建议低风险、明确作用域的变化。\n5. 区分全局 AGENTS、项目 AGENTS、Skill、MCP、config、Rules、Hooks 和 Plugins，不要把它们都叫系统提示词。\n6. 建议必须给出完整 operation，后端将按 operationHash 审批和执行。\n7. 如果证据不足，明确说明暂无可靠建议并结束。\n8. 不要为追求建议数量而制造问题，通常 0 到 5 条高质量建议足够。`;
}

function agentToolDefinitions() {
  const tool = (name, description, properties = {}, required = []) => ({ type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } });
  const filters = { project: { type: "string" }, status: { type: "string" }, intent: { type: "string" }, tool: { type: "string" }, afterUnixMs: { type: "number" }, beforeUnixMs: { type: "number" }, limit: { type: "integer" } };
  return [
    tool("trace_list_sessions", "列出 Trace session 元数据", { ...filters, query: { type: "string" } }),
    tool("trace_search", "在对话与工具摘要中搜索文本", { ...filters, query: { type: "string" } }, ["query"]),
    tool("trace_get_turn", "读取一个 turn 的消息和工具调用", { bundleId: { type: "string" }, turnId: { type: "string" } }, ["bundleId", "turnId"]),
    tool("trace_get_conversation_window", "读取某消息或 turn 周围的对话窗口", { bundleId: { type: "string" }, turnId: { type: "string" }, itemId: { type: "string" }, radius: { type: "integer" } }, ["bundleId"]),
    tool("trace_get_tool_calls", "读取 session 或 turn 的工具调用", { bundleId: { type: "string" }, turnId: { type: "string" }, status: { type: "string" }, limit: { type: "integer" } }, ["bundleId"]),
    tool("trace_get_payload", "按需读取经过脱敏且有大小限制的 Payload", { bundleId: { type: "string" }, payloadId: { type: "string" }, maxBytes: { type: "integer" } }, ["bundleId", "payloadId"]),
    tool("trace_aggregate", "聚合 session、turn、工具失败等指标", filters),
    tool("trace_find_feedback", "查找助手行为之后的用户显式纠正或偏好表达", filters),
    tool("trace_find_cancelled_turns", "查找取消或中断的 turn", filters),
    tool("harness_snapshot", "读取当前 Codex Harness 全量快照"),
    tool("harness_read", "读取一个已发现的 Harness 对象", { target: { type: "object", additionalProperties: true } }, ["target"]),
    tool("instructions_list", "列出按实际生效顺序排列的全局和项目 AGENTS.md"),
    tool("instructions_read", "读取一份已发现的 AGENTS.md", { path: { type: "string" } }, ["path"]),
    tool("skills_list", "列出 Skill、文件和校验状态"),
    tool("skills_read", "读取 Skill 及引用文件", { id: { type: "string" }, path: { type: "string" } }),
    tool("mcp_list", "列出 MCP 配置和启用状态"),
    tool("mcp_inspect", "读取一个 MCP 配置", { id: { type: "string" } }, ["id"]),
    tool("config_read", "结构化读取 config.toml"),
    tool("rules_list", "列出 Rules"),
    tool("hooks_list", "列出 Hooks"),
    tool("plugins_list", "列出 Plugins"),
    tool("proposal_create", "创建一条等待用户审批的结构化 Harness 修改建议", {
      title: { type: "string" }, summary: { type: "string" }, rationale: { type: "string" },
      target: { type: "object", additionalProperties: true }, operation: { type: "object", additionalProperties: true },
      expectedTargetHash: { type: "string" }, evidence: { type: "array", items: { type: "object", additionalProperties: true } },
      risk: { type: "string", enum: ["low", "medium", "high"] }, requiresRestart: { type: "boolean" },
      verificationPlan: { type: "array", items: { type: "string" } },
    }, ["title", "summary", "rationale", "target", "operation", "evidence"]),
    tool("analysis_finish", "结束本次分析", { message: { type: "string" } }, ["message"]),
  ];
}

async function validateEvidenceLocators(context, evidence) {
  if (!Array.isArray(evidence) || !evidence.length) throw new Error("proposal evidence is required");
  for (const item of evidence) {
    if (!context.allowedBundleIds?.has(item.bundleId)) throw new Error(`evidence bundle is outside this analysis scope: ${item.bundleId}`);
    if (item.itemId) await getConversationWindow(context, { bundleId: item.bundleId, itemId: item.itemId, radius: 1 });
    else if (item.turnId) await getTraceTurn(context, item.bundleId, item.turnId);
    else if (item.payloadId) await getTracePayload(context, { bundleId: item.bundleId, payloadId: item.payloadId });
    else {
      const sessions = await listTraceSessions(context, { limit: 10_000 });
      if (!sessions.some((session) => session.bundleId === item.bundleId)) throw new Error(`evidence bundle not found: ${item.bundleId}`);
    }
  }
}

function buildOperationDiff(current, operation) {
  const before = current?.content ?? current?.source ?? current ?? null;
  let after = operation;
  if (operation?.kind === "text.replace") after = operation.content;
  else if (operation?.kind === "text.append") after = `${typeof before === "string" ? before.replace(/\s*$/, "") : ""}\n\n${operation.content || ""}`;
  return { format: "before_after", before, after };
}

function chatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

async function readBoundedResponse(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("Agent 响应超过 1 MB");
  return text;
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((item) => typeof item === "string" ? item : item?.text || "").join("");
}

function normalizeToolCalls(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item?.id && item?.function?.name).map((item) => ({ id: item.id, type: "function", function: { name: item.function.name, arguments: item.function.arguments || "{}" } }));
}

function parseToolArguments(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error("Agent tool arguments are invalid JSON");
  }
}

function boundedJson(value, limit) {
  const source = JSON.stringify(value);
  if (Buffer.byteLength(source, "utf8") <= limit) return source;
  return JSON.stringify({ truncated: true, message: `工具结果超过 ${limit} bytes，请缩小查询范围` });
}

function boundedError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1_000 ? `${message.slice(0, 999)}…` : message;
}

function displayName(value) {
  return String(value).replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || value;
}

function analysisScope(settings, input = {}) {
  const configuredProjects = Array.isArray(settings.agentProjectAllowlist) ? settings.agentProjectAllowlist : [];
  const requestedProjects = Array.isArray(input?.projects) ? input.projects : [];
  if (configuredProjects.length && requestedProjects.some((item) => !configuredProjects.some((allowed) => samePath(allowed, item)))) {
    throw new Error("requested Agent project is outside the configured project allowlist");
  }
  const projects = requestedProjects.length
    ? requestedProjects.filter((item) => !configuredProjects.length || configuredProjects.some((allowed) => samePath(allowed, item)))
    : configuredProjects;
  return {
    lookbackDays: stricterLookback(settings.agentLookbackDays || 0, Number(input.lookbackDays) || 0),
    projects,
    allowPayloads: settings.agentAllowPayloads !== false && input.allowPayloads !== false,
  };
}

function stricterLookback(configured, requested) {
  if (!configured) return requested;
  if (!requested) return configured;
  return Math.min(configured, requested);
}

function sessionsInScope(sessions, scope) {
  const cutoff = scope.lookbackDays > 0 ? Date.now() - scope.lookbackDays * 86_400_000 : 0;
  return sessions.filter((session) => {
    if (cutoff && session.startedAtUnixMs < cutoff) return false;
    if (scope.projects.length && !scope.projects.some((project) => samePath(project, session.project))) return false;
    return true;
  });
}

function normalizeModelUsage(value, messages, responseMessage) {
  const inputTokens = Number(value?.prompt_tokens ?? value?.input_tokens);
  const outputTokens = Number(value?.completion_tokens ?? value?.output_tokens);
  const estimatedInput = estimateMessageTokens(messages);
  const estimatedOutput = estimateMessageTokens([responseMessage]);
  const normalizedInput = Number.isFinite(inputTokens) && inputTokens >= 0 ? Math.trunc(inputTokens) : estimatedInput;
  const normalizedOutput = Number.isFinite(outputTokens) && outputTokens >= 0 ? Math.trunc(outputTokens) : estimatedOutput;
  return { inputTokens: normalizedInput, outputTokens: normalizedOutput, totalTokens: normalizedInput + normalizedOutput, modelCalls: 1 };
}

function addUsage(current = {}, next = {}) {
  return {
    inputTokens: (current.inputTokens || 0) + (next.inputTokens || 0),
    outputTokens: (current.outputTokens || 0) + (next.outputTokens || 0),
    totalTokens: (current.totalTokens || 0) + (next.totalTokens || 0),
    modelCalls: (current.modelCalls || 0) + 1,
  };
}

function estimateMessageTokens(messages) {
  return Math.max(1, Math.ceil(Buffer.byteLength(JSON.stringify(messages || []), "utf8") / 4));
}

function samePath(left, right) {
  if (!left || !right) return false;
  return String(left).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase() === String(right).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
}

import {
  consumeApproval,
  createChange,
  decideProposal,
  getChange,
  getProposal,
  getRun,
  listChanges,
  listProposals,
  listRuns,
  updateChange,
  updateProposal,
  updateRun,
} from "./agent-store.mjs";
import { applyHarnessOperation, rollbackHarnessChange, validateHarnessOperation, verifyHarnessChange } from "./harness-mutations.mjs";
import { createHarnessSnapshot } from "./harness-tools.mjs";
import { aggregateTraces, getConversationWindow, getTracePayload, getTraceToolCalls, getTraceTurn, refreshTraceIndex } from "./trace-query.mjs";

export async function agentDashboard(context) {
  const [runs, proposals, changes, index] = await Promise.all([
    listRuns(context.dataRoot),
    listProposals(context.dataRoot),
    listChanges(context.dataRoot),
    refreshTraceIndex({ traceRoot: context.traceRoot, dataRoot: context.dataRoot }),
  ]);
  const pending = proposals.filter((item) => item.status === "pending");
  const lastAnalyzedRun = runs.find((item) => item.analysisCursor && ["awaiting_approval", "completed"].includes(item.state));
  return {
    configured: Boolean(context.settings.agentEnabled && (context.settings.llmModel || context.settings.agentModel)),
    model: context.settings.llmModel || context.settings.agentModel || null,
    traceCursor: index.cursor,
    incrementalCursor: lastAnalyzedRun?.analysisCursor || null,
    incrementalSinceRunId: lastAnalyzedRun?.id || null,
    indexedSessions: index.sessions.length,
    indexErrors: index.errors || [],
    runs,
    proposals,
    pendingCount: pending.length,
    changes,
  };
}

export async function proposalDetail(context, proposalId) {
  const proposal = await getProposal(context.dataRoot, proposalId);
  return { proposal, run: await getRun(context.dataRoot, proposal.runId) };
}

export async function decideAgentProposal(context, proposalId, input) {
  const currentProposal = await getProposal(context.dataRoot, proposalId);
  const run = await getRun(context.dataRoot, currentProposal.runId);
  await validateHarnessOperation(
    { ...context, projects: run.scope?.observedProjects || [] },
    currentProposal.target,
    input?.editedOperation === undefined ? currentProposal.operation : input.editedOperation,
  );
  const result = await decideProposal(context.dataRoot, proposalId, input);
  const proposal = await getProposal(context.dataRoot, proposalId);
  const outstanding = await listProposals(context.dataRoot, { runId: proposal.runId });
  if (!outstanding.some((item) => ["pending", "approved", "applying"].includes(item.status))) {
    const run = await getRun(context.dataRoot, proposal.runId);
    if (run.state === "awaiting_approval") await updateRun(context.dataRoot, run.id, { state: "completed", progress: { phase: "completed", completed: 1, total: 1, message: "所有建议均已处理" } });
  }
  return result;
}

export async function applyAgentProposal(context, proposalId, token) {
  let proposal = await getProposal(context.dataRoot, proposalId);
  if (proposal.status !== "approved") throw new Error(`proposal cannot be applied from ${proposal.status}`);
  const approval = await consumeApproval(context.dataRoot, proposalId, token);
  if (approval.operationHash !== proposal.operationHash) throw new Error("approved operation hash mismatch");
  let run = await getRun(context.dataRoot, proposal.runId);
  context = { ...context, projects: run.scope?.observedProjects || [] };
  if (run.state !== "awaiting_approval") throw new Error(`Agent run cannot apply from ${run.state}`);
  run = await updateRun(context.dataRoot, run.id, { state: "applying", progress: { phase: "applying", completed: 0, total: 1, message: `正在应用：${proposal.title}` } });
  proposal = await updateProposal(context.dataRoot, proposal.id, { status: "applying" });
  let change = await createChange(context.dataRoot, {
    runId: run.id,
    proposalId: proposal.id,
    approvalId: approval.id,
    target: proposal.target,
    operationHash: proposal.operationHash,
    operation: approval.operation,
    diff: proposal.diff,
  });
  try {
    const applied = await applyHarnessOperation(context, proposal, approval, {
      onSnapshot: async ({ snapshot, beforeHash }) => {
        change = await updateChange(context.dataRoot, change.id, { snapshotId: snapshot.id, beforeHash });
      },
    });
    change = await updateChange(context.dataRoot, change.id, {
      state: "verifying",
      snapshotId: applied.snapshot.id,
      beforeHash: applied.beforeHash,
      afterHash: applied.afterHash,
    });
    await updateRun(context.dataRoot, run.id, { state: "verifying", progress: { phase: "verifying", completed: 0, total: 1, message: "正在验证 Harness 变更" } });
    const verification = await verifyHarnessChange(context, proposal.target, approval.operation, applied.afterHash);
    if (verification.status !== "passed") throw new Error("Harness 变更验证失败");
    change = await updateChange(context.dataRoot, change.id, { state: "completed", verification, completedAtUnixMs: Date.now() });
    proposal = await updateProposal(context.dataRoot, proposal.id, { status: "applied", appliedChangeId: change.id });
    const outstanding = await listProposals(context.dataRoot, { runId: run.id });
    const nextState = outstanding.some((item) => ["pending", "approved"].includes(item.status)) ? "awaiting_approval" : "completed";
    await updateRun(context.dataRoot, run.id, { state: nextState, progress: { phase: nextState, completed: 1, total: 1, message: nextState === "completed" ? "建议已应用并验证" : "本项已应用，仍有建议待处理" } });
    return { proposal, change };
  } catch (error) {
    let recovery = null;
    if (change.snapshotId && (!isExternalChange(change.operation) || change.afterHash)) {
      try {
        const result = await rollbackHarnessChange(context, change);
        recovery = { status: "restored", ...result, recordedAtUnixMs: Date.now() };
      } catch (rollbackError) {
        recovery = { status: "failed", error: boundedError(rollbackError), recordedAtUnixMs: Date.now() };
      }
    }
    await updateChange(context.dataRoot, change.id, {
      state: "failed",
      error: boundedError(error),
      rollback: recovery,
      rolledBackAtUnixMs: recovery?.status === "restored" ? Date.now() : null,
    });
    await updateProposal(context.dataRoot, proposal.id, { status: "failed" });
    await updateRun(context.dataRoot, run.id, { state: "failed", error: boundedError(error), progress: { phase: "failed", completed: 0, total: 1, message: boundedError(error) } });
    throw error;
  }
}

export async function recoverInterruptedAgentState(context) {
  const changes = await listChanges(context.dataRoot);
  for (const change of changes) {
    if (!["applying", "verifying"].includes(change.state)) continue;
    const external = isExternalChange(change.operation);
    let rollback = null;
    if (change.snapshotId && (!external || change.afterHash)) {
      try {
        rollback = { status: "restored", ...await rollbackHarnessChange(context, change), recordedAtUnixMs: Date.now() };
      } catch (error) {
        rollback = { status: "failed", error: boundedError(error), recordedAtUnixMs: Date.now() };
      }
    }
    const error = external && !change.afterHash
      ? "服务在外部 Codex CLI 操作期间中断，无法判断命令是否完成；请人工核验后重新提案"
      : rollback?.status === "restored"
        ? "服务重启时发现未完成的 Harness 变更，已从快照恢复"
        : "服务重启时发现未完成的 Harness 变更，自动恢复失败；请人工核验";
    await updateChange(context.dataRoot, change.id, {
      state: "failed",
      error,
      rollback,
      rolledBackAtUnixMs: rollback?.status === "restored" ? Date.now() : null,
    });
    await updateProposal(context.dataRoot, change.proposalId, { status: "failed" });
  }

  const runs = await listRuns(context.dataRoot);
  for (const run of runs) {
    if (!["idle", "analyzing", "applying", "verifying"].includes(run.state)) continue;
    const mutationInterrupted = ["applying", "verifying"].includes(run.state);
    await updateRun(context.dataRoot, run.id, {
      state: "failed",
      error: mutationInterrupted
        ? "服务在 Harness 变更期间中断；请检查变更记录后再处理"
        : "服务重启中断了本次分析，可从原分析 Cursor 恢复",
      progress: {
        phase: "failed",
        completed: 0,
        total: run.progress?.total ?? null,
        message: mutationInterrupted ? "Harness 变更被服务重启中断" : "分析被服务重启中断，可恢复",
      },
    });
  }
}

export async function rollbackAgentChange(context, changeId, confirmation) {
  if (confirmation !== true) throw new Error("rollback requires explicit user confirmation");
  const change = await getChange(context.dataRoot, changeId);
  const run = await getRun(context.dataRoot, change.runId);
  context = { ...context, projects: run.scope?.observedProjects || [] };
  if (change.state !== "completed") throw new Error(`change cannot be rolled back from ${change.state}`);
  if (change.rolledBackAtUnixMs) throw new Error("change has already been rolled back");
  const result = await rollbackHarnessChange(context, change);
  return updateChange(context.dataRoot, change.id, {
    state: "rolled_back",
    rolledBackAtUnixMs: Date.now(),
    rollback: { ...result, confirmedByUser: true, recordedAtUnixMs: Date.now() },
  });
}

export async function agentEvidenceSummary(context) {
  const index = await refreshTraceIndex({ traceRoot: context.traceRoot, dataRoot: context.dataRoot });
  const projects = [...new Set(index.sessions.map((item) => item.project).filter(Boolean))];
  const [aggregate, harness] = await Promise.all([
    aggregateTraces({ traceRoot: context.traceRoot, dataRoot: context.dataRoot }, {}),
    createHarnessSnapshot({ ...context, projects }),
  ]);
  return { traceCursor: index.cursor, aggregate, harness };
}

export async function agentEvidenceDetail(context, input) {
  const index = await refreshTraceIndex({ traceRoot: context.traceRoot, dataRoot: context.dataRoot });
  if (!index.sessions.some((item) => item.bundleId === input.bundleId)) throw new Error("trace evidence bundle not found");
  const traceContext = {
    traceRoot: context.traceRoot,
    dataRoot: context.dataRoot,
    maxPayloadBytes: Math.min(250_000, context.settings?.agentMaxPayloadBytes || 250_000),
    allowPayloads: context.settings?.agentAllowPayloads !== false,
  };
  if (input.payloadId) return { kind: "payload", value: await getTracePayload(traceContext, input) };
  if (input.toolCallId) return { kind: "tool_call", value: (await getTraceToolCalls(traceContext, { bundleId: input.bundleId, turnId: input.turnId, limit: 1_000 })).find((item) => item.toolCallId === input.toolCallId) || null };
  if (input.itemId) return { kind: "conversation_window", value: await getConversationWindow(traceContext, { ...input, radius: 3 }) };
  if (input.turnId) return { kind: "turn", value: await getTraceTurn(traceContext, input.bundleId, input.turnId) };
  return { kind: "session", value: index.sessions.find((item) => item.bundleId === input.bundleId) };
}

function boundedError(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.length > 1_000 ? `${value.slice(0, 999)}…` : value;
}

function isExternalChange(operation) {
  return Boolean(operation && (
    (["plugin.install", "plugin.update", "plugin.uninstall"].includes(operation.kind) && operation.selector)
    || (["mcp.add", "mcp.remove", "mcp.update"].includes(operation.kind) && operation.cli === true)
  ));
}

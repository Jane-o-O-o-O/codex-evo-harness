import { createHash, randomUUID } from "node:crypto";

export const AGENT_SCHEMA_VERSION = 2;

export const AGENT_RUN_STATES = Object.freeze([
  "idle",
  "analyzing",
  "awaiting_approval",
  "applying",
  "verifying",
  "completed",
  "failed",
]);

export const HARNESS_OBJECT_TYPES = Object.freeze([
  "global_instructions",
  "project_instructions",
  "skill",
  "mcp_server",
  "config",
  "rules",
  "hooks",
  "plugin",
]);

export const PROPOSAL_STATUSES = Object.freeze([
  "draft",
  "pending",
  "approved",
  "rejected",
  "deferred",
  "applying",
  "applied",
  "failed",
  "superseded",
]);

export const APPROVAL_DECISIONS = Object.freeze(["approved", "rejected", "deferred"]);

const RUN_TRANSITIONS = new Map([
  ["idle", new Set(["analyzing", "failed"])],
  ["analyzing", new Set(["awaiting_approval", "completed", "failed"])],
  ["awaiting_approval", new Set(["applying", "completed", "failed"])],
  ["applying", new Set(["verifying", "failed"])],
  ["verifying", new Set(["awaiting_approval", "completed", "failed"])],
  ["completed", new Set()],
  ["failed", new Set()],
]);

const PROPOSAL_TRANSITIONS = new Map([
  ["draft", new Set(["pending", "approved", "rejected", "deferred", "superseded"])],
  ["pending", new Set(["approved", "rejected", "deferred", "superseded"])],
  ["approved", new Set(["approved", "rejected", "deferred", "applying", "failed", "superseded"])],
  ["rejected", new Set(["superseded"])],
  ["deferred", new Set(["approved", "rejected", "deferred", "superseded"])],
  ["applying", new Set(["applied", "failed"])],
  ["applied", new Set()],
  ["failed", new Set(["superseded"])],
  ["superseded", new Set()],
]);

export function assertRunTransition(from, to) {
  assertEnum(from, AGENT_RUN_STATES, "run state");
  assertEnum(to, AGENT_RUN_STATES, "run state");
  if (from === to) return;
  if (!RUN_TRANSITIONS.get(from)?.has(to)) throw new Error(`invalid Agent run transition: ${from} -> ${to}`);
}

export function assertProposalTransition(from, to) {
  assertEnum(from, PROPOSAL_STATUSES, "proposal status");
  assertEnum(to, PROPOSAL_STATUSES, "proposal status");
  if (from === to && from === "approved") return;
  if (from === to && from === "deferred") return;
  if (!PROPOSAL_TRANSITIONS.get(from)?.has(to)) throw new Error(`invalid Proposal transition: ${from} -> ${to}`);
}

export function assertHarnessTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("proposal target must be an object");
  assertEnum(target.type, HARNESS_OBJECT_TYPES, "harness target type");
  if (!['global', 'project'].includes(target.scope)) throw new Error("harness target scope must be global or project");
  if (typeof target.path !== "string" || !target.path.trim()) throw new Error("harness target path is required");
  if (target.scope === "project" && (typeof target.project !== "string" || !target.project.trim())) throw new Error("project-scoped Harness target requires project");
  if (target.id !== undefined && (typeof target.id !== "string" || !target.id.trim())) throw new Error("harness target id must be a non-empty string");
  return target;
}

export function normalizeEvidence(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("proposal evidence must contain at least one locator");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("evidence locator must be an object");
    if (typeof item.bundleId !== "string" || !item.bundleId) throw new Error("evidence locator bundleId is required");
    return {
      bundleId: item.bundleId,
      traceId: optionalString(item.traceId),
      turnId: optionalString(item.turnId),
      itemId: optionalString(item.itemId),
      toolCallId: optionalString(item.toolCallId),
      payloadId: optionalString(item.payloadId),
      signal: optionalString(item.signal),
      excerpt: optionalString(item.excerpt, 800),
      excerptHash: item.excerpt ? sha256(item.excerpt) : optionalString(item.excerptHash),
    };
  });
}

export function createRunRecord(input = {}) {
  const now = Date.now();
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    id: input.id || createId("run"),
    state: "idle",
    mode: input.mode === "incremental" ? "incremental" : "full",
    requestedAtUnixMs: now,
    updatedAtUnixMs: now,
    startedAtUnixMs: null,
    endedAtUnixMs: null,
    baseCursor: input.baseCursor ?? input.analysisCursor ?? null,
    analysisCursor: input.completedCursor || null,
    resumedFromRunId: input.resumedFromRunId || null,
    scope: normalizeAnalysisScope(input.scope),
    budgets: normalizeBudgets(input.budgets),
    usage: normalizeUsage(input.usage),
    progress: { phase: "queued", completed: 0, total: null, message: "" },
    messages: [],
    proposalIds: [],
    error: null,
  };
}

export function createProposalRecord(input) {
  if (!input || typeof input !== "object") throw new Error("proposal input is required");
  if (typeof input.runId !== "string" || !input.runId) throw new Error("proposal runId is required");
  assertHarnessTarget(input.target);
  const evidence = normalizeEvidence(input.evidence);
  const operation = normalizeOperation(input.operation);
  const now = Date.now();
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    id: input.id || createId("proposal"),
    runId: input.runId,
    status: input.status === "draft" ? "draft" : "pending",
    title: requiredString(input.title, "proposal title", 240),
    summary: requiredString(input.summary, "proposal summary", 4_000),
    rationale: requiredString(input.rationale, "proposal rationale", 8_000),
    target: { ...input.target, path: input.target.path.trim() },
    operation,
    operationHash: hashObject(operation),
    diff: input.diff && typeof input.diff === "object" ? JSON.parse(JSON.stringify(input.diff)) : null,
    expectedTargetHash: optionalString(input.expectedTargetHash),
    harnessEvidence: normalizeHarnessEvidence(input.harnessEvidence, input.target, input.expectedTargetHash),
    evidence,
    risk: ["low", "medium", "high"].includes(input.risk) ? input.risk : "medium",
    requiresRestart: harnessChangeRequiresRestart(input.target, operation) || Boolean(input.requiresRestart),
    verificationPlan: stringArray(input.verificationPlan, 20, 1_000),
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
    decidedAtUnixMs: null,
    latestApprovalId: null,
    appliedChangeId: null,
  };
}

export function createApprovalRecord({ proposal, decision, editedOperation, expiresAtUnixMs, tokenHash }) {
  assertEnum(decision, APPROVAL_DECISIONS, "approval decision");
  const operation = editedOperation === undefined ? proposal.operation : normalizeOperation(editedOperation);
  const now = Date.now();
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    id: createId("approval"),
    proposalId: proposal.id,
    runId: proposal.runId,
    decision,
    operation,
    operationHash: hashObject(operation),
    target: JSON.parse(JSON.stringify(proposal.target)),
    expectedTargetHash: proposal.expectedTargetHash || null,
    bindingHash: hashObject({
      proposalId: proposal.id,
      target: proposal.target,
      expectedTargetHash: proposal.expectedTargetHash || null,
      operationHash: hashObject(operation),
    }),
    tokenHash: decision === "approved" ? requiredString(tokenHash, "approval token hash") : null,
    decidedAtUnixMs: now,
    expiresAtUnixMs: decision === "approved" ? expiresAtUnixMs : null,
    consumedAtUnixMs: null,
  };
}

export function createChangeRecord(input) {
  if (!input?.proposalId || !input?.approvalId) throw new Error("change proposalId and approvalId are required");
  const now = Date.now();
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    id: input.id || createId("change"),
    runId: input.runId,
    proposalId: input.proposalId,
    approvalId: input.approvalId,
    target: input.target,
    operationHash: input.operationHash,
    operation: input.operation || null,
    diff: input.diff && typeof input.diff === "object" ? JSON.parse(JSON.stringify(input.diff)) : null,
    state: input.state || "applying",
    snapshotId: input.snapshotId || null,
    beforeHash: input.beforeHash || null,
    afterHash: input.afterHash || null,
    verification: input.verification || null,
    createdAtUnixMs: now,
    updatedAtUnixMs: now,
    completedAtUnixMs: null,
    rolledBackAtUnixMs: null,
    error: null,
  };
}

export function createSnapshotRecord(input) {
  if (!input?.target?.path) throw new Error("snapshot target is required");
  const now = Date.now();
  return {
    schemaVersion: AGENT_SCHEMA_VERSION,
    id: input.id || createId("snapshot"),
    target: input.target,
    exists: Boolean(input.exists),
    contentBase64: input.contentBase64 ?? null,
    files: Array.isArray(input.files) ? input.files.map((item) => ({
      path: requiredString(item.path, "snapshot file path", 2_000),
      contentBase64: requiredString(item.contentBase64, "snapshot file content"),
      hash: requiredString(item.hash, "snapshot file hash"),
      byteLength: Number(item.byteLength) || 0,
    })) : [],
    hash: input.hash || null,
    byteLength: input.byteLength || 0,
    createdAtUnixMs: now,
  };
}

export function createId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashObject(value) {
  return sha256(stableStringify(value));
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function harnessChangeRequiresRestart(target, operation) {
  return Boolean(target?.type && operation?.kind && HARNESS_OBJECT_TYPES.includes(target.type));
}

function normalizeBudgets(value = {}) {
  return {
    maxRounds: boundedInteger(value.maxRounds, 1, 200, 40),
    maxTokens: boundedInteger(value.maxTokens, 1_000, 10_000_000, 200_000),
    maxInputBytes: boundedInteger(value.maxInputBytes, 16_384, 50_000_000, 2_000_000),
    maxPayloadBytes: boundedInteger(value.maxPayloadBytes, 1_024, 5_000_000, 1_000_000),
    maxDurationMs: boundedInteger(value.maxDurationMs, 10_000, 86_400_000, 30 * 60_000),
  };
}

function normalizeAnalysisScope(value = {}) {
  const projects = Array.isArray(value.projects)
    ? [...new Set(value.projects.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))].slice(0, 100)
    : [];
  return {
    lookbackDays: boundedInteger(value.lookbackDays, 0, 3_650, 0),
    projects,
    observedProjects: Array.isArray(value.observedProjects)
      ? [...new Set(value.observedProjects.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim()))].slice(0, 1_000)
      : [],
    allowPayloads: value.allowPayloads !== false,
  };
}

function normalizeUsage(value = {}) {
  return {
    inputTokens: boundedInteger(value.inputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    outputTokens: boundedInteger(value.outputTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    totalTokens: boundedInteger(value.totalTokens, 0, Number.MAX_SAFE_INTEGER, 0),
    modelCalls: boundedInteger(value.modelCalls, 0, Number.MAX_SAFE_INTEGER, 0),
  };
}

function normalizeHarnessEvidence(value, target, expectedTargetHash) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    targetType: optionalString(source.targetType || target?.type),
    targetId: optionalString(source.targetId || target?.id),
    targetPath: optionalString(source.targetPath || target?.path, 2_000),
    scope: optionalString(source.scope || target?.scope),
    hash: optionalString(source.hash ?? expectedTargetHash),
    observedAtUnixMs: Number(source.observedAtUnixMs) || Date.now(),
  };
}

function normalizeOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("proposal operation must be an object");
  const kind = requiredString(value.kind, "operation kind", 120);
  return JSON.parse(JSON.stringify({ ...value, kind }));
}

function requiredString(value, label, length = 10_000) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return optionalString(value, length);
}

function optionalString(value, length = 10_000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("expected a string");
  const normalized = value.trim();
  return normalized.length > length ? normalized.slice(0, length) : normalized;
}

function stringArray(value, limit, length) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => optionalString(item, length)).filter(Boolean).slice(0, limit);
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function assertEnum(value, values, label) {
  if (!values.includes(value)) throw new Error(`${label} must be one of: ${values.join(", ")}`);
}

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  AGENT_SCHEMA_VERSION,
  APPROVAL_DECISIONS,
  assertProposalTransition,
  assertRunTransition,
  createApprovalRecord,
  createChangeRecord,
  createProposalRecord,
  createRunRecord,
  createSnapshotRecord,
  hashObject,
  sha256,
} from "./agent-schema.mjs";

const COLLECTIONS = Object.freeze(["runs", "proposals", "approvals", "changes", "snapshots"]);
const STORE_MIGRATIONS = new Map([
  [0, async (_root, metadata) => {
    const migratedAtUnixMs = Date.now();
    return {
      ...metadata,
      schemaVersion: 1,
      migratedAtUnixMs,
      migrationHistory: [...(metadata.migrationHistory || []), { from: 0, to: 1, migratedAtUnixMs }],
    };
  }],
  [1, async (root, metadata) => {
    const migratedAtUnixMs = Date.now();
    await migrateV1Records(root);
    return {
      ...metadata,
      schemaVersion: 2,
      migratedAtUnixMs,
      migrationHistory: [...(metadata.migrationHistory || []), { from: 1, to: 2, migratedAtUnixMs }],
    };
  }],
]);

export function agentRoot(dataRoot) {
  return path.join(dataRoot, "agent");
}

export async function initializeAgentStore(dataRoot) {
  const root = agentRoot(dataRoot);
  await Promise.all([
    ...COLLECTIONS.map((name) => mkdir(path.join(root, name), { recursive: true })),
    mkdir(path.join(root, "analysis-index"), { recursive: true }),
  ]);
  const metadataFile = path.join(root, "metadata.json");
  let metadata;
  try {
    metadata = await readJson(metadataFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    metadata = { schemaVersion: AGENT_SCHEMA_VERSION, createdAtUnixMs: Date.now(), migratedAtUnixMs: Date.now() };
    await writeJsonAtomic(metadataFile, metadata);
  }
  if (!Number.isInteger(metadata.schemaVersion) || metadata.schemaVersion < 0) throw new Error("invalid Agent store schema version");
  if (metadata.schemaVersion > AGENT_SCHEMA_VERSION) {
    throw new Error(`Agent store schema ${metadata.schemaVersion} is newer than supported version ${AGENT_SCHEMA_VERSION}`);
  }
  while (metadata.schemaVersion < AGENT_SCHEMA_VERSION) {
    const migrate = STORE_MIGRATIONS.get(metadata.schemaVersion);
    if (!migrate) throw new Error(`no Agent store migration from schema version ${metadata.schemaVersion}`);
    metadata = await migrate(root, metadata);
    await writeJsonAtomic(metadataFile, metadata);
  }
  return { root, metadata };
}

export async function createRun(dataRoot, input = {}) {
  await initializeAgentStore(dataRoot);
  const run = createRunRecord(input);
  await putRecord(dataRoot, "runs", run);
  return run;
}

export async function getRun(dataRoot, id) {
  return getRecord(dataRoot, "runs", id);
}

export async function listRuns(dataRoot) {
  return listRecords(dataRoot, "runs", (left, right) => right.requestedAtUnixMs - left.requestedAtUnixMs);
}

export async function updateRun(dataRoot, id, patch) {
  const current = await getRun(dataRoot, id);
  const nextState = patch.state || current.state;
  assertRunTransition(current.state, nextState);
  const now = Date.now();
  const next = { ...current, ...patch, id: current.id, schemaVersion: current.schemaVersion, state: nextState, updatedAtUnixMs: now };
  if (current.state === "idle" && nextState === "analyzing") next.startedAtUnixMs = now;
  if (["completed", "failed"].includes(nextState)) next.endedAtUnixMs = now;
  await putRecord(dataRoot, "runs", next);
  return next;
}

export async function appendRunMessage(dataRoot, id, message) {
  const current = await getRun(dataRoot, id);
  const role = ["system", "user", "assistant", "tool"].includes(message?.role) ? message.role : "assistant";
  const next = {
    ...current,
    messages: [...(current.messages || []), {
      id: message.id || `message-${Date.now()}-${current.messages?.length || 0}`,
      role,
      kind: message.kind || "message",
      content: String(message.content || "").slice(0, 100_000),
      toolName: message.toolName || null,
      createdAtUnixMs: Date.now(),
    }],
    updatedAtUnixMs: Date.now(),
  };
  await putRecord(dataRoot, "runs", next);
  return next;
}

export async function createProposal(dataRoot, input) {
  const proposal = createProposalRecord(input);
  await putRecord(dataRoot, "proposals", proposal);
  const run = await getRun(dataRoot, proposal.runId);
  if (!run.proposalIds.includes(proposal.id)) {
    await putRecord(dataRoot, "runs", { ...run, proposalIds: [...run.proposalIds, proposal.id], updatedAtUnixMs: Date.now() });
  }
  return proposal;
}

export async function getProposal(dataRoot, id) {
  return getRecord(dataRoot, "proposals", id);
}

export async function listProposals(dataRoot, filters = {}) {
  const records = await listRecords(dataRoot, "proposals", (left, right) => right.createdAtUnixMs - left.createdAtUnixMs);
  return records.filter((item) => (!filters.runId || item.runId === filters.runId) && (!filters.status || item.status === filters.status));
}

export async function updateProposal(dataRoot, id, patch) {
  const current = await getProposal(dataRoot, id);
  if (patch.status) assertProposalTransition(current.status, patch.status);
  const next = { ...current, ...patch, id: current.id, schemaVersion: current.schemaVersion, updatedAtUnixMs: Date.now() };
  await putRecord(dataRoot, "proposals", next);
  return next;
}

export async function decideProposal(dataRoot, proposalId, input) {
  const proposal = await getProposal(dataRoot, proposalId);
  if (!["pending", "draft", "deferred", "approved"].includes(proposal.status)) throw new Error(`proposal cannot be decided from status ${proposal.status}`);
  const decision = input?.decision;
  if (!APPROVAL_DECISIONS.includes(decision)) throw new Error("invalid approval decision");
  const token = decision === "approved" ? randomBytes(32).toString("base64url") : null;
  const expiresAtUnixMs = decision === "approved"
    ? Date.now() + normalizeExpiry(input?.expiresInMs)
    : null;
  const approval = createApprovalRecord({
    proposal,
    decision,
    editedOperation: input?.editedOperation,
    expiresAtUnixMs,
    tokenHash: token ? sha256(token) : null,
  });
  await putRecord(dataRoot, "approvals", approval);
  const status = decision === "approved" ? "approved" : decision === "rejected" ? "rejected" : "deferred";
  assertProposalTransition(proposal.status, status);
  await putRecord(dataRoot, "proposals", {
    ...proposal,
    status,
    operation: approval.operation,
    operationHash: approval.operationHash,
    diff: input?.editedOperation === undefined ? proposal.diff : buildEditedOperationDiff(proposal.diff, approval.operation),
    latestApprovalId: approval.id,
    decidedAtUnixMs: approval.decidedAtUnixMs,
    updatedAtUnixMs: Date.now(),
  });
  return { approval: redactApproval(approval), token };
}

function buildEditedOperationDiff(previous, operation) {
  const before = previous?.before ?? null;
  let after = operation;
  if (["text.replace", "instructions.patch", "rules.patch"].includes(operation?.kind)) after = operation.content;
  else if (operation?.kind === "text.append") after = `${typeof before === "string" ? before.replace(/\s*$/, "") : ""}\n\n${operation.content || ""}`;
  return { format: "before_after", before, after, editedAfterApproval: true };
}

export async function consumeApproval(dataRoot, proposalId, token) {
  const proposal = await getProposal(dataRoot, proposalId);
  const approvals = await listRecords(dataRoot, "approvals", (left, right) => right.decidedAtUnixMs - left.decidedAtUnixMs);
  const approval = proposal.latestApprovalId
    ? approvals.find((item) => item.id === proposal.latestApprovalId && item.proposalId === proposalId && item.decision === "approved")
    : approvals.find((item) => item.proposalId === proposalId && item.decision === "approved");
  if (!approval) throw new Error("approved decision not found");
  const expectedBindingHash = hashObject({
    proposalId: proposal.id,
    target: proposal.target,
    expectedTargetHash: proposal.expectedTargetHash || null,
    operationHash: proposal.operationHash,
  });
  if (approval.bindingHash && approval.bindingHash !== expectedBindingHash) throw new Error("approval binding no longer matches proposal target and operation");
  if (approval.operationHash !== proposal.operationHash) throw new Error("approval operation no longer matches proposal");
  if (approval.consumedAtUnixMs) throw new Error("approval has already been consumed");
  if (approval.expiresAtUnixMs <= Date.now()) throw new Error("approval has expired");
  if (typeof token !== "string" || sha256(token) !== approval.tokenHash) throw new Error("invalid approval token");
  const consumed = { ...approval, consumedAtUnixMs: Date.now() };
  await putRecord(dataRoot, "approvals", consumed);
  return consumed;
}

export async function createChange(dataRoot, input) {
  const change = createChangeRecord(input);
  await putRecord(dataRoot, "changes", change);
  return change;
}

export async function updateChange(dataRoot, id, patch) {
  const current = await getRecord(dataRoot, "changes", id);
  const next = { ...current, ...patch, id: current.id, updatedAtUnixMs: Date.now() };
  await putRecord(dataRoot, "changes", next);
  return next;
}

export async function listChanges(dataRoot) {
  return listRecords(dataRoot, "changes", (left, right) => right.createdAtUnixMs - left.createdAtUnixMs);
}

export async function getChange(dataRoot, id) {
  return getRecord(dataRoot, "changes", id);
}

export async function createSnapshot(dataRoot, input) {
  const snapshot = createSnapshotRecord(input);
  await putRecord(dataRoot, "snapshots", snapshot);
  return snapshot;
}

export async function getSnapshot(dataRoot, id) {
  return getRecord(dataRoot, "snapshots", id);
}

export async function readAnalysisIndex(dataRoot, name = "trace-index") {
  await initializeAgentStore(dataRoot);
  const file = path.join(agentRoot(dataRoot), "analysis-index", `${safeId(name)}.json`);
  try {
    return await readJson(file);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function writeAnalysisIndex(dataRoot, name, value) {
  await initializeAgentStore(dataRoot);
  const file = path.join(agentRoot(dataRoot), "analysis-index", `${safeId(name)}.json`);
  await writeJsonAtomic(file, value);
  return value;
}

export function redactApproval(approval) {
  const { tokenHash, ...visible } = approval;
  return visible;
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}

async function putRecord(dataRoot, collection, value) {
  await initializeAgentStore(dataRoot);
  const file = recordFile(dataRoot, collection, value.id);
  await writeJsonAtomic(file, value);
}

async function getRecord(dataRoot, collection, id) {
  await initializeAgentStore(dataRoot);
  try {
    return await readJson(recordFile(dataRoot, collection, id));
  } catch (error) {
    if (error?.code === "ENOENT") {
      const missing = new Error(`${collection.slice(0, -1)} not found`);
      missing.code = "NOT_FOUND";
      throw missing;
    }
    throw error;
  }
}

async function listRecords(dataRoot, collection, compare) {
  await initializeAgentStore(dataRoot);
  const root = path.join(agentRoot(dataRoot), collection);
  const entries = await readdir(root, { withFileTypes: true });
  const values = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try {
      values.push(await readJson(path.join(root, entry.name)));
    } catch {
      // A concurrent atomic rename may briefly change the directory listing.
    }
  }
  return compare ? values.sort(compare) : values;
}

function recordFile(dataRoot, collection, id) {
  if (!COLLECTIONS.includes(collection)) throw new Error("unknown Agent collection");
  return path.join(agentRoot(dataRoot), collection, `${safeId(id)}.json`);
}

function safeId(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error("invalid Agent record id");
  return value;
}

function normalizeExpiry(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 60_000 || parsed > 7 * 86_400_000) return 24 * 60 * 60_000;
  return parsed;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function migrateV1Records(root) {
  for (const collection of COLLECTIONS) {
    const directory = path.join(root, collection);
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(directory, entry.name);
      const record = await readJson(file);
      if ((record.schemaVersion || 1) >= 2) continue;
      let next = { ...record, schemaVersion: 2 };
      if (collection === "runs") {
        const failedDuringMutation = record.state === "failed" && (
          ["applying", "verifying"].includes(record.progress?.phase)
          || (Array.isArray(record.proposalIds) && record.proposalIds.length > 0)
        );
        const analysisIncomplete = ["idle", "analyzing"].includes(record.state) || (record.state === "failed" && !failedDuringMutation);
        next = {
          ...next,
          baseCursor: record.baseCursor ?? (analysisIncomplete ? record.analysisCursor || null : null),
          analysisCursor: analysisIncomplete ? null : record.analysisCursor || null,
          scope: {
            lookbackDays: record.scope?.lookbackDays || 0,
            projects: record.scope?.projects || [],
            observedProjects: record.scope?.observedProjects || [],
            allowPayloads: record.scope?.allowPayloads !== false,
          },
          usage: record.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelCalls: 0 },
          budgets: { maxTokens: 200_000, ...record.budgets },
        };
      } else if (collection === "proposals") {
        next.harnessEvidence = record.harnessEvidence || {
          targetType: record.target?.type || null,
          targetId: record.target?.id || null,
          targetPath: record.target?.path || null,
          scope: record.target?.scope || null,
          hash: record.expectedTargetHash || null,
          observedAtUnixMs: record.createdAtUnixMs || migratedAt(record),
        };
      } else if (collection === "approvals") {
        const proposal = await readProposalForMigration(root, record.proposalId);
        if (proposal) {
          next.target = record.target || proposal.target;
          next.bindingHash = record.bindingHash || hashObject({
            proposalId: proposal.id,
            target: proposal.target,
            expectedTargetHash: proposal.expectedTargetHash || null,
            operationHash: record.operationHash,
          });
        }
      } else if (collection === "changes") {
        next.diff = record.diff || null;
      }
      await writeJsonAtomic(file, next);
    }
  }
}

async function readProposalForMigration(root, id) {
  if (!id) return null;
  try { return await readJson(path.join(root, "proposals", `${safeId(id)}.json`)); } catch { return null; }
}

function migratedAt(record) {
  return record.updatedAtUnixMs || record.createdAtUnixMs || Date.now();
}

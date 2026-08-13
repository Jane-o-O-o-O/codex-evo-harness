import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

import { runCodexCli } from "./codex-cli.mjs";
import { sha256 } from "./agent-schema.mjs";
import { createSnapshot, getSnapshot, writeJsonAtomic } from "./agent-store.mjs";
import { createHarnessSnapshot, inspectConfig, listInstructions, listRules, listSkills, readHarnessObject } from "./harness-tools.mjs";

const MAX_MUTATION_BYTES = 2_000_000;

export async function validateHarnessOperation(context, target, operation) {
  assertOperationMatchesTarget(target, operation);
  await resolveApprovedTarget(context, target, operation);
  return { valid: true };
}

export async function applyHarnessOperation(context, proposal, approval, hooks = {}) {
  if (approval.proposalId !== proposal.id) throw new Error("approval does not belong to proposal");
  if (approval.operationHash !== proposal.operationHash) throw new Error("approved operation no longer matches proposal");
  assertOperationMatchesTarget(proposal.target, approval.operation);
  const targetPath = await resolveApprovedTarget(context, proposal.target, approval.operation);
  const before = await readOptionalFile(targetPath);
  const beforeHash = before.exists ? (before.hash || sha256(before.content)) : null;
  let currentTargetHash = null;
  try { currentTargetHash = (await readHarnessObject(context, proposal.target)).hash || null; } catch { currentTargetHash = null; }
  if ((approval.expectedTargetHash || proposal.expectedTargetHash) !== currentTargetHash) {
    throw new Error("Harness target changed after the proposal was created; create a new proposal");
  }
  const snapshot = await createSnapshot(context.dataRoot, {
    target: proposal.target,
    exists: before.exists,
    contentBase64: before.exists ? before.content.toString("base64") : null,
    files: before.files || [],
    hash: beforeHash,
    byteLength: before.content.length,
  });
  if (hooks.onSnapshot) await hooks.onSnapshot({ snapshot, beforeHash, targetPath });
  const result = await executeOperation(context, proposal.target, approval.operation, targetPath, before);
  return { snapshot, beforeHash, ...result };
}

export async function rollbackHarnessChange(context, change) {
  if (!change.snapshotId) throw new Error("change has no rollback snapshot");
  const snapshot = await getSnapshot(context.dataRoot, change.snapshotId);
  const targetPath = await resolveApprovedTarget(context, snapshot.target, { kind: "rollback" });
  const current = await readOptionalFile(targetPath);
  if (change.afterHash && (!current.exists || (current.hash || sha256(current.content)) !== change.afterHash)) {
    throw new Error("Harness target changed after this change; refusing to overwrite newer edits");
  }
  if (isExternalOperation(change.operation)) {
    await executeExternalInverse(context, change.operation);
  }
  if (snapshot.exists) {
    if (snapshot.files?.length) {
      if (current.exists) await moveToTrash(context, targetPath, `rollback-current-${change.id}`);
      await mkdir(targetPath, { recursive: true });
      for (const file of snapshot.files) {
        await writeFileAtomic(safeDescendant(targetPath, file.path), Buffer.from(file.contentBase64, "base64"));
      }
    } else {
      await writeFileAtomic(targetPath, Buffer.from(snapshot.contentBase64 ?? "", "base64"));
    }
  } else if (current.exists) {
    await moveToTrash(context, targetPath, `rollback-${change.id}`);
  }
  const restored = await readOptionalFile(targetPath);
  return { afterHash: restored.exists ? (restored.hash || sha256(restored.content)) : null, restored: snapshot.exists };
}

export async function verifyHarnessChange(context, target, operation, expectedHash) {
  const targetPath = await resolveApprovedTarget(context, target, operation);
  const current = await readOptionalFile(targetPath);
  const actualHash = current.exists ? (current.hash || sha256(current.content)) : null;
  const checks = [{ name: "target_hash", ok: actualHash === expectedHash, detail: actualHash }];
  if (target.type === "skill") {
    const skills = await listSkills(context);
    const item = skills.find((value) => value.id === target.id || samePath(value.path, targetPath));
    const discovered = Boolean(item);
    checks.push({ name: "skill_discovery", ok: operationRemovesTarget(operation) ? !discovered : discovered });
    if (!operationRemovesTarget(operation)) checks.push({ name: "skill_integrity", ok: item?.validation?.valid === true, detail: item?.validation || null });
  } else if (["config", "mcp_server", "hooks", "plugin"].includes(target.type)) {
    const config = await inspectConfig(path.join(context.codexHome, "config.toml"), { redactSecrets: false });
    checks.push({ name: "config_readable", ok: config.exists });
    checks.push({ name: "config_valid", ok: config.valid, detail: config.warnings });
    if (target.type === "mcp_server") {
      const item = config.mcpServers.find((value) => value.id === target.id);
      const discovered = Boolean(item);
      checks.push({ name: "mcp_discovery", ok: operationRemovesTarget(operation) ? !discovered : discovered });
      if (operation.kind === "mcp.disable") checks.push({ name: "mcp_disabled", ok: item?.enabled === false });
      if (!operationRemovesTarget(operation) && operation.kind !== "mcp.disable") {
        checks.push(await verifyMcpConnection(context, target, operation, item));
      }
    }
    if (target.type === "plugin") {
      const item = config.plugins.find((value) => value.id === target.id);
      const discovered = Boolean(item);
      checks.push({ name: "plugin_discovery", ok: operationRemovesTarget(operation) ? !discovered : discovered });
      if (operation.kind === "plugin.disable") checks.push({ name: "plugin_disabled", ok: item?.enabled === false });
      if (operation.selector && !operationRemovesTarget(operation)) checks.push(await verifyPluginInstallation(context, operation.selector));
    }
    if (target.type === "hooks") {
      const item = config.hooks.find((value) => value.id === target.id || value.section === target.id);
      checks.push({ name: "hooks_discovery", ok: operationRemovesTarget(operation) ? !item : Boolean(item) });
      if (item) checks.push({ name: "hooks_syntax", ok: config.valid, detail: item.section });
    }
  } else if (["global_instructions", "project_instructions"].includes(target.type)) {
    const instructions = await listInstructions(context);
    const item = instructions.find((value) => samePath(value.path, targetPath));
    checks.push({ name: "instruction_discovery", ok: Boolean(item) });
    checks.push({ name: "instruction_precedence", ok: Boolean(item && Number.isInteger(item.effectiveOrder)), detail: item ? { effectiveOrder: item.effectiveOrder, override: item.override, project: item.project } : null });
  } else if (target.type === "rules") {
    const rules = await listRules(context);
    const item = rules.find((value) => samePath(value.path, targetPath));
    checks.push({ name: "rules_discovery", ok: Boolean(item) });
    if (item) checks.push({ name: "rules_syntax", ...await validateRuleFile(targetPath) });
  }
  try {
    const object = await readHarnessObject(context, target);
    if (target.type !== "config" && ["mcp_server", "hooks", "plugin"].includes(target.type)) {
      checks.push({ name: "target_object_readable", ok: operationRemovesTarget(operation) ? false : Boolean(object.hash), detail: object.hash || null });
    }
  } catch {
    if (["mcp_server", "hooks", "plugin"].includes(target.type) && operationRemovesTarget(operation)) checks.push({ name: "target_object_removed", ok: true });
  }
  return { status: checks.every((item) => item.ok) ? "passed" : "failed", checks, verifiedAtUnixMs: Date.now() };
}

async function verifyPluginInstallation(context, selector) {
  try {
    const result = await runCodex(context, ["plugin", "list", "--available", "--json"]);
    const payload = JSON.parse(result.stdout || "{}");
    const installed = Array.isArray(payload.installed) ? payload.installed : [];
    const item = installed.find((value) => value.pluginId === selector);
    return { name: "plugin_installation", ok: Boolean(item?.installed), detail: item ? { pluginId: item.pluginId, version: item.version || null, enabled: item.enabled !== false } : null };
  } catch (error) {
    return { name: "plugin_installation", ok: false, detail: String(error?.message || error).slice(0, 600) };
  }
}

async function verifyMcpConnection(context, target, operation, item) {
  try {
    if (operation.cli === true) {
      const result = await runCodex(context, ["mcp", "get", validateIdentifier(operation.name || target.id), "--json"]);
      JSON.parse(result.stdout || "{}");
      const probe = mcpProbeFromOperation(operation, item);
      if (probe.url) await probeMcpHttp(probe, context.fetchImpl || globalThis.fetch);
      else if (probe.command) await probeMcpStdio(probe);
      else throw new Error("MCP connection verification requires a URL or stdio command");
      return { name: "mcp_connection", ok: true, detail: probe.url ? "HTTP initialize succeeded" : "stdio initialize succeeded" };
    }
    if (operation.probe?.url) {
      await probeMcpHttp(operation.probe, context.fetchImpl || globalThis.fetch);
      return { name: "mcp_connection", ok: true, detail: "HTTP initialize succeeded" };
    }
    if (operation.probe?.command) {
      await probeMcpStdio(operation.probe);
      return { name: "mcp_connection", ok: true, detail: "stdio initialize succeeded" };
    }
    const probe = mcpProbeFromOperation(operation, item);
    if (probe.url) await probeMcpHttp(probe, context.fetchImpl || globalThis.fetch);
    else if (probe.command) await probeMcpStdio(probe);
    else throw new Error("MCP connection verification requires a URL or stdio command");
    return { name: "mcp_connection", ok: true, detail: probe.url ? "HTTP initialize succeeded" : "stdio initialize succeeded" };
  } catch (error) {
    return { name: "mcp_connection", ok: false, detail: String(error?.message || error).slice(0, 600) };
  }
}

function mcpProbeFromOperation(operation, item) {
  if (operation.probe) return operation.probe;
  if (operation.url || operation.command) return operation;
  if (item?.url) return { url: item.url, bearerTokenEnvVar: operation.bearerTokenEnvVar };
  if (item?.command) {
    const command = Array.isArray(item.command) ? item.command : [String(item.command), ...(Array.isArray(item.args) ? item.args : [])];
    return { command, env: item.env && typeof item.env === "object" ? item.env : {} };
  }
  return {};
}

async function probeMcpHttp(operation, fetchImpl) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable for MCP verification");
  const url = new URL(operation.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP URL must use http or https");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    if (operation.bearerTokenEnvVar && process.env[operation.bearerTokenEnvVar]) headers.authorization = `Bearer ${process.env[operation.bearerTokenEnvVar]}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex-insights-verifier", version: "1" } } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`MCP HTTP initialize returned ${response.status}`);
    await response.body?.cancel?.();
  } finally {
    clearTimeout(timeout);
  }
}

async function probeMcpStdio(operation) {
  if (!Array.isArray(operation.command) || !operation.command.length) throw new Error("MCP stdio probe requires command array");
  const [executable, ...args] = operation.command.map(validateCommandArgument);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: operation.cwd || process.cwd(), windowsHide: true, shell: false, env: { ...process.env, ...(operation.env || {}) } });
    let output = "";
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => finish(new Error("MCP stdio initialize timed out")), 5_000);
    child.on("error", finish);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString("utf8");
      if (/"jsonrpc"\s*:\s*"2\.0"/.test(output) && /"id"\s*:\s*1/.test(output)) finish();
      if (output.length > 1_000_000) finish(new Error("MCP stdio response exceeded limit"));
    });
    child.on("close", (code) => { if (!settled) finish(new Error(`MCP stdio server exited before initialize response (${code})`)); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex-insights-verifier", version: "1" } } })}\n`);
  });
}

async function validateRuleFile(file) {
  try {
    const source = await readFile(file, "utf8");
    if (path.extname(file).toLowerCase() === ".json") JSON.parse(source);
    if (path.extname(file).toLowerCase() === ".toml") parseToml(source);
    if (!source.trim()) throw new Error("rule file is empty");
    return { ok: true, detail: "readable" };
  } catch (error) {
    return { ok: false, detail: String(error?.message || error).slice(0, 600) };
  }
}

async function executeOperation(context, target, operation, targetPath, before) {
  if (isExternalOperation(operation)) {
    const external = await executeExternalOperation(context, operation);
    const after = await readOptionalFile(targetPath);
    return { targetPath, afterHash: after.exists ? (after.hash || sha256(after.content)) : null, external };
  }
  if (["text.replace", "instructions.patch", "rules.patch"].includes(operation.kind)) {
    const content = requiredText(operation.content);
    await writeFileAtomic(targetPath, Buffer.from(content, "utf8"));
    return mutationResult(targetPath, content);
  }
  if (operation.kind === "text.append") {
    const content = `${before.exists ? before.content.toString("utf8").replace(/\s*$/, "") : ""}\n\n${requiredText(operation.content).trim()}\n`;
    await writeFileAtomic(targetPath, Buffer.from(content, "utf8"));
    return mutationResult(targetPath, content);
  }
  if (["skill.upsert_files", "skill.create", "skill.update"].includes(operation.kind)) {
    if (!Array.isArray(operation.files) || operation.files.length === 0) throw new Error("skill.upsert_files requires files");
    const skillRoot = targetPath;
    const changedFiles = [];
    for (const item of operation.files) {
      if (!item?.path || typeof item.content !== "string") throw new Error("skill file path and content are required");
      const file = safeDescendant(skillRoot, item.path);
      await writeFileAtomic(file, Buffer.from(item.content, "utf8"));
      changedFiles.push(item.path);
    }
    const manifest = path.join(skillRoot, "SKILL.md");
    const manifestState = await readOptionalFile(manifest);
    if (!manifestState.exists) throw new Error("skill mutation must include SKILL.md");
    return { targetPath, afterHash: await hashDirectory(skillRoot), changedFiles };
  }
  if (["skill.disable", "skill.remove"].includes(operation.kind)) {
    const destination = await moveToTrash(context, targetPath, `${target.type}-${target.id || path.basename(targetPath)}`);
    return { targetPath, afterHash: null, trashedAt: destination };
  }
  if (operation.kind === "config.patch") {
    const configPath = path.join(context.codexHome, "config.toml");
    const source = before.exists ? before.content.toString("utf8") : "";
    const next = patchTomlValues(source, operation.section || "", operation.updates);
    validateTomlDocument(next);
    await writeFileAtomic(configPath, Buffer.from(next, "utf8"));
    return mutationResult(configPath, next);
  }
  if (["mcp.disable", "plugin.disable"].includes(operation.kind)) {
    const configPath = path.join(context.codexHome, "config.toml");
    const source = before.exists ? before.content.toString("utf8") : "";
    const section = requiredSection(operation.section || target.section || sectionForTarget(target));
    const next = patchTomlValues(source, section, { enabled: false });
    validateTomlDocument(next);
    await writeFileAtomic(configPath, Buffer.from(next, "utf8"));
    return mutationResult(configPath, next);
  }
  if (["config.replace_section", "mcp.replace", "mcp.add", "mcp.update", "hooks.replace", "hooks.patch", "plugin.replace", "plugin.install", "plugin.update"].includes(operation.kind)) {
    const configPath = path.join(context.codexHome, "config.toml");
    const source = before.exists ? before.content.toString("utf8") : "";
    const section = requiredSection(operation.section || target.section || sectionForTarget(target));
    let content = operation.content;
    if (["plugin.install", "plugin.update"].includes(operation.kind)) content = mergeTomlAssignment(content || "", "enabled", operation.enabled !== false);
    const normalizedContent = requiredText(content).trim();
    const next = replaceTomlSection(source, section, normalizedContent);
    validateTomlDocument(next);
    await writeFileAtomic(configPath, Buffer.from(next, "utf8"));
    return mutationResult(configPath, next);
  }
  if (["config.remove_section", "mcp.remove", "hooks.remove", "plugin.remove", "plugin.uninstall"].includes(operation.kind)) {
    const configPath = path.join(context.codexHome, "config.toml");
    const source = before.exists ? before.content.toString("utf8") : "";
    const section = requiredSection(operation.section || target.section || sectionForTarget(target));
    const next = removeTomlSection(source, section);
    validateTomlDocument(next);
    await writeFileAtomic(configPath, Buffer.from(next, "utf8"));
    return mutationResult(configPath, next);
  }
  throw new Error(`unsupported approved Harness operation: ${operation.kind}`);
}

function isExternalOperation(operation) {
  return Boolean(operation && (
    (["plugin.install", "plugin.update", "plugin.uninstall"].includes(operation.kind) && operation.selector)
    || (["mcp.add", "mcp.remove", "mcp.update"].includes(operation.kind) && operation.cli === true)
  ));
}

function operationRemovesTarget(operation) {
  return ["skill.disable", "skill.remove", "mcp.remove", "hooks.remove", "plugin.remove", "plugin.uninstall"].includes(operation?.kind);
}

function assertOperationMatchesTarget(target, operation) {
  const allowed = {
    global_instructions: new Set(["text.replace", "text.append", "instructions.patch"]),
    project_instructions: new Set(["text.replace", "text.append", "instructions.patch"]),
    skill: new Set(["skill.upsert_files", "skill.create", "skill.update", "skill.disable", "skill.remove"]),
    mcp_server: new Set(["mcp.replace", "mcp.add", "mcp.update", "mcp.disable", "mcp.remove"]),
    config: new Set(["config.patch", "config.replace_section", "config.remove_section"]),
    rules: new Set(["text.replace", "text.append", "rules.patch"]),
    hooks: new Set(["hooks.replace", "hooks.patch", "hooks.remove"]),
    plugin: new Set(["plugin.replace", "plugin.install", "plugin.update", "plugin.disable", "plugin.remove", "plugin.uninstall"]),
  };
  if (!allowed[target.type]?.has(operation?.kind)) throw new Error(`operation ${operation?.kind || "<missing>"} is not allowed for Harness target ${target.type}`);
  if (target.type === "mcp_server" && operation.cli === true && target.id && operation.name !== target.id) {
    throw new Error("MCP operation name must match the approved target");
  }
  if (target.type === "mcp_server" && operation.cli === true && ["mcp.remove", "mcp.update"].includes(operation.kind) && !operation.previous) {
    throw new Error("external MCP remove/update requires previous configuration for rollback");
  }
  if (["mcp_server", "hooks", "plugin"].includes(target.type) && operation.section) {
    const approvedSection = target.section || sectionForTarget(target);
    if (requiredSection(operation.section) !== requiredSection(approvedSection)) throw new Error("operation section must match the approved target");
  }
  if (target.type === "plugin" && operation.selector && target.id && operation.selector !== target.id) {
    throw new Error("Plugin selector must match the approved target");
  }
}

async function executeExternalOperation(context, operation) {
  if (operation.kind === "plugin.install") return runCodex(context, ["plugin", "add", validateSelector(operation.selector), "--json"]);
  if (operation.kind === "plugin.update") {
    await runCodex(context, ["plugin", "remove", validateSelector(operation.selector), "--json"]);
    try {
      return await runCodex(context, ["plugin", "add", validateSelector(operation.selector), "--json"]);
    } catch (error) {
      try {
        await runCodex(context, ["plugin", "add", validateSelector(operation.selector), "--json"]);
      } catch (restoreError) {
        throw new Error(`plugin update failed and restoring the installed state also failed: ${error.message}; restore: ${restoreError.message}`);
      }
      throw new Error(`plugin update failed; the installed state was restored from the current marketplace snapshot: ${error.message}`);
    }
  }
  if (operation.kind === "plugin.uninstall") return runCodex(context, ["plugin", "remove", validateSelector(operation.selector), "--json"]);
  if (operation.kind === "mcp.add") return runCodex(context, mcpAddArguments(operation));
  if (operation.kind === "mcp.remove") return runCodex(context, ["mcp", "remove", validateIdentifier(operation.name)]);
  if (operation.kind === "mcp.update") {
    await runCodex(context, ["mcp", "remove", validateIdentifier(operation.name)]);
    try {
      return await runCodex(context, mcpAddArguments(operation));
    } catch (error) {
      if (!operation.previous) throw new Error(`MCP update failed after removal and cannot be restored without previous configuration: ${error.message}`);
      try {
        await runCodex(context, mcpAddArguments({ ...operation.previous, name: operation.name }));
      } catch (restoreError) {
        throw new Error(`MCP update failed and restoring the previous configuration also failed: ${error.message}; restore: ${restoreError.message}`);
      }
      throw new Error(`MCP update failed; the previous configuration was restored: ${error.message}`);
    }
  }
  throw new Error(`unsupported external Harness operation: ${operation.kind}`);
}

async function executeExternalInverse(context, operation) {
  if (operation.kind === "plugin.install") return runCodex(context, ["plugin", "remove", validateSelector(operation.selector), "--json"]);
  if (operation.kind === "plugin.update") {
    await runCodex(context, ["plugin", "remove", validateSelector(operation.selector), "--json"]);
    return runCodex(context, ["plugin", "add", validateSelector(operation.selector), "--json"]);
  }
  if (operation.kind === "plugin.uninstall") return runCodex(context, ["plugin", "add", validateSelector(operation.selector), "--json"]);
  if (operation.kind === "mcp.add") return runCodex(context, ["mcp", "remove", validateIdentifier(operation.name)]);
  if (operation.kind === "mcp.remove") {
    if (!operation.previous) throw new Error("MCP remove rollback requires the previous structured configuration");
    return runCodex(context, mcpAddArguments({ ...operation.previous, name: operation.name }));
  }
  if (operation.kind === "mcp.update") {
    if (!operation.previous) throw new Error("MCP update rollback requires the previous structured configuration");
    await runCodex(context, ["mcp", "remove", validateIdentifier(operation.name)]);
    return runCodex(context, mcpAddArguments({ ...operation.previous, name: operation.name }));
  }
}

function mcpAddArguments(operation) {
  const args = ["mcp", "add", validateIdentifier(operation.name)];
  for (const [key, value] of Object.entries(operation.env || {})) args.push("--env", `${validateEnvKey(key)}=${String(value)}`);
  if (operation.url) {
    const url = new URL(operation.url);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("MCP URL must use http or https");
    args.push("--url", url.toString());
    if (operation.bearerTokenEnvVar) args.push("--bearer-token-env-var", validateEnvKey(operation.bearerTokenEnvVar));
  } else {
    if (!Array.isArray(operation.command) || operation.command.length === 0) throw new Error("MCP stdio command must be a non-empty array");
    args.push("--", ...operation.command.map(validateCommandArgument));
  }
  return args;
}

async function runCodex(context, args) {
  return runCodexCli(context, args);
}

function validateSelector(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+$/.test(value)) throw new Error("plugin selector must use plugin@marketplace");
  return value;
}

function validateIdentifier(value) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error("invalid Harness identifier");
  return value;
}

function validateEnvKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("invalid environment variable name");
  return value;
}

function validateCommandArgument(value) {
  if (typeof value !== "string" || value.includes("\0") || value.length > 8_192) throw new Error("invalid MCP command argument");
  return value;
}

function patchTomlValues(source, section, updates) {
  if (!updates || typeof updates !== "object" || Array.isArray(updates) || Object.keys(updates).length === 0) throw new Error("config.patch requires a non-empty updates object");
  let range;
  if (section) {
    range = tomlSectionRange(source, requiredSection(section));
    if (!range) throw new Error(`TOML section not found: ${section}`);
  } else {
    const firstSection = source.search(/^\s*\[/m);
    range = { start: 0, end: firstSection < 0 ? source.length : firstSection };
  }
  let block = source.slice(range.start, range.end);
  for (const [key, value] of Object.entries(updates)) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) throw new Error(`invalid TOML key: ${key}`);
    const expression = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`, "gm");
    const matches = [...block.matchAll(expression)];
    if (matches.length > 1) throw new Error(`cannot patch duplicate TOML key without normalization: ${key}`);
    const line = `${key} = ${tomlValue(value)}`;
    if (matches.length === 1) {
      const lineStart = matches[0].index;
      const lineEndIndex = block.indexOf("\n", lineStart);
      const lineEnd = lineEndIndex < 0 ? block.length : lineEndIndex;
      block = `${block.slice(0, lineStart)}${line}${block.slice(lineEnd)}`;
    } else {
      block = `${block.replace(/\s*$/, "")}\n${line}\n`;
    }
  }
  return `${source.slice(0, range.start)}${block}${source.slice(range.end)}`;
}

function validateTomlDocument(source) {
  try {
    parseToml(normalizeDuplicateTopLevelKeysForValidation(source || ""));
  } catch (error) {
    throw new Error(`TOML validation failed: ${String(error?.message || error).slice(0, 600)}`);
  }
}

function normalizeDuplicateTopLevelKeysForValidation(source) {
  const lines = source.split(/\r?\n/);
  const counts = new Map();
  let inSection = false;
  for (const line of lines) {
    if (/^\s*\[/.test(line)) inSection = true;
    if (inSection) continue;
    const match = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=/);
    if (match) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  const seen = new Map();
  inSection = false;
  return lines.map((line) => {
    if (/^\s*\[/.test(line)) inSection = true;
    if (inSection) return line;
    const match = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=/);
    if (!match || (counts.get(match[1]) || 0) < 2) return line;
    const count = (seen.get(match[1]) || 0) + 1;
    seen.set(match[1], count);
    return count < counts.get(match[1]) ? `# duplicate preserved: ${line}` : line;
  }).join("\n");
}

function mergeTomlAssignment(source, key, value) {
  const normalized = String(source || "").trim();
  const expression = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=.*$`, "m");
  const assignment = `${key} = ${tomlValue(value)}`;
  return expression.test(normalized) ? normalized.replace(expression, assignment) : `${normalized}${normalized ? "\n" : ""}${assignment}`;
}

function tomlValue(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(", ")}]`;
  if (value === null) throw new Error("TOML values cannot be null");
  return JSON.stringify(String(value));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function resolveApprovedTarget(context, target, operation) {
  const codexHome = path.resolve(context.codexHome);
  if (target.type === "global_instructions") {
    const allowed = [path.join(codexHome, "AGENTS.md"), path.join(codexHome, "AGENTS.override.md")];
    return requireAllowedPath(target.path, allowed);
  }
  if (target.type === "project_instructions") {
    const project = requireProject(context.projects, target.project || path.dirname(target.path));
    const resolved = path.resolve(target.path);
    const discovered = await listInstructions({ ...context, projects: [project] });
    const standardName = ["AGENTS.md", "AGENTS.override.md"].includes(path.basename(resolved));
    const discoveredFallback = discovered.some((item) => item.scope === "project" && item.fallback && samePath(item.path, resolved));
    if (!isDescendant(project, resolved) || (!standardName && !discoveredFallback)) throw new Error("invalid project instruction target");
    return resolved;
  }
  if (target.type === "skill") {
    const allowedRoots = [path.join(path.dirname(codexHome), ".agents", "skills"), path.join(codexHome, "skills"), ...context.projects.map((item) => path.join(item, ".agents", "skills"))];
    const resolved = path.resolve(target.path);
    if (!allowedRoots.some((root) => isDescendant(root, resolved))) throw new Error("skill target is outside allowed roots");
    return resolved;
  }
  if (["config", "mcp_server", "hooks", "plugin"].includes(target.type)) return requireAllowedPath(target.path, [path.join(codexHome, "config.toml")]);
  if (target.type === "rules") {
    const allowedRoots = [path.join(codexHome, "rules"), ...context.projects.map((item) => path.join(item, ".codex", "rules"))];
    const resolved = path.resolve(target.path);
    if (!allowedRoots.some((root) => isDescendant(root, resolved))) throw new Error("rules target is outside allowed roots");
    return resolved;
  }
  if (operation.kind === "rollback") return path.resolve(target.path);
  throw new Error(`unsupported Harness target: ${target.type}`);
}

function replaceTomlSection(source, section, content) {
  const range = tomlSectionRange(source, section);
  const block = content.startsWith("[") ? content : `[${section}]\n${content}`;
  if (!range) return `${source.replace(/\s*$/, "")}\n\n${block.trim()}\n`;
  return `${source.slice(0, range.start)}${block.trim()}\n${source.slice(range.end).replace(/^\s*/, "\n")}`;
}

function removeTomlSection(source, section) {
  const range = tomlSectionRange(source, section);
  if (!range) throw new Error(`TOML section not found: ${section}`);
  return `${source.slice(0, range.start).replace(/\s*$/, "")}${source.slice(range.end).replace(/^\s*/, "\n")}`.trimEnd() + "\n";
}

function tomlSectionRange(source, section) {
  const lines = source.split(/(?<=\n)/);
  let offset = 0;
  let start = -1;
  for (const line of lines) {
    const match = line.match(/^\s*\[([^\]]+)\]/);
    if (start >= 0 && match) return { start, end: offset };
    if (match && match[1].trim() === section) start = offset;
    offset += line.length;
  }
  return start >= 0 ? { start, end: source.length } : null;
}

async function moveToTrash(context, targetPath, label) {
  const root = path.join(context.dataRoot, "agent", "trash", `${Date.now()}-${sanitize(label)}`);
  await mkdir(path.dirname(root), { recursive: true });
  await rename(targetPath, root);
  await writeJsonAtomic(`${root}.metadata.json`, { originalPath: targetPath, movedAtUnixMs: Date.now() });
  return root;
}

async function readOptionalFile(file) {
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      const files = await snapshotDirectory(file);
      const hash = hashSnapshotFiles(files);
      return { exists: true, content: Buffer.from(hash), files, directory: true, hash };
    }
    if (info.size > MAX_MUTATION_BYTES) throw new Error(`Harness target exceeds ${MAX_MUTATION_BYTES} bytes`);
    return { exists: true, content: await readFile(file), directory: false };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, content: Buffer.alloc(0), directory: false };
    throw error;
  }
}

async function hashDirectory(root) {
  return hashSnapshotFiles(await snapshotDirectory(root));
}

async function snapshotDirectory(root) {
  const files = [];
  let totalBytes = 0;
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = await readFile(file);
      totalBytes += content.length;
      if (totalBytes > MAX_MUTATION_BYTES) throw new Error(`Harness directory snapshot exceeds ${MAX_MUTATION_BYTES} bytes`);
      files.push({
        path: path.relative(root, file).replaceAll("\\", "/"),
        contentBase64: content.toString("base64"),
        hash: sha256(content),
        byteLength: content.length,
      });
    }
  }
  await visit(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function hashSnapshotFiles(files) {
  return sha256(files.map((item) => `${item.path}\0${item.hash}`).join("\n"));
}

async function writeFileAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, file);
}

function mutationResult(targetPath, content) {
  return { targetPath, afterHash: sha256(content), byteLength: Buffer.byteLength(content, "utf8") };
}

function sectionForTarget(target) {
  if (target.type === "mcp_server") return `mcp_servers.${quoteTomlKey(target.id)}`;
  if (target.type === "plugin") return `plugins.${quoteTomlKey(target.id)}`;
  if (target.type === "hooks") return target.id || "hooks";
  if (target.type === "config") return target.id;
  return null;
}

function quoteTomlKey(value) {
  return /^[a-zA-Z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function requiredSection(value) {
  if (typeof value !== "string" || !value.trim() || /[\r\n\[\]]/.test(value)) throw new Error("valid TOML section is required");
  return value.trim();
}

function requiredText(value) {
  if (typeof value !== "string") throw new Error("operation content must be a string");
  if (Buffer.byteLength(value, "utf8") > MAX_MUTATION_BYTES) throw new Error("operation content is too large");
  return value;
}

function requireProject(projects, candidate) {
  const resolved = path.resolve(candidate);
  const project = projects.map((item) => path.resolve(item)).find((item) => samePath(item, resolved) || isDescendant(item, resolved));
  if (!project) throw new Error("project target is outside the observed project set");
  return project;
}

function requireAllowedPath(candidate, allowed) {
  const resolved = path.resolve(candidate);
  if (!allowed.some((item) => samePath(item, resolved))) throw new Error("Harness target path is not allowed");
  return resolved;
}

function safeDescendant(root, child) {
  const resolved = path.resolve(root, child);
  if (!isDescendant(root, resolved)) throw new Error("path escapes allowed root");
  return resolved;
}

function isDescendant(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

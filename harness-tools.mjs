import { createHash } from "node:crypto";
import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { runCodexCli } from "./codex-cli.mjs";

const MAX_TEXT_BYTES = 2_000_000;
const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization|cookie|credential)/i;

export async function createHarnessSnapshot(context) {
  const { codexHome, projects = [] } = context;
  const configPath = path.join(codexHome, "config.toml");
  const [instructions, skills, config, rules] = await Promise.all([
    listInstructions({ codexHome, projects }),
    listSkills({ codexHome, projects }),
    inspectConfig(configPath),
    listRules({ codexHome, projects }),
  ]);
  const pluginInspection = await inspectInstalledPlugins(context, config.plugins);
  return {
    schemaVersion: 1,
    generatedAtUnixMs: Date.now(),
    codexHome,
    projects: [...new Set(projects.filter(Boolean).map((item) => path.resolve(item)))],
    instructions,
    skills,
    config,
    mcpServers: config.mcpServers,
    hooks: config.hooks,
    plugins: pluginInspection.plugins,
    pluginInspection: { status: pluginInspection.status, error: pluginInspection.error || null },
    rules,
  };
}

export async function listPlugins(context) {
  const config = await inspectConfig(path.join(context.codexHome, "config.toml"));
  return (await inspectInstalledPlugins(context, config.plugins)).plugins;
}

export async function listInstructions({ codexHome, projects = [] }) {
  const output = [];
  const config = await inspectConfig(path.join(codexHome, "config.toml"));
  const fallbackNames = Array.isArray(config.structure?.project_doc_fallback_filenames)
    ? config.structure.project_doc_fallback_filenames.filter(validInstructionFilename)
    : [];
  const projectDocMaxBytes = boundedPositiveInteger(config.structure?.project_doc_max_bytes, 32 * 1_024);
  const globalCandidates = [path.join(codexHome, "AGENTS.override.md"), path.join(codexHome, "AGENTS.md")];
  for (const file of globalCandidates) {
    if (await isNonEmptyFile(file)) {
      output.push(await describeTextObject(file, "global_instructions", "global", null, path.basename(file).includes("override")));
      break;
    }
  }
  for (const project of [...new Set(projects.filter(Boolean).map((item) => path.resolve(item)))]) {
    let remainingBytes = projectDocMaxBytes;
    for (const file of await projectInstructionChain(project, fallbackNames)) {
      if (remainingBytes <= 0) break;
      const item = await describeTextObject(file.path, "project_instructions", "project", project, file.override);
      const includedBytes = Math.min(item.byteLength, remainingBytes);
      output.push({ ...item, fallback: file.fallback, includedBytes, truncated: includedBytes < item.byteLength });
      remainingBytes -= includedBytes;
    }
  }
  return output.map((item, index) => ({
    ...item,
    precedence: index,
    effectiveOrder: index + 1,
    effective: true,
    sourceKind: item.override ? "override" : item.fallback ? "fallback" : "agents",
  }));
}

export async function readInstruction({ codexHome, projects = [] }, targetPath) {
  const allowed = (await listInstructions({ codexHome, projects })).find((item) => samePath(item.path, targetPath));
  if (!allowed) throw new Error("instruction file is outside the discovered Harness scope");
  const result = await readTextObject(allowed.path, allowed);
  if (allowed.includedBytes === undefined || allowed.includedBytes >= result.byteLength) return result;
  return { ...result, content: truncateUtf8(result.content, allowed.includedBytes), effectiveByteLength: allowed.includedBytes, truncated: true };
}

export async function listSkills({ codexHome, projects = [] }) {
  const config = await inspectConfig(path.join(codexHome, "config.toml"));
  const roots = [
    { root: path.join(path.dirname(codexHome), ".agents", "skills"), scope: "global", project: null },
    { root: path.join(codexHome, "skills"), scope: "global", project: null },
    ...projects.filter(Boolean).map((project) => ({ root: path.join(path.resolve(project), ".agents", "skills"), scope: "project", project: path.resolve(project) })),
    ...await pluginSkillRoots(codexHome, config.plugins),
  ];
  const output = [];
  const seen = new Set();
  for (const descriptor of roots) {
    for (const skillFile of await walkNamedFiles(descriptor.root, "SKILL.md", 3_000)) {
      const skillDir = path.dirname(skillFile);
      const key = path.resolve(skillDir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const source = await boundedText(skillFile);
      const metadata = parseSkillMetadata(source);
      const references = extractSkillReferences(source);
      const files = await listSkillFiles(skillDir, references);
      const referenceState = await resolveSkillReferences(skillDir, descriptor.pluginRoot, references, files);
      const name = metadata.name || path.basename(skillDir);
      output.push({
        type: "skill",
        id: descriptor.pluginId ? `${descriptor.pluginId}:${name}` : name,
        name,
        description: metadata.description || "",
        scope: descriptor.scope,
        project: descriptor.project,
        source: descriptor.pluginId ? "plugin" : descriptor.scope,
        readOnly: Boolean(descriptor.pluginId),
        pluginId: descriptor.pluginId || null,
        pluginVersion: descriptor.pluginVersion || null,
        path: skillDir,
        manifestPath: skillFile,
        hash: await hashSkill(skillDir, files, descriptor.pluginRoot, referenceState.sharedFiles),
        files,
        sharedFiles: referenceState.sharedFiles,
        validation: validateSkillDescriptor(metadata, files, source, references, referenceState),
      });
    }
  }
  return output.sort((left, right) => `${left.scope}:${left.id}`.localeCompare(`${right.scope}:${right.id}`));
}

export async function readSkill(context, idOrPath) {
  const skill = (await listSkills(context)).find((item) => item.id === idOrPath || samePath(item.path, idOrPath));
  if (!skill) throw new Error("skill is outside the discovered Harness scope");
  const files = [];
  for (const relative of skill.files) {
    const file = safeDescendant(skill.path, relative);
    const info = await stat(file);
    if (info.size > MAX_TEXT_BYTES) {
      files.push({ path: relative, byteLength: info.size, content: null, omitted: "file too large" });
      continue;
    }
    files.push({ path: relative, byteLength: info.size, content: redactText(await readFile(file, "utf8")) });
  }
  for (const relative of skill.sharedFiles || []) {
    const pluginRoot = path.dirname(path.dirname(skill.path));
    const file = safeDescendant(pluginRoot, relative);
    const info = await stat(file);
    files.push({ path: relative, origin: "plugin_root", byteLength: info.size, content: info.size > MAX_TEXT_BYTES ? null : redactText(await readFile(file, "utf8")), omitted: info.size > MAX_TEXT_BYTES ? "file too large" : undefined });
  }
  return { ...skill, files };
}

export async function inspectConfig(configPath, { redactSecrets = true } = {}) {
  let source = "";
  try {
    source = await boundedText(configPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const sections = parseTomlSections(source);
  const normalizedForParser = normalizeDuplicateTopLevelKeys(source);
  let parsedStructure = {};
  try { parsedStructure = parseToml(normalizedForParser); } catch { parsedStructure = {}; }
  const structure = redactSecrets ? redactStructuredValue(parsedStructure) : parsedStructure;
  const mcpServers = [];
  const plugins = [];
  const hooks = [];
  for (const section of sections) {
    const mcp = section.name.match(/^mcp_servers\.([^\.]+)(?:\.|$)/);
    if (mcp && !mcpServers.some((item) => item.id === unquoteTomlKey(mcp[1]))) {
      const root = sections.find((item) => item.name === `mcp_servers.${mcp[1]}`) || section;
      const id = unquoteTomlKey(mcp[1]);
      const parsed = structure.mcp_servers?.[id] || {};
      mcpServers.push({
        type: "mcp_server",
        id,
        scope: "global",
        path: configPath,
        section: root.name,
        enabled: parsed.enabled !== false && root.values.enabled !== false,
        command: visibleValue(parsed.command ?? root.values.command),
        args: visibleValue(parsed.args ?? root.values.args),
        env: redactSecrets ? redactStructuredValue(parsed.env ?? root.values.env ?? {}) : (parsed.env ?? root.values.env ?? {}),
        url: visibleValue(parsed.url ?? root.values.url),
        hash: sha256(root.raw),
      });
    }
    const plugin = section.name.match(/^plugins\.(.+)$/);
    if (plugin) plugins.push({
      type: "plugin",
      id: unquoteTomlKey(plugin[1]),
      scope: "global",
      path: configPath,
      section: section.name,
      enabled: section.values.enabled !== false,
      hash: sha256(section.raw),
    });
    if (/^hooks(?:\.|$)/.test(section.name)) hooks.push({
      type: "hooks",
      id: section.name,
      scope: "global",
      path: configPath,
      section: section.name,
      hash: sha256(section.raw),
    });
  }
  const duplicates = duplicateTopLevelKeys(source);
  const syntaxErrors = validateTomlSyntax(source);
  return {
    type: "config",
    id: "config.toml",
    scope: "global",
    path: configPath,
    exists: Boolean(source),
    byteLength: Buffer.byteLength(source, "utf8"),
    hash: sha256(source),
    parseMode: "lossless-sections",
    structure,
    warnings: [
      ...(duplicates.length ? [`重复的顶层键：${duplicates.join(", ")}`] : []),
      ...syntaxErrors,
    ],
    duplicateTopLevelKeys: duplicates,
    syntaxErrors,
    valid: syntaxErrors.length === 0,
    source: redactToml(source),
    mcpServers,
    plugins,
    hooks,
  };
}

export async function listRules({ codexHome, projects = [] }) {
  const roots = [
    { root: path.join(codexHome, "rules"), scope: "global", project: null },
    ...projects.filter(Boolean).map((project) => ({ root: path.join(path.resolve(project), ".codex", "rules"), scope: "project", project: path.resolve(project) })),
  ];
  const output = [];
  for (const descriptor of roots) {
    for (const file of await walkExtensions(descriptor.root, new Set([".rules", ".json", ".toml"]), 1_000)) {
      const source = await boundedText(file);
      output.push({
        type: "rules",
        id: path.relative(descriptor.root, file).replaceAll("\\", "/"),
        scope: descriptor.scope,
        project: descriptor.project,
        path: file,
        hash: sha256(source),
        byteLength: Buffer.byteLength(source, "utf8"),
      });
    }
  }
  return output;
}

export async function readHarnessObject(context, target) {
  if (target.type === "global_instructions" || target.type === "project_instructions") return readInstruction(context, target.path);
  if (target.type === "skill") return readSkill(context, target.id || target.path);
  if (["config", "mcp_server", "hooks", "plugin"].includes(target.type)) {
    const config = await inspectConfig(path.join(context.codexHome, "config.toml"));
    if (target.type === "config") return config;
    const collection = target.type === "mcp_server" ? config.mcpServers : target.type === "hooks" ? config.hooks : config.plugins;
    const item = collection.find((value) => value.id === target.id || value.section === target.id);
    if (!item) throw new Error(`${target.type} not found`);
    return item;
  }
  if (target.type === "rules") {
    const item = (await listRules(context)).find((value) => value.id === target.id || samePath(value.path, target.path));
    if (!item) throw new Error("rules object not found");
    return readTextObject(item.path, item);
  }
  throw new Error(`unsupported Harness object type: ${target.type}`);
}

async function inspectInstalledPlugins(context, configuredPlugins) {
  if (!context.runCodexCommand && !context.codex) return { status: "not_checked", plugins: configuredPlugins };
  try {
    const result = await runCodexCli(context, ["plugin", "list", "--available", "--json"], { timeoutMs: 30_000 });
    const payload = JSON.parse(result.stdout || "{}");
    const installed = Array.isArray(payload.installed) ? payload.installed : [];
    const byId = new Map(installed.map((item) => [item.pluginId, item]));
    const configuredById = new Map(configuredPlugins.map((item) => [item.id, item]));
    const ids = [...new Set([...configuredById.keys(), ...byId.keys()])];
    return {
      status: "checked",
      plugins: ids.map((id) => {
        const configured = configuredById.get(id);
        const runtime = byId.get(id);
        return {
          ...(configured || { type: "plugin", id, scope: "global", path: path.join(context.codexHome, "config.toml"), section: null, hash: null }),
          enabled: configured ? configured.enabled !== false : runtime?.enabled !== false,
          installed: runtime?.installed === true,
          version: runtime?.version || null,
          marketplaceName: runtime?.marketplaceName || id.split("@").at(-1) || null,
          source: runtime?.source ? redactStructuredValue(runtime.source) : null,
          installPolicy: runtime?.installPolicy || null,
          authPolicy: runtime?.authPolicy || null,
        };
      }).sort((left, right) => left.id.localeCompare(right.id)),
    };
  } catch (error) {
    return { status: "failed", error: String(error?.message || error).slice(0, 600), plugins: configuredPlugins };
  }
}

async function projectInstructionChain(project, fallbackNames = []) {
  const resolvedProject = path.resolve(project);
  const root = await findProjectRoot(resolvedProject);
  const directories = [];
  let current = root;
  while (true) {
    directories.push(current);
    if (samePath(current, resolvedProject)) break;
    const relative = path.relative(current, resolvedProject).split(path.sep).filter(Boolean);
    if (!relative.length) break;
    current = path.join(current, relative[0]);
  }
  const output = [];
  for (const directory of directories) {
    const override = path.join(directory, "AGENTS.override.md");
    const normal = path.join(directory, "AGENTS.md");
    if (await isNonEmptyFile(override)) output.push({ path: override, override: true });
    else if (await isNonEmptyFile(normal)) output.push({ path: normal, override: false });
    else {
      for (const name of fallbackNames) {
        const fallback = path.join(directory, name);
        if (!await isNonEmptyFile(fallback)) continue;
        output.push({ path: fallback, override: false, fallback: true });
        break;
      }
    }
  }
  return output;
}

function validInstructionFilename(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 255 && path.basename(value) === value && !/[\\/\0]/.test(value);
}

function boundedPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TEXT_BYTES ? parsed : fallback;
}

async function findProjectRoot(project) {
  let current = project;
  while (true) {
    if (await exists(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return project;
    current = parent;
  }
}

async function describeTextObject(file, type, scope, project, override) {
  const source = await boundedText(file);
  return {
    type,
    id: `${scope}:${file}`,
    scope,
    project,
    path: file,
    override,
    hash: sha256(source),
    byteLength: Buffer.byteLength(source, "utf8"),
  };
}

async function readTextObject(file, metadata = {}) {
  const source = await boundedText(file);
  return { ...metadata, path: file, hash: sha256(source), byteLength: Buffer.byteLength(source, "utf8"), content: redactText(source) };
}

async function boundedText(file) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error("Harness object is not a file");
  if (info.size > MAX_TEXT_BYTES) throw new Error(`Harness file exceeds ${MAX_TEXT_BYTES} bytes`);
  return readFile(file, "utf8");
}

function parseSkillMetadata(source) {
  const match = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!item) continue;
    metadata[item[1]] = item[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return metadata;
}

function validateSkillDescriptor(metadata, files, source, references = extractSkillReferences(source), referenceState = {}) {
  const errors = [];
  if (!metadata.name) errors.push("SKILL.md frontmatter 缺少 name");
  if (!metadata.description) errors.push("SKILL.md frontmatter 缺少 description");
  if (metadata.name && !/^[a-zA-Z0-9._-]+$/.test(metadata.name)) errors.push("Skill name 包含不支持的字符");
  const missingReferences = referenceState.missingReferences || references.filter((reference) => !files.includes(reference));
  if (missingReferences.length) errors.push(`缺少引用文件：${missingReferences.join(", ")}`);
  const skillFile = files.includes("SKILL.md") ? "SKILL.md" : null;
  return { valid: errors.length === 0 && Boolean(skillFile), errors, references, resolvedReferences: referenceState.resolvedReferences || [], missingReferences };
}

async function pluginSkillRoots(codexHome, plugins) {
  const cacheRoot = path.join(codexHome, "plugins", "cache");
  const output = [];
  for (const plugin of plugins.filter((item) => item.id && item.enabled !== false)) {
    const separator = plugin.id.lastIndexOf("@");
    if (separator <= 0 || separator === plugin.id.length - 1) continue;
    const name = plugin.id.slice(0, separator);
    const marketplace = plugin.id.slice(separator + 1);
    const pluginRoot = path.join(cacheRoot, marketplace, name);
    const version = await latestPluginCacheVersion(pluginRoot);
    if (!version) continue;
    const skillsRoot = path.join(pluginRoot, version, "skills");
    if (!await exists(skillsRoot)) continue;
    output.push({ root: skillsRoot, scope: "global", project: null, pluginId: plugin.id, pluginVersion: version, pluginRoot: path.join(pluginRoot, version) });
  }
  return output;
}

async function latestPluginCacheVersion(pluginRoot) {
  let entries;
  try {
    entries = await readdir(pluginRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((entry) => entry.isDirectory() && entry.name !== "latest" && !entry.name.startsWith("plugin-backup-"))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true, sensitivity: "base" }));
  return versions[0] || (entries.some((entry) => entry.isDirectory() && entry.name === "latest") ? "latest" : null);
}

function extractSkillReferences(source) {
  const references = new Set();
  const patterns = [
    /\[[^\]]*\]\((?!https?:|mailto:|#)([^)]+)\)/g,
    /(?:^|[\s`'"(])((?:references|scripts|assets)\/[a-zA-Z0-9._\-/]+)(?=$|[\s`'"),])/gm,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const value = String(match[1] || "").split("#")[0].replace(/^\.\//, "").replaceAll("\\", "/");
      if (value && !/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.includes("..")) references.add(value);
    }
  }
  return [...references].sort();
}

function validateTomlSyntax(source) {
  const errors = [];
  try {
    parseToml(normalizeDuplicateTopLevelKeys(source || ""));
  } catch (error) {
    errors.push(`TOML parser: ${String(error?.message || error).slice(0, 500)}`);
  }
  const seenSections = new Set();
  let lineNumber = 0;
  for (const line of source.split(/\r?\n/)) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const section = trimmed.match(/^\[([^\]]+)\](?:\s*#.*)?$/);
    if (section) {
      const name = section[1].trim();
      if (!name) errors.push(`第 ${lineNumber} 行 TOML section 为空`);
      if (seenSections.has(name)) errors.push(`重复的 TOML section：${name}`);
      seenSections.add(name);
      continue;
    }
    if (!/^[a-zA-Z0-9_.-]+\s*=/.test(trimmed)) errors.push(`第 ${lineNumber} 行不是可识别的 TOML 赋值`);
  }
  return errors;
}

function normalizeDuplicateTopLevelKeys(source) {
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

function redactStructuredValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[已隐藏]";
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item));
  if (!value || typeof value !== "object") return typeof value === "string" ? redactText(value) : value;
  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) output[childKey] = redactStructuredValue(childValue, childKey);
  return output;
}

function parseTomlSections(source) {
  const sections = [];
  let current = { name: "", lines: [], values: {} };
  const flush = () => {
    current.raw = current.lines.join("\n");
    sections.push(current);
  };
  for (const line of source.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (section) {
      flush();
      current = { name: section[1].trim(), lines: [line], values: {} };
      continue;
    }
    current.lines.push(line);
    const pair = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (pair) current.values[pair[1]] = parseTomlScalar(pair[2]);
  }
  flush();
  return sections;
}

function parseTomlScalar(value) {
  const normalized = value.trim();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  if (/^[-+]?\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  return normalized.replace(/^['"]|['"]$/g, "");
}

function duplicateTopLevelKeys(source) {
  const counts = new Map();
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inSection = true;
    if (inSection) continue;
    const match = line.match(/^\s*([a-zA-Z0-9_.-]+)\s*=/);
    if (match) counts.set(match[1], (counts.get(match[1]) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([key]) => key);
}

function redactToml(source) {
  return source.split(/\r?\n/).map((line) => {
    const pair = line.match(/^(\s*([^=]+?)\s*=\s*)(.*)$/);
    if (!pair || !SENSITIVE_KEY.test(pair[2])) return redactText(line);
    return `${pair[1]}"[已隐藏]"`;
  }).join("\n");
}

function redactText(value) {
  return String(value || "")
    .replace(/((?:password|passwd|token|api[_ -]?key|secret|authorization|密码|口令)\s*(?:(?:是|为)|[:：=])\s*)[^\s,，;；]+/gi, "$1[已隐藏]")
    .replace(/\b(?:sk|key)-[a-z0-9_-]{8,}\b/gi, "[已隐藏密钥]")
    .replace(/Bearer\s+[a-z0-9._~+/-]+=*/gi, "Bearer [已隐藏]");
}

function truncateUtf8(value, maxBytes) {
  const source = Buffer.from(String(value || ""), "utf8");
  if (source.length <= maxBytes) return source.toString("utf8");
  return source.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/, "");
}

async function listRelativeFiles(root, limit) {
  const files = [];
  async function visit(current) {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) files.push(path.relative(root, file).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return files.sort();
}

async function listSkillFiles(root, references) {
  const files = new Set(await listRelativeFiles(root, 500));
  for (const reference of references) {
    let info;
    try {
      info = await stat(safeDescendant(root, reference));
    } catch {
      continue;
    }
    if (info.isFile()) files.add(reference);
    if (info.isDirectory()) {
      for (const file of await listRelativeFiles(path.join(root, reference), 500)) {
        files.add(path.posix.join(reference.replaceAll("\\", "/"), file));
      }
    }
  }
  return [...files].sort();
}

async function hashDirectory(root, files) {
  const entries = [];
  for (const relative of files) {
    const file = safeDescendant(root, relative);
    entries.push(`${relative}\0${sha256(await readFile(file))}`);
  }
  return sha256(entries.join("\n"));
}

async function hashSkill(skillRoot, files, pluginRoot, sharedFiles) {
  const entries = [];
  for (const relative of files) entries.push(`skill:${relative}\0${sha256(await readFile(safeDescendant(skillRoot, relative)))}`);
  for (const relative of sharedFiles || []) entries.push(`plugin:${relative}\0${sha256(await readFile(safeDescendant(pluginRoot, relative)))}`);
  return sha256(entries.join("\n"));
}

async function resolveSkillReferences(skillRoot, pluginRoot, references, files) {
  const resolvedReferences = [];
  const missingReferences = [];
  const sharedFiles = [];
  for (const reference of references) {
    const normalized = reference.replace(/\/$/, "");
    if (files.includes(normalized) || files.some((file) => file.startsWith(`${normalized}/`))) {
      resolvedReferences.push(reference);
      continue;
    }
    if (pluginRoot) {
      try {
        const info = await stat(safeDescendant(pluginRoot, normalized));
        if (info.isFile()) {
          sharedFiles.push(normalized);
          resolvedReferences.push(reference);
          continue;
        }
        if (info.isDirectory()) {
          resolvedReferences.push(reference);
          continue;
        }
      } catch {
        // Report unresolved references below.
      }
    }
    missingReferences.push(reference);
  }
  return { resolvedReferences, missingReferences, sharedFiles: [...new Set(sharedFiles)].sort() };
}

async function walkNamedFiles(root, name, limit) {
  const files = [];
  async function visit(current) {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && entry.name === name) files.push(file);
    }
  }
  await visit(root);
  return files;
}

async function walkExtensions(root, extensions, limit) {
  const files = [];
  async function visit(current) {
    if (files.length >= limit) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= limit) return;
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) files.push(file);
    }
  }
  await visit(root);
  return files;
}

async function isNonEmptyFile(file) {
  try {
    const info = await stat(file);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function safeDescendant(root, child) {
  const resolved = path.resolve(root, child);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("path escapes allowed Harness root");
  return resolved;
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function unquoteTomlKey(value) {
  return String(value).replace(/^['"]|['"]$/g, "");
}

function visibleValue(value) {
  if (value === undefined) return null;
  return SENSITIVE_KEY.test(String(value)) ? "[已隐藏]" : value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

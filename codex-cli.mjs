import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

const OUTPUT_LIMIT = 1_000_000;

export async function runCodexCli(context, args, options = {}) {
  if (context.runCodexCommand) return context.runCodexCommand(args);
  const launch = await resolveCodexLaunch(context.codex || "codex");
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 120_000;
  return new Promise((resolve, reject) => {
    const child = spawn(launch.executable, [...launch.prefixArgs, ...args], {
      cwd: context.codexHome,
      windowsHide: true,
      shell: false,
      env: { ...process.env, CODEX_HOME: context.codexHome },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`Codex command timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < OUTPUT_LIMIT) stdout += chunk; });
    child.stderr.on("data", (chunk) => { if (stderr.length < OUTPUT_LIMIT) stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) finish(new Error(`Codex command failed (${code}): ${stderr.trim().slice(0, 600)}`));
      else finish(null, { code, stdout: stdout.trim().slice(0, OUTPUT_LIMIT), stderr: stderr.trim().slice(0, OUTPUT_LIMIT), args });
    });
  });
}

export async function resolveCodexLaunch(command) {
  if (process.platform !== "win32") return { executable: command, prefixArgs: [] };
  const resolved = await resolveWindowsCommand(command);
  const extension = path.extname(resolved).toLowerCase();
  const npmEntrypoint = await npmCodexEntrypoint(resolved);
  if (npmEntrypoint) return { executable: process.execPath, prefixArgs: [npmEntrypoint] };
  if (extension === ".ps1") {
    return { executable: "powershell.exe", prefixArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved] };
  }
  if ([".cmd", ".bat"].includes(extension)) {
    const sibling = resolved.slice(0, -extension.length) + ".ps1";
    if (await exists(sibling)) return { executable: "powershell.exe", prefixArgs: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", sibling] };
    throw new Error("Windows Codex .cmd/.bat shim requires a sibling .ps1 launcher to preserve fixed argument execution");
  }
  return { executable: resolved, prefixArgs: [] };
}

async function npmCodexEntrypoint(resolved) {
  const extension = path.extname(resolved).toLowerCase();
  if (![".ps1", ".cmd", ".bat", ""].includes(extension)) return null;
  const base = extension ? resolved.slice(0, -extension.length) : resolved;
  if (path.basename(base).toLowerCase() !== "codex") return null;
  const entrypoint = path.join(path.dirname(base), "node_modules", "@openai", "codex", "bin", "codex.js");
  return await exists(entrypoint) ? entrypoint : null;
}

async function resolveWindowsCommand(command) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    if (await exists(command)) return path.resolve(command);
    throw new Error(`Codex executable not found: ${command}`);
  }
  const directories = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = path.extname(command) ? [""] : [".exe", ".ps1", ".cmd", ".bat", ""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${command}${extension}`);
      if (await exists(candidate)) return candidate;
    }
  }
  throw new Error(`Codex executable not found on PATH: ${command}`);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createViewerServer } from "../server.mjs";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const lockAcquired = app.requestSingleInstanceLock();
const execFileAsync = promisify(execFile);

let viewerServer;
let mainWindow;
let setupWindow;
let setupCompletion;
let shuttingDown = false;

if (!lockAcquired) {
  app.quit();
} else {
  registerDesktopIpc();
  app.on("second-instance", () => {
    if (setupWindow) {
      setupWindow.show();
      setupWindow.focus();
      return;
    }
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startDesktopApp).catch(handleStartupError);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("activate", () => {
    if (!mainWindow) startDesktopApp().catch(handleStartupError);
  });

  app.on("before-quit", (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    closeViewerServer().finally(() => app.exit(0));
  });
}

async function startDesktopApp() {
  if (mainWindow) {
    mainWindow.show();
    return;
  }
  let savedConfig = await loadDesktopConfig();
  if (!savedConfig.setupComplete) {
    savedConfig = await showSetupWizard(savedConfig);
  }
  const options = desktopOptions(process.argv.slice(1), savedConfig);
  viewerServer = createViewerServer({
    ...options,
    host: "127.0.0.1",
    port: 0,
  });
  const port = await listenOnEphemeralPort(viewerServer);
  const url = `http://127.0.0.1:${port}/`;

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    title: "Codex Trace Viewer",
    backgroundColor: "#101114",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(desktopRoot, "preload.mjs"),
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:\/\//i.test(target)) shell.openExternal(target);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  await mainWindow.loadURL(url);
  mainWindow.show();
}

function desktopOptions(argv, savedConfig = {}) {
  const options = {
    traceRoot: savedConfig.traceRoot || process.env.CODEX_ROLLOUT_TRACE_ROOT || path.join(app.getPath("userData"), "traces"),
    dataRoot: savedConfig.dataRoot || process.env.CODEX_INSIGHTS_ROOT || path.join(app.getPath("userData"), "insights"),
    codexHome: savedConfig.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    codex: savedConfig.codexExecutable || process.env.CODEX_TRACE_VIEWER_CODEX || "codex",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--trace-root") options.traceRoot = argv[++index];
    else if (value === "--data-root") options.dataRoot = argv[++index];
    else if (value === "--codex-home") options.codexHome = argv[++index];
    else if (value === "--codex") options.codex = argv[++index];
  }
  return {
    traceRoot: path.resolve(options.traceRoot),
    dataRoot: path.resolve(options.dataRoot),
    codexHome: path.resolve(options.codexHome),
    codex: options.codex,
  };
}

function desktopConfigPath() {
  return path.join(app.getPath("userData"), "desktop-config.json");
}

async function loadDesktopConfig() {
  try {
    const value = JSON.parse(await readFile(desktopConfigPath(), "utf8"));
    if (value && value.setupComplete === true) return value;
  } catch {
    // The first-run wizard handles missing or invalid configuration.
  }
  const detected = await detectCodexExecutable();
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const traceCandidates = traceRootCandidates(codexHome);
  const configuredTraceRoot = process.env.CODEX_ROLLOUT_TRACE_ROOT?.trim();
  const existingTraceRoot = configuredTraceRoot || await firstExistingDirectory(traceCandidates);
  return {
    setupComplete: false,
    traceRoot: existingTraceRoot || traceCandidates.at(-1),
    traceRootDetected: Boolean(existingTraceRoot),
    traceCandidates,
    dataRoot: process.env.CODEX_INSIGHTS_ROOT || path.join(app.getPath("userData"), "insights"),
    codexHome,
    codexExecutable: process.env.CODEX_TRACE_VIEWER_CODEX || detected.path || "codex",
    codexDetected: detected.found,
    codexCandidates: detected.candidates,
    codexVersion: detected.version,
  };
}

async function showSetupWizard(initialConfig) {
  return new Promise((resolve) => {
    setupCompletion = resolve;
    setupWindow = new BrowserWindow({
      width: 920,
      height: 720,
      minWidth: 760,
      minHeight: 620,
      resizable: false,
      show: false,
      autoHideMenuBar: true,
      title: "Codex Trace Viewer 初始设置",
      backgroundColor: "#101114",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(desktopRoot, "preload.mjs"),
      },
    });
    setupWindow.on("closed", () => {
      setupWindow = undefined;
      if (setupCompletion) {
        const complete = setupCompletion;
        setupCompletion = undefined;
        complete(null);
      }
    });
    setupWindow.once("ready-to-show", () => setupWindow.show());
    setupWindow.loadFile(path.join(desktopRoot, "wizard.html"), { query: { initial: JSON.stringify(initialConfig) } }).catch((error) => {
      if (!setupCompletion) return;
      const complete = setupCompletion;
      setupCompletion = undefined;
      complete(null);
      dialog.showErrorBox("初始设置无法打开", error instanceof Error ? error.message : String(error));
      setupWindow?.close();
    });
  }).then((config) => {
    if (!config) throw new Error("初始设置已取消");
    return config;
  });
}

function registerDesktopIpc() {
  ipcMain.handle("desktop:setup-state", async () => loadDesktopConfig());
  ipcMain.handle("desktop:detect-codex", async () => detectCodexExecutable());
  ipcMain.handle("desktop:choose-directory", async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(setupWindow || mainWindow, {
      title: "选择目录",
      defaultPath: typeof defaultPath === "string" ? defaultPath : undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("desktop:choose-codex", async (_event, defaultPath) => {
    const result = await dialog.showOpenDialog(setupWindow || mainWindow, {
      title: "选择 Codex CLI 可执行文件",
      defaultPath: typeof defaultPath === "string" ? defaultPath : undefined,
      properties: ["openFile"],
      filters: [
        { name: "Codex CLI", extensions: ["exe", "cmd", "bat", "ps1"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("desktop:complete-setup", async (_event, input) => {
    const config = await completeSetup(input || {});
    if (setupCompletion) {
      const complete = setupCompletion;
      setupCompletion = undefined;
      complete(config);
      setupWindow?.close();
    }
    return { ok: true, config };
  });
}

async function completeSetup(input) {
  const traceRootInput = String(input.traceRoot || "").trim();
  const dataRootInput = String(input.dataRoot || "").trim();
  const codexHomeInput = String(input.codexHome || "").trim();
  const codexExecutable = String(input.codexExecutable || "").trim();
  if (!traceRootInput || !dataRootInput || !codexExecutable) throw new Error("trace 目录、日报目录和 Codex CLI 路径不能为空");
  const traceRoot = path.resolve(traceRootInput);
  const dataRoot = path.resolve(dataRootInput);
  const codexHome = path.resolve(codexHomeInput || path.join(os.homedir(), ".codex"));
  await mkdir(traceRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  let environmentWarning = "";
  process.env.CODEX_ROLLOUT_TRACE_ROOT = traceRoot;
  process.env.CODEX_INSIGHTS_ROOT = dataRoot;
  process.env.CODEX_TRACE_VIEWER_CODEX = codexExecutable;
  process.env.CODEX_HOME = codexHome;
  if (process.platform === "win32" && input.persistTraceEnvironment !== false) {
    try {
      await persistWindowsEnvironment(traceRoot, dataRoot);
    } catch (error) {
      environmentWarning = `本次工作台已生效，但未能写入 Windows 用户环境变量：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const config = {
    schemaVersion: 1,
    setupComplete: true,
    traceRoot,
    dataRoot,
    codexHome,
    codexExecutable,
    configuredAtUnixMs: Date.now(),
  };
  if (environmentWarning) config.environmentWarning = environmentWarning;
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(desktopConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return config;
}

async function persistWindowsEnvironment(traceRoot, dataRoot) {
  await Promise.all([
    execFileAsync("setx.exe", ["CODEX_ROLLOUT_TRACE_ROOT", traceRoot], { windowsHide: true }),
    execFileAsync("setx.exe", ["CODEX_INSIGHTS_ROOT", dataRoot], { windowsHide: true }),
  ]);
}

async function detectCodexExecutable() {
  const candidates = [];
  const configured = process.env.CODEX_TRACE_VIEWER_CODEX?.trim();
  const configuredPath = configured ? await resolveExecutable(configured) : "";
  if (configuredPath) candidates.push(configuredPath);
  candidates.push(...await findOnPath("codex"));
  const uniqueCandidates = [...new Set(candidates)];
  const preferred = uniqueCandidates.sort((left, right) => executableRank(left) - executableRank(right))[0];
  return {
    found: Boolean(preferred),
    path: preferred || "",
    candidates: uniqueCandidates,
    version: preferred ? await detectCodexVersion(preferred) : "",
  };
}

async function resolveExecutable(value) {
  if (path.isAbsolute(value) || value.includes("/") || value.includes("\\")) {
    try {
      if ((await stat(value)).isFile()) return value;
    } catch {
      return "";
    }
    return "";
  }
  return (await findOnPath(value))[0] || "";
}

async function findOnPath(command) {
  try {
    const result = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [command], { windowsHide: true });
    return result.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  } catch {
    // The picker remains available when Codex is not on PATH.
    return [];
  }
}

async function detectCodexVersion(executable) {
  try {
    if (process.platform === "win32") {
      if (path.extname(executable).toLowerCase() === ".ps1") {
        const result = await execFileAsync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", executable, "--version"], { windowsHide: true, timeout: 2500 });
        return firstLine(result.stdout || result.stderr);
      }
      const quoted = `"${executable.replaceAll('"', '""')}" --version`;
      const result = await execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", quoted], { windowsHide: true, timeout: 2500 });
      return firstLine(result.stdout || result.stderr);
    }
    const result = await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 2500 });
    return firstLine(result.stdout || result.stderr);
  } catch {
    return "";
  }
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean)?.slice(0, 160) || "";
}

function traceRootCandidates(codexHome) {
  return [...new Set([
    process.env.CODEX_ROLLOUT_TRACE_ROOT?.trim(),
    path.join(codexHome, "traces"),
    path.join(process.cwd(), ".codex-traces"),
    path.join(app.getPath("userData"), "traces"),
  ].filter(Boolean).map((value) => path.resolve(value)))];
}

async function firstExistingDirectory(candidates) {
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isDirectory()) return candidate;
    } catch {
      // A missing candidate is expected during first-run setup.
    }
  }
  return "";
}

function executableRank(value) {
  const extension = path.extname(value).toLowerCase();
  if (extension === ".exe") return 0;
  if (extension === ".cmd") return 1;
  if (extension === ".bat") return 2;
  if (extension === ".ps1") return 3;
  return 4;
}

function listenOnEphemeralPort(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Electron 本地服务没有返回有效端口"));
        return;
      }
      resolve(address.port);
    });
  });
}

function closeViewerServer() {
  if (!viewerServer?.listening) return Promise.resolve();
  return new Promise((resolve) => viewerServer.close(resolve));
}

function handleStartupError(error) {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("Codex Trace Viewer 无法启动", message);
  app.quit();
}

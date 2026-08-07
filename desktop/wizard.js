const params = new URLSearchParams(window.location.search);
let initial = {};
try {
  initial = JSON.parse(params.get("initial") || "{}");
} catch {
  initial = {};
}
const form = document.querySelector("#setup-form");
const traceRoot = document.querySelector("#trace-root");
const dataRoot = document.querySelector("#data-root");
const codexHome = document.querySelector("#codex-home");
const codexExecutable = document.querySelector("#codex-executable");
const persistEnvironment = document.querySelector("#persist-environment");
const detection = document.querySelector("#codex-detection");
const codexVersion = document.querySelector("#codex-version");
const helper = document.querySelector("#codex-helper");
const traceHelper = document.querySelector("#trace-helper");
const status = document.querySelector("#setup-status");
const detectButton = document.querySelector("#detect-codex");

function renderDetection(state) {
  if (state.found || state.codexDetected) {
    const executable = state.path || state.codexExecutable || codexExecutable.value;
    detection.textContent = `已找到：${executable}`;
    detection.className = "detected";
    helper.textContent = "已自动填入可用的 Codex CLI 路径，也可以手动更换。";
    codexVersion.textContent = state.version ? `版本：${state.version}` : "已找到可执行文件，版本信息暂不可用。";
    return;
  }
  detection.textContent = "没有在 PATH 中找到 Codex，请选择文件或填写命令名。";
  detection.className = "missing";
  codexVersion.textContent = "";
  helper.textContent = "检测不到时可以填写 PATH 中的命令名，例如 codex，或选择 codex.exe/codex.cmd。";
}

function renderState(state) {
  traceRoot.value = state.traceRoot || "";
  dataRoot.value = state.dataRoot || "";
  codexHome.value = state.codexHome || "";
  codexExecutable.value = state.codexExecutable || "codex";
  renderDetection({
    found: state.codexDetected,
    path: state.codexExecutable,
    version: state.codexVersion,
  });
  if (state.traceRootDetected) {
    traceHelper.textContent = "已发现可用的 trace 目录并自动填入；你也可以改用其他目录。";
    traceHelper.className = "detected-hint";
  } else {
    traceHelper.textContent = "没有发现现有目录，完成设置时会自动创建；之后 Codex 与工作台会共用它。";
    traceHelper.className = "";
  }
}

function showStatus(message, kind = "error") {
  status.textContent = message;
  status.className = `setup-status ${kind}`;
}

async function choose(kind) {
  const input = { traceRoot, dataRoot, codexHome, codexExecutable }[kind];
  const selected = kind === "codexExecutable"
    ? await window.codexDesktop.chooseCodex(input.value)
    : await window.codexDesktop.chooseDirectory(input.value);
  if (selected) input.value = selected;
}

async function detect() {
  detectButton.disabled = true;
  detection.textContent = "正在重新检测…";
  detection.className = "";
  codexVersion.textContent = "";
  try {
    const result = await window.codexDesktop.detectCodex();
    renderDetection(result);
    if (result.path) codexExecutable.value = result.path;
  } catch (error) {
    detection.textContent = "检测失败，请手动填写 Codex CLI 路径。";
    showStatus(error?.message || String(error));
  } finally {
    detectButton.disabled = false;
  }
}

document.querySelectorAll("[data-browse]").forEach((button) => {
  button.addEventListener("click", () => choose(button.dataset.browse).catch((error) => showStatus(error?.message || String(error))));
});
detectButton.addEventListener("click", () => detect());
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!traceRoot.value.trim() || !dataRoot.value.trim() || !codexExecutable.value.trim()) {
    showStatus("请填写 Trace 目录、日报目录和 Codex CLI 路径。", "error");
    return;
  }
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  showStatus("正在保存设置…", "working");
  try {
    const result = await window.codexDesktop.completeSetup({
      traceRoot: traceRoot.value.trim(),
      dataRoot: dataRoot.value.trim(),
      codexHome: codexHome.value.trim(),
      codexExecutable: codexExecutable.value.trim(),
      persistTraceEnvironment: persistEnvironment.checked,
    });
    showStatus(result.config?.environmentWarning || "设置已保存，正在打开工作台…", result.config?.environmentWarning ? "working" : "success");
  } catch (error) {
    showStatus(error?.message || String(error), "error");
    submit.disabled = false;
  }
});

renderState(initial);

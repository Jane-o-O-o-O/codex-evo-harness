const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexDesktop", {
  getSetupState: () => ipcRenderer.invoke("desktop:setup-state"),
  detectCodex: () => ipcRenderer.invoke("desktop:detect-codex"),
  chooseDirectory: (defaultPath) => ipcRenderer.invoke("desktop:choose-directory", defaultPath),
  chooseCodex: (defaultPath) => ipcRenderer.invoke("desktop:choose-codex", defaultPath),
  completeSetup: (input) => ipcRenderer.invoke("desktop:complete-setup", input),
});

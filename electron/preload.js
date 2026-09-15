// Preload script bridge for CodexMemory Desktop
// Note: Electron requires CommonJS preload scripts when ESM is enabled in package.json.
// The active preload script loaded by electron/main.js is preload.cjs.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  startEngine: () => ipcRenderer.invoke("engine:start"),
  stopEngine: () => ipcRenderer.invoke("engine:stop"),
  getEngineStatus: () => ipcRenderer.invoke("engine:status"),
});

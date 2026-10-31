"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("heyclickyGraphics", {
  onThreeModule(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, moduleBase64) => callback(moduleBase64);
    ipcRenderer.on("graphics:three-module", listener);
    return () => ipcRenderer.removeListener("graphics:three-module", listener);
  },
  onRender(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, html) => callback(html);
    ipcRenderer.on("graphics:render", listener);
    return () => ipcRenderer.removeListener("graphics:render", listener);
  },
  onClear(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = () => callback();
    ipcRenderer.on("graphics:clear", listener);
    return () => ipcRenderer.removeListener("graphics:clear", listener);
  }
});

contextBridge.exposeInMainWorld("heyclickySetup", {
  saveApiConfig: (config) => ipcRenderer.invoke("config:save", config)
});

contextBridge.exposeInMainWorld("heyclickyControls", {
  requestVoice: () => ipcRenderer.send("assistant:voice"),
  clearVisual: () => ipcRenderer.send("assistant:clear"),
  quit: () => ipcRenderer.send("assistant:quit"),
  onStatus(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("assistant:status", listener);
    return () => ipcRenderer.removeListener("assistant:status", listener);
  }
});

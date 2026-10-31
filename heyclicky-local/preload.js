"use strict";

const { contextBridge, ipcRenderer } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
let threeModuleBase64 = "";
try {
  const packageEntry = require.resolve("three");
  const moduleFile = path.join(path.dirname(packageEntry), "three.module.js");
  threeModuleBase64 = fs.readFileSync(moduleFile).toString("base64");
} catch (error) {
  console.error("Could not load bundled Three.js module:", error.message);
}

contextBridge.exposeInMainWorld("heyclickyGraphics", {
  getThreeModuleBase64: () => threeModuleBase64,
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

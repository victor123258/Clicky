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
  saveApiConfig: (config) => ipcRenderer.invoke("config:save", config),
  testMicrophone: () => ipcRenderer.send("assistant:setup-mic-test"),
  onMicrophoneTest(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("assistant:setup-mic-result", listener);
    return () => ipcRenderer.removeListener("assistant:setup-mic-result", listener);
  }
});

contextBridge.exposeInMainWorld("heyclickyControls", {
  requestVoice: () => ipcRenderer.send("assistant:voice"),
  testMicrophone: () => ipcRenderer.send("assistant:mic-test"),
  sendText: (text) => ipcRenderer.send("assistant:text", text),
  openSetup: () => ipcRenderer.send("assistant:setup"),
  openMicrophonePrivacy: () => ipcRenderer.send("assistant:mic-privacy"),
  getVoiceLanguage: () => ipcRenderer.invoke("assistant:get-voice-language"),
  getProviderStatus: () => ipcRenderer.invoke("assistant:get-provider-status"),
  setVoiceLanguage: (language) => ipcRenderer.invoke("assistant:set-voice-language", language),
  clearVisual: () => ipcRenderer.send("assistant:clear"),
  quit: () => ipcRenderer.send("assistant:quit"),
  setLayout: (mode) => ipcRenderer.send("assistant:layout", mode),
  onLayout(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("assistant:layout-state", listener);
    return () => ipcRenderer.removeListener("assistant:layout-state", listener);
  },
  onStatus(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("assistant:status", listener);
    return () => ipcRenderer.removeListener("assistant:status", listener);
  },
  onReply(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("assistant:reply", listener);
    return () => ipcRenderer.removeListener("assistant:reply", listener);
  },
  onTranscript(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("assistant:transcript", listener);
    return () => ipcRenderer.removeListener("assistant:transcript", listener);
  },
  onMicTest(callback) {
    if (typeof callback !== "function") return () => {};
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("assistant:mic-test-result", listener);
    return () => ipcRenderer.removeListener("assistant:mic-test-result", listener);
  }
});

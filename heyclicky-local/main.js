"use strict";

const { app, BrowserWindow, dialog, ipcMain, protocol, screen, shell } = require("electron");
const { registerGraphicsScheme, registerGraphicsProtocol } = require("./graphics-protocol.cjs");
registerGraphicsScheme(protocol);
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

let overlay;
let controlsWindow;
let setupWindow;
let lastStatus = { message: "Starting", kind: "busy" };
let backend;
let quitting = false;
let backendStarted = false;
let threeModuleBase64 = "";
let controlLayout = "collapsed";
let collapseTimer;
let captureRestore;
let captureTimer;
let overlayEnabled = true;
let setupOverlayEnabled = null;
let voiceLanguage = "en-US";
const SPEECH_LANGUAGES = new Set(["en-US", "en-GB", "bn-BD", "hi-IN", "ur-PK", "es-MX", "fr-FR", "de-DE"]);
try {
  threeModuleBase64 = require("./three-module.cjs")();
} catch (error) {
  console.error("Bundled Three.js module unavailable:", error.message);
}

function userConfigPath() {
  return path.join(app.getPath("userData"), ".env");
}

function voiceSettingsPath() {
  return path.join(app.getPath("userData"), "voice-settings.json");
}

function loadVoiceLanguage() {
  try {
    const settings = JSON.parse(fs.readFileSync(voiceSettingsPath(), "utf8"));
    if (SPEECH_LANGUAGES.has(settings.language)) voiceLanguage = settings.language;
  } catch (_) { /* First launch defaults to English (US). */ }
}

function keyExistsInEnvFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return /^\s*(GEMINI_API_KEY|OPENROUTER_API_KEY)\s*=\s*[^\s#].*$/m.test(text);
  } catch (_) { return false; }
}

function hasConfiguredKey() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY) ||
    keyExistsInEnvFile(userConfigPath()) || keyExistsInEnvFile(path.join(__dirname, ".env"));
}

function providerStatus() {
  if (!hasConfiguredKey()) return "No AI provider key connected yet.";
  let provider = process.env.AI_PROVIDER || "";
  for (const file of [userConfigPath(), path.join(__dirname, ".env")]) {
    try {
      const text = fs.readFileSync(file, "utf8");
      const match = text.match(/^\s*AI_PROVIDER\s*=\s*(gemini|openrouter)\s*$/mi);
      if (match) { provider = match[1]; break; }
    } catch (_) { /* Try the next configuration source. */ }
  }
  if (!provider) provider = process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY ? "openrouter" : "gemini";
  return `${provider === "openrouter" ? "OpenRouter" : "Google Gemini"} key saved for this Windows user.`;
}

function createOverlay() {
  const display = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setIgnoreMouseEvents(true, { forward: true });
  overlay.loadFile(path.join(__dirname, "overlay.html"));
  overlay.webContents.on("did-finish-load", () => {
    if (!overlay.isDestroyed()) overlay.webContents.send("graphics:three-module", threeModuleBase64);
  });
  overlay.once("ready-to-show", () => {
    if (overlayEnabled) overlay.showInactive();
  });
  overlay.on("closed", () => { overlay = null; });
}

function controlBounds(mode = controlLayout) {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const sizes = {
    collapsed: { width: 286, height: 46 },
    peek: { width: 440, height: 196 },
    expanded: { width: Math.min(720, area.width), height: Math.min(730, area.height) }
  };
  const size = sizes[mode] || sizes.collapsed;
  return {
    x: area.x + Math.round((area.width - size.width) / 2),
    y: area.y,
    width: size.width,
    height: size.height
  };
}

function setControlLayout(mode, focus = false) {
  if (!["collapsed", "peek", "expanded"].includes(mode) || !controlsWindow || controlsWindow.isDestroyed()) return;
  clearTimeout(collapseTimer);
  controlLayout = mode;
  controlsWindow.setBounds(controlBounds(mode));
  controlsWindow.setFocusable?.(mode === "expanded");
  controlsWindow.webContents.send("assistant:layout-state", { mode });
  controlsWindow.webContents.send("assistant:status", lastStatus);
  if (!controlsWindow.isVisible()) controlsWindow.showInactive();
  if (focus && mode === "expanded") controlsWindow.focus();
}

function createControls() {
  const bounds = controlBounds("collapsed");
  controlsWindow = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  controlsWindow.setAlwaysOnTop(true, "screen-saver");
  controlsWindow.loadFile(path.join(__dirname, "controls.html"));
  controlsWindow.once("ready-to-show", () => {
    controlsWindow.showInactive();
    controlsWindow.webContents.send("assistant:status", lastStatus);
    controlsWindow.webContents.send("assistant:layout-state", { mode: controlLayout });
  });
  controlsWindow.on("mouseenter", () => {
    if (controlLayout === "collapsed") setControlLayout("peek");
  });
  controlsWindow.on("mouseleave", () => {
    if (controlLayout === "peek") {
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => {
        if (controlLayout === "peek") setControlLayout("collapsed");
      }, 800);
    }
  });
  controlsWindow.on("closed", () => { controlsWindow = null; });
}

function setAssistantStatus(message, kind = "ready") {
  lastStatus = { message: String(message || "Ready").slice(0, 500), kind };
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send("assistant:status", lastStatus);
    if (kind === "warning" && controlLayout === "collapsed") setControlLayout("peek");
  }
}

function showSetup() {
  setAssistantStatus("Set up API key", "warning");
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  setupOverlayEnabled = overlayEnabled;
  overlayEnabled = false;
  overlay?.hide();
  setupWindow = new BrowserWindow({
    width: 510,
    height: 740,
    minWidth: 470,
    minHeight: 680,
    title: "HeyClicky — First-time setup",
    resizable: false,
    backgroundColor: "#0b1020",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
  setupWindow.loadFile(path.join(__dirname, "setup.html"));
  setupWindow.on("closed", () => {
    setupWindow = null;
    const shouldRestoreOverlay = setupOverlayEnabled === true;
    setupOverlayEnabled = null;
    if (shouldRestoreOverlay && overlay && !overlay.isDestroyed() && !quitting) {
      overlayEnabled = true;
      overlay.showInactive();
    }
    if (!backendStarted && !hasConfiguredKey() && !quitting) app.quit();
  });
}

function sendBackendMessage(value) {
  if (!backend || backend.killed || !backend.stdin.writable) return;
  backend.stdin.write(`${JSON.stringify(value)}\n`);
}

function confirmAction(message) {
  if (!backend || !backend.stdin.writable) return;
  setAssistantStatus("Confirm action", "warning");
  const isClick = message.action === "click";
  const detail = isClick
    ? `Click at screen position (${message.x}, ${message.y})?`
    : `Type this text into the focused application?\n\n${String(message.text || "").slice(0, 500)}`;
  dialog.showMessageBox(overlay || undefined, {
    type: "warning",
    title: "Confirm desktop action",
    message: `HeyClicky proposes to ${isClick ? "click" : "type"}.`,
    detail,
    buttons: ["Execute", "Cancel"],
    defaultId: 1,
    cancelId: 1,
    noLink: true
  }).then(({ response }) => sendBackendMessage({ type: "approval", approved: response === 0 }))
    .catch((error) => {
      console.error("Could not show confirmation dialog:", error.message);
      sendBackendMessage({ type: "approval", approved: false });
    });
}

function restoreAfterCapture() {
  clearTimeout(captureTimer);
  if (!captureRestore) return;
  const previous = captureRestore;
  captureRestore = null;
  if (previous.overlay && overlay && !overlay.isDestroyed()) overlay.showInactive();
  if (previous.controls && controlsWindow && !controlsWindow.isDestroyed()) {
    setControlLayout(previous.mode, false);
    controlsWindow.showInactive();
  }
}

function restartBackend() {
  if (backend && !backend.killed) {
    const previous = backend;
    previous.once("exit", () => { if (!quitting) startBackend(); });
    previous.kill("SIGTERM");
    return;
  }
  backendStarted = false;
  startBackend();
}

function startBackend() {
  if (backendStarted) return;
  backendStarted = true;
  const configDir = app.getPath("userData");
  const bundledExe = path.join(process.resourcesPath, "backend", "heyclicky-engine.exe");
  const packaged = app.isPackaged;
  const python = process.env.HEYCLICKY_PYTHON || (process.platform === "win32" ? "python" : "python3");
  const command = packaged ? bundledExe : python;
  const args = packaged ? [] : ["-u", path.join(__dirname, "engine.py")];
  backend = spawn(command, args, {
    cwd: packaged ? configDir : __dirname,
    env: { ...process.env, PYTHONUNBUFFERED: "1", HEYCLICKY_CONFIG_DIR: configDir, HEYCLICKY_SPEECH_LANGUAGE: voiceLanguage },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const lines = readline.createInterface({ input: backend.stdout, crlfDelay: Infinity });
  lines.on("line", (line) => {
    let message;
    try { message = JSON.parse(line); }
    catch { console.error("Ignoring invalid Python protocol line:", line.slice(0, 300)); return; }
    if (message.type === "render_visual" && typeof message.html_payload === "string") {
      if (message.html_payload.length <= 150_000 && overlay && !overlay.isDestroyed()) {
        overlay.webContents.send("graphics:render", message.html_payload);
      } else console.error("Rejected oversized visual payload or unavailable overlay.");
    } else if (message.type === "clear_visual") {
      overlay?.webContents.send("graphics:clear");
    } else if (message.type === "action_confirmation") {
      confirmAction(message);
    } else if (message.type === "assistant_reply") {
      if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.webContents.send("assistant:reply", { text: String(message.text || "").slice(0, 6000) });
    } else if (message.type === "transcript") {
      if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.webContents.send("assistant:transcript", { text: String(message.text || "").slice(0, 2000) });
    } else if (message.type === "request_rejected") {
      if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.webContents.send("assistant:request-rejected", { message: String(message.message || "Request was not sent.").slice(0, 500) });
    } else if (message.type === "busy_notice") {
      if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.webContents.send("assistant:busy-notice", { message: String(message.message || "Clicky is busy.").slice(0, 300) });
    } else if (message.type === "mic_test_result") {
      const result = { ok: Boolean(message.ok), text: String(message.text || "").slice(0, 300), error: String(message.error || "").slice(0, 500) };
      if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.webContents.send("assistant:mic-test-result", result);
      if (setupWindow && !setupWindow.isDestroyed()) setupWindow.webContents.send("assistant:setup-mic-result", result);
    } else if (message.type === "capture_request") {
      const captureId = String(message.id || "").slice(0, 100);
      if (captureId && !captureRestore) {
        captureRestore = { controls: Boolean(controlsWindow?.isVisible()), overlay: Boolean(overlay?.isVisible()), mode: controlLayout };
        controlsWindow?.hide();
        overlay?.hide();
        clearTimeout(captureTimer);
        captureTimer = setTimeout(() => restoreAfterCapture(), 12000);
        setTimeout(() => sendBackendMessage({ type: "capture_ready", id: captureId }), 140);
      }
    } else if (message.type === "capture_done") {
      restoreAfterCapture();
    } else if (message.type === "failsafe" || message.type === "shutdown") {
      app.quit();
    } else if (message.type === "status") {
      const text = String(message.message || "Ready").slice(0, 400);
      console.log(`[HeyClicky] ${text}`);
      const lower = text.toLowerCase();
      const shortStatus = lower.includes("listening") ? "Listening…"
        : lower.includes("thinking") || lower.includes("requesting") ? "Thinking…"
        : lower.includes("recognized") ? "Thinking…"
        : lower.includes("confirm") ? "Confirm action"
        : lower.includes("cancel") ? "Cancelled"
        : lower.includes("clicked") || lower.includes("typed") ? "Done"
        : lower.includes("ready") ? "Ready"
        : text;
      setAssistantStatus(shortStatus, lower.includes("listening") || lower.includes("thinking") ? "busy" : "ready");
    } else if (message.type === "error") {
      const text = String(message.message || "Unknown error").slice(0, 500);
      console.error(`[HeyClicky] ${text}`);
      setAssistantStatus(text, "warning");
      if (/No API key found/i.test(text)) showSetup();
    }
  });
  backend.stderr.setEncoding("utf8");
  backend.stderr.on("data", (chunk) => process.stderr.write(`[engine] ${chunk}`));
  backend.on("error", (error) => {
    backendStarted = false;
    console.error("Could not start Python backend:", error.message);
    if (packaged) dialog.showErrorBox("HeyClicky startup failed", "The embedded assistant engine could not be started. Reinstall the app or contact support.");
  });
  backend.on("exit", (code, signal) => {
    backendStarted = false;
    backend = null;
    if (!quitting && code !== 0) console.error(`Assistant backend exited (code=${code}, signal=${signal}).`);
  });
}

ipcMain.on("graphics:render-error", (event, value) => {
  if (!overlay || overlay.isDestroyed() || event.sender.id !== overlay.webContents.id || event.senderFrame !== overlay.webContents.mainFrame) return;
  const detail = typeof value === "string" ? value.replace(/[\r\n\0]+/g, " ").slice(0, 300) : "Unknown graphics error";
  console.warn(`[HeyClicky] Graphics rendering failed: ${detail}`);
  setAssistantStatus(`Visual failed to render: ${detail}. Try a simpler 3D request.`, "warning");
});

ipcMain.on("assistant:voice", (event) => {
  if (!controlsWindow || event.sender.id !== controlsWindow.webContents.id) return;
  if (!hasConfiguredKey()) {
    showSetup();
    return;
  }
  if (!backendStarted) startBackend();
  setAssistantStatus("Opening microphone…", "busy");
  sendBackendMessage({ type: "voice_request" });
});

ipcMain.on("assistant:layout", (event, mode) => {
  if (controlsWindow && event.sender.id === controlsWindow.webContents.id) setControlLayout(mode, mode === "expanded");
});

ipcMain.on("assistant:setup", (event) => {
  if (controlsWindow && event.sender.id === controlsWindow.webContents.id) showSetup();
});

ipcMain.on("assistant:text", (event, value) => {
  if (!controlsWindow || event.sender.id !== controlsWindow.webContents.id) return;
  const text = typeof value === "string" ? value.trim().slice(0, 2000) : "";
  if (!text) return;
  if (!hasConfiguredKey()) { showSetup(); return; }
  if (!backendStarted) startBackend();
  setAssistantStatus("Thinking…", "busy");
  sendBackendMessage({ type: "text_request", text });
});

ipcMain.on("assistant:mic-test", (event) => {
  if (!controlsWindow || event.sender.id !== controlsWindow.webContents.id) return;
  if (!backendStarted) startBackend();
  setAssistantStatus("Microphone test…", "busy");
  sendBackendMessage({ type: "mic_test" });
});

ipcMain.on("assistant:setup-mic-test", (event) => {
  if (!setupWindow || event.sender.id !== setupWindow.webContents.id) return;
  if (!backendStarted) startBackend();
  sendBackendMessage({ type: "mic_test" });
});

ipcMain.on("assistant:mic-privacy", (event) => {
  if (!controlsWindow || event.sender.id !== controlsWindow.webContents.id) return;
  if (process.platform === "win32") shell.openExternal("ms-settings:privacy-microphone").catch((error) => console.error("Could not open Windows microphone settings:", error.message));
  else setAssistantStatus("Open your system’s microphone privacy settings.", "warning");
});

ipcMain.handle("assistant:get-voice-language", (event) => {
  if (!controlsWindow || event.sender.id !== controlsWindow.webContents.id) throw new Error("Invalid settings request");
  return voiceLanguage;
});

ipcMain.handle("assistant:get-provider-status", (event) => {
  if (!controlsWindow || event.sender.id !== controlsWindow.webContents.id) throw new Error("Invalid settings request");
  return providerStatus();
});

ipcMain.handle("assistant:set-voice-language", async (event, value) => {
  if (!controlsWindow || event.sender.id !== controlsWindow.webContents.id || !SPEECH_LANGUAGES.has(value)) throw new Error("Choose a supported speech language.");
  if (lastStatus.kind === "busy") throw new Error("Wait for the current voice request to finish before changing speech language.");
  voiceLanguage = value;
  const file = voiceSettingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ language: voiceLanguage })}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows uses user profile ACLs. */ }
  if (backendStarted) restartBackend();
  setAssistantStatus(`Speech language set to ${voiceLanguage}.`, "ready");
  return { ok: true, language: voiceLanguage };
});

ipcMain.on("assistant:clear", (event) => {
  if (!controlsWindow || event.sender.id !== controlsWindow.webContents.id) return;
  if (backendStarted) sendBackendMessage({ type: "clear_visual" });
  else overlay?.webContents.send("graphics:clear");
});

ipcMain.on("assistant:quit", (event) => {
  if (controlsWindow && event.sender.id === controlsWindow.webContents.id) app.quit();
});

ipcMain.handle("config:save", async (event, config) => {
  if (!setupWindow || event.sender.id !== setupWindow.webContents.id || !config || typeof config !== "object") {
    throw new Error("Invalid setup request");
  }
  const gemini = typeof config.gemini === "string" ? config.gemini.trim() : "";
  const openrouter = typeof config.openrouter === "string" ? config.openrouter.trim() : "";
  const provider = config.provider === "openrouter" ? "openrouter" : "gemini";
  const safeKey = (value) => value.length <= 1000 && !/[\r\n\0]/.test(value);
  if ((!gemini && !openrouter) || !safeKey(gemini) || !safeKey(openrouter)) {
    throw new Error("Enter at least one valid API key (maximum 1000 characters)");
  }
  const lines = [];
  if (gemini) lines.push(`GEMINI_API_KEY=${gemini}`);
  if (openrouter) lines.push(`OPENROUTER_API_KEY=${openrouter}`);
  lines.push(`AI_PROVIDER=${provider}`);
  const file = userConfigPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows uses user profile ACLs. */ }
  overlayEnabled = true;
  setupWindow.close();
  if (overlay && !overlay.isDestroyed()) overlay.showInactive();
  if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.show();
  setAssistantStatus("Starting engine…", "busy");
  restartBackend();
  setAssistantStatus("Ready when you are", "ready");
  return { ok: true };
});

app.whenReady().then(() => {
  registerGraphicsProtocol(protocol);
  loadVoiceLanguage();
  createOverlay();
  createControls();
  screen.on("display-metrics-changed", () => {
    if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.setBounds(controlBounds(controlLayout));
  });
  startBackend();
  if (!hasConfiguredKey()) showSetup();
  app.on("activate", () => {
    if (!overlay || overlay.isDestroyed()) createOverlay();
    if (!backendStarted && !hasConfiguredKey()) showSetup();
  });
});

app.on("before-quit", () => {
  quitting = true;
  if (backend && !backend.killed) backend.kill("SIGTERM");
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

"use strict";

const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
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
try {
  const threeEntry = require.resolve("three");
  const moduleFile = path.join(path.dirname(threeEntry), "three.module.js");
  threeModuleBase64 = fs.readFileSync(moduleFile).toString("base64");
} catch (error) {
  console.error("Bundled Three.js module unavailable:", error.message);
}

function userConfigPath() {
  return path.join(app.getPath("userData"), ".env");
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
  overlay.once("ready-to-show", () => overlay.showInactive());
  overlay.on("closed", () => { overlay = null; });
}

function createControls() {
  const display = screen.getPrimaryDisplay();
  const width = 558;
  controlsWindow = new BrowserWindow({
    x: display.bounds.x + Math.round((display.bounds.width - width) / 2),
    y: display.workArea.y + 12,
    width,
    height: 86,
    transparent: true,
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
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
    controlsWindow.show();
    controlsWindow.webContents.send("assistant:status", lastStatus);
  });
  controlsWindow.on("closed", () => { controlsWindow = null; });
}

function setAssistantStatus(message, kind = "ready") {
  lastStatus = { message: String(message || "Ready").slice(0, 60), kind };
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send("assistant:status", lastStatus);
  }
}

function showSetup() {
  overlay?.hide();
  setAssistantStatus("Set up API key", "warning");
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 510,
    height: 650,
    minWidth: 470,
    minHeight: 600,
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
    env: { ...process.env, PYTHONUNBUFFERED: "1", HEYCLICKY_CONFIG_DIR: configDir },
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

ipcMain.on("assistant:voice", () => {
  if (!hasConfiguredKey()) {
    showSetup();
    return;
  }
  if (!backendStarted) startBackend();
  setAssistantStatus("Listening…", "busy");
  sendBackendMessage({ type: "voice_request" });
});

ipcMain.on("assistant:clear", () => {
  if (backendStarted) sendBackendMessage({ type: "clear_visual" });
  else overlay?.webContents.send("graphics:clear");
});

ipcMain.on("assistant:quit", () => app.quit());

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
  setupWindow.close();
  if (overlay && !overlay.isDestroyed()) overlay.showInactive();
  if (controlsWindow && !controlsWindow.isDestroyed()) controlsWindow.show();
  setAssistantStatus("Starting engine…", "busy");
  startBackend();
  return { ok: true };
});

app.whenReady().then(() => {
  createOverlay();
  createControls();
  if (hasConfiguredKey()) startBackend();
  else showSetup();
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

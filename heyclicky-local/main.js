"use strict";

const { app, BrowserWindow, dialog, ipcMain, screen } = require("electron");
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

let overlay;
let setupWindow;
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

function showSetup() {
  overlay?.hide();
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
      console.log(`[HeyClicky] ${String(message.message || "").slice(0, 400)}`);
    } else if (message.type === "error") {
      console.error(`[HeyClicky] ${String(message.message || "Unknown error").slice(0, 500)}`);
      if (/No API key found/i.test(String(message.message || ""))) showSetup();
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
  startBackend();
  return { ok: true };
});

app.whenReady().then(() => {
  createOverlay();
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

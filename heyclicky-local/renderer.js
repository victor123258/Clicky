"use strict";

const root = document.getElementById("graphics-root");
let activeFrame = null;
let activePayload = null;
let threeBase64 = "";
let libraryReady = false;
let waitingPayload = null;
let frameReadyTimer = null;
const MAX_PAYLOAD_CHARS = 150_000;

function reportRenderError(message) {
  const safeMessage = String(message || "Unknown graphics error").replace(/\s+/g, " ").slice(0, 300);
  console.error("Graphics frame error:", safeMessage);
  window.heyclickyGraphics.reportRenderError(safeMessage);
}

function renderNow(payload) {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS) {
    reportRenderError("The visual payload was empty or too large.");
    return;
  }
  clearTimeout(frameReadyTimer);
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", "Isolated assistant graphics");
  frame.setAttribute("referrerpolicy", "no-referrer");
  activeFrame = frame;
  activePayload = payload;
  root.replaceChildren(frame);
  frameReadyTimer = setTimeout(() => {
    if (activeFrame === frame) reportRenderError("The isolated graphics frame did not start.");
  }, 10000);
  frame.src = "clicky-graphics://frame/";
}

function renderIsolated(payload) {
  if (!libraryReady) {
    waitingPayload = payload;
    return;
  }
  renderNow(payload);
}

function clearGraphics() {
  clearTimeout(frameReadyTimer);
  waitingPayload = null;
  activePayload = null;
  if (activeFrame) activeFrame.remove();
  activeFrame = null;
  root.replaceChildren();
}

window.addEventListener("message", (event) => {
  if (!activeFrame || event.source !== activeFrame.contentWindow) return;
  const data = event.data;
  if (data?.type === "heyclicky-frame-ready") {
    clearTimeout(frameReadyTimer);
    if (typeof activePayload !== "string") return;
    activeFrame.contentWindow.postMessage({
      type: "heyclicky-render",
      payload: activePayload,
      threeBase64
    }, "*");
  } else if (data?.type === "heyclicky-visual-error") {
    reportRenderError(data.message);
  }
});

window.heyclickyGraphics.onThreeModule((moduleBase64) => {
  threeBase64 = typeof moduleBase64 === "string" ? moduleBase64 : "";
  libraryReady = true;
  if (waitingPayload !== null) {
    const payload = waitingPayload;
    waitingPayload = null;
    renderNow(payload);
  }
});
window.heyclickyGraphics.onRender(renderIsolated);
window.heyclickyGraphics.onClear(clearGraphics);
window.heyclickyGraphics.onInteraction((enabled) => {
  root.dataset.interactive = String(Boolean(enabled));
});

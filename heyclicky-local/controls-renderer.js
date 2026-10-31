"use strict";

const status = document.querySelector("#status");
const statusLabel = status.querySelector(".status-label");
const listen = document.querySelector("#listen");
const listenLabel = listen.querySelector(".speak-label");

function setStatus(message, kind = "ready") {
  const safeMessage = String(message || "Ready");
  statusLabel.textContent = safeMessage;
  status.title = safeMessage;
  status.className = `status-block ${kind}`;
  listen.disabled = kind === "busy";
  listen.classList.toggle("busy", kind === "busy");
  listen.setAttribute("aria-busy", kind === "busy" ? "true" : "false");
  listenLabel.textContent = kind === "busy" && /listen/i.test(safeMessage) ? "Listening…" : "Speak to Clicky";
}

listen.addEventListener("click", () => {
  setStatus("Listening…", "busy");
  window.heyclickyControls.requestVoice();
});
document.querySelector("#clear").addEventListener("click", () => window.heyclickyControls.clearVisual());
document.querySelector("#quit").addEventListener("click", () => window.heyclickyControls.quit());
window.heyclickyControls.onStatus((value) => {
  const message = typeof value?.message === "string" ? value.message : "Ready";
  const kind = value?.kind === "busy" ? "busy" : value?.kind === "warning" ? "warning" : "ready";
  setStatus(message, kind);
});

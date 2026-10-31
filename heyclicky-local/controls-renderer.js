"use strict";

const status = document.querySelector("#status");
const listen = document.querySelector("#listen");
let busy = false;

function setStatus(message, kind = "ready") {
  status.querySelector("span").textContent = message;
  status.className = `status ${kind}`;
  busy = kind === "busy";
  listen.disabled = busy;
  listen.classList.toggle("busy", busy);
}

listen.addEventListener("click", () => {
  setStatus("Listening…", "busy");
  window.heyclickyControls.requestVoice();
});
document.querySelector("#clear").addEventListener("click", () => window.heyclickyControls.clearVisual());
document.querySelector("#quit").addEventListener("click", () => window.heyclickyControls.quit());
window.heyclickyControls.onStatus((value) => {
  const text = typeof value?.message === "string" ? value.message : "Ready";
  const kind = value?.kind === "busy" ? "busy" : value?.kind === "warning" ? "warning" : "ready";
  setStatus(text, kind);
});

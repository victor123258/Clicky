"use strict";

const root = document.getElementById("graphics-root");
let activeFrame = null;
const MAX_PAYLOAD_CHARS = 150_000;
const threeBase64 = window.heyclickyGraphics.getThreeModuleBase64();
const SANDBOX_CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'\">";

function renderIsolated(payload) {
  if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_PAYLOAD_CHARS) return;
  // Provider markup executes only in an opaque-origin iframe with scripts allowed for
  // graphics. It has no same-origin access, network, Electron bridge, forms, or top nav.
  const threeBootstrap = threeBase64
    ? `<script type="module">import * as THREE from "data:text/javascript;base64,${threeBase64}";window.THREE=THREE;window.dispatchEvent(new Event("heyclicky-three-ready"));</script>`
    : "";
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", "Isolated assistant graphics");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8">${SANDBOX_CSP}<meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}</style></head><body>${threeBootstrap}${payload}</body></html>`;
  if (activeFrame) activeFrame.remove();
  activeFrame = frame;
  root.replaceChildren(frame);
}

function clearGraphics() {
  if (activeFrame) activeFrame.remove();
  activeFrame = null;
  root.replaceChildren();
}

window.heyclickyGraphics.onRender(renderIsolated);
window.heyclickyGraphics.onClear(clearGraphics);

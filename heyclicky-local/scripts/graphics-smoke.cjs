"use strict";

// End-to-end check the actual overlay's srcdoc + inherited-CSP + Three.js
// bootstrap path without requiring an API key, model call, or WebGL device.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

async function main() {
  await app.whenReady();
  const threeEntry = require.resolve("three");
  const threeModule = path.join(path.dirname(threeEntry), "three.module.js");
  const threeBase64 = fs.readFileSync(threeModule).toString("base64");
  const window = new BrowserWindow({
    width: 320,
    height: 240,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "../preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  window.webContents.on("console-message", (...args) => {
    const details = args.at(-1);
    const message = details && typeof details === "object" ? details.message : args[2];
    if (message) console.log(`[overlay console] ${message}`);
  });

  try {
    await window.loadFile(path.join(__dirname, "../overlay.html"));
    // Wait for this evaluation so the receiver is installed before sending IPC;
    // otherwise a fast renderer can deliver the result before the test is listening.
    await window.webContents.executeJavaScript(`
      window.__heyclickySmokeResult = null;
      window.addEventListener("message", (event) => {
        if (event.data?.type === "heyclicky-3d-smoke") window.__heyclickySmokeResult = event.data;
      });
      true
    `);

    const payload = `<script type="module">
      const scene = new THREE.Scene();
      const geometry = new THREE.BoxGeometry(1, 1, 1);
      const material = new THREE.MeshBasicMaterial({ color: 0x7dd3fc });
      scene.add(new THREE.Mesh(geometry, material));
      parent.postMessage({ type: "heyclicky-3d-smoke", revision: THREE.REVISION, objects: scene.children.length, vertices: geometry.attributes.position.count }, "*");
    </script>`;

    window.webContents.send("graphics:three-module", threeBase64);
    window.webContents.send("graphics:render", payload);

    const deadline = Date.now() + 10000;
    let result = null;
    while (Date.now() < deadline && !result) {
      result = await window.webContents.executeJavaScript("window.__heyclickySmokeResult");
      if (!result) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!result) throw new Error("3D payload did not execute inside the isolated graphics frame.");
    if (!result.revision || result.objects !== 1 || result.vertices < 8) {
      throw new Error(`Unexpected Three.js scene result: ${JSON.stringify(result)}`);
    }
    console.log(`3D overlay smoke passed (Three.js r${result.revision}, ${result.vertices} box vertices, isolated iframe).`);
  } finally {
    if (!window.isDestroyed()) window.destroy();
    app.quit();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  app.exit(1);
});

"use strict";

// Exercise the production sandbox and prove Three.js reaches a real WebGL pixel
// without requiring an API key or a model call. SwiftShader keeps CI headless.
const { app, BrowserWindow, protocol } = require("electron");
const path = require("node:path");
const loadThreeModuleBase64 = require("../three-module.cjs");
const { registerGraphicsScheme, registerGraphicsProtocol } = require("../graphics-protocol.cjs");

registerGraphicsScheme(protocol);
app.commandLine.appendSwitch("enable-unsafe-swiftshader");
app.commandLine.appendSwitch("use-gl", "angle");
app.commandLine.appendSwitch("use-angle", "swiftshader");

async function main() {
  await app.whenReady();
  registerGraphicsProtocol(protocol);
  const threeBase64 = loadThreeModuleBase64();
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
    await window.webContents.executeJavaScript(`
      window.__heyclickySmokeResult = null;
      window.__heyclickySmokeError = null;
      window.addEventListener("message", (event) => {
        if (event.data?.type === "heyclicky-3d-smoke") window.__heyclickySmokeResult = event.data;
        if (event.data?.type === "heyclicky-visual-error") window.__heyclickySmokeError = event.data.message;
      });
      true
    `);

    const payload = `<script type="module">
      const THREE = window.THREE;
      const scene = new THREE.Scene();
      const geometry = new THREE.BoxGeometry(2, 2, 2);
      const material = new THREE.MeshBasicMaterial({ color: 0x33aaff });
      scene.add(new THREE.Mesh(geometry, material));
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
      renderer.setSize(64, 64, false);
      renderer.setClearColor(0x000000, 0);
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.set(0, 0, 5);
      camera.lookAt(0, 0, 0);
      renderer.render(scene, camera);
      const pixel = new Uint8Array(4);
      renderer.getContext().readPixels(32, 32, 1, 1, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, pixel);
      parent.postMessage({ type: "heyclicky-3d-smoke", revision: THREE.REVISION, objects: scene.children.length, vertices: geometry.attributes.position.count, webgl: true, centerPixel: Array.from(pixel) }, "*");
      renderer.dispose();
    </script>`;

    window.webContents.send("graphics:three-module", threeBase64);
    window.webContents.send("graphics:render", payload);

    const deadline = Date.now() + 15000;
    let response = null;
    while (Date.now() < deadline && !response) {
      response = await window.webContents.executeJavaScript("({ result: window.__heyclickySmokeResult, error: window.__heyclickySmokeError })");
      if (!response.result && !response.error) {
        response = null;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (response?.error) throw new Error(`Isolated visual error: ${response.error}`);
    const result = response?.result;
    if (!result) throw new Error("3D payload did not execute inside the isolated graphics frame.");
    if (!result.revision || result.objects !== 1 || result.vertices < 8 || result.webgl !== true || result.centerPixel?.[3] < 1 || !result.centerPixel?.slice(0, 3).some((channel) => channel > 0)) {
      throw new Error(`Unexpected Three.js WebGL result: ${JSON.stringify(result)}`);
    }
    console.log(`3D WebGL smoke passed (Three.js r${result.revision}, ${result.vertices} box vertices, center pixel ${result.centerPixel.join(",")}, isolated iframe).`);
  } finally {
    if (!window.isDestroyed()) window.destroy();
    app.quit();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  app.exit(1);
});

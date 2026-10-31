"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' data:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'"
].join("; ");

function registerGraphicsScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{
    scheme: "clicky-graphics",
    privileges: { standard: true, secure: true, supportFetchAPI: true }
  }]);
}

function registerGraphicsProtocol(protocol) {
  const frameHtml = fs.readFileSync(path.join(__dirname, "graphics-frame.html"), "utf8");
  protocol.handle("clicky-graphics", (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.hostname !== "frame" || url.pathname !== "/" || url.search || url.hash) {
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    return new Response(frameHtml, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": FRAME_CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer"
      }
    });
  });
}

module.exports = { registerGraphicsScheme, registerGraphicsProtocol };

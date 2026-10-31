"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Three.js 0.187 splits its browser module into three.module.js and
// three.core.js. Rewrite that sole relative import as a nested data module so
// both files can load in the opaque-origin graphics frame without file/network
// access. Fail closed if a future Three.js release changes the bundle layout.
module.exports = function loadThreeModuleBase64() {
  const threeEntry = require.resolve("three");
  const buildDir = path.dirname(threeEntry);
  const moduleSource = fs.readFileSync(path.join(buildDir, "three.module.js"), "utf8");
  const coreBase64 = fs.readFileSync(path.join(buildDir, "three.core.js")).toString("base64");
  const relativeImports = [...moduleSource.matchAll(/\bfrom\s*["'](\.\/[^"']+)["']/g)].map((match) => match[1]);
  if (relativeImports.length === 0 || relativeImports.some((specifier) => specifier !== "./three.core.js")) {
    throw new Error(`Unexpected Three.js module imports: ${relativeImports.join(", ") || "none"}`);
  }
  const embeddedCore = `data:text/javascript;base64,${coreBase64}`;
  const bundledSource = moduleSource.replace(/\bfrom\s*(["'])\.\/three\.core\.js\1/g, `from "${embeddedCore}"`);
  return Buffer.from(bundledSource, "utf8").toString("base64");
};

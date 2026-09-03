// Drop-in replacement for extract-zip used ONLY by pack.js: under the pixi
// Node (26.x) extract-zip stalls silently on the 136 MB Electron archive
// (the event loop drains after the first directory entry — the packager
// exits 0/1 with nothing extracted). Shell out to the platform's unzipper
// instead; same signature: extract(zipPath, { dir }) -> Promise<void>.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");

module.exports = function extract(zipPath, { dir }) {
  fs.mkdirSync(dir, { recursive: true });
  const [cmd, args] = process.platform === "win32"
    ? ["powershell", ["-NoProfile", "-NonInteractive", "-Command",
        `Expand-Archive -Force -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}'`]]
    : ["unzip", ["-oq", zipPath, "-d", dir]];
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    p.on("error", reject);
    p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
  });
};

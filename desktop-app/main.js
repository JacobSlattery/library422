// Library 422 — desktop shell (Electron, portable: runs from a folder or a
// flash drive, no installer). The SAME web app as app.library422.org: the
// static files are served from `www/` over a private app:// origin (module
// scripts and workers need a real origin; file:// blocks them), and the data
// layer is Node's built-in SQLite reading the full databases straight from
// disk (backend.js) — nothing is copied into browser storage, so the first
// start is instant. The renderer reaches it through preload.js
// (window.desktopDB), which app/js/db.js prefers over its Web Worker.
"use strict";
const { app, BrowserWindow, protocol, ipcMain, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { Backend } = require("./backend");

// packaged: resources/www + resources/data; development: ./www + ./data
const RES = app.isPackaged ? process.resourcesPath : __dirname;
const WWW = path.join(RES, "www");
const DATA = path.join(RES, "data");

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png",
  ".onnx": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
};

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

let backend = null;

function serveFile(req) {
  const url = new URL(req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(WWW, rel));
  if (!file.startsWith(WWW)) return new Response("forbidden", { status: 403 });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory())
    return new Response("not found", { status: 404 });
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  return new Response(fs.readFileSync(file), { headers: { "content-type": type } });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 720, minHeight: 520,
    backgroundColor: "#14161d",
    title: "Library 422",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL("app://library422/index.html");
  // external links (licence sources etc.) open in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  protocol.handle("app", serveFile);
  backend = new Backend(DATA);
  ipcMain.handle("db", async (_ev, action, args) => backend.handle(action, args ?? {}));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  backend?.close();
  app.quit();
});

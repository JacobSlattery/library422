// Bridge between the sandboxed page and the SQLite backend in the main
// process. app/js/db.js uses window.desktopDB.rpc(action, args) when it
// exists instead of spinning up its Web Worker; the action names and result
// shapes are identical (see backend.js).
"use strict";
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopDB", {
  rpc: (action, args) => ipcRenderer.invoke("db", action, args),
  edition: "desktop",
});

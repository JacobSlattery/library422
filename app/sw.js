// Service worker: caches the app shell so the app itself opens with no network.
// The database is NOT handled here — it lives in OPFS via the worker; /data/
// requests are intentionally never cached (the app verifies + stores them once).
//
// The semantic-search embedder (~60 MB under vendor/embedder/) is NOT part of
// the shell: it is fetched only when the user turns on Ask AI and downloads
// the AI search data, then kept in its own cache (cache-first, survives shell
// updates) so it never has to be pulled twice.
const VERSION = "shell-v3";
const EMBEDDER = "embedder-v1";   // bump when the vendored model/runtime changes
const KEEP = new Set([VERSION, EMBEDDER]);
const SHELL = [
  ".",
  "index.html",
  "css/style.css",
  "js/app.js",
  "js/db.js",
  "js/llm.js",
  "js/readaloud.js",
  "js/annotations.js",
  "js/worker.js",
  "vendor/map/levant.json",
  "vendor/sqlite-wasm/sqlite3.mjs",
  "vendor/sqlite-wasm/sqlite3.wasm",
  "manifest.webmanifest",
  "version.json",
  "icons/icon.svg",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KEEP.has(k))
                                       .map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

// page -> SW: drop the embedder cache (user removed the AI search data)
self.addEventListener("message", (e) => {
  if (e.data?.type === "drop-embedder") {
    e.waitUntil(caches.delete(EMBEDDER).catch(() => {}));
  }
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/data/")) return; // DB chunks: app-managed, never SW-cached

  // embedder assets: cache-first (big, immutable per EMBEDDER version)
  if (url.pathname.includes("/vendor/embedder/")) {
    e.respondWith(
      caches.open(EMBEDDER).then((c) =>
        c.match(e.request, { ignoreSearch: true }).then((hit) => hit ?? fetch(e.request)
          .then((res) => {
            if (res.ok && res.status === 200) c.put(e.request, res.clone()).catch(() => {});
            return res;
          }))));
    return;
  }

  // Network-first so shell updates land on refresh; cache fallback = offline start.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // only replace the cached copy with a GOOD response — a 404 during a
        // deploy must not become the offline version of the app
        if (res.ok && res.status === 200) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy))
            .catch(() => {});
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true })
          .then((hit) => hit ?? (e.request.mode === "navigate"
            ? caches.match("index.html")
            : Response.error()))));
});

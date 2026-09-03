// Dedicated worker: owns SQLite WASM, the OPFS databases, downloads and queries.
//
// The data ships as a CATALOG (app/CATALOG.md; manifest version 5). Two
// family main databases — `core` (bible: shared tables, search index) and
// `library` (works: the catalogue) — install at first launch together with
// the default items (WEB, Young's Literal). Every other unit — one Bible
// text, one testament of word tagging, one lexicon, one Library work… — is an
// ITEM: a small SQLite file whose rows are IMPORTED into the family main
// database on install (ATTACH, INSERT … SELECT, FTS rows added, recorded in
// installed_items) and deleted again on removal. One connection per family,
// any number of items, and the app's SQL never changes.
// `vectors` (the AI search index) is its own connection, only opened when
// installed; the query embedder (~60 MB vendored) is fetched only by
// warmEmbedder(), the user's explicit download.
import sqlite3InitModule from "../vendor/sqlite-wasm/sqlite3.mjs";

const FAMILY_MAIN = { bible: "core", works: "library" };
const MAINS = Object.values(FAMILY_MAIN);
const KEEP_FILES = new Set(["/core.db", "/library.db", "/vectors.db"]);
const TMP = "_item";

// external-content FTS tables need explicit rows added / removed
const FTS = {
  verses: {
    add: "INSERT INTO verses_fts(rowid, body_plain) SELECT rowid, body_plain FROM verses_plain WHERE rowid > ?",
    del: (where) => `INSERT INTO verses_fts(verses_fts, rowid, body_plain)
      SELECT 'delete', rowid, body_plain FROM verses_plain
      WHERE rowid IN (SELECT rowid FROM verses WHERE ${where})`,
  },
  work_pages: {
    add: "INSERT INTO work_pages_fts(rowid, body) SELECT rowid, body FROM work_pages WHERE rowid > ?",
    del: (where) => `INSERT INTO work_pages_fts(work_pages_fts, rowid, body)
      SELECT 'delete', rowid, body FROM work_pages WHERE ${where}`,
  },
  work_notes: {
    add: "INSERT INTO work_notes_fts(rowid, body) SELECT rowid, body FROM work_notes WHERE rowid > ?",
    del: (where) => `INSERT INTO work_notes_fts(work_notes_fts, rowid, body)
      SELECT 'delete', rowid, body FROM work_notes WHERE ${where}`,
  },
};

let poolUtil = null;
const dbs = {};              // family ("bible" | "works" | "vectors") -> oo1 db handle
let manifest = null;         // last fetched data manifest (null when offline)

const post = (msg) => self.postMessage(msg);
const progress = (phase, loaded, total, label) =>
  post({ type: "progress", phase, loaded, total, label });

async function sha256hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const versionStamp = (hex) => parseInt(hex.slice(0, 8), 16) | 0;

async function fetchManifest() {
  const res = await fetch("../data/manifest.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  const m = await res.json();
  if (m?.version !== 5)
    throw new Error(`unsupported data manifest version ${m?.version}`);
  return m;
}

// ---- chunk staging ---------------------------------------------------------
// Verified chunks are staged (Cache API when available, else memory) keyed by
// their sha256, so a reload after a dropped connection resumes instead of
// restarting, and only ONE chunk is in RAM at a time during install.
const STAGE_CACHE = "data-staging-v1";
const memStage = new Map();
let stageCache = null;
async function openStage() {
  if (stageCache !== null) return stageCache;
  try { stageCache = (await self.caches?.open(STAGE_CACHE)) ?? false; }
  catch { stageCache = false; }
  return stageCache;
}
const stageKey = (sha) => `/staging/${sha}`;
async function stageGet(sha) {
  if (memStage.has(sha)) return memStage.get(sha);
  const c = await openStage();
  if (!c) return null;
  const hit = await c.match(stageKey(sha));
  return hit ? new Uint8Array(await hit.arrayBuffer()) : null;
}
async function stagePut(sha, bytes) {
  const c = await openStage();
  if (c) {
    try { await c.put(stageKey(sha), new Response(bytes)); return; }
    catch { /* quota or unsupported: fall back to memory */ }
  }
  memStage.set(sha, bytes);
}
async function stageDelete(sha) {
  memStage.delete(sha);
  const c = await openStage();
  if (c) await c.delete(stageKey(sha)).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// fetch + verify one chunk, with retries; returns the bytes (also staged)
async function fetchChunk(chunk, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`../data/${chunk.name}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`${chunk.name}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length !== chunk.size)
        throw new Error(`${chunk.name}: size mismatch (${bytes.length})`);
      if (await sha256hex(bytes) !== chunk.sha256)
        throw new Error(`${chunk.name}: checksum mismatch — refusing to install`);
      await stagePut(chunk.sha256, bytes);
      return bytes;
    } catch (e) {
      lastErr = e;
      if (/checksum|HTTP 4\d\d/.test(String(e.message))) break;  // not transient
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

// Phase 1 (network, may fail): every chunk fetched + verified + staged.
async function downloadChunks(name, entry) {
  let offset = 0;
  for (const chunk of entry.chunks) {
    progress("download", offset, entry.gz_size, name);
    if (!(await stageGet(chunk.sha256))) await fetchChunk(chunk);
    offset += chunk.size;
    progress("download", offset, entry.gz_size, name);
  }
}

// Phase 2 (local): stream staged chunks -> gunzip -> OPFS file `/<file>.db`.
// The pool's importDb(name, fn) pulls decompressed pieces one at a time, so
// the full raw DB never sits in memory.
async function installFromStage(file, entry, label) {
  const path = `/${file}.db`;
  const chunks = entry.chunks;
  let ci = 0;
  const gzStream = new ReadableStream({
    async pull(controller) {
      if (ci >= chunks.length) { controller.close(); return; }
      const bytes = await stageGet(chunks[ci].sha256);
      if (!bytes) throw new Error(`${chunks[ci].name}: staged chunk vanished`);
      ci++;
      controller.enqueue(bytes);
    },
  });
  const reader = gzStream.pipeThrough(new DecompressionStream("gzip")).getReader();
  let done = false, nRead = 0;
  progress("install", 0, entry.db_size, label);
  const next = async () => {
    if (done) return undefined;
    const r = await reader.read();
    if (r.done) { done = true; return undefined; }
    nRead += r.value.byteLength;
    progress("install", Math.min(nRead, entry.db_size), entry.db_size, label);
    return r.value;
  };
  let nWrote;
  try {
    nWrote = await poolUtil.importDb(path, next);
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
  if (nWrote !== entry.db_size) {
    try { poolUtil.unlink(path); } catch { /* nothing to remove */ }
    throw new Error(`${label}: decompressed size mismatch — refusing to install`);
  }
  const d = new poolUtil.OpfsSAHPoolDb(path);
  d.exec(`PRAGMA user_version = ${versionStamp(entry.db_version)}`);
  d.close();
  progress("install", entry.db_size, entry.db_size, label);
  for (const c of chunks) await stageDelete(c.sha256);
}

// ---- catalogue bookkeeping ------------------------------------------------
const items = () => manifest?.items ?? {};
const order = () => manifest?.order ?? Object.keys(items());
const fileExists = (name) => poolUtil.getFileNames().includes(`/${name}.db`);
const unlinkFile = (name) => { try { poolUtil.unlink(`/${name}.db`); } catch { /* gone */ } };

function fileStale(name, entry) {
  if (!entry || !fileExists(name)) return false;
  const d = new poolUtil.OpfsSAHPoolDb(`/${name}.db`);
  const current = d.selectValue("PRAGMA user_version");
  d.close();
  return current !== versionStamp(entry.db_version);
}

// installed items live in each family main's installed_items table
function installedVersions(family) {
  const db = dbs[family];
  if (!db) return new Map();
  try {
    return new Map(db.selectObjects("SELECT id, version FROM installed_items")
      .map((r) => [r.id, r.version]));
  } catch { return new Map(); }
}
const itemInstalled = (id) => {
  const e = items()[id];
  if (id === "vectors" || e?.family === "vectors") return fileExists("vectors");
  if (MAINS.includes(id)) return fileExists(id);
  const fam = e?.family ?? (id.startsWith("work-") ? "works" : "bible");
  return installedVersions(fam).has(id);
};

async function ensureCapacity(n) {
  try {
    const cap = poolUtil.getCapacity();
    if (cap < n) await poolUtil.addCapacity(n - cap);
  } catch { /* capacity APIs missing: proceed with what we have */ }
}

async function storageCheck(ids) {
  // fail early with a readable message instead of dying mid-install
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est?.quota) return;
    const need = ids.filter((id) => !itemInstalled(id))
      .reduce((s, id) => s + (items()[id]?.db_size ?? 0) + (items()[id]?.gz_size ?? 0), 0);
    const free = est.quota - (est.usage ?? 0);
    if (need && free < need)
      throw new Error(`Not enough storage: this needs about ${Math.round(need / 1e6)} MB ` +
                      `and this browser allows ${Math.round(free / 1e6)} MB.`);
  } catch (e) {
    if (/Not enough storage/.test(e.message)) throw e;
  }
}

// ---- connections -----------------------------------------------------------
function closeAll() {
  for (const k of Object.keys(dbs)) {
    try { dbs[k].close(); } catch { /* already closed */ }
    delete dbs[k];
  }
  for (const k of Object.keys(vecSets)) delete vecSets[k];
}
function openAll() {
  closeAll();
  for (const [family, main] of Object.entries(FAMILY_MAIN)) {
    if (fileExists(main)) dbs[family] = new poolUtil.OpfsSAHPoolDb(`/${main}.db`);
  }
  if (fileExists("vectors")) dbs.vectors = new poolUtil.OpfsSAHPoolDb("/vectors.db");
}

// ---- items: import / remove ------------------------------------------------
function removeRows(db, entry) {
  for (const [table, where, params] of entry.tables) {
    if (FTS[table]) db.exec({ sql: FTS[table].del(where), bind: params });
    db.exec({ sql: `DELETE FROM "${table}" WHERE ${where}`, bind: params });
  }
}

// download the item file, then copy its rows into the family main database
async function importItem(id, entry) {
  await downloadChunks(id, entry);
  unlinkFile(TMP);
  await installFromStage(TMP, entry, id);
  const db = dbs[entry.family];
  if (!db) throw new Error(`${id}: its main database is not installed`);
  db.exec(`ATTACH '/${TMP}.db' AS item`);
  try {
    db.exec("BEGIN");
    if (installedVersions(entry.family).has(id)) removeRows(db, entry);   // update
    let i = 0;
    for (const [table] of entry.tables) {
      progress("merge", i++, entry.tables.length, id);
      const before = FTS[table]
        ? db.selectValue(`SELECT COALESCE(MAX(rowid), 0) FROM "${table}"`) : 0;
      db.exec(`INSERT INTO main."${table}" SELECT * FROM item."${table}"`);
      if (FTS[table]) db.exec({ sql: FTS[table].add, bind: [before] });
    }
    db.exec({ sql: "INSERT OR REPLACE INTO installed_items(id, version) VALUES (?, ?)",
              bind: [id, entry.db_version] });
    db.exec("COMMIT");
    progress("merge", entry.tables.length, entry.tables.length, id);
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* not in a transaction */ }
    throw e;
  } finally {
    try { db.exec("DETACH item"); } catch { /* ignore */ }
    unlinkFile(TMP);
  }
}

function removeItemRows(id, entry) {
  const db = dbs[entry.family];
  if (!db) return;
  db.exec("BEGIN");
  try {
    removeRows(db, entry);
    db.exec({ sql: "DELETE FROM installed_items WHERE id = ?", bind: [id] });
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw e;
  }
  try { db.exec("PRAGMA incremental_vacuum"); } catch { /* not incremental */ }
}

// a main or the vectors file: replace the whole file
async function installFile(id, entry) {
  await downloadChunks(id, entry);
  closeAll();
  unlinkFile(id);
  await installFromStage(id, entry, id);
  openAll();
}

// Pending updates: a newer version in the manifest for something we have.
// On the PWA route the app asks the user first; the APK (data bundled as
// assets) updates straight away.
const pendingUpdates = {};   // id -> manifest entry

async function installOne(id) {
  const entry = items()[id];
  if (!entry) throw new Error(`${id}: not offered by the server's data manifest`);
  if (entry.main || entry.family === "vectors") {
    if (fileExists(id) && !fileStale(id, entry)) return;
    // replacing a main loses its imported items: remember them and put them back
    const family = entry.main ? entry.family : null;
    const keep = family ? [...installedVersions(family).keys()] : [];
    await installFile(id, entry);
    for (const k of keep) {
      if (items()[k]) await importItem(k, items()[k]);
    }
  } else {
    const have = installedVersions(entry.family).get(id);
    if (have === entry.db_version) return;
    await importItem(id, entry);
  }
  delete pendingUpdates[id];
}

async function installItems(ids) {
  if (!manifest) manifest = await fetchManifest();
  await storageCheck(ids);
  for (const id of ids) await installOne(id);
  return summary();
}

function removeItem(id) {
  const entry = items()[id];
  if (MAINS.includes(id)) throw new Error(`${id}: the core databases cannot be removed`);
  if (id === "vectors" || entry?.family === "vectors") {
    closeAll();
    unlinkFile("vectors");
    openAll();
  } else {
    // offline (no manifest): reconstruct the row filters from the item id is
    // not possible, so removal needs the manifest entry
    if (!entry) throw new Error(`${id}: can't remove without the data manifest (offline?)`);
    removeItemRows(id, entry);
  }
  delete pendingUpdates[id];
  return summary();
}

// ---- status ----------------------------------------------------------------
function catalog() {
  const out = [];
  const known = manifest ? order() : [];
  const inst = { bible: installedVersions("bible"), works: installedVersions("works") };
  for (const id of known) {
    const e = items()[id];
    const isFile = e.main || e.family === "vectors";
    const installed = isFile ? fileExists(id) : inst[e.family]?.has(id) ?? false;
    const stale = isFile ? fileStale(id, e)
      : (installed && inst[e.family].get(id) !== e.db_version);
    out.push({
      id, family: e.family, main: !!e.main, kind: e.kind, group: e.group,
      title: e.title, blurb: e.blurb ?? "", default: !!e.default,
      text: e.text ?? null, work_id: e.work_id ?? null, slug: e.slug ?? null,
      category: e.category ?? null,
      installed, stale, available: true,
      gz_size: e.gz_size, db_size: e.db_size,
    });
  }
  if (!manifest) {
    // offline: report what is installed so the UI can still label things
    for (const fam of ["bible", "works"]) {
      for (const id of inst[fam].keys()) {
        out.push({ id, family: fam, main: false, kind: id.startsWith("work-") ? "work" : "layer",
                   group: "", title: id, blurb: "", default: false,
                   text: id.startsWith("text-") ? id.slice(5) : null,
                   work_id: null, slug: id.startsWith("work-") ? id.slice(5) : null,
                   category: null, installed: true, stale: false, available: false,
                   gz_size: 0, db_size: 0 });
      }
    }
    if (fileExists("vectors"))
      out.push({ id: "vectors", family: "vectors", main: false, kind: "vectors", group: "",
                 title: "AI search index", blurb: "", default: false, text: null, work_id: null,
                 slug: null, category: null, installed: true, stale: false, available: false,
                 gz_size: 0, db_size: 0 });
  }
  return out;
}

function summary() {
  const counts = dbs.bible.selectObjects(
    `SELECT (SELECT COUNT(*) FROM verses) AS verses,
            (SELECT COUNT(*) FROM words) AS words,
            (SELECT COUNT(*) FROM texts) AS texts`)[0];
  counts.library = dbs.works ? dbs.works.selectValue("SELECT COUNT(*) FROM works") : 0;
  const updates = {};
  for (const [id, e] of Object.entries(pendingUpdates))
    updates[id] = { gz_size: e.gz_size, db_size: e.db_size };
  return { counts, updates, packs: catalog() };
}

async function init({ autoUpdate = false } = {}) {
  const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: console.error });
  // The pool takes exclusive OPFS access handles. A page we navigated away
  // from (or one stashed in the back/forward cache) may still hold them for
  // a moment while its worker shuts down: retry briefly instead of failing.
  for (let attempt = 0; ; attempt++) {
    try {
      poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: "bible-pool", initialCapacity: 8 });
      break;
    } catch (e) {
      if (attempt >= 12 || !/Access Handle|access handle|NoModificationAllowedError/i.test(String(e?.message ?? e)))
        throw e;
      await sleep(500);
    }
  }
  await ensureCapacity(8);

  try {
    manifest = await fetchManifest();
  } catch (e) {
    manifest = null;
    if (!MAINS.every(fileExists))
      throw new Error("No database installed and can't reach server: " + e.message);
  }
  // earlier layouts (monolithic bible.db/works.db, attached packs, a stale
  // temp item file): free the space before installing the catalogue
  for (const f of poolUtil.getFileNames()) {
    if (!KEEP_FILES.has(f)) { try { poolUtil.unlink(f); } catch { /* ignore */ } }
  }
  // a main from the short-lived "packs" layout has the same file name but
  // no installed_items table: it is incompatible, not merely stale
  for (const id of MAINS) {
    if (!fileExists(id)) continue;
    const d = new poolUtil.OpfsSAHPoolDb(`/${id}.db`);
    let ok = false;
    try {
      ok = d.selectValue("SELECT COUNT(*) FROM sqlite_master WHERE name='installed_items'") > 0;
    } catch { ok = false; }
    d.close();
    if (!ok) unlinkFile(id);
  }
  // a main from an older catalogue format has no installed_items table; a
  // stale main is replaced (its items, if any, are re-imported)
  const freshInstall = { bible: false, works: false };
  const wanted = manifest ? [...MAINS, ...(manifest.defaults ?? [])] : [];
  await storageCheck(wanted.filter((id) => MAINS.includes(id)));
  const installed = {};
  for (const id of MAINS) {
    const entry = items()[id];
    if (!fileExists(id)) {
      if (!entry) throw new Error(`${id}: not installed and manifest unavailable`);
      await installFile(id, entry);
      installed[id] = true;
      freshInstall[entry.family] = true;
    } else if (entry && fileStale(id, entry)) {
      if (autoUpdate) { await installOne(id); installed[id] = true; }
      else pendingUpdates[id] = entry;
    }
  }
  openAll();
  // a fresh core gets the default Bible texts (the user can remove them later)
  if (manifest) {
    for (const id of manifest.defaults ?? []) {
      const e = items()[id];
      if (e && freshInstall[e.family] && !itemInstalled(id)) {
        await importItem(id, e);
        installed[id] = true;
      }
    }
  }
  // The APK carries the whole catalogue as assets, but installs only the
  // core + defaults at first launch like the web: everything else is one
  // tap away in Settings -> Catalog (served from the bundled assets, so it
  // works offline) and the phone's storage holds only what the user keeps.
  // updates to installed items / vectors are offered, never pulled at boot
  if (manifest) {
    for (const id of order()) {
      const e = items()[id];
      if (MAINS.includes(id) || !itemInstalled(id)) continue;
      const stale = e.family === "vectors" ? fileStale(id, e)
        : installedVersions(e.family).get(id) !== e.db_version;
      if (stale) {
        if (autoUpdate) await installOne(id); else pendingUpdates[id] = e;
      }
    }
  }
  return { installed, ...summary() };
}

// apply the pending updates (user said "update now")
async function applyUpdates() {
  for (const id of Object.keys(pendingUpdates)) await installOne(id);
  return summary();
}

// ---- semantic search (phase 3) --------------------------------------------
// Query embedding runs HERE via vendored transformers.js (all-MiniLM-L6-v2
// q8 ONNX — the same model that embedded the corpus at build time, see
// tools/build_embeddings.mjs). Corpus vectors are int8 blobs in vectors.db.
// The embedder files are fetched through the service worker's cache-first
// "embedder" cache: warmEmbedder() (the user's explicit download) fills it;
// a query never triggers the ~60 MB fetch on its own because semantic
// search is gated on vectors.db, which only exists after that download.
let embedder = null;
let embedderLoading = null;  // memoized promise: concurrent callers share one load
let embedderFailed = null;   // remember a hard failure; don't retry per query

function initEmbedder(onProgress = null) {
  if (embedder) return Promise.resolve();
  if (embedderFailed) return Promise.reject(embedderFailed);
  embedderLoading ??= (async () => {
    try {
      const { pipeline, env } =
        await import("../vendor/embedder/transformers.min.js");
      env.allowRemoteModels = false;   // fully offline — everything is vendored
      env.allowLocalModels = true;     // browser default is FALSE — must enable
      // ROOTED paths, not absolute URLs: transformers.js path-joins these and
      // collapses "http://" into "http:/" (breaks fetches silently)
      env.localModelPath = "/vendor/embedder/models/";
      env.backends.onnx.wasm.wasmPaths = "/vendor/embedder/";
      // no cross-origin isolation => no SharedArrayBuffer: stay single-threaded
      env.backends.onnx.wasm.numThreads = 1;
      // per-file progress from transformers.js -> one aggregate bar
      const files = new Map();
      const progress_callback = (ev) => {
        if (!onProgress || !ev?.file) return;
        if (ev.status === "progress") files.set(ev.file, [ev.loaded ?? 0, ev.total ?? 0]);
        else if (ev.status === "done") {
          const cur = files.get(ev.file);
          if (cur) files.set(ev.file, [cur[1] || cur[0], cur[1] || cur[0]]);
        }
        let loaded = 0, total = 0;
        for (const [l, t] of files.values()) { loaded += l; total += t; }
        onProgress(loaded, total);
      };
      embedder = await pipeline("feature-extraction",
        "Xenova/all-MiniLM-L6-v2", { dtype: "q8", progress_callback });
    } catch (e) {
      embedderFailed = e;
      throw e;
    }
  })();
  return embedderLoading;
}

// The user's explicit "download AI search data": fetch the embedder (the
// service worker keeps it), load it once, and answer a trivial query so the
// whole path is proven before we report success.
async function warmEmbedder() {
  embedderFailed = null;
  await initEmbedder((loaded, total) => progress("embedder", loaded, total, "embedder"));
  await embedder("warm up", { pooling: "mean", normalize: true });
  return true;
}

const vecSets = {};   // set name -> {int8, ids1, ids2, dims, n}

function loadVectors(setName) {
  if (vecSets[setName]) return vecSets[setName];
  if (!dbs.vectors) throw new Error("AI search data is not installed");
  const blob = (name) => {
    const rows = dbs.vectors.selectObjects(
      "SELECT data FROM vectors WHERE set_name=? AND name=?", [setName, name]);
    if (!rows.length) throw new Error(`vectors.db has no "${setName}" vectors`);
    // slice() re-bases to offset 0 so Int32Array views are aligned
    return rows[0].data.slice();
  };
  const info = JSON.parse(new TextDecoder().decode(blob("info")));
  vecSets[setName] = {
    int8: new Int8Array(blob("vecs").buffer),
    ids1: new Int32Array(blob("ids1").buffer),
    ids2: new Int32Array(blob("ids2").buffer),
    dims: info.dims,
    n: info.n,
  };
  return vecSets[setName];
}

// embed the query, brute-force int8 dot products, return top entries
// (optionally restricted by an ids1 allow-list, e.g. Bible book numbers)
async function semanticScan(dbName, question, keep, allow1 = null) {
  const v = loadVectors(dbName);   // gate FIRST: no vectors.db => no embedder fetch
  await initEmbedder();
  const out = await embedder(question, { pooling: "mean", normalize: true });
  const q8 = new Int8Array(v.dims);
  for (let d = 0; d < v.dims; d++) {
    q8[d] = Math.max(-127, Math.min(127, Math.round(out.data[d] * 127)));
  }
  const allow = allow1?.length ? new Set(allow1) : null;
  const top = [];   // sorted desc by s
  const { int8, dims, n } = v;
  for (let i = 0; i < n; i++) {
    if (allow && !allow.has(v.ids1[i])) continue;
    let s = 0;
    const off = i * dims;
    for (let d = 0; d < dims; d++) s += int8[off + d] * q8[d];
    if (top.length < keep || s > top[top.length - 1].s) {
      let lo = 0, hi = top.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (top[mid].s < s) hi = mid; else lo = mid + 1;
      }
      top.splice(lo, 0, { s, i });
      if (top.length > keep) top.pop();
    }
  }
  return top.map((t) => ({ id1: v.ids1[t.i], id2: v.ids2[t.i], s: t.s }));
}

async function semanticSearch(question, k = 12) {
  // works pages: dedupe chunk hits to pages, join citation metadata. Hits in
  // Library works that are not installed are dropped (no page to show).
  const top = await semanticScan("works", question, k * 6);
  const seen = new Set();
  const picks = [];
  for (const t of top) {
    const key = `${t.id1}:${t.id2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(t);
  }
  // same row shape as searchWorks so retrieve() can merge transparently
  const out = [];
  for (const p of picks) {
    const [w] = dbs.works.selectObjects(
      `SELECT w.id AS work_id, w.slug, w.title, w.pages,
              (SELECT s.title FROM work_sections s
               WHERE s.work_id = w.id AND s.page <= ?
               ORDER BY s.page DESC, s.section DESC LIMIT 1) AS section,
              (SELECT COUNT(*) FROM work_pages p WHERE p.work_id = w.id AND p.page = ?) AS have
       FROM works w WHERE w.id = ?`, [p.id2, p.id2, p.id1]);
    if (!w || !w.have) continue;
    delete w.have;
    out.push({ ...w, page: p.id2, snip: "", sem: p.s / (127 * 127) });
    if (out.length >= k) break;
  }
  return out;
}

async function semanticVerses(question, k = 20, bookNrs = null) {
  // bible.db WEB verses: ids1 = book_nr, ids2 = chapter*1000 + verse
  const top = await semanticScan("bible", question, k, bookNrs);
  return top.map((t) => {
    const chapter = Math.floor(t.id2 / 1000);
    const verse = t.id2 % 1000;
    const [row] = dbs.bible.selectObjects(
      `SELECT v.body, b.name AS book FROM verses v
       JOIN books b ON b.nr = v.book_nr
       WHERE v.text_id='web' AND v.book_nr=? AND v.chapter=? AND v.verse=?`,
      [t.id1, chapter, verse]);
    return { kind: "verse", book_nr: t.id1, chapter, verse,
             book: row?.book ?? `Book ${t.id1}`, body: row?.body ?? "",
             sem: t.s / (127 * 127) };
  });
}

self.onmessage = async (ev) => {
  const { id, action, args } = ev.data;
  try {
    let result;
    if (action === "init") {
      result = await init(args ?? {});
    } else if (action === "update") {
      result = await applyUpdates();
    } else if (action === "exec") {
      const db = dbs[args.db ?? "bible"];
      if (!db) throw new Error("database not ready");
      result = db.selectObjects(args.sql, args.bind ?? []);
    } else if (action === "semantic") {
      if (!dbs.works) throw new Error("database not ready");
      result = await semanticSearch(args.question, args.k ?? 12);
    } else if (action === "semanticVerses") {
      if (!dbs.bible) throw new Error("database not ready");
      result = await semanticVerses(args.question, args.k ?? 20, args.books);
    } else if (action === "packs") {
      result = catalog();
    } else if (action === "installPacks") {
      result = await installItems(args.names);
    } else if (action === "removePack") {
      result = removeItem(args.name);
    } else if (action === "warmEmbedder") {
      result = await warmEmbedder();
    } else {
      throw new Error(`unknown action: ${action}`);
    }
    post({ id, ok: true, result });
  } catch (e) {
    post({ id, ok: false, error: String(e.message ?? e) });
  }
};

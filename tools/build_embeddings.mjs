// Phase-3 semantic retrieval: embed the Library + the WEB verses and store
// the vectors in db/vectors.db — a SEPARATE, optional database (the app
// installs it only when the user turns on Ask AI, so the ~75 MB of vectors
// never inflate the base download).
//
// Chunks every works.db page (900 chars, stride 750, footnotes stripped),
// embeds with transformers.js all-MiniLM-L6-v2 q8 — the SAME runtime+model
// the app uses on-device to embed queries — unit-normalizes, quantizes to
// int8 (measured: zero recall loss vs float32; PCA variants lose recall,
// see testbed/vector_formats.py), and writes four blobs per SET into a
// `vectors(set, name, data)` table: vecs (int8 n*384), ids1 (int32 n),
// ids2 (int32 n), and an info JSON row. Sets: "works" (ids = work_id,
// page) and "bible" (ids = book_nr, chapter*1000+verse).
//
// Legacy: earlier builds wrote a `vectors` table INTO bible.db / works.db;
// this script drops those (and VACUUMs) so the base databases shrink.
//
// Run AFTER tools/build_works_db.py, BEFORE tools/build_app_bundle.py:
//   cd testbed && npm i @huggingface/transformers   (once, gitignored)
//   pixi run node tools/build_embeddings.mjs
// Cache: testbed/emb/<name>.f32 + <name>.keys, one sha1 per chunk TEXT, so
// only chunks whose text is new get embedded (adding a work costs minutes,
// not the ~75 min of a full re-embed; a wording fix re-embeds just that
// chunk). Vectors for identical text are bit-identical across rebuilds.
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
// Windows: import() requires file:// URLs, not paths
const importPkg = (name, from) =>
  import(pathToFileURL(require.resolve(name, { paths: [from] })).href);
const ROOT = new URL("..", import.meta.url).pathname
  .replace(/^\/([A-Za-z]:)/, "$1");
const DB = `${ROOT}/db/works.db`;
const BIBLE_DB = `${ROOT}/db/bible.db`;
const VEC_DB = `${ROOT}/db/vectors.db`;
const CACHE_DIR = `${ROOT}/testbed/emb`;
const CHUNK = 900, STRIDE = 750, DIMS = 384;
const MODEL = "Xenova/all-MiniLM-L6-v2";

// Incremental cache keyed PER CHUNK TEXT: <name>.f32 + <name>.keys (one
// sha1 per line, same order). Adding a work re-embeds only its chunks; an
// unchanged chunk anywhere in the corpus reuses its vector. (The previous
// whole-corpus .sha256 key is migrated on first run: same .f32, keys rebuilt.)
const chunkKey = (t) => createHash("sha1").update(`${MODEL}|q8|${DIMS}|`).update(t).digest("hex");
function cachedVectors(name, texts) {
  const vecs = `${CACHE_DIR}/${name}.f32`, keys = `${CACHE_DIR}/${name}.keys`;
  const legacy = `${CACHE_DIR}/${name}.sha256`;
  const want = texts.map(chunkKey);
  const f32 = new Float32Array(texts.length * DIMS);
  const missing = [];
  let hit = 0;
  let old = null;
  if (existsSync(vecs) && existsSync(keys)) {
    old = readFileSync(keys, "utf8").trim().split("\n");
  } else if (existsSync(vecs) && existsSync(legacy)) {
    // legacy whole-corpus cache: valid only if the corpus is unchanged, in
    // which case the old vectors line up 1:1 with today's chunks
    const h = createHash("sha256");
    h.update(`${MODEL}|q8|${DIMS}\n`);
    for (const t of texts) { h.update(t); h.update("\n "); }
    if (readFileSync(legacy, "utf8").trim() === h.digest("hex")) old = want;
  }
  if (old) {
    const oldF32 = new Float32Array(readFileSync(vecs).buffer.slice(0));
    if (old.length * DIMS === oldF32.length) {
      const where = new Map();
      old.forEach((k, i) => { if (!where.has(k)) where.set(k, i); });
      want.forEach((k, i) => {
        const j = where.get(k);
        if (j === undefined) missing.push(i);
        else { f32.set(oldF32.subarray(j * DIMS, (j + 1) * DIMS), i * DIMS); hit++; }
      });
      return { keys: want, f32, missing, hit };
    }
  }
  want.forEach((_, i) => missing.push(i));
  return { keys: want, f32, missing, hit };
}
function storeVectors(name, keys, f32) {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(`${CACHE_DIR}/${name}.f32`, new Uint8Array(f32.buffer));
  writeFileSync(`${CACHE_DIR}/${name}.keys`, keys.join("\n") + "\n");
}
// embed only the missing chunks into f32 (in place)
async function fillMissing(texts, f32, missing, batch, label) {
  if (!missing.length) return;
  const ex = await extractor();
  console.log(`model loaded — embedding ${missing.length} new ${label} chunks`);
  const t0 = Date.now();
  for (let i = 0; i < missing.length; i += batch) {
    const idx = missing.slice(i, i + batch);
    const out = await ex(idx.map((k) => texts[k]), { pooling: "mean", normalize: true });
    idx.forEach((k, j) => f32.set(out.data.subarray(j * DIMS, (j + 1) * DIMS), k * DIMS));
    if ((i / batch) % 100 === 0) {
      console.log(`  ${label} ${i}/${missing.length} ` +
        `(${(i / ((Date.now() - t0) / 1000) || 0).toFixed(0)}/s)`);
    }
  }
}
let extractorP = null;
const extractor = () => extractorP ??= importPkg(
  "@huggingface/transformers", `${ROOT}/testbed`)
  .then(({ pipeline }) => pipeline("feature-extraction", MODEL, { dtype: "q8" }));
async function embedAll(texts, batch, label) {
  const ex = await extractor();
  console.log(`model loaded — embedding ${label} from scratch`);
  const f32 = new Float32Array(texts.length * DIMS);
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i += batch) {
    const out = await ex(texts.slice(i, i + batch),
      { pooling: "mean", normalize: true });
    f32.set(out.data, i * DIMS);
    if ((i / batch) % 200 === 0) {
      console.log(`  ${label} ${i}/${texts.length} ` +
        `(${(i / ((Date.now() - t0) / 1000) || 0).toFixed(0)}/s)`);
    }
  }
  return f32;
}
// unit-normalize (already is, but cheap to be sure) then int8-quantize
function quantize(f32, n) {
  const int8 = new Int8Array(n * DIMS);
  for (let i = 0; i < n; i++) {
    let norm = 0;
    const off = i * DIMS;
    for (let d = 0; d < DIMS; d++) norm += f32[off + d] * f32[off + d];
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < DIMS; d++) {
      int8[off + d] = Math.max(-127, Math.min(127,
        Math.round((f32[off + d] / norm) * 127)));
    }
  }
  return int8;
}

const db = new DatabaseSync(DB);
const rows = db.prepare(
  "SELECT work_id, page, body FROM work_pages ORDER BY work_id, page").all();
console.log(`${rows.length} pages`);

const chunks = [];
const meta = [];
for (const { work_id, page, body } of rows) {
  const clean = body.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
  if (!clean) continue;
  if (clean.length <= CHUNK) {
    chunks.push(clean);
    meta.push([work_id, page]);
    continue;
  }
  for (let s = 0; s < clean.length - CHUNK / 2; s += STRIDE) {
    chunks.push(clean.slice(s, s + CHUNK));
    meta.push([work_id, page]);
  }
}
console.log(`${chunks.length} chunks`);

const wc = cachedVectors("works", chunks);
console.log(`Library embeddings: ${wc.hit} cached, ${wc.missing.length} to embed`);
await fillMissing(chunks, wc.f32, wc.missing, 32, "Library");
if (wc.missing.length || !existsSync(`${CACHE_DIR}/works.keys`)) storeVectors("works", wc.keys, wc.f32);
const f32 = wc.f32;

const int8 = quantize(f32, chunks.length);
const workIds = new Int32Array(meta.map((m) => m[0]));
const pages = new Int32Array(meta.map((m) => m[1]));

// ---- Bible verse vectors — power the Ask "verse route" -------------------
// One vector per WEB verse (modern English, public domain). Same blob
// schema as works: ids1 = book_nr, ids2 = chapter*1000 + verse.
const bdb = new DatabaseSync(BIBLE_DB);
const verses = bdb.prepare(
  `SELECT book_nr, chapter, verse, body FROM verses
   WHERE text_id='web' ORDER BY book_nr, chapter, verse`).all();
console.log(`${verses.length} WEB verses`);
const vtexts = verses.map((v) =>
  v.body.replace(/<[^<>\s]{1,8}>/g, "").replace(/\s+/g, " ").trim());
// cached like the Library: identical verse text -> identical bytes across
// rebuilds (int8 rounding otherwise depends on the runtime)
const vc = cachedVectors("verses", vtexts);
console.log(`verse embeddings: ${vc.hit} cached, ${vc.missing.length} to embed`);
await fillMissing(vtexts, vc.f32, vc.missing, 64, "verses");
if (vc.missing.length || !existsSync(`${CACHE_DIR}/verses.keys`)) storeVectors("verses", vc.keys, vc.f32);
const vint8 = quantize(vc.f32, verses.length);
const vids1 = new Int32Array(verses.map((v) => v.book_nr));
const vids2 = new Int32Array(verses.map((v) => v.chapter * 1000 + v.verse));

// ---- write db/vectors.db from scratch (deterministic: fresh file) --------
rmSync(VEC_DB, { force: true });
const vdb = new DatabaseSync(VEC_DB);
vdb.exec(`CREATE TABLE vectors (
  set_name TEXT NOT NULL, name TEXT NOT NULL, data BLOB NOT NULL,
  PRIMARY KEY (set_name, name)) WITHOUT ROWID`);
const ins = vdb.prepare("INSERT INTO vectors VALUES (?, ?, ?)");
const putSet = (set, vecs, ids1, ids2, info) => {
  ins.run(set, "vecs", new Uint8Array(vecs.buffer));
  ins.run(set, "ids1", new Uint8Array(ids1.buffer));
  ins.run(set, "ids2", new Uint8Array(ids2.buffer));
  ins.run(set, "info", new TextEncoder().encode(JSON.stringify(
    { model: MODEL, dtype: "q8", dims: DIMS, ...info })));
};
putSet("works", int8, workIds, pages,
  { chunk: CHUNK, stride: STRIDE, n: chunks.length, ids: ["work_id", "page"] });
putSet("bible", vint8, vids1, vids2,
  { kind: "verses", text: "web", n: verses.length,
    ids: ["book_nr", "chapter*1000+verse"] });
vdb.exec("VACUUM");
vdb.close();
console.log(`wrote ${chunks.length} x ${DIMS} Library + ${verses.length} x ${DIMS} ` +
  `verse int8 vectors (${((int8.length + vint8.length) / 1e6).toFixed(1)} MB) ` +
  `into db/vectors.db`);

// ---- legacy cleanup: vectors used to live inside the base databases -----
for (const [name, h] of [["works", db], ["bible", bdb]]) {
  const has = h.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='vectors'").get().n;
  if (has) {
    h.exec("DROP TABLE vectors");
    h.exec("VACUUM");
    console.log(`dropped the legacy vectors table from db/${name}.db`);
  }
  h.close();
}

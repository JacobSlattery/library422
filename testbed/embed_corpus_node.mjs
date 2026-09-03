// Embed the Library corpus with transformers.js (all-MiniLM-L6-v2 q8 ONNX) —
// the EXACT runtime/model the app ships on-device, so vectors and recall
// numbers transfer 1:1. Reads db/works.db via node:sqlite; writes raw
// float32 unit vectors + meta json for embed_recall.py.
//
// Usage: pixi run node testbed/embed_corpus_node.mjs
//        (npm i @huggingface/transformers in testbed/ first — gitignored)
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "node:fs";
import { pipeline } from "@huggingface/transformers";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const OUT = `${ROOT}/testbed/emb`;
const CHUNK = 900, STRIDE = 750;

const db = new DatabaseSync(`${ROOT}/db/works.db`);
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

const extractor = await pipeline(
  "feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
console.log("model loaded");

mkdirSync(OUT, { recursive: true });
const DIMS = 384, BATCH = 32;
const vecs = new Float32Array(chunks.length * DIMS);
const t0 = Date.now();
for (let i = 0; i < chunks.length; i += BATCH) {
  const batch = chunks.slice(i, i + BATCH);
  const out = await extractor(batch, { pooling: "mean", normalize: true });
  vecs.set(out.data, i * DIMS);
  if ((i / BATCH) % 100 === 0) {
    const rate = ((i + batch.length) / ((Date.now() - t0) / 1000)).toFixed(0);
    console.log(`  ${i + batch.length}/${chunks.length} (${rate}/s)`);
  }
}
writeFileSync(`${OUT}/vecs.f32`, Buffer.from(vecs.buffer));
writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${OUT}`);

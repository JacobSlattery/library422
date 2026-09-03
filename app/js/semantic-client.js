// Semantic search for the DESKTOP edition, run in the page: the same vendored
// query embedder the web worker uses (transformers.js + all-MiniLM-L6-v2 q8)
// and the same brute-force int8 scan, but the corpus vectors come from the
// Electron backend (vectors.db on disk) through the preload RPC, once per
// session. The web/APK route keeps doing this inside app/js/worker.js.
export function makeSemantic(rpc) {
  let embedder = null;
  let loading = null;
  const sets = {};   // set name -> {int8, ids1, ids2, dims, n}

  const initEmbedder = () => loading ??= (async () => {
    const { pipeline, env } = await import("../vendor/embedder/transformers.min.js");
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = "/vendor/embedder/models/";
    env.backends.onnx.wasm.wasmPaths = "/vendor/embedder/";
    env.backends.onnx.wasm.numThreads = 1;
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  })();

  async function loadVectors(set) {
    if (sets[set]) return sets[set];
    const blob = async (name) => {
      const raw = await rpc("vectorsBlob", { set, name });
      const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      return u8.slice();                       // own buffer, offset 0 (aligned views)
    };
    const info = JSON.parse(new TextDecoder().decode(await blob("info")));
    sets[set] = {
      int8: new Int8Array((await blob("vecs")).buffer),
      ids1: new Int32Array((await blob("ids1")).buffer),
      ids2: new Int32Array((await blob("ids2")).buffer),
      dims: info.dims, n: info.n,
    };
    return sets[set];
  }

  async function scan(set, question, keep, allow1 = null) {
    const v = await loadVectors(set);
    await initEmbedder();
    const out = await embedder(question, { pooling: "mean", normalize: true });
    const q8 = new Int8Array(v.dims);
    for (let d = 0; d < v.dims; d++) q8[d] = Math.max(-127, Math.min(127, Math.round(out.data[d] * 127)));
    const allow = allow1?.length ? new Set(allow1) : null;
    const top = [];
    const { int8, dims, n } = v;
    for (let i = 0; i < n; i++) {
      if (allow && !allow.has(v.ids1[i])) continue;
      let s = 0;
      const off = i * dims;
      for (let d = 0; d < dims; d++) s += int8[off + d] * q8[d];
      if (top.length < keep || s > top[top.length - 1].s) {
        let lo = 0, hi = top.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (top[mid].s < s) hi = mid; else lo = mid + 1; }
        top.splice(lo, 0, { s, i });
        if (top.length > keep) top.pop();
      }
    }
    return top.map((t) => ({ id1: v.ids1[t.i], id2: v.ids2[t.i], s: t.s }));
  }

  const exec = (db, sql, bind) => rpc("exec", { db, sql, bind });

  return {
    async warm() { await initEmbedder(); await embedder("warm up", { pooling: "mean", normalize: true }); return true; },

    async search(question, k = 12) {
      const top = await scan("works", question, k * 6);
      const seen = new Set();
      const out = [];
      for (const t of top) {
        const key = `${t.id1}:${t.id2}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const [w] = await exec("works",
          `SELECT w.id AS work_id, w.slug, w.title, w.pages,
                  (SELECT s.title FROM work_sections s WHERE s.work_id = w.id AND s.page <= ?
                   ORDER BY s.page DESC, s.section DESC LIMIT 1) AS section
           FROM works w WHERE w.id = ?`, [t.id2, t.id1]);
        if (!w) continue;
        out.push({ ...w, page: t.id2, snip: "", sem: t.s / (127 * 127) });
        if (out.length >= k) break;
      }
      return out;
    },

    async verses(question, k = 20, bookNrs = null) {
      const top = await scan("bible", question, k, bookNrs);
      const out = [];
      for (const t of top) {
        const chapter = Math.floor(t.id2 / 1000), verse = t.id2 % 1000;
        const [row] = await exec("bible",
          `SELECT v.body, b.name AS book FROM verses v JOIN books b ON b.nr = v.book_nr
           WHERE v.text_id='web' AND v.book_nr=? AND v.chapter=? AND v.verse=?`, [t.id1, chapter, verse]);
        out.push({ kind: "verse", book_nr: t.id1, chapter, verse, book: row?.book ?? `Book ${t.id1}`,
                   body: row?.body ?? "", sem: t.s / (127 * 127) });
      }
      return out;
    },
  };
}

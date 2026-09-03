"""Does semantic (embedding) retrieval find the pages BM25 misses?

Tests the known semantic-gap questions: the answer's key term (Hermon,
Eleazar, pears, Vespasian...) appears nowhere in the question's vocabulary,
so lexical search can't bridge it. Gold pages are derived from works.db by
FTS on the ANSWER text (self-verifying ground truth), then we check whether
the question's embedding lands a gold page in the top-k chunks.

Prereqs: corpus.npz built (embed_corpus.py), embedding server on :8082.
Usage:   pixi run python testbed/embed_recall.py
"""
import json
import sqlite3
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "db" / "works.db"
EMBED_URL = "http://localhost:8082/v1/embeddings"

TESTS = [(t["id"], t["q"], t["slug"], t["gold"]) for t in json.loads(
    (Path(__file__).parent / "recall_tests.json").read_text(encoding="utf-8"))]


def embed(texts):
    body = json.dumps({"input": texts}).encode()
    req = urllib.request.Request(EMBED_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.load(r)
    return np.asarray([d["embedding"] for d in out["data"]], dtype=np.float32)


def load_corpus():
    emb = ROOT / "testbed" / "emb"
    if (emb / "vecs.f32").exists():          # node transformers.js output
        vecs = np.fromfile(emb / "vecs.f32", dtype=np.float32).reshape(-1, 384)
        meta = np.asarray(json.loads((emb / "meta.json").read_text()),
                          dtype=np.int32)
        return vecs, meta[:, 0], meta[:, 1]
    data = np.load(emb / "corpus.npz")       # llama.cpp output
    return data["vecs"], data["work_ids"], data["pages"]


def main():
    vecs, work_ids, pages = load_corpus()
    con = sqlite3.connect(DB)
    slug_of = dict(con.execute("SELECT id, slug FROM works"))

    qfile = ROOT / "testbed" / "emb" / "queries.f32"
    if qfile.exists():                       # same-runtime (transformers.js)
        qvecs = np.fromfile(qfile, dtype=np.float32).reshape(-1, 384)
    else:
        qvecs = embed([q for _, q, _, _ in TESTS])
    qvecs /= np.linalg.norm(qvecs, axis=1, keepdims=True).clip(min=1e-9)

    for (tid, q, slug_sub, gold_q), qv in zip(TESTS, qvecs):
        gold = set(con.execute(
            "SELECT wp.work_id, wp.page FROM work_pages_fts f "
            "JOIN work_pages wp ON wp.rowid = f.rowid "
            "JOIN works w ON w.id = wp.work_id "
            "WHERE work_pages_fts MATCH ? AND w.slug LIKE ?",
            (gold_q, f"%{slug_sub}%")).fetchall())
        if not gold:
            print(f"!! {tid}: gold FTS query found nothing — fix the query")
            continue
        sims = vecs @ qv
        order = np.argsort(-sims)
        seen_pages = []          # distinct (work,page) by best chunk
        for idx in order:
            key = (int(work_ids[idx]), int(pages[idx]))
            if key not in seen_pages:
                seen_pages.append(key)
            if len(seen_pages) >= 20:
                break
        hit_at = next((i + 1 for i, key in enumerate(seen_pages)
                       if key in gold), None)
        top3 = [f"{slug_of[w][:18]}:{p}" for w, p in seen_pages[:3]]
        mark = "HIT " if hit_at and hit_at <= 8 else "miss"
        print(f"[{mark}] {tid:16s} gold@{hit_at}  "
              f"(gold pages: {len(gold)})  top3: {top3}")
    con.close()


main()

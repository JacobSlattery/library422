"""Which vector format ships? Compare recall@8 on recall_tests.json:
  A. chunk-level float32 (prototype baseline, 321 MB - reference only)
  B. chunk-level PCA-128 int8 (~27 MB)
  C. chunk-level PCA-192 int8 (~40 MB)
  D. page-mean float32->int8 384d (~6.5 MB)
Usage: pixi run python testbed/vector_formats.py  (needs testbed/emb/*)
"""
import json
import sqlite3
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
EMB = ROOT / "testbed" / "emb"

vecs = np.fromfile(EMB / "vecs.f32", dtype=np.float32).reshape(-1, 384)
meta = np.asarray(json.loads((EMB / "meta.json").read_text()), dtype=np.int32)
work_ids, pages = meta[:, 0], meta[:, 1]
qvecs = np.fromfile(EMB / "queries.f32", dtype=np.float32).reshape(-1, 384)
qvecs /= np.linalg.norm(qvecs, axis=1, keepdims=True).clip(min=1e-9)

tests = json.loads((ROOT / "testbed" / "recall_tests.json").read_text())
con = sqlite3.connect(ROOT / "db" / "works.db")
slug_of = dict(con.execute("SELECT id, slug FROM works"))

golds = []
for t in tests:
    golds.append(set(con.execute(
        "SELECT wp.work_id, wp.page FROM work_pages_fts f "
        "JOIN work_pages wp ON wp.rowid=f.rowid "
        "JOIN works w ON w.id=wp.work_id "
        "WHERE work_pages_fts MATCH ? AND w.slug LIKE ?",
        (t["gold"], f"%{t['slug']}%")).fetchall()))


def recall_at(cvecs, cwork, cpage, qv_all, k=8):
    hits = 0
    detail = []
    for qi, gold in enumerate(golds):
        sims = cvecs @ qv_all[qi]
        order = np.argsort(-sims)
        seen = []
        for idx in order:
            key = (int(cwork[idx]), int(cpage[idx]))
            if key not in seen:
                seen.append(key)
            if len(seen) >= k:
                break
        ok = any(key in gold for key in seen)
        hits += ok
        detail.append("Y" if ok else "-")
    return hits, "".join(detail)


def to_int8(m):
    m = m / np.linalg.norm(m, axis=1, keepdims=True).clip(min=1e-9)
    return np.clip(np.round(m * 127), -127, 127).astype(np.int8)


# A. baseline
h, d = recall_at(vecs, work_ids, pages, qvecs)
print(f"A chunk-f32 384d      : {h}/10 [{d}]  (321 MB)")

# PCA fit on a 60k sample
rng = np.random.default_rng(7)
sample = vecs[rng.choice(len(vecs), 60000, replace=False)]
mean = sample.mean(axis=0)
_, _, Vt = np.linalg.svd(sample - mean, full_matrices=False)

h, d = recall_at(to_int8(vecs).astype(np.float32), work_ids, pages, qvecs)
print(f"E chunk-int8 384d     : {h}/10 [{d}]  (~80 MB)")

for dims, label, mb in [(128, "B chunk-PCA128 int8", 27), (192, "C chunk-PCA192 int8", 40), (256, "F chunk-PCA256 int8", 53)]:
    P = Vt[:dims].T                       # 384 x dims
    cv = to_int8((vecs - mean) @ P).astype(np.float32)
    qv = ((qvecs - mean) @ P)
    qv /= np.linalg.norm(qv, axis=1, keepdims=True).clip(min=1e-9)
    h, d = recall_at(cv, work_ids, pages, qv)
    print(f"{label}  : {h}/10 [{d}]  (~{mb} MB)")

# D. page-mean 384 int8
keys = work_ids.astype(np.int64) * 100000 + pages
order = np.argsort(keys, kind="stable")
uk, starts = np.unique(keys[order], return_index=True)
pm = np.add.reduceat(vecs[order], starts, axis=0)
pm_work = (uk // 100000).astype(np.int32)
pm_page = (uk % 100000).astype(np.int32)
pmq = to_int8(pm).astype(np.float32)
h, d = recall_at(pmq, pm_work, pm_page, qvecs)
print(f"D page-mean int8 384d : {h}/10 [{d}]  (~6.5 MB)")

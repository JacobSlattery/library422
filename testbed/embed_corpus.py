"""Embed the whole Library (works.db pages, chunked) with all-MiniLM-L6-v2
served by llama.cpp — the same weights the app would run on-device via ONNX,
so desktop recall numbers transfer.

Prereq: pixi run llama-server -m models/all-MiniLM-L6-v2-Q8_0.gguf
            --embedding --pooling mean -c 512 -b 4096 -ub 4096 --port 8082
        (NO --parallel: slots split the 512-token ctx and everything 400s)
Usage:  pixi run python testbed/embed_corpus.py
Output: testbed/emb/corpus.npz (float32 unit vectors + work_id/page arrays)
"""
import json
import re
import sqlite3
import time
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "db" / "works.db"
OUTDIR = ROOT / "testbed" / "emb"
EMBED_URL = "http://localhost:8082/v1/embeddings"

CHUNK = 900       # ~225 tokens: safe inside MiniLM's 512 limit even for
STRIDE = 750      # token-heavy Greek/transliteration text
BATCH = 64

FOOTNOTE = re.compile(r"\[\d+\]")
WS = re.compile(r"\s+")


def chunks_of(body):
    body = WS.sub(" ", FOOTNOTE.sub("", body)).strip()
    if len(body) <= CHUNK:
        return [body] if body else []
    out = []
    for start in range(0, len(body) - CHUNK // 2, STRIDE):
        out.append(body[start:start + CHUNK])
    return out


def embed_raw(texts):
    body = json.dumps({"input": texts}).encode()
    req = urllib.request.Request(EMBED_URL, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        out = json.load(r)
    return [d["embedding"] for d in out["data"]]


def embed(texts):
    """Batch embed; on 400 (a chunk tokenizing past the 512-token window —
    Greek/transliteration text runs heavy) fall back to per-item with
    progressive truncation."""
    try:
        return embed_raw(texts)
    except urllib.error.HTTPError:
        out = []
        for t in texts:
            while True:
                try:
                    out.append(embed_raw([t])[0])
                    break
                except urllib.error.HTTPError:
                    if len(t) < 100:
                        out.append([0.0] * 384)
                        break
                    t = t[: len(t) // 2]
        return out


def main():
    OUTDIR.mkdir(exist_ok=True)
    con = sqlite3.connect(DB)
    rows = con.execute(
        "SELECT work_id, page, body FROM work_pages ORDER BY work_id, page"
    ).fetchall()
    con.close()
    print(f"{len(rows)} pages")

    texts, meta = [], []
    for work_id, page, body in rows:
        for c in chunks_of(body):
            texts.append(c)
            meta.append((work_id, page))
    print(f"{len(texts)} chunks")

    vecs = np.empty((len(texts), 384), dtype=np.float32)
    t0 = time.time()
    for i in range(0, len(texts), BATCH):
        batch = texts[i:i + BATCH]
        embs = embed(batch)
        vecs[i:i + len(embs)] = np.asarray(embs, dtype=np.float32)
        if (i // BATCH) % 50 == 0:
            rate = (i + len(batch)) / max(time.time() - t0, 1e-9)
            print(f"  {i + len(batch)}/{len(texts)}  ({rate:.0f}/s)", flush=True)
    vecs /= np.linalg.norm(vecs, axis=1, keepdims=True).clip(min=1e-9)

    meta_arr = np.asarray(meta, dtype=np.int32)
    np.savez(OUTDIR / "corpus.npz", vecs=vecs,
             work_ids=meta_arr[:, 0], pages=meta_arr[:, 1])
    print(f"saved {vecs.shape} in {(time.time() - t0):.0f}s "
          f"-> {OUTDIR / 'corpus.npz'}")


main()

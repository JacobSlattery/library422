"""Verify suite expectations against works.db, replicating app retrieval
(keywords -> ligature-expanded AND, then OR; BM25 rank; top 4).

Usage: python testbed/verify_retrieval.py
"""
import json
import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STOP = set(("a an and are as at be but by does did do for from has have he her his i in is it its of on or "
  "she that the their there they this to was were what when where which who whom why will with you your about any").split())

def keywords(q):
    words = re.sub(r"[^\w\s'-]", " ", q.lower(), flags=re.UNICODE).split()
    return [w for w in words if len(w) > 2 and w not in STOP]

def quote(t):
    forms = {t,
             re.sub("ae", "æ", t, flags=re.I), re.sub("oe", "œ", t, flags=re.I),
             re.sub("æ", "ae", t, flags=re.I), re.sub("œ", "oe", t, flags=re.I)}
    quoted = [f'"{f}"' for f in forms]
    return f"({' OR '.join(quoted)})" if len(quoted) > 1 else quoted[0]

def retrieve(cur, q, want=4):
    terms = keywords(q)
    tries = [" AND ".join(quote(t) for t in terms),
             " OR ".join(quote(t) for t in terms)]
    seen, hits = set(), []
    for match in tries:
        try:
            rows = cur.execute("""
                SELECT w.slug, w.title, p.page,
                       snippet(work_pages_fts, 0, '<', '>', '…', 12)
                FROM work_pages_fts
                JOIN work_pages p ON p.rowid = work_pages_fts.rowid
                JOIN works w ON w.id = p.work_id
                WHERE work_pages_fts MATCH ?
                ORDER BY rank LIMIT ?""", (match, want * 3)).fetchall()
        except sqlite3.OperationalError as e:
            print("   query error:", e)
            rows = []
        for r in rows:
            key = (r[0], r[2])
            if key not in seen:
                seen.add(key)
                hits.append(r)
            if len(hits) >= want:
                return hits
        if len(hits) >= want:
            break
    return hits

def main():
    cur = sqlite3.connect(ROOT / "db" / "works.db").cursor()
    suite = json.loads((ROOT / "testbed" / "suite.json").read_text())
    ok = 0
    for t in suite["tests"]:
        hits = retrieve(cur, t["q"])
        top_slugs = [h[0] for h in hits[:3]]
        hit = any(t["expect_slug"] in s for s in top_slugs)
        mark = "PASS" if hit else "FAIL"
        if hit:
            ok += 1
        print(f"[{mark}] {t['id']}: expect {t['expect_slug']} in top3 -> {top_slugs}")
        for h in hits[:3]:
            print(f"    {h[0]} p.{h[2]}: {h[3][:90]}")
    print(f"\nretrieval hit@3: {ok}/{len(suite['tests'])}")

if __name__ == "__main__":
    main()

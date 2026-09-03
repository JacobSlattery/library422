"""Package the data catalog for the app: gzip, split into chunks, write a manifest.

Bundles the two family main databases (core, library), every catalog item in
db/items/ (built by tools/build_items.py — see app/CATALOG.md) and
db/vectors.db (the AI search index). The mains install at first launch with
the default items; everything else is fetched on the user's request.

Output (app/data/, gitignored — derived like db/):
    core.db.gz.000  library.db.gz.000  text-web.db.gz.000 ...  vectors.db.gz.000 ...
    manifest.json   {version: 5, defaults: [...], order: [...],
                     items: {id: {family, main, group, title, blurb, kind,
                                  text|work_id|slug|category, default,
                                  tables: [[table, where, params]],
                                  db_version, db_size, gz_size, chunks}}}

Deterministic: gzip mtime pinned to 0, fixed chunk size, sorted JSON keys.
Run AFTER build_items.py and build_embeddings.mjs. Stdlib only.
"""
import gzip
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

from build_items import MAIN, DEFAULT_TEXTS, catalogue   # tools/ is on sys.path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "app" / "data"
ITEM_DIR = ROOT / "db" / "items"
CHUNK = 20 * 1024 * 1024  # 20 MiB

VECTORS = {
    "family": "vectors", "group": "Ask AI (beta)", "title": "AI search index",
    "blurb": "Semantic search for Ask AI (beta): finds passages by meaning. "
             "Downloaded together with the query embedder.",
    "kind": "vectors", "tables": [],
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def check_db(path: Path) -> None:
    """Refuse to ship a truncated/corrupt database (an interrupted build)."""
    con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
    try:
        res = con.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        con.close()
    if res != "ok":
        raise SystemExit(f"{path}: integrity_check failed: {res}")


def bundle(name: str, path: Path) -> dict:
    check_db(path)
    raw = path.read_bytes()
    gz = gzip.compress(raw, compresslevel=9, mtime=0)
    chunks = []
    for i in range(0, len(gz), CHUNK):
        part = gz[i:i + CHUNK]
        fname = f"{name}.db.gz.{len(chunks):03d}"
        (OUT_DIR / fname).write_bytes(part)
        chunks.append({"name": fname, "size": len(part), "sha256": sha256(part)})
    return {
        "db_version": sha256(raw),
        "db_size": len(raw),
        "gz_size": len(gz),
        "chunks": chunks,
    }


def main() -> int:
    entries = []   # (id, spec, path, is_main)
    for pid, spec in MAIN.items():
        entries.append((pid, spec, ITEM_DIR / f"{pid}.db", True))
    for pid, spec in catalogue().items():
        entries.append((pid, spec, ITEM_DIR / f"{pid}.db", False))
    entries.append(("vectors", VECTORS, ROOT / "db" / "vectors.db", False))
    for pid, _, path, _ in entries:
        if not path.exists():
            print(f"{path} missing — run `pixi run build-items` (or `pixi run embed`) first",
                  file=sys.stderr)
            return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("*.db.gz.*"):
        old.unlink()
    manifest = {"version": 5, "order": [], "items": {},
                "defaults": [f"text-{t}" for t in DEFAULT_TEXTS]}
    first_load = 0
    for pid, spec, path, is_main in entries:
        entry = bundle(pid, path)
        entry.update({
            "family": spec["family"], "main": is_main,
            "group": spec["group"], "title": spec["title"], "blurb": spec.get("blurb", ""),
            "kind": "main" if is_main else spec["kind"],
            "default": bool(spec.get("default")),
            "tables": [list(t) for t in spec.get("tables", [])] if not is_main else [],
        })
        for k in ("text", "work_id", "slug", "category"):
            if k in spec:
                entry[k] = spec[k]
        manifest["items"][pid] = entry
        manifest["order"].append(pid)
        if is_main or entry["default"]:
            first_load += entry["gz_size"]
        print(f"  {pid:28s} {entry['gz_size']/1e6:6.1f} MB gz"
              + ("  (main)" if is_main else "  (default)" if entry["default"] else ""))
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"  {len(entries)} entries; first-launch download: {first_load/1e6:.1f} MB")
    print("Wrote app/data/manifest.json")
    write_site_catalog(manifest)
    return 0


def write_site_catalog(manifest: dict) -> None:
    """site/catalog.json — what the landing site's per-work / per-Bible pages are
    generated from (tools/build_site.py --landing). Small and committed, so the
    deploy workflow can build those pages without the databases."""
    con = sqlite3.connect(f"file:{(ROOT / 'db' / 'works.db').as_posix()}?mode=ro", uri=True)
    works = [dict(zip(("slug", "title", "category", "source", "pages"), r)) for r in con.execute(
        "SELECT slug, title, category, source, pages FROM works ORDER BY id")]
    con.close()
    con = sqlite3.connect(f"file:{(ROOT / 'db' / 'bible.db').as_posix()}?mode=ro", uri=True)
    langs = dict(con.execute("SELECT id, lang FROM texts"))
    books = {t: n for t, n in con.execute("SELECT text_id, COUNT(*) FROM text_books GROUP BY text_id")}
    con.close()
    texts = []
    for pid, e in manifest["items"].items():
        if e["kind"] != "text":
            continue
        texts.append({"id": e["text"], "title": e["title"], "blurb": e["blurb"], "group": e["group"],
                      "lang": langs.get(e["text"], ""), "books": books.get(e["text"], 0),
                      "mb": round(e["gz_size"] / 1e6, 1)})
    sizes = {e.get("slug"): round(e["gz_size"] / 1e6, 1) for e in manifest["items"].values() if e["kind"] == "work"}
    for w in works:
        w["mb"] = sizes.get(w["slug"], 0)
    out = ROOT / "site" / "catalog.json"
    out.write_text(json.dumps({"works": works, "texts": texts}, indent=1, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    print(f"Wrote site/catalog.json ({len(works)} works, {len(texts)} texts)")


if __name__ == "__main__":
    sys.exit(main())

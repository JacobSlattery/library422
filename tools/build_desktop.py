"""Assemble the desktop edition (Electron, portable) in desktop-app/.

    pixi run desktop-prepare          # copy app/ -> desktop-app/www, databases -> desktop-app/data
    cd desktop-app && pixi run -- npm install && pixi run -- npm run pack:win

What it does:
  * www/   = app/ without the data bundle, service worker and docs (the
             desktop serves it over its private app:// origin)
  * data/  = db/bible.db (+ a book_chapters table the catalog build adds to
             the web core), db/works.db, db/vectors.db, and catalog.json
             (titles/groups from tools/build_items.py so Settings -> Catalog
             lists what the edition contains — everything, installed)
Stdlib only. Run after `pixi run build-data`.
"""
import json
import shutil
import sqlite3
import sys
from pathlib import Path

from build_items import MAIN, catalogue

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "app"
DESK = ROOT / "desktop-app"
WWW = DESK / "www"
DATA = DESK / "data"
SKIP_TOP = {"data", "sw.js", "DESIGN.md", "CATALOG.md"}


def copy_www():
    if WWW.exists():
        shutil.rmtree(WWW)
    WWW.mkdir(parents=True)
    n = 0
    for src in APP.rglob("*"):
        if src.is_dir():
            continue
        rel = src.relative_to(APP)
        if rel.parts[0] in SKIP_TOP:
            continue
        dst = WWW / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dst)
        n += 1
    print(f"www: {n} files")


def copy_data():
    DATA.mkdir(parents=True, exist_ok=True)
    for name in ("bible.db", "works.db", "vectors.db"):
        src = ROOT / "db" / name
        if not src.exists():
            if name == "vectors.db":
                print("vectors.db missing — Ask AI semantic search will be unavailable")
                continue
            print(f"{src} missing — run pixi run build-data first", file=sys.stderr)
            return False
        shutil.copyfile(src, DATA / name)
        print(f"data: {name} {src.stat().st_size/1e6:.0f} MB")
    con = sqlite3.connect(DATA / "bible.db")
    con.execute("DROP TABLE IF EXISTS book_chapters")
    con.execute("CREATE TABLE book_chapters (book_nr INTEGER PRIMARY KEY, n INTEGER NOT NULL)")
    con.execute("INSERT INTO book_chapters SELECT book_nr, MAX(chapter) FROM verses "
                "WHERE text_id='kjv' GROUP BY book_nr")
    con.commit()
    con.execute("VACUUM")
    con.close()
    cat = []
    for pid, spec in MAIN.items():
        cat.append({"id": pid, "family": spec["family"], "main": True, "kind": "main",
                    "group": spec["group"], "title": spec["title"], "blurb": spec["blurb"],
                    "default": False, "text": None, "work_id": None, "slug": None,
                    "category": None, "gz_size": 0, "db_size": 0})
    for pid, spec in catalogue().items():
        cat.append({"id": pid, "family": spec["family"], "main": False, "kind": spec["kind"],
                    "group": spec["group"], "title": spec["title"], "blurb": spec.get("blurb", ""),
                    "default": bool(spec.get("default")), "text": spec.get("text"),
                    "work_id": spec.get("work_id"), "slug": spec.get("slug"),
                    "category": spec.get("category"), "gz_size": 0, "db_size": 0})
    cat.append({"id": "vectors", "family": "vectors", "main": False, "kind": "vectors",
                "group": "Ask AI (beta)", "title": "AI search index", "blurb": "",
                "default": False, "text": None, "work_id": None, "slug": None,
                "category": None, "gz_size": 0, "db_size": 0})
    (DATA / "catalog.json").write_text(json.dumps(cat, indent=1), encoding="utf-8")
    print(f"data: catalog.json ({len(cat)} entries)")
    return True


def main() -> int:
    copy_www()
    return 0 if copy_data() else 1


if __name__ == "__main__":
    sys.exit(main())

"""Split the monolithic databases into catalog ITEMS (db/items/<id>.db).

Design: app/CATALOG.md. Inputs: db/bible.db, db/works.db (built by
build_db.py / build_works_db.py; db/vectors.db is its own item). Two family
"main" databases hold the shared tables plus EMPTY schemas of everything an
item can bring:

    core     (bible)  books, texts, text_books, text_traditions, morph_codes,
                      lexicon, lexicon_affix, crossrefs, book_chapters;
                      empty verses / verse_map / words / verse_words /
                      lexicon_full / dictionary / names tables; verses_fts
    library  (works)  works, work_sections, work_refs; empty work_pages /
                      work_notes + their FTS

Every other unit of data is an ITEM — one Bible text, one testament of word
tagging, one lexicon, one Library work… — a small SQLite file holding just
its rows (same schemas, no indexes). The app imports an item INTO its family
main database on install (INSERT … SELECT, FTS rows added) and deletes those
rows on removal, so any number of items can be installed with one connection.
Each item records the SQL that selects/deletes its rows (`tables`).

Deterministic: fresh files, rows in rowid order, no timestamps.
Run AFTER build_db.py / build_works_db.py, BEFORE build_app_bundle.py:
    pixi run build-items
"""
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIBLE = ROOT / "db" / "bible.db"
WORKS = ROOT / "db" / "works.db"
OUT = ROOT / "db" / "items"

# ---- catalogue --------------------------------------------------------------
TEXTS = {   # id: (title, blurb, group)
    "web": ("World English Bible", "Modern English, public domain; the app's reference text (red letters, added words marked).", "Bibles · English"),
    "ylt": ("Young's Literal Translation", "Hyper-literal 1898 translation that preserves Hebrew and Greek tenses.", "Bibles · English"),
    "kjv": ("King James Version", "The 1769 Authorised Version.", "Bibles · English"),
    "kjva": ("KJV with Apocrypha", "The King James Version including the Apocrypha.", "Bibles · English"),
    "asv": ("American Standard Version (1901)", "Very literal; the ancestor of the NASB.", "Bibles · English"),
    "bsb": ("Berean Standard Bible", "Modern literal translation (CC0).", "Bibles · English"),
    "tyndale": ("Tyndale (1525/1530)", "The first printed English New Testament from the Greek, plus the Pentateuch.", "Bibles · English"),
    "douayrheims": ("Douay-Rheims", "English from the Latin Vulgate (Catholic tradition), with the deuterocanon.", "Bibles · English"),
    "weymouth": ("Weymouth New Testament", "Early modern-speech New Testament (1903).", "Bibles · English"),
    "lxxen": ("Septuagint in English (LXX2012)", "Brenton's translation of the Greek Old Testament, updated; includes the deuterocanon. Old Testament only.", "Bibles · English"),
    "lxx": ("Septuagint (Greek)", "The Greek Old Testament of the early Church, accented. Old Testament only.", "Bibles · Greek"),
    "textusreceptus": ("Textus Receptus", "The Greek New Testament behind the KJV (1550/1894).", "Bibles · Greek"),
    "westcotthort": ("Westcott-Hort", "The 1881 critical Greek New Testament.", "Bibles · Greek"),
    "tischendorf": ("Tischendorf (8th ed.)", "Critical Greek New Testament weighted toward Sinaiticus.", "Bibles · Greek"),
    "wlc": ("Westminster Leningrad Codex", "The Hebrew Old Testament (Masoretic text).", "Bibles · Hebrew"),
    "aleppo": ("Aleppo Codex", "The Hebrew Old Testament from the Aleppo Codex.", "Bibles · Hebrew"),
    "vulgate": ("Clementine Vulgate", "The Latin Bible of the Western Church.", "Bibles · Latin & Syriac"),
    "peshitta": ("Peshitta (Syriac)", "The Syriac New Testament.", "Bibles · Latin & Syriac"),
}
DEFAULT_TEXTS = ["web", "ylt"]
NAMES_TABLES = ["people", "places", "events", "entity_other", "entity_verses",
                "entity_names", "person_relations", "event_links", "easton"]

MAIN = {
    "core": {
        "family": "bible", "group": "Core", "title": "Bible core",
        "blurb": "Book list, cross-references, Strong's dictionary, parsing codes, search index.",
        "tables": ["books", "texts", "text_books", "text_traditions", "morph_codes",
                   "lexicon", "lexicon_affix", "crossrefs"],
        "empty": ["verses", "verse_map", "words", "verse_words", "lexicon_full",
                  "dictionary", *NAMES_TABLES],
        "fts": ["verses_plain", "verses_fts"],
    },
    "library": {
        "family": "works", "group": "Core", "title": "Library catalogue",
        "blurb": "The list of every work, their sections and scripture references.",
        "tables": ["works", "work_sections", "work_refs"],
        "empty": ["work_pages", "work_notes"],
        "fts": ["work_pages_fts", "work_notes_fts"],
    },
}


def catalogue():
    """Ordered {item_id: spec}. spec.tables = [(table, where_sql, params)]."""
    items = {}
    for tid, (title, blurb, group) in TEXTS.items():
        items[f"text-{tid}"] = {
            "family": "bible", "group": group, "title": title, "blurb": blurb,
            "kind": "text", "text": tid, "default": tid in DEFAULT_TEXTS,
            "tables": [("verses", "text_id = ?", [tid]), ("verse_map", "text_id = ?", [tid])],
        }
    items["tagged-ot"] = {
        "family": "bible", "group": "Greek & Hebrew word tagging",
        "title": "Tagged Hebrew Old Testament",
        "blurb": "Every Hebrew and Aramaic word of the OT with Strong's number and parsing (STEPBible TAHOT): the tappable Hebrew reader and concordance.",
        "kind": "layer", "tables": [("words", "book_nr < 40", [])],
    }
    items["tagged-nt"] = {
        "family": "bible", "group": "Greek & Hebrew word tagging",
        "title": "Tagged Greek New Testament",
        "blurb": "Every Greek word of the NT with Strong's number, parsing and edition variants (STEPBible TAGNT): the tappable Greek reader and concordance.",
        "kind": "layer", "tables": [("words", "book_nr >= 40", [])],
    }
    items["interlinear-web"] = {
        "family": "bible", "group": "Greek & Hebrew word tagging",
        "title": "WEB reverse interlinear",
        "blurb": "The original word behind each English word of the World English Bible.",
        "kind": "layer", "tables": [("verse_words", "1", [])],
    }
    for src, title, blurb in [
        ("bdb", "Brown-Driver-Briggs Hebrew lexicon (1906)", "Full BDB entries for every Hebrew Strong's number."),
        ("lsj", "Liddell-Scott-Jones Greek lexicon", "Full LSJ entries (STEPBible edition) for Greek words."),
        ("abbott-smith", "Abbott-Smith Manual Greek Lexicon (1922)", "A New Testament Greek lexicon, concise and precise."),
    ]:
        items[f"lexicon-{src}"] = {
            "family": "bible", "group": "Lexicons", "title": title, "blurb": blurb,
            "kind": "layer", "tables": [("lexicon_full", "source = ?", [src])],
        }
    items["dictionary"] = {
        "family": "bible", "group": "Reference", "title": "English dictionary",
        "blurb": "Webster's 1913 and WordNet definitions for the English texts' words.",
        "kind": "layer", "tables": [("dictionary", "1", [])],
    }
    items["names"] = {
        "family": "bible", "group": "Reference", "title": "People, places & events",
        "blurb": "Who, where and when for every name: family trees, the map, the timeline and Easton's Bible Dictionary.",
        "kind": "layer", "tables": [(t, "1", []) for t in NAMES_TABLES],
    }
    con = sqlite3.connect(f"file:{WORKS.as_posix()}?mode=ro", uri=True)
    for wid, slug, category, title in con.execute(
            "SELECT id, slug, category, title FROM works ORDER BY id"):
        items[f"work-{slug}"] = {
            "family": "works", "group": f"Library · {category}", "title": title,
            "blurb": "", "kind": "work", "work_id": wid, "slug": slug, "category": category,
            "tables": [("work_pages", "work_id = ?", [wid]), ("work_notes", "work_id = ?", [wid])],
        }
    con.close()
    return items


# ---- building ---------------------------------------------------------------
def src_schema(dst, name):
    row = dst.execute("SELECT sql FROM src.sqlite_master WHERE name=? AND sql IS NOT NULL",
                      (name,)).fetchone()
    if not row:
        raise SystemExit(f"{name}: no schema in source")
    return row[0]


def src_indexes(dst, table):
    return [r[0] for r in dst.execute(
        "SELECT sql FROM src.sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
        (table,))]


def fresh(path, source):
    if path.exists():
        path.unlink()
    dst = sqlite3.connect(path)
    dst.execute("PRAGMA auto_vacuum = INCREMENTAL")   # removals reclaim space cheaply
    dst.execute("ATTACH ? AS src", (source.as_posix(),))
    return dst


def finish(dst, path, pid):
    dst.commit()
    dst.execute("DETACH src")
    dst.execute("VACUUM")
    ok = dst.execute("PRAGMA integrity_check").fetchone()[0]
    dst.close()
    if ok != "ok":
        raise SystemExit(f"{pid}: integrity_check failed: {ok}")
    return path.stat().st_size


def build_main(pid, spec):
    source = BIBLE if spec["family"] == "bible" else WORKS
    path = OUT / f"{pid}.db"
    dst = fresh(path, source)
    for t in spec["tables"]:
        dst.execute(src_schema(dst, t))
        for sql in src_indexes(dst, t):
            dst.execute(sql)
        dst.execute(f"INSERT INTO main.{t} SELECT * FROM src.{t}")
    for t in spec["empty"]:
        dst.execute(src_schema(dst, t))
        for sql in src_indexes(dst, t):
            dst.execute(sql)
    for t in spec["fts"]:
        dst.execute(src_schema(dst, t))
    if pid == "core":
        # canonical chapter counts (KJV baseline) so navigation never depends
        # on which Bible texts the user keeps installed
        dst.execute("CREATE TABLE book_chapters (book_nr INTEGER PRIMARY KEY, n INTEGER NOT NULL)")
        dst.execute("INSERT INTO book_chapters SELECT book_nr, MAX(chapter) FROM src.verses "
                    "WHERE text_id='kjv' GROUP BY book_nr")
    dst.execute("CREATE TABLE installed_items (id TEXT PRIMARY KEY, version TEXT NOT NULL)")
    size = finish(dst, path, pid)
    print(f"  {pid:28s} {size/1e6:7.1f} MB  (main)")
    return size


def build_item(pid, spec):
    source = BIBLE if spec["family"] == "bible" else WORKS
    path = OUT / f"{pid}.db"
    dst = fresh(path, source)
    n = 0
    for table, where, params in spec["tables"]:
        dst.execute(src_schema(dst, table))          # schema only — no indexes
        cur = dst.execute(f"INSERT INTO main.{table} SELECT * FROM src.{table} WHERE {where}", params)
        n += cur.rowcount
    size = finish(dst, path, pid)
    print(f"  {pid:28s} {size/1e6:7.1f} MB  {n:,} rows")
    return size


def main() -> int:
    for p in (BIBLE, WORKS):
        if not p.exists():
            print(f"{p} missing — run the matching build script first", file=sys.stderr)
            return 1
    items = catalogue()
    OUT.mkdir(parents=True, exist_ok=True)
    keep = set(MAIN) | set(items)
    for stale in OUT.glob("*.db"):
        if stale.stem not in keep:
            stale.unlink()
    total = 0
    for pid, spec in MAIN.items():
        total += build_main(pid, spec)
    for pid, spec in items.items():
        total += build_item(pid, spec)
    print(f"{len(MAIN)} main databases + {len(items)} items, {total/1e6:.0f} MB raw in {OUT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

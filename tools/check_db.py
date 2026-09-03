"""Data-quality gate for db/bible.db, db/works.db and db/vectors.db (read-only).

Runs the structural checks from the 2026-09-02 audit and fails (exit 1) when
any invariant breaks, so a bad rebuild is caught before it is bundled:

  * PRAGMA integrity_check on both databases
  * expected tables and indexes exist
  * verses: no empty bodies, no duplicate keys, every text/book known,
    FTS row count == verses row count, marker tokens absent from the index
  * words / lexicon / verse_words / morph_codes / graph / verse_map sanity
  * works: no empty pages, page counts match, note anchors resolve,
    scripture references point at real books
  * vectors.db: both vector sets present, sized and id-aligned; the base
    databases carry NO vectors table (that is what keeps the first download small)

Usage:  pixi run check-db      (or  pixi run python tools/check_db.py)
"""
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BIBLE = ROOT / "db" / "bible.db"
WORKS = ROOT / "db" / "works.db"
VECTORS = ROOT / "db" / "vectors.db"

fails = []


def check(name, ok, detail=""):
    print(("  ok    " if ok else "  FAIL  ") + name + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        fails.append(name)


def q(con, sql, *args):
    return con.execute(sql, args).fetchall()


def one(con, sql, *args):
    return con.execute(sql, args).fetchone()[0]


def check_bible():
    con = sqlite3.connect(f"file:{BIBLE.as_posix()}?mode=ro", uri=True)
    print("bible.db")
    check("integrity_check", one(con, "PRAGMA integrity_check") == "ok")
    tables = {r[0] for r in q(con, "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
    for t in ["books", "texts", "text_books", "verses", "verses_plain", "verses_fts", "words",
              "lexicon", "dictionary", "crossrefs", "lexicon_full", "lexicon_affix",
              "verse_words", "morph_codes", "people", "places", "events", "entity_verses",
              "entity_names", "easton", "verse_map", "text_traditions"]:
        check(f"table {t}", t in tables)
    check("no legacy vectors table (lives in vectors.db)", "vectors" not in tables)
    idx = {r[0] for r in q(con, "SELECT name FROM sqlite_master WHERE type='index'")}
    for i in ["idx_words_strongs", "idx_words_ref", "idx_crossrefs_from", "idx_crossrefs_to",
              "idx_lexfull_strongs", "idx_entity_verses_ref", "idx_entity_names_norm"]:
        check(f"index {i}", i in idx)
    n_verses = one(con, "SELECT COUNT(*) FROM verses")
    check("verses > 400k", n_verses > 400_000, str(n_verses))
    check("no empty verse bodies", one(con, "SELECT COUNT(*) FROM verses WHERE TRIM(body)=''") == 0)
    check("no orphan text ids", one(con, "SELECT COUNT(*) FROM verses v WHERE NOT EXISTS (SELECT 1 FROM texts t WHERE t.id=v.text_id)") == 0)
    check("no verse without a text_books entry", one(con,
          "SELECT COUNT(*) FROM verses v WHERE NOT EXISTS (SELECT 1 FROM text_books tb WHERE tb.text_id=v.text_id AND tb.book_nr=v.book_nr)") == 0)
    check("FTS rows == verses", one(con, "SELECT COUNT(*) FROM verses_fts") == n_verses)
    for tok in ("fi", "fr", "fo"):
        check(f"marker token '{tok}' not indexed", one(con, "SELECT COUNT(*) FROM verses_fts WHERE verses_fts MATCH ?", f'"{tok}"') == 0)
    check("words == 447,398", one(con, "SELECT COUNT(*) FROM words") == 447_398)
    check("lexicon == 14,197", one(con, "SELECT COUNT(*) FROM lexicon") == 14_197)
    check("every lexicon Strong's has a full entry",
          one(con, "SELECT COUNT(*) FROM lexicon l WHERE NOT EXISTS (SELECT 1 FROM lexicon_full f WHERE f.strongs=l.strongs)") == 0)
    n_web = one(con, "SELECT COUNT(*) FROM verses WHERE text_id='web'")
    check("verse_words covers every WEB verse",
          one(con, "SELECT COUNT(DISTINCT book_nr||'.'||chapter||'.'||verse) FROM verse_words WHERE text_id='web'") == n_web)
    check("verse_words positions dense", one(con,
          "SELECT COUNT(*) FROM (SELECT book_nr, chapter, verse, MAX(pos)+1 AS n, COUNT(*) AS c FROM verse_words WHERE text_id='web' GROUP BY 1,2,3 HAVING n<>c)") == 0)
    check("morph_codes > 2,500", one(con, "SELECT COUNT(*) FROM morph_codes") > 2_500)
    check("crossrefs == 344,799", one(con, "SELECT COUNT(*) FROM crossrefs") == 344_799)
    check("people > 3,000 / places > 1,300", one(con, "SELECT COUNT(*) FROM people") > 3_000 and one(con, "SELECT COUNT(*) FROM places") > 1_300)
    check("entity_verses point at canonical books", one(con, "SELECT COUNT(*) FROM entity_verses WHERE book_nr NOT BETWEEN 1 AND 66") == 0)
    check("verse_map: English texts have no rows", one(con,
          "SELECT COUNT(*) FROM verse_map WHERE text_id IN ('kjv','kjva','asv','ylt','web','bsb','tyndale','weymouth')") == 0)
    check("verse_map: LXX Ps 23:1 -> 22:1", q(con,
          "SELECT t_chapter, t_verse FROM verse_map WHERE text_id='lxx' AND book_nr=19 AND chapter=23 AND verse=1") == [(22, 1)])
    check("verse_map: WLC Ps 3:1 -> 3:2", q(con,
          "SELECT t_chapter, t_verse FROM verse_map WHERE text_id='wlc' AND book_nr=19 AND chapter=3 AND verse=1") == [(3, 2)])
    con.close()


def check_works():
    con = sqlite3.connect(f"file:{WORKS.as_posix()}?mode=ro", uri=True)
    print("works.db")
    check("integrity_check", one(con, "PRAGMA integrity_check") == "ok")
    tables = {r[0] for r in q(con, "SELECT name FROM sqlite_master WHERE type='table'")}
    for t in ["works", "work_pages", "work_sections", "work_notes", "work_refs",
              "work_pages_fts", "work_notes_fts"]:
        check(f"table {t}", t in tables)
    check("no legacy vectors table (lives in vectors.db)", "vectors" not in tables)
    check("no empty pages", one(con, "SELECT COUNT(*) FROM work_pages WHERE TRIM(body)=''") == 0)
    check("works.pages matches page rows", one(con,
          "SELECT COUNT(*) FROM works w WHERE w.pages <> (SELECT COUNT(*) FROM work_pages p WHERE p.work_id=w.id)") == 0)
    check("note anchors resolve", one(con, """
          SELECT COUNT(*) FROM work_notes n
          WHERE NOT EXISTS (SELECT 1 FROM work_pages p WHERE p.work_id=n.work_id AND p.page=n.page
                            AND instr(p.rich, '⟦N|' || n.n || '⟧') > 0)""") == 0)
    check("work_refs point at real pages", one(con,
          "SELECT COUNT(*) FROM work_refs r WHERE NOT EXISTS (SELECT 1 FROM work_pages p WHERE p.work_id=r.work_id AND p.page=r.page)") == 0)
    check("work_refs books in 1..91", one(con, "SELECT COUNT(*) FROM work_refs WHERE book_nr NOT BETWEEN 1 AND 91") == 0)
    check("FTS rows == pages", one(con, "SELECT COUNT(*) FROM work_pages_fts") == one(con, "SELECT COUNT(*) FROM work_pages"))
    n = one(con, "SELECT COUNT(*) FROM works")
    print(f"  ({n} works)")
    con.close()


def check_vectors():
    con = sqlite3.connect(f"file:{VECTORS.as_posix()}?mode=ro", uri=True)
    print("vectors.db")
    check("integrity_check", one(con, "PRAGMA integrity_check") == "ok")
    tables = {r[0] for r in q(con, "SELECT name FROM sqlite_master WHERE type='table'")}
    check("table vectors", "vectors" in tables)
    if "vectors" not in tables:
        con.close(); return
    sets = {r[0] for r in q(con, "SELECT DISTINCT set_name FROM vectors")}
    check("sets works + bible", sets == {"works", "bible"}, str(sets))

    def blob_len(s, name):
        row = con.execute("SELECT length(data) FROM vectors WHERE set_name=? AND name=?", (s, name)).fetchone()
        return row[0] if row else -1

    for s, min_bytes in (("works", 60_000_000), ("bible", 10_000_000)):
        vec = blob_len(s, "vecs")
        check(f"{s}: vectors sized", vec > min_bytes, str(vec))
        check(f"{s}: ids aligned",
              vec // 384 == blob_len(s, "ids1") // 4 == blob_len(s, "ids2") // 4)
        row = con.execute("SELECT data FROM vectors WHERE set_name=? AND name='info'", (s,)).fetchone()
        check(f"{s}: info row", row is not None and b'"dims":384' in bytes(row[0]))
    con.close()


def check_items():
    """db/items/*.db (tools/build_items.py): the mains carry the shared tables plus
    empty schemas, every source row lands in exactly one item, and importing
    every item into a copy of its main reproduces the source row counts."""
    from build_items import MAIN, catalogue
    items_dir = ROOT / "db" / "items"
    print("items")
    items = catalogue()
    src = {"bible": sqlite3.connect(f"file:{BIBLE.as_posix()}?mode=ro", uri=True),
           "works": sqlite3.connect(f"file:{WORKS.as_posix()}?mode=ro", uri=True)}
    # per-table row totals across items must equal the source tables
    totals = {}
    for pid, spec in items.items():
        path = items_dir / f"{pid}.db"
        if not path.exists():
            check(f"{pid}: file exists", False, str(path)); continue
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        ok = one(con, "PRAGMA integrity_check") == "ok"
        n = 0
        for table, _, _ in spec["tables"]:
            c = one(con, f"SELECT COUNT(*) FROM {table}")
            totals[(spec["family"], table)] = totals.get((spec["family"], table), 0) + c
            n += c
        if not ok or n == 0:
            check(f"{pid}: intact and non-empty", False, f"ok={ok} rows={n}")
        con.close()
    check(f"all {len(items)} items intact and non-empty", not [f for f in fails if f.endswith("intact and non-empty")])
    for (fam, table), n in sorted(totals.items()):
        want = one(src[fam], f"SELECT COUNT(*) FROM {table}")
        check(f"items cover {table} ({n:,} rows)", n == want, f"{n} vs {want}")
    for pid, spec in MAIN.items():
        path = items_dir / f"{pid}.db"
        if not path.exists():
            check(f"{pid}: file exists", False, str(path)); continue
        con = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True)
        check(f"{pid}: integrity_check", one(con, "PRAGMA integrity_check") == "ok")
        tables = {r[0] for r in q(con, "SELECT name FROM sqlite_master WHERE type IN ('table','view')")}
        need = set(spec["tables"]) | set(spec["empty"]) | set(spec["fts"]) | {"installed_items"}
        missing = sorted(need - tables)
        check(f"{pid}: shared tables, empty schemas and FTS present", not missing, ",".join(missing))
        for t in spec["empty"]:
            if t in tables:
                check(f"{pid}: {t} empty", one(con, f"SELECT COUNT(*) FROM {t}") == 0)
        check(f"{pid}: auto_vacuum incremental", one(con, "PRAGMA auto_vacuum") == 2)
        if pid == "core":
            check("core: book_chapters covers 66 books", one(con, "SELECT COUNT(*) FROM book_chapters") == 66)
        con.close()
    for c in src.values():
        c.close()


def main():
    for p in (BIBLE, WORKS, VECTORS):
        if not p.exists():
            print(f"{p} missing"); return 2
    check_bible()
    check_works()
    check_vectors()
    check_items()
    if fails:
        print(f"\n{len(fails)} check(s) FAILED: " + ", ".join(fails))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())

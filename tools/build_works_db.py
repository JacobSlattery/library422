"""Build db/works.db — the Library: historical works as pageable text.

Reads the plain-text primary sources under resources/ (never modifies them)
and produces works + work_pages tables. Pages are split at paragraph
boundaries, ~10 KB each. Deterministic: fixed work list, fixed chunking.

Usage (from repo root):
    python tools/build_works_db.py

Stdlib only.
"""
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "db" / "works.db"
PAGE_CHARS = 10_000

HT = "resources/historical-texts"

# Works with a CCEL ThML (XML) edition get structure: plain body (search/AI —
# editor notes EXCLUDED) + a parallel "rich" body with display markers:
#   ⟦H⟧title⟦/H⟧ heading · ⟦I⟧..⟦/I⟧ italics · ⟦N|n⟧ note anchor ·
#   ⟦R|book.ch.verse⟧text⟦/R⟧ tappable scripture ref
# Note text lives in work_notes (searchable only via its own FTS, opt-in).
THML_WORKS = {
    # anf10 (Bibliographic Synopsis / General Index) parses to almost nothing
    # from ThML — its content is index-structured; it stays plain text
    **{f"anf{n:02d}": f"{HT}/church-fathers/thml/anf{n:02d}.xml"
       for n in range(1, 10)},
    **{f"npnf1{n:02d}": f"{HT}/church-fathers/thml/npnf1{n:02d}.xml"
       for n in range(1, 15)},
    **{f"npnf2{n:02d}": f"{HT}/church-fathers/thml/npnf2{n:02d}.xml"
       for n in range(1, 15)},
    "summa": f"{HT}/aquinas/thml/summa.xml",
    "gentiles": f"{HT}/aquinas/thml/gentiles.xml",
    "catena1-matthew": f"{HT}/aquinas/thml/catena1-matthew.xml",
    "catena2-mark": f"{HT}/aquinas/thml/catena2-mark.xml",
    # catena3/catena4 have no ThML edition on CCEL (404) — plain text
}

# parsed="|1Pet|5|1|5|5" book codes -> our book_nr
OSIS_NR = {
    "Gen": 1, "Exod": 2, "Lev": 3, "Num": 4, "Deut": 5, "Josh": 6,
    "Judg": 7, "Ruth": 8, "1Sam": 9, "2Sam": 10, "1Kgs": 11, "2Kgs": 12,
    "1Chr": 13, "2Chr": 14, "Ezra": 15, "Neh": 16, "Esth": 17, "Job": 18,
    "Ps": 19, "Psa": 19, "Prov": 20, "Eccl": 21, "Song": 22, "Isa": 23,
    "Jer": 24, "Lam": 25, "Ezek": 26, "Dan": 27, "Hos": 28, "Joel": 29,
    "Amos": 30, "Obad": 31, "Jonah": 32, "Mic": 33, "Nah": 34, "Hab": 35,
    "Zeph": 36, "Hag": 37, "Zech": 38, "Mal": 39, "Matt": 40, "Mark": 41,
    "Luke": 42, "John": 43, "Acts": 44, "Rom": 45, "1Cor": 46, "2Cor": 47,
    "Gal": 48, "Eph": 49, "Phil": 50, "Col": 51, "1Thess": 52, "2Thess": 53,
    "1Tim": 54, "2Tim": 55, "Titus": 56, "Phlm": 57, "Heb": 58, "Jas": 59,
    "1Pet": 60, "2Pet": 61, "1John": 62, "2John": 63, "3John": 64,
    "Jude": 65, "Rev": 66,
}

# (category, title or None=read from 'Title:' line, path)
WORKS = [
    ("Apostolic & Early Church", None, f"{HT}/church-fathers/apostolic-fathers-pg77576.txt"),
    *[("Ante-Nicene Fathers", None, f"{HT}/church-fathers/anf{n:02d}.txt")
      for n in range(1, 11)],
    *[("Nicene & Post-Nicene Fathers I", None, f"{HT}/church-fathers/npnf1{n:02d}.txt")
      for n in range(1, 15)],
    *[("Nicene & Post-Nicene Fathers II", None, f"{HT}/church-fathers/npnf2{n:02d}.txt")
      for n in range(1, 15)],
    ("Josephus", "The Life of Flavius Josephus", f"{HT}/josephus/pg2846.txt"),
    ("Josephus", "Antiquities of the Jews", f"{HT}/josephus/pg2848.txt"),
    ("Josephus", "Against Apion", f"{HT}/josephus/pg2849.txt"),
    ("Josephus", "The Wars of the Jews", f"{HT}/josephus/pg2850.txt"),
    *[("Philo of Alexandria", f"Works of Philo, Vol. {n} (Yonge)",
       f"{HT}/philo/philo-yonge-vol{n}.txt") for n in range(1, 5)],
    # Intertestamental (BC) texts — content scope rule 4 in ROADMAP.md; owner prefers
    # Christian terminology in app labels ("Intertestamental", not "Second Temple")
    ("Intertestamental Texts", "The Book of Enoch (R.H. Charles, 1917)",
     f"{HT}/pseudepigrapha/book-of-enoch-charles-pg77935.txt"),
    ("Intertestamental Texts", "The Book of Jubilees (R.H. Charles, 1917)",
     f"{HT}/pseudepigrapha/book-of-jubilees-charles-1917.clean.txt"),
    ("Intertestamental Texts", "The Letter of Aristeas (H. St. J. Thackeray, 1904)",
     f"{HT}/pseudepigrapha/letter-of-aristeas-thackeray-1904.clean.txt"),
    ("Intertestamental Texts", "The Psalms of Solomon (G. B. Gray, in Charles 1913)",
     f"{HT}/pseudepigrapha/psalms-of-solomon-gray-1913.clean.txt"),
    ("Intertestamental Texts", "The Testaments of the Twelve Patriarchs (R.H. Charles, 1913)",
     f"{HT}/pseudepigrapha/testaments-of-the-twelve-patriarchs-charles-1913.clean.txt"),
    ("Thomas Aquinas", "Summa Theologica", f"{HT}/aquinas/summa.txt"),
    ("Thomas Aquinas", "Summa Contra Gentiles", f"{HT}/aquinas/gentiles.txt"),
    ("Thomas Aquinas", "Catena Aurea: Matthew", f"{HT}/aquinas/catena1-matthew.txt"),
    ("Thomas Aquinas", "Catena Aurea: Mark", f"{HT}/aquinas/catena2-mark.txt"),
    ("Thomas Aquinas", "Catena Aurea: Luke I", f"{HT}/aquinas/catena3-luke-part1.txt"),
    ("Thomas Aquinas", "Catena Aurea: Luke II", f"{HT}/aquinas/catena3-luke-part2.txt"),
    ("Thomas Aquinas", "Catena Aurea: John", f"{HT}/aquinas/catena4-john.txt"),
]

TITLE_RE = re.compile(r"^\s*Title:\s*(.+?)\s*$", re.MULTILINE)

# Section headings: how these works divide themselves (Chapter/Book/Homily/
# Question...). Detected on paragraph-leading lines only.
HEADING_RE = re.compile(
    r"^\s{0,8}((?:BOOK|Book|CHAPTER|Chapter|CHAP\.|Chap\.|PART|Part|"
    r"QUESTION|Question|HOMILY|Homily|SERMON|Sermon|TRACTATE|Tractate|"
    r"EPISTLE|Epistle|LECTURE|Lecture|PSALM|Psalm|SECTION|Section|"
    r"ARTICLE|Article|DISCOURSE|Discourse)\s+(?:[IVXLCDM]+|\d+)\b[^\n]{0,60})")
# Per-work cap on detected sections. Was 1000, which silently cut the Summa's
# table of contents off at page 394 of 1538 (it has ~7.5k headings).
MAX_SECTIONS = 20000


def read_title(text, fallback):
    m = TITLE_RE.search(text[:5000])
    return m.group(1) if m else fallback


def paginate(text):
    """Split on blank lines; pack paragraphs into ~PAGE_CHARS pages.
    Returns (pages, sections) where sections = [(title, page_number)] from
    heading-shaped paragraph-leading lines."""
    paras = re.split(r"\n\s*\n", text)
    pages, buf, size = [], [], 0
    sections = []
    for p in paras:
        p = p.strip("\n")
        if not p.strip():
            continue
        if size + len(p) > PAGE_CHARS and buf:
            pages.append("\n\n".join(buf))
            buf, size = [], 0
        if len(sections) < MAX_SECTIONS:
            m = HEADING_RE.match(p)
            if m:
                sections.append((m.group(1).strip(), len(pages) + 1))
        buf.append(p)
        size += len(p) + 2
    if buf:
        pages.append("\n\n".join(buf))
    return pages, sections


# --------------------------------------------------------------- ThML parse
WS_RE = re.compile(r"\s+")
SKIP_TAGS = {"index", "pb", "ThML.head"}
HEAD_TAGS = {"h1", "h2", "h3", "h4", "h5", "h6"}
# block-level containers whose text becomes a paragraph. `li`/`dd`/`dt` carry
# the canons, creeds and lists (~1% of a volume) that used to be dropped.
BLOCK_TAGS = {"p", "l", "blockquote", "td", "verse", "li", "dd", "dt"}


def _scripref_marker(el):
    parsed = el.get("parsed", "")
    parts = parsed.strip("|").split("|")
    if len(parts) >= 3 and parts[0] in OSIS_NR:
        try:
            ch, vs = int(parts[1]), int(parts[2] or 1)
            return f"{OSIS_NR[parts[0]]}.{ch}.{max(vs, 1)}"
        except ValueError:
            pass
    return None


def _inline(el, notes, plain, rich):
    """Flatten an element's inline content into plain + rich strings."""
    tag = el.tag
    if tag in SKIP_TAGS:
        if el.tail:
            plain.append(el.tail)
            rich.append(el.tail)
        return
    if tag == "note":
        # notes keep their own rich markup — most scripture refs in these
        # editions live inside the footnotes
        p_, r_ = _flatten(el, notes)
        if p_:
            notes.append((p_, r_))
            rich.append(f"⟦N|{len(notes)}⟧")
        if el.tail:
            plain.append(el.tail)
            rich.append(el.tail)
        return
    ref = _scripref_marker(el) if tag == "scripRef" else None
    ital = tag == "i"
    if ref:
        rich.append(f"⟦R|{ref}⟧")
    elif ital:
        rich.append("⟦I⟧")
    if el.text:
        plain.append(el.text)
        rich.append(el.text)
    for child in el:
        _inline(child, notes, plain, rich)
    if ref:
        rich.append("⟦/R⟧")
    elif ital:
        rich.append("⟦/I⟧")
    if el.tail:
        plain.append(el.tail)
        rich.append(el.tail)


def _flatten(el, notes):
    plain, rich = [], []
    if el.text:
        plain.append(el.text)
        rich.append(el.text)
    for child in el:
        _inline(child, notes, plain, rich)
    return (WS_RE.sub(" ", "".join(plain)).strip(),
            WS_RE.sub(" ", "".join(rich)).strip())


def _blocks(el, notes, out):
    """Walk ThML structure emitting (plain, rich, heading_or_None) blocks."""
    tag = el.tag
    if tag in SKIP_TAGS:
        return
    if tag.startswith("div") and tag[3:].isdigit():
        title = WS_RE.sub(" ", el.get("title") or "").strip()
        if title and title.lower() not in ("title page",):
            out.append((title, f"⟦H⟧{title}⟦/H⟧", title))
        for child in el:
            _blocks(child, notes, out)
        return
    if tag in HEAD_TAGS:
        plain, rich = _flatten(el, notes)
        if plain:
            out.append((plain, f"⟦H⟧{rich}⟦/H⟧", None))
        return
    if tag in BLOCK_TAGS:
        # a list item may itself contain paragraphs/nested lists: descend
        # when it has block children, else flatten it as one paragraph
        if any(c.tag in BLOCK_TAGS or c.tag in HEAD_TAGS or
               c.tag in ("ul", "ol", "dl", "table") for c in el):
            lead = WS_RE.sub(" ", el.text or "").strip()
            if lead:
                out.append((lead, lead, None))
            for child in el:
                _blocks(child, notes, out)
            return
        plain, rich = _flatten(el, notes)
        if plain:
            out.append((plain, rich, None))
        return
    for child in el:
        _blocks(child, notes, out)


def parse_thml(path):
    """Returns (pages_plain, pages_rich, sections, notes)."""
    body = ET.parse(path).getroot().find("ThML.body")
    notes = []
    blocks = []
    for child in body:
        _blocks(child, notes, blocks)
    pages_p, pages_r, sections = [], [], []
    buf_p, buf_r, size = [], [], 0
    for plain, rich, heading in blocks:
        if size + len(plain) > PAGE_CHARS and buf_p:
            pages_p.append("\n\n".join(buf_p))
            pages_r.append("\n\n".join(buf_r))
            buf_p, buf_r, size = [], [], 0
        if heading and len(sections) < MAX_SECTIONS:
            sections.append((heading, len(pages_p) + 1))
        buf_p.append(plain)
        buf_r.append(rich)
        size += len(plain) + 2
    if buf_p:
        pages_p.append("\n\n".join(buf_p))
        pages_r.append("\n\n".join(buf_r))
    return pages_p, pages_r, sections, notes


def note_pages(pages_rich):
    """note n -> page number, from anchor positions after pagination."""
    mapping = {}
    for pg, rich in enumerate(pages_rich, 1):
        for m in re.finditer(r"⟦N\|(\d+)⟧", rich):
            mapping[int(m.group(1))] = pg
    return mapping


REF_MARK_RE = re.compile(r"⟦R\|(\d+)\.(\d+)\.(\d+)⟧")


def scripture_refs(wid, pages_rich, notes, npages):
    """(book, ch, verse, work, page, note) for every ⟦R⟧ marker — page bodies
    and editor notes alike — deduplicated, in deterministic order. Powers the
    verse sheet's "In the Library" panel (ROADMAP: the Fathers on this verse)."""
    seen = set()
    for pg, rich in enumerate(pages_rich, 1):
        for m in REF_MARK_RE.finditer(rich):
            seen.add((int(m.group(1)), int(m.group(2)), int(m.group(3)),
                      wid, pg, None))
    for n, (_plain, rich) in enumerate(notes, 1):
        pg = npages.get(n, 1)
        for m in REF_MARK_RE.finditer(rich):
            seen.add((int(m.group(1)), int(m.group(2)), int(m.group(3)),
                      wid, pg, n))
    return sorted(seen, key=lambda r: (r[0], r[1], r[2], r[3], r[4], r[5] or 0))


def main():
    DB_PATH.parent.mkdir(exist_ok=True)
    # Build into a temp file and only replace db/works.db once it passes an
    # integrity check: an interrupted build must never leave a truncated DB
    # for build_app_bundle.py to ship.
    tmp = DB_PATH.with_suffix(".db.tmp")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    cur = con.cursor()
    cur.execute("PRAGMA journal_mode=OFF")
    cur.executescript("""
    CREATE TABLE works (
        id INTEGER PRIMARY KEY, slug TEXT UNIQUE NOT NULL,
        category TEXT NOT NULL, title TEXT NOT NULL,
        source TEXT NOT NULL, pages INTEGER NOT NULL);
    CREATE TABLE work_refs (           -- scripture references in the Library
        book_nr INTEGER NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
        work_id INTEGER NOT NULL, page INTEGER NOT NULL,
        note INTEGER);                 -- NULL = in the page body; else editor note n
    CREATE INDEX idx_work_refs_ref ON work_refs(book_nr, chapter, verse);
    CREATE TABLE work_pages (
        work_id INTEGER NOT NULL, page INTEGER NOT NULL, body TEXT NOT NULL,
        rich TEXT,                        -- display markup (ThML works only)
        PRIMARY KEY (work_id, page));
    CREATE TABLE work_sections (          -- a work's internal divisions
        work_id INTEGER NOT NULL, section INTEGER NOT NULL,
        title TEXT NOT NULL, page INTEGER NOT NULL,   -- first page of section
        PRIMARY KEY (work_id, section));
    CREATE TABLE work_notes (             -- editor notes, OUT of page bodies:
        work_id INTEGER NOT NULL, n INTEGER NOT NULL,  -- invisible to search/
        page INTEGER NOT NULL, body TEXT NOT NULL,     -- AI unless opted in
        rich TEXT,                        -- display markup (scripRefs etc.)
        PRIMARY KEY (work_id, n));
    """)
    wid = 0
    total_pages = 0
    total_sections = 0
    total_refs = 0
    for category, title, rel in WORKS:
        path = ROOT / rel
        if not path.exists():
            print(f"  MISSING: {rel}", file=sys.stderr)
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        t = title or read_title(text, path.stem)
        wid += 1
        thml_ok = False
        if path.stem in THML_WORKS and (ROOT / THML_WORKS[path.stem]).exists():
            try:
                pages, rich, sections, notes = parse_thml(
                    ROOT / THML_WORKS[path.stem])
                thml_ok = bool(pages)
                if not thml_ok:
                    print(f"  {path.stem}: ThML parsed to zero pages — "
                          "falling back to plain text", file=sys.stderr)
            except Exception as e:
                print(f"  {path.stem}: ThML parse FAILED ({e}) — "
                      "falling back to plain text", file=sys.stderr)
        if thml_ok:
            npages = note_pages(rich)
            cur.executemany("INSERT INTO work_pages VALUES (?,?,?,?)",
                            [(wid, i + 1, body, rich[i])
                             for i, body in enumerate(pages)])
            cur.executemany("INSERT INTO work_notes VALUES (?,?,?,?,?)",
                            [(wid, n + 1, npages.get(n + 1, 1), np_, nr_)
                             for n, (np_, nr_) in enumerate(notes)])
            refs = scripture_refs(wid, rich, notes, npages)
            cur.executemany("INSERT INTO work_refs VALUES (?,?,?,?,?,?)", refs)
            total_refs += len(refs)
            print(f"  {path.stem}: ThML — {len(pages)} pages, "
                  f"{len(notes)} notes, {len(sections)} sections, "
                  f"{len(refs)} scripture refs")
        else:
            pages, sections = paginate(text)
            cur.executemany("INSERT INTO work_pages VALUES (?,?,?,NULL)",
                            [(wid, i + 1, body) for i, body in enumerate(pages)])
        cur.execute("INSERT INTO works VALUES (?,?,?,?,?,?)",
                    (wid, path.stem, category, t, rel, len(pages)))
        cur.executemany("INSERT INTO work_sections VALUES (?,?,?,?)",
                        [(wid, i + 1, s_title, s_page)
                         for i, (s_title, s_page) in enumerate(sections)])
        total_pages += len(pages)
        total_sections += len(sections)
    print("  building full-text index...")
    cur.executescript("""
    CREATE VIRTUAL TABLE work_pages_fts USING fts5(
        body, content='work_pages', content_rowid='rowid',
        tokenize='porter unicode61');   -- stemming: soldier matches soldiers
    INSERT INTO work_pages_fts(rowid, body)
        SELECT rowid, body FROM work_pages;
    CREATE VIRTUAL TABLE work_notes_fts USING fts5(
        body, content='work_notes', content_rowid='rowid',
        tokenize='porter unicode61');     -- opt-in editor-note search
    INSERT INTO work_notes_fts(rowid, body)
        SELECT rowid, body FROM work_notes;
    """)
    con.commit()
    cur.execute("VACUUM")
    check = cur.execute("PRAGMA integrity_check").fetchone()[0]
    con.close()
    if check != "ok":
        print(f"integrity_check failed: {check}", file=sys.stderr)
        return 1
    os.replace(tmp, DB_PATH)
    size = DB_PATH.stat().st_size / 1e6
    print(f"{wid} works, {total_pages} pages, {total_sections} sections, "
          f"{total_refs} scripture refs -> db/works.db ({size:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

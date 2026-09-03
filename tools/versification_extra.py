"""Versification mapping (STEPBible TVTMS, CC BY 4.0) — per TEXT, by evidence.

The `verses` table keys every text by the English (KJV) numbering, but the
Hebrew, Greek and Latin traditions number some books differently (Psalm
titles count as verse 1 in Hebrew; LXX Psalms are offset by one from Ps 10;
LXX Jeremiah is reordered; Joel/Malachi chapter splits differ...) — and the
editions we hold do not follow one tradition uniformly (LXX2012 has Greek
psalm numbers but English chapters in Malachi; the Rahlfs-style Greek text
swaps the last verses of Malachi).

TVTMS was designed for exactly this: every section of its "Condensed" data
lists, per numbering column, TESTS against the actual Bible ("Mal.3:24=Last",
"Psa.3:1=Exist", "Mal.4:5<Mal.4:6" on word counts). This module evaluates the
tests against each text in bible.db, picks the first column whose tests all
hold, and records that column's alignment for that text:

    verse_map(text_id, book_nr, chapter, verse,        -- canonical (English) key
              t_book_nr, t_chapter, t_verse, part)     -- the text's own key
    text_traditions(text_id, tradition)                -- most-chosen column, for display

Only DIFFERENCES are stored: no row = identity. `verse` 0 = a Psalm title the
English numbering has no verse for. An absent verse is stored with
t_chapter = t_verse = 0 and part = 'absent'. One canonical verse may map to
several target verses (a verse the text subdivides); the app joins them.

Tests we cannot evaluate (sub-verse counts, "TextBeforeV1") are treated as
passing. Stdlib only, deterministic. Called from build_db.py after the texts
are loaded: load_versification(cur).
"""
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TVTMS = (ROOT / "texts" / "stepbible-data" / "Versification" /
         "TVTMS - Translators Versification Traditions with Methodology for "
         "Standardisation for Eng+Heb+Lat+Grk+Others - STEPBible.org CC BY.txt")

STEP_TO_NR = {
    "Gen": 1, "Exo": 2, "Lev": 3, "Num": 4, "Deu": 5, "Jos": 6, "Jdg": 7, "Rut": 8,
    "1Sa": 9, "2Sa": 10, "1Ki": 11, "2Ki": 12, "1Ch": 13, "2Ch": 14, "Ezr": 15,
    "Neh": 16, "Est": 17, "Job": 18, "Psa": 19, "Pro": 20, "Ecc": 21, "Sng": 22,
    "Isa": 23, "Jer": 24, "Lam": 25, "Ezk": 26, "Dan": 27, "Hos": 28, "Jol": 29,
    "Amo": 30, "Oba": 31, "Jon": 32, "Mic": 33, "Nam": 34, "Hab": 35, "Zep": 36,
    "Hag": 37, "Zec": 38, "Mal": 39, "Mat": 40, "Mrk": 41, "Luk": 42, "Jhn": 43,
    "Act": 44, "Rom": 45, "1Co": 46, "2Co": 47, "Gal": 48, "Eph": 49, "Php": 50,
    "Col": 51, "1Th": 52, "2Th": 53, "1Ti": 54, "2Ti": 55, "Tit": 56, "Phm": 57,
    "Heb": 58, "Jas": 59, "1Pe": 60, "2Pe": 61, "1Jn": 62, "2Jn": 63, "3Jn": 64,
    "Jud": 65, "Rev": 66,
    # deuterocanon (kjva / lxx / lxxen numbering, see build_db.DC_TO_NR)
    "1Es": 67, "2Es": 68, "Tob": 69, "Jdt": 70, "Esg": 71, "Ade": 71, "Wis": 73,
    "Sir": 74, "Bar": 75, "S3Y": 76, "Sus": 77, "Bel": 78, "Man": 79, "1Ma": 80,
    "2Ma": 81, "3Ma": 82, "4Ma": 83, "PsS": 90, "LJe": 91,
}

REF_RE = re.compile(
    r"^(?P<book>[1-4]?[A-Za-z]{2,3})\.(?P<ch>\d+):(?P<v>Title|\d+)"
    r"(?P<part>[a-z])?(?:\.(?P<sub>\d+))?(?:-(?P<v2>\d+)(?P<part2>[a-z])?)?$")
TEST_REF_RE = re.compile(r"([1-4]?[A-Za-z]{2,3})\.(\d+):(Title|\d+)(?:\.(\d+))?")


def column_name(raw):
    n = raw.strip().rstrip("*").strip()
    n = re.sub(r"\s*\(.*\)$", "", n).strip()
    return n


def expand(cell):
    """Alignment cell -> list of (book_nr, chapter, verse, part), 'absent',
    or None. Ranges within a chapter expand to consecutive verses."""
    cell = cell.strip()
    if not cell:
        return None
    if cell.lower().startswith("absent"):
        return "absent"
    cell = re.sub(r"\s*\[.*\]$", "", cell).strip()   # "[= Ref]" alternates
    m = REF_RE.match(cell)
    if not m:
        return None
    nr = STEP_TO_NR.get(m.group("book"))
    if nr is None:
        return None
    ch = int(m.group("ch"))
    v = 0 if m.group("v") == "Title" else int(m.group("v"))
    part = m.group("part")
    if m.group("v2") is None:
        return [(nr, ch, v, part)]
    v2 = int(m.group("v2"))
    if v2 < v:
        return None
    return [(nr, ch, x, part if x == v else (m.group("part2") if x == v2 else None))
            for x in range(v, v2 + 1)]


# ----------------------------------------------------------------- sections
def parse_sections(path):
    """-> list of {columns: [names], tests: {col_index: [test strings]},
    rows: [[cell per column]]} for the Condensed data."""
    text = path.read_text(encoding="utf-8-sig")
    lines = text.split("\n")
    start = next(i for i, ln in enumerate(lines) if ln.startswith("#DataStart(Condensed)"))
    end = next(i for i, ln in enumerate(lines) if ln.startswith("#DataEnd(Condensed)"))
    sections = []
    cur = None
    known_names = {"English KJV", "Hebrew", "Latin", "Greek", "Greek2", "GreekUndivided",
                   "LatinUndivided", "EngTitleMerged", "EngTitleSeparate", "BrentonSeparate",
                   "BrentonMerged", "GrkTitleSeparate", "GrkTitleMerged", "Slavonic"}
    for ln in lines[start + 1:end]:
        cells = [c.strip() for c in ln.rstrip("\r").split("\t")]
        if not cells or not cells[0]:
            continue
        head = cells[0]
        if head.startswith("$"):
            cur = {"columns": [column_name(c) for c in cells[1:] if c],
                   "tests": defaultdict(list),        # by column index (TEST rows)
                   "name_tests": defaultdict(list),   # by column name (per-column rows)
                   "rows": []}
            sections.append(cur)
            continue
        if cur is None or head.startswith("#") or head.startswith("'"):
            continue
        if head == "BIBLES":
            # in the Psalms layout the column list comes AFTER the per-column
            # test rows, which is why those are kept by name
            cur["columns"] = [column_name(c) for c in cells[1:] if c]
            continue
        if head.startswith("TEST"):
            for i, c in enumerate(cells[1:]):
                if c.strip(" &"):
                    cur["tests"][i].append(c)
            continue
        # per-column test rows: "<column name>\t & Psa.3:8=Last & ..."
        cname = column_name(head)
        names = [column_name(p) for p in cname.split("+")]
        if len(cells) > 1 and all(n in known_names for n in names) and re.search(r"[=<>]", cells[1]):
            for n in names:
                cur["name_tests"][n].append(cells[1])
            continue
        # alignment row: type, then one cell per column
        if len(cells) > 1 and (expand(cells[1]) is not None):
            cur["rows"].append(cells[1:1 + len(cur["columns"])])
    return sections


# --------------------------------------------------------------- evaluation
class TextFacts:
    """Word counts and chapter extents of one text, for evaluating tests."""

    def __init__(self, rows):
        self.words = {}        # (b, c, v) -> word count
        self.last = {}         # (b, c) -> max verse
        for b, c, v, body in rows:
            self.words[(b, c, v)] = len(body.split())
            if self.last.get((b, c), 0) < v:
                self.last[(b, c)] = v

    def has_book(self, b):
        return any(k[0] == b for k in self.last)


def eval_test(expr, facts):
    """One test clause. Unknown forms pass."""
    expr = expr.strip()
    if not expr:
        return True
    m = re.match(r"^(.+?)=(Last|Exist|NotExist)$", expr)
    if m:
        ref, op = m.group(1).strip(), m.group(2)
        r = TEST_REF_RE.match(ref)
        if not r:
            return True
        b = STEP_TO_NR.get(r.group(1))
        if b is None:
            return True
        if r.group(4) is not None or r.group(3) == "Title" or "TextBeforeV1" in ref:
            return True                       # sub-verse / title tests: unknowable
        c, v = int(r.group(2)), int(r.group(3))
        exists = (b, c, v) in facts.words and facts.words[(b, c, v)] > 0
        if op == "Exist":
            return exists
        if op == "NotExist":
            return not exists
        return exists and facts.last.get((b, c)) == v
    if "TextBeforeV1" in expr:
        return True
    # word-count comparison: "Mal.4:5*2<Mal.4:4+Mal.4:6"
    m = re.match(r"^(.+?)([<>])(.+)$", expr)
    if not m:
        return True
    def value(side):
        side = side.strip()
        def sub(mm):
            b = STEP_TO_NR.get(mm.group(1))
            if b is None or mm.group(3) == "Title":
                return "0"
            return str(facts.words.get((b, int(mm.group(2)), int(mm.group(3))), 0))
        s = TEST_REF_RE.sub(sub, side)
        if not re.match(r"^[\d\s+*.]+$", s):
            return None
        try:
            return eval(s, {"__builtins__": {}}, {})    # digits and + * only
        except Exception:
            return None
    a, b_ = value(m.group(1)), value(m.group(3))
    if a is None or b_ is None:
        return True
    return a < b_ if m.group(2) == "<" else a > b_


def tests_pass(tests, facts, structural_only=False):
    for t in tests:
        for clause in re.split(r"\s*&\s*", t.strip(" &")):
            if structural_only and re.search(r"[<>]", clause):
                continue           # word-count heuristics: skip in the fallback pass
            if not eval_test(clause, facts):
                return False
    return True


def test_score(tests, facts):
    """Fraction of structural clauses that hold (0..1); a "=Last" clause that
    is off by one verse (an edition with one extra or one fewer verse in the
    chapter, e.g. Rahlfs' Jeremiah 25) earns half credit. 0 with no clauses."""
    clauses = [c for t in tests for c in re.split(r"\s*&\s*", t.strip(" &"))
               if c and not re.search(r"[<>]", c)]
    if not clauses:
        return 0.0
    score = 0.0
    for c in clauses:
        if eval_test(c, facts):
            score += 1
            continue
        m = re.match(r"^(.+?)=Last$", c.strip())
        r = TEST_REF_RE.match(m.group(1).strip()) if m else None
        if r and r.group(3) != "Title":
            b = STEP_TO_NR.get(r.group(1))
            last = facts.last.get((b, int(r.group(2)))) if b else None
            if last is not None and abs(last - int(r.group(3))) == 1:
                score += 0.5
    return score / len(clauses)


def column_tests(sec, i):
    cols = sec["columns"]
    tests = list(sec["tests"].get(i, []))
    if i < len(cols):
        for n in cols[i].split("+"):
            tests += sec["name_tests"].get(column_name(n), [])
    return tests


# ------------------------------------------------------------------- loader
def map_text(sections, facts):
    """-> {(b,c,v): [(tb,tc,tv,part), ...]} differences for one text, and the
    Counter of chosen column names."""
    out = {}
    chosen = defaultdict(int)
    for sec in sections:
        cols = sec["columns"]
        if not cols or cols[0] != "English KJV" or not sec["rows"]:
            continue
        # skip sections about books this text does not have
        first = expand(sec["rows"][0][0])
        if not isinstance(first, list) or not facts.has_book(first[0][0]):
            continue
        pick = None
        for structural in (False, True):
            for i, name in enumerate(cols):
                if tests_pass(column_tests(sec, i), facts, structural):
                    pick = i
                    break
            if pick is not None:
                break
        if pick is None:
            # No column's tests hold exactly (an edition whose chapter is one
            # verse longer than the tradition expects, e.g. LXX Jeremiah).
            # Take the best-scoring column when it clearly beats English.
            scores = [test_score(column_tests(sec, i), facts) for i in range(len(cols))]
            best = max(range(len(cols)), key=lambda i: (scores[i], -i))
            if best != 0 and scores[best] >= 0.5 and scores[best] > scores[0] + 0.2:
                pick = best
        if pick is None or pick == 0:
            chosen[cols[pick] if pick is not None else "English KJV"] += 1
            continue
        chosen[cols[pick]] += 1
        for row in sec["rows"]:
            if pick >= len(row):
                continue
            eng = expand(row[0])
            tgt = expand(row[pick])
            if not isinstance(eng, list) or tgt is None:
                continue
            if tgt == "absent":
                for (b, c, v, _p) in eng:
                    out.setdefault((b, c, v), [(b, 0, 0, "absent")])
                continue
            if len(tgt) == len(eng):
                pairs = list(zip(eng, tgt))
            elif len(eng) == 1:
                pairs = [(eng[0], t) for t in tgt]     # one verse, several targets
            elif len(tgt) == 1:
                pairs = [(e, tgt[0]) for e in eng]     # several verses merged
            else:
                continue
            for (b, c, v, _p), (tb, tc, tv, tp) in pairs:
                if (b, c, v) == (tb, tc, tv) and not tp:
                    continue
                out.setdefault((b, c, v), [])
                if (tb, tc, tv, tp) not in out[(b, c, v)]:
                    out[(b, c, v)].append((tb, tc, tv, tp))
    return out, chosen


def load_versification(cur):
    cur.executescript("""
    DROP TABLE IF EXISTS verse_map;
    DROP TABLE IF EXISTS text_traditions;
    CREATE TABLE verse_map (
        text_id TEXT NOT NULL,
        book_nr INTEGER NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
        t_book_nr INTEGER NOT NULL, t_chapter INTEGER NOT NULL, t_verse INTEGER NOT NULL,
        part TEXT,
        PRIMARY KEY (text_id, book_nr, chapter, verse, t_book_nr, t_chapter, t_verse));
    CREATE INDEX idx_verse_map_t ON verse_map(text_id, t_book_nr, t_chapter, t_verse);
    CREATE TABLE text_traditions (text_id TEXT PRIMARY KEY, tradition TEXT NOT NULL);
    """)
    if not TVTMS.exists():
        print(f"  MISSING: {TVTMS.name}", file=sys.stderr)
        return
    sections = parse_sections(TVTMS)
    text_ids = [r[0] for r in cur.execute("SELECT id FROM texts ORDER BY id")]
    total = 0
    summary = []
    for text_id in text_ids:
        rows = cur.execute(
            "SELECT book_nr, chapter, verse, body FROM verses WHERE text_id=?",
            (text_id,)).fetchall()
        facts = TextFacts(rows)
        diffs, chosen = map_text(sections, facts)
        out = []
        for (b, c, v), targets in diffs.items():
            for (tb, tc, tv, tp) in targets:
                out.append((text_id, b, c, v, tb, tc, tv, tp))
        out.sort(key=lambda r: tuple(x if x is not None else "" for x in r))
        # A text that genuinely follows another numbering differs in
        # thousands of verses; a handful of rows means a few sections'
        # heuristics misfired on an English-numbered text (e.g. the KJV's own
        # Philippians 1:16-17 note). Those must not remap the canonical text.
        if len(out) < 20:
            out = []
        cur.executemany("INSERT OR IGNORE INTO verse_map VALUES (?,?,?,?,?,?,?,?)", out)
        total += len(out)
        non_english = {k: n for k, n in chosen.items() if k != "English KJV"}
        tradition = max(non_english, key=lambda k: (non_english[k], k)) if out else "English KJV"
        cur.execute("INSERT INTO text_traditions VALUES (?,?)", (text_id, tradition))
        if out:
            summary.append(f"{text_id}: {len(out)} ({tradition})")
    print(f"  verse_map: {total} rows over {len(sections)} sections — " + ", ".join(summary))

"""Build db/bible.db — the derived SQLite study database.

Reads sources under texts/ and resources/ (never modifies them) and produces a
single queryable database linking: verses (all translations), tagged original-
language words (STEPBible TAHOT/TAGNT), Strong's lexicon entries, and
cross-references. Deterministic: fixed file order, sorted keys, no timestamps.
Safe to delete db/ and rebuild at any time.

Usage (from repo root):
    python tools/build_db.py

Stdlib only (json, sqlite3, re, csv).
"""
import json
import os
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
# Phase A data layers (ROADMAP.md), each a self-contained loader module
from morph_extra import load_morph_codes          # noqa: E402
from web_words_extra import load_web_words        # noqa: E402
from lexicons_extra import load_full_lexicons     # noqa: E402
from graph_extra import load_graph                # noqa: E402
from versification_extra import load_versification  # noqa: E402
DB_DIR = ROOT / "db"
DB_PATH = DB_DIR / "bible.db"

# ---------------------------------------------------------------- book tables
# Canonical Protestant 66-book numbering (matches getBible `nr`).
# code = STEPBible/TAHOT/TAGNT code; ob = openbible.info cross-reference code.
BOOKS = [
    # nr, name, step code, openbible code
    (1, "Genesis", "Gen", "Gen"), (2, "Exodus", "Exo", "Exod"),
    (3, "Leviticus", "Lev", "Lev"), (4, "Numbers", "Num", "Num"),
    (5, "Deuteronomy", "Deu", "Deut"), (6, "Joshua", "Jos", "Josh"),
    (7, "Judges", "Jdg", "Judg"), (8, "Ruth", "Rut", "Ruth"),
    (9, "1 Samuel", "1Sa", "1Sam"), (10, "2 Samuel", "2Sa", "2Sam"),
    (11, "1 Kings", "1Ki", "1Kgs"), (12, "2 Kings", "2Ki", "2Kgs"),
    (13, "1 Chronicles", "1Ch", "1Chr"), (14, "2 Chronicles", "2Ch", "2Chr"),
    (15, "Ezra", "Ezr", "Ezra"), (16, "Nehemiah", "Neh", "Neh"),
    (17, "Esther", "Est", "Esth"), (18, "Job", "Job", "Job"),
    (19, "Psalms", "Psa", "Ps"), (20, "Proverbs", "Pro", "Prov"),
    (21, "Ecclesiastes", "Ecc", "Eccl"), (22, "Song of Solomon", "Sng", "Song"),
    (23, "Isaiah", "Isa", "Isa"), (24, "Jeremiah", "Jer", "Jer"),
    (25, "Lamentations", "Lam", "Lam"), (26, "Ezekiel", "Ezk", "Ezek"),
    (27, "Daniel", "Dan", "Dan"), (28, "Hosea", "Hos", "Hos"),
    (29, "Joel", "Jol", "Joel"), (30, "Amos", "Amo", "Amos"),
    (31, "Obadiah", "Oba", "Obad"), (32, "Jonah", "Jon", "Jonah"),
    (33, "Micah", "Mic", "Mic"), (34, "Nahum", "Nam", "Nah"),
    (35, "Habakkuk", "Hab", "Hab"), (36, "Zephaniah", "Zep", "Zeph"),
    (37, "Haggai", "Hag", "Hag"), (38, "Zechariah", "Zec", "Zech"),
    (39, "Malachi", "Mal", "Mal"), (40, "Matthew", "Mat", "Matt"),
    (41, "Mark", "Mrk", "Mark"), (42, "Luke", "Luk", "Luke"),
    (43, "John", "Jhn", "John"), (44, "Acts", "Act", "Acts"),
    (45, "Romans", "Rom", "Rom"), (46, "1 Corinthians", "1Co", "1Cor"),
    (47, "2 Corinthians", "2Co", "2Cor"), (48, "Galatians", "Gal", "Gal"),
    (49, "Ephesians", "Eph", "Eph"), (50, "Philippians", "Php", "Phil"),
    (51, "Colossians", "Col", "Col"), (52, "1 Thessalonians", "1Th", "1Thess"),
    (53, "2 Thessalonians", "2Th", "2Thess"), (54, "1 Timothy", "1Ti", "1Tim"),
    (55, "2 Timothy", "2Ti", "2Tim"), (56, "Titus", "Tit", "Titus"),
    (57, "Philemon", "Phm", "Phlm"), (58, "Hebrews", "Heb", "Heb"),
    (59, "James", "Jas", "Jas"), (60, "1 Peter", "1Pe", "1Pet"),
    (61, "2 Peter", "2Pe", "2Pet"), (62, "1 John", "1Jn", "1John"),
    (63, "2 John", "2Jn", "2John"), (64, "3 John", "3Jn", "3John"),
    (65, "Jude", "Jud", "Jude"), (66, "Revelation", "Rev", "Rev"),
]
STEP_TO_NR = {code: nr for nr, _, code, _ in BOOKS}
OB_TO_NR = {ob: nr for nr, _, _, ob in BOOKS}
NAME_TO_NR = {name: nr for nr, name, _, _ in BOOKS}
NAME_TO_NR.update({"Psalm": 19, "Song of Songs": 22})  # BSB aliases

# ------------------------------------------------------------- getBible texts
GETBIBLE_TEXTS = [
    # id, language, relative path
    ("kjv", "en", "texts/english/kjv.json"),
    ("kjva", "en", "texts/english/kjva.json"),
    ("asv", "en", "texts/english/asv.json"),
    ("ylt", "en", "texts/english/ylt.json"),
    # web comes from USFM instead (carries \wj red-letter + \add italics)
    ("tyndale", "en", "texts/english/tyndale.json"),
    ("douayrheims", "en", "texts/english/douayrheims.json"),
    ("weymouth", "en", "texts/english/weymouth.json"),
    ("lxx", "grc", "texts/greek/lxx.json"),
    ("textusreceptus", "grc", "texts/greek/textusreceptus.json"),
    ("westcotthort", "grc", "texts/greek/westcotthort.json"),
    ("tischendorf", "grc", "texts/greek/tischendorf.json"),
    ("wlc", "hbo", "texts/hebrew/codex.json"),
    ("aleppo", "hbo", "texts/hebrew/aleppo.json"),
    ("vulgate", "la", "texts/latin/vulgate.json"),
    ("peshitta", "syr", "texts/syriac/peshitta-nt.json"),
]

STEP_DIR = ROOT / "texts" / "stepbible-data" / "Translators Amalgamated OT+NT"
TAHOT_FILES = [
    "TAHOT Gen-Deu - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT Jos-Est - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT Job-Sng - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
    "TAHOT Isa-Mal - Translators Amalgamated Hebrew OT - STEPBible.org CC BY.txt",
]
TAGNT_FILES = [
    "TAGNT Mat-Jhn - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt",
    "TAGNT Act-Rev - Translators Amalgamated Greek NT - STEPBible.org CC-BY.txt",
]

REF_RE = re.compile(r"^([1-3]?[A-Za-z]{2,3})\.(\d+)\.(\d+)(?:\(([\d.]+)\))?#(\d+)=?(\S*)$")
STRONGS_RE = re.compile(r"[HG]\d{4}[A-Za-z]?")
OB_REF_RE = re.compile(r"^([1-3]?[A-Za-z]+)\.(\d+)\.(\d+)$")


def create_schema(cur):
    cur.executescript("""
    CREATE TABLE books (
        nr INTEGER PRIMARY KEY, name TEXT NOT NULL,
        step_code TEXT NOT NULL, ob_code TEXT NOT NULL);
    CREATE TABLE texts (
        id TEXT PRIMARY KEY, lang TEXT NOT NULL, source TEXT NOT NULL);
    CREATE TABLE text_books (          -- each text's own book list (incl. apocrypha)
        text_id TEXT NOT NULL, book_nr INTEGER NOT NULL, book_name TEXT NOT NULL,
        PRIMARY KEY (text_id, book_nr));
    CREATE TABLE verses (
        text_id TEXT NOT NULL, book_nr INTEGER NOT NULL,
        chapter INTEGER NOT NULL, verse INTEGER NOT NULL, body TEXT NOT NULL,
        PRIMARY KEY (text_id, book_nr, chapter, verse));
    CREATE TABLE words (               -- tagged original-language words (STEPBible)
        id INTEGER PRIMARY KEY,
        testament TEXT NOT NULL,       -- 'OT' | 'NT'
        book_nr INTEGER NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
        pos INTEGER NOT NULL,          -- word position within verse
        variant TEXT,                  -- source tag after '=' (L, Q, K, NKO, ...)
        alt_ref TEXT,                  -- alternate versification ref, if any
        surface TEXT NOT NULL,         -- original-language form as written
        translit TEXT, gloss TEXT,
        strongs TEXT,                  -- primary Strong's number (e.g. G3056, H7225)
        strongs_all TEXT,              -- every Strong's code in the tag, space-joined
        lemma TEXT, morph TEXT,
        editions TEXT,                 -- NT: which editions contain this word
        surface_norm TEXT);            -- surface lowercased, marks/punct stripped
    CREATE TABLE lexicon (
        strongs TEXT PRIMARY KEY, lang TEXT NOT NULL,
        lemma TEXT, translit TEXT, pronunciation TEXT,
        definition TEXT, kjv_usage TEXT, derivation TEXT,
        lemma_norm TEXT,      -- lemma lowercased, diacritics/points stripped
        translit_norm TEXT);  -- transliteration lowercased, accents stripped
    CREATE TABLE dictionary (          -- English dictionary (Webster's 1913)
        word TEXT PRIMARY KEY,         -- lowercase headword
        definition TEXT NOT NULL);
    CREATE TABLE crossrefs (
        from_book INTEGER NOT NULL, from_chapter INTEGER NOT NULL,
        from_verse INTEGER NOT NULL,
        to_ref TEXT NOT NULL,          -- raw target (may be a range)
        to_book INTEGER, to_chapter INTEGER, to_verse INTEGER,  -- parsed range start
        votes INTEGER NOT NULL);
    """)


def load_getbible(cur):
    for text_id, lang, rel in GETBIBLE_TEXTS:
        data = json.loads((ROOT / rel).read_text(encoding="utf-8-sig"))
        cur.execute("INSERT INTO texts VALUES (?,?,?)", (text_id, lang, rel))
        vrows, brows = [], []
        synthetic = 90  # books with no nr (e.g. LXX Odes) get stable synthetic numbers
        for b in data["books"]:
            if b.get("nr") is None:
                b["nr"] = synthetic
                synthetic += 1
            brows.append((text_id, b["nr"], b["name"]))
            for ch in b["chapters"]:
                for v in ch["verses"]:
                    # NOTE: verse text keeps getBible inline markers (<FI>..<Fi>
                    # italics = translator-supplied words, <FR>..<Fr> red-letter,
                    # <FO>..<Fo> OT quotes) — the app renders them (owner wants
                    # source formatting preserved). Do not strip.
                    vrows.append((text_id, b["nr"], ch["chapter"], v["verse"],
                                  v["text"].strip()))
        cur.executemany("INSERT INTO text_books VALUES (?,?,?)", brows)
        cur.executemany("INSERT OR IGNORE INTO verses VALUES (?,?,?,?,?)", vrows)
        print(f"  {text_id}: {len(vrows)} verses")


def load_web_usfm(cur):
    """World English Bible from USFM: same translation as the old web.json but
    with formatting markers, converted to the app's inline-marker scheme:
    \\wj -> <FR> (words of Jesus), \\add -> <FI> (translator-supplied)."""
    src = ROOT / "texts/english/web-usfm"
    cur.execute("INSERT INTO texts VALUES (?,?,?)",
                ("web", "en", "texts/english/web-usfm"))
    nr_names = {nr: name for nr, name, _, _ in BOOKS}
    vrows, brows = [], []
    usfm_map = {code.upper(): nr for code, nr in STEP_TO_NR.items()}
    skipped_files = []
    for path in sorted(src.glob("*.usfm")):
        code = path.name[3:6].upper()
        nr = usfm_map.get(code)
        if nr is None:
            skipped_files.append(path.name)
            continue
        text = path.read_text(encoding="utf-8-sig")
        text = re.sub(r"\\fe? .*?\\fe?\*", "", text, flags=re.S)   # footnotes
        text = re.sub(r"\\x .*?\\x\*", "", text, flags=re.S)       # crossrefs
        # \w word|strong="G123"\w* -> word (keep display form only)
        text = re.sub(r"\\\+?w\s+([^|\\]*?)\|[^\\]*?\\\+?w\*", r"\1", text)
        text = re.sub(r"\\\+?w\s+([^|\\]*?)\\\+?w\*", r"\1", text)
        text = re.sub(r"\\\+?wj\s+", "<FR>", text)
        text = re.sub(r"\\\+?wj\*", "<Fr>", text)
        text = re.sub(r"\\\+?add\s+", "<FI>", text)
        text = re.sub(r"\\\+?add\*", "<Fi>", text)
        # headings / titles out
        text = re.sub(r"^\\(s\d?|r|sp|ms\d?|mr|d|rem|toc\d|h|id|ide|mt\d?)\b.*$",
                      "", text, flags=re.M)
        brows.append(("web", nr, nr_names[nr]))
        for chm in re.finditer(r"\\c (\d+)([\s\S]*?)(?=\\c \d|\Z)", text):
            chapter = int(chm.group(1))
            for vm in re.finditer(r"\\v (\d+)[^\s]* ([\s\S]*?)(?=\\v \d|\Z)",
                                  chm.group(2)):
                body = re.sub(r"\\\+?[a-z0-9]+\*?", " ", vm.group(2))
                body = re.sub(r"\s+", " ", body).strip()
                if body:
                    vrows.append(("web", nr, chapter, int(vm.group(1)), body))
    cur.executemany("INSERT OR IGNORE INTO text_books VALUES (?,?,?)", brows)
    cur.executemany("INSERT OR IGNORE INTO verses VALUES (?,?,?,?,?)", vrows)
    print(f"  web (USFM, red-letter): {len(vrows)} verses")


# Deuterocanon USFM codes -> the numbering kjva/lxx already established
DC_TO_NR = {
    "1ES": (67, "1 Esdras"), "TOB": (69, "Tobit"), "JDT": (70, "Judith"),
    "WIS": (73, "Wisdom"), "SIR": (74, "Sirach"), "BAR": (75, "Baruch"),
    "S3Y": (76, "Prayer of Azariah"), "SUS": (77, "Susanna"),
    "BEL": (78, "Bel and the Dragon"), "MAN": (79, "Prayer of Manasses"),
    "1MA": (80, "1 Maccabees"), "2MA": (81, "2 Maccabees"),
    "3MA": (82, "III Maccabees"), "4MA": (83, "IV Maccabees"),
    "LJE": (91, "Epistle of Jeremiah"),
}


def load_lxxen(cur):
    """Septuagint in English (LXX2012, Brenton updated — eBible.org, public
    domain): OT + full deuterocanon from USFM, same pipeline as WEB."""
    src = ROOT / "texts/english/brenton-lxx/lxx2012"
    cur.execute("INSERT INTO texts VALUES (?,?,?)",
                ("lxxen", "en", "texts/english/brenton-lxx/lxx2012"))
    nr_names = {nr: name for nr, name, _, _ in BOOKS}
    usfm_map = {code.upper(): nr for code, nr in STEP_TO_NR.items()}
    vrows, brows = [], []
    for path in sorted(src.glob("*.usfm")):
        code = path.name[3:6].upper()
        if code in DC_TO_NR:
            nr, bname = DC_TO_NR[code]
        elif code in usfm_map:
            nr = usfm_map[code]
            bname = nr_names[nr]
        else:
            continue                      # front matter / intro files
        text = path.read_text(encoding="utf-8-sig")
        text = re.sub(r"\\fe? .*?\\fe?\*", "", text, flags=re.S)
        text = re.sub(r"\\x .*?\\x\*", "", text, flags=re.S)
        text = re.sub(r"\\\+?w\s+([^|\\]*?)\|[^\\]*?\\\+?w\*", r"\1", text)
        text = re.sub(r"\\\+?w\s+([^|\\]*?)\\\+?w\*", r"\1", text)
        text = re.sub(r"\\\+?add\s+", "<FI>", text)
        text = re.sub(r"\\\+?add\*", "<Fi>", text)
        text = re.sub(r"^\\(s\d?|r|sp|ms\d?|mr|d|rem|toc\d|h|id|ide|mt\d?)\b.*$",
                      "", text, flags=re.M)
        brows.append(("lxxen", nr, bname))
        for chm in re.finditer(r"\\c (\d+)([\s\S]*?)(?=\\c \d|\Z)", text):
            chapter = int(chm.group(1))
            for vm in re.finditer(r"\\v (\d+)[^\s]* ([\s\S]*?)(?=\\v \d|\Z)",
                                  chm.group(2)):
                body = re.sub(r"\\\+?[a-z0-9]+\*?", " ", vm.group(2))
                body = re.sub(r"\s+", " ", body).strip()
                if body:
                    vrows.append(("lxxen", nr, chapter, int(vm.group(1)), body))
    cur.executemany("INSERT OR IGNORE INTO text_books VALUES (?,?,?)", brows)
    cur.executemany("INSERT OR IGNORE INTO verses VALUES (?,?,?,?,?)", vrows)
    print(f"  lxxen (LXX2012 English Septuagint): {len(vrows)} verses, "
          f"{len(brows)} books")


def load_bsb(cur):
    rel = "texts/english/bsb.txt"
    cur.execute("INSERT INTO texts VALUES (?,?,?)", ("bsb", "en", rel))
    line_re = re.compile(r"^(.+?) (\d+):(\d+)\t(.*)$")
    rows, seen_books = [], {}
    unparsed, unknown = 0, set()
    for line in (ROOT / rel).read_text(encoding="utf-8-sig").splitlines():
        m = line_re.match(line)
        if not m:
            if line.strip():
                unparsed += 1
            continue
        name, ch, vs, body = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
        nr = NAME_TO_NR.get(name)
        if nr is None:
            unknown.add(name)
            continue
        seen_books.setdefault(nr, name)
        body = body.strip()
        if body:
            rows.append(("bsb", nr, ch, vs, body))
    cur.executemany("INSERT OR IGNORE INTO text_books VALUES (?,?,?)",
                    [("bsb", nr, n) for nr, n in sorted(seen_books.items())])
    cur.executemany("INSERT OR IGNORE INTO verses VALUES (?,?,?,?,?)", rows)
    if unparsed or unknown:
        print(f"  bsb: skipped {unparsed} unparsed lines, unknown books: {sorted(unknown)}")
    print(f"  bsb: {len(rows)} verses")


def parse_surface(cell):
    """TAGNT surface cell looks like 'Ἐν (En)' — split form and transliteration."""
    m = re.match(r"^(.*?)\s*\(([^)]*)\)\s*$", cell)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    return cell.strip(), None


def load_step_words(cur):
    wid = 0
    for testament, files in (("OT", TAHOT_FILES), ("NT", TAGNT_FILES)):
        for fname in files:
            rows = []
            skipped_ref = 0        # ref-like lines REF_RE did not accept (apparatus rows)
            skipped_book = 0
            with open(STEP_DIR / fname, encoding="utf-8-sig") as f:
                for line in f:
                    cols = line.rstrip("\r\n").split("\t")
                    m = REF_RE.match(cols[0]) if cols else None
                    if not m or len(cols) < 6:
                        if cols and re.match(r"^[1-4]?[A-Za-z]{3}\.\d", cols[0]):
                            skipped_ref += 1
                        continue
                    code, ch, vs, alt, pos, variant = m.groups()
                    nr = STEP_TO_NR.get(code)
                    if nr is None:
                        skipped_book += 1
                        continue
                    if testament == "OT":
                        # TAHOT: surface, translit, gloss, strongs, morph
                        surface, translit, gloss = cols[1], cols[2], cols[3]
                        strongs_raw, morph = cols[4], cols[5]
                        lemma, editions = None, None
                    else:
                        # TAGNT: surface(translit), gloss, strongs=morph, lemma=def, editions
                        surface, translit = parse_surface(cols[1])
                        gloss = cols[2]
                        strongs_raw, _, morph = cols[3].partition("=")
                        lemma = cols[4].split("=", 1)[0] if cols[4] else None
                        editions = cols[5] or None
                    codes = STRONGS_RE.findall(strongs_raw)
                    braced = STRONGS_RE.findall(
                        " ".join(re.findall(r"\{([^}]*)\}", strongs_raw)))
                    primary = (braced or codes or [None])[0]
                    if primary:
                        primary = primary[0] + primary[1:5]  # strip suffix letter
                    wid += 1
                    rows.append((wid, testament, nr, int(ch), int(vs), int(pos),
                                 variant or None, alt, surface.strip(),
                                 (translit or "").strip() or None,
                                 gloss.strip() or None, primary,
                                 " ".join(codes) or None, lemma,
                                 morph.strip() or None, editions,
                                 norm_surface(surface)))
            cur.executemany("INSERT INTO words VALUES "
                            "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
            print(f"  {fname.split(' - ')[0]}: {len(rows)} words"
                  + (f" ({skipped_ref} apparatus/unparsed ref lines skipped)" if skipped_ref else "")
                  + (f" ({skipped_book} rows of unknown books skipped)" if skipped_book else ""))


def parse_strongs_js(path):
    raw = path.read_text(encoding="utf-8")
    start, end = raw.index("{"), raw.rindex("}")
    return json.loads(raw[start:end + 1])


def norm(s):
    """Lowercase and strip combining marks (Greek accents, Hebrew points) so
    searches don't require typing polytonic accents or niqqud."""
    if not s:
        return None
    decomposed = unicodedata.normalize("NFD", s.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


SURFACE_JUNK = re.compile(r"[/·,.;:¶«»“”‘’!?()\[\]־׀׃׆|]")


def norm_surface(s):
    """Normalize a written word form for cross-edition matching: drop
    morpheme separators, punctuation, maqaf/sof-pasuq, then norm()."""
    if not s:
        return None
    return norm(SURFACE_JUNK.sub("", s)) or None


def load_lexicon(cur):
    for lang, rel in (("grc", "resources/lexicons/strongs/greek/strongs-greek-dictionary.js"),
                      ("hbo", "resources/lexicons/strongs/hebrew/strongs-hebrew-dictionary.js")):
        d = parse_strongs_js(ROOT / rel)
        rows = []
        for key in sorted(d):
            e = d[key]
            lemma = e.get("lemma")
            translit = e.get("translit") or e.get("xlit")
            # dictionary keys are unpadded (G26); words use padded (G0026)
            padded = key[0] + key[1:].zfill(4)
            rows.append((padded, lang, lemma, translit,
                         e.get("pron"), e.get("strongs_def"), e.get("kjv_def"),
                         e.get("derivation"), norm(lemma), norm(translit)))
        cur.executemany(
            "INSERT OR REPLACE INTO lexicon VALUES (?,?,?,?,?,?,?,?,?,?)", rows)
        print(f"  {lang} lexicon: {len(rows)} entries")


WN_POS = {"n": "n.", "v": "v.", "a": "adj.", "s": "adj.", "r": "adv."}


def parse_wordnet():
    """WordNet 3.1 data.{pos} files -> {word: {pos: [glosses]}}."""
    words = {}
    base = ROOT / "resources/lexicons/wordnet-3.1/dict"
    for fname in ("data.noun", "data.verb", "data.adj", "data.adv"):
        with open(base / fname, encoding="utf-8") as f:
            for line in f:
                if line.startswith("  ") or "|" not in line:
                    continue
                head, gloss = line.split("|", 1)
                # definition part only; drop quoted example sentences
                definition = gloss.strip().split('; "')[0].strip().rstrip(";")
                fields = head.split()
                pos = WN_POS[fields[2]]
                w_cnt = int(fields[3], 16)
                for i in range(w_cnt):
                    w = fields[4 + i * 2].split("(")[0].replace("_", " ").lower()
                    words.setdefault(w, {}).setdefault(pos, [])
                    if len(words[w][pos]) < 3 and definition not in words[w][pos]:
                        words[w][pos].append(definition)
    return words


def load_dictionary(cur):
    """English dictionary: Webster's 1913 where available (rich, era-appropriate),
    WordNet 3.1 filling every gap (adambom Webster's JSON is incomplete)."""
    path = ROOT / "resources/lexicons/websters-english/dictionary.json"
    d = json.loads(path.read_text(encoding="utf-8"))
    rows = [(k.lower(), v.strip()) for k, v in sorted(d.items()) if v and v.strip()]
    cur.executemany("INSERT OR REPLACE INTO dictionary VALUES (?,?)", rows)
    print(f"  webster's 1913: {len(rows)} entries")

    wn = parse_wordnet()
    wn_rows = []
    for w in sorted(wn):
        parts = []
        for pos in ("n.", "v.", "adj.", "adv."):
            if pos in wn[w]:
                senses = "; ".join(
                    f"{i+1}) {g}" for i, g in enumerate(wn[w][pos]))
                parts.append(f"{pos} {senses}")
        wn_rows.append((w, "  ".join(parts)))
    cur.executemany("INSERT OR IGNORE INTO dictionary VALUES (?,?)", wn_rows)
    total = cur.execute("SELECT COUNT(*) FROM dictionary").fetchone()[0]
    print(f"  + wordnet 3.1: {len(wn_rows)} words -> {total} total entries")


def load_crossrefs(cur):
    rows = []
    path = ROOT / "resources/cross-references/cross_references.txt"
    with open(path, encoding="utf-8") as f:
        next(f)  # header
        skipped = 0
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                skipped += 1
                continue
            src, dst, votes = parts[0], parts[1], parts[2]
            ms = OB_REF_RE.match(src)
            if not ms:
                skipped += 1
                continue
            fb = OB_TO_NR.get(ms.group(1))
            if fb is None:
                skipped += 1
                continue
            md = OB_REF_RE.match(dst.split("-")[0])
            tb = OB_TO_NR.get(md.group(1)) if md else None
            rows.append((fb, int(ms.group(2)), int(ms.group(3)), dst,
                         tb, int(md.group(2)) if md else None,
                         int(md.group(3)) if md else None, int(votes)))
    cur.executemany("INSERT INTO crossrefs VALUES (?,?,?,?,?,?,?,?)", rows)
    unresolved = sum(1 for r in rows if r[4] is None)
    print(f"  crossrefs: {len(rows)} links ({skipped} lines skipped, "
          f"{unresolved} targets unresolved)")


# getBible inline markers (<FI>..<Fi>, <FR>..<Fr>, <FO>..<Fo>); same pattern
# the app strips for display-free contexts (llm.js cleanVerse, app.js snipEl)
MARKER_RE = re.compile(r"<[^<>\s]{1,8}>")


def build_indexes(cur):
    cur.executescript("""
    CREATE INDEX idx_words_strongs ON words(strongs);
    CREATE INDEX idx_words_ref ON words(book_nr, chapter, verse, pos);
    CREATE INDEX idx_words_lemma ON words(lemma);
    CREATE INDEX idx_words_surface_norm ON words(surface_norm);
    CREATE INDEX idx_lexicon_lemma_norm ON lexicon(lemma_norm);
    CREATE INDEX idx_lexicon_translit_norm ON lexicon(translit_norm);
    CREATE INDEX idx_crossrefs_from ON crossrefs(from_book, from_chapter, from_verse);
    CREATE INDEX idx_crossrefs_to ON crossrefs(to_book, to_chapter, to_verse);
    """)
    # Full-text index over MARKER-STRIPPED text. `verses.body` keeps the
    # markers for rendering; indexing them made "fi"/"fr"/"fo" match 15k
    # verses and skewed BM25 length normalisation. body_plain is filled only
    # where it differs; the view folds the two so FTS5's external-content
    # lookups (snippet/highlight) see clean text for every row.
    cur.connection.create_function(
        "strip_markers", 1,
        lambda s: MARKER_RE.sub("", s) if s else s, deterministic=True)
    cur.execute("ALTER TABLE verses ADD COLUMN body_plain TEXT")
    cur.execute("UPDATE verses SET body_plain = strip_markers(body) "
                "WHERE body LIKE '%<%'")
    cur.executescript("""
    CREATE VIEW verses_plain AS
        SELECT rowid AS rowid, COALESCE(body_plain, body) AS body_plain
        FROM verses;
    CREATE VIRTUAL TABLE verses_fts USING fts5(
        body_plain, content='verses_plain', content_rowid='rowid',
        tokenize='unicode61');
    INSERT INTO verses_fts(rowid, body_plain)
        SELECT rowid, body_plain FROM verses_plain;
    """)


def main():
    DB_DIR.mkdir(exist_ok=True)
    # Build into a temp file and only replace db/bible.db once it passes an
    # integrity check: an interrupted build must never leave a truncated DB
    # for build_app_bundle.py to ship.
    tmp = DB_PATH.with_suffix(".db.tmp")
    if tmp.exists():
        tmp.unlink()
    con = sqlite3.connect(tmp)
    cur = con.cursor()
    cur.execute("PRAGMA journal_mode=OFF")
    create_schema(cur)
    cur.executemany("INSERT INTO books VALUES (?,?,?,?)", BOOKS)
    print("Loading getBible texts...")
    load_getbible(cur)
    print("Loading WEB from USFM...")
    load_web_usfm(cur)
    print("Loading WEB reverse interlinear...")
    load_web_words(cur)
    print("Loading English Septuagint (LXX2012)...")
    load_lxxen(cur)
    print("Loading BSB...")
    load_bsb(cur)
    print("Loading STEPBible tagged words...")
    load_step_words(cur)
    print("Loading Strong's lexicon...")
    load_lexicon(cur)
    print("Loading full lexicons (BDB, Abbott-Smith, LSJ)...")
    load_full_lexicons(cur)
    print("Loading morphology code expansions...")
    load_morph_codes(cur)
    print("Loading people / places / events (Theographic + TIPNR)...")
    load_graph(cur)
    print("Loading versification mapping...")
    load_versification(cur)
    print("Loading English dictionary...")
    load_dictionary(cur)
    print("Loading cross-references...")
    load_crossrefs(cur)
    print("Building indexes + full-text search...")
    build_indexes(cur)
    con.commit()
    cur.execute("VACUUM")
    check = cur.execute("PRAGMA integrity_check").fetchone()[0]
    con.close()
    if check != "ok":
        print(f"integrity_check failed: {check}", file=sys.stderr)
        return 1
    os.replace(tmp, DB_PATH)
    size = DB_PATH.stat().st_size / 1e6
    print(f"\nDone: {DB_PATH.relative_to(ROOT).as_posix()} ({size:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())

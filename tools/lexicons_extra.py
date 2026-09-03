"""Full lexicon ingest for db/bible.db — BDB, Abbott-Smith and LSJ.

Called from build_db.py after load_lexicon():

    from lexicons_extra import load_full_lexicons
    load_full_lexicons(cur)

Sources (all read-only; see the licence notes in each folder):
  * resources/lexicons/hebrew-bdb/            openscriptures Hebrew Lexicon
        BrownDriverBriggs.xml  BDB entries (TEI-like XML)
        LexicalIndex.xml       BDB entry id <-> Strong's number
        AugIndex.xml           augmented Strong's (122a) -> LexicalIndex id
    CC BY 4.0 (markup) / public domain (text)
  * resources/lexicons/abbott-smith/abbott-smith.tei.xml
    Abbott-Smith, A Manual Greek Lexicon of the NT (1922), TEI; public domain
  * texts/stepbible-data/Lexicons/TFLSJ*.txt
    STEPBible formatted LSJ keyed by extended Strong's; CC BY 4.0
  * texts/stepbible-data/Lexicons/TBESH*.txt
    only the H9001-H9049 affix/pronoun/punctuation codes (Tyndale-authored);
    the Meaning column of the ordinary entries is Online Bible's abridged
    BDB (permission required) and is NOT loaded.

Output tables:
  lexicon_full(source, strongs, lemma, lemma_norm, entry, entry_len)
      source = 'bdb' | 'abbott-smith' | 'lsj'; one row per (entry, Strong's);
      strongs NULL when the source gives no Strong's link.
      entry = plain text, paragraphs separated by "\\n\\n", with the app's rich
      markers only: ⟦I⟧..⟦/I⟧ italics, ⟦R|book.ch.verse⟧..⟦/R⟧ scripture refs.
  lexicon_affix(strongs, form, translit, morph, gloss, meaning)
      the H9xxx codes used by 6k+ `words` rows that have no lexicon entry.

Deterministic (sorted iteration, no timestamps), stdlib only.
"""
import html
import re
import unicodedata
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BDB_DIR = ROOT / "resources/lexicons/hebrew-bdb"
AS_PATH = ROOT / "resources/lexicons/abbott-smith/abbott-smith.tei.xml"
LEX_DIR = ROOT / "texts/stepbible-data/Lexicons"
TFLSJ_FILES = [
    "TFLSJ  0-5624 - Translators Formatted full LSJ Bible lexicon - STEPBible.org CC BY.txt",
    "TFLSJ extra - Translators Formatted full LSJ Bible lexicon - STEPBible.org CC BY.txt",
]
TBESH_FILE = "TBESH - Translators Brief lexicon of Extended Strongs for Hebrew - STEPBible.org CC BY.txt"

# ------------------------------------------------------------ book code map
# OSIS / openbible codes and STEPBible codes -> canonical book number
# (same numbering as build_db.py BOOKS + DC_TO_NR; kept local because
# build_db runs as __main__ and cannot be imported).
_BOOKS = [
    (1, "Gen", "Gen"), (2, "Exo", "Exod"), (3, "Lev", "Lev"), (4, "Num", "Num"),
    (5, "Deu", "Deut"), (6, "Jos", "Josh"), (7, "Jdg", "Judg"), (8, "Rut", "Ruth"),
    (9, "1Sa", "1Sam"), (10, "2Sa", "2Sam"), (11, "1Ki", "1Kgs"), (12, "2Ki", "2Kgs"),
    (13, "1Ch", "1Chr"), (14, "2Ch", "2Chr"), (15, "Ezr", "Ezra"), (16, "Neh", "Neh"),
    (17, "Est", "Esth"), (18, "Job", "Job"), (19, "Psa", "Ps"), (20, "Pro", "Prov"),
    (21, "Ecc", "Eccl"), (22, "Sng", "Song"), (23, "Isa", "Isa"), (24, "Jer", "Jer"),
    (25, "Lam", "Lam"), (26, "Ezk", "Ezek"), (27, "Dan", "Dan"), (28, "Hos", "Hos"),
    (29, "Jol", "Joel"), (30, "Amo", "Amos"), (31, "Oba", "Obad"), (32, "Jon", "Jonah"),
    (33, "Mic", "Mic"), (34, "Nam", "Nah"), (35, "Hab", "Hab"), (36, "Zep", "Zeph"),
    (37, "Hag", "Hag"), (38, "Zec", "Zech"), (39, "Mal", "Mal"), (40, "Mat", "Matt"),
    (41, "Mrk", "Mark"), (42, "Luk", "Luke"), (43, "Jhn", "John"), (44, "Act", "Acts"),
    (45, "Rom", "Rom"), (46, "1Co", "1Cor"), (47, "2Co", "2Cor"), (48, "Gal", "Gal"),
    (49, "Eph", "Eph"), (50, "Php", "Phil"), (51, "Col", "Col"), (52, "1Th", "1Thess"),
    (53, "2Th", "2Thess"), (54, "1Ti", "1Tim"), (55, "2Ti", "2Tim"), (56, "Tit", "Titus"),
    (57, "Phm", "Phlm"), (58, "Heb", "Heb"), (59, "Jas", "Jas"), (60, "1Pe", "1Pet"),
    (61, "2Pe", "2Pet"), (62, "1Jn", "1John"), (63, "2Jn", "2John"), (64, "3Jn", "3John"),
    (65, "Jud", "Jude"), (66, "Rev", "Rev"),
    # deuterocanon: numbering shared with kjva / lxx / lxxen text_books
    (67, "1Es", "1Esd"), (68, "2Es", "2Esd"), (69, "Tob", "Tob"), (70, "Jdt", "Jdt"),
    (71, "Esg", "AddEsth"), (73, "Wis", "Wis"), (74, "Sir", "Sir"), (75, "Bar", "Bar"),
    (76, "S3Y", "PrAzar"), (77, "Sus", "Sus"), (78, "Bel", "Bel"), (79, "Man", "PrMan"),
    (80, "1Ma", "1Macc"), (81, "2Ma", "2Macc"), (82, "3Ma", "3Macc"), (83, "4Ma", "4Macc"),
    (90, "PsS", "PssSol"), (91, "LJe", "EpJer"),
]
CODE_TO_NR = {}
for _nr, _step, _osis in _BOOKS:
    CODE_TO_NR[_step] = _nr
    CODE_TO_NR[_osis] = _nr
# spellings met in the STEPBible LSJ hover text
CODE_TO_NR.update({"Mat": 40, "1Mac": 80, "2Mac": 81, "3Mac": 82, "4Mac": 83,
                   "Jdg": 7, "Jos": 6, "Sol": 22, "Eccles": 21})

REF_RE = re.compile(r"^([1-4]?[A-Za-z]+)\.(\d+)\.(\d+)")


def ref_target(code_ref):
    """'Job.8.12' / 'Matt.13.20-Matt.13.23' -> '18.8.12' or None."""
    m = REF_RE.match(code_ref or "")
    if not m:
        return None
    nr = CODE_TO_NR.get(m.group(1))
    if nr is None:
        return None
    return f"{nr}.{int(m.group(2))}.{int(m.group(3))}"


# --------------------------------------------------------------- normalize
def norm(s):
    """Same rule as build_db.norm: casefold (ς -> σ) and strip combining
    marks (Greek accents, Hebrew points)."""
    if not s:
        return None
    decomposed = unicodedata.normalize("NFD", s.casefold())
    return "".join(c for c in decomposed if not unicodedata.combining(c))


def pad_strongs(s):
    """'G26' / 'H1' / '430' (Hebrew) -> 'G0026' / 'H0001' / 'H0430'."""
    m = re.match(r"^([GH]?)(\d+)$", s or "")
    if not m:
        return None
    return (m.group(1) or "H") + m.group(2).zfill(4)


WS_RE = re.compile(r"\s+")
SPACE_BEFORE_PUNCT = re.compile(r"\s+([,;:.)\]])")


def finish_paragraphs(parts):
    """List of paragraph fragments (None = paragraph break) -> entry text."""
    paras, buf = [], []
    for p in parts:
        if p is None:
            if buf:
                paras.append("".join(buf))
                buf = []
        else:
            buf.append(p)
    if buf:
        paras.append("".join(buf))
    out = []
    for p in paras:
        p = re.sub(r"⟦I⟧\s+", "⟦I⟧", p)      # keep spaces outside markers
        p = re.sub(r"\s+⟦/I⟧", "⟦/I⟧ ", p)
        p = WS_RE.sub(" ", p).strip()
        p = SPACE_BEFORE_PUNCT.sub(r"\1", p)
        if p:
            out.append(p)
    return "\n\n".join(out)


# ------------------------------------------------------------- XML walkers
def _local(tag):
    return tag.rsplit("}", 1)[-1]


class _Walker:
    """Shared element-tree -> paragraph-fragment renderer. Subclasses set
    ITALIC (tags rendered ⟦I⟧..⟦/I⟧), DROP (tags dropped with their content),
    BREAK (tags that start a new paragraph) and REF (tag + attribute holding
    a book.ch.verse style reference)."""
    ITALIC = set()
    DROP = set()
    BREAK = set()
    REF = ("ref", "r")
    SENSE = "sense"

    def render(self, elem):
        self.parts = [elem.text]
        self._walk(elem)
        return finish_paragraphs(self.parts)

    def _text(self, s):
        if s:
            self.parts.append(s)

    def _walk(self, elem):
        for child in elem:
            tag = _local(child.tag)
            if tag in self.DROP:
                self._text(child.tail)
                continue
            if tag == self.SENSE:
                self.parts.append(None)
                n = (child.get("n") or "").strip()
                if n:
                    self._text(n + ("" if n.endswith((".", ")")) else ".") + " ")
                self._text(child.text)
                self._walk(child)
                self.parts.append(None)
                self._text(child.tail)
                continue
            if tag in self.BREAK:
                self.parts.append(None)
                self._text(child.text)
                self._walk(child)
                self.parts.append(None)
                self._text(child.tail)
                continue
            if tag == self.REF[0]:
                target = ref_target(child.get(self.REF[1]))
                if target:
                    self.parts.append(f"⟦R|{target}⟧")
                self._text(child.text)
                self._walk(child)
                if target:
                    self.parts.append("⟦/R⟧")
                self._text(child.tail)
                continue
            if tag in self.ITALIC:
                self.parts.append("⟦I⟧")
                self._text(child.text)
                self._walk(child)
                self.parts.append("⟦/I⟧")
                self._text(child.tail)
                continue
            if tag == "cell":
                self._text(child.text)
                self._walk(child)
                self._text(" ")
                self._text(child.tail)
                continue
            self._text(child.text)
            self._walk(child)
            self._text(child.tail)


class BdbWalker(_Walker):
    ITALIC = {"def", "em", "stem"}
    DROP = {"status", "page"}
    BREAK = set()
    REF = ("ref", "r")


class AbbottSmithWalker(_Walker):
    ITALIC = {"gloss", "emph"}
    DROP = {"pb", "note_occ"}
    BREAK = {"re", "p", "div", "head", "row", "lb", "table"}
    REF = ("ref", "osisRef")

    def _walk(self, elem):
        # occurrence-count notes are metadata, not entry text
        for child in elem:
            if _local(child.tag) == "note" and child.get("type") == "occurrencesNT":
                child.tag = "note_occ"
        super()._walk(elem)


# ---------------------------------------------------------------------- BDB
BDB_NS = "{http://openscriptures.github.com/morphhb/namespace}"


def _bdb_strongs_map():
    """BDB entry id -> sorted list of padded Strong's numbers, via
    LexicalIndex.xml (strong= attribute) and AugIndex.xml (augmented
    numbers such as 122a, mapped by their numeric part)."""
    li_root = ET.parse(BDB_DIR / "LexicalIndex.xml").getroot()
    li_bdb, li_lemma = {}, {}
    bdb_strongs = {}
    for entry in li_root.iter(BDB_NS + "entry"):
        lid = entry.get("id")
        xref = entry.find(BDB_NS + "xref")
        w = entry.find(BDB_NS + "w")
        if w is not None and w.text:
            li_lemma[lid] = w.text.strip()
        if xref is None or not xref.get("bdb"):
            continue
        bid = xref.get("bdb")
        li_bdb[lid] = bid
        s = pad_strongs(xref.get("strong"))
        if s:
            bdb_strongs.setdefault(bid, set()).add(s)
    aug_root = ET.parse(BDB_DIR / "AugIndex.xml").getroot()
    for w in aug_root.iter(BDB_NS + "w"):
        s = pad_strongs(re.sub(r"[a-z]+$", "", w.get("aug") or ""))
        bid = li_bdb.get((w.text or "").strip())
        if s and bid:
            bdb_strongs.setdefault(bid, set()).add(s)
    bdb_lemma = {}
    for lid, bid in li_bdb.items():
        if lid in li_lemma:
            bdb_lemma.setdefault(bid, li_lemma[lid])
    return {k: sorted(v) for k, v in bdb_strongs.items()}, bdb_lemma


def load_bdb():
    strongs_map, li_lemma = _bdb_strongs_map()
    root = ET.parse(BDB_DIR / "BrownDriverBriggs.xml").getroot()
    walker = BdbWalker()
    rows = []
    for entry in root.iter(BDB_NS + "entry"):
        eid = entry.get("id")
        w = entry.find(BDB_NS + "w")
        lemma = (w.text or "").strip() if w is not None else ""
        lemma = lemma or li_lemma.get(eid) or ""
        # headword paragraph: entry.text + children up to the first sense
        text = walker.render(entry)
        if not text:
            continue
        for s in strongs_map.get(eid) or [None]:
            rows.append(("bdb", s, lemma, norm(lemma), text, len(text)))
    return rows


# ------------------------------------------------------------ Abbott-Smith
AS_NS = "{http://www.crosswire.org/2013/TEIOSIS/namespace}"


def load_abbott_smith():
    root = ET.parse(AS_PATH).getroot()
    walker = AbbottSmithWalker()
    rows = []
    body = root.find(AS_NS + "text").find(AS_NS + "body")
    parent_of = {c: p for p in body.iter() for c in p}
    for entry in body.iter(AS_NS + "entry"):
        parts = (entry.get("n") or "").split("|")
        strongs = [pad_strongs(p) for p in parts if re.match(r"^G\d+$", p)]
        lemmas = [p for p in parts if not re.match(r"^G\d+$", p)]
        if not strongs:
            parent = parent_of.get(entry)
            if parent is not None and _local(parent.tag) == "superEntry":
                ps = [pad_strongs(p) for p in (parent.get("n") or "").split("|")
                      if re.match(r"^G\d+$", p)]
                if len(ps) == 1:
                    strongs = ps
        lemma = lemmas[0] if lemmas else ""
        text = walker.render(entry)
        if not text:
            continue
        for s in strongs or [None]:
            rows.append(("abbott-smith", s, lemma, norm(lemma), text, len(text)))
    return rows


# ---------------------------------------------------------------------- LSJ
LSJ_LINE = re.compile(r"^G\d+\t")
A_RE = re.compile(r'<a\b[^>]*?title="([^"]*)"[^>]*>(.*?)</a>', re.S | re.I)
A_PLAIN_RE = re.compile(r"<a\b[^>]*>(.*?)</a>", re.S | re.I)
BR_RE = re.compile(r"<br\s*/?>", re.I)
LEVEL_RE = re.compile(r"</?Level\d>", re.I)
SECTION_RE = re.compile(r"<b>\s*__([^<\s]+)\s*</b>")
ITAL_OPEN_RE = re.compile(r"<(?:b|i|u)>", re.I)
ITAL_CLOSE_RE = re.compile(r"</(?:b|i|u)>", re.I)
TAG_RE = re.compile(r"<[^>]+>")
BIBLE_REF_RE = re.compile(r"\b(?:NT|LXX)\.([1-4]?[A-Za-z]+)\.(\d+)\.(\d+)")
TITLE_KEEP = 120   # hover bibliographies up to this length are kept inline


def _lsj_anchor(m):
    title = WS_RE.sub(" ", m.group(1)).strip()
    visible = m.group(2)
    if title and (len(title) <= TITLE_KEEP or "NT." in title or "LXX." in title):
        return title
    return visible


def _lsj_ref(m):
    if m.group(0).startswith("LXX.") and m.group(1) in ("Ps", "Psa"):
        return m.group(0)    # LXX Psalm numbering differs — leave as text
    target = ref_target(f"{m.group(1)}.{m.group(2)}.{m.group(3)}")
    if not target:
        return m.group(0)
    return f"⟦R|{target}⟧{m.group(0)}⟦/R⟧"


def lsj_to_text(raw):
    s = A_RE.sub(_lsj_anchor, raw)
    s = A_PLAIN_RE.sub(r"\1", s)
    s = BR_RE.sub("\n\n", s)
    s = LEVEL_RE.sub("", s)
    # section markers (__I, __I.1.b) start their own paragraph
    s = SECTION_RE.sub(lambda m: "\n\n" + m.group(1)
                       + ("" if m.group(1).endswith(".") else "."), s)
    s = ITAL_OPEN_RE.sub("⟦I⟧", s)
    s = ITAL_CLOSE_RE.sub("⟦/I⟧", s)
    s = TAG_RE.sub("", s)
    s = html.unescape(s)
    s = BIBLE_REF_RE.sub(_lsj_ref, s)
    parts = []
    for p in re.split(r"\n\s*\n", s):
        parts.append(p)
        parts.append(None)
    return finish_paragraphs(parts)


def load_lsj():
    seen = set()
    rows = []
    for name in TFLSJ_FILES:
        with open(LEX_DIR / name, encoding="utf-8-sig") as f:
            for line in f:
                if not LSJ_LINE.match(line):
                    continue
                cols = line.rstrip("\n").split("\t")
                if len(cols) < 8:
                    continue
                estrong, greek, meaning = cols[0].strip(), cols[3].strip(), cols[7]
                key = (estrong, greek, meaning)
                if key in seen:
                    continue
                seen.add(key)
                text = lsj_to_text(meaning)
                if not text:
                    continue
                lemma_norm = norm(greek.split(",")[0].strip())
                rows.append(("lsj", estrong, greek, lemma_norm, text, len(text)))
    return rows


# --------------------------------------------------------------- H9xxx codes
def load_affixes():
    rows = []
    with open(LEX_DIR / TBESH_FILE, encoding="utf-8-sig") as f:
        for line in f:
            if not re.match(r"^H9\d{3}\t", line):
                continue
            cols = line.rstrip("\n").split("\t")
            if len(cols) < 8:
                continue
            rows.append((cols[0].strip(), cols[3].strip(), cols[4].strip(),
                         cols[5].strip(), cols[6].strip(), cols[7].strip()))
    return rows


# ------------------------------------------------------------------- driver
def load_full_lexicons(cur):
    cur.executescript("""
    DROP TABLE IF EXISTS lexicon_full;
    DROP TABLE IF EXISTS lexicon_affix;
    CREATE TABLE lexicon_full (
        source TEXT NOT NULL,        -- 'bdb' | 'abbott-smith' | 'lsj'
        strongs TEXT,                -- G0001 / H0001 form when known
        lemma TEXT,                  -- headword as printed
        lemma_norm TEXT,             -- casefolded, accents/points stripped
        entry TEXT NOT NULL,         -- plain text + ⟦I⟧/⟦R|b.c.v⟧ markers
        entry_len INTEGER NOT NULL);
    CREATE TABLE lexicon_affix (     -- STEPBible H9001-H9049 affix codes
        strongs TEXT PRIMARY KEY, form TEXT, translit TEXT, morph TEXT,
        gloss TEXT, meaning TEXT);
    """)
    rows = []
    for loader, label in ((load_bdb, "bdb"), (load_abbott_smith, "abbott-smith"),
                          (load_lsj, "lsj")):
        part = loader()
        print(f"  {label}: {len(part)} entries")
        rows.extend(part)
    rows.sort(key=lambda r: (r[0], r[1] or "", r[2], r[4]))
    cur.executemany("INSERT INTO lexicon_full VALUES (?,?,?,?,?,?)", rows)
    affixes = load_affixes()
    cur.executemany("INSERT OR REPLACE INTO lexicon_affix VALUES (?,?,?,?,?,?)", affixes)
    print(f"  affix codes: {len(affixes)} entries")
    cur.executescript("""
    CREATE INDEX idx_lexfull_strongs ON lexicon_full(strongs);
    CREATE INDEX idx_lexfull_lemma_norm ON lexicon_full(lemma_norm, source);
    """)

"""WEB reverse interlinear — per-word Strong's tags for the World English Bible.

The eBible.org WEB USFM (texts/english/web-usfm/, public domain) tags nearly
every word: ``\\w word|strong="G3056"\\w*``.  build_db.load_web_usfm strips
those tags when it builds ``verses`` (text_id 'web'); this module re-reads the
same USFM with the same parsing pipeline and records, for every whitespace
token of every WEB verse body, which Strong's number(s) stood behind it.

Table ``verse_words`` (one row per token, dense — untagged tokens get NULL):

    pos   = 0-based index into  stripMarkers(verses.body).trim().split(/\\s+/)
            where stripMarkers removes the <FI>/<Fi>/<FR>/<Fr> inline markers
    word  = that token, punctuation attached, exactly as in verses.body
    strongs      = primary code, normalised to G0001/H0001 (4 digits, no suffix)
    strongs_all  = every code seen inside the token, space-joined, as given

Alignment is guaranteed by construction: the token list is produced from the
identical text transform load_web_usfm applies, just with the Strong's codes
carried alongside each character instead of discarded.  load_web_words also
re-checks the result against the ``verses`` rows already in the database.

Stdlib only, deterministic (sorted file order, no timestamps).  Public API:
    load_web_words(cur)   -- create table + index, fill, print counts
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "texts/english/web-usfm"
TEXT_ID = "web"

# USFM book codes in canonical 66-book order (nr = index + 1); these are the
# STEPBible codes upper-cased, exactly as build_db.load_web_usfm resolves them.
USFM_CODES = [
    "GEN", "EXO", "LEV", "NUM", "DEU", "JOS", "JDG", "RUT", "1SA", "2SA",
    "1KI", "2KI", "1CH", "2CH", "EZR", "NEH", "EST", "JOB", "PSA", "PRO",
    "ECC", "SNG", "ISA", "JER", "LAM", "EZK", "DAN", "HOS", "JOL", "AMO",
    "OBA", "JON", "MIC", "NAM", "HAB", "ZEP", "HAG", "ZEC", "MAL", "MAT",
    "MRK", "LUK", "JHN", "ACT", "ROM", "1CO", "2CO", "GAL", "EPH", "PHP",
    "COL", "1TH", "2TH", "1TI", "2TI", "TIT", "PHM", "HEB", "JAS", "1PE",
    "2PE", "1JN", "2JN", "3JN", "JUD", "REV",
]
CODE_TO_NR = {code: i + 1 for i, code in enumerate(USFM_CODES)}

# Private-use sentinels that survive every later regex untouched: a tagged
# span becomes  \x01<codes>\x02<text>\x03  and is unwrapped at the very end.
W_OPEN, W_SEP, W_CLOSE = "\x01", "\x02", "\x03"
W_TAG_RE = re.compile(r"\\\+?w\s+([^|\\]*?)\|([^\\]*?)\\\+?w\*")
W_PLAIN_RE = re.compile(r"\\\+?w\s+([^|\\]*?)\\\+?w\*")
STRONG_ATTR_RE = re.compile(r'strong="([^"]*)"')
MARKER_RE = re.compile(r"<[^<>\s]{1,8}>")          # app's inline markers
CODE_RE = re.compile(r"^([GH])0*(\d+)[A-Za-z]*$")


def norm_code(code):
    """'G3056' / 'H0430' / 'H1234a' -> 'G3056' / 'H0430' / 'H1234'; else None."""
    m = CODE_RE.match(code.strip())
    return f"{m.group(1)}{int(m.group(2)):04d}" if m else None


def _tag_repl(m):
    codes = []
    for val in STRONG_ATTR_RE.findall(m.group(2)):
        codes.extend(c for c in re.split(r"[,\s]+", val.strip()) if c)
    if not codes:
        return m.group(1)
    return f"{W_OPEN}{' '.join(codes)}{W_SEP}{m.group(1)}{W_CLOSE}"


def _prepare(text):
    """Mirror of load_web_usfm's whole-file transforms, keeping \\w codes."""
    text = re.sub(r"\\fe? .*?\\fe?\*", "", text, flags=re.S)   # footnotes
    text = re.sub(r"\\x .*?\\x\*", "", text, flags=re.S)       # crossrefs
    text = W_TAG_RE.sub(_tag_repl, text)
    text = W_PLAIN_RE.sub(r"\1", text)
    text = re.sub(r"\\\+?wj\s+", "<FR>", text)
    text = re.sub(r"\\\+?wj\*", "<Fr>", text)
    text = re.sub(r"\\\+?add\s+", "<FI>", text)
    text = re.sub(r"\\\+?add\*", "<Fi>", text)
    text = re.sub(r"^\\(s\d?|r|sp|ms\d?|mr|d|rem|toc\d|h|id|ide|mt\d?)\b.*$",
                  "", text, flags=re.M)
    return text


def _chars_with_codes(chunk):
    """Verse chunk (sentinel form) -> list of (char, codes-or-None) after the
    same residual-marker strip + whitespace collapse load_web_usfm applies."""
    chunk = re.sub(r"\\\+?[a-z0-9]+\*?", " ", chunk)
    pairs, codes, i, n = [], None, 0, len(chunk)
    while i < n:
        ch = chunk[i]
        if ch == W_OPEN:
            j = chunk.index(W_SEP, i)
            codes = chunk[i + 1:j]
            i = j + 1
            continue
        if ch == W_CLOSE:
            codes = None
        elif ch.isspace():
            if pairs and pairs[-1][0] != " ":
                pairs.append((" ", None))
        else:
            pairs.append((ch, codes))
        i += 1
    if pairs and pairs[-1][0] == " ":
        pairs.pop()
    return pairs


def _tokens(pairs):
    """(char, codes) list -> [(pos, word, strongs, strongs_all)] over the
    marker-stripped text, split on whitespace exactly as the app does."""
    plain = "".join(c for c, _ in pairs)
    keep = [True] * len(pairs)
    for m in MARKER_RE.finditer(plain):
        for k in range(m.start(), m.end()):
            keep[k] = False
    rows, word, seen, pos = [], [], [], 0
    for (ch, codes), k in zip(pairs, keep):
        if not k:
            continue
        if ch.isspace():
            if word:
                rows.append(_row(pos, word, seen))
                pos += 1
                word, seen = [], []
            continue
        word.append(ch)
        if codes:
            for c in codes.split(" "):
                if c not in seen:
                    seen.append(c)
    if word:
        rows.append(_row(pos, word, seen))
    return plain, rows


def _row(pos, word, seen):
    primary = next((p for p in (norm_code(c) for c in seen) if p), None)
    return (pos, "".join(word), primary, " ".join(seen) if seen else None)


def iter_verses():
    """Yield (book_nr, chapter, verse, body, rows) for every WEB verse, in the
    same order and with the same keys load_web_usfm produces."""
    seen = set()
    for path in sorted(SRC.glob("*.usfm")):
        nr = CODE_TO_NR.get(path.name[3:6].upper())
        if nr is None:
            continue
        text = _prepare(path.read_text(encoding="utf-8-sig"))
        for chm in re.finditer(r"\\c (\d+)([\s\S]*?)(?=\\c \d|\Z)", text):
            chapter = int(chm.group(1))
            for vm in re.finditer(r"\\v (\d+)[^\s]* ([\s\S]*?)(?=\\v \d|\Z)",
                                  chm.group(2)):
                verse = int(vm.group(1))
                pairs = _chars_with_codes(vm.group(2))
                if not pairs:
                    continue
                key = (nr, chapter, verse)
                if key in seen:            # INSERT OR IGNORE keeps the first
                    continue
                seen.add(key)
                body, rows = _tokens(pairs)
                yield nr, chapter, verse, body, rows


def load_web_words(cur):
    cur.execute("DROP TABLE IF EXISTS verse_words")
    cur.execute("""
        CREATE TABLE verse_words (
            text_id TEXT NOT NULL, book_nr INTEGER NOT NULL,
            chapter INTEGER NOT NULL, verse INTEGER NOT NULL,
            pos INTEGER NOT NULL,
            word TEXT NOT NULL,
            strongs TEXT,
            strongs_all TEXT,
            PRIMARY KEY (text_id, book_nr, chapter, verse, pos)
        ) WITHOUT ROWID""")
    total, tagged, mismatched, checked = 0, 0, 0, 0
    have_verses = cur.execute(
        "SELECT COUNT(*) FROM verses WHERE text_id=?", (TEXT_ID,)).fetchone()[0]
    batch = []
    for nr, chapter, verse, body, rows in iter_verses():
        if have_verses:
            got = cur.execute(
                "SELECT body FROM verses WHERE text_id=? AND book_nr=? "
                "AND chapter=? AND verse=?", (TEXT_ID, nr, chapter, verse)
            ).fetchone()
            checked += 1
            if got is None or MARKER_RE.sub("", got[0]).split() != \
                    [r[1] for r in rows]:
                mismatched += 1
        for pos, word, strongs, strongs_all in rows:
            batch.append((TEXT_ID, nr, chapter, verse, pos, word,
                          strongs, strongs_all))
            total += 1
            tagged += strongs is not None
        if len(batch) >= 50000:
            cur.executemany("INSERT OR IGNORE INTO verse_words VALUES "
                            "(?,?,?,?,?,?,?,?)", batch)
            batch = []
    cur.executemany("INSERT OR IGNORE INTO verse_words VALUES (?,?,?,?,?,?,?,?)",
                    batch)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_verse_words_strongs "
                "ON verse_words(strongs) WHERE strongs IS NOT NULL")
    print(f"  verse_words (WEB reverse interlinear): {total} tokens, "
          f"{tagged} with Strong's"
          + (f", alignment mismatches {mismatched}/{checked}" if checked else ""))

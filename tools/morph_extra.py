"""Morphology code expansions (STEPBible TEGMC / TEHMC, CC BY 4.0).

Loads the "FULL MORPHOLOGY CODES" sections of both files into bible.db:

    morph_codes(lang, code, summary, explanation, example)

`lang` is 'grc' or 'hbo'. Greek codes are the Robinson-style codes used in
`words.morph` for the NT ("V-PAI-3S"). Hebrew/Aramaic codes are the
OpenScriptures-style codes ("HNcmsc"); compound OT codes in `words.morph`
("HTd/Ncmsa", "Hc/Vqw3ms") are strings of these joined by "/", where every
part after the first drops the language letter — the app splits them and looks
each part up with the language letter restored.

Record format in the source (records separated by a line containing "$"):
    line 1: CODE<TAB>Function=...; Case=...   (the element list)
    line 2: summary phrase ("Verb Present Active Indicative 3rd Singular")
    line 3: explanation in plain English
    line 4: example sentence
Stdlib only, deterministic. Called from build_db.py as load_morph_codes(cur).
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MORPH_DIR = ROOT / "texts" / "stepbible-data" / "Morphology codes"
FILES = [
    ("grc", "TEGMC - Translators Expansion of Greek Morphhology Codes - STEPBible.org CC BY.txt"),
    ("hbo", "TEHMC - Translators Expansion of Hebrew Morphology Codes - STEPBible.org CC BY.txt"),
]
CODE_RE = re.compile(r"^([A-Za-z][A-Za-z0-9/:+\-]*)\t(.*)$")


def _clean(s):
    s = s.strip().strip('"').strip()
    return re.sub(r"\s+", " ", s)


def parse_file(path):
    text = path.read_text(encoding="utf-8-sig")
    head, sep, body = text.partition("FULL MORPHOLOGY CODES")
    if not sep:
        raise ValueError(f"{path.name}: no FULL MORPHOLOGY CODES section")
    records = []
    for block in body.split("\n$\n"):
        lines = [ln.rstrip("\r") for ln in block.strip("\n").split("\n")]
        if not lines:
            continue
        m = CODE_RE.match(lines[0])
        if not m:
            continue
        code = m.group(1)
        elements = _clean(m.group(2))
        summary = _clean(lines[1]) if len(lines) > 1 else ""
        explanation = _clean(lines[2]) if len(lines) > 2 else ""
        example = _clean(lines[3]) if len(lines) > 3 else ""
        if not summary:
            summary = elements
        records.append((code, summary, explanation, example))
    return records


def load_morph_codes(cur):
    cur.executescript("""
    CREATE TABLE morph_codes (
        lang TEXT NOT NULL,            -- 'grc' | 'hbo'
        code TEXT NOT NULL,            -- as used in words.morph (or one part of a compound OT code)
        summary TEXT NOT NULL,         -- "Verb Present Active Indicative 3rd Singular"
        explanation TEXT NOT NULL,     -- plain-English function
        example TEXT NOT NULL,
        PRIMARY KEY (lang, code));
    """)
    for lang, name in FILES:
        path = MORPH_DIR / name
        if not path.exists():
            print(f"  MISSING: {path.name}")
            continue
        rows = {}
        for code, summary, expl, ex in parse_file(path):
            rows.setdefault(code, (lang, code, summary, expl, ex))  # first wins
        cur.executemany("INSERT INTO morph_codes VALUES (?,?,?,?,?)",
                        [rows[k] for k in sorted(rows)])
        print(f"  morph codes {lang}: {len(rows)}")

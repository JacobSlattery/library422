"""graph_extra.py -- people / places / events knowledge layer for db/bible.db.

Sources (read-only, never modified here):
  resources/metadata/theographic/CSV/*.csv
      Theographic Bible Metadata (viz.bible) -- CC BY-SA 4.0.
      People, Places (with lat/long), Events (dated timeline), PeopleGroups,
      Easton's Bible Dictionary (1897, public domain) already joined to people
      and places. Verse refs are OSIS strings ("Gen.1.1"); the book part equals
      the openbible code column (books.ob_code) of bible.db exactly.
  texts/stepbible-data/Proper Nouns/TIPNR ... STEPBible.org CC BY.txt
      STEPBible "Translators Individualised Proper Names with all References"
      (Tyndale House) -- CC BY 4.0. Every proper name disambiguated to an
      individual person/place/other with a unique uStrong, every spelling with
      its Hebrew/Greek form + disambiguated Strong's, family relations, and an
      exhaustive verse list (STEP book codes = books.step_code).
      NOTE: the @Brief/@Short/@Article prose in TIPNR is, per its own header,
      "Adapted from the output by Claude 3 Opus AI in April 2024" -- stored in
      the `summary`/`article` columns so the UI can label it as such. The
      structured `description` column ("Priest living at the time of Divided
      Monarchy") is STEPBible's own data.

Entry point: load_graph(cur) -- (re)creates the tables below, loads both
sources, merges TIPNR records into Theographic entities where name + verses
agree, keeps everything else under `tipnr:` ids, and prints counts.

stdlib only; deterministic: sorted iteration everywhere, ids derived from the
sources (Theographic slugs, TIPNR uStrong numbers).
"""
import csv
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
THEO_DIR = ROOT / "resources" / "metadata" / "theographic" / "CSV"
TIPNR_PATH = (ROOT / "texts" / "stepbible-data" / "Proper Nouns" /
              "TIPNR - Translators Individualised Proper Names with all References"
              " - STEPBible.org CC BY.txt")

# nr, STEP code (TIPNR refs), OSIS/openbible code (Theographic refs).
# Same table as build_db.BOOKS; duplicated so this module has no import cycle.
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
]
STEP_TO_NR = {step: nr for nr, step, _ in _BOOKS}
OSIS_TO_NR = {osis: nr for nr, _, osis in _BOOKS}

SCHEMA = """
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS places;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS event_links;
DROP TABLE IF EXISTS entity_other;
DROP TABLE IF EXISTS entity_verses;
DROP TABLE IF EXISTS entity_names;
DROP TABLE IF EXISTS person_relations;
DROP TABLE IF EXISTS easton;

CREATE TABLE people (
    id TEXT PRIMARY KEY,            -- Theographic slug (aaron_1) or tipnr:<uStrong>
    name TEXT NOT NULL,
    gender TEXT,                    -- 'Male' | 'Female' | NULL
    description TEXT,               -- TIPNR structured description, else Theographic disambiguation
    summary TEXT,                   -- TIPNR @Short (AI-adapted prose, label it in the UI)
    article TEXT,                   -- TIPNR @Article (AI-adapted prose; <BR> = paragraph break)
    birth_year INTEGER,             -- Theographic; negative = BC
    death_year INTEGER,
    min_year INTEGER,               -- Theographic floruit bounds (always present)
    max_year INTEGER,
    father_id TEXT, mother_id TEXT,
    tribe TEXT,                     -- 'Tribe of Levi' etc.
    groups TEXT,                    -- Theographic memberOf, comma-joined
    birth_place_id TEXT, death_place_id TEXT,
    easton TEXT,                    -- Easton's Bible Dictionary entry when matched
    source TEXT NOT NULL,           -- 'theographic' | 'tipnr' | 'both'
    tipnr_name TEXT,                -- TIPNR UnifiedName, e.g. Aaron@Exo.4.14-Heb
    ustrong TEXT,                   -- TIPNR unified Strong's (H0175)
    verse_count INTEGER NOT NULL);
CREATE TABLE places (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT,                      -- Theographic featureType: City, Region, Mountain, Water...
    sub_kind TEXT,                  -- featureSubType: River, Gate, Country, Spring...
    description TEXT,
    summary TEXT, article TEXT,     -- TIPNR prose (AI-adapted)
    lat REAL, lon REAL,             -- Theographic latitude/longitude, else TIPNR map link
    modern_name TEXT,               -- only where Theographic comment says "Now X"
    area TEXT,                      -- TIPNR geographical area ('Tribe of Judah', 'Asia Minor')
    root_id TEXT,                   -- Theographic rootID: the place this one belongs to
    duplicate_of TEXT,              -- Theographic duplicate_of
    easton TEXT,
    source TEXT NOT NULL, tipnr_name TEXT, ustrong TEXT,
    verse_count INTEGER NOT NULL);
CREATE TABLE events (
    id TEXT PRIMARY KEY,            -- ev:<Theographic eventID>
    title TEXT NOT NULL,
    description TEXT,               -- Theographic notes (rare)
    start_year INTEGER,             -- negative = BC
    end_year INTEGER,               -- start + duration years (same year for D/W/M durations)
    start_date TEXT,                -- raw Theographic startDate (ISO where known)
    duration TEXT,                  -- raw ('1D', '40Y', '3M10D')
    period TEXT,                    -- Theographic partOf (parent event / era title)
    predecessor_id TEXT,
    sort_key INTEGER NOT NULL);     -- 1..N chronological rank
CREATE TABLE event_links (          -- participants and locations of events
    event_id TEXT NOT NULL, entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL);
CREATE TABLE entity_other (         -- TIPNR non-person/place names + Theographic people groups
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,             -- Group, Supernatural, Time, Musical, Title, Star, Language, Other
    description TEXT, summary TEXT, article TEXT,
    source TEXT NOT NULL, tipnr_name TEXT, ustrong TEXT,
    verse_count INTEGER NOT NULL);
CREATE TABLE entity_verses (
    entity_kind TEXT NOT NULL,      -- 'person' | 'place' | 'event' | 'other'
    entity_id TEXT NOT NULL,
    book_nr INTEGER NOT NULL, chapter INTEGER NOT NULL, verse INTEGER NOT NULL);
CREATE TABLE entity_names (
    entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
    name TEXT NOT NULL,             -- every spelling / alias / Hebrew / Greek form
    name_norm TEXT NOT NULL,        -- lowercased, accents+points stripped, final sigma folded
    strongs TEXT,                   -- Strong's as in words/lexicon (H0175), from TIPNR
    dstrong TEXT);                  -- TIPNR disambiguated Strong's (H2148E)
CREATE TABLE person_relations (
    person_id TEXT NOT NULL, related_id TEXT NOT NULL,
    relation TEXT NOT NULL);        -- father, mother, child, spouse, sibling, half-sibling, member, founded
CREATE TABLE easton (               -- Easton's Bible Dictionary (1897), full
    term TEXT NOT NULL, term_norm TEXT NOT NULL, item_num INTEGER NOT NULL,
    body TEXT NOT NULL, person_id TEXT, place_id TEXT);
"""

INDEXES = """
CREATE INDEX idx_entity_verses_ref ON entity_verses(book_nr, chapter, verse);
CREATE INDEX idx_entity_verses_ent ON entity_verses(entity_kind, entity_id);
CREATE INDEX idx_entity_names_norm ON entity_names(name_norm);
CREATE INDEX idx_entity_names_strongs ON entity_names(strongs);
CREATE INDEX idx_entity_names_ent ON entity_names(entity_kind, entity_id);
CREATE INDEX idx_person_relations_p ON person_relations(person_id);
CREATE INDEX idx_person_relations_r ON person_relations(related_id);
CREATE INDEX idx_event_links_ent ON event_links(entity_kind, entity_id);
CREATE INDEX idx_event_links_ev ON event_links(event_id);
CREATE INDEX idx_easton_term ON easton(term_norm);
CREATE INDEX idx_people_name ON people(name);
CREATE INDEX idx_places_name ON places(name);
"""


# ------------------------------------------------------------------ helpers
def norm_name(s):
    """Lowercase, strip accents / Hebrew points, fold final sigma, keep only
    letters, digits, spaces and hyphens (Latin, Greek, Hebrew ranges)."""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.casefold().replace("ς", "σ")
    s = re.sub(r"[^a-z0-9Ͱ-Ͽא-ת \-]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def name_variants(name):
    """The normalised name, plus a hyphen-free form when it differs."""
    n = norm_name(name)
    out = [n] if n else []
    if "-" in n:
        out.append(norm_name(n.replace("-", "")))
    return out


_OSIS_RX = re.compile(r"^([1-3]?[A-Za-z]+)\.(\d+)\.(\d+)$")


def parse_osis_list(field):
    """'Gen.1.1,Gen.1.2' -> sorted set of (book_nr, chapter, verse)."""
    out = set()
    for tok in field.split(","):
        m = _OSIS_RX.match(tok.strip())
        if not m:
            continue
        nr = OSIS_TO_NR.get(m.group(1))
        if nr:
            out.add((nr, int(m.group(2)), int(m.group(3))))
    return out


_STEP_RX = re.compile(r"^(?:LXX[ .]?)?([1-3]?[A-Za-z]{2,3})\.(\d+)\.(\d+)([a-z]?)((?:,\d+)*)$")


def parse_step_refs(field):
    """TIPNR 'All Refs': 'Exo.4.14; Exo.7.10a; Num.13.8,16' -> set of refs."""
    out = set()
    for tok in field.split(";"):
        tok = tok.strip().strip("[]")
        if not tok:
            continue
        m = _STEP_RX.match(tok)
        if not m:
            continue
        nr = STEP_TO_NR.get(m.group(1))
        if not nr:
            continue
        ch = int(m.group(2))
        out.add((nr, ch, int(m.group(3))))
        for extra in m.group(5).split(","):
            if extra:
                out.add((nr, ch, int(extra)))
    return out


def strip_dstrong(d):
    """H2148E / H5892b -> H2148 (the form used by words.strongs / lexicon)."""
    m = re.match(r"^([HG]\d{4})", d or "")
    return m.group(1) if m else None


def to_int(s):
    try:
        return int(s)
    except (TypeError, ValueError):
        return None


def read_csv(name):
    with open(THEO_DIR / name, encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def split_list(field):
    return [x.strip() for x in field.split(",") if x.strip()]


# ------------------------------------------------------------------ TIPNR
_UNAME_RX = re.compile(r"^(.+?)=([HG]\d{4}[A-Za-z]?)\s*$")
_REF_IN_NAME_RX = re.compile(r"^([1-3]?[A-Za-z]{2,3}\.\d+\.\d+)")
_SUB_RX = re.compile(r"^– (.+)$")           # "– Named" etc.
_STRONG_FORM_RX = re.compile(r"([HG]\d{4}[A-Za-z]?)«([HG]\d{4}[a-z]?)=([^+]*)")
_VERSIONS_RX = re.compile(r"\s*=\s*[A-Z][A-Z ,]*$")
_REL_SUFFIX_RX = re.compile(r"(\(\?\)|\(d\)|\(a\)|\(f\)|=[HG]\d{4}[A-Za-z]?)+$")
_MAP_RX = re.compile(r"@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)")


def _clean_uname(s):
    """'Jesse@Rut.4.17-Rom(?)' / 'Tehinnah@1Ch.4.12=H8468' -> UnifiedName key."""
    s = s.strip()
    s = _REL_SUFFIX_RX.sub("", s)
    return s.strip()


def _translated_names(field):
    """'Bethlehem =ESV,NIV; Beth-lehem =KJV' / 'Tekoite, Tekoa' -> names."""
    names = []
    for piece in field.split(";"):
        piece = _VERSIONS_RX.sub("", piece.strip())
        for part in piece.split(","):
            part = re.sub(r"\([^)]*\)", "", part).replace("/", "").strip()
            if part and part[0].isalpha() and part[0].isupper():
                names.append(part)
    return names


def parse_tipnr(path):
    """Yield one dict per TIPNR record (see module doc for the layout)."""
    with open(path, encoding="utf-8-sig") as fh:
        lines = fh.read().split("\n")
    recs = []
    i = 0
    n = len(lines)
    while i < n:
        m = re.match(r"^\$========== (.+?)\s*$", lines[i])
        if not m:
            i += 1
            continue
        section = m.group(1)
        hdr = lines[i + 1] if i + 1 < n else ""
        i += 2
        subs = []
        while i < n and not lines[i].startswith("$=========="):
            subs.append(lines[i])
            i += 1
        rec = _parse_record(section, hdr, subs)
        if rec:
            recs.append(rec)
    recs.sort(key=lambda r: (r["uname"], r["ustrong"]))
    return recs


def _parse_record(section, hdr, subs):
    f = hdr.rstrip("\t").split("\t")
    m = _UNAME_RX.match(f[0])
    if not m:
        return None
    uname, ustrong = m.group(1).strip(), m.group(2)
    name, _, refpart = uname.partition("@")
    rm = _REF_IN_NAME_RX.match(refpart)
    first_ref = parse_step_refs(rm.group(1)) if rm else set()
    sidx = next((k for k, x in enumerate(f) if x.startswith("#")), None)
    typ = f[sidx + 1].strip() if sidx is not None and sidx + 1 < len(f) else ""
    summary_line = f[sidx][1:].strip() if sidx is not None else ""
    place_layout = section in ("PLACE", "PERSON+PLACE") or sidx == 6
    if place_layout:
        kind = "place"
        desc = ""
        area = f[5].strip() if len(f) > 5 else ""
        founders = f[2] if len(f) > 2 else ""
        parents = siblings = partners = offspring = ""
        tribe = ""
        lat = lon = None
        mm = _MAP_RX.search(f[4]) if len(f) > 4 else None
        if mm and float(mm.group(1)) != 0.0:
            lat, lon = float(mm.group(1)), float(mm.group(2))
    else:
        desc = f[1].strip() if len(f) > 1 else ""
        parents = f[2] if len(f) > 2 else ""
        siblings = f[3] if len(f) > 3 else ""
        partners = f[4] if len(f) > 4 else ""
        offspring = f[5] if len(f) > 5 else ""
        tribe = f[6].strip() if len(f) > 6 else ""
        area = ""
        founders = ""
        lat = lon = None
        if section.startswith("PERSON") and typ in ("Male", "Female", "", "Refs"):
            kind = "person"
        else:
            kind = "other"
    if area == ">":
        area = ""
    if tribe == ">":
        tribe = ""
    names = [name]
    strong_names = []          # (name, dstrong, estrong)
    refs = set(first_ref)
    prose = {}
    for s in subs:
        if s.startswith("@"):
            key, _, val = s.partition("=")
            prose[key[1:].strip()] = val.strip()
            continue
        sm = _SUB_RX.match(s)
        if not sm:
            continue
        sf = s.split("\t")
        sig = sf[0][2:].strip()
        if sig == "Total" or len(sf) < 5:
            continue
        alt = sf[1].split("@")[0]
        if "|" in alt:
            names.append(alt.split("|")[0].strip())
        for dstr, estr, form in _STRONG_FORM_RX.findall(sf[2]):
            form = form.strip()
            if form:
                strong_names.append((form, dstr, estr))
        tnames = _translated_names(sf[3])
        names.extend(tnames)
        # every translated spelling on this line shares the line's Strong's
        line_strongs = [(d, e) for d, e, _ in _STRONG_FORM_RX.findall(sf[2])]
        if line_strongs:
            d, e = line_strongs[0]
            for tn in tnames:
                strong_names.append((tn, d, e))
        refs |= parse_step_refs(sf[4])
    return {
        "section": section, "kind": kind, "type": typ, "uname": uname,
        "ustrong": ustrong, "name": name, "description": desc,
        "summary_line": summary_line, "area": area, "tribe": tribe,
        "parents": parents, "siblings": siblings, "partners": partners,
        "offspring": offspring, "founders": founders, "lat": lat, "lon": lon,
        "names": names, "strong_names": strong_names, "refs": refs,
        "first_ref": first_ref,
        "brief": prose.get("Brief", ""), "short": prose.get("Short", ""),
        "article": prose.get("Article", ""),
    }


# ------------------------------------------------------------------ load
def load_graph(cur):
    cur.executescript(SCHEMA)

    # ---------------- Theographic
    people_rows = sorted(read_csv("People.csv"), key=lambda r: r["personLookup"])
    place_rows = sorted(read_csv("Places.csv"), key=lambda r: r["placeLookup"])
    event_rows = read_csv("Events.csv")
    group_rows = sorted(read_csv("PeopleGroups.csv"), key=lambda r: r["groupName"])
    easton_rows = read_csv("Easton.csv")

    entities = {}            # (kind, id) -> dict of column values
    names = defaultdict(set)  # (kind, id) -> {(name, strongs, dstrong)}
    verses = defaultdict(set)  # (kind, id) -> {(nr, ch, v)}
    relations = set()          # (person_id, related_id, relation)

    def add_names(key, ns, strongs=None, dstrong=None):
        for nm in ns:
            nm = nm.strip()
            if nm:
                names[key].add((nm, strongs, dstrong))

    for r in people_rows:
        pid = r["personLookup"]
        key = ("person", pid)
        member = split_list(r["memberOf"])
        tribe = next((g for g in member if g.startswith("Tribe of")), None)
        entities[key] = {
            "id": pid, "name": r["name"] or r["displayTitle"],
            "gender": r["gender"] or None,
            "description": r["Disambiguation (temp)"] or None,
            "summary": None, "article": None,
            "birth_year": to_int(r["birthYear"]), "death_year": to_int(r["deathYear"]),
            "min_year": to_int(r["minYear"]), "max_year": to_int(r["maxYear"]),
            "father_id": (split_list(r["father"]) or [None])[0],
            "mother_id": (split_list(r["mother"]) or [None])[0],
            "tribe": tribe, "groups": ",".join(member) or None,
            "birth_place_id": (split_list(r["birthPlace"]) or [None])[0],
            "death_place_id": (split_list(r["deathPlace"]) or [None])[0],
            "easton": r["dictText"] or None,
            "source": "theographic", "tipnr_name": None, "ustrong": None,
        }
        add_names(key, [r["name"], r["displayTitle"]] + split_list(r["alsoCalled"]))
        verses[key] |= parse_osis_list(r["verses"])
        for rel, col in (("father", "father"), ("mother", "mother"), ("child", "children"),
                         ("spouse", "partners"), ("sibling", "siblings"),
                         ("half-sibling", "halfSiblingsSameMother"),
                         ("half-sibling", "halfSiblingsSameFather")):
            for other in split_list(r[col]):
                relations.add((pid, other, rel))

    for r in place_rows:
        pid = r["placeLookup"]
        key = ("place", pid)
        lat = r["latitude"] or r["openBibleLat"]
        lon = r["longitude"] or r["openBibleLong"]
        comment = r["comment"].strip()
        modern = comment[4:].strip() if comment.lower().startswith("now ") else None
        desc = None
        if comment and not comment.startswith("http") and not modern:
            desc = comment
        entities[key] = {
            "id": pid, "name": r["displayTitle"] or r["kjvName"],
            "kind": r["featureType"] or None, "sub_kind": r["featureSubType"] or None,
            "description": desc, "summary": None, "article": None,
            "lat": float(lat) if lat else None, "lon": float(lon) if lon else None,
            "modern_name": modern, "area": None,
            "root_id": r["rootID"] or None, "duplicate_of": r["duplicate_of"] or None,
            "easton": r["dictText"] or None,
            "source": "theographic", "tipnr_name": None, "ustrong": None,
        }
        add_names(key, [r["displayTitle"], r["kjvName"], r["esvName"]] + split_list(r["aliases"]))
        verses[key] |= parse_osis_list(r["verses"])

    for r in group_rows:
        gid = "group:" + re.sub(r"[^a-z0-9]+", "_", r["groupName"].lower()).strip("_")
        key = ("other", gid)
        entities[key] = {
            "id": gid, "name": r["groupName"], "kind": "Group",
            "description": ("Part of " + r["partOf"]) if r["partOf"] else None,
            "summary": None, "article": None,
            "source": "theographic", "tipnr_name": None, "ustrong": None,
        }
        add_names(key, [r["groupName"]])
        verses[key] |= parse_osis_list(r["verses"])
        for member in split_list(r["members"]):
            relations.add((member, gid, "member"))

    # ---------------- TIPNR
    tipnr = parse_tipnr(TIPNR_PATH)
    tip_by_uname = {t["uname"]: t for t in tipnr}

    # match index over Theographic: (kind, name_norm, first_ref) and (kind, name_norm)
    by_name_ref = defaultdict(list)
    by_name = defaultdict(list)
    for key in sorted(entities):
        kind, eid = key
        if kind not in ("person", "place"):
            continue
        first = min(verses[key]) if verses[key] else None
        for nm, _, _ in names[key]:
            for nn in name_variants(nm):
                by_name[(kind, nn)].append(eid)
                if first:
                    by_name_ref[(kind, nn, first)].append(eid)

    matched = {}      # tipnr uname -> (kind, theographic id)
    taken = set()
    stats = {"merged_exact": 0, "merged_overlap": 0, "added": 0, "rel_unresolved": 0}

    def tipnr_name_norms(t):
        out = set()
        for nm in t["names"]:
            out.update(name_variants(nm))
        return out

    # pass 1: same name + same first verse
    for t in tipnr:
        if t["kind"] not in ("person", "place"):
            continue
        cands = set()
        refs = set(t["first_ref"])
        if t["refs"]:
            refs.add(min(t["refs"]))
        for nn in tipnr_name_norms(t):
            for ref in refs:
                for eid in by_name_ref.get((t["kind"], nn, ref), ()):
                    if (t["kind"], eid) not in taken:
                        cands.add(eid)
        if cands:
            eid = sorted(cands)[0]
            matched[t["uname"]] = (t["kind"], eid)
            taken.add((t["kind"], eid))
            stats["merged_exact"] += 1

    # pass 2: same name + >= 50% verse overlap (of the smaller set)
    for t in tipnr:
        if t["kind"] not in ("person", "place") or t["uname"] in matched or not t["refs"]:
            continue
        best = None
        for nn in sorted(tipnr_name_norms(t)):
            for eid in by_name.get((t["kind"], nn), ()):
                key = (t["kind"], eid)
                if key in taken or not verses[key]:
                    continue
                inter = len(t["refs"] & verses[key])
                ratio = inter / min(len(t["refs"]), len(verses[key]))
                if ratio >= 0.5 and (best is None or (ratio, -len(eid), eid) > best[0]):
                    best = ((ratio, -len(eid), eid), eid)
        if best:
            eid = best[1]
            matched[t["uname"]] = (t["kind"], eid)
            taken.add((t["kind"], eid))
            stats["merged_overlap"] += 1

    # ids for unmatched TIPNR records: tipnr:<uStrong>, disambiguated on collision
    used_ids = set()
    tip_id = {}
    for t in tipnr:
        if t["uname"] in matched:
            tip_id[t["uname"]] = matched[t["uname"]]
            continue
        base = "tipnr:" + t["ustrong"]
        tid = base
        if tid in used_ids:
            tid = base + ":" + re.sub(r"[^A-Za-z0-9.]+", "_", t["uname"])
        used_ids.add(tid)
        tip_id[t["uname"]] = (t["kind"], tid)

    def resolve_rel(field, sep=","):
        out = []
        for tok in field.split(sep):
            u = _clean_uname(tok)
            if not u:
                continue
            if u in tip_id:
                out.append(tip_id[u][1])
            else:
                stats["rel_unresolved"] += 1
        return out

    for t in tipnr:
        key = tip_id[t["uname"]]
        kind, eid = key
        if t["uname"] in matched:
            ent = entities[key]
            ent["source"] = "both"
            ent["tipnr_name"] = t["uname"]
            ent["ustrong"] = t["ustrong"]
            if t["description"]:
                ent["description"] = t["description"]
            ent["summary"] = t["short"] or t["brief"] or None
            ent["article"] = t["article"] or None
            if kind == "person":
                if not ent["gender"] and t["type"] in ("Male", "Female"):
                    ent["gender"] = t["type"]
                if not ent["tribe"] and t["tribe"].startswith("Tribe of"):
                    ent["tribe"] = t["tribe"]
            else:
                ent["area"] = t["area"] or None
                if ent["lat"] is None and t["lat"] is not None:
                    ent["lat"], ent["lon"] = t["lat"], t["lon"]
        else:
            stats["added"] += 1
            base = {
                "id": eid, "name": t["name"],
                "description": t["description"] or t["summary_line"] or None,
                "summary": t["short"] or t["brief"] or None,
                "article": t["article"] or None,
                "source": "tipnr", "tipnr_name": t["uname"], "ustrong": t["ustrong"],
            }
            if kind == "person":
                base.update({
                    "gender": t["type"] if t["type"] in ("Male", "Female") else None,
                    "birth_year": None, "death_year": None, "min_year": None, "max_year": None,
                    "father_id": None, "mother_id": None,
                    "tribe": t["tribe"] if t["tribe"].startswith("Tribe of") else None,
                    "groups": None, "birth_place_id": None, "death_place_id": None,
                    "easton": None,
                })
            elif kind == "place":
                base.update({
                    "kind": None, "sub_kind": None, "lat": t["lat"], "lon": t["lon"],
                    "modern_name": None, "area": t["area"] or None,
                    "root_id": None, "duplicate_of": None, "easton": None,
                })
            else:
                base["kind"] = t["type"] or "Other"
            entities[key] = base
        add_names(key, t["names"])
        for nm, dstr, estr in t["strong_names"]:
            names[key].add((nm, strip_dstrong(estr), dstr))
        verses[key] |= t["refs"]
        # family relations (person layout) and founders (place layout)
        if kind == "person":
            father, _, mother = t["parents"].partition(" + ")
            for fid in resolve_rel(father):
                relations.add((eid, fid, "father"))
                if entities[key].get("father_id") is None:
                    entities[key]["father_id"] = fid
            for mid in resolve_rel(mother):
                relations.add((eid, mid, "mother"))
                if entities[key].get("mother_id") is None:
                    entities[key]["mother_id"] = mid
            for sid in resolve_rel(t["siblings"]):
                relations.add((eid, sid, "sibling"))
            for sid in resolve_rel(t["partners"]):
                relations.add((eid, sid, "spouse"))
            for cid in resolve_rel(t["offspring"]):
                relations.add((eid, cid, "child"))
        elif kind == "place":
            for fid in resolve_rel(t["founders"], sep=" + "):
                relations.add((fid, eid, "founded"))

    # ---------------- Events (Theographic only)
    def start_year(s):
        m = re.match(r"^(-?\d+)", s.strip())
        return int(m.group(1)) if m else None

    def duration_years(d):
        m = re.match(r"^(\d+(?:\.\d+)?)Y", d.strip())
        return int(float(m.group(1))) if m else 0

    ev_sorted = sorted(event_rows, key=lambda r: (float(r["sortKey"] or 0), int(r["eventID"])))
    ev_id_by_title = {r["title"]: "ev:" + r["eventID"] for r in event_rows}
    event_recs = []
    event_links = set()
    for rank, r in enumerate(ev_sorted, 1):
        evid = "ev:" + r["eventID"]
        sy = start_year(r["startDate"])
        ey = (sy + duration_years(r["duration"])) if sy is not None else None
        event_recs.append((evid, r["title"], r["notes"] or None, sy, ey,
                           r["startDate"] or None, r["duration"] or None,
                           r["partOf"] or None, ev_id_by_title.get(r["predecessor"]), rank))
        verses[("event", evid)] |= parse_osis_list(r["verses"])
        for p in split_list(r["participants"]):
            event_links.add((evid, "person", p))
        for p in split_list(r["locations"]):
            event_links.add((evid, "place", p))

    # ---------------- write
    counts = {k: sum(1 for key in entities if key[0] == k) for k in ("person", "place", "other")}
    vc = {key: len(verses[key]) for key in entities}
    vc.update({("event", e[0]): len(verses[("event", e[0])]) for e in event_recs})

    cur.executemany(
        """INSERT INTO people VALUES (:id,:name,:gender,:description,:summary,:article,
           :birth_year,:death_year,:min_year,:max_year,:father_id,:mother_id,:tribe,:groups,
           :birth_place_id,:death_place_id,:easton,:source,:tipnr_name,:ustrong,:verse_count)""",
        [dict(entities[k], verse_count=vc[k]) for k in sorted(entities) if k[0] == "person"])
    cur.executemany(
        """INSERT INTO places VALUES (:id,:name,:kind,:sub_kind,:description,:summary,:article,
           :lat,:lon,:modern_name,:area,:root_id,:duplicate_of,:easton,:source,:tipnr_name,
           :ustrong,:verse_count)""",
        [dict(entities[k], verse_count=vc[k]) for k in sorted(entities) if k[0] == "place"])
    cur.executemany(
        """INSERT INTO entity_other VALUES (:id,:name,:kind,:description,:summary,:article,
           :source,:tipnr_name,:ustrong,:verse_count)""",
        [dict(entities[k], verse_count=vc[k]) for k in sorted(entities) if k[0] == "other"])
    cur.executemany("INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)", event_recs)
    cur.executemany("INSERT INTO event_links VALUES (?,?,?)", sorted(event_links))

    ev_rows = []
    for key in sorted(verses):
        for ref in sorted(verses[key]):
            ev_rows.append((key[0], key[1]) + ref)
    cur.executemany("INSERT INTO entity_verses VALUES (?,?,?,?,?)", ev_rows)

    name_rows = set()
    for key in sorted(names):
        for nm, strongs, dstrong in names[key]:
            for nn in name_variants(nm):
                name_rows.add((key[0], key[1], nm, nn, strongs, dstrong))
    cur.executemany("INSERT INTO entity_names VALUES (?,?,?,?,?,?)", sorted(name_rows, key=lambda r: tuple(x or "" for x in r)))

    known_people = {k[1] for k in entities if k[0] == "person"}
    known_any = {k[1] for k in entities}
    rel_rows = sorted(r for r in relations if r[0] in known_people and r[1] in known_any)
    cur.executemany("INSERT INTO person_relations VALUES (?,?,?)", rel_rows)

    easton_out = []
    for r in sorted(easton_rows, key=lambda r: (int(r["index"]), r["dictLookup"])):
        term = r["termLabel"] or r["dictLookup"]
        item = int(float(r["itemNum"] or 0))
        easton_out.append((term, norm_name(term), item, r["dictText"],
                           (split_list(r["personLookup"]) or [None])[0],
                           (split_list(r["placeLookup"]) or [None])[0]))
    cur.executemany("INSERT INTO easton VALUES (?,?,?,?,?,?)", easton_out)

    cur.executescript(INDEXES)

    n_coords = sum(1 for k in entities if k[0] == "place" and entities[k]["lat"] is not None)
    n_years = sum(1 for k in entities if k[0] == "person"
                  and (entities[k]["birth_year"] is not None or entities[k]["death_year"] is not None))
    print(f"  graph: people {counts['person']:,} ({n_years} with birth/death year), "
          f"places {counts['place']:,} ({n_coords} with coordinates), "
          f"other {counts['other']:,}, events {len(event_recs)}, "
          f"event_links {len(event_links):,}, entity_verses {len(ev_rows):,}, "
          f"entity_names {len(name_rows):,}, person_relations {len(rel_rows):,}, "
          f"easton {len(easton_out):,}")
    print(f"  graph: TIPNR {len(tipnr):,} records -> merged into Theographic "
          f"{stats['merged_exact']:,} (name+first verse) + {stats['merged_overlap']:,} "
          f"(name+verse overlap), added as tipnr:* {stats['added']:,}; "
          f"unresolved relation targets {stats['rel_unresolved']}")
    return stats


if __name__ == "__main__":
    # Ad-hoc run against an explicit DB path (never db/bible.db by default):
    #   pixi run python tools/graph_extra.py path/to/copy.db
    import sqlite3
    if len(sys.argv) != 2:
        sys.exit("usage: graph_extra.py <sqlite db path>")
    con = sqlite3.connect(sys.argv[1])
    load_graph(con.cursor())
    con.commit()
    con.close()

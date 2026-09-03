# The data catalog — design (Phase D item 1, 2026-09-03)

Goal: a first web load well under 20 MB, and a device whose contents the
user tailors item by item — each Bible text, each testament of word tagging,
each lexicon, each Library work — with "download all" shortcuts for a group,
a shelf, or everything. Replaces the same-day "packs" design (grouped
databases attached per pack), which could not go per-item: SQLite allows ten
attached databases per connection.

## Layout

Manifest version 5 lists **88 entries** (`tools/build_app_bundle.py`):

| entry | what | install |
|---|---|---|
| `core` (main, bible family) | books, texts, text_books, book_chapters, cross-references, Strong's, parsing codes, search index; **empty schemas** of every table an item can bring | always, 9 MB |
| `library` (main, works family) | works, sections, scripture references; empty page/note tables + FTS | always, 2 MB |
| `text-<id>` × 18 | one Bible text: verses + versification map | WEB and YLT by default; the rest on request (0.3–2 MB each) |
| `tagged-ot`, `tagged-nt` | STEPBible word tagging per testament (the tappable reader, concordance) | on request |
| `interlinear-web` | the original word behind each WEB word | on request |
| `lexicon-bdb`, `lexicon-lsj`, `lexicon-abbott-smith` | full lexicon entries | on request |
| `dictionary`, `names` | English dictionary; people/places/events + map + timeline | on request |
| `work-<slug>` × 59 | one Library work: pages + editor notes | on request (0.3–8 MB each) |
| `vectors` | the AI search index (own connection) | with Ask AI (beta) |

First launch = core + library + the two default texts ≈ **15 MB**.

## Mechanism: items are imported, not attached

An item file is a small SQLite database holding just its rows (same table
schemas, no indexes). On install the worker downloads and verifies it,
decompresses it to a temporary OPFS file, `ATTACH`es it to the family's main
database and copies the rows in (`INSERT INTO main.t SELECT * FROM item.t`),
adds the matching FTS rows (the external-content FTS tables need explicit
inserts), records the item in `installed_items(id, version)`, and drops the
temporary file — all inside one transaction. Removal runs the item's own
delete filters (`tables: [[table, where, params]]` in the manifest, e.g.
`verses WHERE text_id = 'kjv'`, `words WHERE book_nr >= 40`), removes the
FTS rows first with the `'delete'` command, and reclaims space through
`PRAGMA incremental_vacuum` (the mains are built with `auto_vacuum =
INCREMENTAL`).

Consequences:

- **One connection per family, any number of items.** No attach limit, no
  views, no per-pack FTS merging: the app's SQL is exactly what it was with
  the monolithic databases.
- **Missing data is empty, not an error.** The mains carry empty schemas of
  every item table, so a query for something not downloaded returns nothing;
  the UI layer (`packInstalled`, `packPrompt` in app.js) turns that into an
  inline "needs X (N MB) — Download" where the data would appear: the
  reader, the text picker, each Library shelf and book spine, the word
  panel's lexicon / dictionary / interlinear sections, the verse panel's
  names, the map and the timeline. Settings → Catalog lists everything
  grouped, with Download / Remove per item, "Download all" per group and
  "Download everything".
- **Updating a main re-imports its items.** A new `core` (say, a
  cross-reference fix) replaces the file, so the worker re-downloads the
  items that were installed (their ids are read from the old
  `installed_items` first). Item updates are remove + import. Both go
  through the same "Update now / Later" bar.
- **Chapter navigation does not depend on any text.** `book_chapters` in
  the core carries the canonical chapter counts (KJV baseline).
- **Coverage is explained.** `text_books` (in the core, for every text)
  lets the reader say "the Septuagint doesn't include John — it covers the
  Old Testament; try Greek NT · tagged, Textus Receptus…" instead of
  "Nothing here".

## Build chain

`build_db.py` / `build_works_db.py` / `build_embeddings.mjs` still produce
the monolithic dev databases. `tools/build_items.py` (its `TEXTS` map and
`catalogue()` are the single source of item ids, titles, blurbs, groups,
defaults and row filters) writes `db/items/*.db`; `build_app_bundle.py`
gzips + chunks them with the manifest; `check_db.py` verifies that the
items reproduce every source row exactly once and that the mains carry the
empty schemas. The Android APK bundles the whole catalog as assets and
installs the core + defaults at first launch like the web; the rest is a
tap away offline. The desktop edition reads the full databases from disk
instead (desktop-app/backend.js) and reports everything installed.

## Migration

Any OPFS file other than `core.db`, `library.db`, `vectors.db` is removed at
boot (monolithic `bible.db`/`works.db`, the short-lived attached packs, a
stale temporary item). A main whose version stamp doesn't match is replaced.
Annotations, reading position and settings live outside the databases.

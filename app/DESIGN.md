# App Design — Library 422

> Decided 2026-08-30 with the owner. V1 = offline-first study app; notes integration is v2.
>
> **Status (2026-09-02):** V1 shipped and exceeded — see "Shipped since this
> design" at the end. This document keeps the original decisions; CLAUDE.md
> carries the operational detail of what exists now.

## Owner's requirements

- Accessible on the web and on phone/tablet → **one responsive PWA**, installable
  to the home screen (no separate native apps).
- Hosting: **serverless static site** — no backend in production.
- **Fully offline capable** — the entire database lives on the device.
- Notes vault: **v2**, not v1.
- Server tech where a server is warranted: **Python + FastAPI**
  (v1: local dev server; v2: notes sync API).

## Architecture

```
┌─ static host: library422.org (Cloudflare static-assets Worker) ───┐
│  index.html · app.js modules · sqlite-wasm (vendored) · sw.js     │
│  data/manifest.json (version 5: 88 catalog items, CATALOG.md)     │
│  data/core.db.gz.000 · library · text-<id> · tagged-* · lexicon-* │
│  · work-<slug> · vectors  (gzip, ≤20 MB chunks, sha256 each)      │
│  vendor/embedder/  (with the AI index only)                       │
└───────────────────────────────────────────────────────────────────┘
                 │ first run: core + library + WEB + YLT (~15 MB);
                 │ every other item on the user's tap (imported into core)
                 ▼
┌─ device (browser / installed PWA / Android APK) ──────────────────┐
│  service worker caches app shell → app loads offline              │
│  chunks downloaded → SHA-256 verified → staged → gunzip STREAMED  │
│  into OPFS (opfs-sahpool VFS, no special headers); the previous   │
│  DB is only removed after every new chunk has been verified       │
│  ALL queries run on-device via SQLite WASM                        │
└───────────────────────────────────────────────────────────────────┘
```

Key technology choices and why:

- **SQLite WASM (official sqlite.org build), `opfs-sahpool` VFS** — persists the DB
  in the browser's Origin Private File System and, critically, does NOT require
  COOP/COEP headers, so any dumb static host works. Vendored into the repo (no CDN).
- **No frontend framework, no build step** — plain ES modules + CSS. Every line
  readable, nothing to compile, trivial to maintain. (Can revisit if UI grows.)
- **Chunked delivery** — static hosts cap file sizes (Cloudflare Pages: 25 MB).
  `tools/build_app_bundle.py` gzips bible.db and splits it into ~20 MB chunks with
  a manifest (chunk list, sizes, SHA-256 of each chunk + of the whole DB, and a
  `db_version`). First run streams chunks → verifies hashes (integrity ethos
  extends to the app) → writes OPFS. Update = manifest version bump; the app
  currently re-downloads at boot without asking (an "update later" prompt is
  still an open item for the PWA route; the APK carries its data as assets).
- **Service worker** — caches the app shell so the app itself opens offline;
  DB access is OPFS so it's inherently offline.
- **PWA manifest** — name, icons, standalone display → installable on
  iOS/Android/desktop.

## V1 screens

1. **Reader** — book/chapter navigation; 1–2 texts in parallel columns
   (stacked panes on phones); any of the 18 texts; original-language texts
   render word-by-word from `words` so every word is tappable.
2. **Word panel** (slide-up sheet) — tap a tagged word: surface, translit,
   in-context gloss, morphology (decoded to plain English), Strong's definition,
   KJV usage summary, and "N occurrences →" link.
3. **Concordance view** — all occurrences of a Strong's number/lemma, grouped by
   book, each with its in-context gloss; tap-through to the reader.
4. **Verse panel** — tap a verse number: cross-references ranked by votes,
   all-translations comparison.
5. **Search** — FTS5 across all texts (verses_fts ships in the DB); filter by text.

## Query layer

Straight SQL against the schema documented in CLAUDE.md (verses, words, lexicon,
crossrefs, verses_fts). A thin `db.js` module wraps the canonical queries (~30 today).
sqlite3 gotcha from CLAUDE.md applies (fresh statement per nested query).

## Dev workflow

- `pixi run dev` → FastAPI serves `app/` + `app/data/` locally (also serves to
  phone over LAN for device testing).
- `pixi run build-data` → rebuild both DBs, embeddings, and the chunked bundle
  in `app/data/` (individual tasks: `build-db`, `build-works`, `embed`, `bundle`).
- Deploy = push static files to any host (decide host when first deploying).

## Rollout: Android first

Owner decision (2026-08-30): get it working as an offline app on Android before
worrying about other platforms. This changes rollout order, not architecture:

1. Build the PWA; test in desktop Chrome (same engine as Android).
2. Serve over LAN (`pixi run dev`), install on the Android device from Chrome
   ("Add to Home Screen") → standalone fullscreen app, DB in device storage,
   fully offline thereafter.
3. Iterate on phone ergonomics (column stacking, tap targets, word panel sheet).
4. Later: static-host deployment for anywhere-access; iOS/desktop verification.

Android Chrome is the strongest platform for this stack (best OPFS + PWA install
support), so Android-first is also lowest-risk-first. If a real APK is ever
wanted (e.g. Play-less sideload distribution or tighter device integration),
wrap the identical web app with Capacitor — zero rewrite.

## Known constraints (accepted)

- ~~~240 MB one-time download on first run~~ Since 2026-09-03 the first run
  is ~15 MB (core databases + WEB + YLT); everything else is a catalog item
  the user adds (CATALOG.md). The APK bundles the whole catalog.
- iOS can evict OPFS storage for rarely-used sites; the app requests persistent
  storage (`navigator.storage.persist()` at boot) and installed PWAs are safer.
  Worst case = re-download. User-authored data on device is small and local
  only: saved Ask conversations, AI settings (incl. an optional API key), and
  the imported model file.
- No app store: the PWA route plus a sideloaded APK — fine for a personal tool.

## V2 (out of scope for v1)

- Notes vault: read-only rendering of `notes/` with [[wiki-link]] navigation,
  then read/write sync via FastAPI (server-side; revisits access model — likely
  Tailscale to keep notes private).
- Versification mapping (LXX Psalms, Jeremiah) via STEPBible tables.
- BDB + Abbott-Smith lexicon integration.
- Sefaria/Targum reading views (Church Fathers shipped — see below).

## Shipped since this design

Everything in "V1 screens" exists, plus (all documented in CLAUDE.md):

- **Android APK** via Capacitor (`android-app/`, appId `org.library422.study`),
  data bundled as assets — the "if a real APK is ever wanted" path was taken.
- **Library tab** — `db/works.db`: 55 historical works (Church Fathers,
  Josephus, Philo, Aquinas, Enoch); 41 volumes with rich ThML rendering,
  section navigation, editor notes on demand.
- **Ask tab (beta, off by default)** — grounded question answering over the
  Library and the Bible: hybrid keyword + semantic retrieval (on-device
  embeddings), app-generated citations, a grounding double-check,
  conversation history. Two providers: on-device Gemma (Android) or the
  user's own Anthropic API key. Enabled from Settings; the semantic index
  (`vectors.db`, an optional third database in the manifest) and the query
  embedder download only on the user's request.
- **Hosting** — library422.org: static-assets Cloudflare Worker deployed by
  GitHub Actions on every push to `main`; the data bundle rides as GitHub
  release assets (DEPLOY.md).
- **Search** across verses, lexicon, and the Library; **English dictionary**
  for English words; **English Septuagint** (`lxxen`) and an OT / NT /
  Apocrypha book picker; **pronunciation** via device TTS.

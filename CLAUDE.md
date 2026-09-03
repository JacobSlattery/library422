# CLAUDE.md — All Things Bible

Read this fully before acting. It contains the project rules and everything needed to
answer questions about this folder without re-exploring it.

## What this project is

A personal Bible research and study vault owned by JacobSlattery. The app is named
**Library 422** (after Mark 4:22 — "nothing hidden, except that it should
be made known"); Android appId `org.library422.study` (owner chose a fresh
identity over data continuity when renaming; the java package/namespace
keeps the old com.allthingsbible.study name — compile-time only, invisible). Markdown notes with Obsidian-style
`[[wiki-links]]` sit on top of a large offline library of Bible texts, original-language
data, lexicons, and primary historical sources.

**Phases:**
1. **Data gathering** — largely complete (see library below); more sources welcome.
2. **App** — shipped: offline-first study PWA + Android APK. Architecture in
   `app/DESIGN.md`. Data layer = `db/bible.db` + `db/works.db` on-device via SQLite
   WASM; no production server; FastAPI only for local dev serving (notes sync in v2).
3. **Free public release** ← we are here (pivot 2026-09-02). The long-term feature
   plan, the per-source licensing ledger, and the release checklist live in
   **`ROADMAP.md`** — read it before adding data or features. Live since
   2026-09-03: the app at **app.library422.org** (its own origin — storage
   and service worker are per origin) and a landing site at
   **library422.org** (`site/`, static HTML): GitHub `main` (private repo
   JacobSlattery/library422) → Actions → two Cloudflare static-assets
   Workers (`wrangler.app.jsonc`, `wrangler.site.jsonc`); the data bundle
   travels as GitHub release assets. Operator steps in **`DEPLOY.md`**.
   Phase D (packs, desktop layout, Electron, iOS, landing site, deep links)
   is the agreed direction — see ROADMAP.md before starting platform work.
   **Two repos since 2026-09-03:** this one is `JacobSlattery/library422-private`
   (everything, incl. sources and notes; data builds and the deploy workflow run
   here); `JacobSlattery/library422` is PUBLIC and holds a filtered export of the
   app/site/tools/shells/docs (`pixi run export-public` → `../library422`, commit
   + push there) plus ALL releases: app builds (`v1.4.0`, stable asset names) and
   `data-…` pre-releases (tools/publish_data.py uploads there; the workflow
   downloads from there). Never export `notes/`, `texts/`, `resources/`,
   `integrity/`; the export scrubs the owner's email and device serial.

**Public-release structure (owner decisions 2026-09-02):** the AI feature is
**beta and off by default** — Settings → "Ask AI (beta)" toggle
(localStorage `atb-ai-beta`); without it there is no Ask tab. The semantic
index (`vectors` pack) and the query embedder (~60 MB under
app/vendor/embedder) are **never installed by default on the web** — only
via "Download AI search data" after the toggle is on; Ask falls back to
keyword retrieval without them.

**Data catalog (Phase D item 1, shipped 2026-09-03 — design in
`app/CATALOG.md`):** the data ships as 88 catalog ITEMS (manifest version 5):
two family mains (`core`: shared tables + empty schemas + search index;
`library`: the works catalogue) plus one item per Bible text (18), per
testament of word tagging, per lexicon, the interlinear, dictionary, names,
one per Library work (59), and the AI index. First launch = mains + the
**default texts WEB and Young's Literal = 15 MB** (owner decision
2026-09-03: defaults are WEB + YLT, and users manage their catalog item by
item; "download all" per group/shelf/everything remains). Mechanism: an
item is IMPORTED into its family main on install (ATTACH temp file → INSERT
… SELECT → FTS rows → `installed_items`) and its rows deleted on removal
(`tables: [[table, where, params]]` in the manifest) — one connection per
family, no attach limit, app SQL unchanged. Updating a main re-imports its
items. `book_chapters` (core) drives navigation; `text_books` explains
coverage ("the Septuagint doesn't include John — it covers the OT"). Build
chain: build_db/build_works/embed still make the monolithic dev DBs;
`tools/build_items.py` (TEXTS map + catalogue() = single source of item ids,
titles, groups, defaults, row filters) writes db/items/, then check-db +
bundle. The short-lived "packs" design (attached per pack) was replaced the
same day because SQLite caps attached databases at 10.

### Rule 2 — public-release licensing (since 2026-09-02)

The app will be released free to the public. Every byte that ships must be
**public domain, CC0, CC BY, or CC BY-SA** (attribution + share-alike honoured
in the app's licences screen). Do NOT ingest non-commercial-only ("NC"),
"personal use", or copyrighted material into `db/` or `app/data/`, even if a
copy sits in `resources/`. Sefaria English versions must be checked per
version (licence field) before ingest. Anything we might license or buy later
goes on the "Purchasable later" list in ROADMAP.md and is never bundled. The
LLM model file is imported by the user; never ship weights.

**Content scope (owner decision 2026-09-02):** Christian scripture in its
ancient languages/versions plus ancient primary sources for its world (Fathers,
Josephus, Philo, Enoch). Jewish religious texts: **BC compositions only**
(Septuagint, Enoch, Sirach, Maccabees, Jubilees...). Anything composed AD —
Targums, Mishnah, Talmud, midrash, commentaries — is OUT; never ingest it, even
though the Sefaria downloads remain in `resources/jewish-texts/` under Rule 1.
**Terminology (owner preference 2026-09-02):** app-facing labels use Christian
terms — "Intertestamental Texts" (not "Second Temple"), "Old Testament" (not
"Hebrew Bible"/"Tanakh"), "Apocrypha"/"Deuterocanon" as the shelf already does.
Scholarly period names are fine inside docs and code comments.
**Release keystore:** `android-app/android/library422-release.jks` +
`app/keystore.properties` (both gitignored, generated 2026-09-02) — never
commit, never regenerate; losing them means installed copies cannot be updated.

## RULES (non-negotiable)

### Rule 1 — Source files are read-only to agents

LLMs make mistakes, and a silently corrupted source text is unacceptable contamination.
Therefore:

- **Never** write, edit, or "fix" any file under `texts/` or `resources/` by hand
  (Edit/Write tools or manual retyping). Not one character, not an "obvious typo",
  not whitespace.
- Alterations are allowed **only** via deterministic Python scripts or queries, and
  **only for formatting cleanup** (e.g., stripping page headers, normalizing line
  endings, re-encoding). Never content changes.
- Cleanup scripts must be saved in `tools/`, must be reviewable before running, and
  should write output to a **new file** (or clearly derived copy) rather than
  destructively overwriting the original wherever practical.
- Downloading new sources from authoritative origins (curl/git) is fine — that's
  acquisition, not editing.
- Notes in `notes/`, docs like `README.md`/`CLAUDE.md`, and code in `tools/` are normal
  working files — write and edit those freely.

Rule 1 (sources read-only) and Rule 2 (licensing, below) are the standing rules.

## Repository map

```
texts/                          Scripture texts
  english/                      kjv, kjva (KJV+Strong's), asv, ylt, web, tyndale,
                                douayrheims, weymouth (.json) · bsb.txt ·
                                darby/ + brenton-lxx/ (USFM folders)
  greek/                        sblgnt/ (git clone) · byzantine/ (Robinson-Pierpont, git clone) ·
                                textusreceptus.json · westcotthort.json · tischendorf.json ·
                                lxx.json (accented Greek Septuagint)
  hebrew/                       wlc-morphhb/ (OpenScriptures WLC + morphology, git clone) ·
                                codex.json (WLC) · aleppo.json
  latin/vulgate.json            Clementine Vulgate
  syriac/peshitta-nt.json       Peshitta NT
  stepbible-data/               STEPBible (Tyndale House, CC-BY): TAHOT/TAGNT word-by-word
                                Hebrew/Greek with Strong's + morphology, lexicons, proper nouns
notes/                          The knowledge base (markdown, [[wiki-links]], Obsidian-compatible)
  topics/ people/ places/ word-studies/ passages/ history/
  _templates/                   topic.md, word-study.md, passage.md — copy for new notes
  INDEX.md                      Hub note; link new notes here
resources/
  lexicons/                     strongs/ (Greek+Hebrew dictionaries, JS/JSON) ·
                                hebrew-bdb/ (BDB XML) · abbott-smith/ (TEI XML) · dodson/
  cross-references/cross_references.txt   OpenBible.info, ~345k lines: FromVerse TAB ToVerse TAB Votes
  metadata/theographic/         CSV knowledge graph: people, places (w/ lat-long), events ↔ verses
  historical-texts/
    josephus/                   pg2846 Life, pg2848 Antiquities, pg2849 Against Apion, pg2850 Wars
    church-fathers/             anf01–10 (10 = index vol), npnf101–114, npnf201–214 (all 38 CCEL vols) +
                                apostolic-fathers-pg77576.txt. Eusebius=npnf201, 7 Councils=npnf214
    philo/                      philo-yonge-vol1–4.txt (Archive.org OCR — has hyphenation/header noise)
    pseudepigrapha/             book-of-enoch-charles-pg77935.txt · Jubilees (Charles 1917) ·
                                Letter of Aristeas (Thackeray 1904) · Psalms of Solomon + Testaments
                                of the XII Patriarchs (from Charles 1913 vol. 2): Archive.org OCR
                                sources + derived *.clean.txt (CLEANUP.txt has the commands).
                                Library shelf "Intertestamental Texts" (BC only — rule 2)
    aquinas/                    summa.txt (complete Summa Theologica) · gentiles.txt (Summa
                                Contra Gentiles) · catena1-matthew/2-mark/3-luke-part1+2/4-john
                                (complete Catena Aurea)
  jewish-texts/
    sefaria/                    Sefaria-Export index only (books.json lists 19,716 versions)
    sefaria-texts/              235 downloaded merged.json files: Targums (Onkelos, Jonathan,
                                Neofiti, Jerusalem), complete Mishnah (Heb+Eng), Bavli tractates
                                Berakhot/Shabbat/Pesachim/Yoma/Sukkah/Sanhedrin
integrity/
  MANIFEST.sha256               SHA-256 of every file under texts/ + resources/ (1,450 entries)
  CLONE-SNAPSHOTS.txt           Origin URL + commit SHA of each former git clone
db/
  bible.db                      DERIVED SQLite study database (~332 MB with the Phase A
                                layers, gitignored, rebuild anytime: pixi run build-db).
                                Builds go to a .tmp file and replace the DB only after
                                integrity_check
  works.db                      DERIVED Library database (~360 MB, gitignored,
                                pixi run build-works): 59 historical works
                                (Fathers, Josephus, Philo, Aquinas, five intertestamental texts) paginated
                                into work_pages (~10 KB/page). Ships alongside
                                bible.db; each installs/updates independently
  vectors.db                    DERIVED semantic index (~79 MB, pixi run embed):
                                vectors(set_name, name, data) — sets "works" (170k
                                Library chunks) + "bible" (31k WEB verses), int8 384d.
                                Ships as the optional `vectors` pack
  items/<id>.db                 DERIVED catalog items (pixi run build-items,
                                app/CATALOG.md): core + library mains, text-<id>,
                                tagged-ot/nt, interlinear-web, lexicon-*, dictionary,
                                names, work-<slug> — what app/data/ (manifest v5)
                                is bundled from
android-app/                    Capacitor wrapper -> real Android APK (see Android
                                section; node_modules/ + www/ + build dirs gitignored)
desktop-app/                    Desktop edition (Electron, portable — Phase D item 3):
                                main.js serves app/ over a private app:// origin,
                                backend.js answers the worker's RPC contract from the
                                FULL db/*.db files via node:sqlite (window.desktopDB in
                                preload.js; app/js/db.js prefers it over the worker).
                                `pixi run desktop-prepare` stages www/ + data/ (gitignored),
                                `npm run pack:win|pack:linux` -> dist/desktop/ (portable
                                folder, no installer; pack.js swaps in shims/extract-zip
                                because extract-zip stalls under Node 26). Semantic search
                                runs in the page (app/js/semantic-client.js) over vector
                                blobs from the backend. Gotchas: the npm here blocks install
                                scripts (approve electron, or unzip the cached
                                electron-v*.zip into node_modules/electron/dist + path.txt);
                                the harness sets ELECTRON_RUN_AS_NODE=1 — clear it to
                                launch (smoke_desktop.py does)
.github/workflows/deploy.yml    push to main -> fetch pinned data release -> build_site
                                -> wrangler deploy x2 (app + landing). Configs:
                                wrangler.app.jsonc, wrangler.site.jsonc
site/                           Landing site sources (library422.org): index.html, site.css,
                                catalog.json (from build_app_bundle.py) -> build_site.py
                                --landing generates /works/<slug>/ and /bibles/<id>/ pages
                                with deep links (app: /read/<book>/<ch>/<v>, /library/<slug>/
                                <page>, /word/<strongs>, /search/<q>; SPA fallback on
                                Cloudflare + dev server)
DEPLOY.md                       One-time hosting setup + the routine (data releases)
tools/
  Get-Verse.ps1                 Verse lookup across all JSON texts (see below)
  Get-SefariaTexts.ps1          Downloads more Sefaria categories from their GCS bucket
  build_manifest.py             (Re)build integrity/MANIFEST.sha256 — run after acquiring new sources
  verify_manifest.py            Verify sources against manifest; exit 1 on any modification
  build_db.py                   Build db/bible.db from sources (deterministic, stdlib-only)
  build_works_db.py             Build db/works.db (the Library) from historical texts
  build_embeddings.mjs          Embed the Library + the 31k WEB verses into db/vectors.db
                                (pixi node + testbed npm env; run after BOTH db builds;
                                also drops any legacy `vectors` table from bible/works).
                                Cache in testbed/emb keyed PER CHUNK TEXT (*.keys): adding
                                a work embeds only its chunks (minutes, not ~75 min)
  build_items.py                Split bible.db + works.db into db/items/*.db (TEXTS +
                                catalogue() = item ids, titles, groups, defaults, filters)
  build_app_bundle.py           Gzip + chunk every item (+ vectors.db) into app/data/
                                with a sha256 manifest (version 5)
  build_site.py                 Assemble dist/site/ (app/ + data + _headers), 25 MiB
                                asset guard — what the deploy workflow publishes
  publish_data.py               Upload app/data/* as GitHub release data-<date>-<hash>
                                and pin it in app/version.json `data_release`
  clean_ocr.py                  Rule-1-safe OCR cleanup: source -> derived *.clean.txt
                                (slice by --start/--end regex, drop page headers, join
                                hyphenation); record the command in the folder's CLEANUP.txt
  *_extra.py                    Phase A loaders called by build_db.py (lexicons, web_words,
                                morph, graph, versification) — one table family each
  build_android.ps1             Build (and -Install) the debug APK; stamps versionCode/
                                versionName from app/version.json (the ONE place to bump)
  build_release.ps1             Signed release APK + dist/site/ (PWA + data) into dist/
                                (gitignored); needs the keystore; run smoke first
  dev_server.py                 FastAPI static server for app/ (pixi run dev)
  build_desktop.py              Stage desktop-app/www + data (+ catalog.json) for Electron
testbed/devtools/
  smoke_app.py                  Browser smoke test (pixi run smoke; --url for the live site)
  smoke_desktop.py              Electron boot check (pixi run smoke-desktop)
  shot.py                       Screenshot any view at any size (design review tool)
```

## The study database (db/bible.db)

Derived artifact — never a source; delete + rebuild freely. This is the data layer for
the future app. Tables:

- `books(nr, name, step_code, ob_code)` — canonical 66-book map between numbering systems
- `texts(id, lang, source)` / `text_books(text_id, book_nr, book_name)` — 18 texts
  (15 getBible JSON + web USFM + lxxen + bsb);
  per-text book lists (kjva apocrypha, LXX deuterocanon incl. synthetic nrs 90+)
- `verses(text_id, book_nr, chapter, verse, body, body_plain)` — 421k verses, all
  texts, aligned by the shared book_nr/chapter/verse scheme. `body_plain` =
  marker-stripped copy, NULL where identical; view `verses_plain` folds them
- (verse embeddings moved to `db/vectors.db` set "bible" on 2026-09-02 — bible.db
  carries NO vectors table; check_db fails if one reappears)
- `words(...)` — 447,398 STEPBible-tagged OT+NT words: surface, translit, gloss,
  strongs (primary, suffix-stripped), strongs_all, lemma, morph, editions, variant
- `lexicon(strongs, ...)` — 14,197 Strong's entries (Greek + Hebrew), full definitions;
  `lemma_norm`/`translit_norm` = lowercased, accents/points stripped, final sigma → σ
  (Python casefold semantics — JS callers must fold ς→σ too)
- Verse `body` KEEPS getBible inline markers (`<FI>..<Fi>` italics = translator-
  supplied words, `<FR>..<Fr>` red-letter, `<FO>..<Fo>` OT quote) — owner wants
  source formatting preserved and RENDERED (app renderBody()); never strip them.
  ylt/weymouth carry FI; the WEB text is built from USFM
  (texts/english/web-usfm/, eBible.org) with \wj -> FR — 2,059 red-letter
  verses — and \add -> FI. Its USFM also embeds per-word Strong's tags
  (\w word|strong="G..."\w*), currently stripped at ingest — a future
  reverse-interlinear data source.
- `dictionary(word, definition)` — 200k ENGLISH dictionary entries: Webster's 1913
  (`resources/lexicons/websters-english/`, incomplete but rich) merged with WordNet 3.1
  (`resources/lexicons/wordnet-3.1/`, fills all gaps). Owner rule: English words get
  ENGLISH dictionary definitions — never present the Greek/Hebrew lexicon as the
  "dictionary" for an English word (cross-language mapping is shown only as a
  clearly-labeled secondary section)
- `crossrefs(from_book/chapter/verse, to_ref, to_book/chapter/verse, votes)` — 344,799
- `verses_fts` — FTS5 full-text index over all verse text, built over the
  `verses_plain` view so `<FI>` etc. are NOT tokens ("fi" used to match 15k verses)
- **Phase A layers (ROADMAP.md, added 2026-09-02; each built by its own
  `tools/*_extra.py` module called from build_db.py):**
  `lexicon_full(source, strongs, lemma, lemma_norm, entry, entry_len)` — BDB /
  Abbott-Smith / LSJ full entries (entry text uses ⟦I⟧ and ⟦R|b.c.v⟧ markers,
  render with renderRichBody) + `lexicon_affix` for STEPBible H9xxx codes;
  `verse_words(text_id, book_nr, chapter, verse, pos, word, strongs, strongs_all)`
  — WEB reverse interlinear, `pos` indexes the marker-stripped body split on
  whitespace; `morph_codes(lang, code, summary, explanation, example)`;
  `people / places / events / entity_other / entity_verses / entity_names /
  person_relations / event_links / easton` — Theographic + TIPNR graph
  (TIPNR `summary`/`article` are AI-adapted prose: never shown in the app);
  `verse_map(text_id, book_nr, chapter, verse, t_book_nr, t_chapter, t_verse,
  part)` + `text_traditions` — per-text versification differences chosen by
  evaluating STEPBible TVTMS tests against each edition (no row = identity;
  verse 0 = psalm title; part 'absent' = verse missing). works.db gained
  `work_refs(book_nr, chapter, verse, work_id, page, note)`.

Key joins: verse → `words` by (book_nr, chapter, verse); word → `lexicon` by strongs;
concordance = `SELECT ... FROM words WHERE strongs=?`. Caveats: BDB/Abbott-Smith not
yet linked (Strong's only); versification differences (LXX Psalms, Jeremiah) not yet
mapped — `words.alt_ref` holds TAHOT's alternate refs when present. sqlite3 gotcha:
don't reuse one cursor for a nested query while iterating another result set.

Vault size ≈ 1.4 GB. **Git repository** (branch `main`, repo-local identity
the owner; GitHub remote per DEPLOY.md — largest tracked file is 76 MB,
under GitHub's 100 MB cap; `app/data/` and `db/` stay gitignored); everything else is tracked. The folders that were git clones had
their `.git` removed and are pinned snapshots — origins + SHAs in
`integrity/CLONE-SNAPSHOTS.txt`; re-clone from there if an upstream refresh is wanted.

## Android APK (native install)

The app ships as a real Android app via Capacitor (`android-app/`) — same web code,
DB chunks bundled as APK assets so install needs zero network. appId
`org.library422.study`, debug APK ~420 MB (both DBs + embedder + map bundled) at
`android-app/android/app/build/outputs/apk/debug/app-debug.apk`.

- **Build:** `.\tools\build_android.ps1` (add `-Install` to adb-install + launch on a
  USB-connected phone). It refreshes `android-app/www` from `app/`, runs
  `npx cap sync`, then gradle.
- **After data changes:** `pixi run build-data` (= build-db → build-works → embed →
  build-items → check-db → bundle, in that order; embed writes db/vectors.db, so never skip it;
  `check-db` = tools/check_db.py, the read-only invariant gate — a failing
  check stops the bundle)
  → `.\tools\build_android.ps1 -Install` for the phone, and for the website
  `pixi run publish-data` + commit app/version.json + push (DEPLOY.md).
  Individual pixi tasks: `build-db`, `build-works`, `embed`, `bundle`, `site`,
  `publish-data`, `android`, `verify`, `dev`, `smoke`.
- **Before shipping UI changes:** `pixi run dev` in one shell, `pixi run smoke` in
  another — headless-Chrome test of every deterministic panel (48 checks incl. a
  catalog first launch (WEB + YLT only) + "Download everything", a remove/reinstall
  cycle of one text, deep links, the LXX coverage notice, the Ask AI (beta) toggle
  and a real AI-search-data download/remove cycle; console errors fail it; `--url`
  runs it against the live site, `--wide` at desktop size). `pixi run smoke-desktop`
  boot-checks the Electron edition (9 checks; `--exe` for a packaged build).
  `testbed/devtools/shot.py` screenshots any view/size/scheme for design review. It is the only runtime test of app.js; syntax checks are
  not enough.
- **OPFS access handles (2026-09-03 live finding):** the sahpool VFS takes EXCLUSIVE
  access handles. On the live site (no `Cache-Control: no-store` on index.html,
  unlike the dev server) Chrome's back/forward cache can keep a navigated-away page
  and its worker alive, so the next page's worker fails with "Access Handles cannot
  be created if there is another open Access Handle". db.js terminates the worker
  on `pagehide` when the page is stashed (and reloads on a persisted `pageshow`);
  the worker retries `installOpfsSAHPoolVfs` for ~6 s on that error. Only the live
  `--wide` smoke run reproduced it — keep running the smoke against the live site.
- **Service worker (app/sw.js):** shell cache `shell-v3` (bump on shell changes);
  the embedder lives in its own cache-first `embedder-v1` cache that survives shell
  bumps and is filled only by the AI-search-data download (worker `warmEmbedder`).
  The worker gates semantic search on `dbs.vectors`, so a query can never trigger
  the 60 MB fetch by itself. Page → SW message `drop-embedder` clears it on Remove.
- **Toolchain:** JDK + Node come from pixi. **openjdk is PINNED =21** — Gradle does not
  support JDK 25 ("Unsupported class file major version 69"); do not unpin. Android SDK
  lives at `C:\Users\timbe\android-sdk` (cmdline-tools + platform 35). Gotcha:
  `android-app/android/local.properties` `sdk.dir` must use FORWARD slashes
  (`\t` in `C:\Users\timbe` parses as a tab in Java properties format).
- The PWA route (dev server + browser install) still works unchanged; `app/sw.js` is
  excluded from the APK (assets are bundled — no service worker needed there).
- **Ask tab providers:** on-device Gemma (Android only, below) OR the user's own
  Anthropic API key ("claude" provider in llm.js, any platform; only the question +
  retrieved passages leave the device; key lives in localStorage `atb-ai`; no
  sampling params are sent — Sonnet 5 / Opus 5 reject `temperature` with 400;
  models offered: claude-sonnet-5, claude-haiku-4-5, claude-opus-5).
- **On-device AI (Android):** LlmPlugin.java wraps MediaPipe
  tasks-genai 0.10.35 (0.10.24 can't read .litertlm; parser dispatch is BY
  FILE EXTENSION — never rename a .litertlm to .task: 'Unable to open zip
  archive'). The owner's phone (11 GB) runs Gemma 3n E4B int4 at
  files/model.litertlm; SAF import sniffs PK header to keep the right name.
  CRITICAL: the engine does NOT stop at <end_of_turn> — generations run to
  the maxTokens ceiling. The plugin therefore uses LlmInferenceSession +
  cancelGenerateResponseAsync (stop() method); llm.js cancels when the turn
  marker appears in the stream. Engine failures (prefill overflow) surface
  on the session FUTURE, not the callback — plugin rejects via
  fut.addListener; llm.js also has a tiny-partial guard (<20 chars from a
  big prompt = mid-prefill death -> treat as failure) and a busy-retry.
  Context: 4096 is the stable on-phone maximum (8192 loads then dies at
  prefill); 4096 maps to 6 passages x 2000 chars ([8,2000] needs >=8192,
  used on desktop evals). Chat template applied per family (.litertlm ->
  Gemma <start_of_turn> wrap) in llm.js wrapForModel.
  ACCURACY CONFIG (measured, 2026-08-30 evening session): answer temp
  0.2 default (expansion 0.7, probe 0.3, per-call temps); grounding
  double-check verifyPrompt() default ON ("Double-check answers" toggle)
  — after a non-declined answer the model re-reads only the CITED
  passages and withdraws on contradiction/misattribution (bigsuite
  wrongs 3 -> 1 for ~2 extra declines; in-prompt meta-rules measured
  WORSE — don't add prompt rules, use checker generations).
  PHASE 3 SEMANTIC RETRIEVAL (shipped): db/vectors.db (optional DB,
  since 2026-09-02) carries ~170k chunk embeddings + 31k verse
  embeddings, int8 384d, ~79 MB — int8 loses ZERO recall, PCA does;
  see testbed/vector_formats.py). Query embedding
  runs in the app worker via app/vendor/embedder (transformers.js +
  all-MiniLM-L6-v2 q8 ONNX, fully offline; gotchas: allowLocalModels
  must be true, paths must be rooted not absolute, worker wants the
  .asyncify ort wasm). retrieve() merges semantic hits as a strategy
  (weight 2.5, +2 scoped); fails open when vectors.db isn't installed
  (worker throws "AI search data is not installed"). On-phone:
  ~113 ms/query after 1.7 s first-call load. Final measured: bigsuite
  33/11/0 (pass/decline/wrong), retrieval hit@3 42/44, suite_verses
  8/8. Data rebuild order: `pixi run build-data` (build_db.py ->
  build_works_db.py -> build_embeddings.mjs -> build_app_bundle.py;
  embeddings cached in testbed/emb by text hash; re-embedding from
  scratch ~75 min). Known open class: absent-work negatives
  (questions naming works not in the library) — see EVAL-PLAN.
  PRONUNCIATION (TtsPlugin.java + app.js speakBtn): speaker button on
  word panels / concordance speaks the LEMMA via device TTS (el / he
  voices — modern pronunciation; Web Speech API on the web route).
  Button self-hides when no voice exists. No audio files shipped —
  14k lexicon entries as files would cost 85-280 MB; runtime synthesis
  is free and covers inflected forms too. Future alternative for
  classical/Erasmian pronunciation: espeak-ng has an Ancient Greek
  ("grc") voice — could batch-generate opus files at build time for a
  curated subset if the owner dislikes modern pronunciation.
  THML RICH LIBRARY (ROLLED OUT: 41 volumes) — CCEL publishes ThML XML
  for anf01-09, all npnf1/npnf2, summa, gentiles, catena1/2 (URLs:
  ccel/schaff/<vol>.xml, ccel/aquinas/<id>.xml; catena3/4 have none;
  anf10 = index volume, parses to nothing — BOTH kept plain text).
  Sources in resources/.../thml/ (180 MB, in manifest).
  tools/build_works_db.py parses ThML (stdlib ET, THML_WORKS map, falls
  back to plain on parse failure) into TWO layers: work_pages.body =
  CLEAN plain text (search/AI/embeddings — 131k editor notes REMOVED AT
  SOURCE, killing the editor-footnote wrong-answer class) and
  work_pages.rich = display markers ⟦H⟧/⟦I⟧/⟦N|n⟧/⟦R|book.ch.verse⟧
  rendered by app.js renderRichBody (stack machine; note anchors are
  CSS-labeled buttons so textContent stays clean for jump-to-line).
  Note text lives in work_notes(body plain, rich) + work_notes_fts —
  searched ONLY via the "editor notes" checkbox (default off); never in
  AI prompts. Most scripRefs live INSIDE notes, so note sheets render
  rich too (tappable verse links -> reader).
  ENGLISH SEPTUAGINT: text_id `lxxen` (LXX2012, eBible USFM at
  texts/english/brenton-lxx/lxx2012; brenton-1851 also on disk,
  uningested). 28,324 verses, 54 books incl. 15 deuterocanon using the
  kjva/lxx book numbering (DC_TO_NR in build_db.py). Book picker now
  groups OT / NT / Apocrypha (apocrypha aggregated from text_books >66
  across kjva/lxx/lxxen; ensureReadable() auto-switches texts when the
  current pair lacks the book).
  QUERY ROUTING (llm.js routeQuestion): named Library author/work ->
  library route (existing scoping); else verse intent ("verses about",
  "bible", "scripture") or a Bible book name -> BIBLE route: hybrid
  verse retrieval (semanticVerses over 31k WEB verse vectors in
  bible.db + verses_fts keywords + parseRefs exact "John 3:16" fetch
  w/ context), buildVersePrompt, verse sources tap to the reader.
  Ambiguous book names (Job, Acts, Mark, John...) need "in <book>" /
  "<book> 3:16" / verse intent; "romans"/"hebrews" are ambiguous too
  (peoples as often as epistles). suite_verses.json 8/8, 0 wrong.
  Quirk to remember: WEB renders YHWH as "Yahweh" — "the Lord"
  phrasings can miss (v-shepherd).
  Grounded RAG (app/js/llm.js, tuned to 8/10 suite, 33/44 pass + 0 wrong big eval —
  see testbed/RESULTS.md + EVAL-PLAN.md): scopeWorks author scoping,
  selective bigram phrases (counted within scope), weighted strategy merge,
  BM25, index-page filter, densest-cluster excerpts w/ section anchoring,
  [1234] footnote stripping (model cited THEM otherwise), model query
  expansion + decline-triggered knowledge-probe retry, and whereLines():
  Where citations are APP-GENERATED from hit metadata (model only writes
  [n] — citations cannot be hallucinated). answer(q, onToken, onStage)
  emits UI stages; Ask UI shows animated dots + stage text.
  Ask page is a full chat screen (own appbar, tab bar hidden, pill composer
  pinned to the screen bottom): conversations persist in localStorage
  (atb-chats, cap 50) with reload/delete via a history sheet; AI settings
  sheet (atb-ai) = context size (auto/1280-8192, honored by loadModel) +
  temperature (passed through plugin generate) + model management + clear
  history. Word/verse bottom sheets cap at 34vh (owner wants the text
  visible); .tall sheets (AI history/settings) may use 75vh.
  Keyboard: activity uses windowSoftInputMode=adjustResize.
  Known gaps: some questions passing on desktop miss on phone (6 vs 8
  passages, int4 variance — e.g. Augustine's pears).
  ENGINE SAFETY (2026-09 audit fixes): "busy" from the plugin means a
  generation is STILL RUNNING — llm.js waits and retries the same level,
  never halves context / reloads on busy (reloading closes the engine
  under a live session). LlmPlugin.closeEngine() cancels, waits for the
  future, closes session THEN engine; import copies to model.tmp first.
  Token listeners detach in a finally (a rejected generate never sends
  `done`). scopeWorks GENERIC includes common title words (great, psalms,
  peter, galatians...) that were forcing the library route.
  Debug tooling + all hard-won CDP/adb mechanics: testbed/devtools/README.md.
- **System bars:** the app must NOT draw under the status bar or bottom nav. The fix
  that works is the WindowInsets listener in `MainActivity.java` (measures actual bar
  sizes and pads the content view; owner explicitly wants those areas excluded).
  Theme attrs (`windowOptOutEdgeToEdgeEnforcement`) and capacitor.config
  `adjustMarginsForEdgeToEdge` were NOT sufficient alone — don't remove the listener.
  That listener CONSUMES all insets, so it must also apply the ime() inset itself
  (bottom = max(bars, keyboard)) — adjustResize alone does nothing here, and
  without it fixed-bottom UI (Ask composer) hides behind the keyboard.

## Integrity workflow

- Verify sources anytime: `python tools/verify_manifest.py` (0 modified/missing = clean).
  Not required every session — it's an audit tool; run it when integrity is in question
  or before/after risky operations.
- After downloading NEW sources: rebuild with `python tools/build_manifest.py`, then
  commit sources + manifest together so git history and manifest stay in step.
- Line endings: `core.autocrlf=false` + `.gitattributes` (`* -text`) are deliberate —
  git must never rewrite source bytes. Do not "fix" line-ending warnings or enable
  autocrlf in this repo.

## Key technical facts (save yourself the searching)

- **getBible JSON structure** (all `texts/**/*.json` except Sefaria): top-level
  `{books: [{nr, name, chapters: [{chapter, verses: [{chapter, verse, name, text}]}]}]}`.
- **Book numbering is consistent across every getBible file** (Protestant order:
  Genesis=1 … Matthew=40, John=43 … Revelation=66), even when `name` is in Greek or
  Hebrew. Always match books by `nr`, resolving English names via `kjv.json`
  (this is exactly what `tools/Get-Verse.ps1` does).
- **Verse lookup:** `.\tools\Get-Verse.ps1 -Book John -Chapter 1 -Verse 1 [-Versions kjv,lxx,codex]`
- **Sefaria merged.json:** `{title, language, text: [...]}` — nested arrays
  (chapter/verse or daf/line). More texts: edit the filter in `Get-SefariaTexts.ps1`;
  files come from `https://storage.googleapis.com/sefaria-export/json/<path>/merged.json`
  (URL-encode spaces).
- **CCEL download pattern:** `https://www.ccel.org/ccel/schaff/<vol>/cache/<vol>.txt` —
  the `/cache/` segment is required; without it you get an HTML page.
- **Archive.org:** `https://archive.org/download/<id>/<id>_djvu.txt` works for
  English-only prints; OCR of Greek/English facing-page editions (Loeb) is garbage — avoid.
- **KJV+Strong's:** despite the name, the `kjva.json` in this vault carries NO
  `{H####}`/`{G####}` tags (checked 2026-09-02: zero matches) — it is the KJV with
  Apocrypha. Strong's lookups come from STEPBible `words` and the WEB `verse_words`.
- **Environment:** Windows 11. The system `python` on PowerShell is 3.10 (old
  SQLite 3.37); the project's Python is **pixi's 3.12** — run build scripts as
  `pixi run python tools/x.py` (or the pixi tasks) so everyone gets the same
  SQLite. Python is NOT on the Git Bash PATH. PowerShell 7 is the primary shell.
- **Environments/dependencies: use pixi** (installed, v0.50+). Any Python packages or
  toolchain installs go through a pixi environment (`pixi init` / `pixi add` in this
  repo) — never global `pip install`. If a processing script needs libraries, set up
  the pixi manifest first so runs are reproducible.

## Licensing boundaries (respect these)

- Everything in the vault is public domain or CC (BY / BY-SA) — see README.md tables.
- **ESV / NASB / Orthodox Study Bible are copyrighted and are NOT here.** Do not scrape
  or bulk-download them (this was discussed and settled: scraping esv.org exceeds
  Crossway's quoting license; the owner also declined the ESV API route). Stand-ins:
  BSB (modern literal), ASV (NASB ancestor), Brenton/LXX (Orthodox OT tradition).
- Quoting short passages of copyrighted translations inside `notes/` is fine (fair
  use / within quoting licenses); storing whole copyrighted texts is not.

## Conventions for notes

- New notes start from `notes/_templates/`; every note gets a one-line summary at top;
  link related notes with `[[name]]`; add an entry in `notes/INDEX.md`.
- Verse refs: `Book Ch:Vv (VERSION)` — e.g. `Gen 1:1 (WLC)`, `John 1:1 (SBLGNT)`.
- Original-language citation: text, then transliteration, then gloss —
  ἐν ἀρχῇ (*en archē*, "in the beginning").

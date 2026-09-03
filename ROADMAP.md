# ROADMAP — Library 422

Long-term plan, agreed 2026-09-02. CLAUDE.md is the operational reference for
what exists; this file is where we are going and in what order. Update the
status markers as work lands.

## Direction

Library 422 will be released to the public, **free**. That fixes three
constraints for every future decision:

1. **Offline, no server.** Everything runs on the device from the bundled
   databases. There is no account, no telemetry, no backend to pay for.
2. **Every shipped byte is public domain or open-licensed.** Sources must be
   public domain, CC0, CC BY, or CC BY-SA (attribution and share-alike
   honoured). Non-commercial-only, "free for personal use", or copyrighted
   material is excluded from the bundle. The exception is material that could
   be *licensed or purchased later* as an optional add-on; those are tracked
   in the "Purchasable later" list and never bundled by default.
3. **Model files are the user's.** The on-device LLM is imported by the user;
   the app ships no model weights.
4. **Content scope (owner decision 2026-09-02, refined the same day).**
   Christian scripture in its ancient languages and versions, plus ancient
   primary sources for its world (the Fathers, Josephus, Philo, Second-Temple
   texts such as Enoch). For **Jewish religious texts the line is BC vs AD:**
   works composed before Christ (the Septuagint, Enoch, Sirach, Wisdom,
   Maccabees, and candidates such as Jubilees, the Letter of Aristeas, the
   Psalms of Solomon) are acceptable; anything composed in the Christian era
   — the Targums (redacted 1st–5th c. AD), Mishnah, Talmud, midrash and all
   later commentary — is **out of scope** and is never ingested, even though
   Sefaria copies sit in `resources/jewish-texts/`. Hebrew-language data must
   be ancient (WLC, Aleppo, tagging, lexicons).

## Licensing ledger

Tier: **PD** = public domain / CC0, **BY** = CC BY (attribute), **BY-SA** =
CC BY-SA (attribute + share derived data alike), **NC** = non-commercial only
(do not bundle), **?** = verify before shipping.

| Source | Used for | Tier | Obligation |
|---|---|---|---|
| KJV, KJVA, ASV, YLT, Tyndale, Douay-Rheims, Weymouth, Darby, Brenton, LXX2012 | Bible texts | PD | none |
| World English Bible (eBible.org USFM) | Bible text, verse vectors, reverse interlinear | PD | none |
| Berean Standard Bible | Bible text | PD (CC0 per berean.bible) | none |
| SBLGNT | Greek NT | BY (SBL/Logos licence: free, attribute) | attribution |
| Robinson-Pierpont Byzantine, TR, Westcott-Hort, Tischendorf, LXX (Greek), WLC, Aleppo, Vulgate, Peshitta | original-language texts | PD | none |
| STEPBible TAHOT / TAGNT, TBESG/TBESH, TFLSJ (LSJ), TIPNR proper nouns, versification | tagging, lexicons, names, versification | BY (CC BY 4.0, Tyndale House) | attribution screen |
| Strong's dictionaries (openscriptures) | lexicon | PD | none |
| Brown-Driver-Briggs XML (openscriptures HebrewLexicon) | Hebrew lexicon | ? (text PD 1906; XML edition CC BY 4.0) | verify LICENSE in folder; attribute |
| Abbott-Smith TEI (biblicalhumanities) | Greek lexicon | ? (text PD 1922; TEI edition CC BY-SA 4.0) | verify README; attribute + SA |
| Dodson Greek lexicon | glosses | PD (CC0 per LICENSE) | none |
| Webster's 1913, WordNet 3.1 | English dictionary | PD / WordNet licence (permissive) | WordNet notice text |
| OpenBible.info cross-references | crossrefs | BY (CC BY) | attribution |
| Theographic Bible metadata | people / places / events | BY-SA (CC BY-SA 4.0) | attribution; derived tables share-alike |
| CCEL ThML editions (ANF, NPNF, Summa, Contra Gentiles, Catena) | Library | PD text; CCEL markup: verify | attribute CCEL as source |
| Josephus (Whiston), Philo (Yonge), Enoch (Charles), Apostolic Fathers (Gutenberg) | Library | PD | Gutenberg trademark rules if text kept verbatim with header |
| Sefaria: Mishnah, Talmud, rabbinic commentaries | — | out of scope | not ingested (content scope rule 4) |
| Sefaria: Targum Onkelos / Jonathan | — | out of scope (AD compositions) | not ingested (content scope rule 4) |
| Charles, *The Book of Jubilees* (SPCK 1917); Thackeray, *The Letter of Aristeas* (1904) — Archive.org OCR, cleaned by `tools/clean_ocr.py` | Library: Intertestamental Texts | PD | none — *added 2026-09-02* |
| Charles (ed.), *Apocrypha and Pseudepigrapha of the OT* vol. 2 (1913), Archive.org scan `cuaapocryphaandp00char`: Psalms of Solomon (Gray), Testaments of the XII Patriarchs (Charles) | Library: Intertestamental Texts | PD | none — *added 2026-09-02*. The Testaments are 2nd c. BC with later interpolations (the translation's notes mark them); 4 Maccabees, the Sibylline Oracles, 2 Baruch, 4 Ezra, Pirke Aboth and the rest of the volume are AD and were NOT taken |
| Natural Earth 1:10m coastline, lakes, rivers (`app/vendor/map/levant.json`) | offline map | PD | none (credit given on the map) |
| sqlite-wasm, transformers.js, ONNX runtime, MiniLM model, MediaPipe, Capacitor | software | PD / Apache-2.0 / MIT | NOTICE text in the about screen |

**Purchasable later (never bundled):** ESV, NASB, NIV, Orthodox Study Bible
notes, modern critical apparatus (NA28 /
UBS5), modern lexica (BDAG, HALOT, Louw-Nida).

## Release readiness

- [x] Attribution / licences screen in Settings (every BY and BY-SA source, software NOTICEs) — *2026-09-02*
- [x] Privacy statement: nothing leaves the device except the optional Claude provider (question + retrieved passages), stated in-app — *2026-09-02, on the same card*
- [x] Release signing: `app/build.gradle` reads a gitignored `keystore.properties`.
  Keystore generated 2026-09-02 at `android-app/android/library422-release.jks`
  (alias `library422`, RSA-4096, valid ~27 years) with a random password kept
  only in `app/keystore.properties`. **Both files are gitignored and must be
  backed up off this machine** — an APK signed with any other key cannot
  update an installed copy. R8 deliberately left off.
- [x] Remove the dead FileProvider from the manifest — *2026-09-02*
- [x] PWA route: "New Bible data is available — Update now / Later" bar; the old
  data keeps working; the APK still auto-installs its bundled data — *2026-09-02*
- [x] Storage estimate before a first install; readable "Not enough storage"
  message — *2026-09-02*
- [x] Ask AI is **beta and off by default** (Settings → "Ask AI (beta)"); the
  semantic index moved out of the base databases into an optional
  `vectors.db`, and it plus the query embedder download only on the user's
  request. First-launch download 267 → 216 MB, and no 60 MB embedder
  precache — *2026-09-02*
- [~] Distribution: `tools/build_release.ps1` produces `dist/library422-<version>.apk`
  (signed, verified with apksigner) and `dist/site/` (via `tools/build_site.py`).
  Version comes from `app/version.json` (shown in Settings; stamped into the
  Android build). **Hosting pipeline in place** (2026-09-02, see `DEPLOY.md`):
  push to `main` → GitHub Actions → `wrangler deploy` to a Cloudflare
  static-assets Worker on library422.org; data bundle published as GitHub
  release assets by `pixi run publish-data`. **Live since 2026-09-03** at
  https://library422.org (private repo github.com/JacobSlattery/library422,
  data release `data-20260902-62896c770c`). Still to do: APK download link
  on the site / GitHub release; F-Droid / Play later
- [ ] Crash-free first launch on a low-RAM (3 GB) phone
- [ ] Trim the APK the same way (it still bundles the embedder + vectors.db
  chunks as assets, ~130 MB): fetch them from library422.org on request instead

## Feature plan

Status: `[ ]` not started · `[~]` in progress · `[x]` shipped. Each item names
its data source so the licensing tier is never in doubt.

### Phase A — data already in the vault (no new downloads)

- [x] **The Fathers on this verse.** `work_refs` in works.db: 87,718
  scripture references from the 41 ThML volumes (page bodies and editor
  notes) → work + page. Verse sheet: "In the Library" panel; tapping lands on
  the reference in the work. Data: CCEL ThML (PD). *Shipped 2026-09-02.*
- [x] **Full lexicons.** `lexicon_full` in bible.db: BDB 12,298 entries,
  Abbott-Smith 5,953, LSJ 10,782 — every Greek and Hebrew Strong's number
  has at least one full entry; STEPBible affix codes (H9xxx) get their own
  `lexicon_affix` table. Word panel / concordance show them as collapsed
  sections under the Strong's gloss. Data: openscriptures BDB (BY), Abbott-
  Smith TEI (PD text), STEPBible TFLSJ (BY). *Shipped 2026-09-02.*
- [x] **Reverse interlinear.** `verse_words`: 755k WEB tokens with Strong's
  codes (OT 90%, NT 93% tagged), aligned to the rendered body by position.
  English word panel shows "Behind this word (WEB tagging)". Caveat: eBible's
  tagging is approximate in places; STEPBible `words` stays authoritative.
  (The vault's `kjva.json` turned out to carry no Strong's tags, so there
  is no second source to add.) Data: WEB (PD). *Shipped 2026-09-02.*
- [x] **Morphology in plain English.** `morph_codes`: 1,644 Greek + 921
  Hebrew/Aramaic expansions; 99.9% of word tokens decode (compound OT codes
  and NT crasis handled in app.js). Data: STEPBible TEGMC/TEHMC (BY).
  *Shipped 2026-09-02.*
- [~] **People, places, events.** `people` 3,162 · `places` 1,330 (1,290 with
  coordinates) · `events` 450 · `entity_verses` 63k · Easton's dictionary
  6,519 entries; TIPNR merged into Theographic (3,920 merged, 339 added).
  Shipped: entity sheet (facts, Easton entry, family, events, verses),
  "People, places & events" on the verse sheet, name lookup from English
  word taps and search, events timeline in the Library. Deliberately NOT
  shown: TIPNR's `summary`/`article` prose, which its header says was
  adapted from an AI model — the app shows only structured data and the
  1897 Easton text. Offline map shipped too: Natural Earth 1:10m coast,
  lakes and major rivers (public domain) clipped to 8–52°E / 22–46°N and
  simplified into `app/vendor/map/levant.json` (140 KB, built by a one-off
  script; source files not kept), drawn on a canvas with pan / pinch-zoom /
  tap-to-open; "Show on map" on place sheets and "Map of Bible places" in
  the Library. Data: Theographic (BY-SA), TIPNR (BY), Natural Earth (PD).
  *Shipped 2026-09-02.*
- [~] ~~Targum parallel reading~~ — **declined 2026-09-02** (AD
  compositions; content scope rule 4). In its place, BC Second-Temple texts
  join Enoch in an "Intertestamental Texts" Library shelf: **Jubilees** (Charles
  1917) and the **Letter of Aristeas** (Thackeray 1904) added 2026-09-02 from
  Archive.org OCR via `tools/clean_ocr.py` (derived `*.clean.txt`, commands in
  `pseudepigrapha/CLEANUP.txt`), then the **Psalms of Solomon** (Gray) and
  the **Testaments of the XII Patriarchs** (Charles) sliced from Charles's
  1913 vol. 2 the same day. The shelf now holds five BC works. Nothing AD
  from that volume was taken.
- [x] **Reader's edition mode.** Settings → "Greek & Hebrew display →
  Reader's edition"; threshold 10–200 occurrences. *Shipped 2026-09-02.*
- [x] **Interlinear layout.** Same setting, "Interlinear". *Shipped 2026-09-02.*
- [x] **OT quotations in the NT.** Verse sheet: "Old Testament background"
  on NT verses (best-voted links into the OT) and "Cited in the New
  Testament" on OT verses (reverse index `idx_crossrefs_to`). Data:
  OpenBible cross-references (BY). *Shipped 2026-09-02.*
- [x] **Read aloud.** Speaker button in the pager reads the primary text
  verse by verse with a following highlight (TtsPlugin `speakQueue` on
  Android, Web Speech elsewhere); pause/resume; stops on navigation. Button
  hides when the device has no voice for the text's language (Latin and
  Syriac voices are rare). *Shipped 2026-09-02.*
- [x] **Morphological search.** Search tab → "Parsing search": Strong's or
  lemma × parsing-code pattern (`V-A?M*`, `*Vqw*`) × book range, results
  with plain-English parsing. *Shipped 2026-09-02.*
- [x] **Edition comparison.** Dotted-underline variant markers in the
  tagged reader (NT words missing from any of NA28 / SBL / TR / Byz / WH;
  Hebrew Ketiv/Qere) with the edition list in the word panel, plus
  "Compare Greek editions" on NT verse sheets: word-level diff of
  Westcott-Hort (base), Textus Receptus and Tischendorf, accents ignored.
  *Shipped 2026-09-02.*
- [x] **Versification mapping.** `verse_map` per TEXT: build_db evaluates
  STEPBible's TVTMS tests against each edition and stores that edition's
  differences (LXX 4,585 rows, Vulgate 4,359, Douay-Rheims 4,374, LXX2012
  3,930, WLC 2,037, Aleppo 2,023; English texts 0). The reader and the verse
  sheet fetch those texts through the map, so Psalm 23 lines up with LXX/
  Vulgate Psalm 22 and Hebrew psalm titles ride with verse 1. Known gap: LXX
  Jeremiah 25–52 stays partly unaligned (our Greek edition's chapter lengths
  do not match any TVTMS column there). *Shipped 2026-09-02.*

### Phase B — the user's own layer

- [x] **Annotations.** Four highlight colours, bookmarks and notes on verses
  (verse sheet toolbar; rows tint, verse numbers show ★ / a dotted underline)
  and on Library pages (under the page); stored in IndexedDB
  (`app/js/annotations.js`, localStorage fallback); "My notes & bookmarks"
  in the Library lists everything and exports Markdown in the `notes/`
  reference style (share sheet, else clipboard). *Shipped 2026-09-02.*
  Still to do: import back from Markdown (the v2 sync path).
- [ ] **Notes vault (v2).** Read-only rendering of `notes/` with wiki-link
  navigation; later read/write sync via FastAPI over Tailscale (owner's device
  only, never part of the public app).

### Phase C — bigger bets

- [ ] **AI over the Fathers.** "Compare what Chrysostom and Augustine say
  about this passage", "summarise this work's argument on X" — retrieval
  scoped by author and passage, same grounded pipeline.
- [~] **Tablet split view.** Reader beside Library / search / notes.
  *2026-09-03: on wide screens (≥1000 px) a citation from the verse
  panel's "In the Library" list opens in the side pane with page arrows and
  "Open in Library", so the verse stays in view — and the mirror: a
  scripture reference inside a Library work opens the verse in the pane
  while the work stays. A resizable two-column split remains open.*

### Phase D — platforms and distribution (direction agreed 2026-09-03)

**Purpose (owner's words):** give Christians free, easy access to as many
study tools and sources for the core works of the faith as possible, with
no price of entry. The web app is the slim, instant version; the desktop
build is fully localized and travels on a flash drive to places without
internet; the mobile apps are the same thing in a pocket. **One shared
codebase for every target** — the UI talks to the data layer only through
the worker's `exec(sql)` RPC, and each platform reimplements that one
contract. No rewrites in other languages (including Apple: Capacitor iOS is
the same web code; only the thin plugins are Swift).

Order of work — each item builds on the one before it:

1. [x] **Data catalog** — *shipped 2026-09-03: first launch 15 MB (core
   databases + the default WEB and Young's Literal), 88 items managed one by
   one from Settings → Catalog (per-group / per-shelf / everything
   shortcuts) or from inline prompts; design and mechanism in
   `app/CATALOG.md`. Owner refinements the same day: individual items rather
   than grouped packs, defaults WEB + YLT, and the reader explains a text's
   coverage (the Septuagint has no NT) instead of "Nothing here".* (The
   original plan follows.)
   (the foundation; target: first web load under 20 MB).
   Generalize what `vectors.db` started: the manifest lists N independent
   databases, the worker installs *core* at first launch and the rest on
   request, and queries span installed packs through SQLite `ATTACH`.
   Features whose pack is missing show an inline "needs the X pack (N MB) —
   Download" instead of disappearing. Proposed boundaries (decide in a
   design pass before building): **core** = WEB + KJV with search, cross-
   references, Strong's, book metadata; packs = Original languages (tagged
   Greek/Hebrew + morphology), Full lexicons (BDB/LSJ/Abbott-Smith), English
   dictionary, People/places/events + map, one pack per additional Bible
   text, the Library per shelf or per work, AI search (exists). Also solves
   the APK size (Play Asset Delivery maps onto packs) and lets the desktop
   build ship everything by copying a folder.
2. [x] **Desktop layout** — *shipped 2026-09-03: from 1000 px (tablet
   landscape) the tab bar becomes an icon rail with the chapter/page
   navigation at its foot and detail panels open in a right-hand pane the
   content column makes room for; from 1200 px the rail widens into a
   labelled sidebar and the pane to 440 px; ← → turn chapters, "/" jumps to
   search; prose widths capped.*
   (Original plan:) Wide breakpoint (~1100 px+): left rail instead of
   bottom tabs, true side-by-side parallel texts, word/verse panels in a
   persistent right pane instead of the 34vh sheet (the biggest waste on
   desktops), reader beside Library/search (the split-view item above),
   keyboard shortcuts. Mechanism: make `sheet()` a panel host that chooses
   sheet vs side pane by width so every existing panel benefits.
   Independent of packs — can run in parallel.
3. [~] **Desktop app: Electron, portable build** (Windows, Linux, macOS).
   *2026-09-03: `desktop-app/` boots the identical web app over a private
   app:// origin with Node's SQLite reading the full databases from disk
   (9/9 boot checks incl. semantic search, `pixi run smoke-desktop`);
   portable packaging via `node pack.js win32|linux` produces
   `dist/desktop/Library422-<platform>-x64/` (1.1 GB with all data; the
   Windows build boots from the folder). Left: macOS (needs a Mac), an app
   icon, signing, a download link on the landing site.*
   Same web code; the data layer is Node's built-in SQLite reading the pack
   files straight from disk (no copy into browser storage, instant start,
   works from a flash drive with no installer). Chosen over Tauri because
   it is the exact engine the smoke test covers and Tauri's Linux webview
   has storage gaps; ~100 MB extra is acceptable next to 700 MB of data.
4. [~] **Android:** stays Capacitor; trim the APK via the catalog. *2026-09-03:
   the debug APK builds with the catalog bundle (318 MB, was 420); first
   launch installs the core + WEB + YLT like the web, the rest is a tap away
   from the bundled assets (works offline). Not yet installed on a phone
   since the catalog change — verify the first launch and a Catalog install
   there. Bundling fewer items (a lighter APK) is now a build choice.*
5. [ ] **iOS:** Capacitor iOS, when a Mac (Xcode + developer account) is
   available. TTS plugin is trivial; the on-device LLM plugin gets ported or
   left out.

**Site structure (agreed 2026-09-03):**

- [x] **Move the app to its own origin, `app.library422.org`, BEFORE there
  are real users.** Browser storage and the service worker are per origin;
  the landing site must never share them (a path move later would force
  every installed copy to re-download). Same deploy workflow, two Workers
  (`wrangler.app.jsonc`, `wrangler.site.jsonc`); a placeholder landing
  page in `site/` holds the root — *2026-09-03*.
- [ ] **library422.org becomes the landing site:** what it is, what it can
  do, tutorials (screenshots + short walkthroughs), download links for the
  desktop / mobile builds (GitHub releases as the artifact host, like the
  data bundle), a spot to try the web app, and eventually the open-source
  repo link. Plain static HTML generated by a small script in tools/ — no
  build framework, consistent with the app.
- [x] **Deep links in the app** — *2026-09-03: `/read/<book>/<chapter>[/<verse>]`,
  `/library/<work-slug>/<page>`, `/word/<strongs>`, `/search/<query>`; the URL follows
  navigation (replaceState); Cloudflare single-page fallback +
  dev_server SpaFallback + `<base href="/">`; http(s) only (APK/desktop
  keep their own schemes). A "Link" button on the verse panel and on
  Library pages copies the address (share sheet on the APK).*
- [x] **Per-resource pages on the landing site** — *2026-09-03: `tools/
  build_site.py --landing` generates `/works/`, `/works/<slug>/`,
  `/bibles/`, `/bibles/<id>/` from `site/catalog.json` (written by
  build_app_bundle.py, committed with the data pin), each with a deep link
  into the app. Still to add: plain-text/EPUB downloads (needs a public
  place to host them — release assets are private while the repo is), and
  the truncated CCEL volume titles in works.db.*
- [ ] **Open-sourcing prep (before the repo link goes public):** move the
  Sefaria downloads (`resources/jewish-texts/`, some possibly NC) out of
  the tracked tree/history, and consider a public code repo + separate
  sources repo so contributors don't clone 700 MB.

## Backlog from the 2026-09-02 audit (low severity)

All closed the same day: `renderBody` carries open markers into the next
verse (Weymouth `<FO>`); every `build_db.py` loader reports what it skipped;
H9xxx affix codes have `lexicon_affix` entries; concordance lists page in
"Show more" steps; tab bar has ARIA tab roles.

## Tooling added 2026-09-02

- `pixi run smoke` — headless-Chrome test of the deterministic UI (27 checks).
- `tools/clean_ocr.py` — deterministic formatting cleanup for Archive.org OCR
  (slice, drop page furniture, re-join hyphenation, collapse OCR spacing);
  writes a derived `*.clean.txt`, never touches the source (Rule 1).
- `tools/build_embeddings.mjs` cache is now per chunk text (`*.keys`), so
  adding a Library work embeds only its own chunks.
- `tools/versification_extra.py` scores near-miss editions (LXX Jeremiah).

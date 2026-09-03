# Ask-AI Evaluation & Improvement Plan (autonomous session)

> Owner is away with the phone. Goal: locally test and improve the grounded
> Ask pipeline as much as possible against the REAL target model, then run a
> large evaluation. This file is the durable state — update it as work
> progresses so context compression never loses the thread.

## Assets

- **Target model:** `models/gemma-3n-E4B-it-int4.litertlm` (4.9 GB, Gemma 3n
  E4B instruction-tuned, int4). TOS at models/gemmaTOS.txt. Gitignored.
- **Small stand-in:** `%TEMP%\qwen05b.task` (Qwen2.5-0.5B, 1280-token cache) —
  useful for fast harness debugging only.
- **Pipeline under test:** app/js/llm.js (retrieve/buildPrompt/answer) over
  db/works.db FTS (BM25 + porter + ligature expansion). Plugin behavior
  reference: android-app/.../LlmPlugin.java.

## Harness (to build)

Desktop Chrome runs the same .task/.litertlm files via MediaPipe's web runtime:
- `npm i @mediapipe/tasks-genai` inside android-app (node env exists) or a
  testbed package.json; vendor the wasm+js into testbed/vendor (no CDN).
- testbed/harness.html + harness.js: loads genai wasm, loads model from
  /models/... (serve repo root or add route), imports app/js/db.js + llm.js
  modules directly (same code as app!), exposes window.__eval hooks:
  runQuestion(q) -> {hits, prompt, answer, timings}.
- Serve via tools/dev_server.py (add /models static mount + /testbed mount).
- Drive with CDP (probe scripts in scratchpad already show the pattern;
  ping_interval=None; generation can take minutes for E4B on CPU/WASM —
  poll patiently, timeout 10+ min per question).
- NOTE: llm.js plugin() guards on window.Capacitor — harness must shim a
  fake Capacitor.Plugins.Llm backed by the web runtime (loadModel/generate/
  countTokens/status/addListener) so llm.js runs UNMODIFIED.

## Improvement backlog (test-driven, in rough order)

1. Chat template: Gemma format `<start_of_turn>user\n...<end_of_turn>\n<start_of_turn>model\n`
   — raw text underuses IT models. Make template a llm.js option; detect
   family via a stored setting at import (or filename); measure vs raw.
2. Work/author scoping: detect author/work mentions in the question
   ("Eusebius", "Josephus", "Aquinas", "Enoch"...) via works.title match;
   filter/boost retrieval to those works. Big precision lever.
3. Retrieval: query relaxation ladder (drop rarest-missing terms before
   full OR); phrase queries for quoted strings; dedupe adjacent pages;
   consider NEAR() queries.
4. Excerpting: center on densest keyword cluster, not first hit; include
   section title in excerpt header (already have).
5. Answer format: instruct structure — direct answer first, then
   "Where: <work>, <section>, p. <page> [n]". Enforce/verify by regex.
6. contextTokens for E4B: Gemma 3n supports large ctx; find what the wasm
   runtime handles (maxTokens 4096 start; try 8192).

## Verification suite (all must pass before the big run)

Format: question | must-retrieve (work slug, page or keyword) | answer must contain
1. Who led Potamiaena to martyrdom? | npnf201 p202 | Basilides
2. What did Polycarp say when asked to revile Christ? | apostolic-fathers or anf01 | "eighty and six years"
3. To which church did Ignatius write begging not to be rescued from the beasts? | anf01 | Romans
4. Where does Josephus mention James the brother of Jesus? | pg2848 (Antiquities) | James / brother of Jesus / Ananus
5. What are Aquinas's five ways? | summa | five ways / motion
6. On which mountain did the Watchers descend (Enoch)? | book-of-enoch | Hermon
7. Who were the Therapeutae described by Philo? | philo-yonge-vol* | contemplative/Egypt/Mareotis (verify exact vol first)
8. What miracle happened to the Thundering Legion? | npnf201 | rain / thundering
9. What are the Two Ways at the start of the Didache? | anf07 | way of life / way of death
10. Who spoke last at Masada and what did he urge? | pg2850 (Wars) | Eleazar
(Verify each expected location against works.db BEFORE trusting the test.)

Scoring: retrieval hit@3 (expected work in top 3), answer-contains, citation
present ([n] + Where line). Track results in testbed/RESULTS.md per iteration.

## Final deliverable

When suite passes: 40+ question run (mix: factual-locate, quote-finding,
cross-work, negative controls that AREN'T in the library — must say "not
found"). Report accuracy + formatting compliance in testbed/RESULTS.md and
summarize for the owner.

## State log (append entries!)

- [init] Plan written. Harness not yet built. Suite expectations unverified.
- [phone] Gemma 3n E4B WORKS on the phone (owner-verified answer on screen).
  Fixes that mattered: tasks-genai 0.10.35; keep .litertlm extension (engine
  parses by suffix — 'Unable to open zip archive' means wrong extension);
  Gemma chat template + <end_of_turn> sanitization (llm.js). Template item
  from backlog is DONE. Phone left with owner; all further work is desktop:
  models/gemma-3n-E4B-it-int4.litertlm via the web harness.
  Caution: CDP sockets die under heavy inference even with pings off —
  reconnect and re-read DOM rather than holding one connection; verify the
  target list has the RIGHT page (stale targets caused a false 'no answer').
- [desktop] Gemma web runtime dead ends: WASM genai needs WebGPU AND a
  gpu_artisan .litertlm build (ours is CPU-flavored); LiteRT-LM Windows exe
  (v0.11.0) missing libGemmaModelConstraintProvider.dll. WORKING PATH:
  llama-server + ungated unsloth gemma-3n-E4B-it Q4_K_M GGUF on :8081
  (pixi llama.cpp), ~7s/answer CPU. Chrome launcher gotcha: lingering
  chromes holding atb-cdp-profile make new launches delegate-and-exit —
  kill by CommandLine match first.
- [tuning] Suite journey 4/10 -> 8/10 answers (commit ff707fa has full
  details). Key wins in order of impact: ORDER BY rank (BM25) on FTS;
  model-assisted query expansion; footnote-marker stripping (model cited
  the texts' [1234] markers!); app-generated Where lines; author scoping;
  section-anchored excerpts; scoped phrase selectivity. Config locked:
  8 passages x 2000 chars (more = attention dilution on 4B).
  Residual fails: watchers-hermon (model quotes Sinai from En 1:4),
  masada (speech pages lack the word Masada) — embeddings-phase class.
- [final] Probe-retry added: big suite 30/44 -> 34/44 (77%). Small suite
  8/10. Negatives 8/9 (Trent 'failure' was a grounded answer from an ANF03
  editor footnote — defensible). Reports in RESULTS.md.
- [on-device] Owner returned; live phone debugging found THE big one: engine
  never stops at <end_of_turn> -> runaway generations looked like 'stuck at
  ...'. Fixed via LlmInferenceSession cancellation + JS marker watch; also
  engine-future error surfacing, tiny-partial guard, busy retry, staged
  thinking UI (animated dots), adjustResize keyboard. Phone ask now 66-142s
  end-to-end. 8192 ctx loads but dies at prefill on this phone -> cascade
  capped 4096 -> 6x2000 passages. Pears question still misses ON PHONE
  (passes desktop) — phone quality trails desktop a notch.
- [open items, small] tab-highlight shows 'reader' during work-picker view;
  settings gear icon looks sun-like; search/library appbar titles
  inconsistent; Library works lack in-work TOC search; eval WHERE_RE
  ignatius nit. [open, big] phase-3 on-device embeddings (needs a mobile
  embedder runtime — MediaPipe TextEmbedder or EmbeddingGemma via LiteRT);
  desktop-only embeddings rejected as non-transferable.
- NOTE: dev server (:8000) and llama-server (:8081) are session background
  processes — restart after a new session: `pixi run dev` and
  `pixi run llama-server -m models/gemma-3n-E4B-it-Q4_K_M.gguf -c 8192
  --port 8081`.
- [accuracy session 2026-08-30 pm] Owner directive: accuracy is THE
  priority — wrong answers unacceptable; misses tolerable. Failure
  analysis of the 34/44 run: only 1-2 true wrong answers, both
  MISATTRIBUTION (model adapts a near-miss passage from the wrong
  author/work, e.g. four-gospels answered "two" from a Tertullian-Marcion
  page); rest were scoring artifacts (200 vs "two hundred";
  Caligula=Gaius — fixed in bigsuite.json), format-only, or declines.
  Eval scoring rebuilt: PASS / MISS (declined) / WRONG (answered wrong,
  incl. answered negatives) + trap-question support (false premise:
  PASS = decline or explicit correction) + answer_must_not +
  expect_slug lists. Temp is now an eval arg — DISCREPANCY FOUND: all
  prior desktop evals ran temp 0.1 while the phone runs 0.6.
- [embeddings feasibility] transformers.js + all-MiniLM-L6-v2 (q8 ONNX)
  in node: 5s load, 3-10ms/query — the app's WebView can embed QUERIES
  on-device trivially; corpus vectors precomputed at build time.
  works.db = 16,803 pages, ~10.1KB avg -> ~205k chunks at 1000/850
  stride. Ship-size options: int8 79MB / int8+PCA128 26MB / coarser
  chunks. llama.cpp serves the same MiniLM GGUF for desktop corpus work
  (models/all-MiniLM-L6-v2-Q8_0.gguf, :8082 --embedding --pooling mean).
  EmbeddingGemma/MediaPipe rejected for now: Android-only, no web path.
- suite2.json added: 17 new verified factual (every expectation checked
  against works.db by FTS first), 6 traps (author-swap/false-premise),
  5 negatives.
- [experiments, bigsuite 44q] temp 0.6 (phone parity): 32 PASS/9 MISS/
  3 WRONG. temp 0.2: 34/7/3 — ADOPTED (llm.js default temp now 0.2;
  expansion pinned 0.7, probe 0.3 via per-call temp).
  In-prompt attribution-guard meta-rule: 32/8/4 — WORSE, REVERTED
  (4B ignores meta-rules; b12 still misattributed, and the guard run
  produced a NEW wrong answer). Conclusion: fight misattribution with a
  focused verifyPrompt() second pass, not prompt rules.
- Embedding server gotcha: llama-server --parallel N splits the 512-token
  BERT ctx into N slots -> every chunk 400s -> per-item truncation death
  spiral. Correct: -c 512 -b 4096 -ub 4096, no --parallel. In practice the
  NODE path won (testbed/embed_corpus_node.mjs, transformers.js q8 ONNX,
  ~43/s under load): same runtime as the app => vectors transfer 1:1.
- [verify pass, bigsuite] v1 (strict, question-term excerpts): 24/20/0 —
  killed all wrongs but 10 correct answers with it. Root cause of the
  false rejections: verifyPrompt excerpted pages by QUESTION terms, so
  the checker often read a different window than the answer came from.
  v2 (window = question+answer terms, UNSUPPORTED only on contradiction/
  misattribution): 29/14/1. Config table (bigsuite 44q):
    0.6 plain 32/9/3 · 0.2 plain 34/7/3 · 0.2+guard 32/8/4 (reverted) ·
    0.2+verify-v1 24/20/0 · 0.2+verify-v2 29/14/1.
  SHIPPED DEFAULT: temp 0.2 + verify v2 ON (owner: wrong answers are the
  unacceptable class; misses tolerable). aiSettings.verify toggle added
  ("Double-check answers"); llm.js answer() runs verifyPrompt after
  non-declined answers, probe-retries once on rejection, then declines
  with an honest message. The residual wrong (b26 james-death) is a pure
  retrieval failure (wrong James) — the embeddings lever, not verify.
- [verifier v3/v4 iteration] v3 added (2) header-attribution emphasis and
  (3) "must answer the question": bigsuite 26/18/0 then 20/23/1
  (replicate — HIGH VARIANCE), suite2 19/7/2, traps 6/6. v4 = v3 minus
  clause 3 (it never caught its target case and drove false declines):
  bigsuite 32/11/1, suite2 17/7/4. SHIPPED: v4 (best realistic-suite
  operating point). Open question for a future session: v3 vs v4 with
  3-run averages; consider 2-vote verification if phone latency allows.
  All remaining wrongs across suites are retrieval-precision failures
  (right page absent from prompt; near-miss page has no on-page
  contradiction): s2-linus (Anacletus page instead of Linus page),
  s2-philo-statue (money-contributions page instead of statue page),
  n-benedict (Cassian silence rules read as Benedict's Rule),
  b12 (Tertullian-Marcion page instead of Irenaeus four-zones page).
  These are exactly what semantic retrieval should fix.
- [EMBEDDINGS RECALL — the go signal] Full corpus embedded: 209,343
  chunks (900 chars, stride 750) via node transformers.js MiniLM q8 in
  75 min (testbed/emb/, gitignored). recall_tests.json (gold pages =
  FTS on ANSWER text): 7/10 gold-in-top-8-pages, including every
  historically BM25-unreachable case — hermon@4, masada@5, pears@2,
  jotapata@1, perpetua@1, eighty-six@6, thundering@2. The 3 misses
  (five-ways, two-ways, didache-prayer) are all phrase-lexical
  questions BM25 already wins. COMPLEMENTARY failure sets => hybrid
  merge (embedding top-k as another weighted strategy in retrieve())
  should fix the remaining wrong-answer class.
  Phase-3 implementation plan (next session, needs phone for install):
  1. tools/build_embeddings.mjs: chunk+embed at bundle time (node,
     transformers.js q8 — same runtime as app); PCA 384->128 + int8
     => ~27 MB, ship as page_vectors table in works.db (page-level:
     keep per-chunk vectors -> 80 MB, or top-2 chunks/page -> ~14 MB).
  2. App: vendor transformers.js + MiniLM ONNX (~30 MB) into
     app/vendor; embed QUERY ONLY in the worker (3-10 ms desktop,
     sub-second phone); brute-force dot product over int8 vectors in
     the worker (~200 ms).
  3. retrieve(): add embedding hits as a strategy with weight ~2.5,
     rerun bigsuite + suite2 + recall suites; expect the
     retrieval-precision wrong class (linus, philo-statue, b12, b26)
     to convert to PASS.
  4. Optional efficiency: when the top embedding+BM25 consensus is
     strong, skip model query expansion (saves a whole phone
     generation, ~10-20 s).
- [GEMMA 4 EVALUATION (owner asked) — verdict: STAY ON GEMMA 3n]
  Gemma 4 (April 2026) E4B tested both ways, same pipeline (raw-wrap
  /completion path, temp 0.2, verify v4, bigsuite):
    Gemma 3n E4B Q4_K_M:      31 PASS / 13 MISS / 0 WRONG
    Gemma 4  E4B QAT Q4_K_XL: 27 PASS / 14 MISS / 3 WRONG
  Gemma 4 is not better at grounded cite-and-answer over this corpus,
  and it is WORSE on the no-wrong-answers criterion. On-device it's
  unusable via MediaPipe tasks-genai 0.10.35 (maintenance mode): the
  .litertlm PARSES and loads fine, but generation falls back to an
  unoptimized CPU path — ~6.5 min for a tiny response, 2 runs, not a
  cache artifact. The optimized path is LiteRT-LM (Google's successor
  runtime; also has GPU/OpenCL + proper stop handling). If a future
  model DOES win on quality, migrate LlmPlugin to LiteRT-LM first.
- [PHASE 3 SHIPPED — hybrid semantic retrieval, this session]
  Format chosen by measurement (testbed/vector_formats.py): chunk-level
  int8 384d = ZERO recall loss vs float32 (7/10) at 80 MB; PCA-128
  4/10, PCA-192 6/10, page-mean 4/10 — rejected.
  Pipeline: tools/build_embeddings.mjs (node, transformers.js MiniLM q8
  = the app's own runtime; reuses testbed/emb cache when chunk count
  matches) writes vectors table (int8 blobs) INTO works.db -> content-
  hash version change makes devices auto-reinstall. Run order:
  build_works_db.py -> build_embeddings.mjs -> build_app_bundle.py.
  App: app/vendor/embedder/ (transformers.min.js + ort wasm BOTH plain
  and .asyncify variants + MiniLM onnx+tokenizer, ~58 MB, offline);
  worker.js semanticSearch (lazy embedder, brute-force int8 dots,
  page-dedupe, searchWorks row shape); llm.js retrieve() merges it as
  a strategy (weight 2.5 + scoped bonus +2). Fails open on old DBs.
  Vendoring gotchas: env.allowLocalModels MUST be true (browser default
  false); localModelPath/wasmPaths must be ROOTED PATHS not absolute
  URLs (transformers.js path-join collapses http:// -> http:/); the
  worker requests the .asyncify ort wasm variant.
  RESULTS (gemma3 raw-wrap, temp .2, verify v4):
  bigsuite 33/10/1 with retrieval hit@3 41/44 (was 32/11/1 @ 37/44) —
  pears/perpetua/motion converted; b12 wrong -> decline.
  suite2 15/10/3 @ 27/28 retrieval — better recall FEEDS the
  absent-work negatives (n-calvin answered from a real editor-footnote
  Calvin quote on the wrong topic; n-benedict persists as Cassian
  mislabel). OPEN ITEM (next accuracy lever): absent-work guard —
  detect when the question names a work/author no library title
  matches and force a "library does not contain" framing.
  DECLINE_RE extended with "not specified" (b24-style non-answers now
  count as declines and trigger the probe retry).
  ON-PHONE: works.db 324 MB installs from APK assets; semanticSearch
  1.7 s first call (embedder+vector load), ~113 ms after; pears +
  hermon gold pages at rank 1 on device. sw.js shell-v2 precaches the
  embedder for the PWA route.
- [QUERY ROUTING (owner request) — bible vs library] routeQuestion():
  library author/work match wins; else verse-intent regex or Bible book
  name (66 names + aliases; ambiguous short names gated behind
  "in <book>" / "<book> N:M" / verse intent) -> bible route. Verse
  retrieval = semanticVerses (31k WEB verse vectors, 11.9 MB in
  bible.db, ids2 = chapter*1000+verse) + verses_fts + parseRefs (exact
  "John 3:16(-18)" fetch with neighbor context, weight 5).
  buildVersePrompt numbers verses; verify + whereLines handle verse
  hits; app sources tap verse rows -> navigateTo reader.
  suite_verses.json: 7 PASS / 1 MISS / 0 WRONG; routing correct on all
  8 incl. "Augustine on Romans 7" -> library. Miss: v-shepherd — WEB
  says "Yahweh is my shepherd", question said "the Lord" (open nit:
  divine-name aliasing in verse retrieval).
- [THML PILOT (anf01) + NOTE EXCLUSION] CCEL ThML parsed into plain
  (search/AI) + rich (display) layers; 4,915 editor notes extracted to
  work_notes — NO LONGER in page bodies, so search/AI/embeddings can't
  see them (kills the editor-footnote grounding class for anf01;
  opt-in via search "editor notes" checkbox -> work_notes_fts). 2,652
  notes carry parsed scripture refs -> tappable links to the reader.
  Full re-embed done post-rebuild (208,862 chunks). Owner asked for
  note exclusion explicitly. REGRESSION RUN CAME BACK AS THE BEST
  RESULT EVER: bigsuite 37 PASS / 7 MISS / 0 WRONG @ retrieval 39/44
  (prev best 33/10/1) — the note-free anf01 text improved retrieval
  and excerpts; b12 four-gospels finally passes. Clean sources are an
  accuracy lever in themselves: MORE REASON to roll ThML out to the
  remaining 36 CCEL volumes. Rollout of remaining volumes = download
  .xml, add to THML_WORKS, rebuild db+embeddings+bundle.
- [FULL THML ROLLOUT + LXXEN] All 40 available ThML volumes converted
  (anf10 index vol + catena3/4 stay plain); 137k notes extracted; works
  corpus now 168k chunks (down from 209k — notes gone). English
  Septuagint ingested (lxxen, LXX2012 USFM, 28,324 verses incl. 15
  deuterocanon books); book picker gained OT/NT/Apocrypha groups with
  auto text-switching. App renamed Library 422, NEW appId
  org.library422.study (fresh install; model pushed into new sandbox
  via run-as). Ask setup redesigned (provider cards; optional Claude
  API-key provider — bills separately from claude.ai subscriptions,
  owner may not use it). FINAL REGRESSION (post-rollout corpus, after
  fixing scoring artifacts the new ThML wording exposed — incorruption/
  immortality, apion phrasing, plus eval DECLINE_RE missing the verse-
  route decline phrasing):
    bigsuite 33/11/0 @ retrieval 42/44 (best retrieval ever, ZERO wrong)
    suite2   16/9/3 (residuals: constantine-wording soft answer,
             tertullian trap, benedict absent-work — the known trio)
    verses   8/8, 0 wrong.
  PASS count vs the 37 high-water is single-run variance on a
  re-paginated corpus; the accuracy invariant (no wrong answers on the
  realistic suite) held through the entire rollout.
- [PRONUNCIATION] TtsPlugin (device TTS, el/he voices) + speakBtn on
  word panels; no audio files (85-280 MB rejected); espeak-ng "grc"
  voice documented as classical-pronunciation alternative. UNTESTED on
  device (phone away) — first thing to try on return.
  Kept regardless (already shipped): plugin persists the imported
  model's original filename (model.origname.txt, status().origName);
  llm.js picks the chat template per model generation (Gemma 4 uses
  <|turn>role ... <turn|> — NOT <start_of_turn>) and the runaway-
  generation watchdog watches both marker styles. eval_generation.py
  argv[5] wrap arg (chat|gemma3|gemma4) uses raw /completion with the
  phone-identical wrap — REQUIRED for Gemma 4 GGUFs (their embedded
  tool-calling jinja template renders empty on our llama.cpp) and
  better fidelity for all future evals. Files: models/
  gemma-4-E4B-it.litertlm (phone CPU flavor) + gemma-4-E4B-it-qat-
  UD-Q4_K_XL.gguf (desktop), both gitignored, kept for re-testing
  after a LiteRT-LM migration.

// Main-thread facade over the SQLite worker: promise-based RPC + the app's
// canonical queries. UI code imports this and never touches SQL workers directly.
let worker = null;
let nextId = 1;
const pending = new Map();
let onProgress = () => {};

export function setProgressHandler(fn) { onProgress = fn; }

// The desktop edition (desktop-app/) exposes the same RPC contract through
// its preload bridge, backed by Node's SQLite reading the databases from
// disk — no worker, no download, no browser storage.
const desktop = () => globalThis.desktopDB ?? null;

// on desktop the semantic actions run in the page (semantic-client.js) over
// vector blobs fetched from the backend; everything else is a straight RPC
let semanticClient = null;
async function desktopRpc(action, args) {
  const d = desktop();
  if (action === "semantic" || action === "semanticVerses" || action === "warmEmbedder") {
    if (!semanticClient) {
      const { makeSemantic } = await import("./semantic-client.js");
      semanticClient = makeSemantic((a, g) => d.rpc(a, g));
    }
    if (action === "warmEmbedder") return semanticClient.warm();
    if (action === "semantic") return semanticClient.search(args.question, args.k);
    return semanticClient.verses(args.question, args.k, args.books);
  }
  return d.rpc(action, args);
}

function rpc(action, args) {
  if (desktop()) return desktopRpc(action, args);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, action, args });
  });
}

export const isDesktop = () => !!desktop();

export function start() {
  if (desktop()) return rpc("init", { autoUpdate: false });
  worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  worker.onmessage = (ev) => {
    const m = ev.data;
    if (m.type === "progress") { onProgress(m); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
  };
  // A crashed worker (out of memory during install, failed module load)
  // otherwise leaves every caller waiting forever — fail them all instead.
  const crashed = (why) => {
    const err = new Error("database worker stopped: " + why);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker.onerror = (e) => crashed(e.message || "script error");
  worker.onmessageerror = () => crashed("message could not be decoded");
  // The back/forward cache can keep this page alive after a navigation, and
  // with it the worker's exclusive OPFS access handles — which the next
  // page's worker needs. Give them up when the page is stashed; a page
  // restored from the cache simply starts over.
  window.addEventListener("pagehide", (e) => {
    if (e.persisted && worker) { worker.terminate(); worker = null; crashed("page stashed"); }
  });
  window.addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });
  // the APK carries its data as assets: a new version just installs.
  // The PWA asks first (init reports `updates` = pending downloads).
  const autoUpdate = !!window.Capacitor?.isNativePlatform?.();
  return rpc("init", { autoUpdate });
}

// download + install the pending database updates reported by start()
export const applyUpdates = () => rpc("update");

const exec = (sql, bind) => rpc("exec", { sql, bind });
const execWorks = (sql, bind) => rpc("exec", { sql, bind, db: "works" });

// Data catalog (app/CATALOG.md): status of every item, install on the user's
// request (progress arrives through the progress handler with phases
// download / install / merge / embedder), remove to free space. Each returns
// the refreshed {counts, updates, packs} summary (`packs` = the catalog list).
export const packStatus = () => rpc("packs");
export const installPacks = (names) => rpc("installPacks", { names });
export const installPack = (name) => installPacks([name]);
export const removePack = (name) => rpc("removePack", { name });
// fetch + load the query embedder (~60 MB, kept by the service worker)
export const warmEmbedder = () => rpc("warmEmbedder");

// canonical chapter counts (KJV baseline, in the core) — navigation must not
// depend on which Bible texts the user keeps installed
export const getBookChapters = () =>
  exec("SELECT book_nr, n FROM book_chapters ORDER BY book_nr");
// which books each text contains (every text, installed or not)
export const getTextBooksAll = () =>
  exec("SELECT text_id, book_nr FROM text_books");

// Semantic (embedding) search over the Library — phase 3. Throws when the
// AI search data (vectors.db) isn't installed or the embedder can't load;
// callers fail open to keyword search.
export const semanticSearch = (question, k = 12) =>
  rpc("semantic", { question, k });

// Semantic search over WEB Bible verses, optionally limited to book numbers.
export const semanticVerses = (question, k = 20, books = null) =>
  rpc("semanticVerses", { question, k, books });

// Exact verses (with neighbors) for explicit references in questions.
export const getVersesWeb = (bookNr, chapter, vFrom, vTo) =>
  exec(`SELECT v.book_nr, v.chapter, v.verse, v.body, b.name AS book
        FROM verses v JOIN books b ON b.nr = v.book_nr
        WHERE v.text_id='web' AND v.book_nr=? AND v.chapter=?
          AND v.verse BETWEEN ? AND ? ORDER BY v.verse`,
       [bookNr, chapter, vFrom, vTo]);

// Keyword (FTS) search over WEB verses for the Ask verse route.
export const searchVersesWeb = (match, books = null, limit = 20) =>
  exec(`SELECT v.book_nr, v.chapter, v.verse, v.body, b.name AS book
        FROM verses_fts f
        JOIN verses v ON v.rowid = f.rowid
        JOIN books b ON b.nr = v.book_nr
        WHERE verses_fts MATCH ? AND v.text_id='web'
        ${books?.length ? `AND v.book_nr IN (${books.map(() => "?").join(",")})` : ""}
        ORDER BY rank LIMIT ?`,
       books?.length ? [match, ...books, limit] : [match, limit]);

// ---- library ----
export const getWorks = () =>
  execWorks("SELECT id, slug, category, title, pages FROM works ORDER BY id");

export const getWorkPage = (workId, page) =>
  execWorks("SELECT body, rich FROM work_pages WHERE work_id=? AND page=?",
            [workId, page]);

export const getWorkNote = (workId, n) =>
  execWorks("SELECT body, rich FROM work_notes WHERE work_id=? AND n=?",
            [workId, n]);

// Opt-in editor-note search (notes live outside page bodies by design)
export const searchWorkNotes = (match, limit = 20) =>
  execWorks(`SELECT w.id AS work_id, w.slug, w.title, w.pages, n.page, n.n,
        snippet(work_notes_fts, 0, '‹', '›', '…', 16) AS snip
        FROM work_notes_fts f
        JOIN work_notes n ON n.rowid = f.rowid
        JOIN works w ON w.id = n.work_id
        WHERE work_notes_fts MATCH ? ORDER BY rank LIMIT ?`, [match, limit]);

export const getWorkSections = (workId) =>
  execWorks(`SELECT section, title, page FROM work_sections
             WHERE work_id=? ORDER BY section`, [workId]);

export const countWorks = (match, workIds = null) =>
  execWorks(`SELECT COUNT(*) AS n FROM work_pages_fts
             JOIN work_pages p ON p.rowid = work_pages_fts.rowid
             WHERE work_pages_fts MATCH ?
             ${workIds?.length ? `AND p.work_id IN (${workIds.map(() => "?").join(",")})` : ""}`,
            workIds?.length ? [match, ...workIds] : [match]);

// full-text search across all installed Library works, with citation
// metadata: the containing section = last section heading at or before the hit page
export const searchWorks = (match, limit = 30, workIds = null) =>
  execWorks(`SELECT w.id AS work_id, w.slug, w.title, w.pages, p.page,
        snippet(work_pages_fts, 0, '‹', '›', '…', 18) AS snip,
        (SELECT s.title FROM work_sections s
         WHERE s.work_id = p.work_id AND s.page <= p.page
         ORDER BY s.page DESC, s.section DESC LIMIT 1) AS section
        FROM work_pages_fts
        JOIN work_pages p ON p.rowid = work_pages_fts.rowid
        JOIN works w ON w.id = p.work_id
        WHERE work_pages_fts MATCH ?
        ${workIds?.length ? `AND p.work_id IN (${workIds.map(() => "?").join(",")})` : ""}
        ORDER BY rank LIMIT ?`,
    workIds?.length ? [match, ...workIds, limit] : [match, limit]);

// ---- canonical queries ----------------------------------------------------
export const getBooks = () =>
  exec("SELECT nr, name FROM books ORDER BY nr");

// OSIS-style (ob_code) and STEP codes -> nr, for references in dictionary text
export const getBookCodes = () =>
  exec("SELECT nr, step_code, ob_code FROM books ORDER BY nr");

// Apocrypha/deuterocanon: books beyond the canonical 66, from whichever
// texts carry them, with their maximum chapter counts for the picker.
export const getApocryphaBooks = () =>
  exec(`SELECT tb.book_nr AS nr, tb.book_name AS name, tb.text_id,
               (SELECT MAX(chapter) FROM verses v
                WHERE v.book_nr = tb.book_nr AND v.text_id = tb.text_id) AS chapters
        FROM text_books tb WHERE tb.book_nr > 66
        ORDER BY tb.book_nr`);

export const getTexts = () =>
  exec("SELECT id, lang FROM texts ORDER BY id");

export const getTextBooks = (textId) =>
  exec(`SELECT tb.book_nr AS nr, tb.book_name AS name FROM text_books tb
        WHERE tb.text_id=? ORDER BY tb.book_nr`, [textId]);

export const getChapterCount = (textId, bookNr) =>
  exec(`SELECT MAX(chapter) AS n FROM verses WHERE text_id=? AND book_nr=?`,
       [textId, bookNr]);

export const getChapterCounts = (textId) =>
  exec(`SELECT book_nr, MAX(chapter) AS n FROM verses
        WHERE text_id=? GROUP BY book_nr ORDER BY book_nr`, [textId]);

export const getChapterWords = (bookNr, chapter) =>
  exec(`SELECT verse, pos, surface, translit, gloss, strongs, morph, lemma,
               editions, variant
        FROM words WHERE book_nr=? AND chapter=? ORDER BY verse, pos`,
       [bookNr, chapter]);

// Morphological search: any combination of Strong's code, lemma, and a GLOB
// over the parsing code (e.g. "V-A?M*" = Greek aorist imperatives, "*Vqw*" =
// Hebrew qal wayyiqtol), optionally limited to a book range.
export const searchMorph = ({ strongs = null, lemmaNorm = null, morphGlob = null,
                              bookFrom = 1, bookTo = 66, limit = 300 }) =>
  exec(`SELECT w.book_nr, b.name AS book, w.chapter, w.verse, w.surface,
               w.gloss, w.morph, w.strongs, w.lemma
        FROM words w JOIN books b ON b.nr = w.book_nr
        WHERE w.book_nr BETWEEN ? AND ?
          AND (? IS NULL OR w.strongs = ?)
          AND (? IS NULL OR w.lemma IN (SELECT lemma FROM lexicon WHERE lemma_norm = ?))
          AND (? IS NULL OR w.morph GLOB ?)
        ORDER BY w.book_nr, w.chapter, w.verse, w.pos LIMIT ?`,
       [bookFrom, bookTo, strongs, strongs, lemmaNorm, lemmaNorm,
        morphGlob, morphGlob, limit]);

export const countMorph = ({ strongs = null, lemmaNorm = null, morphGlob = null,
                             bookFrom = 1, bookTo = 66 }) =>
  exec(`SELECT COUNT(*) AS n FROM words w
        WHERE w.book_nr BETWEEN ? AND ?
          AND (? IS NULL OR w.strongs = ?)
          AND (? IS NULL OR w.lemma IN (SELECT lemma FROM lexicon WHERE lemma_norm = ?))
          AND (? IS NULL OR w.morph GLOB ?)`,
       [bookFrom, bookTo, strongs, strongs, lemmaNorm, lemmaNorm,
        morphGlob, morphGlob]);

export const getChapter = (textId, bookNr, chapter) =>
  exec(`SELECT verse, body FROM verses
        WHERE text_id=? AND book_nr=? AND chapter=? ORDER BY verse`,
       [textId, bookNr, chapter]);

export const getVerseParallel = (textIds, bookNr, chapter, verse) =>
  exec(`SELECT text_id, body FROM verses
        WHERE book_nr=? AND chapter=? AND verse=?
          AND text_id IN (${textIds.map(() => "?").join(",")})`,
       [bookNr, chapter, verse, ...textIds]);

export const getWords = (bookNr, chapter, verse) =>
  exec(`SELECT pos, surface, translit, gloss, strongs, morph, lemma
        FROM words WHERE book_nr=? AND chapter=? AND verse=? ORDER BY pos`,
       [bookNr, chapter, verse]);

export const getLexicon = (strongs) =>
  exec("SELECT * FROM lexicon WHERE strongs=?", [strongs]);

export const getOccurrenceCount = (strongs) =>
  exec("SELECT COUNT(*) AS n FROM words WHERE strongs=?", [strongs]);

export const getConcordance = (strongs, limit = 200, offset = 0) =>
  exec(`SELECT w.book_nr, b.name AS book, w.chapter, w.verse, w.surface, w.gloss
        FROM words w JOIN books b ON b.nr = w.book_nr
        WHERE w.strongs=? ORDER BY w.book_nr, w.chapter, w.verse, w.pos
        LIMIT ? OFFSET ?`,
       [strongs, limit, offset]);

// OT quotations / allusions: for an NT verse, its best-voted links INTO the
// OT; for an OT verse, the NT verses that link TO it (reverse index).
export const getOtLinks = (bookNr, chapter, verse, limit = 8) =>
  exec(`SELECT c.to_book AS book_nr, b.name AS book, c.to_chapter AS chapter,
               c.to_verse AS verse, c.votes
        FROM crossrefs c JOIN books b ON b.nr = c.to_book
        WHERE c.from_book=? AND c.from_chapter=? AND c.from_verse=?
          AND c.to_book BETWEEN 1 AND 39 AND c.votes > 0
        ORDER BY c.votes DESC LIMIT ?`, [bookNr, chapter, verse, limit]);

export const getNtLinks = (bookNr, chapter, verse, limit = 12) =>
  exec(`SELECT c.from_book AS book_nr, b.name AS book, c.from_chapter AS chapter,
               c.from_verse AS verse, c.votes
        FROM crossrefs c JOIN books b ON b.nr = c.from_book
        WHERE c.to_book=? AND c.to_chapter=? AND c.to_verse=?
          AND c.from_book BETWEEN 40 AND 66 AND c.votes > 0
        ORDER BY c.votes DESC LIMIT ?`, [bookNr, chapter, verse, limit]);

export const getCrossrefs = (bookNr, chapter, verse, limit = 20) =>
  exec(`SELECT to_ref, to_book, to_chapter, to_verse, votes FROM crossrefs
        WHERE from_book=? AND from_chapter=? AND from_verse=?
        ORDER BY votes DESC LIMIT ?`,
       [bookNr, chapter, verse, limit]);

// verses_fts indexes the marker-stripped text (see build_db.py), so the
// snippet is already clean and "fi"/"fr"/"fo" are not searchable tokens.
export const searchText = (match, textId = null, limit = 60) =>
  exec(`SELECT v.text_id, v.book_nr, b.name AS book, v.chapter, v.verse,
               snippet(verses_fts, 0, '‹', '›', '…', 16) AS snip
        FROM verses_fts JOIN verses v ON v.rowid = verses_fts.rowid
        JOIN books b ON b.nr = v.book_nr
        WHERE verses_fts MATCH ?
          AND (? IS NULL OR v.text_id = ?)
        ORDER BY rank LIMIT ?`,
       [match, textId, textId, limit]);

// English dictionary (Webster's 1913): exact match, then simple de-inflection
export const getEnglishDef = async (word) => {
  const tries = [word];
  if (word.endsWith("ies")) tries.push(word.slice(0, -3) + "y");
  if (word.endsWith("es")) tries.push(word.slice(0, -2));
  if (word.endsWith("s")) tries.push(word.slice(0, -1));
  if (word.endsWith("ed")) tries.push(word.slice(0, -2), word.slice(0, -1));
  if (word.endsWith("ing")) tries.push(word.slice(0, -3), word.slice(0, -3) + "e");
  if (word.endsWith("eth")) tries.push(word.slice(0, -3));  // KJV: "shineth"
  for (const t of tries) {
    const rows = await exec(
      "SELECT word, definition FROM dictionary WHERE word = ?", [t]);
    if (rows.length) return rows[0];
  }
  return null;
};

// identify an untagged Greek/Hebrew written form via the tagged corpus
export const lookupSurface = (norm, limit = 6) =>
  exec(`SELECT w.strongs, COUNT(*) AS n, l.lemma, l.translit,
               l.definition, l.kjv_usage
        FROM words w LEFT JOIN lexicon l ON l.strongs = w.strongs
        WHERE w.surface_norm = ? AND w.strongs IS NOT NULL
        GROUP BY w.strongs ORDER BY n DESC LIMIT ?`, [norm, limit]);

// which original-language words does this English word translate?
export const reverseGloss = (word, limit = 15) =>
  exec(`SELECT w.strongs, COUNT(*) AS n, l.lemma, l.translit, l.definition
        FROM words w LEFT JOIN lexicon l ON l.strongs = w.strongs
        WHERE w.gloss LIKE '%' || ? || '%' AND w.strongs IS NOT NULL
        GROUP BY w.strongs ORDER BY n DESC, w.strongs LIMIT ?`,
       [word, limit]);

// query must already be normalized (lowercase, accents/points stripped)
export const searchLexicon = (norm, limit = 30) =>
  exec(`SELECT strongs, lang, lemma, translit, definition, kjv_usage
        FROM lexicon
        WHERE lemma_norm LIKE ? || '%' OR translit_norm LIKE ? || '%'
        ORDER BY lang, strongs LIMIT ?`,
       [norm, norm, limit]);

// ---- Phase A data layers (ROADMAP.md) --------------------------------------
// Each block below is owned by the ingest module of the same name in tools/.

// [lexicons_extra] full lexicon entries (BDB / Abbott-Smith / LSJ)
// entry text carries ⟦I⟧..⟦/I⟧ and ⟦R|b.c.v⟧..⟦/R⟧ markers — render with
// renderRichBody. Sources ordered bdb, abbott-smith, lsj.
const LEXFULL_ORDER =
  "CASE source WHEN 'bdb' THEN 0 WHEN 'abbott-smith' THEN 1 ELSE 2 END";

export const getFullLexicon = (strongs) =>
  exec(`SELECT source, strongs, lemma, entry, entry_len FROM lexicon_full
        WHERE strongs=? ORDER BY ${LEXFULL_ORDER}, lemma, entry_len DESC`,
       [strongs]);

// lemmaNorm must already be normalized (casefolded, accents/points stripped,
// final sigma folded to σ)
export const searchFullLexicon = (lemmaNorm, limit = 5) =>
  exec(`SELECT source, strongs, lemma, entry, entry_len FROM lexicon_full
        WHERE lemma_norm=? ORDER BY ${LEXFULL_ORDER}, strongs, lemma LIMIT ?`,
       [lemmaNorm, limit]);

// STEPBible H9001-H9049 affix / pronoun-suffix / punctuation codes
export const getAffix = (strongs) =>
  exec("SELECT * FROM lexicon_affix WHERE strongs=?", [strongs]);

// [web_words_extra] WEB reverse interlinear
// verse_words: one row per whitespace token of a WEB verse body. `pos` indexes
// into  body.replace(/<[^<>\s]{1,8}>/g, "").trim().split(/\s+/)  — i.e. the
// same tokens renderBody() makes tappable — and `word` is that exact token
// (punctuation attached). `strongs` is the primary code (G0001/H0001 form,
// joins lexicon.strongs / words.strongs), NULL for untagged tokens;
// `strongs_all` keeps every code the token carried, space-joined.
export const getVerseWords = (textId, bookNr, chapter, verse) =>
  exec(`SELECT pos, word, strongs, strongs_all
        FROM verse_words
        WHERE text_id=? AND book_nr=? AND chapter=? AND verse=?
        ORDER BY pos`, [textId, bookNr, chapter, verse]);

// Single token -> its Strong's code(s) plus the lexicon entry, or null.
export const getStrongsForWord = async (textId, bookNr, chapter, verse, pos) => {
  const rows = await exec(
    `SELECT v.word, v.strongs, v.strongs_all, l.lang, l.lemma, l.translit,
            l.definition, l.kjv_usage
     FROM verse_words v LEFT JOIN lexicon l ON l.strongs = v.strongs
     WHERE v.text_id=? AND v.book_nr=? AND v.chapter=? AND v.verse=? AND v.pos=?`,
    [textId, bookNr, chapter, verse, pos]);
  return rows[0] ?? null;
};

// Which English renderings does this Strong's number get in the WEB?
// (English-side concordance; complements getConcordance on the original side.)
export const getRenderings = (strongs, textId = "web", limit = 30) =>
  exec(`SELECT word, COUNT(*) AS n FROM verse_words
        WHERE strongs=? AND text_id=?
        GROUP BY word ORDER BY n DESC, word LIMIT ?`, [strongs, textId, limit]);

// [graph_extra] people / places / events (Theographic) + proper nouns (TIPNR)
// Everyone and everything a verse touches (deduplicated by kind+id), with the
// display name and a one-line description pulled from the right table.
export const getEntitiesForVerse = (bookNr, chapter, verse) =>
  exec(`SELECT DISTINCT ev.entity_kind AS kind, ev.entity_id AS id,
               COALESCE(p.name, pl.name, e.title, o.name) AS name,
               COALESCE(p.description, pl.description, e.period, o.description) AS description
        FROM entity_verses ev
        LEFT JOIN people p  ON ev.entity_kind='person' AND p.id  = ev.entity_id
        LEFT JOIN places pl ON ev.entity_kind='place'  AND pl.id = ev.entity_id
        LEFT JOIN events e  ON ev.entity_kind='event'  AND e.id  = ev.entity_id
        LEFT JOIN entity_other o ON ev.entity_kind='other' AND o.id = ev.entity_id
        WHERE ev.book_nr=? AND ev.chapter=? AND ev.verse=?
        ORDER BY CASE ev.entity_kind WHEN 'person' THEN 0 WHEN 'place' THEN 1
                                     WHEN 'event' THEN 2 ELSE 3 END, name`,
       [bookNr, chapter, verse]);

export const getPerson = (id) => exec("SELECT * FROM people WHERE id=?", [id]);
export const getPlace = (id) => exec("SELECT * FROM places WHERE id=?", [id]);
export const getEvent = (id) => exec("SELECT * FROM events WHERE id=?", [id]);
export const getOther = (id) => exec("SELECT * FROM entity_other WHERE id=?", [id]);

export const getEntityVerses = (kind, id, limit = 40) =>
  exec(`SELECT ev.book_nr, b.name AS book, ev.chapter, ev.verse
        FROM entity_verses ev JOIN books b ON b.nr = ev.book_nr
        WHERE ev.entity_kind=? AND ev.entity_id=?
        ORDER BY ev.book_nr, ev.chapter, ev.verse LIMIT ?`, [kind, id, limit]);

export const getEntityNames = (kind, id) =>
  exec(`SELECT DISTINCT name, strongs FROM entity_names
        WHERE entity_kind=? AND entity_id=? ORDER BY name`, [kind, id]);

export const getPersonRelations = (id) =>
  exec(`SELECT r.relation, r.related_id AS id,
               COALESCE(p.name, o.name, r.related_id) AS name
        FROM person_relations r
        LEFT JOIN people p ON p.id = r.related_id
        LEFT JOIN entity_other o ON o.id = r.related_id
        WHERE r.person_id=?
        ORDER BY CASE r.relation WHEN 'father' THEN 0 WHEN 'mother' THEN 1
                 WHEN 'spouse' THEN 2 WHEN 'child' THEN 3 ELSE 4 END, name`, [id]);

export const getEventLinks = (eventId) =>
  exec(`SELECT l.entity_kind AS kind, l.entity_id AS id,
               COALESCE(p.name, pl.name, o.name) AS name
        FROM event_links l
        LEFT JOIN people p  ON l.entity_kind='person' AND p.id  = l.entity_id
        LEFT JOIN places pl ON l.entity_kind='place'  AND pl.id = l.entity_id
        LEFT JOIN entity_other o ON l.entity_kind='other' AND o.id = l.entity_id
        WHERE l.event_id=? ORDER BY l.entity_kind, name`, [eventId]);

export const getEntityEvents = (kind, id) =>
  exec(`SELECT e.id, e.title, e.start_year, e.end_year, e.sort_key
        FROM event_links l JOIN events e ON e.id = l.event_id
        WHERE l.entity_kind=? AND l.entity_id=? ORDER BY e.sort_key`, [kind, id]);

// name lookup (nameNorm = lowercased, accents stripped); groups by entity
export const findEntitiesByName = (nameNorm, limit = 12) =>
  exec(`SELECT DISTINCT n.entity_kind AS kind, n.entity_id AS id,
               COALESCE(p.name, pl.name, o.name) AS name,
               COALESCE(p.description, pl.description, o.description) AS description,
               COALESCE(p.verse_count, pl.verse_count, o.verse_count) AS verse_count
        FROM entity_names n
        LEFT JOIN people p  ON n.entity_kind='person' AND p.id  = n.entity_id
        LEFT JOIN places pl ON n.entity_kind='place'  AND pl.id = n.entity_id
        LEFT JOIN entity_other o ON n.entity_kind='other' AND o.id = n.entity_id
        WHERE n.name_norm=? AND n.entity_kind IN ('person','place','other')
        ORDER BY verse_count DESC LIMIT ?`, [nameNorm, limit]);

export const findEntitiesByStrongs = (strongs, limit = 12) =>
  exec(`SELECT DISTINCT n.entity_kind AS kind, n.entity_id AS id,
               COALESCE(p.name, pl.name, o.name) AS name,
               COALESCE(p.description, pl.description, o.description) AS description,
               COALESCE(p.verse_count, pl.verse_count, o.verse_count) AS verse_count
        FROM entity_names n
        LEFT JOIN people p  ON n.entity_kind='person' AND p.id  = n.entity_id
        LEFT JOIN places pl ON n.entity_kind='place'  AND pl.id = n.entity_id
        LEFT JOIN entity_other o ON n.entity_kind='other' AND o.id = n.entity_id
        WHERE n.strongs=? AND n.entity_kind IN ('person','place','other')
        ORDER BY verse_count DESC LIMIT ?`, [strongs, limit]);

export const getPlacesWithCoords = () =>
  exec(`SELECT id, name, kind, lat, lon, verse_count FROM places
        WHERE lat IS NOT NULL AND lon IS NOT NULL AND duplicate_of IS NULL
        ORDER BY verse_count DESC`);

export const getEventsTimeline = () =>
  exec(`SELECT id, title, start_year, end_year, period, sort_key FROM events
        ORDER BY sort_key`);

export const getEaston = (termNorm) =>
  exec(`SELECT term, item_num, body, person_id, place_id FROM easton
        WHERE term_norm=? ORDER BY item_num`, [termNorm]);

// [work_refs] scripture references in the Library -> "the Fathers on this verse"
// Works citing a verse, most-cited first; per work the pages that cite it.
export const getWorkRefs = (bookNr, chapter, verse, limit = 60) =>
  execWorks(`SELECT r.work_id, w.title, w.category, w.pages, r.page, r.note,
                    (SELECT s.title FROM work_sections s
                     WHERE s.work_id = r.work_id AND s.page <= r.page
                     ORDER BY s.page DESC, s.section DESC LIMIT 1) AS section
             FROM work_refs r JOIN works w ON w.id = r.work_id
             WHERE r.book_nr=? AND r.chapter=? AND r.verse=?
             ORDER BY w.id, r.page, r.note LIMIT ?`,
            [bookNr, chapter, verse, limit]);

export const countWorkRefs = (bookNr, chapter, verse) =>
  execWorks(`SELECT COUNT(*) AS n, COUNT(DISTINCT work_id) AS works
             FROM work_refs WHERE book_nr=? AND chapter=? AND verse=?`,
            [bookNr, chapter, verse]);

// corpus frequency of Strong's codes (reader's-edition mode: gloss only the
// rare words) — one indexed COUNT per code, batched per chapter
export const getStrongsCounts = (codes) =>
  exec(`SELECT strongs, COUNT(*) AS n FROM words
        WHERE strongs IN (${codes.map(() => "?").join(",")}) GROUP BY strongs`,
       codes);

// [morph_extra] plain-English morphology (STEPBible TEGMC/TEHMC)
export const getMorphCodes = (lang, codes) =>
  exec(`SELECT code, summary, explanation, example FROM morph_codes
        WHERE lang=? AND code IN (${codes.map(() => "?").join(",")})`,
       [lang, ...codes]);

// [versification_extra] verse mapping per text (STEPBible TVTMS, evidence-based)
// No row = identity. verse 0 = Psalm title (a verse in Hebrew/Greek/Latin
// numbering only); t_chapter = t_verse = 0 with part 'absent' = no such verse.
// text_traditions.tradition is the numbering column the text mostly follows.
export const getTextTraditions = () =>
  exec("SELECT text_id, tradition FROM text_traditions");

// every mapped verse of a canonical chapter in one text
export const getChapterMap = (textId, bookNr, chapter) =>
  exec(`SELECT verse, t_book_nr, t_chapter, t_verse, part FROM verse_map
        WHERE text_id=? AND book_nr=? AND chapter=? ORDER BY verse`,
       [textId, bookNr, chapter]);

export const mapVerse = (textId, bookNr, chapter, verse) =>
  exec(`SELECT t_book_nr, t_chapter, t_verse, part FROM verse_map
        WHERE text_id=? AND book_nr=? AND chapter=? AND verse=?`,
       [textId, bookNr, chapter, verse]);

// which texts have any mapping at all (the reader skips the rest)
export const getMappedTexts = () =>
  exec("SELECT DISTINCT text_id FROM verse_map");

// verses by explicit (book, chapter, verse) keys of one text, any chapters
export const getVersesByKeys = (textId, keys) =>
  exec(`SELECT book_nr, chapter, verse, body FROM verses
        WHERE text_id=? AND (${keys.map(() => "(book_nr=? AND chapter=? AND verse=?)").join(" OR ")})`,
       [textId, ...keys.flatMap((k) => [k[0], k[1], k[2]])]);

// [readaloud] chapter read-aloud helpers

// On-device LLM bridge + grounded "ask the Library" flow. Android-only:
// everything no-ops gracefully when the Capacitor plugin isn't present.
import * as DB from "./db.js";

const plugin = () => window.Capacitor?.Plugins?.Llm ?? null;
// The Ask tab is always available now: local Gemma (Android plugin) OR the
// user's own Anthropic API key ("claude" provider) — the setup page guides.
export const available = () => true;
export const localAvailable = () => !!plugin();
export const claudeReady = () =>
  aiSettings.provider === "claude" && !!aiSettings.claudeKey;

export const status = () => plugin().status();
export const importModel = () => plugin().importModel();
export const removeModel = () => plugin().removeModel();

// User-tunable AI settings (Ask tab -> AI settings sheet).
// ctx "auto" = probe the cascade below; a number = load exactly that.
// temp 0.2 default: measured (testbed/RESULTS.md) — low temperature answers
// strictly beat 0.6 on factual accuracy (34 vs 32 PASS, fewer declines).
// provider: "local" (on-device Gemma) | "claude" (user's own Anthropic API
// key — stored ONLY in this device's localStorage; retrieval stays local,
// only the question + retrieved passages are sent to the API)
const savedAi = (() => {
  try {
    const v = JSON.parse(localStorage.getItem("atb-ai") ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    try { localStorage.removeItem("atb-ai"); } catch { /* ignore */ }
    return {};
  }
})();
export const aiSettings = Object.assign(
  { ctx: "auto", temp: 0.2, provider: "local",
    claudeKey: "", claudeModel: "claude-sonnet-5" },
  savedAi);
// the older date-suffixed Haiku id is no longer offered
if (aiSettings.claudeModel === "claude-haiku-4-5-20251001")
  aiSettings.claudeModel = "claude-haiku-4-5";
export const saveAiSettings = () =>
  localStorage.setItem("atb-ai", JSON.stringify(aiSettings));

// models ship with fixed context sizes; worse, loading can ACCEPT an
// oversized maxTokens and only fail at generation ("prefill" error). So:
// load optimistically, then learn the real budget from failures.
export let contextTokens = 0;
export async function loadModel(maxTokens) {
  maxTokens ??= aiSettings.ctx === "auto" ? null : Number(aiSettings.ctx);
  if (maxTokens) {
    await plugin().loadModel({ maxTokens });
    contextTokens = maxTokens;
    return maxTokens;
  }
  for (const max of [4096, 2048, 1280]) {
    try {
      await plugin().loadModel({ maxTokens: max });
      contextTokens = max;
      return max;
    } catch (e) {
      if (max === 1280) throw e;
    }
    // an oversized load can 'succeed' then die at prefill — answer() handles
    // that by halving and reloading, so optimism is safe here
  }
}

const countTokens = async (text) => {
  try {
    return (await plugin().countTokens({ text })).tokens;
  } catch {
    return Math.ceil(text.length / 4);  // rough fallback
  }
};
export const onImportProgress = (cb) =>
  plugin().addListener("importProgress", cb);

// Anthropic Messages API — direct from the app with the user's key.
// Official CORS support via the dangerous-direct-browser-access header.
// No sampling parameters: current models (Sonnet 5, Opus 5) reject
// `temperature` with HTTP 400, and grounded retrieval doesn't need it.
export async function generateClaude(prompt, onToken, _temp) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": aiSettings.claudeKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: aiSettings.claudeModel,
      max_tokens: 700,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message ?? `Claude API error ${res.status}`);
  }
  const data = await res.json();
  const text = (data.content ?? []).map((b) => b.text ?? "").join("");
  onToken(text, true);
  return { done: true };
}

export async function generate(prompt, onToken, temp) {
  if (claudeReady()) return generateClaude(prompt, onToken, temp);
  const p = plugin();
  let acc = "";
  let stopped = false;
  const sub = p.addListener("token", (ev) => {
    acc += ev.text ?? "";
    // the engine doesn't stop at the turn marker — cancel it ourselves
    // (watch both Gemma-generation marker styles)
    if (!stopped && (acc.includes("<end_of_turn>") ||
                     acc.includes("<turn|>") || acc.includes("<|turn>"))) {
      stopped = true;
      try { p.stop?.()?.catch?.(() => {}); } catch { /* best effort */ }
    }
    onToken(ev.text ?? "", !!ev.done);
  });
  try {
    return await p.generate({ prompt, temperature: temp ?? aiSettings.temp });
  } finally {
    // ALWAYS detach — a rejected call (busy, prefill overflow) never sends
    // `done`, and a leaked listener would feed the next answer's tokens
    // into this closure too
    try { (await sub)?.remove?.(); } catch { /* already gone */ }
  }
}

export const isBusyError = (e) => /busy/i.test(String(e?.message ?? e));

// polite retries when the engine is briefly busy (previous cancel settling)
async function generateRetry(prompt, onToken, temp, busyRetries = 2) {
  for (let i = 0; ; i++) {
    try {
      return await generate(prompt, onToken, temp);
    } catch (e) {
      if (!isBusyError(e) || i >= busyRetries) throw e;
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
}

// ---------------------------------------------------------------- retrieval
const STOP = new Set(("a an and are as at be but by does did do for from has have he her his i in is it its of on or " +
  "she that the their there they this to was were what when where which who whom why will with you your about any").split(" "));

export const keywords = (q) =>
  q.toLowerCase().replace(/[^\p{L}\p{N}\s'-]/gu, " ")
   .split(/\s+/)
   .filter((w) => w.length > 2 && !STOP.has(w));

// Irregular forms porter stemming can't connect.
const IRREGULARS = {
  swear: ["sworn", "swore"], speak: ["spoke", "spoken"],
  slay: ["slew", "slain"], die: ["died", "dying"], rise: ["rose", "risen"],
};

// Adjacent keyword pairs from the question, quoted as FTS phrases — "five
// ways" or "two ways" identify a passage far better than the words apart.
export function phrases(question, exclude = new Set()) {
  const words = question.toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ").replace(/'s\b/g, "")
    .split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = 0; i + 1 < words.length; i++) {
    const a = words[i], b = words[i + 1];
    if (a.length > 2 && b.length > 2 && !STOP.has(a) && !STOP.has(b) &&
        !exclude.has(a) && !exclude.has(b)) {
      out.push(`${a} ${b}`);
    }
  }
  return out;
}

// Historical texts often use different names than askers do.
const ALIASES = {
  didache: '"teaching of the twelve"',
  ecclesiasticus: '"sirach"',
  septuagint: '"seventy"',
};

// Title words too generic to identify a work (don't scope on these).
const GENERIC = new Set(("the of and fathers father church history writings works life first second " +
  "third century centuries part vol volume gospel epistle epistles book new post index general " +
  "nicene ante against christian commentary chapters with other st saint " +
  // title words that are also ordinary Bible-question vocabulary: scoping on
  // them sent "the great flood" to papal letters and "Psalms" to Augustine
  "great letters select selected historical treatises principal moral " +
  "trinity latin fourth twelve founder apostles psalms matthew galatians " +
  "ephesians peter patriarchs").split(" "));

// Questions may name a work by a title our editions don't use.
const SCOPE_ALIASES = { didache: ["anf07"] };

// Authors/works mentioned in the question -> restrict retrieval to them.
// Whole-word matching only (else 'martyrdom' would match title-word 'martyr').
let worksCache = null;
export async function scopeWorks(question) {
  worksCache ??= await DB.getWorks();
  const qwords = new Set(question.toLowerCase()
    .split(/[^a-zæœ']+/)
    .map((w) => w.replace(/'s$/, "").replace(/'/g, "")));
  const scoped = [];
  const matched = new Set();
  for (const w of worksCache) {
    const tokens = (w.title + " " + w.category).toLowerCase()
      .split(/[^a-zæœ]+/).filter((t) => t.length >= 5 && !GENERIC.has(t));
    let found = tokens.find((tok) => qwords.has(tok));
    if (!found) {
      for (const [alias, slugs] of Object.entries(SCOPE_ALIASES)) {
        if (qwords.has(alias) && slugs.some((s) => w.slug.includes(s))) {
          found = alias;
          break;
        }
      }
    }
    if (found) {
      scoped.push(w.id);
      matched.add(found);
    }
  }
  // scoping to most of the library is no scoping at all
  if (scoped.length > worksCache.length / 2) return { ids: null, matched: new Set() };
  return { ids: scoped.length ? scoped : null, matched };
}

// ------------------------------------------------------------ query routing
// "Good verses about X" should search the BIBLE, not Josephus; "what does
// Romans say" should search Romans. A named Library author/work always wins
// (so "What does Augustine say about Romans 7" stays on the Library route).
const VERSE_INTENT =
  /\bverses?\b|\bscriptures?\b|\bbible\b|what does (the )?scripture say/i;
// Book names that are also common words/names: require "in <book>",
// "<book> 3:16"-style, or explicit verse intent before routing on them.
const AMBIGUOUS_BOOKS = new Set(["job", "acts", "mark", "john", "james",
  "jude", "numbers", "judges", "kings", "ruth", "esther", "titus",
  "philemon", "joel", "amos", "micah", "nahum", "haggai", "luke",
  "matthew", "daniel", "jonah", "revelation", "apocalypse",
  "romans", "hebrews"]);   // peoples as often as epistles
const BOOK_ALIASES = {
  psalms: ["psalm"], "song of solomon": ["song of songs", "canticles"],
  ecclesiastes: ["qoheleth"], revelation: ["apocalypse"],
};
let bibleBooksCache = null;

export async function routeQuestion(question) {
  const { matched } = await scopeWorks(question);
  if (matched.size) return { kind: "library" };
  bibleBooksCache ??= await DB.getBooks();
  const q = " " + question.toLowerCase().replace(/[^a-z0-9\s:]/g, " ")
    .replace(/\s+/g, " ") + " ";
  const hasIntent = VERSE_INTENT.test(question);
  const books = [];
  for (const b of bibleBooksCache) {
    const name = b.name.toLowerCase();
    for (const nm of [name, ...(BOOK_ALIASES[name] ?? [])]) {
      if (!q.includes(` ${nm} `) && !q.includes(` ${nm}:`)) continue;
      if (AMBIGUOUS_BOOKS.has(nm) && !hasIntent &&
          !new RegExp(`\\b(in|from|of|to the) ${nm}\\b|\\b${nm} \\d`).test(q))
        continue;
      books.push(b.nr);
      break;
    }
  }
  if (books.length || hasIntent)
    return { kind: "bible", books: books.length ? books : null };
  return { kind: "library" };
}

const cleanVerse = (body) =>
  body.replace(/<[^<>\s]{1,8}>/g, "").replace(/\s+/g, " ").trim();

// Explicit references in the question ("John 3:16", "Romans 8:28-30")
// are fetched directly with heavy weight — search shouldn't have to
// rediscover a verse the user already named.
async function parseRefs(question) {
  bibleBooksCache ??= await DB.getBooks();
  const q = question.toLowerCase();
  const refs = [];
  for (const b of bibleBooksCache) {
    const names = [b.name.toLowerCase(), ...(BOOK_ALIASES[b.name.toLowerCase()] ?? [])];
    for (const nm of names) {
      const re = new RegExp(
        `\\b${nm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(\\d+):(\\d+)(?:\\s*-\\s*(\\d+))?`, "g");
      for (const m of q.matchAll(re)) {
        refs.push({ book_nr: b.nr, chapter: +m[1],
                    vFrom: +m[2], vTo: +(m[3] ?? m[2]) });
      }
    }
  }
  return refs;
}

// Hybrid verse retrieval: semantic (question + expansions) + keyword FTS,
// merged with the same weighted-strategy scheme as the Library route.
export async function retrieveVerses(question, expText = "",
                                     bookNrs = null, want = 24) {
  const cand = new Map();   // "b:c:v" -> {row, score}
  const add = (rows, weight) => rows.forEach((r, i) => {
    const key = `${r.book_nr}:${r.chapter}:${r.verse}`;
    const e = cand.get(key) ?? { row: r, score: 0 };
    e.score += weight + (rows.length - i) / rows.length;
    cand.set(key, e);
  });
  // explicitly-named references first, with one verse of context each side
  try {
    for (const r of await parseRefs(question)) {
      add(await DB.getVersesWeb(r.book_nr, r.chapter,
                                Math.max(1, r.vFrom - 1), r.vTo + 1), 5);
    }
  } catch {}
  try { add(await DB.semanticVerses(question, 30, bookNrs), 2.5); } catch {}
  for (const line of (expText ?? "").split("\n")) {
    const clean = line.trim();
    if (clean.length < 4 || clean.length > 80) continue;
    try { add(await DB.semanticVerses(clean, 10, bookNrs), 1.2); } catch {}
  }
  const terms = keywords(question);
  if (terms.length) {
    const quote = (t) => `"${t.replace(/"/g, "")}"`;
    try {
      add(await DB.searchVersesWeb(terms.map(quote).join(" AND "),
                                   bookNrs, 20), 2);
    } catch {}
    try {
      add(await DB.searchVersesWeb(terms.map(quote).join(" OR "),
                                   bookNrs, 20), 1);
    } catch {}
  }
  return [...cand.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, want)
    .map((e) => ({ kind: "verse", ...e.row }));
}

export function buildVersePrompt(question, hits) {
  const parts = [
    "You are a helpful Bible study assistant.",
    "Below are numbered Bible verses (World English Bible).",
    "Answer the question using ONLY these verses. Quote the most relevant verses, each with its reference.",
    "Cite verse numbers like [1]. If none of these verses fit the question, say so plainly.",
    "",
  ];
  hits.forEach((h, i) => parts.push(
    `[${i + 1}] ${h.book} ${h.chapter}:${h.verse}: ${cleanVerse(h.body)}`));
  parts.push("", `Question: ${question}`, "Answer:");
  return parts.join("\n");
}

// Progressive retrieval: author-scoped AND -> scoped OR -> global AND -> OR.
export async function retrieve(question, want = 4) {
  let terms = keywords(question);
  if (!terms.length) return [];
  const { ids, matched } = await scopeWorks(question);
  // author name won't appear in their own text — drop matched scope tokens
  const bodyTerms = terms.filter((t) => !matched.has(t));
  if (bodyTerms.length) terms = bodyTerms;
  const quote = (t) => {   // ligature expansion + irregulars + aliases
    const forms = new Set([t,
      t.replace(/ae/gi, "æ"), t.replace(/oe/gi, "œ"),
      t.replace(/æ/gi, "ae"), t.replace(/œ/gi, "oe"),
      ...(IRREGULARS[t] ?? [])]);
    const quoted = [...forms].map((f) => `"${f.replace(/"/g, "")}"`);
    if (ALIASES[t]) quoted.push(ALIASES[t]);
    return quoted.length > 1 ? `(${quoted.join(" OR ")})` : quoted[0];
  };
  const andQ = terms.map(quote).join(" AND ");
  const orQ = terms.map(quote).join(" OR ");
  const rawPhrases = phrases(question, matched);

  const strategies = [];
  for (const scope of ids ? [ids, null] : [null]) {
    const bonus = scope ? 2 : 0;
    // Phrases: only the SELECTIVE ones — judged within the scope, since a
    // corpus-common phrase can still be rare inside one work.
    const phraseList = [];
    for (const p of rawPhrases) {
      try {
        const [{ n }] = await DB.countWorks(`"${p}"`, scope);
        if (n > 0 && n <= 250) phraseList.push(`"${p}"`);
      } catch { /* skip malformed */ }
    }
    if (phraseList.length) {
      strategies.push([phraseList.join(" OR "), scope, 3 + bonus]);
    }
    strategies.push([andQ, scope, 2 + bonus]);
    strategies.push([orQ, scope, 1 + bonus]);
  }
  const cand = new Map();   // key -> {row, score}
  for (const [match, scope, weight] of strategies) {
    let rows = [];
    try {
      rows = await DB.searchWorks(match, want * 3, scope);
    } catch { /* malformed query -> skip */ }
    rows.forEach((r, i) => {
      // back-of-volume index pages are dense with names but carry no prose
      const refMarks = (r.snip?.match(/\[\d+\]/g) ?? []).length;
      if (refMarks >= 4) return;
      const key = `${r.work_id}:${r.page}`;
      const posBonus = (rows.length - i) / rows.length;   // bm25 order matters
      const entry = cand.get(key) ?? { row: r, score: 0 };
      entry.score += weight + posBonus;
      cand.set(key, entry);
    });
  }
  // Phase 3 — semantic (embedding) strategy: bridges the class where the
  // answer's words are absent from the question (Hermon, Eleazar, pears...).
  // Weight sits between phrase (3) and AND (2); author-scoped hits get the
  // same +2 the lexical strategies get. Fails open: an older works.db
  // without vectors, or an embedder failure, just means lexical-only.
  try {
    const sem = await DB.semanticSearch(question, want * 3);
    sem.forEach((r, i) => {
      const key = `${r.work_id}:${r.page}`;
      const posBonus = (sem.length - i) / sem.length;
      const bonus = ids?.includes(r.work_id) ? 2 : 0;
      const entry = cand.get(key) ?? { row: r, score: 0 };
      entry.score += 2.5 + bonus + posBonus;
      cand.set(key, entry);
    });
  } catch { /* semantic unavailable */ }
  const hits = [...cand.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, want)
    .map((e) => e.row);
  return hits;
}

// Model-assisted query expansion: the asker's vocabulary often differs from
// the text's ("final speech at Masada" vs "Eleazar ben Jair"). The model
// proposes alternate search phrasings; answers still come ONLY from passages.
export const expansionPrompt = (question) =>
  "You help search a library of ancient Jewish and Christian texts " +
  "(Josephus, Philo, Church Fathers, Aquinas, Enoch). Give 2 alternative " +
  "search phrases (3-6 words each) that would locate the passage answering " +
  "this question — use names and words the ancient text itself would use. " +
  "Output ONLY the two phrases, one per line, no numbering.\n" +
  `Question: ${question}`;

export async function retrieveExpanded(question, expansionsText, want = 6) {
  const base = await retrieve(question, want);
  const extra = [];
  for (const line of (expansionsText ?? "").split("\n")) {
    const clean = sanitize(line).trim();
    if (clean.length < 4 || clean.length > 80) continue;
    const rows = await retrieve(clean + " " + question.split(" ").slice(0, 4).join(" "), 3);
    extra.push(...rows.slice(0, 2));
  }
  // merge: base first, then novel expansion hits, then next-page follow-ons
  const seen = new Set(base.map((h) => `${h.work_id}:${h.page}`));
  for (const e of extra) {
    const key = `${e.work_id}:${e.page}`;
    if (!seen.has(key) && base.length < want + 2) {
      seen.add(key);
      base.push(e);
    }
  }
  for (const top of base.slice(0, 2)) {
    const key = `${top.work_id}:${top.page + 1}`;
    if (top.page + 1 <= top.pages && !seen.has(key) && base.length < want + 4) {
      seen.add(key);
      base.push({ ...top, page: top.page + 1 });
    }
  }
  return base.slice(0, want + 2);
}

// Trim a page to the window containing the DENSEST cluster of distinct query
// terms — the first occurrence is often an index line or chapter heading,
// while the actual story sits further down the page.
const sectionsCache = new Map();
async function workSections(workId) {
  if (!sectionsCache.has(workId)) {
    sectionsCache.set(workId, await DB.getWorkSections(workId));
  }
  return sectionsCache.get(workId);
}

export async function excerpt(hit, terms, maxLen = 1400) {
  const [row] = await DB.getWorkPage(hit.work_id, hit.page);
  // strip the source's [1234] footnote markers: they are noise, and the model
  // starts citing THEM instead of our passage numbers
  const body = (row?.body ?? "")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ");
  const low = body.toLowerCase();

  // If a section that BEGINS on this page names a query term, the story
  // starts at its heading — excerpt from there.
  const fold = (s) => s.toLowerCase()
    .replace(/æ/g, "ae").replace(/œ/g, "oe");
  try {
    const secs = (await workSections(hit.work_id))
      .filter((s) => s.page === hit.page);
    for (const s of secs) {
      // titles may carry [1234] footnote markers; body already has them
      // stripped, so clean the title the same way before locating it
      const cleanTitle = s.title.replace(/\[\d+\]/g, "").replace(/\s+/g, " ").trim();
      const titleFold = fold(cleanTitle);
      if (terms.some((t) => titleFold.includes(fold(t)))) {
        const pos = low.indexOf(cleanTitle.slice(0, 28).toLowerCase());
        if (pos >= 0) {
          return body.slice(pos, pos + maxLen) +
                 (pos + maxLen < body.length ? "…" : "");
        }
      }
    }
  } catch { /* sections unavailable -> cluster fallback */ }
  // all occurrence positions of every term (ligature-variant aware)
  const marks = [];
  for (const t of terms) {
    const variants = new Set([t,
      t.replace(/ae/gi, "æ"), t.replace(/oe/gi, "œ"),
      t.replace(/æ/gi, "ae"), t.replace(/œ/gi, "oe"),
      ...(IRREGULARS[t] ?? [])]);
    const termMarks = [];
    for (const v of variants) {
      let i = low.indexOf(v);
      while (i >= 0) {
        termMarks.push([i, t]);
        i = low.indexOf(v, i + 1);
      }
    }
    // a term that saturates the page ("book" in Enoch) can't locate anything
    if (termMarks.length <= 25) marks.push(...termMarks);
  }
  let start = 0;
  if (marks.length) {
    marks.sort((a, b) => a[0] - b[0]);
    // best window: most DISTINCT terms; tie-break most total marks; then
    // EARLIEST (trailing index lines pack many terms into no prose)
    let bestDistinct = -1;
    let bestTotal = -1;
    let bestPos = marks[0][0];
    for (let i = 0; i < marks.length; i++) {
      const seen = new Set();
      let total = 0;
      for (let j = i; j < marks.length && marks[j][0] - marks[i][0] < maxLen; j++) {
        seen.add(marks[j][1]);
        total++;
      }
      if (seen.size > bestDistinct ||
          (seen.size === bestDistinct && total > bestTotal)) {
        bestDistinct = seen.size;
        bestTotal = total;
        bestPos = marks[i][0];
      }
    }
    start = Math.max(0, bestPos - Math.floor(maxLen / 6));
  }
  return (start > 0 ? "…" : "") +
         body.slice(start, start + maxLen) +
         (start + maxLen < body.length ? "…" : "");
}

// The model only writes the answer with [n] cites; Where lines are appended
// by US from the hit metadata — real pages, never hallucinated citations.
export const FORMAT_RULES =
  "Format: give the direct answer in 1-4 sentences, citing the supporting " +
  "passage numbers like [1]. Do not write out source names or page numbers — " +
  "the citations [n] are enough.";

// Grounding verifier: cross-check a drafted answer against ONLY the passages
// it cites (~1/4 the prefill of the full prompt, so affordable on-phone).
// The one observed wrong-answer mode is misattribution — the checker is told
// to look for exactly that.
export async function verifyPrompt(question, answerText, hits,
                                   excerptLen = 2000) {
  const cited = [...new Set([...answerText.matchAll(/\[(\d+)\]/g)]
    .map((m) => parseInt(m[1], 10)))].filter((n) => hits[n - 1]);
  const use = cited.length ? cited : hits.slice(0, 2).map((_, i) => i + 1);
  // Excerpt by the ANSWER's terms too — the checker must read the same
  // window of the page the claims were drawn from, or it rejects correct
  // answers for "not mentioning" things that sit elsewhere on the page.
  const terms = keywords(question + " " + answerText.replace(/\[\d+\]/g, ""));
  const parts = [
    "You are a strict fact-checker for a library of ancient texts.",
    "Below are source passages and a proposed answer to a question.",
    "",
  ];
  for (const n of use) {
    const h = hits[n - 1];
    if (h.kind === "verse") {
      parts.push(`[${n}] ${h.book} ${h.chapter}:${h.verse} (WEB): ` +
                 cleanVerse(h.body));
      parts.push("");
      continue;
    }
    const cite = [h.title, h.section, `p. ${h.page}`].filter(Boolean).join(" — ");
    parts.push(`[${n}] ${cite}:`);
    parts.push(await excerpt(h, terms, excerptLen));
    parts.push("");
  }
  parts.push(`Question: ${question}`);
  parts.push(`Proposed answer: ${answerText}`);
  parts.push("");
  parts.push(
    "Check the proposed answer. Paraphrase and partial coverage are fine. " +
    "Reply UNSUPPORTED (plus one short sentence naming the problem) only " +
    "if a claim contradicts the passages, or if the answer attributes a " +
    "fact to a different person or work than the passage header shows — " +
    "the [n] headers name each passage's true work and author. Otherwise " +
    "reply exactly SUPPORTED.");
  return parts.join("\n");
}

// Inline "Where:" lines appear ONLY when the question itself asks for a
// location (owner preference — otherwise locations live in the app's
// separate Sources list, and repeating them in the text is clutter).
export const LOCATION_RE =
  /\bwhere\b|\bin which\b|\bwhich (book|chapter|epistle|letter|work|volume|section|page)\b|\bwhat (chapter|book|section|page)\b/i;

export function whereLines(text, hits) {
  const cited = new Set(
    [...text.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10)));
  const lines = [];
  const seen = new Set();          // several [n]s often share one location
  for (const n of [...cited].sort((a, b) => a - b)) {
    const h = hits[n - 1];
    if (!h) continue;
    const loc = h.kind === "verse"
      ? `${h.book} ${h.chapter}:${h.verse} (WEB)`
      : [h.title, h.section, `p. ${h.page}`].filter(Boolean).join(", ");
    if (seen.has(loc)) continue;
    seen.add(loc);
    lines.push(`Where: ${loc} [${n}]`);
  }
  return lines.join("\n");
}

export async function buildPrompt(question, hits, excerptLen = 900,
                                  extraTermText = "") {
  const terms = keywords(question + " " + extraTermText);
  const parts = [
    "You are a careful research assistant for a library of ancient Christian and Jewish texts.",
    "Answer the question using ONLY the numbered passages below.",
    "Cite passages by number like [1]. Quote briefly where helpful.",
    // NOTE: an in-prompt "attribution guard" meta-rule was tried and MEASURED
    // WORSE (testbed/RESULTS.md) — the 4B model can't apply meta-rules; the
    // separate verifyPrompt() pass is the mechanism that works.
    "If the passages do not answer the question, say plainly that these passages do not contain the answer.",
    FORMAT_RULES,
    "",
  ];
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const cite = [h.title, h.section, `p. ${h.page}`].filter(Boolean).join(" — ");
    parts.push(`[${i + 1}] ${cite}:`);
    parts.push(await excerpt(h, terms, excerptLen));
    parts.push("");
  }
  parts.push(`Question: ${question}`);
  parts.push("Answer:");
  return parts.join("\n");
}

// Instruction-tuned models need their chat template — raw prompts make them
// ramble and loop on turn delimiters. .litertlm => Gemma family, but the
// GENERATION matters: Gemma 4 renamed the turn markers. The plugin persists
// the imported file's original name (origName) so we can tell them apart.
let modelFileName = "";
let modelOrigName = "";
export async function refreshModelInfo() {
  try {
    const st = await status();
    modelFileName = st.file ?? "";
    modelOrigName = st.origName ?? "";
  } catch {}
}
const isGemma4 = () =>
  /gemma[-_]?4/i.test(modelOrigName + " " + modelFileName);
function wrapForModel(text) {
  if (claudeReady()) return text;      // API takes plain user messages
  // Gemma needs its chat template whichever container it came in
  // (.litertlm, or a .task bundle whose original name says gemma)
  if (!modelFileName.endsWith(".litertlm") && !/gemma/i.test(modelOrigName))
    return text;
  if (isGemma4()) {                            // Gemma 4 turn format
    return `<|turn>user\n${text}<turn|>\n<|turn>model\n`;
  }
  return `<start_of_turn>user\n${text}<end_of_turn>\n<start_of_turn>model\n`;
}
// cut at ANY known turn marker (both Gemma generations) — over-matching an
// absent marker is harmless
const TURN_MARKERS =
  ["<end_of_turn>", "<start_of_turn>", "<turn|>", "<|turn>"];
const sanitize = (text) => {
  for (const m of TURN_MARKERS) text = text.split(m)[0];
  return text;
};

const DECLINED_RE =
  /do(es)? not (contain|answer)|not found|no passage|cannot find|couldn't find|not specified|do(es)? not specify|none of (these|the) verses/i;

// One retrieval + prompt for a question, route-aware. Used by answer() and
// by the eval harness (so desktop evals exercise the same routing).
export async function planPrompt(question, expText = "", n = 8, len = 2000) {
  const route = await routeQuestion(question);
  if (route.kind === "bible") {
    const hits = (await retrieveVerses(question, expText, route.books, 24))
      .map((h) => ({ ...h, slug: "bible" }));
    const use = hits.slice(0, Math.min(hits.length, n * 2));
    return { route: "bible", hits,
             prompt: buildVersePrompt(question, use) };
  }
  const hits = await retrieveExpanded(question, expText, 6);
  return { route: "library", hits,
           prompt: await buildPrompt(question, hits.slice(0, n), len, expText) };
}

// When the grounded answer declines, the model often KNOWS the missing name
// ("pears", "Eleazar") — probe it, re-retrieve with those terms, retry once.
const probePrompt = (question) =>
  "In at most 8 words, list the key proper names or distinctive terms " +
  "involved in answering this (no explanation, no sentence):\n" + question;

// Grounded answer with self-correcting budget: measure the prompt, shrink to
// fit; if generation still fails (or returns nothing), reload a fresh session
// at half the budget and retry smaller. Does its own retrieval (with model-
// assisted query expansion). Returns { text, hits }.
export async function answer(question, onToken, onStage = () => {}) {
  await refreshModelInfo();
  // query expansion (best effort — worth ~2s; skip silently on failure)
  onStage("Thinking about search terms");
  let expText = "";
  try {
    // expansion benefits from variety — always a bit warm, regardless of
    // the user's answer-style setting
    await generateRetry(wrapForModel(expansionPrompt(question)), (t) => {
      expText += t;
    }, 0.7);
    expText = sanitize(expText).split("\n").slice(0, 2).join("\n");
  } catch { /* no expansion */ }
  const route = await routeQuestion(question);
  onStage(route.kind === "bible" ? "Searching the Bible"
                                 : "Searching the library");
  const doRetrieve = () => route.kind === "bible"
    ? retrieveVerses(question, expText, route.books, 24)
    : retrieveExpanded(question, expText, 6);
  let hits = await doRetrieve();
  onStage(route.kind === "bible"
    ? `Weighing ${hits.length} verses`
    : `Reading ${Math.min(hits.length, 8)} passages`);

  const cloud = claudeReady();         // huge context, no prefill fragility
  const levels = [[8, 2000], [6, 2000], [4, 1400], [3, 900], [2, 500], [1, 300]];
  const startLevel = cloud ? 0 : contextTokens >= 8192 ? 0
    : contextTokens >= 4096 ? 1 : contextTokens >= 2048 ? 3 : 4;
  let probed = false;
  let busyWaits = 0;
  for (let li = startLevel; li < levels.length; li++) {
    const [n, len] = levels[li];
    // verses are short — the bible route fits twice as many items per level
    const used = route.kind === "bible" ? Math.min(hits.length, n * 2) : n;
    const prompt = wrapForModel(route.kind === "bible"
      ? buildVersePrompt(question, hits.slice(0, used))
      : await buildPrompt(question, hits.slice(0, n), len, expText));
    if (!cloud && li < levels.length - 1) {
      const t = await countTokens(prompt);
      // maxTokens covers prompt AND answer: the margin IS the answer budget
      if (t > contextTokens - 400) continue;   // won't fit — go smaller
    }
    let acc = "";
    onStage("Composing answer");
    try {
      await generateRetry(prompt, (text, done) => {
        acc += text;
        onToken(sanitize(acc), done);
      });
      acc = sanitize(acc);
      // a tiny fragment from a big prompt = engine died mid-prefill
      // (a terse "Yes — see [1]." is a real answer, keep it)
      if (acc.trim().length < 20 && n >= 3 && !/\[\d+\]/.test(acc)) acc = "";
      if (acc.trim()) {
        // one knowledge-probe retry with re-retrieval — used both when the
        // model declines and when the verifier rejects its answer
        const probeRetry = async (stage) => {
          probed = true;
          onStage(stage);
          try {
            let probe = "";
            await generateRetry(wrapForModel(probePrompt(question)), (t) => {
              probe += t;
            }, 0.3);
            probe = sanitize(probe).split("\n")[0].slice(0, 80);
            if (probe.trim()) {
              expText = (expText + "\n" + probe).trim();
              hits = await doRetrieve();
              onStage("Reading new passages");
              return true;
            }
          } catch { /* fall through */ }
          return false;
        };
        if (DECLINED_RE.test(acc) && !probed) {
          if (await probeRetry("Not found — trying different search terms")) {
            li = startLevel - 1;   // regenerate at full budget
            continue;
          }
        }
        // Grounding double-check (default on; AI settings toggle). Measured:
        // cuts wrong answers ~3x at the cost of some extra declines — the
        // owner's priority is no wrong answers.
        // Only a PURE decline skips the check: "the passages don't say X,
        // but [2] says Y" still makes a claim that must be verified.
        const pureDecline = DECLINED_RE.test(acc) && !/\[\d+\]/.test(acc);
        if (!pureDecline && aiSettings.verify !== false) {
          onStage("Double-checking against sources");
          let v = "";
          try {
            await generateRetry(wrapForModel(
              await verifyPrompt(question, acc, hits.slice(0, used))),
              (t) => { v += t; }, 0.1);
          } catch { v = "SUPPORTED"; /* checker unavailable: keep answer */ }
          if (/UNSUPPORTED/i.test(sanitize(v))) {
            if (!probed &&
                await probeRetry("Answer failed source check — retrying")) {
              li = startLevel - 1;
              continue;
            }
            const msg = "I found related passages but could not verify an " +
              "answer against them — declining rather than risk a wrong " +
              "answer. The sources below may still help.";
            onToken(msg, true);
            return { text: msg, hits };
          }
        }
        const where = LOCATION_RE.test(question)
          ? whereLines(acc, hits.slice(0, used)) : "";
        const text = where ? acc.trimEnd() + "\n" + where : acc;
        onToken(text, true);
        return { text, hits };
      }
    } catch (e) {
      if (cloud) throw e;   // API errors surface to the user, no reload dance
      // "busy" means a previous generation is STILL RUNNING on the engine —
      // reloading now would close the engine under it. Wait, then retry the
      // same level; only a real engine/prefill failure shrinks the context.
      if (isBusyError(e)) {
        if (busyWaits++ < 2) {
          onStage("Waiting for the previous answer to stop");
          await new Promise((r) => setTimeout(r, 4000));
          li--;
          continue;
        }
        return { text: "", hits };
      }
      /* fall through to retry */
    }
    if (cloud) continue;
    // session may be poisoned after a prefill failure: fresh, smaller one
    contextTokens = Math.max(1024, Math.floor(contextTokens / 2));
    try { await loadModel(contextTokens); } catch { return { text: acc, hits }; }
  }
  return { text: "", hits };
}

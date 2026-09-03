// Reader: book/chapter navigation, two texts in parallel, tappable tagged
// originals, word panel bottom sheet. State persists in localStorage.
import * as DB from "./db.js";
import * as LLM from "./llm.js";
import * as RA from "./readaloud.js";
import * as ANN from "./annotations.js";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

// Tap = QUICK release (no drag). A slow press deliberately does nothing so the
// platform's native long-press text selection wins — words are selectable text
// first, buttons second. (Groundwork for user highlighting later.)
const TAP_MS = 350, TAP_MOVE = 12;
function tappable(node, fn) {
  let t0 = 0, x0 = 0, y0 = 0;
  node.addEventListener("pointerdown", (e) => {
    t0 = performance.now(); x0 = e.clientX; y0 = e.clientY;
  });
  node.addEventListener("pointerup", (e) => {
    const quick = performance.now() - t0 < TAP_MS
      && Math.hypot(e.clientX - x0, e.clientY - y0) < TAP_MOVE
      && !document.getSelection()?.toString();
    if (quick) fn();
  });
  node.setAttribute("role", "button");
  node.tabIndex = 0;
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") fn();
  });
  return node;
}

// Two pseudo-texts render from the `words` table (every word tappable).
const TAGGED = {
  "tagged-grc": { label: "Greek NT · tagged", lang: "grc", books: [40, 66] },
  "tagged-hbo": { label: "Hebrew OT · tagged", lang: "hbo", books: [1, 39] },
};
const TEXT_LABELS = {
  kjv: "KJV", kjva: "KJV + Strong's", asv: "ASV (1901)", ylt: "Young's Literal",
  web: "World English", bsb: "Berean Standard", tyndale: "Tyndale (1525)",
  douayrheims: "Douay-Rheims", weymouth: "Weymouth NT", lxx: "Septuagint (Greek)",
  lxxen: "Septuagint (English)",
  textusreceptus: "Textus Receptus", westcotthort: "Westcott-Hort",
  tischendorf: "Tischendorf", wlc: "Hebrew (WLC)", aleppo: "Aleppo Codex",
  vulgate: "Vulgate (Latin)", peshitta: "Peshitta (Syriac)",
};
const RTL_LANGS = new Set(["hbo", "syr"]);

// localStorage can hold a truncated/corrupt value (interrupted write, quota);
// a throw here would happen during module evaluation and block the whole
// app from booting, so every read goes through this.
export function loadJson(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null");
    if (v === null) return fallback;
    if (Array.isArray(fallback) !== Array.isArray(v) ||
        typeof v !== typeof fallback) throw new Error("shape");
    return v;
  } catch {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    return fallback;
  }
}

// tagMode: how tagged originals render — "plain" (words only), "interlinear"
// (gloss under every word), "reader" (gloss only under words rarer than
// readerMax occurrences in the corpus — a reader's edition)
const state = Object.assign(
  { book: 43, chapter: 1, textA: "web", textB: "ylt",   // the default installs
    tagMode: "plain", readerMax: 30 },
  loadJson("atb-reader", {}));
const saveState = () =>
  localStorage.setItem("atb-reader", JSON.stringify(state));

let books = [];          // canonical books [{nr,name}]
let textIds = [];        // real text ids from db

const isTagged = (id) => id in TAGGED;
const textLang = new Map();
const langOf = (id) => (isTagged(id) ? TAGGED[id].lang : textLang.get(id));
const labelOf = (id) =>
  id === "none" ? "None" : (TAGGED[id]?.label ?? TEXT_LABELS[id] ?? id);

// -------------------------------------------------- pronunciation (optional)
// Speaks a lexicon word through the device TTS (native plugin on Android,
// Web Speech API elsewhere). The button only appears when a voice for the
// word's language actually exists on this device.
const ttsPlugin = () => window.Capacitor?.Plugins?.Tts ?? null;
let ttsLangs = null;   // {el: bool, he: bool} once probed

async function ttsAvailable(lang) {
  const short = lang.split("-")[0];
  const p = ttsPlugin();
  if (p) {
    if (!ttsLangs) {
      try {
        const v = await p.voices();
        // the engine cold-starts for a few seconds: don't cache "no voices"
        // until it has actually answered
        if (v.ready !== false) ttsLangs = v;
        else return false;
      } catch { ttsLangs = {}; }
    }
    return !!ttsLangs[short];
  }
  if (!window.speechSynthesis) return false;
  return speechSynthesis.getVoices()
    .some((v) => v.lang.toLowerCase().startsWith(short));
}

function speakWord(text, lang) {
  const p = ttsPlugin();
  if (p) {
    p.speak({ text, lang, rate: 0.75 }).catch(() => {});
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 0.75;
  speechSynthesis.speak(u);
}

const wordLang = (s) =>
  /[֐-׿]/.test(s) ? "he-IL"
    : /[Ͱ-Ͽἀ-῿]/.test(s) ? "el-GR" : null;

// speaker button for a panel heading; resolves to nothing if no voice
async function speakBtn(text) {
  const lang = text && wordLang(text);
  if (!lang || !(await ttsAvailable(lang))) return null;
  const b = el("button", "speakbtn");
  b.setAttribute("aria-label", "Pronounce");
  b.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 8.5a4.5 4.5 0 0 1 0 7M18.5 6a8 8 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
  b.onclick = () => speakWord(text, lang);
  return b;
}

// ---------------------------------------------------------------- word panel
// Reset the shared bottom sheet. Word/verse panels stay small (1/3 screen —
// the text being read must remain visible); tall=true for AI history/settings.
// Every open bumps the generation; panels that awaited a query check
// `stale(gen)` afterwards so a slow lookup for word A can't land in B's sheet.
let sheetGen = 0;
const stale = (gen) => gen !== sheetGen;
function sheet(tall = false) {
  const p = $("#wordpanel");
  sheetGen++;
  p.classList.toggle("tall", tall);
  p.innerHTML = "";
  p.setAttribute("role", "dialog");
  p.setAttribute("aria-modal", "false");
  return p;
}
// Escape closes whichever sheet is open (keyboard users had no way out);
// on a keyboard, ← → turn chapters/pages and "/" jumps to search — never
// while typing in a field.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const p = $("#wordpanel");
    if (p && !p.hidden) { p.hidden = true; e.preventDefault(); }
    return;
  }
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    const pager = document.querySelector("#bottombar .pager");
    if (!pager || pager.hidden || $("#bottombar").hidden) return;
    const btn = $(e.key === "ArrowLeft" ? "#prev" : "#next");
    if (btn && !btn.disabled) { btn.click(); e.preventDefault(); }
  } else if (e.key === "/") {
    $("#tab-search")?.click();
    e.preventDefault();
  }
});
// body.has-pane while a panel is open: on wide screens the content column
// makes room for the right-hand pane
new MutationObserver(() => {
  document.body.classList.toggle("has-pane", !$("#wordpanel").hidden);
}).observe($("#wordpanel"), { attributes: true, attributeFilter: ["hidden"] });

// ---- Greek edition comparison -----------------------------------------------
// Word-level diff of the Greek NT editions we hold (Textus Receptus,
// Westcott-Hort, Tischendorf) against the first of them: words absent from
// the base are marked as insertions, base words the edition lacks are shown
// struck through. Comparison ignores accents and case, keeps punctuation out.
const GREEK_EDITIONS = ["westcotthort", "textusreceptus", "tischendorf"];
const gTokens = (body) => body.replace(/<[^<>\s]{1,8}>/g, "")
  .split(/\s+/).map((t) => t.replace(/[.,·;:!?()\[\]«»“”‘’"']/g, "")).filter(Boolean);
function lcsDiff(a, b) {
  // returns ops over b: {tok, kind: "same"|"ins"} plus "del" entries for a-only tokens
  const na = a.map(normalize), nb = b.map(normalize);
  const m = na.length, n = nb.length;
  const L = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      L[i][j] = na[i] === nb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (na[i] === nb[j]) { out.push({ tok: b[j], kind: "same" }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ tok: a[i], kind: "del" }); i++; }
    else { out.push({ tok: b[j], kind: "ins" }); j++; }
  }
  while (i < m) out.push({ tok: a[i++], kind: "del" });
  while (j < n) out.push({ tok: b[j++], kind: "ins" });
  return out;
}
function editionDiff(panel, rows) {
  const eds = GREEK_EDITIONS.map((id) => rows.find((r) => r.text_id === id)).filter(Boolean);
  if (eds.length < 2) return;
  const det = el("details", "lexfull");
  det.append(el("summary", null, `Compare Greek editions (${eds.length})`));
  const base = gTokens(eds[0].body);
  const box = el("div", "eddiff lang-grc");
  const line0 = el("div", "cmp-row");
  line0.append(el("span", "textid", labelOf(eds[0].text_id) + " (base)"), el("div", "line", base.join(" ")));
  box.append(line0);
  let differences = 0;
  for (const e of eds.slice(1)) {
    const ops = lcsDiff(base, gTokens(e.body));
    const line = el("div", "line");
    for (const op of ops) {
      if (op.kind === "same") line.append(document.createTextNode(op.tok + " "));
      else {
        differences++;
        const s = el("span", op.kind === "ins" ? "ed-ins" : "ed-del", op.tok);
        line.append(s, document.createTextNode(" "));
      }
    }
    const row = el("div", "cmp-row");
    row.append(el("span", "textid", labelOf(e.text_id)), line);
    box.append(row);
  }
  det.append(box);
  det.append(el("p", "hint", differences
    ? "Marked: words this edition adds, and words of the base text it lacks (struck through). Accents are ignored."
    : "These editions agree word for word here (ignoring accents)."));
  panel.append(det);
}

// ---- annotations: highlights, bookmarks, notes -------------------------------
const HL_COLORS = ["yellow", "green", "blue", "pink"];

function applyAnnotationToRow(verse, rec) {
  const row = document.querySelector(`.verse-row[data-verse="${verse}"]`);
  if (!row) return;
  for (const c of HL_COLORS) row.classList.remove("hl-" + c);
  if (rec?.color) row.classList.add("hl-" + rec.color);
  const vb = row.querySelector(".vnum");
  if (vb) {
    vb.classList.toggle("bm", !!rec?.bookmark);
    vb.classList.toggle("hasnote", !!(rec?.note && rec.note.trim()));
  }
}

async function applyChapterAnnotations(book, chapter) {
  let recs = [];
  try { recs = await ANN.forChapter(book, chapter); } catch { return; }
  if (state.book !== book || state.chapter !== chapter) return;
  for (const r of recs) applyAnnotationToRow(r.verse, r);
}

// Compact toolbar: colour swatches · bookmark · note. `base` carries the
// record identity; onChange(rec|null) lets the caller refresh its view.
// extra = an optional button that belongs in the bar (the share link) and
// must survive every re-render
async function annotationBar(container, base, onChange, extra = null) {
  const bar = el("div", "annbar");
  container.append(bar);
  let rec = null;
  try { rec = await ANN.get(base.key); } catch { /* storage unavailable */ }
  const cur = () => rec ?? { ...base, color: null, bookmark: false, note: "" };
  const commit = async (patch) => {
    rec = await ANN.save({ ...cur(), ...patch });
    render();
    onChange?.(rec);
  };
  const render = () => {
    bar.innerHTML = "";
    const r = cur();
    for (const c of HL_COLORS) {
      const b = el("button", "swatch sw-" + c);
      b.setAttribute("aria-label", `Highlight ${c}`);
      if (r.color === c) b.classList.add("on");
      b.onclick = () => commit({ color: r.color === c ? null : c });
      bar.append(b);
    }
    const bm = el("button", "annbtn" + (r.bookmark ? " on" : ""), r.bookmark ? "★ Bookmarked" : "☆ Bookmark");
    bm.onclick = () => commit({ bookmark: !r.bookmark });
    bar.append(bm);
    const nb = el("button", "annbtn" + (r.note?.trim() ? " on" : ""), r.note?.trim() ? "✎ Edit note" : "✎ Note");
    nb.onclick = () => {
      if (bar.querySelector("textarea")) return;
      const ta = el("textarea", "annnote");
      ta.value = r.note ?? "";
      ta.placeholder = "Your note (Markdown is fine)";
      const save = el("button", "annbtn", "Save");
      save.onclick = () => commit({ note: ta.value });
      const wrap = el("div", "annnotewrap");
      wrap.append(ta, save);
      bar.append(wrap);
      ta.focus();
    };
    bar.append(nb);
    if (extra) bar.append(extra);
    if (r.note?.trim()) {
      const p = el("p", "annshown", r.note.trim());
      bar.append(p);
    }
  };
  render();
}

async function showAnnotations() {
  const panel = sheet(true);
  const gen = sheetGen;
  const head = el("div", "sheet-head");
  head.append(el("h3", null, "My notes & bookmarks"));
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  panel.hidden = false;
  let recs = [];
  try { recs = await ANN.all(); } catch { /* none */ }
  if (stale(gen)) return;
  const names = new Map(books.map((b) => [b.nr, b.name]));
  // import: paste the Markdown this app exported (from another device)
  const imp = el("button", "annbtn", "Import Markdown…");
  imp.onclick = () => {
    if (panel.querySelector(".annimport")) return;
    const ta = el("textarea", "annnote annimport");
    ta.placeholder = "Paste the exported Markdown here";
    const go = el("button", "annbtn", "Import");
    go.onclick = async () => {
      const nrByName = new Map(books.map((b) => [b.name.toLowerCase(), b.nr]));
      const works = await DB.getWorks().catch(() => []);
      const parsed = ANN.fromMarkdown(ta.value, nrByName);
      let n = 0;
      for (const r of parsed) {
        if (r.kind === "work") {
          const w = works.find((x) => x.title === r.title);
          if (!w) continue;
          r.workId = w.id; r.pages = w.pages; r.key = ANN.workKey(w.id, r.page);
        }
        if (!r.key) continue;
        await ANN.save(r);          // last write wins per verse / page
        n++;
      }
      toastError(`Imported ${n} item${n === 1 ? "" : "s"}.`);
      showAnnotations();
      if (currentView === "read") applyChapterAnnotations(state.book, state.chapter);
    };
    const wrap = el("div", "annnotewrap");
    wrap.append(ta, go);
    imp.after(wrap);
  };
  if (!recs.length) {
    panel.append(el("p", "hint", "Nothing yet. Tap a verse number, then choose a colour, a bookmark, or write a note."));
    panel.append(imp);
    return;
  }
  const exp = el("button", "annbtn", "Export as Markdown");
  exp.onclick = async () => {
    const md = ANN.toMarkdown(recs, names, state.textA);
    try {
      if (navigator.share) { await navigator.share({ title: "Library 422 notes", text: md }); return; }
    } catch { /* cancelled */ }
    try { await navigator.clipboard.writeText(md); toastError("Copied to the clipboard as Markdown."); }
    catch { toastError("Could not export — clipboard unavailable."); }
  };
  const tools = el("div", "annbar");
  tools.append(exp, imp);
  panel.append(tools);
  const verses = recs.filter((r) => r.kind === "verse")
    .sort((a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse);
  const works = recs.filter((r) => r.kind === "work");
  const section = (title, items, render) => {
    if (!items.length) return;
    panel.append(el("p", "hint", title));
    const list = el("div", "occlist");
    for (const r of items) list.append(render(r));
    panel.append(list);
  };
  section("Bible:", verses, (r) => {
    const row = el("div", "occ");
    if (r.color) row.classList.add("hl-" + r.color);
    const a = el("a", null, `${names.get(r.book) ?? r.book} ${r.chapter}:${r.verse}`);
    a.href = "#";
    a.onclick = (e) => { e.preventDefault(); panel.hidden = true; navigateTo(r.book, r.chapter, r.verse); };
    row.append(a);
    if (r.bookmark) row.append(el("span", "hint", " ★"));
    if (r.note?.trim()) row.append(el("div", "snip", r.note.trim().slice(0, 160)));
    return row;
  });
  section("Library:", works, (r) => {
    const row = el("div", "occ");
    const a = el("a", null, `${r.title ?? "Work"} · p. ${r.page}`);
    a.href = "#";
    a.onclick = (e) => {
      e.preventDefault(); panel.hidden = true;
      Object.assign(workState, { id: r.workId, page: r.page, title: r.title ?? workState.title, pages: r.pages ?? workState.pages });
      saveWork(); showView("work"); renderWorkPage();
    };
    row.append(a);
    if (r.bookmark) row.append(el("span", "hint", " ★"));
    if (r.note?.trim()) row.append(el("div", "snip", r.note.trim().slice(0, 160)));
    return row;
  });
}

// ---- full lexicon entries (BDB / Abbott-Smith / LSJ) -------------------------
// Strong's stays first (short, in-context); the full dictionaries follow as
// collapsed sections so a 20 KB LSJ article never buries the panel.
const LEX_SOURCE = {
  bdb: "Brown-Driver-Briggs (1906)",
  "abbott-smith": "Abbott-Smith, Manual Greek Lexicon (1922)",
  lsj: "Liddell-Scott-Jones (via STEPBible)",
};
async function lexiconSections(strongs, container, gen) {
  if (!strongs) return;
  // each full lexicon is its own download (BDB for Hebrew; LSJ and
  // Abbott-Smith for Greek)
  let anyMissing = false;
  for (const id of lexiconItems(strongs)) {
    if (packInstalled(id)) continue;
    anyMissing = true;
    const p = packPrompt(id, "The full lexicon entry");
    if (p) container.append(p);
  }
  if (anyMissing && lexiconItems(strongs).every((id) => !packInstalled(id)) &&
      !/^H9\d{3}$/.test(strongs)) return;
  let rows = [];
  try { rows = await DB.getFullLexicon(strongs); } catch { return; }
  if (gen !== undefined && stale(gen)) return;
  if (!rows.length && /^H9\d{3}$/.test(strongs)) {
    // STEPBible affix/pronoun-suffix codes have no Strong's entry
    try {
      const [a] = await DB.getAffix(strongs);
      if (a && !(gen !== undefined && stale(gen))) {
        container.append(el("p", "def", `${a.form} (${a.translit}) — ${a.gloss}`));
        container.append(el("p", "hint", a.meaning));
      }
    } catch { /* no affix table */ }
    return;
  }
  for (const r of rows) {
    const det = el("details", "lexfull");
    det.append(el("summary", null,
      `${LEX_SOURCE[r.source] ?? r.source} — ${r.lemma ?? ""}`));
    const body = el("div", "def lexbody");
    for (const p of r.entry.split("\n\n")) {
      const para = el("p");
      renderRichBody(para, p);
      body.append(para);
    }
    det.append(body);
    container.append(det);
  }
}

// How the WEB renders this Strong's number (English-side concordance from the
// reverse interlinear): "word (n), word (n)…" — a quick sense of the range.
async function renderingsRow(strongs, container, gen) {
  if (!strongs) return;
  let rows = [];
  try { rows = await DB.getRenderings(strongs, "web", 12); } catch { return; }
  if (gen !== undefined && stale(gen)) return;
  if (!rows.length) return;
  const clean = (w) => w.replace(/[.,;:!?"“”‘’()]/g, "").toLowerCase();
  const merged = new Map();
  for (const r of rows) merged.set(clean(r.word), (merged.get(clean(r.word)) ?? 0) + r.n);
  const parts = [...merged].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([w, n]) => `${w} (${n})`);
  container.append(el("p", "hint", "Rendered in the WEB as: " + parts.join(", ")));
}

// ---- people, places, events ------------------------------------------------
const KIND_LABEL = { person: "Person", place: "Place", event: "Event", other: "Name" };
const yearLabel = (y) => (y == null ? "" : y < 0 ? `${-y} BC` : `AD ${y}`);
const yearRange = (a, b) => {
  if (a == null && b == null) return "";
  if (a != null && b != null && a !== b) return `${yearLabel(a)} – ${yearLabel(b)}`;
  return yearLabel(a ?? b);
};
let bookCodes = new Map();   // "John" / "Jhn" -> nr, for refs inside dictionary text

// Easton's entries carry markdown links "[John 3:1](/john#John.3.1)"; TIPNR
// prose carries <ref="Jhn.3.1">…</ref>. Both become tappable verse links.
function renderRefText(container, text) {
  const re = /\[([^\]]+)\]\(\/[^)#]*#([1-3]?[A-Za-z]+)\.(\d+)\.(\d+)[^)]*\)|<ref="([1-3]?[A-Za-z]+)\.(\d+)\.(\d+)[^"]*">([^<]*)<\/ref>/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    container.append(document.createTextNode(text.slice(last, m.index)));
    last = m.index + m[0].length;
    const label = m[1] ?? m[8];
    const nr = bookCodes.get(m[2] ?? m[5]);
    const ch = Number(m[3] ?? m[6]), v = Number(m[4] ?? m[7]);
    if (!nr) { container.append(document.createTextNode(label)); continue; }
    const a = el("a", "vref", label);
    a.href = "#";
    a.onclick = (e) => { e.preventDefault(); $("#wordpanel").hidden = true; navigateTo(nr, ch, v); };
    container.append(a);
  }
  container.append(document.createTextNode(text.slice(last)));
}

function entityLink(kind, id, name, extra) {
  const row = el("div", "occ");
  const a = el("a", null, name);
  a.href = "#";
  a.onclick = (e) => { e.preventDefault(); showEntity(kind, id); };
  row.append(el("span", "kindchip", KIND_LABEL[kind] ?? kind), a);
  if (extra) row.append(el("span", "hint", ` — ${extra}`));
  return row;
}

async function showEntity(kind, id) {
  const panel = sheet(true);
  const gen = sheetGen;
  const head = el("div", "sheet-head");
  const h3 = el("h3", null, "…");
  head.append(h3);
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  panel.hidden = false;
  let row;
  try {
    [row] = await (kind === "person" ? DB.getPerson(id) : kind === "place" ? DB.getPlace(id)
      : kind === "event" ? DB.getEvent(id) : DB.getOther(id));
  } catch { row = null; }
  if (stale(gen)) return;
  if (!row) { h3.textContent = "Not found"; return; }
  h3.textContent = row.name ?? row.title;
  const facts = el("dl");
  const fact = (k, v) => { if (v) facts.append(el("dt", null, k), el("dd", null, v)); };
  fact("Kind", kind === "place" ? [row.kind, row.sub_kind].filter(Boolean).join(" · ") || "Place"
                : kind === "other" ? row.kind : KIND_LABEL[kind]);
  if (kind === "person") {
    fact("Gender", row.gender);
    fact("Lived", row.birth_year != null || row.death_year != null
      ? yearRange(row.birth_year, row.death_year)
      : row.min_year != null ? `c. ${yearRange(row.min_year, row.max_year)}` : "");
    fact("Tribe", row.tribe);
    fact("Groups", row.groups);
  }
  if (kind === "place") {
    fact("Region", row.area);
    fact("Modern name", row.modern_name);
    if (row.lat != null) fact("Location", `${row.lat.toFixed(3)}, ${row.lon.toFixed(3)}`);
  }
  if (kind === "place" && row.lat != null) {
    const mapBtn = el("button", null, "Show on map →");
    mapBtn.onclick = () => showMap(id);
    facts.append(el("dt", null, ""), mapBtn);
  }
  if (kind === "event") {
    fact("When", yearRange(row.start_year, row.end_year) + (row.duration ? ` (${row.duration})` : ""));
    fact("Part of", row.period);
  }
  panel.append(facts);
  if (row.description && kind !== "event") panel.append(el("p", "def", row.description));
  if (row.description && kind === "event") panel.append(el("p", "def", row.description));

  // Easton's Bible Dictionary (1897): the public-domain prose entry
  if (row.easton) {
    panel.append(el("p", "hint", "Easton's Bible Dictionary (1897):"));
    const p = el("p", "def");
    renderRefText(p, row.easton);
    panel.append(p);
  }

  // other spellings / original forms
  if (kind !== "event") {
    try {
      const names = await DB.getEntityNames(kind, id);
      if (stale(gen)) return;
      const alts = names.map((n) => n.name).filter((n) => n !== row.name);
      if (alts.length) panel.append(el("p", "hint", "Also: " + [...new Set(alts)].slice(0, 12).join(", ")));
    } catch { /* ignore */ }
  }

  // family
  if (kind === "person") {
    try {
      const rels = await DB.getPersonRelations(id);
      if (stale(gen)) return;
      if (rels.length) {
        panel.append(el("p", "hint", "Family:"));
        const list = el("div", "occlist");
        for (const r of rels.slice(0, 40))
          list.append(entityLink("person", r.id, r.name, r.relation));
        panel.append(list);
      }
    } catch { /* ignore */ }
  }

  // events this person/place takes part in, or an event's participants
  try {
    if (kind === "event") {
      const links = await DB.getEventLinks(id);
      if (stale(gen)) return;
      if (links.length) {
        panel.append(el("p", "hint", "Involves:"));
        const list = el("div", "occlist");
        for (const l of links) list.append(entityLink(l.kind, l.id, l.name));
        panel.append(list);
      }
    } else if (kind !== "other") {
      const evs = await DB.getEntityEvents(kind, id);
      if (stale(gen)) return;
      if (evs.length) {
        panel.append(el("p", "hint", "Events:"));
        const list = el("div", "occlist");
        for (const e of evs) list.append(entityLink("event", e.id, e.title, yearRange(e.start_year, e.end_year)));
        panel.append(list);
      }
    }
  } catch { /* ignore */ }

  // verses
  try {
    const vs = await DB.getEntityVerses(kind, id, 60);
    if (stale(gen)) return;
    if (vs.length) {
      const total = row.verse_count ?? vs.length;
      panel.append(el("p", "hint", `Verses${total > vs.length ? ` (first ${vs.length} of ${total})` : ""}:`));
      const list = el("div", "occlist");
      for (const v of vs) {
        const r = el("div", "occ");
        const a = el("a", null, `${v.book} ${v.chapter}:${v.verse}`);
        a.href = "#";
        a.onclick = (e) => { e.preventDefault(); panel.hidden = true; navigateTo(v.book_nr, v.chapter, v.verse); };
        r.append(a);
        list.append(r);
      }
      panel.append(list);
    }
  } catch { /* ignore */ }
  panel.append(el("p", "hint",
    "Sources: Theographic Bible Metadata (CC BY-SA 4.0), STEPBible proper names (CC BY 4.0), Easton (1897)."));
}

// ---- offline map ------------------------------------------------------------
// Natural Earth coast/lakes/rivers (public domain, clipped to the biblical
// world in app/vendor/map/levant.json) on a canvas, with Theographic places
// plotted by verse count. Pan by drag, zoom by wheel / pinch, tap a dot.
let mapData = null, mapPlaces = null;
async function loadMapData() {
  if (!mapData) {
    const res = await fetch("vendor/map/levant.json");
    if (!res.ok) throw new Error("map data missing");
    mapData = await res.json();
  }
  if (!mapPlaces) mapPlaces = await DB.getPlacesWithCoords();
}

async function showMap(focusId = null) {
  const panel = sheet(true);
  const gen = sheetGen;
  const head = el("div", "sheet-head");
  const h3 = el("h3", null, "Map of Bible places");
  head.append(h3);
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  if (!packInstalled("names")) {
    panel.append(head);
    panel.append(packPrompt("names", "The map's places", false) ??
                 el("p", "hint", "No place data in this database."));
    panel.hidden = false;
    return;
  }
  panel.append(head);
  panel.hidden = false;
  try { await loadMapData(); } catch (e) {
    panel.append(el("p", "hint", "Map data is not available: " + e.message));
    return;
  }
  if (stale(gen)) return;
  const canvas = el("canvas", "mapcanvas");
  const wrap = el("div", "mapwrap");
  wrap.append(canvas);
  const caption = el("p", "hint", "Drag to pan · pinch or scroll to zoom · tap a place");
  panel.append(wrap, caption);

  const places = mapPlaces;
  const [W, S, E, N] = mapData.bbox;
  // view: centre (lon, lat) + degrees of longitude across the canvas
  let cx = 35.2, cy = 31.8, span = 8;
  const focus = focusId && places.find((p) => p.id === focusId);
  if (focus) { cx = focus.lon; cy = focus.lat; span = 3; }
  const dpr = window.devicePixelRatio || 1;
  let cw = 0, ch = 0;
  const resize = () => {
    cw = wrap.clientWidth; ch = Math.max(260, Math.round(window.innerHeight * 0.5));
    canvas.width = cw * dpr; canvas.height = ch * dpr;
    canvas.style.width = cw + "px"; canvas.style.height = ch + "px";
  };
  const proj = (lon, lat) => {
    const k = cw / span;                       // px per degree of longitude
    const ky = k / Math.cos(cy * Math.PI / 180); // keep shapes roughly true
    return [cw / 2 + (lon - cx) * k, ch / 2 - (lat - cy) * ky];
  };
  const unproj = (x, y) => {
    const k = cw / span, ky = k / Math.cos(cy * Math.PI / 180);
    return [cx + (x - cw / 2) / k, cy - (y - ch / 2) / ky];
  };
  const styles = () => {
    const cs = getComputedStyle(document.documentElement);
    return { ink: cs.getPropertyValue("--ink").trim() || "#222",
             muted: cs.getPropertyValue("--muted").trim() || "#888",
             accent: cs.getPropertyValue("--accent").trim() || "#4a5fc1",
             bg: cs.getPropertyValue("--card").trim() || "#fff",
             water: cs.getPropertyValue("--chip").trim() || "#e8ecf7" };
  };
  let labelled = [];
  const draw = () => {
    const g = canvas.getContext("2d");
    const st = styles();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = st.bg; g.fillRect(0, 0, cw, ch);
    const line = (path, stroke, width) => {
      g.beginPath();
      path.forEach(([lon, lat], i) => { const [x, y] = proj(lon, lat); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.strokeStyle = stroke; g.lineWidth = width; g.stroke();
    };
    for (const ring of mapData.lakes) {
      g.beginPath();
      ring.forEach(([lon, lat], i) => { const [x, y] = proj(lon, lat); i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.closePath(); g.fillStyle = st.water; g.fill();
    }
    for (const r of mapData.rivers) line(r.path, st.water, 1.5);
    for (const c of mapData.coast) line(c, st.muted, 1);
    // places: dots by verse count; labels for the most-cited, no overlaps
    labelled = [];
    const cells = new Set();
    const sorted = [...places].sort((a, b) => b.verse_count - a.verse_count);
    const maxLabels = span > 12 ? 25 : span > 6 ? 45 : 90;
    g.font = "11px system-ui, sans-serif";
    for (const p of sorted) {
      const [x, y] = proj(p.lon, p.lat);
      if (x < -20 || y < -20 || x > cw + 20 || y > ch + 20) continue;
      const r = Math.min(6, 2 + Math.log2(1 + p.verse_count) * 0.8);
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = p.id === focusId ? st.accent : st.ink; g.globalAlpha = 0.8; g.fill(); g.globalAlpha = 1;
      const cell = `${Math.round(x / 70)}:${Math.round(y / 16)}`;
      if (labelled.length < maxLabels && !cells.has(cell)) {
        cells.add(cell);
        g.fillStyle = st.ink; g.fillText(p.name, x + r + 3, y + 4);
        labelled.push(p);
      }
    }
  };
  resize(); draw();
  // pan / zoom / tap
  const pointers = new Map();
  let dragged = false, pinch0 = 0, span0 = span;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); span0 = span;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pointers.size === 1) {
      const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
      const k = cw / span, ky = k / Math.cos(cy * Math.PI / 180);
      cx -= dx / k; cy += dy / ky;
      cx = Math.max(W, Math.min(E, cx)); cy = Math.max(S, Math.min(N, cy));
      draw();
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (pinch0) { span = Math.max(0.5, Math.min(E - W, span0 * pinch0 / d)); dragged = true; draw(); }
    }
  });
  const up = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (dragged || pointers.size) return;
    // tap: nearest place within 16 px
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bd = 16;
    for (const p of places) {
      const [px, py] = proj(p.lon, p.lat);
      const d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) showEntity("place", best.id);
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", (e) => pointers.delete(e.pointerId));
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const [lon, lat] = unproj(e.clientX - rect.left, e.clientY - rect.top);
    span = Math.max(0.5, Math.min(E - W, span * (e.deltaY > 0 ? 1.2 : 1 / 1.2)));
    // keep the point under the cursor fixed
    const [x2, y2] = proj(lon, lat);
    const k = cw / span, ky = k / Math.cos(cy * Math.PI / 180);
    cx += (x2 - (e.clientX - rect.left)) / k; cy -= (y2 - (e.clientY - rect.top)) / ky;
    draw();
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    [cx, cy] = unproj(e.clientX - rect.left, e.clientY - rect.top);
    span = Math.max(0.5, span / 1.8); draw();
  });
  window.addEventListener("resize", () => { if (!panel.hidden) { resize(); draw(); } });
  panel.append(el("p", "hint", "Coastlines, lakes and rivers: Natural Earth (public domain). Places: Theographic Bible Metadata (CC BY-SA 4.0)."));
}

async function showTimeline() {
  const panel = sheet(true);
  const gen = sheetGen;
  const head = el("div", "sheet-head");
  head.append(el("h3", null, "Timeline of events"));
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  panel.hidden = false;
  let evs = [];
  try { evs = await DB.getEventsTimeline(); } catch { /* no graph */ }
  if (stale(gen)) return;
  if (!evs.length) {
    panel.append(packPrompt("names", "The timeline", false) ??
                 el("p", "hint", "No timeline in this database."));
    return;
  }
  panel.append(el("p", "hint",
    "Traditional dating from Theographic Bible Metadata (Ussher-style chronology for the early periods)."));
  const list = el("div", "occlist");
  let lastPeriod = null;
  for (const e of evs) {
    if (e.period && e.period !== lastPeriod) {
      list.append(el("div", "hint tlperiod", e.period));
      lastPeriod = e.period;
    }
    const r = el("div", "occ tlrow");
    r.append(el("span", "tlyear", yearRange(e.start_year, e.end_year)));
    const a = el("a", null, e.title);
    a.href = "#";
    a.onclick = (ev) => { ev.preventDefault(); showEntity("event", e.id); };
    r.append(a);
    list.append(r);
  }
  panel.append(list);
}

// ---- morphology in plain English -------------------------------------------
// STEPBible's expansions of every morph code live in `morph_codes`. Greek
// codes are single ("V-PAI-3S") or crasis compounds ("P-1NS + G2532=CONJ");
// OT codes chain parts with "/" and drop the language letter after the first
// ("HTd/Ncmsa" = HTd + HNcmsa). Hebrew codes are the only ones with lowercase.
const morphCache = new Map();
const morphLang = (morph) => (/[a-z]/.test(morph) ? "hbo" : "grc");
function morphParts(lang, morph) {
  if (lang === "grc")
    return morph.split(/\s*\+\s*/).map((p) => p.replace(/^G\d+=/, "")).filter(Boolean);
  const parts = morph.split("/").filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p : parts[0][0] + p));
}
async function morphSummary(morph) {
  if (!morph) return null;
  if (morphCache.has(morph)) return morphCache.get(morph);
  const lang = morphLang(morph);
  const parts = morphParts(lang, morph);
  let out = null;
  try {
    const rows = await DB.getMorphCodes(lang, parts);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const found = parts.map((p) => byCode.get(p)).filter(Boolean);
    if (found.length) {
      out = {
        summary: found.map((r) => r.summary).join(" + "),
        explanation: found.map((r) => r.explanation).filter(Boolean).join("; "),
      };
    }
  } catch { /* older DB without morph_codes: show the raw code */ }
  morphCache.set(morph, out);
  return out;
}

// dt/dd pair for a morph code: raw code now, plain English when it arrives
function morphRow(dl, morph, gen) {
  const dd = el("dd", null, morph);
  dl.append(el("dt", null, "Parsing"), dd);
  morphSummary(morph).then((m) => {
    if (!m || stale(gen)) return;
    dd.textContent = m.summary;
    const code = el("span", "hint", ` ${morph}`);
    dd.append(code);
    if (m.explanation) {
      const why = el("div", "hint", m.explanation);
      dd.append(why);
    }
  });
}

async function showWord(word) {
  const panel = sheet();
  const gen = sheetGen;
  const head = el("div", "sheet-head");
  const h3 = el("h3", null,
    `${word.surface} ${word.translit ? `(${word.translit})` : ""}`);
  head.append(h3);
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  speakBtn(word.lemma ?? word.surface).then((b) => b && h3.append(b));

  const dl = el("dl");
  if (word.gloss) dl.append(el("dt", null, "Gloss here"), el("dd", null, word.gloss));
  if (word.morph) morphRow(dl, word.morph, gen);
  variantRow(dl, word);
  for (const [k, v] of [["Lemma", word.lemma], ["Strong's", word.strongs]]) {
    if (v) dl.append(el("dt", null, k), el("dd", null, v));
  }
  panel.append(dl);

  if (word.strongs) {
    const [entry] = await DB.getLexicon(word.strongs);
    const [{ n }] = await DB.getOccurrenceCount(word.strongs);
    if (stale(gen)) return;
    if (entry?.definition) panel.append(el("p", "def", entry.definition));
    if (entry?.kjv_usage) panel.append(el("p", "kjv", "KJV: " + entry.kjv_usage));
    lexiconSections(word.strongs, panel, gen);
    renderingsRow(word.strongs, panel, gen);
    const btn = el("button", null, `${n.toLocaleString()} occurrence${n === 1 ? "" : "s"} →`);
    btn.onclick = async () => {
      const list = el("div", "occlist");
      btn.replaceWith(list);
      await concordancePage(list, word.strongs, n, 0, 200, (o) => {
        panel.hidden = true;
        navigateTo(o.book_nr, o.chapter, o.verse);
      });
    };
    panel.append(btn);
  }
  panel.hidden = false;
}

// --------------------------------------------- English word -> original words
async function showEnglishWord(raw, ctx = null, pos = -1) {
  const word = raw.replace(/[^A-Za-z'’-]/g, "").toLowerCase();
  if (word.length < 2) return;
  const panel = sheet();
  const head = el("div", "sheet-head");
  head.append(el("h3", null, `“${word}”`));
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);

  // English definition first (Webster's 1913/WordNet) — a dictionary FOR English
  const gen = sheetGen;
  const def = await DB.getEnglishDef(word);
  if (stale(gen)) return;
  if (def) {
    if (def.word !== word) panel.append(el("p", "hint", `entry: ${def.word}`));
    panel.append(el("p", "def", def.definition));
  } else if (!packInstalled("dictionary")) {
    panel.append(packPrompt("dictionary", "The English dictionary") ??
                 el("p", "hint", "No dictionary entry found."));
  } else {
    panel.append(el("p", "hint", "No dictionary entry found."));
  }

  // Reverse interlinear: the exact original word behind THIS token (WEB
  // carries per-word Strong's tags). Secondary and labelled — the English
  // dictionary stays first by owner rule. Tagging is eBible's, not STEP's.
  if (ctx?.textId === "web" && pos >= 0) {
    let hit = null;
    try {
      hit = await DB.getStrongsForWord(ctx.textId, ctx.bookNr, ctx.chapter, ctx.verse, pos);
    } catch { /* older DB without verse_words */ }
    if (stale(gen)) return;
    if (!hit && !packInstalled("interlinear-web")) {
      const p = packPrompt("interlinear-web", "The original word behind this one");
      if (p) panel.append(p);
    }
    if (hit?.strongs) {
      const box = el("div", "behind");
      box.append(el("p", "hint", "Behind this word (WEB tagging):"));
      const row = el("div", "occ");
      const link = el("a", null,
        `${hit.lemma ?? hit.strongs} ${hit.translit ? `(${hit.translit})` : ""} — ${hit.strongs}`);
      link.href = "#";
      link.onclick = async (e) => {
        e.preventDefault();
        const holder = el("div");
        panel.innerHTML = "";
        const back = el("button", "close", "✕");
        back.onclick = () => { panel.hidden = true; };
        panel.append(back, holder);
        await showConcordance(hit.strongs, holder);
      };
      row.append(link);
      if (hit.definition) row.append(el("div", "snip", hit.definition.slice(0, 160)));
      box.append(row);
      panel.append(box);
    }
  }

  // a proper name? offer the people/places entries for it
  try {
    const ents = await DB.findEntitiesByName(raw.replace(/[^\p{L}'’-]/gu, "").toLowerCase(), 6);
    if (stale(gen)) return;
    if (ents.length) {
      panel.append(el("p", "hint", "Who or where:"));
      const list = el("div", "occlist");
      for (const e of ents) list.append(entityLink(e.kind, e.id, e.name, e.description));
      panel.append(list);
    }
  } catch { /* no graph tables */ }

  // Original-language mapping stays collapsed until asked for: the panel opens
  // at its final size instantly, no layout shift when slow queries land.
  const expander = el("button", null, "Original-language words ▸");
  expander.onclick = async () => {
    expander.disabled = true;
    expander.textContent = "Loading…";
    const hits = await DB.reverseGloss(word);
    if (stale(gen)) return;
    const box = el("div");
    if (!hits.length) {
      box.append(el("p", "hint", "No tagged original word carries this gloss."));
    } else {
      box.append(el("p", "hint", "In the original languages, this often renders:"));
      const list = el("div", "occlist");
      for (const h of hits) {
        const row = el("div", "occ");
        const link = el("a", null,
          `${h.lemma ?? h.strongs} ${h.translit ? `(${h.translit})` : ""} — ${h.strongs} · ${h.n}×`);
        link.href = "#";
        link.onclick = async (e) => {
          e.preventDefault();
          const holder = el("div");
          panel.innerHTML = "";
          const back = el("button", "close", "✕");
          back.onclick = () => { panel.hidden = true; };
          panel.append(back, holder);
          await showConcordance(h.strongs, holder);
        };
        row.append(link);
        if (h.definition) row.append(el("div", "snip", h.definition.slice(0, 120)));
        list.append(row);
      }
      box.append(list);
    }
    expander.replaceWith(box);
  };
  panel.append(expander);
  panel.hidden = false;
}

// ---------------------------------------- untagged Greek/Hebrew word lookup
const SURFACE_JUNK = /[/·,.;:¶«»“”‘’!?()־׀׃׆|]/g;

async function showOriginalWord(raw) {
  const clean = normalize(raw.replace(SURFACE_JUNK, ""));
  if (!clean) return;
  const panel = sheet();
  const head = el("div", "sheet-head");
  const h3 = el("h3", null, raw.replace(/[,.·;:¶]/g, ""));
  head.append(h3);
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  panel.hidden = false;
  speakBtn(raw.replace(/[,.·;:¶]/g, "")).then((b) => b && h3.append(b));

  const gen = sheetGen;
  let hits = await DB.lookupSurface(clean);
  if (stale(gen)) return;
  if (!hits.length) {
    // maybe the tapped form IS a dictionary headword (common in the LXX)
    const entries = await DB.searchLexicon(clean, 3);
    if (stale(gen)) return;
    if (entries.length) {
      renderLexiconList(entries, panel);
      return;
    }
    panel.append(el("p", "hint",
      "This form isn't in the tagged corpus — no identification available."));
    return;
  }
  const [best, ...rest] = hits;
  const dl = el("dl");
  if (best.lemma) dl.append(el("dt", null, "Lemma"), el("dd", null,
    `${best.lemma} ${best.translit ? `(${best.translit})` : ""}`));
  dl.append(el("dt", null, "Strong's"), el("dd", null, best.strongs));
  panel.append(dl);
  if (best.definition) panel.append(el("p", "def", best.definition));
  if (best.kjv_usage) panel.append(el("p", "kjv", "KJV: " + best.kjv_usage));
  lexiconSections(best.strongs, panel, gen);
  const btn = el("button", null, `Occurrences of ${best.strongs} →`);
  btn.onclick = async () => {
    const holder = el("div");
    panel.innerHTML = "";
    const back = el("button", "close", "✕");
    back.onclick = () => { panel.hidden = true; };
    panel.append(back, holder);
    await showConcordance(best.strongs, holder);
  };
  panel.append(btn);
  if (rest.length) {
    panel.append(el("p", "hint", "This form can also be:"));
    renderLexiconList(rest.map((h) => ({ ...h })), panel);
  }
}

// --------------------------------------------------------------- verse panel
async function showVerse(bookNr, chapter, verse) {
  const bookName = books.find((b) => b.nr === bookNr)?.name ?? `Book ${bookNr}`;
  const panel = sheet();
  const head = el("div", "sheet-head");
  head.append(el("h3", null, `${bookName} ${chapter}:${verse}`));
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);

  // the user's own layer: highlight colour, bookmark, note
  const share = shareButton(`/read/${slugOf(bookName)}/${chapter}/${verse}`, `${bookName} ${chapter}:${verse}`);
  annotationBar(panel, { kind: "verse", key: ANN.verseKey(bookNr, chapter, verse),
    book: bookNr, chapter, verse },
    (rec) => applyAnnotationToRow(verse, rec), share);   // share = the verse's address

  // every translation of this verse (tradition texts through the verse map)
  const gen = sheetGen;
  const plainIds = textIds.filter((t) => !traditionsFor(t));
  const rows = await DB.getVerseParallel(plainIds, bookNr, chapter, verse);
  for (const t of textIds.filter((t) => traditionsFor(t))) {
    try {
      const m = await mappedChapter(t, bookNr, chapter);
      const r = m.get(verse);
      if (r) rows.push({ text_id: t, body: r.body });
    } catch { /* skip */ }
  }
  rows.sort((a, b) => textIds.indexOf(a.text_id) - textIds.indexOf(b.text_id));
  if (stale(gen)) return;
  // Greek NT editions side by side, differences marked
  if (bookNr >= 40 && bookNr <= 66) editionDiff(panel, rows);
  const cmp = el("div", "vcompare");
  for (const r of rows) {
    const line = el("div", "cmp-row");
    line.append(el("span", "textid", labelOf(r.text_id)));
    const body = el("div", "line");
    if (RTL_LANGS.has(langOf(r.text_id))) body.dir = "rtl";
    body.classList.add("lang-" + (langOf(r.text_id) ?? "en"));
    renderBody(body, r.body, false);
    line.append(body);
    cmp.append(line);
  }
  panel.append(cmp);

  // cross-references, best-voted first
  const refs = await DB.getCrossrefs(bookNr, chapter, verse, 20);
  if (stale(gen)) return;
  if (refs.length) {
    panel.append(el("p", "hint", "Cross-references:"));
    const list = el("div", "occlist");
    for (const r of refs) {
      const row = el("div", "occ");
      const toName = books.find((b) => b.nr === r.to_book)?.name ?? r.to_ref;
      const link = el("a", null,
        r.to_book ? `${toName} ${r.to_chapter}:${r.to_verse}` : r.to_ref);
      link.href = "#";
      link.onclick = (e) => {
        e.preventDefault();
        panel.hidden = true;
        if (r.to_book) navigateTo(r.to_book, r.to_chapter, r.to_verse);
      };
      row.append(link, el("span", "hint", `  (${r.votes})`));
      list.append(row);
    }
    panel.append(list);
  }
  panel.hidden = false;

  // OT quotations / background (NT verse) or NT citations (OT verse), from
  // the best-voted cross-reference links across the testaments
  try {
    const nt = bookNr >= 40 && bookNr <= 66;
    const links = nt ? await DB.getOtLinks(bookNr, chapter, verse, 8)
      : bookNr <= 39 ? await DB.getNtLinks(bookNr, chapter, verse, 12) : [];
    if (stale(gen)) return;
    if (links.length) {
      panel.append(el("p", "hint", nt ? "Old Testament background (quotations & allusions):"
                                      : "Cited in the New Testament:"));
      const list = el("div", "occlist");
      for (const l of links) {
        const r = el("div", "occ");
        const a = el("a", null, `${l.book} ${l.chapter}:${l.verse}`);
        a.href = "#";
        a.onclick = (e) => { e.preventDefault(); panel.hidden = true; navigateTo(l.book_nr, l.chapter, l.verse); };
        r.append(a, el("span", "hint", `  (${l.votes})`));
        list.append(r);
      }
      panel.append(list);
    }
  } catch { /* ignore */ }

  // people, places and events this verse touches (Theographic + TIPNR)
  try {
    const ents = await DB.getEntitiesForVerse(bookNr, chapter, verse);
    if (stale(gen)) return;
    if (!ents.length && !packInstalled("names")) {
      const p = packPrompt("names", "People, places & events");
      if (p) panel.append(p);
    }
    if (ents.length) {
      panel.append(el("p", "hint", "People, places & events:"));
      const list = el("div", "occlist");
      for (const e of ents) list.append(entityLink(e.kind, e.id, e.name, e.description));
      panel.append(list);
    }
  } catch { /* older DB without the graph */ }

  // "In the Library": every place the Fathers (and the other rich-text
  // works) cite this verse — page bodies and editor notes alike
  let cites = [];
  try { cites = await DB.getWorkRefs(bookNr, chapter, verse, 80); }
  catch { /* works.db predates work_refs */ }
  if (stale(gen) || !cites.length) return;
  const byWork = new Map();
  for (const c of cites) {
    if (!byWork.has(c.work_id)) byWork.set(c.work_id, { title: c.title, pages: c.pages, rows: [] });
    byWork.get(c.work_id).rows.push(c);
  }
  panel.append(el("p", "hint",
    `In the Library (${cites.length} place${cites.length === 1 ? "" : "s"} in ${byWork.size} work${byWork.size === 1 ? "" : "s"}):`));
  const lib = el("div", "occlist");
  for (const [workId, w] of byWork) {
    for (const c of w.rows) {
      const row = el("div", "occ");
      const where = [w.title, c.section, `p. ${c.page}`].filter(Boolean).join(" · ")
        + (c.note ? ` (note ${c.note})` : "");
      const link = el("a", null, where);
      link.href = "#";
      link.onclick = (e) => {
        e.preventDefault();
        const jump = c.note ? { note: c.note } : { ref: `${bookNr}.${chapter}.${verse}` };
        // wide screens: read the citation in the side pane, the verse stays put
        if (isWide()) { showWorkInPane(workId, c.page, w, jump); return; }
        panel.hidden = true;
        Object.assign(workState, { id: workId, page: c.page, title: w.title, pages: w.pages });
        saveWork();
        pendingWorkJump = jump;
        showView("work");
        renderWorkPage().then(() => { if (c.note) showWorkNote(c.note); });
      };
      row.append(link);
      lib.append(row);
    }
  }
  panel.append(lib);
}

// ------------------------------------------------------------------- search
// Strips combining marks: the regex range below contains literal (invisible)
// combining characters U+0300–U+036F (Greek accents) and U+0591–U+05C7
// (Hebrew cantillation + niqqud). Final sigma folds to sigma like Python casefold(); matches norm() in tools/build_db.py.
const normalize = (s) =>
  s.normalize("NFD").replace(/[̀-֑ͯ-ׇ]/g, "").toLowerCase().replace(/ς/g, 'σ');
// Older editions use æ/œ ligatures (Potamiæna, Cæsar) — expand each token to
// match both spellings so users can type plain "ae"/"oe".
const ftsQuery = (q) =>
  q.split(/\s+/).filter(Boolean).map((t) => {
    const clean = t.replace(/"/g, "");
    const forms = new Set([clean,
      clean.replace(/ae/gi, "æ"), clean.replace(/oe/gi, "œ"),
      clean.replace(/æ/gi, "ae"), clean.replace(/œ/gi, "oe")]);
    const quoted = [...forms].map((f) => `"${f}"`);
    return quoted.length > 1 ? `(${quoted.join(" OR ")})` : quoted[0];
  }).join(" AND ");

let currentView = "read";
let prevAskView = "read";   // where the Ask page's back button returns to
// Ask AI is a BETA feature, off by default (Settings -> Ask AI (beta)). Until
// the user turns it on nothing AI-related exists on the device: no Ask tab,
// no query embedder download, no vectors.db. The flag lives outside the
// reader state so a corrupt reader record can't silently enable it.
const AI_KEY = "atb-ai-beta";
const aiEnabled = () => {
  try { return localStorage.getItem(AI_KEY) === "1"; } catch { return false; }
};
let askBuilt = false;       // the Ask chrome is built once, on first enable
const workState = Object.assign(
  { id: null, page: 1, title: "", pages: 1 },
  loadJson("atb-work", {}));
// every book keeps its own bookmark: work_id -> last page read
const workPages = loadJson("atb-workpages", {});
const saveWork = () => {
  localStorage.setItem("atb-work", JSON.stringify(workState));
  if (workState.id != null) {
    workPages[workState.id] = workState.page;
    localStorage.setItem("atb-workpages", JSON.stringify(workPages));
  }
};

// Wide layout (desktop): the tab bar is a sidebar, panels open in a right
// pane (CSS under "wide layout"); the flag lives on <body> so CSS and the
// few JS decisions below agree.
const WIDE_MQ = window.matchMedia("(min-width: 1000px)");   // tablets landscape and up
const isWide = () => WIDE_MQ.matches;
function applyWide() {
  document.body.classList.toggle("wide", isWide());
  if (currentView) showView(currentView);   // bar visibility rules differ
}
WIDE_MQ.addEventListener("change", applyWide);
document.body.classList.toggle("wide", isWide());

function showView(view) {
  currentView = view;
  for (const [id, v] of [["#content", "read"], ["#searchview", "search"],
                         ["#bookpicker", "books"], ["#libraryview", "library"],
                         ["#workview", "work"], ["#settingsview", "settings"],
                         ["#askview", "ask"]]) {
    $(id).hidden = view !== v;
  }
  $("#topbar").hidden = view !== "read";   // text selectors only matter reading
  // the Ask page is a full chat screen: on phones the composer sits where the
  // tab bar was; on wide screens the sidebar stays
  $("#bottombar").hidden = view === "ask" && !isWide();
  if (view === "library") buildLibrary();  // refresh current-book markers
  $("#topbar").classList.remove("bar-hidden");
  $("#bottombar").classList.remove("bar-hidden");
  for (const a of document.querySelectorAll(".appbar"))
    a.classList.remove("bar-hidden");
  // pager applies where there are pages/chapters to turn
  $("#bottombar").querySelector(".pager").hidden =
    !(view === "read" || view === "work");
  const active = { read: "#tab-read", books: "#tab-read", work: "#tab-library",
                   library: "#tab-library", search: "#tab-search",
                   settings: "#tab-settings", ask: "#tab-ask" }[view];
  for (const t of document.querySelectorAll(".tab")) {
    t.classList.toggle("active", "#" + t.id === active);
    t.setAttribute("aria-selected", String("#" + t.id === active));
  }
  updatePager();
}

function updatePager() {
  if (currentView === "work" && workState.id) {
    $("#locbtn").textContent = `${workState.title} · ${workState.page}/${workState.pages}`;
    $("#prev").disabled = workState.page <= 1;
    $("#next").disabled = workState.page >= workState.pages;
  } else {
    const bookName = books.find((b) => b.nr === state.book)?.name ?? "";
    $("#locbtn").textContent = `${bookName} ${state.chapter}`;
    // prev/next disabled state for bible mode is set in go()
  }
}

// ----------------------------------------------------------------- library
function makeAppbar(title, onBack) {
  const bar = el("div", "appbar");
  if (onBack) {
    const back = el("button", "backbtn", "‹");
    back.setAttribute("aria-label", "Back");
    back.onclick = onBack;
    bar.append(back);
  }
  bar.append(el("h2", null, title));
  return bar;
}

// The Library mirrors the Bible picker: categories behave like books
// (accordion rows), works like chapters — but drawn as book SPINES on a
// shelf: tall boxes with the title as spine text and the series ID
// (ANF01, NPNF2-01...) as a small label, when the title carries one.
const SPINE_ID_RE = /^([A-Z]{2,6}[0-9]{0,3}(?:-[0-9]{1,3})?)\.\s+/;

let libraryGen = 0;
async function buildLibrary() {
  const view = $("#libraryview");
  view.innerHTML = "";
  view.append(makeAppbar("Library"));
  const gen = ++libraryGen;
  const works = await DB.getWorks();
  if (gen !== libraryGen) return;     // a newer build has taken over the view
  // reference shelf: the events timeline (people & places open from verses)
  const tl = el("button", "bookhead", "Timeline of Bible events");
  tl.onclick = showTimeline;
  const tlrow = el("div", "bookrow");
  tlrow.append(tl);
  view.append(tlrow);
  const mp = el("button", "bookhead", "Map of Bible places");
  mp.onclick = () => showMap();
  const mprow = el("div", "bookrow");
  mprow.append(mp);
  view.append(mprow);
  const an = el("button", "bookhead", "My notes & bookmarks");
  an.onclick = showAnnotations;
  const anrow = el("div", "bookrow");
  anrow.append(an);
  view.append(anrow);
  const cats = [];
  const byCat = new Map();
  for (const w of works) {
    if (!byCat.has(w.category)) {
      byCat.set(w.category, []);
      cats.push(w.category);
    }
    byCat.get(w.category).push(w);
  }
  let openShelf = null;
  for (const cat of cats) {
    const row = el("div", "bookrow");
    const head = el("button", "bookhead", cat);
    const hasCurrent = byCat.get(cat).some((w) => w.id === workState.id);
    if (hasCurrent) head.classList.add("here-book");
    // every work is its own download: tag the shelf with what is missing
    const shelfItems = byCat.get(cat).map(workItem).filter(Boolean);
    const missing = shelfItems.map(packById).filter((p) => p && !p.installed);
    if (missing.length)
      head.append(el("span", "packtag",
        `${missing.length} to download · ${fmtSize(missing.reduce((s, p) => s + p.gz_size, 0))}`));
    const makeShelf = () => {
      const shelf = el("div", "shelf");
      shelf.dataset.cat = cat;
      const note = el("p", "hint");
      const all = groupButton("Download the whole shelf", shelfItems, note);
      if (all) {
        const bar = el("div", "aidata compact");
        bar.append(all);
        shelf.append(bar, note);
      }
      for (const w of byCat.get(cat)) {
        const spine = el("button", "bookspine");
        const m = w.title.match(SPINE_ID_RE);
        spine.append(el("span", "btitle",
                        m ? w.title.slice(m[0].length) : w.title));
        if (m) spine.append(el("span", "bid", m[1]));
        if (w.id === workState.id) spine.classList.add("here");
        const item = workItem(w);
        if (item && !packInstalled(item)) {
          spine.classList.add("needs-pack");
          spine.append(el("span", "bid", `${fmtSize(packById(item)?.gz_size ?? 0)}`));
          spine.onclick = () => {
            // the download offer appears right under the tapped book
            shelf.querySelector(".workprompt")?.remove();
            const p = packPrompt(item, w.title, false);
            if (!p) return;
            p.classList.add("workprompt");
            spine.after(p);
          };
        } else {
          spine.onclick = () => openWork(w);
        }
        shelf.append(spine);
      }
      return shelf;
    };
    head.onclick = () => {
      if (openShelf?.dataset.cat === cat) {   // tap again: collapse
        openShelf.remove();
        openShelf = null;
        return;
      }
      openShelf?.remove();
      openShelf = makeShelf();
      row.append(openShelf);
      head.scrollIntoView({ block: "nearest" });
    };
    row.append(head);
    view.append(row);
    if (hasCurrent) {          // shelf holding the current book starts open
      openShelf = makeShelf();
      row.append(openShelf);
    }
  }
}

async function openWork(w) {
  if (workState.id !== w.id) {
    // reopen at the page this book was last read (per-book bookmark);
    // clamp — page counts shift when a volume's edition is upgraded
    Object.assign(workState, {
      id: w.id, page: Math.min(workPages[w.id] ?? 1, w.pages),
      title: w.title, pages: w.pages });
  } else {
    workState.title = w.title;
    workState.pages = w.pages;
  }
  saveWork();
  showView("work");
  await renderWorkPage();
}

// Rich work pages (ThML works): ⟦H⟧..⟦/H⟧ headings, ⟦I⟧..⟦/I⟧ italics,
// ⟦R|book.ch.verse⟧..⟦/R⟧ tappable scripture refs, ⟦N|n⟧ note anchors.
// Note text is NOT in the page — tapping fetches it into the bottom sheet.
const RICH_RE = /⟦(H|I|\/H|\/I)⟧|⟦R\|([\d.]+)⟧|⟦\/R⟧|⟦N\|(\d+)⟧/g;

async function showWorkNote(n) {
  const panel = sheet();
  const head = el("div", "sheet-head");
  head.append(el("h3", null, `Editor's note ${n}`));
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  const gen = sheetGen;
  const [row] = await DB.getWorkNote(workState.id, n);
  if (stale(gen)) return;
  const p = el("p", "def workbody");
  if (row?.rich) renderRichBody(p, row.rich);   // refs in notes stay tappable
  else p.textContent = row?.body ?? "(note unavailable)";
  panel.append(p);
  panel.hidden = false;
}

function renderRichBody(container, rich) {
  // the body renders pre-wrap, so blank lines are visible: never more than
  // one blank line in a row, and none around headings (they carry their own
  // margins) — the ThML source pads them generously
  rich = rich.replace(/\n{3,}/g, "\n\n")
    .replace(/\n+(⟦H⟧)/g, "\n$1").replace(/(⟦\/H⟧)\n+/g, "$1\n");
  const stack = [container];
  const top = () => stack[stack.length - 1];
  let last = 0;
  for (const m of rich.matchAll(RICH_RE)) {
    if (m.index > last) {
      top().append(document.createTextNode(rich.slice(last, m.index)));
    }
    last = m.index + m[0].length;
    const [, simple, refTarget, noteN] = m;
    if (simple === "H") {
      const h = el("h3", "wsec");
      container.append(h);          // headings always at top level
      stack.push(h);
    } else if (simple === "I") {
      const i = el("em");
      top().append(i);
      stack.push(i);
    } else if (simple === "/H" || simple === "/I") {
      const closed = stack.length > 1 ? stack.pop() : null;
      // the ThML editions often carry a section's title twice in a row (a
      // division title followed by the same heading): show it once
      if (simple === "/H" && closed) {
        const prev = closed.previousElementSibling;
        if (prev?.classList.contains("wsec") &&
            prev.textContent.trim() === closed.textContent.trim()) closed.remove();
      }
    } else if (refTarget) {
      const [b, c, v] = refTarget.split(".").map(Number);
      const a = el("a", "vref");
      a.href = "#";
      a.dataset.ref = refTarget;      // "43.3.16": jump target for verse-sheet links
      a.onclick = (e) => {
        e.preventDefault();
        // wide screens: the verse opens in the side pane and the work stays
        // in view (the mirror of reading a citation beside the reader)
        if (isWide() && currentView === "work") { showVerse(b, c, v); return; }
        $("#wordpanel").hidden = true;   // ref tapped inside a note sheet
        navigateTo(b, c, v);
      };
      top().append(a);
      stack.push(a);
    } else if (m[0] === "⟦/R⟧") {
      if (stack.length > 1) stack.pop();
    } else if (noteN) {
      const btn = el("button", "notebtn");
      btn.dataset.n = noteN;        // shown via CSS ::after — textContent
      btn.onclick = () => showWorkNote(+noteN);   // stays clean for search
      top().append(btn);
    }
  }
  if (last < rich.length) {
    top().append(document.createTextNode(rich.slice(last)));
  }
}

async function renderWorkPage() {
  const view = $("#workview");
  view.innerHTML = "";
  view.append(makeAppbar(workState.title, () => showView("library")));
  syncUrl();
  const [row] = await DB.getWorkPage(workState.id, workState.page);
  const body = el("div", "workbody");
  if (row?.rich) {
    renderRichBody(body, row.rich);
  } else {
    body.textContent = row?.body ?? "(empty page)";
  }
  view.append(body);
  // highlight / bookmark / note for this page live in a sheet: the pencil in
  // the app bar opens it (lit when the page already carries something), and
  // selecting text on the page offers "Note" with the selection quoted
  const annBtn = el("button", "iconbtn annopen");
  annBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 20h4l10.5-10.5a2 2 0 0 0-4-4L4 16v4z M13 7l4 4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  annBtn.setAttribute("aria-label", "Highlight, bookmark or note this page");
  annBtn.onclick = () => openWorkAnnotations();
  const bar = view.querySelector(".appbar");
  bar.append(el("span", "flexspace"), annBtn);
  ANN.get(ANN.workKey(workState.id, workState.page))
    .then((rec) => { if (rec && (rec.color || rec.bookmark || rec.note?.trim())) annBtn.classList.add("on"); })
    .catch(() => {});
  installSelectionChip(body);
  updatePager();
  // search-result jumps land on the matched LINE, highlighted
  const jump = pendingWorkJump;
  pendingWorkJump = null;
  if (jump?.term && highlightInBody(body, jump.term)) return;
  // verse-sheet jumps land on the scripture reference (or its note anchor)
  const target = (jump?.ref && body.querySelector(`[data-ref="${jump.ref}"]`))
    || (jump?.note && body.querySelector(`.notebtn[data-n="${jump.note}"]`));
  if (target) {
    target.classList.add("jumpref");
    target.scrollIntoView({ block: "center" });
    return;
  }
  window.scrollTo(0, 0);
}

// A Library page in the side pane (wide screens): the reader stays in view
// while a citation is read; page arrows walk the work, "Open in Library"
// hands over to the full view at the same page.
async function showWorkInPane(workId, page, w, jump = null) {
  const panel = sheet(true);
  const gen = sheetGen;
  const head = el("div", "sheet-head");
  const title = el("h3", null, w.title);
  head.append(title);
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  const nav = el("div", "annbar");
  const prev = el("button", "annbtn", "‹");
  const where = el("span", "pcstatus", `p. ${page} / ${w.pages}`);
  const next = el("button", "annbtn", "›");
  const open = el("button", "annbtn", "Open in Library");
  prev.disabled = page <= 1;
  next.disabled = page >= w.pages;
  prev.onclick = () => showWorkInPane(workId, page - 1, w);
  next.onclick = () => showWorkInPane(workId, page + 1, w);
  open.onclick = () => {
    panel.hidden = true;
    Object.assign(workState, { id: workId, page, title: w.title, pages: w.pages });
    saveWork();
    showView("work");
    renderWorkPage();
  };
  nav.append(prev, where, next, open);
  panel.append(nav);
  panel.hidden = false;
  const [row] = await DB.getWorkPage(workId, page);
  if (stale(gen)) return;
  const body = el("div", "workbody");
  if (row?.rich) renderRichBody(body, row.rich);
  else body.textContent = row?.body ?? "(this work is not downloaded)";
  panel.append(body);
  const target = (jump?.ref && body.querySelector(`[data-ref="${jump.ref}"]`))
    || (jump?.note && body.querySelector(`.notebtn[data-n="${jump.note}"]`));
  if (target) {
    target.classList.add("jumpref");
    target.scrollIntoView({ block: "center" });
  }
}

// The work page's annotation controls, as a sheet (quote = text to prefill
// into the note, from a selection)
async function openWorkAnnotations(quote = "") {
  const panel = sheet();
  const head = el("div", "sheet-head");
  head.append(el("h3", null, `${workState.title} · p. ${workState.page}`));
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  const slug = worksBySlug.get(workState.id);
  const share = slug ? shareButton(`/library/${slug}/${workState.page}`, workState.title) : null;
  panel.hidden = false;
  await annotationBar(panel, { kind: "work", key: ANN.workKey(workState.id, workState.page),
    workId: workState.id, page: workState.page, title: workState.title, pages: workState.pages },
    (rec) => $("#workview .annopen")?.classList.toggle("on", !!(rec.color || rec.bookmark || rec.note?.trim())),
    share);
  if (quote) {
    // open the note with the selection quoted, ready to type under it
    const nb = [...panel.querySelectorAll(".annbar .annbtn")].find((b) => /Note/.test(b.textContent));
    nb?.click();
    const ta = panel.querySelector("textarea.annnote");
    if (ta) {
      const q = quote.trim().replace(/\s+/g, " ");
      ta.value = (ta.value.trim() ? ta.value.trimEnd() + "\n\n" : "") + `> ${q}\n\n`;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }
}

// A floating "Note" chip while text is selected inside a Library page. Each
// rendered page gets its own chip + listener; the listener retires itself
// once that page's body has left the document.
function installSelectionChip(body) {
  document.querySelectorAll(".selchip").forEach((c) => c.remove());
  const chip = el("button", "selchip", "✎ Note this");
  chip.hidden = true;
  document.body.append(chip);
  const current = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
    const range = sel.getRangeAt(0);
    return body.contains(range.commonAncestorContainer) ? sel.toString() : "";
  };
  chip.onpointerdown = (e) => e.preventDefault();   // keep the selection alive
  chip.onclick = () => {
    const text = current();
    chip.hidden = true;
    openWorkAnnotations(text);
  };
  const update = () => {
    if (!document.body.contains(body) || !chip.isConnected) {
      chip.remove();
      document.removeEventListener("selectionchange", update);
      return;
    }
    chip.hidden = !current() || currentView !== "work";
  };
  document.addEventListener("selectionchange", update);
}

async function turnWorkPage(delta) {
  workState.page = Math.min(Math.max(1, workState.page + delta), workState.pages);
  saveWork();
  await renderWorkPage();
}

function buildSettings(counts) {
  const view = $("#settingsview");
  view.innerHTML = "";
  view.append(makeAppbar("Settings"));
  const card = el("div", "result-card");
  const title = el("p", null, "Library 422 — offline study");
  card.append(title);
  // single source of truth for the version: app/version.json (the Android
  // build stamps versionCode/versionName from it too)
  fetch("version.json", { cache: "no-store" }).then((r) => r.ok ? r.json() : null)
    .then((v) => { if (v?.version) title.textContent += ` · v${v.version} (${v.date})`; })
    .catch(() => {});
  card.append(el("p", "hint",
    "“For there is nothing hidden, except that it should be made known; " +
    "neither was anything made secret, but that it should come to light.” " +
    "— Mark 4:22 (WEB)"));
  card.append(el("p", "hint",
    `${counts.texts} Bible texts · ${counts.verses.toLocaleString()} verses · ` +
    `${counts.words.toLocaleString()} tagged words · ` +
    `${counts.library} library works`));
  card.append(el("p", "hint",
    "Everything runs on-device. Reading position, text choices, and library " +
    "position are remembered automatically."));
  view.append(card);

  // tagged-text display: plain / interlinear / reader's edition
  const disp = el("div", "result-card");
  disp.append(el("h3", null, "Greek & Hebrew display"));
  const modeSel = el("select");
  for (const [v, t] of [["plain", "Words only (tap for details)"],
                        ["interlinear", "Interlinear — gloss under every word"],
                        ["reader", "Reader's edition — gloss only rare words"]])
    modeSel.append(new Option(t, v));
  modeSel.value = state.tagMode ?? "plain";
  const rareSel = el("select");
  for (const n of [10, 20, 30, 50, 100, 200])
    rareSel.append(new Option(`words used fewer than ${n} times`, String(n)));
  rareSel.value = String(state.readerMax ?? 30);
  const rareLab = el("label", null, "Gloss ");
  rareLab.append(rareSel);
  rareLab.hidden = modeSel.value !== "reader";
  modeSel.onchange = () => {
    state.tagMode = modeSel.value;
    rareLab.hidden = modeSel.value !== "reader";
    saveState();
    renderChapter();
  };
  rareSel.onchange = () => {
    state.readerMax = Number(rareSel.value);
    saveState();
    renderChapter();
  };
  const modeLab = el("label", null, "Show ");
  modeLab.append(modeSel);
  disp.append(modeLab, rareLab, el("p", "hint",
    "Applies to the tagged Greek NT and Hebrew OT. Glosses are STEPBible's " +
    "in-context translations of each word. Dotted underlines mark words " +
    "that differ between the major Greek editions, or Hebrew Ketiv/Qere readings."));
  view.append(disp);

  view.append(buildDownloadsCard());
  view.append(buildAiCard());

  // sources and licences (public release requirement — see ROADMAP.md)
  const lic = el("div", "result-card");
  lic.append(el("h3", null, "Sources & licences"));
  lic.append(el("p", "hint",
    "Everything in this app is public domain or openly licensed. Nothing " +
    "leaves your device except, if you enable it, the optional Claude " +
    "provider in Ask (your question and the retrieved passages)."));
  const SOURCES = [
    ["Bible texts", "KJV, ASV, YLT, Tyndale, Douay-Rheims, Weymouth, Brenton / LXX2012, World English Bible (eBible.org), Berean Standard Bible, Textus Receptus, Westcott-Hort, Tischendorf, Septuagint, Westminster Leningrad Codex, Aleppo Codex, Clementine Vulgate, Peshitta", "public domain / CC0"],
    ["Word tagging, lexicons, names, morphology, versification", "STEPBible TAHOT / TAGNT, TBESH, LSJ (TFLSJ), TIPNR, TEGMC / TEHMC, TVTMS — Tyndale House Cambridge", "CC BY 4.0"],
    ["Strong's dictionaries", "openscriptures", "public domain"],
    ["Brown-Driver-Briggs Hebrew lexicon (1906)", "openscriptures HebrewLexicon XML edition", "text public domain; XML CC BY 4.0"],
    ["Abbott-Smith, Manual Greek Lexicon of the NT (1922)", "TEI edition", "public domain"],
    ["English dictionary", "Webster's 1913, WordNet 3.1 (Princeton)", "public domain / WordNet licence"],
    ["Cross-references", "OpenBible.info", "CC BY"],
    ["People, places, events, timeline", "Theographic Bible Metadata (viz.bible)", "CC BY-SA 4.0"],
    ["Easton's Bible Dictionary (1897)", "via Theographic", "public domain"],
    ["Library", "Ante-Nicene, Nicene and Post-Nicene Fathers, Aquinas (CCEL editions); Josephus (Whiston), Philo (Yonge), Enoch (Charles), Apostolic Fathers (Project Gutenberg)", "public domain"],
    ["Software", "SQLite WASM, transformers.js + ONNX Runtime (Apache-2.0), all-MiniLM-L6-v2 (Apache-2.0), MediaPipe (Apache-2.0), Capacitor (MIT)", "open source"],
    ["Library 422 itself", "the app's code — github.com/JacobSlattery/library422", "MIT (the texts and data above keep their own terms)"],
  ];
  const dl2 = el("dl");
  for (const [what, who, lic2] of SOURCES) {
    dl2.append(el("dt", null, what), el("dd", null, `${who} — ${lic2}`));
  }
  lic.append(dl2);
  lic.append(el("p", "hint",
    "Data from STEPBible is used under CC BY 4.0 and may be obtained from " +
    "github.com/STEPBible. Theographic data is CC BY-SA 4.0; the derived " +
    "people/places/events tables in this app carry the same licence."));
  view.append(lic);
}

// ------------------------------------------------------- book/chapter picker
let chapterCounts = new Map();   // book_nr -> chapter count (kjv baseline)
let apocBooks = [];              // [{nr, name, chapters}] beyond the 66
let apocTexts = new Map();       // nr -> Set(text_ids that carry it)

// After a jump, make sure the selected texts can actually show the book —
// apocryphal books need kjva/lxxen/lxx, canonical ones fall back to KJV.
async function ensureReadable(bookNr, chapter) {
  if (document.querySelector(".verse-row")) return;
  let patch;
  if (bookNr > 66) {
    const have = apocTexts.get(bookNr) ?? new Set();
    const engl = ["kjva", "lxxen"].find((t) => have.has(t)) ?? "lxx";
    const second = engl !== "lxx" && have.has("lxx") ? "lxx"
      : engl !== "kjva" && have.has("kjva") ? "kjva" : "none";
    patch = { textA: engl, textB: second };
  } else {
    patch = { textA: "web", textB: "ylt" };
  }
  await go({ ...patch, book: bookNr, chapter });
}

function buildBookPicker() {
  const picker = $("#bookpicker");
  picker.innerHTML = "";
  const bar = el("div", "appbar");
  const back = el("button", "backbtn", "‹");
  back.setAttribute("aria-label", "Back to reading");
  back.onclick = () => showView("read");
  bar.append(back, el("h2", null, "Books"));
  picker.append(bar);
  let openGrid = null;
  const groups = [
    ["Old Testament", books.filter((b) => b.nr <= 39)],
    ["New Testament", books.filter((b) => b.nr >= 40)],
    ["Apocrypha", apocBooks],
  ];
  for (const [label, list] of groups) {
    if (!list.length) continue;
    picker.append(el("h3", "pickgroup", label));
    for (const b of list) {
      const row = el("div", "bookrow");
      const head = el("button", "bookhead", b.name);
      if (b.nr === state.book) head.classList.add("here-book");
      head.onclick = () => {
        if (openGrid?.dataset.book === String(b.nr)) {  // tap again: collapse
          openGrid.remove(); openGrid = null; return;
        }
        openGrid?.remove();
        const grid = el("div", "chgrid");
        grid.dataset.book = String(b.nr);
        const n = b.chapters ?? chapterCounts.get(b.nr) ?? 1;
        for (let c = 1; c <= n; c++) {
          const box = el("button", "chbox", String(c));
          if (b.nr === state.book && c === state.chapter) box.classList.add("here");
          box.onclick = async () => {
            showView("read");
            await go({ book: b.nr, chapter: c });
            await ensureReadable(b.nr, c);
          };
          grid.append(box);
        }
        row.append(grid);
        openGrid = grid;
        head.scrollIntoView({ block: "nearest" });
      };
      row.append(head);
      picker.append(row);
    }
  }
}

function openBookPicker() {
  const opening = $("#bookpicker").hidden;
  if (!opening) { showView("read"); return; }
  buildBookPicker();                      // container is shared with work picker
  showView("books");
  $("#bookpicker").querySelector(".here-book")
    ?.scrollIntoView({ block: "center" });
}

// The same picker paradigm for a Library work: detected sections behave like
// books; the pages of a section like chapters.
async function openWorkPicker() {
  const picker = $("#bookpicker");
  picker.innerHTML = "";
  picker.append(makeAppbar(workState.title, () => showView("work")));
  const sections = await DB.getWorkSections(workState.id);
  let openGrid = null;

  const pageGrid = (from, to) => {
    const grid = el("div", "chgrid");
    for (let p = from; p <= to; p++) {
      const box = el("button", "chbox", String(p));
      if (p === workState.page) box.classList.add("here");
      box.onclick = async () => {
        workState.page = p;
        saveWork();
        showView("work");
        await renderWorkPage();
      };
      grid.append(box);
    }
    return grid;
  };

  if (!sections.length) {
    picker.append(el("p", "hint", "Pages"));
    picker.append(pageGrid(1, workState.pages));
  } else {
    // current section = the last one starting at or before the current page
    let hereIdx = 0;
    sections.forEach((s, i) => { if (s.page <= workState.page) hereIdx = i; });
    sections.forEach((s, i) => {
      const row = el("div", "bookrow");
      const head = el("button", "bookhead", s.title);
      if (i === hereIdx) head.classList.add("here-book");
      head.onclick = () => {
        if (openGrid?.dataset.sec === String(i)) {
          openGrid.remove(); openGrid = null; return;
        }
        openGrid?.remove();
        const to = i + 1 < sections.length
          ? Math.max(s.page, sections[i + 1].page - 1) : workState.pages;
        const grid = pageGrid(s.page, to);
        grid.dataset.sec = String(i);
        row.append(grid);
        openGrid = grid;
        head.scrollIntoView({ block: "nearest" });
      };
      row.append(head);
      picker.append(row);
    });
  }
  showView("books");
  // picking within a Library work: the Library tab is the honest highlight
  $("#tab-read").classList.remove("active");
  $("#tab-library").classList.add("active");
  picker.querySelector(".here-book")?.scrollIntoView({ block: "center" });
}

// ------------------------------------------------------------- deep links
// Shareable paths: /read/<book>/<chapter>[/<verse>], /library/<work>/<page>,
// /word/<strongs>. The host serves the shell for any such path (Cloudflare
// single-page fallback, dev_server.py SpaFallback) and <base href="/"> keeps
// relative assets rooted. The URL is kept in step as the user navigates
// (replaceState — no history spam, back leaves the app as before). Only on
// http(s): the APK and the desktop edition load from their own schemes.
const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const urlRouting = () => /^https?:$/.test(location.protocol) &&
  !/\/index\.html$/.test(location.pathname);
function parseRoute(pathname) {
  const parts = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "read" && parts[1]) {
    const slug = slugOf(parts[1]);
    const book = [...books, ...apocBooks].find((b) => slugOf(b.name) === slug)
      ?? books.find((b) => b.nr === Number(parts[1]));
    if (!book) return null;
    return { view: "read", book: book.nr, chapter: Number(parts[2]) || 1,
             verse: Number(parts[3]) || 0 };
  }
  if (parts[0] === "library" && parts[1])
    return { view: "work", slug: parts[1], page: Number(parts[2]) || 1 };
  if (parts[0] === "word" && /^[GH]\d{1,5}$/i.test(parts[1] ?? ""))
    return { view: "word", strongs: parts[1].toUpperCase() };
  if (parts[0] === "search" && parts[1])
    return { view: "search", q: parts.slice(1).join(" ").slice(0, 200) };
  return null;
}
function syncUrl() {
  if (!urlRouting()) return;
  let path = "/";
  if (currentView === "read") {
    const name = [...books, ...apocBooks].find((b) => b.nr === state.book)?.name;
    if (name) path = `/read/${slugOf(name)}/${state.chapter}`;
  } else if (currentView === "work" && workState.id) {
    const slug = worksBySlug.get(workState.id);
    if (slug) path = `/library/${slug}/${workState.page}`;
  } else {
    return;                                   // other views keep the last URL
  }
  if (location.pathname !== path) {
    try { history.replaceState(null, "", path); } catch { /* ignore */ }
  }
}
const worksBySlug = new Map();   // work id -> slug (for URLs); filled at boot

// "Copy link" for a deep-link path: the public app address on the web, or the
// live origin on a local build; uses the share sheet where phones have one.
// Returns null where links make no sense (the desktop edition's app:// scheme).
const PUBLIC_APP = "https://app.library422.org";
function shareButton(path, title) {
  if (!/^https?:$/.test(location.protocol) && !window.Capacitor) return null;
  const url = (/^https?:$/.test(location.protocol) && !/localhost|127\.0\.0\.1/.test(location.host)
    ? location.origin : PUBLIC_APP) + path;
  const b = el("button", "annbtn", "Link");
  b.title = url;
  b.onclick = async () => {
    try {
      if (navigator.share && window.Capacitor) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url);
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Link"; }, 1800);
    } catch {
      window.prompt("Link to this passage:", url);
    }
  };
  return b;
}
async function openRoute(route) {
  if (!route) return false;
  if (route.view === "read") {
    await navigateTo(route.book, route.chapter, route.verse || undefined);
    return true;
  }
  if (route.view === "work") {
    const works = await DB.getWorks();
    const w = works.find((x) => x.slug === route.slug);
    if (!w) return false;
    // the link names the page: it wins over the per-book bookmark
    Object.assign(workState, { id: w.id, title: w.title, pages: w.pages,
                               page: Math.min(Math.max(1, route.page), w.pages) });
    saveWork();
    showView("work");
    await renderWorkPage();
    return true;
  }
  if (route.view === "search") {
    await go({});                     // the reader is ready behind the search
    showView("search");
    $("#q").value = route.q;
    $("#gobtn").click();
    return true;
  }
  if (route.view === "word") {
    showView("read");
    await go({});
    const panel = sheet(true);
    const head = el("div", "sheet-head");
    head.append(el("h3", null, route.strongs));
    const close = el("button", "close", "✕");
    close.onclick = () => { panel.hidden = true; };
    head.append(close);
    panel.append(head);
    panel.hidden = false;
    await showConcordance(route.strongs, panel);
    return true;
  }
  return false;
}

async function navigateTo(bookNr, chapter, verse) {
  showView("read");
  await go({ book: bookNr, chapter });
  // if the selected texts have nothing for this book, switch to ones that do
  await ensureReadable(bookNr, chapter);
  if (verse) {
    const row = document.querySelector(`.verse-row[data-verse="${verse}"]`);
    if (row) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("flash");
      setTimeout(() => row.classList.remove("flash"), 2500);
    }
  }
}

// Occurrence list in pages: `total` known up front, "Show more" fetches the
// next `size` rows (a common word has 20k occurrences — never all at once).
async function concordancePage(list, strongs, total, offset, size, onPick) {
  const rows = await DB.getConcordance(strongs, size, offset);
  for (const o of rows) {
    const row = el("div", "occ");
    const link = el("a", null, `${o.book} ${o.chapter}:${o.verse}`);
    link.href = "#";
    link.onclick = (e) => { e.preventDefault(); onPick(o); };
    row.append(link, el("span", null, ` — ${o.surface} — ${o.gloss ?? ""}`));
    list.append(row);
  }
  const shown = offset + rows.length;
  if (shown < total && rows.length === size) {
    const more = el("button", null, `Show more (${shown.toLocaleString()} of ${total.toLocaleString()})`);
    more.onclick = async () => {
      more.disabled = true;
      more.remove();
      await concordancePage(list, strongs, total, shown, size, onPick);
    };
    list.append(more);
  }
}

async function showConcordance(strongs, container) {
  container.innerHTML = "";
  const [entry] = await DB.getLexicon(strongs);
  const [{ n }] = await DB.getOccurrenceCount(strongs);
  const card = el("div", "result-card");
  const h3 = el("h3", null,
    `${entry?.lemma ?? strongs} ${entry?.translit ? `(${entry.translit})` : ""} — ${strongs}`);
  card.append(h3);
  if (entry?.lemma) {
    speakBtn(entry.lemma).then((b) => b && h3.append(b));
  }
  if (entry?.definition) card.append(el("p", "def", entry.definition));
  if (entry?.kjv_usage) card.append(el("p", "kjv", "KJV: " + entry.kjv_usage));
  await lexiconSections(strongs, card);
  card.append(el("p", "hint", `${n} occurrence${n === 1 ? "" : "s"}:`));
  const list = el("div", "occlist tall");
  await concordancePage(list, strongs, n, 0, 300, (o) => navigateTo(o.book_nr, o.chapter, o.verse));
  card.append(list);
  container.append(card);
}

// Search snippets: FTS marks hits with ‹›; render them as bold instead of
// showing the raw markers.
function snipEl(text) {
  const div = el("div", "snip");
  text.replace(/<[^<>\s]{1,8}>/g, "")     // strip source formatting markers
    .split(/‹([^›]*)›/)
    .forEach((part, i) => {
      if (!part) return;
      div.append(i % 2 ? el("b", null, part)
                       : document.createTextNode(part));
    });
  return div;
}

// Exact-phrase FTS queries for the whole search string (ligature variants).
function phraseQueries(q) {
  const base = q.replace(/"/g, "").trim();
  if (!base) return [];
  const forms = new Set([base,
    base.replace(/ae/gi, "æ"), base.replace(/oe/gi, "œ"),
    base.replace(/æ/gi, "ae"), base.replace(/œ/gi, "oe")]);
  return [...forms].map((f) => `"${f}"`);
}

// After a search tap, the work page scrolls to and highlights the matched
// text (the bible side gets this via navigateTo's verse flash).
let pendingWorkJump = null;

// Fold text for matching: lowercase, whitespace runs -> single space,
// æ/œ -> ae/oe, curly quotes -> straight, OCR line-break hyphens removed —
// with an index map back into the ORIGINAL string, because page bodies are
// hard-wrapped mid-sentence and a plain indexOf can never match a phrase
// that spans a line break.
function foldWithMap(text) {
  const folded = [];
  const map = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      const start = i;
      while (i < text.length && /\s/.test(text[i])) i++;
      folded.push(" ");
      map.push(start);
      continue;
    }
    if (ch === "-" && /\s/.test(text[i + 1] ?? "")) {   // OCR hyphenation
      i++;
      while (i < text.length && /\s/.test(text[i])) i++;
      continue;
    }
    let c = ch.toLowerCase();
    if (c === "’" || c === "‘") c = "'";
    else if (c === "“" || c === "”") c = '"';
    if (c === "æ") { folded.push("a", "e"); map.push(i, i); }
    else if (c === "œ") { folded.push("o", "e"); map.push(i, i); }
    else { folded.push(c); map.push(i); }
    i++;
  }
  return { folded: folded.join(""), map };
}

function highlightInBody(body, term) {
  // works across rich (multi-node) pages: fold the concatenated text nodes,
  // map matches back to (node, offset), wrap with a Range
  const textNodes = [];
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  if (!textNodes.length) return false;
  const segStarts = [];
  let text = "";
  for (const tn of textNodes) {
    segStarts.push(text.length);
    text += tn.nodeValue;
  }
  const { folded, map } = foldWithMap(text);
  // full phrase, then progressively shorter prefixes, then the first
  // substantial word — best-effort landing beats top-of-page
  const words = foldWithMap(term).folded.trim().split(" ").filter(Boolean);
  const candidates = [];
  if (words.length) candidates.push(words.join(" "));
  if (words.length > 3) candidates.push(words.slice(0, 3).join(" "));
  const big = words.find((w) => w.length > 3);
  if (big) candidates.push(big);
  const locate = (gidx) => {
    let lo = 0;
    let hi = segStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segStarts[mid] <= gidx) lo = mid; else hi = mid - 1;
    }
    return [textNodes[lo], gidx - segStarts[lo]];
  };
  for (const cand of candidates) {
    const pos = folded.indexOf(cand);
    if (pos < 0) continue;
    const start = map[pos];
    const end = map[pos + cand.length - 1] + 1;
    const [nA, oA] = locate(start);
    const [nB, oBRaw] = locate(end - 1);
    const mark = el("mark", "hitmark");
    const range = document.createRange();
    range.setStart(nA, oA);
    range.setEnd(nB, oBRaw + 1);
    try {
      range.surroundContents(mark);
    } catch {
      // match crosses element boundaries — clamp to the start node
      const r2 = document.createRange();
      r2.setStart(nA, oA);
      r2.setEnd(nA, nA.nodeValue.length);
      try { r2.surroundContents(mark); } catch { return false; }
    }
    requestAnimationFrame(() =>
      mark.scrollIntoView({ block: "center" }));
    return true;
  }
  return false;
}

// Enter and the Go button can both fire; every await below re-checks that
// this run still owns #results so two searches never interleave rows.
let searchGen = 0;
async function runSearch() {
  const q = $("#q").value.trim();
  if (!q) return;
  const results = $("#results");
  const gen = ++searchGen;
  const mine = () => gen === searchGen;
  results.innerHTML = "";
  results.append(el("p", "hint", "Searching…"));
  const textFilter = $("#ftstext").value || null;

  const strongsMatch = q.match(/^([gh])\s*0*(\d{1,4})$/i);
  const isOriginal = /[Ͱ-Ͽἀ-῿֐-׿]/.test(q);

  results.innerHTML = "";
  try {
    if (strongsMatch) {
      const id = strongsMatch[1].toUpperCase() + strongsMatch[2].padStart(4, "0");
      await showConcordance(id, results);
      return;
    }

    if (isOriginal) {
      const entries = await DB.searchLexicon(normalize(q));
      if (!mine()) return;
      if (!entries.length) {
        results.append(el("p", "hint", "No lexicon matches."));
        return;
      }
      renderLexiconList(entries, results);
      return;
    }

    // people and places whose name is the query
    try {
      const ents = await DB.findEntitiesByName(q.toLowerCase().replace(/[^\p{L}'’ -]/gu, "").trim(), 8);
      if (!mine()) return;
      if (ents.length) {
        results.append(el("p", "hint", "People & places:"));
        for (const e of ents)
          results.append(entityLink(e.kind, e.id, e.name,
            [e.description, e.verse_count ? `${e.verse_count} verses` : ""].filter(Boolean).join(" · ")));
      }
    } catch { /* no graph tables */ }

    // English (or transliteration): exact phrase first, then lexicon +
    // word-based matches (dupes of the exact section are skipped)
    const seenV = new Set();
    const seenW = new Set();
    const verseRow = (r) => {
      seenV.add(`${r.text_id}:${r.book_nr}:${r.chapter}:${r.verse}`);
      const row = el("div", "occ");
      const link = el("a", null, `${r.book} ${r.chapter}:${r.verse} · ${labelOf(r.text_id)}`);
      link.href = "#";
      link.onclick = (e) => {
        e.preventDefault();
        navigateTo(r.book_nr, r.chapter, r.verse);
      };
      row.append(link, snipEl(r.snip));
      return row;
    };
    const workRow = (r, jumpTerm) => {
      seenW.add(`${r.work_id}:${r.page}`);
      const row = el("div", "occ");
      const cite = [r.title, r.section, `p. ${r.page}`]
        .filter(Boolean).join(" · ");
      const link = el("a", null, cite);
      link.href = "#";
      link.onclick = (e) => {
        e.preventDefault();
        Object.assign(workState,
          { id: r.work_id, page: r.page, title: r.title, pages: r.pages });
        saveWork();
        // land on the matched line, not just the page
        pendingWorkJump = { term: jumpTerm ??
          (r.snip.match(/‹([^›]*)›/)?.[1] ?? "") };
        showView("work");
        renderWorkPage();
      };
      row.append(link, snipEl(r.snip));
      return row;
    };

    if (q.split(/\s+/).length >= 2) {
      const phraseQ = phraseQueries(q).join(" OR ");
      let ev = [];
      let ew = [];
      try { ev = await DB.searchText(phraseQ, textFilter, 20); } catch {}
      try { ew = await DB.searchWorks(phraseQ, 20); } catch {}
      if (!mine()) return;
      if (ev.length || ew.length) {
        results.append(el("p", "hint", "Exact matches:"));
        for (const r of ev) results.append(verseRow(r));
        for (const r of ew) results.append(workRow(r, q));
      }
    }

    const entries = await DB.searchLexicon(normalize(q), 8);
    if (!mine()) return;
    if (entries.length) {
      results.append(el("p", "hint", "Lexicon matches:"));
      renderLexiconList(entries, results);
    }
    results.append(el("p", "hint", "Verses:"));
    const verses = (await DB.searchText(ftsQuery(q), textFilter))
      .filter((r) => !seenV.has(`${r.text_id}:${r.book_nr}:${r.chapter}:${r.verse}`));
    if (!mine()) return;
    if (!verses.length) results.append(el("p", "hint", "No verse matches."));
    for (const r of verses) results.append(verseRow(r));

    // Library works, cited by section + page
    results.append(el("p", "hint", "Library:"));
    const wres = (await DB.searchWorks(ftsQuery(q)))
      .filter((r) => !seenW.has(`${r.work_id}:${r.page}`));
    if (!mine()) return;
    if (!wres.length) results.append(el("p", "hint", "No library matches."));
    for (const r of wres) results.append(workRow(r));
    // search only sees what is on the device: say so when the catalog isn't complete
    const missingTexts = packs.filter((p) => p.kind === "text" && !p.installed && p.available).length;
    const missingWorks = packs.filter((p) => p.kind === "work" && !p.installed && p.available).length;
    if (missingTexts || missingWorks) {
      const note = el("p", "hint");
      const parts = [];
      if (missingTexts) parts.push(`${missingTexts} Bible text${missingTexts === 1 ? "" : "s"}`);
      if (missingWorks) parts.push(`${missingWorks} Library work${missingWorks === 1 ? "" : "s"}`);
      note.append(`Search covers what is on this device — ${parts.join(" and ")} not downloaded. `);
      const a = el("a", null, "Open the Catalog");
      a.href = "#";
      a.onclick = (e) => { e.preventDefault(); showView("settings"); $("#downloads")?.scrollIntoView({ block: "start" }); };
      note.append(a);
      results.append(note);
    }

    // Editor notes: EXCLUDED from everything unless the user opts in here
    if ($("#notesearch").checked) {
      results.append(el("p", "hint", "Editor notes:"));
      let nres = [];
      try { nres = await DB.searchWorkNotes(ftsQuery(q)); } catch {}
      if (!mine()) return;
      if (!nres.length) results.append(el("p", "hint", "No note matches."));
      for (const r of nres) {
        const row = el("div", "occ");
        const link = el("a", null,
          `${r.title} · note ${r.n} · p. ${r.page}`);
        link.href = "#";
        link.onclick = (e) => {
          e.preventDefault();
          Object.assign(workState,
            { id: r.work_id, page: r.page, title: r.title, pages: r.pages });
          saveWork();
          showView("work");
          renderWorkPage().then(() => showWorkNote(r.n));
        };
        row.append(link, snipEl(r.snip));
        results.append(row);
      }
    }
  } catch (e) {
    results.append(el("p", "hint", "Search error: " + e.message));
  }
}

function renderLexiconList(entries, container) {
  for (const entry of entries) {
    const row = el("div", "occ");
    const link = el("a", null,
      `${entry.lemma} ${entry.translit ? `(${entry.translit})` : ""} — ${entry.strongs}`);
    link.href = "#";
    link.onclick = async (e) => {
      e.preventDefault();
      await showConcordance(entry.strongs, container);
      window.scrollTo(0, 0);
    };
    row.append(link);
    if (entry.definition)
      row.append(el("div", "snip", entry.definition.slice(0, 140)));
    container.append(row);
  }
}

// ------------------------------------------------------------------- reader
// Versification: texts whose numbering differs from the English (Hebrew
// psalm titles, LXX psalm/Jeremiah numbering, Latin psalms...) are fetched
// through verse_map so every row of the reader lines up with the canonical
// verse numbers. No map row = same key. The map is per text, chosen at build
// time by testing each edition against STEPBible's versification tests.
const textTradition = new Map();            // text_id -> numbering column name
const mappedTexts = new Set();              // text_ids that have any map rows
const traditionsFor = (textId) => (mappedTexts.has(textId) ? textId : null);

// canonical chapter -> Map(verse -> {verse, body}) for a mapped text
async function mappedChapter(textId, bookNr, chapter) {
  const plain = await DB.getChapter(textId, bookNr, chapter);
  const out = new Map(plain.map((r) => [r.verse, { verse: r.verse, body: r.body }]));
  if (!mappedTexts.has(textId)) return out;
  let rows = [];
  try { rows = await DB.getChapterMap(textId, bookNr, chapter); } catch { return out; }
  if (!rows.length) return out;
  const byVerse = new Map();
  for (const r of rows) {
    if (!byVerse.has(r.verse)) byVerse.set(r.verse, []);
    byVerse.get(r.verse).push(r);
  }
  const keys = [];
  for (const list of byVerse.values())
    for (const r of list) if (r.part !== "absent") keys.push([r.t_book_nr, r.t_chapter, r.t_verse]);
  const fetched = new Map();
  if (keys.length) {
    for (const r of await DB.getVersesByKeys(textId, keys))
      fetched.set(`${r.book_nr}.${r.chapter}.${r.verse}`, r.body);
  }
  // verses whose canonical number is only a target of a mapping (e.g. the
  // Hebrew title, canonical verse 0) must not also appear under their own
  // number: drop identity rows that some mapping claims
  const claimed = new Set();
  for (const list of byVerse.values())
    for (const r of list)
      if (r.t_book_nr === bookNr && r.t_chapter === chapter) claimed.add(r.t_verse);
  for (const v of claimed) if (!byVerse.has(v)) out.delete(v);
  for (const [v, list] of byVerse) {
    if (list[0].part === "absent") { out.delete(v); continue; }
    const body = list.map((r) => fetched.get(`${r.t_book_nr}.${r.t_chapter}.${r.t_verse}`))
      .filter(Boolean).join(" ");
    if (body) out.set(v, { verse: v, body }); else out.delete(v);
  }
  // a Psalm title (canonical verse 0) rides along with verse 1
  if (out.has(0)) {
    const title = out.get(0).body;
    out.delete(0);
    const v1 = out.get(1);
    out.set(1, { verse: 1, body: v1 ? `${title} ${v1.body}` : title });
  }
  return out;
}

// which books each text contains (text_books, every text whether downloaded
// or not); tagged readers cover a testament each
const textBooks = new Map();   // text_id -> Set(book_nr)
function textHasBook(textId, bookNr) {
  if (isTagged(textId)) {
    const [lo, hi] = TAGGED[textId].books;
    return bookNr >= lo && bookNr <= hi;
  }
  const set = textBooks.get(textId);
  return set ? set.has(bookNr) : true;      // unknown: don't claim otherwise
}
function coverageNotice(textId, bookNr) {
  if (textHasBook(textId, bookNr)) return null;
  const name = books.find((b) => b.nr === bookNr)?.name ?? `book ${bookNr}`;
  const box = el("div", "aidata packnotice");
  const set = isTagged(textId)
    ? new Set(books.filter((b) => textHasBook(textId, b.nr)).map((b) => b.nr))
    : textBooks.get(textId);
  const nrs = [...set].sort((a, b) => a - b);
  const bookName = (nr) => books.find((b) => b.nr === nr)?.name ?? apocBooks.find((b) => b.nr === nr)?.name ?? "";
  const hasOT = nrs.some((n) => n <= 39);
  const hasNT = nrs.some((n) => n >= 40 && n <= 66);
  const hasApoc = nrs.some((n) => n > 66);
  let span = "";
  if (hasOT && !hasNT) span = "the Old Testament" + (hasApoc ? " and Apocrypha" : "");
  else if (hasNT && !hasOT) span = "the New Testament";
  else if (nrs.length) span = `${bookName(nrs[0])} to ${bookName(nrs[nrs.length - 1])} (${nrs.length} books)`;
  const lang = langOf(textId);
  const alt = [...Object.keys(TAGGED), ...textIds]
    .filter((t) => t !== textId && langOf(t) === lang && textHasBook(t, bookNr))
    .map(labelOf);
  box.append(el("span", "pcstatus",
    `${labelOf(textId)} doesn't include ${name}` + (span ? ` — it covers ${span}.` : ".") +
    (alt.length ? ` For ${name} in the same language try: ${alt.join(", ")}.` : "")));
  return box;
}

async function chapterVerses(textId) {
  if (!isTagged(textId)) {
    return mappedChapter(textId, state.book, state.chapter);
  }
  const [lo, hi] = TAGGED[textId].books;
  if (state.book < lo || state.book > hi) return new Map();
  const words = await DB.getChapterWords(state.book, state.chapter);
  const byVerse = new Map();
  for (const w of words) {
    if (!w.surface) continue;
    if (!byVerse.has(w.verse)) byVerse.set(w.verse, { verse: w.verse, words: [] });
    byVerse.get(w.verse).words.push(w);
  }
  return byVerse;
}

// getBible inline markers, rendered not stripped (owner preference):
// <FI>..<Fi> italics (translator-supplied words), <FR>..<Fr> words of Christ
// (red letter), <FO>..<Fo> OT quotation. Other markers (<CM>, <CL>, <PB>...)
// are layout hints and render as nothing.
const TAG_CLASS = { FI: "added", FR: "redletter", FO: "otquote" };

// ctx = {textId, bookNr, chapter, verse} lets an English-word tap look up the
// original word behind it (verse_words). `pos` counts whitespace-separated
// tokens of the marker-stripped body — a marker glued to a word ("<FR>Word,")
// must NOT split the token, so the counter only advances after whitespace.
// `initial` = markers still open from the previous verse (Weymouth opens
// <FO> in one verse and closes it in the next); the open set is returned so
// the caller can carry it forward.
function renderBody(line, body, tappableWords, ctx = null, initial = null) {
  const active = new Set(initial ?? []);
  let pos = -1, inToken = false;
  for (const part of body.split(/(<[^<>\s]{1,8}>)/)) {
    const m = part.match(/^<([A-Za-z]{2,8})>$/);
    if (m) {
      const cls = TAG_CLASS[m[1].toUpperCase()];
      if (cls) {
        if (m[1] === m[1].toUpperCase()) active.add(cls);
        else active.delete(cls);
      }
      continue;
    }
    if (!part) continue;
    const classes = [...active].join(" ");
    if (tappableWords) {
      const original = tappableWords === "original";
      for (const tok of part.split(/(\s+)/)) {
        if (/\S/.test(tok)) {
          if (!inToken) { pos++; inToken = true; }
          const at = pos;
          const w = el("span", ("eword " + classes).trim(), tok);
          line.append(tappable(w, () =>
            original ? showOriginalWord(tok) : showEnglishWord(tok, ctx, at)));
        } else {
          if (tok) inToken = false;
          line.append(document.createTextNode(tok));
        }
      }
    } else if (classes) {
      line.append(el("span", classes, part));
    } else {
      line.append(document.createTextNode(part));
    }
  }
  return active;
}

// ---- textual variants (edition comparison) ---------------------------------
// TAGNT records which editions carry each NT word (NA28, NA27, Tyndale
// House, SBL, WH, Tregelles, TR, Byzantine); TAHOT marks Ketiv/Qere with K/Q.
const MAJOR_EDITIONS = ["NA28", "SBL", "TR", "Byz", "WH"];
const EDITION_NAMES = {
  NA28: "Nestle-Aland 28", NA27: "Nestle-Aland 27", Tyn: "Tyndale House GNT",
  SBL: "SBL GNT", WH: "Westcott-Hort", Treg: "Tregelles", TR: "Textus Receptus",
  Byz: "Byzantine (Robinson-Pierpont)", KJV: "KJV underlying text",
};
function editionsOf(w) {
  if (!w.editions) return null;
  return w.editions.split("+").map((e) => e.replace(/[^A-Za-z0-9]/g, ""));
}
function isVariantWord(w) {
  const eds = editionsOf(w);
  if (eds) return MAJOR_EDITIONS.some((e) => !eds.includes(e));
  return /[KQ]/.test(w.variant ?? "") && !/^L$/.test(w.variant ?? "");
}
function variantRow(dl, w) {
  const eds = editionsOf(w);
  if (eds) {
    const missing = MAJOR_EDITIONS.filter((e) => !eds.includes(e));
    if (!missing.length) return;
    dl.append(el("dt", null, "Editions"),
      el("dd", null, `In ${eds.map((e) => EDITION_NAMES[e] ?? e).join(", ")}. ` +
        `Not in ${missing.map((e) => EDITION_NAMES[e] ?? e).join(", ")}.`));
    return;
  }
  const v = w.variant ?? "";
  if (/K/.test(v) && !/Q/.test(v)) dl.append(el("dt", null, "Reading"), el("dd", null, `Ketiv (written form) — ${v}`));
  else if (/Q/.test(v)) dl.append(el("dt", null, "Reading"), el("dd", null, `Qere (read form) — ${v}`));
}

// corpus frequency per Strong's code, filled per chapter for reader's mode
const strongsFreq = new Map();
async function primeStrongsFreq(maps) {
  const want = new Set();
  for (const m of maps) {
    for (const d of m.values()) {
      for (const w of d.words ?? []) {
        if (w.strongs && !strongsFreq.has(w.strongs)) want.add(w.strongs);
      }
    }
  }
  if (!want.size) return;
  try {
    for (const r of await DB.getStrongsCounts([...want])) strongsFreq.set(r.strongs, r.n);
  } catch { /* leave unknown: treated as common */ }
}

function renderTextLine(textId, data, ctx = null, carry = null) {
  const line = el("div", "line");
  if (RTL_LANGS.has(langOf(textId))) line.dir = "rtl";
  line.classList.add("lang-" + (langOf(textId) ?? "en"));
  if (!data) {
    line.append(el("span", "missing", "—"));
  } else if (data.words) {
    const mode = state.tagMode ?? "plain";
    if (mode !== "plain") line.classList.add("interlinear");
    for (const w of data.words) {
      const word = tappable(el("span", "word", w.surface), () => showWord(w));
      // textual variants: a NT word missing from one of the major editions,
      // or a Hebrew Ketiv/Qere reading, gets a dotted underline (details in
      // the word panel)
      if (isVariantWord(w)) word.classList.add("variant");
      const glossed = mode === "interlinear" ||
        (mode === "reader" && w.strongs &&
         (strongsFreq.get(w.strongs) ?? Infinity) <= (state.readerMax ?? 30));
      if (mode === "plain" || !glossed) {
        line.append(word);
        if (mode !== "plain") {
          // keep every word in the same stacked box so lines align
          const box = el("span", "iw");
          box.append(word);
          line.replaceChild(box, word);
        }
      } else {
        const box = el("span", "iw");
        box.append(word, el("span", "gloss", w.gloss ?? ""));
        line.append(box);
      }
      line.append(document.createTextNode(" "));
    }
  } else {
    const lang = langOf(textId);
    // en -> English dictionary taps; grc/hbo -> identify via tagged corpus
    const mode = lang === "en" ? true
      : (lang === "grc" || lang === "hbo") ? "original" : false;
    line._carry = renderBody(line, data.body, mode, ctx, carry);
  }
  return line;
}

async function renderChapter() {
  const content = $("#content");
  content.innerHTML = "";
  content.append(el("p", "hint", "Loading…"));

  const texts = [state.textA, state.textB].filter((t) => t && t !== "none");
  const maps = await Promise.all(texts.map(chapterVerses));
  if (state.tagMode === "reader") await primeStrongsFreq(maps);

  content.innerHTML = "";
  // a selected text that isn't downloaded, or that doesn't contain this
  // book (the Septuagint has no New Testament): say so where its words
  // would be, and point at texts in the same language that do have it
  texts.forEach((t, i) => {
    const need = isTagged(t) ? taggedItem(t) : packOfText(t);
    if (need && !packInstalled(need)) {
      const p = packPrompt(need, labelOf(t), false);
      if (p) { p.classList.add("packnotice"); content.append(p); }
      return;
    }
    if (maps[i].size) return;
    const notice = coverageNotice(t, state.book);
    if (notice) content.append(notice);
  });
  const verseNums = [...new Set(maps.flatMap((m) => [...m.keys()]))]
    .sort((a, b) => a - b);
  if (!verseNums.length) {
    content.append(el("p", "hint",
      "Nothing here for the selected text(s) — try another text or book."));
    return;
  }
  // No per-verse text labels: the top-bar selectors already say which texts
  // are shown and in what order; the second text renders slightly muted.
  // what read-aloud would speak: the primary text, verse by verse
  readItems = [];
  const readLang = isTagged(texts[0]) ? TAGGED[texts[0]].lang : (langOf(texts[0]) ?? "en");
  for (const v of verseNums) {
    const d = maps[0].get(v);
    const text = d?.words ? d.words.map((w) => w.surface).join(" ")
      : d?.body ? d.body.replace(/<[^<>\s]{1,8}>/g, "").replace(/\s+/g, " ").trim() : "";
    if (text) readItems.push({ id: v, text, lang: readLang });
  }
  updateReadButton(readLang);
  const carry = texts.map(() => null);   // markers left open by the previous verse
  for (const v of verseNums) {
    const row = el("div", "verse-row");
    row.dataset.verse = v;
    const vbtn = el("button", "vnum", String(v));
    vbtn.title = "Verse details";
    vbtn.onclick = () => showVerse(state.book, state.chapter, v);
    row.append(vbtn);
    const body = el("div", "vbody" + (texts.length === 2 ? " two" : ""));
    texts.forEach((t, i) => {
      const line = renderTextLine(t, maps[i].get(v),
        { textId: t, bookNr: state.book, chapter: state.chapter, verse: v }, carry[i]);
      carry[i] = line._carry?.size ? line._carry : null;
      if (i > 0) line.classList.add("line-b");
      body.append(line);
    });
    row.append(body);
    content.append(row);
  }
  window.scrollTo(0, 0);
  applyChapterAnnotations(state.book, state.chapter);
}

async function go(patch) {
  window.dispatchEvent(new Event("atb:navigate"));   // stops read-aloud
  Object.assign(state, patch);
  let maxCh = chapterCounts.get(state.book);
  if (!maxCh) {
    // book outside KJV coverage (apocrypha/LXX extras): probe selected texts
    for (const probe of [state.textA, state.textB]) {
      if (!probe || probe === "none" || isTagged(probe)) continue;
      const [{ n }] = await DB.getChapterCount(probe, state.book);
      if (n) { maxCh = n; break; }
    }
  }
  maxCh = maxCh ?? 1;
  if (patch.book && !patch.chapter) state.chapter = 1;
  state.chapter = Math.min(Math.max(1, state.chapter), maxCh);
  // source buttons always reflect the live selection
  $("#textA").textContent = labelOf(state.textA);
  $("#textB").textContent = labelOf(state.textB);
  updatePager();
  $("#prev").disabled = state.chapter <= 1;
  $("#next").disabled = state.chapter >= maxCh;
  saveState();
  await renderChapter();
  syncUrl();
}

// Top bar auto-hide: slide away scrolling down; return on a quick upward
// flick, or near the top or bottom of the page.
function initAutoHideBar() {
  const bar = $("#topbar");
  const setPad = () => {
    if (bar.offsetHeight)
      document.documentElement.style
        .setProperty("--topbar-h", bar.offsetHeight + "px");
    // skip when hidden (Ask page) — a 0 would break the other views' padding
    if ($("#bottombar").offsetHeight)
      document.documentElement.style
        .setProperty("--bottombar-h", $("#bottombar").offsetHeight + "px");
  };
  setPad();
  window.addEventListener("resize", setPad);
  let lastY = window.scrollY;
  let ticking = false;
  let upAccum = 0;     // cumulative upward scroll since last downward move
  let downAccum = 0;   // cumulative downward scroll since last upward move
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const y = window.scrollY;
      const dy = y - lastY;
      lastY = y;
      ticking = false;
      // symmetric gentle thresholds: ~36px of cumulative scroll in either
      // direction, at any speed, toggles the bars (owner: per-frame speed
      // thresholds were too hard to trigger)
      upAccum = dy < 0 ? upAccum - dy : 0;
      downAccum = dy > 0 ? downAccum + dy : 0;
      const nearTop = y < 60;
      const nearBottom = window.innerHeight + y
        >= document.documentElement.scrollHeight - 60;
      // whatever chrome the current view shows: reader top bar, or the
      // active view's own header (e.g. a Library work), plus the bottom bar
      const bars = [bar, $("#bottombar"),
                    document.querySelector("main:not([hidden]) .appbar")]
                   .filter(Boolean);
      if (nearTop || nearBottom || upAccum > 36) {
        for (const b of bars) b.classList.remove("bar-hidden");
        downAccum = 0;
      } else if (downAccum > 36) {
        for (const b of bars) b.classList.add("bar-hidden");
        upAccum = 0;
      }
    });
  }, { passive: true });
}

// ---- read aloud -------------------------------------------------------------
let readItems = [];
let readLangShown = null;
async function updateReadButton(lang) {
  const btn = $("#readbtn");
  if (!btn) return;
  if (RA.isPlaying() || RA.isPaused()) return;    // leave the control alone mid-play
  readLangShown = lang;
  let ok = false;
  try { ok = await RA.available(lang); } catch { ok = false; }
  if (readLangShown !== lang) return;
  btn.hidden = !ok || !readItems.length;           // null (engine starting) hides too
  btn.classList.remove("playing");
}
function markReading(v) {
  for (const r of document.querySelectorAll(".verse-row.reading")) r.classList.remove("reading");
  if (v == null) return;
  const row = document.querySelector(`.verse-row[data-verse="${v}"]`);
  if (row) {
    row.classList.add("reading");
    row.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}
function initReadAloud() {
  const btn = $("#readbtn");
  if (!btn) return;
  btn.onclick = async () => {
    if (RA.isPlaying()) { await RA.pause(); btn.classList.remove("playing"); return; }
    if (RA.isPaused()) { await RA.resume(); btn.classList.add("playing"); return; }
    if (!readItems.length) return;
    btn.classList.add("playing");
    const ok = await RA.start(readItems, {
      rate: 0.9,
      onVerse: (id) => markReading(Number(id)),
      onDone: () => { markReading(null); btn.classList.remove("playing"); },
      onError: (msg) => { toastError(msg); },
    });
    if (!ok) btn.classList.remove("playing");
  };
  // leaving the chapter stops the voice
  window.addEventListener("atb:navigate", () => { RA.stop(); markReading(null); btn.classList.remove("playing"); });
}
function toastError(msg) {
  let t = $("#errtoast");
  if (!t) { t = el("div", "errtoast"); t.id = "errtoast"; document.body.append(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 6000);
}

// The Ask tab comes into existence only when the beta toggle is on.
function enableAskTab() {
  $("#tab-ask").hidden = false;
  if (askBuilt) return;
  askBuilt = true;
  $("#tab-ask").onclick = () => {
    prevAskView = currentView;
    showView("ask");
    refreshModelCard();
    window.scrollTo(0, document.documentElement.scrollHeight);
  };
  buildAskUI();
  $("#askgo").onclick = askQuestion;
  const ta = $("#askq");
  ta.addEventListener("input", () => {     // grow with the question, capped
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 120) + "px";
  });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!$("#askgo").disabled) askQuestion();   // same gate as the button
    }
  });
}
function disableAskTab() {
  $("#tab-ask").hidden = true;
  if (currentView === "ask") showView("read");
}

// ------------------------------------------------------------ data catalog
// The data ships as a catalog of items (app/CATALOG.md): the core databases
// and the default Bibles install at first launch, everything else — each
// text, each testament of tagging, each lexicon, each Library work — on the
// user's tap. `packs` mirrors the worker's catalog; the helpers below gate
// the UI (the core's empty schemas make a missing item return nothing,
// these make the app say so and offer the download).
let packs = [];                       // [{id, title, blurb, group, kind, installed, ...}]
const packById = (id) => packs.find((p) => p.id === id);
const packInstalled = (id) => !!packById(id)?.installed;
const packOfText = (textId) => packById(`text-${textId}`) ? `text-${textId}` : null;
const taggedItem = (id) => (id === "tagged-grc" ? "tagged-nt" : "tagged-ot");
const workItem = (w) => packs.find((p) => p.kind === "work" && p.work_id === w.id)?.id
  ?? (packById(`work-${w.slug}`) ? `work-${w.slug}` : null);
const lexiconItems = (strongs) =>
  /^H/.test(strongs ?? "") ? ["lexicon-bdb"] : ["lexicon-lsj", "lexicon-abbott-smith"];
// sizes for people: KB under a megabyte, one decimal under ten, whole MB above
const fmtSize = (n) => n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB`
  : n < 10e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e6)} MB`;
const mbOf = (n) => Math.max(1, Math.round(n / 1e6));   // arithmetic only
const packListeners = new Set();      // views that re-render after a change
const setPacks = (list) => {
  if (Array.isArray(list)) packs = list;
  for (const fn of packListeners) { try { fn(); } catch { /* view gone */ } }
};

// download + install one pack (or several) with progress text; the AI
// index also warms the query embedder so the whole path is proven
async function installPackUI(ids, onText = () => {}) {
  const mb = (n) => (n / 1e6).toFixed(0);
  const list = Array.isArray(ids) ? ids : [ids];
  DB.setProgressHandler(({ phase, loaded, total, label }) => {
    const title = packById(label)?.title ?? label ?? "";
    onText(phase === "download" ? `Downloading ${title} ${mb(loaded)} / ${mb(total)} MB…`
      : phase === "embedder" ? (total ? `Downloading embedder ${mb(loaded)} / ${mb(total)} MB…`
                                      : "Downloading embedder…")
      : phase === "install" ? `Installing ${title}…` : `${phase}…`);
  });
  try {
    const res = await DB.installPacks(list);
    if (list.includes("vectors")) {
      onText("Loading embedder…");
      await DB.warmEmbedder();
    }
    setPacks(res.packs);
  } finally {
    DB.setProgressHandler(() => {});
  }
}

async function removePackUI(id) {
  const res = await DB.removePack(id);
  if (id === "vectors")
    navigator.serviceWorker?.controller?.postMessage({ type: "drop-embedder" });
  setPacks(res.packs);
}

// Inline "this needs the X pack" line with a Download button. Returns null
// when the pack is installed (or unknown), so callers can `append` blindly.
function packPrompt(id, what, compact = true) {
  const p = packById(id);
  if (!p || (p.installed && !p.stale)) return null;
  const box = el("div", compact ? "aidata compact" : "aidata");
  const status = el("span", "pcstatus");
  const note = el("p", "hint");
  if (!p.available) {
    status.textContent = `${what} needs the “${p.title}” pack, which can't be fetched right now (offline?).`;
    box.append(status);
    return box;
  }
  status.textContent = p.stale
    ? `An update to “${p.title}” is available (${fmtSize(p.gz_size)}).`
    : `${what} needs the “${p.title}” pack (${fmtSize(p.gz_size)} download).`;
  const btn = el("button", compact ? "annbtn" : "pcbtn", p.stale ? "Update" : "Download");
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await installPackUI(id, (t) => { note.textContent = t; });
      note.textContent = "";
    } catch (e) {
      note.textContent = "Download failed: " + (e.message ?? e);
      btn.disabled = false;
    }
  };
  box.append(status, btn, note);
  return box;
}

// a Download / Update / Remove row for one catalog item (used by the
// Catalog card and by the Library shelves)
function itemButtons(p, rowNote) {
  const out = [];
  if (!p.main && p.available && (!p.installed || p.stale)) {
    const b = el("button", "annbtn", p.stale ? "Update" : `Download (${fmtSize(p.gz_size)})`);
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try { await installPackUI(p.id, (t) => { rowNote.textContent = t; }); }
      catch (err) { rowNote.textContent = "Download failed: " + (err.message ?? err); b.disabled = false; }
    };
    out.push(b);
  }
  if (!p.main && p.installed) {
    const r = el("button", "annbtn", "Remove");
    r.onclick = async (e) => {
      e.stopPropagation();
      r.disabled = true;
      try { await removePackUI(p.id); }
      catch (err) { rowNote.textContent = "Remove failed: " + (err.message ?? err); r.disabled = false; }
    };
    out.push(r);
  }
  return out;
}

// "Download all" for a set of items (a group, a shelf, everything)
function groupButton(label, ids, note, cls = "annbtn") {
  const missing = ids.map(packById).filter((p) => p && !p.installed && p.available);
  if (!missing.length) return null;
  const b = el("button", cls,
    `${label} (${missing.length} · ${fmtSize(missing.reduce((s, p) => s + p.gz_size, 0))})`);
  b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    try { await installPackUI(missing.map((p) => p.id), (t) => { note.textContent = t; }); }
    catch (err) { note.textContent = "Download failed: " + (err.message ?? err); b.disabled = false; }
  };
  return b;
}

// Settings → Catalog: every item grouped (Bibles, tagging, lexicons,
// reference, Library shelves) with Download / Remove per item, "Download
// all" per group, and "Download everything" for desktops and generous
// data plans. Users tailor what lives on the device from here.
function buildDownloadsCard() {
  const card = el("div", "result-card");
  card.id = "downloads";
  const open = new Set(loadJson("atb-catalog-open", []));
  const render = () => {
    card.innerHTML = "";
    card.append(el("h3", null, "Catalog"));
    const visible = packs.filter((p) => !p.main && (p.id !== "vectors" || aiEnabled()));
    const onDevice = packs.filter((p) => p.installed).reduce((s, p) => s + p.db_size, 0);
    card.append(el("p", "hint",
      `Pick exactly what lives on this device: each Bible, the Greek and Hebrew ` +
      `tagging, each lexicon and every Library work is a separate download, and ` +
      `everything works offline afterwards. On this device now: ${fmtSize(onDevice)} ` +
      `(${visible.filter((p) => p.installed).length} of ${visible.length} items).`));
    const note = el("p", "hint");
    const everything = groupButton("Download everything",
      visible.filter((p) => p.id !== "vectors").map((p) => p.id), note, "pcbtn");
    if (everything) card.append(everything);
    card.append(note);
    const groups = [];
    for (const p of visible) if (!groups.includes(p.group)) groups.push(p.group);
    for (const g of groups) {
      const members = visible.filter((p) => p.group === g);
      const box = el("details", "packgroup");
      box.open = open.has(g);
      box.ontoggle = () => {
        if (box.open) open.add(g); else open.delete(g);
        try { localStorage.setItem("atb-catalog-open", JSON.stringify([...open])); } catch { /* ignore */ }
      };
      const sum = el("summary");
      sum.append(el("span", "packtitle", g),
                 el("span", "pcstatus", ` ${members.filter((p) => p.installed).length}/${members.length} installed`));
      box.append(sum);
      const gnote = el("p", "hint");
      const gbtn = groupButton("Download all", members.map((p) => p.id), gnote);
      if (gbtn) box.append(gbtn);
      box.append(gnote);
      for (const p of members) {
        const row = el("div", "packrow");
        const head = el("div", "packhead");
        head.append(el("span", "packtitle", p.title),
                    el("span", "pcstatus" + (p.installed ? " ok" : ""),
                       p.installed
                         ? (p.stale ? `update available (${fmtSize(p.gz_size)})` : `installed · ${fmtSize(p.db_size)}`)
                         : p.available ? `${fmtSize(p.gz_size)}` : "not available offline"));
        row.append(head);
        if (p.blurb) row.append(el("p", "hint", p.blurb));
        const rowNote = el("p", "hint");
        row.append(...itemButtons(p, rowNote), rowNote);
        box.append(row);
      }
      card.append(box);
    }
  };
  render();
  packListeners.add(render);
  return card;
}

// Status line + Download / Update / Remove button for the AI search index
// (the `vectors` pack + the query embedder). compact = the one-line nudge on
// the Ask page (renders nothing when there is nothing to do).
function renderAiDataControl(box, compact = false) {
  box.innerHTML = "";
  const st = packById("vectors");
  const ready = st?.installed && !st.stale;
  if (compact && (!st || ready || !st.available)) return;
  const row = el("div", compact ? "aidata compact" : "aidata");
  const status = el("span", "pcstatus");
  const btn = el("button", compact ? "annbtn" : "pcbtn");
  const note = el("p", "hint");
  if (!st) {
    status.textContent = "AI search data: status unavailable.";
    row.append(status);
  } else if (ready) {
    status.textContent = `AI search data: installed (${fmtSize(st.db_size)} on this device).`;
    status.classList.add("ok");
    btn.textContent = "Remove";
    btn.onclick = async () => {
      btn.disabled = true;
      try { await removePackUI("vectors"); }
      catch (e) { note.textContent = "Remove failed: " + (e.message ?? e); }
      renderAiDataControl(box, compact);
    };
    row.append(status, btn);
  } else if (!st.available) {
    status.textContent = "AI search data: not downloaded (the server can't be reached right now).";
    row.append(status);
  } else {
    const total = fmtSize(st.gz_size + 50e6);     // index chunks + embedder files
    status.textContent = st.stale
      ? `AI search data: an update is available (${fmtSize(st.gz_size)}).`
      : compact
        ? `Semantic search is off — download the AI search data (about ${total}) for far better retrieval.`
        : `AI search data: not downloaded (about ${total}: semantic index + embedder).`;
    btn.textContent = st.stale ? "Update" : "Download";
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await installPackUI("vectors", (t) => { note.textContent = t; });
      } catch (e) {
        note.textContent = "Download failed: " + (e.message ?? e) +
          " — Ask still works with keyword search.";
        btn.disabled = false;
        return;
      }
      renderAiDataControl(box, compact);
    };
    row.append(status, btn);
  }
  box.append(row, note);
  if (!compact && st) box.append(el("p", "hint",
    "Semantic search finds passages by meaning, not only by matching words; " +
    "without it Ask falls back to keyword search. Stored on this device — " +
    "remove it any time."));
}

// Settings card: the beta toggle that brings the AI feature into existence
function buildAiCard() {
  const card = el("div", "result-card");
  card.id = "aicard";
  card.append(el("h3", null, "Ask AI (beta)"));
  const lab = el("label", "aitoggle");
  const chk = el("input");
  chk.type = "checkbox";
  chk.id = "aibeta";
  chk.checked = aiEnabled();
  lab.append(chk, document.createTextNode(" Enable the Ask tab (beta)"));
  card.append(lab);
  card.append(el("p", "hint",
    "Experimental. Ask questions about the Bible and the Library and get " +
    "answers that cite passages you can tap. Answers are written by an AI " +
    "model — on this device (Android, with a model file you import) or through " +
    "your own Claude API key — and can be wrong: check the cited passages. " +
    "Off by default; nothing AI-related is downloaded until you turn it on."));
  const data = el("div");
  card.append(data);
  const refresh = () => {
    data.hidden = !chk.checked;
    if (chk.checked) renderAiDataControl(data);
    else data.innerHTML = "";
  };
  chk.onchange = () => {
    try { localStorage.setItem(AI_KEY, chk.checked ? "1" : "0"); } catch { /* ignore */ }
    if (chk.checked) enableAskTab(); else disableAskTab();
    refresh();
  };
  refresh();
  return card;
}

function buildControls() {
  $("#locbtn").onclick = () => {
    if (currentView === "work") openWorkPicker();
    else openBookPicker();
  };
  $("#prev").onclick = () =>
    currentView === "work" ? turnWorkPage(-1) : go({ chapter: state.chapter - 1 });
  $("#next").onclick = () =>
    currentView === "work" ? turnWorkPage(1) : go({ chapter: state.chapter + 1 });

  // bottom tabs: reader tab always returns to the preserved reading position
  $("#tab-read").onclick = () => { showView("read"); };
  $("#tab-library").onclick = () => {
    if (workState.id && currentView !== "library" && currentView !== "work") {
      showView("work"); renderWorkPage();   // resume the work being read
    } else {
      showView("library");
    }
  };
  $("#tab-search").onclick = () => { showView("search"); $("#q").focus(); };
  $("#tab-settings").onclick = () => showView("settings");
  if (aiEnabled()) enableAskTab();

  const LANG_GROUPS = [
    ["Tapped originals", Object.keys(TAGGED)],
    ["English", textIds.filter((t) => langOf(t) === "en")],
    ["Greek", textIds.filter((t) => langOf(t) === "grc")],
    ["Hebrew", textIds.filter((t) => langOf(t) === "hbo")],
    ["Latin", textIds.filter((t) => langOf(t) === "la")],
    ["Syriac", textIds.filter((t) => langOf(t) === "syr")],
  ];
  const fillTextSelect = (sel, { none = false, tagged = true } = {}) => {
    if (none) sel.append(new Option("None", "none"));
    for (const [label, ids] of LANG_GROUPS) {
      if (!tagged && label === "Tapped originals") continue;
      if (!ids.length) continue;
      const grp = el("optgroup");
      grp.label = label;
      for (const id of ids) grp.append(new Option(labelOf(id), id));
      sel.append(grp);
    }
  };

  // The two source selectors open an in-theme picker screen (same accordion
  // paradigm as the book/library pickers) instead of the platform dropdown.
  const updateTextButtons = () => {
    $("#textA").textContent = labelOf(state.textA);
    $("#textB").textContent = labelOf(state.textB);
  };
  const openTextPicker = (slot) => {
    const picker = $("#bookpicker");
    picker.innerHTML = "";
    picker.append(makeAppbar(
      slot === "textA" ? "Primary text" : "Second text",
      () => showView("read")));
    const groups = slot === "textB"
      ? [["No second text", ["none"]], ...LANG_GROUPS] : LANG_GROUPS;
    let openGrid = null;
    const current = state[slot];
    for (const [label, ids] of groups) {
      if (!ids.length) continue;
      const row = el("div", "bookrow");
      const head = el("button", "bookhead", label);
      const hasCurrent = ids.includes(current);
      if (hasCurrent) head.classList.add("here-book");
      const makeGrid = () => {
        const grid = el("div", "chgrid");
        grid.dataset.group = label;
        for (const id of ids) {
          const box = el("button", "textbox", labelOf(id));
          if (id === current) box.classList.add("here");
          // texts (and the tagged reader) not yet downloaded
          const need = isTagged(id) ? taggedItem(id) : packOfText(id);
          if (need && !packInstalled(need)) {
            box.classList.add("needs-pack");
            box.append(el("span", "packtag", `${fmtSize(packById(need)?.gz_size ?? 0)}`));
          }
          box.onclick = () => {
            if (slot === "textA" && id === "none") return;
            showView("read");
            go({ [slot]: id });      // the reader shows the download prompt itself
            updateTextButtons();
          };
          grid.append(box);
        }
        return grid;
      };
      head.onclick = () => {
        if (openGrid?.dataset.group === label) {
          openGrid.remove();
          openGrid = null;
          return;
        }
        openGrid?.remove();
        openGrid = makeGrid();
        row.append(openGrid);
        head.scrollIntoView({ block: "nearest" });
      };
      row.append(head);
      picker.append(row);
      if (hasCurrent) {
        openGrid = makeGrid();
        row.append(openGrid);
      }
    }
    showView("books");
    picker.querySelector(".here-book")?.scrollIntoView({ block: "center" });
  };
  updateTextButtons();
  $("#textA").onclick = () => openTextPicker("textA");
  $("#textB").onclick = () => openTextPicker("textB");
  $("#swapbtn").onclick = () => {
    if (state.textB === "none") return;   // primary slot can't be empty
    const [a, b] = [state.textB, state.textA];
    go({ textA: a, textB: b });
    updateTextButtons();
  };

  // search wiring
  $("#searchview").prepend(makeAppbar("Search"));   // header parity with
                                                    // Library/Settings/Ask
  const noteChk = $("#notesearch");
  noteChk.checked = localStorage.getItem("atb-notesearch") === "1";
  noteChk.onchange = () =>
    localStorage.setItem("atb-notesearch", noteChk.checked ? "1" : "0");
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runSearch();
  });
  $("#gobtn").onclick = runSearch;
  const ftsSel = $("#ftstext");
  ftsSel.append(new Option("All texts", ""));
  fillTextSelect(ftsSel, { tagged: false });
  ftsSel.onchange = () => ftsSel.blur();

  // parsing (morphological) search
  const from = $("#mq-from"), to = $("#mq-to");
  if (from && to) {
    for (const b of books) {
      if (b.nr > 66) continue;
      from.append(new Option(b.name, String(b.nr)));
      to.append(new Option(b.name, String(b.nr)));
    }
    from.value = "1"; to.value = "66";
    $("#mq-go").onclick = runMorphSearch;
    for (const id of ["#mq-word", "#mq-morph"])
      $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") runMorphSearch(); });
  }
}

async function runMorphSearch() {
  const wordQ = $("#mq-word").value.trim();
  const morphQ = $("#mq-morph").value.trim();
  if (!wordQ && !morphQ) return;
  const results = $("#results");
  const gen = ++searchGen;
  results.innerHTML = "";
  results.append(el("p", "hint", "Searching…"));
  const params = {
    bookFrom: Number($("#mq-from").value) || 1,
    bookTo: Number($("#mq-to").value) || 66,
    morphGlob: morphQ || null,
    limit: 400,
  };
  if (params.bookFrom > params.bookTo) [params.bookFrom, params.bookTo] = [params.bookTo, params.bookFrom];
  const sm = wordQ.match(/^([gh])\s*0*(\d{1,4})$/i);
  if (sm) params.strongs = sm[1].toUpperCase() + sm[2].padStart(4, "0");
  else if (wordQ) params.lemmaNorm = normalize(wordQ);
  try {
    const [{ n }] = await DB.countMorph(params);
    const rows = await DB.searchMorph(params);
    if (gen !== searchGen) return;
    results.innerHTML = "";
    if (!rows.length) { results.append(el("p", "hint", "No words match that parsing.")); return; }
    results.append(el("p", "hint",
      `${n.toLocaleString()} match${n === 1 ? "" : "es"}${rows.length < n ? ` (showing ${rows.length})` : ""}:`));
    const list = el("div", "occlist tall");
    const summaries = new Map();
    for (const r of rows) {
      const row = el("div", "occ");
      const link = el("a", null, `${r.book} ${r.chapter}:${r.verse}`);
      link.href = "#";
      link.onclick = (e) => { e.preventDefault(); navigateTo(r.book_nr, r.chapter, r.verse); };
      const morphEl = el("span", "hint", ` ${r.morph}`);
      row.append(link, el("span", null, ` — ${r.surface} — ${r.gloss ?? ""}`), morphEl);
      list.append(row);
      if (!summaries.has(r.morph)) summaries.set(r.morph, morphSummary(r.morph));
      summaries.get(r.morph).then((m) => { if (m) morphEl.textContent = ` · ${m.summary}`; });
    }
    results.append(list);
  } catch (e) {
    results.innerHTML = "";
    results.append(el("p", "hint", "Search error: " + e.message));
  }
}

// ------------------------------------------------------------------ ask AI
let modelLoaded = false;

// Saved conversations: [{id, title, ts, msgs: [{q, a, sources}]}], newest first.
const chats = loadJson("atb-chats", []);
let chatId = null;                    // null = fresh conversation
const saveChats = () => {
  // quota-safe: drop oldest conversations until the save fits
  for (let keep = 50; keep >= 1; keep = Math.floor(keep / 2)) {
    try {
      localStorage.setItem("atb-chats", JSON.stringify(chats.slice(0, keep)));
      return;
    } catch { /* smaller */ }
  }
};

const ASK_ICONS = {
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  history: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tune: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="9" cy="7" r="2.2" style="fill:var(--bg)" stroke="currentColor" stroke-width="1.7"/><circle cx="15" cy="12" r="2.2" style="fill:var(--bg)" stroke="currentColor" stroke-width="1.7"/><circle cx="8" cy="17" r="2.2" style="fill:var(--bg)" stroke="currentColor" stroke-width="1.7"/></svg>',
};

function buildAskUI() {
  const bar = makeAppbar("Ask · beta", () => showView(prevAskView));
  bar.append(el("span", "flexspace"));
  const mk = (label, svg, fn) => {
    const b = el("button", "iconbtn");
    b.innerHTML = svg;
    b.setAttribute("aria-label", label);
    b.onclick = fn;
    return b;
  };
  bar.append(mk("New conversation", ASK_ICONS.plus, newChat),
             mk("Conversations", ASK_ICONS.history, showChatHistory),
             mk("AI settings", ASK_ICONS.tune, showAiSettings));
  $("#askview").prepend(bar);
}

function newChat() {
  chatId = null;
  $("#askthread").innerHTML = "";
  buildAskSetup();          // fresh thread: bring back the starter chips
  window.scrollTo(0, 0);
  $("#askq").focus();
}

function loadChat(c) {
  chatId = c.id;
  renderThread(c.msgs);
}

function renderThread(msgs) {
  const thread = $("#askthread");
  thread.innerHTML = "";
  for (const m of msgs) {
    thread.append(el("div", "msg q", m.q));
    thread.append(el("div", "msg a", m.a));
    if (m.sources?.length) thread.append(sourcesBlock(m.sources, m.a));
  }
  window.scrollTo(0, document.documentElement.scrollHeight);
}

// Sources list under an answer: passages the answer actually cites come
// first at full strength; the rest of what was retrieved follows dimmed
// (still tappable). Numbering matches the [n] citations in the text.
function sourcesBlock(sources, answerText = "") {
  const cited = new Set(
    [...answerText.matchAll(/\[(\d+)\]/g)].map((m) => parseInt(m[1], 10)));
  const src = el("div", "asksources");
  src.append(el("p", "hint", "Sources:"));
  const row = (h, i, dim) => {
    const r = el("div", dim ? "occ dim" : "occ");
    const label = h.kind === "verse"
      ? `[${i + 1}] ${h.book} ${h.chapter}:${h.verse} (WEB)`
      : `[${i + 1}] ` +
        [h.title, h.section, `p. ${h.page}`].filter(Boolean).join(" · ");
    const link = el("a", null, label);
    link.href = "#";
    link.onclick = (e) => {
      e.preventDefault();
      if (h.kind === "verse") {         // verse sources open the reader
        navigateTo(h.book_nr, h.chapter, h.verse);
        return;
      }
      Object.assign(workState,
        { id: h.work_id, page: h.page, title: h.title, pages: h.pages });
      saveWork();
      showView("work");
      renderWorkPage();
    };
    r.append(link);
    return r;
  };
  sources.forEach((h, i) => {
    if (cited.size && !cited.has(i + 1)) return;
    src.append(row(h, i, false));
  });
  sources.forEach((h, i) => {
    if (!cited.size || cited.has(i + 1)) return;
    src.append(row(h, i, true));
  });
  return src;
}

function persistTurn(q, a, sources) {
  let chat = chats.find((c) => c.id === chatId);
  if (!chat) {
    chat = { id: Date.now(), title: q.slice(0, 48), ts: Date.now(), msgs: [] };
    chats.unshift(chat);
    chatId = chat.id;
  }
  chat.msgs.push({ q, a, sources });
  chat.ts = Date.now();
  saveChats();
}

function showChatHistory() {
  const panel = sheet(true);
  const head = el("div", "sheet-head");
  head.append(el("h3", null, "Conversations"));
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  if (!chats.length) {
    panel.append(el("p", "hint", "No saved conversations yet."));
  }
  const list = el("div", "occlist");
  for (const c of chats) {
    const row = el("div", "occ chatrow");
    const link = el("a", null, c.title);
    link.href = "#";
    link.onclick = (e) => {
      e.preventDefault();
      panel.hidden = true;
      loadChat(c);
    };
    const del = el("button", "close", "✕");
    del.setAttribute("aria-label", "Delete conversation");
    del.onclick = () => {
      chats.splice(chats.indexOf(c), 1);
      saveChats();
      if (chatId === c.id) newChat();
      showChatHistory();
    };
    row.append(link,
      el("span", "hint",
        `${new Date(c.ts).toLocaleDateString()} · ` +
        `${c.msgs.length} question${c.msgs.length === 1 ? "" : "s"}`),
      del);
    list.append(row);
  }
  panel.append(list);
  panel.hidden = false;
}

async function showAiSettings() {
  const panel = sheet(true);
  const head = el("div", "sheet-head");
  head.append(el("h3", null, "AI settings"));
  const close = el("button", "close", "✕");
  close.onclick = () => { panel.hidden = true; };
  head.append(close);
  panel.append(head);
  const S = LLM.aiSettings;

  // provider (on-device vs Claude account)
  const provBtn = el("button", null, "Change…");
  provBtn.onclick = () => {
    panel.hidden = true;
    buildAskSetup(true);
    window.scrollTo(0, 0);
  };
  const provRow = el("div", "setrow");
  const provLab = el("label", null,
    `Provider: ${S.provider === "claude"
      ? "Claude (" + (S.claudeModel ?? "").replace("claude-", "") + ")"
      : "On-device"}`);
  provLab.append(provBtn);
  provRow.append(provLab);
  panel.append(provRow);

  const setRow = (labelText, control, hintText) => {
    const row = el("div", "setrow");
    const lab = el("label", null, labelText);
    lab.append(control);
    row.append(lab);
    if (hintText) row.append(el("p", "hint", hintText));
    panel.append(row);
    return row;
  };

  // context size
  const ctxSel = el("select");
  for (const [v, t] of [["auto", "Auto (recommended)"], ["1280", "1280"],
                        ["2048", "2048"], ["4096", "4096"],
                        ["8192", "8192 (loads, but most phones fail at answer time)"]])
    ctxSel.append(new Option(t, v));
  ctxSel.value = String(S.ctx);
  const ctxNote = el("p", "hint", "");
  ctxSel.onchange = async () => {
    S.ctx = ctxSel.value === "auto" ? "auto" : Number(ctxSel.value);
    LLM.saveAiSettings();
    if (!modelLoaded) return;
    ctxNote.textContent = "Reloading model… (can take a minute)";
    try {
      const n = await LLM.loadModel(S.ctx === "auto" ? undefined : S.ctx);
      ctxNote.textContent = `Model reloaded with a ${n}-token context.`;
    } catch (e) {
      ctxNote.textContent = "Reload failed: " + (e.message ?? e);
      modelLoaded = false;
      refreshModelCard();
    }
  };
  setRow("Context size", ctxSel,
    "How much the AI reads at once — larger fits more Library passages per " +
    "answer, but loads slower and can fail on phones with less memory. " +
    "Auto finds the largest size that works.");
  panel.append(ctxNote);

  // answer style (temperature)
  const tSel = el("select");
  for (const [v, t] of [["0.2", "Precise"], ["0.6", "Balanced"],
                        ["0.9", "Creative"]])
    tSel.append(new Option(t, v));
  tSel.value = [...tSel.options].some((o) => o.value === String(S.temp))
    ? String(S.temp) : "0.2";
  tSel.onchange = () => { S.temp = Number(tSel.value); LLM.saveAiSettings(); };
  setRow("Answer style", tSel,
    "Precise sticks closest to the passages (most accurate — measured); " +
    "Creative words things more freely. Applies from the next question.");

  // grounding double-check
  const vSel = el("select");
  vSel.append(new Option("On (recommended)", "on"), new Option("Off", "off"));
  vSel.value = S.verify === false ? "off" : "on";
  vSel.onchange = () => {
    S.verify = vSel.value !== "off";
    LLM.saveAiSettings();
  };
  setRow("Double-check answers", vSel,
    "After answering, the AI re-reads the cited passages and withdraws the " +
    "answer if they don't support it. Roughly 3× fewer wrong answers, " +
    "at the cost of extra time and some declined questions.");

  // conversations
  const clearBtn = el("button", null, "Clear conversation history");
  clearBtn.onclick = () => {
    chats.length = 0;
    saveChats();
    newChat();
    clearBtn.textContent = "Cleared";
    clearBtn.disabled = true;
  };
  setRow("Conversations", clearBtn);

  // model management
  let st = { hasModel: false, loaded: false };
  try { st = await LLM.status(); } catch {}
  panel.append(el("p", "hint", st.hasModel
    ? `Model: ${st.file ?? "file"} · ${(st.modelBytes / 1e9).toFixed(2)} GB · ` +
      (st.loaded ? "loaded" : "not loaded")
    : "Model: none imported"));
  if (st.hasModel) {
    const rm = el("button", null, "Remove model file");
    rm.onclick = async () => {
      await LLM.removeModel();
      modelLoaded = false;
      panel.hidden = true;
      refreshModelCard();
    };
    panel.append(rm);
  }
  panel.hidden = false;
}

// The Ask setup screen: pick and configure a provider — on-device Gemma
// (private/offline) or the user's own Claude account via API key. Shown
// until a provider is ready; reachable later from AI settings.
async function buildAskSetup(force = false) {
  const card = $("#askmodel");
  const S = LLM.aiSettings;
  let st = { hasModel: false, loaded: false };
  try { st = await LLM.status(); } catch {}
  modelLoaded = st.loaded;
  const ready = LLM.claudeReady() || modelLoaded;
  if (ready && !force) {
    if ($("#askthread").childElementCount) {   // mid-conversation: no chrome
      card.hidden = true;
      return;
    }
    // fresh conversation: a welcoming empty state with tappable starters
    card.hidden = false;
    card.innerHTML = "";
    card.className = "setup";
    const hero = el("div", "setup-hero");
    hero.innerHTML =
      '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z M18.5 15l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    hero.append(el("h2", null, "Ask the Library"),
      el("p", "hint", "Every answer cites sources you can tap. Try:"));
    card.append(hero);
    const sugg = el("div", "suggestions");
    for (const s of ["Give me verses about hope",
                     "What did Polycarp say before his martyrdom?",
                     "Where does Josephus mention James the brother of Jesus?"]) {
      const chip = el("button", "sugchip", s);
      chip.onclick = () => {
        const ta = $("#askq");
        ta.value = s;
        ta.dispatchEvent(new Event("input"));
        ta.focus();
      };
      sugg.append(chip);
    }
    card.append(sugg);
    const nudge = el("div");
    card.append(nudge);
    renderAiDataControl(nudge, true);
    return;
  }
  card.hidden = false;
  card.innerHTML = "";
  card.className = "setup";

  const hero = el("div", "setup-hero");
  hero.innerHTML =
    '<svg viewBox="0 0 24 24" width="34" height="34"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z M18.5 15l.9 2.3 2.3.9-2.3.9-.9 2.3-.9-2.3-2.3-.9 2.3-.9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  hero.append(el("h2", null, "Ask the Library"),
    el("p", "hint",
      "Grounded answers from your books and Bible — every answer cites " +
      "sources you can tap. Choose how answers are generated:"));
  card.append(hero);

  const mkCard = (id, icon, name, sub) => {
    const c = el("div", "provider-card");
    c.dataset.provider = id;
    const head = el("div", "pchead");
    const ic = el("span", "pcicon");
    ic.innerHTML = icon;
    const tw = el("div", "pctitle");
    tw.append(el("h4", null, name), el("span", "pcsub", sub));
    head.append(ic, tw);
    const badge = el("span", "badge", "Selected");
    head.append(badge);
    c.append(head);
    c.classList.toggle("active", S.provider === id);
    c.onclick = (e) => {
      if (e.target.closest("button, input, select, a")) return;
      S.provider = id;
      LLM.saveAiSettings();
      buildAskSetup(true);
    };
    return c;
  };

  // ---- on-device card
  const local = mkCard("local",
    '<svg viewBox="0 0 24 24" width="22" height="22"><rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M9 1.5v3M15 1.5v3M9 19.5v3M15 19.5v3M1.5 9h3M1.5 15h3M19.5 9h3M19.5 15h3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    "On-device AI", "Private · offline · free");
  if (!LLM.localAvailable()) {
    local.append(el("p", "pcdesc",
      "Runs a Gemma model entirely on your device. Available in the " +
      "Android app."));
    local.classList.add("disabled");
  } else {
    local.append(el("p", "pcdesc",
      "Runs a Gemma model entirely on this device. Nothing leaves your " +
      "device — works in airplane mode."));
    const act = el("div", "pcactions");
    if (st.loaded) {
      act.append(el("span", "pcstatus ok", "Model loaded"));
    } else if (st.hasModel) {
      act.append(el("span", "pcstatus",
        `Model ready (${(st.modelBytes / 1e9).toFixed(1)} GB)`));
      const b = el("button", "pcbtn", "Load model");
      b.onclick = async () => {
        b.disabled = true;
        b.textContent = "Loading… (up to a minute)";
        try { await LLM.loadModel(); } catch (e) {
          act.append(el("p", "hint", "Load failed: " + (e.message ?? e)));
        }
        buildAskSetup(force);
      };
      act.append(b);
    } else {
      act.append(el("span", "pcstatus", "No model on this device yet"));
      const b = el("button", "pcbtn", "Import model file…");
      b.onclick = async () => {
        const prog = el("p", "hint", "");
        act.append(prog);
        const sub = await LLM.onImportProgress((ev) => {
          prog.textContent = `Copying… ${(ev.copiedBytes / 1e6).toFixed(0)} MB`;
        });
        try { await LLM.importModel(); } catch (e) {
          prog.textContent = "Import: " + (e.message ?? e);
        }
        sub.remove?.();
        buildAskSetup(force);
      };
      act.append(b);
    }
    local.append(act);
  }
  card.append(local);

  // ---- Claude card
  const claude = mkCard("claude",
    '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 2.5l2.4 6.1 6.1 2.4-6.1 2.4L12 19.5l-2.4-6.1-6.1-2.4 6.1-2.4z" fill="currentColor"/></svg>',
    "Claude — your account", "Fast · highest quality · uses your API key");
  claude.append(el("p", "pcdesc",
    "Answers are written by Claude using an API key from your Anthropic " +
    "account (console.anthropic.com — app sign-in isn't offered to " +
    "third-party apps). Search stays on this device; only your question " +
    "and the retrieved passages are sent. The key is stored only on " +
    "this device."));
  const cact = el("div", "pcactions column");
  const key = el("input", "keyinput");
  key.type = "password";
  // never re-render the saved key into the DOM; a saved key shows as a state
  key.placeholder = S.claudeKey ? "key saved — paste a new one to replace" : "sk-ant-…";
  key.autocomplete = "off";
  key.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go.click();
  });
  const msel = el("select", "pcmodel");
  for (const [v, t] of [["claude-sonnet-5", "Claude Sonnet 5 (recommended)"],
                        ["claude-haiku-4-5", "Claude Haiku 4.5 (fastest)"],
                        ["claude-opus-5", "Claude Opus 5 (deepest)"]])
    msel.append(new Option(t, v));
  msel.value = S.claudeModel ?? "claude-sonnet-5";
  const note = el("p", "hint", LLM.claudeReady() ? "Connected." : "");
  const go = el("button", "pcbtn",
    LLM.claudeReady() ? "Reconnect" : "Connect");
  go.onclick = async () => {
    const k = key.value.trim() || S.claudeKey || "";
    if (!k) { note.textContent = "Enter your API key first."; return; }
    go.disabled = true;
    go.textContent = "Checking…";
    S.provider = "claude";
    S.claudeKey = k;
    S.claudeModel = msel.value;
    try {
      await LLM.generateClaude("Reply with OK.", () => {}, 0);
      LLM.saveAiSettings();
      note.textContent = "";
      buildAskSetup();          // ready now — setup hides
      $("#askq").focus();
      return;
    } catch (e) {
      S.claudeKey = "";
      note.textContent = "Could not connect: " + (e.message ?? e);
    }
    go.disabled = false;
    go.textContent = "Connect";
  };
  cact.append(key, msel, go, note);
  claude.append(cact);
  card.append(claude);

  const nudge = el("div");
  card.append(nudge);
  renderAiDataControl(nudge, true);
}

const refreshModelCard = buildAskSetup;   // legacy call sites

async function askQuestion() {
  const ta = $("#askq");
  const q = ta.value.trim();
  if (!q || $("#askgo").disabled) return;      // one generation at a time
  if (!(LLM.claudeReady() || modelLoaded)) {   // surface setup, not a dead tap
    buildAskSetup(true);
    window.scrollTo(0, 0);
    return;
  }
  ta.value = "";
  ta.style.height = "auto";
  $("#askgo").disabled = true;
  $("#askmodel").hidden = true;          // clear empty-state suggestions
  const thread = $("#askthread");
  thread.append(el("div", "msg q", q));
  const a = el("div", "msg a");
  thread.append(a);
  // animated thinking indicator with live stage text
  const think = el("div", "thinking");
  const stageEl = el("span", "stage", "Starting");
  const dots = el("span", "dots");
  dots.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
  think.append(stageEl, dots);
  a.append(think);
  window.scrollTo(0, document.documentElement.scrollHeight);
  let firstToken = false;
  let hits = [];
  try {
    const res = await LLM.answer(q, (acc) => {
      if (!firstToken && acc.trim()) {
        firstToken = true;
      }
      if (firstToken) {
        a.textContent = acc;
        window.scrollTo(0, document.documentElement.scrollHeight);
      }
    }, (stage) => {
      if (!firstToken) stageEl.textContent = stage;
    });
    hits = res.hits;
    if (!hits.length) {
      a.textContent = "I couldn't find any Library passages matching that — try different words.";
    } else if (!res.text.trim()) {
      a.textContent = "[The model couldn't produce an answer — try rephrasing, or a larger model.]";
    }
  } catch (e) {
    a.textContent = "[generation failed: " + (e.message ?? e) + "]";
  }
  // sources under the answer, tappable; kept in the saved conversation too
  try {
    const sources = hits.map((h) => h.kind === "verse"
      ? { kind: "verse", book_nr: h.book_nr, chapter: h.chapter,
          verse: h.verse, book: h.book }
      : { work_id: h.work_id, page: h.page,
          title: h.title, section: h.section, pages: h.pages });
    if (sources.length) thread.append(sourcesBlock(sources, a.textContent));
    persistTurn(q, a.textContent, sources);
  } finally {
    $("#askgo").disabled = false;        // never leave Send stuck disabled
  }
}

// --------------------------------------------------------------------- boot
const PHASE_LABEL = {
  download: "Downloading database",
  decompress: "Decompressing",
  install: "Installing to device storage",
  embedder: "Downloading AI embedder",
};
DB.setProgressHandler(({ phase, loaded, total }) => {
  $("#status").textContent = PHASE_LABEL[phase] ?? phase;
  const pct = total ? Math.round((loaded / total) * 100) : 0;
  $("#bar").style.width = pct + "%";
  $("#pct").textContent = phase === "download"
    ? `${(loaded / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB` : "";
});

// Anything that escapes a fire-and-forget handler (a tap, a page turn) used
// to vanish into the console; show it instead of leaving "Loading…" forever.
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason?.message ?? String(e.reason);
  console.error(e.reason);
  const boot = $("#boot");
  if (boot && !boot.hidden) { $("#status").textContent = "Error: " + msg; return; }
  let t = $("#errtoast");
  if (!t) {
    t = el("div", "errtoast");
    t.id = "errtoast";
    document.body.append(t);
  }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 6000);
});

// PWA route: a newer data version is on the server. Offer it instead of
// silently pulling hundreds of megabytes at boot; the old data keeps working.
function offerUpdate(updates) {
  const mb = Math.round(Object.values(updates).reduce((s, u) => s + u.gz_size, 0) / 1e6);
  const bar = el("div", "updatebar");
  bar.append(el("span", null, `New Bible data is available (${mb} MB download).`));
  const now = el("button", "annbtn", "Update now");
  const later = el("button", "annbtn", "Later");
  later.onclick = () => bar.remove();
  now.onclick = async () => {
    now.disabled = later.disabled = true;
    const status = el("span", "hint", " Downloading…");
    bar.append(status);
    DB.setProgressHandler(({ phase, loaded, total }) => {
      status.textContent = phase === "download"
        ? ` Downloading ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`
        : ` ${PHASE_LABEL[phase] ?? phase}…`;
    });
    try {
      await DB.applyUpdates();
      status.textContent = " Updated — reloading.";
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      status.textContent = " Update failed: " + e.message + " (your current data still works)";
      now.disabled = later.disabled = false;
    }
  };
  bar.append(now, later);
  document.body.prepend(bar);
}

async function main() {
  // register the shell cache + ask for durable storage BEFORE the (possibly
  // very long) data install, so leaving early still leaves an offline shell
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  navigator.storage?.persist?.().catch(() => {});
  try {
    const { counts, updates, packs: packList } = await DB.start();
    setPacks(packList);
    // a pack arriving or leaving changes what the reader and Library can show
    packListeners.add(() => {
      if (currentView === "read") renderChapter();
      buildLibrary();
    });
    $("#boot").hidden = true;
    if (updates && Object.keys(updates).length) offerUpdate(updates);
    books = await DB.getBooks();
    const texts = await DB.getTexts();
    textIds = texts.map((t) => t.id);
    for (const t of texts) textLang.set(t.id, t.lang);
    try {
      for (const b of await DB.getBookCodes()) {
        if (b.ob_code) bookCodes.set(b.ob_code, b.nr);
        if (b.step_code) bookCodes.set(b.step_code, b.nr);
      }
    } catch { /* ignore */ }
    try {
      for (const t of await DB.getTextTraditions()) textTradition.set(t.text_id, t.tradition);
      for (const t of await DB.getMappedTexts()) mappedTexts.add(t.text_id);
    } catch { /* older DB: everything treated as English numbering */ }
    // a text id can disappear in a data update (codex -> wlc happened once):
    // never leave the reader pointed at a slot nothing can render
    const known = new Set([...textIds, ...Object.keys(TAGGED), "none"]);
    if (!known.has(state.textA)) state.textA = "web";
    if (!known.has(state.textB)) state.textB = "ylt";
    // a selected text that is no longer on the device (removed from the
    // catalog, or a fresh install) must not leave the reader empty at boot:
    // fall back to an installed text, or to nothing for the second slot
    const readable = (t) => t === "none" ||
      packInstalled(isTagged(t) ? taggedItem(t) : (packOfText(t) ?? ""));
    const firstText = packs.find((p) => p.kind === "text" && p.installed)?.text;
    if (!readable(state.textA)) state.textA = readable("web") ? "web" : (firstText ?? state.textA);
    if (!readable(state.textB)) state.textB = readable("ylt") && state.textA !== "ylt" ? "ylt" : "none";
    // canonical chapter counts from the core (not from any one text, which
    // the user may have removed), plus each text's book coverage
    chapterCounts = new Map(
      (await DB.getBookChapters()).map((r) => [r.book_nr, r.n]));
    try {
      for (const r of await DB.getTextBooksAll()) {
        if (!textBooks.has(r.text_id)) textBooks.set(r.text_id, new Set());
        textBooks.get(r.text_id).add(r.book_nr);
      }
    } catch { /* older core */ }
    // apocrypha: aggregate across the texts that carry each book
    const NAME_PRIORITY = ["kjva", "lxxen"];
    const apocMap = new Map();
    for (const r of await DB.getApocryphaBooks()) {
      const e = apocMap.get(r.nr) ??
        { nr: r.nr, name: r.name, namePri: 99, chapters: 0 };
      const pri = NAME_PRIORITY.indexOf(r.text_id);
      if (pri !== -1 && pri < e.namePri) { e.name = r.name; e.namePri = pri; }
      e.chapters = Math.max(e.chapters, r.chapters ?? 1);
      apocMap.set(r.nr, e);
      if (!apocTexts.has(r.nr)) apocTexts.set(r.nr, new Set());
      apocTexts.get(r.nr).add(r.text_id);
    }
    apocBooks = [...apocMap.values()].sort((a, b) => a.nr - b.nr);
    buildControls();
    initReadAloud();
    buildBookPicker();
    buildSettings(counts);
    buildLibrary();          // async fill; view exists immediately
    $("#reader").hidden = false;
    initAutoHideBar();
    try {
      for (const w of await DB.getWorks()) worksBySlug.set(w.id, w.slug);
    } catch { /* library not ready */ }
    // a deep link wins over the remembered position; otherwise resume
    const route = urlRouting() ? parseRoute(location.pathname) : null;
    if (!(await openRoute(route))) {
      showView("read");
      await go({});
    }
  } catch (e) {
    $("#status").textContent = "Error: " + e.message;
    console.error(e);
    $("#progress").hidden = true;
    const retry = el("button", "pcbtn", "Try again");
    retry.onclick = () => location.reload();
    $("#boot").append(retry);
  }
}

main();

// The user's own layer: highlights, bookmarks and notes on verses and on
// Library pages. Stored on the device in IndexedDB (localStorage fallback),
// never sent anywhere. Exportable as Markdown that follows the vault's note
// conventions (`Book Ch:Vv (VERSION)` refs), which is also the v2 sync path.
//
// Record shape (one per target):
//   { key, kind: "verse"|"work", book, chapter, verse | workId, page, title,
//     color: null|"yellow"|"green"|"blue"|"pink", bookmark: bool,
//     note: "", ts }
// A record with no colour, no bookmark and an empty note is deleted.

const DB_NAME = "atb-user", STORE = "annotations";
let dbP = null;

function openDb() {
  if (dbP) return dbP;
  dbP = new Promise((resolve) => {
    if (!("indexedDB" in window)) { resolve(null); return; }
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const st = db.createObjectStore(STORE, { keyPath: "key" });
          st.createIndex("kind", "kind");
          st.createIndex("chapter", "chapterKey");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbP;
}

// localStorage fallback (small, but keeps the feature alive in odd contexts)
const LS_KEY = "atb-annotations";
function lsAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}") || {}; } catch { return {}; }
}
function lsSave(all) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(all)); } catch { /* quota */ }
}

const tx = (db, mode, fn) => new Promise((resolve, reject) => {
  const t = db.transaction(STORE, mode);
  const st = t.objectStore(STORE);
  let out;
  try { out = fn(st); } catch (e) { reject(e); return; }
  t.oncomplete = () => resolve(out?.result ?? out);
  t.onerror = () => reject(t.error);
});
const reqP = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export const verseKey = (book, chapter, verse) => `verse:${book}.${chapter}.${verse}`;
export const workKey = (workId, page) => `work:${workId}.${page}`;
const chapterKeyOf = (r) => r.kind === "verse" ? `verse:${r.book}.${r.chapter}` : `work:${r.workId}`;
const isEmpty = (r) => !r.color && !r.bookmark && !(r.note && r.note.trim());

export async function get(key) {
  const db = await openDb();
  if (!db) return lsAll()[key] ?? null;
  try {
    return (await tx(db, "readonly", (st) => reqP(st.get(key)))) ?? null;
  } catch { return null; }
}

// every record for a chapter (or a whole work), keyed by verse / page
export async function forChapter(book, chapter) {
  return byChapterKey(`verse:${book}.${chapter}`);
}
export async function forWork(workId) {
  return byChapterKey(`work:${workId}`);
}
async function byChapterKey(ck) {
  const db = await openDb();
  if (!db) {
    return Object.values(lsAll()).filter((r) => chapterKeyOf(r) === ck);
  }
  try {
    return await tx(db, "readonly", (st) => reqP(st.index("chapter").getAll(ck)));
  } catch { return []; }
}

export async function save(record) {
  record.ts = Date.now();
  record.chapterKey = chapterKeyOf(record);
  if (isEmpty(record)) return remove(record.key);
  const db = await openDb();
  if (!db) { const all = lsAll(); all[record.key] = record; lsSave(all); return record; }
  try { await tx(db, "readwrite", (st) => st.put(record)); } catch { /* quota */ }
  return record;
}

export async function remove(key) {
  const db = await openDb();
  if (!db) { const all = lsAll(); delete all[key]; lsSave(all); return null; }
  try { await tx(db, "readwrite", (st) => st.delete(key)); } catch { /* ignore */ }
  return null;
}

export async function all() {
  const db = await openDb();
  if (!db) return Object.values(lsAll());
  try { return await tx(db, "readonly", (st) => reqP(st.getAll())); } catch { return []; }
}

// Import what toMarkdown wrote (from another device, or hand-edited in the
// vault). nrByName: lowercased book name -> nr. Returns the records parsed;
// the caller decides whether to merge or replace.
export function fromMarkdown(md, nrByName) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur) { cur.note = cur.note.trim(); out.push(cur); cur = null; } };
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    const v = line.match(/^- \*\*(.+?) (\d+):(\d+) \([A-Za-z0-9]+\)\*\*(?: — (.*))?$/);
    const w = line.match(/^- \*\*(.+?), p\. (\d+)\*\*(?: — (.*))?$/);
    if (v) {
      flush();
      const nr = nrByName.get(v[1].toLowerCase());
      if (!nr) continue;
      const tags = v[4] ?? "";
      cur = { kind: "verse", book: nr, chapter: +v[2], verse: +v[3],
              key: verseKey(nr, +v[2], +v[3]),
              bookmark: /\bbookmark\b/.test(tags),
              color: (tags.match(/highlight: (\w+)/) ?? [])[1] ?? null, note: "" };
    } else if (w) {
      flush();
      cur = { kind: "work", title: w[1], page: +w[2], workId: null,
              key: null, bookmark: /\bbookmark\b/.test(w[3] ?? ""), color: null, note: "" };
    } else if (cur && /^  /.test(raw)) {
      cur.note += raw.slice(2) + "\n";
    } else if (cur && line === "") {
      cur.note += "\n";
    } else {
      flush();
    }
  }
  flush();
  return out;
}

// Markdown export following notes/ conventions; bookNames: nr -> name
export function toMarkdown(records, bookNames, textId = "KJV") {
  const verses = records.filter((r) => r.kind === "verse")
    .sort((a, b) => a.book - b.book || a.chapter - b.chapter || a.verse - b.verse);
  const works = records.filter((r) => r.kind === "work")
    .sort((a, b) => (a.title ?? "").localeCompare(b.title ?? "") || a.page - b.page);
  const lines = ["# My notes & highlights", "",
    `Exported ${new Date().toISOString().slice(0, 10)} from Library 422.`, ""];
  if (verses.length) {
    lines.push("## Bible", "");
    for (const r of verses) {
      const ref = `${bookNames.get(r.book) ?? `Book ${r.book}`} ${r.chapter}:${r.verse} (${textId.toUpperCase()})`;
      const tags = [r.bookmark ? "bookmark" : "", r.color ? `highlight: ${r.color}` : ""].filter(Boolean).join(", ");
      lines.push(`- **${ref}**${tags ? ` — ${tags}` : ""}`);
      if (r.note && r.note.trim()) for (const l of r.note.trim().split("\n")) lines.push(`  ${l}`);
    }
    lines.push("");
  }
  if (works.length) {
    lines.push("## Library", "");
    for (const r of works) {
      const tags = [r.bookmark ? "bookmark" : ""].filter(Boolean).join(", ");
      lines.push(`- **${r.title ?? `Work ${r.workId}`}, p. ${r.page}**${tags ? ` — ${tags}` : ""}`);
      if (r.note && r.note.trim()) for (const l of r.note.trim().split("\n")) lines.push(`  ${l}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

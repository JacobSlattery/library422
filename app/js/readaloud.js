// Chapter read-aloud: plays a list of {id, text, lang} items one after the
// other and reports which one is being read, so the reader can highlight and
// scroll. Two backends behind one API:
//
//   Android  -> the Capacitor `Tts` plugin (TtsPlugin.java):
//               speakQueue({items:[{id,text,lang}], rate}) · pause() · resume()
//               · stopAll(), events ttsStart{id} · ttsDone{id} ·
//               ttsError{id,message} · ttsFinished{}
//   Web      -> SpeechSynthesis, one utterance per item (long items are split
//               at sentence boundaries: several engines cut utterances that run
//               past ~15 s).
//
// `lang` is the reader's language code: en · grc · hbo · la · syr.
// Every backend call is wrapped: this module never throws into the UI.

const BCP47 = { en: "en-US", grc: "el-GR", hbo: "he-IL", la: "la", syr: "syr" };
const SHORT = { en: "en", grc: "el", hbo: "he", la: "la", syr: "syr" };

const plugin = () => window.Capacitor?.Plugins?.Tts ?? null;

let playing = false, paused = false;
let handles = [];              // Capacitor listener handles
let webQueue = [], webIndex = 0, webUtterance = null;
let cb = {};

// ---- availability ---------------------------------------------------------
let voicesReadyP = null;
function webVoices() {
  if (!window.speechSynthesis) return Promise.resolve([]);
  const have = speechSynthesis.getVoices();
  if (have.length) return Promise.resolve(have);
  voicesReadyP ??= new Promise((resolve) => {
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener("voiceschanged", done, { once: true });
    setTimeout(done, 1500);          // engines that never fire the event
  });
  return voicesReadyP;
}

export async function available(lang) {
  const p = plugin();
  if (p) {
    try {
      const v = await p.voices();
      if (v.ready === false) return null;     // engine still starting: unknown
      return !!v[SHORT[lang] ?? lang];
    } catch { return false; }
  }
  const voices = await webVoices();
  const want = (SHORT[lang] ?? lang).toLowerCase();
  return voices.some((v) => v.lang.toLowerCase().startsWith(want));
}

// ---- control --------------------------------------------------------------
export const isPlaying = () => playing && !paused;
export const isPaused = () => playing && paused;

function finish() {
  playing = false; paused = false;
  detach();
  const done = cb.onDone;
  cb = {};
  try { done?.(); } catch { /* UI's problem */ }
}

function detach() {
  for (const h of handles) { try { h.then?.((x) => x.remove()) ?? h.remove?.(); } catch { /* gone */ } }
  handles = [];
}

export async function start(items, { rate = 0.9, onVerse, onDone, onError } = {}) {
  await stop();
  const list = items.filter((it) => it && it.text && it.text.trim());
  if (!list.length) return false;
  cb = { onVerse, onDone, onError };
  playing = true; paused = false;
  const p = plugin();
  if (p) {
    const add = (name, fn) => handles.push(p.addListener(name, fn));
    add("ttsStart", (ev) => { try { cb.onVerse?.(ev.id); } catch { /* ignore */ } });
    add("ttsError", (ev) => { try { cb.onError?.(ev.message ?? "speech error"); } catch { /* ignore */ } });
    add("ttsFinished", () => finish());
    try {
      await p.speakQueue({
        items: list.map((it) => ({ id: String(it.id), text: it.text, lang: BCP47[it.lang] ?? it.lang })),
        rate,
      });
      return true;
    } catch (e) {
      playing = false; detach();
      try { onError?.(String(e?.message ?? e)); } catch { /* ignore */ }
      return false;
    }
  }
  if (!window.speechSynthesis) {
    playing = false;
    try { onError?.("This browser has no speech synthesis."); } catch { /* ignore */ }
    return false;
  }
  webQueue = list.map((it) => ({ ...it, rate }));
  webIndex = 0;
  speakWebItem();
  return true;
}

// split long text at sentence boundaries (~180 chars) for engines that cut
function chunks(text) {
  const out = [];
  let buf = "";
  for (const s of text.split(/(?<=[.!?;:])\s+/)) {
    if ((buf + " " + s).length > 180 && buf) { out.push(buf); buf = s; }
    else buf = buf ? buf + " " + s : s;
  }
  if (buf) out.push(buf);
  return out;
}

function speakWebItem() {
  if (!playing || paused) return;
  if (webIndex >= webQueue.length) { finish(); return; }
  const it = webQueue[webIndex];
  const parts = chunks(it.text);
  let pi = 0;
  const next = () => {
    if (!playing || paused) return;
    if (pi >= parts.length) { webIndex++; speakWebItem(); return; }
    const u = new SpeechSynthesisUtterance(parts[pi++]);
    u.lang = BCP47[it.lang] ?? it.lang;
    u.rate = it.rate;
    if (pi === 1) u.onstart = () => { try { cb.onVerse?.(String(it.id)); } catch { /* ignore */ } };
    u.onend = next;
    u.onerror = (e) => {
      if (e.error === "interrupted" || e.error === "canceled") return;
      try { cb.onError?.(e.error ?? "speech error"); } catch { /* ignore */ }
      next();
    };
    webUtterance = u;
    try { speechSynthesis.speak(u); } catch { next(); }
  };
  next();
}

export async function pause() {
  if (!playing || paused) return;
  paused = true;
  const p = plugin();
  if (p) { try { await p.pause(); } catch { /* ignore */ } return; }
  try { speechSynthesis.cancel(); } catch { /* ignore */ }   // pause() is unreliable; restart the item on resume
}

export async function resume() {
  if (!playing || !paused) return;
  paused = false;
  const p = plugin();
  if (p) { try { await p.resume(); } catch { /* ignore */ } return; }
  speakWebItem();
}

export async function stop() {
  if (!playing) return;
  playing = false; paused = false;
  const p = plugin();
  if (p) { try { await p.stopAll(); } catch { /* ignore */ } }
  else { try { speechSynthesis.cancel(); } catch { /* ignore */ } }
  detach();
  cb = {};
}

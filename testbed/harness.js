// Desktop eval harness: runs the app's UNMODIFIED db.js + llm.js pipeline
// against a local model via MediaPipe's web runtime. Driven over CDP through
// window.__eval.
import { FilesetResolver, LlmInference } from "./vendor/genai/genai_bundle.mjs";

const params = new URLSearchParams(location.search);
const MODEL_PATH = params.get("model") ?? "/models/gemma-3n-E4B-it-int4.litertlm";

const log = (m) => {
  document.querySelector("#log").textContent += "\n" + m;
  console.log(m);
};

// ---- Capacitor shim backed by the web runtime ------------------------------
let llm = null;
let fileset = null;
const listeners = { token: [], importProgress: [] };

window.Capacitor = {
  isNativePlatform: () => true,
  Plugins: {
    Llm: {
      async status() {
        return { hasModel: true, modelBytes: 0,
                 file: MODEL_PATH.split("/").pop(), loaded: !!llm };
      },
      async loadModel({ maxTokens }) {
        fileset ??= await FilesetResolver.forGenAiTasks("./vendor/genai");
        if (llm) { try { llm.close(); } catch {} llm = null; }
        llm = await LlmInference.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MODEL_PATH },
          maxTokens,
        });
        return { loaded: true };
      },
      async countTokens({ text }) {
        return { tokens: llm.sizeInTokens(text) };
      },
      async generate({ prompt }) {
        return new Promise((resolve, reject) => {
          try {
            llm.generateResponse(prompt, (part, done) => {
              for (const cb of [...listeners.token]) cb({ text: part, done });
              if (done) resolve({ done: true });
            });
          } catch (e) {
            reject(e);
          }
        });
      },
      async stop() { /* web runtime has no cancel; sanitize handles it */ },
      addListener(name, cb) {
        listeners[name].push(cb);
        return { remove() {
          listeners[name] = listeners[name].filter((x) => x !== cb);
        } };
      },
    },
  },
};

// ---- app modules (unmodified) ----------------------------------------------
const DB = await import("/js/db.js");
const LLM = await import("/js/llm.js");

window.__eval = {
  ready: false,
  async init() {
    const { counts } = await DB.start();
    this.ready = true;
    log(`db ready: ${counts.verses} verses, ${counts.library} works`);
    return counts;
  },
  async load(maxTokens = 4096) {
    const t0 = performance.now();
    await window.Capacitor.Plugins.Llm.loadModel({ maxTokens });
    LLM.contextTokens = maxTokens;   // keep module state in sync
    const ms = Math.round(performance.now() - t0);
    log(`model loaded in ${ms} ms (maxTokens ${maxTokens})`);
    return ms;
  },
  async retrieve(q, want = 4) {
    return LLM.retrieve(q, want);
  },
  async prompt(q, n = 6, len = 2000) {
    const hits = await LLM.retrieve(q, n);
    const prompt = await LLM.buildPrompt(q, hits.slice(0, n), len);
    return { hits, prompt };
  },
  expansionPrompt(q) {
    return LLM.expansionPrompt(q);
  },
  async promptEx(q, expText, n = 8, len = 2000) {
    // route-aware (bible verses vs library works) — same path the app takes
    return LLM.planPrompt(q, expText, n, len);
  },
  async ask(q) {
    const t0 = performance.now();
    const hits = await LLM.retrieve(q, 4);
    let last = "";
    const answer = await LLM.answer(q, hits, (acc) => { last = acc; });
    const ms = Math.round(performance.now() - t0);
    log(`Q: ${q}\nA (${ms} ms): ${answer.slice(0, 300)}`);
    return { hits, answer, ms };
  },
  DB, LLM, log,
};
log("harness ready — call __eval.init() then __eval.load()");

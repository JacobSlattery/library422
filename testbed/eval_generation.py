"""Generation eval: app-code retrieval+prompt (via harness/CDP) + Gemma via
llama-server. Scores answer correctness and Where-format compliance.

Prereqs: dev server on :8000, llama-server on :8081 with the Gemma GGUF.
Usage: pixi run python testbed/eval_generation.py [questions.json] [outname] [temp]
Defaults: testbed/suite.json -> testbed/RESULTS.md (append), temp 0.2.

Scoring separates the classes that matter differently:
  PASS  — answered, expected facts present
  MISS  — declined ("passages do not contain") when an answer exists: annoying
  WRONG — gave an answer that lacks the expected facts, or answered a
          negative control: the UNACCEPTABLE class (owner: no wrong answers)
"""
import asyncio
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TEMP = r"C:\Users\timbe\AppData\Local\Temp"
SUITE_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "testbed" / "suite.json"
OUT = ROOT / "testbed" / (sys.argv[2] if len(sys.argv) > 2 else "RESULTS.md")
ANSWER_TEMP = float(sys.argv[3]) if len(sys.argv) > 3 else 0.2
VERIFY = len(sys.argv) > 4 and sys.argv[4] == "verify"
# argv[5]: "chat" (llama applies the GGUF template) | "gemma3" | "gemma4"
# (raw /completion with the SAME manual wrap the phone's llm.js applies —
# maximum fidelity, and the only working path for Gemma 4, whose embedded
# tool-calling template our llama.cpp can't render)
WRAP = sys.argv[5] if len(sys.argv) > 5 else "chat"
LLAMA = "http://localhost:8081/v1/chat/completions"
LLAMA_RAW = "http://localhost:8081/completion"
STOPS = ["<turn|>", "<|turn>", "<end_of_turn>", "<start_of_turn>"]

VERIFY_SUFFIX = (
    "\n\nNow act as a strict fact-checker. Compare the proposed answer above "
    "against the numbered passages ONLY. If every factual claim in it is "
    "directly supported by the passages, reply exactly SUPPORTED. If any "
    "claim is absent from the passages, contradicts them, or attributes "
    "something to the wrong person or work, reply UNSUPPORTED followed by "
    "the reason in one sentence.")

WHERE_RE = re.compile(r"\bWhere:\s*[^\n]*p\.\s*\d+", re.I)
CITE_RE = re.compile(r"\[\d+\]")
# mirrors llm.js LOCATION_RE: inline Where lines only when asked for
LOCATION_RE = re.compile(
    r"\bwhere\b|\bin which\b|"
    r"\bwhich (book|chapter|epistle|letter|work|volume|section|page)\b|"
    r"\bwhat (chapter|book|section|page)\b", re.I)
DECLINE_RE = re.compile(
    r"do(es)? not (contain|answer)|not found|no passage|don't contain|"
    r"cannot find|couldn't find|not specified|do(es)? not specify|"
    r"none of (these|the) verses|cannot answer", re.I)

_id = 0
async def cdp(ws, method, params=None, timeout=None):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg.get("id") == _id:
            return msg.get("result", {})

async def evaljs(ws, expr, timeout=600):
    r = await cdp(ws, "Runtime.evaluate",
                  {"expression": expr, "returnByValue": True,
                   "awaitPromise": True}, timeout)
    res = r.get("result", {})
    if res.get("subtype") == "error":
        raise RuntimeError(str(res.get("description"))[:300])
    return res.get("value")

def ask_llama(prompt, max_tokens=400, temp=ANSWER_TEMP):
    if WRAP == "gemma4":
        wrapped = f"<|turn>user\n{prompt}<turn|>\n<|turn>model\n"
    elif WRAP == "gemma3":
        wrapped = (f"<start_of_turn>user\n{prompt}<end_of_turn>\n"
                   "<start_of_turn>model\n")
    else:
        wrapped = None
    if wrapped is not None:
        body = json.dumps({"prompt": wrapped, "n_predict": max_tokens,
                           "temperature": temp, "stop": STOPS}).encode()
        req = urllib.request.Request(LLAMA_RAW, data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=1800) as r:
            return json.load(r)["content"]
    body = json.dumps({
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "temperature": temp,
    }).encode()
    req = urllib.request.Request(LLAMA, data=body,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=1800) as r:
        out = json.load(r)
    return out["choices"][0]["message"]["content"]

async def main():
    suite = json.loads(SUITE_PATH.read_text(encoding="utf-8"))
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
        "--remote-debugging-port=9222",
        f"--user-data-dir={TEMP}\\atb-cdp-profile", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results = []
    try:
        target = None
        for _ in range(60):
            try:
                with urllib.request.urlopen("http://localhost:9222/json") as r:
                    target = next(t for t in json.load(r) if t["type"] == "page")
                break
            except Exception:
                time.sleep(0.5)
        async with websockets.connect(target["webSocketDebuggerUrl"],
                                      max_size=50_000_000, ping_interval=None) as ws:
            await cdp(ws, "Runtime.enable")
            await cdp(ws, "Page.enable")
            await cdp(ws, "Page.navigate",
                      {"url": "http://localhost:8000/testbed/harness.html"})
            for _ in range(30):
                try:
                    if await evaljs(ws, "!!window.__eval") is True:
                        break
                except Exception:
                    pass
                await asyncio.sleep(1)
            await evaljs(ws, "__eval.init()", 300)
            for t in suite["tests"]:
                t0 = time.time()
                exp_prompt = await evaljs(ws,
                    f"__eval.expansionPrompt({json.dumps(t['q'])})", 60)
                expansions = ask_llama(exp_prompt, max_tokens=60, temp=0.7)
                p = await evaljs(ws,
                    f"__eval.promptEx({json.dumps(t['q'])}, {json.dumps(expansions)})",
                    300)
                answer = ask_llama(p["prompt"])
                # knowledge-probe retry on decline (mirrors llm.js answer())
                if DECLINE_RE.search(answer) and not t.get("negative"):
                    probe = ask_llama(
                        "In at most 8 words, list the key proper names or "
                        "distinctive terms involved in answering this (no "
                        "explanation, no sentence):\n" + t["q"],
                        max_tokens=30, temp=0.3)
                    exp2 = (expansions + "\n" + probe.splitlines()[0][:80]).strip()
                    p = await evaljs(ws,
                        f"__eval.promptEx({json.dumps(t['q'])}, {json.dumps(exp2)})",
                        300)
                    answer = ask_llama(p["prompt"])
                # optional grounding verification: one extra generation that
                # cross-checks the answer against its CITED passages only
                # (mirrors the app's llm.js verifyPrompt exactly)
                verify_note = ""
                if VERIFY and not DECLINE_RE.search(answer):
                    vp = await evaljs(ws,
                        "__eval.LLM.verifyPrompt(" +
                        f"{json.dumps(t['q'])}, {json.dumps(answer)}, "
                        f"{json.dumps(p['hits'])})", 120)
                    check = ask_llama(vp, max_tokens=80, temp=0.1)
                    if "UNSUPPORTED" in check.upper():
                        verify_note = " [verifier: " + check.strip()[:160] + "]"
                        answer = ("These passages do not contain a supported "
                                  "answer.")
                # app appends authoritative Where lines from hit metadata —
                # inline only when the question asks for a location
                where = await evaljs(ws,
                    "__eval.LLM.whereLines(" +
                    f"{json.dumps(answer)}, {json.dumps(p['hits'])})", 60)
                if where and LOCATION_RE.search(t["q"]):
                    answer = answer.rstrip() + "\n" + where
                ms = round((time.time() - t0) * 1000)
                slugs = [h.get("slug", "") for h in p["hits"][:3]]
                expect = t.get("expect_slug")
                if isinstance(expect, str):
                    expect = [expect]
                r_hit = (any(e in s for e in expect for s in slugs)
                         if expect else True)
                negative = t.get("negative", False)
                declined = bool(DECLINE_RE.search(answer))
                low = answer.lower()
                facts_ok = all(m.lower() in low for m in t.get("answer_must", []))
                anyof = t.get("answer_any")
                if facts_ok and anyof:
                    facts_ok = any(m.lower() in low for m in anyof)
                # forbidden claims (trap questions): asserting one = WRONG
                bad = any(m.lower() in low for m in t.get("answer_must_not", []))
                if negative:
                    verdict = "PASS" if declined else "WRONG"
                elif t.get("trap"):
                    # false-premise question: declining OR correcting the
                    # premise (anyof terms) passes; adapting to it is WRONG
                    corrected = anyof and any(m.lower() in low for m in anyof)
                    verdict = "PASS" if (declined or corrected) and not bad \
                        else "WRONG"
                elif declined:
                    verdict = "MISS"
                elif facts_ok and not bad:
                    verdict = "PASS"
                else:
                    verdict = "WRONG"
                f_ok = bool(CITE_RE.search(answer))
                if LOCATION_RE.search(t["q"]):   # asked "where" -> must say
                    f_ok = f_ok and bool(WHERE_RE.search(answer))
                if declined or negative:
                    f_ok = True   # format line optional when declining
                results.append({"id": t["id"], "q": t["q"],
                                "answer": answer + verify_note,
                                "slugs": slugs, "r_hit": r_hit,
                                "verdict": verdict, "f_ok": f_ok, "ms": ms})
                print(f"[{verdict:5s}{' F' if f_ok else ' -'}"
                      f"{'R' if r_hit else '-'}] {t['id']} ({ms} ms)")
    finally:
        proc.kill()

    n = len(results)
    npass = sum(r["verdict"] == "PASS" for r in results)
    nmiss = sum(r["verdict"] == "MISS" for r in results)
    nwrong = sum(r["verdict"] == "WRONG" for r in results)
    f = sum(r["f_ok"] for r in results)
    rh = sum(r["r_hit"] for r in results)
    try:
        with urllib.request.urlopen("http://localhost:8081/props",
                                    timeout=10) as r:
            model = json.load(r).get("model_path", "?").split("/")[-1]
    except Exception:
        model = "?"
    summary = (f"PASS {npass}/{n} · MISS {nmiss} · WRONG {nwrong} · "
               f"format ok: {f}/{n} · retrieval hit@3: {rh}/{n} · "
               f"temp {ANSWER_TEMP} · wrap {WRAP} · {model}")
    lines = [f"\n## Run {time.strftime('%Y-%m-%d %H:%M')} — {SUITE_PATH.name}",
             summary, ""]
    for r in results:
        flag = r["verdict"] if r["f_ok"] else f"{r['verdict']}/FMT"
        lines.append(f"### [{flag}] {r['id']} ({r['ms']} ms)")
        lines.append(f"Q: {r['q']}")
        lines.append(f"top3: {r['slugs']}  (hit: {r['r_hit']})")
        lines.append("```")
        lines.append(r["answer"].strip()[:1200])
        lines.append("```")
    with open(OUT, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")
    print("\n" + summary + f" -> {OUT.name}")
    return 0

sys.exit(asyncio.run(main()))

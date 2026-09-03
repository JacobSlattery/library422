"""Drive the desktop eval harness. Usage:
  python drive_harness.py [model_url] [maxTokens] [question...]
Defaults: E4B, 4096, one smoke question."""
import asyncio, json, subprocess, sys, time, urllib.request
import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TEMP = r"C:\Users\timbe\AppData\Local\Temp"

MODEL = sys.argv[1] if len(sys.argv) > 1 else "/models/gemma-3n-E4B-it-int4.litertlm"
MAXTOK = int(sys.argv[2]) if len(sys.argv) > 2 else 4096
QUESTION = " ".join(sys.argv[3:]) or "Who led Potamiaena to martyrdom?"

_id = 0
async def cmd(ws, method, params=None, timeout=None):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg.get("id") == _id:
            return msg.get("result", {})

async def evaljs(ws, expr, timeout=1200):
    r = await cmd(ws, "Runtime.evaluate",
                  {"expression": expr, "returnByValue": True,
                   "awaitPromise": True}, timeout)
    res = r.get("result", {})
    if res.get("subtype") == "error":
        return "JSERROR: " + str(res.get("description"))[:400]
    if "value" in res:
        return res["value"]
    exc = r.get("exceptionDetails")
    if exc:
        return "JSEXC: " + json.dumps(exc)[:400]
    return None

async def main():
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
        "--js-flags=--max-old-space-size=16384",
        "--remote-debugging-port=9222", "--window-size=800,700",
        f"--user-data-dir={TEMP}\\atb-cdp-profile", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
                                      max_size=50_000_000,
                                      ping_interval=None) as ws:
            await cmd(ws, "Runtime.enable")
            await cmd(ws, "Page.enable")
            await cmd(ws, "Page.navigate",
                      {"url": f"http://localhost:8000/testbed/harness.html?model={MODEL}"})
            for _ in range(60):
                if await evaljs(ws, "!!window.__eval") is True:
                    break
                await asyncio.sleep(1)
            print("harness up")
            print("init:", await evaljs(ws, "__eval.init()", 600))
            t0 = time.time()
            r = await evaljs(ws, f"__eval.load({MAXTOK})", 1800)
            print(f"load({MAXTOK}):", r, f"wall {time.time()-t0:.0f}s")
            if isinstance(r, str) and r.startswith("JS"):
                return 1
            t0 = time.time()
            a = await evaljs(ws,
                f"__eval.ask({json.dumps(QUESTION)})", 3600)
            print(f"ask wall {time.time()-t0:.0f}s")
            if isinstance(a, dict):
                print("ANSWER:", (a.get("answer") or "")[:800])
                print("HITS:", [(h.get("title"), h.get("page")) for h in a.get("hits", [])])
                print("ms:", a.get("ms"))
            else:
                print("ask result:", a)
    finally:
        proc.kill()
    return 0

sys.exit(asyncio.run(main()))

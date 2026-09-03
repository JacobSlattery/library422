"""Run suite retrieval through the app's real code (harness, no model)."""
import asyncio, json, subprocess, sys, time, urllib.request
from pathlib import Path
import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TEMP = r"C:\Users\timbe\AppData\Local\Temp"
SUITE = json.loads(Path(r"C:\Dev\all_things_bible\testbed\suite.json").read_text())

_id = 0
async def cmd(ws, method, params=None, timeout=None):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if msg.get("id") == _id:
            return msg.get("result", {})

async def evaljs(ws, expr, timeout=600):
    r = await cmd(ws, "Runtime.evaluate",
                  {"expression": expr, "returnByValue": True,
                   "awaitPromise": True}, timeout)
    res = r.get("result", {})
    if res.get("subtype") == "error":
        return "JSERROR: " + str(res.get("description"))[:300]
    return res.get("value")

async def main():
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
        "--remote-debugging-port=9222",
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
                                      max_size=50_000_000, ping_interval=None) as ws:
            await cmd(ws, "Runtime.enable")
            await cmd(ws, "Page.enable")
            await cmd(ws, "Page.navigate",
                      {"url": "http://localhost:8000/testbed/harness.html"})
            for _ in range(30):
                if await evaljs(ws, "!!window.__eval") is True:
                    break
                await asyncio.sleep(1)
            await evaljs(ws, "__eval.init()", 300)
            ok = 0
            for t in SUITE["tests"]:
                hits = await evaljs(ws,
                    f"__eval.retrieve({json.dumps(t['q'])})", 120)
                if isinstance(hits, str):
                    print(f"[ERR ] {t['id']}: {hits}")
                    continue
                slugs = [h.get("slug", "") for h in hits[:3]]
                hit = any(t["expect_slug"] in s for s in slugs)
                ok += hit
                print(f"[{'PASS' if hit else 'FAIL'}] {t['id']}: {slugs}")
            print(f"\nretrieval hit@3 (app code): {ok}/{len(SUITE['tests'])}")
    finally:
        proc.kill()
    return 0

sys.exit(asyncio.run(main()))

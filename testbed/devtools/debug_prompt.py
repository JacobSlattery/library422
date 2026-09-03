"""Dump the exact prompt the app builds for a question. Instrumented launch."""
import asyncio
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
TEMP = Path(r"C:\Users\timbe\AppData\Local\Temp")
LOG = TEMP / "chrome-dbg.log"
PORT = 9250
Q = sys.argv[1] if len(sys.argv) > 1 else "Who led Potamiaena to martyrdom?"

_id = 0
async def cmd(ws, m, p=None, t=None):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": m, "params": p or {}}))
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), t))
        if msg.get("id") == _id:
            return msg.get("result", {})

async def evaljs(ws, e, t=600):
    r = await cmd(ws, "Runtime.evaluate",
                  {"expression": e, "returnByValue": True, "awaitPromise": True}, t)
    res = r.get("result", {})
    if res.get("subtype") == "error":
        return "JSERROR: " + str(res.get("description"))[:400]
    return res.get("value")

async def main():
    subprocess.run(["powershell", "-c",
        "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | "
        "Where-Object { $_.CommandLine -like '*atb-cdp-profile*' } | "
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force "
        "-ErrorAction SilentlyContinue }"], capture_output=True)
    time.sleep(2)
    logf = open(LOG, "w")
    proc = subprocess.Popen([
        CHROME, "--headless=new", "--no-sandbox", "--disable-gpu",
        f"--remote-debugging-port={PORT}",
        f"--user-data-dir={TEMP}\\atb-cdp-profile", "about:blank"],
        stdout=logf, stderr=subprocess.STDOUT)
    try:
        target = None
        last = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://localhost:{PORT}/json") as r:
                    target = next(t for t in json.load(r) if t["type"] == "page")
                break
            except Exception as e:
                last = e
                time.sleep(0.5)
        if target is None:
            print("POLL FAILED:", last)
            print("chrome alive:", proc.poll() is None, "rc:", proc.poll())
            logf.flush()
            print(LOG.read_text()[:1000])
            return 1
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
            p = await evaljs(ws, f"__eval.prompt({json.dumps(Q)})", 300)
            if isinstance(p, str):
                print(p)
                return 1
            print(p["prompt"])
    finally:
        proc.kill()
        logf.close()
    return 0

sys.exit(asyncio.run(main()))

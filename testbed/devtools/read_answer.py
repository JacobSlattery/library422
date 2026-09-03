"""Reconnect to the phone webview and read the current ask thread."""
import asyncio, json, subprocess, sys, time, urllib.request
import websockets

def sh(cmd):
    return subprocess.run(["adb"] + cmd, capture_output=True, text=True).stdout

_id = 0
async def cmd(ws, method, params=None):
    global _id
    _id += 1
    await ws.send(json.dumps({"id": _id, "method": method, "params": params or {}}))
    while True:
        msg = json.loads(await ws.recv())
        if msg.get("id") == _id:
            return msg.get("result", {})

async def evaljs(ws, expr):
    r = await cmd(ws, "Runtime.evaluate",
                  {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return r.get("result", {}).get("value")

async def main():
    sock = None
    out = sh(["shell", "cat", "/proc/net/unix"])
    for line in out.splitlines():
        if "webview_devtools_remote_" in line:
            sock = line.split("@")[-1].strip()
    sh(["forward", "tcp:9444", f"localabstract:{sock}"])
    targets = json.load(urllib.request.urlopen("http://localhost:9444/json"))
    page = next(t for t in targets if t.get("type") == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"],
                                  max_size=50_000_000, ping_interval=None) as ws:
        await cmd(ws, "Runtime.enable")
        print("question:", await evaljs(ws,
            "[...document.querySelectorAll('.msg.q')].at(-1)?.textContent"))
        print("answer so far:", (await evaljs(ws,
            "[...document.querySelectorAll('.msg.a')].at(-1)?.textContent") or "")[:800])
        print("sources rendered:", await evaljs(ws,
            "document.querySelectorAll('.asksources').length"))
    return 0

sys.exit(asyncio.run(main()))

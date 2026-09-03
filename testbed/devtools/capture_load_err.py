"""Trigger model load on phone, capture the plugin/native error."""
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
    res = r.get("result", {})
    if res.get("subtype") == "error":
        return "JSERROR: " + str(res.get("description"))[:250]
    return res.get("value")

async def wait_js(ws, expr, timeout, poll=2.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if (await evaljs(ws, expr)) is True:
            return True
        await asyncio.sleep(poll)
    return False

async def main():
    sock = None
    for _ in range(30):
        out = sh(["shell", "cat", "/proc/net/unix"])
        for line in out.splitlines():
            if "webview_devtools_remote_" in line:
                sock = line.split("@")[-1].strip()
        if sock:
            break
        time.sleep(2)
    sh(["forward", "tcp:9444", f"localabstract:{sock}"])
    targets = json.load(urllib.request.urlopen("http://localhost:9444/json"))
    page = next(t for t in targets if t.get("type") == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"],
                                  max_size=50_000_000, ping_interval=None) as ws:
        await cmd(ws, "Runtime.enable")
        ok = await wait_js(ws,
            "document.querySelectorAll('.verse-row, .workbody').length > 0", 300)
        print("app ready:", ok)
        # call the plugin directly so nothing re-renders over the error
        err = await evaljs(ws, """
            window.Capacitor.Plugins.Llm.loadModel({maxTokens: 1280})
              .then(r => 'OK: ' + JSON.stringify(r))
              .catch(e => 'FAIL: ' + (e.message ?? e))""")
        print("direct loadModel(1280):", err)
    print("--- logcat ---")
    out = sh(["logcat", "-d"])
    for line in out.splitlines():
        if any(k in line for k in ("LlmPlugin", "genai", "litert", "LlmInference",
                                    "MediaPipe", "load failed")):
            print(line[:200])
    return 0

sys.exit(asyncio.run(main()))

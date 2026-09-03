"""Diagnose generation race on device."""
import asyncio, json, subprocess, sys, time, urllib.request
import websockets

def sh(cmd):
    return subprocess.run(["adb"] + cmd, capture_output=True, text=True).stdout

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
        return "JSERROR: " + str(res.get("description"))[:300]
    return res.get("value")

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
        # is the token stream still live? count arrivals over 4s
        n = await evaljs(ws, """
            new Promise(res => {
              let c = 0;
              const sub = window.Capacitor.Plugins.Llm.addListener('token',
                () => c++);
              setTimeout(async () => {
                (await sub).remove(); res(c);
              }, 4000);
            })""", 30)
        print("tokens arriving in 4s window:", n)
        # try a fresh tiny generate and time it
        t0 = time.time()
        r = await evaljs(ws, """
            window.Capacitor.Plugins.Llm.generate(
              {prompt: '<start_of_turn>user\\nSay READY only.<end_of_turn>\\n<start_of_turn>model\\n'})
              .then(x => 'resolved: ' + JSON.stringify(x))
              .catch(e => 'rejected: ' + (e.message ?? e))""", 600)
        print(f"tiny generate ({time.time()-t0:.1f}s):", r)
    return 0

sys.exit(asyncio.run(main()))

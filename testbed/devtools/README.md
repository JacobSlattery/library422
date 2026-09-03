# Devtools — CDP drivers for app testing (desktop + on-phone)

Rescued from a session scratchpad; run with `pixi run python <script>`.
All assume the dev server on :8000 (`pixi run dev`).

- `smoke_app.py [--fresh]` (`pixi run smoke`) — **end-to-end UI smoke test of the
  deterministic features** in headless Chrome: boots the PWA, then drives the
  real DOM (verse sheet sections, annotations, entity sheet, word panel with
  parsing + lexicons, interlinear mode, reverse interlinear, variant markers,
  timeline, map, notes list, Library jump, entity + parsing search, settings,
  LXX versification). Console errors fail the run. 27 checks, ~1 min warm;
  `--fresh` wipes the profile and re-downloads the databases.
- `drive_harness.py [model] [maxTokens] [question]` — desktop harness smoke
  (loads /testbed/harness.html, inits DB, asks one question).
- `eval_retrieval.py` — retrieval-only suite check through real app code.
- `debug_prompt.py "<question>"` — dump the exact prompt the app builds.
- `phone_ask_staged.py` — full on-phone ask with live stage timing (loads
  model via UI if needed).
- `read_answer.py` — reconnect to the phone webview, read current thread.
- `phone_diag.py` — live token-stream check + tiny direct generate.
- `capture_load_err.py` — trigger model load on phone, dump native error.

## Non-obvious mechanics (hard-won)
- Phone webview CDP: `adb shell cat /proc/net/unix | grep webview_devtools`
  -> `adb forward tcp:9444 localabstract:webview_devtools_remote_<pid>`.
  ALWAYS `ping_interval=None` (inference starves keepalives); reconnect and
  re-read DOM rather than holding sockets; beware stale page targets.
- Desktop Chrome: kill lingering instances holding the profile FIRST
  (`Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ? CommandLine
  -like '*atb-cdp-profile*' | Stop-Process`) or new launches delegate-and-exit.
- Synthetic `.click()` does NOT trigger word taps — the app uses pointer
  timing; dispatch PointerEvent pointerdown+pointerup (see TAP helper in
  phone_ask_staged.py / drive_phone probes).
- Git Bash mangles `/data/...` device paths — use the PowerShell tool for adb
  shell commands with absolute device paths.
- Copy files INTO the app sandbox via
  `adb push f /data/local/tmp/x` + `adb shell "cat /data/local/tmp/x |
  run-as org.library422.study sh -c 'cat > files/y'"`.
- Local Gemma generation for evals: `pixi run llama-server -m
  models/gemma-3n-E4B-it-Q4_K_M.gguf -c 8192 --port 8081` (ungated GGUF;
  behaviorally matches the phone's litertlm E4B; llama applies the Gemma
  chat template on /v1/chat/completions).
- testbed/eval_generation.py runs suites end-to-end (suite.json /
  bigsuite.json) and appends to testbed/RESULTS.md.

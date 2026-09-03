# Deploying library422.org

How the public site gets from this repository to the domain, and the one-time
setup it needs. Operational detail for the app itself is in CLAUDE.md.

## How it fits together

```
 laptop                                   GitHub                          Cloudflare
 ──────                                   ──────                          ──────────
 pixi run build-data  ─▶ app/data/ ──▶  release data-<date>-<hash>
 pixi run publish-data                    (assets, ~270 MB)                   │
   └─ pins the tag in app/version.json          │                             │
 git push main  ───────────────────▶  Actions: deploy.yml                     │
                                        ├─ sparse checkout of app/ + site/    │
                                        ├─ gh release download <tag>          │
                                        ├─ build_site.py → dist/site          │
                                        ├─ build_site.py --landing → dist/landing
                                        ├─ wrangler deploy (app) ────────▶ Worker "library422-app"
                                        │                                  app.library422.org
                                        └─ wrangler deploy (site) ───────▶ Worker "library422"
                                                                           library422.org, www
```

* **Two origins on purpose.** The app lives at **app.library422.org**
  (`wrangler.app.jsonc`, assets from `app/`); the landing site at
  **library422.org** (`wrangler.site.jsonc`, assets from `site/`). Browser
  storage (the ~216 MB install, the AI caches) and the service worker are per
  origin, so the landing site can change freely without ever touching an
  installed copy of the app. Cloudflare creates the `app` DNS record itself
  from the custom-domain route.
* Code lives in git; the data bundle lives in GitHub **releases** (255 MB of
  gzip chunks that change wholesale on every data rebuild would bloat the
  repository past GitHub's limits within a few releases).
* Both sites are **static-assets-only Cloudflare Workers**. No server code,
  no bindings; the free plan serves static assets without request charges.
  Every asset is under Cloudflare's 25 MiB cap (the data chunks are 20 MiB;
  `tools/build_site.py` refuses anything larger).
* Installed copies pick up new code through the service worker on the next
  visit and are *offered* new data ("Update now / Later"); the old data keeps
  working until they accept.

## One-time setup

1. **GitHub repository.** Create it (private is fine — the workflow downloads
   release assets with the built-in `GITHUB_TOKEN`) and push `main`:

   ```powershell
   gh repo create library422 --private --source . --remote origin --push
   ```

2. **Cloudflare API token.** Cloudflare dashboard → My Profile → API Tokens →
   Create Token → template *Edit Cloudflare Workers*. Note the token and the
   **Account ID** (Workers & Pages overview, right-hand column).

3. **GitHub secrets.** Repository → Settings → Secrets and variables → Actions:

   | Secret | Value |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | the token from step 2 |
   | `CLOUDFLARE_ACCOUNT_ID` | the account id |

   Or from the terminal: `gh secret set CLOUDFLARE_API_TOKEN` (prompts for the value).

4. **Domain.** In Cloudflare, add `library422.org` as a site (Domains → Add a
   domain) and point the registrar's nameservers at the two Cloudflare
   nameservers it shows (skip this if the domain was bought through Cloudflare
   Registrar — it is already there). Wait until the zone shows **Active**.
   `wrangler.site.jsonc` binds `library422.org` and `www.library422.org`,
   and `wrangler.app.jsonc` binds `app.library422.org`, as custom domains;
   Cloudflare creates the DNS records and certificates itself. *If the zone
   is not active yet, the deploy fails on the routes* — temporarily delete
   the `routes` blocks, deploy, and put them back once the zone is active.

5. **First data release.** After a green `pixi run build-data`:

   ```powershell
   pixi run publish-data      # uploads app/data/* as a release, pins the tag
   git add app/version.json
   git commit -m "Pin data release"
   git push
   ```

   The push triggers the workflow; watch it with `gh run watch`.

## Routine

| Change | What to do |
|---|---|
| App code / CSS / vendored files | commit, push `main` — deploys automatically |
| Landing site (`site/`) | commit, push `main` — same workflow, deploys the `library422` Worker. Guide screenshots: `pixi run python testbed/devtools/shot.py --light --out site/img/<name>.png ...` (dev server running) |
| Data (texts, Library works, embeddings) | `pixi run build-data` → `pixi run smoke` → `pixi run publish-data` → commit `app/version.json` **and `site/catalog.json`** (the landing site's per-work / per-Bible pages are generated from it) → push |
| Desktop edition | `pixi run desktop-prepare` → `cd desktop-app && node pack.js win32` (or `linux`) → `dist/desktop/Library422-<platform>-x64/` is the portable folder; `Compress-Archive` it to `dist/desktop/Library422-win32-x64.zip` for a download or a flash drive; `pixi run smoke-desktop --exe dist/desktop/Library422-win32-x64/Library422.exe` boot-checks the packaged build |
| Version number | edit `app/version.json` (`version`, `code`) — it is shown in Settings and stamped into the APK |
| Android APK | `.\tools\build_release.ps1` locally (needs the keystore); attach `dist/library422-<version>.apk` to a GitHub release by hand for now |
| Rebuild the sites locally | `pixi run site` → `dist/site/`, `pixi run landing` → `dist/landing/` (the exact folders the workflow deploys) |
| Deploy without a push | Actions → Deploy site → Run workflow |

## Checks before pushing data

* `pixi run build-data` already ends in `check-db` (the invariant gate) — do
  not bundle around a failure.
* `pixi run dev` + `pixi run smoke` in another shell: the headless-Chrome test
  of every deterministic panel, including the Ask AI (beta) toggle. It is the
  only runtime test of `app.js`.

## Gotchas met on the way

* `cloudflare/wrangler-action@v3` fell back to a stale wrangler that rejects an
  assets-only config ("Missing entry-point"). The workflow therefore runs
  `npx --yes wrangler@4 deploy` directly; wrangler 4 reads the token and account
  id from the `CLOUDFLARE_*` environment variables.
* Large-asset uploads to Cloudflare retry internally ("Asset upload failed.
  Retrying…") — a few retries on the 20 MB data chunks are normal, not a failure.
* The first run after a fresh push shows a warning and skips the deploy until the
  two secrets exist; it does not fail.

## What is deliberately NOT automated

* Building the data bundle in CI — the embedding step alone needs the local
  cache (`testbed/emb`, ~75 min cold) and the sources are 700 MB.
* The Android release build — it needs the signing keystore, which never
  leaves this machine (see ROADMAP.md).

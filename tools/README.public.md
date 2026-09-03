# Library 422

**Free, offline Bible study that runs entirely on your device.**
Live at [library422.org](https://library422.org) · app at
[app.library422.org](https://app.library422.org)

Named after Mark 4:22 — *"For there is nothing hidden, except that it should
be made known."* Eighteen Bible texts read side by side, every Greek and
Hebrew word tagged with Strong's numbers and parsing, full lexicons
(Brown-Driver-Briggs, Liddell-Scott-Jones, Abbott-Smith), cross-references,
people, places and events with a map and timeline, and a Library of
fifty-nine works: the Ante-Nicene, Nicene and Post-Nicene Fathers, Josephus,
Philo, Aquinas and the intertestamental texts. Everything is public domain or
openly licensed, and nothing leaves your device.

## Get it

| | |
|---|---|
| **Web** | [app.library422.org](https://app.library422.org) — installs about 15 MB, then works offline; add it to your home screen or desktop |
| **Windows / Linux** | portable folders on the [releases page](https://github.com/JacobSlattery/library422/releases/latest) — unzip anywhere (a flash drive works) and run `Library422` |
| **Android** | the APK on the [releases page](https://github.com/JacobSlattery/library422/releases/latest) |

A five-minute guide: [library422.org/guide](https://library422.org/guide/).

## What is in this repository

```
app/            the app: plain ES modules + CSS, SQLite WASM, service worker
site/           the landing site (library422.org)
desktop-app/    Electron shell for the portable desktop edition
android-app/    Capacitor shell for the Android APK
tools/          build chain: databases -> catalog items -> chunked bundle -> site
testbed/        headless-Chrome smoke tests, screenshot tool, Ask evaluation harness
.github/        deploy workflow (push to main -> Cloudflare)
```

The **source texts are not in this repository.** They live in a separate
(currently private) sources repository with a SHA-256 manifest; the data
the app uses is published here as release assets (`data-…` pre-releases)
and downloaded by the deploy workflow. `ROADMAP.md`, `DEPLOY.md`,
`app/DESIGN.md` and `app/CATALOG.md` describe the architecture and the
plan; `CLAUDE.md` is the working reference for the codebase.

## Running the app locally

```
pixi run dev            # serves app/ on http://localhost:8000
pixi run smoke          # headless-Chrome smoke test (needs the dev server)
```

The dev server needs a data bundle in `app/data/`: download the assets of the
latest `data-…` release into that folder (the same thing the deploy workflow
does), or build it from the sources if you have them.

## Licences

The code in this repository is released under the MIT licence (see
`LICENSE`). That licence does not touch the data: the texts, lexicons and
works the app ships are public domain or CC BY / CC BY-SA, exactly as their
sources state, and the full list with attributions is in the app under
Settings → Sources & licences and in `ROADMAP.md`.

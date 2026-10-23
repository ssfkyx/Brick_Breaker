# Tests — web app

No npm packages. Everything runs with the Node.js that is already available
(Node 18+; this project was verified with Node 24).

## Simulation core (35 tests)

```bash
cd web
node tests/core.test.mjs
```

`tests/helpers/load-core.mjs` executes the classic scripts (`js/00-config.js` …
`js/60-session.js`) in a Node `vm`, in the same order as `index.html`, and returns
the shared `BB` namespace. The suite covers:

- M2 geometry (960×720 room, brick grid inside the room, 240×200 clamping)
- M3 brick state machine, ball helpers, run-stat bookkeeping
- M5 scoring/combo/speed policy
- M6 level factory (row ladder, double-HP top row from level 3)
- M4 physics (wall/paddle/brick/floor events, sub-stepping)
- M10 session lifecycle (launch, life loss, game over, restart, level clear,
  resize, pointer aiming, audio-intent wiring)

On some restricted Windows sandboxes plain `node --test` cannot spawn its
isolation workers (`EPERM`); run the file directly instead:

```bash
node tests/core.test.mjs
# or, if you want the test runner:
node --test --test-isolation=none tests/core.test.mjs
```

## Browser check (optional, dev only)

`tests/browser-check.mjs` drives headless Chrome/Edge over the DevTools Protocol
using Node's built-in `fetch`/`WebSocket`; it needs Chrome installed but no npm
packages. It reports layout metrics (viewport, devicePixelRatio, canvas backing
size, horizontal overflow), console errors, state after keys/touch, and can save
screenshots.

```bash
node tests/browser-check.mjs \
  --url "file:///C:/path/to/web/index.html?demo=combo5" \
  --width 1440 --height 900 --dpr 2 \
  --screenshot verification/combo.png \
  --key "Space,KeyT" --screenshotAfterKeys verification/after.png
```

Useful flags:

| Flag | Meaning |
| --- | --- |
| `--mobile` | mobile emulation + touch events enabled |
| `--touch x,y` | dispatch a touch drag and report paddle movement |
| `--mouse x,y` | dispatch a mouse drag |
| `--reload` | reload after input to verify `localStorage` persistence |
| `--eval "expression"` | evaluate JS in the page and include the result |
| `--demo=…` in URL | deterministic fixture (`title`, `playing`, `combo5`, `gameover`, `paused`, `settings`) |

Chrome is auto-detected in the usual Windows/macOS/Linux install locations; set
`CHROME_PATH` to override.

## What is intentionally not tested in CI

The audio graph itself needs a real browser audio device; the CDP check confirms
the context reaches `running` after a gesture, while the timbre data/synthesis
is verified through the desktop audio tests and manual listening. The browser
check is a maintainer tool rather than a CI requirement (it needs Chrome).

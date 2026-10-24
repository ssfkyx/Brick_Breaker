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
| `&live=1` in URL | keep the simulation running in a demo fixture (needed when testing input; otherwise `playing`/`combo5` freeze for stable screenshots) |
| `&stats=1` in URL | show the live FPS / quality / canvas-backing readout |
| `?quality=high\|low` | force a fixed render quality for a run (normally adaptive AUTO) |

Example: a touch-drag check needs the live fixture:

```bash
node tests/browser-check.mjs \
  --url "file:///C:/path/to/web/index.html?demo=playing&live=1" \
  --width 390 --height 844 --dpr 2 --mobile --touch 300,700
```

Chrome is auto-detected in the usual Windows/macOS/Linux install locations; set
`CHROME_PATH` to override.

## Performance checks

The renderer is tuned for Canvas2D: static scenery is cached in an offscreen
canvas, bricks are flat-shaded (no per-brick `shadowBlur`/gradients), the HUD has
no `backdrop-filter` over the animated canvas, and the app adapts the canvas
resolution when the frame rate drops (simulation stays 120 Hz). `?stats=1` shows
the live values. Typical headless-Chrome measurements on this machine
(software rendering, so real GPUs are faster):

| Scenario | Before | After |
| --- | --- | --- |
| 1440×900 @DPR2, full quality | ~10 fps | ~31–33 fps |
| 1440×900 @DPR2, adaptive | ~10 fps | ~53–58 fps (scale ≈0.6–0.7) |
| 1440×900 @DPR1 | ~32 fps | 60 fps |
| 390×844 @DPR2 (mobile) | — | 60 fps at full quality |

Run your own with `--eval`:

```bash
node tests/browser-check.mjs --url "file:///.../index.html?demo=playing" \
  --width 1440 --height 900 --dpr 2 --wait 3000 \
  --eval 'new Promise(r=>{let n=0,s=performance.now();function f(t){n++;t-s>2000?r({fps:Math.round(n*1000/(t-s))}):requestAnimationFrame(f)}requestAnimationFrame(f)})'
```

## What is intentionally not tested in CI

The audio graph itself needs a real browser audio device; the CDP check confirms
the context reaches `running` after a gesture, while the timbre data/synthesis
is verified through the desktop audio tests and manual listening. The browser
check is a maintainer tool rather than a CI requirement (it needs Chrome).

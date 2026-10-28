# Architecture — Brick Breaker Web

This folder is a **zero-build static web app**. There is no bundler, no npm
dependency and no framework: `index.html` loads a fixed list of classic
`<script>` files, each one attaching a module to the shared `BB` namespace.
That makes the folder playable by double-clicking `index.html` and deployable by
copying it to any static host.

The design deliberately mirrors the desktop implementation in
`../bb_v1/brick_breaker.py` (modules M1–M11), so the architecture document,
gameplay rules and tests stay comparable across both builds.

## Layer / dependency direction

```text
                    ┌──────────────────────────────┐
                    │ 80-app.js        M11 APP      │  DOM shell, RAF loop,
                    │                                │  overlays, persistence,
                    └───────────────┬────────────────┘  audio unlock, headless hook
                                    │
                    ┌───────────────▼────────────────┐
                    │ 60-session.js    M10 SESSION   │  run state machine (READY /
                    │  settings/stats/popups/banner  │  PLAYING / PAUSED /
                    └───┬──────────┬──────────┬──────┘  LEVEL_CLEAR / GAME_OVER)
                        │          │          │
        ┌───────────────▼──┐  ┌────▼─────┐  ┌─▼──────────────────┐
        │ 22-physics.js M4 │  │20-rules  │  │21-levels.js      │
        │ 22-physics.js    │  │M5 RULES  │  │M6 LEVELS          │
        └────────┬─────────┘  └────┬─────┘  └────┬───────────────┘
                 │                 │             │
        ┌────────▼─────────────────▼─────────────▼──────────────┐
        │ 10-model.js   M2 GEOMETRY + M3 MODEL                    │
        │ FieldLayout, Brick, Paddle, Ball, RunStats, Settings, Popup
        └──────────────────────────┬──────────────────────────────┘
                                   │
                        ┌──────────▼──────────┐
                        │ 00-config.js  M1    │  constants, enums, palette
                        └─────────────────────┘

Peripheral adapters (depend inward; nothing inward depends on them):
  M7 AUDIO   30-audio.js   Web Audio engine + note table + instrument presets
  M8 VIEW    50-renderer.js canvas renderer, particles, combo light show
  M9 INPUT   70-input.js   keyboard + pointer/touch -> BB.Intent / pointer target
  web-only   40-storage.js localStorage persistence, safe fallbacks
```

Load order is the dependency graph and is fixed in `index.html`:
`00-config → 10-model → 20-rules → 21-levels → 22-physics → 30-audio →
40-storage → 50-renderer → 60-session → 70-input → 80-app`.

## Module map (web ↔ desktop)

| Web file | Python module | Responsibility |
| --- | --- | --- |
| `js/00-config.js` | M1 CONFIG | tunables, enums (`RunState`, `BallState`, `BrickState`, `HitKind`, `Intent`), `clamp`, visual palette |
| `js/10-model.js` | M2 GEOMETRY + M3 MODEL | `FieldLayout` (room/grid derived from canvas size), `Brick` fade state machine, `Paddle` english/movement, `Ball` helpers, `RunStats`, `Record`, `Settings`, `Popup` |
| `js/20-rules.js` | M5 RULES | pure scoring: combo ladder, brick points, level bonus, speed ramp, rally caps |
| `js/21-levels.js` | M6 LEVELS | row ladder, brick style (points/HP/hue), wall factory, reflow on resize |
| `js/22-physics.js` | M4 PHYSICS | circle-rect test, sub-stepped collision engine producing plain events |
| `js/30-audio.js` | M7 AUDIO | Web Audio engine: `NOTE_TABLE`, four `INSTRUMENTS` presets, oscillator/periodic-wave envelopes, noise transients, mute, instrument cycling |
| `js/40-storage.js` | — (web-only) | typed localStorage access with in-memory fallback |
| `js/50-renderer.js` | M8 VIEW | canvas drawing, HiDPI backing store, cached static scenery, flat-shaded DJ light show, adaptive resolution scale |
| `js/60-session.js` | M10 SESSION | the only owner of `RunState`; consumes collision events, applies intents, calls audio, spawns popups, handles resize and pointer aiming |
| `js/70-input.js` | M9 INPUT | keyboard/pointer/touch translation, held-key axis, `Intent` events, focus-loss handling |
| `js/80-app.js` | M11 APP + web shell | RAF fixed-timestep loop, DOM HUD/overlays, audio unlock, persistence wiring, demo fixtures |

## Frame flow (fixed timestep, 120 Hz)

```text
requestAnimationFrame(now)
  dt = min((now - last) / 1000, MAX_FRAME_TIME)
  input.getAxis() -> session.setMoveAxis(axis)
  accumulator += dt
  while accumulator >= PHYSICS_STEP (max 12 steps):
      session.update(PHYSICS_STEP)
          ├─ move paddle (keyboard axis or pointer target)
          ├─ physics.step(ball, paddle, bricks, layout, dt) -> events
          ├─ consume events: wall / paddle english / brick damage+score / floor
          ├─ advance fades + popups, level-clear countdown
          └─ state transitions (the only place RunState is assigned)
      accumulator -= PHYSICS_STEP
  renderer.sync(session, dt)   // effects only: beat, hue, particles, trail
  renderer.draw(session)       // read-only on the model
  app.syncHud()/syncPanels()   // DOM text, overlays, chips
```

Design rules carried over from the desktop architecture:

1. **M4 reports facts, does not score or draw.** `CollisionEngine` returns plain
   event objects; M10 decides what they mean.
2. **M5 is stateless.** Scoring/speed policy is pure functions.
3. **M8 is read-only.** The renderer (and the combo light show) never assigns to
   the session; all animation is derived from `session` + local time.
4. **M10 is the only state-machine owner.** `RunState` transitions happen only in
   `GameSession`.
5. **M11 does not contain physics.** App handles time, DOM, input routing and
   audio unlocking only.
6. **M1 has no dependencies.** Constants/enums only.

## Audio architecture (M7)

- `NOTE_TABLE` — instrument-independent note recipes (start/end Hz, duration ms,
  volume), identical to the desktop build.
- `INSTRUMENTS` — data-only presets: harmonic partials, attack, decay ratio,
  transient noise amount/band-pass factor, gain.
- `AudioEngine` — builds a `PeriodicWave` per preset, plays a note as
  oscillator + gain envelope (attack → exponential decay) + optional filtered
  noise burst, into a master gain → compressor → destination.
- Browser autoplay policy: context creation/resume happens on the first user
  gesture (`AudioEngine.unlock()`), guarded by `enabled`/`ready` checks so the
  game also runs silently in headless tests.
- Instrument changes are surfaced through `onChange`, which the app persists.

## Combo light show (M8 render-only)

`Renderer.sync()` derives a small effect state from the session:

| Signal | Source | Visual effect |
| --- | --- | --- |
| `beat` (0..1) | new score popups / bricks destroyed | brick brightness + glow, shards, wave rings, shake |
| `comboGlow` | combo multiplier increases | hue kick across the wall |
| `heat` | current combo multiplier | equalizer floor amplitude, background glow, saturation |
| `time`, brick `col/row` | local clock | slow hue rotation + column ripple |

Bricks remain the same entities; only their rendered HSL values change. The
effect honours the DJ-booth toggle and `prefers-reduced-motion`.

## HiDPI + responsive layout

- `Renderer.resize(cssWidth, cssHeight, dpr)` sizes the canvas backing store to
  `round(css × dpr × qualityScale)` (DPR clamped, quality scale 0.6–1), sets
  `ctx.setTransform(dpr, …)`, and all drawing uses CSS pixel coordinates. Text in
  the HUD/overlays is real DOM text, so it is always crisp.
- **Adaptive resolution:** `80-app.js` measures a rolling frame rate; when it
  stays below ~54 fps it calls `renderer.setQualityScale()` with a smaller scale
  (recreating the static background cache at the new size) and raises it again
  after a stable ~57+ fps. The simulation timestep is independent of this and
  stays at 120 Hz, so input latency and physics do not degrade. The DJ booth
  exposes AUTO / CRISP / FAST; `?stats=1` shows FPS, scale and backing size.
- **Static background cache:** the gradient, perspective grid, scanlines and
  vignette are rendered once into an offscreen canvas on resize and blitted per
  frame. Bricks are **20×8 pixel-art sprites** (outline, chunky bevel, dither
  marks, crack pixels) stretched with `imageSmoothingEnabled = false`; sprite
  variants are cached per quantised hue/lightness bucket, so the combo colour
  cycle stays cheap while the wall keeps a deliberately low-fi arcade look.
  This is what keeps Canvas2D fast on high-DPR panels.
- `App.resize()` uses a `ResizeObserver` on the stage plus window/orientation/
  fullscreen listeners; the session re-derives the room/grid from the new canvas
  size (same formulas as the desktop `FieldLayout.compute`).
- CSS supports small phones (compact HUD, touch hints, safe-area insets),
  landscape phones and large desktop screens. The HUD does not use
  `backdrop-filter` over the animated canvas, and ambient lighting is static.

## Persistence

`BB.Storage` wraps `localStorage` (key `brick-breaker.web.v1`) and falls back to
in-memory state when storage is unavailable (e.g. some `file://` contexts).
Schema: `{ bestScore, bestCombo, bestLevel, instrument, muted, lightShow, quality }`.
Records are written when a run ends; instrument/mute/light-show/quality changes
persist immediately.

## Testing strategy

- **Simulation core** — `tests/core.test.mjs` runs with Node's built-in test
  runner (no npm). `tests/helpers/load-core.mjs` executes the classic scripts in
  a `vm` in browser order and returns `globalThis.BB`; the DOM-free modules are
  exercised headlessly (35 tests).
- **Browser** — `tests/browser-check.mjs` is a zero-dependency DevTools-Protocol
  driver (Node 22+ WebSocket): it reports `devicePixelRatio`, canvas backing size,
  overflow, console errors, keyboard/touch results and screenshots. Demo fixtures
  (`?demo=…`) make every visual state reproducible.
- **Manual** — the screenshots in `docs/screenshots/` were captured with that
  CDP check at 1440×900 @DPR2 and 390×844 @DPR2.

## Extension points

| Goal | Change |
| --- | --- |
| Add an instrument timbre | add one entry to `INSTRUMENTS` in `30-audio.js` (data only) |
| Add a sound cue | add a note to `NOTE_TABLE` + `audio.play('name')` at the call site |
| New level pattern | extend `LevelFactory.build()` / `brickStyle()` |
| New visual theme | edit CSS custom properties in `css/style.css` and `BB.style` palette |
| New UI panel | add DOM markup + a `panel-*` section and one branch in `App._syncPanels()` |
| Persist more state | add a default in `40-storage.js` and read it in `App` |
| Tune performance | adjust the FPS thresholds in `App._adaptQuality()` or the `qualityScale` clamp in `Renderer.resize()` |

## Constraints / non-goals

- No build step and no runtime dependencies (by design).
- No network calls, analytics or accounts; fully client-side.
- Desktop packaging (`../windows_release`) stays out of this folder.

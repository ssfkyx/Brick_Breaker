# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog, and the project uses Semantic Versioning.
Version numbers before 1.0.0 are retrospective labels for the dated milestones.

## [Unreleased]

### Added

- **Web edition** (`web/`): a zero-dependency, zero-build browser port of the
  game with the M1–M11 architecture preserved as classic `<script>` modules on a
  shared `BB` namespace. Runs by opening `web/index.html` and deploys as a static
  site (GitHub Pages workflow included).
- New neon-arcade visual system for the web build: DOM HUD and overlays with
  crisp HiDPI text, a `devicePixelRatio`-aware canvas backing store, responsive
  layout for desktop and phones, CSS-driven menus and a DJ-booth sound panel.
- **DJ-style combo light show**: as the combo multiplier climbs, the brick wall
  shifts hue together, a ripple travels across the columns, bricks glow/brighten
  on every hit, and a pulsing equalizer floor joins in (render-only, toggleable,
  reduced-motion aware).
- Web Audio instrument engine: the same `NOTE_TABLE` score as the desktop build
  with data-driven `SINE` / `PIANO` / `CLASSICAL` / `ACOUSTIC` presets,
  oscillator + envelope + transient synthesis, and gesture-based audio unlock.
- Touch and mouse controls: direct paddle aiming (velocity preserved for the
  english bounce), tap-to-launch, pause/mute/settings buttons, fullscreen API.
- `localStorage` persistence for best score/combo/level, instrument, mute,
  light-show preference and render-quality mode.
- **Performance pass for the web build**: the static playfield scenery is cached
  in an offscreen canvas, bricks are **low-fi 20×8 pixel sprites** (outline,
  chunky bevel, dither and crack pixels) stretched with nearest-neighbour
  filtering instead of per-brick gradients + `shadowBlur`, the combo glow is a
  cached sprite, the HUD/chips no longer use `backdrop-filter` over the animated
  canvas, and the ambient background is static. The renderer now sizes its
  backing store from `devicePixelRatio` × an adaptive quality scale: when a
  device cannot hold ~54 fps the canvas resolution is lowered (never the fixed
  120 Hz physics) and recovered when there is headroom. DJ booth exposes
  AUTO / CRISP / FAST; `?stats=1` shows live FPS/quality/backing size.
  Headless-Chrome measurements on the dev machine improved from ~10 fps to
  **~60 fps** (adaptive) at 1440×900@DPR2, and 32 fps → 60 fps at DPR1; the
  deliberately coarse brick look also gives the arcade wall more character.
- **Fixed occasional screen flashes in the web build.** The adaptive-resolution
  engine could oscillate around its FPS threshold, resizing the canvas back and
  forth every few seconds (a visible blink + blur jump). Quality is now quantised
  to fixed steps, changes are limited to once per ~3 s, a downgrade needs two
  consecutive bad windows, upward probes happen at most once per session and are
  rolled back/blocked if they do not hold, and the renderer redraws immediately
  inside the resize call so a just-cleared canvas is never presented blank. The
  brick sprite cache is no longer flushed mid-run either. Verified under
  DevTools CPU throttling: 1–2 monotonic quality changes and no oscillation.
- Web test tooling with no npm dependency: 35 `node:test` simulation tests
  (`web/tests/core.test.mjs`) plus a DevTools-Protocol browser checker
  (`web/tests/browser-check.mjs`) for layout/DPR/overflow/console-error checks,
  keyboard/touch input, persistence reload and screenshots.
- `web/README.md`, `web/README.zh-CN.md`, `web/ARCHITECTURE.md` and
  `web/tests/README.md`; GitHub Pages workflow
  (`.github/workflows/web-pages.yml` and a self-contained copy in `web/`).
- Root README/README.zh-CN now point at the web edition; desktop build and tests
  are unchanged.

## [1.1.0] - 2026-10-23

### Added

- Selectable instrument timbres: `T` cycles `SINE` (the original v1.0.0 voice),
  `PIANO`, `CLASSICAL` (nylon-string guitar) and `ACOUSTIC` (steel-string
  guitar); the HUD shows the active preset as `SND <label>` and the READY
  overlay lists the new key.
- Data-driven audio architecture in M7: an instrument-independent `NOTE_TABLE`
  (same pitches/durations/volumes as v1.0.0), frozen `SoundNote` /
  `InstrumentPreset` dataclasses, a pure `build_wavetable()` / `render_note()`
  synthesiser (harmonic spectrum + attack transient + exponential envelope
  tails), and a `SoundBank` that lazily synthesises and caches each preset.
- A short `preview` cue that auditions the newly selected instrument.
- Nine headless audio tests: note/preset consistency, SINE bit-identical to the
  v1.0.0 formula, distinct bounded PCM per acoustic preset, stereo channel
  interleaving, lazy preset switching with stable cue durations, no-mixer
  degradation, `Intent.CYCLE_INSTRUMENT` model/bank sync, and the `T` key
  mapping (17 tests total).
- `bb_v1/docs/architecture.md`: R10 traceability, audio-subsystem layering and
  dependency section, updated M7 contract and SETTINGS ERD.

### Changed

- README (English and Chinese): sound section, `T` in the controls table, audio
  tests in the test description, and refreshed verification notes.
- `windows_release/BrickBreaker.exe` rebuilt as v1.1.0 so the double-click build
  contains the new sound engine: version metadata 1.1.0, cache flag
  `ready_v1.1.0.flag`, and the NSIS target switched to `x86-unicode` so the
  portable x86-only NSIS toolchain can reproduce it locally (the embedded Python
  payload stays 64-bit).
- `windows_release/启动游戏.bat` now launches the already-unpacked runtime
  directly when the v1.1.0 cache is present; this is faster and also avoids
  Windows TEMP problems that can make the NSIS self-extractor fail.

## [1.0.0] - 2026-10-23

### Added

- MIT license (`LICENSE`), copyright 2026 Brick Breaker contributors.
- `tests/`: a headless standard-library `unittest` suite with SDL dummy video and
  audio drivers, covering configuration and geometry, `App`/`Renderer`
  construction and drawing, ball launch movement, combo scoring, the brick damage
  state machine, and the game-over transition; plus `tests/README.md`.
- `.github/workflows/ci.yml`: GitHub Actions CI on Ubuntu and Windows with Python
  3.10 and 3.12 (`compileall` + the unittest suite).
- `.github/workflows/release.yml`: tag-driven (`v*`) and manual Windows release
  build. Pins embeddable Python 3.12.10 and pygame-ce 2.5.8, verifies the Python
  zip SHA256, rebuilds the NSIS exe on `windows-latest`, runs the test suite
  first, uploads the artifact, and publishes a GitHub Release with the exe, a zip
  package, and `SHA256SUMS.txt`.
- `build_win/build_windows.ps1`: reproducible local Windows build with pinned,
  SHA256-verified inputs (Python 3.12.10 embeddable zip and the pygame-ce 2.5.8
  cp312 wheel), a `-Clean` switch, and output path/size/SHA256 reporting.
- `build_win/README.md`: payload layout, pinned versions/URLs/SHA256, and the two
  build paths (GitHub Actions release and the local script).
- `README.zh-CN.md` (Chinese README with language switcher), `CONTRIBUTING.md`,
  `CHANGELOG.md`, and the `bb_v2/README.md` placeholder.
- `.gitattributes`: text/binary policy, LF for source files, CRLF for `.bat`
  files, and `windows_release/BrickBreaker.exe` marked as binary/no-diff.
- `docs/screenshot-windows.png`: real capture of the packaged exe running on
  Windows 10, referenced from both READMEs.
- `.gitignore`: ignore `verification/`, release zips, `SHA256SUMS.txt`, and
  `*.sha256`.

### Changed

- `README.md`: language switcher, updated feature list and project layout, a
  tests section, rewritten Windows build instructions, refreshed verification
  wording, and an MIT license section.
- `windows_release/BrickBreaker.exe` is intentionally tracked so the game can be
  played without installing Python.

## [0.2.0] - 2026-10-19 — Windows packaging

### Added

- Windows packaging: embeddable Python 3.12.10 + pygame-ce 2.5.8 payload,
  NSIS single-file self-extracting exe (`build_win/BrickBreaker.nsi`), a
  `%LOCALAPPDATA%\BrickBreaker` unpack cache guarded by a ready flag, the
  `launcher.pyw` error-reporting entry point, a generated multi-size `app.ico`,
  the `启动游戏.bat` one-click launcher, the gameplay screenshot, an English
  README, and a repository `.gitignore`.
- Headless source smoke checks: `GameSession` and `Renderer` constructed without
  a display, the fixed-step simulation advanced, and the gameplay screenshot
  captured.

## [0.1.0] - 2026-09-22 — v1

### Added

- Initial single-file Pygame brick breaker: ball, paddle and brick physics;
  paddle english; fixed 120 Hz sub-stepped physics; combo scoring; level
  progression; procedural audio; `INTACT → CRACKED → FADING → GONE` brick fade;
  resizable and fullscreen window; pause/restart/mute/quit controls.
- `bb_v1/docs/architecture.md` (state machines, ERD, module contracts) and
  `bb_v1/prompts/prompt.md` (original prompt and review notes).

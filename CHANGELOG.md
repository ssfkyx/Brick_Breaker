# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog, and the project uses Semantic Versioning.
Version numbers before 1.0.0 are retrospective labels for the dated milestones.

## [Unreleased]

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

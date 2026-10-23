# Contributing to Brick Breaker

Thanks for taking the time to contribute! This project is small on purpose: a
complete game in one Python file, plus the build and test tooling around it.

## Requirements

- Python 3.10+ (3.12 recommended) with pygame-ce 2.5.x — the tests and CI use
  `pygame-ce==2.5.8`.
- Windows builds additionally need NSIS 3.x (`makensis.exe`) and PowerShell 5.1+
  or PowerShell 7.
- No pytest and no extra runtime dependencies: the game uses only Pygame and the
  Python standard library.

## Run the game

```bash
python -m pip install "pygame-ce==2.5.8"
python bb_v1/brick_breaker.py
```

## Tests

```bash
python -m unittest discover -s tests -v
```

The suite is headless (SDL dummy drivers) and deterministic. Add or update a test
for any behaviour you change, and keep it standard-library `unittest` only. On
Windows, `python -m compileall -q bb_v1` also runs as a quick syntax check in CI.

## Windows build

```powershell
pwsh -File build_win\build_windows.ps1         # rebuild windows_release\BrickBreaker.exe
pwsh -File build_win\build_windows.ps1 -Clean  # rebuild the payload from scratch
```

Pushing a `v*` tag builds and publishes the Windows release through
`.github/workflows/release.yml`. See [`build_win/README.md`](build_win/README.md)
for the payload layout, pinned versions, and SHA256 values.

## Style

- Keep the game in the single file `bb_v1/brick_breaker.py`.
- Keep the `M1`–`M11` module banners and update `bb_v1/docs/architecture.md` when
  a module contract, state machine, or invariant changes.
- Code comments and docstrings are in English; use the naming style of the
  surrounding code.
- Windows build scripts must stay compatible with PowerShell 5.1 (no `? :`
  ternary, no `??`, no `-Parallel`).
- Do not commit generated payload files, downloaded build inputs, or local
  verification artifacts — they are covered by `.gitignore`.

## Pull requests

- Open an issue or discussion before changing `bb_v1/brick_breaker.py`; game
  behaviour and architecture changes need agreement first.
- Keep pull requests focused, and describe what changed and why.
- Make sure `python -m unittest discover -s tests -v` and
  `python -m compileall -q bb_v1` pass; CI must be green.
- Documentation and build tooling improvements are welcome without prior
  discussion.

## Reporting bugs

Include the operating system, Python and pygame versions, the exact command, and
any traceback. For the packaged exe, also attach
`%LOCALAPPDATA%\BrickBreaker\app\startup_error.log` if it exists.

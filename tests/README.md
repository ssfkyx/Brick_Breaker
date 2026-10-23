# Tests

Headless `unittest` suite for the single-file game (`bb_v1/brick_breaker.py`).
It deliberately uses only the Python standard library — no pytest, no extra
test dependencies — so it runs on any machine that can already run the game.

## What is covered

| Test class | Area |
| --- | --- |
| `ConfigTests` | tunables (`PHYSICS_STEP`, lives, combo, fade time, caps) and the `RunState` / `BallState` / `BrickState` / `HitKind` enums |
| `GeometryTests` | `FieldLayout.compute()`: derived brick grid, paddle/ball sizes and clamping for tiny windows |
| `BrickStateMachineTests` | the R7 damage chain: `INTACT → CRACKED → FADING → GONE`, fades and non-collidability while fading |
| `ScoringRulesTests` | combo multiplier ladder and cap, brick points, level bonus, level speed ramp and the rally-speed cap |
| `SessionTests` | launch (`READY → PLAYING`, ball moves on fixed `PHYSICS_STEP` updates) and losing all lives through `FLOOR` collisions up to `GAME_OVER` + restart |
| `AppTests` | `App` construction at a small size, `Renderer.draw()` into the surface, headless `pygame.display.flip()`, and window resize |

The suite forces `SDL_VIDEODRIVER=dummy` and `SDL_AUDIODRIVER=dummy` in the test
module *before* pygame is imported, so no display or sound device is required.
It seeds `random` and advances the simulation by fixed `PHYSICS_STEP` values:
there are no sleeps and no wall-clock reads.

## Run it

From the repository root, with Pygame installed (`pygame-ce==2.5.8` is what CI
uses — classic `pygame` 2.x also works):

```bash
python -m pip install "pygame-ce==2.5.8"
python -m unittest discover -s tests -v
```

On Linux use `python3` if that is how Python is installed.

### Using the bundled Windows runtime

The Windows build payload embeds a console-variant Python 3.12 with pygame-ce
already installed. It can run the suite without installing anything:

```powershell
build_win\payload\python\python.exe -m unittest discover -s tests -v
```

That path is generated locally by [`build_win/build_windows.ps1`](../build_win/build_windows.ps1)
and is git-ignored; use a normal `python` on machines without the payload.

## CI

The GitHub Actions matrix in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
runs the same command on `ubuntu-latest` and `windows-latest` with Python 3.10
and 3.12, with the SDL dummy drivers set by the workflow environment.

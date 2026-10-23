# Windows build

This directory builds `windows_release/BrickBreaker.exe`, a single-file NSIS
self-extractor that bundles a private Python runtime, so the game runs on a
64-bit Windows machine without Python installed.

## Payload layout

The exe is assembled from `build_win/payload/`:

```text
build_win/
├── BrickBreaker.nsi          # NSIS script; OutFile ..\windows_release\BrickBreaker.exe
├── build_windows.ps1         # reproducible local build (pinned inputs + SHA256 checks)
├── make_icon.py              # generates app.ico from the in-game icon (optional)
├── app.ico                   # exe icon (tracked)
├── app_icon.png              # 256×256 icon preview (tracked)
├── README.md                 # this file
├── downloads/                # cached build inputs (git-ignored)
│   ├── python-embed.zip      # python-3.12.10-embed-amd64.zip, unmodified
│   └── pygame_ce.whl         # pygame_ce-2.5.8-cp312-cp312-win_amd64.whl
├── payload/
│   ├── app/
│   │   ├── launcher.pyw      # windowed entry point with error reporting (tracked)
│   │   └── brick_breaker.py  # copied from bb_v1/ by the build (git-ignored)
│   └── python/               # expanded embeddable Python + pygame (git-ignored)
│       ├── python.exe, pythonw.exe, python312.dll, python312.zip, ...
│       ├── python312._pth    # patched: python312.zip | . | Lib\site-packages | import site
│       └── Lib/site-packages/pygame/...
└── nsis-win/                 # optional portable NSIS 3.09 toolchain (git-ignored)
```

On first launch the exe extracts `payload/app/*` to
`%LOCALAPPDATA%\BrickBreaker\app` and `payload/python/*` to
`%LOCALAPPDATA%\BrickBreaker\python`, writes a `ready_v1.1.0.flag`, and starts
`pythonw.exe app\launcher.pyw`. Later launches execute the cached copy directly.
Bump `READY_FLAG` in `BrickBreaker.nsi` whenever the payload changes, otherwise
machines with an older cache keep running the old game code.

## Pinned inputs

| Component | Version | Source | SHA256 |
| --- | --- | --- | --- |
| Python embeddable (amd64) | 3.12.10 | <https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip> | `4ACBED6DD1C744B0376E3B1CF57CE906F9DC9E95E68824584C8099A63025A3C3` |
| pygame-ce wheel (`cp312-win_amd64`) | 2.5.8 | <https://pypi.org/project/pygame-ce/2.5.8/#files> | `2CFE8AFE1E7955780F0BD4F01D65F1B4903F561407052081CFCEC31E80957C3C` |

Both hashes are enforced by [`build_windows.ps1`](build_windows.ps1) and by
[`.github/workflows/release.yml`](../.github/workflows/release.yml): the Python zip
is checked after download, and the pygame wheel is checked before it is unpacked
into the payload. The cached local copies in `build_win/downloads/` are
byte-identical to those upstream files.

## Build it locally

Prerequisites:

- 64-bit Windows 10/11;
- PowerShell 5.1+ (or PowerShell 7);
- NSIS 3.x with `makensis.exe` on `PATH`, in `build_win\nsis-win\`
  (portable, see below), or in the standard install directories
  (`C:\Program Files (x86)\NSIS` or `C:\Program Files\NSIS`);
- Python 3.12 on `PATH` only if the pygame-ce wheel is not cached yet.

```powershell
pwsh -File build_win\build_windows.ps1
```

### Portable NSIS toolchain (no admin needed)

The Windows build in this repository was produced with the portable NSIS 3.09
package, unpacked to `build_win\nsis-win\` (git-ignored) and detected
automatically by the script. That package ships **x86 stubs only**, which is why
`BrickBreaker.nsi` uses `Target x86-unicode`; the embedded Python/pygame payload
is still 64-bit, so the game itself only runs on 64-bit Windows.

| Component | Version | Source | SHA256 |
| --- | --- | --- | --- |
| NSIS portable (`nsis-3.09.zip`) | 3.09 | <https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.9/nsis-3.09.zip> | `F5DC52EEF1F3884230520199BAC6F36B82D643D86B003CE51BD24B05C6BA7C91` |

Unpack it so that `build_win\nsis-win\nsis-3.09\Bin\makensis.exe` exists.

The script:

1. downloads `build_win\downloads\python-embed.zip` only when it is missing, and
   verifies its SHA256;
2. expands it into `build_win\payload\python` and patches `python312._pth` so the
   runtime sees `Lib\site-packages` and runs `import site`;
3. installs pygame-ce into `build_win\payload\python\Lib\site-packages` from the
   cached wheel, or downloads the pinned cp312 wheel with pip (SHA256-checked);
4. copies `bb_v1\brick_breaker.py` into `build_win\payload\app`;
5. runs NSIS on `BrickBreaker.nsi` and prints the output path, size, and SHA256.

Useful switches:

- `-Clean` — rebuild the payload runtime from the cached Python zip (also
  refreshes pygame-ce);
- `-PythonVersion` / `-PygameVersion` — only versions with a pinned SHA256 in the
  script are accepted, which keeps builds reproducible.

The manual path also works once the payload has been assembled:

```powershell
cd build_win
makensis BrickBreaker.nsi
```

## Build with GitHub Actions

Pushing a tag such as `v1.1.0` runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml) on a
GitHub-hosted `windows-latest` runner. The workflow downloads and verifies the
same pinned inputs, runs the headless test suite, rebuilds the exe, uploads it as
a workflow artifact, and (for tags) publishes a GitHub Release containing:

- `windows_release/BrickBreaker.exe`;
- `BrickBreaker-<tag>-windows-x64.zip` (exe + `启动游戏.bat` + `README.txt`);
- `SHA256SUMS.txt`.

A manual `workflow_dispatch` run builds and uploads the artifact without creating
a release. The workflow mirrors the commands in `build_windows.ps1`; it has not
been executed on GitHub Actions in this repository yet, so the first tag push
is its end-to-end test.

## Committed exe

`windows_release/BrickBreaker.exe` (~13 MB) is committed on purpose, so users can
clone or download the repository and double-click the game without installing
Python. The current committed build is **v1.1.0** (selectable instrument
presets). The binary is marked `binary -diff` in `.gitattributes`; rebuild it
with this directory's script whenever the game source changes.
`windows_release/*.zip` and `windows_release/SHA256SUMS.txt` are produced only by
the release workflow and are git-ignored.

The exe is not code-signed: Windows SmartScreen may show a warning (choose
**More info → Run anyway** if you trust the build), and some antivirus products
flag unsigned self-extracting Python executables.


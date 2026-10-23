#Requires -Version 5.1
<#
.SYNOPSIS
    Rebuild windows_release\BrickBreaker.exe from the pinned build inputs.

.DESCRIPTION
    Local maintainer build that mirrors .github/workflows/release.yml:

      1. fetch (network only when the file is missing) and SHA256-verify
         build_win\downloads\python-embed.zip (Python 3.12.10 embeddable, amd64);
      2. expand it into build_win\payload\python and patch python312._pth so the
         runtime finds Lib\site-packages and runs site.main();
      3. install pygame-ce 2.5.8 into the payload from the cached wheel in
         build_win\downloads (or download the pinned cp312 wheel with pip);
      4. copy bb_v1\brick_breaker.py into build_win\payload\app;
      5. run NSIS on build_win\BrickBreaker.nsi, which writes
         windows_release\BrickBreaker.exe;
      6. print the output path, size and SHA256.

    Everything is pinned and verified, so two runs from the same inputs produce
    the same executable.  The generated payload and downloads are git-ignored;
    the resulting exe is committed under windows_release\ on purpose so users can
    run the game without a Python installation.

.PARAMETER PythonVersion
    Embeddable CPython version to bundle. Default: 3.12.10.

.PARAMETER PygameVersion
    pygame-ce version to bundle. Default: 2.5.8.

.PARAMETER Clean
    Delete the expanded payload runtime (and therefore the installed pygame)
    before rebuilding.  The downloaded inputs are kept and re-verified.

.EXAMPLE
    pwsh -File build_win\build_windows.ps1

.EXAMPLE
    pwsh -File build_win\build_windows.ps1 -Clean

.NOTES
    Requires 64-bit Windows, a Python 3.12 on PATH only when the pygame-ce wheel
    is not cached yet, and NSIS 3.x (makensis.exe).  No administrator rights are
    needed to build or to run the resulting exe.
#>

[CmdletBinding()]
param(
    [string] $PythonVersion = "3.12.10",
    [string] $PygameVersion = "2.5.8",
    [switch] $Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Pinned inputs ---------------------------------------------------------
# Keep this table in sync with .github/workflows/release.yml and build_win\README.md.
$PythonPins = @{
    "3.12.10" = @{
        Url    = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"
        Sha256 = "4ACBED6DD1C744B0376E3B1CF57CE906F9DC9E95E68824584C8099A63025A3C3"
    }
}

# pygame-ce wheels: SHA256 of the cp312-win_amd64 wheel from PyPI.
$PygamePins = @{
    "2.5.8" = "2CFE8AFE1E7955780F0BD4F01D65F1B4903F561407052081CFCEC31E80957C3C"
}

# --- Paths -----------------------------------------------------------------
$RepoRoot        = Split-Path -Parent $PSScriptRoot
$BuildDir        = $PSScriptRoot
$DownloadDir     = Join-Path $BuildDir "downloads"
$PayloadDir      = Join-Path $BuildDir "payload"
$PayloadPython   = Join-Path $PayloadDir "python"
$PayloadApp      = Join-Path $PayloadDir "app"
$SitePackagesDir = Join-Path (Join-Path $PayloadPython "Lib") "site-packages"
$PythonEmbedZip  = Join-Path $DownloadDir "python-embed.zip"
$GameSource      = Join-Path (Join-Path $RepoRoot "bb_v1") "brick_breaker.py"
$LauncherSource  = Join-Path $PayloadApp "launcher.pyw"
$IconFile        = Join-Path $BuildDir "app.ico"
$NsiScript       = Join-Path $BuildDir "BrickBreaker.nsi"
$ReleaseDir      = Join-Path $RepoRoot "windows_release"
$OutputExe       = Join-Path $ReleaseDir "BrickBreaker.exe"

# --- Helpers ---------------------------------------------------------------
function Write-Step {
    param([string] $Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Get-Sha256 {
    param([string] $Path)
    return (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToUpperInvariant()
}

function Assert-InputExists {
    param(
        [string] $Path,
        [string] $Description
    )
    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Description not found: $Path"
    }
}

function Invoke-Makensis {
    param(
        [string] $MakensisPath,
        [string] $ScriptName
    )
    Push-Location $BuildDir
    try {
        & $MakensisPath $ScriptName
        if ($LASTEXITCODE -ne 0) {
            throw "makensis failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

# --- Banner ----------------------------------------------------------------
Write-Step "Brick Breaker Windows build"
Write-Host "Repository : $RepoRoot"
Write-Host "Python     : $PythonVersion (embeddable, 64-bit)"
Write-Host "pygame-ce  : $PygameVersion"
Write-Host "Payload    : $PayloadPython"
Write-Host "Output     : $OutputExe"
Write-Host "Clean      : $($Clean.IsPresent)"

if (-not $PythonPins.ContainsKey($PythonVersion)) {
    throw "Python $PythonVersion is not pinned. Supported versions: $($PythonPins.Keys -join ', '). Add its URL and SHA256 to `$PythonPins in build_windows.ps1."
}
if (-not $PygamePins.ContainsKey($PygameVersion)) {
    throw "pygame-ce $PygameVersion is not pinned. Supported versions: $($PygamePins.Keys -join ', '). Add the cp312-win_amd64 wheel SHA256 to `$PygamePins in build_windows.ps1."
}
$PythonPin = $PythonPins[$PythonVersion]
$PygameSha256 = $PygamePins[$PygameVersion]

Assert-InputExists -Path $GameSource -Description "Game source"
Assert-InputExists -Path $LauncherSource -Description "Packaged launcher (build_win\payload\app\launcher.pyw)"
Assert-InputExists -Path $IconFile -Description "Application icon (build_win\app.ico)"
Assert-InputExists -Path $NsiScript -Description "NSIS build script (build_win\BrickBreaker.nsi)"

# --- 1. Embeddable Python runtime -----------------------------------------
Write-Step "Preparing Python $PythonVersion (embeddable runtime)"
New-Item -ItemType Directory -Force -Path $DownloadDir | Out-Null

if (-not (Test-Path -LiteralPath $PythonEmbedZip)) {
    Write-Host "Downloading $($PythonPin.Url)"
    Invoke-WebRequest -Uri $PythonPin.Url -OutFile $PythonEmbedZip
}
else {
    Write-Host "Using cached $PythonEmbedZip"
}

$embedHash = Get-Sha256 -Path $PythonEmbedZip
if ($embedHash -ne $PythonPin.Sha256) {
    throw ("Cached python-embed.zip has an unexpected SHA256.`n" +
           "  expected: $($PythonPin.Sha256)`n" +
           "  actual:   $embedHash`n" +
           "Delete '$PythonEmbedZip' and re-run to download it again.")
}
Write-Host "SHA256 OK: $embedHash"

# --- 2. Expand the payload runtime and patch python312._pth ----------------
Write-Step "Expanding the runtime into build_win\payload\python"
if ($Clean.IsPresent -and (Test-Path -LiteralPath $PayloadPython)) {
    Write-Host "Removing old payload runtime: $PayloadPython"
    Remove-Item -Recurse -Force -LiteralPath $PayloadPython
}
if (-not (Test-Path -LiteralPath $PayloadPython)) {
    New-Item -ItemType Directory -Force -Path $PayloadPython | Out-Null
    Expand-Archive -Path $PythonEmbedZip -DestinationPath $PayloadPython -Force
    Write-Host "Expanded python-embed.zip"
}
else {
    Write-Host "Payload runtime already expanded (use -Clean to refresh it)."
}

$PayloadPythonExe = Join-Path $PayloadPython "python.exe"
if (-not (Test-Path -LiteralPath $PayloadPythonExe)) {
    throw "The embedded runtime does not contain python.exe: $PayloadPythonExe"
}

$versionParts = $PythonVersion.Split(".")
$pthName = "python" + $versionParts[0] + $versionParts[1] + "._pth"
$PthFile = Join-Path $PayloadPython $pthName
if (-not (Test-Path -LiteralPath $PthFile)) {
    throw "Expected $pthName in the embedded runtime, but it was not found: $PthFile"
}
$pthLines = @(
    Get-Content -Path $PthFile |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne "" -and -not $_.StartsWith("#") }
)
$pthLines = @($pthLines | Where-Object { $_ -ne "Lib\site-packages" -and $_ -ne "import site" })
$pthLines += @("Lib\site-packages", "import site")
Set-Content -Path $PthFile -Value $pthLines -Encoding ASCII
$patchedPth = @(Get-Content -Path $PthFile)
if (-not ($patchedPth -contains "Lib\site-packages")) {
    throw "Failed to add 'Lib\site-packages' to $pthName."
}
if (-not ($patchedPth -contains "import site")) {
    throw "Failed to enable 'import site' in $pthName."
}
Write-Host "$pthName patched: $($patchedPth -join ' | ')"

# --- 3. pygame-ce into the payload ---------------------------------------
Write-Step "Installing pygame-ce $PygameVersion into the payload"
$PyGameInit = Join-Path (Join-Path $SitePackagesDir "pygame") "__init__.py"
$needsPygame = $Clean.IsPresent -or (-not (Test-Path -LiteralPath $PyGameInit))

if ($needsPygame) {
    $cachedWheel = Get-ChildItem -Path $DownloadDir -Filter "pygame_ce*.whl" -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $wheelPath = $null

    if ($null -ne $cachedWheel) {
        $cachedHash = Get-Sha256 -Path $cachedWheel.FullName
        if ($cachedHash -ne $PygameSha256) {
            throw ("Cached wheel '$($cachedWheel.Name)' has an unexpected SHA256.`n" +
                   "  expected: $PygameSha256`n" +
                   "  actual:   $cachedHash`n" +
                   "Delete '$($cachedWheel.FullName)' and re-run to download it again.")
        }
        Write-Host "Using cached $($cachedWheel.Name) (SHA256 OK)"
        $wheelPath = $cachedWheel.FullName
    }
    else {
        $hostPython = Get-Command python -ErrorAction SilentlyContinue
        if ($null -eq $hostPython) {
            throw "No 'python' on PATH. A CPython 3.12 installation is required to fetch the pygame-ce wheel; alternatively put the pinned pygame_ce wheel into '$DownloadDir'."
        }
        Write-Host "Downloading the pygame-ce $PygameVersion cp312-win_amd64 wheel with pip"
        & python -m pip download --only-binary=:all: --no-deps --python-version 3.12 --implementation cp --abi cp312 --platform win_amd64 --dest $DownloadDir "pygame-ce==$PygameVersion"
        if ($LASTEXITCODE -ne 0) {
            throw "pip download failed with exit code $LASTEXITCODE."
        }
        $downloadedWheel = Get-ChildItem -Path $DownloadDir -Filter "pygame_ce*.whl" -File |
            Where-Object { $_.Name -like "pygame_ce-$PygameVersion-*" } |
            Select-Object -First 1
        if ($null -eq $downloadedWheel) {
            throw "pip download finished but no pygame-ce $PygameVersion wheel was found in $DownloadDir."
        }
        $downloadedHash = Get-Sha256 -Path $downloadedWheel.FullName
        if ($downloadedHash -ne $PygameSha256) {
            throw ("The downloaded wheel '$($downloadedWheel.Name)' does not match the pinned SHA256.`n" +
                   "  expected: $PygameSha256`n" +
                   "  actual:   $downloadedHash")
        }
        Write-Host "Downloaded $($downloadedWheel.Name) (SHA256 OK)"
        $wheelPath = $downloadedWheel.FullName
    }

    # A wheel is a zip archive; extracting it into site-packages is exactly what
    # `pip install --no-deps --target` does (pygame-ce has no install scripts and
    # no .data relocation directory).
    New-Item -ItemType Directory -Force -Path $SitePackagesDir | Out-Null
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory($wheelPath, $SitePackagesDir)
    Write-Host "Extracted $(Split-Path -Leaf $wheelPath) into $SitePackagesDir"
}
else {
    Write-Host "pygame is already installed in the payload (use -Clean to refresh it)."
}

# Verify the payload interpreter really can import the bundled pygame.
# Note: PowerShell variable names are case-insensitive, so this must not be
# called $pygameVersion -- that would overwrite the $PygameVersion parameter.
$pygameVersionOutput = & $PayloadPythonExe -c "import pygame; print(pygame.version.ver)"
if ($LASTEXITCODE -ne 0) {
    throw "The payload Python could not import pygame. Re-run with -Clean, and check that the wheel matches Python $PythonVersion."
}
$installedPygameVersion = (@($pygameVersionOutput) | Select-Object -Last 1).Trim()
if ($installedPygameVersion -ne $PygameVersion) {
    throw "The payload contains pygame-ce $installedPygameVersion, but $PygameVersion is pinned. Re-run with -Clean."
}
Write-Host "Payload check OK: Python $PythonVersion + pygame-ce $installedPygameVersion"

# --- 4. Game source -------------------------------------------------------
Write-Step "Copying the game source into the payload"
if (-not (Test-Path -LiteralPath $PayloadApp)) {
    New-Item -ItemType Directory -Force -Path $PayloadApp | Out-Null
}
Copy-Item -Path $GameSource -Destination (Join-Path $PayloadApp "brick_breaker.py") -Force
$copied = Get-Item (Join-Path $PayloadApp "brick_breaker.py")
Write-Host ("Copied bb_v1\brick_breaker.py ({0:N0} bytes) into build_win\payload\app" -f $copied.Length)

# --- 5. NSIS --------------------------------------------------------------
Write-Step "Locating NSIS"
$makensis = $null
$pathCommand = Get-Command makensis.exe -ErrorAction SilentlyContinue
if ($null -ne $pathCommand) {
    $makensis = $pathCommand.Source
    Write-Host "Found makensis on PATH: $makensis"
}
$programCandidates = @()
if (${env:ProgramFiles(x86)}) {
    $programCandidates += (Join-Path ${env:ProgramFiles(x86)} "NSIS\makensis.exe")
}
if ($env:ProgramFiles) {
    $programCandidates += (Join-Path $env:ProgramFiles "NSIS\makensis.exe")
}
foreach ($candidate in $programCandidates) {
    if (($null -eq $makensis) -and (Test-Path -LiteralPath $candidate)) {
        $makensis = $candidate
        Write-Host "Found makensis in Program Files: $makensis"
    }
}
if ($null -eq $makensis) {
    throw ("NSIS (makensis.exe) was not found on PATH or in the standard install directories.`n" +
           "Install NSIS 3.x with one of:`n" +
           "  winget install NSIS.NSIS`n" +
           "  choco install nsis -y`n" +
           "and re-run this script.")
}

Write-Step "Building windows_release\BrickBreaker.exe"
New-Item -ItemType Directory -Force -Path $ReleaseDir | Out-Null
if (Test-Path -LiteralPath $OutputExe) {
    Write-Host "Removing the previous $OutputExe"
    Remove-Item -Force -LiteralPath $OutputExe
}
Invoke-Makensis -MakensisPath $makensis -ScriptName "BrickBreaker.nsi"

if (-not (Test-Path -LiteralPath $OutputExe)) {
    throw "NSIS finished but the expected output was not produced: $OutputExe"
}
$outputItem = Get-Item -LiteralPath $OutputExe
$outputHash = Get-Sha256 -Path $OutputExe

Write-Host ""
Write-Host "Build complete." -ForegroundColor Green
Write-Host "Output : $($outputItem.FullName)"
Write-Host "Size   : $($outputItem.Length) bytes ($([math]::Round($outputItem.Length / 1MB, 2)) MB)"
Write-Host "SHA256 : $outputHash"
$launcherBat = Get-ChildItem -Path $ReleaseDir -Filter "*.bat" -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($null -eq $launcherBat) {
    Write-Warning "The optional windows_release launcher batch file (*.bat) is missing; it is a tracked file and should be restored from the repository."
}

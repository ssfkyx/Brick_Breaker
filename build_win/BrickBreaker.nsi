Unicode true
; The embedded payload is 64-bit (Python amd64 + pygame cp312-win_amd64), but the
; NSIS stub itself only extracts files and starts pythonw.exe, so a 32-bit stub is
; sufficient and keeps portable NSIS toolchains (x86-only builds) usable locally.
; The exe still requires 64-bit Windows because of the bundled runtime.
Target x86-unicode

Name "Brick Breaker"
OutFile "..\windows_release\BrickBreaker.exe"
RequestExecutionLevel user
SetCompressor /SOLID lzma
SetCompressorDictSize 64
Icon "app.ico"
UninstallIcon "app.ico"

VIProductVersion "1.1.0.0"
VIAddVersionKey /LANG=1033 "ProductName" "Brick Breaker"
VIAddVersionKey /LANG=1033 "FileDescription" "Brick Breaker - single-file Windows build"
VIAddVersionKey /LANG=1033 "FileVersion" "1.1.0"
VIAddVersionKey /LANG=1033 "ProductVersion" "1.1.0"
VIAddVersionKey /LANG=1033 "LegalCopyright" ""

SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
BrandingText "Brick Breaker"

!define APP_DIR "$LOCALAPPDATA\BrickBreaker"
!define READY_FLAG "${APP_DIR}\ready_v1.1.0.flag"

Function .onInit
    ; Already unpacked: start the game immediately and let the installer exit.
    IfFileExists "${READY_FLAG}" 0 unpack
    IfFileExists "${APP_DIR}\python\pythonw.exe" 0 unpack
    IfFileExists "${APP_DIR}\app\launcher.pyw" 0 unpack
    Exec '"${APP_DIR}\python\pythonw.exe" "${APP_DIR}\app\launcher.pyw"'
    Quit

unpack:
FunctionEnd

Section "Brick Breaker"
    ; First run (or version refresh): unpack the private Python runtime once.
    SetOutPath "${APP_DIR}\app"
    File /r "payload\app\*.*"

    SetOutPath "${APP_DIR}\python"
    File /r "payload\python\*.*"

    ; Written last so an interrupted extraction is retried next time.
    SetOutPath "${APP_DIR}"
    FileOpen $0 "${READY_FLAG}" w
    FileWrite $0 "Brick Breaker 1.1.0"
    FileClose $0

    Exec '"${APP_DIR}\python\pythonw.exe" "${APP_DIR}\app\launcher.pyw"'
SectionEnd

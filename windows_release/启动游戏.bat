@echo off
chcp 65001 >nul
setlocal EnableExtensions
title Brick Breaker

rem Always work relative to this file, even when launched from a shortcut.
cd /d "%~dp0"

if exist "%~dp0BrickBreaker.exe" (
    start "" "%~dp0BrickBreaker.exe"
    exit /b 0
)

rem Fallback: run the source version if the exe was not copied along.
set "PY="
py -3 -c "import sys" >nul 2>nul && set "PY=py -3"
if not defined PY (
    python -c "import sys" >nul 2>nul && set "PY=python"
)
if not defined PY (
    python3 -c "import sys" >nul 2>nul && set "PY=python3"
)

if not defined PY (
    echo.
    echo 未找到 BrickBreaker.exe，也没有检测到 Python。
    echo 请把 BrickBreaker.exe 与本文件放在同一文件夹后双击。
    echo 或者安装 Python 3.8+：https://www.python.org/downloads/windows/
    echo.
    pause
    exit /b 1
)

%PY% -c "import pygame" >nul 2>nul
if errorlevel 1 (
    echo 首次运行，正在安装 pygame，请稍候...
    %PY% -m pip install --user pygame-ce
    if errorlevel 1 %PY% -m pip install --user pygame
    %PY% -c "import pygame" >nul 2>nul
    if errorlevel 1 (
        echo.
        echo pygame 安装失败，请检查网络后重试。
        echo.
        pause
        exit /b 1
    )
)

if exist "%~dp0bb_v1\brick_breaker.py" (
    %PY% "%~dp0bb_v1\brick_breaker.py"
) else if exist "%~dp0..\bb_v1\brick_breaker.py" (
    %PY% "%~dp0..\bb_v1\brick_breaker.py"
) else if exist "%~dp0brick_breaker.py" (
    %PY% "%~dp0brick_breaker.py"
) else (
    echo.
    echo 未找到 brick_breaker.py。
    echo.
    pause
    exit /b 1
)

"""Windowed entry point used by the packaged exe.

`pythonw.exe` has no console, so an import or start-up failure would otherwise be
invisible.  Show a native message box and leave a log next to the game.
"""

from __future__ import annotations

import os
import sys
import traceback


def show_error(message: str) -> None:
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(
            None, message, "Brick Breaker - 启动失败", 0x10
        )
    except Exception:
        pass


def main() -> int:
    app_dir = os.path.dirname(os.path.abspath(__file__))
    if app_dir not in sys.path:
        sys.path.insert(0, app_dir)

    try:
        import brick_breaker

        return brick_breaker.main()
    except Exception:
        details = traceback.format_exc()
        log_path = os.path.join(app_dir, "startup_error.log")
        try:
            with open(log_path, "w", encoding="utf-8") as log:
                log.write(details)
        except OSError:
            log_path = "(无法写入日志文件)"

        show_error(
            "游戏启动失败：\n\n"
            + details[-1500:]
            + "\n\n详细日志：\n"
            + log_path
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())

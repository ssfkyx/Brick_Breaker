"""Generate a multi-size Windows .ico matching the in-game window icon."""

from __future__ import annotations

import struct
from pathlib import Path

import pygame

COLOR_BRICK_TOP = (238, 92, 92)
COLOR_BRICK_BOTTOM = (94, 176, 240)
COLOR_PADDLE = (245, 245, 245)
COLOR_BALL = (255, 214, 90)


def render_icon(size: int) -> pygame.Surface:
    """Draw the icon at 4x and downsample for clean antialiased edges."""
    scale = 32  # 1024 / 32
    big = pygame.Surface((32 * scale, 32 * scale), pygame.SRCALPHA)
    big.fill((0, 0, 0, 0))

    def rect(x: int, y: int, w: int, h: int, color, radius: int) -> None:
        pygame.draw.rect(
            big,
            color,
            pygame.Rect(x * scale, y * scale, w * scale, h * scale),
            border_radius=radius * scale,
        )

    rect(3, 3, 26, 7, COLOR_BRICK_TOP, 2)
    rect(3, 13, 26, 7, COLOR_BRICK_BOTTOM, 2)
    rect(9, 25, 14, 4, COLOR_PADDLE, 2)
    pygame.draw.circle(big, COLOR_BALL, (16 * scale, 21 * scale), 3 * scale)

    return pygame.transform.smoothscale(big, (size, size))


def bmp_entry(surface: pygame.Surface) -> bytes:
    """Encode a surface as a classic 32-bit BMP icon entry (bottom-up BGRA)."""
    width, height = surface.get_size()
    pixels = pygame.image.tobytes(surface, "BGRA")
    stride = width * 4
    rows = [pixels[y * stride:(y + 1) * stride] for y in range(height)]
    xor = b"".join(reversed(rows))

    mask_stride = ((width + 31) // 32) * 4
    and_mask = b"\x00" * (mask_stride * height)

    header = struct.pack(
        "<IiiHHIIiiII",
        40,             # biSize
        width,          # biWidth
        height * 2,     # biHeight: XOR + AND mask
        1,              # biPlanes
        32,             # biBitCount
        0,              # biCompression (BI_RGB)
        len(xor) + len(and_mask),
        0, 0, 0, 0,
    )
    return header + xor + and_mask


def main() -> None:
    pygame.init()
    sizes = (16, 24, 32, 48, 64, 128, 256)
    entries = []
    for size in sizes:
        surface = render_icon(size)
        entries.append((size, bmp_entry(surface)))
        if size == 256:
            pygame.image.save(surface, "app_icon.png")

    offset = 6 + 16 * len(entries)
    directory = struct.pack("<HHH", 0, 1, len(entries))
    chunks = []
    for size, data in entries:
        directory += struct.pack(
            "<BBBBHHII",
            0 if size == 256 else size,
            0 if size == 256 else size,
            0, 0, 1, 32, len(data), offset,
        )
        chunks.append(data)
        offset += len(data)

    Path("app.ico").write_bytes(directory + b"".join(chunks))
    pygame.quit()
    print("wrote app.ico and app_icon.png")


if __name__ == "__main__":
    main()

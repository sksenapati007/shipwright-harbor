#!/usr/bin/env python3
"""Generate Harbor app icons (pixel-art "H" on a hull). Stdlib only: python3 scripts/gen_icons.py"""
import struct
import zlib
from pathlib import Path

G = [
    "................",
    "................",
    "...XX......XX...",
    "...XX......XX...",
    "...XX......XX...",
    "...XX......XX...",
    "...XXXXXXXXXX...",
    "...XXXXXXXXXX...",
    "...XX......XX...",
    "...XX......XX...",
    "...XX......XX...",
    "...XX......XX...",
    "XXXXXXXXXXXXXXXX",
    ".XXXXXXXXXXXXXX.",
    "..XXXXXXXXXXXX..",
    "................",
]


def chunk(t: bytes, d: bytes) -> bytes:
    return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


def png(size: int, pad: float, path: Path) -> None:
    bg, fg = (250, 250, 247), (17, 17, 17)
    cells = 16
    cs = int(size * (1 - 2 * pad)) // cells
    off = (size - cs * cells) // 2
    raw = bytearray()
    for y in range(size):
        raw.append(0)
        gy = (y - off) // cs if y >= off else -1
        for x in range(size):
            gx = (x - off) // cs if x >= off else -1
            on = 0 <= gx < cells and 0 <= gy < cells and G[gy][gx] == "X"
            raw += bytes(fg if on else bg)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )


out = Path(__file__).resolve().parent.parent / "public" / "icons"
png(192, 0.12, out / "icon-192.png")
png(512, 0.12, out / "icon-512.png")
png(512, 0.22, out / "icon-maskable-512.png")
png(180, 0.12, out / "apple-touch-icon.png")

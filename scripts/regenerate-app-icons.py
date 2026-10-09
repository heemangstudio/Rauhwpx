#!/usr/bin/env python3

from __future__ import annotations

import io
import shutil
import struct
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
LOGO_DIR = ROOT / "rhwp" / "assets" / "logo"
BUILD_DIR = ROOT / "build"
STUDIO_PUBLIC = ROOT / "rhwp" / "rhwp-studio" / "public"
VSCODE_ICON = ROOT / "rhwp" / "rhwp-vscode" / "media" / "icon.png"
PNG_SIZES = (16, 32, 128, 256, 300, 512, 1024)
ICO_SIZES = (16, 32, 48, 64, 128, 256)


def load_master(path: Path) -> Image.Image:
    return Image.open(path).convert("RGBA").resize((1024, 1024), Image.Resampling.NEAREST)


def write_pngs(master: Image.Image) -> None:
    LOGO_DIR.mkdir(parents=True, exist_ok=True)
    for size in PNG_SIZES:
        dest = LOGO_DIR / f"logo-{size}.png"
        resized = master.resize((size, size), Image.Resampling.NEAREST)
        resized.save(dest, format="PNG", optimize=True)
        print(f"wrote {dest}")


def write_png_compressed_ico(master: Image.Image, dest: Path) -> None:
    """Write a 32-bpp PNG-in-ICO.

    `icotool -c` quantizes to 8-bpp palette DIBs. Electron-builder / rcedit on
    Windows reject those and expect 32-bpp images (PNG-compressed ICO entries).
    """
    pngs: list[bytes] = []
    for size in ICO_SIZES:
        buf = io.BytesIO()
        master.resize((size, size), Image.Resampling.NEAREST).convert("RGBA").save(
            buf, format="PNG", optimize=True
        )
        pngs.append(buf.getvalue())

    count = len(pngs)
    offset = 6 + 16 * count
    header = struct.pack("<HHH", 0, 1, count)
    entries = bytearray()
    blobs = bytearray()
    for size, data in zip(ICO_SIZES, pngs, strict=True):
        width = 0 if size >= 256 else size
        height = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", width, height, 0, 0, 1, 32, len(data), offset)
        blobs += data
        offset += len(data)
    dest.write_bytes(header + bytes(entries) + bytes(blobs))
    assert_ico_is_32bpp_png(dest)


def assert_ico_is_32bpp_png(path: Path) -> None:
    data = path.read_bytes()
    reserved, typ, count = struct.unpack_from("<HHH", data, 0)
    if reserved != 0 or typ != 1 or count == 0:
        raise SystemExit(f"{path}: invalid ICO header")
    off = 6
    for _ in range(count):
        _w, _h, _colors, _reserved, planes, bitcount, size, offset = struct.unpack_from(
            "<BBBBHHII", data, off
        )
        if planes != 1 or bitcount != 32:
            raise SystemExit(f"{path}: expected 32-bpp ICO entry, got planes={planes} bpp={bitcount}")
        if data[offset : offset + 8] != b"\x89PNG\r\n\x1a\n":
            raise SystemExit(f"{path}: expected PNG-compressed ICO image data")
        if size == 0 or offset + size > len(data):
            raise SystemExit(f"{path}: ICO entry payload is truncated")
        off += 16


def write_favicon_and_ico(master: Image.Image) -> None:
    favicon = LOGO_DIR / "favicon.ico"
    electron_ico = BUILD_DIR / "icon.ico"
    studio_favicon = STUDIO_PUBLIC / "favicon.ico"
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    write_png_compressed_ico(master, favicon)
    shutil.copy2(favicon, electron_ico)
    shutil.copy2(favicon, studio_favicon)
    print(f"wrote {favicon}")
    print(f"wrote {electron_ico}")
    print(f"wrote {studio_favicon}")


def write_icns(master: Image.Image) -> None:
    dest = BUILD_DIR / "icon.icns"
    master.save(dest, format="ICNS")
    print(f"wrote {dest}")


def strokes_on_transparent(master: Image.Image, size: int) -> Image.Image:
    """Use the colored artwork silhouette for CSS masks."""
    scaled = master.resize((size, size), Image.Resampling.NEAREST)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    src = scaled.load()
    dst = out.load()
    for y in range(size):
        for x in range(size):
            r, g, b, a = src[x, y]
            if a > 0 and max(r, g, b) > 0:
                dst[x, y] = (255, 255, 255, a)
    return out


def write_ui_copies(master: Image.Image) -> None:
    studio_icons = STUDIO_PUBLIC / "icons"
    for size in (128, 192, 256, 512):
        dest = studio_icons / f"icon-{size}.png"
        master.resize((size, size), Image.Resampling.NEAREST).save(
            dest, format="PNG", optimize=True
        )
        print(f"wrote {dest}")
    for extension in ("rhwp-chrome/icons", "rhwp-firefox/icons", "rhwp-safari/src/icons"):
        for size in (16, 32, 48, 128):
            dest = ROOT / "rhwp" / extension / f"icon-{size}.png"
            master.resize((size, size), Image.Resampling.NEAREST).save(dest, optimize=True)
    shutil.copy2(LOGO_DIR / "logo-1024.png", ROOT / "website/assets/hamaeditor-logo.png")
    shutil.copy2(LOGO_DIR / "logo-1024.png", ROOT / "rhwp/rhwp-logo.png")
    rau = strokes_on_transparent(master, 128)
    rau.save(studio_icons / "rau.png", format="PNG", optimize=True)
    master.resize((128, 128), Image.Resampling.NEAREST).save(
        VSCODE_ICON, format="PNG", optimize=True
    )
    print(f"wrote {studio_icons / 'rau.png'}")
    print(f"wrote {VSCODE_ICON}")


def main() -> int:
    candidates = [LOGO_DIR / "hamaeditor-master.png"]
    if len(sys.argv) > 1:
        candidates.insert(0, Path(sys.argv[1]))
    src = next((p for p in candidates if p.is_file()), None)
    if src is None:
        raise SystemExit("no logo master PNG found")
    print(f"master {src}")
    master = load_master(src)
    write_pngs(master)
    write_favicon_and_ico(master)
    write_icns(master)
    write_ui_copies(master)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

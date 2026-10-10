#!/usr/bin/env python3
"""Generate the HamaEditor nightly app icon ("Moonlit pond").

The release hippo stands at the edge of a night pond: a crescent moon in the
top-right corner, stars, ripples off its feet and the moon's reflection on the
water. The hippo is copied cell for cell from hamaeditor-master.png; only the
background changes.

Outputs in rhwp/assets/logo/nightly/:
  hamaeditor-nightly-master.png   2048x2048, the same 32x32 grid as the master
  icon.icns                       macOS app icon
  icon.ico                        Windows app and installer icon, Studio favicon
  icon-{128,192,256,512}.png      Studio icons; icon-512 is also the Linux icon

Nightly packages copy these over the release icons
(scripts/apply-nightly-icon.mjs).

Usage: python3 scripts/generate-nightly-icon.py
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "rhwp" / "assets" / "logo" / "hamaeditor-master.png"
OUT_DIR = ROOT / "rhwp" / "assets" / "logo" / "nightly"
GRID = 32
STUDIO_SIZES = (128, 192, 256, 512)

# The icon's eye is a gap onto its black background. Drawing it keeps the eye
# on the night sky.
EYE = (15, 14)

PALETTE = {
    # sky, darkest at the top; band 3 is the halo and the glow on the horizon
    "0": (0x06, 0x08, 0x1A),
    "1": (0x0B, 0x10, 0x2E),
    "2": (0x12, 0x19, 0x42),
    "3": (0x1B, 0x25, 0x5A),
    # crescent moon, its earthshine, and the reflection fading down the water
    "M": (0xFF, 0xF1, 0xC2),
    "m": (0xE8, 0xC7, 0x72),
    "e": (0x26, 0x31, 0x6E),
    "n": (0xA8, 0x8C, 0x52),
    "u": (0x6A, 0x5A, 0x3C),
    # stars: core, sparkle arms, dim
    "*": (0xE6, 0xF5, 0xFF),
    "+": (0x9A, 0xA8, 0xE0),
    ":": (0x6C, 0x79, 0xB8),
    # ripples off the feet, in the hippo's own shades as in the boot logo
    "s": (0x2F, 0x73, 0xA0),
    "d": (0x1D, 0x47, 0x66),
    # water, darkening with depth, and faint swells
    "a": (0x07, 0x0C, 0x22),
    "b": (0x05, 0x09, 0x1A),
    "c": (0x04, 0x07, 0x15),
    "f": (0x03, 0x05, 0x10),
    "g": (0x02, 0x04, 0x0C),
    "r": (0x12, 0x1C, 0x44),
    "q": (0x10, 0x18, 0x3A),
}

# '#' marks the hippo, copied from the master. Row 26 is the waterline.
SCENE = [
    "00000000000000000000012333333333",
    "000000000*000000000*023333mMM333",
    "000000000000000000001:333eemMM33",
    "0000+0000000000000002233eeeemMM3",
    "000+*+000000000*00001333eeeemMM3",
    "0000+0000000000000002233eeeemMM3",
    "000000000000000000###2333eemMM33",
    "101010101010101010#####333mMM333",
    "010101010101010101#####333333333",
    "101010:01010101010####2233333332",
    "11111111111111111#####1122232221",
    "1111111111+111#11#####1111212111",
    "111111111+*+1########11111111111",
    "1111111111+1111######111#1111:11",
    "1*111111111111#######1#####11111",
    "1111111111111##############11111",
    "1111111111###############1111111",
    "2121212################121212121",
    "12121###############121212121212",
    "22222##############222222222+222",
    "22222##############22222222+*+22",
    "22:22##############222222222+222",
    "222222############22222222222222",
    "323232############32323232323232",
    "232323############232323*3232323",
    "333333#####33#####33333333333333",
    "333ss333333333333333sss33mmmmmm3",
    "aaaadaaaaaaaaaaaaaaaaaaaaaMMMMaa",
    "bbbbbbbbbrrrrbbbbbbbbddbbbbbbbbb",
    "cccccccccccccccccccccccccmmcnnnc",
    "ffffqqqfffffffqqqqffffffffffffff",
    "ggggggggggggggggggggggggggguuggg",
]


def load_icon_tools():
    """Reuse the release icon writers (32-bpp ICO, ICNS, 1024 master)."""
    path = ROOT / "scripts" / "regenerate-app-icons.py"
    sys.dont_write_bytecode = True  # keep scripts/ free of __pycache__
    spec = importlib.util.spec_from_file_location("regenerate_app_icons", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def hippo_cells(master: Image.Image) -> dict[tuple[int, int], tuple[int, int, int]]:
    grid = master.resize((GRID, GRID), Image.Resampling.NEAREST)
    if grid.resize(master.size, Image.Resampling.NEAREST).tobytes() != master.tobytes():
        raise SystemExit(f"{MASTER} is no longer a {GRID}x{GRID} pixel grid")
    px = grid.load()
    cells = {
        (x, y): px[x, y]
        for y in range(GRID)
        for x in range(GRID)
        if px[x, y] != (0, 0, 0)
    }
    cells[EYE] = (0, 0, 0)
    return cells


def compose(cells: dict[tuple[int, int], tuple[int, int, int]]) -> Image.Image:
    assert len(SCENE) == GRID and all(len(row) == GRID for row in SCENE)
    marked = {(x, y) for y, row in enumerate(SCENE) for x, ch in enumerate(row) if ch == "#"}
    if marked != set(cells):
        raise SystemExit("SCENE hippo cells no longer match hamaeditor-master.png")
    icon = Image.new("RGB", (GRID, GRID))
    px = icon.load()
    for y, row in enumerate(SCENE):
        for x, ch in enumerate(row):
            px[x, y] = cells[(x, y)] if ch == "#" else PALETTE[ch]
    return icon


def main() -> int:
    tools = load_icon_tools()
    master = Image.open(MASTER).convert("RGB")
    icon = compose(hippo_cells(master))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    nightly_master = OUT_DIR / "hamaeditor-nightly-master.png"
    icon.resize(master.size, Image.Resampling.NEAREST).convert("RGBA").save(
        nightly_master, format="PNG", optimize=True
    )
    print(f"wrote {nightly_master}")

    rgba = tools.load_master(nightly_master)
    tools.write_png_compressed_ico(rgba, OUT_DIR / "icon.ico")
    print(f"wrote {OUT_DIR / 'icon.ico'}")
    rgba.save(OUT_DIR / "icon.icns", format="ICNS")
    print(f"wrote {OUT_DIR / 'icon.icns'}")
    for size in STUDIO_SIZES:
        dest = OUT_DIR / f"icon-{size}.png"
        rgba.resize((size, size), Image.Resampling.NEAREST).save(dest, format="PNG", optimize=True)
        print(f"wrote {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

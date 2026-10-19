#!/usr/bin/env python3
"""Generate the update hippo: it peeks up from the document home's bottom-right edge,
facing left, and holds a picket sign up by biting its stick.

The hippo is the setup hippo (palette from generate-boot-logo.py) drawn about 1.5x larger
so its face reads next to the sign, facing left into the screen. Its neck and back run off
the window's bottom and right edges. The stick stands just in front of the muzzle, its foot
held between the lips. The sign
board is HTML (it carries Korean text and buttons); the sprite draws only the hippo and
the stick, whose top end the board covers.

Every frame is one cell on the boot logo's logical pixel grid. The last row sits on the
window's bottom edge and the last column on its right edge.

Output: rhwp-studio/src/ui/update-hippo/update-hippo-sprites.png (1x), next to the
component. Cell order (SPRITE_FRAMES), the cell size and the stick column (STICK_X) are
the contract with rhwp-studio/src/ui/update-hippo/update-hippo.ts.

Usage: python3 scripts/generate-update-hippo-art.py [--preview DIR]
  --preview DIR also writes an 8x sheet on the light and dark home colours.
"""

from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "rhwp" / "rhwp-studio" / "src" / "ui" / "update-hippo" / "update-hippo-sprites.png"

sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
_spec = importlib.util.spec_from_file_location("boot_logo", ROOT / "scripts" / "generate-boot-logo.py")
boot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(boot)

PALETTE = dict(boot.HIPPO)
PALETTE.update({
    # The stick: plain wood, lit from the left.
    "X": (0xE2, 0xB0, 0x78),
    "W": (0xB8, 0x7C, 0x48),
})

WIDTH = 36
PAD = 3            # columns left of the hippo, room for the stick
STICK_X = 1        # left column of the two-pixel stick
STICK_ROWS = 12    # stick rows above the ear tip
MOUTH_ROW = 9      # hippo row of the mouth line

# The setup hippo's head at about 1.5x: a nostril bump on the front of the muzzle, the eye
# bump, a small ear behind it, and the mouth line curving up into a smile. The neck and back
# run on to the right edge of the cell and off the window.
HIPPO = [
    "..............hhh.......hh.......",
    ".............hoooh.....hsoh......",
    "...hhh......hookooh...hsoo.......",
    "..hokoh....hoookooohhhooooh......",
    ".hoooooohhhoooooooooooooooooh....",
    "hooooooooooooooooooooooooooooohh.",
    "ooooooooooooooooooooooooooooooohh",
    "ooooooooooooooooooooooooooooooooo",
    "sooooooooooookooooooooooooooooooo",
    "sokkkkkkkkkkkoooooooooooooooooooo",
    "ssooooooooooosooooooooooooooooooo",
    ".sssooooooossoooooooooooooooooooo",
    "...sssssssssooooooooooooooooooooo",
    "...........sooooooooooooooooooooo",
]


def patch(rows: list[str], pixels: dict[tuple[int, int], str]) -> list[str]:
    """Change single pixels, keyed (column, row) like the image."""
    out = list(rows)
    for (c, r), ch in pixels.items():
        out[r] = out[r][:c] + ch + out[r][c + 1:]
    return out


# Eyes shut: the eye becomes a lid line.
BLINK = patch(HIPPO, {(15, 2): "o", (14, 3): "d", (15, 3): "d", (16, 3): "d"})
# The ear twitches.
EAR = patch(HIPPO, {(24, 0): "."})
# Dip: eyes shut and the ear laid flat while it ducks under the edge.
DIP = patch(BLINK, {(24, 0): ".", (25, 0): ".", (24, 1): "h", (25, 1): "h", (26, 1): "s"})
# Ducked: the top three rows show; the nostril bump would be a lone bar beside the eye.
PEEK = patch(HIPPO, {(3, 2): ".", (4, 2): ".", (5, 2): "."})


def put(rows: list[str], x: int, y: int, ch: str) -> None:
    rows[y] = rows[y][:x] + ch + rows[y][x + 1:]


def frame(hippo: list[str], stick: bool = True) -> list[str]:
    rows = ["." * WIDTH] * STICK_ROWS + [("." * PAD + row).ljust(WIDTH, ".")[:WIDTH] for row in hippo]
    if not stick:
        return rows
    mouth = STICK_ROWS + MOUTH_ROW
    for y in range(mouth + 2):
        put(rows, STICK_X, y, "X")
        put(rows, STICK_X + 1, y, "W")
    # The bite. The upper lip reaches forward over the stick, the mouth corner opens dark on
    # both sides of it with a tooth behind, the stick runs a row past the lip line, and the
    # lower lip closes under its foot.
    left, right = STICK_X - 1, STICK_X + 2
    for x in range(left, right + 1):
        put(rows, x, mouth - 1, "s" if x == left else "o")
    put(rows, left, mouth, "k")
    put(rows, right, mouth, "w")
    put(rows, right + 1, mouth, "k")
    put(rows, left, mouth + 1, "k")
    put(rows, right, mouth + 1, "k")
    for x in range(left, right + 2):
        put(rows, x, mouth + 2, "s")
    return rows


SPRITE_FRAMES = ("idle", "blink", "ear", "dip", "peek")


def frames() -> dict[str, list[str]]:
    return {
        "idle": frame(HIPPO),
        "blink": frame(BLINK),
        "ear": frame(EAR),
        "dip": frame(DIP),
        # Ducked, it lets go of the sign: only the ear and eye show above the edge. The
        # muzzle's top row would show as a stray bar there, so this cell leaves it out.
        "peek": frame(PEEK, stick=False),
    }


def verify(all_frames: dict[str, list[str]]) -> None:
    for pose in (HIPPO, BLINK, EAR, DIP, PEEK):
        assert len(pose) == len(HIPPO) and all(len(row) <= WIDTH - PAD for row in pose)
    for name, rows in all_frames.items():
        assert len(rows) == STICK_ROWS + len(HIPPO) and all(len(row) == WIDTH for row in rows), name
        if name != "peek":
            assert rows[0][STICK_X] == "X", f"{name}: stick does not reach the top"
            mouth = STICK_ROWS + MOUTH_ROW
            assert rows[mouth - 1][STICK_X] != "X" and rows[mouth + 1][STICK_X] == "X", \
                f"{name}: the stick must pass behind the upper lip and on below the lip line"


def write(dest: Path, preview: Path | None) -> tuple[int, int]:
    all_frames = frames()
    verify(all_frames)
    cell_w, cell_h = WIDTH, len(all_frames["idle"])
    sheet = Image.new("RGBA", (cell_w * len(SPRITE_FRAMES), cell_h))
    for i, name in enumerate(SPRITE_FRAMES):
        for r, row in enumerate(all_frames[name]):
            for c, ch in enumerate(row):
                if ch != ".":
                    sheet.putpixel((i * cell_w + c, r), PALETTE[ch] + (255,))
    dest.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dest, optimize=True)
    if preview:
        preview.mkdir(parents=True, exist_ok=True)
        scale, pad, gap = 8, 2, 3
        band_w = len(SPRITE_FRAMES) * (cell_w + gap) + pad
        out = Image.new("RGBA", (band_w * scale, (cell_h + pad) * 2 * scale))
        for k, bg in enumerate(((0xF2, 0xF3, 0xF5), (0x0F, 0x0F, 0x0F))):
            band = Image.new("RGBA", (band_w, cell_h + pad), bg + (255,))
            for i in range(len(SPRITE_FRAMES)):
                band.alpha_composite(sheet.crop((i * cell_w, 0, (i + 1) * cell_w, cell_h)),
                                     (pad + i * (cell_w + gap), pad))
            out.paste(band.resize((band.width * scale, band.height * scale), Image.Resampling.NEAREST),
                      (0, k * band.height * scale))
        out.save(preview / "update-hippo-preview.png")
    return cell_w, cell_h


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", type=Path, help="also write an 8x preview sheet here")
    args = parser.parse_args()
    cell_w, cell_h = write(DEST, args.preview)
    print(f"{len(SPRITE_FRAMES)} frames of {cell_w}x{cell_h} px -> {DEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

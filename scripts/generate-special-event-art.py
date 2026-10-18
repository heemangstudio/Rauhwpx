#!/usr/bin/env python3
"""Generate the special-event sprite: the hippo and Clawd holding hands.

The hippo stands up on its hind legs. Its head is the setup hippo's CLOSED pose
and its feet are the BODY leg rows, both read from generate-boot-logo.py, so the
hippo stays the app icon's hippo. Only the upright body and the arm are new.
Clawd follows the Claude Code terminal mark: a wide body, two tall eyes, arm
stubs and four thin legs.

Every frame is one cell on the boot logo's logical pixel grid, bottom-aligned on a
shared ground line, so the joined hands stay touching in every pose.

Output: rhwp-studio/src/ui/special-event/hama-clawd-sprites.png (1x), next to the popup.
Cell order (SPRITE_FRAMES) is the contract with
rhwp-studio/src/ui/special-event/special-event-popup.ts.

Usage: python3 scripts/generate-special-event-art.py [--preview DIR]
  --preview DIR also writes an 8x sheet on the light and dark sheet colours.
"""

from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / "rhwp" / "rhwp-studio" / "src" / "ui" / "special-event" / "hama-clawd-sprites.png"

_spec = importlib.util.spec_from_file_location("boot_logo", ROOT / "scripts" / "generate-boot-logo.py")
boot = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(boot)

PALETTE = dict(boot.HIPPO)
PALETTE.update({
    # Clawd: Claude's terracotta, shaded like the hippo (light from the top, shadow right and below).
    "A": (0xD9, 0x77, 0x57),
    "B": (0xB4, 0x5A, 0x3C),
    "C": (0xEE, 0xA0, 0x84),
    "E": (0x1F, 0x12, 0x0E),
})

# ---------------------------------------------------------------- hippo
HEAD_COL = 10  # CLOSED column that becomes column 0 here


def head(pose: list[str]) -> list[str]:
    """Rows 5..12 of a setup pose: ears, eye, snout and chin."""
    rows = [row[HEAD_COL:HEAD_COL + 21] for row in pose[5:13]]
    # The nape runs on into the upright back, so its highlight continues down column 0.
    return [("h" + row[1:]) if r in (6, 7) else row for r, row in enumerate(rows)]


# Upright trunk with the near arm reaching forward and down to Clawd.
TRUNK = [
    "hhoooooooos..........",
    "hoooooooooohh........",
    "hooooooooosooh.......",
    "hoooooooooosooh......",
    "ooooooooooosoooh.....",
    "oooooooooooosoooh....",
    "ooooooooooooosoooh...",
    "oooooooooooosssoooo..",
    "soooooooooooossssss..",
    "ssoooooooooos........",
    ".sssoooooosss........",
]
LEGS = [row[4:25] for row in boot.BODY[7:]]
CROUCH_FEET = [boot.CROUCH[-1][4:25]]


def hippo(pose: list[str] = boot.CLOSED, legs: list[str] = LEGS, mouth_open: bool = False) -> list[str]:
    rows = head(pose)
    if mouth_open:
        # Upper jaw lifts one row at the front: a wedge of mouth opening toward the
        # snout tip, with the icon's tooth. A full-width gap would read as sunglasses.
        rows = rows[:6] + ["o" * 13 + "kkkkw" + "..."] + rows[6:]
    return rows + TRUNK + legs


# ---------------------------------------------------------------- clawd
CLAWD_BODY = [
    "...CCCCCCCCCCCCCC...",
    "...AAAAAAAAAAAAAB...",
    "...AAEAAAAAAAEAAB...",
    "...AAEAAAAAAAEAAB...",
    "AAAAAAAAAAAAAAAABBB.",
    "BBBAAAAAAAAAAAAABBB.",
    "...AAAAAAAAAAAAAB...",
    "...AAAAAAAAAAAAAB...",
    "...BBBBBBBBBBBBBB...",
]
CLAWD_LEGS = [
    "....A.A......A.A....",
    "....B.B......B.B....",
]


def clawd(blink: bool = False, crouch: bool = False, happy: bool = False) -> list[str]:
    rows = list(CLAWD_BODY)
    if blink:
        rows[2] = rows[2].replace("E", "A")
    if happy:
        # ^ ^ eyes, each peaking on the open eye's column.
        rows[2] = "...AAEAAAAAAAEAAB..."
        rows[3] = "...AEAEAAAAAEAEAB..."
    legs = ["....B.B......B.B...."] if crouch else CLAWD_LEGS
    return rows + legs


# Clawd's held arm starts right where the hippo's paw ends.
CLAWD_X = 19

SPRITE_FRAMES = ("idle", "hippo-blink", "clawd-blink", "crouch", "cheer")


def frames() -> dict[str, tuple[list[str], list[str]]]:
    return {
        "idle": (hippo(), clawd()),
        "hippo-blink": (hippo(boot.BLINK), clawd()),
        "clawd-blink": (hippo(), clawd(blink=True)),
        "crouch": (hippo(legs=LEGS[:-2] + CROUCH_FEET), clawd(crouch=True)),
        "cheer": (hippo(mouth_open=True), clawd(happy=True)),
    }


def cell_size(all_frames) -> tuple[int, int]:
    w = max(max(len(h[0]), CLAWD_X + len(c[0])) for h, c in all_frames.values())
    h = max(max(len(hp), len(cl)) for hp, cl in all_frames.values())
    return w, h


def paint(sheet: Image.Image, x0: int, cell_h: int, rows: list[str], dx: int) -> None:
    top = cell_h - len(rows)
    for r, row in enumerate(rows):
        for c, ch in enumerate(row):
            if ch != ".":
                sheet.putpixel((x0 + dx + c, top + r), PALETTE[ch] + (255,))


def layer(rows: list[str], cell_h: int, dx: int) -> set[tuple[int, int]]:
    top = cell_h - len(rows)
    return {(dx + c, top + r) for r, row in enumerate(rows) for c, ch in enumerate(row) if ch != "."}


def verify(all_frames, cell_h: int) -> None:
    """The head must stay the setup hippo's head; the hands must touch in every frame."""
    for r, row in enumerate(hippo()[:8]):
        source = boot.CLOSED[5 + r][HEAD_COL:HEAD_COL + 21]
        assert row[1:] == source[1:], f"head row {r} drifted from CLOSED"
    for name, (h, c) in all_frames.items():
        # Below Clawd's top only: the snout above it also reaches that column.
        paw = {y for x, y in layer(h, cell_h, 0) if x == CLAWD_X - 1 and y >= cell_h - len(c)}
        hand = {y for x, y in layer(c, cell_h, CLAWD_X) if x == CLAWD_X}
        assert paw and paw == hand, f"{name}: paw rows {sorted(paw)} != hand rows {sorted(hand)}"
        assert not layer(h, cell_h, 0) & layer(c, cell_h, CLAWD_X), f"{name}: sprites overlap"


def write(dest: Path, preview: Path | None) -> tuple[int, int]:
    all_frames = frames()
    cell_w, cell_h = cell_size(all_frames)
    verify(all_frames, cell_h)
    sheet = Image.new("RGBA", (cell_w * len(SPRITE_FRAMES), cell_h))
    for i, name in enumerate(SPRITE_FRAMES):
        h, c = all_frames[name]
        paint(sheet, i * cell_w, cell_h, h, 0)
        paint(sheet, i * cell_w, cell_h, c, CLAWD_X)
    dest.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dest, optimize=True)
    if preview:
        preview.mkdir(parents=True, exist_ok=True)
        scale, pad = 8, 4
        out = Image.new("RGBA", ((sheet.width + pad * 2) * scale, (cell_h + pad * 2) * 2 * scale))
        for k, bg in enumerate(((0xFF, 0xFF, 0xFF), (0x18, 0x18, 0x18))):
            band = Image.new("RGBA", (sheet.width + pad * 2, cell_h + pad * 2), bg + (255,))
            band.alpha_composite(sheet, (pad, pad))
            out.paste(band.resize((band.width * scale, band.height * scale), Image.Resampling.NEAREST),
                      (0, k * band.height * scale))
        out.save(preview / "hama-clawd-preview.png")
    return cell_w, cell_h


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", type=Path, help="also write an 8x preview sheet here")
    args = parser.parse_args()
    cell_w, cell_h = write(DEST, args.preview)
    print(f"{len(SPRITE_FRAMES)} frames of {cell_w}x{cell_h} px -> {DEST.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Generate the HamaEditor boot logo ("Surface") from pixel data.

The hippo surfaces through the x-height of "tor", blinks, climbs out and
yawns into the exact app-icon pose. Every frame is drawn on one logical
pixel grid, so the outputs are exact at 1x and scale cleanly with
`image-rendering: pixelated`.

Outputs in rhwp/assets/logo/boot/:
  hama-boot-{dark,light}.gif         1x, transparent, plays once
  hama-boot-{dark,light}@4x.gif      4x, same timing
  hama-boot-{dark,light}-still.png   final frame (reduced motion), 1x and @4x
  hama-boot-timeline.json            frame timing and canvas size
  hama-sprites.png                   setup-screen poses (see SPRITE_POSES), 1x

The 1x GIFs, stills and sprites are also copied to rhwp-studio/public/images/boot/.

Usage: python3 scripts/generate-boot-logo.py [--preview DIR]
  --preview DIR also writes looping 6x previews on the app canvas colour.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "rhwp" / "assets" / "logo" / "hamaeditor-master.png"
OUT_DIR = ROOT / "rhwp" / "assets" / "logo" / "boot"
STUDIO_BOOT = ROOT / "rhwp" / "rhwp-studio" / "public" / "images" / "boot"

# ---------------------------------------------------------------- palette
HIPPO = {
    "o": (0x62, 0xB3, 0xE2),
    "s": (0x2F, 0x73, 0xA0),
    "h": (0xB2, 0xE2, 0xFB),
    "d": (0x1D, 0x47, 0x66),
    "k": (0x0C, 0x25, 0x36),
    "w": (0xE6, 0xF5, 0xFF),
    # The icon's eye is a gap onto its black background. Drawing it keeps the
    # eye on any canvas.
    "e": (0x00, 0x00, 0x00),
}

# Wordmark ink follows the Studio --n-text tokens; canvas is --n-canvas.
THEMES = {
    "dark": {
        "canvas": (0x0F, 0x0F, 0x0F),
        "ink": (0xF5, 0xF5, 0xF7),
        "shadow": (0x1D, 0x2B, 0x3A),
        "dim": (0x2A, 0x2E, 0x35),
        "ripple": (HIPPO["h"], HIPPO["o"], HIPPO["s"]),
    },
    "light": {
        "canvas": (0xF5, 0xF5, 0xF7),
        "ink": (0x1D, 0x1D, 0x1F),
        "shadow": None,
        "dim": (0xD9, 0xDC, 0xE1),
        "ripple": (HIPPO["s"], HIPPO["o"], HIPPO["h"]),
    },
}

# ---------------------------------------------------------------- hippo
# 32 columns, rows 6..25 of the 32x32 app icon.
BODY = [
    "..........hhhooooooooooss.......",
    ".......hhhoooooooooosss.........",
    ".....hhoooooooooooos............",
    ".....oooooooooooooo.............",
    ".....oooooooooooooo.............",
    ".....soooooooooooos.............",
    "......ooooooooooos..............",
    "......ooossooooosd..............",
    "......oooddssooodd..............",
    "......sssdd..sssdd..............",
]

OPEN = [
    "..................hhh...........",
    "..................ooohh.........",
    "..................oooos.........",
    "..................oooo..........",
    ".................hoooo..........",
    "..............h..oooos..........",
    ".............hshhoooo...........",
    "...............ooooos...w.......",
    "..............heooook.whohh.....",
    ".............hoooookkhoooss.....",
] + BODY

HALF = [
    "................................",
    "................................",
    "......................hhh.......",
    ".....................hooohh.....",
    "....................hoooos......",
    "..............h....hoooos.......",
    ".............hshh.hoooos........",
    "...............hhooooskk.w......",
    "..............heoooookkwhohh....",
    ".............hoooooookhoooss....",
] + BODY

CLOSED = [
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
    "..............h....hh...........",
    ".............hsh..hkoh..........",
    "..............hhhhoooohhhhh.....",
    ".............hoooooooooooooohh..",
    ".............ooooooooooooooooos.",
    "..........hhhooooooooooooooooos.",
    ".......hhhooooooooookkkkkkkksss.",
    ".....hhoooooooooooooossssssss...",
] + BODY[3:]

BLINK = CLOSED[:6] + [
    ".............hsh..hooh..........",
    "..............hhhhoddohhhhh.....",
] + CLOSED[8:]

EAR_FLICK = CLOSED[:5] + [
    "...............h...hh...........",
    ".............hhs..hkoh..........",
] + CLOSED[7:]

# Setup-screen motion: the back and front legs swap, and a squat before take-off and on landing.
STEP = CLOSED[:-3] + [
    ".......oossooooosd..............",
    ".......ooddssoooddd.............",
    "......sssd....ssdd..............",
]
CROUCH = ["." * 32] + CLOSED[:-2] + [
    ".....sssddd..sssddd.............",
]

TOOTH = (24, 7)  # sparkle anchor inside OPEN

# ---------------------------------------------------------------- wordmark
# Cap/ascender height 10, x-height 7 (rows 3..9), 1 px tracking.
GLYPHS = {
    "H": ["##...##", "##...##", "##...##", "##...##", "#######",
          "#######", "##...##", "##...##", "##...##", "##...##"],
    "a": ["......", "......", "......", ".####.", "....##",
          ".#####", "##..##", "##..##", "##.###", ".##.##"],
    "m": ["..........", "..........", "..........", "#########.", "##########",
          "##..##..##", "##..##..##", "##..##..##", "##..##..##", "##..##..##"],
    "E": ["######", "######", "##....", "##....", "#####.",
          "#####.", "##....", "##....", "######", "######"],
    "d": ["....##", "....##", "....##", ".#####", "######",
          "##..##", "##..##", "##..##", "######", ".#####"],
    "i": ["##", "##", "..", "##", "##", "##", "##", "##", "##", "##"],
    "t": [".....", ".##..", ".##..", "#####", ".##..",
          ".##..", ".##..", ".##..", ".####", "..###"],
    "o": ["......", "......", "......", ".####.", "######",
          "##..##", "##..##", "##..##", "######", ".####."],
    "r": ["......", "......", "......", "##.###", "######",
          "###...", "##....", "##....", "##....", "##...."],
}
WORD = "HamaEditor"

# Layout on a working grid; the output is cropped to the animation's bounds.
WORK_W, WORK_H = 112, 64
WORD_X, WORD_Y = 21, 34
LETTERS: list[tuple[str, int]] = []
_x = WORD_X
for _ch in WORD:
    LETTERS.append((_ch, _x))
    _x += len(GLYPHS[_ch][0]) + 1
HIPPO_X = LETTERS[7][1] - 3          # stands on "tor"
HIPPO_Y = WORD_Y + 2 - 19            # feet on the x-height
WATER = WORD_Y + 3                   # the x-height of "tor" is the waterline
HEAD_X = HIPPO_X + 19                # where ripples centre


class Frame:
    def __init__(self) -> None:
        self.px: list[list[tuple[int, int, int] | None]] = [[None] * WORK_W for _ in range(WORK_H)]

    def put(self, x: int, y: int, c) -> None:
        if 0 <= x < WORK_W and 0 <= y < WORK_H:
            self.px[y][x] = c

    def hippo(self, rows: list[str], dy: int = 0, clip: bool = False) -> None:
        for r, row in enumerate(rows):
            y = HIPPO_Y + dy + r
            if clip and y >= WATER:
                continue
            for c, ch in enumerate(row):
                if ch != ".":
                    self.put(HIPPO_X + c, y, HIPPO[ch])

    def word(self, theme: dict, lit: int = len(WORD)) -> None:
        for i, (ch, x0) in enumerate(LETTERS):
            on = i < lit
            for r, row in enumerate(GLYPHS[ch]):
                for c, p in enumerate(row):
                    if p == "#" and on and theme["shadow"]:
                        self.put(x0 + c, WORD_Y + r + 1, theme["shadow"])
            for r, row in enumerate(GLYPHS[ch]):
                for c, p in enumerate(row):
                    if p == "#":
                        self.put(x0 + c, WORD_Y + r, theme["ink"] if on else theme["dim"])


def sparkle(f: Frame, size: int) -> None:
    x, y = HIPPO_X + TOOTH[0], HIPPO_Y + TOOTH[1]
    if size <= 0:
        return
    f.put(x, y, HIPPO["w"])
    for d in range(1, size + 1):
        c = HIPPO["w"] if d < size else HIPPO["h"]
        for dx, dy in ((d, 0), (-d, 0), (0, d), (0, -d)):
            f.put(x + dx, y + dy, c)


def ripple(f: Frame, theme: dict, radius: int, age: int) -> None:
    """Two short dashes on the waterline, fading from bright to deep."""
    if age > 2:
        return
    c = theme["ripple"][age]
    for side in (-1, 1):
        x = HEAD_X + side * radius
        f.put(x, WATER - 1, c)
        f.put(x + side, WATER - 1, c)


def timeline(theme: dict) -> list[tuple[Frame, int, str]]:
    frames: list[tuple[Frame, int, str]] = []

    def add(ms: int, beat: str, draw) -> None:
        f = Frame()
        draw(f)
        frames.append((f, ms, beat))

    word = lambda f, lit=len(WORD): f.word(theme, lit)  # noqa: E731

    # 1. Idle, then the wordmark scans on left to right.
    add(220, "idle", lambda f: word(f, 0))
    for lit in range(1, len(WORD) + 1):
        add(40, "scan", lambda f, lit=lit: word(f, lit))

    # 2. Bubbles break the surface.
    bubbles = [((HEAD_X - 1, WATER - 1), "o"), ((HEAD_X - 1, WATER - 2), "h"),
               ((HEAD_X + 2, WATER - 1), "o"), ((HEAD_X + 2, WATER - 3), "h")]
    for k in range(3):
        def draw(f, k=k):
            word(f)
            (x, y), c = bubbles[k]
            f.put(x, y, HIPPO[c])
            if k:
                (x, y), c = bubbles[k + 1]
                f.put(x, y, HIPPO[c])
        add(70, "bubbles", draw)

    # 3. Ears and eye peek out; ripples spread; an ear flick and a blink.
    peek = [(13, CLOSED, 70), (12, CLOSED, 80), (12, CLOSED, 80), (12, CLOSED, 80),
            (12, EAR_FLICK, 90), (12, CLOSED, 120), (12, BLINK, 80), (12, CLOSED, 140)]
    for k, (dy, pose, ms) in enumerate(peek):
        def draw(f, k=k, dy=dy, pose=pose):
            word(f)
            f.hippo(pose, dy, clip=True)
            for start in (0, 3):
                age = k - start
                if 0 <= age <= 2:
                    ripple(f, theme, 4 + 3 * age, age)
        add(ms, "peek", draw)

    # 4. Climb out, shedding drops; overshoot and settle.
    drops: list[list[int]] = []
    for k, dy in enumerate((8, 4, 1, -1, -2, -1, 0)):
        if k in (1, 2, 3):
            drops += [[HIPPO_X + 9 + 3 * k, HIPPO_Y + dy + 13], [HIPPO_X + 25 - k, HIPPO_Y + dy + 12]]

        def draw(f, dy=dy, k=k):
            word(f)
            f.hippo(CLOSED, dy, clip=True)
            for d in drops:
                if d[1] < WATER - 1:
                    f.put(d[0], d[1], HIPPO["h"])
            if k == 0:
                ripple(f, theme, 6, 0)
            elif k == 1:
                ripple(f, theme, 9, 1)
        add(50, "rise", draw)
        for d in drops:
            d[1] += 2
    add(160, "settle", lambda f: (word(f), f.hippo(CLOSED)))

    # 5. Yawn into the app-icon pose, tooth sparkle.
    add(70, "yawn", lambda f: (word(f), f.hippo(HALF)))
    add(70, "yawn", lambda f: (word(f), f.hippo(OPEN, -1)))
    add(80, "yawn", lambda f: (word(f), f.hippo(OPEN)))
    for size in (1, 2, 3, 2, 1):
        add(60, "sparkle", lambda f, size=size: (word(f), f.hippo(OPEN), sparkle(f, size)))
    add(100, "final", lambda f: (word(f), f.hippo(OPEN)))
    return frames


# ---------------------------------------------------------------- output
def _extent(f: Frame) -> tuple[int, int, int, int]:
    xs = [x for row in f.px for x, c in enumerate(row) if c is not None]
    ys = [y for y, row in enumerate(f.px) if any(c is not None for c in row)]
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def bounds(frames) -> tuple[int, int, int, int]:
    """Canvas centred on the final lockup, wide enough for every frame."""
    fx0, fy0, fx1, fy1 = _extent(frames[-1][0])
    cx2, cy2 = fx0 + fx1, fy0 + fy1  # doubled centre keeps integer maths
    half_w = half_h = 0
    for f, _, _ in frames:
        x0, y0, x1, y1 = _extent(f)
        half_w = max(half_w, cx2 - 2 * x0, 2 * x1 - cx2)
        half_h = max(half_h, cy2 - 2 * y0, 2 * y1 - cy2)
    pad = 3
    half_w = (half_w + 1) // 2 + pad
    half_h = (half_h + 1) // 2 + pad
    x0, y0 = (cx2 + 1) // 2 - half_w, (cy2 + 1) // 2 - half_h
    return x0, y0, x0 + 2 * half_w, y0 + 2 * half_h


def to_rgba(f: Frame, box, scale: int, bg=None) -> Image.Image:
    x0, y0, x1, y1 = box
    im = Image.new("RGBA", (x1 - x0, y1 - y0))
    im.putdata([
        (c + (255,)) if c is not None else ((bg + (255,)) if bg else (0, 0, 0, 0))
        for row in f.px[y0:y1] for c in row[x0:x1]
    ])
    return im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST) if scale > 1 else im


def write_gif(frames, box, scale: int, dest: Path, *, bg=None, loop: bool = False, hold: int = 0) -> None:
    """Exact-palette GIF: index 0 is transparent, no dithering, full-frame disposal."""
    colours: dict[tuple[int, int, int], int] = {}
    for f, _, _ in frames:
        for row in f.px:
            for c in row:
                if c is not None and c not in colours:
                    colours[c] = len(colours) + 1
    if bg is not None and bg not in colours:
        colours[bg] = len(colours) + 1
    palette = [255, 0, 255] + [v for c in colours for v in c]
    x0, y0, x1, y1 = box
    ims = []
    for f, _, _ in frames:
        im = Image.new("P", (x1 - x0, y1 - y0))
        im.putdata([
            colours[c] if c is not None else (colours[bg] if bg else 0)
            for row in f.px[y0:y1] for c in row[x0:x1]
        ])
        im.putpalette(palette)
        if scale > 1:
            im = im.resize((im.width * scale, im.height * scale), Image.Resampling.NEAREST)
        ims.append(im)
    durations = [ms for _, ms, _ in frames]
    durations[-1] += hold
    kwargs = dict(save_all=True, append_images=ims[1:], duration=durations,
                  disposal=2, optimize=False)
    if bg is None:
        kwargs["transparency"] = 0
    if loop:
        kwargs["loop"] = 0
    ims[0].save(dest, **kwargs)


def verify_icon_pose() -> None:
    """The last frame must be the app icon, pixel for pixel."""
    master = Image.open(MASTER).convert("RGB")
    cell = master.width // 32
    for r, row in enumerate(OPEN):
        for c, ch in enumerate(row):
            got = master.getpixel((c * cell + cell // 2, (r + 6) * cell + cell // 2))
            want = HIPPO[ch] if ch != "." else (0, 0, 0)
            if got != want:
                sys.exit(f"OPEN pose differs from the app icon at ({c}, {r + 6}): {got} != {want}")


# Order is the contract with rhwp-studio/src/ui/initial-setup/hippo.ts.
SPRITE_POSES = ("closed", "talk", "open", "blink", "step", "crouch")
SPRITE_COLS = (5, 31)  # columns any pose uses


def write_sprites(dest: Path) -> tuple[int, int]:
    poses = {"closed": CLOSED, "talk": HALF, "open": OPEN, "blink": BLINK, "step": STEP, "crouch": CROUCH}
    x0, x1 = SPRITE_COLS
    cell_w, cell_h = x1 - x0, len(OPEN)
    sheet = Image.new("RGBA", (cell_w * len(SPRITE_POSES), cell_h))
    for i, name in enumerate(SPRITE_POSES):
        rows = poses[name]
        assert all(set(row[:x0] + row[x1:]) <= {"."} for row in rows), name
        for r, row in enumerate(rows):
            for c, ch in enumerate(row[x0:x1]):
                if ch != ".":
                    sheet.putpixel((i * cell_w + c, r), HIPPO[ch] + (255,))
    sheet.save(dest, optimize=True)
    return cell_w, cell_h


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", type=Path, help="also write looping 6x previews here")
    args = parser.parse_args()

    verify_icon_pose()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    box = None
    meta = {}
    for name, theme in THEMES.items():
        frames = timeline(theme)
        box = box or bounds(frames)
        for scale, suffix in ((1, ""), (4, "@4x")):
            write_gif(frames, box, scale, OUT_DIR / f"hama-boot-{name}{suffix}.gif")
            to_rgba(frames[-1][0], box, scale).save(
                OUT_DIR / f"hama-boot-{name}-still{suffix}.png", optimize=True)
        if args.preview:
            args.preview.mkdir(parents=True, exist_ok=True)
            write_gif(frames, box, 6, args.preview / f"hama-boot-{name}-preview.gif",
                      bg=theme["canvas"], loop=True, hold=1600)
        meta = {
            "width": box[2] - box[0],
            "height": box[3] - box[1],
            "frames": [{"ms": ms, "beat": beat} for _, ms, beat in frames],
            "durationMs": sum(ms for _, ms, _ in frames),
        }
    meta["sprites"] = dict(zip(("cellWidth", "cellHeight"), write_sprites(OUT_DIR / "hama-sprites.png")))
    meta["sprites"]["poses"] = list(SPRITE_POSES)
    (OUT_DIR / "hama-boot-timeline.json").write_text(json.dumps(meta, indent=2) + "\n")
    STUDIO_BOOT.mkdir(parents=True, exist_ok=True)
    for name in THEMES:
        for file in (f"hama-boot-{name}.gif", f"hama-boot-{name}-still.png"):
            shutil.copyfile(OUT_DIR / file, STUDIO_BOOT / file)
    shutil.copyfile(OUT_DIR / "hama-sprites.png", STUDIO_BOOT / "hama-sprites.png")
    print(f"{meta['width']}x{meta['height']} px, {len(meta['frames'])} frames, "
          f"{meta['durationMs']} ms -> {OUT_DIR.relative_to(ROOT)}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Regenerate the synthetic HYhwpEQ-named source font for equation tests.

Run from rhwp after generate_shaping_fixture.py:
    python scripts/generate_equation_source_fixture.py
"""

from pathlib import Path

from fontTools.ttLib import TTFont


FONT_DIR = Path(__file__).resolve().parents[1] / "tests/fixtures/fonts"
font = TTFont(FONT_DIR / "RHWPShapingFixture.ttf")

# Reuse only the shaping fixture's rectangular outlines and advances. All extra
# equation-source characters deliberately point to its synthetic A rectangle.
cmap = font.getBestCmap()
cmap.update({ord(char): "A" for char in "0123456789=>ab"})
cmap.update({codepoint: "A" for codepoint in range(0xE000, 0xE100)})
for table in font["cmap"].tables:
    table.cmap = cmap

for name_id, value in ((1, "HYhwpEQ"), (4, "HYhwpEQ Regular"), (6, "HYhwpEQ-Regular")):
    for platform, encoding, language in ((1, 0, 0), (3, 1, 1033)):
        font["name"].setName(value, name_id, platform, encoding, language)

# Keep the original fixture's fixed timestamp so regeneration is byte-stable.
font["head"].modified = 3873843102
font.recalcTimestamp = False
font.save(FONT_DIR / "HYhwpEQSourceFixture.ttf")

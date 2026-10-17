#!/usr/bin/env python3
"""Generate the WOFF/WOFF2 desktop font fixtures in tests/fixtures/fonts.

WOFF2 needs the brotli module. Run without touching the global Python:
  uv run --no-project --with fonttools --with brotli python rhwp/scripts/generate_web_font_fixtures.py
"""

from __future__ import annotations

from io import BytesIO
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont, woff2
from fontTools.ttLib.tables import ttProgram
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphComponent

RHWP = Path(__file__).resolve().parents[1]
OUTPUT = RHWP.parent / "tests" / "fixtures" / "fonts"
NOTO = RHWP / "ttfs" / "opensource" / "NotoSansKR-Regular.ttf"
VARIABLE = RHWP / "tests" / "fixtures" / "fonts" / "RHWPVariableWeightFixture.ttf"
TEXT = "AÅaéQ 019 가각한글"
# PUSHB[0] 1, POP: 실행해도 아무 일도 하지 않는 명령
NOOP_PROGRAM = bytes([0xB0, 0x01, 0x21])
# hmtx 변환은 모든 lsb 가 xMin 과 같을 때만 쓸 수 있다.
TRANSFORM = {"glyf", "loca", "hmtx"}


def subset_noto() -> bytes:
    options = subset.Options()
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.layout_features = []
    options.hinting = True
    options.notdef_outline = True
    options.drop_tables += ["BASE", "STAT", "vhea", "vmtx", "GDEF", "GPOS", "GSUB"]
    font = TTFont(NOTO)
    subsetter = subset.Subsetter(options)
    subsetter.populate(text=TEXT)
    subsetter.subset(font)
    add_composite_and_instructions(font)
    font["head"].flags |= 1 << 1  # lsb == xMin: hmtx 변환 가능
    out = BytesIO()
    font.save(out, reorderTables=True)
    return out.getvalue()


def program(code: bytes) -> ttProgram.Program:
    result = ttProgram.Program()
    result.fromBytecode(code)
    return result


def add_composite_and_instructions(font: TTFont) -> None:
    """WOFF2 glyf 변환의 합성 글리프·명령 스트림 경로도 지나도록 é 를 a + 축소한 A 의 합성으로 바꾼다."""
    glyf = font["glyf"]
    base = GlyphComponent()
    base.glyphName, base.x, base.y, base.flags = "a", 0, 0, 0x0204  # ROUND_XY_TO_GRID | USE_MY_METRICS
    accent = GlyphComponent()
    accent.glyphName, accent.x, accent.y, accent.flags = "A", 150, 600, 0
    accent.transform = [[0.5, 0], [0, 0.25]]  # WE_HAVE_AN_X_AND_Y_SCALE
    composite = Glyph()
    composite.numberOfContours = -1
    composite.components = [base, accent]
    composite.program = program(NOOP_PROGRAM)
    glyf["eacute"] = composite
    glyf["A"].program = program(NOOP_PROGRAM)
    glyf.compile(font)
    for name in ("eacute",):
        glyph = glyf[name]
        glyph.recalcBounds(glyf)
        font["hmtx"][name] = (font["hmtx"][name][0], glyph.xMin)
    font["maxp"].recalc(font)


def write_flavor(source: bytes, path: Path, flavor: str) -> None:
    if flavor == "woff2":
        out = BytesIO()
        woff2.compress(BytesIO(source), out, transform_tables=TRANSFORM)
        path.write_bytes(out.getvalue())
        return
    font = TTFont(BytesIO(source))
    font.flavor = flavor
    font.save(path, reorderTables=False)


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    noto = subset_noto()
    (OUTPUT / "NotoSansKRWebFixture.ttf").write_bytes(noto)
    write_flavor(noto, OUTPUT / "NotoSansKRWebFixture.woff", "woff")
    write_flavor(noto, OUTPUT / "NotoSansKRWebFixture.woff2", "woff2")
    write_flavor(VARIABLE.read_bytes(), OUTPUT / "RHWPVariableWeightFixture.woff2", "woff2")
    for path in sorted(OUTPUT.glob("*.woff*")) + [OUTPUT / "NotoSansKRWebFixture.ttf"]:
        print(f"{path.relative_to(RHWP.parent)} {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()

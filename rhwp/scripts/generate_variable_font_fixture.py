#!/usr/bin/env python3
"""Generate the deterministic variable-weight fixture (wght 100-900, named instances)."""

from __future__ import annotations

import sys
from io import BytesIO
from pathlib import Path

from fontTools.designspaceLib import AxisDescriptor, DesignSpaceDocument, InstanceDescriptor, SourceDescriptor
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools import varLib


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "tests" / "fixtures" / "fonts" / "RHWPVariableWeightFixture.ttf"
FAMILY = "RHWP Variable Fixture"
GLYPHS = [".notdef", "A", "gaHangul"]
CMAP = {0x41: "A", 0xAC00: "gaHangul"}
# 굵기마다 advance 가 달라야 인스턴스 좌표가 레이아웃에 반영되는지 확인할 수 있다.
MASTERS = {100: {"A": 400, "gaHangul": 900}, 400: {"A": 500, "gaHangul": 1000}, 900: {"A": 700, "gaHangul": 1200}}
INSTANCES = [("Thin", 100), ("Regular", 400), ("SemiBold", 600), ("Bold", 700), ("Black", 900)]


def box(width: int, stem: int) -> object:
    pen = TTGlyphPen(None)
    pen.moveTo((50, 0))
    pen.lineTo((50 + stem, 0))
    pen.lineTo((50 + stem, 700))
    pen.lineTo((50, 700))
    pen.closePath()
    pen.moveTo((width - 50 - stem, 0))
    pen.lineTo((width - 50, 0))
    pen.lineTo((width - 50, 700))
    pen.lineTo((width - 50 - stem, 700))
    pen.closePath()
    return pen.glyph()


def master(weight: int) -> TTFont:
    advances = {".notdef": 500, **MASTERS[weight]}
    stem = 20 + weight // 10
    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder(GLYPHS)
    builder.setupCharacterMap(CMAP)
    builder.setupGlyf({name: box(advances[name], stem) for name in GLYPHS})
    builder.setupHorizontalMetrics({name: (advances[name], 50) for name in GLYPHS})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable(
        {
            "familyName": FAMILY,
            "styleName": "Regular",
            "uniqueFontIdentifier": "RHWPVariableFixture-Regular",
            "fullName": f"{FAMILY} Regular",
            "psName": "RHWPVariableFixture-Regular",
            "version": "Version 1.000",
        }
    )
    builder.setupOS2(usWeightClass=weight, sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.setupMaxp()
    font = builder.font
    font["head"].created = 2082844800
    font["head"].modified = 2082844800
    # 메모리에서 한 번 저장·재로드해야 varLib 가 glyf 를 읽는다.
    buffer = BytesIO()
    font.save(buffer)
    buffer.seek(0)
    return TTFont(buffer)


def main() -> int:
    doc = DesignSpaceDocument()
    axis = AxisDescriptor()
    axis.tag, axis.name, axis.minimum, axis.default, axis.maximum = "wght", "Weight", 100, 400, 900
    doc.addAxis(axis)
    for weight in MASTERS:
        source = SourceDescriptor()
        source.font = master(weight)
        source.location = {"Weight": weight}
        source.familyName = FAMILY
        doc.addSource(source)
    for style, weight in INSTANCES:
        instance = InstanceDescriptor()
        instance.familyName = FAMILY
        instance.styleName = style
        instance.postScriptFontName = f"RHWPVariableFixture-{style}"
        instance.location = {"Weight": weight}
        doc.addInstance(instance)
    font, _, _ = varLib.build(doc, exclude=["STAT", "MVAR"])
    font["head"].created = 2082844800
    font["head"].modified = 2082844800
    font.recalcTimestamp = False
    font.save(OUTPUT)
    print(OUTPUT.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())

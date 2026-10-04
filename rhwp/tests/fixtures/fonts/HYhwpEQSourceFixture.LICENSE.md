# HYhwpEQ source fixture

`HYhwpEQSourceFixture.ttf` is original synthetic test data released under this
repository's MIT license. It is derived from `RHWPShapingFixture.ttf`: its
outlines, advances, and OpenType shaping tables are unchanged. Digits, `=`, `>`,
`a`, `b`, and U+E000–U+E0FF map to the same rectangular `A` glyph, and family
names are changed to exercise equation-source font selection. Regenerate it with
`scripts/generate_equation_source_fixture.py` after regenerating the shaping
fixture.

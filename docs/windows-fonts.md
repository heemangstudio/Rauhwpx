# Windows local application fonts

HamaEditor reads locally installed fonts in place to reduce HWP/HWPX font substitutions. It does not download proprietary fonts or redistribute another application's font files.

Windows discovery includes:

- Windows system fonts and the current user's installed fonts.
- Hancom installations under the x64 and x86 Program Files folders, including HFT font-name maps.
- Font folders (`Font`, `Fonts`, `DFonts`, `TTF`, `HFT`) inside applications under Program Files, Common Files and the current user's `AppData/Local/Programs`. This covers layouts such as Microsoft Office's `root/vfs/Fonts`, Adobe Acrobat's `Resource/Font` and LibreOffice's `share/fonts` when present and readable.
- Additional files or folders listed in `RHWP_FONT_PATH`, separated by semicolons on Windows, for custom installation locations.

Application discovery is breadth-first, limited to six directory levels and 20,000 directories. It skips dependency/cache/installer folders and does not follow application junctions. The existing font file, parser and per-face byte limits still apply. Unreadable locations are skipped without elevation; reaching the application directory cap is reported in the font index. Fonts behind protected app stores or activation/download mechanisms may remain unavailable.

Discovered faces use the existing exact-name matching, document-driven byte loading and metadata cache. Hancom mappings retain precedence. Only needed faces are loaded into the editor; discovery does not install fonts system-wide. Use a font only as permitted by its license. Missing fonts can still require substitution, and finding more local fonts does not establish Hancom layout parity.

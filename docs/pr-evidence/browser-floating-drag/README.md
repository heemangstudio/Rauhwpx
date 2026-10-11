# Floating browser drag recovery

The live verification tools connected Puppeteer to Electron without `defaultViewport: null`. That applied an 800 × 600 emulated viewport to the running editor, while the actual content window was 1374 × 861. The floating browser's viewport clamp then used the wrong bounds. A 476-pixel-high preview stopped at y=124 instead of following the pointer down.

Cleared the editor's device-metrics override and corrected all six existing `/tmp/rhwp-*` Puppeteer live-check tools to connect with `defaultViewport: null`. Future live checks must preserve the user's actual window dimensions. Apply `Emulation.clearDeviceMetricsOverride` only to the editor target when repairing a previous verification override; never treat a user's running app as a fixed-size fixture.

## Live verification

Runtime: `Rauhwpx-pr475`, Studio `http://127.0.0.1:7745/`, Electron CDP 9475, `adsf.hwpx`.

- Actual mouse dragging before repair stopped at y=124 despite an additional 180-pixel downward movement; the drag check failed.
- After repair, repeated the user's downward drag with both the school sidebar page and Muxy floating preview open. The preview moved from y=164 to y=344, then could immediately be dragged up to y=204. Pointer gestures finished normally.
- Confirmed the editor's viewport matches the actual window: 1374 × 861.
- Restored the floating preview to its original observed position, x=385/y=164, and removed all 10 temporary pointer probe listeners.
- No application implementation change or browser restart was needed. The existing drag behavior works with the actual window geometry; both open browser views were preserved.

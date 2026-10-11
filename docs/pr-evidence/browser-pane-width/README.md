# Full-screen browser pane width

The workbench now remembers the selected pixel width instead of deriving its limit from a viewport percentage. It defaults to 560 px and supports resizing up to 1,120 px while reserving 360 px for the conversation and space for the visible thread rail. A temporarily smaller window does not overwrite the saved preference, including when opening the app or switching documents.

At 960 px or narrower, the browser uses a compact overlay capped at 560 px. It leaves a 24 px gutter when the window is narrower than that. Pointer and keyboard resizing are disabled there and restored when the window grows. Website zoom affects the page content independently.

## Verification

- `npm run test:sidebar -- browser-workbench`: passed using fixture-backed services. The existing production-UI check now exercises divider resizing, stable width across window changes, fitting constraints, disabled compact gestures, saved preferences, and restored keyboard resizing.
- `npm run build:sidebar`: passed.
- Studio `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- Running Electron at `http://127.0.0.1:7745/`, with `adsf.hwpx`: dispatched the divider's production pointer handlers, changed its renderer viewport through CDP, and read actual layout bounds. A selected 640 px pane stayed at 640 px in 1,710 and 1,280 px viewports, shrank to 620 px at 980 px, used a fixed 560 px compact overlay at 840 and 700 px, and fit to 366 px at 390 px. The saved preference stayed 640 px throughout and was restored at 1,710 px. The live website zoom button changed from 90% to 100% while the pane remained 640 px.

After the requested quit and relaunch, the fresh Electron process reopened `adsf.hwpx` and retained the saved width. Native macOS window resizing was then verified through accessibility: the current 836 px preference stayed 836 px at 1,440 and 1,280 px, used a non-resizable 560 px overlay at 900 px, and returned to 836 px when widened. The saved preference remained unchanged. The original native window frame was restored afterward. The earlier renderer viewport emulation was cleared; fixture checks used real pointer input in headless Chrome.

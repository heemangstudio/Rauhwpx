# Full-screen browser pane width

Raised the shared right-hand workbench resize limit from 45% to two-thirds of the window width. The existing divider, keyboard resizing, saved width, and viewport reclamping use the same limit.

Verified through the divider's pointer drag in the running `Rauhwpx-pr475` Electron build at `http://127.0.0.1:7745/`, with `adsf.hwpx`. Dragging beyond the limit produced a 1,140 px saved width in a 1,710 px viewport. The browser content pane measured 1,139 px after its border, and pointer release cleared the resizing state. The change loaded through Vite's renderer reload.

`npm run test:sidebar -- browser-workbench` passed with fixture-backed services. Updated that existing check to follow the current auto-opening launcher and target the visible floating browser rather than a hidden presentation. `npm run build:sidebar` and `git diff --check` passed.

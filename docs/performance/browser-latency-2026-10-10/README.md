# Browser input latency

Measured in real Electron, Studio and its authenticated hub on this Mac, using an isolated browser profile and a local website fixture. No provider turn or external account was involved.

| Display path | Median click latency | Screenshots during eight clicks |
| --- | ---: | ---: |
| Previous screenshot path | 700.8 ms | 9 |
| Updated screenshot fallback | 100.1 ms | 9 |
| Native Electron view | 32.7 ms | 0 |

The native result is about 21 times faster for this fixture. It measures a CDP click through acknowledgment after two browser animation frames. The screenshot results measure the click through the changed pixel in the displayed JPEG. These numbers measure local interaction and display latency; they do not measure website/network load times or physical monitor scanout. The baseline uses the production pointer handlers with synthetic pointer events; the updated fallback uses renderer CDP mouse clicks. Both exercise the same ordered hub input and screenshot display path.

Electron now chooses its native WebContentsView by default. Explicitly saved managed-browser preferences remain honored. Live native browsing no longer polls screenshots, while starting an annotation still captures one masked frame. Human control is synchronized when opening or recovering a native tab. Moving a view updates its bounds without removing and reattaching it, and unchanged viewports avoid redundant CDP commands. Fallback input refreshes the displayed frame as soon as the input finishes and polls more often while input is active.

The native benchmark also verified text entry, Korean IME composition/commit, scrolling, annotation capture/cancellation, and retention of typed text. The native guest suite verified focused typing after movement, docking/floating/popout transitions, hidden capture, hub restart, native default startup, recovery into a new editor session, and input isolation. Runtime and security tests passed 26 cases without skips. Studio controller tests passed five cases and TypeScript checking passed.

Run against a Studio dev server:

```sh
cd rhwp/rhwp-studio
VITE_URL=http://127.0.0.1:7745 RHWP_BROWSER_LATENCY_OUTPUT=/tmp/browser-native.json node bench/browser-human-latency.mjs
VITE_URL=http://127.0.0.1:7745 RHWP_BROWSER_LATENCY_OUTPUT=/tmp/browser-managed.json node bench/browser-human-latency.mjs --managed
```

The benchmark launches and removes its own Electron profile. The managed variant needs the pinned Playwright browser installed; `PLAYWRIGHT_BROWSERS_PATH` can reuse an existing installation.

Live preview verification used `http://127.0.0.1:7745` in Electron with its existing profile. The saved active tab recovered into a native docked view with human control; `adsf.hwpx` reopened with no dirty state or running provider turn, and no renderer errors were observed. The physical-input harness prepares a native backing surface before focusing it. The benchmark uses CDP input; first input from the user’s physical keyboard/mouse after cold startup remains a manual check.

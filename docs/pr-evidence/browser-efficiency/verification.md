# Browser frame memory and idle capture

## Changes

The Studio controller keeps the selected tab's screenshot only. Selecting or opening another tab releases the previous base64 frame and ignores its late capture responses. Browser pages, forms, navigation history, and control ownership stay in the runtime. Annotation contexts retain their own pinned frame until the annotation ends.

The fallback screenshot view stops polling while Home, an ancestor, or the document hides it. It resumes when the view becomes visible. Clearing a frame also removes the image's data URL so its DOM node cannot retain the previous screenshot.

## Live baseline

Read-only inspection of existing Electron PID 69214 at CDP `127.0.0.1:9475` and Studio `http://127.0.0.1:7745/`, 2026-10-10. No tabs were opened, navigated, closed, frozen, or discarded. The existing workload contained seven Hancom SDK pages, one lib.rs page, and `exam-kor-1p.hwpx` in Studio.

- Electron and its immediate children used 1,441,984 KiB RSS in one sample. This sum includes the main process, GPU, network process, hub, Studio, and guest renderers.
- Hancom guest JS heaps were 13.7–15.3 MB. Studio JS heap was 33.1 MB with 39.0 MB of backing storage.
- Studio had no data-URL images. Native presentation already avoids the screenshot polling loop.
- Five seconds of idle Studio observation produced zero WebSocket frames, zero layouts, 103 style recalculations, 0.0333 seconds of task time, and 0.00377 seconds of script time.
- Several unparented guest pages reported `document.visibilityState === 'visible'`. Four guest renderer processes consumed roughly 1.6–1.9% CPU. Changing page lifecycle would need a separate native investigation because active agent tabs must continue executing.

This change does not establish a native RSS improvement. The baseline identifies guest page memory as the dominant current cost; this patch removes screenshot overhead in the fallback and annotation paths without changing those pages.

## Measured fallback workload

A controller fixture visited eight existing logical tabs and supplied a 400,000-character screenshot for each. There were no page mutations.

| Metric | Base 26ef8931 | Changed |
| --- | ---: | ---: |
| Logical tabs retained | 8 | 8 |
| Screenshot frames retained | 8 | 1 |
| Base64 characters retained | 3,200,000 | 400,000 |
| Close/recover/reconnect actions | 0 | 0 |

Retained screenshot payload fell 87.5%. These are payload retention counts, not process RSS estimates.

The headless Chrome UI fixture hid the browser through Home for 1.6 seconds, longer than two idle capture intervals. Baseline issued two additional frame requests. Changed code issued zero, then resumed capture on return. Switching tabs removed the old image `src` and frame cache while preserving both logical tabs. The fixture substitutes capture responses; it uses the production controller, view, DOM, visibility observer, and timers.

## Checks

Passed 16 focused tests:

```sh
node --experimental-strip-types --test \
  rhwp/rhwp-studio/tests/browser-controller.test.ts \
  rhwp/rhwp-studio/tests/browser-frame-lifetime.browser.test.ts \
  rhwp/rhwp-studio/tests/browser-projection.browser.test.ts
rhwp/rhwp-studio/node_modules/.bin/tsc --noEmit -p rhwp/rhwp-studio/tsconfig.json
git diff --check
```

The new UI behavior test was also run against the baseline view and failed as expected on hidden-page frame polling: actual 3 captures versus expected 1. Existing native projection coverage passed, including hidden-parent detach, retained tab restore, floating bounds, and cancellation of a late attach. Native Electron verification of the integrated change is delegated to the task's final verification owner.

## Native renderer reuse experiment

The existing runtime allocates a renderer for each independently created native guest. A private-profile Electron experiment created eight same-origin localhost pages with independent form drafts and a 10 ms interval plus animation loop. A pristine `about:blank` seed supplied cloned WebContents in the candidate. The seed never loaded a user page, so no user or credential tab was copied. No existing app or profile was changed.

Three fresh-process trials on Electron 44.7.0 gave these medians:

| Metric | Fresh contents | Blank-seed clones |
| --- | ---: | ---: |
| Guest renderer processes | 8 | 1 |
| Process family RSS | 1,003,968 KiB | 400,752 KiB |
| Load eight pages | 623.1 ms | 505.9 ms |
| Cloned tabs incorrectly visible while unparented | 0 | 8 |

The experiment reduced RSS 60.1% and load time 18.8% in this fixture, but the candidate was rejected. Hidden cloned pages continued their animation loops at about 60 frames per second each. Hidden-window parking, `paintWhenInitiallyHidden:false`, view visibility toggles, and explicit `setBackgroundThrottling(true)` before and after loading did not correct this in the tested no-shown-window setup. Electron 43.4.0 had the same issue. Dependency files and native production code were left unchanged.

The clone safety probes confirmed separate form drafts and sessionStorage, empty window name, null opener, preserved sandbox/context isolation/web security, and a separate renderer after redirecting to another origin. Named-target popup attempts were blocked. Cloning a pristine seed avoids the history and storage inheritance risk of copying a user tab.

Reproduction uses [native-seed-probe.cjs](native-seed-probe.cjs), with aggregate results in [native-clone-trials.json](native-clone-trials.json). Run the probe through the selected Electron binary with `RHWP_PROBE_MODE=baseline` or `RHWP_PROBE_MODE=seed` and `ELECTRON_RUN_AS_NODE` unset. It opens no windows, serves only a local fixture, and uses a new temporary profile. The tested 44.7.0 binary was installed only under `/tmp/rauhwpx-electron44-probe`.

Electron's [clone API documentation](https://www.electronjs.org/docs/latest/api/web-contents/#contentsclone) describes related SiteInstance reuse. [43.4.0 source](https://github.com/electron/electron/blob/v43.4.0/shell/browser/api/electron_api_web_contents.cc) unconditionally shows a hidden render host when setting background throttling; [44.7.0 source](https://github.com/electron/electron/blob/v44.7.0/shell/browser/api/electron_api_web_contents.cc) contains conditional visibility handling. The source fix alone did not establish correct visibility for the candidate.

## Native visibility and scoped actions

The installed Playwright 1.64.0 applies `Emulation.setFocusEmulationEnabled(true)` during ordinary CDP attachment. A fresh unparented Electron guest changes from `hidden` with zero animation frames to `visible` with approximately 60 frames/second. Disabling the override restores native hidden visibility. A separate previously shown guest fixture proved both detach orderings already become hidden; reordering native detach was unnecessary.

The native runtime now uses the supported `connectOverCDP({ noDefaults: true, artifactsDir: downloadsPath })` options. The host configures downloads explicitly in its owned transfer directory. Each service operation temporarily acquires a host activity token and releases it in `finally`. Tokens validate runtime generation, target, logical tab, editor session, and chat. Control transfer, navigation, rebinding, disconnect, release and a 30-second expiry clear outstanding tokens. An old completion cannot cancel a newer token. The lifecycle retains native pages, form state and session storage. It does not freeze or discard pages.

Two fresh private-profile Electron 43.4.0 runs each sampled three alternating one-second idle periods on a local CSS-animation/RAF fixture:

| Median per run | Forced-visible override | Native hidden |
| --- | ---: | ---: |
| Renderer CPU, first run | 0.5244% | 0.0196% |
| Renderer CPU, second run | 0.3915% | 0.0143% |
| Animation frames/second | 59–60 | 0 |
| Style recalculations/second | 60–61 | 0 |

Electron's renderer CPU samples decrease about 96.3% in both runs. These are fixture-specific CPU measurements; no native RSS reduction is claimed. Full results are in [native-activity-trials.json](native-activity-trials.json).

The durable real-Electron fixture exercises hidden locator click, success/error cleanup, preserved draft/session/history, an HTTP attachment download read from the controlled directory, native visible UI after lease end, control transfer, binding/navigation invalidation, stale completion, disconnect and release. Its brief shown window is labeled `Browser activity fixture`; the remaining checks use a new hidden private profile. Existing native dock/float/popout/reconnect and blob-download coverage also passes. Password actions share the operation scope; their protected native helper verification remains with the credential integration owner.

Checks passed:

```sh
node --test tests/desktop-owned-browser.test.mjs
node --test rhwp/rhwp-agent/tests/owned-browser-runtime.test.mjs
node --test rhwp/rhwp-agent/tests/owned-browser-security.test.mjs
git diff --check
```

The suites report 3 native desktop checks, 15 runtime checks, and 17 security checks. Existing personal pages and the running editor were not changed by these experiments.

## Native password-helper key input integration

The integrated native password helper now owns semantic clicks and key input. A bounded private unplaced-guest probe confirmed its mouse click was trusted and completed under the activity lease. Enter keyDown/keyUp alone returned success but did not activate the focused button. Adding Electron's separate `char` event (`\r`) produced exactly one trusted activation without showing or focusing a window.

Native key input now sends character events for Enter, Space and unmodified printable keys, and releases keyUp in `finally`. Exact Control/Meta+A shortcuts select the focused input or textarea in the validated isolated helper without reading its value. Plain character and Space input remain blocked for password and private fields. Modifier shortcuts receive no additional character event.

The durable native activity fixture now installs the production password helper and verifies trusted hidden click, trusted Enter form submission exactly once, actual select-all followed by replacement input, Shift+Tab, secret character rejection and key release after an injected character-dispatch failure. The activity lease ends and animation frames stop after the failure; forms, session/history and downloads remain covered.

```sh
node --test tests/desktop-owned-browser.test.mjs tests/desktop-browser-passwords.test.mjs tests/desktop-browser-passwords-native.test.mjs
git diff --check
```

All 22 checks passed, including actual native password submit/protected input and the hidden activity fixture. The checks used private fixture profiles and did not alter the live editor or personal browser pages.

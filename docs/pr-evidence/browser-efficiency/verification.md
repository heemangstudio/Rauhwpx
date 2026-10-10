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

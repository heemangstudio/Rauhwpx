# Slice 3 persistence and performance

Status: passed. Runtime: http://127.0.0.1:7700/?engine=heemang. Chrome: Chrome/155.0.8059.86.
Engine 2008f209e97a70bd586644b8b8596ca32ef5274f; WASM SHA-256 412a55db1e1a3f69df7a49c693e008d7e800875427e1ab25de10432be79e6df3. The vendor commit exactly matches read-only Engine main. Browser network response hashes matched this WASM in every document session. No Vite update/full-reload event was observed during either run.

| Document | Pages before/reopen | Lines before/reopen | Changed/added/removed | Max delta, HU | Saved bytes |
| --- | --- | --- | --- | --- | --- |
| exam_math.hwp | 20/20 | 568/568 | 0/0/0 | 0 | 740352 |
| lang_exam.hwp | 15/15 | 1284/1284 | 0/0/0 | 0 | 407040 |
| nikl_plan.hwp | 35/35 | 2159/2159 | 0/0/0 | 0 | 268800 |
| fdi_q1.hwpx | 10/10 | 1605/1605 | 0/0/0 | 0 | 537749 |

Compared every native line and caret stop on every page, with zero tolerance. Raw snapshots preserve all page packets; normalized paint comparison normalizes runtime face/glyph IDs and excludes glyph binary payloads and runtime epochs. It does not prove glyph-outline identity. 100 HU = 1 pt. Full first differences, count changes and per-field maximum deltas are in verification.json.

Each document was opened from an immutable output copy through the file input, formatted through the real character and paragraph menus in body text and a table cell, saved through File > Save with an intercepted writable filesystem handle, and reopened from the exact file written by that handle. Before-save/reopened screenshots are in the gate run folders.

exam_math.hwp: text true, normalized paint true, sampled styles true, reopened bytes true. Cancellation/write-failure checks: cancel passed; failure passed.

lang_exam.hwp: text true, normalized paint true, sampled styles true, reopened bytes true. Cancellation/write-failure checks: cancel passed; failure passed.

nikl_plan.hwp: text true, normalized paint true, sampled styles true, reopened bytes true. Cancellation/write-failure checks: cancel passed; failure passed.

fdi_q1.hwpx: text true, normalized paint true, sampled styles true, reopened bytes true. Cancellation/write-failure checks: cancel passed; failure passed.

Handbook first paint: 1557.0999999642372 ms. Open completion: 1808.5 ms. Pages: 384. WASM at open completion: 121700352 bytes / 116.0625 MiB. JS heap after page visits, screenshots and explicit GC: 55013800 bytes / 52.465248107910156 MiB. Settled WASM after page visits: 121700352 bytes / 116.0625 MiB; after typing: 116.0625 MiB. Cover bitmap paint timing: 1850.5999999642372 ms.

Trusted Chrome keyboard, 36 characters: key-to-paint p50 24.69999998807907 ms, p95 34.30000001192093 ms.
36 trusted Chrome keyboard.press characters at native-hit-tested body text. keyToPaint starts in capture-phase trusted keydown and finishes after rAF + macrotask with rendered contentEpoch >= key epoch+1. Handler latency is not measured: capture-phase microtask timing does not bracket the production mutation handlers. No synthetic input or direct document mutation.

First paint preserves the prior open-document-bytes event to first synchronous Canvas2D paint boundary, viewport 1440x2000 DPR 1, WASM-at-open sampling, screenshots at pages 1/2/last at zoom 0.8, then explicit GC and Runtime.getHeapUsage. Typing uses the earlier 1440x1200 DPR 1 viewport, same 36 characters, and rAF + macrotask/rendered epoch endpoint. It uses trusted keyboard input; prior evidence dispatched synthetic keydown/beforeinput/input/keyup in one task, so handler timing and input delivery are not identical.

Prior handbook evidence: 1148.800000011921 ms first paint, 1603.699999988079 ms open completion, 385 pages, 102.6875 MiB WASM, 52.40935516357422 MiB JS. Prior synthetic typing: paint p50 14.400000035762787 ms / p95 23.600000023841858 ms; handler p50 9.099999964237213 ms / p95 10.099999964237213 ms. Sources are output/heemang-first-paint/verification.json and output/heemang-editing/live/results.json.

- Production source and engine remain read-only. All editing uses Chrome mouse/keyboard and production menus. File-system picker/writable handles are intercepted and write only inside this run.
- Geometry compares every native line on every page exactly in HWP units. No rounding/tolerance. Paint comparison normalizes runtime face/glyph IDs and excludes glyph binary payloads and runtime epochs; raw packets are preserved. It does not prove glyph-outline identity.
- Enter and cross-cell checks are owned by the parent. Native read-only sampling is used to choose clickable text and inspect results.
- First paint follows the prior event-to-first synchronous Canvas2D paint definition, which may precede image decode. Typing uses trusted Chrome keys rather than the prior synthetic input sequence; this delivery difference limits direct comparison.
- Local dev build, headless Chrome, one machine; no CPU throttling. Measurements are observations, not release-build benchmarks.

The refreshed handbook has 384 pages; prior evidence has 385. This run verifies persistence of the four formatted documents and measures handbook performance; it does not establish handbook pagination parity. Screenshots: /Users/pyu/projects/hobbies/Rau/heemang-wt/studio/output/heemang-editing/slice3/2026-10-23T09-07-40-039Z/handbook/studio.png, /Users/pyu/projects/hobbies/Rau/heemang-wt/studio/output/heemang-editing/slice3/2026-10-23T09-07-40-039Z/handbook/page-001.png, /Users/pyu/projects/hobbies/Rau/heemang-wt/studio/output/heemang-editing/slice3/2026-10-23T09-07-40-039Z/handbook/page-002.png, /Users/pyu/projects/hobbies/Rau/heemang-wt/studio/output/heemang-editing/slice3/2026-10-23T09-07-40-039Z/handbook/page-384.png, /Users/pyu/projects/hobbies/Rau/heemang-wt/studio/output/heemang-editing/slice3/2026-10-23T09-07-40-039Z/handbook/after-typing.png.

Original fixture hashes unchanged: true. Vendored engine unchanged during each run: true. No production changes or commits by this verification task.

Gate evidence: output/heemang-editing/slice3/2026-10-23T09-06-11-174Z/results.json
Performance evidence: output/heemang-editing/slice3/2026-10-23T09-07-40-039Z/results.json

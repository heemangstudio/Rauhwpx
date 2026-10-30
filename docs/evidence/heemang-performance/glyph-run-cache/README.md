# Glyph-run path cache

Typing replaces the edited page's decoded packet. The renderer previously rebuilt every glyph run's composite `Path2D`, including unchanged text. An identity cache had zero hits across 4,257 runs because the packet objects changed.

The player now caches complete run geometry across packets. The key includes scale, face, size, ratio, italic skew, baseline, glyph IDs and positions. Existing font/outline cache invalidation clears these paths. The LRU retains at most 256 runs and 4,096 glyphs; larger individual runs bypass it.

## Causal diagnostic

Same real research-report typing scenario, 41 strokes, corrected guide-redraw path:

| Inclusive CPU time across the sequence | Ordinary | Content-cache probe |
| --- | ---: | ---: |
| Run-path composition and lookup | 48.17 ms | 14.78 ms |
| Page canvas paint | 76.45 ms | 41.91 ms |

The runtime probe had 3,285 hits and 972 misses. Its miss builds account for 12.32 ms of the 14.78 ms. Raw profiles and inputs are stored beside this note. A separate formatter ran for about one second during this window; all profile and latency samples here are diagnostic.

## Correctness

- Player tests: 17 passed. The new behavior test failed before caching and now checks packet replacement, geometry changes, zoom, a missing outline followed by font refill, and font-generation invalidation. TypeScript passes.
- Real Studio `http://127.0.0.1:7733/?engine=heemang`, fixture Pi hub, 92-page research report. Production cached paint matches a direct uncached builder on the exact same packet, scale and fonts at all 41 strokes, with zero differing pixels and no page errors.
- The live sequence covers actual font generations 69 through 76. Reopening the original file changes document instance 1 to 2 while generation remains 76; cached and uncached paint still match.
- `correctness.jsonl` and its manifest record the actual source and WASM hashes. The WASM is the lane's temporary `8174d3ba…` build; unrelated native trials are evaluated separately.

Seven-run performance qualification is pending. The corrected typing signal observes the completed bitmap, including async glyph arrival. Earlier revision-painted frame timings are excluded. The six-document final cold-visible and typing p50/p95 gates remain unchanged.

The lane harness command for exact-packet and reopen checks is:

```sh
HV_BASELINE=/private/tmp/heemang-perf-resume/baseline-main \
HV_CANDIDATE_VITE_PORT=7733 \
node rhwp/rhwp-studio/e2e/heemang-verify/cold-open-bench.mjs \
  --mode=typing --docs=report --apps=candidate --runs=1 --warmup=0 --verify-packets
```

# Session and master-page parity

Real baseline Studio and candidate Studio at `http://127.0.0.1:7724/?engine=heemang`, headless Chrome, 2026-10-25. Provider responses use a local fixture; document operations and rendering use the actual engines.

The live scenario types four paragraphs, calls the existing bridge numbering API, reads the painted number glyphs, opens and cancels the number dialog, saves through the UI, and reopens the saved output. Outline and ordinary numbers show `1,7,8`; a plain paragraph numbered after restart shows `7`. Both engines discard this session state on reopening. The candidate also reports the stored override through paragraph properties. Native tests cover undo/redo, checkpoints, malformed requests and both file formats; the merge property view omits the flag.

The synthetic two-page master fixture places `LAST_MASTER_PROBE` only on page two. Baseline and candidate retain that placement after the UI's Save As HWP and Save As HWPX and reopening each output. Native tests additionally edit the body, resave in its own format, export the other format and confirm one master list and two body paragraphs. No page errors were reported. Both servers stopped.

Reproduce with `node rhwp/rhwp-studio/e2e/heemang-verify/session-parity.mjs`. The fixture is `tests/fixtures/heemang-last-page-master.hwpx`. `summary.json` records the live results. The old-engine JSON records were produced by read-only calls against the baseline package. No old engine implementation was copied.

# Browser public tool contracts

The public `browser_type` schema exposed `submit`, but both backends only filled the field. The public `browser_wait` schema exposed conditions and text, but the backend ignored them and returned no snapshot.

`submit: true` now fills and sends trusted Enter through the existing backend input path. Submission retains the action's declared intent and the existing policy checks. Waits return a fresh sanitized snapshot: `ready` uses document readiness, `idle` adds 500 ms without document loading/navigation, `visible` matches a visible semantic element (optionally by non-sensitive name/text), and `text` matches sanitized visible document text. Streaming connections do not delay idle. Text waits require nonempty text.

Wait deadlines include time spent queued and asynchronous reads. Reads that finish after expiry cannot replace a newer hub snapshot. An executing native wait finishes activity cleanup before returning its timeout, so an error cannot leave the hidden tab forced visible.

## Verification

- The new public-argument managed checks failed against the base service: submit produced zero submissions and wait returned no snapshot.
- `node --test rhwp/rhwp-agent/tests/owned-browser-tool-contracts.test.mjs`: three actual managed Chromium checks cover trusted submission, all conditions, persistent streaming, fresh actionable refs, missing text, queue/read deadlines, and late observation rejection.
- `node --test --test-name-pattern='native hidden guests' tests/desktop-owned-browser.test.mjs`: the private Electron fixture uses the real native password helper and public tool arguments. It checks one trusted submission, all wait conditions, protected visible text redaction, protected-string timeout, scoped focus cleanup, form/history preservation, and captured downloads.

These are local fixture-backed runtime checks. No personal browser tab or live application window was changed.

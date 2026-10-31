# Account and pricing preview evidence

Captured on 2026-11-01 from the production UI at `http://127.0.0.1:7715` with local account, checkout, and usage fixtures. Screenshots contain sample account data and perform no real purchases or redemptions.

- `pricing.png`: shared Hama/Rau pricing columns, including the Rau trial and static reduced-motion artwork.
- `inline-confirmation.png`: starting the sample Rau trial leaves the columns visible and replaces its button with a checkmark.
- `account-plan.png`: Rau plan heading and credit summary in the account page.
- `signed-out-account.png`: signing out inside Settings keeps the signup screen in the account tab.

The animated neuron effect is checked separately with normal motion: it stays inside Rau, expands at approximately 10 fps, and dissolves without retracting. Repeated clicks replace the active animation; reduced motion skips it.

Real Electron at `http://127.0.0.1:7700` was also used to verify the account/compose control alignment and promotion-code input. A successful production gift-code redemption with a complete issued code was not verified; desktop-to-server routing, normalization, entitlement updates, idempotency, and server rejection cases are covered by the focused tests.

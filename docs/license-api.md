# Desktop license gate

The key server lives in `site-api/` (subscriptions since #541). HamaEditor sells as a yearly subscription, 연 ₩9,900 (VAT included), renewed automatically through Groble and cancellable at any time, with two devices per key. Keys sold before the subscription, beta keys and manual keys stay lifetime keys. Development runs are unenforced unless `HAMA_LICENSE_GATE=on`.

## Production public key

`desktop/license-lease.mjs` pins `PRODUCTION_LICENSE_PUBLIC_KEYS['hama-prod-1']` to `UH46oBHmV639T/ubZNdW+S3q6EywftOp3zZVfuzEVtM=`, the raw 32-byte Ed25519 public key in base64 that the production server returns as `rawBase64` from `GET /v1/license/public-key`. The private half stays on the server. Tests and the mock server generate their own key pair in memory.

`hama-prod-1` is the signing-key ID in the server's lease and public-key response. Activation compares the endpoint's key and ID with the pin; it never downloads a new trusted key. Rotating the key means adding a new `kid` here and shipping a new build.

## API contract

Default origin: `https://rau-credits-production.up.railway.app`.

| Request | Response |
| --- | --- |
| `GET /v1/license/public-key` | `{alg:"Ed25519", kid, rawBase64, spkiDerBase64}` |
| `POST /v1/license/activate {key,deviceId,appVersion,platform}` | `{ok:true,lease,keyId,tier,expiresAt,licenseExpiresAt,autoRenew,devicesUsed,deviceLimit}` |
| `POST /v1/license/validate {key,deviceId}` | Same lease response |
| `POST /v1/license/deactivate {key,deviceId}` | `{ok:true,removed,tier,devicesUsed,deviceLimit}` |
| `POST /v1/license/grandfather {installId}` | `{ok:true,key,created}` |

`tier` is `paid` or `beta`. Beta-tester keys allow their own device count and get three-day leases; the app stores the tier for display only (title and revoked message), and a state file without it reads as `paid`.

Errors are `{ok:false,error}`: `invalid_key` 404, `revoked` 403 (with `tier`), `expired` 403 (an annual key past its end, with `tier` and `licenseExpiresAt`), `device_limit` 409, `not_activated` 404, `device_id_invalid` 400, `server_not_configured` 503. Grandfather errors include `grandfather_disabled` 403, `not_eligible` 403 and `install_id_invalid` 400. Network and server failures preserve a still-valid signed lease. Revocation immediately removes editing rights after the next successful check.

Keys have five groups of five Crockford base32 characters after `HAMA-`. Normalization matches the server: remove spaces and hyphens, uppercase, accept a missing prefix, map O to 0 and I/L to 1, validate the alphabet, then regroup.

A lease is `base64url(JSON bytes).base64url(Ed25519 signature over the ASCII bytes of the first segment)`. Payload: `{v:1,kid,keyId,keyHash,deviceId,issuedAt,expiresAt[,licenseExpiresAt]}`. Times are epoch milliseconds. `keyHash` is SHA-256 of the submitted key after uppercase and whitespace removal; the client submits and stores the canonical key above. The client checks signature, version, signing-key ID, device, license ID, key hash, timestamps and a maximum seven-day lifetime. This matches PR #490's updated contract at `7440d09c` and `/workspace/hamaeditor/license-api-contract.md`.


Grandfathering uses the existing `unique-install.json` install ID. Eligibility and cutoff are decided by the server's recorded first-seen time and platform. The client cannot grant eligibility itself. Eligible keys then go through the same pinned-key activation and two-device limit. Failed eligibility requests leave the trial unchanged and retry at launch or after 24 hours.

## Annual keys

Keys bought through the Groble 정기결제 product end at `licenseExpiresAt` (epoch ms, the end of the KST anniversary day) and renew on the server; lifetime keys have none. The server signs `licenseExpiresAt` into the lease, so the app enforces it offline, and also returns it with `autoRenew` for display. Lifetime leases are byte-for-byte what older builds expect.

- Before the end date the app works as with a lifetime key, and settings and the activation window show `다음 갱신 <date>` (or `<date>까지` once auto-renewal is off).
- Past the end date the app rechecks every hour (`EXPIRED_RECHECK_MS`). When the server answers `expired`, the app goes read-only at once (state `expired`, the same viewer mode as an ended trial, with the same one-time lock save). A renewal on the server unlocks it at the next recheck or `지금 확인`.
- When the server cannot be reached, the app keeps working for `SUBSCRIPTION_OFFLINE_GRACE_MS` (7 days) past the end date, or until the held lease ends, whichever is first, and settings say the renewal needs checking. The server never signs a lease for a key past its end date, so the grace is bounded by the last lease too.
- **Failed renewal payment:** the server adds `licenseState: 'payment_failed'`, `paymentGraceEndsAt` (also signed into the lease) and `paymentFixUrl` (default `https://groble.im/manage/purchase`, Groble's buyer 주문조회; the app only opens `https://groble.im/` or `https://www.groble.im/` pages). Until `paymentGraceEndsAt` the key stays fully editable even past its end date. A non-blocking card titled **키 만료, 연장할까요?** sits bottom-right with `결제 수단 바꾸기`; settings and the activation window show the same title and button. Closing the card hides it for that window until the next launch.
- Once the key fully lapses (state `expired`), the viewer screen shows the same card with `Groble에서 연장하기` and `새로 구매하기`, and the activation window adds `Groble에서 연장하기 · 연장했나요? 지금 확인`.
- Older builds see `expired` as a server error and keep their lease, which ends at most 7 days later. They ignore the payment-failed fields.

## Trial and read-only behavior

`userData/license.json` holds the device UUID, trial start, monotonic last-seen time and signed lease. The trial gives full access for 72 hours (3 days) from the first launch on a device. Saves are not counted, and a `saves` field left by older builds is ignored. Deactivating a license ends the remaining trial on that device. The ordinary HWP/HWPX/HML save and the portable `.rhwpx` archive save each check the gate before one native write, and the main process serializes the check and write across windows.

When the trial runs out, each window locks editing and saves its edited documents without dialogs before going read-only. It starts five seconds before the deadline; the main process accepts any write it received before the deadline, even if the queue runs it later. Every edited document first goes to recovery storage. Documents with a file are then overwritten in place; untitled documents, version-history archives, documents waiting on agent-edit review and managed worktrees stay in recovery storage only. If the window was asleep across the deadline, it asks `license:begin-expiry-save` once on wake. The main process grants a one-minute window, persisted in `license.json` so a relaunch cannot reopen it, and accepts flagged writes only from the window that asked. A toast reports documents that could not be kept. The same save runs when a running window goes from editable to revoked, lease-expired or needs-activation; the main process grants that lock one in-memory grace window, so a restart or the same lock cannot reopen it. While the license is read-only, closing a window or quitting keeps edited documents in recovery storage and closes without a save prompt, and opening another document in a window with unsaved edits keeps that document in the background instead of asking to save. Recovery snapshots and version storage do not call that IPC.

Studio starts locked until it receives desktop status. Expiry disables typing, editing commands, history mutations and agent document writes. A pill to the left of the menu bar's command search shows the live trial countdown (`체험 2일 13시간 남음`, then `13시간 42분`, then a per-second `42분 15초` in the last hour) or the read-only state; clicking it opens activation. It repaints on each displayed minute (each second in the last hour) and when the window becomes visible again, and it is removed once a license is active. Document-specific read-only restrictions remain after activation. Native writes also check the gate, and a `LICENSE_READ_ONLY` rejection opens activation and produces a readable toast instead of a generic save-error alert.

Validation runs on every launch and every 24 hours. A one-minute wake-up timer refreshes time-based read-only state after trial or lease expiry. Offline use ends at the signed lease's expiry, at most seven days after issuance. Settings provides key entry, status, validation and device deactivation. The trial file is local and deleting it resets the trial; this is not a tamper-resistant entitlement store.

## Local verification

Use Node 22. Run `npm run setup`, `npm run build:wasm`, `npm run test:desktop`, `npm run test:ci`, Studio `tsc --noEmit`, `npm --prefix rhwp/rhwp-studio test`, and `npm --prefix rhwp/rhwp-studio run lint:css-tokens`.

For a local Electron run, start `node tests/fixtures/license-mock-server.mjs`. It generates an ephemeral Ed25519 keypair in memory and prints a test license and `HAMA_LICENSE_DEV_PUBLIC_KEY=hama-prod-1:<raw base64>`. Start Studio, then run Electron with `HAMA_LICENSE_GATE=on`, `HAMA_LICENSE_API_BASE=http://127.0.0.1:8787` and that public-key override. Add `HAMA_LICENSE_DEV_TRIAL_MS=<ms>` to shorten the trial and `RHWP_DESKTOP_USER_DATA=<dir>` to use a throwaway profile. Packaged builds ignore the API, public-key and trial-length overrides. No fixture private key is stored in the source tree.

Before launch, verify on a Mac: initial trial, repeated edited saves including a history archive, reopen output, 72-hour expiry, activation, offline grace, refund revocation, device limit, offline deactivation failure and successful deactivation. Verify the signed/notarized build separately. This draft does not build a release, notarize, upload or deploy anything.

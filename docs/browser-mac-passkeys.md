# macOS website passkeys

Research and runtime checks recorded on 2026-10-10.

## Supported routes

Existing Mac passkeys use the installed, signed Google Chrome browser. Browser settings requests `sign-in` with `authenticationMethod: 'mac-passkey'`. The website starts its WebAuthn request and macOS handles account selection and user verification. The app owns a separate `browser/chrome-profile` directory; it never opens the user's normal Chrome profile. During sign-in this Chrome process has no debugging port. After the user confirms completion, the managed browser reopens the same signed executable and profile to retain the authenticated website session.

Chrome supports iCloud Keychain passkeys on macOS 13.5 and later. The operating system may ask the user to allow Chrome access to Mac passkeys. Chrome controls that prompt. [Chrome's iCloud Keychain support](https://developer.chrome.com/blog/passkeys-on-icloud-keychain)

The runtime verifies Google's signing identity and `com.apple.developer.web-browser.public-key-credential` entitlement before advertising the route. `runtime.passkeys` contains `{ method: 'mac-passkey', provider: 'Google Chrome', supported, reason?, requiresUserVerification: true }`. Executable paths and credential identifiers remain local. The provider selection file stores only `chrome` or `chromium`; executable paths cannot be injected through that file.

## Native Electron support

Electron 43 supports the Touch ID platform authenticator through `app.configureWebAuthn`. Those credentials are bound to the Mac's Secure Enclave and Electron session. They do not expose existing iCloud Keychain website credentials. The app configures this authenticator only when its actual signature includes the dedicated `C8M34MMT8W.com.hataewook.rauhwpx.webauthn` keychain access group. The signed app entitlement file now includes that group. Unsigned developer builds report the signing requirement. [Electron 43.3 WebAuthn documentation](https://raw.githubusercontent.com/electron/electron/v43.3.0/docs/api/app.md)

The owned session handles Electron's `select-webauthn-account` event with a parented native account chooser. The default action cancels. Navigation, tab destruction, renderer failure, owning-window closure, timeout, and disposal cancel a pending choice. A stale editor binding or frame cannot complete it. Account names and credential identifiers are used only in the local chooser; state events contain capability metadata and the relying-party ID. Chromium validates the site's WebAuthn challenge and relying-party rules. [Electron account-selection event](https://raw.githubusercontent.com/electron/electron/v43.3.0/docs/api/session.md)

## Version and entitlement limits

At research time, the latest stable Electron was 44.7.0, and 45.0.0-beta.1 was a prerelease. The stable 44 documentation still exposes only `touchID`. The 45 documentation adds `platformPasskeys` through Apple's AuthenticationServices, with application-identifier, associated-domain, provisioning-profile, and website association requirements. The app keeps its current stable Electron dependency. [Electron 44.7 release](https://github.com/electron/electron/releases/tag/v44.7.0), [Electron 44 WebAuthn documentation](https://raw.githubusercontent.com/electron/electron/v44.7.0/docs/api/app.md), [Electron 45 beta documentation](https://raw.githubusercontent.com/electron/electron/v45.0.0-beta.1/docs/api/app.md)

Apple's managed browser entitlement allows passkey requests for arbitrary relying parties. Requesting it requires an organization account's Account Holder and Apple's review of the app's browser behavior. Adding an entitlement string to a plist does not grant that capability. No managed browser entitlement was added to HamaEditor. The Chrome route uses Chrome's existing approved entitlement. [Apple's browser passkey entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential)

## Verification

- `node --test tests/desktop-browser-webauthn.test.mjs`: 5 passed. The native Electron fixture created two local CDP virtual credentials, received the real account-selection session event, cancelled with `NotAllowedError`, and rejected an unrelated relying-party ID with `SecurityError`. No personal passkey or biometric prompt was used.
- `RHWP_TEST_MAC_PASSKEY_HANDOFF=1 node --test rhwp/rhwp-agent/tests/browser-mac-passkeys.test.mjs`: 4 passed. Real signed Chrome opened a localhost fixture without debugging, retained its HttpOnly session cookie through normal process shutdown, and reopened the same private profile under managed control. The authenticated fixture page and exported session state contained the cookie. The test removed its temporary profile.
- `node --test rhwp/rhwp-agent/tests/owned-browser-runtime.test.mjs`: 15 passed, including existing managed-session, checkpoint, native reconnect, and navigation cases.

The controlled checks establish native WebAuthn handling and authenticated Chrome profile reuse. A website login with the user's existing Mac passkey still needs a human to choose and verify the credential through Chrome's system prompt after the integrated UI is running.

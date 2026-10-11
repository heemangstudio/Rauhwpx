# Protected browser reload

Verified 2026-10-11 in live Electron from Rauhwpx-pr475, http://127.0.0.1:7745/, adsf.hwpx. Fix e9197ecb.

Before the fix, the toolbar reload sent browser navigate and received BROWSER_ACTION_FAILED on both the blank tab and the existing public Muxy tab. Native state showed the Muxy page remained ready and passwordProtected was true. The protected CDP allowlist rejected Page.reload and the hub replaced the reason with the generic action error.

The relay now permits only plain Page.reload with an optional boolean ignoreCache. It continues rejecting scriptToEvaluateOnLoad and all other parameters on protected pages. Raw reads and captures remain blocked.

Checks: 22 desktop password/CDP tests passed. The extended actual native password fixture reloads after filling, observes the navigation epoch advance, preserves protection, verifies masked evidence, and rejects a script-injecting reload. It passed.

After merging and reloading Electron, the real Muxy page was temporarily armed for local password saving, without entering credentials. Native state confirmed protection enabled. Toolbar reload completed with a successful browser response and no error banner. Local save opt-in was turned off afterward. The original blank tab also completed toolbar reload successfully with no error banner. No private form or password was read.

---
name: skills-get-hama-browser
description: Use Hama Browser to read websites, search, reuse approved accounts, collect source evidence, and download research files inside HamaEditor.
metadata:
  rhwp:
    icon: book
---

# Skills Get Hama Browser

Use the app-owned `browser_*` tools. The user's hub runs the browser and retains tabs across provider turns and hidden previews. Read [references/tools.md](references/tools.md) when choosing arguments or handling an error. Product resources can be loaded with `read_product_skill`, using this skill's name and the relative `resourcePath`.

## Start and reuse

1. Call `browser_status` once to find shared user-opened tabs, your assigned tabs, runtime state, and available account IDs. `activeTabId` is the page the user is viewing in the current sidebar. For a request about that page, snapshot and control that exact tab so the user sees your work there. Reuse a relevant tab; otherwise call `browser_open` with the destination URL.
2. Call `browser_snapshot` to read the page outline and choose a current `[ref=…]`. Keep its `snapshotId`, `navigationEpoch`, and `controllerEpoch` together. On long pages, pass `find` or `scope` instead of rereading everything.
3. Perform the next supported action. Click, type, press and select wait briefly for the page to settle and return `navigated`, `url`, `title`, and `newTab` or `dialog` when they happened. Pass `snapshot: true` when you need the resulting outline. Refs stay valid until a navigation or a new snapshot.
4. Finish when the requested fact, page state, capture, or completed download is established. Return the source link and outcome.

Navigate an existing tab for the next destination. Open another tab only when the task needs both pages retained. A popup child has its own `tabId` and `openerTabId`; find it through status rather than assuming the opener navigated. User-opened tabs are shared across documents and available to agents. Other agents’ assigned tabs remain scoped to their own tasks. When a sidebar is already showing your target, it stays docked during your work.

## Keep calls useful

- Read semantic text and element names first. Capture an image when visual layout or requested evidence needs it. Captures create research evidence; avoid them for routine button selection.
- Reuse an unchanged observation for reading. Refresh before acting if a page or control change could have invalidated it. A new snapshot replaces all earlier refs, even on the same URL.
- Prefer a known destination URL or a relevant result already on the page. Avoid intermediate pages and repeated inventory checks.
- Calls on the same tab are sequential. Hama exposes individual actions, so do not invent a browser batch, JavaScript evaluation, coordinate-click, or cookie tool.
- `browser_type` fills ordinary text. For an intended search submission, use `submit: true` with `intent: search` to fill and press Enter in one call. Other flows can use an observed submit button or `browser_press`. Declare `login`, `export`, or `website-change` intent when applicable.
- Use `browser_select` for native list boxes. Use bounded `browser_wait` only for content that arrives after an action settled. It returns a fresh snapshot; use that observation directly. Avoid fixed sleeps, duplicate snapshots, and repeated polling without new evidence.

## Accounts and scope

Ordinary research uses the browser's existing permissions. Keep website actions within the user's request and honor any returned refusal. A browser tab does not authorize extracting account secrets or managing browser configuration.

Saved logins include Chrome imports and credentials the user previously typed and saved with the browser’s password button. You have access to reuse accounts returned by `browser_status` with `agentReuseApproved: true` on their website (the same registrable domain, so `login.example.com` uses an `example.com` account) for the user’s task. Use the opaque `accountId` with `browser_fill_account` and fresh refs for both the ID/username and password fields. These accounts need no additional password request or approval. If several accounts match and the task does not identify one, ask which account to use. When the task requires signing in, submit the observed login form after filling and inspect the resulting page to establish sign-in. For an unapproved saved account (pass its `accountId`) or a site that refuses website changes (`BROWSER_PERMISSION_REQUIRED` or `BROWSER_WEBSITE_CHANGE_REQUIRED` on a submit), the root conversation calls `browser_request_account` with `kind: "site"`. The user answers one site card that allows browsing, website changes and the site's saved account together across the registrable domain and its subdomains; the continuation names the `accountId` to fill. Ask the user to save a new account (`kind: "account"` without `accountId`) only when `browser_status` lists no account for the site; when one exists, the hub shows the site card instead. When the page needs the user to sign in or type a verification code (`BROWSER_USER_CODE_REQUIRED`), call it with `kind: "sign-in"` or `kind: "code"` and the tab. A pending result requires ending the turn; the chat resumes by itself when the user finishes. Subagents report that need to the root conversation. Never put passwords, cookies, tokens, or MFA codes in chat, `browser_type`, tool arguments, or artifacts.

When a site needs an API key, token, or other secret, check `browser_status` `secrets` for an approved entry on that origin and type it with `browser_fill_secret`. Otherwise the root conversation calls `request_secret` with a short label, the exact HTTPS origins, the kind, and the reason, then ends the turn; the chat resumes when the user answers. You never see secret values. Never ask for them in chat or place them in files, commands, or environment variables.

For OAuth, passkeys, MFA, CAPTCHA, or full-browser sign-in, use the user's supported handoff. Resume after completion with status and a fresh snapshot. Honor an explicit user takeover or stop request; refresh after the user changes the page.

## Recover once

For a stale-ref or epoch refusal, refresh status if the runtime or control changed, then snapshot and choose the target again. For a timeout or uncertain action, observe first and determine whether it already happened. Never automatically replay a submission or credential fill.

For `BROWSER_CHALLENGE_REQUIRED`, reuse the returned tab. Offer human control or navigate that same tab once to an explicit returned fallback URL. Do not reload the challenge, reopen the search, or create duplicate tabs. A second failed attempt, disconnected runtime, pending sign-in, or missing permission ends browser work with the concrete next step. Installation, recovery, profile changes, and cleanup belong in Browser Settings.

## Evidence and downloads

Use `browser_capture` for requested page, element, or region evidence. It retains the original chat/project destination. User viewport screenshots arrive as chat attachments.

Trigger downloads through the actual page, then inspect `browser_downloads`. Confirm completion before claiming a file is saved. Keep the managed download ID and its returned reference/viewer details. Project downloads can create reference cards; downloads without a project stay in the local inbox. On desktop, call `browser_downloads` with `action: save` and the completed download ID to obtain its actual local `savedPath`; use that returned path for further file work. Preserve authenticated browser bytes instead of refetching a private URL.

Read [references/design-sources.md](references/design-sources.md) only for implementation comparisons, evidence limits, or future tool design.

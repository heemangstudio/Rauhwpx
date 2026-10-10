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

1. Call `browser_status` once to find your assigned tabs, runtime state, and available account IDs. Reuse a relevant tab; otherwise call `browser_open` with the destination URL.
2. Call `browser_snapshot` to read the page and choose a current element ref. Keep its `snapshotId`, `navigationEpoch`, and `controllerEpoch` together.
3. Perform the next supported action, then take the cheapest observation that answers whether it worked. Use a fresh snapshot after navigation, submission, scrolling, page changes, or user input. Use status to find a new popup tab or inspect runtime changes.
4. Finish when the requested fact, page state, capture, or completed download is established. Return the source link and outcome.

Navigate an existing tab for the next destination. Open another tab only when the task needs both pages retained. A popup child has its own `tabId` and `openerTabId`; find it through status rather than assuming the opener navigated. Each agent uses its own assigned tabs.

## Keep calls useful

- Read semantic text and element names first. Capture an image when visual layout or requested evidence needs it. Captures create research evidence; avoid them for routine button selection.
- Reuse an unchanged observation for reading. Refresh before acting if a page or control change could have invalidated it. A new snapshot replaces all earlier refs, even on the same URL.
- Prefer a known destination URL or a relevant result already on the page. Avoid intermediate pages and repeated inventory checks.
- Calls on the same tab are sequential. Hama exposes individual actions, so do not invent a browser batch, JavaScript evaluation, coordinate-click, or cookie tool.
- `browser_type` fills ordinary text. For an intended search submission, use `submit: true` with `intent: search` to fill and press Enter in one call. Other flows can use an observed submit button or `browser_press`. Declare `login`, `export`, or `website-change` intent when applicable.
- Use bounded `browser_wait` for the needed readiness, idle, visible, or text condition. It returns a fresh snapshot; use that observation directly. Avoid fixed sleeps, duplicate snapshots, and repeated polling without new evidence.

## Accounts and scope

Ordinary research uses the browser's existing permissions. Keep website actions within the user's request and honor any returned refusal. A browser tab does not authorize extracting account secrets or managing browser configuration.

Use an approved opaque `accountId` from status with `browser_fill_account` and current sign-in refs. For a missing account or origin approval, the root conversation calls `browser_request_account`; a pending result requires ending the turn and waiting for the secure form. Subagents report that need to the root conversation. Never put passwords, cookies, tokens, or MFA codes in chat, `browser_type`, tool arguments, or artifacts.

For OAuth, passkeys, MFA, CAPTCHA, or full-browser sign-in, use the user's supported handoff. Resume after completion with status and a fresh snapshot. Honor an explicit user takeover or stop request; refresh after the user changes the page.

## Recover once

For a stale-ref or epoch refusal, refresh status if the runtime or control changed, then snapshot and choose the target again. For a timeout or uncertain action, observe first and determine whether it already happened. Never automatically replay a submission or credential fill.

For `BROWSER_CHALLENGE_REQUIRED`, reuse the returned tab. Offer human control or navigate that same tab once to an explicit returned fallback URL. Do not reload the challenge, reopen the search, or create duplicate tabs. A second failed attempt, disconnected runtime, pending sign-in, or missing permission ends browser work with the concrete next step. Installation, recovery, profile changes, and cleanup belong in Browser Settings.

## Evidence and downloads

Use `browser_capture` for requested page, element, or region evidence. It retains the original chat/project destination. Human browser markings arrive as user attachments; they are not agent annotation tools.

Trigger downloads through the actual page, then inspect `browser_downloads`. Confirm completion before claiming a file is saved. Keep the managed download ID and its returned reference/viewer details. Project downloads can create reference cards; downloads without a project stay in the local inbox. Preserve authenticated browser bytes instead of refetching a private URL.

Read [references/design-sources.md](references/design-sources.md) only for implementation comparisons, evidence limits, or future tool design.

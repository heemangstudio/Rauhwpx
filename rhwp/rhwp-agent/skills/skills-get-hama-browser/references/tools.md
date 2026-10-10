# Hama Browser tools

The live tool definitions are the authority. This guide was checked against `tools.mjs`, `server.mjs`, and `owned-browser-service.mjs` at base commit `171820b3`, with submission and conditional-wait contracts from `95d54b99`, on 2026-10-11. MCP names have the `mcp__rhwp__` prefix where the provider requires it.

## Identity and results

Ordinary successful tab calls return `ok`, `action`, `runtime`, and `tab`, plus their specific result. `completed: true` confirms the operation returned; inspect the page or download to establish the task outcome. Document readiness does not establish that dynamic results, an export, or a save finished.

| Returned value | Use |
| --- | --- |
| `tab.tabId` | Stable assigned-tab identity. Hidden previews and provider turn endings do not close it. |
| `tab.openerTabId` | Identifies a popup's parent. Enumerate status to find the child. |
| `tab.navigationEpoch`, `tab.controllerEpoch` | Latest values required by input, navigation, close, and account fill. Never increment them yourself. |
| `runtime.generation`, `tab.runtimeGeneration` | Detect a runtime replacement. Refresh inventory and snapshot afterward. The public tool schemas do **not** accept a `runtimeGeneration` argument. |
| `snapshot.snapshotId`, `snapshot.elements[].ref` | Current observation and target identity. A new snapshot replaces earlier refs. Navigation, zoom changes, and recovery can invalidate them. |
| `snapshot.url`, `title`, `text`, `selectedText`, `elements`, `truncated` | Read observed content. Elements include `role`, `name`, `text`, `value`, `disabled`, `sensitive`, and `rect`; ordinary snapshot elements do not promise link `href` values. Sensitive values are masked. |

Agent ownership comes from the hub, not tool arguments. A tab ID from another agent is unavailable. The server serializes actions per tab. Never run dependent input calls concurrently.

## Argument groups

`epochs` below means required `navigationEpoch` and `controllerEpoch`, both nonnegative integers. `target` means required `tabId`, `snapshotId`, `ref`, and `epochs`.

`intent` accepts `research`, `search`, `login`, `export`, or `website-change`, and defaults to `research`. It describes the operation; it does not grant a new permission. Optional fields below can be omitted.

| Tool | Arguments | Result and practical use |
| --- | --- | --- |
| `browser_status` | `{}` | `runtime`, scoped `tabs`, `limits`, and available `accounts`. Reuse assigned tabs and inspect approval/readiness metadata. |
| `browser_open` | Optional `url`, `intent` | Creates your tab and returns its descriptor. Omitted URL opens `about:blank`. Runtime starts lazily. |
| `browser_navigate` | `tabId`, `url`, `epochs`; optional `intent` | Navigates the same tab. Snapshot afterward. The public schema has no back/forward/reload direction field. |
| `browser_snapshot` | `tabId` | Returns `snapshot` and current tab state. Replaces refs, so choose actions from this result. |
| `browser_click` | `target`; optional `intent` | Clicks the observed element. Snapshot for the resulting page; status for popup children. |
| `browser_type` | `target`, `text`; optional `intent`, `submit` | Fills ordinary text, maximum 16,000 characters. `submit: true` fills and presses Enter on that validated target. It defaults to false. Use `intent: search` for a search form. |
| `browser_press` | `target`, `key`; optional `intent` | Presses on the observed element. `Enter`, navigation keys, single letters/digits, and select-all are supported. Clipboard/browser-window shortcuts are blocked. |
| `browser_scroll` | `tabId`, `deltaY`, `epochs`; optional `deltaX` | Scroll, then snapshot. Schema permits deltas between -10,000 and 10,000; runtime clamps each delta to -2,000 through 2,000. |
| `browser_wait` | `tabId`; optional `condition`, `text`, `timeoutMs` | Conditions are `ready`, `idle`, `visible`, `text`; default `ready`. Timeout is between 1 and 30,000 ms, default 10,000. Returns a fresh `snapshot` when the predicate succeeds. `text` requires nonempty text. See conditions below. |
| `browser_close` | `tabId`, `epochs` | Explicitly closes your tab. Completed managed downloads survive. Hiding a preview is separate. |
| `browser_capture` | `tabId`; optional `snapshotId`, `ref`, `navigationEpoch`, `region`, `comment` | Page capture by default. Element capture uses current `snapshotId` and `ref`; region uses `{x,y,width,height}` in observed page CSS coordinates. Returns `capture` provenance and an image when available. Capture stays bound to the originating destination. |
| `browser_downloads` | Optional `action`, `downloadId` | `action` is `list`, `cancel`, or `retry`, default `list`. Use a returned ID for cancel/retry. Returns scoped jobs or one job. Importing to another project is a human UI operation, absent from this agent schema. |
| `browser_fill_account` | `tabId`, `accountId`, `snapshotId`, `passwordRef`, `epochs`; optional `usernameRef` | Secure broker fill. `accountId` must be a UUID from status. The broker validates account, origin, field, and current binding. Returns metadata/results, never the password. |
| `browser_request_account` | `tabId`, `origin`, `label`, `reason`; optional `accountId` | Root conversation only. Exact origin approval or secure save/use request. Returns `pending`, `requestId`, `origin`; end the turn and wait. |

URLs must satisfy the browser's network guard. Public HTTPS research is the normal path; workspace preview access needs its configured allowance. Do not substitute raw HTTP requests or another browser to evade a refusal.

Wait conditions use observable page state. `ready` waits for document readiness. `idle` waits for loading/navigation to settle for 500 ms, without requiring network silence. `visible` waits for a visible semantic element, optionally with a non-sensitive name/text containing the supplied `text`. `text` waits for supplied text in sanitized visible document text. Matching uses a case-sensitive substring. The timeout includes queued time and observation work. Treat the returned snapshot as the current observation and avoid another snapshot without a reason.

## Minimal examples

These are individual tool arguments, not an invented batch API. IDs and epochs below are illustrative; replace them with returned values.

Open once, then observe:

```json
{"url":"https://pubmed.ncbi.nlm.nih.gov/","intent":"research"}
```

```json
{"tabId":"tab-returned-by-open"}
```

After snapshot identifies the search input as `e4`, fill and submit with `browser_type`:

```json
{"tabId":"tab-returned-by-open","snapshotId":"snapshot-returned-by-snapshot","ref":"e4","navigationEpoch":1,"controllerEpoch":1,"text":"school sleep duration","submit":true,"intent":"search"}
```

Observe results with a snapshot, or wait for expected text and use its returned snapshot:

```json
{"tabId":"tab-returned-by-open","condition":"text","text":"Search results","timeoutMs":10000}
```

Read the resulting text and choose the next current ref. A navigation or a new snapshot requires new values. If the next destination is a known source URL, navigate the same tab:

```json
{"tabId":"tab-returned-by-open","url":"https://pmc.ncbi.nlm.nih.gov/","navigationEpoch":2,"controllerEpoch":1,"intent":"research"}
```

For a PDF, click its observed download/export control with `intent: export`, then inspect jobs:

```json
{"action":"list"}
```

Use the job's actual terminal status, reference ID, or viewer link. Do not derive a filesystem path from the filename or manufacture a successful card.

## Errors and one recovery

| Signal | Next action |
| --- | --- |
| `BROWSER_STALE_REFERENCE`, `BROWSER_REFERENCE_NOT_FOUND`, `BROWSER_STALE_NAVIGATION`, `BROWSER_STALE_GEOMETRY` | Take one fresh snapshot, re-identify the target, and act only if the task still requires it. |
| `BROWSER_STALE_CONTROL`, `BROWSER_STALE_RUNTIME` | Refresh status and snapshot. Honor the user's current control/stop request. Never reuse a queued action. |
| `BROWSER_ACTION_TIMEOUT`, `BROWSER_ACTION_FAILED`, `BROWSER_ACTION_UNCERTAIN` | Observe once to establish whether input took effect. Replay only a demonstrably unperformed, safe action; never blindly repeat a submission or fill. |
| `BROWSER_WAIT_TEXT_REQUIRED` | Supply nonempty trimmed `text` for a text wait, or choose the condition the task actually needs. |
| `BROWSER_CHALLENGE_REQUIRED`, tab `challenge-required` | Results are unavailable. Keep the returned tab; offer user control or navigate once to its explicit returned fallback. No challenge retries or duplicate search tabs. |
| `BROWSER_RECONNECT_REQUIRED`, tab `disconnected`, `BROWSER_RESET_REQUIRED` | Check status once and report the Settings recovery step. Agent tools do not expose reconnect/reset. |
| `BROWSER_SIGN_IN_ACTIVE` | Wait for the user's full-browser sign-in and account confirmation. Status is allowed; do not poll repeatedly or open another profile owner. |
| Account/permission refusal, `BROWSER_SECRET_CHANNEL_REQUIRED` | Use the root secure-account request when applicable; otherwise report the actual refusal. A pending request is not a grant. |
| `BROWSER_TAB_LIMIT` | Reuse a relevant tab or close an unused assigned tab with current epochs. |
| Capture `screenshotError` | Keep returned text/comment/provenance and state that the image failed. Password-protected pages can refuse image capture. |

After one unsuccessful recovery, report the blocker and next step. `retryable: true` does not authorize repeating an uncertain action.

## Human UI and scope

Browser Settings owns installation, runtime modes, accounts, sign-in, cleanup, and policy management. Raw pointer input and file uploads are human UI capabilities, absent from the agent tool list. Human markings are user attachments; agent `browser_capture` is evidence capture.

The service treats opening and assigned-tab browsing as the agent's browser territory. Secure account fill still uses broker approval and origin checks. Keep actions within the user's requested task. The [source comparison](design-sources.md) records the architecture and research sources.

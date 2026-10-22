# Hama Browser tools

The live tool definitions are the authority. This guide was checked against `tools.mjs`, `server.mjs`, and `owned-browser-service.mjs` at base commit `171820b3`, with submission and conditional-wait contracts from `95d54b99`, on 2026-10-11, and the outline, settle and select contracts added on 2026-10-16. MCP names have the `mcp__rhwp__` prefix where the provider requires it.

## Identity and results

Ordinary successful tab calls return `ok`, `action`, `runtime`, and `tab`, plus their specific result. `completed: true` confirms the operation returned; inspect the page or download to establish the task outcome. Document readiness does not establish that dynamic results, an export, or a save finished.

`browser_click`, `browser_type`, `browser_press`, and `browser_select` first wait about 0.5 s, then up to 5 s for a started navigation to load or for the requests the action started to answer. They return only `ok`, `action`, `navigated`, `url`, and `title`, plus `navigationEpoch` after a navigation, `newTab` for an opened popup, `dialog` for a dismissed alert or confirm, and `snapshot` when requested.

| Returned value | Use |
| --- | --- |
| `tab.tabId` | Stable assigned-tab identity. Hidden previews and provider turn endings do not close it. |
| `tab.openerTabId` | Identifies a popup's parent. Enumerate status to find the child. |
| `tab.navigationEpoch`, `tab.controllerEpoch` | Latest values required by input, navigation, close, and account fill. Never increment them yourself. |
| `runtime.generation`, `tab.runtimeGeneration` | Detect a runtime replacement. Refresh inventory and snapshot afterward. The public tool schemas do **not** accept a `runtimeGeneration` argument. |
| `snapshot.snapshotId`, `[ref=…]` in `snapshot.outline` | Current observation and target identity. A new snapshot replaces earlier refs. Navigation, zoom changes, and recovery can invalidate them. |
| `snapshot.outline`, `url`, `title`, `truncated`, `hint` | One line per node, such as `- button "Save" [ref=e12]` or `- textbox "Email" [ref=e3]: value`. Controls and scopeable regions carry refs; headings, paragraphs and lists give structure. Links have no `href`. Private field values read `[masked]`. Menus and footers with more than 10 controls fold into one line such as `- navigation "Main" [ref=e7]: +23 links`; scope that ref or use `find` to list them. The outline stops near 20 KB with `truncated: true`. `text` and `selectedText` appear only when requested or present. |

Agent ownership comes from the hub, not tool arguments. A tab ID from another agent is unavailable. The server serializes actions per tab. Never run dependent input calls concurrently.

## Argument groups

`epochs` below means required `navigationEpoch` and `controllerEpoch`, both nonnegative integers. `target` means required `tabId`, `snapshotId`, `ref`, and `epochs`.

`intent` accepts `research`, `search`, `login`, `export`, or `website-change`, and defaults to `research`. It describes the operation; it does not grant a new permission. Optional fields below can be omitted.

| Tool | Arguments | Result and practical use |
| --- | --- | --- |
| `browser_status` | `{}` | `runtime`, scoped `tabs`, `limits`, `sites` (this chat's site access: `always`, `chat`, `signedIn`, `blocked`), the active browser's `accounts` (`id`, `label`, `origin`, `site`, `agentBlocked`, `usable`), and `secrets` (`id`, `label`, `kind`, `origins`, `blocked`, `usable`; never a value). `usable: true` fills now. A tab whose page needs site access reads `approval-required` with its `site` and `request`. |
| `browser_open` | Optional `url`, `intent` | Creates your tab and returns its descriptor. Omitted URL opens `about:blank`. Runtime starts lazily. |
| `browser_navigate` | `tabId`, `url`, `epochs`; optional `intent` | Navigates the same tab. Snapshot afterward. The public schema has no back/forward/reload direction field. |
| `browser_snapshot` | `tabId`; optional `scope`, `find`, `text` | Returns `snapshot` and current tab state. `scope` keeps one ref's subtree, `find` keeps matching lines with their ancestors and reports `matches`, `text: true` adds up to 24,000 characters of visible text; try `find` first. Replaces refs, so choose actions from this result. |
| `browser_click` | `target`; optional `intent`, `snapshot` | Clicks the observed element and reports the settled result. `newTab.tabId` names an opened popup. |
| `browser_type` | `target`, `text`; optional `intent`, `submit`, `snapshot` | Fills ordinary text, maximum 16,000 characters. `submit: true` fills and presses Enter on that validated target. It defaults to false. Use `intent: search` for a search form. |
| `browser_press` | `target`, `key`; optional `intent`, `snapshot` | Presses on the observed element. `Enter`, navigation keys, single letters/digits, and select-all are supported. Clipboard/browser-window shortcuts are blocked. |
| `browser_select` | `target`, `option`; optional `intent`, `snapshot` | Chooses an enabled `<select>` option by label, then value, then case-insensitive label. Custom menus are clicked instead. |
| `browser_upload` | `target`, `files` (1–5 of `{artifactId}`, `{downloadId}`, `{projectItemId}` or `{snapshotPath}`) | Attaches files to a file input, or clicks the observed button, label or drop zone and fills the file chooser it opens. Sources are only this chat's artifacts, its completed downloads, its project files and paths returned by `materialize_document_snapshot` (the open document). Local paths and bytes are refused. Each file is at most 20 MB, 40 MB in total. Always needs site access. Returns `files` (`name`, `size`) with the settled change. Not available on pages protected by saved passwords. |
| `browser_scroll` | `tabId`, `deltaY`, `epochs`; optional `deltaX` | Scroll, then snapshot. Schema permits deltas between -10,000 and 10,000; runtime clamps each delta to -2,000 through 2,000. |
| `browser_wait` | `tabId`; optional `condition`, `text`, `find`, `timeoutMs` | Conditions are `ready`, `idle`, `visible`, `text`; default `ready`. Timeout is between 1 and 30,000 ms, default 10,000. Returns a fresh `snapshot` when the predicate succeeds. `text` requires nonempty text. See conditions below. |
| `browser_close` | `tabId`, `epochs` | Explicitly closes your tab. Completed managed downloads survive. Hiding a preview is separate. |
| `browser_capture` | `tabId`; optional `snapshotId`, `ref`, `navigationEpoch`, `region`, `comment` | Page capture by default. Element capture uses current `snapshotId` and `ref`; region uses `{x,y,width,height}` in observed page CSS coordinates. Returns `capture` provenance and an image when available. Capture stays bound to the originating destination. |
| `browser_downloads` | Optional `action`, `downloadId` | `action` is `list`, `cancel`, `retry`, or `save`, default `list`. Use a returned ID for cancel/retry/save. After completion, desktop `save` returns the actual `savedPath` in the local Downloads folder, retaining the filename without overwriting existing files. Returns scoped jobs or one job. Importing to another project is a human UI operation, absent from this agent schema. |
| `browser_fill_account` | `tabId`, `accountId`, `snapshotId`, `passwordRef`, `epochs`; optional `usernameRef` | Secure local autofill for a saved login on its own site (same registrable domain); the form must post to that site. `accountId` must be a UUID from status. Needs site access (`usable: true` in status). Supply refs for both login fields, including ID fields without autocomplete hints. Returns metadata/results, never the password. |
| `browser_request_account` | `origin`; optional `kind`, `tabId`, `label`, `reason`, `accountId`, `blocked` | Root conversation only. `kind: "site"` asks once for site access on the site's registrable domain and all its subdomains (an IP, `localhost` or HTTP origin stays exact): signed-in reads, website changes, its saved logins and secrets. `kind: "account"` (default) becomes the same site card when the site has a saved login and a save form only when it has none. `kind: "sign-in"` / `"code"` hands `tabId` to the user. Returns `granted: true` when this chat already has access, otherwise `pending` with `requestId`; end the turn and wait. Repeated requests return the same pending card. |
| `browser_fill_secret` | `target`, `secretId`; optional `submit` | Types a saved secret into one visible text, password or textarea field on the secret's site (same registrable domain as one of its `origins`); a form must post to that site. Needs site access. Returns the settled change, never the value; later observations show the field as `[masked]`. |
| `request_secret` | `label`, `origins` (1–20 HTTPS origins), `kind` (`api-key`, `token`, `password`, `other`), `reason`; optional `secretId` | Root conversation only. Asks the user to enter a new secret, or for site access to use a saved one (`secretId`, or the same label and origins). Returns `status: granted` with `secretId` when this chat may already use it; otherwise `pending` and `requestId`: end the turn. The chat resumes when the user answers. |

URLs must satisfy the browser's network guard. Public HTTPS research is the normal path; workspace preview access needs its configured allowance. Do not substitute raw HTTP requests or another browser to evade a refusal.

Wait conditions use observable page state. `ready` waits for document readiness. `idle` waits for loading/navigation to settle for 500 ms, without requiring network silence. `visible` waits for a control with a ref, optionally with a non-masked name or value containing the supplied `text`. `text` waits for supplied text anywhere in the full outline, before its size limit. Matching uses a case-sensitive substring. The timeout includes queued time and observation work. Treat the returned snapshot as the current observation and avoid another snapshot without a reason.

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

Add `"snapshot":true` to read the results in the same call, or wait for expected text that loads later and use its returned snapshot:

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
| `BROWSER_PERMISSION_REQUIRED` (`reason`: `signed-in`, `website-change`, `account-use`), `BROWSER_SITE_BLOCKED` | The refusal names `site` and carries `request`. Root conversation: make exactly that call, then end the turn. Subagents (`reportToRoot`) report the site to the root. `performed: true` means the first request already reached the site; observe before retrying. |
| `BROWSER_SECRET_CHANNEL_REQUIRED` | A password field: fill it with `browser_fill_account`, or ask to save a login with `kind: "account"`. |
| `SECRET_VALUE_UNAVAILABLE` | The root conversation calls `request_secret` with the returned `secretId` and ends the turn. |
| `BROWSER_SECRET_ORIGIN_MISMATCH`, `BROWSER_SECRET_FORM_ORIGIN`, `BROWSER_SECRET_TARGET_INVALID` | The page, frame, form destination or field is outside what the user approved. Choose the right field on the approved site; never move the secret elsewhere. |
| `BROWSER_TAB_LIMIT` | Reuse a relevant tab or close an unused assigned tab with current epochs. |
| Capture `screenshotError` | Keep returned text/comment/provenance and state that the image failed. Password-protected pages can refuse image capture. |

After one unsuccessful recovery, report the blocker and next step. `retryable: true` does not authorize repeating an uncertain action.

## Human UI and scope

Browser Settings owns installation, runtime modes, accounts, sign-in, cleanup, and policy management. Raw pointer input and file uploads are human UI capabilities, absent from the agent tool list. User viewport screenshots are chat attachments; agent `browser_capture` is evidence capture.

The service treats opening and assigned-tab browsing as the agent's browser territory. Secure fills check site access, the item's own site and the form destination. Keep actions within the user's requested task. The [source comparison](design-sources.md) records the architecture and research sources.

`browser_status.activeTabId` is the selected tab in the current Studio sidebar, or `null` when no browser is docked. It never names another agent’s private tab, and it is always `null` for subagents, which see only their own tabs. For tasks about the current page, use that ID with `browser_snapshot` and the existing navigation and input tools.

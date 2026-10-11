# Browser design sources

Reviewed 2026-10-11. The skill applies these findings to Hama's existing tools. This comparison covers public source, official API documentation, and installed documentation. It does not establish private Codex or Claude application internals.

## Comparison

| System and evidence | Established behavior | Hama decision |
| --- | --- | --- |
| T3 Code, pinned upstream source `c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e` | Server Playwright ownership, desktop `<webview>` plus private CDP relay, thread/tab identity, popup adoption, controller generation, and namespaced semantic refs. | Keep hub-owned tabs independent of the preview, reuse assigned IDs, and refresh after generation changes. |
| Codex installed browser plugin documentation, version `26.1007.21159` | `accessibility.md` prefers accessibility observations and indexed actions, supports observation diffs, and refreshes after interactions. `api-use-behavior.md` asks for the cheapest state check answering the next question. `browser-troubleshooting.md` separates stale tabs/helpers from a disconnected browser. | Lead with semantic snapshots, avoid duplicate observations, and distinguish ref refresh from runtime recovery. Installed documentation is evidence of its documented contract, not source proof of the private app implementation. |
| Official Codex browser documentation, redirected to the shared ChatGPT browser guide | Built-in browser profile is separate from the regular browser. Codex can open, click, type, observe, and verify pages; visual comments identify exact elements/regions. Full CDP access is a separate developer setting. | Preserve app-owned profile identity and human feedback attachments. Keep routine browser tools separate from developer introspection. |
| Official Claude Code Chrome integration documentation | CLI/VS Code connects to the Claude in Chrome extension through native messaging. New task tabs share the selected regular browser's login state and form a session group. Login/CAPTCHA uses a human handoff; `/chrome` manages connection and selection. | Keep account reuse and recovery explicit. Hama uses its own hub/profile rather than importing the user's regular browser session. |
| Official OpenAI computer-use API documentation | Applications provide the environment, execute actions or code, and return observations. Existing function/MCP UI tools can remain the integration. | Keep Hama's provider-neutral MCP contract. Action completion and task success require separate checks. |
| Official Anthropic computer-use API documentation | The application runs screenshot, mouse, keyboard, and zoom calls through a client toolset. The agent loop returns tool results; several calls may arrive together. | Use screenshots when visual context is necessary and keep execution/order checks on the hub. Claude's API batching does not create a Hama batch tool. |
| Hama base `171820b3`, submission/wait contracts `95d54b99` | Individual semantic tools, scoped tabs, epochs, secure broker fill, capture provenance, managed download jobs, combined search submission, and waits returning fresh snapshots. | Publish a short task guide plus an exact tool reference. Preserve source identity and actual browser-delivered downloads. |

T3's [desktop browser host](https://github.com/pingdotgg/t3code/blob/c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e/apps/desktop/src/preview/DesktopBrowserHost.ts) registers webviews and relays CDP. Its [server browser](https://github.com/pingdotgg/t3code/blob/c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e/apps/server/src/preview/ServerBrowser.ts) connects desktop tabs or launches server-owned pages and adopts popup children. Its [page observations](https://github.com/pingdotgg/t3code/blob/c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e/apps/server/src/preview/ServerBrowserPage.ts) map fresh, runtime-namespaced refs to Playwright accessibility refs. [SessionControl](https://github.com/pingdotgg/t3code/blob/c77a7b7eebd6ea8a3a63bbcaaa7c1707fe65c86e/apps/server/src/preview/SessionControl.ts) checks agent ownership and human control, invalidates generations, and drains actions before release.

OpenAI's [computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use) documents persistent environments, execution limits, screenshots, and custom UI tool integrations. Anthropic's [computer-use tool guide](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) documents the client toolset, action dispatch, screenshot coordinates, zoom, and the bounded agent loop. These API contracts inform Hama's observation/action loop; they do not establish how the vendors' desktop apps are built.

The official [Codex browser route](https://developers.openai.com/codex/app/browser) currently redirects to the [shared browser guide](https://learn.chatgpt.com/docs/browser?surface=app). It establishes user-visible browser/profile, annotation, and developer access behavior. The official [Claude Code Chrome guide](https://code.claude.com/docs/en/chrome) establishes extension integration, native messaging setup, session tab groups, login reuse, site permissions, and reconnect behavior. Neither requires copying the vendors' private app internals to use Hama's browser effectively.

The installed Codex references are under the `openai-bundled/browser/26.1007.21159/docs/` plugin directory. They were read locally before checking official OpenAI documentation. Their accessibility and Playwright calls are not Hama tool names and must not be copied into this skill's executable examples.

## Current implementation boundaries

Hama's [tool definitions](../../../tools.mjs) and [hub dispatch](../../../server.mjs) declare and forward agent calls. The [browser service](../../../owned-browser-service.mjs) owns descriptors, queues, snapshots, captures, and runtime lifecycle. The [credential broker](../../../browser-credentials.mjs) handles opaque account IDs, approved origins, current-field bindings, and revocation. [Provider instructions](../../../agents/backend.mjs) keep account requests in the root conversation. The [product skill registry](../../../skills.mjs) discovers this bundled directory through its frontmatter name and description; the document heading is `Skills Get Hama Browser`.

The guide follows these implementation boundaries:

- Search fill/submit can run in one `browser_type` call. Conditional waits return a fresh semantic snapshot, avoiding another observation call.
- Runtime generation appears in results; it is absent from public action arguments. Refresh inventory after a generation change instead of adding an unsupported field.
- Semantic snapshots return bounded full text and elements, without a public diff/filter option. Capture creates evidence and can fail while retaining provenance.
- Opening and assigned-tab browsing short-circuit the service's general page-policy path as agent territory. Secure account fill retains its separate broker checks. Tool descriptions about page/account restrictions should be assessed against that actual behavior.
- Human input and agent browsing coexist. Epoch changes and fresh observations keep agent targets current; full-browser account sign-in uses a separate handoff.
- Agent tools expose no raw coordinates, JavaScript evaluation, browser-policy editing, installation, recovery, uploads, or human marking operation.

This documentation change does not alter browser implementations.

## Evidence and future work

The repository's [existing browser plan](../../../../../docs/design/owned-browser-plan.md) records the earlier architecture study and pinned T3 source. Its [runtime evidence](../../../../../docs/pr-evidence/owned-browser/README.md) separates real Chromium/Electron checks, fixture providers/sites, and account-holder verification. This skill was validated for format, catalog discovery, resource reads, and real schema-compatible examples. A documentation check does not establish private account login, Google Slides export, or live-provider browsing success.

Potential tool changes require separate implementation and runtime verification:

| Candidate | Benefit | Required contract |
| --- | --- | --- |
| Action result plus compact fresh observation | Fewer round trips for click/read workflows | Return new refs and epochs atomically; distinguish uncertain input from unperformed input. |
| Snapshot diffs or bounded filtering | Reduce repeated full text and element output | Preserve stable observation identity and make missing/truncated content explicit. |

The shipping skill uses only the currently exposed individual tools.

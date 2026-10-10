# Agent Hub stability audit — 2026-10-10

Architecture and failure-path audit of PR #475. Findings below pair reproduced failures with fixes and verification. Browserbase references describe that audited revision; the app-owned browser migration supersedes those runtime paths.

## Architecture and failure boundaries

- `rhwp/rhwp-agent/server.mjs` owns the HTTP and WebSocket hub. Owner registration creates a per-session record and storage roots; `hub-session-registry.mjs` authenticates capabilities by session, audience, resource, and provider generation.
- `/studio` and `/mcp` upgrades authenticate before attaching sockets. Each session has a bounded, serialized Studio command queue, correlated pending tool calls, and provider-turn identity checks. `mcp-stdio.mjs` bounds provider RPCs and fails them when its hub socket closes.
- The server starts Claude, Codex, and Pi backends. Session teardown also drains Browserbase, auxiliary processes, template workers, snapshots, and credential mirrors. Process-tree cleanup is fail-closed: uncertain ownership retains the backend and work root.
- Shared state includes provider setup/health, project/reference stores, and the CLI npm prefix. Per-session work and home directories isolate provider writes. Pi prefix changes are serialized in the server; managed Claude/Codex installs and launch preparation are serialized by the CLI setup manager.

## Reproduced failures and repairs

`chat-stop` clears `record.agentSession` before asynchronous process-tree cleanup finishes. A concurrent owner `DELETE /sessions/:id` could therefore observe no active backend, finish record disposal, and remove the provider's work directory while its process was still alive.

The server now coalesces provider disposal through `sessionDisposalPromise`, so chat stop, owner deletion, and hub shutdown await the same cleanup result. The `hub-session-cleanup.test.mjs` integration test starts a fixture Pi process that holds its workspace after SIGTERM, triggers chat stop and owner deletion together, checks that the PID and workspace remain and deletion is pending, then releases the process and checks that deletion completes and the workspace is removed. This test reproduced premature workspace deletion before the repair and passed after it.

**Managed CLI replacement during launch.** A provider turn could resolve a managed `.bin` path while npm was replacing the shared prefix. The CLI setup manager now reserves the prefix through each synchronous spawn; installs wait until the reservation releases. Tests cover waiting for an in-progress install, blocking a new install during a reservation, and provider cancellation before spawn (`cli-setup-manager.test.mjs`, `codex-app-server.test.mjs`, `backend-capabilities.test.mjs`). The original missing-path report still needs live reproduction after the change.

**Installer timeout with uncertain process cleanup.** A timed-out npm process could leave descendants writing to the shared prefix after the installer was considered finished. The manager now waits for process-tree cleanup and quarantines the prefix when it cannot prove exit; later installs and launches fail closed. `cli-setup-manager.test.mjs` covers an unproven timed-out installer and verifies that subsequent operations are rejected. This quarantine lasts for the manager process; recovery across a hub restart requires checking that the old installer has stopped.

**Spawn failure before an OS process exists.** An `ENOENT` spawn leaves a child handle without a PID. Process-tree cleanup previously treated the absent tree identity as uncertain, which could quarantine a valid provider session after a simple missing executable. `process-tree.mjs` now treats the negative libuv exit code with no PID as a completed no-process case. `process-tree.test.mjs` covers that behavior, and `backend-capabilities.test.mjs` verifies Claude can retry after a real spawn failure.

**Stale reconnect credentials.** Overlapping reconnect attempts could finish session lookup out of order and apply an older capability or open a socket for a superseded attempt. `AgentBridgeImpl` now increments a reconnect sequence for initialization and checks it after each asynchronous lookup. `agent-reconnect-ui.test.ts` covers superseded manual and initial reconnects, overlapping initializers, and retry timers.

**Stale Claude SDK fallback.** When native SDK startup failed asynchronously, its legacy MCP fallback could dispatch a prompt after that prompt had been cancelled and a newer turn had started. Claude now binds fallback work to the turn generation, reacquires the managed launch reservation, discards stale prompts, and releases the reservation on cancellation. `provider-user-input-protocols.test.mjs` covers the cancelled old prompt, current prompt, and reservation release behavior.

**Draft attachment scope before first chat.** An attachment uploaded before the first message had no authoritative provider session scope, so valid files could be rejected or associated with stale chat context. The bridge now binds the draft thread over the Studio socket and confirms that context before HTTP staging; upload cancellation propagates through an `AbortSignal`. The hub grants the bound thread only for staging requests, while stored-file reads remain tied to the active provider session. Coverage includes `agent-reference-protocol.test.ts`, `reference-files-flow.test.mjs` (empty-editor and next-draft flows), and the server staging-scope path.

## Graph loading and research storage

The editor and standalone sidebar preview previously shared Vite's default optimized-dependency cache. Starting the second configuration could replace the cache while the editor still referenced an older `d3-force` URL. Both configurations now use separate checkout-local caches under `.run/vite-cache/`, and the editor eagerly optimizes `d3-force`. The graph check runs both real Vite configurations, renders the production graph after the second optimizer starts, and exercises a failed dependency response followed by reload recovery. It passed; its graph data is fixture-backed.

An actual Codex 0.162.1 turn reproduced the 자료함 failure: `project_import` and `download_file` requested MCP approval while the provider's approval policy was `never`. Both Codex adapters now explicitly approve those two scoped MCP tools. Hub authorization, project edit settings, download address filtering, and question-mode document write restrictions remain enforced. The fix takes effect when a provider process starts again.

The research-storage checks passed 198 focused tests. Actual Codex app-server and legacy exec turns accepted both tools. An isolated real hub with Codex app-server downloaded the Example Domain page, imported it and reference text into a project, listed the saved files, and read them back. That check used a protocol Studio client with a fixture document, rather than the user's Electron conversation.

## Intentional capture and resumed-chat recovery

Ordinary document selection no longer opens the inline agent pill. Two Control taps arm the next selection and add a faint border without text; pressing S while armed starts a document-region screenshot. Selection comments and screenshots save locally as JSON records and PNG files, then appear as composer attachment pills. Saving does not start a provider turn. Electron stores records under its user-data `document-captures` directory; the standalone web editor uses IndexedDB.

Explicit composer Send stages the queued captures and requests a correlated acceptance receipt. Rejected or cancelled sends retain the local queue. Accepted sends consume it; retries reuse a message ID and the hub deduplicates accepted messages. Attachment processing failures reject the complete opt-in batch. Provider events emitted synchronously during dispatch are buffered until the receipt, including synchronous successful completion. Captures remain scoped to their document, and bounded native screenshot IPC validates the trusted sender, rectangle, pixel allocation, and PNG.

Memo #6 reproduced a reconnect handoff that skipped the idle welcome while waiting for `chat-started`. That response previously omitted status, leaving the old bridge turn and editing lease active. The hub now sends status and turn ID; the bridge reconciles the authoritative snapshot through normal turn cleanup, preserving pending review edits and genuinely active turns. The sidebar updates its stop button and pending indicator from that state.

## Mode selector interaction

Memo #7's mode menu now uses a smaller translucent surface, thin border and single-line rows. Light/dark preview checks covered mode selection, full-access confirmation/cancellation and outside dismissal. An isolated real Studio/WASM editor with a fixture Pi provider also verified click, Up/Down, Home/End, Enter to select Plan, and Escape returning focus to the selector. The existing keyboard implementation passed this flow; no additional menu handler was needed. The compact glass styling was also exercised in the running Electron editor without sending a provider prompt.

## Chat-scoped permission requests

An agent can call `request_permission` for project edits, downloads, browser use, or local files and commands. The tool returns `pending` immediately, and the agent ends its turn while the user decides through a permission pill. Granting refreshes the provider's capabilities when it is idle; it does not send a user message or change the saved mode preference. A busy or failed grant leaves the same pill available for retry.

The hub binds each request to the authenticated root provider resource, generation, capability epoch, turn, chat, and document. Legacy Claude/Codex MCP requests consume a matching one-use provider-stream scope ticket; missing, ambiguous, or child tickets are rejected. Claude retains child provenance even when the parent task card has not been mapped. A pending request survives normal turn completion and reconnect, while interruption, replacement, or a new turn expires it. Same-chat provider reconfiguration retains granted capabilities; a new chat or document starts with an empty grant list. Grants remain in the running hub's memory.

Every app tool call still passes category authorization. Chat always rejects live-document writes, including stale document-edit grants. Document editing requires Agent or Full Access mode; Plan retains its approval gate. Project-edit overrides only that chat's project-write setting. Download and browser grants expose those app capabilities to a direct-mode chat. Instruction changes, background-worker tools, and canonical plan approval keep their existing gates. Local-execution enables native file access and commands in the owning chat through the provider adapters.

Every successful grant sends the full capability list through `setExecutionMode`, keeping provider briefs and native policies synchronized. Codex updates its resumed conversation through an acknowledged `thread/inject_items` developer message before the hub accepts the grant. A CLI without that protocol method produces an actionable update-and-retry error and restores prior permissions. Failed reconfiguration rolls back the full prior capability list. If interruption invalidates an in-flight transition, the hub reapplies prior capabilities; an unproven rollback disposes the session.

## Permission verification

- The focused hub/tool/planning/Pi catalog run passed 105 tests. Behavioral cases cover blocked writes before grant, immediate pending tool results, busy retry, wrong-chat rejection, reconnect replay, denial, stop, new-chat reset, canonical-plan approval, and one-use legacy root provenance. A delayed adapter fixture also proves that failure or interruption during native reconfiguration restores prior authority.
- Real Studio, hub, and WASM at `http://127.0.0.1:7840` passed `e2e:chat-permissions` with a controlled Pi fixture. Chat document writes remained blocked before and after other grants, and document-edit permission requests produced no pill. Agent staged an actual WASM edit for review and Reject restored the document; Full Access committed immediately. The real project store accepted a note only after project-edit was granted. Denial, stop, detached old pills, and new-chat reset kept unauthorized writes blocked; personal mode settings remained unchanged. Results and screenshots are in [the runtime evidence directory](evidence/pr475-chat-permissions-runtime/results.json). Local-execution in this UI check validates grant state through the fixture provider.
- Historical verification before document-edit grants were removed: actual Codex 0.162.1 app-server completed request, document-only grant, native command grant, and revocation in the same isolated conversation. Its MCP request and document-edit responses were fixtures. After local-execution was granted, its native OS command exited zero and wrote `native-grant-success` to a temporary file outside the chat workspace. The document-only and revoked cases left their native-write probe files absent. The chat stayed in question workflow with the safe permission profile. [The compact native evidence](evidence/pr475-chat-permissions-runtime/native-codex-results.json) records those boundaries.
- Provider-focused tests passed 186 cases, followed by 40 Codex app-server cases after the instruction-sync repair. The latter cover acknowledged grant/revoke briefs, a separate chat retaining read-only policy, and rollback when `thread/inject_items` is unavailable.

## Integrated permission checks

The bounded full hub rerun passed 1,164 tests. The full Studio unit rerun passed 2,541 tests with one skip, and Studio TypeScript checking passed. The bounded full Studio browser rerun passed 102 tests with zero cancellations. An earlier concurrent hub run hit a metadata timing assertion; the same case passed in isolation and in the full rerun. Obsolete guard/presentation failures from the first Studio run were corrected before the passing rerun.

The Codex context refresh after later workflow/profile changes passed three focused tests and an extended actual CLI run. In the same conversation, revoking grants then switching to direct/safe enabled a workspace write, full access enabled an outside-workspace write, and switching back to safe refreshed instructions without starting a turn.

## Remaining bounded follow-ups

1. **Owner delete during provider startup — unproven.** A Studio `chat-start` may already be awaiting boot, auth, or project/reference setup when owner deletion disposes the record. `startSession()` has no general disposed check after those awaits; plan mode also awaits `backend.setExecutionMode()` after assigning the backend. Most starts after registry deletion should fail at capability issuance, but test a gated plan-mode start racing DELETE and verify that no disposed session is later reported or used.
2. **Registration rollback after partial allocation — unproven.** The production `HubSessionRegistry` factory creates directories and credential mirrors before returning its record. If a later synchronous initialization step throws, there is no record to pass through `disposeRecord()`. Fault-inject a factory failure after allocation and verify the partial root is cleaned.
3. **Unproven cleanup response semantics — unproven.** Owner DELETE removes the record before cleanup and currently ignores a false `disposeRecord()` result, whereas `/shutdown` reports `cleanup-unproven`. Check the desktop caller and add an injected cleanup-failure HTTP test before deciding whether DELETE should report failure or retain an explicit tombstone.

## Focused verification

Focused tests exercise capability generations and tenant isolation, concurrent provider turns, Studio reconnects, bounded queues, provider restart barriers, process-tree outcomes, and owner watchdog shutdown. Useful commands from the repository root:

```sh
node --test rhwp/rhwp-agent/tests/hub-session-registry.test.mjs rhwp/rhwp-agent/tests/hub-server-tenancy.test.mjs rhwp/rhwp-agent/tests/hub-studio-reattach.test.mjs rhwp/rhwp-agent/tests/hub-session-cleanup.test.mjs
node --test rhwp/rhwp-agent/tests/process-tree.test.mjs rhwp/rhwp-agent/tests/turn-process-lifecycle.test.mjs rhwp/rhwp-agent/tests/auxiliary-process-cleanup.test.mjs rhwp/rhwp-agent/tests/cli-setup-manager.test.mjs rhwp/rhwp-agent/tests/codex-app-server.test.mjs
npm --prefix rhwp/rhwp-agent test
```

## Verification results before permission changes

- At commit `3ca1bbca`, `node --test --test-concurrency=4 rhwp/rhwp-agent/tests/*.test.mjs`: 1,149 passed.
- At the same commit, Studio `npm test -- --test-concurrency=4`: 2,533 passed, one skipped.
- Desktop suite: 42 passed; focused capture storage/native IPC suite: six passed. ACP and Studio TypeScript checks passed.
- The standalone sidebar build and full interaction suite passed, including resumed idle chats and later cancellation. The real Studio capture E2E passed with a fixture Pi provider: ordinary selection, intentional selection, object/table/cell context, local save without sending, rejection retention, and explicit accepted Send.
- Isolated Electron at `http://127.0.0.1:7830/?renderer=canvaskit`, profile `/tmp/rauhwpx-capture-image-evidence/user-data`: a clean `test-image.hwp` region capture matched a fresh live crop exactly (422 × 320 pixels). Save queued one pill with zero user messages; Escape cancelled another capture; reload and reopening the same fixture restored the pill. JSON and PNG were read back from disk. This check used a fixture document; no authenticated provider turn was sent.
- The user's Electron at `http://127.0.0.1:7745`, CDP 9475, restarted gracefully with the new backend and IPC. Its original persisted document snapshot and existing 17-message Codex chat reopened with no running turn, stop button, or IPC error. The latest restart also confirmed an empty chat grant list. No verification prompt was added to that chat. A subsequent authenticated resumed Codex turn remains a manual check.
- Fixture-only visual evidence is committed under `docs/evidence/pr475-memo-fixes/`: armed border, screenshot comment, queued pills, graph, and idle resumed chat.
- ACP type checking, Studio TypeScript checking, standalone sidebar build, and the full sidebar interaction suite passed.
- Real isolated hub/Studio reconnect E2E passed hub absence, automatic recovery, termination, manual retry, and restart recovery. Reference-file E2E used the original HWPX with a fixture provider and passed initial upload, next-draft upload, and cancellation.
- Running Electron at `http://127.0.0.1:7745`, CDP 9475: the original `landscape-001.hwpx` staged with HTTP 201 and cancellation returned HTTP 200; document identity, revision, thread, composer, and messages remained unchanged. The new-chat toolbar kept sidebar view. Screenshots: `/tmp/rauhwpx-memo1-live-ready.png` and `/tmp/rauhwpx-memo3-live-sidebar.png`.
- The managed Claude executable passed `--version`; real OS failed-spawn tests verified retry and cleanup. An authenticated Claude chat was not run in the user's active conversation. Its end-to-end authenticated turn remains a manual verification step.

## CI fixture login independence

The Auth CI job exposed a fixture dependency on the developer's Claude login. Its root-provenance test replaced the backend but still read host setup credentials, so a signed-out runner returned `AGENT_AUTH_REQUIRED` before the expected turn-start. The fixture now uses the real CLI setup manager with temporary setup/home directories and an explicit dummy credential. A signed-out fixture also verifies that authentication rejects the message before backend dispatch.

The complete user-question suite passed 16 tests, and the authenticated/signed-out provenance cases passed five consecutive repetitions. The exact serialized CI hub command, `node --test --test-concurrency=1 rhwp/rhwp-agent/tests/*.test.mjs`, then passed all 1,165 tests with no failures or skips in 82 seconds.

## Memo #8: Codex copy-layout workers stopped before calling tools

The two reported jobs stopped after about 15 seconds with no tool calls and no completion report. An offline probe using Codex 0.162.1 and GPT-6.1-Sol model metadata reproduced the failure: the model calls MCP through `functions.exec`, while the copy-layout launch configuration disabled `code_mode_host`. Its tool output reported that the host was disabled. Direct MCP probes initially appeared healthy because they bypassed this model-visible route.

Both Codex launch paths now enable that host. Workers retain the read-only sandbox, disabled shell/unified execution, disabled nested agents, and job-scoped MCP catalog. The actual CLI regression reaches progress, helper and completion tools; an attempted native patch reports the expected read-only sandbox denial and creates no file. The primary checkout passed that offline check and 101 focused provider/capability tests.

An isolated Studio/hub flow with actual Codex, the document engine and copy-layout helper generated and published a 6,602-byte template artifact, reported verified geometry/safety/readability for one source and output page, and delivered completion to the owning chat. Model responses came from a local fixture; no provider quota was used. The user's Electron was restarted while idle with no unsaved edits or composer draft, and the memo's original document and chat were restored.

## Chat document editing removed

Chat no longer accepts or requests document-edit grants. The hub tool catalog, authorization gate, provider brief and native mode, Studio write executor, staging and editing lease all enforce this boundary. Old grants and pending requests are stripped or rejected; malformed Chat implementation phases cannot commit edits. Project, download, browser and local-execution grants remain chat-scoped. Approved Plan execution remains available.

The full hub check passed 1,166 tests with one skip; Studio passed 2,541 with one skip. Fifteen focused Studio permission/mode/protocol tests and TypeScript checking passed after the final malformed-phase fix. The real Studio/hub/WASM permission flow with a controlled Pi provider verified blocked Chat writes, no document-edit pill, Agent review/rejection and Full Access immediate writes. The running Electron build was restarted and restored its existing document and Chat thread idle with no grants.

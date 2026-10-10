# Agent Hub stability audit — 2026-10-10

Architecture and failure-path audit of PR #475. Findings below pair reproduced failures with fixes and verification.

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

## Verification results

- `node --test --test-concurrency=4 rhwp/rhwp-agent/tests/*.test.mjs`: 1,140 passed.
- Studio `npm test -- --test-concurrency=4`: 2,524 passed, one skipped.
- ACP type checking, Studio TypeScript checking, standalone sidebar build, and the full sidebar interaction suite passed.
- Real isolated hub/Studio reconnect E2E passed hub absence, automatic recovery, termination, manual retry, and restart recovery. Reference-file E2E used the original HWPX with a fixture provider and passed initial upload, next-draft upload, and cancellation.
- Running Electron at `http://127.0.0.1:7745`, CDP 9475: the original `landscape-001.hwpx` staged with HTTP 201 and cancellation returned HTTP 200; document identity, revision, thread, composer, and messages remained unchanged. The new-chat toolbar kept sidebar view. Screenshots: `/tmp/rauhwpx-memo1-live-ready.png` and `/tmp/rauhwpx-memo3-live-sidebar.png`.
- The managed Claude executable passed `--version`; real OS failed-spawn tests verified retry and cleanup. An authenticated Claude chat was not run in the user's active conversation. Its end-to-end authenticated turn remains a manual verification step.

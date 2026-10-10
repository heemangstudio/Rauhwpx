# Chat permission runtime verification

Command: `RHWP_PERMISSION_EVIDENCE_DIR=docs/evidence/pr475-chat-permissions-runtime node e2e/chat-permissions.test.mjs --mode=headless` from `rhwp/rhwp-studio` (use an absolute evidence path).

The current check ran on 2026-10-10 at `http://127.0.0.1:7840` with the production Studio editor, a real authenticated hub at port 5840, and the built WASM engine. Pi was a controlled fixture that opened and ended turns without model inference. Tool calls used the authenticated MCP connection and the actual session workflow. Each run used temporary hub data and a separate Vite dependency cache. Both runtimes stopped after verification.

- Chat denied document writes before and after project-edit and local-execution grants. Requesting `document-edit` returned `INVALID_ARGS`, created no permission pill, and left the document unchanged.
- With project chat editing disabled in the isolated settings, project writes were denied before approval. Clicking its permission pill during the running turn returned the busy error. After the turn ended, approval allowed a note into the actual project store. The local-execution pill added only that chat grant through the real Pi adapter reconfiguration.
- Grants did not send another user message or change the personal mode preference. Denial and Stop left their capabilities ungranted. A detached stale pill could not grant the background chat. New Chat-mode conversations inherited no grants; an idle new chat also cleared grants while reusing its Studio hub session. New draft prompts explicitly selected Chat using `/chat`.
- Switching through the production mode menu to Agent allowed a staged document edit. Clicking Reject restored the actual WASM document. Switching to Full through its confirmation sheet allowed an immediately committed document edit with no pending review.
- No browser page errors were raised.

`results.json` records the current assertions. `chat-document-edit-denied.png` shows the unchanged Chat document; `permission-request.png` shows the project-edit request with a busy error; `permission-chat-grants.png` shows the remaining grants; `permission-new-chat-reset.png` shows the fresh read-only chat. `agent-document-review.png` shows the staged edit with review controls; `full-document-edit.png` shows the committed Full-mode edit. The Agent and Full screenshots were visually inspected.

This fixture run verifies the UI, authenticated grant state, hub, document/project behavior, and Pi adapter permission reconfiguration. It does not execute a local shell command. `native-codex-results.json` is historical evidence from the earlier permission design; any document-edit grant recorded there is obsolete.

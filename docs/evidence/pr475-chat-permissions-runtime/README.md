# Chat permission runtime verification

Command: `node e2e/chat-permissions.test.mjs --mode=headless` from `rhwp/rhwp-studio`.

The check ran at `http://127.0.0.1:7840` with the production Studio editor, a real authenticated hub at port 5840, and the built WASM engine. Pi was a controlled fixture that opened and ended turns without model inference. Each run used temporary hub data and a separate Vite dependency cache. The runtime was stopped after verification.

- Before approval, document writes were denied and the WASM document stayed unchanged. Clicking the permission pill during a running turn returned the busy error and left the request pending.
- After the fixture turn ended, clicking the same pill gave the authenticated chat a document-edit grant. The grant did not send another user message. The next explicit turn inserted text in the actual document and held it for review. Clicking Reject restored the original WASM document.
- With project chat editing disabled in the isolated settings, project writes were denied before approval. A project-edit grant allowed a note into the actual project store. The local-execution pill added only that chat grant through the real Pi adapter reconfiguration.
- Denial and Stop left their requested capabilities ungranted. A detached stale pill did not grant the background chat. Starting another chat had no inherited grants, and an idle new chat also cleared grants while reusing its Studio hub session.
- The chat stayed in question workflow with the safe profile. Personal mode preferences were unchanged, and no browser page errors were raised.

`results.json` records the assertions. `permission-request.png` shows the request, `permission-granted-review.png` shows the granted pill beside the actual staged document edit and review controls, `permission-chat-grants.png` shows the chat grants, and `permission-new-chat-reset.png` shows the fresh read-only chat.

Actual local command execution is verified separately by the native provider check; this run verifies the UI, authenticated grant state, hub, and document/project behavior.

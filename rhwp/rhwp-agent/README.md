# HamaEditor agent hub

Local WebSocket hub. Claude, Codex, and Pi read and edit the document open in HamaEditor through MCP. The hub owns chat workflow, downloads, and the app-owned browser runtime. Document logic stays in the browser.

```text
agent CLI ──spawn──► mcp-stdio.mjs ──ws──► server.mjs ◄──ws── rhwp-studio
                     (MCP server)         (127.0.0.1)
```

## Requirements

- Node 22.18 or newer
- The dependency setup and WASM build in [CONTRIBUTING.md](../../CONTRIBUTING.md)

Install a provider from Studio **Settings → Connection**.

## Run

Run these commands from the repository root after setup.

1. Start Studio. It starts its own authenticated hub on an ephemeral port.

   ```sh
   npm run setup
   npm run build:wasm
   npm run dev:studio
   ```

2. Open http://127.0.0.1:7700, load a document, pick a provider, and type an instruction. Enter sends. Shift+Enter adds a line.

For a standalone hub on port 5175, run `npm start` from the repository root. The process returns when `/healthz` is ready. Logs go to `.run/rhwp-agent.log`. Stop with `npm stop`. Foreground: `npm run start:fg`, or `cd rhwp/rhwp-agent && npm start`.

New chats start in **Safe** mode. Staged document edits wait for review. File and shell tools stay inside the project. **Full access** can reach files anywhere on the laptop.

`direct` runs immediately. `plan` stays read-only on the document until you approve. The hub blocks document writes before that approval.

AI requests send prompts and any document content read by the agent to your selected provider. Browser and web tools connect to external websites; the browser runtime runs on your hub.

## MCP tools

`rhwp/rhwp-agent/tools.mjs` is the list. `rhwp/rhwp-agent/tests/tools.test.mjs` pins the count and categories. Visible to Claude as `mcp__rhwp__<name>`.

Every read returns a `revision`. Every write requires `expectedRevision`. A mismatch returns `REVISION_MISMATCH`. Saving does not bump the revision. Coordinates are `sectionIdx` / `paraIdx` / `charOffset`, 0-based.

## Studio slash commands

These stay in Studio chat. They are not MCP tools.

- `/fast [on|off|status]`. Codex Fast service tier (Codex only). The next turn uses `service_tier="fast"`.
- `/skills`. Open the skill library.
- `/skill-create`. Draft a user skill.
- `/skill-edit <name>` / `/skill-delete <name>`. Change or remove a user skill.
- `/<skill-name> [request]`. Run an enabled skill.

Unknown slash text is sent as a normal message. `//` sends a message that starts with `/`.

## Provider usage

**Settings → AI 연결 → 사용량** reads Claude and Codex subscription quotas from the local CLI login. Claude uses its OAuth credentials in Keychain or `CLAUDE_CONFIG_DIR/.credentials.json`. Codex reads `account/rateLimits/read` through a short-lived app-server and supplements missing windows and banked reset balances through the account usage API. `CODEX_HOME` is respected. API-key billing keeps local token records without showing subscription quota estimates.

Claude and Codex log in from **Settings → AI 연결**, including on macOS. A profile already signed in to Claude Code or Codex is picked up automatically: the hub copies the existing login into each isolated session, so the provider is usable without signing in again. A Claude login that exists only in the macOS Keychain is materialized into a hub-owned seed file, because `security add-generic-password` needs an interactive authorization that the hub cannot satisfy — the hub only ever reads that item, and Claude Code stays its sole author.

Remaining-quota bars refresh while Connections is visible, and each card’s refresh icon forces a new read. Codex banked resets require confirmation and bind the request to the displayed account. The hub saves reset request IDs in `codex-reset-ledger.json` under the usage data directory so an interrupted reset can be retried safely. Credentials stay in the hub. CLIProxyAPI configuration is no longer used.

Unknown provider values remain unavailable.

## Environment variables
`RHWP_STUDIO_ORIGINS` (default empty) is a comma-separated list of exact HTTPS Studio origins allowed for operator-run remote previews.

`browser_*` tools operate app-owned Chromium tabs on the same hub as the agent. Tabs belong to authenticated chat/agent scopes; actions use the returned tab and snapshot identities. Public research and managed downloads are available by default. Website changes and saved-account use follow the approvals managed in **Settings → Browser → Approved Permissions**. Browser installation and runtime status appear in Browser settings.

See [Browser and research downloads](../../docs/owned-browser.md) for account approval, human takeover, managed profiles, and PDF recovery.

| Variable | Default | Description |
| --- | --- | --- |
| `RHWP_AGENT_PORT` | `5175` | Hub port, bound to 127.0.0.1 |
| `RHWP_AGENT_TOKEN` | `dev` | Shared token for WS connections (`?token=`) |
| `RHWP_CLAUDE_MODEL` | `sonnet` | Claude model |
| `RHWP_CODEX_MODEL` | `sol` | Codex model ID or legacy lineup (`astra`, `sol`, `luna`, `terra`) |
| `RHWP_SKILLS_DIR` | OS application-data directory | Product skill directory |
| `RHWP_USAGE_DIR` | OS application-data directory | Token-usage log directory |
| `RHWP_REFERENCES_DIR` | OS application-data directory | Reference file store |
| `RHWP_BROWSER_DATA_DIR` | Persistent hub browser directory | Shared browser profiles, policy, encrypted checkpoints, and download manifests; independent of project/chat lifetime |
| `RHWP_BROWSER_WORKSPACE_TARGETS` | `[]` | Operator-configured JSON array of exact HTTP(S) workspace origins allowed through the browser's private-network guard |
| `RHWP_BROWSER_WRAPPING_KEY_FILE` | unset | Optional owner-only 256-bit wrapping key outside browser data for a hub without an OS vault; passwords never use a plaintext fallback |
| `RHWP_PI_ROUTING_SORT` | `throughput` | OpenRouter provider sort for Pi: `throughput`, `latency`, `price`, or `off` (no provider routing preferences). Pi's `models.json` is rewritten at hub start, so restart the hub after changing it |

Studio build-time: `VITE_RHWP_AGENT_URL` (default `ws://127.0.0.1:5175`), `VITE_RHWP_AGENT_TOKEN` (default `dev`).

## Troubleshooting

- `HUB_UNAVAILABLE`. `node rhwp/rhwp-agent/server.mjs` is not running.
- `NO_STUDIO`. No Studio page is connected.
- `STUDIO_TIMEOUT`. Studio did not answer a document call within 30s.
- `TOOL_TIMEOUT`. The MCP-to-hub call did not finish within 180s.
- `CAPABILITY_EPOCH_REQUIRED` / `STALE_CAPABILITY_EPOCH`. Restart the provider in the current workflow phase.
- `PLAN_WRITE_BLOCKED`. A document write ran before the plan reached `implementing`.
- Only one Studio connection is kept. A new tab replaces the previous one.

## Tests

```sh
cd rhwp/rhwp-agent
npm test
npm run typecheck:acp
```

`typecheck:acp` checks the shared backend contract. Install Studio dependencies first.

`node scripts/pi-harness-check.mjs` runs the installed Pi binary against a local stub model and a fake hub, with no network. It checks the Pi system prompt, parallel reads, serialized writes, revision fill and retry, the finish check, and image pruning. It also plants extensions, skills, `mcp.json`, `.pi/` settings and `AGENTS.md` in the Pi home, the user home and the workspace, and checks that the parent and a subagent load only the bundled resources (`RHWP_PI_CHECK_BIN` picks another binary).

The app's Pi runs only with resources from the app bundle. `pi/resources.mjs` passes the `pi/extension` files and `pi/skills` on every spawn and turns off extension, skill, prompt-template, theme, context-file and project-local discovery, so the user's own Pi setup is never read. The hub installs and keeps Pi at `PI_VERSION` in `pi-manager.mjs`; raise it only after rerunning the harness check and a live bench.

## Files

| File | Role |
| --- | --- |
| `rhwp/rhwp-agent/server.mjs` | WS hub (`/studio`, `/mcp`, `/healthz`) |
| `rhwp/rhwp-agent/ctl.mjs` | `npm start` / `stop` / `status` |
| `rhwp/rhwp-agent/tools.mjs` | MCP tool definitions |
| `rhwp/rhwp-agent/mcp-stdio.mjs` | MCP stdio forwarder |
| `rhwp/rhwp-agent/agents/` | Provider backends |
| `rhwp/rhwp-agent/tests/` | Tool and hub contracts |

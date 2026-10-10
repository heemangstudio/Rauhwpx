# Application E2E tests

Run `npm run e2e:list` to discover regression scripts. Use the relevant
`npm run e2e:<name>` command in `package.json`, or run a listed file with Node.
Read its header for browser, server, fixture, and provider requirements. These
scripts are selected explicitly; the default Node tests do not run them.

`npm run e2e:check` checks that package commands and GitHub workflow references
point to existing scripts. The filesystem and executable commands are the
inventory; adding a test does not require editing a second table.

Name regression scripts `*.test.mjs` and make assertion failures exit nonzero.
Helpers, render reports, and benchmark runners are not regression coverage
merely because they execute.

## Hub and Vite processes

Start a hub or Vite server with `spawnLogged`, or with `startHub` and
`startVite`, from `agent-bench-harness.mjs`, and stop it with `stopServer`. Do not
call `child.kill()` on the server. `npm run dev` runs Vite under npm and a
shell, so killing the child stops only npm and leaves Vite listening.

Each server runs in its own process group (taskkill `/T` on Windows), and
`stopServer` stops the whole tree. It also stops processes the server moved
out of its group, such as the hub's Pi auto-update `npm install`, and waits
for them to exit. If a script exits through Ctrl-C, SIGTERM, an uncaught error
or `process.exit` before stopping its servers, the harness stops them on exit.
Remove fixture directories with `removeTempDir`. It retries while files are
still being released and logs a warning if removal fails, so a failed cleanup
does not crash the run.

`npm run e2e:worktrees` starts an isolated hub and Studio to check worktree creation
from current edits, independent document state, local saving, standalone export,
close and reopen, portable history import, removal with retained history, merge
undo and redo, and cross-window ownership. It uses the real editor, WASM and
IndexedDB; the file picker uses an in-memory handle.
Chrome and the built WASM package are required. No provider credentials are needed.

## Agent tool latency

`npm run e2e:agent-tool-concurrency-bench` sends tool calls through a real
`mcp-stdio.mjs` child, the hub and Studio at concurrency 1, 4 and 8, and splits
each call into stages. `npm run e2e:agent-claude-live-bench` runs the real
`claude` CLI from the sidebar composer and reports per-call latency, model
requests per turn and whether parallel tool calls overlapped. It also records how
many paragraphs each turn rewrote, bolded or reformatted, so fewer requests can be
checked against the same work. It uses account quota.

Each turn is split into startup, and per model request: wait before the first
byte, thinking, tool-argument streaming and text. Failed tool calls are counted,
because each one costs another model request.

- `--followup="…"` sends a second message in the same chat and reports it separately.
- `--agent=codex` drives Codex through the same path. It reports turn time, tool
  calls and failed calls only.
- `--transcripts=<dir>` keeps the Claude session files, with tool arguments and
  results, for reading what a failed call sent.

Both start the hub with `RHWP_TOOL_TRACE=1`. The hub then writes one JSONL row
per tool call (`RHWP_TOOL_TRACE_FILE`, default `<work dir>/tool-trace.jsonl`),
and `mcp-stdio` and Studio add their own timestamps. Without the variable no
trace fields are sent.

For fixture setup and development prerequisites, see [CONTRIBUTING](../../../CONTRIBUTING.md).

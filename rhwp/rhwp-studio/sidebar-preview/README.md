# Sidebar design preview

The preview mounts `initAgentSidebar` from the application, including its CSS,
icons, fonts, menus, overlays, settings, and interaction handlers. There is no
second sidebar implementation to keep synchronized.

## Start

From the repository root, using Node 22.18 or newer:

```sh
npm --prefix rhwp/rhwp-studio ci  # first run only
npm run dev:sidebar
```

Open **http://127.0.0.1:7715**. Vite reloads when the imported sidebar or its styles
change. The server binds to localhost and reserves this port so the preview's
browser storage stays separate from Studio. It requires no Rust build, WASM,
Electron, agent hub, or credentials.

## Live UI audit

Open **http://127.0.0.1:7715/?audit=1** for a searchable checklist of sidebar
scenarios and production dialog/menu launchers. The **Scenes** tab covers
responses, rich Markdown, plan approval, questions, edit review, active subagents,
connection failures, each provider's setup, Browserbase, preferences, and history.
**Editor dialogs** opens production file, table, field, font, grid, and
merge-preparation dialogs with sample values.

Use **Previous / Next** and the reviewed checkboxes to track the audit. Checkmarks
persist in the current browser tab. Theme and sidebar width controls stay above
the navigation. Scene links preserve both values. **Fixture controls** exposes
manual playback and service controls. Active-turn fixtures stay running until
you press Stop.

The document canvas, ribbon, engine-dependent formatting/object dialogs, and
native file pickers are reviewed in the running Electron app. Changes to the
shared production components appear in both the app and this preview. Dialog
callbacks in this preview only report sample results.

If another worktree already owns port 7715, leave it running and use a separate
port: `npm --prefix rhwp/rhwp-studio run dev:sidebar -- --port 7716`, then open
`http://127.0.0.1:7716/?audit=1`. Each port has separate browser storage.

Run `npm run test:sidebar:audit` to open every named scene and dialog in a fresh
headless browser, check navigation/checklist persistence, and verify that no
external service or WASM requests occur. Representative screenshots are saved
under `sidebar-preview/artifacts/audit-*.png`.

The left controls belong to the preview. The right panel is the production
sidebar, starting at its normal 480px width. Drag its left edge to resize it;
the application's width limits and compact composer behavior still apply.
The focus-mode button shows a placeholder because this preview covers the sidebar;
`fullscreen=1` opens focus mode through the native menu's agent command instead.

## Useful URLs

Open **http://127.0.0.1:7715/?editor=1** to review the whole editor shell with
the production header, menus, toolbars, status bar, and sidebar. The production
menu and command palette controllers use fixture commands, so their keyboard and
focus behavior can be reviewed without the document engine. The page carries an
explicit fixture label; document rendering and command actions are samples.
Add `&theme=dark` or `&width=360`
for layout review at other settings. Fixture controls are hidden in this mode.

| URL suffix | Opens |
| --- | --- |
| `?scenario=plan` | Next submitted message produces an approval plan |
| `?scenario=question` | A question with selectable and free-text answers |
| `?scenario=review` | Streaming reply followed by accept/reject changes |
| `?scenario=fleet` | Tool activity and a subagent task |
| `?scenario=fleet&background=1` | A subagent that keeps running after its turn: its card stays in the dock, outside the turn fold, and lands below the fold when it finishes |
| `?scenario=tools&play=1` | A finished multi-tool turn folded into one summary row above the answer (`작업 … · 문단 3개 수정 · … · 오류 1`) |
| `?scenario=tools&play=1&hold=1`, then Stop | A stopped turn folded as `중단됨 · …` |
| `?scenario=chat&report=1&play=1` | A turn that writes its report and then calls one more tool (`update_todos`): the report is the turn's last prose and stays below the fold row, the trailing tool folds |
| `?scenario=error` | A failed turn: one network-failure notice with 다시 시도 (same as `&failure=network`); failed turns never fold |
| `?scenario=error&failure=auth` | Login notice (Claude/Codex) with 로그인; after the fixture login it shows 다시 연결됐어요 and 다시 시도 |
| `?scenario=error&failure=pi-auth` | Pi connection notice with 설정 열기 |
| `?scenario=error&failure=pi-setup` | Chat start refused because Pi setup is unfinished (`PI_NOT_CONFIGURED`): Pi connection notice with 설정 열기 and no Pi 로그인 필요 chip |
| `?scenario=error&failure=usage` | Usage-limit notice whose reset time comes from the quota report, with 리셋 후 이어서 and 사용량 보기 |
| `?scenario=error&failure=usage-soon` | Usage-limit notice resetting in 3 s; 리셋 후 이어서 sends by itself (the preview's clock grace is 0.5 s, the app's 30 s) |
| `?scenario=error&failure=credits` | OpenRouter credits notice with 사용량 보기 |
| `?scenario=error&failure=provider` | Provider overloaded or 5xx notice with 다시 시도 and 자세히 |
| `?scenario=error&failure=network` | Network failure notice with 다시 시도 |
| `?scenario=error&failure=exited` | CLI stopped mid-turn notice with 다시 시도 |
| `?scenario=error&failure=cleanup` | Previous process could not be cleaned up: no retry, asks for an app restart |
| `?scenario=error&failure=cli-missing` | CLI not found notice with 설정 열기 |
| `?scenario=error&failure=invalid` | Conversation too long for the model (invalid request) |
| `?scenario=error&failure=unknown` | Unclassified failure with 다시 시도 |
| `?scenario=error&failure=start` | Chat start failure (`AGENT_SPAWN_FAILED`); 다시 시도 restarts the session |
| `?scenario=error&failure=legacy` | An older hub's text-only failure, classified in Studio (login notice) |
| `?scenario=writer-busy` | A write refused because another chat of the document is editing it |
| `?scenario=interrupted` | A turn that reads the document and asks a question, then loses the agent hub (restart): the question card reads `만료됨 · 허브 재시작`, the fold `중단됨 · …`, and one row says `에이전트 허브가 다시 시작되어 작업이 중단됐어요` with **이어서 진행** — no failure notice, no green dot |
| `?scenario=interrupted&hold=1`, then type a follow-up and press Enter, then `sidebarPreview.askQuestion()` and `sidebarPreview.restartHub()` | The same cut-off with a queued follow-up: the queue holds as `허브 재시작 · 작업이 끊겨…` and the row says `대기 메시지 1개는 이어서 진행한 뒤 보내요`. **이어서 진행** sends `이어서 진행해 주세요.` (the agent also gets a `<turn_interrupted reason="hub-restart">` block, see `snapshot().messageTexts`), starts a new chat session first, and the queue drains when that turn ends |
| `?scenario=review&restore=later` | After **변경 수락**, hovering the request shows **이 작업 전으로 되돌리기**; it asks before discarding later edits, then puts the request back into the empty composer |
| `?scenario=review&restore=evicted` | The same action for a request whose checkpoint is gone: dimmed, and a click only explains why |
| `?scenario=chat&hold=1`, then type and press Enter while it runs | Follow-ups queue above the composer instead of stopping the turn; Ctrl/⌘+Enter sends one now |
| `?scenario=chat&play=1&hold=1&queue=2` | Two queued follow-ups while the reply is held |
| `?scenario=chat&play=1&hold=1&queue=2&queueHold=stopped` | The queue held after 중지, with its reason and 보내기 |
| `?scenario=chat&play=1&hold=1&queue=2&queueHold=gap` | The gap after a queued follow-up is sent at a normal end: the hub runs it but has not opened its turn yet. The mode chip and model pickers stay locked; switching chats now puts the message back at the head of that chat's queue, held as stopped |
| `?scenario=compaction` | A turn with an automatic context compaction divider |
| `?context=92` | Start the context meter at 92% (any 1–100) |
| `?page=settings` | Production settings panel |
| `?page=settings&fullscreen=1` | Settings inside the full-screen focus workspace |
| `?page=versions` | Production version graph |
| `?page=versions&history=branches` | Branching and merging history with colored graph lanes |
| `?services=setup&page=settings` | Uninstalled/unconfigured service fixtures |
| `?page=settings&quota=error` | Provider quota errors and unknown health bars in AI |
| `?page=settings&quota=empty` | Exhausted Codex quota and zero banked resets |
| `?page=settings&quota=refresh-error` | Manual refresh fails once, then succeeds on retry |
| `?initial-setup=1` | Production first-run setup (theme, models, fonts) with the talking hippo |
| `?initial-setup=deferred` | Setup postponed by a file launch: the `처음 설정` chip above the composer |
| `?theme=dark&width=360` | Dark theme and narrow sidebar |
| `?controls=0` | Hide preview controls for clean captures |
| `?reset=1` | Clear preview storage before mounting |
| `?chats=sample` | Restore sample chats across three documents and no document: one running (`작업 중`), one finished but unread (green dot), one awaiting review (`검토 대기`, 분기별 예산 표 합계 확인) and one cut off (`중단됨` red ring, 추진 일정 분기별로 나누기), with **확인 필요 3** under the rail toolbar and 3 on the chat-list button. 사업 개요 첫 문단 다듬기 restores a folded turn (`작업 2분 31초 · 문단 2개 수정 · 표 1개 읽음`) and 참석자 명단 표 만들기 an interrupted one (`중단됨 · 1분 12초 · 표 1개 추가`) |
| `?chats=engine-trap` | The sample chats plus the shown document's chat that an engine trap interrupted; it opens with `문서 엔진이 멈춰 작업이 중단됐어요` and **이어서 진행**, as the editor marks it after reopening documents |
| `?chats=sample`, then open 추진 일정 분기별로 나누기 | A turn the app cut off by restarting (stored sample): `앱이 다시 시작되어 작업이 중단됐어요` with **이어서 진행**, the question card `만료됨 · 앱 재시작` and one follow-up held as `앱 재시작 · …`. Set **Connection** to disconnected: the button is dimmed with `허브에 연결되면 이어서 진행할 수 있어요` |
| `?chats=sample&reload=lost` | A reload that lost the working chat's turn (no live hub session): startup settles it as `페이지를 새로 고쳐 작업이 중단됐어요` and its stored question draft becomes the card `만료됨 · 새로고침` |
| `?sessions=2&chats=sample` | A second live document (회의록) with its own sidebar and mock agent; its chats switch sidebars without stopping the other agent |
| `?parallel=1` | Several chats of one document: a new chat or another chat opened while the shown chat works gets its own sidebar and mock agent, and the busy agent keeps running |
| `?parallel=locked` | The first chat edits with a held reply and a second, new chat opens beside it, locked to 채팅 |
| `?parallel=1&scenario=review&hold=1`, play, open a new chat, then `sidebarPreview.chats[0].mock.finishTurn()` | The hidden chat ends with edits to review: its row shows `검토 대기`, the chat-list button counts 1, and a toast `{제목} — 검토할 변경이 있습니다` offers **열기**, which shows that chat |
| `?parallel=1&scenario=chat&hold=1`, play, open a new chat, then `sidebarPreview.chats[0].mock.failRunningTurn('auth')` | The hidden chat fails: a red ring with the short reason `로그인 필요` and a toast with the failure title |
| `?attention=away&…` | The ledger behaves as if the window had no focus: notices for hidden chats go to the system sink (`알림: {제목} — {본문}` in the status line, `sidebarPreview.attentionNotices`) instead of toasts. By default a system notice is `HamaEditor — 작업이 중단됐습니다`: the app name and the fixed phrase, no chat title or document name |
| `?attention=away&notificationDetails=1&…` | The same with **알림에 채팅 제목과 문서 이름 표시** on: `{채팅 제목} — 작업이 중단됐습니다 · 사업 제안서.hwpx` |
| `?notifications=granted&page=settings&destination=ai` | 설정 → AI → **알림** with the **백그라운드 채팅 알림** switch and the **알림에 채팅 제목과 문서 이름 표시** switch (off by default), shown on the web only when the site already has notification permission |
| `?scenario=chat&play=1&hold=1&questionHeld=1` | A question that arrived while the composer had focus and text: the one-line 에이전트가 질문했어요 strip. Click it, or move focus out of the composer, to open the question |
| `?editor=1&scenario=chat&hold=1` | Editor shell with a labeled document input fixture (`textarea[data-rhwp-editor-input]`) for typing "in the document" |
| `?connection=disconnected` | The offline dot and the read-only composer lock, shown after the 400 ms status delay |
| `?chats=sample&reload=running` | Reload with the agent still working: the 사업 제안서 chat is re-adopted, not restarted (Stop stays available) |
| `?chats=sample&reload=question` | Reload with a pending question: the draft comes back at step 2/2 with its typed `직접 입력` answer |
| `?chats=sample&reload=ended` | The working chat's turn finished while the page reloaded: the hub replays that turn-end before its welcome, and the restored chat folds it as completed (nothing lands on the startup draft) |
| `?chats=sample&reload=failed` | The same with a failed turn: the restored chat keeps one failure notice, the startup draft stays empty |
| `?chats=sample&reload=ended-error` | The hub replays the turn's provider error and then a turn-end without a failure: the replayed error still counts, so the turn settles as failed (no completed fold) next to its notice |
| `?chats=sample&reload=failed&document=empty` | The failed turn's chat is not re-adopted (its document is not open): the notice is stored in that chat, its queue is held with the failure reason and the chat list shows it failed (`연결 실패`) |
| `?scenario=interrupted`, play, wait for the restart | A hub restart cut the turn off. Pressing **이어서 진행** starts the new session with the conversation so far (`sidebarPreview.snapshot().chatStarts.at(-1).history` holds the interrupted request). Typing a message instead also carries the block and releases the queue held by the interruption. With `sidebarPreview.rejectNextMessage('AGENT_AUTH_REQUIRED')` first, the refused continuation reopens the row |
| `?scenario=plan`, approve, then `sidebarPreview.restartHub()` while it runs | A plan implementation cut off by a hub restart: the row adds `이어서 진행하면 남은 작업의 계획을 다시 세워 승인을 받아요`, and the continuation asks the agent for a plan of the remaining steps (the hub does not carry the approval into a new session) |
| `?scenario=plan&hold=1`, play, queue a message, `sidebarPreview.finishTurn()`, then approve | Plan feedback queued before approval stays held after approval, with `계획을 다듬는 동안 쓴 메시지라 저절로 보내지 않았어요` instead of the approval-wait line |
| `?chats=sample&reload=running&document=empty` | The running chat's document is not open yet: events streamed meanwhile (`sidebarPreview.streamEvent(…)`) are held, and drawn when **Document** switches to 사업 제안서 and the chat is re-adopted |
| `?reload=running` (after a `chats=sample&reload=running` visit) | Reload without re-seeding the chats: follow-ups queued before the reload stay queued and released, and the adopted turn's normal end sends the next one |

Parameters can be combined. Select **Next reply**, then type a message or press
**Play sample conversation**. Connection and service controls expose disconnected,
reconnecting, replaced-session, and setup screens without waiting for real failures.
With **Next reply** set to `Error`, **실패 유형** picks which provider failure the turn
ends with; the mock sends the same classified failure on both the `error` and the
`turn-end` event, and the production collector folds them into one notice.
`node sidebar-preview/failures.check.mjs` opens every kind, exercises 로그인, 다시 시도,
dismissal across a chat switch and a reload, and 리셋 후 이어서 / 취소, and saves
`artifacts/failure-*.png`.

Transient statuses are delayed like the app: the connection dot, the composer's lock
(read-only, so focus and IME composition survive) and the "편집 중…" ring appear only
after 400 ms and then stay at least 400 ms; the rail shows 작업 중 400 ms after a turn
starts. Screenshots of those states must wait for them. Automation reads composer
readiness from `#agent-sidebar[data-composer-ready="true"]`, which follows the real
state without the delay; `.ag-input` is no longer `disabled` while connecting or starting.

A question that arrives while the user types (in the composer, the document or any
other text field) waits as a strip until the user pauses for 1.5 s, leaves the text
field, presses Enter or clicks the strip. A Hangul syllable still composing in the
composer keeps it waiting past the pause (the card would take the composer over); one
composing in the document or another field does not, since the card leaves the focus
there. Only real (trusted) keystrokes count, so page scripts cannot hold it;
`questionHeld=1` uses a fixture that holds the typing state.
From the console, `sidebarPreview.askQuestion()` asks the sample question on the running
turn (use `hold=1`), and `sidebarPreview.setChatStartDelay(ms)` and
`sidebarPreview.setStageDelay(ms)` slow a chat start or an attachment upload.

## Interrupted turns

A turn whose end Studio never heard — the agent hub restarted, the app restarted, the
page reloaded, the chat's agent session vanished, or the document engine stopped — is
marked where it stopped: its fold reads `중단됨 · …` and one system row below it says why,
with **이어서 진행** on the chat's latest interruption. The button sends
`이어서 진행해 주세요.`; the request also carries a `<turn_interrupted reason="…">` block
telling the agent to re-read the document before editing again. Whatever the user sends
first after an interruption (typed, queued or retried) carries the same block once.
Queued follow-ups stay held with the reason until then. The mock exposes
`sidebarPreview.restartHub()` to cut the running turn.

`node rhwp/rhwp-studio/sidebar-preview/interruption.check.mjs` covers the live hub restart,
resuming, a typed send after an interruption, a user stop (no row, no dot), the stored app
restart, the reload startup path and the engine-trap chat, and saves
`interrupted-live.png`, `interrupted-restored.png` and `interrupted-reload.png` to
`sidebar-preview/artifacts/`. `node rhwp/rhwp-studio/sidebar-preview/adoption.check.mjs` covers
the re-adoption edges: a turn-end the hub replays before its welcome (completed and failed),
events that arrive before the chat is bound, a turn whose end was never replayed
(`sidebarPreview.loseTurnEnd()`), and a late end of the adopted turn after another chat opened
(`sidebarPreview.setLateTurnEnd(true)`).

## Turn fold

When a turn settles, its milestones, tool groups and settled subagent cards fold into
one summary row above the final answer, such as `작업 2분 31초 · 문단 5개 수정 · 표 1개 읽음`.
The answer, questions, plans and system lines (errors included) stay in the flow. A
completed turn with no final answer after its last tool keeps its last milestone (its
report) in the flow and folds only the work around it. A
turn that ended in an error never folds, and a turn still running when the page
reloads stays unfolded until it settles. Restored chats fold the same way; chats saved
before turns were recorded fold by user message as `작업 내역 · …`. The row expands in
place and collapses again whenever the chat is re-rendered.

`node rhwp/rhwp-studio/sidebar-preview/turn-fold.check.mjs` covers the live, restored,
stopped, failed, subagent, scrolled-up and report-then-tool cases and saves `turn-fold.png`,
`turn-fold-open.png`, `turn-fold-interrupted.png` and `turn-fold-report.png` to
`sidebar-preview/artifacts/`.

## Background-chat attention

Each chat row shows whose turn it is: `입력 대기` (red dot) for a question or a plan awaiting
approval, `작업 중` (breathing yellow, 400 ms after the turn starts), `검토 대기` (agent-colored
dot) for staged edits, a red ring with a short reason (`오류`, `중단됨`, `로그인 필요`, `사용 한도` …)
for a failed or cut-off turn, and a green dot for a turn that finished while nobody watched it.
Seeing a chat (shown, window focused) clears its green dot and red ring; 입력 대기 and 검토 대기
stay until answered. When any chat needs attention, **확인 필요 N** appears under the rail toolbar
and filters the list without moving rows, and the chat-list button shows the count of other chats.
A hidden chat's question, review or failure shows a toast with **열기** when the window has focus;
an unfocused desktop window gets one OS notification per turn and state and an app-icon badge.
OS and browser notifications show the app name and a fixed phrase (`답변을 기다립니다`,
`검토할 변경이 있습니다`, `작업이 중단됐습니다`, the failure title, `작업을 마쳤습니다`) unless
**알림에 채팅 제목과 문서 이름 표시** is on; toasts inside the window always name the chat.

`node rhwp/rhwp-studio/sidebar-preview/attention.check.mjs` covers hidden review, failure and finish,
plan, question and stop, the chip filter, `attention=away` with and without chat details in system
notices, and the settings switches, and saves
`attention-rail.png`, `attention-filter.png`, `attention-toast.png` and `attention-settings.png`.
Inside the full harness it is the step selected by `SIDEBAR_CHECK=attention npm run test:sidebar`.

## Changes drawer

Open `?audit=1&auditScene=chat-changes-full` to inspect an applied full-access turn,
uncommitted paragraphs, table/image changes, and expandable commit history in the
production fullscreen drawer. The safe-mode change review scene keeps the same
paragraph diff rows with accept/reject actions. The drawer defaults to 560px and
retains its resize handle.

The full-access fixture emits the same finalized-then-approved lifecycle as the
editor. Browser checks cover commit, confirmed discard, top-entry undo, navigation,
long paragraphs, editing locks, stale document responses, and light/dark widths.
Latest-turn content is held in memory per thread; commits remain in the version
store. Historical diffs open the comparison view rather than using old paragraph
positions in the live document.

## Behavior and placeholders

### Live provider usage audit

Start a development agent hub from this checkout on an unused port, then enable the optional local transport:

```sh
RHWP_AGENT_PORT=5178 npm start
RHWP_SIDEBAR_LIVE_HUB=http://127.0.0.1:5178 npm run dev:sidebar
```

Open `http://127.0.0.1:7715/?page=settings&usage=live` and select **AI**. Usage, token history, and banked reset actions use the real hub; chat, document, and provider setup controls remain fixtures. Confirming a banked reset spends a real reset. The default URL continues to use samples. If the hub uses a custom development token, set `RHWP_SIDEBAR_HUB_TOKEN` on the preview server; hub credentials stay server-side.

The optional transport accepts only same-origin usage reads and Codex reset requests on loopback. It registers its own hub session and deletes that session when the preview server closes.

| Surface | Preview behavior |
| --- | --- |
| Chat | Real composer, provider/model/effort pickers, permissions, streaming Markdown, stop, tool details, question responses, and thread library |
| Plans and changes | Real approval/revision controls, pending change cards, accept/reject, and full-access behavior; document content is simulated |
| Skills | Search, edit files, create/validate/save/delete, enable/disable, and generated sample drafts |
| Templates | Upload metadata, rename, replace, delete, and select via `/templates`; document parsing is simulated |
| References | File picker/drop/paste UI, staged message attachments, scoped lists, filename search, and deletion; extraction returns sample metadata/snippets |
| Settings | Real editing preferences, draft/apply/cancel, themes, model defaults, app instructions, and sample writing-style calibration |
| Connections | Provider install/login, direct quota health bars, manual refresh, Codex banked reset confirmation, and model catalogs; provider credentials are never used by mocks |
| Versions | Graph, commit titles, checkpoints, restore/adopt metadata, branches, worktree create/open/close/remove, tags, shelves, and sample merges |
| External/document actions | Local notice for browser pages, linked documents, full-workspace focus mode, and document comparisons |

Service fixtures are in memory and reset on reload. The production preference and
thread stores persist on the preview's origin. **Reset preview data** clears those
stores too; close other preview tabs first. Real application data is on its own
origin and is unaffected.

## Edit and extend

- Edit `src/ui/agent-sidebar/` for designs intended to ship. Its production code is
  imported directly; changes appear here and in the app.
- For exploratory work, use an isolated Git branch/worktree. Make temporary style
  experiments in `src/sidebar-preview/preview.css` when they should remain preview-only.
- Add sample content in `src/sidebar-preview/fixtures.ts` and service behavior in
  `mock-bridge.ts` or `mock-versions.ts`. Keep application selectors/markup out of mocks.
- The mocks implement `SidebarBridge` and `VersionManagerController`. Changes to
  those interfaces must be reflected in the fixtures; avoid `any`, cast-throughs,
  or a catch-all proxy that would conceal an unimplemented service method.
- `window.sidebarPreview` exposes the typed bridge, version controller, event bus,
  scenario selector, and state snapshot for focused browser experiments.
  `finishTurn(stopReason, errorMessage?)` ends a held reply (or plays a hub-started turn's end),
  `failRunningTurn(kind)` ends it with a classified failure,
  `rejectNextMessage(code)` makes the hub refuse the next message,
  `setTurnStartDelay(ms)` delays the turn-start of an accepted message,
  `emitHubError(code, message, messageId?)` sends a hub refusal (a settings change mid-turn, for
  example), and `snapshot().messageTexts` / `sentMessages` list what reached the bridge.
  `sidebar-preview/queue.check.mjs` runs the follow-up queue checks on its own, including the gap
  after a queued send (screenshots `queue-gap-locked.png` and `queue-gap-switched.png`).

`vite.sidebar.config.ts` is independent of the application's Vite config. Keep it
free of the agent-hub and PWA plugins and imports of the application entry point.
The shared desktop module's optional PWA import resolves to a preview-only no-op.

The version graph uses compact rows. Dates appear on hover or keyboard focus;
selecting a commit keeps its details and restore actions below the scrolling list.
The branch buttons switch the active branch or open its owning worktree. The
워크트리 tab creates isolated sample branches, opens and closes them, preserves
branches on removal, and removes a worktree after its fixture merge succeeds.
These operations use in-memory document fixtures. New preview commits update
the same graph layout used by the application.

For LAN or Tailscale access, bind the preview explicitly:

```sh
npm --prefix rhwp/rhwp-studio run dev:sidebar -- --host 0.0.0.0
```

Open the host's IP address on port 7715. The preview bootstrap supports HTTP
origins where the browser does not expose `crypto.randomUUID()`.

## Verification

```sh
npm run test:sidebar
npm run build:sidebar
node rhwp/rhwp-studio/sidebar-preview/editor-shell.check.mjs
node rhwp/rhwp-studio/sidebar-preview/typing-guard.check.mjs
node rhwp/rhwp-studio/sidebar-preview/delayed-status.check.mjs
node rhwp/rhwp-studio/sidebar-preview/reload.check.mjs
node rhwp/rhwp-studio/sidebar-preview/attention.check.mjs
```

`SIDEBAR_CHECK=<text> npm run test:sidebar` runs only the harness steps whose name contains
`<text>` (case-insensitive), for example `SIDEBAR_CHECK=attention`.

`typing-guard.check.mjs` and `delayed-status.check.mjs` also run as steps of
`npm run test:sidebar` and in `tests/agent-composer-arrivals.browser.test.ts`. Run alone,
each starts its own server and browser like the full check.

`reload.check.mjs` also runs as a step of `npm run test:sidebar`. It opens both `reload=`
URLs, asserts that the fixture bridge saw no chat start, stop or interrupt, queues two
follow-ups and reloads to check they are released and sent one per normal turn end, and saves
`reload-running.png`, `reload-question.png` and `reload-queued.png`.

The browser check starts its own Vite server on an ephemeral port and launches a
fresh headless Chrome profile. It exercises the primary panels and mutations,
checks request isolation, and writes **sidebar-only PNGs** to
`sidebar-preview/artifacts/` (Git-ignored). Set `CHROME_PATH` if Chrome/Chromium is
not installed in a standard macOS/Linux location; this also supports Windows paths.
It does not connect to or control your normal browser.

The static build goes to `rhwp/rhwp-studio/dist-sidebar/`, separately from the
application build. For the repository-wide TypeScript check, run Studio's normal
`tsc` command after generating the application's WASM declarations. A checkout
without `rhwp/pkg/rhwp.d.ts` reports existing missing-WASM type errors even though
the sidebar preview runs and builds independently.

For a design review, also inspect keyboard focus, scroll behavior with long
content, and popovers at the sidebar width you plan to ship. Backend correctness
and document-renderer behavior remain covered by their application tests.


### OpenCode login terminal

Open the **OpenCode login terminal** audit scene to review the expanding login panel. The preview uses local terminal output: press Enter twice to finish the sample login, or cancel and choose API-key entry. The app uses the same UI with an owned PTY running `opencode auth login`; completion refreshes provider status automatically. Restart the desktop app after updating the hub to test the real login.

The terminal supports keyboard input, paste, resizing, browser links, cancellation, and restoration after a connection interruption. Raw terminal output is kept only in the owning login's memory, with bounded buffers. Credentials are staged and published through the existing authentication transaction after successful validation.


New Claude, Codex, Grok, Cursor, and OpenCode installs continue into the embedded login terminal. The hub advertises platform support; every provider including Claude on macOS can complete its login there, because Claude Code writes the staged profile's `.credentials.json` and a Keychain-only login is read back into it. Pi keeps its OpenRouter browser login. Provider connection status still refreshes automatically after login, and API-key entry remains available as a fallback.

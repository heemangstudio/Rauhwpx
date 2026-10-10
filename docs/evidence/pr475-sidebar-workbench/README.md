# Agent Focus workbench verification

Agent Focus adds Board, Changes, Subagents and PDF · Documents to the left navigation, plus a panel button at the top right that mirrors the chat list button. Each view opens in a tabbed panel beside the chat. The tab strip starts empty and holds only the views and documents opened in this session, and every tab can close. An empty panel shows a 작업 열기 list with B, C, S and P shortcuts; the + after the tabs brings it back. The normal document sidebar is unchanged.

## Real Studio and hub

Run `node e2e/sidebar-workbench.test.mjs --mode=headless` from `rhwp/rhwp-studio`. Set `RHWP_WORKBENCH_EVIDENCE_DIR` to this directory's absolute path to save evidence here.

The test starts its own Studio (Vite), an authenticated local hub and the built WASM engine. A controlled Pi fixture opens and ends the chat turn; the project service and workbench components follow their production paths.

- Agent Focus opens with its full View Transition. The test waits for the transition and the threads rail to settle before clicking the Board launcher.
- Alt+arrow moves the real project note on the board. A fresh project-service read returns the new column.
- Enter on the board card opens the note as a document tab. An unsaved draft survives switching to Board and back.
- Saving persists the note. A fresh hub read returns the exact draft text.
- No browser page errors occur. Both owned runtimes stop after the run.

`real-studio-results.json` records the assertions. `real-studio-board-persisted.png` and `real-studio-note-saved.png` show the real editor.

## Fixture-backed production sidebar

`sidebar-preview/workbench.check.mjs` runs inside `npm run test:sidebar` with local project and provider fixtures and the production UI.

- Normal sidebar: the workbench navigation, panel and tab strip stay hidden, and leaving Agent Focus restores the original sidebar size and the unsent draft.
- Layout: every view at 1440, 1280 and 840 px in light and dark themes (`focus-workbench-*`). Measured bounds are in `results.json`.
- Panel button: it opens an empty panel on the surface list with the first item focused. Letter shortcuts, arrow keys and + open views. The button closes the panel and reopens the last tab, and Escape returns to the composer (`workbench-launcher-empty`).
- Tabs: the strip starts empty, records opened views, and Delete closes tabs. Closing the last tab shows the surface list with its first item focused.
- Direct documents: a document opened from the board has no library tab. Closing it selects the neighbouring tab, and closing the last one shows the surface list instead of an untabbed library.
- Board: below 720 px the board becomes a compact list. Columns stack as foldable sections with one-line rows and tag dots, and no width overflows horizontally. Keyboard and pointer moves persist, a failed write rolls back, and moving a card into a folded section unfolds it (`workbench-board-*`).
- Documents: PDF tabs are reused per file, keep zoom and page, and a source clip reuses its PDF tab. Note drafts survive tab switches, and closing a dirty note asks first. A malformed PDF shows a retry that recovers (`workbench-document-*`).
- Subagents: streamed task records, failures, filters and stop are shown; a new draft chat starts with no tasks (`workbench-agents-*`).
- Changes: pending review and commit run from the panel, and the tab head carries the undo button for approved changes. The same review card stays in the changes drawer after the panel closes (`workbench-changes-*`). `sidebar-preview/changes.check.mjs` covers undo, history, commit and discard through this tab.

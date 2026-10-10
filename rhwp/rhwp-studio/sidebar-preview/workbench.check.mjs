import assert from 'node:assert/strict';

/** Fixture-backed production workbench UI; project/provider services are local samples. */
export async function checkWorkbench({ page, origin, screenshot }) {
  const layouts = [];
  const panel = '.ag-workbench-page:not([hidden])';
  const resource = '.ag-wdocs-panel:not([hidden])';
  async function open(query = '') {
    const params = new URLSearchParams('reset=1&controls=0&scenario=chat&width=400&fullscreen=1');
    for (const [key, value] of new URLSearchParams(query)) params.set(key, value);
    await page.goto(`${origin}/?${params}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
  }
  async function launch(view) {
    if (await page.$(`.ag-workbench-tabs [role="tab"][data-view="${view}"]`) && await page.$eval('.ag-workbench-page', node => node.checkVisibility())) {
      await page.click(`.ag-workbench-tabs [role="tab"][data-view="${view}"]`);
    } else {
      // 오른쪽 칸 단추로 칸을 열고 + 의 작업 목록에서 보기를 고른다.
      if (!await page.$eval('.ag-root', node => node.classList.contains('ag-workbench-open'))) await page.click('.ag-workspace-panel-btn');
      await page.click('.ag-workbench-add');
      await page.click(`.ag-workbench-launcher-item[data-view="${view}"]`);
    }
    await page.waitForSelector(`${panel} .ag-workbench-panel[data-view="${view}"]:not([hidden])`, { visible: true });
  }
  async function back() {
    await page.click('.ag-workspace-panel-btn[aria-expanded="true"]');
    await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-workbench-open'));
  }
  async function library() {
    await page.click('.ag-workbench-tabs [role="tab"][data-view="documents"]');
    await page.waitForSelector('.ag-wdocs-library:not([hidden])', { visible: true });
  }
  async function item(id) {
    await library();
    // 프로젝트 갱신이 자료 목록을 다시 그릴 수 있어 다시 찾아 누르는 locator를 쓴다.
    await page.locator(`.ag-wdocs-card[data-item-id="${id}"]`).click();
    await page.waitForSelector(`${resource} .ag-pp`, { visible: true });
    await page.waitForFunction((selector) => !document.querySelector(`${selector} .ag-pp-body`)?.hasAttribute('aria-busy'), {}, resource);
  }
  async function alt(key) {
    await page.keyboard.down('Alt');
    await page.keyboard.press(key);
    await page.keyboard.up('Alt');
  }

  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await open('fullscreen=0&theme=light');
  const normalSize = await page.$eval('.ag-root', node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
  assert.equal(await page.$('.ag-workbench-nav'), null, 'the chat rail has no workbench entries');
  assert.equal(await page.$eval('.ag-workbench-page', node => node.checkVisibility()), false);
  assert.equal(await page.$eval('.ag-workbench-head', node => node.checkVisibility()), false);
  await page.type('.ag-input', 'Focus transition draft');
  await page.evaluate(() => window.sidebarPreview.enterFocusMode());
  await launch('board');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-fullscreen'));
  assert.equal(await page.$eval('.ag-workbench-page', node => node.checkVisibility()), false);
  assert.equal(await page.$eval('.ag-input', node => node.value), 'Focus transition draft');
  const restoredSize = await page.$eval('.ag-root', node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }));
  assert(Math.abs(normalSize.width - restoredSize.width) <= 2 && Math.abs(normalSize.height - restoredSize.height) <= 2,
    'leaving Agent Focus restores the ordinary sidebar dimensions');
  await screenshot('normal-sidebar-restored');

  for (const theme of ['light', 'dark']) {
    for (const viewport of [1440, 1280, 840]) {
      await page.setViewport({ width: viewport, height: 1000, deviceScaleFactor: 1 });
      await open(`theme=${theme}`);
      await page.type('.ag-input', 'Keep this unsent draft');
      for (const view of ['board', 'changes', 'agents', 'documents']) {
        await launch(view);
        const bounds = await page.$eval(panel, node => {
          const rect = node.getBoundingClientRect();
          return { width: rect.width, height: rect.height, overflow: node.scrollWidth - node.clientWidth };
        });
        layouts.push({ theme, viewport, view, ...bounds });
        assert(bounds.width >= 280 && bounds.height > 200, `${view} has usable ${theme}/${viewport} bounds`);
        assert(bounds.overflow <= 2, `${view} outer surface overflows ${theme}/${viewport}`);
        if (view === 'board') {
          const board = await page.$eval('.ag-workbench-board .ag-pboard', node => node.scrollWidth - node.clientWidth);
          assert(board <= 1, `the side-panel board fits without horizontal scrolling at ${theme}/${viewport}`);
        }
        assert.equal(await page.$eval('.ag-chat-page', node => node.inert), false);
        assert.equal(await page.$eval('.ag-chat-page', node => node.checkVisibility()), true);
        assert.equal(await page.$eval('.ag-input', node => node.value), 'Keep this unsent draft');
        await screenshot(`focus-workbench-${view}-${theme}-${viewport}`);
      }
      await back();
      assert.equal(await page.$eval('.ag-input', node => node.value), 'Keep this unsent draft');
    }
  }

  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await open('theme=light');
  assert.equal(await page.$$eval('.ag-workbench-tabs [role="tab"]', tabs => tabs.length), 0);
  // 오른쪽 칸 단추는 빈 칸에 작업 목록을 열고, 글자 단축키와 +로 보기를 연다.
  const launcherShown = () => page.waitForSelector(`${panel} .ag-workbench-launcher:not([hidden])`, { visible: true });
  const launcherFocused = () => page.$eval('.ag-workbench-launcher-item', node => node === document.activeElement);
  await page.click('.ag-workspace-panel-btn');
  await launcherShown();
  assert.equal(await launcherFocused(), true, 'the empty panel focuses its first surface');
  await screenshot('workbench-launcher-empty');
  await page.keyboard.press('KeyS');
  await page.waitForSelector(`${panel} .ag-workbench-panel[data-view="agents"]:not([hidden])`, { visible: true });
  await page.click('.ag-workbench-add');
  await launcherShown();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${panel} .ag-workbench-panel[data-view="changes"]:not([hidden])`, { visible: true });
  assert.deepEqual(await page.$$eval('.ag-workbench-tabs [role="tab"]', tabs => tabs.map(tab => tab.dataset.view)), ['agents', 'changes']);
  await back();
  await page.click('.ag-workspace-panel-btn');
  await page.waitForSelector(`${panel} .ag-workbench-panel[data-view="changes"]:not([hidden])`, { visible: true });
  await page.focus('.ag-workbench-tabs [role="tab"][data-view="changes"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.ag-root').classList.contains('ag-workbench-open'));
  assert.equal(await page.$eval('.ag-input', node => node === document.activeElement), true, 'Escape in the panel returns to the composer');
  await open('theme=light');
  await launch('board');
  assert.equal(await page.$$eval('.ag-workbench-tabs [role="tab"]', tabs => tabs.length), 1);
  await launch('agents');
  await launch('board');
  assert.equal(await page.$$eval('.ag-workbench-tabs [role="tab"]', tabs => tabs.length), 2);
  // 탭은 마우스로 끌어 순서를 바꾸고, Alt+화살표로도 옮긴다. 끄는 중 Esc는 원래 순서로 돌린다.
  const tabOrder = () => page.$$eval('.ag-workbench-tabs [role="tab"]', tabs => tabs.map(tab => tab.dataset.view));
  const tabBox = async view => (await page.$(`.ag-workbench-tabs [data-view="${view}"]`)).boundingBox();
  assert.deepEqual(await tabOrder(), ['board', 'agents']);
  let grab = await tabBox('agents');
  const drop = await tabBox('board');
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(drop.x + 6, drop.y + drop.height / 2, { steps: 10 });
  await page.mouse.up();
  assert.deepEqual(await tabOrder(), ['agents', 'board'], 'dragging a tab reorders the strip');
  await page.focus('.ag-workbench-tabs [role="tab"][data-view="agents"]');
  await alt('ArrowRight');
  assert.deepEqual(await tabOrder(), ['board', 'agents'], 'Alt+arrow moves the focused tab');
  grab = await tabBox('agents');
  await page.mouse.move(grab.x + grab.width / 2, grab.y + grab.height / 2);
  await page.mouse.down();
  await page.mouse.move(drop.x + 6, drop.y + drop.height / 2, { steps: 10 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.deepEqual(await tabOrder(), ['board', 'agents'], 'Escape cancels a drag');
  assert.equal(await page.$eval('.ag-root', node => node.classList.contains('ag-workbench-open')), true);
  await page.focus('.ag-workbench-tabs [role="tab"][data-view="board"]');
  await page.keyboard.press('Delete');
  await page.waitForSelector('.ag-workbench-tabs [data-view="agents"][aria-selected="true"]');
  await page.keyboard.press('Delete');
  await launcherShown();
  assert.equal(await launcherFocused(), true, 'closing the last tab leaves the surface list focused');
  // 보드에서 바로 연 자료에는 자료 목록 탭이 없다. 닫으면 옆 탭으로, 마지막이면 작업 목록으로 간다.
  await launch('board');
  const boardCard = '.ag-workbench-board .ag-pcard[data-item="fa2k7q"]';
  const openFromBoard = async () => {
    await page.waitForSelector(boardCard, { visible: true });
    await page.focus(boardCard);
    await page.keyboard.press('Enter');
    await page.waitForSelector('.ag-workbench-tabs [data-resource-id][aria-selected="true"]');
  };
  const tabState = () => page.$$eval('.ag-workbench-tabs [role="tab"]', tabs => tabs.map(tab => `${tab.dataset.view ?? 'resource'}:${tab.getAttribute('aria-selected')}`));
  await openFromBoard();
  await page.focus('.ag-workbench-tabs [data-resource-id]');
  await page.keyboard.press('Delete');
  await page.waitForSelector(`${panel} .ag-workbench-panel[data-view="board"]:not([hidden])`, { visible: true });
  assert.deepEqual(await tabState(), ['board:true'], 'closing a direct resource selects the remaining board tab');
  await openFromBoard();
  await page.focus('.ag-workbench-tabs [data-view="board"]');
  await page.keyboard.press('Delete');
  assert.deepEqual(await tabState(), ['resource:true']);
  await page.focus('.ag-workbench-tabs [data-resource-id]');
  await page.keyboard.press('Delete');
  await launcherShown();
  assert.equal(await page.$eval('.ag-wdocs-library', node => node.checkVisibility()), false, 'no library is left without a tab');
  assert.equal(await launcherFocused(), true, 'closing the last direct resource shows the surface list');
  await launch('board');
  await page.waitForSelector('.ag-workbench-board .ag-pcard[data-item="fa2k7q"]');
  const readItem = id => page.evaluate(key => window.sidebarPreview.projects.store.get().items.find(item => item.id === key), id);
  const before = await readItem('fa2k7q');
  await page.focus('.ag-workbench-board .ag-pcard[data-item="fa2k7q"]');
  await alt('ArrowLeft');
  await page.waitForFunction(id => window.sidebarPreview.projects.store.get().items.find(item => item.id === id).column !== 'key', {}, 'fa2k7q');
  const moved = await readItem('fa2k7q');
  assert.notEqual(moved.column, before.column, 'Alt+arrow moves the actual project item');
  // 좁은 칸의 열 묶음은 접히고, 접힌 열로 옮긴 카드는 그 열을 다시 펴서 초점을 지킨다.
  const keyColumn = '.ag-workbench-board .ag-pboard-col[data-column="key"]';
  await page.click(`${keyColumn} .ag-pboard-col-toggle`);
  assert.equal(await page.$eval(`${keyColumn} .ag-pboard-cards`, node => node.checkVisibility()), false, 'a folded section hides its rows');
  assert.equal(await page.$eval(`${keyColumn} .ag-pboard-col-toggle`, node => node.getAttribute('aria-expanded')), 'false');
  await page.focus('.ag-workbench-board .ag-pcard[data-item="fa2k7q"]');
  await alt('ArrowRight');
  await page.waitForFunction(id => window.sidebarPreview.projects.store.get().items.find(item => item.id === id).column === 'key', {}, 'fa2k7q');
  await page.waitForFunction(selector => document.querySelector(`${selector} .ag-pboard-cards`).checkVisibility()
    && document.activeElement?.dataset.item === 'fa2k7q', {}, keyColumn);
  await screenshot('workbench-board-compact');
  await alt('ArrowLeft');
  await page.waitForFunction((id, column) => window.sidebarPreview.projects.store.get().items.find(item => item.id === id).column === column, {}, 'fa2k7q', moved.column);
  await back();
  await launch('board');
  assert.equal((await readItem('fa2k7q')).column, moved.column, 'board changes survive workbench navigation');
  await page.evaluate(async () => window.sidebarPreview.projects.store.refresh());
  assert.equal((await readItem('fa2k7q')).column, moved.column, 'the project service persists board movement');

  const card = await page.$('.ag-workbench-board .ag-pcard[data-item="fa2k7q"]');
  await card.scrollIntoView();
  const target = await page.$('.ag-workbench-board .ag-pboard-col[data-column="inbox"] .ag-pboard-col-head');
  await target.scrollIntoView();
  const from = await card.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + 20);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height + 25, { steps: 16 });
  await page.mouse.up();
  await page.waitForFunction(() => window.sidebarPreview.projects.store.get().items.find(item => item.id === 'fa2k7q').column === 'inbox');
  await screenshot('workbench-board-persisted-drag');
  await page.evaluate(() => {
    const service = window.sidebarPreview.projects.service;
    const original = service.applyOps;
    service.applyOps = async (...args) => {
      service.applyOps = original;
      throw new Error('Fixture board write failed');
    };
  });
  await page.focus('.ag-workbench-board .ag-pcard[data-item="fa2k7q"]');
  await alt('ArrowRight');
  await page.waitForSelector('.ag-workbench-board .ag-project-status.ag-error');
  assert.equal((await readItem('fa2k7q')).column, 'inbox', 'a failed project write rolls back optimistic board movement');
  await screenshot('workbench-board-failed-move-rollback');

  await launch('documents');
  await item('fq7k2m4');
  await page.waitForSelector(`${resource} .ag-pdf-canvas`);
  const pdfWidth = () => page.$eval(`${resource} .ag-pdf-page`, node => node.getBoundingClientRect().width);
  const initialWidth = await pdfWidth();
  await page.click(`${resource} [aria-label="확대"]`);
  await page.waitForFunction((width, selector) => document.querySelector(`${selector} .ag-pdf-page`).getBoundingClientRect().width > width + 5, {}, initialWidth, resource);
  const zoomedWidth = await pdfWidth();
  await item('fs4cann');
  await page.waitForSelector(`${resource} .ag-pdf-canvas`);
  assert.equal(await page.$$eval('.ag-workbench-tabs [data-resource-id]', rows => rows.length), 2);
  await item('fq7k2m4');
  assert.equal(await page.$$eval('.ag-workbench-tabs [data-resource-id]', rows => rows.length), 2, 'opening the same PDF reuses its tab');
  assert(Math.abs(await pdfWidth() - zoomedWidth) < 2, 'PDF zoom remains independent across tabs');
  await screenshot('workbench-document-pdf-tabs');
  await item('fs4cann');
  await page.click(`${resource} [aria-label="확대"]`);
  const clipZoomWidth = await pdfWidth();
  await page.click('.ag-workbench-tabs [role="tab"][data-view="board"]');
  await page.focus('.ag-workbench-board .ag-pcard[data-item="rt4b2xy"]');
  await page.keyboard.press('Enter');
  await page.waitForSelector(`${resource} .ag-pdf-canvas`);
  assert.equal(await page.$$eval('.ag-workbench-tabs [data-resource-id]', rows => rows.length), 2,
    'opening a source clip reuses its PDF resource tab');
  assert(Math.abs(await pdfWidth() - clipZoomWidth) < 2, 'revealing a clip keeps the PDF zoom');
  await page.waitForFunction(selector => document.querySelector(`${selector} .ag-pp-meta`)?.textContent.startsWith('2 /'), {}, resource);
  await item('fq7k2m4');
  await item('fs4cann');
  await page.waitForFunction(selector => document.querySelector(`${selector} .ag-pp-meta`)?.textContent.startsWith('2 /'), {}, resource);
  await screenshot('workbench-document-clip-page-retained');

  // The focus right pane keeps open surfaces and document resources in one strip.
  await back();
  await launch('board');
  await launch('changes');
  await launch('agents');
  await launch('documents');
  await page.waitForFunction(() => {
    const strip = document.querySelector('.ag-workbench-tabs');
    return strip.scrollWidth > strip.clientWidth;
  });
  const tabStrip = await page.$('.ag-workbench-tabs');
  const stripBox = await tabStrip.boundingBox();
  await page.evaluate(() => { document.querySelector('.ag-workbench-tabs').scrollLeft = 0; });
  await page.mouse.move(stripBox.x + stripBox.width / 2, stripBox.y + stripBox.height / 2);
  await page.mouse.wheel({ deltaY: 220 });
  await page.waitForFunction(() => document.querySelector('.ag-workbench-tabs').scrollLeft > 0);
  await page.focus('.ag-workbench-tabs [role="tab"][aria-selected="true"]');
  await page.keyboard.press('Home');
  await page.keyboard.press('End');
  await page.waitForFunction(() => {
    const tab = document.querySelector('.ag-workbench-tabs [role="tab"][aria-selected="true"]');
    const strip = document.querySelector('.ag-workbench-tabs');
    const a = tab.getBoundingClientRect(); const b = strip.getBoundingClientRect();
    return tab === document.activeElement && a.left >= b.left - 2 && a.right <= b.right + 2;
  });
  const lastResource = await page.$eval('.ag-workbench-tabs [role="tab"][aria-selected="true"]', node => node.dataset.resourceId);
  // End 로 연 탭을 보이게 맞추는 프레임이 끝난 뒤에 손으로 스크롤한다.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.evaluate(() => { document.querySelector('.ag-workbench-tabs').scrollLeft = 0; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.$eval('.ag-workbench-tabs', node => node.scrollLeft), 0,
    'manual scrolling left keeps earlier tabs reachable');
  assert.equal(await page.$eval('.ag-workbench-tabs [role="tab"][aria-selected="true"]', node => node.dataset.resourceId), lastResource,
    'scrolling the strip does not change the active document');
  await screenshot('workbench-unified-tabs-narrow-scroll');
  await item('n5r2c7d');
  await page.click(`${resource} [aria-label="노트 편집"]`);
  await page.type(`${resource} .ag-pp-note-editor`, '\nRetained workbench draft');
  const draft = await page.$eval(`${resource} .ag-pp-note-editor`, node => node.value);
  await item('fq7k2m4');
  await item('n5r2c7d');
  assert.equal(await page.$eval(`${resource} .ag-pp-note-editor`, node => node.value), draft);
  await page.click('.ag-workbench-tabs [role="tab"][data-view="board"]');
  await page.click('.ag-workbench-tab-row.ag-dirty .ag-workbench-tab-close');
  await page.waitForSelector('.ag-wdocs-notice:not([hidden]) [aria-label="노트 계속 편집"]', { visible: true });
  assert.equal(await page.$eval('.ag-workbench-panel[data-view="documents"]', node => node.checkVisibility()), true,
    'closing a dirty resource from Board exposes its note confirmation');
  const tabsBeforeCancel = await page.$$eval('.ag-workbench-tabs [data-resource-id]', rows => rows.length);
  await page.click('[aria-label="노트 계속 편집"]');
  assert.equal(await page.$$eval('.ag-workbench-tabs [data-resource-id]', rows => rows.length), tabsBeforeCancel);
  assert.equal(await page.$eval(`${resource} .ag-pp-note-editor`, node => node.value), draft);
  await screenshot('workbench-document-retained-note');
  await page.click('.ag-workbench-tab-row.ag-dirty .ag-workbench-tab-close');
  await page.click('[aria-label="변경 버리고 닫기"]');
  assert.equal(await page.$$eval('.ag-workbench-tabs [data-resource-id]', rows => rows.length), tabsBeforeCancel - 1);
  await page.focus('.ag-workbench-tabs [role="tab"][aria-selected="true"]');
  await page.keyboard.press('Delete');
  assert.equal(await page.$$eval('.ag-workbench-tabs [data-resource-id]', rows => rows.length), tabsBeforeCancel - 2);
  await page.waitForFunction(() => document.querySelector('.ag-workbench-tabs [role="tab"][aria-selected="true"]') === document.activeElement,
    { timeout: 3000 }).catch(async () => { throw new Error('Adjacent close focus: ' + await page.evaluate(() => JSON.stringify({ tag: document.activeElement?.tagName, className: document.activeElement?.className })) + JSON.stringify(await tabState())); });
  await item('fo4a5d');
  await page.waitForSelector(`${resource} [aria-label="다시 열기"]`);
  assert.equal(await page.$(`${resource} .ag-pdf-canvas`), null, 'invalid sample PDF does not impersonate a loaded document');
  await screenshot('workbench-document-load-failure');
  await page.evaluate(() => {
    const service = window.sidebarPreview.projects.service;
    const original = service.fileBlob.bind(service);
    service.fileBlob = (projectId, itemId) => original(projectId, itemId === 'fo4a5d' ? 'fq7k2m4' : itemId);
  });
  await page.click(`${resource} [aria-label="다시 열기"]`);
  await page.waitForSelector(`${resource} .ag-pdf-canvas`);
  await screenshot('workbench-document-load-retry');

  await open('scenario=fleet&hold=1&theme=dark&width=400');
  await page.type('.ag-input', 'Run scoped helper tasks');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  await launch('agents');
  await page.waitForSelector('.ag-workbench-agent-card[data-status="running"]');
  await page.evaluate(() => window.sidebarPreview.streamEvent({ type: 'task-start', agent: 'claude', taskId: 'workbench-test',
    title: 'Scoped task evidence', role: 'review', taskKind: 'agent' }));
  await page.waitForSelector('.ag-workbench-agent-card[data-task-id="workbench-test"]');
  await page.evaluate(() => {
    const preview = window.sidebarPreview;
    preview.streamEvent({ type: 'tool-call', agent: 'claude', parentTaskId: 'workbench-test', callId: 'wb-tool', tool: 'read_document', argsJson: '{}' });
    preview.streamEvent({ type: 'tool-result', agent: 'claude', parentTaskId: 'workbench-test', callId: 'wb-tool', ok: false, resultPreview: 'Fixture tool failure' });
    preview.streamEvent({ type: 'task-end', agent: 'claude', taskId: 'workbench-test', status: 'failed', summary: 'Visible task failure' });
  });
  await page.waitForSelector('.ag-workbench-agent-card[data-task-id="workbench-test"][data-status="failed"]');
  await page.click('.ag-workbench-agent-card[data-task-id="workbench-test"] .ag-workbench-agent-toggle');
  await page.waitForSelector('.ag-workbench-agent-tool[data-call-id="wb-tool"]');
  await page.click('.ag-workbench-agents-filter[data-filter="running"]');
  assert.equal(await page.$eval('.ag-workbench-agent-card[data-task-id="workbench-test"]', node => node.checkVisibility()), false);
  await page.click('.ag-workbench-agents-filter[data-filter="finished"]');
  await page.waitForSelector('.ag-workbench-agent-card[data-task-id="workbench-test"]', { visible: true });
  await screenshot('workbench-agents-task-failure');
  await back();
  await page.click('.ag-stop');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
  await launch('agents');
  await page.click('.ag-workbench-agents-filter[data-filter="all"]');
  await page.waitForSelector('.ag-workbench-agent-card[data-status="stopped"]');
  await back();
  await page.evaluate(() => window.sidebarPreview.sidebar.startDraftChat());
  await launch('agents');
  assert.equal(await page.$('.ag-workbench-agent-card'), null, 'a new draft inherits no previous task records');
  await screenshot('workbench-agents-draft-empty');

  await open('scenario=review&review=full&theme=light&width=400');
  await page.type('.ag-input', 'Make changes for review');
  await page.click('.ag-send');
  await page.waitForSelector('.ag-review-card .ag-approve');
  await launch('changes');
  await page.waitForSelector(`${panel} .ag-review-card .ag-approve`);
  await screenshot('workbench-changes-pending-review');
  await back();
  // Agent Focus keeps the pending review in the changes drawer; the next open must find the same card.
  await page.waitForSelector('.ag-changes-review-slot .ag-review-card .ag-approve');
  await launch('changes');
  await page.click(`${panel} .ag-review-card .ag-approve`);
  await page.waitForFunction(() => window.sidebarPreview.snapshot().pendingChanges === 0);
  if (await page.$('.rhwp-toast-close')) {
    await page.click('.rhwp-toast-close');
    await page.waitForSelector('.rhwp-toast', { hidden: true });
  }
  await page.type(`${panel} .ag-changes-message`, 'Workbench change commit');
  await page.click(`${panel} .ag-changes-primary`);
  await page.waitForFunction(() => window.sidebarPreview.versions.getState().dirty === false);
  assert.equal(await page.evaluate(() => window.sidebarPreview.versions.getState().commits[0].title), 'Workbench change commit');
  await screenshot('workbench-changes-committed');
  // 변경 사항 탭은 버전 창 전체를 담는다. 그래프에 새 커밋이 보이고 집중 화면은 그대로다.
  await page.evaluate(selector => [...document.querySelectorAll(`${selector} .ag-versions-tab`)].find(tab => tab.textContent.startsWith('그래프')).click(), panel);
  await page.waitForFunction(selector => document.querySelector(`${selector} .ag-version-row .ag-version-title`)?.textContent === 'Workbench change commit', {}, panel);
  assert.equal(await page.$eval('.ag-root', node => node.classList.contains('ag-fullscreen')), true);
  await screenshot('workbench-changes-graph');
  return { layouts, boardPersistence: true, boardPointerDrag: true, pdfTabReuse: true, pdfZoomRetained: true, pdfPageRetained: true, clipReusesSourceTab: true,
    noteDraftRetained: true, dirtyCloseCancellation: true, keyboardCloseFocus: true, directResourceCloseFallback: true, panelToggleAndLauncher: true, tabDragReorder: true, compactBoardSections: true, malformedPdfRetry: true,
    taskFailureAndCancellation: true, draftTaskIsolation: true, changeReviewAndCommit: true, versionManagerInPanel: true };
}

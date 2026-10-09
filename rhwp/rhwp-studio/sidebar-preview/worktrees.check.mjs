import assert from 'node:assert/strict';

/** Fixture-backed checks exercise the production worktree page and its controller calls. */
export async function checkWorktrees({ page, open, screenshot }) {
  await open('page=versions&width=360&theme=light');
  await page.click('[data-tab="worktrees"]');
  const create = async (source, name) => {
    await page.click('[aria-label="워크트리 만들기"]');
    await page.waitForSelector('select.ag-version-prompt-input', { visible: true });
    await page.select('select.ag-version-prompt-input', source);
    await page.click('.ag-version-prompt button[type="submit"]');
    if (name) {
      await page.waitForSelector('input.ag-version-prompt-input', { visible: true });
      await page.$eval('input.ag-version-prompt-input', (input) => { input.value = ''; });
      await page.type('input.ag-version-prompt-input', name);
      await page.click('.ag-version-prompt button[type="submit"]');
    }
    await page.waitForFunction((branch) => window.sidebarPreview.versions.getState().worktrees.some((item) => item.branch === branch), {}, name ?? source);
  };
  await create('main', '초안-작업');
  assert.equal(await page.$('[aria-label="main 워크트리 삭제"]'), null, 'Primary worktree must be protected');
  await page.click('[aria-label="워크트리 만들기"]');
  await page.waitForSelector('select.ag-version-prompt-input', { visible: true });
  await page.click('.ag-version-prompt button[type="submit"]');
  await page.waitForSelector('input.ag-version-prompt-input', { visible: true });
  await page.$eval('input.ag-version-prompt-input', (input) => { input.value = '초안-작업'; });
  await page.click('.ag-version-prompt button[type="submit"]');
  await page.waitForFunction(() => document.querySelector('.ag-versions-notice')?.dataset.kind === 'error');
  assert.equal(await page.evaluate(() => window.sidebarPreview.versions.getState().worktrees.length), 2, 'Failed creation must preserve existing worktrees');
  await page.click('.ag-versions-worktrees [aria-label="초안-작업 워크트리 열기"]');
  await page.waitForFunction(() => window.sidebarPreview.versions.getState().activeBranch === '초안-작업');
  await screenshot('worktrees-light-narrow');
  assert(await page.$eval('.ag-versions-page', (node) => node.scrollWidth <= node.clientWidth), 'Worktree page overflows at narrow width');
  await page.click('.ag-versions-worktrees [aria-label="초안-작업 워크트리 닫기"]');
  await page.waitForFunction(() => window.sidebarPreview.versions.getState().activeBranch === 'main');
  await page.click('.ag-versions-worktrees [aria-label="초안-작업 워크트리 삭제"]');
  await page.waitForSelector('.ag-sheet-layer.ag-sheet-open .ag-sheet-cancel', { visible: true });
  await page.click('.ag-sheet-cancel');
  assert.equal(await page.evaluate(() => window.sidebarPreview.versions.getState().worktrees.length), 2, 'Cancelling removal must preserve the worktree');
  await page.click('.ag-versions-worktrees [aria-label="초안-작업 워크트리 삭제"]');
  await page.waitForSelector('.ag-sheet-layer.ag-sheet-open .ag-sheet-confirm', { visible: true });
  await page.click('.ag-sheet-confirm');
  await page.waitForFunction(() => window.sidebarPreview.versions.getState().worktrees.length === 1);
  assert(await page.evaluate(() => window.sidebarPreview.versions.getState().branches.some((branch) => branch.name === '초안-작업')), 'Removing a worktree must preserve its branch');
  await create('대안');
  await page.click('.ag-versions-worktrees [aria-label="대안 워크트리 병합 후 삭제"]');
  await page.waitForFunction(() => window.sidebarPreview.versions.getState().worktrees.length === 1);
  assert(await page.evaluate(() => window.sidebarPreview.versions.getState().commits[0].parentIds.length === 2), 'Merge must precede removal');
  await page.evaluate(async () => {
    const controller = window.sidebarPreview.versions;
    const state = controller.getState();
    const primary = state.worktrees.find((worktree) => worktree.primary);
    primary.readOnly = true;
    primary.busy = true;
    state.mutationBlockedReason = '다른 창에서 이 워크트리를 편집하고 있습니다.';
    state.worktrees.push({ id: 'remote-navigation', documentId: 'preview-proposal', branch: '초안-작업', primary: false, isCurrent: false, isOpen: true, busy: true });
    await controller.refresh();
  });
  assert.equal(await page.$eval('.ag-versions-worktrees [aria-label="main 워크트리 다시 열기"]', (button) => button.disabled), false, 'A read-only current worktree must allow reopening');
  assert.equal(await page.$eval('.ag-versions-worktrees [aria-label="초안-작업 워크트리 열기"]', (button) => button.disabled), false, 'Read-only and busy ownership must not block navigation');
  await page.click('.ag-versions-worktrees [aria-label="main 워크트리 다시 열기"]');
  await page.waitForFunction(() => !window.sidebarPreview.versions.getState().worktrees.find((worktree) => worktree.primary).readOnly);

}

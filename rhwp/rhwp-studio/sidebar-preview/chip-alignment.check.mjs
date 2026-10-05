import assert from 'node:assert/strict';

export async function checkChipAlignment(page, origin, screenshot) {
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 900, 600, 360]) {
      await page.setViewport({ width, height: 900 });
      await page.goto(`${origin}/?theme=${theme}&controls=0`, { waitUntil: 'networkidle0' });
      await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
      await page.evaluate(async () => {
        const preview = window.sidebarPreview;
        const statuses = await preview.bridge.requestAgentSetupStatus();
        for (const status of Object.values(statuses)) {
          status.authenticated = false;
          status.connected = false;
        }
        preview.boot();
        // The preview's focus button is a placeholder. Mount the production
        // fullscreen layout directly, keeping the real provider status chip.
        preview.sidebar.root.classList.add('ag-fullscreen');
        preview.sidebar.root.classList.toggle('ag-workspace-compact', window.innerWidth <= 960);
      });
      await page.waitForSelector('.ag-reconnect-chip', { visible: true });
      await new Promise((resolve) => setTimeout(resolve, 350));
      const bounds = await page.evaluate(() => {
        const chip = document.querySelector('.ag-reconnect-chip').getBoundingClientRect();
        const composer = document.querySelector('.ag-composer').getBoundingClientRect();
        return { chipLeft: chip.left, chipRight: chip.right, composerLeft: composer.left, composerRight: composer.right };
      });
      if (width === 1440 && theme === 'light' && screenshot) await screenshot(page);
      assert.ok(Math.abs(bounds.chipLeft - bounds.composerLeft) <= 1,
        `${theme} ${width}px: chip starts at ${bounds.chipLeft}, composer at ${bounds.composerLeft}`);
      assert.ok(bounds.chipRight <= bounds.composerRight + 1, `${theme} ${width}px: chip fits the composer column`);
    }
  }
  await page.setViewport({ width: 1280, height: 900 });
}

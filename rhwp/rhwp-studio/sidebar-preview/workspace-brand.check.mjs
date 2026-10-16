import assert from 'node:assert/strict';

export async function checkWorkspaceBrand(page, origin, screenshot) {
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.goto(`${origin}/?theme=light&reset=1&fullscreen=1&width=480`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && document.querySelector('.ag-root.ag-fullscreen'));

  async function captureTransition(label) {
    const samples = await page.evaluate(async () => {
      const root = document.querySelector('.ag-root');
      const brand = document.querySelector('.ag-workspace-brand');
      const lockup = brand.querySelector('.ag-workspace-brand-lockup');
      const values = [];
      const start = performance.now();
      while (performance.now() - start < 320) {
        const brandRect = brand.getBoundingClientRect();
        values.push({
          collapsed: root.classList.contains('ag-rail-collapsed'),
          brandWidth: brandRect.width,
          lockupWidth: lockup.getBoundingClientRect().width,
        });
        await new Promise(requestAnimationFrame);
      }
      return values;
    });

    assert.ok(samples.length > 5, `${label}: sampled animation frames`);
    for (const sample of samples) {
      assert.ok(sample.brandWidth + 1 >= sample.lockupWidth,
        `${label}: brand content fits (${sample.brandWidth.toFixed(1)}px box, ${sample.lockupWidth.toFixed(1)}px lockup)`);
    }
    await screenshot(`workspace-brand-${label}`);
  }

  for (const [label, collapsed] of [['collapse', true], ['expand', false]]) {
    const current = await page.$eval('.ag-root', (root) => root.classList.contains('ag-rail-collapsed'));
    if (current === collapsed) {
      await page.click('.ag-workspace-threads-btn');
      await page.waitForFunction((expected) => document.querySelector('.ag-root').classList.contains('ag-rail-collapsed') === expected, {}, !collapsed);
      await new Promise((resolve) => setTimeout(resolve, 320));
    }
    await page.click('.ag-workspace-threads-btn');
    await page.waitForFunction((expected) => document.querySelector('.ag-root').classList.contains('ag-rail-collapsed') === expected, {}, collapsed);
    await captureTransition(label);
  }
}

import assert from 'node:assert/strict';
import { isMainModule, runStandalone } from './standalone.mjs';

/*
 * A provider update found while the first-run setup is open (or about to open) does not
 * raise its toast over the setup; the toast follows once the setup is closed.
 */

const UPDATE_TOAST = () => [...document.querySelectorAll('.rhwp-toast-message')]
  .some((node) => node.textContent?.includes('업데이트가 있습니다'));

export async function checkInitialSetupUpdateToast(page, origin) {
  await page.goto(`${origin}/?theme=light&reset=1&width=480&initial-setup=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await page.evaluate(() => window.sidebarPreview.setUpdateAvailable('claude', '9.9.9'));
  await page.waitForSelector('.rhwp-setup-overlay.rhwp-setup-open');
  await page.evaluate(() => window.sidebarPreview.setUpdateAvailable('claude', '9.9.10'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await page.evaluate(UPDATE_TOAST), false, 'no update toast while the first-run setup is up');

  await page.click('.rhwp-setup-skip');
  await page.waitForFunction(() => !document.querySelector('.rhwp-setup-overlay.rhwp-setup-open'));
  await page.waitForFunction(UPDATE_TOAST, { timeout: 3_000 });
}

if (isMainModule(import.meta)) {
  await runStandalone('Provider update toast waits for the first-run setup', checkInitialSetupUpdateToast);
}

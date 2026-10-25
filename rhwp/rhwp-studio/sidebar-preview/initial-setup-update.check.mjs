import assert from 'node:assert/strict';
import { isMainModule, runStandalone } from './standalone.mjs';

/*
 * A provider update found while the first-run setup is open (or about to open) does not
 * raise its hippo over the setup; the hippo follows once the setup is closed.
 */

const UPDATE_HIPPO = () => [...document.querySelectorAll('.uh-provider:not([hidden]) .uh-text')]
  .some((node) => node.textContent?.includes('업데이트가 있어요'));

export async function checkInitialSetupUpdateHippo(page, origin) {
  await page.goto(`${origin}/?theme=light&reset=1&width=480&initial-setup=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await page.evaluate(() => window.sidebarPreview.setUpdateAvailable('claude', '9.9.9'));
  await page.waitForSelector('.rhwp-setup-overlay.rhwp-setup-open');
  await page.evaluate(() => window.sidebarPreview.setUpdateAvailable('claude', '9.9.10'));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await page.evaluate(UPDATE_HIPPO), false, 'no update hippo while the first-run setup is up');

  await page.click('.rhwp-setup-skip');
  await page.waitForFunction(() => !document.querySelector('.rhwp-setup-overlay.rhwp-setup-open'));
  await page.waitForFunction(UPDATE_HIPPO, { timeout: 3_000 });
}

if (isMainModule(import.meta)) {
  await runStandalone('Provider update hippo waits for the first-run setup', checkInitialSetupUpdateHippo);
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { OwnedBrowserHost, fileChooserFilters } from '../desktop/browser-host.mjs';

function host() {
  const calls = [];
  const dialog = { showOpenDialog: async (window, options) => { calls.push({ window, options }); return { canceled: false, filePaths: ['/Users/me/a.txt', '/Users/me/b.txt'] }; } };
  const browser = new OwnedBrowserHost({ dataDir: '/tmp/unused-native-profile', dialog });
  const window = { isDestroyed: () => false };
  const tab = { targetId: 'target-1', human: true, interactive: true, placement: { window, mode: 'dock' }, view: { webContents: { isDestroyed: () => false } } };
  browser.tabs.set(tab.targetId, tab);
  return { browser, tab, window, calls };
}

test('website file inputs open the OS file dialog only for a tab the user is controlling', async () => {
  const { browser, tab, window, calls } = host();
  assert.deepEqual(await browser.chooseFiles({ targetId: 'target-1', multiple: false, accept: '.txt' }), { paths: ['/Users/me/a.txt'] });
  assert.equal(calls[0].window, window);
  assert.deepEqual(calls[0].options, { properties: ['openFile'], filters: [{ name: '파일', extensions: ['txt'] }] });
  assert.deepEqual(await browser.chooseFiles({ targetId: 'target-1', multiple: true, accept: '' }), { paths: ['/Users/me/a.txt', '/Users/me/b.txt'] });
  assert.deepEqual(calls[1].options, { properties: ['openFile', 'multiSelections'] });
  for (const change of [{ human: false }, { interactive: false }, { placement: null }, { automationInputDepth: 1 }]) {
    Object.assign(tab, { human: true, interactive: true, placement: { window, mode: 'dock' }, automationInputDepth: 0 }, change);
    await assert.rejects(browser.chooseFiles({ targetId: 'target-1', multiple: false }), /not controlling/, JSON.stringify(change));
  }
  assert.equal(calls.length, 2);
});

test('accept maps to dialog filters and unknown types leave every file selectable', () => {
  assert.deepEqual(fileChooserFilters('.HWP, application/pdf'), [{ name: '파일', extensions: ['hwp', 'pdf'] }]);
  assert.equal(fileChooserFilters('application/x-unknown,.pdf'), null);
  assert.equal(fileChooserFilters(''), null);
});

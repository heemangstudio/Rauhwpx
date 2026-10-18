import assert from 'node:assert/strict';
import test from 'node:test';

import { BrowserAdblock } from '../desktop/browser-adblock.mjs';

function blockerWithEngine() {
  const ipcMain = { handle() {}, removeHandler() {} };
  const adblock = new BrowserAdblock({ host: { dataDir: '/tmp/rhwp-adblock-test', tabs: new Map(), pendingTabs: new Set() }, ipcMain });
  // 모든 요청을 막는 엔진: 거르기 대상이면 차단된다.
  adblock.engine = { onBeforeRequest(_details, callback) { callback({ cancel: true }); } };
  return adblock;
}

function decide(adblock, details) {
  let result;
  adblock.beforeRequest(details, (value) => { result = value; });
  return result;
}

test('Google sign-in connectivity check is never ad-blocked inside an OAuth popup', () => {
  const adblock = blockerWithEngine();
  const page = 'https://accounts.google.com/v3/signin/challenge/pwd?app_domain=https://x.com';
  const result = decide(adblock, {
    // Google 은 연결 확인을 이미지 요청으로 보낸다. 실제 필터 목록이 이 형태를 막는다.
    url: 'https://accounts.google.com/generate_204?Qq3W7w',
    resourceType: 'image',
    webContents: { getURL: () => page },
  });
  assert.deepEqual(result, {});
});

test('requests to a sign-in provider pass even from a filtered site', () => {
  const adblock = blockerWithEngine();
  const result = decide(adblock, {
    url: 'https://accounts.google.com/gsi/client',
    resourceType: 'script',
    webContents: { getURL: () => 'https://x.com/i/flow/login' },
  });
  assert.deepEqual(result, {});
});

test('ordinary trackers on ordinary sites are still blocked', () => {
  const adblock = blockerWithEngine();
  const result = decide(adblock, {
    url: 'https://ads.example.net/pixel.gif',
    resourceType: 'image',
    webContents: { getURL: () => 'https://x.com/home' },
  });
  assert.deepEqual(result, { cancel: true });
});

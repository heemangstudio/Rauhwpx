import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

const identity = tab => ({ tabId: tab.tabId, navigationEpoch: tab.navigationEpoch, controllerEpoch: tab.controllerEpoch, runtimeGeneration: tab.runtimeGeneration });
const human = { isHuman: true, clientId: 'editor', sessionId: 'editor', threadId: 'chat', agentId: 'owner' };

async function fixture(t, native = false) {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('Install managed Chromium for frozen-page behavior checks.'); return; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-frozen-test-'));
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><style>body{margin:0;font:20px sans-serif}p{height:170px;margin:0}button{width:220px;height:70px}#bottom{background:#1c8844;color:white}input,textarea,[contenteditable]{width:200px;height:30px;background:red}</style><title>Frozen fixture</title><h1>Frozen source</h1><label>Account<input value="field-secret"></label><textarea>textarea-secret</textarea><div contenteditable>editable-secret</div><div contenteditable="plaintext-only">plaintext-secret</div><section data-rhwp-private-field><span>custom-secret</span></section>${Array.from({ length: 28 }, (_, i) => `<p>Research ${i}</p>`).join('')}<button id="bottom" onclick="window.activated++">Original frozen button</button><script>window.activated=0;window.wheels=0;addEventListener('wheel',()=>window.wheels++);</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const state = { shield: false, nativeEpoch: 0, zoom: 1, holdActivity: null, page: null, snapshotCalls: 0 };
  const events = [];
  const adapter = native ? {
    bind: async () => ({ generation: 'native-test', zoomFactor: state.zoom }), control: async () => {},
    passwordSnapshot: async () => { state.snapshotCalls++; return { passwordProtected: state.shield, nativeNavigationEpoch: 1, nativeControlEpoch: state.nativeEpoch, zoomFactor: state.zoom }; },
    activity: async ({ active }) => { if (!active && state.holdActivity) await state.holdActivity(); },
  } : undefined;
  const browser = createOwnedBrowserService({ dataDir: directory, workspaceTargets: [origin], nativeAdapter: adapter, autoInstall: false, onEvent: event => events.push(event),
    runtimeFactory: async options => {
      const runtime = await startOwnedBrowserRuntime({ ...options, nativeAdapter: undefined });
      runtime.context.on('page', page => { state.page = page; });
      return runtime;
    } });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const opened = await browser.request(human, 'open', { url: origin });
  return { browser, tab: opened.tab, state, events };
}

test('full frozen page keeps bottom element and pixels after live DOM changes without website input', async t => {
  const f = await fixture(t); if (!f) return;
  const { frozen } = await f.browser.request(human, 'freeze', identity(f.tab));
  assert.ok(frozen.frame.height > 4800);
  const dimensions = await f.state.page.evaluate(async data => {
    const image = new Image(); image.src = `data:image/jpeg;base64,${data}`; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight };
  }, frozen.frame.data);
  assert.deepEqual(dimensions, { width: frozen.frame.width, height: frozen.frame.height }, 'full-page pixels must match CSS coordinate dimensions');
  const element = frozen.elements.find(element => element.text === 'Original frozen button');
  assert.ok(element.rect.y > 4800);
  assert.equal(/field-secret|textarea-secret|editable-secret|plaintext-secret|custom-secret/.test(JSON.stringify(frozen.elements)), false);
  await f.state.page.evaluate(() => { document.querySelector('#bottom').textContent = 'Changed live button'; document.querySelector('#bottom').style.background = 'red'; });
  const capture = (await f.browser.request(human, 'capture', { ...identity(f.tab), freezeId: frozen.freezeId, mode: 'element', elementId: element.elementId, destinationThreadId: 'chat', comment: 'Original' })).capture;
  assert.equal(capture.element.text, 'Original frozen button');
  assert.equal(capture.screenshot.data, frozen.frame.data);
  assert.deepEqual(capture.screenshot.clip, element.rect);
  assert.deepEqual(await f.state.page.evaluate(() => ({ activated: window.activated, wheels: window.wheels, y: scrollY })), { activated: 0, wheels: 0, y: 0 });
  assert.equal(f.events.find(event => event.type === 'owned_browser_capture').capture.screenshot, undefined, 'agent-facing event excludes full-page bytes');
  await assert.rejects(f.browser.request({ ...human, clientId: 'other' }, 'capture', { ...identity(f.tab), freezeId: frozen.freezeId }), { code: 'BROWSER_STALE_FREEZE' });
  await f.browser.request(human, 'release-freeze', { tabId: f.tab.tabId, freezeId: frozen.freezeId });
  await assert.rejects(f.browser.request(human, 'capture', { ...identity(f.tab), freezeId: frozen.freezeId }), { code: 'BROWSER_STALE_FREEZE' });
});

test('frozen native images fail closed before capture and across late protection or logout changes', async t => {
  const f = await fixture(t, true); if (!f) return;
  f.state.shield = true;
  let screenshots = 0; const original = f.state.page.screenshot.bind(f.state.page);
  f.state.page.screenshot = async args => { screenshots++; return original(args); };
  await assert.rejects(f.browser.request(human, 'freeze', identity(f.tab)), { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
  assert.equal(screenshots, 0);
  f.state.shield = false;
  f.state.page.screenshot = async args => { const bytes = await original(args); f.state.shield = true; return bytes; };
  await assert.rejects(f.browser.request(human, 'freeze', identity(f.tab)), { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
  f.state.shield = false; f.state.page.screenshot = original;
  const { frozen } = await f.browser.request(human, 'freeze', identity(f.tab));
  f.state.nativeEpoch++;
  await assert.rejects(f.browser.request(human, 'capture', { ...identity(f.tab), freezeId: frozen.freezeId }), { code: 'BROWSER_STALE_FREEZE' });
  let resume; let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.state.holdActivity = async () => { entered(); await new Promise(resolve => { resume = resolve; }); };
  const pending = f.browser.request(human, 'freeze', identity(f.tab));
  await waiting; f.state.shield = true; resume();
  await assert.rejects(pending, { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
});

test('one client keeps one frozen page and bounded captures reject oversized documents', async t => {
  const f = await fixture(t); if (!f) return;
  const second = await f.browser.request(human, 'open', { url: f.tab.url });
  const [a, b] = await Promise.allSettled([f.browser.request(human, 'freeze', identity(f.tab)), f.browser.request(human, 'freeze', identity(second.tab))]);
  if (a.status === 'fulfilled') await assert.rejects(f.browser.request(human, 'capture', { ...identity(f.tab), freezeId: a.value.frozen.freezeId }), { code: 'BROWSER_STALE_FREEZE' });
  else assert.equal(a.reason.code, 'BROWSER_STALE_FREEZE');
  assert.equal(b.status, 'fulfilled');
  assert.ok((await f.browser.request(human, 'capture', { ...identity(second.tab), freezeId: b.value.frozen.freezeId })).capture.screenshot.data);
  await f.state.page.evaluate(() => { document.body.style.height = '40000px'; });
  await assert.rejects(f.browser.request(human, 'freeze', identity(second.tab)), { code: 'BROWSER_FROZEN_PAGE_TOO_LARGE' });
  await assert.rejects(f.browser.request({ threadId: 'chat', agentId: 'owner' }, 'freeze', identity(f.tab)), { code: 'BROWSER_HUMAN_REQUIRED' });
});

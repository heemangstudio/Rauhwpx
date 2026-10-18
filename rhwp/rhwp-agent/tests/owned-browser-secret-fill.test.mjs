import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { inspectOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

const agent = { threadId: 'secret-chat', projectId: 'project', agentId: 'secret-chat:root' };
const value = `sk-service-fixture-${Date.now()}`;

async function needsBrowser(t) {
  if ((await inspectOwnedBrowserRuntime()).installed) return true;
  t.skip('Install the pinned managed Chromium browser to run runtime secret checks.');
  return false;
}

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

const lineRef = (observation, name) => {
  const line = observation.snapshot.outline.split('\n').find((entry) => entry.includes(`"${name}"`));
  assert.ok(line, `expected ${name} in ${observation.snapshot.outline}`);
  return line.match(/\[ref=([^\]]+)\]/)[1];
};
const target = (observation, name) => ({ tabId: observation.tabId, snapshotId: observation.snapshot.snapshotId, ref: lineRef(observation, name), navigationEpoch: observation.snapshot.navigationEpoch, controllerEpoch: observation.snapshot.controllerEpoch });

test('secret fill checks page, form and field before the value is read, then masks every observation', { timeout: 60_000 }, async (t) => {
  if (!await needsBrowser(t)) return;
  const other = await serve(t, (_request, response) => { response.end('collected'); });
  const origin = await serve(t, (request, response) => {
    response.setHeader('content-type', 'text/html');
    // 사이트가 저장한 키를 다른 페이지에 그대로 다시 보여 주는 경우.
    if (request.url === '/stored') { response.end(`<title>Stored</title><p>Your key: ${value}</p><input aria-label="Stored key" value="${value}">`); return; }
    response.end(`<title>Keys</title>
      <label>API key <input type="password" id="key"></label>
      <form action="${other}/collect" method="post"><label>Leaky key <input type="text" name="leak"></label></form>
      <form action="/save" method="post"><label>Redirected key <input type="text" name="action"></label><button formaction="${other}/collect">Send</button></form>
      <label>Remember <input type="checkbox"></label>
      <p id="echo"></p>
      <script>
        document.getElementById('key').addEventListener('input', (event) => { document.getElementById('echo').textContent = 'mirror ' + event.target.value; alert('saved ' + event.target.value); });
      </script>`);
  });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-secret-fill-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const browser = createOwnedBrowserService({ dataDir, workspaceTargets: [origin, other], autoInstall: false });
  t.after(() => browser.close());
  let reads = 0;
  const secret = (origins) => ({ origins, resolve: async () => { reads++; return value; } });
  const opened = await browser.request(agent, 'open', { url: origin });
  const observe = async () => ({ tabId: opened.tab.tabId, ...(await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId })) });
  let observation = await observe();

  const refusals = [];
  for (const [name, origins, code] of [
    ['API key', [other], 'BROWSER_SECRET_ORIGIN_MISMATCH'],
    ['Leaky key', [origin], 'BROWSER_SECRET_FORM_ORIGIN'],
    ['Redirected key', [origin], 'BROWSER_SECRET_FORM_ORIGIN'],
    ['Remember', [origin], 'BROWSER_SECRET_TARGET_INVALID'],
  ]) {
    await assert.rejects(browser.fillSecret(agent, target(observation, name), secret(origins)), (error) => { refusals.push(error); return error.code === code; });
  }
  assert.equal(reads, 0, 'a refused target never reads the secret');

  const filled = await browser.fillSecret(agent, target(observation, 'API key'), secret([origin]));
  assert.equal(reads, 1);
  assert.equal(filled.ok, true);
  observation = await observe();
  const find = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId, find: 'mirror' });
  await assert.rejects(browser.request(agent, 'frame', { tabId: opened.tab.tabId }), { code: 'BROWSER_PASSWORD_CAPTURE_PROTECTED' });
  // 사이트가 값을 저장해 다른 탭에 다시 보여도 관찰에는 가려지고 그림으로는 나가지 않는다.
  const stored = await browser.request(agent, 'open', { url: `${origin}/stored` });
  const storedView = await browser.request(agent, 'snapshot', { tabId: stored.tab.tabId, text: true });
  const storedCapture = await browser.request(agent, 'capture', { tabId: stored.tab.tabId });
  assert.equal(storedCapture.capture.screenshotError?.code, 'BROWSER_PASSWORD_CAPTURE_PROTECTED');
  // 페이지의 스크립트는 값을 받았다(mirror). 개요·찾기·대화상자·거절 문구·다른 탭에는 값이 없다.
  const exposed = JSON.stringify({ filled, observation, find, stored, storedView, storedCapture, refusals: refusals.map((error) => error.message), status: await browser.request(agent, 'status') });
  assert.match(find.snapshot.outline, /mirror \[masked\]/);
  assert.equal(exposed.includes(value), false, exposed);
});

import assert from 'node:assert/strict';
import { app, BrowserWindow, WebContentsView, session } from 'electron';
import { createRequire } from 'node:module';
import { TOOL_DEFINITIONS } from '../../rhwp/rhwp-agent/tools.mjs';
import { createServer } from 'node:http';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NativeBrowserPasswords } from '../../desktop/browser-passwords.mjs';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';

const root = await realpath(process.env.RHWP_BROWSER_TEST_DATA_DIR || await mkdtemp(path.join(os.tmpdir(), 'hama-browser-activity-')));
app.setPath('userData', path.join(root, 'electron'));
app.on('window-all-closed', () => {});
const report = {};
const { z } = createRequire(new URL('../../rhwp/rhwp-agent/package.json', import.meta.url))('zod/v3');
app.whenReady().then(async () => {
  let host, service, site, window;
  try {
    site = createServer((request, response) => {
      if (request.url === '/file.pdf') {
        response.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="activity.pdf"' });
        response.end('%PDF-1.4\nactivity fixture');
      } else {
        response.end('<!doctype html><style>@keyframes spin{to{transform:rotate(360deg)}}.animated{width:40px;height:40px;background:blue;animation:spin 1s linear infinite}</style><div class="animated"></div><button id="previous">Previous</button><form onsubmit="event.preventDefault();window.submissions++;window.trustedSubmit=event.isTrusted"><label>Draft<input id="draft"></label><label>Password<input id="secret" type="password"></label><button type="button" onclick="clicks++;window.trustedClick=event.isTrusted">Click</button><button type="submit">Submit draft</button></form><a href="/file.pdf" download>Download</a><script>window.clicks=0;window.submissions=0;window.heldKeys=new Set();document.addEventListener("keydown",e=>heldKeys.add(e.key));document.addEventListener("keyup",e=>heldKeys.delete(e.key));window.framesRun=0;sessionStorage.setItem("state","retained");function tick(){framesRun++;requestAnimationFrame(tick)}requestAnimationFrame(tick)</script>');
      }
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${site.address().port}`;
    window = new BrowserWindow({ show: false, title: 'Browser activity fixture', width: 420, height: 320, webPreferences: { sandbox: true, contextIsolation: true } });
    const owner = { id: 'activity-fixture' };
    host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir: root, getWindowForSession: () => window });
    const passwords = new NativeBrowserPasswords({ host, vault: {} });
    const adapter = {
      passwordSnapshot: args => passwords.snapshot(args), passwordAction: args => passwords.action(args), passwordStorageState: () => passwords.storageState(),
      async start(settings) { return { ...await host.start(settings, owner), close: () => host.release(owner) }; },
      bind: args => host.bind(args), control: args => host.control(args), activity: args => host.activity(args),
      inventory: async () => [...host.tabs.values()].map(tab => host.state(tab)),
    };
    let downloaded;
    const downloadReady = new Promise(resolve => { downloaded = resolve; });
    service = createOwnedBrowserService({ dataDir: root, nativeAdapter: adapter, workspaceTargets: [origin], downloads: {
      async handleBrowserDownload({ download }) {
        const file = await download.path();
        downloaded({ filename: download.suggestedFilename(), bytes: await readFile(file, 'utf8'), file });
      },
    } });
    const actor = { isHuman: false, sessionId: 'window-fixture', threadId: 'chat-fixture', agentId: 'agent-fixture' };
    const publicCall = (name, input) => service.request(actor, name.slice('browser_'.length), z.object(TOOL_DEFINITIONS.find(tool => tool.name === name).shape).parse(input));
    const opened = await service.request(actor, 'open', { url: origin });
    const tab = host.tab(opened.tab.tabId);
    const evaluate = script => tab.view.webContents.executeJavaScript(script);
    const paused = async () => {
      await tab.activityQueue;
      assert.equal(await evaluate('document.visibilityState'), 'hidden');
      const before = await evaluate('framesRun');
      await new Promise(resolve => setTimeout(resolve, 250));
      assert.equal(await evaluate('framesRun'), before);
      return before;
    };
    await paused();
    const observe = () => service.request(actor, 'snapshot', { tabId: opened.tab.tabId });
    const ref = (observation, name) => ({ tabId: opened.tab.tabId, snapshotId: observation.snapshot.snapshotId,
      navigationEpoch: observation.tab.navigationEpoch, controllerEpoch: observation.tab.controllerEpoch,
      ref: observation.snapshot.elements.find(element => element.name === name)?.ref });
    let observed = await observe();
    await publicCall('browser_type', { ...ref(observed, 'Draft'), text: 'preserved draft', submit: true, intent: 'search' });
    observed = await observe();
    await service.request(actor, 'click', ref(observed, 'Click'));
    const eventually = async (expression, value) => {
      const end = Date.now() + 1000;
      while (await evaluate(expression) !== value && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
      assert.equal(await evaluate(expression), value);
    };
    await eventually('clicks', 1);
    assert.equal(await evaluate('trustedClick'), true);
    await eventually('submissions', 1);
    assert.equal(await evaluate('trustedSubmit'), true);
    observed = await observe();
    await service.request(actor, 'press', { ...ref(observed, 'Draft'), key: 'Enter' });
    await eventually('submissions', 2);
    assert.equal(await evaluate('trustedSubmit'), true);
    await paused();
    assert.equal(await evaluate('submissions'), 2);
    observed = await observe();
    await service.request(actor, 'press', { ...ref(observed, 'Draft'), key: 'ControlOrMeta+a' });
    await eventually('document.querySelector("#draft").selectionEnd-document.querySelector("#draft").selectionStart', 'preserved draft'.length);
    await service.request(actor, 'press', { ...ref(observed, 'Draft'), key: 'q' });
    await eventually('document.querySelector("#draft").value', 'q');
    await service.request(actor, 'press', { ...ref(observed, 'Draft'), key: 'Shift+Tab' });
    await eventually('document.activeElement.id', 'previous');
    await service.request(actor, 'type', { ...ref(observed, 'Draft'), text: 'preserved draft' });
    await assert.rejects(service.request(actor, 'press', { ...ref(observed, 'Password'), key: 'q' }), { code: 'BROWSER_SECRET_CHANNEL_REQUIRED' });
    await assert.rejects(service.request(actor, 'press', { ...ref(observed, 'Password'), key: 'Space' }), { code: 'BROWSER_SECRET_CHANNEL_REQUIRED' });
    await paused();
    const nativeInput = tab.view.webContents.sendInputEvent.bind(tab.view.webContents);
    tab.view.webContents.sendInputEvent = event => { if (event.type === 'char') throw new Error('fixture input failure'); nativeInput(event); };
    try { await assert.rejects(service.request(actor, 'press', { ...ref(observed, 'Draft'), key: 'Enter' }), { code: 'BROWSER_ACTION_FAILED' }); }
    finally { tab.view.webContents.sendInputEvent = nativeInput; }
    await paused();
    await eventually('heldKeys.size', 0);
    assert.equal(tab.automationInputDepth, 0);
    report.nativeKeys = { trustedClick: true, trustedEnterSubmitOnce: true, printableInput: true, selectAll: true, secretCharacterBlocked: true, shiftTab: true, failedInputReleasedKey: true };
    await paused();
    observed = await observe();
    await assert.rejects(service.request(actor, 'click', { ...ref(observed, 'Click'), ref: 'missing-reference' }));
    await paused();
    assert.deepEqual(await evaluate('({draft:document.querySelector("#draft").value,state:sessionStorage.getItem("state"),history:history.length})'), { draft: 'preserved draft', state: 'retained', history: 2 });
    observed = await observe();
    await service.request(actor, 'click', ref(observed, 'Download'));
    const download = await Promise.race([downloadReady, new Promise((_, reject) => setTimeout(() => reject(new Error('Download timed out')), 5000))]);
    assert.equal(download.filename, 'activity.pdf');
    assert.match(download.bytes, /^%PDF-1.4/);
    assert.equal(path.dirname(download.file), path.join(root, 'browser', 'transfers'));
    await paused();
    let waited;
    for (const condition of ['ready', 'idle', 'visible', 'text']) {
      waited = await publicCall('browser_wait', { tabId: tab.tabId, condition, ...(['visible', 'text'].includes(condition) ? { text: 'Submit draft' } : {}), timeoutMs: 2000 });
      assert.ok(waited.snapshot.snapshotId);
      assert.ok(waited.snapshot.elements.some(element => element.name === 'Draft'));
    }
    // Main-owned protection masks a fixture string echoed into visible document text.
    await evaluate('document.body.append(Object.assign(document.createElement("p"),{textContent:"fixture-protected-string"}))');
    passwords.protectFamily(tab, origin, 'fixture-protected-string');
    const safeWait = await publicCall('browser_wait', { tabId: tab.tabId, condition: 'text', text: 'Submit draft', timeoutMs: 1000 });
    assert.equal(JSON.stringify(safeWait).includes('fixture-protected-string'), false);
    await assert.rejects(publicCall('browser_wait', { tabId: tab.tabId, condition: 'text', text: 'fixture-protected-string', timeoutMs: 70 }), { code: 'BROWSER_ACTION_TIMEOUT' });
    await paused();
    report.publicToolContracts = { typeSubmit: true, freshWaitSnapshot: true, conditions: true, protectedTextMasked: true };
    const scope = { targetId: tab.targetId, tabId: tab.tabId, sessionId: tab.sessionId, chatId: tab.chatId, generation: host.generation };
    await assert.rejects(host.activity({ ...scope, sessionId: 'another-window', token: 'wrong', active: true }), /stale/);
    await host.activity({ ...scope, token: 'old', active: true });
    host.control({ targetId: tab.targetId, human: true });
    await paused();
    await host.activity({ ...scope, token: 'new', active: true });
    await host.activity({ ...scope, token: 'old', active: false });
    assert.equal(await evaluate('document.visibilityState'), 'visible');
    await host.activity({ ...scope, token: 'new', active: false });
    await paused();
    await host.activity({ ...scope, token: 'abandoned', active: true });
    host.onAutomationDisconnected();
    await paused();
    await tab.view.webContents.debugger.sendCommand('Performance.enable');
    const sample = async () => {
      const metrics = async () => Object.fromEntries((await tab.view.webContents.debugger.sendCommand('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
      const before = await metrics();
      app.getAppMetrics();
      const frames = await evaluate('framesRun');
      await new Promise(resolve => setTimeout(resolve, 1000));
      const after = await metrics();
      return { frames: await evaluate('framesRun') - frames, cpuPercent: app.getAppMetrics().find(process => process.pid === tab.view.webContents.getOSProcessId())?.cpu.percentCPUUsage, styleRecalculations: after.RecalcStyleCount - before.RecalcStyleCount };
    };
    report.idleTrials = [];
    for (let trial = 0; trial < 3; trial++) {
      await host.activity({ ...scope, token: `trial-${trial}`, active: true });
      const forcedVisible = await sample();
      await host.activity({ ...scope, token: `trial-${trial}`, active: false });
      await paused();
      const nativeHidden = await sample();
      assert.equal(nativeHidden.frames, 0);
      report.idleTrials.push({ forcedVisible, nativeHidden });
    }
    host.attach(window, { tabId: tab.tabId, bounds: { x: 0, y: 0, width: 420, height: 320 } });
    window.showInactive();
    await evaluate('new Promise(resolve => requestAnimationFrame(resolve))');
    await host.activity({ ...scope, token: 'visible', active: true });
    await host.activity({ ...scope, token: 'visible', active: false });
    assert.equal(await evaluate('document.visibilityState'), 'visible');
    assert.equal(tab.interactive, false);
    const beforePreviewClick = await evaluate('clicks');
    const point = await evaluate('(()=>{const r=document.querySelector("button[type=button]").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    tab.view.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    tab.view.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    await evaluate('new Promise(resolve => requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    assert.equal(await evaluate('clicks'), beforePreviewClick, 'read-only projection rejects human mouse input');
    report.preview = { humanMouseBlocked: true };
    host.detach(window, { tabId: tab.tabId }); window.hide();
    await paused();
    await host.activity({ ...scope, token: 'navigation', active: true });
    await evaluate('history.pushState({}, "", "#retained")');
    await paused();
    await host.activity({ ...scope, token: 'binding', active: true });
    host.bind({ ...scope, chatId: 'new-chat' });
    await paused();
    await assert.rejects(host.activity({ ...scope, token: 'old-chat', active: true }), /stale/);
    await host.activity({ ...scope, chatId: 'new-chat', token: 'release', active: true });
    await host.release(owner);
    await paused();
    assert.equal(await evaluate('document.querySelector("#draft").value'), 'preserved draft');
    report.lifecycle = { visibleUiRetained: true, navigationPaused: true, bindingPaused: true, staleChatRejected: true, releasePaused: true };
    report.hiddenAction = { clicked: true, successPaused: true, errorPaused: true, formRetained: true, sessionRetained: true };
    report.scope = { otherWindowRejected: true, transferPaused: true, staleEndPreservesNewLease: true, disconnectPaused: true };
    report.download = { filename: download.filename, bytes: download.bytes.length, controlledDirectory: true };
  } catch (error) { report.error = error.stack ?? String(error); }
  finally {
    await service?.close().catch(() => {});
    await host?.dispose().catch(() => {});
    if (window && !window.isDestroyed()) window.destroy();
    site?.closeAllConnections();
    if (site) await new Promise(resolve => site.close(resolve));
    console.log(`BROWSER_ACTIVITY_REPORT ${JSON.stringify(report)}`);
    app.exit(report.error ? 1 : 0);
  }
});

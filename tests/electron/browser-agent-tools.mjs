import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { app, BaseWindow, BrowserWindow, WebContentsView, session } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';

const root = process.env.RHWP_BROWSER_TEST_DATA_DIR;
app.setPath('userData', path.join(root, 'electron'));
app.on('window-all-closed', () => {});
const report = {};
app.whenReady().then(async () => {
  let host, service, editor, site;
  try {
    site = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      const url = new URL(request.url, 'http://x');
      if (url.pathname.startsWith('/read')) { response.end(`<title>Read ${url.pathname}</title><article><h1>Heading ${url.pathname}</h1><p>Fact for ${url.pathname}</p></article>`); return; }
      response.end(`<!doctype html><title>Probe</title><meta property="og:site_name" content="Probe Site">
        <p id="lead">Quoted paragraph about native browsers.</p>
        <label>Name<input name="name"></label><label>Size<select name="size"><option>Small</option><option>Large</option></select></label><label><input type="checkbox" name="ok">Agree</label>
        <style>#menu{display:none}#host:hover #menu{display:block}</style><div id="host" role="button" aria-label="Products">Products<div id="menu"><a href="/x">Hidden item</a></div></div>
        <div role="slider" aria-label="Volume" id="knob" aria-valuenow="0" style="width:30px;height:30px;background:#333"></div>
        <button onclick="window.answer=confirm('Proceed?')">Ask</button>
        <script>let s;knob.onmousedown=e=>s=e.clientX;addEventListener('mouseup',e=>{if(s!==undefined){knob.setAttribute('aria-valuenow',String(Math.round(e.clientX-s)));s=undefined}})</script>`);
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${site.address().port}`;
    editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await editor.loadURL('data:text/html,<h1>Editor</h1>');
    const owner = {};
    host = new OwnedBrowserHost({ BrowserWindow, BaseWindow, WebContentsView, electronSession: session, dataDir: root, getWindowForSession: () => editor });
    const events = [];
    service = createOwnedBrowserService({ dataDir: root, workspaceTargets: [origin], policy: { assertAllowed: async () => {} }, onEvent: (event) => events.push(event), nativeAdapter: {
      async start(settings) { return { ...await host.start(settings, owner), close: () => host.release(owner) }; },
      bind: args => host.bind(args), control: args => host.control(args), activity: args => host.activity(args),
      inventory: async () => [...host.tabs.values()].map(tab => host.state(tab)),
    } });
    const actor = { sessionId: 'editor', threadId: 'probe', agentId: 'probe-agent' };
    const opened = await service.request(actor, 'open', { url: origin });
    const tabId = opened.tab.tabId;
    const tab = host.tab(tabId);
    host.attach(editor, { tabId, bounds: { x: 0, y: 0, width: 800, height: 600 } });
    // 붙인 뒤 게스트 크기가 바뀌는 동안의 배치는 기다린다.
    for (let attempt = 0; attempt < 50 && await tab.view.webContents.executeJavaScript('innerWidth') !== 800; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    const refOf = (snapshot, name) => snapshot.outline.split('\n').find(line => line.includes(`"${name}"`))?.match(/\[ref=([^\]]+)\]/)?.[1];
    const snap = async () => (await service.request(actor, 'snapshot', { tabId })).snapshot;
    const ep = (s) => ({ tabId, snapshotId: s.snapshotId, navigationEpoch: s.navigationEpoch, controllerEpoch: s.controllerEpoch });
    let s = await snap();
    const filled = await service.request(actor, 'fill-form', { ...ep(s), fields: [{ ref: refOf(s, 'Name'), value: 'Kim' }, { ref: refOf(s, 'Size'), value: 'Large' }, { ref: refOf(s, 'Agree'), value: true }] });
    report.fillForm = filled.fields.every(f => f.ok) && await tab.view.webContents.executeJavaScript('[document.querySelector("[name=name]").value, document.querySelector("select").value, document.querySelector("[name=ok]").checked].join(",")') === 'Kim,Large,true';
    const found = await service.request(actor, 'snapshot', { tabId, find: 'native browsers', scrollTo: 1 });
    report.find = found.found.count === 1 && found.found.scrolledTo === 1 && !!found.snapshot?.snapshotId;
    const cited = await service.request(actor, 'cite', { tabId, quote: 'Quoted paragraph about native browsers.' });
    report.cite = cited.citation.siteName === 'Probe Site' && cited.citation.url === `${origin}/`;
    s = await snap();
    const hovered = await service.request(actor, 'click', { ...ep(s), ref: refOf(s, 'Products'), hover: true, snapshot: true });
    report.hover = /Hidden item/.test(hovered.snapshot.outline);
    s = await snap();
    await service.request(actor, 'click', { ...ep(s), ref: refOf(s, 'Volume'), dragBy: { x: 100, y: 0 } });
    const moved = Number(await tab.view.webContents.executeJavaScript('knob.getAttribute("aria-valuenow")'));
    report.drag = moved >= 95 && moved <= 105;
    report.pointerEvents = events.filter(e => e.type === 'owned_browser_pointer').map(e => e.phase).slice(0, 5);
    s = await snap();
    const started = Date.now();
    const clicked = await service.request(actor, 'click', { ...ep(s), ref: refOf(s, 'Ask') });
    report.dialogRace = clicked.dialog?.pending === true && Date.now() - started < 5000;
    await service.request(actor, 'dialog', { tabId, accept: true });
    report.dialogAccepted = await tab.view.webContents.executeJavaScript('window.answer') === true;
    const read = await service.request(actor, 'open', { urls: ['/read1', '/read2', '/read3', '/read4'].map(p => origin + p) });
    report.readMany = read.pages.map(p => p.ok && p.text.includes('Fact for')).every(Boolean) && read.pages.length === 4;
  } catch (error) { report.error = error.stack; }
  finally {
    await service?.close().catch(() => {}); await host?.dispose().catch(() => {});
    if (editor && !editor.isDestroyed()) editor.destroy(); site?.close();
    console.log('BROWSER_AGENT_TOOLS_REPORT ' + JSON.stringify(report));
    app.exit(report.error ? 1 : 0);
  }
});

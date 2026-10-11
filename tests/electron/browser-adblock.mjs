import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { app, BrowserWindow, WebContentsView, session, ipcMain } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { BrowserAdblock, registerBrowserAdblockIpc } from '../../desktop/browser-adblock.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';

const require = createRequire(new URL('../../rhwp/rhwp-studio/package.json', import.meta.url));
const root = process.env.RHWP_BROWSER_TEST_DATA_DIR;
app.setPath('userData', path.join(root, 'electron'));
app.on('window-all-closed', () => {});
const report = {}; let stage;
app.whenReady().then(async () => {
  let host, service, site, editor, vite;
  try {
    const hits = { ad: 0, app: 0, submit: 0 };
    site = createServer((request, response) => {
      if (request.url === '/ads/cbr.js') { hits.ad++; response.setHeader('content-type', 'text/javascript'); return response.end('window.adLoaded=true'); }
      if (request.url === '/app.js') { hits.app++; response.setHeader('content-type', 'text/javascript'); return response.end('window.appLoaded=true'); }
      if (request.url === '/submitted') { hits.submit++; return response.end('<title>Signed in</title>Form submitted'); }
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><title>Normal article</title><h1>Readable article</h1><div class="adsbygoogle-wrapper">Advertisement</div><input id="draft" value="retained draft"><form action="/submitted" method="post"><input type="password" value="fixture-password"><button>Sign in</button></form><script src="/app.js"></script><script src="/ads/cbr.js"></script>');
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://article.example:${site.address().port}`;
    const { createServer: createVite } = await import(require.resolve('vite'));
    vite = await createVite({ root: fileURLToPath(new URL('../../rhwp/rhwp-studio/', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'adblock-settings', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url !== '/adblock-settings') return next();
        response.setHeader('content-type', 'text/html');
        response.end(`<html><meta charset="utf-8"><body style="margin:0;background:#fff;color:#222;font:14px system-ui"><div class="ag-root ag-settings-open" style="position:relative;width:100%;height:100%;inset:0;max-width:none"><div class="ag-settings-page" style="position:relative;display:block;overflow:auto;height:100%"></div></div><script type="module">
          import '/src/ui/agent-sidebar/agent-sidebar.css';
          import '/src/ui/agent-sidebar/settings.css';
          import {createBrowserSettingsPane} from '/src/ui/agent-sidebar/browser-settings.ts';
          const pane=createBrowserSettingsPane({isConnected:()=>true,submit:async()=>({}),request:async action=>action==='accounts.list'?{accounts:[]}:action==='policy.list'?{defaults:{},sites:[]}:{} });
          document.querySelector('.ag-settings-page').append(pane.element);pane.open();[...pane.element.querySelectorAll('[role=tab]')].find(b=>b.textContent==='구성').click();
        </script></body></html>`);
      });
    } }] });
    await vite.listen();
    editor = new BrowserWindow({ show: false, width: 780, height: 950, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, preload: fileURLToPath(new URL('../../desktop/preload.cjs', import.meta.url)) } });
    const owner = {};
    host = new OwnedBrowserHost({ BrowserWindow, WebContentsView, electronSession: session, dataDir: path.join(root, 'browser-data'), getWindowForSession: () => editor });
    const before = process.memoryUsage(); const started = performance.now();
    const adblock = new BrowserAdblock({ host, ipcMain, fetcher: async () => { throw new Error('Offline fixture'); } });
    await adblock.load();
    report.engine = { loadMs: Math.round(performance.now() - started), heapMiB: +(Math.max(0, process.memoryUsage().heapUsed - before.heapUsed) / 1048576).toFixed(2), arrayBufferMiB: +(Math.max(0, process.memoryUsage().arrayBuffers - before.arrayBuffers) / 1048576).toFixed(2) };
    ipcMain.handle('desktop:browser-passwords-profiles', () => ({supported:false,profiles:[]}));
    ipcMain.handle('desktop:browser-passwords-list', () => ({accounts:[]}));
    registerBrowserAdblockIpc({ ipcMain, adblock, browserWindowForEvent(event) { if (event.sender !== editor.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Editor only'); return editor; } });
    const adapter = { async start(settings) { return { ...await host.start(settings, owner), close: () => host.release(owner) }; }, bind: args => host.bind(args), control: args => host.control(args), inventory: async () => [...host.tabs.values()].map(tab => host.state(tab)) };
    service = createOwnedBrowserService({ dataDir: host.dataDir, nativeAdapter: adapter, workspaceTargets: [origin], lookup: async () => [{address:'127.0.0.1',family:4}] });
    const opened = await service.request({ isHuman: true, sessionId: 'adblock-editor', clientId: 'adblock-editor', threadId: 'adblock-chat' }, 'open', { url: origin });
    const tab = host.tab(opened.tab.tabId); const contents = tab.view.webContents;
    const eventually = async (contents, expression, expected) => {
      const end = Date.now() + 8000; let lastError;
      while (Date.now() < end) {
        try { if (await contents.executeJavaScript(expression) === expected) return; } catch (error) { lastError = error; }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      assert.equal(await contents.executeJavaScript(expression).catch(() => lastError.message), expected, expression);
    };
    stage = 'first-page';
    await eventually(contents, 'window.appLoaded', true);
    await eventually(contents, 'getComputedStyle(document.querySelector(".adsbygoogle-wrapper")).display', 'none');
    assert.equal(hits.ad, 0); assert.equal(hits.app, 1);
    assert.equal(await contents.executeJavaScript('document.querySelector("#draft").value'), 'retained draft');
    report.blocked = { ordinaryScript: true, adRequestsReachedServer: hits.ad, cosmeticHidden: true, draftPreserved: true };
    stage = 'settings';
    await editor.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}/adblock-settings`);
    await eventually(editor.webContents, `!!document.querySelector('[aria-label="article.example 일시 중지"]')`, true);
    const click = async selector => {
      const point = await editor.webContents.executeJavaScript(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView();const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
      editor.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
      editor.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    };
    stage = 'pause';
    await click('[aria-label="article.example 일시 중지"]');
    await eventually(editor.webContents, `!!document.querySelector('[aria-label="article.example 차단 재개"]')`, true);
    assert.equal(await contents.executeJavaScript('document.querySelector("#draft").value'), 'retained draft');
    await contents.loadURL(origin); await eventually(contents, 'window.adLoaded', true); assert.equal(hits.ad, 1);
    await eventually(contents, 'getComputedStyle(document.querySelector(".adsbygoogle-wrapper")).display', 'block');
    report.sitePause = { requestAllowed: true, cosmeticsRemovedAfterReload: true, draftPreservedWithoutReload: true };
    stage = 'resume';
    await click('[aria-label="article.example 차단 재개"]');
    await eventually(editor.webContents, `!!document.querySelector('[aria-label="article.example 일시 중지"]')`, true);
    await contents.loadURL(origin); await eventually(contents, 'window.appLoaded', true); assert.equal(hits.ad, 1);
    stage = 'toggle';
    const toggle = '.ag-browser-section input[type="checkbox"]';
    await click(toggle); await eventually(editor.webContents, '(()=>{const e=document.querySelector(".ag-browser-section input[type=checkbox]");return !e.checked&&!e.disabled})()', true);
    assert.equal((await adblock.state()).enabled, false);
    await contents.loadURL(origin); await eventually(contents, 'window.adLoaded', true); assert.equal(hits.ad, 2);
    await click(toggle); await eventually(editor.webContents, '(()=>{const e=document.querySelector(".ag-browser-section input[type=checkbox]");return e.checked&&!e.disabled})()', true);
    assert.equal((await adblock.state()).enabled, true);
    await contents.loadURL(origin); await eventually(contents, 'window.appLoaded', true); assert.equal(hits.ad, 2);
    await assert.rejects(adblock.update(), /Offline/);
    await contents.loadURL(origin); await eventually(contents, 'window.appLoaded', true); assert.equal(hits.ad, 2);
    report.globalToggle = { disabledAllowsRequest: true, reenabledBlocks: true, failedUpdateKeepsBlocking: true };
    const updatedUrls = [];
    adblock.fetcher = async (url, options) => {
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
      updatedUrls.push(url);
      const name = url.endsWith('/easylist.txt') ? 'easylist' : 'easyprivacy';
      return new Response(gunzipSync(await readFile(new URL(`../../desktop/adblock/${name}.txt.gz`, import.meta.url))));
    };
    await adblock.update();
    assert.deepEqual(updatedUrls.sort(), ['https://easylist.to/easylist/easylist.txt', 'https://easylist.to/easylist/easyprivacy.txt']);
    await contents.loadURL(origin); await eventually(contents, 'window.appLoaded', true); assert.equal(hits.ad, 2);
    report.filterUpdate = { fixedUrlsOnly: true, successfulCacheWrite: true, updatedEngineBlocks: true };
    await assert.rejects(adblock.configure({ enabled: true, pausedSites: ['good.example/bad'] }), /Invalid/);
    stage = 'form';
    await contents.executeJavaScript('document.querySelector("form").requestSubmit()');
    await eventually(contents, 'document.title', 'Signed in'); assert.equal(hits.submit, 1);
    report.formSubmission = true;
    const allowed = host.proxy; host.proxy = null;
    try { await assert.rejects(contents.loadURL(origin), /ERR_BLOCKED_BY_CLIENT/); } finally { host.proxy = allowed; }
    report.securityGuardStillBlocks = true;
    if (process.env.RHWP_ADBLOCK_SCREENSHOT) {
      await editor.webContents.executeJavaScript('document.querySelector(".ag-settings-page").scrollTop=0;window.scrollTo(0,0)');
      await writeFile(process.env.RHWP_ADBLOCK_SCREENSHOT, (await editor.webContents.capturePage()).toPNG());
    }
    const persisted = await adblock.configure({enabled:false,pausedSites:['article.example']}); adblock.dispose();
    const restarted = new BrowserAdblock({ host, ipcMain, fetcher: async () => { throw new Error('offline'); } });
    assert.deepEqual((await restarted.state()).pausedSites, persisted.pausedSites); assert.equal((await restarted.state()).enabled, persisted.enabled);
    assert.equal((await restarted.state()).updatedAt, persisted.updatedAt);
    report.offlineRestart = true;
  } catch (error) { report.error = `${stage}: ${error.stack ?? String(error)}\n${await editor?.webContents.executeJavaScript('document.body.innerText').catch(() => '')}`; }
  finally {
    await service?.close().catch(() => {}); await host?.dispose().catch(() => {}); editor?.destroy(); await vite?.close(); site?.closeAllConnections(); await new Promise(resolve => site ? site.close(resolve) : resolve());
    console.log(`BROWSER_ADBLOCK_REPORT ${JSON.stringify(report)}`); app.exit(report.error ? 1 : 0);
  }
});

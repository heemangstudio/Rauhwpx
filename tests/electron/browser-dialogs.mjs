import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { app, BaseWindow, BrowserWindow, WebContentsView, session, webContents } from 'electron';
import { OwnedBrowserHost } from '../../desktop/browser-host.mjs';
import { createOwnedBrowserService } from '../../rhwp/rhwp-agent/owned-browser-service.mjs';

const root = process.env.RHWP_BROWSER_TEST_DATA_DIR;
app.setPath('userData', path.join(root, 'electron'));
app.on('window-all-closed', () => {});
const report = {};
app.whenReady().then(async () => {
  let host, service, editor, otherEditor, site;
  try {
    site = createServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/restored') {
        response.end('<!doctype html><title>Restored website fixture</title><script>alert("Synthetic abnormal connection");window.restored=true</script>');
        return;
      }
      response.end(`<!doctype html><title>Website dialog fixture</title><input id="draft" value="retained">
        <button id="submit">Submit</button><script>
        window.submissions=0;window.finished=0;
        submit.onclick=()=>{if(confirm('Submit the fixture form?'))submissions++;finished++};
        </script>`);
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${site.address().port}`;
    editor = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await editor.loadURL('data:text/html,<h1>Editor remains responsive</h1>');
    const owner = {};
    host = new OwnedBrowserHost({ BrowserWindow, BaseWindow, WebContentsView, electronSession: session,
      dataDir: root, getWindowForSession: () => editor });
    const wire = [];
    const send = host.cdp.send.bind(host.cdp);
    host.cdp.send = (message, client) => { wire.push(JSON.stringify(message)); return send(message, client); };
    service = createOwnedBrowserService({ dataDir: root, workspaceTargets: [origin],
      policy: { assertAllowed: async () => {} }, nativeAdapter: {
        async start(settings) { return { ...await host.start(settings, owner), close: () => host.release(owner) }; },
        bind: args => host.bind(args), control: args => host.control(args), activity: args => host.activity(args),
        inventory: async () => [...host.tabs.values()].map(tab => host.state(tab)),
      } });
    const actor = { sessionId: 'editor', threadId: 'dialog-fixture', agentId: 'fixture-agent' };
    const human = { ...actor, isHuman: true, clientId: 'editor' };
    const initialContents = webContents.getAllWebContents().length;
    const restored = await service.request(actor, 'open', { url: origin + '/restored' });
    const restoredGuest = host.tab(restored.tab.tabId);
    assert.equal(await restoredGuest.view.webContents.executeJavaScript('restored'), true, 'A startup alert does not stall hidden-page restoration');
    await service.request(human, 'close', { tabId: restoredGuest.tabId,
      navigationEpoch: restored.tab.navigationEpoch, controllerEpoch: restored.tab.controllerEpoch });
    const opened = await service.request(actor, 'open', { url: origin });
    let tab = host.tab(opened.tab.tabId);
    assert.equal(webContents.getAllWebContents().length, initialContents + 1, 'Parking adds no renderer');
    assert.equal(tab.view.webContents.getOwnerBrowserWindow(), host.parkingWindow);
    assert.equal(await tab.view.webContents.executeJavaScript('document.visibilityState'), 'hidden');
    const capture = await host.cdp.command({ method: 'Page.captureScreenshot', params: { format: 'png' }, sessionId: tab.cdpSessionId });
    assert.ok(capture.data.length > 100, 'A hidden parked guest remains capturable through the shared debugger');
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(host.parkingWindow.isVisible(), false, 'Capture never leaves a native window mapped');
    assert.equal(await tab.view.webContents.executeJavaScript('document.visibilityState'), 'hidden');
    const evaluate = script => tab.view.webContents.executeJavaScript(script, true);
    const waitDialog = () => new Promise((resolve, reject) => {
      const contents = tab.view.webContents;
      const timer = setTimeout(() => { contents.debugger.off('message', listener); reject(new Error('Website dialog was not observed')); }, 3000);
      const listener = (_event, method, params) => {
        if (method !== 'Page.javascriptDialogOpening') return;
        clearTimeout(timer); contents.debugger.off('message', listener); resolve(params.type);
      };
      contents.debugger.on('message', listener);
    });
    const responsive = async () => {
      // This renderer reply and main-process timer both stall in NSAlert.runModal.
      assert.equal(await editor.webContents.executeJavaScript('document.querySelector("h1").textContent'), 'Editor remains responsive');
      await new Promise(resolve => setTimeout(resolve, 30));
    };
    let observed = waitDialog();
    const alert = evaluate('alert("Synthetic abnormal connection"); "continued"');
    assert.equal(await observed, 'alert');
    await responsive();
    assert.equal(await alert, 'continued');
    const serviceTab = async (tabId) => (await service.request(actor, 'status', {})).tabs.find(entry => entry.tabId === tabId);
    const serviceDialog = async (tabId) => {
      for (let attempt = 0; attempt < 60; attempt++) { const current = await serviceTab(tabId); if (current?.dialog) return current; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('The hub did not observe the website dialog');
    };
    // An agent tab's confirmation stays hidden and waits for the agent's answer.
    observed = waitDialog();
    const agentConfirm = evaluate('confirm("Submit the fixture form?")');
    assert.equal(await observed, 'confirm');
    await responsive();
    let current = await serviceDialog(tab.tabId);
    assert.deepEqual(current.dialog, { type: 'confirm', message: 'Submit the fixture form?' });
    // Electron always shows its sheet; it stays parented to the editor and the agent's answer closes it.
    assert.equal(tab.view.webContents.getOwnerBrowserWindow(), editor, 'A pending agent dialog keeps the editor as its async parent');
    await assert.rejects(service.request(actor, 'snapshot', { tabId: tab.tabId }), { code: 'BROWSER_DIALOG_PENDING' });
    await service.request(actor, 'dialog', { tabId: tab.tabId, accept: false, navigationEpoch: current.navigationEpoch, controllerEpoch: current.controllerEpoch });
    assert.equal(await agentConfirm, false);
    assert.equal(await evaluate('document.getElementById("draft").value'), 'retained');
    report.agent = { startupAlertContinued: true, alertContinued: true, confirmCancelled: true, editorResponsive: true };

    // A global tab stays human-controlled, even while agents are allowed to use it.
    const personal = await service.request(human, 'open', { url: origin });
    tab = host.tab(personal.tab.tabId);
    observed = waitDialog();
    const restoredHuman = host.navigate(editor, { tabId: tab.tabId, url: origin + '/restored' });
    assert.equal(await observed, 'alert');
    await responsive();
    assert.equal(tab.view.webContents.getOwnerBrowserWindow(), editor, 'A hidden human startup alert belongs to its editor');
    await tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false });
    await restoredHuman;
    assert.equal(await evaluate('restored'), true);
    assert.equal(tab.view.webContents.getOwnerBrowserWindow(), host.parkingWindow);
    await host.navigate(editor, { tabId: tab.tabId, url: origin });
    host.attach(editor, { tabId: tab.tabId, bounds: { x: 0, y: 0, width: 600, height: 400 }, interactive: true });
    assert.equal(tab.view.webContents.getOwnerBrowserWindow(), editor);
    let completed = false;
    observed = waitDialog();
    const confirmation = evaluate('submit.click(); submissions').then(value => { completed = true; return value; });
    assert.equal(await observed, 'confirm');
    await responsive();
    assert.equal(completed, false, 'A human confirmation stays pending until an explicit choice');
    await tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: true });
    assert.equal(await confirmation, 1, 'The explicit human choice permits the fixture submission');
    assert.equal(await evaluate('finished'), 1);
    report.human = { hiddenStartupAlertParented: true, pendingUntilChoice: true, confirmAccepted: true, editorResponsive: true };

    // An agent click on that same human tab returns its own confirmation instead of hanging; the agent answers it.
    const snapshot = await service.request(actor, 'snapshot', { tabId: tab.tabId });
    const clicked = await service.request(actor, 'click', { tabId: tab.tabId, snapshotId: snapshot.snapshot.snapshotId,
      navigationEpoch: snapshot.tab.navigationEpoch, controllerEpoch: snapshot.tab.controllerEpoch,
      ref: snapshot.snapshot.outline.split('\n').find(line => line.includes('"Submit"')).match(/\[ref=([^\]]+)\]/)[1] });
    assert.deepEqual(clicked.dialog, { type: 'confirm', message: 'Submit the fixture form?', pending: true });
    await service.request(actor, 'dialog', { tabId: tab.tabId, accept: false, navigationEpoch: snapshot.tab.navigationEpoch, controllerEpoch: snapshot.tab.controllerEpoch });
    assert.equal(await evaluate('submissions'), 1);
    assert.equal(await evaluate('finished'), 2);

    // A pending human dialog stays with the user; agent work reports it without answering.
    observed = waitDialog();
    const humanChoice = evaluate('confirm("Pending human fixture choice")');
    assert.equal(await observed, 'confirm');
    await responsive();
    current = await serviceDialog(tab.tabId);
    assert.equal(current.dialog.owner, 'user');
    await assert.rejects(service.request(actor, 'snapshot', { tabId: tab.tabId }), (failure) => failure.code === 'BROWSER_DIALOG_PENDING' && /user/.test(failure.message));
    await assert.rejects(service.request(actor, 'dialog', { tabId: tab.tabId, accept: true, navigationEpoch: current.navigationEpoch, controllerEpoch: current.controllerEpoch }), { code: 'BROWSER_USER_CONTROL' });
    await tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false });
    assert.equal(await humanChoice, false);
    await service.request(actor, 'snapshot', { tabId: tab.tabId });
    report.shared = { agentAnsweredOwnDialog: true, userDialogLeftToUser: true };

    // Every presentation returns to the same owner before hidden scripts can run.
    for (const mode of ['dock', 'float', 'popout']) {
      host.attach(editor, { tabId: tab.tabId, mode, bounds: { x: 0, y: 0, width: 600, height: 400 }, interactive: true });
      host.detach(editor, { tabId: tab.tabId });
      assert.equal(tab.view.webContents.getOwnerBrowserWindow(), host.parkingWindow);
      observed = waitDialog();
      const hidden = evaluate(`confirm(${JSON.stringify(`Hidden ${mode} fixture`)})`);
      assert.equal(await observed, 'confirm');
      await responsive();
      assert.equal(tab.view.webContents.getOwnerBrowserWindow(), editor);
      await tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false });
      assert.equal(await hidden, false);
      assert.equal(tab.view.webContents.getOwnerBrowserWindow(), host.parkingWindow);
    }
    assert.equal(await evaluate('document.getElementById("draft").value'), 'retained');
    report.presentation = { dockFloatPopoutReparked: true, hiddenDialogsResponsive: true, draftRetained: true };

    otherEditor = new BrowserWindow({ show: false });
    host.getWindowForSession = () => otherEditor;
    observed = waitDialog();
    const staleOwner = evaluate('confirm("Synthetic stale editor choice")');
    assert.equal(await observed, 'confirm');
    await responsive();
    assert.equal(tab.view.webContents.getOwnerBrowserWindow(), host.parkingWindow, 'A replacement editor cannot own a dialog before explicit binding');
    await tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false });
    assert.equal(await staleOwner, false);
    host.getWindowForSession = () => editor;
    otherEditor.destroy(); otherEditor = null;

    observed = waitDialog();
    const movedDialog = evaluate('confirm("Synthetic moved presentation choice")');
    assert.equal(await observed, 'confirm');
    host.attach(editor, { tabId: tab.tabId, bounds: { x: 0, y: 0, width: 600, height: 400 }, interactive: true });
    await tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false });
    assert.equal(await movedDialog, false);
    assert.equal(tab.placement.mode, 'dock', 'A closing dialog cannot undo a newer user presentation');
    assert.equal(tab.view.webContents.getOwnerBrowserWindow(), editor);
    host.detach(editor, { tabId: tab.tabId });
    report.ownership = { staleEditorRejected: true, newerPresentationRetained: true };

    const secret = 'synthetic-dialog-private-value-a93f';
    tab.passwordShield = true;
    observed = waitDialog();
    const protectedDialog = evaluate(`confirm(${JSON.stringify(secret)})`);
    assert.equal(await observed, 'confirm');
    await responsive();
    await tab.view.webContents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept: false });
    assert.equal(await protectedDialog, false);
    assert.equal(wire.join('\n').includes(secret), false, 'Protected dialog text never reaches the hub');
    tab.passwordShield = false;
    const prompt = await evaluate('(()=>{try{return {value:prompt("Private input","synthetic-default")}}catch{return {unsupported:true}}})()');
    assert.equal(prompt.unsupported, true, 'Electron continues to reject unsupported prompt()');
    report.privacy = { protectedTextAbsent: true, promptUnsupported: true };

    const parkingWindow = host.parkingWindow;
    const guest = tab.view.webContents;
    host.closeGuest(tab);
    assert.equal(parkingWindow.contentView.children.includes(tab.view), false);
    await service.close(); service = null;
    await host.dispose();
    assert.equal(guest.isDestroyed(), true);
    assert.equal(parkingWindow.isDestroyed(), true);
    assert.equal(host.parkingWindow, null);
    report.cleanup = { closedGuestRemoved: true, parkingWindowDestroyed: true };
  } catch (error) { report.error = error.stack; }
  finally {
    await service?.close().catch(() => {});
    await host?.dispose().catch(() => {});
    if (editor && !editor.isDestroyed()) editor.destroy();
    if (otherEditor && !otherEditor.isDestroyed()) otherEditor.destroy();
    site?.close();
    console.log('BROWSER_DIALOG_REPORT ' + JSON.stringify(report));
    app.exit(report.error ? 1 : 0);
  }
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import path from 'node:path';
import { app, BrowserWindow, session, webContents } from 'electron';
import { BrowserWebAuthn } from '../../desktop/browser-webauthn.mjs';

app.setPath('userData', path.join(process.env.RHWP_WEBAUTHN_TEST_DIR, 'electron'));
app.on('window-all-closed', () => {});
console.error('WEBAUTHN_STAGE modules-loaded');
const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><title>Local WebAuthn fixture</title>'); });
let window;
let service;
app.whenReady().then(async () => {
try {
  console.error('WEBAUTHN_STAGE ready');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browserSession = session.fromPartition('webauthn-fixture');
  window = new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const contents = window.webContents;
  const tab = { view: { webContents: contents }, targetId: 'fixture', sessionId: 'fixture-editor', windowId: window.id, navigationEpoch: 1 };
  let selectedAccounts = 0;
  browserSession.on('select-webauthn-account', (_event, details) => { selectedAccounts = details.accounts.length; });
  service = new BrowserWebAuthn({ app, systemPreferences: { canPromptTouchID: () => false }, checkEntitlement: async () => false,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    getTabForFrame: (frame) => webContents.fromFrame(frame) === contents ? tab : null, getWindowForTab: () => window });
  const metadata = await service.configure();
  service.attachSession(browserSession);
  await contents.loadURL(`http://localhost:${server.address().port}/`);
  console.error('WEBAUTHN_STAGE loaded');
  contents.debugger.attach('1.3');
  await contents.debugger.sendCommand('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await contents.debugger.sendCommand('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  for (let i = 1; i <= 2; i++) {
    console.error(`WEBAUTHN_STAGE create-${i}`);
    const result = await contents.executeJavaScript(`navigator.credentials.create({publicKey:{challenge:new Uint8Array(32),rp:{id:'localhost',name:'Fixture'},user:{id:new Uint8Array([${i}]),name:'fixture-${i}',displayName:'Fixture ${i}'},pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{residentKey:'required',userVerification:'required'},timeout:5000}}).then(value=>!!value)`);
    assert.equal(result, true);
  }
  const invalidRp = await contents.executeJavaScript("navigator.credentials.get({publicKey:{challenge:new Uint8Array(32),rpId:'different.example',timeout:5000}}).then(()=> 'unexpected-success',error=>error.name)");
  console.error('WEBAUTHN_STAGE rp-validated');
  const cancelled = await contents.executeJavaScript("navigator.credentials.get({publicKey:{challenge:new Uint8Array(32),rpId:'localhost',userVerification:'required',timeout:5000}}).then(()=> 'unexpected-success',error=>error.name)");
  await contents.debugger.sendCommand('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  console.log(`WEBAUTHN_REPORT ${JSON.stringify({ invalidRp, cancelled, selectedAccounts, existingMacPasskeys: metadata.existingMacPasskeys })}`);
} catch (error) { console.error(error.stack); process.exitCode = 1; }
finally {
  service?.dispose();
  window?.destroy();
  await new Promise((resolve) => server.close(resolve));
  app.exit(process.exitCode ?? 0);
}
});

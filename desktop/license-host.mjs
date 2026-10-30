// 라이선스 관리자를 Electron 에 연결한다: IPC, 활성화 창, 상태 방송.
import { fileURLToPath } from 'node:url';
import { paymentFixUrlFrom, PRICING_URL, SUPPORT_MAILTO } from './license-manager.mjs';

const LICENSE_PRELOAD = fileURLToPath(new URL('./license-preload.cjs', import.meta.url));
const LICENSE_URL = new URL('./license-window.html', import.meta.url).href;

export function installLicenseHost({
  ipcMain,
  BrowserWindow,
  shell,
  clipboard,
  manager,
  isTrustedStudioEvent,
  studioWebContents = () => [],
  parentWindow = () => null,
  log = console,
}) {
  let licenseWindow = null;

  function isLicenseWindowEvent(event) {
    return Boolean(licenseWindow && !licenseWindow.isDestroyed() && event.sender === licenseWindow.webContents);
  }

  function assertAllowed(event) {
    if (isLicenseWindowEvent(event)) return;
    if (isTrustedStudioEvent(event)) return;
    throw new Error('Untrusted license IPC sender');
  }

  function broadcast(status) {
    const targets = [...studioWebContents()];
    if (licenseWindow && !licenseWindow.isDestroyed()) targets.push(licenseWindow.webContents);
    for (const contents of targets) {
      if (!contents || contents.isDestroyed?.()) continue;
      try { contents.send('license:changed', status); } catch { /* 닫히는 창 */ }
    }
  }

  function openWindow() {
    if (licenseWindow && !licenseWindow.isDestroyed()) {
      licenseWindow.show();
      licenseWindow.focus();
      return licenseWindow;
    }
    const parent = parentWindow();
    licenseWindow = new BrowserWindow({
      width: 520,
      height: 470,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'HamaEditor 라이선스',
      show: false,
      ...(parent && !parent.isDestroyed?.() ? { parent } : {}),
      webPreferences: {
        preload: LICENSE_PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const contents = licenseWindow.webContents;
    contents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
    contents.on?.('will-navigate', (event) => event.preventDefault());
    licenseWindow.once?.('ready-to-show', () => licenseWindow?.show());
    licenseWindow.on?.('closed', () => { licenseWindow = null; });
    void licenseWindow.loadURL(LICENSE_URL).catch((error) => log.warn?.('[license] window failed to load:', error));
    return licenseWindow;
  }

  const handlers = {
    'license:status': () => manager.status(),
    'license:activate': (_event, key) => manager.activate(String(key ?? '').slice(0, 256)),
    'license:deactivate': () => manager.deactivate(),
    'license:check': () => manager.check({ force: true }),
    'license:open-pricing': () => shell.openExternal(PRICING_URL),
    // 결제가 실패했거나 끝난 연간 키: 구매자가 결제 수단을 바꾸는 Groble 페이지를 연다.
    'license:open-payment-fix': async () => shell.openExternal(paymentFixUrlFrom((await manager.status()).license?.paymentFixUrl)),
    // 고정된 문의 주소만 연다. 렌더러가 주소를 넘기지 않는다.
    'license:open-support': () => shell.openExternal(SUPPORT_MAILTO),
    // 키는 렌더러로 보내지 않고 메인이 클립보드에 바로 쓴다.
    'license:copy-key': async () => {
      const key = await manager.licenseKey();
      if (!key || !clipboard) return false;
      clipboard.writeText(key);
      return true;
    },
    'license:open-window': () => { openWindow(); return true; },
    'license:close-window': () => { licenseWindow?.close(); return true; },
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      assertAllowed(event);
      return handler(event, ...args);
    });
  }

  return { openWindow, broadcast, channels: Object.keys(handlers) };
}

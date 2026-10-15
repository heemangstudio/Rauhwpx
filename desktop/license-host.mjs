// 라이선스 관리자를 Electron 에 연결한다: IPC, 활성화 창, 상태 방송, 저장 차단.
import { fileURLToPath } from 'node:url';
import { PRICING_URL } from './license-manager.mjs';

const LICENSE_PRELOAD = fileURLToPath(new URL('./license-preload.cjs', import.meta.url));
const LICENSE_URL = new URL('./license-window.html', import.meta.url).href;

export function installLicenseHost({
  ipcMain,
  BrowserWindow,
  shell,
  manager,
  isTrustedStudioEvent,
  studioWebContents = () => [],
  parentWindow = () => null,
  log = console,
}) {
  let licenseWindow = null;
  let saveQueue = Promise.resolve();

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
    'license:open-window': () => { openWindow(); return true; },
    'license:close-window': () => { licenseWindow?.close(); return true; },
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      assertAllowed(event);
      return handler(event, ...args);
    });
  }

  /** 저장 전에 부른다. 읽기 전용이면 활성화 창을 띄우고 LicenseReadOnlyError 를 던진다. */
  async function guardSave() {
    try {
      return await manager.assertCanSave();
    } catch (error) {
      if (error?.code === 'LICENSE_READ_ONLY') openWindow();
      throw error;
    }
  }

  /** 저장에 성공한 뒤 부른다. 체험 횟수를 세고, 마지막 체험 저장이면 활성화 창을 띄운다. */
  async function noteSave() {
    try {
      const status = await manager.recordSave();
      if (status.readOnly) openWindow();
      return status;
    } catch (error) {
      log.warn?.('[license] could not record a trial save:', error);
      return null;
    }
  }

  /** 실행할 때: 읽기 전용이면 첫 창 위에 활성화 창을 띄운다. */
  async function showIfReadOnly() {
    const status = await manager.status();
    if (status.readOnly) openWindow();
    return status;
  }

  function save(write) {
    const result = saveQueue.then(async () => {
      await guardSave();
      const written = await write();
      await noteSave();
      return written;
    });
    saveQueue = result.catch(() => {});
    return result;
  }

  return { openWindow, guardSave, noteSave, save, showIfReadOnly, broadcast, channels: Object.keys(handlers) };
}

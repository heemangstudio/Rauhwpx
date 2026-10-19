// 라이선스 관리자를 Electron 에 연결한다: IPC, 활성화 창, 상태 방송, 저장 차단.
import { fileURLToPath } from 'node:url';
import { paymentFixUrlFrom, PRICING_URL } from './license-manager.mjs';

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
  // 체험이 끝날 때 자동 저장 유예를 받은 창. 이 창의 쓰기만 유예 안에서 받는다.
  const expirySavers = new WeakSet();

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
    'license:open-window': () => { openWindow(); return true; },
    'license:close-window': () => { licenseWindow?.close(); return true; },
    'license:begin-expiry-save': async (event) => {
      const result = await manager.beginExpirySave();
      if (result.ok && event?.sender) expirySavers.add(event.sender);
      return result;
    },
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args) => {
      assertAllowed(event);
      return handler(event, ...args);
    });
  }

  /** 저장 전에 부른다. 읽기 전용이면 활성화 창을 띄우고 LicenseReadOnlyError 를 던진다. */
  async function guardSave(options) {
    try {
      return await manager.assertCanSave(options);
    } catch (error) {
      if (error?.code === 'LICENSE_READ_ONLY') openWindow();
      throw error;
    }
  }

  /** 실행할 때: 읽기 전용이면 첫 창 위에 활성화 창을 띄운다. */
  async function showIfReadOnly() {
    const status = await manager.status();
    if (status.readOnly) openWindow();
    return status;
  }

  /**
   * 여러 창의 저장을 한 줄로 세워, 저장마다 확인한 뒤 쓴다. 받은 시각을 줄 서기 전에 남겨,
   * 체험 중에 들어온 저장이 앞선 저장을 기다리다 기한을 넘겨도 거절하지 않는다.
   */
  function save(write, { sender = null } = {}) {
    const requestedAt = manager.time();
    const expirySave = Boolean(sender && expirySavers.has(sender));
    const result = saveQueue.then(async () => {
      await guardSave({ requestedAt, expirySave });
      return write();
    });
    saveQueue = result.catch(() => {});
    return result;
  }

  return { openWindow, guardSave, save, showIfReadOnly, broadcast, channels: Object.keys(handlers) };
}

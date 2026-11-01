// 라이선스 관리자를 Electron 에 연결한다: IPC, 활성화 창, 상태 방송.
import { fileURLToPath } from 'node:url';
import { paymentFixUrlFrom, PRICING_URL, SUPPORT_MAILTO } from './license-manager.mjs';
import { normalizeGiftCode } from './license-lease.mjs';

/** 프로모션 코드 칸의 안내. 선물 코드(GIFT-)는 계정에, 예전 키(HAMA-)는 이 기기에 등록한다. */
export const PROMO_MESSAGES = Object.freeze({
  invalid_format: '프로모션 코드 형식이 아니에요. 받은 GIFT- 또는 HAMA- 코드를 그대로 붙여 넣어 주세요.',
  sign_in_required: '선물 코드는 계정에 등록돼요. 먼저 로그인한 뒤 다시 등록해 주세요.',
  invalid_code: '선물 코드를 찾을 수 없어요. 코드를 다시 확인해 주세요.',
  code_redeemed: '이미 다른 계정에서 사용한 선물 코드예요.',
  code_revoked: '취소된 선물 코드예요. 더 이상 쓸 수 없어요.',
  code_expired: '사용 기한이 지난 선물 코드예요.',
  network: '서버에 연결하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.',
  server: '서버가 잠시 응답하지 않아요. 조금 뒤 다시 시도해 주세요.',
  rate_limited: '시도가 너무 많아요. 잠시 뒤 다시 시도해 주세요.',
});

/** GIFT 로 시작하면 선물 코드로 본다(대소문자·공백·하이픈 무시). */
export function looksLikeGiftCode(raw) {
  return String(raw ?? '').toUpperCase().replace(/[\s-]/g, '').startsWith('GIFT');
}

/**
 * 프로모션 코드 칸 하나로 두 가지를 받는다.
 * - GIFT-…: 로그인한 계정에 선물 코드를 등록한다(POST /v1/account/gift-codes/redeem). 요금제는 계정 상태로 바로 바뀐다.
 * - 그 밖: 예전처럼 이 기기에 라이선스 키(HAMA-…)를 활성화한다.
 */
export async function submitPromoCode(raw, { manager, redeemGift }) {
  const input = String(raw ?? '').slice(0, 256);
  if (looksLikeGiftCode(input)) {
    const fail = async (code) => ({
      ok: false, kind: 'gift', code, signInRequired: code === 'sign_in_required',
      message: PROMO_MESSAGES[code] ?? PROMO_MESSAGES.server, status: await manager.status(),
    });
    const code = normalizeGiftCode(input);
    if (!code) return fail('invalid_format');
    if (typeof redeemGift !== 'function') return fail('server');
    let result;
    try { result = await redeemGift(code); } catch { return fail('network'); }
    if (!result?.ok) return fail(result?.code ?? 'server');
    return { ok: true, kind: 'gift', alreadyLinked: result.alreadyLinked === true, status: await manager.status() };
  }
  const result = await manager.activate(input);
  if (!result.ok && result.code === 'invalid_format') return { ...result, kind: 'license', message: PROMO_MESSAGES.invalid_format };
  return { ...result, kind: 'license' };
}

const LICENSE_PRELOAD = fileURLToPath(new URL('./license-preload.cjs', import.meta.url));
const LICENSE_URL = new URL('./license-window.html', import.meta.url).href;

export function installLicenseHost({
  ipcMain,
  BrowserWindow,
  shell,
  clipboard,
  manager,
  redeemGift,
  signIn,
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
      title: 'HamaEditor 프로모션 코드',
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
    'license:activate': (_event, key) => submitPromoCode(key, { manager, redeemGift }),
    // 선물 코드를 넣다가 로그인이 필요할 때. 렌더러는 아무것도 넘기지 않는다.
    'license:sign-in': () => (typeof signIn === 'function' ? signIn() : { ok: false, code: 'sign_in_required' }),
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

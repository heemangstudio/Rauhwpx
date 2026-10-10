import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
export const WEB_AUTHN_KEYCHAIN_GROUP = 'C8M34MMT8W.com.hataewook.rauhwpx.webauthn';

export async function hasWebAuthnEntitlement(executable = process.execPath) {
  try {
    await execFileAsync('/usr/bin/codesign', ['--verify', '--strict', '-R', '=identifier "com.hataewook.rauhwpx" and anchor apple generic and certificate leaf[subject.OU] = "C8M34MMT8W"', executable], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync('/usr/bin/codesign', ['-d', '--entitlements', ':-', executable], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const groups = stdout.match(/<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
    return !!groups?.match(/<string>([^<]+)<\/string>/g)?.some((entry) => entry === `<string>${WEB_AUTHN_KEYCHAIN_GROUP}</string>`);
  } catch { return false; }
}

const label = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 120);

// 비밀키와 WebAuthn 응답은 Chromium과 macOS가 관리한다. 허브에는 기능 상태만 공개한다.
export class BrowserWebAuthn {
  constructor({ app, dialog, systemPreferences, getTabForFrame, getWindowForTab, onState = () => {},
    platform = process.platform, electronVersion = process.versions.electron ?? '',
    checkEntitlement = hasWebAuthnEntitlement, selectionTimeoutMs = 120_000 }) {
    Object.assign(this, { app, dialog, systemPreferences, getTabForFrame, getWindowForTab, onState,
      platform, electronVersion, checkEntitlement, selectionTimeoutMs });
    this.sessions = new Map();
    this.pending = new Map();
    this.configured = false;
    this.touchIdAvailable = false;
    this.reason = platform === 'darwin' ? 'not-configured' : 'macos-required';
  }

  async configure() {
    if (this.configuration) return this.configuration;
    this.configuration = this.configureNative();
    return this.configuration;
  }

  async configureNative() {
    if (this.platform !== 'darwin') return this.metadata();
    await this.app.whenReady();
    if (typeof this.app.configureWebAuthn !== 'function') this.reason = 'electron-api-unavailable';
    else if (!await this.checkEntitlement()) this.reason = 'signed-keychain-entitlement-required';
    else {
      try {
        this.app.configureWebAuthn({ touchID: { keychainAccessGroup: WEB_AUTHN_KEYCHAIN_GROUP, promptReason: 'sign in to $1' } });
        this.configured = true;
        this.touchIdAvailable = this.systemPreferences.canPromptTouchID();
        this.reason = this.touchIdAvailable ? null : 'touch-id-unavailable';
      } catch { this.reason = 'native-configuration-failed'; }
    }
    return this.metadata();
  }

  metadata() {
    return { electronVersion: this.electronVersion, touchIdConfigured: this.configured,
      touchIdAvailable: this.touchIdAvailable, touchIdReason: this.reason,
      credentialScope: 'device-and-browser-profile', existingMacPasskeys: false,
      existingMacPasskeysReason: this.platform === 'darwin' ? 'full-chrome-sign-in-required' : 'macos-required',
      requestSource: 'website', userVerification: 'native', pendingSelections: this.pending.size };
  }

  attachSession(session) {
    if (this.sessions.has(session)) return;
    const listener = (_event, details, callback) => { void this.selectAccount(details, callback); };
    this.sessions.set(session, listener);
    session.on('select-webauthn-account', listener);
  }

  async selectAccount(details, callback) {
    let settled = false;
    let cleanup = () => {};
    const finish = (credentialId) => {
      if (settled) return;
      settled = true;
      try { cleanup(); } finally { callback(credentialId); }
    };
    try {
      const frame = details.frame;
      const tab = frame && this.getTabForFrame(frame);
      const contents = tab?.view?.webContents;
      const window = tab && this.getWindowForTab(tab);
      const accounts = details.accounts;
      if (!contents || contents.isDestroyed() || !window || window.isDestroyed() || !tab.sessionId ||
        !Array.isArray(accounts) || accounts.length === 0 || accounts.length > 64 ||
        accounts.some((account) => typeof account.credentialId !== 'string' || !account.credentialId)) {
        finish(); return;
      }
      this.cancelTab(tab);
      const origin = new URL(frame.url).origin;
      const binding = { targetId: tab.targetId, sessionId: tab.sessionId, windowId: tab.windowId, navigationEpoch: tab.navigationEpoch };
      const controller = new AbortController();
      const cancel = () => { controller.abort(); finish(); };
      const timer = setTimeout(cancel, this.selectionTimeoutMs);
      timer.unref?.();
      const events = ['did-start-navigation', 'destroyed', 'render-process-gone'];
      for (const event of events) contents.once(event, cancel);
      window.once('closed', cancel);
      this.pending.set(contents.id, { tab, cancel });
      cleanup = () => {
        clearTimeout(timer);
        for (const event of events) contents.removeListener(event, cancel);
        window.removeListener('closed', cancel);
        this.pending.delete(contents.id);
        this.emitState(tab, { type: 'passkey-selection-complete', passkeys: this.metadata() });
      };
      this.emitState(tab, { type: 'passkey-selection', relyingPartyId: details.relyingPartyId, passkeys: this.metadata() });
      // 기본 버튼은 취소다. 계정 선택은 사용자만 네이티브 대화상자에서 처리한다.
      const { response } = await this.dialog.showMessageBox(window, { type: 'question', title: '패스키 계정 선택',
        message: `${label(details.relyingPartyId)}에 로그인할 계정을 선택하세요.`,
        detail: origin, buttons: ['취소', ...accounts.map((account) => label(account.name || account.displayName || '계정'))],
        defaultId: 0, cancelId: 0, noLink: true, normalizeAccessKeys: false, signal: controller.signal });
      const currentTab = this.getTabForFrame(frame);
      const current = !settled && currentTab === tab && !contents.isDestroyed() && !window.isDestroyed() &&
        Object.entries(binding).every(([key, value]) => tab[key] === value) && new URL(frame.url).origin === origin;
      finish(current && Number.isInteger(response) && response > 0 ? accounts[response - 1]?.credentialId : undefined);
    } catch { finish(); }
  }

  cancelTab(tab) {
    for (const pending of this.pending.values()) if (pending.tab === tab) pending.cancel();
  }

  emitState(tab, state) {
    try { this.onState(tab, state); } catch {}
  }

  dispose() {
    for (const pending of this.pending.values()) pending.cancel();
    for (const [session, listener] of this.sessions) session.removeListener('select-webauthn-account', listener);
    this.sessions.clear();
  }
}

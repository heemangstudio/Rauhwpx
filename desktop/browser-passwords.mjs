import { randomUUID } from 'node:crypto';
import { LocalBrowserPasswordVault, passwordFailure, passwordOrigin } from './browser-local-password-vault.mjs';
import { ChromePasswordImporter } from './browser-chrome-password-import.mjs';
import { BROWSER_CONTROL_SELECTOR, browserRole } from '../rhwp/rhwp-agent/browser-roles.mjs';

const WORLD = 1007;
const SENSITIVE = 'input[type="password"],input[type="email"],input[autocomplete="username"],input[name="username"],input[name="email"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]';
const SECRET = 'input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]';

// These functions run only in Electron's isolated world. Page scripts never see the ref map.
function pageSnapshot(token, selector, maxElements, elementSelector) {
  const secrets = [...document.querySelectorAll(selector)].map(el => el.value).filter(Boolean);
  const maskedValues = secrets.flatMap(secret => [secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6)]);
  const scrub = value => { for (const secret of maskedValues) value = value.split(secret).join('[masked]'); return value; };
  const refs = new Map(); const elements = [];
  const candidates = document.querySelectorAll(elementSelector);
  for (const el of candidates) {
    if (elements.length >= maxElements) break;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || getComputedStyle(el).visibility === 'hidden') continue;
    const sensitive = el.matches(selector);
    const ref = `e${elements.length + 1}`; refs.set(ref, el);
    const form = el.form instanceof HTMLFormElement ? el.form : null;
    const submitter = (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && ['submit', 'image'].includes(el.type) ? el : null;
    const formSensitive = form ? [...Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form)].some(control => control.matches(selector) || control.type === 'file') : undefined;
    const inputType = el instanceof HTMLInputElement ? el.type : undefined;
    const row = { ref, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || undefined,
      inputType, autocomplete: ['username', 'current-password', 'new-password', 'one-time-code', 'email'].includes(el.autocomplete) ? el.autocomplete : undefined,
      formMethod: form ? String(submitter?.getAttribute('formmethod') || form.method).toLowerCase() : undefined, formAction: form ? new URL(submitter?.getAttribute('formaction') || form.action, document.baseURI).href : undefined, formSensitive,
      name: scrub(String(el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.getAttribute('placeholder') || el.textContent || '').trim().slice(0, 500)),
      text: sensitive ? '[masked]' : scrub(String(el.textContent ?? '').trim().slice(0, 1000)), value: sensitive ? '[masked]' : scrub(String(el.value ?? '').slice(0, 1000)), sensitive, disabled: !!el.disabled,
      inViewport: rect.x < innerWidth && rect.y < innerHeight && rect.x + rect.width > 0 && rect.y + rect.height > 0,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
    if (inputType === 'checkbox' || inputType === 'radio') row.checked = !!el.checked;
    else if (el.hasAttribute('aria-checked')) row.checked = el.getAttribute('aria-checked') === 'true';
    if (el.tagName === 'A') {
      try { const href = new URL(el.href); if (/^https?:$/.test(href.protocol)) { href.username = ''; href.password = ''; row.href = scrub(href.href.slice(0, 2000)); } } catch {}
    }
    elements.push(row);
  }
  globalThis.__rhwpNativePasswordRefs = { token, refs };
  // Form values and selected text are excluded entirely from this native document observation.
  return { elements, text: scrub(String(document.body?.innerText ?? '').slice(0, 24000)), selectedText: '', hasSecret: secrets.length > 0, truncated: candidates.length > maxElements,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY } };
}

function captureViewport(secretSelector) {
  const roots = [document]; let masked = true; let hasSecret = false;
  for (let index = 0; index < roots.length; index++) {
    for (const el of roots[index].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.matches(secretSelector) && el.value) hasSecret = true;
      if (el.matches('input,textarea,select,[contenteditable],iframe,frame') && getComputedStyle(el).visibility !== 'hidden') masked = false;
    }
  }
  return { masked, hasSecret, width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY };
}

function pageAction(payload) {
  if (payload.action === 'stop') { window.stop(); return { completed: true }; }
  const current = globalThis.__rhwpNativePasswordRefs;
  if (!current || current.token !== payload.snapshotId || location.origin !== payload.origin) return { error: 'stale' };
  const el = payload.action === 'focus' && !payload.ref ? document.activeElement : current.refs.get(payload.ref);
  const ready = (field) => {
    if (!field?.isConnected || field.disabled || field.readOnly) return false;
    const rect = field.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(field).visibility !== 'hidden';
  };
  if (payload.action === 'wait') return { completed: payload.state === 'hidden' ? !ready(el) : ready(el) };
  if (payload.action === 'scroll') { window.scrollBy(payload.deltaX, payload.deltaY); return { completed: true }; }
  if (payload.action === 'focus' && !payload.ref) {
    if ((payload.key === 'Space' || /^[A-Za-z0-9]$/.test(payload.key)) && el?.matches(payload.sensitive)) return { error: 'secret' };
    return { completed: true };
  }
  if (!ready(el)) return { error: 'target' };
  if (payload.action === 'submission') {
    const form = el.form instanceof HTMLFormElement ? el.form : null;
    const type = String(el.type ?? '').toLowerCase();
    const submitter = (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) && ['submit', 'image'].includes(type) ? el : null;
    if (!form || (payload.submissionAction === 'click' ? !submitter : !(el instanceof HTMLInputElement && payload.textTypes.includes(type)))) return { completed: true, submission: null };
    const controls = [...Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form)];
    const sensitive = controls.some(control => control.matches(payload.sensitiveSelector) || control.type === 'file');
    // Never return protected form values, even to the hub's policy evaluator.
    if (sensitive) return { completed: true, submission: { sensitive: true } };
    const method = String(submitter?.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase();
    const destination = new URL(submitter?.getAttribute('formaction') || form.getAttribute('action') || location.href, document.baseURI);
    const params = new URLSearchParams();
    for (const control of controls) {
      const kind = String(control.type ?? '').toLowerCase();
      if (!control.name || control.disabled || ['submit', 'image', 'button', 'reset'].includes(kind) && control !== submitter) continue;
      if (['checkbox', 'radio'].includes(kind) && !control.checked) continue;
      if (control instanceof HTMLSelectElement) { for (const option of control.selectedOptions) params.append(control.name, option.value); continue; }
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLButtonElement) params.append(control.name, control === el && payload.typed !== null ? payload.typed : control.value);
    }
    destination.search = params.toString(); destination.hash = '';
    return { completed: true, submission: { method, url: destination.href, sensitive: false } };
  }
  if (payload.action === 'fill' || payload.action === 'validate-fill') {
    const password = current.refs.get(payload.passwordRef);
    const username = payload.usernameRef ? current.refs.get(payload.usernameRef) : null;
    if (!ready(password) || !(password instanceof HTMLInputElement) || password.type !== 'password' || username && (!ready(username) || !(username instanceof HTMLInputElement) || !['text', 'email', 'tel'].includes(username.type))) return { error: 'target' };
    const form = password.form;
    if (username && username.form !== form) return { error: 'target' };
    if (form?.action && new URL(form.action, location.href).origin !== payload.origin) return { error: 'origin' };
    if (payload.action === 'validate-fill') return { completed: true };
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    if (username) { username.setAttribute('data-rhwp-private-field', 'true'); setter.call(username, payload.username); }
    password.setAttribute('data-rhwp-private-field', 'true'); setter.call(password, payload.password);
    // Write both fields before site handlers run. Revalidate before each event.
    for (const field of [username, password].filter(Boolean)) {
      if (!ready(field) || location.origin !== payload.origin || password.type !== 'password') return { error: 'target' };
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { completed: true };
  }
  if (payload.action === 'click') {
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const rect = el.getBoundingClientRect(); const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const hit = document.elementFromPoint(point.x, point.y);
    if (point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight || !hit) return { error: 'target' };
    if (!(hit === el || el.contains(hit)) && hit.closest?.('label')?.control !== el) {
      let name = hit.matches(payload.sensitiveSelector) ? '[masked]' : String(hit.getAttribute('aria-label') || hit.getAttribute('title') || hit.textContent || hit.id || '');
      for (const field of document.querySelectorAll(payload.sensitiveSelector)) if (field.value) name = name.split(field.value).join('[masked]');
      return { error: 'covered', covering: { tag: hit.tagName.toLowerCase(), name: name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) } };
    }
    return { completed: true, point };
  }
  if (payload.action === 'type') {
    if (el.matches(payload.sensitive)) return { error: 'secret' };
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return { error: 'target' };
    const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, payload.text);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return { completed: true };
  }
  if (payload.action === 'focus') {
    if ((payload.key === 'Space' || /^[A-Za-z0-9]$/.test(payload.key)) && el.matches(payload.sensitive)) return { error: 'secret' };
    el.focus();
    if (['Control+a', 'Meta+a', 'ControlOrMeta+a'].includes(payload.key) && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select();
    return { completed: true };
  }
  return { error: 'target' };
}

function focusedForm() {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLInputElement)) return null;
  const container = focused.form ?? document;
  const passwords = [...container.querySelectorAll('input[type="password"]')].filter((el) => !el.disabled && !el.readOnly && el.getBoundingClientRect().width > 0);
  if (passwords.length !== 1) return null;
  const password = passwords[0];
  const usernames = [...container.querySelectorAll('input[autocomplete="username"],input[type="email"],input[name="username"],input[name="email"]')].filter((el) => !el.disabled && !el.readOnly && el.getBoundingClientRect().width > 0);
  const candidates = [...container.querySelectorAll('input')].filter(el => !el.disabled && !el.readOnly && ['text', 'email', 'tel'].includes(el.type) && el.getBoundingClientRect().width > 0 && el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
  const username = usernames[0] ?? candidates.at(-1);
  if (focused !== password && focused !== username) return null;
  const refs = globalThis.__rhwpNativePasswordRefs?.refs;
  return { passwordRef: [...refs ?? []].find(([, el]) => el === password)?.[0], usernameRef: [...refs ?? []].find(([, el]) => el === username)?.[0] };
}

export class NativeBrowserPasswords {
  constructor({ host, dataDir, safeStorage, vault, importer, Menu }) {
    this.host = host; this.vault = vault ?? new LocalBrowserPasswordVault({ dataDir, safeStorage });
    this.importer = importer ?? new ChromePasswordImporter({ vault: this.vault });
    this.Menu = Menu;
    host.passwords = this;
  }
  async run(tab, fn, args = []) {
    try { return await tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${fn.toString()})(...${JSON.stringify(args)})` }], true); }
    catch { throw passwordFailure('BROWSER_PASSWORD_TARGET_CHANGED', 'The page changed before native browser input completed.'); }
  }
  protectFamily(tab, origin, password) {
    const candidates = new Set([...this.host.tabs.values(), ...(this.host.pendingTabs ?? []), tab]);
    const keys = (candidate) => {
      const result = new Set(); const visited = new Set();
      for (let member = candidate; member && !visited.has(member); member = member.openerTab) {
        visited.add(member); result.add(member);
        if (member.targetId) result.add(`target:${member.targetId}`);
        if (member.openerTargetId) result.add(`target:${member.openerTargetId}`);
      }
      return result;
    };
    const connected = keys(tab); const family = new Set([tab]); let changed;
    do {
      changed = false;
      for (const candidate of candidates) {
        if (candidate.closing || candidate.view.webContents.isDestroyed()) continue;
        const related = keys(candidate);
        if ([...related].some((key) => connected.has(key))) {
          for (const key of related) connected.add(key);
          if (!family.has(candidate)) { family.add(candidate); changed = true; }
        }
      }
    } while (changed);
    for (const member of family) {
      member.passwordShield = true;
      member.passwordAllowedOrigins = new Set(member.passwordAllowedOrigins ?? []); member.passwordAllowedOrigins.add(origin);
      member.protectedPasswords = new Set(member.protectedPasswords ?? []); member.protectedPasswords.add(password);
    }
  }
  tab(params, { human = false } = {}) {
    const tab = this.host.tab(params.targetId ?? params.tabId);
    if (params.tabId !== tab.tabId || (!human && (params.targetId !== tab.targetId || params.sessionId !== tab.sessionId || (params.chatId ?? null) !== (tab.chatId ?? null)))) throw passwordFailure('BROWSER_PASSWORD_SCOPE_MISMATCH', 'The saved account request belongs to another browser tab or chat.');
    return tab;
  }
  assertSnapshot(tab, params) {
    if (tab.closing || !tab.view.webContents || tab.view.webContents.isDestroyed()) throw passwordFailure('BROWSER_PASSWORD_TARGET_CHANGED', 'The browser tab was closed.');
    const snapshot = tab.passwordSnapshot;
    if (!snapshot) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'Take a new browser snapshot.');
    if (snapshot.zoomFactor !== tab.view.webContents.getZoomFactor()) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'Page zoom changed. Take a new browser snapshot.');
    if (params.snapshotId !== snapshot.snapshotId || snapshot.generation !== this.host.generation || snapshot.owner !== this.host.owner || snapshot.navigationEpoch !== tab.navigationEpoch || snapshot.targetId !== tab.targetId || snapshot.sessionId !== tab.sessionId || snapshot.chatId !== tab.chatId || snapshot.controlEpoch !== (tab.passwordControlEpoch ?? 0) || snapshot.origin !== new URL(tab.view.webContents.getURL()).origin) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'Take a new browser snapshot before using this saved account.');
    return snapshot;
  }
  async snapshot(params, { viewportOnly = false } = {}) {
    const tab = this.tab(params);
    const epoch = tab.navigationEpoch; const snapshotId = `native-password-${randomUUID()}`;
    const lifetime = { generation: this.host.generation, owner: this.host.owner, targetId: tab.targetId, sessionId: tab.sessionId, chatId: tab.chatId, controlEpoch: tab.passwordControlEpoch ?? 0, zoomFactor: tab.view.webContents.getZoomFactor(), origin: new URL(tab.view.webContents.getURL()).origin };
    const observed = viewportOnly
      ? await this.run(tab, captureViewport, [SECRET]).then(({ hasSecret, width, height, deviceScaleFactor, scrollX, scrollY }) => ({ hasSecret, viewport: { width, height, deviceScaleFactor, scrollX, scrollY } }))
      : await this.run(tab, pageSnapshot, [snapshotId, SENSITIVE, 400, BROWSER_CONTROL_SELECTOR]);
    if (lifetime.zoomFactor !== tab.view.webContents.getZoomFactor()) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'Page zoom changed during the browser snapshot.');
    if (tab.closing || tab.view.webContents.isDestroyed() || epoch !== tab.navigationEpoch || lifetime.generation !== this.host.generation || lifetime.owner !== this.host.owner || lifetime.targetId !== tab.targetId || lifetime.sessionId !== tab.sessionId || lifetime.chatId !== tab.chatId || lifetime.controlEpoch !== (tab.passwordControlEpoch ?? 0) || lifetime.origin !== new URL(tab.view.webContents.getURL()).origin) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'The page changed during the browser snapshot.');
    const url = new URL(tab.view.webContents.getURL());
    if (!viewportOnly) observed.elements = observed.elements.map(element => ({ ...element, role: browserRole(element.role, element.tag, element.inputType) }));
    if (!viewportOnly) tab.passwordSnapshot = { snapshotId, generation: this.host.generation, owner: this.host.owner, navigationEpoch: epoch, targetId: tab.targetId, sessionId: tab.sessionId, chatId: tab.chatId, controlEpoch: tab.passwordControlEpoch ?? 0, zoomFactor: lifetime.zoomFactor, origin: url.origin, elements: observed.elements };
    return this.redact(tab, { ...observed, snapshotId, nativeNavigationEpoch: epoch, nativeControlEpoch: lifetime.controlEpoch, zoomFactor: lifetime.zoomFactor, url: tab.passwordShield || observed.hasSecret ? `${url.origin}/` : `${url.origin}${url.pathname}`, title: tab.passwordShield || observed.hasSecret ? '' : tab.view.webContents.getTitle(), passwordProtected: !!tab.passwordShield || observed.hasSecret });
  }
  async capture(params) {
    const tab = this.tab(params);
    if (!tab.passwordShield) return { available: false };
    const contents = tab.view.webContents;
    // 저장된 비밀번호는 페이지 본문에도 복사될 수 있어 이미지로 내보내지 않는다.
    const assertSafe = () => {
      if (tab.protectedPasswords?.size) throw passwordFailure('BROWSER_PASSWORD_CAPTURE_PROTECTED', '저장된 비밀번호를 사용한 페이지는 캡처할 수 없습니다. 다른 탭에서 캡처해 주세요.');
    };
    assertSafe();
    if (tab.passwordCapturePending) throw passwordFailure('BROWSER_CAPTURE_PENDING', '화면 캡처가 진행 중입니다. 잠시 후 다시 시도해 주세요.');
    tab.passwordCapturePending = true;
    const epoch = tab.navigationEpoch; const controlEpoch = tab.passwordControlEpoch ?? 0;
    const generation = this.host.generation; const owner = this.host.owner; const zoom = contents.getZoomFactor();
    const current = () => {
      assertSafe();
      if (tab.closing || contents.isDestroyed() || epoch !== tab.navigationEpoch || controlEpoch !== (tab.passwordControlEpoch ?? 0) || generation !== this.host.generation || owner !== this.host.owner || zoom !== contents.getZoomFactor()) throw passwordFailure('BROWSER_STALE_FRAME', '페이지가 변경되었습니다. 현재 화면을 다시 캡처해 주세요.');
    };
    let css; let timer; let result;
    try {
      // 폼과 하위 프레임은 숨기고 실제 마스킹을 확인한다. 값은 읽거나 전송하지 않는다.
      css = await contents.insertCSS('input,textarea,select,[contenteditable],iframe,frame { visibility: hidden !important; }');
      current();
      const viewport = await this.run(tab, captureViewport, [SECRET]);
      if (viewport.hasSecret) throw passwordFailure('BROWSER_PASSWORD_CAPTURE_PROTECTED', '비밀번호가 입력된 페이지는 캡처할 수 없습니다. 다른 탭에서 캡처해 주세요.');
      if (!viewport.masked) throw passwordFailure('BROWSER_CAPTURE_MASK_FAILED', '입력 내용을 안전하게 가릴 수 없어 캡처를 중단했습니다.');
      const image = await Promise.race([
        contents.capturePage({}, { stayAwake: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(passwordFailure('BROWSER_CAPTURE_TIMEOUT', '화면 캡처 시간이 초과되었습니다. 다시 시도해 주세요.')), 5000); }),
      ]);
      current();
      const after = await this.run(tab, captureViewport, [SECRET]);
      current();
      if (after.hasSecret) throw passwordFailure('BROWSER_PASSWORD_CAPTURE_PROTECTED', '비밀번호가 입력된 페이지는 캡처할 수 없습니다. 다른 탭에서 캡처해 주세요.');
      if (JSON.stringify(viewport) !== JSON.stringify(after)) throw passwordFailure('BROWSER_STALE_GEOMETRY', '페이지 크기가 변경되었습니다. 현재 화면을 다시 캡처해 주세요.');
      if (!image || image.isEmpty()) throw passwordFailure('BROWSER_CAPTURE_IMAGE_FAILED', '화면을 캡처하지 못했습니다. 다시 시도해 주세요.');
      let captured = image;
      if (params.rect) {
        const scaleX = image.getSize().width / viewport.width; const scaleY = image.getSize().height / viewport.height;
        const r = params.rect;
        captured = image.crop({ x: Math.floor(r.x * scaleX), y: Math.floor(r.y * scaleY), width: Math.max(1, Math.floor(r.width * scaleX)), height: Math.max(1, Math.floor(r.height * scaleY)) });
      }
      result = { data: captured.toJPEG(75).toString('base64') };
    } finally {
      clearTimeout(timer);
      if (css && !contents.isDestroyed()) {
        await contents.removeInsertedCSS(css).catch(() => {});
        await this.run(tab, () => new Promise(resolve => { const timer = setTimeout(resolve, 100); requestAnimationFrame(() => { clearTimeout(timer); resolve(); }); })).catch(() => {});
      }
      tab.passwordCapturePending = false;
    }
    current();
    return result;
  }
  async fill(params, { human = false } = {}) {
    const tab = this.tab(params, { human });
    const snapshot = this.assertSnapshot(tab, params);
    const origin = passwordOrigin(tab.view.webContents.getURL());
    return this.vault.withCredential(params.accountId, async (credential, lease) => {
      this.assertSnapshot(tab, params);
      if (credential.origin !== origin) throw passwordFailure('BROWSER_PASSWORD_ORIGIN_MISMATCH', 'This saved account belongs to a different website.');
      const target = { snapshotId: snapshot.snapshotId, ref: params.passwordRef, passwordRef: params.passwordRef, usernameRef: params.usernameRef, origin };
      const checked = await this.run(tab, pageAction, [{ ...target, action: 'validate-fill' }]);
      this.assertSnapshot(tab, params);
      lease.assertCurrent();
      if (!checked?.completed) throw passwordFailure('BROWSER_PASSWORD_TARGET_INVALID', 'Choose a visible password field in a same-origin sign-in form.');
      // Stop outstanding raw reads before the first secret enters the guest DOM.
      const firstProtection = !tab.passwordShield;
      this.protectFamily(tab, origin, credential.password);
      if (firstProtection) await this.host.session?.closeAllConnections();
      this.assertSnapshot(tab, params);
      const result = await lease.write(() => this.run(tab, pageAction, [{ ...target, action: 'fill', username: credential.username, password: credential.password }]));
      if (!result?.completed) throw passwordFailure('BROWSER_PASSWORD_TARGET_INVALID', 'Choose a visible password field in a same-origin sign-in form.');
      return { completed: true, accountId: params.accountId };
    });
  }
  async action(params) {
    const tab = this.tab(params);
    if (params.action === 'stop') { tab.view.webContents.stop(); return { completed: true }; }
    const snapshot = this.assertSnapshot(tab, params);
    const allowed = ['click', 'type', 'press', 'scroll', 'wait', 'submission'];
    if (!allowed.includes(params.action)) throw passwordFailure('BROWSER_PASSWORD_ACTION_INVALID', 'This native browser action is unsupported.');
    let keyCode; let modifiers = [];
    if (params.action === 'press') {
      const pieces = String(params.key ?? '').split('+'); keyCode = pieces.pop();
      modifiers = pieces.map((part) => part === 'ControlOrMeta' ? process.platform === 'darwin' ? 'meta' : 'control' : part.toLowerCase());
      const plain = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Space'].includes(keyCode) || /^[A-Za-z0-9]$/.test(keyCode);
      const combination = ['Shift+Tab', 'Control+a', 'Meta+a', 'ControlOrMeta+a'].includes(params.key);
      if (!(plain && modifiers.length === 0 || combination)) throw passwordFailure('BROWSER_PASSWORD_KEY_INVALID', 'This browser shortcut is unavailable for native account input.');
    }
    let result;
    const expiresAt = Date.now() + Math.min(15000, Math.max(1, params.timeoutMs ?? 3000));
    do {
      this.assertSnapshot(tab, params);
      result = await this.run(tab, pageAction, [{ ...params, action: params.action === 'press' ? 'focus' : params.action, origin: snapshot.origin, sensitive: SECRET, sensitiveSelector: SENSITIVE }]);
      if (params.action !== 'wait' || result?.completed || Date.now() >= expiresAt) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (true);
    if (result?.error === 'covered') {
      const covering = this.redact(tab, result.covering);
      throw Object.assign(passwordFailure('BROWSER_TARGET_COVERED', `Another element covers this target: <${covering.tag}> "${covering.name}". Nothing was clicked.`), { retryable: true, hint: 'Dismiss or close the covering element, then take a new snapshot before clicking again.' });
    }
    if (!result?.completed) throw passwordFailure(result?.error === 'secret' ? 'BROWSER_SECRET_CHANNEL_REQUIRED' : 'BROWSER_PASSWORD_TARGET_INVALID', result?.error === 'secret' ? 'Use a saved account to fill this field.' : 'The selected browser field is no longer available.');
    if (params.action === 'submission') return this.redact(tab, result);
    if (params.action === 'press' || params.action === 'click') {
      this.assertSnapshot(tab, params);
      tab.automationInputDepth = (tab.automationInputDepth ?? 0) + 1;
      try {
        if (params.action === 'press') {
          keyCode = keyCode === 'Space' ? ' ' : keyCode;
          // Electron separates character input from physical key transitions.
          const character = modifiers.length === 0 ? keyCode === 'Enter' ? '\r' : keyCode.length === 1 ? keyCode : null : null;
          try {
            tab.view.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
            if (character) tab.view.webContents.sendInputEvent({ type: 'char', keyCode: character, modifiers });
          } finally {
            tab.view.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
          }
        } else {
          const { x, y } = result.point;
          const zoomFactor = snapshot.zoomFactor;
          tab.view.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x * zoomFactor), y: Math.round(y * zoomFactor), button: 'left', clickCount: 1 });
          tab.view.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x * zoomFactor), y: Math.round(y * zoomFactor), button: 'left', clickCount: 1 });
        }
      } finally { tab.automationInputDepth--; }
    }
    return { completed: true };
  }
  redact(tab, value) {
    const secrets = [...tab?.protectedPasswords ?? []].flatMap((secret) => [secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6), Buffer.from(secret).toString('base64')]).filter(Boolean);
    const scrub = (input) => {
      if (typeof input === 'string') { for (const secret of secrets) input = input.replaceAll(secret, '[masked]'); return input; }
      if (Array.isArray(input)) return input.map(scrub);
      if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) => [scrub(key), scrub(item)]));
      return input;
    };
    return scrub(value);
  }
  forgetTab(tab) {
    tab.passwordControlEpoch = (tab.passwordControlEpoch ?? 0) + 1;
    tab.passwordSnapshot = null; tab.protectedPasswords?.clear(); tab.passwordAllowedOrigins?.clear();
    tab.passwordShield = false;
  }
  async storageState() {
    if (![...this.host.tabs.values()].some((tab) => tab.passwordShield)) return null;
    let value = { cookies: await this.host.getCookies(), origins: [], originsComplete: false };
    for (const tab of this.host.tabs.values()) value = this.redact(tab, value);
    return value;
  }
  async armSave(window, params) {
    const tab = this.host.ownedTab(params.tabId, window);
    if (!tab.interactive) throw passwordFailure('BROWSER_PASSWORD_HUMAN_CONTROL_REQUIRED', 'Show this browser tab before saving a login.');
    const origin = passwordOrigin(tab.view.webContents.getURL());
    const epoch = tab.navigationEpoch;
    if (!await this.vault.available()) throw passwordFailure('BROWSER_PASSWORD_STORAGE_UNAVAILABLE', 'OS password storage is unavailable.');
    if (!tab.interactive || tab.closing || tab.view.webContents.isDestroyed() || epoch !== tab.navigationEpoch || origin !== passwordOrigin(tab.view.webContents.getURL())) throw passwordFailure('BROWSER_PASSWORD_TARGET_CHANGED', 'The login page changed. Try again.');
    const token = params.enabled === false ? null : randomUUID();
    tab.manualPasswordSave = token ? { token, origin, epoch: tab.navigationEpoch } : null;
    if (token) {
      tab.passwordShield = true;
      tab.passwordAllowedOrigins = new Set(tab.passwordAllowedOrigins ?? []); tab.passwordAllowedOrigins.add(origin);
    }
    tab.view.webContents.send('desktop:browser-guest-arm-save', token);
    return { enabled: !!token, navigationEpoch: epoch };
  }
  restoreManualSave(tab) {
    const armed = tab.manualPasswordSave;
    if (!armed || tab.closing || tab.view.webContents.isDestroyed()) return;
    let sameOrigin = false;
    try { sameOrigin = passwordOrigin(tab.view.webContents.getURL()) === armed.origin; } catch {}
    tab.manualPasswordSave = sameOrigin ? { ...armed, token: randomUUID(), epoch: tab.navigationEpoch } : null;
    tab.view.webContents.send('desktop:browser-guest-arm-save', tab.manualPasswordSave?.token ?? null);
    this.host.emit(tab, 'password-save-mode', { enabled: sameOrigin });
  }
  async saveLogin(event, payload) {
    const tab = [...this.host.tabs.values()].find(entry => entry.view.webContents === event.sender);
    const armed = tab?.manualPasswordSave;
    if (!armed || !tab.interactive || event.senderFrame !== event.sender.mainFrame || payload?.token !== armed.token || armed.epoch !== tab.navigationEpoch) return;
    let origin;
    try { origin = passwordOrigin(event.senderFrame.url); } catch { return; }
    if (origin !== armed.origin || typeof payload.username !== 'string' || typeof payload.password !== 'string' || !payload.username || !payload.password || Buffer.byteLength(payload.username) + Buffer.byteLength(payload.password) > 12 * 1024) return;
    this.protectFamily(tab, origin, payload.password);
    try {
      await this.vault.importCredential({ origin, username: payload.username, password: payload.password, sourceProfile: 'Hama Browser' });
      this.host.emit(tab, 'password-save', { state: 'saved' });
    } catch {
      this.host.emit(tab, 'password-save', { state: 'failed' });
    } finally { payload.password = ''; }
  }
  async humanFill(window, params) {
    const tab = this.host.ownedTab(params.tabId, window);
    if (!tab.interactive) throw passwordFailure('BROWSER_PASSWORD_HUMAN_CONTROL_REQUIRED', 'Show this browser tab before using a saved password.');
    const binding = { targetId: tab.targetId, tabId: tab.tabId, sessionId: tab.sessionId, chatId: tab.chatId };
    const snapshot = await this.snapshot(binding);
    const fields = await this.run(tab, focusedForm);
    if (!fields?.passwordRef) throw passwordFailure('BROWSER_PASSWORD_TARGET_INVALID', 'Focus a sign-in field before using a saved password.');
    return this.fill({ ...binding, ...fields, accountId: params.accountId, snapshotId: snapshot.snapshotId }, { human: true });
  }
  async autocomplete(event, payload) {
    const tab = [...this.host.tabs.values()].find((entry) => entry.view.webContents === event.sender);
    if (!tab || event.senderFrame !== event.sender.mainFrame || !tab.interactive || payload?.eligible !== true || !this.Menu) return;
    let origin;
    try { origin = passwordOrigin(event.sender.getURL()); } catch { return; }
    const epoch = tab.navigationEpoch;
    const { accounts } = await this.vault.list();
    const matching = accounts.filter((account) => account.origin === origin);
    if (!matching.length || epoch !== tab.navigationEpoch || !tab.interactive) return;
    const window = this.host.getWindowForSession(tab.sessionId);
    if (!window || window.isDestroyed()) return;
    this.Menu.buildFromTemplate(matching.map((account) => ({ label: account.username || account.label, click: () => {
      if (epoch !== tab.navigationEpoch || !tab.interactive) return;
      void this.humanFill(window, { tabId: tab.tabId, accountId: account.id }).catch(() => {});
    } }))).popup({ window });
  }
}

export function registerBrowserPasswordIpc({ ipcMain, browserHost, passwords = browserHost.passwords, browserWindowForEvent }) {
  const handlers = {
    profiles: () => passwords.importer.listProfiles(), import: (_window, payload) => passwords.importer.importProfile(payload),
    list: () => passwords.vault.list(), remove: (_window, payload) => passwords.vault.remove(payload?.id),
    fill: (window, payload) => passwords.humanFill(window, payload),
    armSave: (window, payload) => passwords.armSave(window, payload),
  };
  for (const [operation, handler] of Object.entries(handlers)) ipcMain.handle(`desktop:browser-passwords-${operation}`, (event, payload) => handler(browserWindowForEvent(event), payload));
  const autocomplete = (event, payload) => { void passwords.autocomplete(event, payload).catch(() => {}); };
  ipcMain.on('desktop:browser-guest-autocomplete', autocomplete);
  const saveLogin = (event, payload) => { void passwords.saveLogin(event, payload).catch(() => {}); };
  ipcMain.on('desktop:browser-guest-save-login', saveLogin);
  return () => { for (const operation of Object.keys(handlers)) ipcMain.removeHandler(`desktop:browser-passwords-${operation}`); ipcMain.removeListener('desktop:browser-guest-autocomplete', autocomplete); ipcMain.removeListener('desktop:browser-guest-save-login', saveLogin); };
}

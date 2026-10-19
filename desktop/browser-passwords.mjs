import { randomUUID } from 'node:crypto';
import { LocalBrowserPasswordVault, passwordFailure, passwordOrigin } from './browser-local-password-vault.mjs';
import { ChromePasswordImporter } from './browser-chrome-password-import.mjs';
import { ChromeCookieImporter } from './browser-chrome-cookie-import.mjs';
import { sameSite, siteScope } from './browser-site.mjs';

const WORLD = 1007;
const SENSITIVE = 'input[type="password"],input[type="email"],input[autocomplete="username"],input[name="username"],input[name="email"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]';
const SECRET = 'input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]';
/** 앱 전체에서 가리는 입력값 수. 넘으면 가장 오래된 값부터 뺀다. */
const PROTECTED_LIMIT = 256;

// These functions run only in Electron's isolated world. Page scripts never see the ref map.
// 허브가 Playwright aria 개요와 같은 노드 모양으로 그린다. 조작 가능한 요소와 범위 컨테이너만 ref를 받는다.
function pageSnapshot(token, selector, maxElements, includeText) {
  const secrets = [...document.querySelectorAll('input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-rhwp-private-field]')].map(el => el.value).filter(Boolean);
  const scrub = value => { for (const secret of secrets) value = value.split(secret).join('[masked]'); return value; };
  const squash = value => scrub(String(value ?? '').replace(/\s+/g, ' ').trim());
  // 같은 문서 안에서는 같은 요소가 같은 ref를 유지한다.
  const ids = globalThis.__rhwpNativeRefIds ??= { map: new WeakMap(), next: 0 };
  const refFor = el => { let ref = ids.map.get(el); if (!ref) { ref = `e${++ids.next}`; ids.map.set(el, ref); } return ref; };
  const CONTROLS = 'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],[role="menuitem"],[role="option"],[role="tab"],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';
  const CONTAINERS = new Set(['main', 'navigation', 'contentinfo', 'form', 'search', 'dialog', 'alertdialog', 'region', 'table', 'grid', 'tablist', 'menu', 'menubar', 'tree']);
  const FROM_CONTENT = new Set(['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'heading', 'switch', 'checkbox', 'radio']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe', 'frame', 'object', 'embed', 'head', 'meta', 'link', 'datalist']);
  const TAGS = { p: 'paragraph', ul: 'list', ol: 'list', menu: 'list', li: 'listitem', nav: 'navigation', main: 'main', aside: 'complementary', form: 'form', search: 'search', dialog: 'dialog', table: 'table', tr: 'row', td: 'cell', th: 'columnheader', fieldset: 'group', blockquote: 'blockquote', article: 'article', details: 'group', textarea: 'textbox', summary: 'button', option: 'option' };
  const implicitRole = el => {
    const tag = el.localName;
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'button') return 'button';
    if (tag === 'input') return el.type === 'hidden' ? null : ['button', 'submit', 'reset', 'image', 'file'].includes(el.type) ? 'button' : { checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' }[el.type] ?? 'textbox';
    if (tag === 'select') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return el.alt ? 'img' : null;
    if (tag === 'section') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    if (tag === 'footer') return el.parentElement?.closest('article,aside,main,nav,section') ? null : 'contentinfo';
    if (el.isContentEditable && el.matches('[contenteditable]')) return 'textbox';
    return TAGS[tag] ?? null;
  };
  // 라벨 안의 입력 칸과 선택지 글은 이름에 넣지 않는다.
  const ownText = el => { let value = ''; const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('select,textarea,script,style,[aria-hidden="true"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT }); while (walker.nextNode()) value += ` ${walker.currentNode.data}`; return value; };
  const nameOf = (el, role) => {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) { const value = labelledBy.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(ownText).join(' '); if (value.trim()) return value; }
    const label = el.getAttribute('aria-label'); if (label?.trim()) return label;
    if (el.localName === 'input' && ['button', 'submit', 'reset'].includes(el.type)) return el.value || { submit: 'Submit', reset: 'Reset' }[el.type] || '';
    if (el.localName === 'input' && el.type === 'image') return el.alt || el.value || 'Submit';
    if (el.labels?.length) { const value = [...el.labels].map(ownText).join(' '); if (value.trim()) return value; }
    if (el.localName === 'img') return el.alt;
    if (FROM_CONTENT.has(role)) { const value = ownText(el) || el.querySelector('img[alt]')?.alt; if (value?.trim()) return value; }
    return el.getAttribute('placeholder') || el.getAttribute('title') || '';
  };
  const refs = new Map(); const elements = []; let count = 0; let truncated = false;
  const visible = el => el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true }) || (getComputedStyle(el).display === 'contents' ? 'contents' : false);
  const walk = parent => {
    const out = [];
    const children = parent.localName === 'slot' ? parent.assignedNodes({ flatten: true }) : (parent.shadowRoot ?? parent).childNodes;
    for (const child of children) {
      if (count >= 6000) { truncated = true; break; }
      if (child.nodeType === 3) { const value = squash(child.data); if (value) { out.push(value.slice(0, 1000)); count++; } continue; }
      if (child.nodeType !== 1) continue;
      const el = child; const tag = el.localName;
      if (SKIP.has(tag) || el.getAttribute('aria-hidden') === 'true' || tag === 'input' && el.type === 'hidden') continue;
      const shown = visible(el);
      if (!shown) continue;
      if (shown === 'contents') { out.push(...walk(el)); continue; }
      const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0];
      const role = explicit && !['none', 'presentation', 'generic'].includes(explicit) ? explicit : implicitRole(el);
      const control = el.matches(CONTROLS);
      if (control) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || elements.length >= maxElements) { if (elements.length >= maxElements) truncated = true; out.push(...walk(el).filter(node => typeof node === 'object')); continue; }
      }
      if (!role) { out.push(...walk(el)); continue; }
      count++;
      const node = { role };
      const name = squash(nameOf(el, role)).slice(0, 500); if (name) node.name = name;
      if (role === 'heading') node.level = Number(el.getAttribute('aria-level')) || Number(tag[1]) || 2;
      const sensitive = el.matches(selector);
      if (control || CONTAINERS.has(role) && (role !== 'region' || name)) {
        const ref = refFor(el); node.ref = ref; refs.set(ref, el);
        const rect = el.getBoundingClientRect();
        elements.push({ ref, tag, role: node.role, name: name.slice(0, 500), inputType: el instanceof HTMLInputElement ? el.type : undefined, autocomplete: ['username', 'current-password', 'new-password', 'one-time-code', 'email'].includes(el.autocomplete) ? el.autocomplete : undefined,
          formMethod: el.closest('form')?.method, formAction: el.closest('form')?.action, sensitive, disabled: !!el.disabled, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
      }
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') node.disabled = true;
      if (el instanceof HTMLInputElement && ['checkbox', 'radio'].includes(el.type)) node.checked = el.indeterminate ? 'mixed' : el.checked;
      else if (el.hasAttribute('aria-checked')) node.checked = el.getAttribute('aria-checked') === 'mixed' ? 'mixed' : el.getAttribute('aria-checked') === 'true';
      if (el.hasAttribute('aria-expanded')) node.expanded = el.getAttribute('aria-expanded') === 'true';
      else if (tag === 'summary') node.expanded = !!el.parentElement?.open;
      if (el.getAttribute('aria-selected') === 'true') node.selected = true;
      if (el.hasAttribute('aria-pressed')) node.pressed = el.getAttribute('aria-pressed') === 'true';
      if (node.checked === false) delete node.checked;
      if (el instanceof HTMLSelectElement) {
        node.children = [...el.options].slice(0, 500).map(option => ({ role: 'option', name: squash(option.label).slice(0, 500), ...(option.selected ? { selected: true } : {}) }));
      } else if (el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'image', 'file', 'checkbox', 'radio'].includes(el.type) || el instanceof HTMLTextAreaElement || role === 'textbox' && el.isContentEditable) {
        const value = el.isContentEditable && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) ? el.innerText : el.value;
        if (value) node.value = sensitive ? '[masked]' : squash(value).slice(0, 1000);
      } else if (sensitive) {
        // 비공개로 표시한 영역의 내용은 읽지 않는다.
      } else if (FROM_CONTENT.has(role) && name) {
        // 내용에서 이름을 얻은 노드는 같은 글을 다시 담지 않고 안쪽 조작 요소만 남긴다.
        const nested = walk(el).filter(entry => typeof entry === 'object'); if (nested.length) node.children = nested;
      } else { const nested = walk(el); if (nested.length) node.children = nested; }
      out.push(node);
    }
    return out;
  };
  const tree = document.body ? walk(document.body) : [];
  globalThis.__rhwpNativePasswordRefs = { token, refs };
  // Form values and selected text are excluded entirely from this native document observation.
  return { tree, elements, ...(includeText ? { text: scrub(String(document.body?.innerText ?? '').slice(0, 24000)) } : {}), selectedText: '', hasSecret: secrets.length > 0, truncated,
    viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY } };
}

function captureViewport(secretSelector, protectedValues = []) {
  const roots = [document]; let masked = true; let hasSecret = false;
  // 허브가 다른 탭에 입력한 사용자 비밀을 사이트가 다시 보여 주는 페이지도 캡처하지 않는다.
  const shows = (value) => typeof value === 'string' && protectedValues.some((secret) => value.includes(secret));
  if (protectedValues.length && shows(String(document.documentElement?.innerText ?? ''))) hasSecret = true;
  for (let index = 0; index < roots.length; index++) {
    for (const el of roots[index].querySelectorAll('*')) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.matches(secretSelector) && el.value) hasSecret = true;
      if (protectedValues.length && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && shows(el.value)) hasSecret = true;
      if (el.matches('input,textarea,select,[contenteditable],iframe,frame') && getComputedStyle(el).visibility !== 'hidden') masked = false;
    }
  }
  return { masked, hasSecret, width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio, scrollX, scrollY };
}

function pageAction(payload) {
  if (payload.action === 'stop') { window.stop(); return { completed: true }; }
  const current = globalThis.__rhwpNativePasswordRefs;
  if (!current || current.token !== payload.snapshotId || location.origin !== payload.origin) return { error: 'stale' };
  const el = current.refs.get(payload.ref);
  // 읽기 전용은 값을 쓰는 동작에서만 막는다. 읽기 전용 칸으로 만든 목록·날짜 선택기도 누를 수 있어야 한다.
  const writes = ['type', 'fill', 'validate-fill', 'fill-secret', 'validate-secret'].includes(payload.action);
  const ready = (field, editable = writes) => {
    if (!field?.isConnected || field.disabled || editable && field.readOnly) return false;
    const rect = field.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(field).visibility !== 'hidden';
  };
  if (payload.action === 'wait') return { completed: payload.state === 'hidden' ? !ready(el) : ready(el) };
  if (payload.action === 'scroll') { window.scrollBy(payload.deltaX, payload.deltaY); return { completed: true }; }
  if (!ready(el)) return { error: 'target' };
  // 폼은 같은 사이트(등록 도메인)로만 보내야 한다. 등록 도메인이 없는 사이트는 정확한 출처만 된다.
  // 이름이 action 인 칸이 form.action 을 가릴 수 있어 속성을 직접 읽는다. 제출 단추의 formaction 도 본다.
  const onSite = (value) => {
    let url; try { url = new URL(value, document.baseURI); } catch { return false; }
    const key = new URL(payload.site.key);
    if (!payload.site.domain) return url.origin === key.origin;
    return url.protocol === key.protocol && url.port === key.port && (url.hostname === payload.site.domain || url.hostname.endsWith(`.${payload.site.domain}`));
  };
  const sendsOffSite = (form) => !!form && [form.getAttribute('action'), ...[...form.elements].filter((item) => ['submit', 'image'].includes(item.type)).map((item) => item.getAttribute('formaction'))].some((value) => value && !onSite(value));
  if (payload.action === 'validate-secret' || payload.action === 'fill-secret') {
    // 사용자가 승인한 비밀은 한 줄 글자 칸이나 textarea 한 곳에만 넣는다.
    const textInput = el instanceof HTMLInputElement && ['text', 'password', 'email', 'tel', 'url'].includes(el.type);
    if (!textInput && !(el instanceof HTMLTextAreaElement)) return { error: 'target' };
    if (el.autocomplete === 'one-time-code') return { error: 'code' };
    if (/^cc-/.test(el.autocomplete)) return { error: 'target' };
    if (sendsOffSite(el.form)) return { error: 'origin' };
    if (payload.action === 'validate-secret') return { completed: true };
    const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    el.setAttribute('data-rhwp-private-field', 'true');
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, payload.value);
    if (!ready(el) || location.origin !== payload.origin) return { error: 'target' };
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { completed: true };
  }
  if (payload.action === 'fill' || payload.action === 'validate-fill') {
    const password = current.refs.get(payload.passwordRef);
    const username = payload.usernameRef ? current.refs.get(payload.usernameRef) : null;
    if (!ready(password, true) || !(password instanceof HTMLInputElement) || password.type !== 'password' || username && (!ready(username, true) || !(username instanceof HTMLInputElement) || !['text', 'email', 'tel'].includes(username.type))) return { error: 'target' };
    const form = password.form;
    if (username && username.form !== form) return { error: 'target' };
    if (sendsOffSite(form)) return { error: 'origin' };
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
    // 고정 머리글 아래로 숨지 않도록 가운데로 올린다.
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    // 화면 안에 보이는 부분만 누른다. 화면보다 큰 요소는 가운데가 화면 밖일 수 있다.
    const left = Math.max(rect.left, 0), top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, innerWidth), bottom = Math.min(rect.bottom, innerHeight);
    if (right - left < 1 || bottom - top < 1) return { error: 'target' };
    // 웹 컴포넌트 안까지 내려가 실제로 눌릴 요소를 찾는다. document 기준 결과는 그림자 호스트에서 멈춘다.
    const deepHit = (x, y) => {
      let hit = document.elementFromPoint(x, y);
      for (let depth = 0; hit?.shadowRoot && depth < 32; depth++) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
      return hit;
    };
    // 눌린 요소가 대상 안(그림자 경계·slot 포함)이거나 대상과 연결된 label 이면 대상을 누른 것이다.
    const reaches = (hit) => {
      for (let node = hit; node; node = node.assignedSlot ?? node.parentNode ?? node.host) if (node === el) return true;
      const label = hit?.closest?.('label');
      return !!label && label.control === el;
    };
    const w = right - left, h = bottom - top, cx = left + w / 2, cy = top + h / 2;
    // 가운데를 배너·쿠키 알림이 가리면 요소 안의 다른 지점을 시도한다.
    const points = [[cx, cy], [left + w * 0.25, cy], [left + w * 0.75, cy], [cx, top + h * 0.25], [cx, top + h * 0.75], [left + Math.min(4, w / 2), top + Math.min(4, h / 2)], [right - Math.min(4, w / 2), bottom - Math.min(4, h / 2)]];
    for (const [x, y] of points) {
      if (reaches(deepHit(x, y))) return { completed: true, point: { x, y } };
    }
    return { error: 'target' };
  }
  // 일회용 코드는 사용자가 직접 입력한다. 비밀번호·카드 칸과 다른 안내를 준다.
  const secretError = () => el.autocomplete === 'one-time-code' ? 'code' : 'secret';
  if (payload.action === 'type') {
    if (el.matches(payload.sensitive)) return { error: secretError() };
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return { error: 'target' };
    const prototype = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, payload.text);
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return { completed: true };
  }
  if (payload.action === 'select') {
    if (!(el instanceof HTMLSelectElement)) return { error: 'select' };
    const wanted = String(payload.option ?? '').trim(); const options = [...el.options].filter(option => !option.disabled);
    const option = options.find(entry => entry.label.trim() === wanted) ?? options.find(entry => entry.value === wanted) ?? options.find(entry => entry.label.trim().toLowerCase() === wanted.toLowerCase());
    if (!option) return { error: 'option' };
    el.focus(); option.selected = true;
    el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
    return { completed: true };
  }
  if (payload.action === 'focus') {
    if ((payload.key === 'Space' || /^[A-Za-z0-9]$/.test(payload.key)) && el.matches(payload.sensitive)) return { error: secretError() };
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
    this.cookies = new ChromeCookieImporter({ host, profiles: this.importer });
    this.Menu = Menu;
    /** 저장된 비밀번호와 사용자 비밀 중 이 앱에서 입력한 값. 모든 탭의 관찰·상태·CDP 메시지에서 가린다. */
    this.protectedValues = new Set();
    this.protectedLoad = null;
    host.passwords = this;
  }
  protect(value) {
    if (typeof value !== 'string' || !value) return;
    this.protectedValues.delete(value); this.protectedValues.add(value);
    while (this.protectedValues.size > PROTECTED_LIMIT) this.protectedValues.delete(this.protectedValues.values().next().value);
  }
  /** 다시 시작한 뒤 첫 관찰 전에 최근에 입력한 비밀번호를 다시 가린다. 입력 기록이 없으면 OS 보관함을 열지 않는다. */
  loadProtectedValues() {
    this.protectedLoad ??= Promise.resolve().then(() => this.vault.recentPasswords?.() ?? []).then((values) => { for (const value of [...values].reverse()) this.protect(value); }, () => {});
    return this.protectedLoad;
  }
  clearProtectedValues() { this.protectedValues.clear(); this.protectedLoad = null; }
  async run(tab, fn, args = []) {
    try { return await tab.view.webContents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: `(${fn.toString()})(...${JSON.stringify(args)})` }], true); }
    catch { throw passwordFailure('BROWSER_PASSWORD_TARGET_CHANGED', 'The page changed before native browser input completed.'); }
  }
  protectFamily(tab, password) {
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
      member.protectedPasswords = new Set(member.protectedPasswords ?? []); member.protectedPasswords.add(password);
    }
    this.protect(password);
  }
  tab(params, { human = false } = {}) {
    const tab = this.host.tab(params.targetId ?? params.tabId);
    if (params.tabId !== tab.tabId || (!human && (params.targetId !== tab.targetId || params.sessionId !== tab.sessionId || (params.chatId ?? null) !== (tab.chatId ?? null)))) throw passwordFailure('BROWSER_PASSWORD_SCOPE_MISMATCH', 'The saved account request belongs to another browser tab or chat.');
    return tab;
  }
  assertSnapshot(tab, params) {
    if (tab.closing || !tab.view.webContents || tab.view.webContents.isDestroyed()) throw passwordFailure('BROWSER_PASSWORD_TARGET_CHANGED', 'The browser tab was closed.');
    const snapshot = tab.passwordSnapshot;
    if (snapshot?.zoomFactor !== tab.view.webContents.getZoomFactor()) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'Page zoom changed. Take a new browser snapshot.');
    if (!snapshot || params.snapshotId !== snapshot.snapshotId || snapshot.generation !== this.host.generation || snapshot.owner !== this.host.owner || snapshot.navigationEpoch !== tab.navigationEpoch || snapshot.targetId !== tab.targetId || snapshot.sessionId !== tab.sessionId || snapshot.chatId !== tab.chatId || snapshot.controlEpoch !== (tab.passwordControlEpoch ?? 0) || snapshot.origin !== new URL(tab.view.webContents.getURL()).origin) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'Take a new browser snapshot before using this saved account.');
    return snapshot;
  }
  async snapshot(params, { viewportOnly = false } = {}) {
    const tab = this.tab(params);
    await this.loadProtectedValues();
    const epoch = tab.navigationEpoch; const snapshotId = `native-password-${randomUUID()}`;
    const lifetime = { generation: this.host.generation, owner: this.host.owner, targetId: tab.targetId, sessionId: tab.sessionId, chatId: tab.chatId, controlEpoch: tab.passwordControlEpoch ?? 0, zoomFactor: tab.view.webContents.getZoomFactor(), origin: new URL(tab.view.webContents.getURL()).origin };
    const observed = viewportOnly
      ? await this.run(tab, captureViewport, [SECRET, [...new Set([...this.protectedValues, ...(Array.isArray(params.protectedValues) ? params.protectedValues.filter((value) => typeof value === 'string' && value).slice(0, 256) : [])])]]).then(({ hasSecret, width, height, deviceScaleFactor, scrollX, scrollY }) => ({ hasSecret, viewport: { width, height, deviceScaleFactor, scrollX, scrollY } }))
      : await this.run(tab, pageSnapshot, [snapshotId, SENSITIVE, 1000, params.text === true]);
    if (lifetime.zoomFactor !== tab.view.webContents.getZoomFactor()) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'Page zoom changed during the browser snapshot.');
    if (tab.closing || tab.view.webContents.isDestroyed() || epoch !== tab.navigationEpoch || lifetime.generation !== this.host.generation || lifetime.owner !== this.host.owner || lifetime.targetId !== tab.targetId || lifetime.sessionId !== tab.sessionId || lifetime.chatId !== tab.chatId || lifetime.controlEpoch !== (tab.passwordControlEpoch ?? 0) || lifetime.origin !== new URL(tab.view.webContents.getURL()).origin) throw passwordFailure('BROWSER_PASSWORD_STALE_REFERENCE', 'The page changed during the browser snapshot.');
    const url = new URL(tab.view.webContents.getURL());
    if (!viewportOnly) tab.passwordSnapshot = { snapshotId, generation: this.host.generation, owner: this.host.owner, navigationEpoch: epoch, targetId: tab.targetId, sessionId: tab.sessionId, chatId: tab.chatId, controlEpoch: tab.passwordControlEpoch ?? 0, zoomFactor: lifetime.zoomFactor, origin: url.origin, elements: observed.elements };
    return this.redact(tab, { ...observed, snapshotId, nativeNavigationEpoch: epoch, nativeControlEpoch: lifetime.controlEpoch, zoomFactor: lifetime.zoomFactor, url: tab.passwordShield || observed.hasSecret ? `${url.origin}/` : `${url.origin}${url.pathname}`, title: tab.passwordShield || observed.hasSecret ? '' : tab.view.webContents.getTitle(), passwordProtected: !!tab.passwordShield || observed.hasSecret });
  }
  async capture(params) {
    const tab = this.tab(params);
    if (!tab.passwordShield) return { available: false };
    await this.loadProtectedValues();
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
      const viewport = await this.run(tab, captureViewport, [SECRET, [...this.protectedValues]]);
      if (viewport.hasSecret) throw passwordFailure('BROWSER_PASSWORD_CAPTURE_PROTECTED', '비밀번호가 입력된 페이지는 캡처할 수 없습니다. 다른 탭에서 캡처해 주세요.');
      if (!viewport.masked) throw passwordFailure('BROWSER_CAPTURE_MASK_FAILED', '입력 내용을 안전하게 가릴 수 없어 캡처를 중단했습니다.');
      const image = await Promise.race([
        contents.capturePage({}, { stayAwake: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(passwordFailure('BROWSER_CAPTURE_TIMEOUT', '화면 캡처 시간이 초과되었습니다. 다시 시도해 주세요.')), 5000); }),
      ]);
      current();
      const after = await this.run(tab, captureViewport, [SECRET, [...this.protectedValues]]);
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
  /** 허브가 사이트 사용을 확인하고 넘긴 사용자 비밀을 한 칸에 넣는다. 비밀의 사이트(등록 도메인) 안에서만 넣는다. 값은 응답·로그에 남기지 않는다. */
  async fillSecret(params) {
    const tab = this.tab(params);
    const snapshot = this.assertSnapshot(tab, params);
    const origin = passwordOrigin(tab.view.webContents.getURL());
    if (!Array.isArray(params.origins) || !params.origins.some((entry) => sameSite(entry, origin))) throw passwordFailure('BROWSER_SECRET_ORIGIN_MISMATCH', 'This page is outside the websites saved for this secret.');
    if (typeof params.value !== 'string' || !params.value || Buffer.byteLength(params.value) > 16 * 1024) throw passwordFailure('BROWSER_SECRET_INVALID', 'The secret value is unavailable.');
    const { key, domain } = siteScope(origin);
    const target = { snapshotId: snapshot.snapshotId, ref: params.ref, origin, site: { key, domain } };
    const checked = await this.run(tab, pageAction, [{ ...target, action: 'validate-secret' }]);
    this.assertSnapshot(tab, params);
    if (checked?.error === 'code') throw passwordFailure('BROWSER_USER_CODE_REQUIRED', "The user must enter this one-time code. Call browser_request_account with kind 'code'.");
    if (!checked?.completed) throw passwordFailure(checked?.error === 'origin' ? 'BROWSER_SECRET_FORM_ORIGIN' : 'BROWSER_SECRET_TARGET_INVALID', checked?.error === 'origin' ? 'This form sends its data to another site.' : 'Choose a visible text or password field for this secret.');
    // 값이 페이지에 들어가기 전에 원시 읽기를 막는다(비밀번호 입력과 같은 보호).
    const firstProtection = !tab.passwordShield;
    this.protectFamily(tab, params.value);
    if (firstProtection) await this.host.session?.closeAllConnections();
    this.assertSnapshot(tab, params);
    const result = await this.run(tab, pageAction, [{ ...target, action: 'fill-secret', value: params.value }]);
    if (!result?.completed) throw passwordFailure('BROWSER_SECRET_TARGET_INVALID', 'Choose a visible text or password field for this secret.');
    return { completed: true };
  }
  async fill(params, { human = false } = {}) {
    if (!human && params?.mode === 'secret') return this.fillSecret(params);
    const tab = this.tab(params, { human });
    const snapshot = this.assertSnapshot(tab, params);
    const origin = passwordOrigin(tab.view.webContents.getURL());
    const { key, domain } = siteScope(origin);
    const filled = await this.vault.withCredential(params.accountId, async (credential, lease) => {
      this.assertSnapshot(tab, params);
      // 로그인은 자기 사이트(등록 도메인) 안에서만 넣는다. www 에 저장한 계정도 login.* 에서 쓸 수 있다.
      if (!sameSite(credential.origin, origin)) throw passwordFailure('BROWSER_PASSWORD_ORIGIN_MISMATCH', 'This saved account belongs to a different website.');
      const target = { snapshotId: snapshot.snapshotId, ref: params.passwordRef, passwordRef: params.passwordRef, usernameRef: params.usernameRef, origin, site: { key, domain } };
      const checked = await this.run(tab, pageAction, [{ ...target, action: 'validate-fill' }]);
      this.assertSnapshot(tab, params);
      lease.assertCurrent();
      if (!checked?.completed) throw passwordFailure(checked?.error === 'origin' ? 'BROWSER_PASSWORD_FORM_ORIGIN' : 'BROWSER_PASSWORD_TARGET_INVALID', checked?.error === 'origin' ? 'This sign-in form sends its data to another site.' : 'Choose a visible password field in a same-site sign-in form.');
      // Stop outstanding raw reads before the first secret enters the guest DOM.
      const firstProtection = !tab.passwordShield;
      this.protectFamily(tab, credential.password);
      if (firstProtection) await this.host.session?.closeAllConnections();
      this.assertSnapshot(tab, params);
      const result = await lease.write(() => this.run(tab, pageAction, [{ ...target, action: 'fill', username: credential.username, password: credential.password }]));
      if (!result?.completed) throw passwordFailure('BROWSER_PASSWORD_TARGET_INVALID', 'Choose a visible password field in a same-site sign-in form.');
      return { completed: true, accountId: params.accountId };
    }, { agent: !human, grant: human ? null : params.grant });
    await Promise.resolve(this.vault.markFilled?.(params.accountId)).catch(() => {});
    return filled;
  }
  async action(params) {
    const tab = this.tab(params);
    if (params.action === 'stop') { tab.view.webContents.stop(); return { completed: true }; }
    const snapshot = this.assertSnapshot(tab, params);
    const allowed = ['click', 'type', 'press', 'select', 'scroll', 'wait'];
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
      result = await this.run(tab, pageAction, [{ ...params, action: params.action === 'press' ? 'focus' : params.action, origin: snapshot.origin, sensitive: SECRET }]);
      if (params.action !== 'wait' || result?.completed || Date.now() >= expiresAt) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (true);
    if (result?.error === 'code') throw passwordFailure('BROWSER_USER_CODE_REQUIRED', "The user must enter this one-time code. Call browser_request_account with kind 'code'.");
    if (result?.error === 'select') throw passwordFailure('BROWSER_NOT_SELECTABLE', 'The target is not a native list box. Click custom menus instead.');
    if (result?.error === 'option') throw passwordFailure('BROWSER_OPTION_NOT_FOUND', 'No enabled option has this label or value. Snapshot the list box with scope to see its options.');
    if (!result?.completed) throw passwordFailure(result?.error === 'secret' ? 'BROWSER_SECRET_CHANNEL_REQUIRED' : 'BROWSER_PASSWORD_TARGET_INVALID', result?.error === 'secret' ? 'Use a saved account to fill this field.' : 'The selected browser field is no longer available.');
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
  /**
   * tab 이 없으면 모든 탭의 보호 값까지 함께 가린다.
   * 가릴 값이 없는 부분은 원래 객체를 그대로 돌려준다. 메인 스레드에서 CDP 메시지마다 전체를 복사하지 않기 위해서다.
   * 바뀌는 부분의 결과는 예전처럼 모든 표기를 차례로 바꾼 값과 같다.
   */
  redact(tab, value) {
    const tabValues = tab ? [...tab.protectedPasswords ?? []] : [...this.host.tabs?.values() ?? []].flatMap((entry) => [...entry.protectedPasswords ?? []]);
    const secrets = [...new Set([...this.protectedValues, ...tabValues])].flatMap((secret) => [secret, encodeURIComponent(secret), new URLSearchParams({ value: secret }).toString().slice(6), Buffer.from(secret).toString('base64')]).filter(Boolean);
    // CDP·Electron 이 넘기는 값은 JSON 모양의 평범한 객체라, 가릴 값이 없으면 그대로 보내도 같은 JSON 이 된다.
    if (!secrets.length) return value;
    const scrub = (input) => {
      if (typeof input === 'string') {
        if (!secrets.some((secret) => input.includes(secret))) return input;
        for (const secret of secrets) input = input.replaceAll(secret, '[masked]');
        return input;
      }
      if (Array.isArray(input)) {
        for (let index = 0; index < input.length; index += 1) {
          if (!(index in input)) continue;
          const item = scrub(input[index]);
          if (item !== input[index]) return input.map((entry, position) => position < index ? entry : position === index ? item : scrub(entry));
        }
        return input;
      }
      if (input && typeof input === 'object') {
        const prototype = Object.getPrototypeOf(input);
        // Date·Buffer 같은 특수 객체는 예전과 같은 평범한 객체 사본을 만든다.
        if (prototype !== Object.prototype && prototype !== null) return Object.fromEntries(Object.entries(input).map(([key, item]) => [scrub(key), scrub(item)]));
        const keys = Object.keys(input);
        for (let index = 0; index < keys.length; index += 1) {
          const key = scrub(keys[index]); const item = scrub(input[keys[index]]);
          if (key !== keys[index] || item !== input[keys[index]]) {
            return Object.fromEntries(keys.map((name, position) => position < index ? [name, input[name]] : position === index ? [key, item] : [scrub(name), scrub(input[name])]));
          }
        }
        return input;
      }
      return input;
    };
    return scrub(value);
  }
  forgetTab(tab) {
    tab.passwordControlEpoch = (tab.passwordControlEpoch ?? 0) + 1;
    tab.passwordSnapshot = null; tab.protectedPasswords?.clear();
    tab.passwordShield = false;
  }
  async storageState() {
    if (![...this.host.tabs.values()].some((tab) => tab.passwordShield)) return null;
    let value = { cookies: await this.host.getCookies(), origins: [], originsComplete: false };
    for (const tab of this.host.tabs.values()) value = this.redact(tab, value);
    return value;
  }
  /** 사용자가 승인한 저장 카드나 설정이 보낸 로그인을 OS 보관함에 저장한다. 응답에는 비밀번호가 없다. */
  async save(payload) {
    try {
      return await this.vault.importCredential({ origin: payload?.origin, username: payload?.username, password: payload?.password, sourceProfile: 'Hama Browser' });
    } finally { if (payload) payload.password = ''; }
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
    if (token) tab.passwordShield = true;
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
    this.protectFamily(tab, payload.password);
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
    // 같은 사이트의 로그인을 모두 보여 주고, 이 출처에 저장한 것을 먼저 둔다.
    const matching = accounts.filter((account) => sameSite(account.origin, origin)).sort((left, right) => Number(right.origin === origin) - Number(left.origin === origin));
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
    block: (_window, payload) => passwords.vault.setAgentBlocked(payload?.id, payload?.blocked),
    save: (_window, payload) => passwords.save(payload),
    cookieSites: (_window, payload) => passwords.cookies.listSites(payload), importCookies: (_window, payload) => passwords.cookies.importSites(payload),
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

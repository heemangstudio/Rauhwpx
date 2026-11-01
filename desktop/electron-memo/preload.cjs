/**
 * Electron memo layer — renderer side (sandbox-safe preload, isolated world).
 * Source of truth: ~/.agents/skills/electron-memo-loop/assets/memo-layer (projects keep a copy).
 *
 *   Ctrl+G          pick an element (↑/↓ walks to the parent/child, Esc cancels), then write a memo.
 *                   Enter saves to the queue, ⌘/Ctrl+Enter saves it as "fix now".
 *   Ctrl+Shift+G    memo list: open and fixed memos, show the element, fix now, delete.
 *
 * Pins are layered: a pin shows only while its own element is on screen — connected,
 * visible, inside the viewport and actually on top at the pin's point. A pin left on a
 * notification bar disappears when the bar closes and returns when it opens again.
 *
 * Everything renders inside a shadow root. Input events that start inside the layer stop at
 * the window capture phase, so the app never receives keys typed into the memo box. Only the
 * `electron` module is required, so the file works with sandboxed preloads.
 */
const { ipcRenderer } = require('electron');

const ACCENT = '#ff4f8b';
const PIN_TRACK_MS = 250;
const ANCHOR_RECHECK_MS = 2000;
const DRAFT_DEBOUNCE_MS = 300;
const DRAFT_RESTORE_TRIES = 10;
/** A focus move this soon after the user pressed the pointer in the app is the user's own. */
const USER_FOCUS_WINDOW_MS = 400;
const UI_EVENTS = [
  'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
  'compositionstart', 'compositionupdate', 'compositionend', 'paste', 'copy', 'cut',
  'pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup', 'mousemove',
  'click', 'dblclick', 'contextmenu', 'wheel', 'focusin', 'focusout',
];
/** Open/selected-style classes change with state, so selectors and fingerprints skip them. */
const STATE_CLASS = /(^|-)(active|open|opened|hover|focus|focused|selected|expanded|collapsed|resting|stale|pending|visible|hidden|disabled|loading|dragging|current|checked|pressed|new|enter|leave)$/;

const STRINGS = {
  en: {
    banner: 'Click what should change · ↑ ↓ parent / child · Esc cancel',
    placeholder: 'What should change here?',
    hint: 'Enter save · ⌘/Ctrl+Enter fix now',
    cancel: 'Cancel', save: 'Save', fixNow: 'Fix now',
    saved: (n) => `Memo #${n} saved · Ctrl+Shift+G for the list`,
    savedNow: (n) => `Memo #${n} sent to fix now`,
    deleted: 'Memo deleted',
    failed: (message) => `Failed: ${message}`,
    fixed: (n, note) => `#${n} fixed${note ? ` · ${note}` : ''}`,
    working: (n) => `#${n} in progress`,
    draftRestored: 'Restored the memo you were writing',
    targetLost: 'The element is no longer on screen',
    panelTitle: 'Memos', tabOpen: 'Open', tabFixed: 'Fixed',
    emptyOpen: 'No open memos', emptyFixed: 'No fixed memos yet',
    show: 'Show', notHere: 'Not on this screen', remove: 'Delete', close: 'Close',
    statusWorking: 'In progress', now: 'Fix now',
    pinsShown: 'Pins on', pinsHidden: 'Pins off',
    justNow: 'just now', minutesAgo: (m) => `${m}m ago`, hoursAgo: (h) => `${h}h ago`, daysAgo: (d) => `${d}d ago`,
  },
  ko: {
    banner: '바꿀 곳을 누르세요 · ↑ ↓ 상위 / 하위 요소 · Esc 취소',
    placeholder: '여기를 어떻게 바꿀까요?',
    hint: 'Enter 저장 · ⌘/Ctrl+Enter 바로 고치기',
    cancel: '취소', save: '저장', fixNow: '바로 고치기',
    saved: (n) => `메모 #${n} 저장됨 · Ctrl+Shift+G 목록`,
    savedNow: (n) => `메모 #${n} 바로 고치기로 보냄`,
    deleted: '메모 삭제됨',
    failed: (message) => `실패: ${message}`,
    fixed: (n, note) => `#${n} 고침${note ? ` · ${note}` : ''}`,
    working: (n) => `#${n} 작업 중`,
    draftRestored: '쓰던 메모를 되살렸어요',
    targetLost: '원래 요소가 지금 화면에 없어요',
    panelTitle: '메모', tabOpen: '열림', tabFixed: '고침',
    emptyOpen: '열린 메모 없음', emptyFixed: '고친 메모 없음',
    show: '보기', notHere: '이 화면에 없음', remove: '삭제', close: '닫기',
    statusWorking: '작업 중', now: '바로',
    pinsShown: '핀 보임', pinsHidden: '핀 숨김',
    justNow: '방금', minutesAgo: (m) => `${m}분 전`, hoursAgo: (h) => `${h}시간 전`, daysAgo: (d) => `${d}일 전`,
  },
};

let ui = null;

const isToggleKey = (event) => event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'KeyG';

function onWindowEvent(event) {
  if (!ui) return;
  if (event.type === 'keydown') {
    if (isToggleKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.shiftKey) ui.togglePanel();
      else ui.togglePicking();
      return;
    }
    if (ui.consumeKey(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  }
  if (!ui.owns(event)) {
    if (event.type === 'pointerdown') ui.noteOutsidePointer();
    else if (event.type === 'focusin') ui.keepFocus();
    return;
  }
  event.stopImmediatePropagation();
  ui.handle(event);
}

// Registered before any app script runs, so the layer sees shortcuts and its own input first.
for (const type of UI_EVENTS) window.addEventListener(type, onWindowEvent, true);

if (window.top === window) {
  // The main process answers trusted app windows only; anywhere else the layer stays off.
  ipcRenderer.invoke('memo:config').then((config) => {
    const start = () => {
      ui = createUi(config);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }, () => {});
}

// ── Element description and re-anchoring ──────────────────────────────────

function clip(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const textOf = (node) => clip(node.innerText ?? node.textContent, 400);
const stableClasses = (node) => [...node.classList].filter((name) => !STATE_CLASS.test(name));

function shortName(node) {
  if (!(node instanceof Element)) return null;
  const classes = stableClasses(node).slice(0, 3).map((name) => `.${name}`).join('');
  return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes}`;
}

function selectorFor(target) {
  const parts = [];
  for (let node = target; node instanceof Element && node !== document.documentElement; node = node.parentElement) {
    if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    let part = node.tagName.toLowerCase();
    const classes = stableClasses(node).slice(0, 3);
    if (classes.length) part += classes.map((name) => `.${CSS.escape(name)}`).join('');
    const parent = node.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    if (document.querySelectorAll(parts.join(' > ')).length === 1) break;
  }
  return parts.join(' > ');
}

function fingerprint(node) {
  return {
    tag: node.tagName.toLowerCase(),
    id: node.id || null,
    testId: node.getAttribute('data-testid') || null,
    role: node.getAttribute('role'),
    ariaLabel: node.getAttribute('aria-label'),
    text: clip(textOf(node), 160),
    classes: stableClasses(node).slice(0, 4),
  };
}

function bigrams(value) {
  const text = value.toLowerCase();
  const grams = new Map();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Dice coefficient over character bigrams: 1 means the same text. */
function similarity(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / (a.length - 1 + b.length - 1);
}

/** Does this element still look like the one the memo was written on? */
function sameElement(node, print) {
  if (!print || node.tagName.toLowerCase() !== print.tag) return false;
  if (print.testId) return node.getAttribute('data-testid') === print.testId;
  if (print.id && node.id === print.id) return true;
  if (print.text) return similarity(clip(textOf(node), 160), print.text) >= 0.6;
  if (print.ariaLabel) return node.getAttribute('aria-label') === print.ariaLabel;
  return print.classes.every((name) => node.classList.contains(name));
}

function legacyPrint(target) {
  return {
    tag: target.tag, id: target.id ?? null, testId: null, role: target.role ?? null,
    ariaLabel: target.ariaLabel ?? null, text: clip(target.text, 160),
    classes: (target.classes ?? []).filter((name) => !STATE_CLASS.test(name)).slice(0, 4),
  };
}

function query(selector, all = false) {
  if (!selector) return all ? [] : null;
  try {
    return all ? [...document.querySelectorAll(selector)] : document.querySelector(selector);
  } catch {
    return all ? [] : null;
  }
}

function findAnchor(target) {
  if (!target) return null;
  const print = target.fingerprint ?? legacyPrint(target);
  const direct = query(target.selector);
  if (direct && sameElement(direct, print)) return direct;
  // The selector drifted or now points at another element: search by fingerprint instead.
  const base = print.id ? `#${CSS.escape(print.id)}` : `${print.tag}${print.classes.map((name) => `.${CSS.escape(name)}`).join('')}`;
  const candidates = query(base, true).slice(0, 400).filter((node) => sameElement(node, print));
  if (candidates.length <= 1) return candidates[0] ?? null;
  const ancestry = (node) => {
    const names = [];
    for (let parent = node.parentElement; parent && names.length < 8; parent = parent.parentElement) names.push(shortName(parent));
    return names;
  };
  const score = (node) => ancestry(node).filter((name, index) => name === target.ancestors?.[index]).length;
  candidates.sort((a, b) => score(b) - score(a));
  return score(candidates[0]) > score(candidates[1]) ? candidates[0] : null;
}

function pointOn(rect, ratio) {
  return {
    x: rect.left + (ratio?.x ?? 0.5) * rect.width,
    y: rect.top + (ratio?.y ?? 0.5) * rect.height,
  };
}

function describeTarget(node, point) {
  const rect = node.getBoundingClientRect();
  const ancestors = [];
  for (let parent = node.parentElement; parent && ancestors.length < 8; parent = parent.parentElement) ancestors.push(shortName(parent));
  const ratio = (offset, size) => (size ? Math.round((offset / size) * 1000) / 1000 : 0.5);
  return {
    selector: selectorFor(node),
    element: shortName(node),
    fingerprint: fingerprint(node),
    tag: node.tagName.toLowerCase(),
    id: node.id || null,
    classes: [...node.classList],
    text: clip(textOf(node), 300),
    ariaLabel: node.getAttribute('aria-label'),
    role: node.getAttribute('role'),
    title: node.getAttribute('title'),
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) },
    point: { x: Math.round(point.x), y: Math.round(point.y) },
    pointRatio: { x: ratio(point.x - rect.left, rect.width), y: ratio(point.y - rect.top, rect.height) },
    ancestors,
    html: clip(node.outerHTML, 800),
  };
}

function describeView() {
  const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')]
    .filter((node) => node.checkVisibility?.() ?? true)
    .map((node) => node.getAttribute('aria-label') || shortName(node));
  return {
    url: location.href,
    title: document.title,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    theme: document.documentElement.dataset.themeEffective ?? document.documentElement.dataset.theme ?? null,
    htmlClasses: document.documentElement.className || null,
    bodyClasses: document.body?.className || null,
    activeElement: shortName(document.activeElement),
    dialogs,
    selection: clip(window.getSelection()?.toString(), 200) || null,
  };
}

const frames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function button(label, action, className = '') {
  const node = h('button', className, label);
  node.type = 'button';
  node.dataset.action = action;
  return node;
}

// ── Layer ─────────────────────────────────────────────────────────────────

function createUi(config) {
  const t = STRINGS[config.locale] ?? STRINGS.en;
  const host = document.createElement('div');
  host.setAttribute('data-electron-memo-layer', '');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = h('style', '', STYLES);

  const pins = h('div', 'pins');
  const pick = h('div', 'pick');
  const banner = h('div', 'banner', t.banner);
  const highlight = h('div', 'hl');
  const highlightLabel = h('span', 'hl-label');
  highlight.append(highlightLabel);
  const marker = h('div', 'marker');

  const editor = h('div', 'editor');
  const lost = h('div', 'lost', t.targetLost);
  const textarea = h('textarea');
  textarea.placeholder = t.placeholder;
  textarea.rows = 3;
  const error = h('div', 'error');
  const editorRow = h('div', 'row');
  const editorButtons = h('div', 'buttons');
  editorButtons.append(button(t.cancel, 'cancel'), button(t.save, 'save'), button(t.fixNow, 'save-now', 'primary'));
  editorRow.append(h('span', 'hint', t.hint), editorButtons);
  editor.append(lost, textarea, error, editorRow);

  const panel = h('aside', 'panel');
  const panelTitle = h('strong', 'panel-title', t.panelTitle);
  const pinsToggle = button('', 'toggle-pins', 'ghost');
  const panelHead = h('div', 'panel-head');
  const panelActions = h('div', 'buttons');
  panelActions.append(pinsToggle, button(t.close, 'close-panel', 'ghost'));
  panelHead.append(panelTitle, panelActions);
  const tabs = h('div', 'tabs');
  const openTab = button('', 'tab-open', 'tab');
  const fixedTab = button('', 'tab-fixed', 'tab');
  tabs.append(openTab, fixedTab);
  const list = h('div', 'list');
  panel.append(panelHead, tabs, list);

  const toast = h('div', 'toast');
  for (const node of [pick, banner, highlight, marker, editor, panel, toast, lost]) node.hidden = true;
  shadow.append(style, pins, pick, banner, highlight, marker, editor, panel, toast);
  document.documentElement.append(host);

  let memos = config.memos ?? [];
  let pinsVisible = true;
  let picking = false;
  let hoverBase = null;
  let chosen = null;
  const depth = [];
  let editing = null; // { node, point, lostTarget }
  let saving = false;
  let panelTab = 'open';
  let toastTimer = 0;
  let draftTimer = 0;
  let outsidePointerAt = 0;
  let focusReclaims = [];
  const anchors = new Map();

  const openMemos = () => memos.filter((memo) => memo.status !== 'resolved');
  const fixedMemos = () => memos.filter((memo) => memo.status === 'resolved')
    .sort((a, b) => String(b.resolution?.resolvedAt ?? b.updatedAt).localeCompare(String(a.resolution?.resolvedAt ?? a.updatedAt)));

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2800);
  }

  function ago(iso) {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (!Number.isFinite(minutes) || minutes < 1) return t.justNow;
    if (minutes < 60) return t.minutesAgo(minutes);
    if (minutes < 1440) return t.hoursAgo(Math.round(minutes / 60));
    return t.daysAgo(Math.round(minutes / 1440));
  }

  // ── Layered visibility ──
  function topAt(x, y) {
    return document.elementsFromPoint(x, y).find((node) => node !== host) ?? null;
  }

  /** On screen means visible, inside the viewport and not covered by another layer. */
  function onScreen(node, probe) {
    const rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) return false;
    if (!(node.checkVisibility?.({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true }) ?? true)) return false;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= window.innerHeight || rect.left >= window.innerWidth) return false;
    const clampX = (x) => Math.min(window.innerWidth - 1, Math.max(0, x));
    const clampY = (y) => Math.min(window.innerHeight - 1, Math.max(0, y));
    const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    return [probe, center].filter(Boolean).some((point) => {
      const top = topAt(clampX(point.x), clampY(point.y));
      return Boolean(top && (top === node || node.contains(top) || top.contains(node)));
    });
  }

  function anchorFor(memo) {
    const cached = anchors.get(memo.id);
    const now = Date.now();
    if (cached?.node.isConnected && now - cached.checkedAt < ANCHOR_RECHECK_MS) return cached.node;
    const print = memo.target?.fingerprint ?? legacyPrint(memo.target ?? {});
    const node = cached?.node.isConnected && sameElement(cached.node, print) ? cached.node : findAnchor(memo.target);
    if (node) anchors.set(memo.id, { node, checkedAt: now });
    else anchors.delete(memo.id);
    return node;
  }

  function placeHighlight(node) {
    if (!node) {
      highlight.hidden = true;
      return;
    }
    const rect = node.getBoundingClientRect();
    Object.assign(highlight.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    highlightLabel.textContent = shortName(node);
    highlightLabel.classList.toggle('below', rect.top < 24);
    highlight.hidden = false;
  }

  function flash(node) {
    placeHighlight(node);
    highlight.classList.add('flash');
    window.setTimeout(() => {
      highlight.classList.remove('flash');
      if (!editing) highlight.hidden = true;
    }, 1400);
  }

  // ── Picking ──
  function elementAt(x, y) {
    return document.elementsFromPoint(x, y).find((node) => node !== host && node !== document.documentElement) ?? null;
  }

  function setPicking(next) {
    picking = next;
    pick.hidden = !next;
    banner.hidden = !next;
    hoverBase = null;
    chosen = null;
    depth.length = 0;
    if (!next && !editing) highlight.hidden = true;
  }

  function hover(x, y) {
    const base = elementAt(x, y);
    if (base === hoverBase) return;
    hoverBase = base;
    chosen = base;
    depth.length = 0;
    placeHighlight(chosen);
  }

  // ── Editor and drafts ──
  function positionEditor(at) {
    const width = 320;
    const height = editor.offsetHeight || 150;
    editor.style.left = `${Math.min(Math.max(8, at.x + 14), window.innerWidth - width - 8)}px`;
    editor.style.top = `${Math.min(Math.max(8, at.y + 14), window.innerHeight - height - 8)}px`;
  }

  function openEditor(node, at, { text = '', lostTarget = null } = {}) {
    setPicking(false);
    editing = { node, point: at, lostTarget };
    placeHighlight(node);
    Object.assign(marker.style, { left: `${at.x}px`, top: `${at.y}px` });
    marker.hidden = false;
    lost.hidden = Boolean(node);
    error.textContent = '';
    textarea.value = text;
    editor.hidden = false;
    positionEditor(at);
    textarea.focus();
    textarea.setSelectionRange(text.length, text.length);
  }

  function closeEditor({ discardDraft }) {
    editor.hidden = true;
    marker.hidden = true;
    highlight.hidden = true;
    editing = null;
    clearTimeout(draftTimer);
    if (discardDraft) void ipcRenderer.invoke('memo:draft', null).catch(() => {});
  }

  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = window.setTimeout(() => {
      if (!editing) return;
      const target = editing.node ? describeTarget(editing.node, editing.point) : editing.lostTarget;
      void ipcRenderer.invoke('memo:draft', { text: textarea.value, target, point: editing.point, url: location.href }).catch(() => {});
    }, DRAFT_DEBOUNCE_MS);
  }

  async function save(priority) {
    const comment = textarea.value.trim();
    if (!comment || saving || !editing) return;
    saving = true;
    clearTimeout(draftTimer);
    const target = editing.node?.isConnected ? describeTarget(editing.node, editing.point) : editing.lostTarget;
    const payload = { comment, priority, target, view: describeView() };
    // The screenshot shows the app, the chosen element's outline and the click point only.
    const panelWasOpen = !panel.hidden;
    editor.hidden = true;
    pins.hidden = true;
    panel.hidden = true;
    await frames();
    try {
      const memo = await ipcRenderer.invoke('memo:add', payload);
      closeEditor({ discardDraft: false });
      showToast(priority === 'now' ? t.savedNow(memo.number) : t.saved(memo.number));
    } catch (cause) {
      editor.hidden = false;
      error.textContent = t.failed(cause?.message ?? cause);
      textarea.focus();
    } finally {
      saving = false;
      pins.hidden = !pinsVisible;
      panel.hidden = !panelWasOpen;
    }
  }

  /** Apps often render after DOMContentLoaded, so the element gets a few tries to appear. */
  function restoreDraft(draft, attempt = 0) {
    if (!draft?.text || editing) return;
    const node = findAnchor(draft.target);
    if (!node && attempt < DRAFT_RESTORE_TRIES) {
      window.setTimeout(() => restoreDraft(draft, attempt + 1), 300);
      return;
    }
    const at = node ? pointOn(node.getBoundingClientRect(), draft.target?.pointRatio) : (draft.point ?? { x: 120, y: 120 });
    openEditor(node, at, { text: draft.text, lostTarget: node ? null : draft.target });
    showToast(t.draftRestored);
  }

  // ── Pins ──
  function renderPins() {
    const visible = openMemos();
    pins.replaceChildren(...visible.map((memo) => {
      const pin = h('div', 'pin', String(memo.number));
      pin.dataset.id = memo.id;
      pin.dataset.action = 'pin';
      pin.hidden = true;
      const tip = h('div', 'tip');
      const meta = h('div', 'tip-row');
      meta.append(h('span', 'tip-meta', memo.target?.element ?? ''), button(t.remove, 'remove'));
      meta.lastChild.dataset.id = memo.id;
      tip.append(h('div', 'tip-text', memo.comment), meta);
      pin.append(tip);
      return pin;
    }));
    trackPins();
  }

  function trackPins() {
    if (!pinsVisible) return;
    for (const pin of pins.children) {
      const memo = memos.find((candidate) => candidate.id === pin.dataset.id);
      const anchor = memo && anchorFor(memo);
      const rect = anchor?.getBoundingClientRect();
      const at = rect && pointOn(rect, memo.target?.pointRatio);
      const shown = Boolean(anchor && onScreen(anchor, at));
      pin.hidden = !shown;
      if (!shown) {
        pin.classList.remove('open');
        continue;
      }
      pin.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y - 22)}px)`;
      pin.classList.toggle('flip', at.x > window.innerWidth - 320);
    }
  }

  // ── Panel ──
  function renderPanel() {
    const open = openMemos();
    const fixed = fixedMemos();
    openTab.textContent = `${t.tabOpen} ${open.length}`;
    fixedTab.textContent = `${t.tabFixed} ${fixed.length}`;
    openTab.classList.toggle('on', panelTab === 'open');
    fixedTab.classList.toggle('on', panelTab === 'fixed');
    pinsToggle.textContent = pinsVisible ? t.pinsShown : t.pinsHidden;
    const items = panelTab === 'open' ? open : fixed;
    if (!items.length) {
      list.replaceChildren(h('div', 'empty', panelTab === 'open' ? t.emptyOpen : t.emptyFixed));
      return;
    }
    list.replaceChildren(...items.map((memo) => {
      const item = h('article', 'item');
      item.dataset.id = memo.id;
      const head = h('div', 'item-head');
      head.append(h('span', 'num', `#${memo.number}`));
      if (memo.status === 'in-progress') head.append(h('span', 'chip working', t.statusWorking));
      if (memo.status !== 'resolved' && memo.priority === 'now') head.append(h('span', 'chip now', t.now));
      head.append(h('span', 'time', ago(memo.status === 'resolved' ? (memo.resolution?.resolvedAt ?? memo.updatedAt) : memo.createdAt)));
      item.append(head, h('div', 'item-text', memo.comment));
      if (memo.status === 'resolved' && memo.resolution?.note) item.append(h('div', 'item-note', memo.resolution.note));
      const foot = h('div', 'item-foot');
      foot.append(h('span', 'tip-meta', memo.target?.element ?? ''));
      const actions = h('div', 'buttons');
      if (memo.status !== 'resolved') {
        const show = button(t.show, 'show', 'ghost');
        show.dataset.id = memo.id;
        actions.append(show);
        if (memo.priority !== 'now') {
          const now = button(t.fixNow, 'now', 'ghost');
          now.dataset.id = memo.id;
          actions.append(now);
        }
      }
      const remove = button(t.remove, 'remove', 'ghost');
      remove.dataset.id = memo.id;
      actions.append(remove);
      foot.append(actions);
      item.append(foot);
      return item;
    }));
    refreshShowButtons();
  }

  function refreshShowButtons() {
    for (const show of list.querySelectorAll('button[data-action="show"]')) {
      const memo = memos.find((candidate) => candidate.id === show.dataset.id);
      const anchor = memo && anchorFor(memo);
      show.disabled = !anchor;
      show.title = anchor ? '' : t.notHere;
      show.textContent = anchor ? t.show : t.notHere;
    }
  }

  function setMemos(next, events = []) {
    memos = next;
    for (const id of anchors.keys()) if (!memos.some((memo) => memo.id === id)) anchors.delete(id);
    renderPins();
    if (!panel.hidden) renderPanel();
    const latest = events.at(-1);
    if (latest?.status === 'resolved') showToast(t.fixed(latest.number, latest.note));
    else if (latest?.status === 'in-progress') showToast(t.working(latest.number));
  }

  async function act(action, id) {
    try {
      if (action === 'remove') {
        await ipcRenderer.invoke('memo:remove', id);
        showToast(t.deleted);
      } else if (action === 'now') {
        await ipcRenderer.invoke('memo:set-priority', id, 'now');
      } else if (action === 'show') {
        const memo = memos.find((candidate) => candidate.id === id);
        const anchor = memo && anchorFor(memo);
        if (!anchor) return;
        anchor.scrollIntoView({ block: 'center', inline: 'nearest' });
        await frames();
        flash(anchor);
      }
    } catch (cause) {
      showToast(t.failed(cause?.message ?? cause));
    }
  }

  ipcRenderer.on('memo:changed', (_event, update) => setMemos(update.memos ?? [], update.events ?? []));
  window.setInterval(trackPins, PIN_TRACK_MS);
  window.setInterval(() => { if (!panel.hidden) refreshShowButtons(); }, 1000);
  window.addEventListener('resize', () => requestAnimationFrame(trackPins));
  window.addEventListener('scroll', () => requestAnimationFrame(trackPins), true);

  renderPins();
  restoreDraft(config.draft);

  return {
    owns: (event) => event.composedPath().includes(host),
    noteOutsidePointer() {
      outsidePointerAt = Date.now();
    },
    /** Apps move focus on their own (a dialog opening, an editor refocusing). While a memo is
        being written, take it back unless the user clicked into the app. */
    keepFocus() {
      const now = Date.now();
      if (!editing || saving || now - outsidePointerAt < USER_FOCUS_WINDOW_MS) return;
      // An app that forces focus back on every move would ping-pong forever; yield after three tries a second.
      focusReclaims = focusReclaims.filter((at) => now - at < 1000);
      if (focusReclaims.length >= 3) return;
      focusReclaims.push(now);
      window.setTimeout(() => {
        if (editing && !saving && !host.shadowRoot.activeElement) textarea.focus({ preventScroll: true });
      }, 0);
    },
    togglePicking() {
      if (editing || saving) return;
      setPicking(!picking);
    },
    togglePanel() {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) renderPanel();
    },
    consumeKey(event) {
      if (picking && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (event.key === 'ArrowUp' && chosen?.parentElement && chosen.parentElement !== document.documentElement) {
          depth.push(chosen);
          chosen = chosen.parentElement;
        } else if (event.key === 'ArrowDown' && depth.length) {
          chosen = depth.pop();
        }
        placeHighlight(chosen);
        return true;
      }
      if (event.key !== 'Escape') return false;
      if (saving) return true;
      if (editing) {
        closeEditor({ discardDraft: true });
        return true;
      }
      if (picking) {
        setPicking(false);
        return true;
      }
      const openPin = pins.querySelector('.pin.open');
      if (openPin) {
        openPin.classList.remove('open');
        return true;
      }
      if (!panel.hidden) {
        panel.hidden = true;
        return true;
      }
      return false;
    },
    handle(event) {
      const path = event.composedPath();
      if (path.includes(pick)) {
        if (event.type === 'pointermove') hover(event.clientX, event.clientY);
        if (event.type === 'pointerdown' || event.type === 'mousedown' || event.type === 'contextmenu' || event.type === 'wheel') event.preventDefault();
        if (event.type === 'click') {
          if (!chosen) hover(event.clientX, event.clientY);
          if (!chosen) return;
          const rect = chosen.getBoundingClientRect();
          const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
          openEditor(chosen, inside ? { x: event.clientX, y: event.clientY } : pointOn(rect, null));
        }
        return;
      }
      if (path.includes(textarea)) {
        if (event.type === 'input') scheduleDraft();
        if (event.type === 'keydown' && event.key === 'Enter' && !event.isComposing && event.keyCode !== 229) {
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            void save('now');
          } else if (!event.shiftKey) {
            event.preventDefault();
            void save('queued');
          }
        }
        return;
      }
      if (event.type !== 'click') return;
      const target = path.find((node) => node instanceof HTMLElement && node.dataset.action);
      if (!target) return;
      const { action, id } = target.dataset;
      if (action === 'save') void save('queued');
      else if (action === 'save-now') void save('now');
      else if (action === 'cancel') closeEditor({ discardDraft: true });
      else if (action === 'close-panel') panel.hidden = true;
      else if (action === 'tab-open' || action === 'tab-fixed') {
        panelTab = action === 'tab-open' ? 'open' : 'fixed';
        renderPanel();
      } else if (action === 'toggle-pins') {
        pinsVisible = !pinsVisible;
        pins.hidden = !pinsVisible;
        trackPins();
        renderPanel();
      } else if (action === 'pin') {
        for (const other of pins.querySelectorAll('.pin.open')) if (other !== target) other.classList.remove('open');
        target.classList.toggle('open');
      } else if (id) void act(action, id);
    },
  };
}

const STYLES = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Segoe UI', system-ui, sans-serif; }
[hidden] { display: none !important; }
.pins { position: fixed; inset: 0; pointer-events: none; }
.pick { position: fixed; inset: 0; cursor: crosshair; pointer-events: auto; }
.banner, .toast {
  position: fixed; left: 50%; transform: translateX(-50%); padding: 7px 13px; border-radius: 999px;
  font-size: 12px; color: #f4f4f5; background: #1c1c20; border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35); pointer-events: none; white-space: nowrap;
}
.banner { top: 10px; }
.toast { bottom: 18px; max-width: min(560px, calc(100vw - 32px)); overflow: hidden; text-overflow: ellipsis; }
.hl {
  position: fixed; border: 1.5px solid ${ACCENT}; border-radius: 4px;
  background: rgba(255, 79, 139, 0.08); pointer-events: none;
}
.hl.flash { animation: flash 1.4s ease-out; }
@keyframes flash { 0%, 40% { background: rgba(255, 79, 139, 0.28); } 100% { background: rgba(255, 79, 139, 0); } }
.hl-label {
  position: absolute; left: -1.5px; bottom: 100%; margin-bottom: 4px; max-width: 420px;
  padding: 2px 6px; border-radius: 4px; color: #fff; background: ${ACCENT};
  font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hl-label.below { bottom: auto; top: 100%; margin: 4px 0 0; }
.marker {
  position: fixed; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%;
  background: ${ACCENT}; box-shadow: 0 0 0 3px rgba(255, 79, 139, 0.3); pointer-events: none;
}
.editor, .panel {
  position: fixed; color: #f4f4f5; background: #1c1c20; border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45); pointer-events: auto;
}
.editor { width: 320px; display: grid; gap: 8px; padding: 10px; border-radius: 12px; }
.lost { font-size: 11px; color: #f5b041; }
textarea {
  width: 100%; min-height: 72px; resize: vertical; padding: 8px 10px; border-radius: 8px;
  color: inherit; background: #121214; border: 1px solid rgba(255, 255, 255, 0.12);
  font-size: 13px; line-height: 1.5; outline: none;
}
textarea:focus { border-color: ${ACCENT}; }
.row, .tip-row, .item-foot, .panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hint, .tip-meta, .time, .empty { font-size: 11px; color: #8b8b92; }
.tip-meta { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.buttons { display: flex; gap: 4px; flex-shrink: 0; }
.error { font-size: 11px; color: #ff8a8a; }
.error:empty { display: none; }
button {
  all: unset; cursor: pointer; padding: 5px 9px; border-radius: 7px;
  font-size: 12px; color: #d4d4d8; background: rgba(255, 255, 255, 0.06); white-space: nowrap;
}
button:hover { background: rgba(255, 255, 255, 0.12); }
button:disabled { cursor: default; opacity: 0.45; background: transparent; }
button.primary { color: #fff; background: ${ACCENT}; }
button.ghost { background: transparent; }
button.ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.08); }
.pin {
  position: fixed; left: 0; top: 0; width: 22px; height: 22px; display: grid; place-items: center;
  border-radius: 50% 50% 50% 4px; color: #fff; background: ${ACCENT};
  font-size: 11px; font-weight: 700; cursor: pointer; pointer-events: auto;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.tip {
  display: none; position: absolute; left: 28px; top: 0; width: 280px; gap: 8px; padding: 9px 10px;
  border-radius: 10px; color: #f4f4f5; background: #1c1c20; border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45); font-size: 12px; font-weight: 400; line-height: 1.5;
  text-align: left; cursor: default;
}
.pin.flip .tip { left: auto; right: 28px; }
.pin:hover .tip, .pin.open .tip { display: grid; }
.tip-text, .item-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.panel {
  top: 12px; right: 12px; bottom: 12px; width: 340px; display: flex; flex-direction: column;
  border-radius: 14px; overflow: hidden;
}
.panel-head { padding: 12px 12px 8px 14px; }
.panel-title { font-size: 13px; font-weight: 600; }
.tabs { display: flex; gap: 4px; padding: 0 10px 8px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); }
button.tab { background: transparent; color: #8b8b92; }
button.tab.on { color: #f4f4f5; background: rgba(255, 255, 255, 0.08); }
.list { flex: 1; overflow-y: auto; padding: 8px; display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 6px; }
.empty { padding: 18px 6px; text-align: center; }
.item { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; min-width: 0; padding: 10px; border-radius: 10px; background: rgba(255, 255, 255, 0.03); }
.item-foot .tip-meta { flex: 1 1 auto; }
.item-head { display: flex; align-items: center; gap: 6px; }
.item-head .time { margin-left: auto; }
.num { font-size: 12px; font-weight: 700; color: ${ACCENT}; }
.chip { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 999px; }
.chip.now { color: #fff; background: ${ACCENT}; }
.chip.working { color: #1c1c20; background: #f5b041; }
.item-text { font-size: 12.5px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
.item-note { font-size: 11.5px; line-height: 1.45; color: #a7f3c0; white-space: pre-wrap; }
`;

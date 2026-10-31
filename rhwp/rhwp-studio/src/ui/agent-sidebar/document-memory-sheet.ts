/**
 * 문서 기억 시트 — 지금 문서의 기억을 종류별로 보여 주고 그 자리에서 고치고 지우고 더한다.
 *
 * 정본은 허브에 있다. 시트는 그린 기억의 revision 을 expectedRevision 으로 실어 쓰고,
 * 다른 곳(에이전트 도구·자동 학습·되돌리기)에서 바뀌면 document-memory-changed 를 받아 다시 읽는다.
 * 고치는 중이면 그 줄을 덮지 않고, 고치기가 끝난 뒤 새 목록을 그린다. 쓰는 사이 다른 곳에서 바뀌었으면
 * 그 항목이 고치기를 시작할 때와 같을 때만 다시 쓴다 — 아니면 초안을 남기고 알린다.
 * 머리의 '기록에서 배우기'는 대화에서 배우기 설정과 상관없이 Rau-0.1 을 한 번 돌린다. 결과 구분선은 사이드바가
 * taste-history-learned 로 그 문서의 채팅 끝에 남기고, 배운 항목은 document-memory-changed 로 이 목록에 들어온다.
 * 항목마다 강도(1–5)를 Rau 탭과 같은 물그릇(strength-gauge)으로 보인다. 보강·감쇄로 바뀌면 물이 움직인다.
 *
 * Rau 요금제(체험 포함)이고 허브가 장기기억을 쓸 수 있다고 하면, 아래에 '장기기억' 칸을 읽기 전용으로 둔다.
 * 장기기억은 창 하나가 함께 보는 RauMemoryStore 에서 읽고, 고치기는 설정의 Rau 탭에서 한다.
 * 같은 종류·주제의 문서 기억이 장기기억과 다른 지침을 담으면 두 줄 모두에 덮어쓰기 표를 단다.
 */
import './document-memory-sheet.css';
import type { SidebarBridge } from '../../agent/bridge.ts';
import type { TasteHistoryOutcome } from '../../agent/taste-history.ts';
import type {
  AccountRule,
  DocumentMemory,
  DocumentMemoryEntry,
  DocumentMemoryKind,
  DocumentMemoryOp,
  DocumentMemoryResult,
} from '../../agent/types.ts';
import { RAU_TASTE_NAME } from '../../agent/taste.ts';
import { showContextMenu } from '../native-context-menu.ts';
import { createIcon } from './icons.ts';
import { createSheetFrame } from './sheet.ts';
import type { PlanStore } from '../plan/plan-store.ts';
import { sharedRauMemoryStore, type RauMemoryStore } from './rau-memory-state.ts';
import { createStrengthGauge } from './strength-gauge.ts';

export type DocumentMemorySheetBridge = Pick<
  SidebarBridge,
  'listDocumentMemory' | 'applyDocumentMemory' | 'missingDocumentMemoryAnchors' | 'onEvent' | 'learnFromHistory'
> & Partial<Pick<SidebarBridge, 'requestUserMemory'>>;

export interface DocumentMemorySheetOptions {
  bridge: DocumentMemorySheetBridge;
  documentId: string;
  /** 시트를 띄울 기준 요소. 가장 가까운 .ag-root 안에 뜬다. */
  anchor?: Element | null;
  /** 바깥에서 닫는다. */
  signal?: AbortSignal;
  /** 요금제 상태. tier 가 'rau' 일 때만 '장기기억' 칸을 보인다. 없으면 그 칸이 없다. */
  plan?: Pick<PlanStore, 'status' | 'subscribe'> | null;
  /** 장기기억 상태. 없으면 창의 sharedRauMemoryStore 를 읽는다. */
  rauMemory?: RauMemoryStore | null;
}

export interface DocumentMemorySheetHandle {
  close(): void;
  /** 시트가 닫히면 풀린다. */
  readonly closed: Promise<void>;
}

/** 보이는 순서. */
const KIND_ORDER: readonly DocumentMemoryKind[] = ['style', 'term', 'decision', 'protect', 'fact'];
const KIND_LABEL: Record<DocumentMemoryKind, string> = {
  style: 'STYLE',
  term: 'WORDING',
  decision: 'DECISION',
  protect: 'PROTECT',
  fact: 'FACT',
};
const TEXT_MAX = 300;
/** '장기기억' 칸이 처음 보이는 규칙 수 — 나머지는 펼쳐 본다. 이 문서가 대신하는 규칙은 늘 보인다. */
const ACCOUNT_PREVIEW = 6;

const ERROR_TEXT: Record<string, string> = {
  MEMORY_FULL: '기억이 가득 찼습니다.',
  MEMORY_ENTRY_NOT_FOUND: '이미 지워진 기억입니다.',
  MEMORY_REVISION_CONFLICT: '기억이 바뀌었습니다. 다시 저장해 주세요.',
  MEMORY_CHANGED_ELSEWHERE: '다른 곳에서 이 기억이 바뀌었습니다.',
  MEMORY_INVALID: '기억을 저장하지 못했습니다.',
};
const OFFLINE_TEXT = '에이전트 허브에 연결되어 있지 않습니다.';
const HISTORY_NOTE_MS = 3_200;

/** 기록에서 배우기 결과의 안내. 배운 것이 있으면 구분선이 남으므로 null. 시트와 /learn 이 함께 쓴다. */
export function historyOutcomeNote(outcome: TasteHistoryOutcome): { text: string; error: boolean } | null {
  if (outcome.status === 'review') return { text: '검토 중인 변경이 있습니다.', error: false };
  if (outcome.status === 'empty') return { text: '배울 기록이 없습니다.', error: false };
  if (outcome.status === 'learned' && outcome.result.items.length === 0) return { text: '새로 배운 것이 없습니다.', error: false };
  if (outcome.status === 'failed') {
    return { text: outcome.code === 'OFFLINE' ? OFFLINE_TEXT : '기록에서 배우지 못했습니다.', error: true };
  }
  return null;
}

function errorText(result: DocumentMemoryResult | null): string {
  if (!result) return OFFLINE_TEXT;
  return ERROR_TEXT[result.error?.code ?? ''] ?? '기억을 저장하지 못했습니다.';
}

/** 사용자가 보고 고친 내용이 같은가 — 시각·근거 수처럼 보이지 않는 값은 견주지 않는다. */
function sameNote(a: DocumentMemoryEntry, b: DocumentMemoryEntry): boolean {
  const shape = (entry: DocumentMemoryEntry) => JSON.stringify([entry.kind, entry.subject, entry.text, entry.anchor ?? null]);
  return shape(a) === shape(b);
}

/** 허브의 canonicalSubject 와 같은 주제 비교 키. */
function subjectKey(subject: string): string {
  return subject.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** 학습기는 같은 취향이면 기존 글을 재사용한다. 같은 종류·주제에서 실제 글이 다를 때만 덮어쓴다. */
function overridesRule(entry: DocumentMemoryEntry, rule: AccountRule): boolean {
  const subject = subjectKey(entry.subject);
  const preference = (text: string) => subjectKey(text).replace(/[.。]+$/, '').trim();
  return entry.kind === rule.kind && subject.length > 0 && subject === subjectKey(rule.subject)
    && preference(entry.text) !== preference(rule.text);
}

/** 한 줄 기억 — 줄바꿈은 띄어쓰기로 편다. */
function singleLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ');
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function autoGrow(area: HTMLTextAreaElement): void {
  area.style.height = 'auto';
  area.style.height = `${area.scrollHeight}px`;
}

export function openDocumentMemorySheet(options: DocumentMemorySheetOptions): DocumentMemorySheetHandle {
  const { bridge, documentId } = options;

  let memory: DocumentMemory | null = null;
  let missing = new Set<string>();
  /** 고치는 중인 항목과 그 초안. 목록을 다시 그려도 이 줄은 초안으로 다시 연다. base 는 고치기 시작할 때의 항목. */
  let editing: { id: string; draft: string; base: DocumentMemoryEntry } | null = null;
  /** 고치는 동안 미뤄 둔 새 목록 그리기. */
  let renderDeferred = false;
  /** 허브에 쓰는 중인 항목 — 흐리게 그린다. */
  const pendingIds = new Set<string>();
  let addKind: DocumentMemoryKind = 'style';
  let closed = false;
  const rauMemory = options.rauMemory ?? sharedRauMemoryStore();
  /** '장기기억' 칸을 다 폈는가. */
  let accountExpanded = false;
  /** 지난 그림의 강도 — 바뀐 줄만 물이 움직인다. 처음 그림은 움직이지 않는다. */
  const shownStrength = new Map<string, number>();
  let painted = false;

  const frame = createSheetFrame({
    title: '문서 기억',
    animate: false,
    anchor: options.anchor,
    signal: options.signal,
    role: 'dialog',
    className: 'ag-memory-sheet',
    dragIgnore: 'button, label, input, textarea, .ag-memory-list',
    onEscape: () => {
      // 종류 메뉴(웹의 HTML 메뉴)가 떠 있으면 Esc 는 그 메뉴만 닫는다.
      if (document.querySelector('body > .context-menu')) return true;
      if (!editing) return false;
      cancelEdit();
      return true;
    },
  });
  const { sheet } = frame;

  const header = el('div', 'ag-memory-header');
  frame.header.replaceWith(header);
  const learnButton = el('button', 'ag-memory-learn', '기록에서 배우기');
  learnButton.type = 'button';
  header.append(frame.header, learnButton);

  const list = el('div', 'ag-memory-list');
  const empty = el('p', 'ag-memory-empty', '아직 기억이 없습니다.');
  empty.hidden = true;

  const addRow = el('form', 'ag-memory-add');
  const kindButton = el('button', 'ag-memory-kind-btn');
  kindButton.type = 'button';
  kindButton.setAttribute('aria-haspopup', 'menu');
  const kindLabel = el('span', 'ag-memory-kind-label', KIND_LABEL[addKind]);
  kindButton.append(kindLabel, createIcon('updown'));
  kindButton.setAttribute('aria-label', `종류: ${KIND_LABEL[addKind]}`);
  const addInput = el('input', 'ag-memory-add-input');
  addInput.type = 'text';
  addInput.placeholder = '새 기억';
  addInput.maxLength = TEXT_MAX;
  addInput.autocomplete = 'off';
  addInput.setAttribute('aria-label', '새 기억');
  addRow.append(kindButton, addInput);

  const errorLine = el('p', 'ag-memory-error');
  errorLine.setAttribute('role', 'alert');
  errorLine.hidden = true;
  const noteLine = el('p', 'ag-memory-note');
  noteLine.setAttribute('role', 'status');
  noteLine.hidden = true;

  sheet.append(header, list, empty, addRow, errorLine, noteLine);
  sheet.dataset.loading = 'true';

  function showError(text: string | null): void {
    errorLine.textContent = text ?? '';
    errorLine.hidden = !text;
  }

  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  function showNote(text: string): void {
    if (noteTimer !== null) clearTimeout(noteTimer);
    noteLine.textContent = text;
    noteLine.hidden = false;
    noteTimer = setTimeout(() => {
      noteTimer = null;
      noteLine.hidden = true;
    }, HISTORY_NOTE_MS);
  }

  async function learnFromHistory(): Promise<void> {
    if (learnButton.getAttribute('aria-busy') === 'true') return;
    learnButton.setAttribute('aria-busy', 'true');
    noteLine.hidden = true;
    showError(null);
    const outcome = await bridge.learnFromHistory();
    learnButton.removeAttribute('aria-busy');
    if (closed) return;
    const note = historyOutcomeNote(outcome);
    if (note?.error) showError(note.text);
    else if (note) showNote(note.text);
  }

  /** 새 기억을 받는다 — revision 이 뒤로 가지 않게 한다. */
  function accept(next: DocumentMemory | undefined): boolean {
    if (!next) return false;
    if (memory && memory.key === next.key && next.revision < memory.revision) return false;
    memory = next;
    const anchored = next.entries.filter((entry) => entry.anchor);
    missing = new Set(anchored.length ? bridge.missingDocumentMemoryAnchors(anchored) : []);
    return true;
  }

  function render(): void {
    if (closed) return;
    if (editing) {
      renderDeferred = true;
      return;
    }
    renderDeferred = false;
    delete sheet.dataset.loading;
    const entries = memory?.entries ?? [];
    const rules = accountRules();
    const ruleBySubject = new Map<string, AccountRule>();
    for (const rule of rules ?? []) {
      const key = subjectKey(rule.subject);
      if (key && !ruleBySubject.has(key)) ruleBySubject.set(key, rule);
    }
    const strengths = new Map<string, number>();
    const groups: HTMLElement[] = [];
    for (const kind of KIND_ORDER) {
      const rows = entries.filter((entry) => entry.kind === kind);
      if (!rows.length) continue;
      const group = el('section', 'ag-memory-group');
      group.dataset.kind = kind;
      const heading = el('h3', 'ag-memory-kind', KIND_LABEL[kind][0] + KIND_LABEL[kind].slice(1).toLowerCase());
      const ul = el('ul', 'ag-memory-rows');
      for (const entry of rows) {
        const rule = ruleBySubject.get(subjectKey(entry.subject));
        ul.append(buildRow(entry, rule && overridesRule(entry, rule) ? rule : null));
        strengths.set(entry.id, entry.strength);
      }
      group.append(heading, ul);
      groups.push(group);
    }
    const children: HTMLElement[] = [];
    if (rules && memory) {
      // 두 층을 함께 보일 때만 '이 문서' 머리를 단다. 문서 기억이 없으면 빈 줄을 그 자리에 둔다.
      const docTier = el('section', 'ag-memory-tier');
      docTier.dataset.tier = 'document';
      docTier.append(el('h3', 'ag-memory-tier-title', '이 문서'));
      if (groups.length) docTier.append(...groups);
      else docTier.append(el('p', 'ag-memory-tier-empty', '이 문서의 기억은 아직 없습니다.'));
      const overriddenRules = new Set(rules.filter((rule) => entries.some((entry) => overridesRule(entry, rule))).map((rule) => rule.id));
      children.push(docTier, buildAccountTier(rules, overriddenRules, strengths));
    } else {
      children.push(...groups);
    }
    list.replaceChildren(...children);
    list.hidden = children.length === 0;
    empty.hidden = children.length > 0 || !memory;
    shownStrength.clear();
    for (const [id, value] of strengths) shownStrength.set(id, value);
    painted = memory !== null;
  }

  /** 지금 보일 장기기억. Rau 요금제가 아니거나 허브가 쓸 수 없다고 하면 null — 칸을 그리지 않는다. */
  function accountRules(): AccountRule[] | null {
    if (options.plan?.status()?.tier !== 'rau') return null;
    const snapshot = rauMemory.state().memory;
    return snapshot?.available ? snapshot.rules : null;
  }

  /** 강도 물그릇. 지난 그림과 다르면 그 값에서 움직인다 — 새로 생긴 줄은 빈 그릇에서 차오른다. */
  function strengthGauge(key: string, value: number): HTMLElement {
    const from = painted ? shownStrength.get(key) ?? 0 : value;
    return createStrengthGauge(value, from === value ? {} : { from, animate: true }).root;
  }

  /** '장기기억' — 장기기억을 읽기 전용으로 보인다. 센 것부터, 이 문서가 대신하는 규칙은 늘 보인다. */
  function buildAccountTier(rules: AccountRule[], overriddenRules: Set<string>, strengths: Map<string, number>): HTMLElement {
    const tier = el('section', 'ag-memory-tier');
    tier.dataset.tier = 'account';
    const head = el('div', 'ag-memory-tier-head');
    head.append(el('h3', 'ag-memory-tier-title', '장기기억'));
    if (rules.length) head.append(el('span', 'ag-memory-tier-count', String(rules.length)));
    tier.append(head);
    if (!rules.length) {
      tier.append(el('p', 'ag-memory-tier-empty', '아직 장기기억이 없습니다.'));
      return tier;
    }
    const overridden = (rule: AccountRule) => overriddenRules.has(rule.id);
    const visible = accountExpanded ? rules : rules.filter((rule, index) => index < ACCOUNT_PREVIEW || overridden(rule));
    const ul = el('ul', 'ag-memory-rows');
    for (const rule of visible) {
      const key = `account:${rule.id}`;
      const row = el('li', 'ag-memory-row');
      row.dataset.ruleId = rule.id;
      row.dataset.readonly = 'true';
      const body = el('div', 'ag-memory-row-body');
      body.append(el('div', 'ag-memory-text', rule.text));
      if (overridden(rule)) {
        row.dataset.overridden = 'true';
        const meta = el('div', 'ag-memory-anchor');
        meta.append(el('span', 'ag-memory-override', 'OVERRIDE'));
        body.append(meta);
      }
      row.append(strengthGauge(key, rule.strength), body);
      ul.append(row);
      strengths.set(key, rule.strength);
    }
    tier.append(ul);
    const folded = rules.length - visible.length;
    if (folded > 0 || (accountExpanded && rules.length > ACCOUNT_PREVIEW)) {
      const more = el('button', 'ag-memory-more', accountExpanded ? '접기' : `${folded}개 더 보기`);
      more.type = 'button';
      more.setAttribute('aria-expanded', String(accountExpanded));
      more.addEventListener('click', () => {
        accountExpanded = !accountExpanded;
        render();
        list.querySelector<HTMLElement>('.ag-memory-more')?.focus({ preventScroll: true });
      });
      tier.append(more);
    }
    return tier;
  }

  function buildRow(entry: DocumentMemoryEntry, overrides: AccountRule | null): HTMLElement {
    const row = el('li', 'ag-memory-row');
    row.dataset.entryId = entry.id;
    if (pendingIds.has(entry.id)) row.dataset.pending = 'true';
    const body = el('div', 'ag-memory-row-body');
    const text = el('div', 'ag-memory-text', entry.text);
    text.tabIndex = 0;
    text.setAttribute('role', 'button');
    text.setAttribute('aria-label', `${entry.text} 고치기`);
    text.addEventListener('click', () => beginEdit(entry.id));
    text.addEventListener('keydown', (event) => {
      if ((event.key === 'Enter' || event.key === ' ') && !event.isComposing) {
        event.preventDefault();
        beginEdit(entry.id);
      }
    });
    body.append(text);
    // 자동 학습이 남긴 기억만 이름표를 단다. 사용자 요청·시트에서 고친 기억은 달지 않는다.
    const learned = entry.origin === 'learned';
    if (entry.anchor || learned || overrides) {
      const anchor = el('div', 'ag-memory-anchor');
      if (learned) anchor.append(el('span', 'ag-memory-origin', RAU_TASTE_NAME));
      if (overrides) {
        // 같은 주제의 장기기억이 있다 — 이 문서에서는 이 줄이 앞선다.
        row.dataset.override = 'true';
        const tag = el('span', 'ag-memory-override', 'OVERRIDE');
        tag.title = `장기기억: ${overrides.text}`;
        anchor.append(tag);
      }
      if (entry.anchor) {
        const quote = el('span', 'ag-memory-quote', `“${entry.anchor.quote}”`);
        quote.title = entry.anchor.quote;
        anchor.append(quote);
        if (missing.has(entry.id)) {
          row.dataset.stale = 'true';
          anchor.append(el('span', 'ag-memory-stale', '문서에 없음'));
        }
      }
      body.append(anchor);
    }
    const remove = el('button', 'ag-memory-remove');
    remove.type = 'button';
    remove.setAttribute('aria-label', '삭제');
    remove.append(createIcon('close'));
    remove.addEventListener('click', () => void removeEntry(entry.id));
    row.append(strengthGauge(entry.id, entry.strength), body, remove);
    return row;
  }

  function rowOf(id: string): HTMLElement | null {
    return list.querySelector<HTMLElement>(`.ag-memory-row[data-entry-id="${CSS.escape(id)}"]`);
  }

  function beginEdit(id: string, draft?: string): void {
    const entry = memory?.entries.find((item) => item.id === id);
    const row = rowOf(id);
    if (!entry || !row || pendingIds.has(id)) return;
    if (editing && editing.id !== id) {
      commitEdit();
      // 다른 곳에서 바뀐 항목의 초안을 다시 열었다 — 그 초안을 두고 옮겨 가지 않는다.
      if (editing) return;
    }
    editing = { id, draft: draft ?? entry.text, base: structuredClone(entry) };
    const text = row.querySelector<HTMLElement>('.ag-memory-text');
    if (!text) return;
    const area = el('textarea', 'ag-memory-edit');
    area.value = editing.draft;
    area.rows = 1;
    area.maxLength = TEXT_MAX;
    area.spellcheck = false;
    area.setAttribute('aria-label', '기억 고치기');
    text.replaceWith(area);
    row.dataset.editing = 'true';
    autoGrow(area);
    area.focus({ preventScroll: true });
    area.setSelectionRange(area.value.length, area.value.length);
    area.addEventListener('input', () => {
      const flat = singleLine(area.value);
      if (flat !== area.value) area.value = flat;
      if (editing?.id === id) editing.draft = area.value;
      autoGrow(area);
    });
    area.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      commitEdit(true);
    });
    area.addEventListener('blur', () => {
      // 시트를 닫으며 잃은 초점은 저장하지 않는다.
      if (!closed && editing?.id === id) commitEdit();
    });
  }

  /** 고치기를 닫는다. 키보드로 닫았으면 초점을 그 줄로 돌린다. */
  function endEdit(refocus = false): void {
    const id = editing?.id;
    editing = null;
    render();
    if (refocus && id) rowOf(id)?.querySelector<HTMLElement>('.ag-memory-text')?.focus({ preventScroll: true });
  }

  function cancelEdit(): void {
    showError(null);
    endEdit(true);
  }

  function commitEdit(refocus = false): void {
    if (!editing) return;
    const { id, draft, base } = editing;
    const entry = memory?.entries.find((item) => item.id === id);
    const next = singleLine(draft).trim();
    if (!entry || !next || next === entry.text) {
      endEdit(refocus);
      return;
    }
    if (!sameNote(entry, base)) {
      // 고치는 사이 다른 곳(에이전트·학습)에서 이 항목을 바꿨다. 덮지 않고 초안을 새 항목 위에 다시 연다.
      showError(ERROR_TEXT.MEMORY_CHANGED_ELSEWHERE!);
      editing = null;
      render();
      beginEdit(id, draft);
      return;
    }
    // 고친 글을 바로 보인다. 실패하면 초안을 그대로 다시 연다.
    entry.text = next;
    pendingIds.add(id);
    endEdit(refocus);
    void write([{ op: 'update', id, text: next }], id, base).then((ok) => {
      if (!ok && memory?.entries.some((item) => item.id === id)) beginEdit(id, draft);
    });
  }

  async function removeEntry(id: string): Promise<void> {
    const entry = memory?.entries.find((item) => item.id === id);
    if (pendingIds.has(id) || !entry) return;
    const base = editing?.id === id ? editing.base : structuredClone(entry);
    if (editing?.id === id) editing = null;
    pendingIds.add(id);
    render();
    await write([{ op: 'remove', id }], id, base);
  }

  async function addEntry(): Promise<void> {
    const text = singleLine(addInput.value).trim();
    if (!text || addRow.dataset.pending === 'true') return;
    addRow.dataset.pending = 'true';
    // 빈 주제는 허브가 종류와 글에서 만든다.
    const ok = await write([{ op: 'add', kind: addKind, text }], null);
    delete addRow.dataset.pending;
    if (ok && addInput.value.trim() === text) addInput.value = '';
  }

  /**
   * 허브에 쓴다. 그린 revision 을 싣고, 그사이 바뀌었으면 새로 읽어 한 번 더 쓴다.
   * 고치거나 지우던 항목이 사라졌거나 base 와 달라졌으면(다른 곳에서 고쳤다) 덮지 않는다.
   */
  async function write(ops: DocumentMemoryOp[], entryId: string | null, base?: DocumentMemoryEntry): Promise<boolean> {
    showError(null);
    let result = await bridge.applyDocumentMemory(ops, { expectedRevision: memory?.revision, documentId });
    if (result && !result.ok && result.error?.code === 'MEMORY_REVISION_CONFLICT') {
      const fresh = await bridge.listDocumentMemory(documentId);
      if (fresh?.ok) accept(fresh.memory);
      const current = entryId === null ? null : memory?.entries.find((entry) => entry.id === entryId);
      if (entryId !== null && !current) {
        result = { ok: false, error: { code: 'MEMORY_ENTRY_NOT_FOUND', message: '' } };
      } else if (current && base && !sameNote(current, base)) {
        result = { ok: false, error: { code: 'MEMORY_CHANGED_ELSEWHERE', message: '' } };
      } else {
        result = await bridge.applyDocumentMemory(ops, { expectedRevision: memory?.revision, documentId });
      }
    }
    if (entryId) pendingIds.delete(entryId);
    if (closed) return Boolean(result?.ok);
    if (result?.ok) {
      accept(result.memory);
      render();
      return true;
    }
    if (result?.error?.code === 'MEMORY_ENTRY_NOT_FOUND') {
      // 다른 곳에서 지워졌다 — 목록을 맞춘다.
      void reload();
    } else if (result) {
      // 낙관적으로 보인 글을 허브의 것으로 되돌린다.
      void reload();
    }
    showError(errorText(result));
    render();
    return false;
  }

  let reloading: Promise<void> | null = null;
  let reloadAgain = false;
  async function reload(): Promise<void> {
    if (reloading) {
      reloadAgain = true;
      return reloading;
    }
    reloading = (async () => {
      do {
        reloadAgain = false;
        const result = await bridge.listDocumentMemory(documentId);
        if (closed) return;
        if (result?.ok) {
          accept(result.memory);
          if (errorLine.textContent === OFFLINE_TEXT) showError(null);
        } else if (!memory) {
          showError(errorText(result));
        }
        render();
      } while (reloadAgain && !closed);
    })().finally(() => { reloading = null; });
    return reloading;
  }

  function selectKind(kind: DocumentMemoryKind): void {
    addKind = kind;
    kindLabel.textContent = KIND_LABEL[addKind];
    kindButton.setAttribute('aria-label', `종류: ${KIND_LABEL[addKind]}`);
    addInput.focus({ preventScroll: true });
  }

  async function chooseKind(): Promise<void> {
    const rect = kindButton.getBoundingClientRect();
    const choice = await showContextMenu(
      KIND_ORDER.map((kind) => ({ id: kind, label: KIND_LABEL[kind], checked: kind === addKind })),
      { x: rect.left, y: rect.bottom + 4 },
    );
    if (!choice || closed) return;
    selectKind(choice as DocumentMemoryKind);
  }

  sheet.addEventListener('keydown', (event) => {
    // 줄을 고치는 동안에는 초점을 빼앗지 않는다. 빼앗으면 blur 가 고치던 글을 저장한다.
    if (event.ctrlKey || event.altKey || event.metaKey || event.defaultPrevented || editing) return;
    const target = event.target instanceof Element ? event.target : null;
    const typing = Boolean(target?.closest('input, textarea, [contenteditable="true"]'));
    if (event.key === 'Process' || event.keyCode === 229) {
      if (!typing) addInput.focus({ preventScroll: true });
      return;
    }
    if (event.isComposing) return;
    if (event.key === 'Tab' && event.shiftKey) {
      // 목록의 단추와 줄에서는 초점을 뒤로 옮기는 원래 동작을 둔다.
      if (target && target !== sheet && !addRow.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      selectKind(KIND_ORDER[(KIND_ORDER.indexOf(addKind) + 1) % KIND_ORDER.length]!);
      return;
    }
    if (typing) return;
    // 초점이 간 단추는 Enter·Space 로 제 동작을 한다.
    if ((event.key === 'Enter' || event.key === ' ') && target?.closest('button, a, summary, [role="button"]')) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      addInput.focus({ preventScroll: true });
      void addEntry();
    } else if (event.key.length === 1) {
      event.preventDefault();
      event.stopPropagation();
      addInput.focus({ preventScroll: true });
      if (addInput.value.length < TEXT_MAX) {
        addInput.setRangeText(event.key, addInput.selectionStart ?? addInput.value.length, addInput.selectionEnd ?? addInput.value.length, 'end');
        addInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  });
  kindButton.setAttribute('aria-keyshortcuts', 'Shift+Tab');
  kindButton.title = '종류 바꾸기 (Shift+Tab)';
  kindButton.addEventListener('click', () => void chooseKind());
  learnButton.addEventListener('click', () => void learnFromHistory());
  addRow.addEventListener('submit', (event) => {
    event.preventDefault();
    void addEntry();
  });
  addInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // 한글 조합을 끝내는 Enter 는 보내지 않는다.
    if (event.isComposing || event.keyCode === 229) event.preventDefault();
  });

  const stopEvents = bridge.onEvent((event) => {
    if (event.type !== 'document-memory-changed') return;
    if (event.documentId !== documentId && event.key !== memory?.key) return;
    if (memory && event.key === memory.key && event.revision <= memory.revision) return;
    void reload();
  });

  // 장기기억과 요금제가 바뀌면 '장기기억' 칸을 다시 그린다. 고치는 중이면 render 가 미룬다.
  let shownAccount = accountRules();
  function accountChanged(): void {
    const next = accountRules();
    if (next === shownAccount) return;
    shownAccount = next;
    if (memory) render();
  }
  /** 창에 아직 장기기억이 없으면 한 번 묻는다. 답은 함께 쓰는 상태로 들어가 구독으로 그려진다. */
  let accountRequested = false;
  function requestAccountMemory(): void {
    if (accountRequested || closed || !bridge.requestUserMemory) return;
    if (options.plan?.status()?.tier !== 'rau' || rauMemory.state().memory) return;
    accountRequested = true;
    void bridge.requestUserMemory({ op: 'list' }).then((result) => {
      if (result?.memory) rauMemory.accept({ type: 'user-memory', memory: result.memory });
    }, () => {});
  }
  const stopRauMemory = rauMemory.subscribe(() => accountChanged());
  const stopPlan = options.plan?.subscribe(() => {
    accountChanged();
    requestAccountMemory();
  }) ?? (() => {});

  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const finish = frame.present(() => addInput, () => {
    closed = true;
    if (noteTimer !== null) clearTimeout(noteTimer);
    stopEvents();
    stopRauMemory();
    stopPlan();
    resolveClosed();
  });
  requestAccountMemory();
  void reload();

  return {
    close: () => finish(false),
    closed: closedPromise,
  };
}

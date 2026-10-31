/**
 * 설정 → Rau. 계정의 기억(Rau-0.1)과 문체 학습 — Rau 요금제(체험 포함)에서만 열린다.
 *
 * 위에서부터: 하마가 선 물가와 상태 줄·대화에서 배우기, 문체 학습(올리기 → 도는 카드 → 결과 카드),
 * 기억(문체·용어, 강도, 고치기·지우기·더하기), 최근 변화(되돌리기), 물러난 기억(되살리기).
 * 정본은 허브에 있다. 이 화면은 창 하나가 함께 보는 sharedRauMemoryStore 를 그리고, 바꾸는 요청만 보낸다.
 * 학습은 팝업 없이 이 탭 안의 카드에서 돈다 — 다른 창에서 올린 학습도 같은 카드로 보인다.
 */
import './settings-rau.css';
import type { SidebarBridge } from '../../agent/bridge.ts';
import { RAU_TASTE_NAME } from '../../agent/taste.ts';
import type {
  AccountRule,
  AccountRuleKind,
  MemoryEvent,
  MemoryEventKind,
  RetireReason,
  RetiredRule,
  StyleLearnFound,
  StyleLearnSummary,
  StyleLearnSummaryItem,
  StyleLearnUpload,
  StyleUploadRecord,
  TasteSettings,
  UserMemoryOp,
  UserMemorySnapshot,
} from '../../agent/types.ts';
import {
  ACCOUNT_RULE_TEXT_MAX,
  checkStyleLearnFiles,
  STYLE_LEARN_EXTENSIONS,
  STYLE_LEARN_MAX_FILE_BYTES,
  STYLE_LEARN_MAX_FILES,
} from '../../agent/user-memory.ts';
import { ByteLimitError, readBlobBytesWithLimit } from '../../core/document-input-limits.ts';
import { createHamaScene } from './rau-hero-scene.ts';
import { createPartyHama, Hama, type ChatHamaMode } from './chat-hama.ts';
import { createIcon } from './icons.ts';
import {
  styleLearnErrorMessage,
  styleLearnFraction,
  userMemoryErrorMessage,
  type RauMemoryState,
  type RauMemoryStore,
  type StyleLearnOutcome,
  type StyleLearnRun,
} from './rau-memory-state.ts';
import { createStrengthGauge, type StrengthGauge } from './strength-gauge.ts';
import { createTasteLearningToggle } from './settings-taste.ts';
import { formatRelativeTime } from './usage-format.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text?: string): HTMLButtonElement {
  const node = el('button', className, text);
  node.type = 'button';
  return node;
}

function iconButton(className: string, icon: Parameters<typeof createIcon>[0], label: string): HTMLButtonElement {
  const node = button(`ag-rau-icon-btn ${className}`);
  node.setAttribute('aria-label', label);
  node.title = label;
  node.append(createIcon(icon));
  return node;
}

const KIND_LABEL: Record<AccountRuleKind, string> = { style: '문체', term: '용어' };
const EVENT_LABEL: Record<MemoryEventKind, string> = {
  new: '새로',
  reinforced: '보강',
  dampened: '감쇄',
  escalated: '기억 승격',
  retired: '물러남',
  restored: '되살림',
  edited: '고침',
  deleted: '지움',
};
const RETIRE_LABEL: Record<RetireReason, string> = {
  dampened: '감쇄로',
  flipped: '뒤집힘',
  evicted: '자리 부족',
  deleted: '직접 지움',
  undone: '되돌림',
};
const SOURCE_LABEL: Record<MemoryEvent['source'], string> = { chat: '채팅', upload: '업로드', user: '직접' };
const STAGE_TITLE: Record<StyleLearnRun['stage'], string> = {
  starting: '원고를 보내는 중',
  reading: '원고 읽는 중',
  extracting: '문체 찾는 중',
  merging: '기억에 합치는 중',
};
const STAGE_MODE: Record<StyleLearnRun['stage'], ChatHamaMode> = {
  starting: 'read',
  reading: 'read',
  extracting: 'work',
  merging: 'think',
};
/** 끝난 하마가 재주를 부리고 결과 카드로 바뀌기까지. */
const FINISH_MS = 1500;

function timeMs(iso: string | null | undefined): number {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : 0;
}

function relative(iso: string | null | undefined): string {
  const at = timeMs(iso);
  return at ? formatRelativeTime(at) : '';
}

function shortDate(iso: string): string {
  const at = timeMs(iso);
  if (!at) return '';
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric' }).format(at);
}

function filesLabel(files: readonly string[]): string {
  if (!files.length) return '원고';
  return files.length === 1 ? files[0]! : `${files[0]} 외 ${files.length - 1}개`;
}

/** 규칙의 출처 — 문서 n개 / 업로드 n개 / 직접. */
export function ruleSourceLabel(rule: Pick<AccountRule, 'origin' | 'documents' | 'uploads'>): string {
  const parts: string[] = [];
  if (rule.documents > 0) parts.push(`문서 ${rule.documents}개`);
  if (rule.uploads > 0) parts.push(`업로드 ${rule.uploads}개`);
  if (rule.origin === 'user' || parts.length === 0) parts.unshift('직접');
  return parts.join(' · ');
}

function foundKey(item: Pick<StyleLearnFound, 'kind' | 'subject' | 'text'>): string {
  return `${item.kind}\u0000${item.subject}\u0000${item.text}`;
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunk, bytes.length)));
  }
  return btoa(binary);
}

/** 고른 파일 검사의 결과를 사용자 말로. */
function pickProblemMessage(problem: ReturnType<typeof checkStyleLearnFiles>['problem']): string {
  switch (problem) {
    case 'too-many': return `한 번에 ${STYLE_LEARN_MAX_FILES}개까지 올릴 수 있어요.`;
    case 'file-too-large': return styleLearnErrorMessage('FILE_TOO_LARGE');
    case 'total-too-large': return styleLearnErrorMessage('FILES_TOO_LARGE');
    case 'unsupported': return styleLearnErrorMessage('UNSUPPORTED_FILE');
    case 'empty': return '빈 파일은 배울 수 없어요.';
    default: return '';
  }
}

export type RauPaneBridge = Pick<
  SidebarBridge,
  | 'requestUserMemory'
  | 'startStyleLearn'
  | 'cancelStyleLearn'
  | 'requestStyleLearnStatus'
  | 'answerStyleLearnLegacy'
  | 'requestTasteSettings'
  | 'setTasteSettings'
  | 'getConnectionState'
>;

export interface RauSettingsPaneDeps {
  bridge: RauPaneBridge;
  store: RauMemoryStore;
  isDisposed(): boolean;
  /** 요금제 카드를 Rau 칸에 맞춰 연다. 없으면 단추가 없다. */
  openPlans?: (() => void) | null;
  /**
   * 요금제 API 가 있는가(데스크톱 앱). 있으면 탭이 열린 것 자체가 Rau 요금제라는 뜻이라,
   * 'unavailable' 은 "요금제에서 배워요"가 아니라 "지금 Rau 에 닿지 않아요"다.
   */
  hasPlanApi?: boolean;
}

/** 사이드바마다 Rau 탭이 하나씩 있다 — 문서 안에서 id 가 겹치지 않게 센다. */
let paneSeq = 0;

export interface RauSettingsPane {
  root: HTMLElement;
  /** 탭이 보인다 — 기억·진행·설정을 새로 묻고 하마를 깨운다. */
  open(): void;
  /** 탭이 가려졌다 — 하마를 재운다. */
  close(): void;
  isOpen(): boolean;
  acceptTasteSettings(settings: TasteSettings | null): void;
  setConnected(connected: boolean): void;
  /** 파일 고르기를 연다(칩·명령에서). */
  pickFiles(): void;
  dispose(): void;
}

interface RuleRow {
  root: HTMLLIElement;
  gauge: StrengthGauge;
  update(rule: AccountRule, animate: boolean): void;
}

export function createRauSettingsPane(deps: RauSettingsPaneDeps): RauSettingsPane {
  const { bridge, store } = deps;
  let opened = false;
  let disposed = false;
  let connected = bridge.getConnectionState() === 'connected';
  let state: RauMemoryState = store.state();
  let busyOps = 0;
  let messageTimer = 0;
  let addKind: AccountRuleKind = 'style';
  let editing: { id: string; text: string; kind: AccountRuleKind } | null = null;
  let uploadsExpanded = false;
  let legacyBusy = false;
  /** 결과 카드로 바뀌기 전에 하마가 재주를 부리는 동안의 학습. */
  let finishing: { run: StyleLearnRun; until: number } | null = null;
  let finishTimer = 0;
  /** 지난 그림의 강도 — 바뀐 규칙만 물이 움직인다. */
  const lastStrength = new Map<string, number>();
  let seenRules = false;

  const root = el('div', 'ag-settings-destination-content ag-rau-pane');

  // ── 머리: 물가의 하마, 이름, 상태 줄, 대화에서 배우기 ─────────
  const hero = el('section', 'ag-rau-hero');
  const heroArt = el('div', 'ag-rau-hero-art');
  heroArt.append(createHamaScene('ag-rau-hero-scene'));
  const heroCopy = el('div', 'ag-rau-hero-copy');
  const heroName = el('h3', 'ag-settings-section-title ag-rau-hero-name', RAU_TASTE_NAME);
  const heroStatus = el('p', 'ag-rau-hero-status');
  heroStatus.setAttribute('aria-live', 'polite');
  heroCopy.append(heroName, heroStatus);
  const heroTop = el('div', 'ag-rau-hero-top');
  heroTop.append(heroArt, heroCopy);
  const tasteToggle = createTasteLearningToggle({ bridge, isDisposed: () => disposed || deps.isDisposed() });
  const notice = el('div', 'ag-rau-notice');
  notice.hidden = true;
  const noticeText = el('p', 'ag-rau-notice-text');
  const noticeAction = button('ag-settings-btn ag-rau-notice-action', '요금제 보기');
  noticeAction.hidden = true;
  noticeAction.addEventListener('click', () => deps.openPlans?.());
  notice.append(createIcon('warning'), noticeText, noticeAction);
  hero.append(heroTop, tasteToggle.root, notice);

  // ── 문체 학습 ────────────────────────────────────────
  const learn = el('section', 'ag-rau-section ag-rau-learn');
  const learnHead = el('div', 'ag-rau-section-head');
  learnHead.append(el('h3', 'ag-settings-section-title', '문체 학습'));
  const learnLead = el('p', 'ag-rau-section-lead', '내 글을 올리면 Rau-0.1이 문체와 용어를 배워 기억에 더해요.');
  const legacyCard = el('div', 'ag-rau-legacy');
  legacyCard.hidden = true;
  const legacyText = el('p', 'ag-rau-legacy-text');
  const legacyAccept = button('ag-settings-primary', '만들기');
  const legacyDecline = button('ag-settings-btn', '아니요');
  const legacyActions = el('div', 'ag-rau-legacy-actions');
  legacyActions.append(legacyDecline, legacyAccept);
  legacyCard.append(createIcon('sparkles'), legacyText, legacyActions);
  const stage = el('div', 'ag-rau-learn-stage');
  const uploadsBox = el('div', 'ag-rau-uploads');
  learn.append(learnHead, learnLead, legacyCard, stage, uploadsBox);

  const fileInput = el('input', 'ag-rau-file-input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.accept = STYLE_LEARN_EXTENSIONS.map((ext) => `.${ext}`).join(',');
  fileInput.hidden = true;
  fileInput.tabIndex = -1;

  const dropMetaId = `ag-rau-drop-meta-${++paneSeq}`;
  const dropzone = button('ag-rau-drop');
  dropzone.setAttribute('aria-describedby', dropMetaId);
  const dropIcon = el('span', 'ag-rau-drop-icon');
  dropIcon.append(createIcon('documentAdd'));
  const dropTitle = el('span', 'ag-rau-drop-title', '원고를 끌어다 놓거나 골라 주세요');
  // 형식과 한도를 두 줄로 — 한 줄에 이으면 좁은 폭에서 가운뎃점만 줄 끝에 남는다.
  const dropMeta = el('span', 'ag-rau-drop-meta');
  dropMeta.append(
    el('span', 'ag-rau-drop-meta-line', STYLE_LEARN_EXTENSIONS.filter((ext) => ext !== 'htm').join(' · ')),
    el('span', 'ag-rau-drop-meta-line', `${STYLE_LEARN_MAX_FILES}개까지 · 파일당 20MB · 모두 50MB`),
  );
  dropMeta.id = dropMetaId;
  dropzone.append(dropIcon, dropTitle, dropMeta);
  dropzone.addEventListener('click', () => pickFiles());
  for (const type of ['dragenter', 'dragover'] as const) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      if (!dropzone.disabled) dropzone.classList.add('ag-dragging');
    });
  }
  for (const type of ['dragleave', 'drop'] as const) {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('ag-dragging');
    });
  }
  dropzone.addEventListener('drop', (event) => {
    if (dropzone.disabled) return;
    void upload([...(event.dataTransfer?.files ?? [])]);
  });
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void upload(files);
  });
  const learnMessage = el('p', 'ag-rau-learn-message');
  learnMessage.hidden = true;
  learnMessage.setAttribute('role', 'status');

  // 도는 카드 — 하마, 단계, 파일, 진행 막대, 찾은 규칙.
  const runCard = el('div', 'ag-rau-run');
  const runHippoStage = el('div', 'ag-rau-run-hippo');
  const runHama = new Hama(1);
  runHama.setBounds(0, 0);
  runHippoStage.append(runHama.el);
  const runCopy = el('div', 'ag-rau-run-copy');
  const runTitle = el('p', 'ag-rau-run-title');
  const runMeta = el('p', 'ag-rau-run-meta');
  const runFile = el('p', 'ag-rau-run-file');
  runCopy.append(runTitle, runMeta, runFile);
  const runCancel = button('ag-settings-btn ag-rau-run-cancel', '멈추기');
  const runTop = el('div', 'ag-rau-run-top');
  runTop.append(runHippoStage, runCopy, runCancel);
  const runBar = el('div', 'ag-rau-run-bar');
  runBar.setAttribute('role', 'progressbar');
  runBar.setAttribute('aria-valuemin', '0');
  runBar.setAttribute('aria-valuemax', '100');
  runBar.setAttribute('aria-label', '문체 학습 진행');
  const runFill = el('span', 'ag-rau-run-fill');
  runBar.append(runFill);
  const runFoundHead = el('p', 'ag-rau-run-found-head', '찾은 규칙');
  const runFound = el('ul', 'ag-rau-found');
  runFound.setAttribute('aria-live', 'polite');
  runCard.append(runTop, runBar, runFoundHead, runFound);
  /** 멈추기 단추가 지금 가리키는 학습 — 다른 학습으로 바뀌면 단추를 다시 살린다. */
  let cancelJobId: string | null = null;
  runCancel.addEventListener('click', () => {
    const jobId = store.state().run?.jobId;
    if (jobId) bridge.cancelStyleLearn(jobId);
    runCancel.disabled = true;
  });
  const foundShown = new Map<string, HTMLLIElement>();

  // ── 기억 ────────────────────────────────────────────
  const memorySection = el('section', 'ag-rau-section ag-rau-memory');
  const memoryHead = el('div', 'ag-rau-section-head');
  const memoryCount = el('span', 'ag-rau-count');
  memoryHead.append(el('h3', 'ag-settings-section-title', '기억'), memoryCount);
  const memoryLead = el('p', 'ag-rau-section-lead', '모든 문서에서 Rau-0.1이 따르는 규칙이에요. 여러 문서에서 거듭 보이면 강해지고, 어긋나면 약해져요.');
  const memoryEmpty = el('p', 'ag-rau-empty', '아직 기억이 없어요. 원고를 올리거나, 채팅에서 고쳐 주면 쌓여요.');
  const groups = new Map<AccountRuleKind, { root: HTMLElement; list: HTMLUListElement; count: HTMLElement; rows: Map<string, RuleRow> }>();
  const groupsBox = el('div', 'ag-rau-groups');
  for (const kind of ['style', 'term'] as const) {
    const group = el('div', 'ag-rau-group');
    group.dataset.kind = kind;
    const head = el('div', 'ag-rau-group-head');
    const count = el('span', 'ag-rau-group-count');
    head.append(el('h4', 'ag-settings-group-title ag-rau-group-title', KIND_LABEL[kind]), count);
    const list = el('ul', 'ag-rau-rules');
    group.append(head, list);
    groupsBox.append(group);
    groups.set(kind, { root: group, list, count, rows: new Map() });
  }
  const memoryMessage = el('p', 'ag-rau-message');
  memoryMessage.hidden = true;
  memoryMessage.setAttribute('role', 'status');

  // 더하기 줄 — 종류와 한 줄.
  const addForm = el('form', 'ag-rau-add');
  const addKindSwitch = kindSwitch(addKind, (kind) => { addKind = kind; });
  const addInput = el('input', 'ag-settings-input ag-rau-add-input');
  addInput.type = 'text';
  addInput.maxLength = ACCOUNT_RULE_TEXT_MAX;
  addInput.placeholder = '예: 문장 끝은 "~합니다"로 맺는다';
  addInput.setAttribute('aria-label', '새 기억');
  const addSubmit = el('button', 'ag-settings-btn ag-rau-add-submit', '더하기');
  addSubmit.type = 'submit';
  addForm.append(addKindSwitch.root, addInput, addSubmit);
  addInput.addEventListener('input', () => { addSubmit.disabled = !addInput.value.trim() || busyOps > 0; });
  addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = addInput.value.trim();
    if (!text) return;
    void send({ op: 'add', rule: { kind: addKind, text } }).then((ok) => {
      if (!ok) return;
      addInput.value = '';
      addSubmit.disabled = true;
    });
  });
  memorySection.append(memoryHead, memoryLead, memoryEmpty, groupsBox, addForm, memoryMessage);

  // ── 최근 변화 ────────────────────────────────────────
  const eventsSection = el('section', 'ag-rau-section ag-rau-events');
  const eventsHead = el('div', 'ag-rau-section-head');
  eventsHead.append(el('h3', 'ag-settings-section-title', '최근 변화'));
  const eventsList = el('ul', 'ag-rau-event-list');
  const eventsEmpty = el('p', 'ag-rau-empty', '바뀐 것이 생기면 여기에 남아요.');
  eventsSection.append(eventsHead, eventsList, eventsEmpty);

  // ── 물러난 기억 ──────────────────────────────────────
  const retiredSection = el('details', 'ag-rau-section ag-rau-retired');
  const retiredSummary = el('summary', 'ag-rau-retired-summary');
  const retiredTitle = el('span', 'ag-settings-section-title', '물러난 기억');
  const retiredCount = el('span', 'ag-rau-count');
  retiredSummary.append(retiredTitle, retiredCount);
  const retiredLead = el('p', 'ag-rau-section-lead', '약해졌거나 지운 기억이에요. 되살리면 마지막 강도로 돌아와요.');
  const retiredList = el('ul', 'ag-rau-retired-list');
  retiredSection.append(retiredSummary, retiredLead, retiredList);

  root.append(hero, learn, memorySection, eventsSection, retiredSection, fileInput);

  // ── 요청 ────────────────────────────────────────────

  function flash(text: string, target: HTMLElement = memoryMessage): void {
    window.clearTimeout(messageTimer);
    for (const node of [memoryMessage, learnMessage]) {
      node.textContent = node === target ? text : '';
      node.hidden = node !== target || !text;
    }
    if (text) messageTimer = window.setTimeout(() => flash('', target), 5000);
  }

  /** 기억을 바꾸는 요청. 허브가 user-memory 로도 알리지만 답의 스냅숏을 곧바로 그린다. */
  async function send(op: UserMemoryOp): Promise<boolean> {
    if (!connected) {
      flash(userMemoryErrorMessage('OFFLINE'));
      return false;
    }
    busyOps += 1;
    renderBusy();
    const result = await bridge.requestUserMemory(op);
    busyOps -= 1;
    if (disposed) return false;
    if (result?.memory) store.accept({ type: 'user-memory', memory: result.memory });
    renderBusy();
    if (!result) {
      flash(userMemoryErrorMessage('OFFLINE'));
      return false;
    }
    if (!result.ok) {
      flash(userMemoryErrorMessage(result.error?.code ?? ''));
      return false;
    }
    flash('');
    return true;
  }

  function pickFiles(): void {
    if (dropzone.disabled || state.run) return;
    fileInput.click();
  }

  async function upload(files: File[]): Promise<void> {
    if (state.run || !files.length) return;
    const checked = checkStyleLearnFiles(files.map((file) => ({ name: file.name, size: file.size })));
    if (checked.problem) {
      flash(pickProblemMessage(checked.problem), learnMessage);
      return;
    }
    if (!connected) {
      flash(styleLearnErrorMessage('OFFLINE'), learnMessage);
      return;
    }
    const picked = checked.accepted.map((index) => files[index]!);
    const left = [...checked.unsupported, ...checked.empty];
    flash(left.length ? `${left.join(', ')} 은(는) 빼고 올려요.` : '', learnMessage);
    // 읽는 동안에도 카드가 곧바로 돈다.
    const placeholder = `local-${Date.now().toString(36)}`;
    store.begin(placeholder, picked.map((file) => file.name));
    let uploads: StyleLearnUpload[];
    try {
      uploads = await Promise.all(picked.map(async (file) => ({
        name: file.name,
        type: file.type,
        size: file.size,
        content: toBase64(await readBlobBytesWithLimit(file, STYLE_LEARN_MAX_FILE_BYTES, file.name)),
      })));
    } catch (error) {
      // 고른 뒤 파일이 커졌으면 한도로 멈춘다.
      store.fail(placeholder, error instanceof ByteLimitError ? 'FILE_TOO_LARGE' : 'INVALID_FILES');
      return;
    }
    if (disposed) return;
    const requestId = bridge.startStyleLearn(uploads);
    if (!requestId) {
      store.fail(placeholder, 'OFFLINE');
      return;
    }
    store.begin(requestId, picked.map((file) => file.name));
  }

  function answerLegacy(accept: boolean): void {
    if (legacyBusy || !connected) return;
    const files = state.memory?.legacy?.files ?? 0;
    const requestId = bridge.answerStyleLearnLegacy(accept);
    if (!requestId) {
      flash(styleLearnErrorMessage('OFFLINE'), learnMessage);
      return;
    }
    legacyBusy = true;
    if (accept) store.begin(requestId, Array.from({ length: files }, (_, index) => `이전 원고 ${index + 1}`), { legacy: true });
    render();
  }
  legacyAccept.addEventListener('click', () => answerLegacy(true));
  legacyDecline.addEventListener('click', () => answerLegacy(false));

  // ── 그리기 ──────────────────────────────────────────

  function kindSwitch(initial: AccountRuleKind, onChange: (kind: AccountRuleKind) => void): { root: HTMLElement; set(kind: AccountRuleKind): void } {
    const group = el('div', 'ag-rau-kind');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', '종류');
    const buttons = new Map<AccountRuleKind, HTMLButtonElement>();
    const set = (kind: AccountRuleKind) => {
      for (const [value, node] of buttons) {
        node.setAttribute('aria-checked', String(value === kind));
        node.tabIndex = value === kind ? 0 : -1;
      }
    };
    for (const kind of ['style', 'term'] as const) {
      const node = button('ag-rau-kind-option', KIND_LABEL[kind]);
      node.setAttribute('role', 'radio');
      node.dataset.kind = kind;
      node.addEventListener('click', () => { set(kind); onChange(kind); });
      node.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = kind === 'style' ? 'term' : 'style';
        set(next);
        onChange(next);
        buttons.get(next)?.focus();
      });
      buttons.set(kind, node);
      group.append(node);
    }
    set(initial);
    return { root: group, set };
  }

  function buildRuleRow(rule: AccountRule): RuleRow {
    const row = el('li', 'ag-rau-rule');
    row.dataset.ruleId = rule.id;
    const gauge = createStrengthGauge(rule.strength, { size: 'md' });
    const body = el('div', 'ag-rau-rule-body');
    const text = el('p', 'ag-rau-rule-text');
    const meta = el('p', 'ag-rau-rule-meta');
    body.append(text, meta);
    const actions = el('div', 'ag-rau-rule-actions');
    const edit = iconButton('ag-rau-rule-edit', 'pencil', '고치기');
    const remove = iconButton('ag-rau-rule-delete', 'trash', '지우기');
    actions.append(edit, remove);
    row.append(gauge.root, body, actions);
    let current = rule;

    function showEditor(): void {
      const form = el('form', 'ag-rau-rule-editor');
      const kind = kindSwitch(editing?.kind ?? current.kind, (value) => { if (editing) editing.kind = value; });
      const input = el('textarea', 'ag-settings-input ag-rau-rule-input');
      input.rows = 2;
      input.maxLength = ACCOUNT_RULE_TEXT_MAX;
      input.value = editing?.text ?? current.text;
      input.setAttribute('aria-label', '기억 고치기');
      const save = el('button', 'ag-settings-primary', '저장');
      save.type = 'submit';
      const cancel = button('ag-settings-btn', '취소');
      const buttons = el('div', 'ag-rau-rule-editor-actions');
      buttons.append(kind.root, cancel, save);
      form.append(input, buttons);
      body.replaceChildren(form);
      actions.hidden = true;
      row.classList.add('ag-rau-rule-editing');
      input.addEventListener('input', () => { if (editing) editing.text = input.value; });
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeEditor(); }
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
      });
      cancel.addEventListener('click', () => closeEditor());
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const next = input.value.replace(/\s+/g, ' ').trim();
        const nextKind = editing?.kind ?? current.kind;
        if (!next) return;
        if (next === current.text && nextKind === current.kind) { closeEditor(); return; }
        save.disabled = true;
        void send({ op: 'edit', id: current.id, text: next, ...(nextKind !== current.kind ? { kind: nextKind } : {}) }).then((ok) => {
          save.disabled = false;
          if (ok) closeEditor();
        });
      });
      requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }

    function closeEditor(): void {
      editing = null;
      row.classList.remove('ag-rau-rule-editing');
      body.replaceChildren(text, meta);
      actions.hidden = false;
      // 고치는 사이 종류가 바뀌었으면 다른 무리로 옮긴다.
      render();
      edit.focus({ preventScroll: true });
    }

    edit.addEventListener('click', () => {
      editing = { id: current.id, text: current.text, kind: current.kind };
      showEditor();
    });
    remove.addEventListener('click', () => {
      row.classList.add('ag-rau-rule-leaving');
      void send({ op: 'delete', id: current.id }).then((ok) => {
        if (!ok) row.classList.remove('ag-rau-rule-leaving');
        else flash('지웠어요. 물러난 기억에서 되살릴 수 있어요.');
      });
    });

    function update(next: AccountRule, animate: boolean): void {
      current = next;
      row.dataset.ruleId = next.id;
      row.dataset.strength = String(next.strength);
      text.textContent = next.text;
      meta.textContent = ruleSourceLabel(next);
      if (gauge.value !== next.strength) gauge.set(next.strength, { animate });
      remove.disabled = busyOps > 0;
      edit.disabled = busyOps > 0;
    }
    update(rule, false);
    return { root: row, gauge, update };
  }

  function renderRules(memory: UserMemorySnapshot | null): void {
    const rules = memory?.rules ?? [];
    const animate = seenRules && !reducedMotion();
    for (const [kind, group] of groups) {
      const mine = rules.filter((rule) => rule.kind === kind);
      const keep = new Set(mine.map((rule) => rule.id));
      for (const [id, row] of group.rows) {
        if (!keep.has(id) && editing?.id !== id) {
          row.root.remove();
          group.rows.delete(id);
        }
      }
      mine.forEach((rule, index) => {
        let row = group.rows.get(rule.id);
        const fresh = !row;
        if (!row) {
          row = buildRuleRow({ ...rule, strength: lastStrength.get(rule.id) ?? (animate ? 0 : rule.strength) });
          group.rows.set(rule.id, row);
        }
        if (editing?.id !== rule.id) row.update(rule, animate);
        if (fresh && animate && !lastStrength.has(rule.id)) {
          row.root.classList.add('ag-rau-rule-new');
          row.root.addEventListener('animationend', () => row!.root.classList.remove('ag-rau-rule-new'), { once: true });
        }
        if (group.list.children[index] !== row.root) group.list.insertBefore(row.root, group.list.children[index] ?? null);
      });
      group.count.textContent = String(mine.length);
      group.root.hidden = mine.length === 0;
    }
    lastStrength.clear();
    for (const rule of rules) lastStrength.set(rule.id, rule.strength);
    seenRules = memory !== null;
    memoryCount.textContent = rules.length ? `${rules.length}개` : '';
    memoryEmpty.hidden = rules.length > 0 || memory === null;
  }

  function strengthChange(change: { from: number; to: number } | undefined): HTMLElement | null {
    if (!change) return null;
    const box = el('span', 'ag-rau-change');
    box.append(createStrengthGauge(change.to, { from: change.from, size: 'sm', muted: change.to === 0, showFrom: true }).root);
    return box;
  }

  function renderEvents(memory: UserMemorySnapshot | null): void {
    const events = memory?.events ?? [];
    eventsList.replaceChildren(...events.slice(0, 12).map((event) => {
      const row = el('li', 'ag-rau-event');
      row.dataset.kind = event.kind;
      row.dataset.eventId = event.id;
      const tag = el('span', 'ag-rau-tag', EVENT_LABEL[event.kind]);
      tag.dataset.kind = event.kind;
      const body = el('div', 'ag-rau-event-body');
      const text = el('p', 'ag-rau-event-text');
      if (event.kind === 'edited' && event.prevText) {
        text.append(el('del', 'ag-rau-event-prev', event.prevText), ' → ', event.text);
      } else {
        text.textContent = event.text;
      }
      const meta = [KIND_LABEL[event.ruleKind], SOURCE_LABEL[event.source], event.documentName ?? '', relative(event.at)]
        .filter(Boolean).join(' · ');
      body.append(text, el('p', 'ag-rau-event-meta', meta));
      row.append(tag, body);
      const change = strengthChange(event.strength);
      if (change) row.append(change);
      if (event.undoable) {
        const undo = iconButton('ag-rau-event-undo', 'undo', '되돌리기');
        undo.disabled = busyOps > 0;
        undo.addEventListener('click', () => {
          undo.disabled = true;
          void send({ op: 'undo', eventId: event.id }).then((ok) => {
            if (ok) flash('되돌렸어요.');
            else undo.disabled = false;
          });
        });
        row.append(undo);
      }
      return row;
    }));
    eventsEmpty.hidden = events.length > 0;
    eventsSection.hidden = memory === null;
  }

  function renderRetired(memory: UserMemorySnapshot | null): void {
    const retired: RetiredRule[] = memory?.retired ?? [];
    retiredCount.textContent = retired.length ? `${retired.length}개` : '';
    retiredSection.hidden = retired.length === 0;
    retiredList.replaceChildren(...retired.map((rule) => {
      const row = el('li', 'ag-rau-retired-row');
      row.dataset.ruleId = rule.id;
      row.dataset.reason = rule.reason;
      const body = el('div', 'ag-rau-rule-body');
      body.append(
        el('p', 'ag-rau-rule-text', rule.text),
        el('p', 'ag-rau-rule-meta', [KIND_LABEL[rule.kind], RETIRE_LABEL[rule.reason], relative(rule.retiredAt)].filter(Boolean).join(' · ')),
      );
      const restore = button('ag-settings-btn ag-rau-restore', '되살리기');
      restore.disabled = busyOps > 0;
      restore.addEventListener('click', () => {
        restore.disabled = true;
        void send({ op: 'restore', id: rule.id }).then((ok) => {
          if (ok) flash('되살렸어요.');
          else restore.disabled = false;
        });
      });
      row.append(createStrengthGauge(rule.strength, { size: 'md', muted: true }).root, body, restore);
      return row;
    }));
  }

  function renderUploads(memory: UserMemorySnapshot | null): void {
    const uploads: StyleUploadRecord[] = memory?.uploads ?? [];
    uploadsBox.hidden = uploads.length === 0;
    if (!uploads.length) {
      uploadsBox.replaceChildren();
      return;
    }
    const head = el('p', 'ag-rau-uploads-head', '올린 원고');
    const list = el('ul', 'ag-rau-upload-list');
    const shown = uploadsExpanded ? uploads : uploads.slice(0, 3);
    list.append(...shown.map((record) => {
      const row = el('li', 'ag-rau-upload');
      const name = el('span', 'ag-rau-upload-name', filesLabel(record.files));
      name.title = record.files.join('\n');
      const counts = [
        record.counts.new ? `새로 ${record.counts.new}` : '',
        record.counts.reinforced ? `보강 ${record.counts.reinforced}` : '',
        record.counts.dampened ? `감쇄 ${record.counts.dampened}` : '',
      ].filter(Boolean).join(' · ') || '바뀐 것 없음';
      row.append(createIcon('document'), name, el('span', 'ag-rau-upload-meta', `${shortDate(record.at)} · ${counts}`));
      return row;
    }));
    uploadsBox.replaceChildren(head, list);
    if (uploads.length > 3) {
      const more = button('ag-rau-link', uploadsExpanded ? '접기' : `모두 보기 (${uploads.length})`);
      more.addEventListener('click', () => { uploadsExpanded = !uploadsExpanded; renderUploads(state.memory); });
      uploadsBox.append(more);
    }
  }

  function renderRun(run: StyleLearnRun, done: boolean): void {
    if (runCard.parentElement !== stage) stage.replaceChildren(runCard);
    runCard.dataset.stage = done ? 'done' : run.stage;
    const fraction = done ? 1 : styleLearnFraction(run);
    runFill.style.transform = `scaleX(${fraction})`;
    runBar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
    const total = run.files.length || run.total;
    const fileIndex = run.stage === 'reading' ? Math.min(total, run.completed + 1) : run.completed;
    const fileCount = run.stage === 'extracting' ? run.total : total;
    runTitle.textContent = done ? '다 배웠어요!' : STAGE_TITLE[run.stage];
    const parts: string[] = [];
    // 보내는 중(브라우저가 파일을 읽어 싸는 동안)에는 허브가 아직 어느 파일도 읽지 않았다.
    if (!done && run.stage !== 'merging' && run.stage !== 'starting' && fileCount > 0) parts.push(`파일 ${Math.max(run.stage === 'reading' ? 1 : 0, fileIndex)}/${fileCount}`);
    parts.push(`규칙 ${run.found.length}개`);
    runMeta.textContent = parts.join(' · ');
    runFile.textContent = done ? '' : run.file?.name ?? (run.legacy ? '이전 말투 맞추기 원고' : filesLabel(run.files));
    runCancel.hidden = done || !run.jobId;
    // 멈춘 뒤 다른 학습(다른 창·다시 연 창)이 jobId 를 가진 채로 바로 오면 단추를 다시 살린다.
    if (run.jobId !== cancelJobId) {
      cancelJobId = run.jobId;
      runCancel.disabled = false;
    }
    if (!run.jobId || done) runCancel.disabled = false;
    setHamaMode(done ? 'done' : STAGE_MODE[run.stage]);
    // 찾은 규칙: 새로 온 것만 튀어나온다.
    const keys = new Set(run.found.map(foundKey));
    for (const [key, node] of foundShown) {
      if (!keys.has(key)) { node.remove(); foundShown.delete(key); }
    }
    for (const item of run.found) {
      const key = foundKey(item);
      if (foundShown.has(key)) continue;
      const chip = el('li', 'ag-rau-found-item');
      chip.dataset.kind = item.kind;
      chip.append(el('span', 'ag-rau-tag', KIND_LABEL[item.kind]), el('span', 'ag-rau-found-text', item.text));
      if (!reducedMotion()) chip.classList.add('ag-rau-pop');
      runFound.prepend(chip);
      foundShown.set(key, chip);
    }
    runFoundHead.hidden = run.found.length === 0;
  }

  function summaryGroup(title: string, kind: string, items: readonly StyleLearnSummaryItem[], delay: { value: number }): HTMLElement | null {
    if (!items.length) return null;
    const group = el('div', 'ag-rau-result-group');
    group.dataset.kind = kind;
    const list = el('ul', 'ag-rau-result-list');
    for (const item of items) {
      const row = el('li', 'ag-rau-result-item');
      const tag = el('span', 'ag-rau-tag', KIND_LABEL[item.kind]);
      const body = el('div', 'ag-rau-result-body');
      body.append(el('p', 'ag-rau-result-text', item.text));
      if (item.note && kind === 'conflicts') {
        body.append(el('p', 'ag-rau-result-note', item.note === 'deleted' ? '직접 지운 기억과 같아서 더하지 않았어요.' : `기억: ${item.note}`));
      }
      row.append(tag, body);
      // 강도는 오른쪽 끝 한 칸에 — 종류 표와 글이 모든 줄에서 같은 자리에 선다(최근 변화와 같은 배치).
      if (item.strength) {
        const gauge = createStrengthGauge(item.strength.to, { from: item.strength.from, size: 'md', animate: !reducedMotion(), muted: item.strength.to === 0, showFrom: true });
        gauge.root.style.setProperty('--ag-strength-delay', `${delay.value}ms`);
        row.append(gauge.root);
      }
      if (!reducedMotion()) {
        row.style.animationDelay = `${delay.value}ms`;
        row.classList.add('ag-rau-pop');
        delay.value += 70;
      }
      list.append(row);
    }
    group.append(el('p', 'ag-rau-result-group-title', title), list);
    return group;
  }

  function renderResult(outcome: Extract<StyleLearnOutcome, { kind: 'result' }>): void {
    const summary: StyleLearnSummary = outcome.summary;
    const card = el('div', 'ag-rau-result');
    card.dataset.jobId = outcome.jobId;
    const head = el('div', 'ag-rau-result-head');
    const art = el('div', 'ag-rau-result-art');
    art.append(createPartyHama());
    if (!reducedMotion()) {
      for (let index = 0; index < 10; index += 1) {
        const bit = el('span', 'ag-rau-confetti');
        bit.style.setProperty('--i', String(index));
        art.append(bit);
      }
    }
    const copy = el('div', 'ag-rau-result-copy');
    const learned = summary.new.length + summary.reinforced.length;
    const title = el('p', 'ag-rau-result-title', learned ? '문체 학습 끝' : '이미 아는 문체예요');
    const lead = el('p', 'ag-rau-result-lead', learned
      ? `${outcome.legacy ? '이전 원고' : filesLabel(outcome.files)}에서 배운 것을 기억에 더했어요.`
      : '새로 더할 규칙은 없었어요. 기억은 그대로예요.');
    copy.append(title, lead);
    head.append(art, copy);
    const stats = el('div', 'ag-rau-stats');
    for (const [label, value, kind] of [
      ['새로', summary.new.length, 'new'],
      ['보강', summary.reinforced.length, 'reinforced'],
      ['감쇄', summary.dampened.length, 'dampened'],
      ['물러남', summary.retired.length, 'retired'],
    ] as const) {
      const stat = el('div', 'ag-rau-stat');
      stat.dataset.kind = kind;
      stat.classList.toggle('ag-rau-stat-zero', value === 0);
      stat.append(el('span', 'ag-rau-stat-value', String(value)), el('span', 'ag-rau-stat-label', label));
      stats.append(stat);
    }
    const delay = { value: 220 };
    const groupsNode = el('div', 'ag-rau-result-groups');
    for (const node of [
      summaryGroup('새로 배운 기억', 'new', summary.new, delay),
      summaryGroup('보강', 'reinforced', summary.reinforced, delay),
      summaryGroup('감쇄', 'dampened', summary.dampened, delay),
      summaryGroup('물러남', 'retired', summary.retired, delay),
      summaryGroup('기억과 어긋남', 'conflicts', summary.conflicts, delay),
    ]) if (node) groupsNode.append(node);
    if (summary.skippedFiles.length) {
      const skipped = el('p', 'ag-rau-result-skipped');
      skipped.append(createIcon('warning'), `읽지 못한 파일 · ${summary.skippedFiles.join(', ')}`);
      groupsNode.append(skipped);
    }
    const actions = el('div', 'ag-rau-result-actions');
    const more = button('ag-settings-btn', '더 올리기');
    const ok = button('ag-settings-primary', '확인');
    more.addEventListener('click', () => { store.dismissOutcome(); pickFiles(); });
    ok.addEventListener('click', () => store.dismissOutcome());
    actions.append(more, ok);
    card.append(head, stats, groupsNode, actions);
    stage.replaceChildren(card);
  }

  function renderError(outcome: Extract<StyleLearnOutcome, { kind: 'error' }>): void {
    const card = el('div', 'ag-rau-error');
    card.dataset.code = outcome.code;
    const quiet = outcome.code === 'CANCELLED';
    card.classList.toggle('ag-rau-error-quiet', quiet);
    const text = el('p', 'ag-rau-error-text', styleLearnErrorMessage(outcome.code, { legacy: outcome.legacy }));
    const actions = el('div', 'ag-rau-result-actions');
    const close = button('ag-settings-btn', '닫기');
    close.addEventListener('click', () => store.dismissOutcome());
    actions.append(close);
    if (outcome.code !== 'RAU_PLAN_REQUIRED' && outcome.code !== 'RAU_CREDITS_EXHAUSTED' && !outcome.legacy) {
      const retry = button('ag-settings-primary', '다시 올리기');
      retry.addEventListener('click', () => { store.dismissOutcome(); pickFiles(); });
      actions.append(retry);
    }
    if (outcome.code === 'RAU_PLAN_REQUIRED' && deps.openPlans) {
      const plans = button('ag-settings-primary', '요금제 보기');
      plans.addEventListener('click', () => deps.openPlans?.());
      actions.append(plans);
    }
    card.append(createIcon(quiet ? 'pause' : 'warning'), text, actions);
    stage.replaceChildren(card);
  }

  function renderStage(): void {
    const run = state.run;
    if (finishing && performance.now() < finishing.until) {
      renderRun(finishing.run, true);
    } else if (run) {
      renderRun(run, false);
    } else if (state.outcome?.kind === 'result') {
      if (stage.firstElementChild?.getAttribute('data-job-id') !== state.outcome.jobId) renderResult(state.outcome);
    } else if (state.outcome?.kind === 'error') {
      renderError(state.outcome);
    } else {
      if (stage.firstElementChild !== dropzone) stage.replaceChildren(dropzone, learnMessage);
    }
    if (!run && !finishing) {
      foundShown.clear();
      runFound.replaceChildren();
    }
    syncHama();
  }

  function renderHero(memory: UserMemorySnapshot | null): void {
    const parts: string[] = [];
    if (memory) {
      parts.push(memory.rules.length ? `기억 ${memory.rules.length}개` : '아직 기억 없음');
      if (memory.lastLearnedAt) parts.push(`마지막 학습 ${relative(memory.lastLearnedAt)}`);
    } else {
      parts.push(connected ? '기억을 불러오는 중' : '허브에 연결되면 기억을 불러와요');
    }
    if (state.run) parts.push('문체 학습 중');
    heroStatus.textContent = parts.join(' · ');
    let text = '';
    let action = false;
    let tone = 'info';
    const availability = memory?.availability ?? null;
    // 요금제 API 가 있으면 탭이 열린 것이 곧 Rau 요금제다 — unavailable 은 Rau 에 닿지 않는다는 뜻이다.
    const unreachable = availability === 'unavailable' && deps.hasPlanApi === true;
    if (unreachable) text = '지금 Rau 에 닿지 않아요. 기억은 그대로 보고 고칠 수 있어요.';
    else if (memory && memory.availability === 'unavailable') text = '데스크톱 앱의 Rau 요금제에서 배워요. 지금은 기억을 보고 고칠 수만 있어요.';
    else if (memory && memory.availability === 'not_eligible') { text = 'Rau 요금제에서 배우고 기억을 써요.'; action = Boolean(deps.openPlans); }
    else if (memory && memory.availability === 'exhausted') { text = '이번 달 Rau 크레딧을 다 썼어요. 기억은 그대로 쓰고, 문체 학습은 크레딧이 채워지면 다시 돼요.'; tone = 'warn'; }
    notice.hidden = !text;
    notice.dataset.tone = tone;
    noticeText.textContent = text;
    noticeAction.hidden = !action;
    // 배울 수 없을 때(웹 Studio, Hama, 크레딧 소진, Rau 에 닿지 않음)는 올리기를 잠근다 — 허브가 곧바로
    // 거절할 것을 50MB 까지 읽어 보내지 않는다.
    const learnable = !memory || availability === 'active';
    dropzone.disabled = !connected || !learnable;
    dropTitle.textContent = learnable
      ? '원고를 끌어다 놓거나 골라 주세요'
      : availability === 'exhausted'
        ? '크레딧이 채워지면 다시 올릴 수 있어요'
        : unreachable
          ? 'Rau 에 닿으면 다시 올릴 수 있어요'
          : '데스크톱 앱의 Rau 요금제에서 올릴 수 있어요';
    root.dataset.availability = memory?.availability ?? 'loading';
  }

  function renderLegacy(memory: UserMemorySnapshot | null): void {
    const files = memory?.legacy?.files ?? 0;
    if (!files) legacyBusy = false;
    legacyCard.hidden = !files || Boolean(state.run) || legacyBusy;
    legacyText.textContent = `이전 말투 맞추기 원고 ${files}개가 남아 있어요. 이 원고로 기억을 만들까요?`;
    // 지금 배울 수 없으면(크레딧 소진 등) 허브가 곧바로 거절한다. 아니요는 언제든 고를 수 있다.
    legacyAccept.disabled = !connected || legacyBusy || memory?.availability !== 'active';
    legacyDecline.disabled = !connected || legacyBusy;
  }

  function renderBusy(): void {
    addSubmit.disabled = !addInput.value.trim() || busyOps > 0 || !connected;
    addInput.disabled = !connected;
    for (const group of groups.values()) {
      for (const row of group.rows.values()) {
        for (const node of row.root.querySelectorAll<HTMLButtonElement>('.ag-rau-rule-actions button')) node.disabled = busyOps > 0 || !connected;
      }
    }
    // 요청 중에 도착한 user-memory 가 목록을 그리면 버튼이 잠긴 채 남는다 — 요청이 끝날 때 함께 푼다.
    for (const node of eventsList.querySelectorAll<HTMLButtonElement>('.ag-rau-event-undo')) node.disabled = busyOps > 0 || !connected;
    for (const node of retiredList.querySelectorAll<HTMLButtonElement>('.ag-rau-restore')) node.disabled = busyOps > 0 || !connected;
  }

  function render(): void {
    const memory = state.memory;
    renderHero(memory);
    renderLegacy(memory);
    renderStage();
    renderUploads(memory);
    renderRules(memory);
    renderEvents(memory);
    renderRetired(memory);
    renderBusy();
  }

  // ── 하마 ────────────────────────────────────────────
  let hamaMode: ChatHamaMode = 'idle';
  let visible = false;
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      syncHama();
    })
    : null;
  io?.observe(runHippoStage);

  function setHamaMode(mode: ChatHamaMode): void {
    if (mode === hamaMode) return;
    hamaMode = mode;
    runHama.setMode(mode);
    if (mode === 'done' && !reducedMotion()) {
      window.setTimeout(() => { if (!disposed && hamaMode === 'done') runHama.play('backflip'); }, 650);
    }
  }

  function syncHama(): void {
    const on = opened && (io ? visible : true) && runHippoStage.isConnected && document.visibilityState !== 'hidden';
    runHama.setActive(on, !reducedMotion());
  }
  const onVisibility = () => syncHama();
  document.addEventListener('visibilitychange', onVisibility);

  // ── 상태 구독 ────────────────────────────────────────
  const unsubscribe = store.subscribe((next) => {
    const prev = state;
    state = next;
    if (!next.memory?.legacy) legacyBusy = false;
    // 학습이 끝났다 — 결과 카드로 넘어가기 전에 하마가 잠깐 재주를 부린다.
    if (prev.run && !next.run && next.outcome?.kind === 'result' && opened && !reducedMotion()) {
      finishing = { run: { ...prev.run, found: prev.run.found }, until: performance.now() + FINISH_MS };
      window.clearTimeout(finishTimer);
      finishTimer = window.setTimeout(() => {
        finishing = null;
        if (!disposed) render();
      }, FINISH_MS);
    }
    if (next.run) legacyBusy = false;
    render();
  });

  render();

  return {
    root,
    open() {
      opened = true;
      connected = bridge.getConnectionState() === 'connected';
      void tasteToggle.refresh();
      if (connected) {
        void bridge.requestUserMemory({ op: 'list' }).then((result) => {
          if (!disposed && result?.memory) store.accept({ type: 'user-memory', memory: result.memory });
        });
        bridge.requestStyleLearnStatus();
      }
      render();
    },
    close() {
      opened = false;
      syncHama();
    },
    isOpen: () => opened,
    acceptTasteSettings(settings) {
      tasteToggle.accept(settings);
    },
    setConnected(next) {
      connected = next;
      if (next && opened) {
        void bridge.requestUserMemory({ op: 'list' }).then((result) => {
          if (!disposed && result?.memory) store.accept({ type: 'user-memory', memory: result.memory });
        });
        void tasteToggle.refresh();
      }
      render();
    },
    pickFiles,
    dispose() {
      disposed = true;
      unsubscribe();
      io?.disconnect();
      window.clearTimeout(finishTimer);
      window.clearTimeout(messageTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      runHama.dispose();
    },
  };
}

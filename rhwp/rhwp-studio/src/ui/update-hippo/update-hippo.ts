import { updateAllSign } from './update-all-sign.ts';
import { isInitialSetupActive, onInitialSetupInactive } from '../initial-setup/active.ts';
/**
 * 문서 홈 오른쪽 아래 가장자리의 업데이트 하마. 가장자리 위로 고개를 내밀고 팻말 막대를 물어
 * 들고 있다. 팻말 내용은 update-sign.ts 가 업데이트 상태에서 정한다.
 *
 * 그림은 scripts/generate-update-hippo-art.py 가 만든 update-hippo-sprites.png 의 칸이다.
 * 칸 순서(FRAMES)·칸 크기·막대 열(STICK_X)을 바꾸면 여기도 같이 바꾼다. 팻말은 한글과 단추를
 * 담아야 해서 HTML 이고, 그림과 같은 3px 칸으로 테두리를 그린다.
 *
 * 업데이트 팻말이 없으면 새 버전의 첫 실행에 릴리스 노트(release-notes.ts)를 잠깐 든다.
 *
 * 팻말이 바뀌면 하마가 가장자리 밑으로 내려갔다가 새 팻말을 들고 올라온다. 하마를 누르면 귀만
 * 남기고 숨고, 귀를 누르면 다시 올라온다(이 페이지가 떠 있는 동안 기억한다). 움직임은 3px 칸
 * 단위로만 끊고, 동작 줄이기 설정이면 움직이지 않는다.
 */
import './update-hippo.css';
import type { DesktopUpdateState, DesktopUpdatesApi, UpdateAllState } from '../../desktop-integration.ts';
import { updateSign, type UpdateSign, type UpdateSignAction, type UpdateSignIcon } from './update-sign.ts';
import { markReleaseNotesSeen, pendingReleaseNotes, RELEASE_NOTES, releaseNotesSign } from './release-notes.ts';

const FRAMES = ['idle', 'blink', 'ear', 'dip', 'peek'] as const;
type Frame = (typeof FRAMES)[number];

const SCALE = 3;
const CELL_WIDTH = 36;
const CELL_HEIGHT = 26;
/** 막대 왼쪽 열(두 칸 굵기). 팻말은 이 막대 가운데에 맞춘다. */
const STICK_X = 1;
/** 귀 끝 위의 막대 줄. 귀만 남길 때 이 줄들은 비어 있다. */
const STICK_ROWS = 12;
/** 숨었을 때 가장자리 위에 남는 줄: 귀와 눈. */
const PEEK_ROWS = 3;
const STEP_MS = 34;
/** 팻말이 창 오른쪽 끝에 닿지 않게 남기는 틈. */
const EDGE_GAP = 6;
/** 내려받기 막대의 폭(update-hippo.css 의 .uh-bar). */
const BAR_WIDTH = 108;

/** 가장자리 밑으로 들어갈 때(빨라짐)와 올라올 때(느려지며 한 칸 넘쳤다 앉음)의 진행. */
const SINK = [0.1, 0.28, 0.52, 0.8, 1];
const RISE = [0.62, 0.32, 0.12, 0.02, -1, 0];

/** 이 페이지가 떠 있는 동안 숨김을 기억한다. 다음에 앱을 켜면 다시 올라온다. */
let rememberedDucked = false;

const SVG_NS = 'http://www.w3.org/2000/svg';

/* 픽셀 아이콘. 한 칸은 그림과 같은 3px 이다. */
const ICONS: Record<UpdateSignIcon, readonly string[]> = {
  download: [
    '...#...',
    '...#...',
    '.#.#.#.',
    '..###..',
    '...#...',
    '.......',
    '#######',
  ],
  reload: [
    '..###.#',
    '.#...##',
    '#...###',
    '#......',
    '#.....#',
    '.#...#.',
    '..###..',
  ],
};

function pixelIcon(name: UpdateSignIcon): SVGSVGElement {
  const rows = ICONS[name];
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
  });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'uh-icon');
  svg.setAttribute('viewBox', `0 0 ${rows[0].length} ${rows.length}`);
  svg.setAttribute('width', String(rows[0].length * SCALE));
  svg.setAttribute('height', String(rows.length * SCALE));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.append(path);
  return svg;
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** 3px 칸에 맞춘다. */
function snap(px: number): number {
  return Math.round(px / SCALE) * SCALE;
}

export interface UpdateHippo {
  element: HTMLElement;
  dispose(): void;
}

export function createUpdateSignHippo(
  onAction: (id: UpdateSignAction['id']) => void,
  /** 잠깐 보인 팻말(transientMs)이 내려갈 때. */
  onDismiss: (key: string) => void = () => {},
): UpdateHippo & {
  setSign(sign: UpdateSign | null): void;
} {
  const element = document.createElement('div');
  element.className = 'uh';
  element.hidden = true;

  const rig = document.createElement('div');
  rig.className = 'uh-rig';

  const board = document.createElement('div');
  board.className = 'uh-board';
  board.setAttribute('role', 'group');
  board.setAttribute('aria-label', '업데이트');

  const sprite = document.createElement('span');
  sprite.className = 'uh-sprite';
  sprite.setAttribute('aria-hidden', 'true');
  // 그림 위에 겹친 투명한 단추. 숨으면 귀 자리의 단추로 바뀐다.
  const hippo = document.createElement('button');
  hippo.type = 'button';
  hippo.className = 'uh-hippo';
  hippo.setAttribute('aria-label', '하마 숨기기');
  rig.append(sprite, hippo, board);

  // 숨었을 때 귀 둘레를 누르는 자리. 귀 세 줄보다 넉넉하다.
  const ears = document.createElement('button');
  ears.type = 'button';
  ears.className = 'uh-ears';
  ears.setAttribute('aria-label', '하마 부르기');
  ears.hidden = true;

  const spoken = document.createElement('span');
  spoken.className = 'visually-hidden';
  spoken.setAttribute('aria-live', 'polite');
  element.append(rig, ears, spoken);

  let state: UpdateSign | null = null;
  let ducked = rememberedDucked;
  /** 지금 들고 있는 팻말. null 이면 하마는 가장자리 밑에 있다. */
  let shown: UpdateSign | null = null;
  /** 잠깐 보였다 내려간 팻말. 상태가 다른 팻말을 지나면 잊는다. */
  let dismissedKey: string | null = null;
  let y = 0;
  let moving = false;
  let disposed = false;
  let moveTimer = 0;
  let idleTimer = 0;
  let blinkTimer = 0;
  let transientTimer = 0;
  let transientArmed = false;

  function show(frame: Frame): void {
    sprite.style.backgroundPositionX = `${-FRAMES.indexOf(frame) * CELL_WIDTH * SCALE}px`;
    element.dataset.frame = frame;
  }

  function place(next: number): void {
    y = snap(next);
    rig.style.transform = y ? `translateY(${y}px)` : '';
  }

  /** 팻말까지 가장자리 밑으로 완전히 들어간 높이. 팻말은 그림 위로 솟아 있다. */
  function sunkY(): number {
    const above = board.hidden ? 0 : Math.max(0, -board.offsetTop);
    return Math.ceil((CELL_HEIGHT * SCALE + above + SCALE * 2) / SCALE) * SCALE;
  }

  /** 서 있는 높이. 숨었으면 귀만 남는다. */
  function restY(): number {
    return ducked ? (CELL_HEIGHT - STICK_ROWS - PEEK_ROWS) * SCALE : 0;
  }

  function move(to: number, curve: readonly number[], frame: Frame, done: () => void): void {
    window.clearTimeout(moveTimer);
    const from = y;
    if (reducedMotion() || from === to) {
      place(to);
      done();
      return;
    }
    moving = true;
    show(frame);
    let index = 0;
    const step = (): void => {
      if (disposed) return;
      const t = curve[index++];
      if (t === undefined) {
        moving = false;
        done();
        return;
      }
      // SINK 는 출발점에서 잰 진행, RISE 는 도착점까지 남은 몫이다(음수는 그만큼 칸을 넘친다).
      if (curve === RISE) place(t < 0 ? to + t * SCALE : to + (from - to) * t);
      else place(from + (to - from) * t);
      moveTimer = window.setTimeout(step, STEP_MS);
    };
    step();
  }

  function sink(done: () => void): void {
    move(sunkY(), SINK, 'dip', done);
  }

  function rise(done: () => void = () => {}): void {
    show(ducked ? 'peek' : 'dip');
    move(restY(), RISE, ducked ? 'peek' : 'dip', () => {
      show(ducked ? 'peek' : 'idle');
      done();
    });
  }

  /* ── 팻말 ── */

  function actionButton(action: UpdateSignAction): HTMLButtonElement {
    const node = document.createElement('button');
    node.type = 'button';
    node.dataset.action = action.id;
    if (action.icon) {
      node.className = 'uh-act uh-act-icon';
      node.setAttribute('aria-label', action.label);
      node.title = action.label;
      node.append(pixelIcon(action.icon));
    } else {
      node.className = 'uh-act uh-act-text';
      node.textContent = action.label;
    }
    node.addEventListener('click', () => run(action.id));
    return node;
  }

  function fillBoard(sign: UpdateSign): void {
    board.replaceChildren();
    board.dataset.tone = sign.tone;
    board.dataset.sign = sign.key.split(':')[0];
    board.classList.toggle('is-stacked', sign.actions.length > 1
      || sign.progress !== null && sign.lines.length > 0 || Boolean(sign.heading));
    if (sign.heading) {
      const heading = document.createElement('strong');
      heading.className = 'uh-heading';
      heading.setAttribute('aria-hidden', 'true');
      heading.textContent = sign.heading;
      board.append(heading);
    }
    if (sign.lines.length) {
      const text = document.createElement('p');
      text.className = 'uh-text';
      text.setAttribute('aria-hidden', 'true');
      for (const line of sign.lines) {
        const span = document.createElement('span');
        span.textContent = line;
        text.append(span);
      }
      board.append(text);
    }
    if (sign.footnote) {
      const footnote = document.createElement('span');
      footnote.className = 'uh-footnote';
      footnote.setAttribute('aria-hidden', 'true');
      footnote.textContent = sign.footnote;
      board.append(footnote);
    }
    if (sign.progress !== null) {
      const progress = document.createElement('div');
      progress.className = 'uh-progress';
      const bar = document.createElement('span');
      bar.className = 'uh-bar';
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', '다운로드');
      bar.setAttribute('aria-valuemin', '0');
      bar.setAttribute('aria-valuemax', '100');
      const fill = document.createElement('span');
      fill.className = 'uh-bar-fill';
      bar.append(fill);
      const percent = document.createElement('span');
      percent.className = 'uh-percent';
      percent.setAttribute('aria-hidden', 'true');
      progress.append(bar, percent);
      board.append(progress);
    }
    if (sign.actions.length) {
      const actions = document.createElement('div');
      actions.className = 'uh-actions';
      actions.append(...sign.actions.map(actionButton));
      board.append(actions);
    }
    updateBoard(sign);
  }

  /** 같은 팻말 안에서 바뀌는 것: 내려받은 비율, 경고의 채팅 수. */
  function updateBoard(sign: UpdateSign): void {
    board.title = sign.detail ?? '';
    const lines = board.querySelectorAll('.uh-text span');
    sign.lines.forEach((line, index) => {
      if (lines[index] && lines[index].textContent !== line) lines[index].textContent = line;
    });
    if (sign.progress !== null) {
      const bar = board.querySelector<HTMLElement>('.uh-bar');
      const fill = board.querySelector<HTMLElement>('.uh-bar-fill');
      const percent = board.querySelector<HTMLElement>('.uh-percent');
      bar?.setAttribute('aria-valuenow', String(sign.progress));
      // 채움도 3px 칸으로 끊어 자란다.
      if (fill) fill.style.width = `${Math.floor((BAR_WIDTH * sign.progress) / 100 / SCALE) * SCALE}px`;
      if (percent) percent.textContent = `${sign.progress}%`;
    }
    alignBoard();
  }

  /** 팻말 가운데를 막대에 맞추되, 창 오른쪽 끝을 넘으면 그만큼 왼쪽으로 민다. */
  function alignBoard(): void {
    const stickCenter = (STICK_X + 1) * SCALE;
    const room = CELL_WIDTH * SCALE - stickCenter + rightInset() - EDGE_GAP;
    const half = board.offsetWidth / 2;
    const shift = Math.ceil(Math.max(0, half - room) / SCALE) * SCALE;
    board.style.left = `${snap(stickCenter - half) - shift}px`;
  }

  function rightInset(): number {
    return Number.parseFloat(getComputedStyle(rig).right) || 0;
  }

  function speak(sign: UpdateSign): void {
    spoken.textContent = sign.spoken;
  }

  function hold(sign: UpdateSign): void {
    shown = sign;
    fillBoard(sign);
    speak(sign);
    window.clearTimeout(transientTimer);
    transientArmed = false;
    armTransient();
  }

  /**
   * 잠깐 보이는 팻말의 시간은 홈이 보일 때부터 잰다. 문서를 연 채 켜져 홈이 가려져 있으면
   * 홈이 보이게 될 때(rig 크기가 생길 때) 다시 부른다. 팻말에 마우스가 있으면 기다린다.
   */
  function armTransient(): void {
    const sign = shown;
    if (!sign?.transientMs || transientArmed || !rig.offsetWidth) return;
    transientArmed = true;
    const fire = (): void => {
      if (disposed || shown !== sign) return;
      if (board.matches(':hover')) {
        transientTimer = window.setTimeout(fire, 1000);
        return;
      }
      transientArmed = false;
      dismissedKey = sign.key;
      onDismiss(sign.key);
      sync();
    };
    transientTimer = window.setTimeout(fire, sign.transientMs);
  }

  function setDucked(next: boolean): void {
    ducked = next;
    rememberedDucked = next;
    element.dataset.ducked = String(next);
    board.hidden = next;
    hippo.hidden = next;
    ears.hidden = !next;
  }

  /** 상태와 지금 팻말을 맞춘다. 움직이는 중이면 끝난 뒤 다시 맞춘다. */
  function sync(): void {
    if (disposed || moving) return;
    let next = state;
    if (!next || next.key !== dismissedKey) dismissedKey = null;
    if (next && next.key === dismissedKey) next = null;

    if (!next && !shown) {
      element.hidden = true;
      return;
    }
    if (next && !shown) {
      element.hidden = false;
      setDucked(ducked);
      hold(next);
      place(sunkY());
      rise(sync);
      scheduleIdle();
      return;
    }
    if (!next && shown) {
      shown = null;
      window.clearTimeout(transientTimer);
      transientArmed = false;
      sink(() => {
        element.hidden = true;
        sync();
      });
      return;
    }
    if (next && shown && next.key === shown.key) {
      shown = next;
      updateBoard(next);
      return;
    }
    if (next && ducked) {
      hold(next);
      return;
    }
    sink(() => {
      hold(next!);
      // 새 팻말이 더 높으면 올라오기 전부터 보이지 않게 더 내려 둔다.
      place(Math.max(y, sunkY()));
      rise(sync);
    });
  }

  function run(id: UpdateSignAction['id']): void {
    onAction(id);
  }

  /* ── 숨기·부르기 ── */

  hippo.addEventListener('click', () => {
    if (moving || !shown) return;
    sink(() => {
      setDucked(true);
      show('peek');
      ears.focus({ preventScroll: true });
      rise(sync);
    });
  });

  ears.addEventListener('click', () => {
    if (moving) return;
    move(sunkY(), SINK, 'peek', () => {
      setDucked(false);
      if (shown) fillBoard(shown);
      place(sunkY());
      hippo.focus({ preventScroll: true });
      rise(sync);
    });
  });

  /* ── 가만히 있을 때: 가끔 눈을 깜빡이거나 귀를 턴다 ── */

  function scheduleIdle(): void {
    window.clearTimeout(idleTimer);
    if (reducedMotion() || disposed) return;
    idleTimer = window.setTimeout(() => {
      if (element.isConnected && !element.hidden && !moving && !ducked && element.offsetParent) {
        const frame: Frame = Math.random() < 0.7 ? 'blink' : 'ear';
        show(frame);
        blinkTimer = window.setTimeout(() => {
          if (!moving && !ducked) show('idle');
        }, frame === 'blink' ? 140 : 220);
      }
      scheduleIdle();
    }, 2600 + Math.random() * 2600);
  }

  show(ducked ? 'peek' : 'idle');
  setDucked(ducked);
  // 홈이 가려진 채 팻말을 들면 너비가 0 이라, 보이게 되어 너비가 생길 때 다시 맞춘다.
  const boardSize = new ResizeObserver(() => {
    alignBoard();
    armTransient();
  });
  boardSize.observe(board);
  boardSize.observe(rig);

  return {
    element,
    setSign(sign): void { state = sign; sync(); },
    dispose(): void {
      disposed = true;
      boardSize.disconnect();
      window.clearTimeout(moveTimer);
      window.clearTimeout(idleTimer);
      window.clearTimeout(blinkTimer);
      window.clearTimeout(transientTimer);
      element.remove();
    },
  };
}

export interface ReleaseNotesSource {
  version: string;
  items: readonly string[];
  /** 팻말이 홈에 보였다가 내려갔을 때. */
  onSeen(): void;
}

export function createUpdateHippo(api: DesktopUpdatesApi, notes: ReleaseNotesSource | null = null): UpdateHippo {
  let state: DesktopUpdateState | null = null;
  let notesSign = notes ? releaseNotesSign(notes.version, notes.items) : null;
  let confirming = false;
  let disposed = false;
  let allState: UpdateAllState | null = null;
  const unified = Boolean(api.getAllState && api.onAllState && api.updateAll);
  // 업데이트 팻말이 먼저고, 릴리스 노트는 그 팻말이 없을 때만 든다.
  const sync = () => hippo.setSign(isInitialSetupActive() ? null
    : (unified ? updateAllSign(allState) : updateSign(state, { confirming })) ?? notesSign);
  const hippo = createUpdateSignHippo((id) => {
    switch (id) {
      case 'update-all': void api.updateAll?.().catch(() => {}); break;
      case 'later': void api.later?.().catch(() => {}); break;
      case 'download': void api.download().catch(() => {}); break;
      case 'check': void api.check().catch(() => {}); break;
      case 'restart': confirming = true; sync(); break;
      case 'cancel': confirming = false; sync(); break;
      case 'confirm':
        confirming = false;
        void api.restart().catch(() => ({ ok: false })).finally(() => { if (!disposed) sync(); });
        break;
    }
  }, (key) => {
    if (key !== notesSign?.key) return;
    notesSign = null;
    notes?.onSeen();
    sync();
  });
  const unsubscribeInitial = onInitialSetupInactive(sync);
  const unsubscribeAll = unified ? api.onAllState!((next) => { allState = next; sync(); }) : () => {};
  if (unified) void api.getAllState!().then((initial) => {
    if (!disposed && !allState) { allState = initial; sync(); }
  }).catch(() => {});
  const unsubscribe = api.onState((next) => {
    if (next.status !== 'downloaded') confirming = false;
    state = next;
    sync();
  });
  void api.getState().then((initial) => {
    if (state || disposed) return;
    state = initial;
    sync();
  }).catch(() => {});
  return {
    element: hippo.element,
    dispose() { disposed = true; unsubscribeInitial(); unsubscribeAll(); unsubscribe(); hippo.dispose(); },
  };
}

interface UpdatesHost {
  rhwpDesktop?: { updates?: DesktopUpdatesApi };
  location?: { search: string };
  localStorage?: Storage;
}

function releaseNotesFor(version: string, host: UpdatesHost): ReleaseNotesSource | null {
  let storage: Storage | undefined;
  try {
    storage = host.localStorage;
  } catch {
    return null;
  }
  if (!storage) return null;
  const store = storage;
  const items = pendingReleaseNotes(version, store);
  return items ? { version, items, onSeen: () => markReleaseNotesSeen(version, store) } : null;
}

/**
 * 데스크톱 앱이면 하마를 slot 에 붙인다. Vite 개발 서버에서는 `?update-hippo=<상황>` 으로
 * 가짜 업데이트를 띄울 수 있다(dev-updates-mock.ts, 배포 번들에는 들어가지 않는다).
 * `?update-hippo=release-notes` 는 본 기록과 상관없이 가장 최근 릴리스 노트를 든다.
 */
export function mountUpdateHippo(slot: HTMLElement, host: UpdatesHost = window, version = __APP_VERSION__): void {
  const api = host.rhwpDesktop?.updates;
  if (api) {
    slot.append(createUpdateHippo(api, releaseNotesFor(version, host)).element);
    return;
  }
  if (import.meta.env.DEV) {
    const scenario = new URLSearchParams(host.location?.search ?? '').get('update-hippo');
    if (!scenario) return;
    void import('./dev-updates-mock.ts').then(({ createDevUpdatesApi }) => {
      const latest = Object.keys(RELEASE_NOTES).at(-1);
      const notes = scenario === 'release-notes' && latest ? {
        version: latest,
        items: RELEASE_NOTES[latest]!,
        onSeen: () => console.info('[update-hippo mock] 릴리스 노트를 봤어요'),
      } : null;
      slot.append(createUpdateHippo(createDevUpdatesApi(scenario), notes).element);
    });
  }
}

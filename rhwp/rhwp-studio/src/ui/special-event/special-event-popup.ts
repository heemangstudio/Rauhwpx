/**
 * 업데이트 뒤 한 번 뜨는 특별 이벤트 창. 하마와 Claude 의 Clawd 가 손을 잡고 서 있다.
 *
 * 그림은 scripts/generate-special-event-art.py 가 만든
 * hama-clawd-sprites.png 의 칸이다. 칸 순서(FRAMES)와 크기를
 * 바꾸면 여기도 같이 바꾼다. 둘은 한 칸에 같이 그려져 있어 어떤 자세에서도 손이 떨어지지
 * 않는다. 움직임은 스프라이트 픽셀(3px) 단위로만 끊고, 동작 줄이기 설정이면 움직이지 않는다.
 *
 * 크레딧을 받는 일은 넘겨받은 claim() 이 맡는다. GiftClaimError 로 거절하면 그 메시지를 보인다.
 * 내 키가 있는 사람에게는 쓰는 순서(먼저·내 키 다음에)도 고르게 한다(order).
 * 언제 띄울지(이벤트마다 한 번)는 special-event-trigger.ts 가 정한다.
 */
import '../agent-sidebar/sheet.css';
import './special-event-popup.css';
import {
  formatGiftAmount,
  formatGiftBalance,
  GIFT_ORDER_OPTIONS,
  GiftClaimError,
  giftMeter,
  type GiftOrder,
} from './gift.ts';

export const SPECIAL_EVENT_FRAMES = ['idle', 'hippo-blink', 'clawd-blink', 'crouch', 'cheer'] as const;
type Frame = (typeof SPECIAL_EVENT_FRAMES)[number];

const CELL_WIDTH = 39;
const SCALE = 3;
const ORDER_SAVE_FAILED = '순서를 저장하지 못했습니다. Pi 설정에서 다시 골라 주세요.';

export interface SpecialEventClaim {
  /** 받은 뒤 남은 크레딧(달러). */
  balanceUsd: number;
}

export interface SpecialEventOptions {
  /**
   * 크레딧을 받는다. 실패하면 거부(reject)하고, 창은 다시 시도할 수 있게 남는다.
   * GiftClaimError 면 그 메시지를, 다른 오류면 기본 문구를 보인다.
   */
  claim(): Promise<SpecialEventClaim>;
  /** 주는 크레딧(달러). 서버가 키마다 정한다. 문구와 남은 양 막대의 기준이다. */
  amountUsd: number;
  /** 이미 받았으면 남은 양. 받기 없이 남은 양과 순서만 보인다(order 와 함께 쓴다). */
  claimedBalanceUsd?: number;
  /**
   * 내 OpenRouter 키가 있으면 쓰는 순서를 고르게 한다. 받기 전에는 받을 때 저장하고,
   * 받은 뒤에는 고를 때마다 저장한다. 저장에 실패하면 거부한다.
   */
  order?: { initial: GiftOrder; choose(order: GiftOrder): Promise<void> };
}

export type SpecialEventResult = 'claimed' | 'dismissed';

/* ── 픽셀 제목 ─────────────────────────────────────────
   5×7 비트맵 글꼴을 SVG 사각형으로 그린다. 한 칸은 그림과 같은 3px 이다. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  S: ['.###.', '#...#', '#....', '.###.', '....#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  V: ['#...#', '#...#', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  ' ': ['..', '..', '..', '..', '..', '..', '..'],
};
const GLYPH_ROWS = 7;
const SVG_NS = 'http://www.w3.org/2000/svg';

function pixelTitle(text: string): SVGSVGElement {
  let x = 0;
  let face = '';
  for (const ch of text) {
    const glyph = GLYPHS[ch];
    if (!glyph) throw new Error(`pixel glyph missing: ${ch}`);
    glyph.forEach((row, y) => {
      for (let c = 0; c < row.length; c += 1) if (row[c] === '#') face += `M${x + c} ${y}h1v1h-1z`;
    });
    x += glyph[0].length + 1;
  }
  const width = x - 1;
  // 그림자는 한 칸 아래. 글자 면이 그 위를 덮어 아래로 두께가 생긴다.
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'se-title-art');
  svg.setAttribute('viewBox', `0 0 ${width} ${GLYPH_ROWS + 1}`);
  svg.setAttribute('width', String(width * SCALE));
  svg.setAttribute('height', String((GLYPH_ROWS + 1) * SCALE));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  for (const [cls, dy] of [['se-title-shadow', 1], ['se-title-face', 0]] as const) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', cls);
    path.setAttribute('d', face);
    if (dy) path.setAttribute('transform', `translate(0 ${dy})`);
    svg.append(path);
  }
  return svg;
}

/* ── 손잡은 둘 ───────────────────────────────────────── */

interface Step {
  ms: number;
  frame: Frame;
  /** 위로 뜬 높이(스프라이트 픽셀). */
  lift?: number;
}

/** 둘이 같이 한 번 폴짝. 손은 같은 칸 안에 있어 같이 뜬다. */
function hop(air: Frame = 'idle'): Step[] {
  return [
    { ms: 90, frame: 'crouch' },
    { ms: 60, frame: air, lift: 2 },
    { ms: 80, frame: air, lift: 3 },
    { ms: 60, frame: air, lift: 2 },
    { ms: 80, frame: 'crouch' },
  ];
}

function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

interface Pair {
  element: HTMLElement;
  celebrate(): void;
  dispose(): void;
}

function createPair(): Pair {
  const element = document.createElement('div');
  element.className = 'se-stage';
  element.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i += 1) {
    const spark = document.createElement('span');
    spark.className = 'se-spark';
    element.append(spark);
  }
  const sprite = document.createElement('span');
  sprite.className = 'se-sprite';
  const ground = document.createElement('span');
  ground.className = 'se-ground';
  element.append(ground, sprite);

  let rest: Frame = 'idle';
  let timer = 0;
  let idleTimer = 0;

  function show(frame: Frame, lift = 0): void {
    sprite.style.backgroundPositionX = `${-SPECIAL_EVENT_FRAMES.indexOf(frame) * CELL_WIDTH * SCALE}px`;
    sprite.style.transform = lift ? `translateY(${-lift * SCALE}px)` : '';
    element.dataset.frame = frame;
  }

  function play(steps: readonly Step[], done?: () => void): void {
    window.clearTimeout(timer);
    let index = 0;
    const next = (): void => {
      const step = steps[index++];
      if (!step) {
        show(rest);
        done?.();
        return;
      }
      show(step.frame, step.lift);
      timer = window.setTimeout(next, step.ms);
    };
    next();
  }

  /** 가끔 한쪽이 눈을 깜빡이고, 드물게 둘이 같이 뛴다. */
  function scheduleIdle(): void {
    window.clearTimeout(idleTimer);
    if (reducedMotion()) return;
    idleTimer = window.setTimeout(() => {
      if (!element.isConnected) return;
      const roll = Math.random();
      if (rest === 'cheer') {
        play(hop('cheer'));
      } else if (roll < 0.7) {
        play([{ ms: 140, frame: roll < 0.4 ? 'hippo-blink' : 'clawd-blink' }]);
      } else {
        play(hop());
      }
      scheduleIdle();
    }, 2200 + Math.random() * 2600);
  }

  show(rest);
  scheduleIdle();

  return {
    element,
    celebrate(): void {
      rest = 'cheer';
      element.dataset.cheer = 'true';
      if (reducedMotion()) {
        show(rest);
        return;
      }
      play([...hop('cheer'), ...hop('cheer')]);
      scheduleIdle();
    },
    dispose(): void {
      window.clearTimeout(timer);
      window.clearTimeout(idleTimer);
    },
  };
}

/* ── 창 ──────────────────────────────────────────────── */

function button(label: string, kind: 'confirm' | 'cancel'): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = `ag-sheet-btn ag-sheet-${kind}`;
  node.textContent = label;
  return node;
}

let openCount = 0;

/**
 * 특별 이벤트 창을 띄운다. 받았으면 'claimed', 나중에·Esc·바깥 클릭이면 'dismissed' 로 끝난다.
 * 받는 중에는 닫히지 않는다.
 */
/** 쓰는 순서 두 칸. 고른 칸은 aria-checked 이고 화살표로 옮긴다. */
function orderChoice(initial: GiftOrder, onPick: (order: GiftOrder) => void): {
  element: HTMLElement;
  value(): GiftOrder;
  set(order: GiftOrder): void;
  setDisabled(disabled: boolean): void;
} {
  const group = document.createElement('div');
  group.className = 'se-order';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', '사용 순서');
  let current = initial;
  const buttons = GIFT_ORDER_OPTIONS.map((option) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'se-order-option';
    node.setAttribute('role', 'radio');
    node.textContent = option.label;
    node.addEventListener('click', () => pick(option.value));
    group.append(node);
    return { value: option.value, node };
  });
  function render(): void {
    for (const { value, node } of buttons) {
      const active = value === current;
      node.setAttribute('aria-checked', String(active));
      node.tabIndex = active ? 0 : -1;
    }
  }
  function pick(order: GiftOrder): void {
    if (order === current) return;
    current = order;
    render();
    onPick(order);
  }
  group.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = buttons.findIndex(({ value }) => value === current);
    const next = buttons[(index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
    pick(next.value);
    next.node.focus();
  });
  render();
  return {
    element: group,
    value: () => current,
    set(order) {
      current = order;
      render();
    },
    setDisabled(disabled) {
      for (const { node } of buttons) node.disabled = disabled;
    },
  };
}

/** 받은 뒤 한 줄 문구. 내 키 다음에 쓰면 그렇게 알린다. */
function claimedCopy(order: GiftOrder | null): string {
  return order === 'after' ? '내 키 크레딧이 떨어지면 이어서 씁니다.' : 'Pi에서 바로 쓸 수 있습니다.';
}

export function openSpecialEventPopup(options: SpecialEventOptions): Promise<SpecialEventResult> {
  const amount = options.amountUsd;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  openCount += 1;
  const id = `se-popup-${openCount}`;

  const layer = document.createElement('div');
  layer.className = 'se-layer';
  const backdrop = document.createElement('div');
  backdrop.className = 'se-backdrop';
  const card = document.createElement('section');
  card.className = 'se-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  card.setAttribute('aria-labelledby', `${id}-title`);
  card.setAttribute('aria-describedby', `${id}-copy`);
  card.tabIndex = -1;

  const pair = createPair();

  const title = document.createElement('h2');
  title.className = 'se-title';
  title.id = `${id}-title`;
  const titleText = document.createElement('span');
  titleText.className = 'visually-hidden';
  titleText.textContent = 'Special event';
  title.append(pixelTitle('SPECIAL EVENT'), titleText);

  const copy = document.createElement('p');
  copy.className = 'se-copy';
  copy.id = `${id}-copy`;
  copy.textContent = `업데이트 기념으로 Claude 크레딧 ${formatGiftAmount(amount)}를 드립니다.`;

  const meta = document.createElement('p');
  meta.className = 'se-meta';
  meta.textContent = 'Pi에서 사용 · 크레딧 소진 시 종료';

  const error = document.createElement('p');
  error.className = 'se-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  const later = button('나중에', 'cancel');
  const claim = button('받기', 'confirm');
  const actions = document.createElement('div');
  actions.className = 'se-actions';
  actions.append(later, claim);

  // 순서는 받기 전에는 고르기만 하고 받을 때 저장한다. 받은 뒤에는 고를 때마다 저장한다.
  let saved: GiftOrder | null = options.order?.initial ?? null;
  let afterClaim = false;
  const order = options.order
    ? orderChoice(options.order.initial, (next) => {
      if (afterClaim) void saveOrder(next);
    })
    : null;

  async function saveOrder(next: GiftOrder): Promise<void> {
    if (!options.order || next === saved) {
      copy.textContent = claimedCopy(next);
      return;
    }
    error.hidden = true;
    try {
      await options.order.choose(next);
      saved = next;
      copy.textContent = claimedCopy(next);
    } catch {
      order?.set(saved ?? 'first');
      error.textContent = ORDER_SAVE_FAILED;
      error.hidden = false;
    }
  }

  card.append(pair.element, title, copy, meta, ...(order ? [order.element] : []), error, actions);
  layer.append(backdrop, card);
  document.body.append(layer);

  let state: 'offer' | 'claiming' | 'claimed' | 'closed' = 'offer';
  return new Promise<SpecialEventResult>((resolve) => {

    const close = (result: SpecialEventResult): void => {
      if (state === 'closed' || state === 'claiming') return;
      state = 'closed';
      pair.dispose();
      document.removeEventListener('keydown', onKey, true);
      layer.classList.remove('se-open');
      layer.classList.add('se-closing');
      const remove = (): void => layer.remove();
      if (reducedMotion()) remove();
      else window.setTimeout(remove, 220);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(result);
    };

    const showClaimed = (balance: number): HTMLButtonElement => {
      state = 'claimed';
      card.dataset.state = 'claimed';
      const wallet = document.createElement('div');
      wallet.className = 'se-wallet';
      const row = document.createElement('div');
      row.className = 'se-wallet-row';
      const label = document.createElement('span');
      label.textContent = 'Claude 크레딧';
      const value = document.createElement('span');
      value.className = 'se-wallet-value';
      value.textContent = `${formatGiftBalance(balance)} 남음`;
      row.append(label, value);
      const { ratio, max } = giftMeter(amount, balance);
      const meter = document.createElement('div');
      meter.className = 'se-meter';
      meter.setAttribute('role', 'meter');
      meter.setAttribute('aria-label', 'Claude 크레딧 남은 양');
      meter.setAttribute('aria-valuemin', '0');
      meter.setAttribute('aria-valuemax', String(max));
      meter.setAttribute('aria-valuenow', String(Math.max(0, balance)));
      meter.setAttribute('aria-valuetext', `${formatGiftBalance(balance)} 남음`);
      const fill = document.createElement('span');
      fill.className = 'se-meter-fill';
      fill.style.setProperty('--se-fill', String(ratio));
      meter.append(fill);
      wallet.append(row, meter);

      const done = button('확인', 'confirm');
      done.addEventListener('click', () => close('claimed'));
      actions.replaceChildren(done);
      actions.dataset.single = 'true';
      copy.textContent = claimedCopy(order?.value() ?? null);
      meta.replaceWith(wallet);
      order?.setDisabled(false);
      afterClaim = true;
      return done;
    };

    const celebrate = (balance: number): void => {
      const done = showClaimed(balance);
      pair.celebrate();
      done.focus({ preventScroll: true });
      // 받기 전에 고른 순서를 이제 저장한다.
      const picked = order?.value();
      if (picked) void saveOrder(picked);
    };

    claim.addEventListener('click', () => {
      if (state !== 'offer') return;
      state = 'claiming';
      claim.disabled = true;
      later.disabled = true;
      claim.textContent = '받는 중…';
      error.hidden = true;
      order?.setDisabled(true);
      options.claim().then(
        (result) => celebrate(result.balanceUsd),
        (reason: unknown) => {
          state = 'offer';
          claim.disabled = false;
          later.disabled = false;
          order?.setDisabled(false);
          claim.textContent = '다시 받기';
          error.textContent = reason instanceof GiftClaimError && reason.message
            ? reason.message
            : '받지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
          error.hidden = false;
        },
      );
    });
    later.addEventListener('click', () => close('dismissed'));
    backdrop.addEventListener('click', () => close(state === 'claimed' ? 'claimed' : 'dismissed'));

    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(state === 'claimed' ? 'claimed' : 'dismissed');
        return;
      }
      if (event.key !== 'Tab') return;
      // 창 안에서만 돈다.
      const stops = [...card.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
      if (!stops.length) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      const inside = active !== card && card.contains(active);
      if (event.shiftKey && (active === first || !inside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !inside)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);

    // 이미 받았으면 받기 없이 남은 양과 순서만 보인다.
    if (options.claimedBalanceUsd !== undefined) showClaimed(options.claimedBalanceUsd);

    // 앱을 켜자마자 뜨는 창이라 버튼 대신 창에 초점을 둔다. 첫 화면에 초점 테두리가 없고 Tab 이면 버튼으로 간다.
    requestAnimationFrame(() => {
      layer.classList.add('se-open');
      card.focus({ preventScroll: true });
    });
  });
}

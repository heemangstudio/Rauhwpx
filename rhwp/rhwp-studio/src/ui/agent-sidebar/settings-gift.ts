// 설정 → Pi 카드 맨 위의 선물 크레딧 한 줄. macOS·Windows 데스크톱에서 이벤트가 진행 중일 때만 보인다.
// 받기 전: 'Claude 크레딧 $20' + 받기. 받은 뒤: 남은 양과 막대. 다 쓰면 한 줄 안내.
// 내 OpenRouter 키가 있으면 받은 뒤 쓰는 순서(먼저 사용 · 내 키 다음에)를 고른다.
import {
  formatGiftAmount,
  formatGiftBalance,
  GIFT_ORDER_OPTIONS,
  giftLineState,
  giftMeter,
  type DesktopGiftApi,
  type DesktopGiftStatus,
  type GiftOrder,
} from '../special-event/gift.ts';

const CLAIM_FAILED = '받지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
const ORDER_FAILED = '순서를 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export interface PiGiftLine {
  root: HTMLElement;
  /** 데스크톱에 상태를 다시 묻는다(데스크톱이 잠깐 캐시한다). */
  refresh(): void;
  /** 허브의 Pi 상태. 내 키가 있을 때만 순서 고르기가 보인다. */
  setPiStatus(status: { keyConfigured: boolean; giftOrder?: GiftOrder } | null): void;
  dispose(): void;
}

export function createPiGiftLine(
  api: DesktopGiftApi,
  /** 순서를 허브에 저장한다. 실패하면 거부한다. 없으면 순서 고르기를 숨긴다. */
  setOrder?: (order: GiftOrder) => Promise<void>,
): PiGiftLine {
  const root = el('div', 'ag-settings-meter ag-pi-gift');
  root.hidden = true;
  const head = el('div', 'ag-settings-meter-head');
  const label = el('span', 'ag-settings-meter-label');
  const value = el('span', 'ag-settings-meter-value');
  const claim = el('button', 'ag-settings-btn ag-pi-gift-claim', '받기');
  claim.type = 'button';
  head.append(label, value, claim);
  const track = el('div', 'ag-settings-meter-track');
  track.setAttribute('role', 'meter');
  track.setAttribute('aria-label', 'Claude 크레딧 남은 양');
  track.setAttribute('aria-valuemin', '0');
  const fill = el('div', 'ag-settings-meter-fill');
  track.append(fill);
  const orderGroup = el('div', 'ag-settings-segmented ag-pi-gift-order');
  orderGroup.setAttribute('role', 'radiogroup');
  orderGroup.setAttribute('aria-label', 'Claude 크레딧 사용 순서');
  const orderButtons = GIFT_ORDER_OPTIONS.map((option) => {
    const node = el('button', 'ag-settings-segment', option.label);
    node.type = 'button';
    node.setAttribute('role', 'radio');
    node.addEventListener('click', () => pickOrder(option.value));
    orderGroup.append(node);
    return { value: option.value, node };
  });
  orderGroup.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const index = orderButtons.findIndex(({ value }) => value === order);
    const next = orderButtons[(index + (event.key === 'ArrowRight' ? 1 : -1) + orderButtons.length) % orderButtons.length];
    pickOrder(next.value);
    next.node.focus();
  });
  const error = el('p', 'ag-settings-cliproxy-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(head, track, orderGroup, error);

  let disposed = false;
  let claiming = false;
  let ownKey = false;
  let order: GiftOrder = 'first';
  let savingOrder = false;

  function render(status: DesktopGiftStatus | null): void {
    if (disposed) return;
    const line = giftLineState(status);
    root.hidden = line === null;
    root.dataset.state = line?.kind ?? 'hidden';
    claim.hidden = line?.kind !== 'offer';
    claim.disabled = claiming;
    claim.textContent = claiming ? '받는 중…' : '받기';
    track.hidden = line?.kind !== 'balance';
    value.hidden = line?.kind !== 'balance';
    orderGroup.hidden = line?.kind !== 'balance' || !ownKey || !setOrder;
    for (const { value: option, node } of orderButtons) {
      const active = option === order;
      node.classList.toggle('ag-active', active);
      node.setAttribute('aria-checked', String(active));
      node.tabIndex = active ? 0 : -1;
      node.disabled = savingOrder;
    }
    if (line?.kind !== 'offer' && line?.kind !== 'balance') error.hidden = true;
    if (!line) return;
    if (line.kind === 'offer') {
      label.textContent = `Claude 크레딧 ${formatGiftAmount(line.amountUsd)}`;
      return;
    }
    if (line.kind === 'exhausted') {
      label.textContent = 'Claude 크레딧을 모두 사용했습니다';
      return;
    }
    const left = `${formatGiftBalance(line.remainingUsd)} 남음`;
    label.textContent = 'Claude 크레딧';
    value.textContent = left;
    // 서버가 한도를 늘려 남은 양이 처음 금액보다 많아도 막대는 가득 찰 뿐 넘치지 않는다.
    const { ratio, max } = giftMeter(line.amountUsd, line.remainingUsd);
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    track.setAttribute('aria-valuemax', String(max));
    track.setAttribute('aria-valuenow', String(line.remainingUsd));
    track.setAttribute('aria-valuetext', left);
  }

  let current: DesktopGiftStatus | null = null;
  const show = (status: DesktopGiftStatus): void => {
    current = status;
    render(current);
  };

  function pickOrder(next: GiftOrder): void {
    if (!setOrder || savingOrder || next === order) return;
    const previous = order;
    order = next;
    savingOrder = true;
    error.hidden = true;
    render(current);
    void setOrder(next).then(
      () => {
        savingOrder = false;
        render(current);
      },
      () => {
        savingOrder = false;
        order = previous;
        render(current);
        error.textContent = ORDER_FAILED;
        error.hidden = root.hidden;
      },
    );
  }

  claim.addEventListener('click', () => {
    if (claiming) return;
    claiming = true;
    error.hidden = true;
    render(current);
    void api.claim().then(
      (result) => {
        claiming = false;
        if (result.status) current = result.status;
        render(current);
        if (!result.ok) {
          error.textContent = result.message || CLAIM_FAILED;
          error.hidden = root.hidden;
        }
      },
      () => {
        claiming = false;
        render(current);
        error.textContent = CLAIM_FAILED;
        error.hidden = root.hidden;
      },
    );
  });

  const unsubscribe = api.onChange(show);
  const refresh = (): void => {
    void api.getStatus().then(show, () => { /* 마지막 상태를 그대로 둔다 */ });
  };
  refresh();

  return {
    root,
    refresh,
    setPiStatus(status): void {
      ownKey = status?.keyConfigured === true;
      // 저장 중에는 고른 값을 지킨다. 허브의 답이 오면 그 값으로 맞춘다.
      if (!savingOrder) order = status?.giftOrder ?? 'first';
      render(current);
    },
    dispose(): void {
      disposed = true;
      unsubscribe();
    },
  };
}

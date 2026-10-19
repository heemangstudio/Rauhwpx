// 설정 → Pi 카드 맨 위의 선물 크레딧 한 줄. macOS·Windows 데스크톱에서 이벤트가 진행 중일 때만 보인다.
// 받기 전: 'Claude 크레딧 $20' + 받기. 받은 뒤: 남은 양과 막대. 다 쓰면 한 줄 안내.
import {
  formatGiftAmount,
  formatGiftBalance,
  giftLineState,
  type DesktopGiftApi,
  type DesktopGiftStatus,
} from '../special-event/gift.ts';

const CLAIM_FAILED = '받지 못했습니다. 잠시 뒤 다시 시도해 주세요.';

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
  dispose(): void;
}

export function createPiGiftLine(api: DesktopGiftApi): PiGiftLine {
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
  const error = el('p', 'ag-settings-cliproxy-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(head, track, error);

  let disposed = false;
  let claiming = false;

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
    if (line?.kind !== 'offer') error.hidden = true;
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
    const ratio = line.amountUsd > 0 ? Math.max(0, Math.min(1, line.remainingUsd / line.amountUsd)) : 0;
    fill.style.width = `${(ratio * 100).toFixed(1)}%`;
    track.setAttribute('aria-valuemax', String(line.amountUsd));
    track.setAttribute('aria-valuenow', String(line.remainingUsd));
    track.setAttribute('aria-valuetext', left);
  }

  let current: DesktopGiftStatus | null = null;
  const show = (status: DesktopGiftStatus): void => {
    current = status;
    render(current);
  };

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
    dispose(): void {
      disposed = true;
      unsubscribe();
    },
  };
}

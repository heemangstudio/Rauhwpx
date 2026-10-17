import './trial-ended-banner.css';

/**
 * 체험이 끝났거나 라이선스가 잠긴 동안 막힌 동작을 눌렀을 때 뜨는 모달. 화면을 어둡게 덮고 가운데에 정사각형에 가까운 카드를 띄운다.
 * 카드 오른쪽 위 모서리에는 경고 팻말을 문 하마가 선다.
 *
 * 하마는 scripts/generate-boot-logo.py 의 CLOSED 자세(같은 팔레트)에 팻말을 더한 픽셀 그림이다.
 * 4배로 키워 그리고, 움직임은 4px 단위로만 끊는다.
 */

const SIGN_HIPPO = [
  '.......................a......',
  '......................aya.....',
  '......................aya.....',
  '.....................ayyya....',
  '.....................ayaya....',
  '....................ayyayya...',
  '....................ayyayya...',
  '...................ayyyayyya..',
  '...................ayyyyyyya..',
  '..................ayyyyayyyya.',
  '.................aaaaaaaaaaaaa',
  '.........h....hh.......b......',
  '........hsh..hkoh......b......',
  '.........hhhhoooohhhhh.b......',
  '........hoooooooooooooobh.....',
  '........ooooooooooooooobos....',
  '.....hhhooooooooooooooobos....',
  '..hhhooooooooookkkkkkkkbss....',
  'hhoooooooooooooossssssss......',
  'oooooooooooooo................',
  'oooooooooooooo................',
  'soooooooooooos................',
  '.ooooooooooos.................',
  '.ooossooooosd.................',
  '.oooddssooodd.................',
  '.sssdd..sssdd.................',
];

/* token-ok: 하마 팔레트는 부트 로고와 같은 고정 색이다. */
const PALETTE: Record<string, string> = {
  o: '#62b3e2',
  s: '#2f73a0',
  h: '#b2e2fb',
  d: '#1d4766',
  k: '#0c2536',
  y: '#f6c445',
  a: '#6b4508',
  b: '#9a6a3a',
};

const SCALE = 4;
const SVG_NS = 'http://www.w3.org/2000/svg';

function signHippoSvg(): SVGSVGElement {
  const width = SIGN_HIPPO[0].length;
  const height = SIGN_HIPPO.length;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width * SCALE));
  svg.setAttribute('height', String(height * SCALE));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  // 같은 색이 이어지는 가로 칸은 사각형 하나로 그린다.
  SIGN_HIPPO.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end += 1;
      const fill = PALETTE[ch];
      if (fill) {
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', String(x));
        rect.setAttribute('y', String(y));
        rect.setAttribute('width', String(end - x));
        rect.setAttribute('height', '1');
        rect.setAttribute('fill', fill);
        svg.append(rect);
      }
      x = end;
    }
  });
  return svg;
}

export interface TrialEndedBannerOptions {
  title?: string;
  detail?: string;
  onActivate: () => void;
  onPurchase: () => void;
  /**
   * 있으면 닫을 수 없는 카드가 된다(Esc·나중에 없음). 맨 아래 단추는 이 화면을 떠나는 동작이고,
   * 카드는 부른 쪽이 dismiss 로 내린다.
   */
  leave?: { label: string; onClick: () => void };
}

export interface TrialEndedBanner {
  dismiss(): void;
}

function button(className: string, label: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

export function showTrialEndedBanner(options: TrialEndedBannerOptions): TrialEndedBanner {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const overlay = document.createElement('div');
  overlay.className = 'trial-ended-overlay';
  const locked = Boolean(options.leave);
  overlay.classList.toggle('trial-ended-overlay-locked', locked);

  const dialog = document.createElement('div');
  dialog.className = 'trial-ended';
  dialog.setAttribute('role', 'alertdialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'trial-ended-title');
  dialog.setAttribute('aria-describedby', 'trial-ended-detail');

  const hippo = document.createElement('span');
  hippo.className = 'trial-ended-hippo';
  hippo.append(signHippoSvg());

  const title = document.createElement('h2');
  title.id = 'trial-ended-title';
  title.className = 'trial-ended-title';
  title.textContent = options.title ?? '체험이 끝났어요';
  const detail = document.createElement('p');
  detail.id = 'trial-ended-detail';
  detail.className = 'trial-ended-detail';
  detail.textContent = options.detail ?? '라이선스를 활성화하면 쓰던 문서를 바로 이어서 편집할 수 있어요.';

  const actions = document.createElement('div');
  actions.className = 'trial-ended-actions';
  const activate = button('trial-ended-primary', '라이선스 키 입력하기');
  const purchase = button('trial-ended-secondary', '라이선스 구매하기');
  actions.append(activate, purchase);

  const later = button('trial-ended-later', options.leave?.label ?? '나중에');

  dialog.append(hippo, title, detail, actions, later);
  overlay.append(dialog);

  let open = true;
  function dismiss(): void {
    if (!open) return;
    open = false;
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  // 모달이라 Tab 은 세 버튼 안에서만 돈다.
  const focusables = [activate, purchase, later];
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !locked) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    if (event.key !== 'Tab') return;
    const index = focusables.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + (event.shiftKey ? -1 : 1) + focusables.length) % focusables.length;
    event.preventDefault();
    focusables[index < 0 ? 0 : next].focus();
  }

  // 잠긴 카드는 활성화 창을 연 뒤에도 남는다. 활성화되면 부른 쪽이 내린다.
  activate.addEventListener('click', () => {
    options.onActivate();
    if (!locked) dismiss();
  });
  purchase.addEventListener('click', () => { options.onPurchase(); });
  later.addEventListener('click', () => {
    if (options.leave) options.leave.onClick();
    else dismiss();
  });
  overlay.addEventListener('keydown', onKeydown);

  document.body.append(overlay);
  activate.focus({ preventScroll: true });
  return { dismiss };
}

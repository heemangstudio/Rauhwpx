/**
 * 처음 설정의 마지막 장: 라이선스 구매와 키 넣기.
 *
 * 데스크톱(macOS·Windows)에서 아직 키를 넣지 않았을 때만 뜬다. 키는 이 장에서 바로 활성화한다
 * (메인의 license:activate). 구매 단추는 구매 페이지를 열고, 돌아와 키를 붙여 넣으면 곧바로 확인한다.
 * 설명은 하마가 하고, 화면에는 구매 칸과 키 칸만 둔다.
 */
import type { DesktopLicenseApi, LicenseStatus } from '../agent-sidebar/settings-license.ts';
import { licenseTermText, trialTimeLeft } from '../agent-sidebar/settings-license.ts';
import { createIcon } from '../agent-sidebar/icons.ts';

/** 키를 넣지 않은 새 사용자만. 이미 키가 있거나 라이선스를 보지 않는 빌드면 장을 넣지 않는다. */
export function needsLicenseStep(status: LicenseStatus | null): boolean {
  return status?.state === 'trial' || status?.state === 'trial_expired' || status?.state === 'needs_activation';
}

/** 하마가 이 장에서 하는 말. */
export function licenseLine(status: LicenseStatus | null, now = Date.now()): string {
  if (status?.state === 'trial' && status.trial.endsAt > now) {
    return `체험이 ${trialTimeLeft(status.trial.endsAt, now)} 남았어요. 키를 넣으면 계속 쓸 수 있어요.`;
  }
  return '라이선스 키를 넣으면 바로 편집할 수 있어요.';
}

/** HAMA- 로 시작하고 다섯 묶음이 다 찼는지. 붙여 넣은 키를 바로 확인할지 정한다. */
export function looksLikeFullKey(raw: string): boolean {
  return /^HAMA(-?[0-9A-Z]{5}){5}$/.test(raw.trim().toUpperCase().replace(/\s+/g, ''));
}

/* ── 픽셀 열쇠 ─────────────────────────────────────────
   한 칸은 하마와 같은 3px. 그림자는 한 칸 아래에 깔아 아래로 두께가 생긴다. */
const KEY_ROWS = [
  '.####..............',
  '##..##.............',
  '#....##############',
  '#....##############',
  '##..##.......##.##.',
  '.####........##.##.',
];
const KEY_GLINT = [[1, 1], [2, 0]] as const;
const SCALE = 3;
const SVG_NS = 'http://www.w3.org/2000/svg';

function pixelPath(rows: readonly string[]): string {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
  });
  return d;
}

function pixelKey(): SVGSVGElement {
  const width = KEY_ROWS[0]!.length;
  const height = KEY_ROWS.length + 1;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'rhwp-setup-key-art');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', String(width * SCALE));
  svg.setAttribute('height', String(height * SCALE));
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');
  const face = pixelPath(KEY_ROWS);
  for (const [cls, d, dy] of [
    ['rhwp-setup-key-shadow', face, 1],
    ['rhwp-setup-key-face', face, 0],
    ['rhwp-setup-key-glint', KEY_GLINT.map(([x, y]) => `M${x} ${y}h1v1h-1z`).join(''), 0],
  ] as const) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('class', cls);
    path.setAttribute('d', d);
    if (dy) path.setAttribute('transform', `translate(0 ${dy})`);
    svg.append(path);
  }
  return svg;
}

export interface LicenseStepUi {
  element: HTMLElement;
  /** 활성화했는지. 다음 단추의 글과 마지막 장면을 정한다. */
  licensed(): boolean;
  focusTarget(): HTMLElement;
  dispose(): void;
}

export interface LicenseStepDeps {
  api: DesktopLicenseApi;
  status: LicenseStatus | null;
  say(line: string): void;
  cheer(line: string): void;
  /** 이 장에서 활성화했을 때 한 번. */
  onLicensed(status: LicenseStatus): void;
  onStateChange(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createLicenseStep(deps: LicenseStepDeps): LicenseStepUi {
  const { api } = deps;
  let licensed = deps.status?.state === 'licensed';
  let busy = false;

  const panel = el('div', 'rhwp-setup-panel rhwp-setup-license');
  panel.dataset.step = 'license';

  // 구매 칸. 활성화하면 같은 칸이 정품 표시로 바뀐다.
  const buy = el('button', 'rhwp-setup-license-buy');
  buy.type = 'button';
  const art = el('span', 'rhwp-setup-key');
  art.append(pixelKey());
  const copy = el('span', 'rhwp-setup-license-copy');
  const title = el('span', 'rhwp-setup-license-title', '라이선스 구매');
  const detail = el('span', 'rhwp-setup-license-detail', '연 ₩9,900');
  copy.append(title, detail);
  const go = el('span', 'rhwp-setup-license-go');
  go.append(createIcon('external'));
  const check = el('span', 'rhwp-setup-check');
  check.append(createIcon('check'));
  buy.append(art, copy, go, check);
  buy.addEventListener('click', () => {
    if (licensed) return;
    void api.openPricing();
  });

  const form = el('form', 'rhwp-setup-license-form');
  form.noValidate = true;
  const input = el('input', 'rhwp-setup-license-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('autocapitalize', 'characters');
  input.placeholder = '라이선스 키 붙여넣기';
  input.setAttribute('aria-label', '라이선스 키');
  const redeem = el('button', 'rhwp-setup-license-redeem', '활성화');
  redeem.type = 'submit';
  form.append(input, redeem);
  panel.append(buy, form);

  function render(): void {
    panel.dataset.state = licensed ? 'licensed' : busy ? 'checking' : 'idle';
    buy.disabled = licensed;
    buy.setAttribute('aria-label', licensed ? '정품 라이선스 활성화됨' : '라이선스 구매, 연 9,900원');
    title.textContent = licensed ? '정품 라이선스' : '라이선스 구매';
    form.hidden = licensed;
    input.disabled = busy;
    redeem.disabled = busy || !input.value.trim();
    redeem.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function markLicensed(status: LicenseStatus): void {
    if (licensed) return;
    licensed = true;
    // 연간 키는 다음 갱신일, 평생 키는 가린 키를 보인다.
    detail.textContent = licenseTermText(status.license) || status.license?.maskedKey || '';
    buy.title = status.license?.maskedKey ?? '';
    render();
    deps.cheer('라이선스가 활성화됐어요!');
    deps.onLicensed(status);
    deps.onStateChange();
  }

  async function submit(): Promise<void> {
    const key = input.value.trim();
    if (!key || busy || licensed) return;
    busy = true;
    render();
    deps.say('키를 확인하는 중이에요…');
    try {
      const result = await api.activate(key);
      busy = false;
      if (result.ok) {
        input.value = '';
        markLicensed(result.status);
        return;
      }
      render();
      deps.say(result.message ?? '키를 확인하지 못했어요. 다시 넣어 주세요.');
      input.focus();
      input.select();
    } catch {
      busy = false;
      render();
      deps.say('라이선스 서버에 연결하지 못했어요. 잠시 뒤 다시 해 주세요.');
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener('input', render);
  // 구매 페이지에서 복사한 키를 붙여 넣으면 누르지 않아도 바로 확인한다.
  input.addEventListener('paste', () => {
    window.setTimeout(() => {
      if (looksLikeFullKey(input.value)) void submit();
    }, 0);
  });

  // 활성화 창 등 다른 곳에서 활성화해도 이 장이 따라간다.
  const unsubscribe = api.onChange((status) => {
    if (status.state === 'licensed') markLicensed(status);
  });

  render();
  return {
    element: panel,
    licensed: () => licensed,
    focusTarget: () => (licensed ? buy : input),
    dispose: unsubscribe,
  };
}

// 계정 화면의 그림: 둥근 사진(또는 머리글자, 사람 모양), 로그인 공급자 표, 기기 종류.
import './account-glyphs.css';
import { accountInitial } from './account-format.ts';
import type { AccountProvider, AccountStatus } from './account-types.ts';

const NS = 'http://www.w3.org/2000/svg';

function svg(viewBox: string, className: string): SVGSVGElement {
  const node = document.createElementNS(NS, 'svg');
  node.setAttribute('class', className);
  node.setAttribute('viewBox', viewBox);
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');
  return node;
}

function path(d: string, attrs: Record<string, string> = {}): SVGPathElement {
  const node = document.createElementNS(NS, 'path');
  node.setAttribute('d', d);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** 로그아웃 상태의 사람 모양. 원 안에 들어간다. */
function personGlyph(): SVGSVGElement {
  const node = svg('0 0 24 24', 'acct-avatar-person');
  node.append(path('M12 12.6a3.9 3.9 0 1 0 0-7.8 3.9 3.9 0 0 0 0 7.8zM5 20.2c1-3.4 3.7-5.2 7-5.2s6 1.8 7 5.2', STROKE));
  return node;
}

export interface AvatarView {
  element: HTMLElement;
  /** 사진, 없으면 머리글자, 로그아웃이면 사람 모양. */
  paint(status: AccountStatus | null, url: string | null): void;
}

/** 크기는 CSS(className)가 정한다. 사진은 원, 머리글자는 중성 면 위. */
export function createAvatar(className: string): AvatarView {
  const element = document.createElement('span');
  element.className = `acct-avatar ${className}`;
  element.setAttribute('aria-hidden', 'true');
  let shown = '';
  return {
    element,
    paint(status, url) {
      const account = status?.state === 'signed_in' ? status.account : null;
      const initial = account ? accountInitial(account.name, account.email) : '';
      const key = account ? (url ? `img:${url.length}:${url.slice(-24)}` : `txt:${initial}`) : 'person';
      if (key === shown) return;
      shown = key;
      element.dataset.kind = account ? (url ? 'image' : 'initial') : 'person';
      if (account && url) {
        const img = document.createElement('img');
        img.alt = '';
        img.decoding = 'async';
        img.src = url;
        element.replaceChildren(img);
      } else if (account) {
        const letter = document.createElement('span');
        letter.className = 'acct-avatar-initial';
        letter.textContent = initial;
        element.replaceChildren(letter);
      } else {
        element.replaceChildren(personGlyph());
      }
    },
  };
}

/** 공급자 표. Google 은 제 색, 나머지는 글자색을 따른다. */
export function providerGlyph(provider: AccountProvider): SVGSVGElement {
  if (provider === 'google') {
    const node = svg('0 0 18 18', 'acct-provider-glyph');
    node.append(
      path('M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z', { fill: '#4285F4' }),
      path('M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z', { fill: '#34A853' }),
      path('M3.96 10.71A5.41 5.41 0 0 1 3.68 9c0-.59.1-1.17.28-1.71V4.96H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.04l3-2.33z', { fill: '#FBBC05' }),
      path('M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59A8.65 8.65 0 0 0 9 0 9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z', { fill: '#EA4335' }),
    );
    return node;
  }
  const node = svg('0 0 16 16', 'acct-provider-glyph');
  node.append(path('M2.5 4h11v8h-11zM2.8 4.4 8 8.6l5.2-4.2', STROKE));
  return node;
}

export const PROVIDER_LABEL: Record<AccountProvider, string> = { email: '이메일', google: 'Google' };

/** 기기 종류. Mac 은 노트북, 나머지는 화면. */
export function platformGlyph(platform: string): SVGSVGElement {
  const node = svg('0 0 16 16', 'acct-platform-glyph');
  node.append(path(platform === 'darwin' ? 'M3.5 4h9v6.5h-9zM1.8 12.5h12.4' : 'M2.5 3.2h11v7.6h-11zM6 13.6h4M8 10.8v2.8', STROKE));
  return node;
}

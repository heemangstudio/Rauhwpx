import './site-mark.css';

/** 허브에 사이트 아이콘을 묻는 함수. 사람용 브라우저 요청만 쓴다. */
export type SiteMarkRequest = (action: string, args?: Record<string, unknown>) => Promise<unknown>;

/* Studio CSP 는 data:/blob: 이미지만 연다. 바깥 아이콘 서비스는 쓰지 않는다. */
const MAX_ICON_CHARS = 24_000;
const MISS_TTL_MS = 10 * 60_000;
const BATCH_LIMIT = 50;

const icons = new Map<string, string>();
const misses = new Map<string, number>();
const waiting = new Map<string, Set<(icon: string | null) => void>>();
let queued: { origins: Set<string>; request: SiteMarkRequest } | null = null;
let unsupportedUntil = 0;

function iconUri(value: unknown): string | null {
  return typeof value === 'string' && value.length <= MAX_ICON_CHARS && /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i.test(value)
    ? value : null;
}

/** https/http 사이트의 origin. 그 밖의 주소(about:, 파일)는 null. */
export function siteOrigin(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch { return null; }
}

export function siteHost(value: string | undefined | null): string {
  if (!value) return '';
  try { return new URL(value).hostname; } catch { return value; }
}

function initial(origin: string | null, fallback: string): string {
  const host = siteHost(origin ?? '').replace(/^www\./, '');
  return (host || fallback).slice(0, 1).toLocaleUpperCase();
}

/** 탭이 실어 온 아이콘을 캐시에 둔다 — 같은 사이트의 다른 표시도 다시 묻지 않는다. */
export function rememberSiteIcon(origin: string | null, faviconUrl: string | undefined): void {
  const icon = iconUri(faviconUrl);
  if (!origin || !icon) return;
  icons.set(origin, icon);
  misses.delete(origin);
  settleWaiters(origin, icon);
}

function settleWaiters(origin: string, icon: string | null): void {
  const callbacks = waiting.get(origin);
  if (!callbacks) return;
  waiting.delete(origin);
  for (const callback of callbacks) callback(icon);
}

function flush(): void {
  const batch = queued;
  queued = null;
  if (!batch) return;
  const origins = [...batch.origins].slice(0, BATCH_LIMIT);
  const rest = [...batch.origins].slice(BATCH_LIMIT);
  if (rest.length) {
    queued = { origins: new Set(rest), request: batch.request };
    queueMicrotask(flush);
  }
  void batch.request('favicons.get', { origins }).then((result) => {
    const map = (result && typeof result === 'object' ? (result as { icons?: unknown }).icons : null);
    const found = map && typeof map === 'object' && !Array.isArray(map) ? map as Record<string, unknown> : {};
    for (const origin of origins) {
      const icon = iconUri(found[origin]);
      if (icon) icons.set(origin, icon); else misses.set(origin, Date.now());
      settleWaiters(origin, icon);
    }
  }).catch((error: unknown) => {
    // 끊긴 연결은 다음 표시에서 다시 묻는다. 옛 허브(동작 없음)는 한동안 묻지 않고 첫 글자로 둔다.
    const disconnected = (error as { code?: unknown } | null)?.code === 'BROWSER_DISCONNECTED';
    if (!disconnected) unsupportedUntil = Date.now() + MISS_TTL_MS;
    for (const origin of origins) { if (!disconnected) misses.set(origin, Date.now()); settleWaiters(origin, null); }
  });
}

function lookup(origin: string, request: SiteMarkRequest | undefined, done: (icon: string) => void): void {
  const cached = icons.get(origin);
  if (cached) { done(cached); return; }
  const missed = misses.get(origin);
  if (!request || Date.now() < unsupportedUntil || (missed !== undefined && Date.now() - missed < MISS_TTL_MS)) return;
  let callbacks = waiting.get(origin);
  if (!callbacks) {
    callbacks = new Set();
    waiting.set(origin, callbacks);
    queued ??= { origins: new Set(), request };
    queued.origins.add(origin);
    if (queued.origins.size === 1) queueMicrotask(flush);
  }
  callbacks.add((icon) => { if (icon) done(icon); });
}

/**
 * 사이트 로고 — 탭의 아이콘, 허브가 아는 아이콘, 그도 없으면 첫 글자.
 * 아이콘이 늦게 오면 같은 요소 안에서 글자를 바꿔 끼운다.
 */
export function createSiteMark(options: {
  origin: string | null | undefined;
  faviconUrl?: string;
  request?: SiteMarkRequest;
  /** origin 이 없을 때 보일 글자. */
  fallback?: string;
  className?: string;
}): HTMLElement {
  const origin = siteOrigin(options.origin);
  rememberSiteIcon(origin, options.faviconUrl);
  const root = document.createElement('span');
  root.className = options.className ? `ag-site-mark ${options.className}` : 'ag-site-mark';
  root.setAttribute('aria-hidden', 'true');
  root.textContent = initial(origin, options.fallback ?? '?');
  const show = (icon: string) => {
    if (root.dataset.icon === 'true') return;
    const image = document.createElement('img');
    image.alt = '';
    image.decoding = 'async';
    image.draggable = false;
    image.src = icon;
    image.addEventListener('error', () => { image.remove(); root.dataset.icon = 'false'; root.textContent = initial(origin, options.fallback ?? '?'); }, { once: true });
    root.replaceChildren(image);
    root.dataset.icon = 'true';
  };
  const direct = iconUri(options.faviconUrl);
  if (direct) show(direct);
  else if (origin) lookup(origin, options.request, show);
  return root;
}


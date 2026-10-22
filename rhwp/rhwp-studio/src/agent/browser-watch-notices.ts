/**
 * 페이지 감시 알림 — 허브가 맡은 페이지의 글이 바뀌거나 감시를 멈추면 그 채팅 기록에 한 줄로 남긴다.
 * 허브 알림(owned_browser_watch_notice)을 기록 메시지로 바꾸고, 저장본을 다시 읽고, 프로바이더 기록 글을 만든다.
 */

export interface BrowserWatchNotice {
  noticeId: string;
  watchId: string;
  url: string;
  title: string;
  change: 'changed' | 'paused';
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
  /** 멈춘 까닭(허브 오류 코드). */
  reason?: string;
  /** epoch ms */
  at: number;
}

/** 허브가 보내는 감시 요약 — browser_watch list 와 같은 모양. */
export interface BrowserWatchSummary {
  watchId: string;
  url: string;
  title: string;
  find?: string;
  intervalMinutes: number;
  status: 'active' | 'paused';
  lastCheckedAt: number | null;
  lastChangedAt: number | null;
}

const MAX_LINES = 5;
const MAX_LINE_CHARS = 200;
const MAX_TITLE_CHARS = 300;
const MAX_URL_CHARS = 2_000;

function lines(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((line): line is string => typeof line === 'string').slice(0, MAX_LINES).map((line) => line.slice(0, MAX_LINE_CHARS))
    : [];
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

/** 허브 알림이나 저장된 알림을 믿을 수 있는 모양으로. 깨졌으면 null. */
export function normalizeWatchNotice(raw: unknown): BrowserWatchNotice | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const url = httpUrl(value.url);
  const change = value.change ?? value.kind;
  if (typeof value.noticeId !== 'string' || !value.noticeId || value.noticeId.length > 160
    || typeof value.watchId !== 'string' || !value.watchId || value.watchId.length > 160
    || !url || (change !== 'changed' && change !== 'paused')) return null;
  const added = lines(value.added);
  const removed = lines(value.removed);
  return {
    noticeId: value.noticeId,
    watchId: value.watchId,
    url,
    title: typeof value.title === 'string' ? value.title.slice(0, MAX_TITLE_CHARS) : '',
    change,
    added,
    removed,
    addedCount: count(value.addedCount, added.length),
    removedCount: count(value.removedCount, removed.length),
    ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason.slice(0, 80) } : {}),
    at: typeof value.at === 'number' && Number.isFinite(value.at) && value.at >= 0 ? value.at : 0,
  };
}

/** 이 기능을 모르는 옛 빌드가 보일 한 줄. */
export function watchNoticeFallbackText(notice: BrowserWatchNotice): string {
  const page = notice.title || siteLabel(notice.url);
  return notice.change === 'paused' ? `${page} 확인을 멈췄습니다` : `${page} 페이지가 바뀌었습니다`;
}

/** 프로바이더 기록에 싣는 글. 페이지 글은 믿지 않는 웹 내용으로 감싼다. */
export function watchNoticeHistoryText(notice: BrowserWatchNotice): string {
  const page = `${notice.title ? `"${notice.title.slice(0, 120)}" ` : ''}${notice.url}`;
  const body = notice.change === 'paused'
    ? [`Page watch ${notice.watchId} on ${page} paused (${notice.reason ?? 'denied'}); the user must allow the site, then create the watch again.`]
    : [
      `Page watch ${notice.watchId}: ${page} changed (+${notice.addedCount} / -${notice.removedCount} lines).`,
      ...notice.added.map((line) => `+ ${line}`),
      ...notice.removed.map((line) => `- ${line}`),
    ];
  return ['<page_watch_notice trust="untrusted-web">', ...body, '</page_watch_notice>'].join('\n');
}

export function siteLabel(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** 감시 간격 문구 — 15분마다, 1시간마다, 2일마다. */
export function watchIntervalLabel(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}일마다`;
  if (minutes % 60 === 0) return `${minutes / 60}시간마다`;
  return `${minutes}분마다`;
}

export function normalizeWatchSummaries(raw: unknown): BrowserWatchSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): BrowserWatchSummary[] => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const url = httpUrl(value.url);
    if (typeof value.watchId !== 'string' || !url || typeof value.intervalMinutes !== 'number') return [];
    const time = (input: unknown) => (typeof input === 'number' && Number.isFinite(input) ? input : null);
    return [{
      watchId: value.watchId,
      url,
      title: typeof value.title === 'string' ? value.title.slice(0, MAX_TITLE_CHARS) : '',
      ...(typeof value.find === 'string' && value.find ? { find: value.find } : {}),
      intervalMinutes: value.intervalMinutes,
      status: value.status === 'paused' ? 'paused' : 'active',
      lastCheckedAt: time(value.lastCheckedAt),
      lastChangedAt: time(value.lastChangedAt),
    }];
  });
}

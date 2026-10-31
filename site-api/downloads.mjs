import { createHash, timingSafeEqual } from 'node:crypto';

import { createMemoryStore } from './store.mjs';

/**
 * Download counter for the website's download buttons. It stores counts only, by KST day, platform
 * and version: no IP, no user agent, no identifier. Rate limiting happens in memory in server.mjs.
 */
export const DOWNLOAD_PLATFORMS = Object.freeze(['mac-arm64', 'mac-x64', 'win-x64', 'win-arm64', 'linux-x64']);
// `latest` is what the website links (GitHub's latest release); a release page may send its own version.
const VERSION_RE = /^(?:latest|\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,20})?)$/;
const MAX_VERSION_CHARS = 32;
/** Distinct platform|version pairs kept per day; more are counted under `<platform>|other`. */
export const MAX_KEYS_PER_DAY = 64;
export const DOWNLOAD_RETENTION_DAYS = 400;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function downloadsError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function emptyDownloadsState() {
  return { days: {} };
}

export function kstDay(ms) {
  return new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** `{platform, version}` from the request body, or a `_INVALID` error (400). */
export function parseDownload(body) {
  const platform = typeof body?.platform === 'string' ? body.platform.trim() : '';
  if (!DOWNLOAD_PLATFORMS.includes(platform)) throw downloadsError('DOWNLOAD_PLATFORM_INVALID', 'platform is not one of the published builds');
  const version = typeof body?.version === 'string' ? body.version.trim() : '';
  if (!version || version.length > MAX_VERSION_CHARS || !VERSION_RE.test(version)) {
    throw downloadsError('DOWNLOAD_VERSION_INVALID', 'version must be `latest` or x.y.z');
  }
  return { platform, version };
}

function tokenMatches(given, expected) {
  if (!expected || !given) return false;
  const left = createHash('sha256').update(String(given)).digest();
  const right = createHash('sha256').update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

export function createDownloadsService({
  store = createMemoryStore(emptyDownloadsState()),
  now = Date.now,
  adminToken = '',
} = {}) {
  /** A state without a `days` map counts as empty, and anything else in it goes (in place). */
  function normalize(state) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return emptyDownloadsState();
    if (typeof state.days === 'object' && !Array.isArray(state.days)) return state;
    for (const key of Object.keys(state)) delete state[key];
    return Object.assign(state, emptyDownloadsState());
  }

  return {
    async record(body) {
      const { platform, version } = parseDownload(body);
      await store.update((stored) => {
        const state = normalize(stored);
        const today = kstDay(now());
        const oldest = kstDay(now() - DOWNLOAD_RETENTION_DAYS * DAY_MS);
        for (const day of Object.keys(state.days)) if (day < oldest) delete state.days[day];
        const counts = state.days[today] ?? {};
        state.days[today] = counts;
        let key = `${platform}|${version}`;
        if (!Object.hasOwn(counts, key) && Object.keys(counts).length >= MAX_KEYS_PER_DAY) key = `${platform}|other`;
        counts[key] = (counts[key] ?? 0) + 1;
      });
      return { ok: true };
    },
    /** Counts for the last `days` KST days (default 30, at most the retention), newest day first. */
    async summary(token, { days } = {}) {
      if (!tokenMatches(token, adminToken)) throw downloadsError('DOWNLOADS_FORBIDDEN', 'admin token required');
      const span = Math.min(Math.max(Number.parseInt(days, 10) || 30, 1), DOWNLOAD_RETENTION_DAYS);
      const since = kstDay(now() - (span - 1) * DAY_MS);
      const state = normalize(await store.read());
      const byPlatform = {};
      const byVersion = {};
      const byDay = [];
      let total = 0;
      for (const day of Object.keys(state.days).filter((d) => d >= since).sort().reverse()) {
        let dayTotal = 0;
        for (const [key, count] of Object.entries(state.days[day])) {
          const [platform, version] = key.split('|');
          byPlatform[platform] = (byPlatform[platform] ?? 0) + count;
          byVersion[version] = (byVersion[version] ?? 0) + count;
          dayTotal += count;
        }
        total += dayTotal;
        byDay.push({ day, total: dayTotal, counts: { ...state.days[day] } });
      }
      return { ok: true, since, days: span, total, byPlatform, byVersion, byDay };
    },
  };
}

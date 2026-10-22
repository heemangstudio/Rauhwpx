// 사용자가 내장 브라우저에서 직접 연 페이지의 방문 기록. 에이전트가 사용자가 자주 가는 사이트를 다시 찾는 데 쓴다.
// 주소는 인용 주소 규칙(계정 정보·조각·추적 매개변수·서명 값 제거)으로 다듬어 저장하므로 원래 주소의 비밀은 디스크에도 남지 않는다.
import crypto from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { citationURL } from './owned-browser-reading.mjs';

export const HISTORY_LIMIT = 500;
export const HISTORY_LIST_LIMIT = 30;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const TITLE_MAX = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
// 로그인·인증 과정의 페이지는 다시 찾을 곳이 아니다.
const AUTH_PATH = /(?:^|\/)(?:log-?in|log-?on|log-?out|sign-?in|sign-?on|sign-?out|oauth2?|authorize|sso|auth)(?:[/._-]|$)/i;

/** 기록에 남길 주소. 웹 주소가 아니거나 인증 과정이면 null. */
export function historyURL(value) {
  const url = citationURL(value);
  if (!url) return null;
  return AUTH_PATH.test(new URL(url).pathname) ? null : url;
}

const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);
const keyOf = (profileId, url) => `${profileId}\n${url}`;
const valid = (entry) => entry && typeof entry.profileId === 'string' && typeof entry.url === 'string' && historyURL(entry.url) === entry.url
  && Number.isSafeInteger(entry.visits) && entry.visits > 0 && Number.isFinite(entry.lastVisitedAt);

export function createBrowserHistory({ file, limit = HISTORY_LIMIT, now = Date.now } = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('Browser history file must be absolute');
  let entries = null;
  let queue = Promise.resolve();
  let epoch = 0;
  const run = (task) => { const next = queue.catch(() => {}).then(task); queue = next; return next; };

  const load = async () => {
    if (entries) return entries;
    entries = new Map();
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) return entries;
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      for (const entry of Array.isArray(stored?.entries) ? stored.entries : []) {
        if (!valid(entry)) continue;
        entries.set(keyOf(entry.profileId, entry.url), { profileId: entry.profileId, url: entry.url, title: squash(entry.title), visits: entry.visits, lastVisitedAt: entry.lastVisitedAt });
      }
    } catch {}
    return entries;
  };
  const write = async () => {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.part`;
    await fs.writeFile(temp, JSON.stringify({ version: 1, entries: [...entries.values()] }), { mode: 0o600, flag: 'wx' });
    try { await fs.rename(temp, file); } catch (failure) { await fs.rm(temp, { force: true }); throw failure; }
  };

  return {
    /** 방문 하나를 기록한다. 같은 주소는 횟수와 마지막 방문 시각만 갱신한다. */
    record({ url, title, profileId } = {}) {
      const clean = historyURL(url);
      if (!clean || typeof profileId !== 'string') return Promise.resolve(false);
      const started = epoch;
      return run(async () => {
        if (started !== epoch) return false;
        const map = await load();
        const key = keyOf(profileId, clean);
        const previous = map.get(key);
        map.delete(key);
        map.set(key, { profileId, url: clean, title: squash(title) || previous?.title || '', visits: (previous?.visits ?? 0) + 1, lastVisitedAt: now() });
        // 삽입 순서가 최근 방문 순서다. 넘치면 가장 오래 안 간 주소부터 버린다.
        while (map.size > limit) map.delete(map.keys().next().value);
        await write();
        return true;
      });
    },
    /** 주소 하나를 기록에서 뺀다. */
    forget({ url, profileId } = {}) {
      const clean = historyURL(url);
      if (!clean) return Promise.resolve(false);
      return run(async () => {
        const map = await load();
        if (!map.delete(keyOf(profileId, clean))) return false;
        await write();
        return true;
      });
    },
    /** 이 프로필의 자주·최근 방문 주소. query 는 제목·주소에서 찾는다. */
    async list({ profileId, query = '', limit: max = HISTORY_LIST_LIMIT } = {}) {
      await queue.catch(() => {});
      const map = await load();
      const needle = String(query ?? '').trim().toLowerCase();
      const at = now();
      // 최근에 자주 간 곳이 앞에 온다. 방문 횟수에 30일 반감기를 곱한다.
      const score = (entry) => entry.visits * 0.5 ** (Math.max(0, at - entry.lastVisitedAt) / (30 * DAY_MS));
      return [...map.values()]
        .filter((entry) => entry.profileId === profileId && (!needle || entry.url.toLowerCase().includes(needle) || entry.title.toLowerCase().includes(needle)))
        .sort((a, b) => score(b) - score(a) || b.lastVisitedAt - a.lastVisitedAt)
        .slice(0, Math.max(1, Math.min(HISTORY_LIMIT, max)))
        .map((entry) => ({ title: entry.title, url: entry.url, visits: entry.visits, lastVisitedAt: entry.lastVisitedAt }));
    },
    /** 브라우저 데이터 지우기. 진행 중인 기록은 버리고 파일을 지운다. */
    clear() {
      epoch++;
      return run(async () => { entries = new Map(); await fs.rm(file, { force: true }); });
    },
    flush: () => queue.catch(() => {}),
  };
}

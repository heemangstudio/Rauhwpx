// 페이지 감시 — 채팅이 맡긴 웹 페이지를 주기마다 다시 읽고, 읽을 수 있는 글이 바뀌면 그 채팅에 알린다.
// 다시 읽기는 맡긴 채팅의 에이전트(감시 전용 agentId)로 하므로, 정책은 그 채팅의 사이트 접근으로 판단한다.
// 감시와 아직 전하지 못한 알림은 <dataDir>/browser/watches.json 에 남아 허브를 다시 시작해도 이어진다.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const WATCH_LIMITS = Object.freeze({
  perChat: 5,
  total: 30,
  minIntervalMinutes: 15,
  maxIntervalMinutes: 7 * 24 * 60,
  defaultIntervalMinutes: 60,
  lifetimeMs: 30 * 24 * 60 * 60_000,
  textChars: 20_000,
  findChars: 200,
  urlChars: 2_000,
  diffLines: 5,
  diffLineChars: 160,
  pendingNotices: 100,
  noticeTtlMs: 14 * 24 * 60 * 60_000,
  maxBackoffMs: 24 * 60 * 60_000,
});

/** 사용자가 풀어야 하는 거절 — 다시 읽어도 소용없으니 감시를 멈추고 한 번 알린다. */
const PAUSE_CODES = new Set([
  'BROWSER_SITE_BLOCKED', 'BROWSER_PERMISSION_REQUIRED', 'BROWSER_WEBSITE_CHANGE_REQUIRED',
  'BROWSER_HUMAN_REQUIRED', 'BROWSER_CHALLENGE_REQUIRED', 'BROWSER_NETWORK_BLOCKED', 'BROWSER_URL_BLOCKED',
]);
const FILE_VERSION = 1;
const MAX_TIMER_MS = 2 ** 31 - 1;

function failure(code, message) { return Object.assign(new Error(message), { code }); }
const text = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
const clip = (line) => line.length > WATCH_LIMITS.diffLineChars ? `${line.slice(0, WATCH_LIMITS.diffLineChars - 1)}…` : line;

/** 비교할 글: 줄마다 공백을 접고 빈 줄과 보이지 않는 글자를 뺀다. */
export function normalizeWatchText(value) {
  return String(value ?? '')
    .replace(/[​-‍⁠﻿]/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** 줄 단위 차이. 순서만 바뀐 줄은 세지 않는다. */
export function diffWatchText(before, after) {
  const count = (lines) => {
    const map = new Map();
    for (const line of lines) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = before ? before.split('\n') : [];
  const newLines = after ? after.split('\n') : [];
  const oldCounts = count(oldLines);
  const newCounts = count(newLines);
  const pick = (lines, mine, theirs) => {
    const seen = new Map();
    const out = [];
    for (const line of lines) {
      const used = (seen.get(line) ?? 0) + 1;
      seen.set(line, used);
      if (used > (theirs.get(line) ?? 0) && used <= mine.get(line)) out.push(line);
    }
    return out;
  };
  const added = pick(newLines, newCounts, oldCounts);
  const removed = pick(oldLines, oldCounts, newCounts);
  return {
    added: added.slice(0, WATCH_LIMITS.diffLines).map(clip),
    removed: removed.slice(0, WATCH_LIMITS.diffLines).map(clip),
    addedCount: added.length,
    removedCount: removed.length,
  };
}

/** 에이전트에게 싣는 알림 한 덩이(영문). 페이지 글은 믿지 않는 웹 내용으로 다룬다. */
export function watchNoticeText(notice) {
  const page = `${notice.title ? `"${String(notice.title).slice(0, 120)}" ` : ''}${notice.url}`;
  if (notice.kind === 'paused') return `Page watch ${notice.watchId} on ${page} paused (${notice.reason}); the user must allow the site, then create the watch again.`;
  return [
    `Page watch ${notice.watchId}: ${page} changed (+${notice.addedCount ?? 0} / -${notice.removedCount ?? 0} lines).`,
    ...(notice.added ?? []).map((line) => `+ ${line}`),
    ...(notice.removed ?? []).map((line) => `- ${line}`),
  ].join('\n');
}

/** 감시할 주소. http(s) 만, 자격 증명과 조각(#)은 뺀다. */
export function watchUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw failure('INVALID_ARGS', 'Pass an http or https URL to watch'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw failure('INVALID_ARGS', 'Only http and https pages can be watched');
  url.username = '';
  url.password = '';
  url.hash = '';
  if (url.href.length > WATCH_LIMITS.urlChars) throw failure('INVALID_ARGS', 'The URL is too long to watch');
  return url.href;
}

function pageText(page) {
  if (typeof page?.text === 'string') return page.text;
  if (Array.isArray(page?.matches)) return page.matches.map((match) => (typeof match === 'string' ? match : match?.text ?? '')).join('\n');
  return '';
}

/**
 * @param {{
 *   dataDir: string,
 *   ownedBrowser: { request: (actor: object, action: string, args: object) => Promise<any> },
 *   onNotice?: (notice: object) => void,
 *   onChange?: (threadId: string) => void,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   setTimer?: typeof setTimeout,
 *   clearTimer?: typeof clearTimeout,
 *   random?: () => number,
 *   minuteMs?: number,
 * }} options minuteMs 는 시험용으로 "1분" 을 줄인다. 에이전트가 고르는 최소 간격(분)은 그대로다.
 */
export function createBrowserWatchService({
  dataDir, ownedBrowser, onNotice = () => {}, onChange = () => {}, log = () => {},
  now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, random = Math.random,
  minuteMs = 60_000,
}) {
  const filePath = path.join(dataDir, 'browser', 'watches.json');
  /** @type {Map<string, any>} */
  const watches = new Map();
  /** @type {any[]} */
  let notices = [];
  const timers = new Map();
  const checking = new Map();
  let checkQueue = Promise.resolve();
  let writeQueue = Promise.resolve();
  let closed = false;

  const intervalMs = (watch) => watch.intervalMinutes * minuteMs;
  const actorFor = (watch) => Object.freeze({
    sessionId: null,
    threadId: watch.threadId,
    documentId: watch.documentId,
    projectId: watch.projectId,
    // 채팅의 에이전트 탭 한도를 쓰지 않도록 감시는 따로 센다.
    agentId: `${watch.threadId}:watch`,
    taskId: null,
    clientId: 'browser-watch',
    activeBrowserTabId: null,
    isHuman: false,
  });
  const summary = (watch) => ({
    watchId: watch.watchId,
    url: watch.url,
    title: watch.title,
    ...(watch.find ? { find: watch.find } : {}),
    intervalMinutes: watch.intervalMinutes,
    status: watch.status,
    ...(watch.pausedReason ? { pausedReason: watch.pausedReason } : {}),
    createdAt: watch.createdAt,
    lastCheckedAt: watch.lastCheckedAt,
    lastChangedAt: watch.lastChangedAt,
    nextCheckAt: watch.status === 'active' ? watch.nextCheckAt : null,
    expiresAt: watch.expiresAt,
  });

  const persist = () => {
    const snapshot = JSON.stringify({ version: FILE_VERSION, watches: [...watches.values()], notices });
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.part`;
      await fs.writeFile(temp, snapshot, { mode: 0o600, flag: 'wx' });
      await fs.rename(temp, filePath);
    }).catch((error) => log(`browser watch save failed: ${error?.code ?? error?.message ?? error}`));
    return writeQueue;
  };

  const unschedule = (watchId) => {
    const timer = timers.get(watchId);
    if (timer) clearTimer(timer);
    timers.delete(watchId);
  };
  const schedule = (watch) => {
    unschedule(watch.watchId);
    if (closed || watch.status !== 'active') return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, Math.min(watch.nextCheckAt, watch.expiresAt) - now()));
    const timer = setTimer(() => {
      timers.delete(watch.watchId);
      void runCheck(watch.watchId);
    }, delay);
    timer?.unref?.();
    timers.set(watch.watchId, timer);
  };
  const nextAfterSuccess = (watch) => now() + Math.round(intervalMs(watch) * (1 + random() * 0.1));
  const nextAfterFailure = (watch) => {
    const backoff = intervalMs(watch) * 2 ** Math.min(watch.failures, 6);
    const ceiling = Math.max(intervalMs(watch), WATCH_LIMITS.maxBackoffMs);
    return now() + Math.round(Math.min(backoff, ceiling) * (1 + random() * 0.1));
  };

  const pruneNotices = () => {
    const cutoff = now() - WATCH_LIMITS.noticeTtlMs;
    notices = notices.filter((notice) => notice.at >= cutoff).slice(-WATCH_LIMITS.pendingNotices);
  };
  const emitNotice = (watch, fields) => {
    const notice = {
      noticeId: `watch-notice-${crypto.randomUUID()}`,
      watchId: watch.watchId,
      threadId: watch.threadId,
      documentId: watch.documentId,
      projectId: watch.projectId,
      url: watch.url,
      title: watch.title,
      ...(watch.find ? { find: watch.find } : {}),
      at: now(),
      ...fields,
    };
    notices.push(notice);
    pruneNotices();
    try { onNotice(structuredClone(notice)); } catch (error) { log(`browser watch notice failed: ${error?.message ?? error}`); }
  };
  const changed = (threadId) => {
    try { onChange(threadId); } catch (error) { log(`browser watch change hook failed: ${error?.message ?? error}`); }
  };

  /** 한 페이지를 읽어 정규화한 글과 제목을 돌려준다. 거절은 code 를 단 오류로 던진다. */
  const readPage = async (watch) => {
    const result = await ownedBrowser.request(actorFor(watch), 'read-many', {
      urls: [watch.url], ...(watch.find ? { find: watch.find } : {}), maxChars: WATCH_LIMITS.textChars,
    });
    const page = result?.pages?.[0];
    if (!page) throw failure('BROWSER_WATCH_READ_FAILED', 'The page could not be read');
    if (page.ok === false || page.error) {
      throw Object.assign(failure(page.error?.code ?? 'BROWSER_WATCH_READ_FAILED', page.error?.message ?? 'The page could not be read'), page.error ?? {});
    }
    const normalized = normalizeWatchText(pageText(page));
    return {
      title: text(page.title, 300),
      normalized,
      hash: crypto.createHash('sha256').update(normalized).digest('hex'),
      bounded: normalized.slice(0, WATCH_LIMITS.textChars),
    };
  };

  const expire = (watch) => {
    unschedule(watch.watchId);
    watches.delete(watch.watchId);
    void persist();
    changed(watch.threadId);
  };

  const check = async (watchId) => {
    const watch = watches.get(watchId);
    if (!watch || closed || watch.status !== 'active') return;
    if (now() >= watch.expiresAt) { expire(watch); return; }
    try {
      const page = await readPage(watch);
      if (watches.get(watchId) !== watch || watch.status !== 'active') return;
      watch.failures = 0;
      watch.lastError = null;
      watch.lastCheckedAt = now();
      if (page.title) watch.title = page.title;
      if (page.hash !== watch.hash) {
        const diff = diffWatchText(watch.text, page.bounded);
        watch.hash = page.hash;
        watch.text = page.bounded;
        if (diff.addedCount || diff.removedCount) {
          watch.lastChangedAt = watch.lastCheckedAt;
          emitNotice(watch, { kind: 'changed', ...diff });
        }
      }
      watch.nextCheckAt = nextAfterSuccess(watch);
    } catch (error) {
      if (watches.get(watchId) !== watch || watch.status !== 'active') return;
      watch.lastCheckedAt = now();
      watch.lastError = { code: String(error?.code ?? 'BROWSER_WATCH_READ_FAILED').slice(0, 80) };
      if (PAUSE_CODES.has(error?.code)) {
        watch.status = 'paused';
        watch.pausedReason = error.code;
        emitNotice(watch, { kind: 'paused', reason: error.code });
      } else {
        watch.failures = (watch.failures ?? 0) + 1;
        watch.nextCheckAt = nextAfterFailure(watch);
        log(`browser watch ${watchId} read failed: ${watch.lastError.code}`);
      }
    }
    await persist();
    schedule(watch);
    changed(watch.threadId);
  };

  /** 감시마다 한 번에 하나, 허브 전체로도 하나씩 읽는다 — 브라우저를 한꺼번에 깨우지 않는다. */
  const runCheck = (watchId) => {
    const running = checking.get(watchId);
    if (running) return running;
    const task = checkQueue.catch(() => {}).then(() => check(watchId));
    checkQueue = task.catch(() => {});
    const tracked = task.finally(() => { if (checking.get(watchId) === tracked) checking.delete(watchId); });
    checking.set(watchId, tracked);
    return tracked;
  };

  const ready = (async () => {
    let stored;
    try { stored = JSON.parse(await fs.readFile(filePath, 'utf8')); } catch { return; }
    if (stored?.version !== FILE_VERSION) return;
    const at = now();
    for (const watch of Array.isArray(stored.watches) ? stored.watches.slice(0, WATCH_LIMITS.total) : []) {
      if (typeof watch?.watchId !== 'string' || typeof watch.threadId !== 'string' || typeof watch.url !== 'string') continue;
      if (!Number.isFinite(watch.expiresAt) || watch.expiresAt <= at) continue;
      watches.set(watch.watchId, { ...watch, status: watch.status === 'paused' ? 'paused' : 'active', failures: Number(watch.failures) || 0 });
    }
    notices = (Array.isArray(stored.notices) ? stored.notices : []).filter((notice) => typeof notice?.noticeId === 'string' && typeof notice.threadId === 'string');
    pruneNotices();
    for (const watch of watches.values()) schedule(watch);
  })();

  return {
    ready: () => ready,

    /** 감시를 만든다. 처음 읽기가 기준이 되고, 거절은 그대로 에이전트에게 간다. */
    async create(actor, args = {}) {
      await ready;
      if (!actor?.threadId || actor.isHuman) throw failure('BROWSER_SCOPE_REQUIRED', 'Only a chat agent can watch a page');
      const intervalMinutes = args.intervalMinutes ?? WATCH_LIMITS.defaultIntervalMinutes;
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < WATCH_LIMITS.minIntervalMinutes || intervalMinutes > WATCH_LIMITS.maxIntervalMinutes) {
        throw failure('INVALID_ARGS', `intervalMinutes must be an integer from ${WATCH_LIMITS.minIntervalMinutes} to ${WATCH_LIMITS.maxIntervalMinutes}`);
      }
      const find = args.find === undefined ? null : text(args.find, WATCH_LIMITS.findChars) || null;
      let source = args.url;
      if (args.tabId !== undefined) {
        if (args.url !== undefined) throw failure('INVALID_ARGS', 'Pass url or tabId, not both');
        const status = await ownedBrowser.request(actor, 'status', {});
        const tab = (status?.tabs ?? []).find((entry) => entry.tabId === args.tabId);
        if (!tab) throw failure('BROWSER_TAB_NOT_FOUND', 'This browser tab is unavailable to the current agent.');
        source = tab.url;
      }
      if (source === undefined) throw failure('INVALID_ARGS', 'Pass url or tabId');
      const url = watchUrl(source);
      const mine = [...watches.values()].filter((watch) => watch.threadId === actor.threadId);
      const existing = mine.find((watch) => watch.url === url && watch.find === find);
      if (existing) {
        if (existing.status === 'active' && existing.intervalMinutes === intervalMinutes) return { ok: true, action: 'create', existing: true, watch: summary(existing) };
        expire(existing);
      } else {
        if (mine.length >= WATCH_LIMITS.perChat) throw failure('BROWSER_WATCH_LIMIT', `A chat can watch at most ${WATCH_LIMITS.perChat} pages; cancel one first`);
        if (watches.size >= WATCH_LIMITS.total) throw failure('BROWSER_WATCH_LIMIT', `At most ${WATCH_LIMITS.total} pages can be watched; cancel one first`);
      }
      const at = now();
      const watch = {
        watchId: `watch-${crypto.randomUUID()}`,
        threadId: actor.threadId,
        documentId: actor.documentId ?? null,
        projectId: actor.projectId ?? null,
        url, find, title: '', intervalMinutes,
        status: 'active', pausedReason: null, failures: 0, lastError: null,
        createdAt: at, expiresAt: at + WATCH_LIMITS.lifetimeMs,
        lastCheckedAt: null, lastChangedAt: null, nextCheckAt: at,
        hash: null, text: '',
      };
      const page = await readPage(watch);
      if (closed) throw failure('BROWSER_CLOSED', 'The browser service has closed.');
      Object.assign(watch, { title: page.title, hash: page.hash, text: page.bounded, lastCheckedAt: now() });
      watch.nextCheckAt = nextAfterSuccess(watch);
      watches.set(watch.watchId, watch);
      await persist();
      schedule(watch);
      changed(watch.threadId);
      return { ok: true, action: 'create', watch: summary(watch), chars: page.normalized.length };
    },

    list(threadId) {
      return [...watches.values()]
        .filter((watch) => watch.threadId === threadId)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(summary);
    },

    /** threadId 를 주면 그 채팅의 감시만 지운다(에이전트). 없으면 사용자 UI 의 취소다. */
    async cancel(watchId, { threadId } = {}) {
      await ready;
      const watch = watches.get(watchId);
      if (!watch || (threadId !== undefined && watch.threadId !== threadId)) throw failure('BROWSER_WATCH_NOT_FOUND', 'No such watch in this chat');
      unschedule(watchId);
      watches.delete(watchId);
      notices = notices.filter((notice) => notice.watchId !== watchId);
      await persist();
      changed(watch.threadId);
      return { ok: true, action: 'cancel', watchId };
    },

    /** 채팅을 보관하거나 지웠다 — 그 채팅의 감시와 알림을 모두 버린다. */
    async endThread(threadId) {
      await ready;
      let removed = 0;
      for (const watch of [...watches.values()]) {
        if (watch.threadId !== threadId) continue;
        unschedule(watch.watchId);
        watches.delete(watch.watchId);
        removed += 1;
      }
      const before = notices.length;
      notices = notices.filter((notice) => notice.threadId !== threadId);
      if (removed || notices.length !== before) {
        await persist();
        changed(threadId);
      }
      return { removed };
    },

    /** 아직 Studio 가 받았다고 하지 않은 알림. 다시 붙은 Studio 에 그대로 보낸다. */
    pendingNotices() {
      pruneNotices();
      return notices.map((notice) => structuredClone(notice));
    },

    async ack(noticeIds) {
      await ready;
      const ids = new Set((Array.isArray(noticeIds) ? noticeIds : []).filter((id) => typeof id === 'string'));
      const before = notices.length;
      notices = notices.filter((notice) => !ids.has(notice.noticeId));
      if (notices.length !== before) await persist();
      return { acknowledged: before - notices.length };
    },

    /** 시험과 진단용 — 기다리지 않고 지금 한 번 읽는다. */
    checkNow: (watchId) => runCheck(watchId),
    /** 시험용 — 줄 선 확인과 저장이 모두 끝나기를 기다린다. */
    idle: () => checkQueue.then(() => writeQueue),

    async close() {
      closed = true;
      for (const watchId of [...timers.keys()]) unschedule(watchId);
      await writeQueue.catch(() => {});
    },
  };
}

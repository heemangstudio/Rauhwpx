import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { replaceFileAtomically } from './harness-update.mjs';

const MAX_MAPPED_CHATS = 500;
const MAX_STORE_BYTES = 256 * 1024;

/**
 * 웹 비서(ask_chatgpt·ask_claude)의 켜기 설정과 HamaEditor 채팅 → 웹 채팅 주소 지도. 허브 데이터 폴더의 작은 JSON(0600, 원자적 교체).
 * 읽을 수 없는 파일은 꺼진 기본값으로 시작한다(기능이 켜진 채로 남지 않게).
 * projectUrl·chatUrl 은 그 사이트의 프로젝트·채팅 주소만 돌려주고 나머지는 null 로 거른다.
 * @param {{ filePath: string, projectUrl: (value: unknown) => string | null, chatUrl: (value: unknown) => string | null,
 *   label?: string, logger?: ((message: string) => void) | null, platform?: string }} options
 */
export function createWebAssistantStore({ filePath, projectUrl: normalizeProject, chatUrl: normalizeChat, label = 'web assistant', logger = null, platform = process.platform }) {
  if (!filePath) throw new TypeError(`${label} store filePath is required.`);
  let state = { enabled: false, projectUrl: null, chats: {} };
  let queue = Promise.resolve();
  const ready = (async () => {
    let raw;
    try {
      const info = await fs.lstat(filePath);
      if (!info.isFile() || info.size > MAX_STORE_BYTES) throw new Error('not a bounded file');
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') logger?.(`${label} store unreadable: ${error?.message ?? error}`);
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.schema !== 1) throw new Error('unknown schema');
      const chats = {};
      for (const [key, url] of Object.entries(parsed.chats ?? {})) {
        const chat = normalizeChat(url);
        if (chat && typeof key === 'string' && key.length <= 256) chats[key] = chat;
      }
      state = { enabled: parsed.enabled === true, projectUrl: normalizeProject(parsed.projectUrl), chats };
    } catch (error) { logger?.(`${label} store invalid: ${error?.message ?? error}`); }
  })();
  const write = (next) => {
    const task = queue.then(async () => {
      await ready;
      const value = { ...state, ...next(state) };
      await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temp = `${filePath}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temp, JSON.stringify({ schema: 1, ...value }), { mode: 0o600, flag: 'wx' });
        await replaceFileAtomically(temp, filePath, { platform });
      } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
      state = value;
      return value;
    });
    queue = task.catch(() => {});
    return task;
  };
  return {
    ready: () => ready,
    enabled: () => state.enabled,
    projectUrl: () => state.projectUrl,
    chatUrl: (chatKey) => (typeof chatKey === 'string' && Object.hasOwn(state.chats, chatKey) ? state.chats[chatKey] : null),
    setEnabled: (enabled) => write(() => ({ enabled: enabled === true })),
    setProjectUrl: (url) => write(() => ({ projectUrl: normalizeProject(url) })),
    setChatUrl: (chatKey, url) => write((current) => {
      const chat = normalizeChat(url);
      if (!chat || typeof chatKey !== 'string' || !chatKey || chatKey.length > 256) return {};
      const chats = { ...current.chats };
      delete chats[chatKey];
      chats[chatKey] = chat;
      const keys = Object.keys(chats);
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_MAPPED_CHATS))) delete chats[key];
      return { chats };
    }),
    forgetChat: (chatKey) => write((current) => {
      if (!Object.hasOwn(current.chats, chatKey)) return {};
      const chats = { ...current.chats };
      delete chats[chatKey];
      return { chats };
    }),
  };
}

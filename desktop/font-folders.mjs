// 사용자가 데스크톱 앱에서 더한 글꼴 폴더 목록. userData 의 JSON 파일 하나에 둔다.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { pathKey } from '../rhwp/rhwp-shared/fonts/font-index-core.mjs';

const MAX_FOLDERS = 64;

/**
 * @param {{ filePath: string, writeAtomically: (filePath: string, bytes: Buffer) => Promise<unknown>,
 *   platform?: string, log?: (line: string) => void }} options
 */
export function createFontFolderStore({ filePath, writeAtomically, platform = process.platform, log = () => {} }) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let folders = null;
  let tail = Promise.resolve();

  function normalize(list) {
    const seen = new Set();
    const result = [];
    for (const folder of Array.isArray(list) ? list : []) {
      if (typeof folder !== 'string' || !pathApi.isAbsolute(folder)) continue;
      const resolved = pathApi.resolve(folder);
      const key = pathKey(resolved, platform);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(resolved);
      if (result.length >= MAX_FOLDERS) break;
    }
    return result;
  }

  async function load() {
    if (folders) return folders;
    try {
      folders = normalize(JSON.parse(await readFile(filePath, 'utf8'))?.folders);
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`font folder list unreadable: ${error.message}`);
      folders = [];
    }
    return folders;
  }

  /** 바꾸기는 한 번에 하나씩 한다. 여러 창이 동시에 더하거나 빼도 서로 덮어쓰지 않는다. */
  function update(change) {
    const run = tail.then(async () => {
      const current = await load();
      const next = normalize(change(current));
      if (next.length !== current.length || next.some((folder, i) => folder !== current[i])) {
        await writeAtomically(filePath, Buffer.from(`${JSON.stringify({ folders: next }, null, 2)}\n`, 'utf8'));
        folders = next;
      }
      return [...folders];
    });
    tail = run.catch(() => {});
    return run;
  }

  return {
    async list() {
      await tail;
      return [...await load()];
    },
    add(folder) {
      return update((current) => [...current, folder]);
    },
    remove(folder) {
      const key = typeof folder === 'string' ? pathKey(pathApi.resolve(folder), platform) : null;
      return update((current) => current.filter((entry) => pathKey(entry, platform) !== key));
    },
  };
}

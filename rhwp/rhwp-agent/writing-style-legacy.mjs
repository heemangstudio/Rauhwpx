/**
 * 예전 말투 맞추기(writing-style) 폴더를 한 번 옮긴다 — 문체 학습(style-learning.mjs)과 기억이 그 자리를 잇는다.
 *
 * 허브가 뜰 때(migrateLegacyWritingStyle):
 * - 비지 않은 additional-instruction.md 는 사용자의 글이니 AGENTS.md 의 `## 말투 지침` 아래로 한 번 옮긴다
 *   (기억의 legacy.instructionMigrated 로 다시 옮기지 않는다).
 * - 한국어가 아니거나 저장한 원고(sources/)가 없으면 폴더를 지운다. 문체 학습은 한국어만 배운다.
 * - 원고가 있으면 Rau 탭이 "예전 원고 N개로 배우기"를 묻는다(legacy:{files}). 받아들이면 그 원고로 문체 학습을 돌리고
 *   성공한 뒤 폴더를 지운다. 거절하면 곧바로 지운다.
 *
 * 폴더: `%APPDATA%\rhwp\writing-style` (macOS `~/Library/Application Support/rhwp/writing-style`,
 * 그 밖 `$XDG_DATA_HOME/rhwp/writing-style`). RHWP_WRITING_STYLE_DIR 로 바꾼다.
 *   metadata.json {language}, additional-instruction.md, sources.json {version:1, files:[{id, sha256, storedName, name, type, size}]},
 *   sources/<storedName>
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readFileBytesBounded, readUtf8FileBounded } from './bounded-file.mjs';

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_INSTRUCTION_BYTES = 16 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_SOURCE_FILES = 20;
const MAX_SOURCE_FILE_BYTES = 20 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 50 * 1024 * 1024;
export const LEGACY_INSTRUCTION_HEADING = '## 말투 지침';

export function defaultWritingStyleRoot(env = process.env, platform = process.platform, home = os.homedir()) {
  if (env.RHWP_WRITING_STYLE_DIR) return path.resolve(env.RHWP_WRITING_STYLE_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'rhwp', 'writing-style');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'rhwp', 'writing-style');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'rhwp', 'writing-style');
}

function legacyError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readText(file, maxBytes, label, platform) {
  try {
    return await readUtf8FileBounded(file, { maxBytes, label, platform });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 저장한 원고 목록 — 모양이 틀린 항목은 버린다. */
function manifestFiles(raw) {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.files)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of raw.files.slice(0, MAX_SOURCE_FILES)) {
    if (!entry || typeof entry.id !== 'string' || !/^[a-f0-9]{64}$/.test(entry.id) || entry.sha256 !== entry.id
      || typeof entry.storedName !== 'string' || path.basename(entry.storedName) !== entry.storedName
      || !/^\d{2}-[a-f0-9]{64}(?:\.[a-z0-9]{1,11})?$/.test(entry.storedName)
      || typeof entry.name !== 'string' || !entry.name || entry.name.length > 512
      || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > MAX_SOURCE_FILE_BYTES
      || seen.has(entry.storedName)) continue;
    seen.add(entry.storedName);
    out.push({
      id: entry.id,
      storedName: entry.storedName,
      name: entry.name,
      type: typeof entry.type === 'string' && entry.type.length <= 256 ? entry.type : 'application/octet-stream',
      size: entry.size,
    });
  }
  return out;
}

/**
 * 폴더를 읽는다. 없으면 null.
 * @returns {Promise<{ language: string, instruction: string, files: {id, storedName, name, type, size}[] } | null>}
 */
export async function inspectLegacyWritingStyle(root, { platform = process.platform } = {}) {
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let metadata = {};
  try {
    metadata = JSON.parse(await readText(path.join(root, 'metadata.json'), MAX_METADATA_BYTES, 'Writing-style metadata', platform) ?? '{}');
  } catch {}
  const instruction = (await readText(path.join(root, 'additional-instruction.md'), MAX_INSTRUCTION_BYTES, 'Writing-style instruction', platform).catch(() => null)) ?? '';
  let manifest = null;
  try {
    manifest = JSON.parse(await readText(path.join(root, 'sources.json'), MAX_MANIFEST_BYTES, 'Writing-style source manifest', platform) ?? 'null');
  } catch {}
  const listed = manifestFiles(manifest);
  const files = [];
  for (const entry of listed) {
    try {
      const stat = await fs.lstat(path.join(root, 'sources', entry.storedName));
      if (stat.isFile() && !stat.isSymbolicLink()) files.push(entry);
    } catch {}
  }
  return { language: metadata?.language === 'en' ? 'en' : 'ko', instruction: instruction.trim(), files };
}

/**
 * 저장한 원고를 읽어 sha256 을 확인한다. 바뀌었거나 없는 파일은 뺀다.
 * @returns {Promise<{ name: string, type: string, size: number, bytes: Buffer }[]>}
 */
export async function readLegacySources(root, { platform = process.platform } = {}) {
  const inspected = await inspectLegacyWritingStyle(root, { platform });
  if (!inspected) throw legacyError('LEGACY_NOT_FOUND', 'The earlier writing samples are no longer here.');
  const loaded = [];
  let total = 0;
  for (const entry of inspected.files) {
    let bytes;
    try {
      bytes = await readFileBytesBounded(path.join(root, 'sources', entry.storedName), {
        maxBytes: MAX_SOURCE_FILE_BYTES,
        label: `Writing-style source ${entry.name}`,
        platform,
      });
    } catch {
      continue;
    }
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== entry.size || digest !== entry.id) continue;
    if (total + bytes.length > MAX_SOURCE_TOTAL_BYTES) break;
    total += bytes.length;
    loaded.push({ name: entry.name, type: entry.type, size: bytes.length, bytes });
  }
  return loaded;
}

export async function removeLegacyWritingStyle(root) {
  await fs.rm(root, { recursive: true, force: true });
}

/** AGENTS.md 에 `## 말투 지침` 절을 붙인 내용. 같은 글이 이미 있으면 null. */
export function appendLegacyInstruction(content, instruction) {
  const text = String(instruction ?? '').replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  const body = String(content ?? '').replace(/\r\n?/g, '\n');
  if (body.includes(text)) return null;
  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed ? `${trimmed}\n\n` : ''}${LEGACY_INSTRUCTION_HEADING}\n${text}\n`;
}

/**
 * 허브가 뜰 때 한 번 — 위 머리말의 순서대로 옮긴다. 남은 원고가 있으면 { files } 를, 없으면 null 을 돌려준다.
 * @param {{
 *   root?: string,
 *   instructions: { snapshot(): { content: string, revision: number }, update(content: string, options: { expectedRevision: number }): Promise<unknown> },
 *   userMemory: { legacyState(): Promise<Record<string, boolean>>, setLegacyState(patch: Record<string, boolean>): Promise<unknown> },
 *   log?: (message: string) => void,
 *   platform?: string,
 * }} deps
 */
export async function migrateLegacyWritingStyle({ root = defaultWritingStyleRoot(), instructions, userMemory, log = () => {}, platform = process.platform }) {
  const inspected = await inspectLegacyWritingStyle(root, { platform });
  if (!inspected) return null;
  const state = await userMemory.legacyState();
  if (state.instructionMigrated !== true) {
    if (inspected.instruction) {
      const status = instructions.snapshot();
      const content = appendLegacyInstruction(status.content, inspected.instruction);
      if (content !== null) {
        await instructions.update(content, { expectedRevision: status.revision });
        log('moved the earlier writing-style instruction into AGENTS.md');
      }
    }
    await userMemory.setLegacyState({ instructionMigrated: true });
  }
  if (inspected.language !== 'ko' || inspected.files.length === 0) {
    await removeLegacyWritingStyle(root);
    log('removed the earlier writing-style folder (nothing to learn from)');
    return null;
  }
  return { files: inspected.files.length };
}

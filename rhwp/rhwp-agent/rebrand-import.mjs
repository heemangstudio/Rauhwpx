/**
 * 2.0.11 이 `<데이터 폴더>/hamaeditor/*` 에 남긴 허브 데이터를 정본 `<데이터 폴더>/rhwp/*` 에 합친다.
 *
 * 2.0.11 은 허브 저장소의 기본 폴더 이름을 rhwp 에서 hamaeditor 로 바꿨다. 2.0.12 부터 원래 폴더가
 * 정본이다. 2.0.11 쪽은 읽기만 하고 지우지 않는다. 정본에 이미 있는 항목은 덮지 않고, 한 문서뿐인
 * 저장소(앱 지시, 문체)만 더 최근 쪽을 쓰되 밀려난 정본을 옆에 남긴다.
 *
 * 비밀 저장소에 묶인 Pi·CLI 설정은 옮기지 않는다. 2.0.11 의 비밀은 다른 키로 암호화돼 있어 함께
 * 옮길 수 없고, 열쇠 없는 설정만 옮기면 설정된 것처럼 보이는데 쓸 수 없는 상태가 된다.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { replaceFileAtomically } from './harness-update.mjs';

export const CANONICAL_DATA_DIR = 'rhwp';
export const REBRANDED_DATA_DIR = 'hamaeditor';
export const REBRAND_IMPORT_MARKER = '.rebrand-import.json';
const CANONICAL_SKILL_ORIGIN_FILE = '.rhwp-origin.json';
const REBRANDED_SKILL_ORIGIN_FILE = '.hamaeditor-origin.json';

/** 허브 저장소의 기본 데이터 폴더. 각 저장소의 default*Root 와 같은 규칙이다. */
export function hubDataBase(env = process.env, platform = process.platform, home = os.homedir()) {
  const platformPath = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return platformPath.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || platformPath.join(home, 'AppData', 'Roaming');
  return env.XDG_DATA_HOME || platformPath.join(home, '.local', 'share');
}

async function readOptional(file, encoding) {
  try {
    return await fs.readFile(file, encoding);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 원자적 쓰기가 중간에 끊기면 `.previous-write` 에 이전 내용이 남는다. */
async function readWithInterruptedFallback(file, encoding) {
  return await readOptional(file, encoding) ?? await readOptional(`${file}.previous-write`, encoding);
}

async function readJson(file) {
  const text = await readWithInterruptedFallback(file, 'utf8');
  if (text === null) return null;
  return JSON.parse(text);
}

async function exists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomically(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.rebrand-${process.pid}-${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await replaceFileAtomically(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** 폴더를 옆 임시 폴더에 다 복사한 뒤 이름을 바꿔, 중간에 끊겨도 반쯤 복사된 폴더가 남지 않게 한다. */
async function copyDirectoryAtomically(source, target, { filter = () => true, rename = (name) => name } = {}) {
  const staging = `${target}.rebrand-${process.pid}-${randomUUID()}`;
  try {
    await fs.cp(source, staging, {
      recursive: true,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
      filter: (from) => filter(path.relative(source, from)),
    });
    await renameInside(staging, rename);
    await fs.rename(staging, target);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function renameInside(directory, rename) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const from = path.join(directory, entry.name);
    const to = path.join(directory, rename(entry.name));
    if (to !== from) await fs.rename(from, to);
    if (entry.isDirectory()) await renameInside(to, rename);
  }
}

async function fingerprint(root) {
  const hash = createHash('sha256');
  async function walk(directory, prefix) {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
      throw error;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        hash.update(`d:${relative}\n`);
        await walk(full, `${relative}/`);
      } else {
        const stat = await fs.lstat(full);
        hash.update(`f:${relative}:${stat.size}:${Math.trunc(stat.mtimeMs)}\n`);
      }
    }
  }
  await walk(root, '');
  return hash.digest('hex');
}

// ── 앱 지시(AGENTS.md) ─────────────────────────────────────────────────────

async function readInstructions(root) {
  const content = await readWithInterruptedFallback(path.join(root, 'AGENTS.md'), 'utf8');
  if (content === null) return null;
  let meta = null;
  try {
    meta = await readJson(path.join(root, '.AGENTS.md.meta.json'));
  } catch {
    meta = null;
  }
  let updatedAt = Date.parse(meta?.updatedAt ?? '');
  if (!Number.isFinite(updatedAt)) updatedAt = (await fs.stat(path.join(root, 'AGENTS.md'))).mtimeMs;
  return { content, meta, updatedAt };
}

/** 처음 심은 뒤 한 번도 고치지 않은 지시. 버전마다 기본 문구가 달라 내용 대신 메타로 판단한다. */
function isUntouchedSeed(instructions) {
  const { meta, content } = instructions;
  return meta?.revision === 1
    && meta?.contentHash === createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 고친 쪽을 남긴다. 둘 다 고쳤으면 더 최근 쪽을 쓰고, 밀려난 정본은 지시 폴더 옆에 남긴다.
 * 메타는 그대로 두어 다음 기동에서 저장소가 해시 불일치를 보고 revision 을 올리게 한다.
 */
export async function mergeAgentInstructions(source, target, { now = Date.now } = {}) {
  const incoming = await readInstructions(source);
  if (!incoming || isUntouchedSeed(incoming)) return { changed: false, reason: 'source-untouched' };
  const current = await readInstructions(target);
  if (current?.content === incoming.content) return { changed: false, reason: 'same' };
  if (current && !isUntouchedSeed(current)) {
    if (current.updatedAt >= incoming.updatedAt) return { changed: false, reason: 'canonical-newer' };
    await writeAtomically(
      path.join(path.dirname(target), `${path.basename(target)}.replaced-${now()}.md`),
      current.content,
    );
  }
  await writeAtomically(path.join(target, 'AGENTS.md'), incoming.content);
  return { changed: true, reason: current ? 'source-newer' : 'canonical-missing' };
}

// ── 스킬 ───────────────────────────────────────────────────────────────────

async function readCatalogState(root) {
  try {
    const state = await readJson(path.join(root, '.catalog-state.json'));
    return Array.isArray(state?.disabled) ? state.disabled.filter((name) => typeof name === 'string') : [];
  } catch {
    return [];
  }
}

function canonicalSkillName(name) {
  return name === REBRANDED_SKILL_ORIGIN_FILE ? CANONICAL_SKILL_ORIGIN_FILE : name;
}

/** 정본에 없는 스킬 폴더와 휴지통 항목만 더한다. 이름이 같으면 정본을 두고 2.0.11 쪽은 원래 자리에 남긴다. */
export async function mergeSkills(source, target) {
  let entries;
  try {
    entries = await fs.readdir(source, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { added: [], kept: [] };
    throw error;
  }
  await fs.mkdir(target, { recursive: true });
  const added = [];
  const kept = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const destination = path.join(target, entry.name);
    if (await exists(destination)) {
      kept.push(entry.name);
      continue;
    }
    await copyDirectoryAtomically(path.join(source, entry.name), destination, { rename: canonicalSkillName });
    added.push(entry.name);
  }
  const trashSource = path.join(source, '.trash', 'deleted');
  const trashTarget = path.join(target, '.trash', 'deleted');
  for (const entry of await fs.readdir(trashSource, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || await exists(path.join(trashTarget, entry.name))) continue;
    await fs.mkdir(trashTarget, { recursive: true });
    await copyDirectoryAtomically(path.join(trashSource, entry.name), path.join(trashTarget, entry.name), {
      rename: canonicalSkillName,
    });
  }
  // 정본에 있던 스킬의 켜짐 상태는 정본을 따르고, 새로 들어온 스킬은 2.0.11 상태를 따른다.
  const incomingDisabled = (await readCatalogState(source)).filter((name) => added.includes(name));
  if (incomingDisabled.length) {
    const disabled = [...new Set([...await readCatalogState(target), ...incomingDisabled])];
    await writeAtomically(path.join(target, '.catalog-state.json'), `${JSON.stringify({ disabled })}\n`);
  }
  return { added, kept };
}

// ── 서식(템플릿) ───────────────────────────────────────────────────────────

function templateNameKey(name) {
  return String(name ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function uniqueTemplateName(name, taken) {
  for (let attempt = 2; attempt < 1000; attempt += 1) {
    const suffix = ` (${attempt})`;
    const candidate = `${String(name).slice(0, 80 - suffix.length)}${suffix}`;
    if (!taken.has(templateNameKey(candidate))) return candidate;
  }
  return null;
}

/**
 * id 기준 합집합. 같은 이름이 있으면 들어오는 서식 이름에 번호를 붙인다. 합친 결과를 실제
 * 저장소로 열어 보고, 열리지 않으면 정본 메타데이터와 복사한 파일을 되돌린다.
 */
export async function mergeTemplates(source, target, { validate } = {}) {
  const incoming = await readJson(path.join(source, 'metadata.json')).catch(() => null);
  if (!Array.isArray(incoming?.templates) || incoming.templates.length === 0) return { added: [] };
  const metadataPath = path.join(target, 'metadata.json');
  const previousBytes = await readOptional(metadataPath);
  const current = previousBytes ? JSON.parse(previousBytes.toString('utf8')) : null;
  const templates = Array.isArray(current?.templates) ? [...current.templates] : [];
  const ids = new Set(templates.map((record) => record.id));
  const names = new Set(templates.map((record) => templateNameKey(record.name)));
  const copied = [];
  const added = [];
  try {
    for (const record of incoming.templates) {
      if (!record || typeof record !== 'object' || ids.has(record.id)) continue;
      const name = names.has(templateNameKey(record.name)) ? uniqueTemplateName(record.name, names) : record.name;
      if (!name) continue;
      const from = path.join(source, 'files', path.basename(String(record.blobName)));
      const to = path.join(target, 'files', path.basename(String(record.blobName)));
      if (!await exists(from)) continue;
      if (!await exists(to)) {
        await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        copied.push(to);
      }
      templates.push({ ...record, name });
      ids.add(record.id);
      names.add(templateNameKey(name));
      added.push(record.id);
    }
    if (added.length === 0) return { added };
    const merged = {
      catalogRevision: Math.max(current?.catalogRevision ?? 0, incoming.catalogRevision ?? 0) + 1,
      schemaVersion: 1,
      templates,
    };
    await writeAtomically(metadataPath, `${JSON.stringify(merged, null, 2)}\n`);
    await validate?.(target);
    return { added };
  } catch (error) {
    await restore(metadataPath, previousBytes, copied);
    throw error;
  }
}

async function restore(metadataPath, previousBytes, copied) {
  if (previousBytes) await writeAtomically(metadataPath, previousBytes).catch(() => {});
  else await fs.rm(metadataPath, { force: true }).catch(() => {});
  for (const file of copied) await fs.rm(file, { force: true }).catch(() => {});
}

// ── 참고 파일 ──────────────────────────────────────────────────────────────

/** id 기준 합집합. 내용 주소 파일은 없을 때만 복사한다. 한도를 넘으면 실제 저장소 검사가 막고 되돌린다. */
export async function mergeReferences(source, target, { validate } = {}) {
  const incoming = await readJson(path.join(source, 'metadata.json')).catch(() => null);
  if (!Array.isArray(incoming?.files) || incoming.files.length === 0) return { added: [] };
  const metadataPath = path.join(target, 'metadata.json');
  const previousBytes = await readOptional(metadataPath);
  const current = previousBytes ? JSON.parse(previousBytes.toString('utf8')) : null;
  const files = Array.isArray(current?.files) ? [...current.files] : [];
  const ids = new Set(files.map((record) => record.id));
  const copied = [];
  const added = [];
  try {
    for (const record of incoming.files) {
      if (!record || typeof record !== 'object' || ids.has(record.id)) continue;
      if (typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) continue;
      for (const [directory, name] of [['blobs', record.sha256], ['objects', `${record.sha256}.json`]]) {
        const from = path.join(source, directory, name);
        const to = path.join(target, directory, name);
        if (!await exists(from) || await exists(to)) continue;
        await fs.mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
        copied.push(to);
      }
      files.push(record);
      ids.add(record.id);
      added.push(record.id);
    }
    if (added.length === 0) return { added };
    await writeAtomically(metadataPath, `${JSON.stringify({ schemaVersion: 1, files }, null, 2)}\n`);
    await validate?.(target);
    return { added };
  } catch (error) {
    await restore(metadataPath, previousBytes, copied);
    throw error;
  }
}

// ── 사용량 ─────────────────────────────────────────────────────────────────

/** 사용 기록 줄을 합친다. 줄에 id 가 없으니 같은 줄은 한 번만 넣는다. 요금제와 초기화 장부는 정본에 없을 때만 가져온다. */
export async function mergeUsage(source, target) {
  let appended = 0;
  const incoming = await readOptional(path.join(source, 'events.jsonl'), 'utf8');
  if (incoming) {
    const eventsPath = path.join(target, 'events.jsonl');
    const current = await readOptional(eventsPath, 'utf8') ?? '';
    const seen = new Set(current.split('\n').filter(Boolean));
    const lines = incoming.split('\n').filter((line) => line.trim() && !seen.has(line));
    if (lines.length) {
      const prefix = current && !current.endsWith('\n') ? '\n' : '';
      await writeAtomically(eventsPath, `${current}${prefix}${lines.join('\n')}\n`);
      appended = lines.length;
    }
  }
  const copied = [];
  for (const name of ['plans.json', 'codex-reset-ledger.json']) {
    const bytes = await readWithInterruptedFallback(path.join(source, name));
    if (bytes === null || await exists(path.join(target, name))) continue;
    await writeAtomically(path.join(target, name), bytes);
    copied.push(name);
  }
  return { appended, copied };
}

// ── 문체 ───────────────────────────────────────────────────────────────────

const WRITING_STYLE_SCRATCH = /^(?:commit-journal\.json|.*\.old-.+|.*\.tmp-.+)$/;

async function writingStyleUpdatedAt(root) {
  try {
    const metadata = await readJson(path.join(root, 'metadata.json'));
    const updatedAt = Date.parse(metadata?.updatedAt ?? '');
    return Number.isFinite(updatedAt) ? updatedAt : 0;
  } catch {
    return 0;
  }
}

/** 문체는 파일 여러 개가 한 묶음이다. 더 최근 묶음을 통째로 쓰고, 밀려난 정본은 옆 폴더에 남긴다. */
export async function mergeWritingStyle(source, target, { now = Date.now } = {}) {
  if (!await exists(path.join(source, 'style.md'))) return { changed: false, reason: 'source-empty' };
  const filter = (relative) => !relative || !WRITING_STYLE_SCRATCH.test(path.basename(relative));
  let replaced = null;
  if (await exists(path.join(target, 'style.md'))) {
    if (await writingStyleUpdatedAt(target) >= await writingStyleUpdatedAt(source)) {
      return { changed: false, reason: 'canonical-newer' };
    }
    replaced = `${target}.replaced-${now()}`;
  } else if (await exists(target)) {
    // 문체가 없는 빈 폴더다. 지우지 않고 옆으로 비켜 둔다.
    replaced = `${target}.replaced-${now()}`;
  }
  if (replaced) await fs.rename(target, replaced);
  try {
    await copyDirectoryAtomically(source, target, { filter });
  } catch (error) {
    if (replaced) await fs.rename(replaced, target).catch(() => {});
    throw error;
  }
  return { changed: true, reason: replaced ? 'source-newer' : 'canonical-missing' };
}

// ── 잠금 ───────────────────────────────────────────────────────────────────

const IMPORT_LOCK_DIR = '.rebrand-import.lock';
const IMPORT_LOCK_STALE_MS = 2 * 60 * 1000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readLockOwner(lock) {
  try {
    return JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function lockIsStale(lock, owner, now) {
  if (owner && Number.isSafeInteger(owner.pid) && Number.isFinite(owner.at)) {
    return !processAlive(owner.pid) || now - owner.at > IMPORT_LOCK_STALE_MS;
  }
  // 주인 기록을 쓰기 전에 멈춘 잠금이다. 막 만든 잠금일 수 있으니 한동안은 그대로 둔다.
  const stat = await fs.stat(lock).catch(() => null);
  return !stat || now - stat.mtimeMs > IMPORT_LOCK_STALE_MS;
}

/**
 * 허브 여럿이 동시에 떠도 가져오기는 한 번에 하나만 돈다. `timeoutMs` 안에 잠금을 못 얻으면
 * null 이고, 그 허브는 이번에 가져오기를 건너뛴다.
 */
export async function acquireImportLock(baseDir, { timeoutMs = 10_000, now = Date.now } = {}) {
  const lock = path.join(baseDir, IMPORT_LOCK_DIR);
  await fs.mkdir(baseDir, { recursive: true });
  const deadline = now() + timeoutMs;
  const token = randomUUID();
  for (;;) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, at: now(), token }));
      return async () => {
        if ((await readLockOwner(lock))?.token === token) await fs.rm(lock, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const owner = await readLockOwner(lock);
    if (await lockIsStale(lock, owner, now())) {
      // 지우기 직전에 다른 허브가 새로 잡았다면 그 잠금은 건드리지 않는다.
      const again = await readLockOwner(lock);
      if (JSON.stringify(again) === JSON.stringify(owner)) {
        await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
      }
      continue;
    }
    if (now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// ── 진입점 ─────────────────────────────────────────────────────────────────

const ROOTS = [
  { name: 'agent-instructions', env: 'RHWP_AGENT_INSTRUCTIONS_DIR', merge: mergeAgentInstructions },
  { name: 'skills', env: 'RHWP_SKILLS_DIR', merge: mergeSkills },
  { name: 'templates', env: 'RHWP_TEMPLATES_DIR', merge: mergeTemplates, validator: 'templates' },
  { name: 'references', env: 'RHWP_REFERENCES_DIR', merge: mergeReferences, validator: 'references' },
  { name: 'usage', env: 'RHWP_USAGE_DIR', merge: mergeUsage },
  { name: 'writing-style', env: 'RHWP_WRITING_STYLE_DIR', merge: mergeWritingStyle },
];

async function defaultValidators() {
  const [{ TemplateStore }, { ReferenceStore }] = await Promise.all([
    import('./template-store.mjs'),
    import('./reference-store.mjs'),
  ]);
  return {
    templates: async (root) => { await new TemplateStore({ rootDir: root }).init(); },
    references: async (root) => { await new ReferenceStore({ root }).init(); },
  };
}

/**
 * 기본 폴더를 쓰는 저장소마다 2.0.11 데이터를 한 번 합친다. 2.0.11 쪽이 바뀌면 다시 합친다.
 * 저장소를 열기 전에 불러야 한다. 한 저장소가 실패해도 나머지는 계속하고 다음 기동에서 다시 시도한다.
 */
export async function importRebrandedHubData({
  env = process.env,
  platform = process.platform,
  home = os.homedir(),
  log = () => {},
  validators = null,
  lockTimeoutMs = 10_000,
} = {}) {
  const base = hubDataBase(env, platform, home);
  const sourceBase = path.join(base, REBRANDED_DATA_DIR);
  const targetBase = path.join(base, CANONICAL_DATA_DIR);
  if (!await exists(sourceBase)) return {};
  const release = await acquireImportLock(targetBase, { timeoutMs: lockTimeoutMs });
  if (!release) {
    log('2.0.11 data import skipped: another hub is importing');
    return {};
  }
  try {
    return await importUnderLock({ env, sourceBase, targetBase, log, validators });
  } finally {
    await release().catch(() => {});
  }
}

async function importUnderLock({ env, sourceBase, targetBase, log, validators }) {
  const markerPath = path.join(targetBase, REBRAND_IMPORT_MARKER);
  let marker = {};
  try {
    marker = await readJson(markerPath) ?? {};
  } catch {
    marker = {};
  }
  const checks = validators ?? await defaultValidators();
  const results = {};
  let markerChanged = false;
  for (const root of ROOTS) {
    if (env[root.env]) continue;
    const source = path.join(sourceBase, root.name);
    if (!await exists(source)) continue;
    try {
      const current = await fingerprint(source);
      if (marker[root.name]?.fingerprint === current) continue;
      results[root.name] = await root.merge(source, path.join(targetBase, root.name), {
        validate: root.validator ? checks[root.validator] : undefined,
      });
      marker[root.name] = { fingerprint: current, importedAt: new Date().toISOString() };
      markerChanged = true;
      log(`imported 2.0.11 ${root.name}: ${JSON.stringify(results[root.name])}`);
    } catch (error) {
      results[root.name] = { error: String(error?.message ?? error) };
      log(`2.0.11 ${root.name} import failed: ${error?.message ?? error}`);
      // 저장소 검사가 거절한 결과(한도 초과 등)는 다시 해도 같다. 2.0.11 쪽이 바뀔 때까지 다시 시도하지 않는다.
      if (/^(?:REFERENCE|TEMPLATE)_/.test(String(error?.code ?? ''))) {
        marker[root.name] = { fingerprint: await fingerprint(source), rejected: String(error.code) };
        markerChanged = true;
      }
    }
  }
  if (markerChanged) await writeAtomically(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return results;
}

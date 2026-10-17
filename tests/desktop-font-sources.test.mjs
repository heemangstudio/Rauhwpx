import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSystemFontService, defaultFontRoots } from '../desktop/system-fonts.mjs';
import { createFontFolderStore } from '../desktop/font-folders.mjs';
import {
  fontconfigFontRoots,
  parseFcListFiles,
  parseRegQueryFonts,
  windowsRegistryFontRoots,
} from '../rhwp/rhwp-shared/fonts/font-enumerators.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTO = path.join(repoRoot, 'rhwp/ttfs/opensource/NotoSansKR-Regular.ttf');

const HKLM_OUTPUT = [
  '',
  'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  '    Arial (TrueType)    REG_SZ    arial.ttf',
  '    맑은 고딕 & Malgun Gothic UI (TrueType)    REG_SZ    malgun.ttc',
  '    함초롬바탕 (TrueType)    REG_SZ    C:\\Program Files (x86)\\Hnc\\Shared\\Fonts\\HANBatang.ttf',
  '    Courier 10,12,15    REG_SZ    COURE.FON',
  '    Brand Sans Bold (OpenType)    REG_SZ    D:\\Design Fonts\\Brand Sans Bold.otf',
  '    Brand Sans Bold copy (OpenType)    REG_SZ    d:\\design fonts\\brand sans bold.otf',
  '    Expanded (TrueType)    REG_EXPAND_SZ    %ProgramData%\\Vendor\\Fonts\\expanded.ttf',
  '    Old Bitmap    REG_SZ    C:\\Legacy\\old.fon',
  '',
].join('\r\n');

const HKCU_OUTPUT = [
  '',
  'HKEY_CURRENT_USER\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  '    나눔명조 (TrueType)    REG_SZ    C:\\Users\\라우\\AppData\\Local\\Microsoft\\Windows\\Fonts\\NanumMyeongjo.ttf',
  '    Team Font (TrueType)    REG_SZ    \\\\fileserver\\fonts share\\team.ttf',
  '    Empty    REG_SZ    ',
  '',
].join('\r\n');

test('reads Windows registry font values and keeps only absolute files outside the catalog folders', () => {
  const values = parseRegQueryFonts(HKLM_OUTPUT);
  assert.equal(values.length, 8);
  assert.deepEqual(values[1], { name: '맑은 고딕 & Malgun Gothic UI (TrueType)', type: 'REG_SZ', value: 'malgun.ttc' });
  assert.deepEqual(values[4], {
    name: 'Brand Sans Bold (OpenType)',
    type: 'REG_SZ',
    value: 'D:\\Design Fonts\\Brand Sans Bold.otf',
  });

  const roots = windowsRegistryFontRoots([
    { kind: 'user', values: parseRegQueryFonts(HKCU_OUTPUT) },
    { kind: 'system', values },
  ], {
    covered: ['C:\\Windows\\Fonts', 'C:\\Users\\라우\\AppData\\Local\\Microsoft\\Windows\\Fonts', 'C:\\Program Files (x86)\\Hnc'],
    env: { PROGRAMDATA: 'C:\\ProgramData' },
  });
  // 파일 이름만 있는 값, 카탈로그 폴더 안 경로, 비트맵 .fon, 대소문자만 다른 중복은 뺀다.
  assert.deepEqual(roots, [
    { path: '\\\\fileserver\\fonts share\\team.ttf', kind: 'user', label: 'Windows registry' },
    { path: 'D:\\Design Fonts\\Brand Sans Bold.otf', kind: 'system', label: 'Windows registry' },
    { path: 'C:\\ProgramData\\Vendor\\Fonts\\expanded.ttf', kind: 'system', label: 'Windows registry' },
  ]);
});

test('turns fontconfig files outside the catalog into one shallow root per folder', () => {
  const files = parseFcListFiles([
    '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf',
    '/home/rau/.local/share/fonts/나눔고딕.ttf',
    '/opt/brand fonts/Brand Sans.otf',
    '/opt/brand fonts/Brand Sans Bold.otf',
    '/home/rau/projects/fonts/Custom.ttf',
    'Fontconfig warning: ignoring UTF-8',
    '',
  ].join('\n'));
  assert.equal(files.length, 5);
  assert.deepEqual(fontconfigFontRoots(files, { covered: ['/usr/share/fonts', '/home/rau/.local/share/fonts'] }), [
    { path: '/opt/brand fonts', kind: 'system', label: 'fontconfig', maxDepth: 0 },
    { path: '/home/rau/projects/fonts', kind: 'system', label: 'fontconfig', maxDepth: 0 },
  ]);
});

test('default roots add OS-enumerated fonts, and a failed command adds nothing', async () => {
  const env = {
    WINDIR: 'C:\\Windows',
    SystemRoot: 'C:\\Windows',
    LOCALAPPDATA: 'C:\\Users\\rau\\AppData\\Local',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  };
  const calls = [];
  const win = await defaultFontRoots({
    platform: 'win32',
    env,
    runCommand: async (command, args) => {
      calls.push([command, ...args]);
      return args[1].startsWith('HKLM') ? HKLM_OUTPUT : null;
    },
  });
  assert.deepEqual(calls.map((call) => call[0]), ['C:\\Windows\\System32\\reg.exe', 'C:\\Windows\\System32\\reg.exe']);
  const registry = win.roots.filter((root) => root.label === 'Windows registry');
  assert.deepEqual(registry.map((root) => root.path), ['D:\\Design Fonts\\Brand Sans Bold.otf']);

  const linux = await defaultFontRoots({
    platform: 'linux',
    env: {},
    home: '/home/rau',
    runCommand: async () => '/usr/share/fonts/a.ttf\n/home/rau/.fonts/b.ttf\n/srv/fonts/c.ttf\n',
  });
  assert.deepEqual(linux.roots.filter((root) => root.label === 'fontconfig').map((root) => root.path), ['/srv/fonts']);
  const absent = await defaultFontRoots({ platform: 'linux', env: {}, home: '/home/rau', runCommand: async () => null });
  assert.ok(!absent.roots.some((root) => root.label === 'fontconfig'));
});

test('added folders are indexed as user fonts, persist, and leave the index once removed', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-font-folders-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const added = path.join(dir, 'my fonts');
  const system = path.join(dir, 'system');
  await mkdir(added, { recursive: true });
  await mkdir(system, { recursive: true });
  await copyFile(NOTO, path.join(added, 'Noto.ttf'));
  await writeFile(path.join(system, 'readme.txt'), 'not a font');

  const filePath = path.join(dir, 'font-folders.json');
  const writeAtomically = (target, bytes) => writeFile(target, bytes);
  const store = createFontFolderStore({ filePath, writeAtomically });
  const service = createSystemFontService({
    roots: [{ path: system, kind: 'system', label: 'system fonts' }],
    addedFolders: () => store.list(),
  });
  assert.equal((await service.list()).faces.length, 0);

  assert.deepEqual(await Promise.all([store.add(added), store.add(`${added}/`)]), [[added], [added]]);
  const withFolder = await service.list({ refresh: true });
  assert.deepEqual(withFolder.faces.map((face) => [face.source, face.families[0]]), [['user', 'Noto Sans KR']]);
  const report = withFolder.roots.find((root) => root.path === added);
  assert.deepEqual([report.kind, report.label, report.fileCount, report.faceCount], ['user', 'added folder', 1, 1]);

  // 앱을 다시 켜면 저장한 목록을 읽는다.
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).folders, [added]);
  const reopened = createFontFolderStore({ filePath, writeAtomically });
  assert.deepEqual(await reopened.list(), [added]);

  assert.deepEqual(await reopened.remove(added), []);
  const refreshed = await createSystemFontService({
    roots: [{ path: system, kind: 'system' }],
    addedFolders: () => reopened.list(),
  }).list();
  assert.equal(refreshed.faces.length, 0);
  assert.ok(!refreshed.roots.some((root) => root.path === added));
});

test('a refresh requested during a scan rescans with the folders changed meanwhile', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rhwp-font-refresh-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(NOTO, path.join(dir, 'Noto.ttf'));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const service = createSystemFontService({
    roots: [],
    addedFolders: async () => {
      calls += 1;
      if (calls > 1) return [dir];
      await gate;
      return [];
    },
  });
  const first = service.list();
  while (calls === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = service.list({ refresh: true });
  release();
  assert.equal((await first).faces.length, 0);
  assert.equal((await second).faces.length, 1);
});

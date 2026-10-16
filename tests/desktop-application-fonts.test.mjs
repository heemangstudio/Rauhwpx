import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSystemFontService, defaultFontRoots, discoverApplicationFontDirs } from '../desktop/system-fonts.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hama-app-fonts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('discovers font folders across installed applications, including Office, Adobe and per-user apps', async (t) => {
  const root = await fixture(t);
  const programFiles = path.join(root, 'Program Files');
  const userPrograms = path.join(root, 'Local', 'Programs');
  const expected = [
    path.join(programFiles, 'Microsoft Office', 'root', 'vfs', 'Fonts'),
    path.join(programFiles, 'Adobe', 'Acrobat', 'Resource', 'Font'),
    path.join(programFiles, 'LibreOffice', 'share', 'fonts'),
    path.join(userPrograms, '한글 앱', 'Resources', 'DFonts'),
  ];
  for (const dir of [...expected, path.join(programFiles, 'App', 'node_modules', 'Fonts')]) {
    await mkdir(dir, { recursive: true });
  }
  const found = await discoverApplicationFontDirs([programFiles, userPrograms, programFiles, path.join(root, 'missing')]);
  assert.deepEqual(found.directories, expected.sort());
  assert.equal(found.capped, false);
});

test('application font discovery bounds depth and directory work and skips junctions', async (t) => {
  const root = await fixture(t);
  const base = path.join(root, 'Apps');
  const outside = path.join(root, 'Outside', 'Fonts');
  await mkdir(path.join(base, 'App', 'Resources', 'Fonts'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(path.dirname(outside), path.join(base, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const limited = await discoverApplicationFontDirs([base], { maxDirs: 1 });
  assert.equal(limited.capped, true);
  assert.deepEqual(limited.directories, []);
  assert.deepEqual((await discoverApplicationFontDirs([base], { maxDepth: 1 })).directories, []);
  assert.deepEqual((await discoverApplicationFontDirs([base])).directories, [path.join(base, 'App', 'Resources', 'Fonts')]);
  for (const name of ['Fonts', 'TTF', 'DFonts']) await mkdir(path.join(base, name));
  const wide = await discoverApplicationFontDirs([base], { maxDirs: 1 });
  assert.equal(wide.capped, true);
  assert.equal(wide.directories.length, 1);
});

test('discovered application fonts are indexed, served from the original file and reused from cache', async (t) => {
  const root = await fixture(t);
  const fonts = path.join(root, 'Office', 'Resources', 'Fonts');
  await mkdir(fonts, { recursive: true });
  const bytes = await readFile(new URL('../rhwp/ttfs/opensource/NotoSansKR-Regular.ttf', import.meta.url));
  const file = path.join(fonts, 'NotoSansKR.ttf');
  await writeFile(file, bytes);
  const { directories } = await discoverApplicationFontDirs([root]);
  const options = { roots: directories.map((dir) => ({ path: dir, kind: 'user' })), cacheDir: path.join(root, 'cache') };
  const service = createSystemFontService(options);
  const index = await service.list();
  const face = index.faces.find((candidate) => candidate.families.includes('Noto Sans KR'));
  assert.ok(face);
  assert.equal(face.path, file);
  assert.equal(face.source, 'user');
  const opened = await service.openFace(face.id);
  const chunks = [];
  for await (const chunk of opened.chunks()) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  const cached = await createSystemFontService(options).list();
  assert.equal(cached.fromCache, true);
  assert.equal(cached.faces[0].id, face.id);
  assert.deepEqual(await readFile(file), bytes);
});

test('Windows defaults include application font directories without duplicate Program Files roots', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await fixture(t);
  const programs = path.join(root, 'Program Files');
  const local = path.join(root, 'Local');
  const appFonts = path.join(programs, 'Adobe', 'Acrobat', 'Resource', 'Font');
  const userFonts = path.join(local, 'Programs', 'App', 'Fonts');
  await mkdir(appFonts, { recursive: true });
  await mkdir(userFonts, { recursive: true });
  const defaults = await defaultFontRoots({ platform: 'win32', env: {
    WINDIR: path.join(root, 'Windows'), ProgramFiles: programs,
    ProgramW6432: programs.toUpperCase(), LOCALAPPDATA: local,
  } });
  assert.equal(defaults.roots.filter((entry) => entry.path === appFonts).length, 1);
  assert.ok(defaults.roots.some((entry) => entry.path === userFonts && entry.kind === 'user'));
  assert.ok(defaults.roots.some((entry) => entry.path === path.join(local, 'Microsoft', 'Windows', 'Fonts')));
  assert.deepEqual(defaults.discoveryErrors, []);
});

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import crossSpawn from 'cross-spawn';

import { buildMdfindQuery, createHomeSearch, HOME_HIT_TTL_MS } from '../home-search.mjs';

const FAKE_MDFIND = fileURLToPath(new URL('./fixtures/fake-mdfind.mjs', import.meta.url));

async function makeHome(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-home-search-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const outside = path.join(base, 'outside');
  const write = async (rel, content = '%PDF-1.4\n') => {
    const full = path.join(home, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
    return full;
  };
  const files = {
    report: await write('Documents/보고서 초안.pdf'),
    nfd: await write(`Documents/${'보고서 한글'.normalize('NFD')}.pdf`),
    hidden: await write('Documents/.hidden/보고서.pdf'),
    library: await write('Library/Mobile Documents/보고서.pdf'),
    photos: await write('Pictures/Photos Library.photoslibrary/보고서.png'),
    app: await write('Applications/보고서.app/Contents/보고서.pdf'),
    excluded: await write('Private/보고서.pdf'),
    huge: await write('Documents/보고서 대용량.pdf', Buffer.alloc(1024 * 1024 + 1, 1)),
    empty: await write('Documents/보고서 빈.pdf', ''),
    exe: await write('Documents/보고서.exe'),
    modules: await write('code/node_modules/pkg/보고서.md', '# x'),
  };
  await fs.mkdir(outside, { recursive: true });
  files.outside = path.join(outside, '보고서.pdf');
  await fs.writeFile(files.outside, '%PDF-1.4\n');
  files.link = path.join(home, 'Documents', '보고서 링크.pdf');
  await fs.symlink(files.report, files.link);
  await fs.symlink(outside, path.join(home, 'Documents', 'linked'));
  files.viaLinkedDir = path.join(home, 'Documents', 'linked', '보고서.pdf');
  return { base, home, files };
}

function settings(overrides = {}) {
  return () => ({
    ingest: {
      homeSearch: true,
      fileTypes: ['pdf', 'md', 'png'],
      excludedFolders: ['~/Private'],
      maxFileMb: 1,
      ...overrides,
    },
  });
}

function fakeSpawn(base, paths, { mode } = {}) {
  const out = path.join(base, 'mdfind-out.json');
  const log = path.join(base, 'mdfind-log.jsonl');
  const ready = fs.writeFile(out, JSON.stringify(paths));
  return {
    log,
    ready,
    spawn: (command, args, options) => crossSpawn(process.execPath, [FAKE_MDFIND, ...args], {
      ...options,
      env: { ...process.env, FAKE_MDFIND_OUT: out, FAKE_MDFIND_LOG: log, ...(mode ? { FAKE_MDFIND_MODE: mode } : {}) },
    }),
  };
}

test('Spotlight queries escape every word and restrict extensions', () => {
  const query = buildMdfindQuery(['예산"*', 'a\\b'], ['pdf', 'hwp']);
  assert.equal(query, '(kMDItemDisplayName == "*예산\\"\\**"cd || kMDItemTextContent == "예산\\"\\**"cdw)'
    + ' && (kMDItemDisplayName == "*a\\\\b*"cd || kMDItemTextContent == "a\\\\b*"cdw)'
    + ' && (kMDItemFSName == "*.pdf"c || kMDItemFSName == "*.hwp"c)');
});

test('macOS search filters mdfind output to safe home files and hands out session-bound hit ids', async (t) => {
  const { base, home, files } = await makeHome(t);
  const fake = fakeSpawn(base, [...Object.values(files), '/etc/hosts', 'relative/보고서.pdf']);
  await fake.ready;
  let clock = 1_000_000;
  const search = createHomeSearch({
    home, platform: 'darwin', settings: settings(), access: true, spawn: fake.spawn, now: () => clock,
  });
  assert.equal(search.available, true);
  await assert.rejects(search.find({ query: '보고서' }), { code: 'HOME_SEARCH_INVALID' });

  const result = await search.find({ query: '보고서', sessionKey: 'chat-1' });
  const args = JSON.parse((await fs.readFile(fake.log, 'utf8')).trim());
  assert.deepEqual(args.slice(0, 3), ['-0', '-onlyin', home]);
  assert.match(args[3], /kMDItemDisplayName == "\*보고서\*"cd/);
  assert.match(args[3], /kMDItemFSName == "\*\.md"c/);

  assert.deepEqual(result.hits.map((hit) => hit.homePath).sort(), [
    '~/Documents/보고서 초안.pdf',
    `~/Documents/${'보고서 한글'.normalize('NFC')}.pdf`,
  ].sort());
  const nfd = result.hits.find((hit) => hit.name.startsWith('보고서 한글'));
  assert.equal(nfd.name, '보고서 한글.pdf'.normalize('NFC'));
  for (const hit of result.hits) {
    assert.match(hit.hitId, /^h[a-z2-7]{20}$/);
    assert.equal(hit.ext, 'pdf');
    assert.ok(hit.size > 0 && hit.mtime > 0);
    assert.doesNotMatch(JSON.stringify(hit), new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const report = result.hits.find((hit) => hit.name === '보고서 초안.pdf');
  assert.equal(await search.resolve(report.hitId, 'chat-1'), files.report);
  assert.deepEqual(await search.resolveHit(report.hitId, 'chat-1'), {
    realPath: files.report, homePath: '~/Documents/보고서 초안.pdf', name: '보고서 초안.pdf', size: 9, ext: 'pdf',
  });
  await assert.rejects(search.resolve(report.hitId, 'chat-2'), { code: 'HOME_HIT_INVALID' });
  await assert.rejects(search.resolve('haaaaaaaaaaaaaaaaaaaa', 'chat-1'), { code: 'HOME_HIT_INVALID' });
  await assert.rejects(search.resolve(undefined, 'chat-1'), { code: 'HOME_HIT_INVALID' });

  // A file swapped for a symlink after the search is refused on resolve.
  await fs.rm(files.report);
  await fs.symlink(files.outside, files.report);
  await assert.rejects(search.resolve(report.hitId, 'chat-1'), { code: 'HOME_HIT_UNAVAILABLE' });

  clock += HOME_HIT_TTL_MS + 1;
  await assert.rejects(search.resolve(nfd.hitId, 'chat-1'), { code: 'HOME_HIT_EXPIRED' });
});

test('home search is off without desktop access or when settings disable it', async (t) => {
  const { home } = await makeHome(t);
  const browser = createHomeSearch({ home, platform: 'darwin', settings: settings(), access: false });
  assert.equal(browser.available, false);
  await assert.rejects(browser.find({ query: 'x', sessionKey: 's' }), { code: 'HOME_ACCESS_DISABLED' });
  const disabled = createHomeSearch({ home, platform: 'darwin', settings: settings({ homeSearch: false }), access: true });
  assert.equal(disabled.available, false);
  await assert.rejects(disabled.resolve('hx', 's'), { code: 'HOME_ACCESS_DISABLED' });
});

test('filename walk covers Windows/Linux and a hung mdfind, with the same exclusions', async (t) => {
  const { base, home } = await makeHome(t);
  const linux = createHomeSearch({ home, platform: 'linux', settings: settings(), access: true });
  const walked = await linux.find({ query: '보고서', sessionKey: 's' });
  assert.deepEqual(walked.hits.map((hit) => hit.homePath).sort(), [
    '~/Documents/보고서 초안.pdf',
    `~/Documents/${'보고서 한글'.normalize('NFD')}.pdf`.normalize('NFC'),
  ].sort());
  const narrowed = await linux.find({ query: '보고서 초안', types: ['pdf'], sessionKey: 's' });
  assert.deepEqual(narrowed.hits.map((hit) => hit.name), ['보고서 초안.pdf']);

  const fake = fakeSpawn(base, [], { mode: 'hang' });
  await fake.ready;
  const darwin = createHomeSearch({
    home, platform: 'darwin', settings: settings(), access: true, spawn: fake.spawn, mdfindTimeoutMs: 200,
  });
  const started = Date.now();
  const fallback = await darwin.find({ query: '초안', sessionKey: 's' });
  assert.ok(Date.now() - started < 4_000);
  assert.deepEqual(fallback.hits.map((hit) => hit.name), ['보고서 초안.pdf']);
});

test('a folder whose opendir never returns (pending macOS privacy prompt) is skipped within the walk budget', async (t) => {
  const { home } = await makeHome(t);
  await fs.mkdir(path.join(home, 'Desktop'), { recursive: true });
  await fs.writeFile(path.join(home, 'Desktop', '보고서 바탕.pdf'), '%PDF-1.4\n');
  const opened = [];
  const linux = createHomeSearch({
    home, platform: 'linux', settings: settings(), access: true,
    openDir: (dir) => {
      opened.push(dir);
      return dir.endsWith(`${path.sep}Desktop`) ? new Promise(() => {}) : fs.opendir(dir);
    },
  });
  const started = Date.now();
  const first = await linux.find({ query: '보고서', sessionKey: 's' });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(first.complete, false);
  assert.ok(first.hits.some((hit) => hit.name === '보고서 초안.pdf'));
  assert.ok(!first.hits.some((hit) => hit.name === '보고서 바탕.pdf'));
  // 아직 열리지 않은 폴더는 다시 열지 않는다 — 멈춘 호출이 스레드 풀을 더 묶지 않게.
  await linux.find({ query: '초안', types: ['md'], sessionKey: 's' });
  assert.equal(opened.filter((dir) => dir.endsWith(`${path.sep}Desktop`)).length, 1);
});

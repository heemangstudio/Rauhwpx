import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fetchPublic, safeNetworkFetch } from '../download-manager.mjs';
import {
  createProjectIngest,
  extensionForDownload,
  htmlToSnapshot,
} from '../project-ingest.mjs';

function fakeStores() {
  const added = [];
  const items = [];
  return {
    added,
    items,
    referenceStore: {
      async addBuffer(options) {
        added.push(options);
        return { id: `ref${added.length}`, name: options.name, size: options.bytes.length };
      },
    },
    projectStore: {
      async addFileItem(projectId, item) {
        const stored = { id: `f${String(items.length).padStart(6, 'a')}`, projectId, ...item };
        items.push(stored);
        return stored;
      },
    },
  };
}

function settings(overrides = {}) {
  return () => ({
    ingest: {
      homeSearch: true,
      fileTypes: ['pdf', 'md', 'txt', 'html', 'docx', 'png'],
      excludedFolders: [],
      maxFileMb: 1,
      ...overrides,
    },
  });
}

function response(status, headers, body = '') {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(headers),
    body: (async function* chunks() { if (body) yield Buffer.from(body); })(),
  };
}

test('public fetch refuses private targets, including after a redirect', async () => {
  await assert.rejects(fetchPublic('http://127.0.0.1:9/secret'), { code: 'DOWNLOAD_ADDRESS_BLOCKED' });
  await assert.rejects(fetchPublic('http://user:pw@example.com/'), { code: 'DOWNLOAD_URL_INVALID' });
  await assert.rejects(fetchPublic('file:///etc/passwd'), { code: 'DOWNLOAD_URL_INVALID' });

  const visited = [];
  const redirecting = async (url, options) => {
    visited.push(String(url));
    if (url.hostname === 'public.example') {
      return response(302, { location: 'http://169.254.169.254/latest/meta-data' });
    }
    return safeNetworkFetch(url, options);
  };
  await assert.rejects(
    fetchPublic('https://public.example/report', { fetchImpl: redirecting }),
    { code: 'DOWNLOAD_ADDRESS_BLOCKED' },
  );
  assert.deepEqual(visited, ['https://public.example/report', 'http://169.254.169.254/latest/meta-data']);

  const toFile = async () => response(302, { location: 'file:///etc/passwd' });
  await assert.rejects(fetchPublic('https://public.example/', { fetchImpl: toFile }), { code: 'DOWNLOAD_URL_INVALID' });
});

test('public fetch enforces the byte cap while streaming', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.end(Buffer.alloc(4_096, 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/big.pdf`;
  await assert.rejects(fetchPublic(url, { fetchImpl: globalThis.fetch, maxBytes: 1_000 }), { code: 'DOWNLOAD_TOO_LARGE' });
  const ok = await fetchPublic(url, { fetchImpl: globalThis.fetch });
  assert.equal(ok.size, 4_096);
  assert.equal(ok.mime, 'application/pdf');
  assert.equal(ok.filename, 'big.pdf');
});

test('download extensions come from the signature, then the content type, then the name', () => {
  const pdf = Buffer.from('%PDF-1.7 ...');
  assert.equal(extensionForDownload({ mime: 'application/octet-stream', filename: 'x', bytes: pdf }), 'pdf');
  assert.equal(extensionForDownload({ mime: 'text/html; charset=utf-8', filename: 'index', bytes: Buffer.from('<p>') }), 'html');
  assert.equal(extensionForDownload({
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', filename: 'deck', bytes: Buffer.from('PK'),
  }), 'pptx');
  assert.equal(extensionForDownload({ mime: 'application/octet-stream', filename: '보고서.hwp', bytes: Buffer.from('x') }), 'hwp');
  assert.equal(extensionForDownload({ mime: 'text/plain', filename: 'data.csv', bytes: Buffer.from('a,b') }), 'csv');
  assert.equal(extensionForDownload({ mime: 'application/octet-stream', filename: 'page', bytes: Buffer.from('<!DOCTYPE html><html>') }), 'html');
  assert.equal(extensionForDownload({ mime: 'application/x-msdownload', filename: 'setup.exe', bytes: Buffer.from('MZ') }), null);
});

test('HTML becomes a readable markdown snapshot without scripts or navigation', () => {
  const html = `<!doctype html><html><head><title>정책 브리핑 | 사이트</title><script>steal()</script></head>
    <body><nav><a>메뉴</a></nav><header>로고</header>
    <main><h1>청년 주거 지원</h1><p>지원 대상은 &amp; 만 19~34세입니다.</p><ul><li>월세 지원</li><li>보증금 대출</li></ul>
    <p>${'본문 '.repeat(60)}</p></main><footer>저작권</footer><style>.x{}</style></body></html>`;
  const { title, markdown } = htmlToSnapshot(html, { url: 'https://gov.example/policy' });
  assert.equal(title, '정책 브리핑 | 사이트');
  assert.match(markdown, /^# 정책 브리핑 \| 사이트\n\n원문: https:\/\/gov\.example\/policy\n/);
  assert.match(markdown, /# 청년 주거 지원/);
  assert.match(markdown, /- 월세 지원\n- 보증금 대출/);
  assert.match(markdown, /& 만 19~34세/);
  assert.doesNotMatch(markdown, /steal|메뉴|로고|저작권|\.x\{\}/);
});

test('URL imports store HTML as .md and documents as-is with web source metadata', async () => {
  const stores = fakeStores();
  const pages = {
    'https://news.example/a': { mime: 'text/html', charset: 'euc-kr', filename: 'a',
      // EUC-KR: 기사 / 본문
      bytes: Buffer.concat([
        Buffer.from('<html><head><title>'), Buffer.from([0xB1, 0xE2, 0xBB, 0xE7]),
        Buffer.from('</title></head><body><p>'), Buffer.from([0xBA, 0xBB, 0xB9, 0xAE]), Buffer.from('</p></body></html>'),
      ]),
      finalUrl: 'https://news.example/a?ref=1' },
    'https://files.example/r': { mime: 'application/pdf', filename: 'report.pdf', bytes: Buffer.from('%PDF-1.4\n'),
      finalUrl: 'https://files.example/r' },
    'https://files.example/zip': { mime: 'application/zip', filename: 'bundle.zip', bytes: Buffer.from('PK') ,
      finalUrl: 'https://files.example/zip' },
  };
  const calls = [];
  const ingest = createProjectIngest({
    ...stores,
    settings: settings(),
    fetchPublic: async (url, options) => {
      calls.push(options);
      const page = pages[url];
      return { ...page, size: page.bytes.length, source: url };
    },
  });
  const actor = { kind: 'agent', threadId: 't1', agent: 'claude' };
  const { item: html } = await ingest.importUrl({ projectId: 'pabc', url: 'https://news.example/a', actor, tags: ['뉴스'] });
  assert.equal(html.title, '기사.md');
  assert.deepEqual(html.source, { kind: 'web', url: 'https://news.example/a', finalUrl: 'https://news.example/a?ref=1' });
  assert.deepEqual(html.addedBy, actor);
  assert.deepEqual(html.tags, ['뉴스']);
  assert.equal(stores.added[0].scope, 'project');
  assert.equal(stores.added[0].scopeId, 'pabc');
  assert.match(stores.added[0].bytes.toString('utf8'), /^# 기사\n\n원문: https:\/\/news\.example\/a\?ref=1\n\n본문/);
  assert.equal(calls[0].maxBytes, 1024 * 1024);

  const { item: pdf } = await ingest.importUrl({ projectId: 'pabc', url: 'https://files.example/r', actor });
  assert.equal(pdf.title, 'report.pdf');
  assert.equal(stores.added[1].mimeType, 'application/pdf');
  await assert.rejects(ingest.importUrl({ projectId: 'pabc', url: 'https://files.example/zip', actor }), { code: 'PROJECT_INGEST_TYPE' });

  // 에이전트가 붙인 이름의 점 뒤는 확장자가 아니다 — 날짜·도메인이 잘리지 않는다.
  const { item: named } = await ingest.importUrl({ projectId: 'pabc', url: 'https://news.example/a', actor, name: '보도자료: 현장점검 (2026.6.23)' });
  assert.equal(named.title, '보도자료 현장점검 (2026.6.23).md');
  const { item: renamedPdf } = await ingest.importUrl({ projectId: 'pabc', url: 'https://files.example/r', actor, name: '안내서 v1.2.pdf' });
  assert.equal(renamedPdf.title, '안내서 v1.2.pdf');
});

test('settings file types and size limits apply to every import', async () => {
  const stores = fakeStores();
  const ingest = createProjectIngest({
    ...stores,
    settings: settings({ fileTypes: ['md'], maxFileMb: 1 }),
    fetchPublic: async () => ({ mime: 'application/pdf', filename: 'a.pdf', bytes: Buffer.from('%PDF-'), size: 5, source: 'https://x.example/' }),
  });
  await assert.rejects(ingest.importUrl({ projectId: 'p1', url: 'https://x.example/' }), { code: 'PROJECT_INGEST_TYPE' });
  await assert.rejects(ingest.importText({ projectId: 'p1', name: 'a.txt', text: 'hi' }), { code: 'PROJECT_INGEST_TYPE' });
  await assert.rejects(
    ingest.importText({ projectId: 'p1', name: 'big', text: '가'.repeat(400_000) }),
    { code: 'PROJECT_INGEST_TOO_LARGE' },
  );
  const { item } = await ingest.importText({ projectId: 'p1', name: '회의 메모', url: 'https://x.example/m', text: '결정 사항' });
  assert.equal(item.title, '회의 메모.md');
  assert.deepEqual(item.source, { kind: 'text', url: 'https://x.example/m' });
  assert.equal(stores.added[0].bytes.toString('utf8'), '원문: https://x.example/m\n\n결정 사항\n');
});

test('path imports stay inside the allowed roots and reject links', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-ingest-path-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const work = path.join(base, 'work');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(work, 'sub'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(path.join(work, 'sub', 'notes.md'), '# 메모');
  await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
  await fs.symlink(path.join(outside, 'secret.md'), path.join(work, 'link.md'));
  await fs.symlink(outside, path.join(work, 'linked-dir'));
  const stores = fakeStores();
  const ingest = createProjectIngest({ ...stores, settings: settings(), fetchPublic: async () => assert.fail('no fetch') });
  const roots = [work];

  const { item } = await ingest.importPath({ projectId: 'p1', path: 'sub/notes.md', allowedRoots: roots });
  assert.equal(item.title, 'notes.md');
  assert.deepEqual(item.source, { kind: 'workspace' });

  for (const candidate of [
    '../outside/secret.md',
    path.join(outside, 'secret.md'),
    'link.md',
    'linked-dir/secret.md',
  ]) {
    await assert.rejects(
      ingest.importPath({ projectId: 'p1', path: candidate, allowedRoots: roots }),
      { code: 'PROJECT_INGEST_PATH' },
      candidate,
    );
  }
  await assert.rejects(ingest.importPath({ projectId: 'p1', path: 'sub/missing.md', allowedRoots: roots }), { code: 'PROJECT_INGEST_NOT_FOUND' });
  assert.equal(stores.added.length, 1);
});

test('home imports require a resolvable hit from the home search', async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-ingest-home-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const file = path.join(base, '계획.pdf');
  await fs.writeFile(file, '%PDF-1.4\n');
  const stores = fakeStores();
  const resolved = [];
  const ingest = createProjectIngest({
    ...stores,
    settings: settings(),
    fetchPublic: async () => assert.fail('no fetch'),
    homeSearch: {
      available: true,
      async resolveHit(hitId, sessionKey) {
        resolved.push([hitId, sessionKey]);
        if (hitId !== 'hgood') throw Object.assign(new Error('bad'), { code: 'HOME_HIT_INVALID' });
        return { realPath: file, homePath: '~/Documents/계획.pdf' };
      },
    },
  });
  const { item } = await ingest.importHomeHit({ projectId: 'p1', hitId: 'hgood', sessionKey: 's1' });
  assert.equal(item.title, '계획.pdf');
  assert.deepEqual(item.source, { kind: 'home', homePath: '~/Documents/계획.pdf' });
  await assert.rejects(ingest.importHomeHit({ projectId: 'p1', hitId: 'hbad', sessionKey: 's1' }), { code: 'HOME_HIT_INVALID' });
  assert.deepEqual(resolved, [['hgood', 's1'], ['hbad', 's1']]);

  const browser = createProjectIngest({ ...stores, settings: settings(), homeSearch: { available: false } });
  await assert.rejects(browser.importHomeHit({ projectId: 'p1', hitId: 'hgood', sessionKey: 's1' }), { code: 'PROJECT_INGEST_UNAVAILABLE' });
});

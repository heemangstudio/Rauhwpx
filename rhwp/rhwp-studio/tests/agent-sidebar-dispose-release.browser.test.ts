/**
 * 걷은 사이드바는 메모리에서 사라진다 — 파일 이름 가운데 줄임(middle-truncate)의 공용 표가
 * 한 번도 그려지지 않은 이름표를 붙잡아 사이드바 전체(그리고 브리지)를 살려 두지 않는다.
 * 실제 사이드바를 미리보기 고정 데이터의 브리지로 만들고, 가비지 수집 뒤 WeakRef 로 확인한다.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer, { type Page } from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

let server: any;
let browser: any;
let origin: string;
let cache: string;

test.before(async () => {
  cache = await mkdtemp(resolve(tmpdir(), 'rau-sidebar-release-'));
  server = await createServer({
    cacheDir: cache,
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});

async function openPreview(t: any): Promise<Page> {
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'Uncaught browser errors'));
  await page.goto(`${origin}/?reset=1&controls=0&theme=light`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => (window as any).sidebarPreview
    && document.querySelector<HTMLElement>('#agent-sidebar')?.dataset.composerReady === 'true', { timeout: 60_000 });
  // 앱이 읽어 들인 모듈 그대로 쓴다(같은 모듈 인스턴스).
  await page.evaluate(async () => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    const load = (part: string) => import(/* @vite-ignore */ urls.find((url) => url.includes(part))!);
    (window as any).__modules = {
      sidebar: await load('/ui/agent-sidebar/index.ts'),
      mock: await load('/sidebar-preview/mock-bridge.ts'),
      bus: await load('/core/event-bus.ts'),
      truncate: await load('/ui/middle-truncate.ts'),
    };
  });
  return page;
}

async function collectGarbage(page: Page): Promise<void> {
  const client = await page.createCDPSession();
  await client.send('HeapProfiler.collectGarbage');
  await client.send('HeapProfiler.collectGarbage');
  await client.detach();
}

test('a disposed sidebar that was never shown is garbage collected', { timeout: 120_000 }, async (t) => {
  const page = await openPreview(t);
  await page.evaluate(async () => {
    const { sidebar, mock, bus } = (window as any).__modules;
    const preview = (window as any).sidebarPreview;
    const created = mock.createMockBridge(() => {});
    created.setScenario('chat');
    const instance = sidebar.initAgentSidebar({
      bridge: created.bridge,
      eventBus: new bus.EventBus(),
      startActive: false,
      attention: preview.attention,
      getDocumentContext: () => ({ documentId: 'doc-release', documentName: '걷는 사이드바.hwpx', selectionLabel: null }),
      listRecentDocuments: async () => [],
      moveToLibraryDocument: async () => 'cancelled',
    });
    created.boot();
    // 목록과 머리글이 이름표를 등록할 시간을 준다 — 사이드바는 한 번도 문서에 붙지 않는다.
    await new Promise((done) => setTimeout(done, 300));
    (window as any).__released = { root: new WeakRef(instance.root), bridge: new WeakRef(created.bridge) };
    instance.dispose();
    created.bridge.dispose();
  });
  await collectGarbage(page);
  assert.deepEqual(await page.evaluate(() => {
    const { root, bridge } = (window as any).__released;
    return { root: root.deref() === undefined, bridge: bridge.deref() === undefined };
  }), { root: true, bridge: true });
});

test('a name label set while detached and dropped before it is ever shown is not kept alive', { timeout: 60_000 }, async (t) => {
  const page = await openPreview(t);
  await page.evaluate(() => {
    const { truncate } = (window as any).__modules;
    const label = document.createElement('span');
    truncate.setMiddleTruncatedText(label, '사업계획서_최종_수정본_v3.hwpx');
    (window as any).__label = new WeakRef(label);
  });
  await collectGarbage(page);
  assert.equal(await page.evaluate(() => (window as any).__label.deref() === undefined), true);
});

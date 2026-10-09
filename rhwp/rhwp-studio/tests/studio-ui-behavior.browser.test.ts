import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { createServer, type ViteDevServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// 실제 UI 모듈을 빈 페이지에 띄워 사용자 입력·저장 경로를 확인한다(허브와 엔진은 가짜).
const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const HOSTILE = '<img src=x onerror="window.__injected = true">';
let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let baseUrl = '';

test.before(async () => {
  server = await createServer({
    root: studioRoot,
    configFile: false,
    cacheDir: resolve(studioRoot, 'node_modules/.vite-studio-ui-behavior-test'),
    logLevel: 'silent',
    resolve: { alias: { '@': resolve(studioRoot, 'src') } },
    server: { host: '127.0.0.1', port: 0, hmr: false },
    plugins: [{
      name: 'ui-harness',
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== '/ui-harness') return next();
          response.setHeader('Content-Type', 'text/html');
          response.end('<!doctype html><html><head><meta charset="UTF-8"></head><body></body></html>');
        });
      },
    }],
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  baseUrl = `http://127.0.0.1:${address.port}`;
  browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
});

test.after(async () => {
  await browser?.close();
  await server?.close();
});

async function harness(): Promise<Page> {
  assert.ok(browser);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  (page as Page & { pageErrors: string[] }).pageErrors = errors;
  await page.goto(`${baseUrl}/ui-harness`);
  return page;
}

async function closeHarness(page: Page): Promise<void> {
  await page.browserContext().close();
}

function pageErrors(page: Page): string[] {
  return (page as Page & { pageErrors: string[] }).pageErrors;
}

test('agent questions render provider text as text, never as markup', { timeout: 60_000 }, async () => {
  const page = await harness();
  try {
    const result = await page.evaluate(async (hostile) => {
      const { createUserQuestionController } = await import('/src/ui/agent-sidebar/user-question-controller.ts');
      const controller = createUserQuestionController({
        input: document.createElement('textarea'),
        submitAnswers: () => 'response-1',
        stop() {},
        onDraftChange() {},
        onComposerModeChange() {},
        onResolved() {},
      });
      document.body.append(controller.root);
      controller.request({
        interactionId: 'interaction-1',
        providerRequestId: 'provider-1',
        threadId: 'thread-1',
        turnId: 'turn-1',
        agent: 'codex',
        source: 'native',
        createdAt: '2026-10-10T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
        questions: [{
          id: 'q1',
          header: hostile,
          question: hostile,
          mode: 'single',
          options: [{ id: 'a', label: hostile, description: hostile }],
          allowOther: false,
        }],
      });
      await new Promise((settle) => setTimeout(settle, 50));
      return {
        images: controller.root.querySelectorAll('img').length,
        injected: (window as unknown as { __injected?: boolean }).__injected === true,
        showsText: controller.root.textContent?.includes(hostile) ?? false,
      };
    }, HOSTILE);
    assert.deepEqual(result, { images: 0, injected: false, showsText: true });
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await closeHarness(page);
  }
});

test('reference names and search snippets from the hub render as text', { timeout: 60_000 }, async () => {
  const page = await harness();
  try {
    await page.evaluate(async (hostile) => {
      const { createReferenceLibrary } = await import('/src/ui/agent-sidebar/reference-library.ts');
      const file = {
        id: 'ref-1', scope: 'global', scopeId: 'global', name: `${hostile}.pdf`, mimeType: 'application/pdf',
        size: 10, status: 'ready', createdAt: '2026-10-10T00:00:00.000Z', kind: 'document',
      };
      const bridge = {
        getConnectionState: () => 'connected',
        getActiveAgent: () => 'codex',
        getPendingUserQuestion: () => null,
        listReferences: async () => [file],
        searchReferences: async () => [{
          referenceId: 'ref-1', name: file.name, scope: 'global', scopeId: 'global', score: 1, snippet: hostile,
        }],
      };
      const library = createReferenceLibrary({
        bridge: bridge as never,
        getContext: () => ({ threadId: 'thread-1', documentId: null, documentName: null }),
      });
      document.body.append(library.page);
      library.setOpen(true, 'global');
    }, HOSTILE);
    await page.waitForFunction(() => document.querySelector('.ag-reference-file-name') !== null);
    const listed = await page.evaluate(() => ({
      name: document.querySelector('.ag-reference-file-name')?.textContent,
      images: document.querySelectorAll('img').length,
    }));
    assert.deepEqual(listed, { name: `${HOSTILE}.pdf`, images: 0 });

    await page.$eval('.ag-reference-search', (node) => {
      (node as HTMLInputElement).value = 'onerror';
      node.dispatchEvent(new Event('input'));
    });
    await page.waitForFunction(() => document.querySelector('.ag-reference-search-snippet') !== null);
    assert.equal(await page.$eval('.ag-reference-search-snippet', (node) => node.textContent), HOSTILE);
    assert.deepEqual(await page.evaluate(() => ({
      images: document.querySelectorAll('img').length,
      injected: (window as unknown as { __injected?: boolean }).__injected === true,
    })), { images: 0, injected: false });
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await closeHarness(page);
  }
});

test('chat threads migrate from localStorage into IndexedDB and survive a reload', { timeout: 60_000 }, async () => {
  const page = await harness();
  try {
    await page.evaluate(() => {
      localStorage.setItem('hamaeditor-agent-threads', JSON.stringify([{
        id: 'legacy-thread', title: '예전 채팅', createdAt: 1, updatedAt: 2,
        agent: 'claude', model: 'sonnet', effort: 'high',
        messages: [{ role: 'user', text: '표 제목을 고쳐줘' }],
      }]));
    });
    const migrated = await page.evaluate(async () => {
      const threads = await import('/src/agent/threads.ts');
      await threads.waitForThreadsPersistence();
      const fresh = threads.createEmptyThread({ agent: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
      fresh.messages.push({ role: 'user', text: '새 채팅' });
      threads.upsertThread(fresh);
      await threads.waitForThreadsPersistence();
      return {
        ids: threads.listThreads().map((thread) => thread.id),
        freshId: fresh.id,
        legacyKeyLeft: localStorage.getItem('hamaeditor-agent-threads') !== null,
      };
    });
    assert.ok(migrated.ids.includes('legacy-thread'));
    assert.equal(migrated.legacyKeyLeft, false, 'the legacy copy is removed only after IndexedDB holds it');

    await page.reload();
    const reloaded = await page.evaluate(async () => {
      const threads = await import('/src/agent/threads.ts');
      await threads.waitForThreadsPersistence();
      return {
        ids: threads.listThreads().map((thread) => thread.id),
        legacyText: threads.getThread('legacy-thread')?.messages[0]?.text,
      };
    });
    assert.deepEqual(reloaded.ids.sort(), [migrated.freshId, 'legacy-thread'].sort());
    assert.equal(reloaded.legacyText, '표 제목을 고쳐줘');
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await closeHarness(page);
  }
});

test('font search ignores Enter while a Korean IME composition is active', { timeout: 60_000 }, async () => {
  const page = await harness();
  try {
    const result = await page.evaluate(async () => {
      const { Toolbar } = await import('/src/ui/toolbar.ts');
      const selected: string[] = [];
      const fontName = document.createElement('input');
      document.body.append(fontName);
      const toolbar = Object.assign(Object.create(Toolbar.prototype), {
        fontName,
        fontMenu: null,
        fontMenuCleanup: null,
        fontMenuQuery: '',
        fontMenuCategory: 'document',
        fontMenuDocumentFonts: ['맑은 고딕', '함초롬바탕'],
        selectFontMenuEntry: (value: string) => { selected.push(value); },
      });
      toolbar.openFontMenu();
      const search = document.querySelector<HTMLInputElement>('.font-picker-menu input')!;
      search.value = '고딕';
      search.dispatchEvent(new Event('input'));
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
      const duringComposition = [...selected];
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { duringComposition, afterComposition: selected };
    });
    assert.deepEqual(result, { duringComposition: [], afterComposition: ['맑은 고딕'] });
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await closeHarness(page);
  }
});

test('highlight palette closes on Escape, returns focus, and keeps its color input out of Tab order', { timeout: 60_000 }, async () => {
  const page = await harness();
  try {
    await page.evaluate(async () => {
      const { Toolbar } = await import('/src/ui/toolbar.ts');
      const container = document.createElement('div');
      container.innerHTML = `
        <div id="highlight-dropdown"><button id="btn-highlight">형광펜</button><div id="highlight-palette"></div></div>
        <button id="after">다음</button>`;
      document.body.append(container);
      const toolbar = Object.assign(Object.create(Toolbar.prototype), {
        container,
        highlightColor: '#ffff00',
        highlightBar: document.createElement('span'),
        highlightDropdown: container.querySelector('#highlight-dropdown'),
        btnHighlight: container.querySelector('#btn-highlight'),
        eventBus: { emit() {} },
      });
      toolbar.setupHighlightPicker();
    });
    await page.click('#btn-highlight');
    assert.equal(await page.$eval('#highlight-dropdown', (node) => node.classList.contains('open')), true);

    const other = await page.evaluateHandle(() => [...document.querySelectorAll('#highlight-palette button')]
      .find((button) => button.textContent === '다른 색...')!);
    await (other as unknown as { focus(): Promise<void> }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'after',
      'Tab skips the hidden color input');

    await (other as unknown as { focus(): Promise<void> }).focus();
    await page.keyboard.press('Escape');
    assert.deepEqual(await page.evaluate(() => ({
      open: document.querySelector('#highlight-dropdown')!.classList.contains('open'),
      focused: document.activeElement?.id,
    })), { open: false, focused: 'btn-highlight' });
    assert.deepEqual(pageErrors(page), []);
  } finally {
    await closeHarness(page);
  }
});

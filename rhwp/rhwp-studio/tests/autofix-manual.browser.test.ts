// 제목 막대의 자동 수정 단추: 명령 검색 왼쪽에 서고 설정을 따라 붙고 빠진다. 시트에 지금 상태를 적어 보내면
// 그 글이 요청이 되고, 고친 뒤의 답이 확인 결과로 나가며, 아직 안 되면 글을 남겨 다시 고칠 수 있다.
import assert from 'node:assert/strict';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

test('the title-bar autofix button sends the described state and reports whether the fix held', { timeout: 60_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'manual-autofix-harness', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/manual-autofix') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><nav id="menu-bar"><div class="menu-item"><span class="menu-title">파일</span></div><span id="editor-document-title">문서.hwp</span><button type="button" id="editor-command-search" class="editor-command-search">명령 검색</button></nav></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.setViewport({ width: 1100, height: 760 });
    await page.goto(`http://127.0.0.1:${address.port}/manual-autofix`);
    await page.evaluate(async () => {
      await import('../src/style.css');
      const { setAutofixApi } = await import('../src/ui/autofix/autofix.ts');
      const { installManualAutofix } = await import('../src/ui/autofix/autofix-manual.ts');
      let settings = {
        enabled: true, decided: true,
        providers: [{ id: 'codex', enabled: true, model: 'sol', effort: 'low' }, { id: 'claude', enabled: true, model: 'claude-sonnet-5-5', effort: 'medium' }],
      };
      const listeners = new Set<(next: typeof settings) => void>();
      const state = { requests: [] as unknown[], outcomes: [] as unknown[], reports: 0, release: null as null | ((value: unknown) => void), runs: 0 };
      Object.assign(window, { autofixState: state });
      setAutofixApi({
        run: (request: unknown) => new Promise((resolve) => { state.requests.push(request); state.runs += 1; state.release = resolve; }),
        getSettings: async () => settings,
        setSettings: async (patch: Partial<typeof settings>) => { settings = { ...settings, ...patch }; for (const listener of listeners) listener(settings); return settings; },
        onChange: (callback: (next: typeof settings) => void) => { listeners.add(callback); return () => listeners.delete(callback); },
        prewarm: async () => ({ ready: true }),
        outcome: async (outcome: unknown) => { state.outcomes.push(outcome); return true; },
      } as never);
      installManualAutofix({ reportIssue: () => { state.reports += 1; } });
    });
    const state = () => page.evaluate(() => {
      const value = (window as any).autofixState;
      return { requests: value.requests, outcomes: value.outcomes, reports: value.reports, runs: value.runs };
    });
    const release = (result: unknown) => page.evaluate((value) => (window as any).autofixState.release(value), result as never);
    const view = () => page.$eval('.afm-sheet', (sheet) => (sheet as HTMLElement).dataset.view).catch(() => null);
    const visibleButtons = () => page.$$eval('.afm-sheet .ag-sheet-actions button', (buttons) => buttons.filter((button) => !(button as HTMLElement).hidden).map((button) => button.textContent));

    // 단추는 설정을 읽은 뒤 명령 검색 바로 왼쪽에 붙는다.
    await page.waitForSelector('#editor-autofix-manual');
    assert.equal(await page.$eval('#editor-command-search', (search) => search.previousElementSibling?.id), 'editor-autofix-manual');
    const [tool, search] = await Promise.all([page.$('#editor-autofix-manual'), page.$('#editor-command-search')]);
    const [toolBox, searchBox] = await Promise.all([tool!.boundingBox(), search!.boundingBox()]);
    assert.ok(toolBox && searchBox);
    assert.ok(toolBox.x + toolBox.width <= searchBox.x && searchBox.x - (toolBox.x + toolBox.width) < 12, 'it sits just left of the search box');

    // 끄면 빠지고 켜면 다시 붙는다.
    await page.evaluate(async () => (await import('../src/ui/autofix/autofix.ts')).updateAutofixSettings({ enabled: false }));
    assert.equal(await page.$('#editor-autofix-manual'), null);
    await page.evaluate(async () => (await import('../src/ui/autofix/autofix.ts')).updateAutofixSettings({ enabled: true }));
    await page.waitForSelector('#editor-autofix-manual');

    // 적어 보내면 그 글이 요청이 된다. 빈 글은 보낼 수 없다.
    await page.click('#editor-autofix-manual');
    await page.waitForSelector('.afm-sheet');
    assert.equal(await view(), 'form');
    assert.equal(await page.$eval('.afm-sheet .ag-sheet-confirm', (button) => (button as HTMLButtonElement).disabled), true);
    await page.type('.afm-message', '사이드바가 연결 중에서 멈춰요');
    await page.keyboard.down('Shift'); await page.keyboard.press('Enter'); await page.keyboard.up('Shift');
    await page.type('.afm-message', '다시 연결도 안 돼요');
    await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.afm-sheet')?.dataset.view === 'running');
    assert.deepEqual((await state()).requests, [{
      surface: 'manual', title: '사이드바가 연결 중에서 멈춰요', detail: '사이드바가 연결 중에서 멈춰요\n다시 연결도 안 돼요', attempts: 0,
    }]);
    assert.equal(await page.$eval('#editor-autofix-manual', (button) => (button as HTMLElement).dataset.running), 'true');
    assert.deepEqual(await visibleButtons(), ['닫기']);
    // 고치는 동안 픽셀 하마가 움직이고 지난 시간을 센다.
    const hamaPixels = () => page.$eval('.afm-hama', (canvas) => {
      const element = canvas as HTMLCanvasElement;
      return Array.from(element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data).join(',');
    });
    const firstFrame = await hamaPixels();
    await page.waitForFunction((before) => {
      const element = document.querySelector<HTMLCanvasElement>('.afm-hama');
      if (!element) return false;
      return Array.from(element.getContext('2d')!.getImageData(0, 0, element.width, element.height).data).join(',') !== before;
    }, { timeout: 3000 }, firstFrame);
    assert.match(await page.$eval('.afm-elapsed', (node) => node.textContent ?? ''), /^고치는 중 · 0:0\d$/);

    // 고치면 원인을 글자로만 보이고 잘 되는지 묻는다. 아직 안 되면 글을 남겨 다시 고칠 수 있다.
    await release({ status: 'fixed', provider: 'codex', runId: 'r1', cause: '<b>잠금 파일</b>을 지웠습니다.' });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.afm-sheet')?.dataset.view === 'fixed');
    assert.equal(await page.$('.afm-hama'), null, 'the hippo leaves with the result');
    assert.equal(await page.$eval('.afm-cause', (cause) => cause.textContent), '원인: <b>잠금 파일</b>을 지웠습니다.');
    assert.equal(await page.$('.afm-cause b'), null, 'the agent text is never parsed as HTML');
    assert.equal(await page.$eval('#editor-autofix-manual', (button) => (button as HTMLElement).dataset.running ?? null), null);
    assert.deepEqual(await visibleButtons(), ['아직 안 돼요', '잘 돼요']);
    await page.click('.afm-sheet .ag-sheet-cancel:not(.afm-report)');
    assert.deepEqual((await state()).outcomes, [{ surface: 'manual', ok: false, runId: 'r1' }]);
    assert.equal(await view(), 'form');
    assert.equal(await page.$eval('.afm-message', (message) => (message as HTMLTextAreaElement).value), '사이드바가 연결 중에서 멈춰요\n다시 연결도 안 돼요');

    // 다시 고치고 이번에는 잘 된다.
    await page.click('.afm-sheet .ag-sheet-confirm');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.afm-sheet')?.dataset.view === 'running');
    await release({ status: 'fixed', runId: 'r2', cause: '허브를 다시 띄웠습니다.' });
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.afm-sheet')?.dataset.view === 'fixed');
    await page.click('.afm-sheet .ag-sheet-confirm');
    assert.deepEqual((await state()).outcomes.at(-1), { surface: 'manual', ok: true, runId: 'r2' });
    await page.waitForFunction(() => !document.querySelector('.afm-sheet'));

    // 고치는 중에 닫아도 이어서 돌고, 못 고치면 토스트에서 결과를 다시 열어 버그 제보로 넘어간다.
    await page.click('#editor-autofix-manual');
    await page.waitForSelector('.afm-sheet');
    assert.equal(await page.$eval('.afm-message', (message) => (message as HTMLTextAreaElement).value), '', 'an answered fix clears the text');
    await page.type('.afm-message', '표가 안 그려져요');
    await page.click('.afm-sheet .ag-sheet-confirm');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.afm-sheet')?.dataset.view === 'running');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.afm-sheet'));
    await release({ status: 'failed', runId: 'r3', cause: '원인을 찾지 못했습니다.' });
    await page.waitForFunction(() => [...document.querySelectorAll('.rhwp-toast button, .rhwp-toast a')].some((node) => node.textContent === '결과 보기'));
    await page.evaluate(() => ([...document.querySelectorAll<HTMLElement>('.rhwp-toast button, .rhwp-toast a')].find((node) => node.textContent === '결과 보기'))!.click());
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.afm-sheet')?.dataset.view === 'failed');
    assert.equal(await page.$eval('.afm-cause', (cause) => cause.textContent), '원인: 원인을 찾지 못했습니다.');
    assert.deepEqual(await visibleButtons(), ['닫기', '버그 제보']);
    await page.click('.afm-report');
    assert.equal((await state()).reports, 1);
    assert.equal((await state()).runs, 3);
    assert.equal((await state()).outcomes.length, 2, 'a failed run asks nothing');
  } finally { await browser?.close(); await server.close(); }
});

test('the autofix button stays glued to the left of the search box in every title-bar layout, after the license pill', { timeout: 60_000 }, async () => {
  const server = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, logLevel: 'silent', server: { host: '127.0.0.1', port: 0 },
    plugins: [{ name: 'manual-autofix-layout', configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url !== '/manual-autofix-layout') return next();
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body><nav id="menu-bar"><div class="menu-item"><span class="menu-title">파일</span></div><span id="editor-document-title">문서.hwp</span><button type="button" id="editor-command-search" class="editor-command-search">명령 검색<kbd>Ctrl+/</kbd></button></nav></body></html>');
      });
    } }],
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen(); const address = server.httpServer!.address(); assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
    const page = await browser.newPage(); await page.setViewport({ width: 1200, height: 600 });
    await page.goto(`http://127.0.0.1:${address.port}/manual-autofix-layout`);
    await page.evaluate(async () => {
      await import('../src/style.css');
      await import('../src/ui/license-gate.css');
      const { setAutofixApi } = await import('../src/ui/autofix/autofix.ts');
      const { installManualAutofix } = await import('../src/ui/autofix/autofix-manual.ts');
      const settings = { enabled: true, decided: true, providers: [] };
      setAutofixApi({
        run: async () => ({ status: 'failed' }), getSettings: async () => settings, setSettings: async () => settings, onChange: () => () => {},
      } as never);
      installManualAutofix();
    });
    await page.waitForSelector('#editor-autofix-manual');
    const measure = (htmlClass: string, titleHidden: boolean, pill: boolean, width: number) => page.evaluate(async (cls, hidden, withPill, viewport) => {
      document.documentElement.className = cls;
      document.getElementById('editor-document-title')!.hidden = hidden;
      document.querySelector('.license-pill')?.remove();
      if (withPill) {
        // license-gate.ts 와 같은 자리: 자동 수정 단추가 검색 바로 왼쪽에 있으면 그 앞.
        const search = document.getElementById('editor-command-search')!;
        const pillNode = document.createElement('button');
        pillNode.className = 'license-pill';
        pillNode.textContent = '체험 7일 남음';
        const autofix = search.previousElementSibling?.id === 'editor-autofix-manual' ? search.previousElementSibling : null;
        (autofix ?? search).before(pillNode);
      }
      document.body.style.width = `${viewport}px`;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = (selector: string) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { left: box.left, right: box.right, top: box.top } : null;
      };
      return { tool: rect('#editor-autofix-manual'), search: rect('#editor-command-search'), pill: rect('.license-pill') };
    }, htmlClass, titleHidden, pill, width);
    for (const htmlClass of ['', 'desktop-mac desktop-native-menu', 'desktop-windows']) {
      for (const titleHidden of [false, true]) {
        for (const pill of [false, true]) {
          for (const width of [1200, 700]) {
            const label = `${htmlClass || 'web'} title ${titleHidden ? 'hidden' : 'shown'} pill ${pill} width ${width}`;
            const { tool, search, pill: pillBox } = await measure(htmlClass, titleHidden, pill, width);
            assert.ok(tool && search, label);
            assert.equal(tool.top, search.top, `${label}: same row`);
            const gap = search.left - tool.right;
            assert.ok(gap >= 0 && gap < 12, `${label}: gap ${gap}`);
            if (pillBox && htmlClass === 'desktop-windows') {
              // Windows 제목 막대는 검색이 메뉴 단추 옆(왼쪽)에, 알약이 오른쪽 끝에 선다.
              assert.ok(pillBox.left > search.right, `${label}: pill stays at the right end`);
            } else if (pillBox) {
              const pillGap = tool.left - pillBox.right;
              assert.ok(pillGap >= 0 && pillGap < 16, `${label}: pill gap ${pillGap}`);
            }
          }
        }
      }
    }
  } finally { await browser?.close(); await server.close(); }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// Mount production modules; the sidebar service boundary is the explicitly labeled preview fixture.
let server: any, browser: any, origin: string, cache: string;
test.before(async () => {
  cache = await mkdtemp(resolve(tmpdir(), 'rau-regression-review-'));
  server = await createServer({
    cacheDir: cache,
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false, hmr: false },
    logLevel: 'error',
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({
    executablePath: browserExecutable(),
    headless: true,
    args: browserLaunchArgs(),
  });
});
test.after(async () => {
  await browser?.close();
  await server?.close();
  if (cache) await rm(cache, { recursive: true, force: true });
});
async function open(t: any, query = '') {
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], 'Uncaught browser errors'));
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  await page.goto(`${origin}/?controls=1&reset=1&${query}`);
  await page.waitForFunction(
    () =>
      (window as any).sidebarPreview &&
      !(document.querySelector('.ag-input') as HTMLInputElement).disabled,
  );
  return page;
}
async function clickText(page: any, selector: string, text: string) {
  const clicked = await page.evaluate(
    (selector: string, text: string) => {
      const b = [
        ...document.querySelectorAll<HTMLButtonElement>(selector),
      ].find((b) => b.textContent?.trim() === text && b.checkVisibility());
      b?.click();
      return !!b;
    },
    selector,
    text,
  );
  assert(clicked, `Visible action: ${text}`);
}

test('settings keyboard entry exposes the named region and dirty exit preserves, discards or persists the draft', async (t) => {
  const page = await open(t);
  await page.focus('.ag-settings-btn');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ag-root.ag-settings-open');
  assert.equal(
    await page
      .$eval('#ag-settings-panel', (el: HTMLElement) => ({
        role: el.getAttribute('role'),
        name: el.getAttribute('aria-label'),
        visible: el.checkVisibility(),
      }))
      .then((v: any) => v.role === 'region' && v.name === '설정' && v.visible),
    true,
  );
  await page.click('[data-destination="editing"]');
  const toggle = '#ag-settings-pane-editing input[aria-label="문단 부호"]';
  const before = await page.evaluate(
    async () =>
      (
        await import('/src/core/user-settings.ts')
      ).userSettings.getViewSettings().showParagraphMarks,
  );
  await page.click(toggle);
  const draft = !before;
  await page.click('.ag-settings-close');
  await page.waitForSelector('.ag-settings-dirty-dialog');
  assert.equal(
    await page.$eval('.ag-settings-dirty-dialog', (el: HTMLElement) =>
      el.getAttribute('aria-modal'),
    ),
    'true',
  );
  await clickText(page, '.ag-settings-dirty-dialog button', '계속 편집');
  assert.equal(
    await page.$eval(toggle, (el: HTMLInputElement) => el.checked),
    draft,
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await import('/src/core/user-settings.ts')
        ).userSettings.getViewSettings().showParagraphMarks,
    ),
    before,
  );
  await page.click('.ag-settings-close');
  await clickText(page, '.ag-settings-dirty-dialog button', '버리기');
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.ag-root')!
        .classList.contains('ag-settings-open'),
  );
  await page.click('.ag-settings-btn');
  await page.click('[data-destination="editing"]');
  assert.equal(
    await page.$eval(toggle, (el: HTMLInputElement) => el.checked),
    before,
  );
  await page.click(toggle);
  await page.click('.ag-settings-close');
  await clickText(page, '.ag-settings-dirty-dialog button', '적용');
  await page.waitForFunction(
    () =>
      !document
        .querySelector('.ag-root')!
        .classList.contains('ag-settings-open'),
  );
  await page.reload();
  await page.waitForFunction(() => (window as any).sidebarPreview);
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await import('/src/core/user-settings.ts')
        ).userSettings.getViewSettings().showParagraphMarks,
    ),
    draft,
  );
});

test('plan approval is locked during transition and produces one implementation request', async (t) => {
  const page = await open(t, 'scenario=plan');
  await page.evaluate(() => {
    const bridge = (window as any).sidebarPreview.bridge;
    (window as any).reviewApprovals = [];
    (window as any).reviewMessages = [];
    const send = bridge.sendUserMessage.bind(bridge);
    bridge.sendUserMessage = (...args: any[]) => {
      (window as any).reviewMessages.push(args);
      return send(...args);
    };
    const original = bridge.approvePlan.bind(bridge);
    bridge.approvePlan = (id: string) => {
      (window as any).reviewApprovals.push(id);
      return original(id);
    };
  });
  await page.click('#play');
  await page.waitForSelector('.ag-plan-approve:not(:disabled)', {
    visible: true,
  });
  assert.equal(
    await page.evaluate(
      () => (window as any).sidebarPreview.bridge.getWorkflowState().phase,
    ),
    'awaiting-approval',
  );
  await page.evaluate(() => {
    (window as any).reviewMessages = [];
  });
  await page.evaluate(() => {
    const b = document.querySelector<HTMLButtonElement>('.ag-plan-approve')!;
    b.click();
    b.click();
  });
  await page.waitForFunction(
    () =>
      (window as any).sidebarPreview.bridge.getWorkflowState().phase ===
      'switching',
  );
  await page.$eval('.ag-input', (el: HTMLInputElement) => {
    el.value = 'Hold this draft';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  assert.deepEqual(
    await page.evaluate(() => (window as any).reviewMessages),
    [],
  );
  assert.equal(
    await page.$eval('.ag-input', (el: HTMLInputElement) => el.value),
    'Hold this draft',
  );
  await page.waitForFunction(
    () =>
      (window as any).sidebarPreview.bridge.getWorkflowState().phase ===
      'implementing',
  );
  assert.equal(
    await page.evaluate(() => (window as any).reviewApprovals.length),
    1,
  );
});

test('mode changes are blocked during an active turn and entering 전체 requires confirmation', async (t) => {
  const page = await open(t, 'scenario=chat');
  const chip = '.ag-mode-btn';
  const before = await page.$eval(chip, (b: HTMLButtonElement) => b.textContent);
  assert.equal(before, '에이전트');
  await page.click('#play');
  await page.waitForFunction(() =>
    (window as any).sidebarPreview.bridge.isTurnRunning(),
  );
  assert.equal(await page.$eval(chip, (b: HTMLButtonElement) => b.disabled), true);
  await page.$eval(chip, (b: HTMLButtonElement) => b.click());
  assert.equal(
    await page.$eval('.ag-mode', (el: HTMLElement) => el.classList.contains('ag-model-open')),
    false,
  );
  await page.waitForFunction(
    () => !(window as any).sidebarPreview.bridge.isTurnRunning(),
  );
  await page.waitForFunction(
    () => !(document.querySelector('.ag-mode-btn') as HTMLButtonElement).disabled,
  );
  await page.click(chip);
  await page.waitForSelector('.ag-mode-item[data-mode="full"]', { visible: true });
  await page.click('.ag-mode-item[data-mode="full"]');
  await page.waitForSelector(
    '.ag-sheet-layer.ag-sheet-open .ag-sheet-confirm',
    { visible: true },
  );
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval(chip, (b: HTMLButtonElement) => b.textContent), before);
});

test('toolbar boundary inputs emit bounded formats and keyboard increments do not duplicate them', async (t) => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const { Toolbar } = await import('/src/ui/toolbar.ts');
    const calls: any[] = [];
    const toolbar: any = Object.create(Toolbar.prototype);
    for (const name of ['fontName', 'fontLang', 'lsSelect']) {
      const s = document.createElement('select');
      s.innerHTML = '<option value="160">160</option>';
      document.body.append(s);
      toolbar[name] = s;
    }
    toolbar.fontSize = document.createElement('input');
    document.body.append(toolbar.fontSize);
    for (const name of ['btnSizeUp', 'btnSizeDown', 'btnLsUp', 'btnLsDown']) {
      toolbar[name] = document.createElement('button');
      document.body.append(toolbar[name]);
    }
    toolbar.enabled = true;
    toolbar.eventBus = {
      emit: (id: string, value: any) => calls.push({ id, value }),
    };
    toolbar.dispatcher = {
      dispatch: (id: string, value: any) => calls.push({ id, value }),
    };
    toolbar.setupFontControls();
    toolbar.setupLineSpacingDropdown();
    const sizes = [];
    for (const [value, expected] of [
      ['0.5', 100],
      ['12', 1200],
      ['9999', 409600],
    ]) {
      toolbar.fontSize.value = value;
      toolbar.fontSize.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter' }),
      );
      sizes.push([calls.at(-1).value.fontSize, expected]);
    }
    for (const value of ['', 'invalid', '-5', '0']) {
      const n = calls.length;
      toolbar.fontSize.value = value;
      toolbar.fontSize.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter' }),
      );
      if (calls.length !== n) throw new Error('Invalid font input was applied');
    }
    toolbar.fontSize.value = '4096';
    const n = calls.length;
    toolbar.btnSizeUp.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    const increment = {
      count: calls.length - n,
      size: calls.at(-1).value.fontSize,
    };
    const spacing = [];
    for (const value of ['900', '300', 'invalid', '-1']) {
      toolbar.lsSelect.dispatchEvent(new MouseEvent('dblclick'));
      const input = toolbar.lsSelect.previousElementSibling as HTMLInputElement;
      input.value = value;
      const n = calls.length;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      spacing.push({
        value,
        emitted: calls.length - n,
        applied: calls.length > n ? calls.at(-1).value.value : null,
      });
    }
    toolbar.ensureLsOption(500);
    toolbar.lsSelect.value = '500';
    toolbar.btnLsUp.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter' }),
    );
    return { sizes, increment, spacing, last: calls.at(-1).value.value };
  });
  for (const [actual, expected] of result.sizes) assert.equal(actual, expected);
  assert.deepEqual(result.increment, { count: 1, size: 409600 });
  assert.deepEqual(result.spacing, [
    { value: '900', emitted: 1, applied: 500 },
    { value: '300', emitted: 1, applied: 300 },
    { value: 'invalid', emitted: 0, applied: null },
    { value: '-1', emitted: 0, applied: null },
  ]);
  assert.equal(result.last, 500);
});

test('production registry exposes shortcut metadata without parsing source text', async (t) => {
  const page = await open(t);
  const actual = await page.evaluate(async () => {
    const [
      { CommandRegistry },
      { viewCommands },
      { formatCommands },
      { tableCommands },
    ] = await Promise.all([
      import('/src/command/registry.ts'),
      import('/src/command/commands/view.ts'),
      import('/src/command/commands/format.ts'),
      import('/src/command/commands/table.ts'),
    ]);
    const registry = new CommandRegistry();
    registry.registerAll([
      ...viewCommands,
      ...formatCommands,
      ...tableCommands,
    ]);
    return Object.fromEntries(
      [
        'view:zoom-fit-page',
        'view:zoom-fit-width',
        'format:font-size-increase',
        'format:line-spacing-increase',
        'table:insert-row-col',
        'table:delete-row-col',
      ].map((id) => [id, registry.get(id)?.shortcutLabel]),
    );
  });
  assert.deepEqual(actual, {
    'view:zoom-fit-page': 'Ctrl+G,P',
    'view:zoom-fit-width': 'Ctrl+G,W',
    'format:font-size-increase': 'Alt+Shift+E',
    'format:line-spacing-increase': 'Alt+Shift+Z',
    'table:insert-row-col': 'Alt+Enter',
    'table:delete-row-col': 'Alt+Delete',
  });
});

test('chat markdown and reference search treat hostile markup as data', async (t) => {
  const page = await open(t);
  const rendered = await page.evaluate(async () => {
    const { renderChatMarkdown } =
      await import('/src/ui/agent-sidebar/chat-markdown.ts');
    const target = document.createElement('div');
    document.body.append(target);
    (window as any).reviewInjected = false;
    renderChatMarkdown(
      target,
      '<img src=x onerror="window.reviewInjected=true">\n\n[unsafe](javascript:alert(1))',
    );
    return {
      text: target.textContent,
      images: target.querySelectorAll('img').length,
      unsafe: [...target.querySelectorAll('a')].some(
        (a) => a.protocol === 'javascript:',
      ),
      injected: (window as any).reviewInjected,
    };
  });
  assert.match(rendered.text, /<img/);
  assert.equal(rendered.images, 0);
  assert.equal(rendered.unsafe, false);
  assert.equal(rendered.injected, false);
  await page.evaluate(() => {
    (window as any).sidebarPreview.bridge.searchReferences = async () => [
      {
        referenceId: 'hostile',
        fileName: '<img src=x onerror=alert(1)>',
        snippet: '<script>window.reviewInjected=true</script>',
        page: 1,
      },
    ];
  });
  await page.click('.ag-references-btn');
  await page.type('.ag-reference-search', 'hostile');
  await page.waitForSelector('.ag-reference-search-hit', { visible: true });
  const hit = await page.$eval(
    '.ag-reference-search-hit',
    (el: HTMLElement) => ({
      text: el.textContent,
      injected: el.querySelectorAll('script,img').length,
    }),
  );
  assert.match(hit.text, /<script>/);
  assert.equal(hit.injected, 0);
});

test('streamed chat markdown matches fresh rendering and preserves completed content', async (t) => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const { renderChatMarkdown } = await import('/src/ui/agent-sidebar/chat-markdown.ts');
    const target = document.createElement('div');
    document.body.append(target);
    const extra = document.createElement('button');
    extra.textContent = '답변 복사';
    target.append(extra);
    const opening = '첫 문단\n\n';
    renderChatMarkdown(target, opening, { streaming: true });
    const first = target.querySelector('[data-md-block]');
    const source = opening + '## 제목\n\n- [x] 하나\n  설명\n- [ ] 둘\n\n'
      + '| 한글 | 값 |\n|---|---:|\n| 가 | **나** |\n\n'
      + '```md\n~~~\n\n코드\n```\n\n'
      + '$$\n가\n\n# 수식 안\n\n나\n$$\n\n끝';
    const body = (node: Element) => [...node.querySelectorAll(':scope > [data-md-block]')]
      .map((block) => block.outerHTML);
    const mismatches: number[] = [];
    for (let end = opening.length; end <= source.length; end += 1) {
      const chunk = source.slice(0, end);
      renderChatMarkdown(target, chunk, { streaming: true });
      const expected = document.createElement('div');
      renderChatMarkdown(expected, chunk, { streaming: true });
      if (JSON.stringify(body(target)) !== JSON.stringify(body(expected))) mismatches.push(end);
    }
    renderChatMarkdown(target, source);
    const final = document.createElement('div');
    renderChatMarkdown(final, source);
    const completed = JSON.stringify(body(target)) === JSON.stringify(body(final));
    const preserved = first === target.querySelector('[data-md-block]') && extra.parentElement === target;
    renderChatMarkdown(target, '교체한 답변');
    return {
      mismatches,
      completed,
      preserved,
      replaced: body(target).length === 1 && target.firstElementChild?.textContent === '교체한 답변',
      extraPreserved: extra.parentElement === target,
    };
  });
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.completed, true);
  assert.equal(result.preserved, true);
  assert.equal(result.replaced, true);
  assert.equal(result.extraPreserved, true);
});

test('keyboard skill selection sends the explicit skill and preserves the requested instruction', async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    (window as any).reviewSkillRequests = [];
    (window as any).sidebarPreview.bridge.sendUserMessage = async (
      ...args: any[]
    ) => {
      (window as any).reviewSkillRequests.push(args);
      return 'review-message';
    };
  });
  await page.type('.ag-input', '/proof');
  await page.waitForFunction(
    () =>
      document.querySelector('.ag-slash-menu')?.checkVisibility() &&
      document
        .querySelector('.ag-input')
        ?.getAttribute('aria-activedescendant'),
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ag-composer-skill', { visible: true });
  await page.type('.ag-input', 'Review this paragraph');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => (window as any).reviewSkillRequests.length === 1,
  );
  const [prompt, skill, referenceIds] = await page.evaluate(
    () => (window as any).reviewSkillRequests[0],
  );
  assert.equal(skill, 'proofread-korean');
  assert.match(prompt, /Review this paragraph/);
  assert.deepEqual(referenceIds, []);
});

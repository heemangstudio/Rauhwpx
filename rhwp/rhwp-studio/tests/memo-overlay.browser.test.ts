import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// 실제 Studio 에서 메모 풍선·앵커 강조·보기 토글·풍선 고치기·Ctrl+K,M 넣기를 사용자 조작으로
// 확인하고, 저장본을 다시 열어 바뀐 메모가 남는지 본다.

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const sample = resolve(studioRoot, '../samples/basic/NewYear_s_Day.hwp');
// RHWP_MEMO_SCREENSHOTS=<dir> 이면 화면을 남긴다.
const artifacts = process.env.RHWP_MEMO_SCREENSHOTS;

type MemoView = { count: number; highlights: number; texts: string[] };

test('메모 풍선 표시·보기 토글·고치기·Ctrl+K,M 넣기가 저장본까지 남는다', { timeout: 180_000 }, async () => {
  // 실제 vite 설정을 쓰되 허브는 다른 포트로 띄워 다른 작업 트리와 겹치지 않게 한다.
  process.env.RHWP_AGENT_PORT ??= '0';
  const server = await createServer({
    root: studioRoot,
    configFile: resolve(studioRoot, 'vite.config.ts'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, strictPort: false },
  });
  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address !== 'string');
    browser = await puppeteer.launch({
      executablePath: browserExecutable(),
      headless: true,
      args: browserLaunchArgs(),
      defaultViewport: { width: 1600, height: 1000 },
    });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'load' });
    // 문서 홈이 그려진 뒤에야 파일 입력 change 처리가 붙는다.
    await page.waitForFunction(() => document.body.innerText.includes('최근 문서'), { timeout: 60_000 });
    const input = await page.$('#file-input');
    await (input as any).uploadFile(sample);
    await page.waitForFunction(
      () => document.querySelectorAll('.memo-balloon').length === 9
        && !(document.querySelector('#document-home') as HTMLElement | null)?.checkVisibility(),
      { timeout: 90_000 },
    );

    const view = (): Promise<MemoView> => page.evaluate(() => ({
      count: document.querySelectorAll('.memo-balloon').length,
      highlights: document.querySelectorAll('.memo-anchor-highlight').length,
      texts: [...document.querySelectorAll('.memo-balloon-body')].map((el) => el.textContent ?? ''),
    }));
    const shown = await view();
    assert.equal(shown.count, 9, '풍선 9개');
    assert.ok(shown.highlights >= 9, '앵커 강조가 메모마다 있다');
    assert.ok(shown.texts.every((text) => text.length > 0), '풍선마다 본문이 보인다');
    if (artifacts) {
      mkdirSync(artifacts, { recursive: true });
      await page.screenshot({ path: resolve(artifacts, 'newyear-memos.png') });
    }

    // 보기 › 메모 끄기/켜기
    const toggle = () => page.evaluate(() => {
      (document.querySelector('.md-item[data-cmd="view:memo"]') as HTMLElement).click();
    });
    await toggle();
    await page.waitForFunction(() => document.querySelectorAll('.memo-balloon').length === 0);
    assert.equal((await view()).highlights, 0, '메모를 끄면 강조도 사라진다');
    await toggle();
    await page.waitForFunction(() => document.querySelectorAll('.memo-balloon').length === 9);

    // 풍선 본문을 눌러 고치고 Ctrl+Enter 로 확정
    await page.evaluate(() => document.querySelector('.memo-balloon')!.scrollIntoView({ block: 'center' }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.click('.memo-balloon .memo-balloon-body');
    await page.waitForSelector('.memo-balloon-editing .memo-balloon-body');
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.type('브라우저에서 고친 메모');
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await page.waitForFunction(
      () => [...document.querySelectorAll('.memo-balloon-body')].some((el) => el.textContent === '브라우저에서 고친 메모'),
    );

    type MemoState = {
      pos: { sectionIndex: number; paragraphIndex: number; charOffset: number };
      memos: Array<{
        fieldId: number; text: string; anchorText: string;
        anchor: { paraIdx: number; startCharIdx: number; endCharIdx: number } | null;
      }>;
      draft: boolean;
    };
    const state = (): Promise<MemoState> => page.evaluate(async () => {
      const { getMemoOverlay } = await import('/src/command/commands/memo.ts');
      const overlay = getMemoOverlay() as any;
      const ih = overlay.deps.getInputHandler();
      return {
        pos: ih.getCursorPosition(),
        memos: overlay.deps.wasm.getMemoNoteList().map((m: any) => ({
          fieldId: m.fieldId, text: m.text, anchorText: m.anchorText, anchor: m.anchor,
        })),
        draft: !!document.querySelector('.memo-balloon-draft'),
      };
    });
    // 캐럿을 문서 위치로 옮기고 편집기에 초점을 둔다. 실제로 옮겨졌는지 확인한다.
    const placeCaret = async (para: number, charOffset: number) => {
      const moved = await page.evaluate(async (para, charOffset) => {
        const { getMemoOverlay } = await import('/src/command/commands/memo.ts');
        const ih = (getMemoOverlay() as any).deps.getInputHandler();
        ih.moveCursorTo({ sectionIndex: 0, paragraphIndex: para, charOffset }, { center: true });
        ih.focus();
        return ih.getCursorPosition();
      }, para, charOffset);
      assert.deepEqual([moved.paragraphIndex, moved.charOffset], [para, charOffset], 'caret moved');
    };
    const chord = async (key: string) => {
      await page.keyboard.down('Control');
      await page.keyboard.press(key);
      await page.keyboard.up('Control');
    };
    const commandMemo = async () => {
      await chord('KeyK');
      await page.keyboard.press('KeyM');
    };
    const dispatch = (commandId: string) => page.evaluate((commandId) => {
      const item = document.querySelector(`#menu-bar .md-item[data-cmd="${commandId}"]`) as HTMLElement | null;
      if (!item) throw new Error(`no menu item ${commandId}`);
      item.click();
    }, commandId);
    const balloons = (n: number) =>
      page.waitForFunction((n) => document.querySelectorAll('.memo-balloon').length === n, { timeout: 10_000 }, n);

    // 메모가 없는 본문 문단의 둘째 낱말 가운데에 캐럿을 두고 Ctrl+K,M — 그 낱말에 메모가 달린다.
    const target = await page.evaluate(async () => {
      const { getMemoOverlay } = await import('/src/command/commands/memo.ts');
      const wasm = (getMemoOverlay() as any).deps.wasm;
      const used = new Set(wasm.getMemoNoteList().map((m: any) => m.anchor?.paraIdx));
      for (let p = 1; p < wasm.getParagraphCount(0); p++) {
        if (used.has(p)) continue;
        try {
          const chars = [...(wasm.getHyperlinkContext({ section: 0, para: p, cellPath: [] }).text as string)];
          const firstEnd = chars.findIndex((ch, i) => i > 0 && /\s/u.test(ch) && /\S/u.test(chars[i - 1]));
          if (firstEnd < 0) continue;
          let start = firstEnd;
          while (start < chars.length && /\s/u.test(chars[start])) start++;
          let end = start;
          while (end < chars.length && /[\p{L}\p{N}]/u.test(chars[end])) end++;
          if (end - start >= 2) return { para: p, start, end, word: chars.slice(start, end).join('') };
        } catch { /* 개체 문단 */ }
      }
      throw new Error('no paragraph with two words');
    });
    await placeCaret(target.para, target.start + 1);
    const memoCount = (await state()).memos.length;
    await commandMemo();
    await page.waitForSelector('.memo-balloon-draft .memo-balloon-body', { timeout: 10_000 });
    await page.keyboard.type('새로 넣은 메모');
    await chord('Enter');
    await balloons(memoCount + 1);
    const added = (await state()).memos.find((m) => m.text === '새로 넣은 메모');
    assert.ok(added, 'new memo');
    assert.deepEqual(
      [added.anchor?.paraIdx, added.anchor?.startCharIdx, added.anchor?.endCharIdx, added.anchorText],
      [target.para, target.start, target.end, target.word],
      'the memo anchors to the word under the caret',
    );
    if (artifacts) await page.screenshot({ path: resolve(artifacts, 'newyear-edited.png') });

    // 실행 취소·다시 실행 (편집기 단축키)
    await placeCaret(target.para, 0);
    await chord('KeyZ');
    await balloons(memoCount);
    await chord('KeyY');
    await balloons(memoCount + 1);

    // 빈 새 메모에서 Esc: 풍선이 사라지고 메모가 늘지 않는다.
    await placeCaret(target.para, 1);
    await commandMemo();
    await page.waitForSelector('.memo-balloon-draft .memo-balloon-body', { timeout: 10_000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.memo-balloon-draft'));
    const afterEsc = await state();
    assert.equal(afterEsc.memos.length, memoCount + 1, 'Esc adds no memo');

    // 이미 메모가 달린 낱말에서 Ctrl+K,M: 새 풍선 대신 그 메모 풍선이 편집 상태가 된다.
    const first = afterEsc.memos.find((m) => m.anchor && m.anchor.endCharIdx - m.anchor.startCharIdx >= 2
      && m.anchor.startCharIdx >= 1)!;
    await placeCaret(first.anchor!.paraIdx, first.anchor!.startCharIdx + 1);
    await commandMemo();
    await page.waitForFunction(
      (id) => document.querySelector('.memo-balloon-editing')?.getAttribute('data-memo-field-id') === String(id),
      { timeout: 10_000 }, first.fieldId,
    );
    assert.equal((await state()).draft, false, 'no draft over an existing memo');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.memo-balloon-editing'));

    // 기존 메모와 겹치는 선택에 메뉴로 메모 넣기: 풍선을 열지 않고 사유를 알린다.
    await page.evaluate(async (para, start, end) => {
      const { getMemoOverlay } = await import('/src/command/commands/memo.ts');
      const ih = (getMemoOverlay() as any).deps.getInputHandler();
      ih.focus();
      ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: para, charOffset: start });
      ih.cursor.setAnchor();
      ih.cursor.moveTo({ sectionIndex: 0, paragraphIndex: para, charOffset: end });
      if (!ih.hasSelection()) throw new Error('no selection');
    }, first.anchor!.paraIdx, first.anchor!.startCharIdx - 1, first.anchor!.startCharIdx + 1);
    await dispatch('insert:memo-note');
    await page.waitForFunction(() => document.body.innerText.includes('겹치는'), { timeout: 10_000 });
    assert.equal((await state()).draft, false, 'no dead draft balloon');
    assert.equal((await state()).memos.length, memoCount + 1);

    // 앵커 우클릭 메뉴를 그냥 닫은 뒤 메뉴의 메모 지우기는 캐럿의 메모를 지운다.
    const anchorPoint = (id: number) => page.evaluate((id) => {
      const el = document.querySelector(`.memo-anchor-highlight[data-memo-field-id="${id}"]`) as HTMLElement;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, id);
    const live = (await state()).memos.filter((m) => m.anchor && m.anchorText.length >= 2
      && m.text !== '브라우저에서 고친 메모' && m.text !== '새로 넣은 메모');
    const [memoA, memoB, memoC] = live;
    let point = await anchorPoint(memoA.fieldId);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await page.waitForSelector('.context-menu .md-item[data-cmd="memo:delete"]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.context-menu'));
    await placeCaret(memoB.anchor!.paraIdx, memoB.anchor!.startCharIdx + 1);
    // 명령 팔레트(Ctrl+/)에서 메모 지우기
    await chord('Slash');
    await page.waitForSelector('.cp-input', { visible: true });
    await page.keyboard.type('메모 지우기');
    await page.waitForFunction(
      () => document.querySelector('.cp-item--selected .cp-item-label')?.textContent === '메모 지우기',
      { timeout: 10_000 },
    );
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      (id) => !document.querySelector(`.memo-balloon[data-memo-field-id="${id}"]`), { timeout: 10_000 }, memoB.fieldId,
    );
    assert.ok((await state()).memos.some((m) => m.fieldId === memoA.fieldId), 'memo A is kept');

    // 앵커 우클릭 › 메모 지우기는 우클릭한 메모를 지운다.
    point = await anchorPoint(memoC.fieldId);
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await page.click('.context-menu .md-item[data-cmd="memo:delete"]');
    await page.waitForFunction(
      (id) => !document.querySelector(`.memo-balloon[data-memo-field-id="${id}"]`), { timeout: 10_000 }, memoC.fieldId,
    );

    // 풍선을 고치다 Ctrl+S: 풍선이 먼저 확정되고 저장 명령이 실행된다.
    await page.evaluate(async () => {
      const { getMemoOverlay } = await import('/src/command/commands/memo.ts');
      const overlay = getMemoOverlay() as any;
      const original = overlay.deps.matchAppShortcut;
      (window as any).__appShortcuts = [];
      // 실제 저장 대화상자는 띄우지 않는다 — 앱 단축키로 넘어온 명령만 기록한다.
      overlay.deps.matchAppShortcut = (e: KeyboardEvent) => original?.(e)
        ? () => { (window as any).__appShortcuts.push(e.key.toLowerCase()); }
        : null;
    });
    // 스크롤하면 풍선을 다시 그리므로 잡은 노드가 떨어질 수 있다 — 페이지 안에서 바로 누른다.
    await page.evaluate((id) => {
      const body = document.querySelector(`.memo-balloon[data-memo-field-id="${id}"] .memo-balloon-body`) as HTMLElement;
      body.click();
    }, memoA.fieldId);
    await page.waitForFunction(
      () => document.activeElement?.closest('.memo-balloon-editing') !== null
        && document.activeElement?.classList.contains('memo-balloon-body'),
      { timeout: 10_000 },
    );
    await chord('KeyA');
    await page.keyboard.type('저장 직전 메모');
    await chord('KeyS');
    await page.waitForFunction(() => !document.querySelector('.memo-balloon-editing'), { timeout: 10_000 });
    assert.deepEqual(await page.evaluate(() => (window as any).__appShortcuts), ['s'], 'Ctrl+S reached the app');
    assert.ok(
      (await state()).memos.some((m) => m.fieldId === memoA.fieldId && m.text === '저장 직전 메모'),
      'memo committed before the save command',
    );

    // HWP·HWPX 로 저장해 다시 열기
    const reopened = await page.evaluate(async () => {
      const { getMemoOverlay } = await import('/src/command/commands/memo.ts');
      const { WasmBridge } = await import('/src/core/wasm-bridge.ts');
      const wasm = (getMemoOverlay() as any).deps.wasm;
      const texts = (bridge: any) => bridge.getMemoNoteList().map((m: any) => m.text).sort();
      const out: Record<string, string[]> = {};
      for (const [name, bytes] of [['a.hwp', wasm.exportHwp()], ['a.hwpx', wasm.exportHwpx()]] as const) {
        const bridge = new WasmBridge();
        (bridge as any).initialized = true;
        bridge.loadDocument(bytes, name);
        out[name] = texts(bridge);
      }
      return { before: texts(wasm), ...out };
    });
    assert.ok(reopened.before.includes('브라우저에서 고친 메모'));
    assert.ok(reopened.before.includes('새로 넣은 메모'));
    assert.ok(reopened.before.includes('저장 직전 메모'));
    assert.deepEqual(reopened['a.hwp'], reopened.before, 'HWP 저장본');
    assert.deepEqual(reopened['a.hwpx'], reopened.before, 'HWPX 저장본');
  } finally {
    await browser?.close();
    await server.close();
  }
});

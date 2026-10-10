/**
 * 정착한 턴 접기의 비용 — 실제 사이드바(미리보기 고정 데이터의 브리지)와 그 CSS 로 잰다.
 * 긴 턴을 접는 시간은 작업 수에 비례하고, 도착한 단계의 등장 애니메이션은 문서에 쌓이지 않으며,
 * 접힌 본문은 그리지 않다가 펼칠 때 등장을 다시 돌리지 않고, 사용자가 접는 동안에는 그대로 보인다.
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
  cache = await mkdtemp(resolve(tmpdir(), 'rau-turn-fold-cost-'));
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

/** 움직임을 켠 채(등장 애니메이션이 실제로 돈다) 도구 단계를 steps 개 흘린 턴을 연다. */
async function openRunningTurn(t: any, steps: number): Promise<Page> {
  const context = await browser.createBrowserContext();
  t.after(() => context.close());
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'Uncaught browser errors'));
  await page.setViewport({ width: 1280, height: 900 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  await page.goto(`${origin}/?reset=1&theme=light&width=480&scenario=chat&hold=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => (window as any).sidebarPreview
    && document.querySelector<HTMLElement>('#agent-sidebar')?.dataset.composerReady === 'true', { timeout: 60_000 });
  await page.evaluate(() => document.querySelector<HTMLButtonElement>('#play')!.click());
  await page.waitForFunction(() => (window as any).sidebarPreview.bridge.isTurnRunning());
  await page.evaluate(async (count) => {
    const stream = (window as any).sidebarPreview.streamEvent;
    for (let i = 0; i < count; i += 1) {
      stream({ type: 'text-delta', agent: 'claude', text: `문단 ${i}을 고치겠습니다. ` });
      stream({ type: 'tool-call', agent: 'claude', callId: `cost-${i}`, tool: 'mcp__rhwp__apply_edits', argsJson: '{"expectedRevision":1,"edits":[]}' });
      stream({ type: 'tool-result', agent: 'claude', callId: `cost-${i}`, ok: true, resultPreview: '적용됨' });
      if (i % 10 === 9) await new Promise((done) => requestAnimationFrame(() => done(null)));
    }
  }, steps);
  // 등장 애니메이션이 모두 끝날 때까지 기다린다.
  await page.evaluate(() => Promise.all(document.querySelector('.ag-messages')!
    .getAnimations({ subtree: true })
    .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
    .map((animation) => animation.finished.catch(() => undefined))));
  return page;
}

test('arrived steps keep no finished entrance animations, so long turns do not slow every animation query', { timeout: 120_000 }, async (t) => {
  const page = await openRunningTurn(t, 40);
  const state = await page.evaluate(() => {
    const steps = [...document.querySelectorAll<HTMLElement>('.ag-messages .ag-progress-step')];
    return {
      steps: steps.length,
      held: steps.reduce((sum, step) => sum + step.getAnimations().length, 0),
      settled: steps.every((step) => getComputedStyle(step).opacity === '1'),
    };
  });
  assert.ok(state.steps >= 40, `tool steps arrived (${state.steps})`);
  assert.equal(state.held, 0, 'a step that finished arriving holds no animation');
  assert.equal(state.settled, true, 'arrived steps rest fully shown');
});

test('folding a long turn costs time proportional to its work', { timeout: 180_000 }, async (t) => {
  const page = await openRunningTurn(t, 20);
  const timings = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((entry) => entry.name)
      .find((name) => name.includes('/agent-sidebar/turn-fold.ts'))!;
    const fold = await import(/* @vite-ignore */ url);
    const messages = document.querySelector<HTMLElement>('.ag-messages')!;
    const work = [...messages.children].filter((node) => fold.isTurnWorkNode(node)) as HTMLElement[];
    const settle = () => Promise.all(messages.getAnimations({ subtree: true })
      .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
      .map((animation) => animation.finished.catch(() => undefined)));
    /** count 개의 작업 노드(실제 단계의 복제)를 대화에 붙여 다 도착시킨 뒤, 접힘에 옮기는 시간. */
    const adoptMs = async (count: number) => {
      const nodes = Array.from({ length: count }, (_, i) => work[i % work.length].cloneNode(true) as HTMLElement);
      const host = document.createElement('div');
      messages.append(host);
      host.append(...nodes);
      void messages.offsetHeight;
      await settle();
      const row = fold.createTurnFoldRow(`cost-${count}`);
      messages.append(row.root);
      void messages.offsetHeight;
      const started = performance.now();
      row.adopt(nodes);
      // 옮긴 뒤 다음 화면을 그릴 때 드는 스타일·배치까지 잰다.
      void messages.offsetHeight;
      const elapsed = performance.now() - started;
      row.root.remove();
      host.remove();
      void messages.offsetHeight;
      return elapsed;
    };
    const best = async (count: number) => {
      let min = Infinity;
      for (let run = 0; run < 3; run += 1) min = Math.min(min, await adoptMs(count));
      return min;
    };
    await best(50);
    return { small: await best(100), large: await best(400) };
  });
  // 비례하면 4배 남짓, 노드마다 문서의 애니메이션을 다시 훑으면 16배를 넘는다.
  assert.ok(timings.large <= timings.small * 8 + 40,
    `folding 400 work nodes took ${timings.large.toFixed(1)} ms vs ${timings.small.toFixed(1)} ms for 100`);
});

test('a folded turn is not rendered while closed, opens without replaying arrivals and stays visible while the user closes it', { timeout: 120_000 }, async (t) => {
  const page = await openRunningTurn(t, 12);
  await page.evaluate(() => (window as any).sidebarPreview.finishTurn());
  await page.waitForSelector('.ag-turn-fold:not([hidden]) .ag-turn-fold-toggle');
  const closed = await page.evaluate(() => {
    const body = document.querySelector<HTMLElement>('.ag-turn-fold .ag-turn-fold-body')!;
    const work = body.firstElementChild as HTMLElement | null;
    return { work: body.children.length, rendered: work?.checkVisibility() ?? null };
  });
  assert.ok(closed.work >= 1, 'the turn work moved into the fold');
  assert.equal(closed.rendered, false, 'closed fold content is not rendered');

  const opened = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.ag-turn-fold')!;
    root.querySelector<HTMLButtonElement>('.ag-turn-fold-toggle')!.click();
    const body = root.querySelector<HTMLElement>('.ag-turn-fold-body')!;
    const replaying = body.getAnimations({ subtree: true }).filter((animation) =>
      animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime));
    return {
      expanded: root.querySelector('.ag-turn-fold-toggle')!.getAttribute('aria-expanded'),
      rendered: (body.firstElementChild as HTMLElement).checkVisibility(),
      replaying: replaying.length,
    };
  });
  assert.deepEqual(opened, { expanded: 'true', rendered: true, replaying: 0 }, 'opening shows the work at rest');

  // 열리는 전환이 끝난 뒤 사용자가 다시 접는다 — 닫히는 동안은 그대로 그리고, 다 닫히면 그리지 않는다.
  await page.waitForFunction(() => document.querySelector('.ag-turn-fold-collapse')!.getAnimations().length === 0);
  const closing = await page.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.ag-turn-fold')!;
    root.querySelector<HTMLButtonElement>('.ag-turn-fold-toggle')!.click();
    const body = root.querySelector<HTMLElement>('.ag-turn-fold-body')!;
    return {
      expanded: root.querySelector('.ag-turn-fold-toggle')!.getAttribute('aria-expanded'),
      rendered: (body.firstElementChild as HTMLElement).checkVisibility(),
    };
  });
  assert.deepEqual(closing, { expanded: 'false', rendered: true }, 'the work stays drawn while it closes');
  await page.waitForFunction(() => (document.querySelector('.ag-turn-fold-body')!.firstElementChild as HTMLElement)
    .checkVisibility() === false, { timeout: 5_000 });
});

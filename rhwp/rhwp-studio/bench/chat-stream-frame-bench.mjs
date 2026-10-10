/**
 * 실제 사이드바에 긴 답변을 토큰 단위로 흘려 보내며 한 프레임에 드는 전체 비용
 * (스크립트·스타일·레이아웃)을 잰다. chat-stream-bench.mjs 는 Markdown 렌더만 재고,
 * 이 벤치는 따라가기 스크롤·끝 여백·최신 알약까지 포함한 사이드바 전체를 잰다.
 *
 * - foreground: 보이는 채팅에 답변이 흐른다.
 * - background: 같은 문서의 다른 채팅을 띄워 둔 채, 가려진 채팅에 답변이 흐른다.
 *   끝나면 그 채팅으로 돌아가 답변 전체가 보이는지 확인한다.
 *
 * 먼저 npm run dev:sidebar 를 실행한다.
 * 실행: node bench/chat-stream-frame-bench.mjs [--url=http://127.0.0.1:7715] [--runs=3]
 *       [--tokens-per-frame=4] [--json=out.json]
 */
import { writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from '../tests/browser-support.ts';

const options = new Map(process.argv.slice(2).map((argument) => {
  const separator = argument.indexOf('=');
  return separator < 0 ? [argument.slice(2), 'true'] : [argument.slice(2, separator), argument.slice(separator + 1)];
}));
const url = options.get('url') ?? 'http://127.0.0.1:7715';
const runs = Number(options.get('runs') ?? 3);
const tokensPerFrame = Number(options.get('tokens-per-frame') ?? 4);

const paragraph = '문서 내용을 검토하고 표와 본문의 연결을 확인합니다. **중요한 내용**과 [참고 링크](https://example.com)를 표시합니다. ';
const answer = Array.from({ length: 24 }, (_, index) => [
  `## 검토 ${index + 1}\n\n${paragraph.repeat(2)}\n\n`,
  index % 4 === 0 ? '1. 사업의 목적과 기대 효과를 명확히 작성합니다.\n2. 단계별 일정과 담당자를 확인합니다.\n3. 예산 항목을 다시 맞춥니다.\n\n' : '',
  index % 8 === 0 ? '```typescript\nconst message = "한글 문서 검토";\nconsole.log(message);\n```\n\n' : '',
  index % 10 === 0 ? '| 항목 | 결과 |\n| --- | --- |\n| 문단 | 확인 |\n| 표 | 확인 |\n\n' : '',
].join('')).join('');

/** Claude 의 한국어 토큰처럼 1~5자 조각으로 자른다. */
function tokenize(text) {
  const sizes = [3, 1, 4, 2, 5, 2, 3];
  const tokens = [];
  for (let at = 0, i = 0; at < text.length; i += 1) {
    const size = sizes[i % sizes.length];
    tokens.push(text.slice(at, at + size));
    at += size;
  }
  return tokens;
}
const tokens = tokenize(answer);

const METRICS = ['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'LayoutCount', 'RecalcStyleCount'];
async function metrics(cdp) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.filter(({ name }) => METRICS.includes(name)).map(({ name, value }) => [name, value]));
}

async function openPreview(page, query) {
  await page.goto(`${url}/?theme=light&width=480&reset=1&${query}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.click('#play');
  await page.waitForFunction(() => window.sidebarPreview.chats[0].mock.snapshot().running);
  // 샘플 답변이 끝까지 흐른 뒤(턴은 붙잡힌 채) 긴 답변을 이어 붙인다.
  await page.waitForFunction(() => document.querySelector('.ag-msg-assistant')?.textContent?.includes('단계별 일정과 담당자'));
}

/** 프레임마다 토큰 몇 개를 각자의 작업으로 보낸다 — 허브 WS 프레임이 하나씩 도착하는 모양. */
function streamTokens(page, chatIndex, idle = false) {
  return page.evaluate(async ({ chatIndex, tokens, tokensPerFrame, idle }) => {
    const { chats } = window.sidebarPreview;
    const stream = chats[chatIndex].mock.streamEvent;
    const gaps = [];
    const longTasks = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) longTasks.push(entry.duration);
    });
    try { observer.observe({ type: 'longtask' }); } catch {}
    let next = 0;
    let last = 0;
    await new Promise((resolve) => {
      const frame = (now) => {
        if (last) gaps.push(now - last);
        last = now;
        for (let i = 0; i < tokensPerFrame && next < tokens.length; i += 1) {
          const text = tokens[next++];
          if (!idle) setTimeout(() => stream({ type: 'text-delta', agent: 'claude', text }), 0);
        }
        if (next < tokens.length) requestAnimationFrame(frame);
        else setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 0);
      };
      requestAnimationFrame(frame);
    });
    observer.disconnect();
    gaps.sort((a, b) => a - b);
    return {
      frames: gaps.length + 1,
      p95GapMs: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
      maxGapMs: gaps.at(-1) ?? 0,
      slowFrames: gaps.filter((gap) => gap > 25).length,
      longTasks: longTasks.length,
      longTaskMs: longTasks.reduce((sum, value) => sum + value, 0),
    };
  }, { chatIndex, tokens, tokensPerFrame, idle });
}

/** idle: 같은 프레임 수 동안 토큰 없이 돌려, 화면이 원래 쓰는 비용(맥박 애니메이션 등)을 잰다. */
async function measure(page, cdp, chatIndex, idle = false) {
  const before = await metrics(cdp);
  const frames = await streamTokens(page, chatIndex, idle);
  const after = await metrics(cdp);
  const delta = Object.fromEntries(METRICS.map((name) => [name, after[name] - before[name]]));
  const ms = (name) => Math.round(delta[name] * 1000 * 10) / 10;
  return {
    ...frames,
    taskMs: ms('TaskDuration'),
    scriptMs: ms('ScriptDuration'),
    layoutMs: ms('LayoutDuration'),
    styleMs: ms('RecalcStyleDuration'),
    layouts: delta.LayoutCount,
    styleRecalcs: delta.RecalcStyleCount,
    taskMsPerFrame: Math.round((delta.TaskDuration * 1000 / frames.frames) * 100) / 100,
    layoutsPerFrame: Math.round((delta.LayoutCount / frames.frames) * 100) / 100,
  };
}

async function foreground(page, cdp) {
  await openPreview(page, 'scenario=chat&hold=1');
  const idle = await measure(page, cdp, 0, true);
  const result = { ...await measure(page, cdp, 0), idleTaskMs: idle.taskMs, idleStyleRecalcs: idle.styleRecalcs };
  const rendered = await page.evaluate(() => document.querySelector('.ag-msg-assistant')?.textContent ?? '');
  if (!rendered.includes('검토 23')) throw new Error('foreground answer did not render');
  return result;
}

async function background(page, cdp) {
  await openPreview(page, 'parallel=1&scenario=chat&hold=1');
  await page.click('.ag-header .ag-threads-btn');
  await page.waitForSelector('.ag-threads-new', { visible: true });
  await page.click('.ag-threads-new');
  await page.waitForFunction(() => window.sidebarPreview.chats[1]?.sidebar.isActive());
  const idle = await measure(page, cdp, 0, true);
  const result = { ...await measure(page, cdp, 0), idleTaskMs: idle.taskMs, idleStyleRecalcs: idle.styleRecalcs };
  // 돌아오면 가려져 있던 동안의 답변이 모두 보여야 한다(마지막 문단은 턴 끝까지 보류).
  await page.evaluate(() => window.sidebarPreview.showChat(0));
  await page.waitForFunction(() => window.sidebarPreview.chats[0].sidebar.isActive());
  const shown = await page.evaluate(() => {
    const bubble = [...document.querySelectorAll('.ag-msg-assistant')].at(-1);
    return bubble?.textContent ?? '';
  });
  if (!shown.includes('검토 23')) throw new Error('background answer missing after switching back');
  return result;
}

function median(samples) {
  const keys = Object.keys(samples[0]);
  return Object.fromEntries(keys.map((key) => {
    const sorted = samples.map((sample) => sample[key]).sort((a, b) => a - b);
    return [key, sorted[Math.floor(sorted.length / 2)]];
  }));
}

const browser = await puppeteer.launch({
  executablePath: browserExecutable(), headless: true,
  args: [...browserLaunchArgs(), '--window-size=1280,900'],
  defaultViewport: { width: 1280, height: 900 },
});
try {
  const report = { url, characters: answer.length, tokens: tokens.length, tokensPerFrame, runs, scenarios: {} };
  for (const [name, scenario] of Object.entries({ foreground, background })) {
    const samples = [];
    for (let run = 0; run < runs; run += 1) {
      const page = await browser.newPage();
      const cdp = await page.createCDPSession();
      await cdp.send('Performance.enable');
      samples.push(await scenario(page, cdp));
      await page.close();
    }
    report.scenarios[name] = { median: median(samples), samples };
  }
  if (options.has('json')) writeFileSync(options.get('json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report.scenarios).map(([name, { median }]) => [name, median])), null, 2));
} finally {
  await browser.close();
}

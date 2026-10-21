/** 프로젝트 그래프(연구 허브의 그래프 탭) 계산·그리기 비용. 합성 그래프(withSyntheticGraph)로 잰다.
 * node bench/project-graph-bench.mjs --label=after [--nodes=500,2000,5000] [--json=out.json]
 * BENCH_STUDIO_ROOT=/path/to/baseline/rhwp/rhwp-studio 로 같은 워크로드를 비교한다.
 *
 * 장면: open(update + 첫 배치), settle(열고 3초), rename(구조가 같은 스냅샷, 9번의 중앙값), grow(항목 하나 더함),
 * pan(줌인한 화면 끌기, 이름 그리기 포함), hover(그래프 위에서 커서 이동).
 * 프레임 비용은 requestAnimationFrame 콜백 시간을 그대로 잰다(틱 + 그리기 + 나머지).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const studio = process.env.BENCH_STUDIO_ROOT || path.resolve(here, '..');
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const label = arg('label') || 'current';
const sizes = (arg('nodes') || '500,2000,5000').split(',').map(Number).filter((value) => value > 0);
const jsonPath = arg('json');

process.env.RHWP_SKIP_AGENT_HUB = '1';
const server = await createServer({
  configFile: path.join(studio, 'vite.sidebar.config.ts'),
  root: studio,
  server: { port: 0, open: false, hmr: false },
  logLevel: 'error',
  plugins: [{
    name: 'graph-bench-page',
    configureServer(vite) {
      vite.middlewares.use('/__graph_bench', (_request, response) => {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><html><body style="margin:0"></body></html>');
      });
    },
  }],
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await puppeteer.launch({ executablePath: findBrowserExecutable(), headless: true, args: browserLaunchArgs() });
const results = { label, source: studio, platform: `${os.platform()} ${os.arch()}`, cpu: os.cpus()[0]?.model, browser: await browser.version(), sizes: [] };

try {
  for (const size of sizes) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${origin}/__graph_bench`);
    const result = await page.evaluate(async (count) => {
      const [{ createProjectGraph }, { sampleProject, withSyntheticGraph }] = await Promise.all([
        import('/src/ui/agent-sidebar/project/project-graph.ts'),
        import('/src/sidebar-preview/mock-projects.ts'),
      ]);
      // d3-force 를 미리 불러 둔다(첫 배치 시간에 넣지 않는다).
      const warm = createProjectGraph({ store: {}, openPreview() {}, announce() {} });
      warm.element.style.cssText = 'width:200px;height:200px';
      document.body.append(warm.element);
      warm.update(sampleProject(1_700_000_000_000));
      warm.setActive(true);
      while (!warm.element.graphStats.ticks) await new Promise((done) => setTimeout(done, 16));
      warm.dispose();
      // rAF 콜백 시간 = 그래프 한 프레임의 일.
      let frames = [];
      const nativeRaf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => nativeRaf((time) => {
        const started = performance.now();
        callback(time);
        frames.push(performance.now() - started);
      });
      const nextFrame = () => new Promise((done) => nativeRaf(() => done()));
      const settleTask = () => new Promise((done) => setTimeout(done, 0));
      const summarize = (list) => {
        const sorted = [...list].sort((a, b) => a - b);
        const pick = (q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
        const mean = list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : 0;
        return { frames: list.length, meanMs: +mean.toFixed(3), p50Ms: +pick(0.5).toFixed(3), p95Ms: +pick(0.95).toFixed(3), maxMs: +pick(1).toFixed(3) };
      };
      const measure = async (ms, during) => {
        frames = [];
        const end = performance.now() + ms;
        while (performance.now() < end) {
          during?.();
          await nextFrame();
        }
        return summarize(frames);
      };

      const project = withSyntheticGraph(sampleProject(1_700_000_000_000), count);
      const graph = createProjectGraph({ store: { edit: async () => undefined }, openPreview() {}, announce() {} });
      graph.element.style.cssText = 'position:fixed;inset:0;width:1200px;height:800px';
      document.body.append(graph.element);
      const stats = graph.element.graphStats;
      const canvas = graph.element.querySelector('canvas');
      const out = { nodes: 0, links: 0 };

      let started = performance.now();
      graph.update(project);
      graph.setActive(true);
      await settleTask();
      out.openMs = +(performance.now() - started).toFixed(2);
      out.nodes = stats.nodes;
      out.links = stats.links;
      out.settle = await measure(3000);

      // 구조가 같은 스냅샷(이름만 바뀜). 한 번은 JIT 가 덜 데워져 흔들리므로 9번의 중앙값을 본다.
      let renamed = project;
      const renames = [];
      for (let round = 1; round <= 9; round++) {
        renamed = { ...project, revision: project.revision + round, items: project.items.map((item, index) => index === 0 ? { ...item, title: `${item.title}${round}` } : item) };
        started = performance.now();
        graph.update(renamed);
        renames.push(performance.now() - started);
      }
      out.renameUpdateMs = +renames.sort((a, b) => a - b)[4].toFixed(3);

      const grown = { ...renamed, revision: renamed.revision + 1, items: [...renamed.items, { ...renamed.items.find((item) => item.kind === 'note'), id: 'nbench1', title: 'bench' }], links: [...renamed.links, { id: 'lbench1', from: 'nbench1', to: renamed.items[0].id, origin: 'explicit' }] };
      started = performance.now();
      graph.update(grown);
      await settleTask();
      out.growUpdateMs = +(performance.now() - started).toFixed(3);
      out.grow = await measure(2000);

      // 줌인해 이름이 보이게 한 뒤 화면 끌기: 그리기만의 비용.
      canvas.focus();
      for (let index = 0; index < 4; index++) canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true }));
      await measure(600);
      const pointer = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }));
      // 빈 곳에서 시작해야 화면 끌기다. 맨 위 왼쪽 모서리를 찾는다.
      let x = 6;
      let y = 6;
      pointer('pointerdown', x, y);
      out.pan = await measure(1500, () => {
        x += 3;
        y += 2;
        pointer('pointermove', x, y);
      });
      pointer('pointerup', x, y);
      out.drawsDuringPan = stats.draws;

      // 쉬는 동안 커서를 그래프 위로 움직인다: 찾기 + 초점 흐림 그리기.
      canvas.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
      await measure(1500);
      let t = 0;
      out.hover = await measure(1500, () => {
        t += 1;
        const hx = 600 + Math.cos(t / 9) * 260;
        const hy = 400 + Math.sin(t / 7) * 200;
        canvas.dispatchEvent(new PointerEvent('pointermove', { clientX: hx, clientY: hy, pointerId: 2, bubbles: true }));
      });
      out.tickMs = +stats.tickMs.toFixed(3);
      out.maxTickMs = +stats.maxTickMs.toFixed(3);
      out.drawMs = +stats.drawMs.toFixed(3);
      out.maxDrawMs = +stats.maxDrawMs.toFixed(3);
      graph.dispose();
      return out;
    }, size);
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    results.sizes.push({ size, ...result });
    console.log(`[${label}] ${size}: nodes ${result.nodes}, links ${result.links}, open ${result.openMs}ms, settle mean ${result.settle.meanMs}ms p95 ${result.settle.p95Ms}ms, grow mean ${result.grow.meanMs}ms, pan mean ${result.pan.meanMs}ms p95 ${result.pan.p95Ms}ms, hover mean ${result.hover.meanMs}ms, tick ${result.tickMs}ms, draw ${result.drawMs}ms, rename ${result.renameUpdateMs}ms`);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
if (jsonPath) fs.writeFileSync(jsonPath, `${JSON.stringify(results, null, 2)}\n`);

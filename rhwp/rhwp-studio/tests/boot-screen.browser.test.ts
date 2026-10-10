import { browserExecutable, browserLaunchArgs } from './browser-support.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import puppeteer, { type Browser } from 'puppeteer-core';

const script = readFileSync(new URL('../public/boot-screen.js', import.meta.url), 'utf8');
const page = `<!doctype html><html data-theme-effective="dark"><body>
<div id="boot-screen" hidden><img id="boot-screen-logo" alt="HamaEditor"></div>
<script src="/boot-screen.js"></script>
</body></html>`;

interface Scenario {
  search?: string;
  setup?: Record<string, unknown>;
  automated?: boolean;
  desktopLaunchFiles?: number;
}

interface BootResult {
  present: boolean;
  hidden: boolean;
  mode: string;
  launchedWithFile: boolean;
  src: string;
}

let server: Server;
let origin = '';
let browser: Browser;

test.before(async () => {
  server = createServer((request, response) => {
    if (request.url?.startsWith('/boot-screen.js')) {
      response.writeHead(200, { 'content-type': 'text/javascript' });
      response.end(script);
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await puppeteer.launch({
    executablePath: browserExecutable(),
    headless: true,
    args: browserLaunchArgs(),
  });
});

test.after(async () => {
  await browser?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

async function boot(scenario: Scenario): Promise<BootResult> {
  const context = await browser.createBrowserContext();
  try {
    const tab = await context.newPage();
    await tab.evaluateOnNewDocument((options: Scenario) => {
      // puppeteer 는 webdriver 로 보인다. 사람이 연 창을 흉내 낼 때만 지운다.
      if (!options.automated) Object.defineProperty(navigator, 'webdriver', { get: () => false });
      if (options.setup) localStorage.setItem('rhwp-initial-setup', JSON.stringify(options.setup));
      if (options.desktopLaunchFiles !== undefined) {
        const files = Array.from({ length: options.desktopLaunchFiles }, (_, index) => ({ handleId: `h${index}` }));
        (window as unknown as { rhwpDesktop: unknown }).rhwpDesktop = {
          getLaunchFiles: () => Promise.resolve(files),
          getLaunchGeneratedDocument: () => Promise.resolve(null),
        };
      }
    }, scenario);
    await tab.goto(`${origin}/${scenario.search ?? ''}`);
    return await tab.evaluate(async () => {
      const state = (window as unknown as { __rhwpBoot: { decided: Promise<void>; mode: string; launchedWithFile: boolean } }).__rhwpBoot;
      await state.decided;
      const screen = document.getElementById('boot-screen');
      const logo = document.getElementById('boot-screen-logo') as HTMLImageElement | null;
      return {
        present: screen !== null,
        hidden: screen?.hidden ?? true,
        mode: state.mode,
        launchedWithFile: state.launchedWithFile,
        src: logo?.getAttribute('src') ?? '',
      };
    });
  } finally {
    await context.close();
  }
}

test('first run plays the themed hippo animation', async () => {
  const result = await boot({});
  assert.equal(result.hidden, false);
  assert.equal(result.mode, 'intro');
  assert.equal(result.src, '/images/boot/hama-boot-dark.gif');
});

test('later launches show the still logo instead of the animation', async () => {
  const result = await boot({ setup: { version: 2, completed: true } });
  assert.equal(result.mode, 'still');
  assert.equal(result.src, '/images/boot/hama-boot-dark-still.png');
});

test('a deferred setup keeps the still logo and never replays the intro', async () => {
  const result = await boot({ setup: { version: 2, completed: false, deferred: true } });
  assert.equal(result.mode, 'still');
});

test('a first launch that opens a desktop file shows the still logo and defers setup', async () => {
  const result = await boot({ desktopLaunchFiles: 1 });
  assert.equal(result.mode, 'still');
  assert.equal(result.launchedWithFile, true);
  const empty = await boot({ desktopLaunchFiles: 0 });
  assert.equal(empty.mode, 'intro');
  assert.equal(empty.launchedWithFile, false);
});

test('a first launch with a document URL shows the still logo', async () => {
  const result = await boot({ search: '?url=https%3A%2F%2Fexample.com%2Fa.hwp' });
  assert.equal(result.mode, 'still');
  assert.equal(result.launchedWithFile, true);
});

test('automated browsers never see the boot screen', async () => {
  const result = await boot({ automated: true });
  assert.equal(result.present, false);
  assert.equal(result.mode, 'off');
});

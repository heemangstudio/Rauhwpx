import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createOwnedBrowserService } from '../owned-browser-service.mjs';
import { inspectOwnedBrowserRuntime, startOwnedBrowserRuntime } from '../owned-browser-runtime.mjs';

// Real Chromium, deterministic provider pages. No traffic reaches Google or DuckDuckGo.
test('traffic checks retain one owned tab, stop agent retries, and permit explicit continuation', async (t) => {
  if (!(await inspectOwnedBrowserRuntime()).installed) { t.skip('Install pinned managed Chromium for browser challenge coverage.'); return; }
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rhwp-browser-challenge-'));
  const visits = [];
  const pages = [];
  const policyCalls = [];
  let denied = false;
  let denyFallback = false;
  const browser = createOwnedBrowserService({ dataDir, autoInstall: false,
    policy: { assertBrowserAction: async ({ url }) => {
      policyCalls.push(url);
      if (denied || denyFallback && url.startsWith('https://duckduckgo.com/')) throw Object.assign(new Error('Site access revoked'), { code: 'BROWSER_PERMISSION_REQUIRED' });
    } },
    runtimeFactory: async (options) => {
      const runtime = await startOwnedBrowserRuntime(options);
      const newPage = runtime.context.newPage.bind(runtime.context);
      runtime.context.newPage = async () => {
        const page = await newPage(); pages.push(page);
        const goto = page.goto.bind(page);
        page.goto = (url, options) => goto(url.startsWith('https://www.google.com/search?') ? 'https://www.google.com/sorry/index?continue=private-token' : url, options);
        await page.route('https://**/*', async (route) => {
          const url = new URL(route.request().url()); visits.push(url.href);
          await route.fulfill({ contentType: 'text/html', body: url.pathname === '/sorry/index' ? '<title>Traffic check</title><h1>Verify you are human</h1><button>Verify</button>' : '<title>Results</title><h1>Research results</h1>' });
        });
        return page;
      };
      return runtime;
    },
  });
  t.after(async () => { await browser.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  const agent = { threadId: 'research', agentId: 'researcher' };
  const human = { ...agent, isHuman: true, clientId: 'window' };
  const query = '한국어 document research';
  const opened = await browser.request(agent, 'open', { url: `https://www.google.com/search?q=${encodeURIComponent(query)}` });
  assert.equal(opened.ok, false);
  assert.equal(opened.code, 'BROWSER_CHALLENGE_REQUIRED');
  assert.equal(opened.retryable, false);
  assert.equal(opened.tab.status, 'challenge-required');
  assert.equal(opened.tab.challenge.fallback.url, `https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
  assert.equal(JSON.stringify(opened).includes('private-token'), false);
  const identity = () => ({ tabId: opened.tab.tabId, navigationEpoch: opened.tab.navigationEpoch, controllerEpoch: opened.tab.controllerEpoch });
  const visitCount = visits.length;
  for (let i = 0; i < 3; i++) {
    const retry = await browser.request(agent, 'open', { url: 'https://www.google.com/search?q=retry' });
    assert.equal(retry.code, opened.code); assert.equal(retry.tab.tabId, opened.tab.tabId);
  }
  assert.equal(visits.length, visitCount);
  assert.equal(pages.length, 1);
  const retry = await browser.request(agent, 'navigate', { ...identity(), url: 'https://www.google.com/search?q=retry' });
  assert.equal(retry.ok, false);
  assert.equal(visits.length, visitCount);
  const input = await browser.request(agent, 'press', { ...identity(), key: 'Enter' });
  assert.equal(input.code, opened.code);
  const observation = await browser.request(agent, 'snapshot', { tabId: opened.tab.tabId });
  assert.equal(observation.ok, false); assert.equal(observation.code, opened.code);
  await assert.rejects(browser.request({ ...agent, agentId: 'other' }, 'snapshot', { tabId: opened.tab.tabId }), { code: 'BROWSER_TAB_NOT_FOUND' });
  denyFallback = true;
  await assert.rejects(browser.request(agent, 'navigate', { ...identity(), url: opened.tab.challenge.fallback.url }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  assert.equal(visits.length, visitCount);
  denyFallback = false;
  const alternate = await browser.request(agent, 'navigate', { ...identity(), url: opened.tab.challenge.fallback.url });
  assert.equal(alternate.ok, true); assert.equal(alternate.tab.tabId, opened.tab.tabId);
  assert.equal(alternate.tab.challenge, null); assert.equal(pages.length, 1);
  const challengedAgain = await browser.request(agent, 'navigate', { tabId: opened.tab.tabId, navigationEpoch: alternate.tab.navigationEpoch, controllerEpoch: alternate.tab.controllerEpoch, url: `https://www.google.com/search?q=${encodeURIComponent(query)}` });
  assert.equal(challengedAgain.ok, false); opened.tab = challengedAgain.tab;
  denied = true;
  await assert.rejects(browser.request(agent, 'open', { url: 'https://www.google.com/search?q=retry' }), { code: 'BROWSER_PERMISSION_REQUIRED' });
  const hidden = (await browser.inventory(agent)).tabs[0];
  assert.equal(hidden.challenge, null); assert.equal(hidden.url, 'about:blank');
  denied = false;
  const taken = await browser.request(human, 'control', { ...identity(), owner: 'human' });
  assert.equal(taken.tab.tabId, opened.tab.tabId);
  assert.equal(taken.tab.controller.owner, 'human');
  // Human continuation remains in the same Chromium page and session.
  await pages[0].goto('https://www.google.com/completed');
  assert.equal((await browser.inventory(human)).tabs[0].challenge, null);
  const returned = await browser.request(human, 'control', { tabId: opened.tab.tabId, owner: 'agent' });
  const fallback = await browser.request(agent, 'navigate', { tabId: opened.tab.tabId, navigationEpoch: returned.tab.navigationEpoch, controllerEpoch: returned.tab.controllerEpoch, url: opened.tab.challenge.fallback.url });
  assert.equal(fallback.ok, true); assert.equal(fallback.tab.challenge, null);
  assert.equal(fallback.tab.tabId, opened.tab.tabId); assert.equal(pages.length, 1);
  assert.ok(policyCalls.includes(opened.tab.challenge.fallback.url));
  const lookalike = await browser.request(agent, 'open', { url: 'https://google.com.example.org/sorry/index' });
  assert.equal(lookalike.ok, true); assert.equal(lookalike.tab.challenge, null);
});

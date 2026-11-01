import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { browserExecutable, browserLaunchArgs } from './browser-support.ts';

// 실제 설정·계정·요금제 UI를 쓰되 결제와 계정 응답만 미리보기 대역으로 검증한다.
test('setup gates provider connection by account and plan, and resumes after checkout', { timeout: 90_000 }, async () => {
  const server = await createServer({
    configFile: resolve(import.meta.dirname, '../vite.sidebar.config.ts'),
    server: { port: 0, open: false }, logLevel: 'error',
  });
  await server.listen();
  const browser = await puppeteer.launch({ executablePath: browserExecutable(), headless: true, args: browserLaunchArgs() });
  try {
    const artifacts = resolve(import.meta.dirname, '../sidebar-preview/artifacts');
    await mkdir(artifacts, { recursive: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 800 });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    const address = server.httpServer!.address() as { port: number };
    const step = (name: string) => page.waitForSelector(`.rhwp-setup-dialog[data-step="${name}"]`, { visible: true });
    const start = async (account: string, extra = '') => {
      await page.goto(`http://127.0.0.1:${address.port}/?reset=1&initial-setup=1&account=${account}${extra}`);
      await step('intro');
      await page.click('.rhwp-setup-primary');
      await step('theme');
      await page.click('.rhwp-setup-dot[aria-label="시작 방법"]');
      await step('welcome');
    };
    const finished = async () => {
      await page.waitForSelector('.rhwp-setup-overlay', { hidden: true });
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rhwp-initial-setup')!).completed), true);
    };

    await start('signed-out');
    await page.screenshot({ path: resolve(artifacts, 'setup-paths.png') });
    assert.equal(await page.$('.rhwp-setup-dot[aria-label="AI 연결"]'), null);
    await page.click('[data-path="free"]');
    await finished();

    await start('signed-out');
    await page.click('[data-path="ai"]');
    await step('account');
    assert.equal(await page.$('.rhwp-setup-dot[aria-label="요금제"]'), null);
    assert.equal(await page.$('.rhwp-setup-dot[aria-label="AI 연결"]'), null);
    await page.click('.rhwp-setup-primary');
    await finished();

    await start('free');
    await page.click('[data-path="ai"]');
    await step('plans');
    await page.waitForSelector('.rhwp-setup-plans .ag-pricing-grid', { visible: true });
    assert.equal(await page.$('.rhwp-setup-dot[aria-label="AI 연결"]'), null);
    await page.click('.rhwp-setup-back');
    await step('welcome');
    await page.click('[data-path="ai"]');
    await step('plans');
    await page.click('.rhwp-setup-primary');
    await finished();

    await start('free');
    await page.click('[data-path="ai"]');
    await step('plans');
    await page.click('.rhwp-setup-skip');
    await finished();

    // Hama: 프로바이더 연결 뒤 웹 ChatGPT·Claude 장. 카드를 누르면 켜고 로그인을 본 뒤 확인 질문을 실제로 보낸다.
    // claude=broken 은 확인 질문이 실패하는 미리보기 허브다.
    await start('hama', '&claude=broken');
    await page.click('[data-path="ai"]');
    await step('models');
    await page.click('.rhwp-setup-primary');
    await step('assistants');
    assert.equal(await page.$eval('.rhwp-setup-primary', (node) => node.textContent), '연결 건너뛰기');
    await page.click('.rhwp-setup-assistant[data-service="chatgpt"] .rhwp-setup-card-action');
    await page.waitForSelector('.rhwp-setup-assistant[data-service="chatgpt"][data-state="verifying"]');
    await page.waitForSelector('.rhwp-setup-assistant[data-service="chatgpt"][data-state="verified"]');
    assert.equal(await page.$eval('.rhwp-setup-assistant[data-service="chatgpt"] .rhwp-setup-assistant-detail', (node) => node.textContent), '작동 확인됨 · user@example.com');
    assert.equal(await page.$eval('.rhwp-setup-assistant[data-service="chatgpt"] .rhwp-setup-assistant-answer', (node) => node.textContent), '“연결됐어요”');
    await page.click('.rhwp-setup-assistant[data-service="claude"] .rhwp-setup-card-action');
    await page.waitForSelector('.rhwp-setup-assistant[data-service="claude"][data-state="failed"]');
    await page.screenshot({ path: resolve(artifacts, 'setup-web-assistants.png') });
    // 켠 상태는 설정 → AI 의 줄과 같은 허브 상태다.
    assert.equal(await page.evaluate(() => window.sidebarPreview.bridge.requestBrowser('chatgpt.status', {}).then((status) => (status as { enabled: boolean }).enabled)), true);
    assert.equal(await page.$eval('.rhwp-setup-primary', (node) => node.textContent), '홈으로');
    await page.click('.rhwp-setup-primary');
    await finished();

    await start('rau');
    await page.click('[data-path="ai"]');
    await step('rau');
    await page.screenshot({ path: resolve(artifacts, 'setup-rau-introduction.png') });
    await page.click('.rhwp-setup-primary');
    await step('models');
    await page.click('.rhwp-setup-primary');
    await step('assistants');
    await page.click('.rhwp-setup-primary');
    await finished();

    // 체험 기간 안에 정식 Rau 를 등록해도, 남은 체험 이력으로 가입을 안내하지 않는다.
    await start('rau-trial');
    await page.evaluate(() => window.sidebarPreview.account.setTier('rau'));
    await page.click('[data-path="ai"]');
    await step('rau');
    assert.equal(await page.$eval('.rhwp-setup-upgrade .rhwp-setup-upgrade-title', (node) => node.textContent), '이제 Rau와 함께해요');
    await page.click('.rhwp-setup-primary');
    await step('models');
    await page.click('.rhwp-setup-primary');
    await step('assistants');
    await page.click('.rhwp-setup-primary');
    await finished();
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:open-plan-card')));
    await page.waitForSelector('.ag-pricing-card');
    assert.equal(await page.$('.ag-pricing-trial-tag'), null, 'paid Rau is not marked as a running trial');
    await page.click('.ag-pricing-close');
    await page.waitForFunction(() => !document.querySelector('.ag-pricing-card'));

    await start('free');
    await page.click('[data-path="ai"]');
    await step('plans');
    // 무료 계정은 Rau 체험을 쓸 수 있다. 체험 시작은 네트워크 요청 없는 mock-account 다.
    await page.click('.ag-pricing-col[data-plan="rau"] .ag-pricing-btn-trial');
    await step('rau');
    assert.match(await page.$eval('.rhwp-setup-upgrade .rhwp-setup-upgrade-title', (node) => node.textContent ?? ''), /무료 체험을 시작했어요/);
    await page.click('.rhwp-setup-primary');
    await step('models');
    await page.click('.rhwp-setup-primary');
    await step('assistants');
    await page.click('.rhwp-setup-primary');
    await finished();
  } finally {
    await browser.close();
    await server.close();
  }
});

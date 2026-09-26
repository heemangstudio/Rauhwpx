import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const WIDTHS = [280, 480, 900];
const THEMES = ['light', 'dark'];

/**
 * boat 설정 두 갈래(이메일 · API 키)와 설정 카드의 시작·중지·연결 해제·삭제를 세 폭과 두 테마에서 걷는다.
 * 모든 화면에서 창이 넘치지 않는지, 버튼 글자가 줄바꿈되지 않는지, 포커스·Enter·Escape 가 맞는지 본다.
 */
export async function checkBoatSetup(page, origin, artifacts) {
  await page.browserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const settle = (ms = 60) => new Promise((done) => setTimeout(done, ms));
  const title = (text) => page.waitForFunction((expected) => {
    const overlay = document.querySelector('.ag-cloud-setup-overlay');
    return overlay && !overlay.hidden && document.querySelector('.ag-cloud-setup-title')?.textContent === expected;
  }, { timeout: 15_000 }, text);
  const calls = () => page.evaluate(() => [...window.sidebarPreview.cloud.calls.boat]);
  const active = () => page.evaluate(() => {
    const node = document.activeElement;
    return node?.id || node?.textContent?.trim() || node?.className || '';
  });
  async function button(label) {
    const handle = await page.waitForFunction((text) => [...document.querySelectorAll('.ag-cloud-setup-dialog button')]
      .find((node) => node.textContent.trim() === text && node.checkVisibility()), { timeout: 10_000 }, label)
      .catch(() => assert.fail(`Missing setup button: ${label}`));
    return handle.asElement();
  }
  async function click(label) {
    const handle = await button(label);
    await page.waitForFunction((node) => !node.disabled, {}, handle);
    await handle.click();
  }
  async function focused(expected, where) {
    await page.waitForFunction((value) => {
      const node = document.activeElement;
      return node && (node.id === value || node.textContent?.trim() === value);
    }, { timeout: 5_000 }, expected).catch(() => {});
    assert.equal(await active(), expected, `focus on ${where}`);
  }
  /** 창·카드가 가로로 넘치지 않고, 보이는 버튼 글자가 한 줄인지. */
  async function fits(where) {
    const report = await page.evaluate(() => {
      const overlay = document.querySelector('.ag-cloud-setup-overlay');
      const surface = overlay && !overlay.hidden
        ? overlay.querySelector('.ag-cloud-setup-dialog')
        : document.querySelector('.ag-cloud-settings');
      const rect = surface.getBoundingClientRect();
      const problems = [];
      if (rect.left < 0 || rect.right > innerWidth + 0.5) problems.push(`outside viewport ${rect.left}-${rect.right}`);
      for (const node of [surface, ...surface.querySelectorAll('.ag-cloud-setup-body, .ag-cloud-setup-footer, .ag-cloud-settings-card, .ag-cloud-setup-code')]) {
        if (node.scrollWidth > node.clientWidth + 1) problems.push(`${node.className} overflows ${node.scrollWidth}>${node.clientWidth}`);
      }
      const root = document.querySelector('.ag-root');
      if (root.scrollWidth > root.clientWidth + 1) problems.push('sidebar overflows');
      // 글자 버튼과 선택지 이름은 한 줄이어야 한다. 선택지의 보조 문구만 좁은 폭에서 줄을 바꿀 수 있다.
      const labels = surface.querySelectorAll(
        '.ag-cloud-setup-button, .ag-cloud-setup-link, .ag-settings-btn, .ag-cloud-setup-option-copy strong, .ag-cloud-settings-status');
      for (const node of labels) {
        if (!node.checkVisibility() || !node.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const tops = new Set([...range.getClientRects()].filter((line) => line.width > 0).map((line) => Math.round(line.top)));
        if (tops.size > 1) problems.push(`label wraps: ${node.textContent.trim()}`);
        const box = node.getBoundingClientRect();
        if (box.right > rect.right + 0.5 || box.left < rect.left - 0.5) problems.push(`label clipped: ${node.textContent.trim()}`);
      }
      return problems;
    });
    assert.deepEqual(report, [], `${where} fits`);
  }
  async function open(width, theme, boatState, scenario = {}) {
    await page.goto(`${origin}/?cloud=1&page=settings&destination=cloud&controls=0&width=${width}&reset=1&theme=${theme}`,
      { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.sidebarPreview?.cloud);
    await page.evaluate((state, flags) => {
      const cloud = window.sidebarPreview.cloud;
      cloud.setDashboardState('unconfigured');
      cloud.setBoatSpeed(0.1);
      cloud.setBoatScenario(flags);
      cloud.setBoatState(state);
    }, boatState, scenario);
    await page.waitForSelector('.ag-cloud-settings-action');
  }
  async function chooseBoat(where) {
    await page.click('.ag-cloud-settings-action');
    await title('Cloud 서버 선택');
    assert.deepEqual(await page.$$eval('.ag-cloud-setup-option', (nodes) => nodes.map((node) => [
      node.dataset.serverMode, node.querySelector('.ag-cloud-setup-option-note')?.textContent,
    ])).then((rows) => rows.map(([mode]) => mode)), ['app-hosted', 'boat', 'self-hosted']);
    assert.equal(await page.$eval('.ag-cloud-setup-option[data-server-mode="boat"] .ag-cloud-setup-option-note',
      (node) => node.textContent), '내 boat 계정 · EU');
    await page.click('.ag-cloud-setup-option[data-server-mode="boat"]');
    await page.waitForFunction(() => document.querySelector('.ag-cloud-setup-option[data-server-mode="boat"]')
      ?.getAttribute('aria-checked') === 'true');
    await fits(`${where} chooser`);
    await click('계속');
  }

  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      const at = `${width}px ${theme}`;
      // ── 이메일 로그인: 만료된 코드 → 새 코드 → 연결 → 만들기 → 숨겨도 계속 → 완료
      await open(width, theme, 'off', { expireFirstCode: true });
      await chooseBoat(at);
      await title('boat 계정 연결');
      await focused('ag-boat-email', `${at} email field`);
      await fits(`${at} connect`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('.ag-cloud-setup-overlay').hidden);
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('ag-cloud-settings-action')), true,
        `${at} Escape returns focus to the card`);
      await chooseBoat(at);
      await title('boat 계정 연결');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#ag-boat-email[aria-invalid="true"]');
      assert.equal(await page.$eval('.ag-cloud-setup-field-error', (node) => node.textContent), '이메일이 필요합니다.');
      await page.type('#ag-boat-email', 'andy@example.com');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await title('boat 로그인');
      assert.equal((await calls()).filter((call) => call === 'email-start').length, 1, `${at} one sign-in request`);
      await focused('로그인 페이지 열기', `${at} sign-in link`);
      await fits(`${at} sign-in link`);
      await page.keyboard.press('Enter');
      await focused('로그인했습니다', `${at} signed-in confirmation`);
      assert.ok((await calls()).includes('open-verification'));
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ag-cloud-setup-code');
      assert.equal(await page.$eval('.ag-cloud-setup-code-copy', (node) => node.title), '코드 복사');
      await page.waitForSelector('.ag-cloud-setup-code[data-expired]', { timeout: 15_000 });
      assert.match(await page.$eval('.ag-cloud-setup-body', (node) => node.textContent), /코드가 만료되었습니다\./);
      await focused('새 코드', `${at} new code`);
      await fits(`${at} expired code`);
      if (width === 480) await page.screenshot({ path: resolve(artifacts, `boat-code-expired-${theme}.png`) });
      await page.keyboard.press('Enter');
      await title('boat 로그인');
      await click('로그인 페이지 열기');
      await click('로그인했습니다');
      await page.waitForSelector('.ag-cloud-setup-code:not([data-expired]) .ag-cloud-setup-code-copy');
      await page.click('.ag-cloud-setup-code-copy');
      await page.waitForSelector('.ag-cloud-setup-code-copy[data-copied="true"]');
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^\d{6}$/);
      await page.waitForSelector('.ag-cloud-setup-code-copy:not([data-copied])', { timeout: 3_000 });
      await fits(`${at} sign-in code`);
      if (width === 480) await page.screenshot({ path: resolve(artifacts, `boat-code-${theme}.png`) });
      await title('boat 서버 만들기');
      await focused('서버 만들기', `${at} create`);
      assert.deepEqual(await page.$$eval('.ag-cloud-setup-fact', (rows) => rows.map((row) => row.textContent)),
        ['사양4 vCPU · 8 GB', '지역EU', '자동 중지30분 동안 쉬면']);
      await fits(`${at} create`);
      await page.keyboard.press('Enter');
      await title('boat 서버 준비 중');
      await page.waitForSelector('.ag-cloud-setup-stage[data-status="active"]');
      await fits(`${at} progress`);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => document.querySelector('.ag-cloud-setup-overlay').hidden);
      await page.waitForFunction(() => document.querySelector('.ag-cloud-settings-status')?.textContent === 'boat · EU');
      await page.waitForFunction(() => /^실행 중/.test(document.querySelector('.ag-cloud-settings-detail')?.textContent ?? ''),
        { timeout: 15_000 });
      assert.equal((await calls()).filter((call) => call.startsWith('setup-')).length, 1, `${at} one setup`);
      await fits(`${at} running card`);

      // ── 카드: 중지 → 시작 → 연결 해제 → 기존 서버 가져오기 → 삭제(취소 뒤 확인)
      await page.click('.ag-cloud-settings-action');
      await page.waitForFunction(() => document.querySelector('.ag-cloud-settings-dot')?.dataset.pulse === 'true');
      assert.equal(await page.$eval('.ag-cloud-settings-action', (node) => node.disabled), true, `${at} stop disabled while stopping`);
      await page.waitForFunction(() => /^정지됨/.test(document.querySelector('.ag-cloud-settings-detail').textContent));
      assert.equal(await page.$eval('.ag-cloud-settings-action', (node) => node.textContent), '시작');
      await fits(`${at} stopped card`);
      if (width === 480) await page.screenshot({ path: resolve(artifacts, `boat-card-stopped-${theme}.png`) });
      await page.click('.ag-cloud-settings-action');
      await page.waitForFunction(() => document.querySelector('.ag-cloud-settings-detail').textContent === '시작하는 중');
      await page.waitForFunction(() => /^실행 중/.test(document.querySelector('.ag-cloud-settings-detail').textContent));
      assert.equal(await page.$eval('.ag-cloud-settings-more', (node) => node.title), 'boat 서버 관리');
      await page.click('.ag-cloud-settings-more');
      await page.waitForSelector('.context-menu');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.ag-cloud-settings-status')?.textContent === '설정되지 않음');
      assert.equal((await calls()).at(-1), 'disconnect');
      await page.click('.ag-cloud-settings-action');
      await title('Cloud 서버 선택');
      assert.equal(await page.$eval('.ag-cloud-setup-option[data-server-mode="boat"]', (node) => node.getAttribute('aria-checked')),
        'true', `${at} a connected account preselects boat`);
      await click('계속');
      await title('boat 서버 연결');
      await click('서버 연결');
      await title('boat 서버가 준비되었습니다');
      await focused('완료', `${at} ready`);
      await fits(`${at} ready`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.ag-cloud-setup-overlay').hidden);
      await page.click('.ag-cloud-settings-more');
      await page.waitForSelector('.context-menu');
      await page.evaluate(() => [...document.querySelectorAll('.context-menu .md-item')].find((node) => node.textContent === '서버 삭제').click());
      await page.waitForSelector('.ag-sheet-layer.ag-sheet-open');
      assert.equal(await page.$eval('.ag-sheet-title', (node) => node.textContent), 'boat 서버를 삭제할까요?');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.ag-sheet-layer'));
      assert.notEqual((await calls()).at(-1), 'delete', `${at} Escape keeps the server`);
      await page.click('.ag-cloud-settings-more');
      await page.waitForSelector('.context-menu');
      await page.evaluate(() => [...document.querySelectorAll('.context-menu .md-item')].find((node) => node.textContent === '서버 삭제').click());
      await page.waitForSelector('.ag-sheet-layer.ag-sheet-open');
      await settle(450);
      if (width === 480) await page.screenshot({ path: resolve(artifacts, `boat-delete-${theme}.png`) });
      await page.click('.ag-sheet-confirm');
      await page.waitForFunction(() => document.querySelector('.ag-cloud-settings-status')?.textContent === '설정되지 않음');
      assert.equal((await calls()).at(-1), 'delete');

      // ── API 키: 거절 → 다시 입력 → 요금제 → 결제 확인 → 설치 실패 → 다시 시도 → 완료
      await open(width, theme, 'off', { invalidKey: true, billingRequired: true, installFailures: 1 });
      await chooseBoat(at);
      await title('boat 계정 연결');
      await click('API 키로 연결');
      await title('API 키로 연결');
      await focused('ag-boat-api-key', `${at} API key field`);
      assert.equal(await page.$eval('#ag-boat-api-key', (node) => node.type), 'password');
      await page.type('#ag-boat-api-key', 'boat_live_4f9c2a7e81d3b6c0');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#ag-boat-api-key[aria-invalid="true"]', { timeout: 10_000 });
      assert.equal((await calls()).filter((call) => call === 'connect-key').length, 1, `${at} no double submit`);
      assert.equal(await page.$eval('.ag-cloud-setup-field-error', (node) => node.textContent), 'boat가 이 API 키를 거절했습니다.');
      await focused('ag-boat-api-key', `${at} API key field after rejection`);
      await fits(`${at} rejected key`);
      if (width === 480) await page.screenshot({ path: resolve(artifacts, `boat-key-rejected-${theme}.png`) });
      await page.keyboard.press('Enter');
      await title('boat 요금제 필요');
      await focused('결제 페이지 열기', `${at} checkout`);
      await fits(`${at} billing`);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ag-cloud-setup-waiting');
      assert.ok((await calls()).includes('open-checkout'));
      await title('boat 서버 만들기');
      await page.keyboard.press('Enter');
      await title('boat 서버를 준비하지 못했습니다');
      await focused('다시 시도', `${at} retry`);
      assert.match(await page.$eval('.ag-cloud-setup-technical summary', (node) => node.textContent), /자세히/);
      await page.click('.ag-cloud-setup-technical summary');
      await fits(`${at} failure`);
      if (width === 480) await page.screenshot({ path: resolve(artifacts, `boat-failed-${theme}.png`) });
      await click('다시 시도');
      await title('boat 서버가 준비되었습니다');
      assert.deepEqual(await page.$$eval('.ag-cloud-setup-fact', (rows) => rows.map((row) => row.textContent)),
        ['사양4 vCPU · 8 GB', '지역EU', '로그인 정보Claude · Codex']);
      await click('완료');
      await page.waitForFunction(() => document.querySelector('.ag-cloud-setup-overlay').hidden);
      await settle();
    }
  }
}

// 단독 실행: 자체 Vite 서버와 새 브라우저 프로필로 돈다.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { existsSync } = await import('node:fs');
  const { mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { createServer } = await import('vite');
  const { default: puppeteer } = await import('puppeteer-core');
  const studio = resolve(import.meta.dirname, '..');
  const artifacts = resolve(import.meta.dirname, 'artifacts');
  const executablePath = [process.env.CHROME_PATH, process.env.PUPPETEER_EXECUTABLE_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((path) => path && existsSync(path));
  assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
  await mkdir(artifacts, { recursive: true });
  const cacheDir = await mkdtemp(resolve(tmpdir(), 'rauhwpx-boat-check-'));
  const server = await createServer({ cacheDir, configFile: resolve(studio, 'vite.sidebar.config.ts'),
    server: { port: 0, open: false, hmr: false }, logLevel: 'error' });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await checkBoatSetup(page, origin, artifacts);
    assert.deepEqual(errors, [], 'No browser errors');
    console.log(`PASS boat setup and card at ${WIDTHS.join('/')}px, ${THEMES.join('/')}. Screenshots: ${artifacts}`);
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
}

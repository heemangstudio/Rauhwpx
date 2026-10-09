import { checkChipAlignment } from './chip-alignment.check.mjs';
import { checkPiModels } from './pi-models.check.mjs';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { checkSetupTerminal } from './setup-terminal.check.mjs';
import { checkFleetPreview } from './fleet.check.mjs';
import { checkChangesPreview } from './changes.check.mjs';
import { checkPlanPreview } from './plan.check.mjs';
import { checkContextPreview } from './context.check.mjs';
import { browserLaunchArgs, findBrowserExecutable } from '../tests/browser-support.ts';

const studio = resolve(import.meta.dirname, '..');
const artifacts = resolve(import.meta.dirname, 'artifacts');
const executablePath = findBrowserExecutable();
assert(executablePath, 'Set CHROME_PATH to a Chrome/Chromium executable.');
await mkdir(artifacts, { recursive: true });
const sampleFile = resolve(artifacts, 'sample.txt');
await writeFile(sampleFile, '문서 디자인을 위한 샘플 참고자료입니다.');
// Own server + fresh browser profile: checks do not need or alter a running app/preview.
const cacheDir = await mkdtemp(resolve(tmpdir(), 'hamaeditor-sidebar-check-'));
const server = await createServer({
  cacheDir,
  configFile: resolve(studio, 'vite.sidebar.config.ts'),
  server: { port: 0, open: false, hmr: false },
  logLevel: 'error',
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true, args: browserLaunchArgs() });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([
    { name: 'prefers-reduced-motion', value: 'reduce' },
  ]);
  const errors = [];
  const forbidden = [];
  await page.exposeFunction('reportSidebarRuntimeError', (message) =>
    errors.push(message),
  );
  await page.evaluateOnNewDocument(() => {
    // Exercise the same missing API as an HTTP LAN/Tailscale origin.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, writable: true, configurable: true });
    window.addEventListener('error', (event) =>
      window.reportSidebarRuntimeError(event.message),
    );
    window.addEventListener('unhandledrejection', (event) =>
      window.reportSidebarRuntimeError(String(event.reason)),
    );
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('dialog', (dialog) => dialog.accept());
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    const forbiddenPath =
      /\.(wasm)(\?|$)|\/src\/(main\.ts|agent\/(bridge|tool-executor)\.ts|core\/wasm-bridge\.ts)|\/api\//;
    if (
      (url.protocol.startsWith('http') && url.origin !== origin) ||
      forbiddenPath.test(url.pathname)
    ) {
      forbidden.push(request.url());
      void request.abort();
    } else void request.continue();
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketCreated', ({ url }) => {
    if (!url.startsWith(origin.replace('http:', 'ws:'))) forbidden.push(url);
  });
  async function open(query = '') {
    const params = new URLSearchParams(query);
    if (!params.has('width')) params.set('width', '480');
    await page.goto(`${origin}/?theme=light&${params}`, {
      waitUntil: 'networkidle0',
    });
    await page.waitForFunction(() => window.sidebarPreview);
    if (!query.includes('services=setup'))
      await page.waitForFunction(
        () => !document.querySelector('.ag-input').disabled,
      );
  }
  async function screenshot(name) {
    const sidebar = await page.$('.ag-root');
    await sidebar.screenshot({ path: resolve(artifacts, `${name}.png`) });
  }
  async function clickText(selector, text) {
    const clicked = await page.evaluate(
      (selector, text) => {
        const element = [...document.querySelectorAll(selector)].find(
          (element) =>
            element.textContent.trim() === text && element.checkVisibility(),
        );
        if (!element) return false;
        element.click();
        return true;
      },
      selector,
      text,
    );
    assert(clicked, `Visible ${selector} with text ${text}`);
  }
  async function openNewChat(query = '') {
    await open(query);
    await page.click('.ag-header .ag-threads-btn');
    await page.waitForSelector('.ag-threads-new', { visible: true });
    await page.click('.ag-threads-new');
    await page.waitForFunction(() => !document.querySelector('.ag-input').disabled);
  }
  async function play(scenario) {
    await openNewChat(`scenario=${scenario}`);
    await page.click('#play');
    await page.waitForFunction(() =>
      window.sidebarPreview.bridge.isTurnRunning(),
    );
    if (scenario === 'question')
      await page.waitForSelector('.ag-question-option', { visible: true });
    else
      await page.waitForFunction(
        () =>
          !window.sidebarPreview.bridge.isTurnRunning() &&
          document.querySelector('.ag-msg-user'),
      );
  }
  async function step(name, run) {
    try {
      await run();
      console.log(`PASS ${name}`);
    } catch (error) {
      await page.screenshot({ path: resolve(artifacts, 'failure.png') });
      throw new Error(`${name}: ${error.message}\nRuntime errors: ${JSON.stringify(errors)}\nBlocked requests: ${JSON.stringify(forbidden)}`, { cause: error });
    }
  }
  await step('Fullscreen provider chip follows the composer column', () => checkChipAlignment(page, origin));
  await step(
    'Production shell, light/dark themes, resize and collapse',
    async () => {
      await open();
      assert.equal(
        await page.$eval('.ag-root', (element) =>
          Math.round(element.getBoundingClientRect().width),
        ),
        480,
      );
      assert.equal(
        await page.$eval('.ag-root', (element) =>
          Math.round(element.getBoundingClientRect().top),
        ),
        0,
      );
      assert.equal(await page.$('canvas'), null);
      await screenshot('empty-light');
      await page.select('#theme', 'dark');
      await screenshot('empty-dark');
      await page.click('.ag-collapse-tab');
      await page.waitForFunction(
        () => !document.body.classList.contains('ag-sidebar-open'),
      );
      await page.click('.ag-collapse-tab');
      await page.waitForFunction(() =>
        document.body.classList.contains('ag-sidebar-open'),
      );
      await page.click('.ag-fullscreen-btn');
      assert.equal(
        await page.$eval('.ag-root', (element) =>
          element.classList.contains('ag-fullscreen'),
        ),
        false,
      );
      await open('width=360');
      assert.equal(
        await page.$eval('.ag-root', (element) =>
          Math.round(element.getBoundingClientRect().width),
        ),
        360,
      );
      await screenshot('empty-narrow');
      await open('width=480');
    },
  );
  await step(
    'Streaming conversation, stop, and persisted thread library',
    async () => {
      await play('chat');
      await page.waitForFunction(() =>
        document
          .querySelector('.ag-root')
          .innerText.includes('필요한 부분을 선택'),
      );
      await screenshot('chat');
      await page.click('.ag-header .ag-threads-btn');
      await page.waitForSelector('.ag-root.ag-threads-open');
      assert(
        await page.$eval('.ag-threads-page', (element) =>
          element.innerText.includes('이 문서의 핵심'),
        ),
      );
      await screenshot('threads');
      await open();
      await page.click('#play');
      await page.waitForFunction(() =>
        window.sidebarPreview.bridge.isTurnRunning(),
      );
      await page.click('.ag-send');
      await page.waitForFunction(
        () => !window.sidebarPreview.bridge.isTurnRunning(),
      );
    },
  );
  await step('Tool activity labels stay compact during and after a turn', async () => {
    await play('chat');
    assert.equal(await page.$eval('.ag-activity-label', node => node.textContent), 'read_document');
    await play('tools');
    const turnLabel = '편집 2번 · 읽기 1번 · 도구 1번 · 오류 1';
    await page.waitForFunction((label) => !window.sidebarPreview.bridge.isTurnRunning()
      && document.querySelector('.ag-activity-label')?.textContent === label, {}, turnLabel);
    await page.click('.ag-activity-toggle');
    const toolRows = async () => page.$$eval('.ag-tool-row', rows => rows.map(row => ({
      label: row.querySelector('.ag-tool-label')?.textContent,
      summary: row.querySelector('.ag-tool-summary')?.textContent,
      outcome: row.querySelector('.ag-tool-outcome')?.hidden ? '' : row.querySelector('.ag-tool-outcome-text')?.textContent,
      thumb: Boolean(row.querySelector('.ag-tool-thumb img')),
      items: [...row.querySelectorAll('.ag-tool-item')].map(item => item.textContent),
    })));
    const assertToolRows = (rows) => {
      assert.deepEqual(rows.map(row => row.label), ['read_document', '2개 읽기', '3곳 편집', '표 속성 변경']);
      assert.equal(rows[1].outcome, '2개 읽음');
      assert.equal(rows[2].summary, '텍스트 바꾸기 · 텍스트 삽입 · 글자 서식');
      assert.equal(rows[2].outcome, '3개 편집 적용 · 2쪽');
      assert.equal(rows[2].items.length, 3);
      assert.equal(rows[3].outcome, '문서 버전 불일치');
    };
    const live = await toolRows();
    assertToolRows(live);
    assert.equal(live[2].thumb, true, '편집 결과 그림이 작은 그림으로 붙는다');
    await page.$$eval('.ag-tool-head', heads => heads[2].click());
    await page.click('.ag-tool-thumb');
    await page.waitForSelector('.ag-image-viewer img');
    await screenshot('tool-activity-live');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ag-image-viewer'));
    // 줄인 그림이 기록에 들어간 뒤 다시 연다.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await page.click('.ag-header .ag-threads-btn');
    const threadId = await page.$eval('.ag-threads-item.ag-active', node => node.dataset.threadId);
    await page.reload({ waitUntil: 'networkidle0' });
    await page.click('.ag-header .ag-threads-btn');
    await page.$eval('.ag-threads-list', (list, id) =>
      [...list.querySelectorAll('.ag-threads-item')].find(node => node.dataset.threadId === id)?.click(), threadId);
    await page.waitForSelector('.ag-activity-label');
    assert.equal(await page.$eval('.ag-activity-label', node => node.textContent), turnLabel);
    await page.click('.ag-activity-toggle');
    const stored = await toolRows();
    assertToolRows(stored);
    assert.equal(stored[2].thumb, true, '저장된 대화도 결과 그림을 보인다');
    await screenshot('tool-activity');
  });
  await step('Chat follows a send and yields to manual scrolling', async () => {
    await openNewChat('scenario=chat&hold=1');
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
    await page.evaluate(() => {
      const messages = document.querySelector('.ag-messages');
      const history = document.createElement('div');
      history.style.minHeight = '1200px';
      messages.insertBefore(history, messages.querySelector('.ag-messages-end'));
    });
    await page.waitForFunction(() => document.querySelector('.ag-messages').scrollTop > 200);
    await page.$eval('.ag-messages', (messages) => { messages.scrollTop = 0; });
    await page.click('#play');
    await page.waitForFunction(() => document.querySelector('.ag-messages').scrollTop > 400);
    const messages = await page.$('.ag-messages');
    const box = await messages.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    // 따라가기 스크롤이 멈춘 뒤의 위치를 기준으로 삼는다. 움직이는 중에 읽으면 휠이 그 움직임과 겹친다.
    await page.waitForFunction(() => new Promise((done) => {
      const node = document.querySelector('.ag-messages');
      const before = node.scrollTop;
      setTimeout(() => done(Math.abs(node.scrollTop - before) < 1), 250);
    }));
    const followedTop = await messages.evaluate((node) => node.scrollTop);
    // 답변 아래 끝 여백까지 화면 밖으로 넘길 만큼 올린다.
    await page.mouse.wheel({ deltaY: -700 });
    await page.waitForFunction((top) => document.querySelector('.ag-messages').scrollTop < top - 80, {}, followedTop);
    // 입력기는 대화 끝이 충분히 가려진 뒤 이어지는 위 스크롤에서 접힌다.
    const scrolledTop = await messages.evaluate((node) => node.scrollTop);
    await page.mouse.wheel({ deltaY: -60 });
    await page.waitForSelector('.ag-composer.ag-resting');
    await page.waitForFunction((top) => new Promise((done) => {
      const node = document.querySelector('.ag-messages');
      const before = node.scrollTop;
      setTimeout(() => done(before < top && Math.abs(node.scrollTop - before) < 1), 250);
    }), {}, scrolledTop);
    const pausedTop = await messages.evaluate((node) => node.scrollTop);
    // 멈춘 턴은 닫히지 않은 마지막 문단을 그리지 않으므로 그 앞 목록까지 기다린다.
    await page.waitForFunction(() => document.querySelector('.ag-messages').textContent.includes('단계별 일정과 담당자를 확인합니다.'));
    assert(Math.abs((await messages.evaluate((node) => node.scrollTop)) - pausedTop) < 4);
    await page.mouse.wheel({ deltaY: 1800 });
    await page.waitForFunction(() => {
      const node = document.querySelector('.ag-messages');
      return node.scrollHeight - node.scrollTop - node.clientHeight < 4;
    });
    await page.waitForSelector('.ag-composer:not(.ag-resting)');
    // 실행 중인 답변은 첫 줄에 고정되고 끝을 쫓지 않는다. 턴을 멈춰 답변을 확정한 뒤,
    // 그 아래로 붙는 내용은 다시 끝을 따라가는지 본다.
    await page.$eval('.ag-send', (button) => button.click());
    await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
    const resumedTop = await messages.evaluate((node) => node.scrollTop);
    await page.evaluate(() => {
      const messages = document.querySelector('.ag-messages');
      const more = document.createElement('div');
      // 끝 여백이 흡수하지 못할 만큼 길게 붙인다.
      more.style.minHeight = '1200px';
      messages.insertBefore(more, messages.querySelector('.ag-messages-end'));
    });
    await page.waitForFunction((top) => document.querySelector('.ag-messages').scrollTop > top + 100, {}, resumedTop);
    // 접힌 입력기는 누르는 순간 설정 줄과 함께 다시 펼쳐진다.
    await page.mouse.wheel({ deltaY: -120 });
    await page.waitForSelector('.ag-composer.ag-resting');
    await page.click('.ag-input');
    await page.waitForSelector('.ag-composer:not(.ag-resting) .ag-composer-meta', { visible: true });
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  });
  await step('Provider, model and effort changes after the first reply', async () => {
    await play('chat');
    const messageCount = await page.$$eval('.ag-msg-user', (nodes) => nodes.length);
    await page.click('[aria-label="프로바이더 선택"]');
    await page.waitForSelector('.ag-config-panel.ag-open');
    await page.click('.ag-provider-item[data-agent="codex"]');
    await page.click('.ag-llm-item[data-model="luna"]');
    await page.click('.ag-llm-item[data-model="astra"]');
    await page.focus('.ag-eslider');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.querySelector('.ag-effort-name').textContent === 'Max');
    assert.equal(await page.$eval('.ag-llm-name', (node) => node.textContent), 'Astra');
    assert.equal(await page.$$eval('.ag-msg-user', (nodes) => nodes.length), messageCount);
    await screenshot('provider-settings-after-reply');
    await page.click('.ag-provider-item[data-agent="pi"]');
    await page.click('.ag-provider-item[data-agent="claude"]');
    await page.click('.ag-llm-item[data-model="haiku"]');
    assert.equal(await page.$eval('.ag-eslider', (node) => node.getAttribute('aria-valuemax')), '2');
    await page.click('.ag-input');
    await page.type('.ag-input', 'Continue the same conversation after changing the model.');
    await page.click('.ag-send');
    await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
    assert.equal(await page.$eval('[aria-label="프로바이더 선택"]', (node) => node.disabled), true);
    await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
    assert.equal(await page.$eval('[aria-label="프로바이더 선택"]', (node) => node.disabled), false);
    assert.equal(await page.$$eval('.ag-msg-user', (nodes) => nodes.length), messageCount + 1);
  });
  await step(
    'Plan approval and document change acceptance/rejection',
    async () => {
      await play('plan');
      await page.waitForSelector('.ag-plan-approve', { visible: true });
      await screenshot('plan');
      await page.click('.ag-plan-approve');
      await page.waitForFunction(
        () => window.sidebarPreview.snapshot().pendingChanges === 1,
      );
      await page.click('.ag-review-card .ag-approve');
      await page.waitForFunction(
        () => window.sidebarPreview.snapshot().pendingChanges === 0,
      );
      assert.equal(await page.$('.ag-review-card:not(.ag-review-card-leaving)'), null);
      assert.equal(await page.$eval('.ag-agent-undo-btn', (node) => node.hidden), false);
      await page.click('.ag-agent-undo-btn');
      await page.waitForFunction(() => window.sidebarPreview.undoState.calls === 1);
      assert.equal(await page.$eval('.ag-agent-undo-btn', (node) => node.hidden), true);
      await play('review');
      await page.waitForSelector('.ag-review-card .ag-reject', {
        visible: true,
      });
      await screenshot('review');
      await page.click('.ag-review-card .ag-reject');
      await page.waitForFunction(
        () => window.sidebarPreview.snapshot().pendingChanges === 0,
      );
    },
  );
  await step('Plan research, revision, execution progress, and review',
    () => checkPlanPreview(page, origin, artifacts));
  await step('Question submission and resolution', async () => {
    await play('question');
    await screenshot('question');
    await page.click('.ag-question-option');
    await page.click('.ag-question-next');
    await page.waitForFunction(
      () => !window.sidebarPreview.bridge.getPendingUserQuestion(),
    );
    await page.waitForFunction(() =>
      document.querySelector('.ag-root').innerText.includes('선택한 문체'),
    );
  });
  await step('Shared Pi model selection', () => checkPiModels(page, origin));
  await step('Embedded CLI login terminal', () => checkSetupTerminal(page, origin));
  await step('Provider picker only lists connected providers', async () => {
    await open();
    const visible = () => page.$$eval('.ag-provider-item', items => items.filter(item => !item.hidden).map(item => item.dataset.agent));
    assert.equal((await visible()).length, 3);
    await page.evaluate(() => window.sidebarPreview.setServices(false));
    assert.deepEqual(await visible(), []);
  });
  await step('Context meter, compaction, and provider handoff', () => checkContextPreview(page, origin, artifacts));
  await step('Compact live subagent previews', () => checkFleetPreview(page, origin));
  await step('Full-screen changes, history, commit, discard, and review',
    () => checkChangesPreview(page, origin, artifacts));
  await step('Subagent fleet, failure, and offline recovery', async () => {
    await play('fleet');
    await page.waitForSelector('.ag-fleet-slot:not([hidden]) .ag-fleet-toggle');
    await page.click('.ag-fleet-slot:not([hidden]) .ag-fleet-toggle');
    await page.waitForFunction(() => document.querySelector('.ag-root').innerText.includes('용어를 통일'));
    await screenshot('fleet');
    await play('error');
    await page.waitForFunction(() =>
      document.querySelector('.ag-root').innerText.includes('앗, 오류에요! 네트워크 연결을 확인하세요!'),
    );
    assert(
      !(await page.$eval('.ag-root', (element) =>
        element.innerText.includes('작업 완료 · 문서 확인'),
      )),
    );
    await page.select('#connection', 'disconnected');
    await screenshot('disconnected');
    await page.evaluate(() => window.sidebarPreview.bridge.reconnectNow());
    await page.waitForFunction(
      () => document.querySelector('#connection').value === 'connected',
    );
  });
  await step('All provider/model catalogs and skill library', async () => {
    await open();
    await page.click('[aria-label="프로바이더 선택"]');
    for (const agent of ['claude', 'codex', 'pi']) {
      await page.click(`.ag-provider-item[data-agent="${agent}"]`);
      await page.waitForFunction(
        (agent) => window.sidebarPreview.bridge.getActiveAgent() === agent,
        {},
        agent,
      );
      assert(
        await page.$eval(
          '.ag-llm-trigger',
          (element) => element.textContent.trim().length > 0,
        ),
      );
    }
    await page.keyboard.press('Escape');
    await page.click('.ag-settings-btn');
    await page.waitForSelector('.ag-root.ag-settings-open');
    await page.click('.ag-settings-nav-button[data-destination="skills"]');
    await page.waitForSelector('#ag-settings-pane-skills .ag-skills-list');
    await page.type('.ag-skills-search', 'proofread');
    await page.waitForFunction(
      () => {
        const rows = [...document.querySelectorAll('.ag-skill-copy')];
        return rows.length === 1 && rows[0].textContent.includes('proofread-korean');
      },
    );
    await screenshot('skills');
    const pressed = await page.$eval('.ag-skill-toggle', (element) =>
      element.getAttribute('aria-pressed'),
    );
    await page.click('.ag-skill-toggle');
    await page.waitForFunction(
      (before) =>
        document.querySelector('.ag-skill-toggle')?.getAttribute('aria-pressed') !== before,
      {},
      pressed,
    );
  });
  await step('Reference upload, search, and deletion', async () => {
    await open();
    await page.click('.ag-references-btn');
    await clickText('.ag-reference-tab', '모든 채팅');
    await page.waitForSelector('.ag-reference-file', { visible: true });
    await screenshot('references');
    const [chooser] = await Promise.all([
      page.waitForFileChooser(),
      page.click('.ag-reference-add'),
    ]);
    await chooser.accept([sampleFile]);
    await page.waitForSelector('[aria-label="sample.txt 참고자료 제거"]', {
      visible: true,
    });
    await page.click('[aria-label="sample.txt 참고자료 제거"]');
    // 제거 확인은 사이드바 안의 확인 시트로 뜬다.
    await page.waitForSelector('.ag-sheet-layer.ag-sheet-open .ag-sheet-confirm', { visible: true });
    await page.click('.ag-sheet-confirm');
    await page.waitForSelector('[aria-label="sample.txt 참고자료 제거"]', {
      hidden: true,
    });
    await page.type('.ag-reference-search', '브랜드');
    await page.waitForSelector('.ag-reference-search-hit', { visible: true });
    await page.evaluate(async () => {
      const bridge = window.sidebarPreview.bridge;
      const file = await bridge.uploadReference(
        'global',
        'global',
        new File(['sample'], 'sample.txt', { type: 'text/plain' }),
      );
      if (
        !(await bridge.listReferences('global', 'global')).some(
          (item) => item.id === file.id,
        )
      )
        throw new Error('Upload missing');
      await bridge.deleteReference(file);
      if (
        (await bridge.listReferences('global', 'global')).some(
          (item) => item.id === file.id,
        )
      )
        throw new Error('Delete failed');
    });
  });
  await step('Dragging an image without a filename extension stages it as an attachment', async () => {
    await open();
    const drop = await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(['image bytes'], 'image-from-browser', { type: 'image/png' }));
      const input = document.querySelector('.ag-input');
      input.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data }));
      input.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
      const event = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data });
      input.dispatchEvent(event);
      return { prevented: event.defaultPrevented, types: [...data.types] };
    });
    assert.deepEqual(drop, { prevented: true, types: ['Files'] });
    await page.waitForSelector('.ag-reference-upload-chip', { visible: true });
    assert.match(await page.$eval('.ag-reference-upload-chip-name', (node) => node.textContent), /^드롭한 이미지 .+\.png$/);
  });
  await step(
    'Settings, usage, templates, and writing style',
    async () => {
      await open('page=settings');
      await clickText('.ag-settings-nav-button', 'AI');
      await page.waitForSelector('.ag-settings-quota-fill[data-health="low"]', { visible: true });
      assert.match(await page.$eval('.ag-settings-balance-card[data-provider="openrouter"] .ag-settings-balance-amount', (el) => el.textContent), /\$18\.50/);
      assert.equal(await page.$eval('.ag-settings-balance-card[data-provider="openrouter"] [role="meter"]', (el) => el.getAttribute('aria-valuenow')), '92.5');
      assert.deepEqual(await page.$$eval('.ag-settings-balance-card', (cards) => cards.map((card) => card.dataset.provider)), ['openrouter']);
      assert.equal(await page.$eval('.ag-settings-quota-card[data-provider="codex"] [role="meter"]', (el) => el.getAttribute('aria-valuenow')), '8');
      assert.equal(await page.$eval('.ag-settings-usage-disclosure', el => el.open), false);
      await page.click('.ag-settings-usage-disclosure > summary');
      await page.click('.ag-settings-usage-block[data-agent="codex"] .ag-settings-usage-toggle');
      assert.equal(await page.$eval('.ag-settings-usage-block[data-agent="codex"] .ag-settings-usage-expanded', el => el.hidden), false);
      await screenshot('local-usage-table');
      await page.click('.ag-settings-usage-block[data-agent="codex"] .ag-settings-usage-toggle');
      assert.equal(await page.$eval('.ag-settings-usage-block[data-agent="codex"] .ag-settings-usage-expanded', el => el.hidden), true);
      await page.click('.ag-settings-usage-disclosure > summary');
      // Usage polling replaces quota cards while the click scrolls into view.
      await page.locator('[data-action="request-reset"]').click();
      await page.waitForSelector('[data-action="confirm-reset"]', { visible: true });
      assert.match(await page.$eval('.ag-provider-quotas', (el) => el.textContent), /보관한 리셋 2개/);
      await page.click('[data-action="confirm-reset"]');
      assert.equal(await page.$eval('[data-action="confirm-reset"]', (el) => el.disabled), true);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('rhwp-codex-pending-reset')).account), 'preview-codex');
      await page.waitForFunction(() => document.querySelector('.ag-provider-quotas').textContent.includes('한도 리셋 완료'));
      assert.match(await page.$eval('.ag-provider-quotas', (el) => el.textContent), /보관한 리셋 1개/);
      assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-codex-pending-reset')), null);
      assert.equal(await page.$eval('.ag-settings-quota-card[data-provider="codex"] [role="meter"]', (el) => el.getAttribute('aria-valuenow')), '100');
      await screenshot('usage');
      await page.click('[data-action="refresh-usage"]');
      assert.equal(await page.$eval('[data-action="refresh-usage"]', (el) => el.disabled), true);
      await page.waitForFunction(() => !document.querySelector('[data-action="refresh-usage"]').disabled);
      await screenshot('settings');
      await open('page=settings');
      await clickText('.ag-settings-nav-button', 'AI');
      await page.waitForSelector('.ag-template-row', { visible: true });
      await screenshot('ai-settings');
      await page.evaluate(async () => {
        const bridge = window.sidebarPreview.bridge;
        const template = await bridge.addTemplate(
          new File(['sample'], 'sample.hwpx'),
          '샘플 양식',
        );
        await bridge.renameTemplate(template.id, '수정 양식');
        if (
          !(await bridge.listTemplates()).templates.some(
            (item) => item.name === '수정 양식',
          )
        )
          throw new Error('Rename missing');
        await bridge.deleteTemplate(template.id);
        const status = await bridge.requestAgentInstructions();
        await bridge.saveAgentInstructions(
          '수정된 지시입니다.',
          status.revision,
        );
        if (
          (await bridge.requestAgentInstructions()).content !==
          '수정된 지시입니다.'
        )
          throw new Error('Instructions not saved');
        await new Promise((resolve) => {
          const unsubscribe = bridge.onEvent((event) => {
            if (event.type === 'writing-style-result') {
              unsubscribe();
              resolve();
            }
          });
          bridge.calibrateWritingStyle({
            language: 'ko',
            files: [
              {
                name: 'sample.txt',
                type: 'text/plain',
                size: 6,
                content: 'sample',
              },
            ],
            agent: 'codex',
            model: 'sample',
            append: false,
          });
        });
      });
    },
  );
  await step('Provider quota failure and exhausted reset credit', async () => {
    await open('page=settings&quota=pro');
    await clickText('.ag-settings-nav-button', 'AI');
    await page.waitForSelector('.ag-settings-quota-card[data-provider="codex"]');
    assert.equal(await page.$$eval('.ag-settings-quota-card[data-provider="codex"] [role="meter"]', (meters) => meters.length), 1);
    assert.doesNotMatch(await page.$eval('.ag-settings-quota-card[data-provider="codex"]', (el) => el.textContent), /5시간/);
    assert.match(await page.$eval('.ag-settings-quota-card[data-provider="claude"]', (el) => el.textContent), /5시간/);
    await open('page=settings&quota=error');
    await clickText('.ag-settings-nav-button', 'AI');
    await page.waitForSelector('.ag-settings-quota-card[data-state="error"]');
    assert.match(await page.$eval('.ag-provider-quotas', (el) => el.textContent), /제공자가 응답하지 않아요/);
    assert.equal(await page.$eval('.ag-settings-quota-card[data-provider="codex"] [role="meter"]', (el) => el.hasAttribute('aria-valuenow')), false);
    assert.equal(await page.$('[data-action="request-reset"]'), null);
    await open('page=settings&quota=refresh-error');
    await clickText('.ag-settings-nav-button', 'AI');
    await page.waitForFunction(() => !document.querySelector('[data-action="refresh-usage"]').disabled);
    await page.click('[data-action="refresh-usage"]');
    await page.waitForFunction(() => document.querySelector('.ag-settings-body').textContent.includes('연결이 일시적으로 끊겼어요.'));
    await page.click('[data-action="refresh-usage"]');
    await page.waitForFunction(() => !document.querySelector('[data-action="refresh-usage"]').disabled);
    assert.equal(await page.$eval('.ag-settings-body', (el) => el.textContent.includes('연결이 일시적으로 끊겼어요.')), false);
    await open('page=settings&quota=empty');
    await clickText('.ag-settings-nav-button', 'AI');
    await page.waitForSelector('[data-action="request-reset"]');
    assert.equal(await page.$eval('[data-action="request-reset"]', (el) => el.disabled), true);
    await page.evaluate(() => localStorage.setItem('rhwp-codex-pending-reset', JSON.stringify({
      key: 'reset-interrupted-request-123456', account: 'preview-codex',
    })));
    await open('page=settings&quota=empty');
    await clickText('.ag-settings-nav-button', 'AI');
    await page.waitForSelector('[data-action="confirm-reset"]');
    assert.equal(await page.$eval('[data-action="confirm-reset"]', (el) => el.disabled), false,
      'An interrupted reset can be checked again after reload even with zero credits');
    await page.click('[data-action="confirm-reset"]');
    await page.waitForFunction(() => document.querySelector('.ag-provider-quotas').textContent.includes('리셋 크레딧 없음'));
    assert.equal(await page.evaluate(() => localStorage.getItem('rhwp-codex-pending-reset')), null);
  });
  await step(
    'Unconfigured provider installation and local OAuth placeholder',
    async () => {
      await open('services=setup&page=settings');
      await clickText('.ag-settings-nav-button', 'AI');
      const codexRow = '.ag-settings-provider-row[data-agent="codex"]';
      await page.click(`${codexRow} summary`);
      assert.equal(await page.$eval(codexRow, el => el.open), true);
      await page.click('.ag-settings-provider-row[data-agent="claude"] summary');
      await page.waitForFunction(() => !document.querySelector('.ag-settings-provider-row[data-agent="codex"]').open);
      await page.focus(`${codexRow} summary`);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.ag-settings-provider-row[data-agent="codex"]').open);
      await screenshot('connection-accordion');
      await page.click(`${codexRow} .ag-provider-setup-btn`);
      await page.waitForSelector(
        '.ag-agent-setup-overlay[aria-hidden="false"]',
      );
      await clickText('.ag-agent-setup-primary', '설치하고 계속');
      await page.waitForFunction(
        async () =>
          (await window.sidebarPreview.bridge.requestAgentSetupStatus()).codex
            .installed,
      );
      await page.waitForSelector('.ag-setup-terminal .xterm-helper-textarea');
      await page.focus('.ag-setup-terminal .xterm-helper-textarea');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        async () =>
          (await window.sidebarPreview.bridge.requestAgentSetupStatus()).codex
            .connected,
      );
      await page.click('.ag-agent-setup-close');
    },
  );
  await step(
    'Version graph and mutable branches, checkpoints, shelves, tags',
    async () => {
      await open('page=versions');
      await page.waitForSelector('.ag-root.ag-versions-open');
      await screenshot('versions');
      await page.click('[aria-label="새 커밋 만들기"]');
      await page.waitForSelector('.ag-version-prompt-input', { visible: true });
      await page.type(
        '.ag-version-prompt-input',
        '디자인 검토 내용을 저장했습니다.',
      );
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => window.sidebarPreview.versions.getState().commits.length === 4,
      );
      await clickText('.ag-versions-tab', '브랜치');
      await screenshot('branches');
      await page.evaluate(async () => {
        const controller = window.sidebarPreview.versions;
        await controller.createBranch('테스트');
        await controller.switchBranch('테스트');
        await controller.renameBranch('테스트', '디자인');
        await controller.createTag('v1', controller.getState().commits[0].id);
        await controller.createShelf('디자인 초안');
        const shelf = controller.getState().shelves[0];
        await controller.applyShelf(shelf.id, true);
        if (controller.getState().shelves.some((item) => item.id === shelf.id))
          throw new Error('Shelf not removed');
        if (controller.getState().activeBranch !== '디자인')
          throw new Error('Branch not selected');
        await controller.switchBranch('main');
        await controller.deleteBranch('디자인');
      });
    },
  );
  await step('Branch commits keep their graph lane and move the branch label', async () => {
    await open('page=versions&history=branches&theme=dark&width=480');
    await screenshot('versions-dark');
    assert.equal(await page.$$eval('.ag-version-meta, .ag-version-time', (items) => items.length), 0);
    const initialRowHeight = await page.$eval('.ag-version-row', (row) => row.getBoundingClientRect().height);
    await page.hover('.ag-version-row');
    await page.waitForSelector('.ag-version-date-tooltip.ag-visible', { visible: true });
    assert.match(await page.$eval('.ag-version-date-tooltip', (tip) => tip.textContent), /월/);
    assert.equal(await page.$eval('.ag-version-row', (row) => row.getBoundingClientRect().height), initialRowHeight);
    await screenshot('versions-date-hover');
    await page.focus('.ag-version-row');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ag-version-date-tooltip').classList.contains('ag-visible'));
    assert(await page.$eval('.ag-root', (root) => root.classList.contains('ag-versions-open')));
    await page.click('[aria-label="이 커밋에서 브랜치 만들기"]');
    await page.waitForSelector('.ag-version-prompt-input', { visible: true });
    await page.type('.ag-version-prompt-input', '새-디자인');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.sidebarPreview.versions.getState().activeBranch === '새-디자인');
    await page.click('[aria-label="새 커밋 만들기"]');
    await page.waitForSelector('.ag-version-prompt-input', { visible: true });
    await page.type('.ag-version-prompt-input', '새 브랜치에서 만든 커밋');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.sidebarPreview.versions.getState().commits[0].title === '새 브랜치에서 만든 커밋');
    const result = await page.evaluate(() => {
      const state = window.sidebarPreview.versions.getState();
      const head = state.commits[0];
      const branch = state.branches.find((item) => item.name === '새-디자인');
      const main = state.commits.find((item) => item.id === state.branches.find((branch) => branch.isDefault).headId);
      const row = document.querySelector(`[data-commit-id="${head.id}"]`);
      return { branchAtHead: branch.headId === head.id, parent: head.parentIds[0],
        separateLane: head.lane !== main.lane, label: row.innerText.includes('새-디자인'),
        current: head.isHead, selected: row.getAttribute('aria-selected') };
    });
    assert.deepEqual(result, { branchAtHead: true, parent: 'e8f21a0', separateLane: true, label: true, current: true, selected: 'true' });
    await screenshot('versions-branch-commit');
    await open('page=versions&history=branches&width=360');
    await screenshot('versions-light-narrow');
    assert(await page.$eval('.ag-versions-page', (el) => el.scrollWidth <= el.clientWidth), 'Narrow panel overflows');
    await open('width=480');
  });
  await step('AI model choices stage, cancel, save, and filter the composer', async () => {
    await open('page=settings&destination=ai&reset=1&width=360');
    await page.waitForSelector('.ag-settings-model-row[data-model-id="claude-haiku-4-5"]');
    await page.type('.ag-settings-model-search-input', 'haiku');
    assert.equal(await page.$$eval('.ag-settings-model-row', (rows) => rows.length), 1);
    await page.click('.ag-settings-model-row');
    assert.equal(await page.$eval('.ag-settings-ai-footer .ag-settings-primary', (button) => button.disabled), false);
    await clickText('.ag-settings-ai-footer button', '취소');
    assert.equal(await page.$eval('.ag-settings-model-row', (row) => row.getAttribute('aria-pressed')), 'true');
    await page.click('.ag-settings-model-row');
    await clickText('.ag-settings-ai-footer button', '적용');
    assert.equal(await page.$eval('.ag-settings-ai-footer .ag-settings-primary', (button) => button.disabled), true);
    await page.click('.ag-settings-close');
    await page.click('.ag-llm-trigger');
    assert.deepEqual(await page.$$eval('.ag-llm-item', (rows) => rows.map((row) => row.dataset.model)),
      ['claude-opus-4-6', 'claude-sonnet-4-6']);
  });
  await step(
    'Document context, reset, clean canvas, and backend isolation',
    async () => {
      await open();
      await page.select('#document', 'notes');
      await page.waitForFunction(() =>
        document.querySelector('.ag-root').innerText.includes('회의록.hwpx'),
      );
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('#reset'),
      ]);
      await page.waitForFunction(() => window.sidebarPreview);
      assert.equal(
        await page.evaluate(async () => {
          await window.sidebarPreview.threadStore.waitForThreadsPersistence();
          return window.sidebarPreview.threadStore.listThreads().length;
        }),
        0,
      );
      await open('controls=0');
      assert(
        await page.$eval('#preview-controls', (element) => element.hidden),
      );
      assert.equal(
        await page.evaluate(
          async () => (await navigator.serviceWorker.getRegistrations()).length,
        ),
        0,
      );
      assert.deepEqual(
        forbidden,
        [],
        'No remote services, document engine, or application entry point',
      );
      assert.deepEqual(errors, [], 'No browser errors');
    },
  );
  console.log(`Sidebar checks passed. Screenshots: ${artifacts}`);
} finally {
  const browserProcess = browser?.process();
  await browser?.close();
  // Detached Chrome helpers can retain inherited output pipes after its exit.
  browserProcess?.stdout?.destroy();
  browserProcess?.stderr?.destroy();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}

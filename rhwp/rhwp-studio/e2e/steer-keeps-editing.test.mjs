/**
 * 에이전트 모드에서 '지금 보내기'가 편집 턴을 끊지 않고 이어 가는지 실제 Studio + 허브 + WASM에서 확인한다.
 * 끊긴 턴 끝에는 검토 카드가 뜨지 않고, 끼어든 메시지의 턴이 끝날 때 두 편집이 한 카드로 뜬다.
 * 일반 중지는 그대로 바로 검토를 띄운다. Pi는 턴 시작/종료만 제어하는 fixture다.
 * 실행: node e2e/steer-keeps-editing.test.mjs --mode=headless
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'vite';
import { registerHubSession } from '../../../desktop/agent-hub.mjs';
import {
  ensureChromePath, findAvailablePort, repoRoot, startHub, stopServer, studioRoot, writeFakePi,
} from './agent-bench-harness.mjs';

ensureChromePath();
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rhwp-steer-e2e-'));
const evidenceDir = process.env.RHWP_STEER_EVIDENCE_DIR || path.join(repoRoot, 'output', 'e2e', 'steer-keeps-editing');
fs.mkdirSync(evidenceDir, { recursive: true });
const { piRoot, finishTurnPath } = writeFakePi(fixtureRoot);
const hubPort = await findAvailablePort(5860);
const vitePort = await findAvailablePort(7860);
const token = randomUUID();
let hub;
let vite;
let provider;

async function health() {
  const response = await fetch(`http://127.0.0.1:${hubPort}/healthz`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return response.json();
}

/** 지금 도는 턴의 허브 세션에 fixture MCP 소켓을 붙인다. */
async function attachProvider(page) {
  const snapshot = await health();
  const sessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess()?.sessionId);
  const record = snapshot.sessions.find((row) => row.sessionId === sessionId);
  assert.ok(record?.sessionId, 'the real editor has an authenticated hub session');
  const capabilities = await registerHubSession({
    port: hubPort, token, launchId: snapshot.launchId, sessionId: record.sessionId,
  });
  provider?.socket.close();
  const socket = new WebSocket(
    `ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(capabilities.mcp)}`
      + `&sessionId=${encodeURIComponent(record.sessionId)}&agent=pi&role=chat`,
  );
  const calls = new Map();
  let sequence = 0;
  socket.addEventListener('message', (event) => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'tool-result') return;
    const pending = calls.get(frame.id);
    if (!pending) return;
    calls.delete(frame.id);
    clearTimeout(pending.timer);
    pending.resolve(frame);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('The authenticated MCP connection failed')), { once: true });
  });
  provider = {
    socket,
    call(tool, args) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          calls.delete(id);
          reject(new Error(`Tool result timeout: ${tool}`));
        }, 30_000);
        calls.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({
          v: 5, type: 'tool-call', id, tool, args,
          workflow: record.session.workflow, capabilityEpoch: record.session.capabilityEpoch,
        }));
      });
    },
  };
  return record.session;
}

function must(frame, label) {
  assert.equal(frame.ok, true, `${label}: ${frame.error?.code} ${frame.error?.message}`);
  return frame.result;
}

try {
  hub = await startHub({
    hubPort, token, fixtureRoot, env: { RHWP_PI_DIR: piRoot }, logName: 'steer-keeps-editing-e2e-hub.log',
  });
  process.env.VITE_RHWP_AGENT_URL = `ws://127.0.0.1:${hubPort}`;
  process.env.RHWP_AGENT_TOKEN = token;
  process.env.RHWP_AGENT_PORT = String(hubPort);
  vite = await createServer({
    configFile: path.join(studioRoot, 'vite.config.ts'),
    cacheDir: path.join(fixtureRoot, 'vite-cache'),
    server: {
      host: '127.0.0.1', port: vitePort, strictPort: true, open: false,
      fs: { allow: [studioRoot, fs.realpathSync(path.join(studioRoot, '..', 'pkg')),
        path.join(studioRoot, '..', 'samples'), path.join(studioRoot, '..', 'npm', 'editor')] },
    },
    logLevel: 'warn',
  });
  await vite.listen();
  process.env.VITE_URL = `http://127.0.0.1:${vitePort}`;
  const { runTest, createNewDocument, waitForState } = await import('./helpers.mjs');

  await runTest('지금 보내기는 에이전트 편집 턴을 이어 간다', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'chat',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForState(page, 'real editor and hub ready', () => Boolean(window.__wasm)
      && window.__agentBridge?.getConnectionState() === 'connected');
    await createNewDocument(page);
    // 검토 카드·대기 상태가 한 번이라도 떴는지 남긴다 — 순간적으로 떴다 사라져도 잡는다.
    await page.evaluate(() => {
      const log = { events: [], statuses: [], cardSeen: false };
      window.__steerLog = log;
      // 턴 경계는 실행 상태의 전환으로 남긴다(끝 → 시작).
      let running = window.__agentBridge.isTurnRunning();
      setInterval(() => {
        const now = window.__agentBridge.isTurnRunning();
        if (now !== running) log.events.push({ type: now ? 'turn-start' : 'turn-end' });
        running = now;
      }, 2);
      window.__agentBridge.pendingEdits.onChange(() => {
        for (const set of window.__agentBridge.pendingEdits.getChangeSets()) log.statuses.push(set.status);
      });
      new MutationObserver(() => {
        if (document.querySelector('.ag-review-card[data-set-id]:not(.ag-review-card-leaving)')) log.cardSeen = true;
      }).observe(document.body, { subtree: true, childList: true });
    });
    const resetLog = () => page.evaluate(() => {
      Object.assign(window.__steerLog, { events: [], statuses: [], cardSeen: false });
    });
    const readLog = () => page.evaluate(() => window.__steerLog);
    const hasMarker = (text) => page.evaluate((query) => {
      const matches = window.__wasm.searchAllText(query, false, true);
      return (typeof matches === 'string' ? JSON.parse(matches) : matches).length > 0;
    }, text);
    const reviewCards = () => page.$$eval('.ag-review-card[data-set-id]:not(.ag-review-card-leaving)',
      (cards) => cards.map((card) => ({ count: card.querySelector('.ag-review-count')?.textContent,
        stopped: Boolean(card.querySelector('.ag-review-note')) })));
    const changeSets = () => page.evaluate(() => window.__agentBridge.pendingEdits.getChangeSets()
      .map((set) => ({ status: set.status, ops: set.ops.length })));
    const write = async (text) => {
      const current = must(await provider.call('get_structure', { format: 'json' }), 'get_structure');
      must(await provider.call('insert_text', {
        sectionIdx: 0, paraIdx: 0, charOffset: 0, text, expectedRevision: current.revision,
      }), `insert ${text}`);
      assert.equal(await hasMarker(text), true, `${text} is staged in the document preview`);
    };
    const startTurn = async (text) => {
      fs.rmSync(finishTurnPath, { force: true });
      await waitForState(page, 'enabled composer', () => {
        const input = document.querySelector('.ag-input');
        return input && !input.disabled;
      });
      await page.type('.ag-input', text);
      await page.click('.ag-send');
      await waitForState(page, 'fixture provider turn', () => window.__agentBridge.isTurnRunning());
      return attachProvider(page);
    };
    const finishTurn = async () => {
      fs.writeFileSync(finishTurnPath, '');
      await waitForState(page, 'completed fixture turn', () => !window.__agentBridge.isTurnRunning());
      fs.rmSync(finishTurnPath, { force: true });
    };
    const selectMode = async (mode) => {
      await page.click('.ag-mode-btn');
      await page.click(`.ag-mode-item[data-mode="${mode}"]`);
      await waitForState(page, 'selected mode', (expected) =>
        document.querySelector('.ag-mode')?.dataset.mode === expected, mode);
    };
    /** 턴 1 쓰기 → 후속 메시지 대기열 → 지금 보내기 → 턴 2 쓰기 → 끝. 검토 카드 하나를 남긴다. */
    const steerRun = async (label, via) => {
      const a = `${label} first edit`;
      const b = `${label} steered edit`;
      const session = await startTurn(`Edit the paragraph (${label}).`);
      assert.equal(session.workflow, 'direct');
      assert.equal(session.permissionProfile, 'safe');
      await write(a);
      await resetLog();
      await page.type('.ag-input', `Also add the steered edit (${label}).`);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.ag-followup-send-now');
      assert.equal(await page.evaluate(() => window.__agentBridge.isTurnRunning()), true, 'Enter only queued the follow-up');
      if (via === 'button') {
        await page.click('.ag-followup-send-now');
      } else {
        const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
        await page.focus('.ag-input');
        await page.keyboard.down(mod);
        await page.keyboard.press('Enter');
        await page.keyboard.up(mod);
      }
      await waitForState(page, 'steered turn started', () => {
        const events = window.__steerLog.events;
        return events.length >= 2 && events.at(-1).type === 'turn-start' && window.__agentBridge.isTurnRunning();
      });
      const afterInterrupt = await readLog();
      assert.equal(afterInterrupt.events[0].type, 'turn-end', JSON.stringify(afterInterrupt.events));
      assert.equal(afterInterrupt.cardSeen, false, 'no review card after the steered interrupt');
      assert.equal(afterInterrupt.statuses.includes('awaiting-review'), false, JSON.stringify(afterInterrupt.statuses));
      assert.deepEqual(await reviewCards(), []);
      assert.equal(await hasMarker(a), true, 'the first edit stays in the preview through the interrupt');
      assert.equal(await page.$('.ag-followup-send-now'), null, 'the queued follow-up was dispatched');

      await attachProvider(page);
      await write(b);
      assert.deepEqual(await reviewCards(), [], 'no review while the steered turn runs');
      await finishTurn();
      await page.waitForSelector('.ag-review-card[data-set-id] .ag-approve');
      const cards = await reviewCards();
      assert.equal(cards.length, 1, JSON.stringify(cards));
      assert.equal(cards[0].count, '02건', 'one card holds both edits');
      assert.equal(cards[0].stopped, false, 'the steered turn ended normally');
      const sets = await changeSets();
      assert.deepEqual(sets, [{ status: 'awaiting-review', ops: 2 }], JSON.stringify(sets));
      assert.equal(await hasMarker(a) && await hasMarker(b), true);
      return { a, b, events: afterInterrupt.events };
    };

    await selectMode('agent');

    console.log('Scenario: 지금 보내기 단추 → 한 카드, 수락');
    const run1 = await steerRun('Steer one', 'button');
    await page.screenshot({ path: path.join(evidenceDir, 'steer-review-card.png') });
    await page.click('.ag-review-card[data-set-id] .ag-approve');
    await waitForState(page, 'approved', () => !window.__agentBridge.pendingEdits.hasPending());
    assert.equal(await hasMarker(run1.a) && await hasMarker(run1.b), true, 'approval keeps both edits');

    console.log('Scenario: ⌘/Ctrl+Enter → 한 카드, 거절');
    const run2 = await steerRun('Steer two', 'shortcut');
    await page.screenshot({ path: path.join(evidenceDir, 'steer-shortcut-review-card.png') });
    await page.click('.ag-review-card[data-set-id] .ag-reject');
    await waitForState(page, 'rejected', () => !window.__agentBridge.pendingEdits.hasPending());
    assert.equal(await hasMarker(run2.a) || await hasMarker(run2.b), false, 'rejection removes both edits');
    assert.equal(await hasMarker(run1.a), true, 'earlier approved edits stay');

    console.log('Scenario: 일반 중지는 바로 검토');
    await startTurn('Edit then get stopped.');
    await write('Plain stop edit');
    await resetLog();
    await page.click('.ag-stop');
    await waitForState(page, 'stopped', () => !window.__agentBridge.isTurnRunning());
    await page.waitForSelector('.ag-review-card[data-set-id] .ag-reject', { timeout: 5_000 });
    const stopCards = await reviewCards();
    assert.equal(stopCards.length, 1);
    assert.equal(stopCards[0].stopped, true);
    await page.screenshot({ path: path.join(evidenceDir, 'plain-stop-review-card.png') });
    await page.click('.ag-review-card[data-set-id] .ag-reject');
    await waitForState(page, 'stop rejected', () => !window.__agentBridge.pendingEdits.hasPending());
    assert.equal(await hasMarker('Plain stop edit'), false);

    assert.deepEqual(errors, [], 'the real editor raises no page errors');
    console.log(`  interrupt events: ${JSON.stringify(run1.events)}`);
    console.log(`  Evidence: ${evidenceDir}`);
  });
} finally {
  provider?.socket.close();
  await vite?.close();
  await stopServer(hub);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

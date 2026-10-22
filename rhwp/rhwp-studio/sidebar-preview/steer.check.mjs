// 지금 보내기(steer): 허브가 끼워 넣기를 알면 도는 턴을 멈추지 않고 메시지를 그 턴에 넣는다 —
// 서브에이전트가 멈추지 않는다. 공급자가 거절하면 예전처럼 멈추고 보낸다.
// 혼자 돌릴 때: node sidebar-preview/steer.check.mjs (CHROME_PATH 필요, standalone.mjs 가 자기 Vite 서버를 띄운다).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

function steerState(page) {
  return page.evaluate(() => {
    const snapshot = window.sidebarPreview.snapshot();
    const conversation = [...document.querySelectorAll('.ag-msg-user, .ag-msg-assistant')]
      .filter((node) => !node.closest('.ag-progress-step'))
      .map((node) => `${node.classList.contains('ag-msg-user') ? 'user' : 'assistant'}:${node.textContent.trim()}`);
    return {
      messageTexts: snapshot.messageTexts,
      steers: snapshot.steers,
      interrupts: snapshot.interrupts,
      running: snapshot.running,
      rows: [...document.querySelectorAll('.ag-followup')].map((row) => row.querySelector('.ag-followup-text')?.title ?? ''),
      conversation,
    };
  });
}

async function waitFor(page, predicate, arg, message) {
  try {
    await page.waitForFunction(predicate, { timeout: 5000 }, arg);
  } catch (error) {
    throw new Error(`${message}: ${JSON.stringify(await steerState(page))}`, { cause: error });
  }
}

async function sendNowKey(page) {
  const mac = await page.evaluate(() => /mac/i.test(navigator.userAgentData?.platform || navigator.platform || ''));
  const modifier = mac ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  await page.keyboard.press('Enter');
  await page.keyboard.up(modifier);
}

export async function checkSteerSendNow(page, origin, artifacts) {
  const screenshot = async (name) => {
    const sidebar = await page.$('.ag-root');
    await sidebar.screenshot({ path: resolve(artifacts, `${name}.png`) });
  };
  await page.goto(`${origin}/?theme=light&width=480&reset=1&scenario=chat&hold=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview
    && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  await page.evaluate(() => window.sidebarPreview.setSteerSupported(true));
  await page.click('#play');
  await waitFor(page, () => window.sidebarPreview.snapshot().running, undefined, 'turn did not start');

  // 1. 지금 보내기는 턴을 멈추지 않고 그 턴에 넣는다. 메시지는 대화에 남고 대기열에는 없다.
  await page.focus('.ag-input');
  await page.type('.ag-input', '표도 하나 넣어 줘');
  await sendNowKey(page);
  await waitFor(page, () => window.sidebarPreview.snapshot().steers.length === 1, undefined, 'send now did not steer');
  await waitFor(page, () => [...document.querySelectorAll('.ag-msg-user')].some((node) => node.textContent.includes('표도 하나 넣어 줘')),
    undefined, 'the steered message is not in the conversation');
  let state = await steerState(page);
  assert.deepEqual(state.steers, ['표도 하나 넣어 줘']);
  assert.equal(state.interrupts, 0, 'steering must not stop the turn and its subagents');
  assert.equal(state.running, true);
  assert.equal(state.messageTexts.length, 1, 'the steered message is not sent again as a new turn');
  assert.deepEqual(state.rows, []);

  // 2. 이어지는 답은 끼워 넣은 메시지 아래 새 말풍선에서 시작한다.
  await page.evaluate(() => window.sidebarPreview.streamEvent({ type: 'text-delta', agent: 'claude', text: '표를 추가했습니다.' }));
  await waitFor(page, () => [...document.querySelectorAll('.ag-msg-assistant')].some((node) => node.textContent.includes('표를 추가했습니다.')),
    undefined, 'the reply after the steer did not render');
  state = await steerState(page);
  const steeredAt = state.conversation.indexOf('user:표도 하나 넣어 줘');
  const replyAt = state.conversation.findIndex((entry) => entry.startsWith('assistant:') && entry.includes('표를 추가했습니다.'));
  assert.ok(steeredAt >= 0 && replyAt > steeredAt, `the reply follows the steered message: ${JSON.stringify(state.conversation)}`);
  await screenshot('steer-send-now');

  // 3. 공급자가 끼우지 못하면 예전처럼 멈추고 그 턴이 끝나면 보낸다.
  await page.evaluate(() => window.sidebarPreview.rejectNextSteer());
  await page.type('.ag-input', '맞춤법도 봐 줘');
  await sendNowKey(page);
  await waitFor(page, () => window.sidebarPreview.snapshot().messageTexts.at(-1) === '맞춤법도 봐 줘', undefined, 'a refused steer did not fall back to stop and send');
  state = await steerState(page);
  assert.equal(state.interrupts, 1);
  assert.deepEqual(state.steers, ['표도 하나 넣어 줘']);
  assert.equal(state.conversation.filter((entry) => entry === 'user:맞춤법도 봐 줘').length, 1, 'the fallback shows the message once');
}

if (isMainModule(import.meta)) {
  await runStandalone('Send now steers the running turn without stopping it', checkSteerSendNow);
}

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isMainModule, runStandalone } from './standalone.mjs';

/*
 * Transient statuses appear only after 400 ms and then stay at least 400 ms: the header
 * connection dot, the composer's transient lock (readOnly, so focus and text survive), the
 * "편집 중…" ring at the transcript's end and the rail's 작업 중. The real state still gates
 * sending, and `data-composer-ready` reports it to automation without the delay.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const READY = () => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true';

async function open(page, origin, query = '') {
  const params = new URLSearchParams(query);
  params.set('theme', 'light');
  params.set('reset', '1');
  if (!params.has('width')) params.set('width', '480');
  await page.goto(`${origin}/?${params}`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview);
  await page.waitForFunction(READY);
}

/** Plays the sample reply to its end so a chat exists and no turn runs. */
async function playToEnd(page) {
  await page.evaluate(() => document.querySelector('#play').click());
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning());
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning());
}

/** Records each visible change of the composer's lock and the connection dot, with timestamps. */
function recordComposerAndDot(page) {
  return page.evaluate(() => {
    window.statusRecords = [];
    const input = document.querySelector('.ag-input');
    const dot = document.querySelector('.ag-conn-dot');
    const read = () => ({ dotHidden: dot.hidden, readOnly: input.readOnly, disabled: input.disabled });
    let last = read();
    const observer = new MutationObserver(() => {
      const next = read();
      // Re-setting an attribute to the same value is not a visible change.
      if (Object.keys(next).every((key) => next[key] === last[key])) return;
      last = next;
      window.statusRecords.push({ at: performance.now(), ...next });
    });
    observer.observe(input, { attributes: true, attributeFilter: ['readonly', 'disabled'] });
    observer.observe(dot, { attributes: true, attributeFilter: ['hidden'] });
  });
}

const composerState = (page) => page.evaluate(() => {
  const input = document.querySelector('.ag-input');
  return {
    focused: document.activeElement === input,
    value: input.value,
    readOnly: input.readOnly,
    disabled: input.disabled,
    placeholder: input.placeholder,
    dotHidden: document.querySelector('.ag-conn-dot').hidden,
    ready: document.querySelector('#agent-sidebar').dataset.composerReady,
  };
});

export async function checkDelayedStatus(page, origin, artifacts) {
  // (a) A blip shorter than 400 ms shows nothing and leaves the composer's focus and text alone.
  await open(page, origin);
  await page.focus('.ag-input');
  await page.type('.ag-input', 'abc');
  await recordComposerAndDot(page);
  await page.evaluate(() => window.sidebarPreview.setConnection('connecting'));
  await sleep(150);
  await page.evaluate(() => window.sidebarPreview.setConnection('connected'));
  await sleep(600);
  assert.deepEqual(await page.evaluate(() => window.statusRecords), [], 'no dot and no lock for a blip');
  let now = await composerState(page);
  assert.equal(now.focused, true, 'the composer keeps focus');
  assert.equal(now.value, 'abc');

  // (b) A real outage shows after 400 ms, keeps focus (readOnly, not disabled) and stays ≥ 400 ms.
  await page.evaluate(() => { window.statusRecords = []; });
  await page.evaluate(() => window.sidebarPreview.setConnection('disconnected'));
  assert.equal((await composerState(page)).ready, 'false', 'automation sees the real state at once');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), 0, 'Enter does not send offline');
  await sleep(600);
  now = await composerState(page);
  assert.equal(now.dotHidden, false, 'the connection dot shows after the delay');
  assert.equal(now.readOnly, true, 'the composer is locked');
  assert.equal(now.disabled, false, 'the lock does not disable (and so blur) the composer');
  assert.equal(now.focused, true, 'focus stays in the composer');
  assert.equal(now.value, 'abc');
  assert.match(now.placeholder, /허브 연결이 끊겼어요/);
  await (await page.$('.ag-root')).screenshot({ path: resolve(artifacts, 'composer-locked-offline.png') });
  await sleep(50);
  await page.evaluate(() => window.sidebarPreview.setConnection('connected'));
  await page.waitForFunction(() => !document.querySelector('.ag-input').readOnly);
  const records = await page.evaluate(() => window.statusRecords);
  const shownIndex = records.findIndex((record) => !record.dotHidden);
  const shownAt = records[shownIndex]?.at;
  const hiddenAt = records.slice(shownIndex + 1).find((record) => record.dotHidden)?.at;
  assert(shownAt !== undefined && hiddenAt !== undefined, 'the dot appeared and went away');
  assert(hiddenAt - shownAt >= 395, `the dot stayed ${Math.round(hiddenAt - shownAt)} ms, at least 400 ms`);
  now = await composerState(page);
  assert.equal(now.dotHidden, true);
  assert.equal(now.focused, true);
  assert.equal(now.ready, 'true');

  // (c) The "편집 중…" ring does not blink for a quick answer, and shows when the agent is silent.
  await open(page, origin, 'scenario=chat');
  await playToEnd(page);
  await page.evaluate(() => {
    window.ringShown = false;
    const ring = document.querySelector('.ag-turn-pending');
    new MutationObserver(() => { if (!ring.hidden) window.ringShown = true; })
      .observe(ring, { attributes: true, attributeFilter: ['hidden'] });
  });
  await page.evaluate(async () => {
    const { streamEvent } = window.sidebarPreview;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    streamEvent({ type: 'turn-start', agent: 'claude', turnId: 'quick' });
    await wait(100);
    streamEvent({ type: 'text-delta', agent: 'claude', text: '짧은 답.\n\n' });
    await wait(100);
    streamEvent({ type: 'turn-end', agent: 'claude', stopReason: 'completed' });
  });
  await sleep(600);
  assert.equal(await page.evaluate(() => window.ringShown), false, 'a quick answer never shows the ring');
  await page.evaluate(() => window.sidebarPreview.streamEvent({ type: 'turn-start', agent: 'claude', turnId: 'silent' }));
  await sleep(700);
  assert.equal(await page.evaluate(() => window.ringShown), true, 'a silent agent shows the ring');
  assert.equal(await page.evaluate(() => {
    const ring = document.querySelector('.ag-turn-pending');
    return !ring.hidden && ring.nextElementSibling === document.querySelector('.ag-messages-end');
  }), true, 'the ring sits at the end of the transcript');
  await page.evaluate(() => window.sidebarPreview.streamEvent({ type: 'turn-end', agent: 'claude', stopReason: 'completed' }));

  // (d) The rail shows 작업 중 only for a turn that lasts 400 ms.
  await open(page, origin, 'scenario=chat');
  await playToEnd(page);
  const threadId = await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId());
  assert(threadId, 'the played chat is saved');
  await page.click('.ag-header .ag-threads-btn');
  await page.waitForSelector(`.ag-threads-item[data-thread-id="${threadId}"] .ag-threads-item-when`);
  await page.evaluate((id) => {
    window.railStatuses = [];
    const read = () => document.querySelector(`.ag-threads-item[data-thread-id="${id}"] .ag-threads-item-when`)?.dataset.status;
    new MutationObserver(() => window.railStatuses.push(read()))
      .observe(document.querySelector('.ag-root'), { subtree: true, childList: true, attributes: true, attributeFilter: ['data-status'] });
  }, threadId);
  await page.evaluate(async () => {
    const { streamEvent } = window.sidebarPreview;
    streamEvent({ type: 'turn-start', agent: 'claude', turnId: 'short' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    streamEvent({ type: 'turn-end', agent: 'claude', stopReason: 'completed' });
  });
  await sleep(600);
  const shortTurn = await page.evaluate(() => window.railStatuses);
  assert(!shortTurn.includes('working'), `a 150 ms turn never shows 작업 중 (${shortTurn})`);
  assert.equal(shortTurn.at(-1), 'finished', 'it goes straight to the finished dot');
  await page.evaluate(() => {
    window.railStatuses = [];
    window.sidebarPreview.streamEvent({ type: 'turn-start', agent: 'claude', turnId: 'long' });
  });
  await sleep(700);
  assert.equal(await page.$eval(`.ag-threads-item[data-thread-id="${threadId}"] .ag-threads-item-when`,
    (when) => when.dataset.status), 'working', 'a turn past 400 ms shows 작업 중');
  await page.evaluate(() => window.sidebarPreview.streamEvent({ type: 'turn-end', agent: 'claude', stopReason: 'completed' }));

  // (e) While a switched-to chat starts, Enter cannot reach the old session; the lock keeps focus.
  await open(page, origin, 'chats=sample');
  await page.evaluate(() => window.sidebarPreview.setChatStartDelay(1_500));
  const sentBefore = await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent);
  await page.evaluate(() => window.sidebarPreview.sidebar.openThreadById('preview-chat-overview'));
  assert.equal((await composerState(page)).ready, 'false');
  await page.focus('.ag-input');
  await page.type('.ag-input', '이어서');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), sentBefore,
    'Enter during a chat start sends nothing');
  await sleep(500);
  now = await composerState(page);
  assert.equal(now.readOnly, true, 'a slow start shows the lock');
  assert.equal(now.placeholder, '채팅을 여는 중…');
  assert.equal(now.focused, true, 'the lock keeps focus in the composer');
  assert.equal(now.value, '이어서', 'the typed text stays');
  await page.waitForFunction(READY, { timeout: 3_000 });
  await page.waitForFunction(() => !document.querySelector('.ag-input').readOnly);
  await page.keyboard.press('Enter');
  await page.waitForFunction((before) => window.sidebarPreview.snapshot().messagesSent === before + 1, {}, sentBefore);

  // (f) An attachment still uploading keeps the send button disabled and Enter from sending.
  await open(page, origin);
  await page.evaluate(() => window.sidebarPreview.setStageDelay(800));
  await page.focus('.ag-input');
  await page.type('.ag-input', '이 그림을 설명해 줘');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([137, 80, 78, 71])], 'figure.png', { type: 'image/png' }));
    document.querySelector('.ag-input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.ag-reference-upload-chip');
  assert.equal(await page.$eval('.ag-send', (send) => send.disabled), true, 'send waits for the upload');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), 0, 'Enter waits for the upload');
  await page.waitForFunction(() => !document.querySelector('.ag-send').disabled, { timeout: 3_000 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().messagesSent === 1);
}

if (isMainModule(import.meta)) await runStandalone('Transient statuses wait 400 ms and never blink', checkDelayedStatus);

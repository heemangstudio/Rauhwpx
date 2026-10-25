// 실제 사이드바의 캡처 전송: 끊긴 작업 이어 가기, 첨부 없는 재시도 방지, 수락 전 채팅 전환.
import assert from 'node:assert/strict';

async function open(page, origin) {
  await page.goto(`${origin}/?reset=1&scenario=chat&hold=1&theme=light&width=480`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
}

async function sendText(page, text) {
  await page.type('.ag-input', text);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().running);
}

async function attachCapture(page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('rhwp:agent-command', { detail: { command: 'toggle-focus-chat' } })));
  await page.waitForFunction(() => document.querySelector('.ag-root').classList.contains('ag-fullscreen') && !document.body.classList.contains('ag-fs-vt'));
  await page.click('.ag-workspace-panel-btn');
  await page.click('.ag-workbench-launcher-item[data-view="browser"]');
  await page.waitForSelector('.ag-browser:not([hidden])', { visible: true });
  const emptyOpen = await page.$('.ag-browser [aria-label="연구 브라우저 열기"]');
  if (emptyOpen && await emptyOpen.evaluate((button) => button.checkVisibility())) await emptyOpen.click();
  await page.waitForFunction(() => document.querySelector('.ag-browser-frame')?.src.startsWith('data:image'));
  await page.click('[aria-label="현재 화면을 캡처해 채팅에 첨부"]');
  await page.waitForSelector('.ag-capture-inbox [data-capture-id]');
}

const currentThread = (page) => page.evaluate(() => window.sidebarPreview.threadStore.getThread(window.sidebarPreview.sidebar.currentThreadId()));
const interruptedMarker = (thread) => thread.messages.find((message) => message.kind === 'turn' && message.interruption);

export async function checkCaptureSend({ page, origin, screenshot }) {
  // 이미 다시 보낼 일반 요청이 있어도 캡처 실패에는 그 요청이나 첨부 없는 캡처를 제안하지 않는다.
  await open(page, origin);
  await sendText(page, '앞선 일반 요청입니다.');
  await page.evaluate(() => window.sidebarPreview.failRunningTurn('network'));
  await page.waitForSelector('.ag-failure-notice [data-action="retry"]');
  await attachCapture(page);
  await sendText(page, '지금 첨부한 캡처를 검토해 주세요.');
  await page.evaluate(() => window.sidebarPreview.failRunningTurn('network'));
  await page.waitForFunction(() => document.querySelectorAll('.ag-failure-notice').length === 2);
  const failedCapture = await currentThread(page);
  const latestFailure = failedCapture.messages.filter((message) => message.kind === 'error').at(-1);
  assert.equal(latestFailure.retry, undefined, 'capture failure cannot reuse a preceding plain request');
  assert.equal(await page.$$eval('.ag-failure-notice', (nodes) => nodes.at(-1).querySelector('[data-action="retry"]') !== null), false);
  const captureMessage = failedCapture.messages.filter((message) => message.role === 'user').at(-1);
  assert.equal(captureMessage.text, '지금 첨부한 캡처를 검토해 주세요.');
  assert.ok(captureMessage.attachments.length >= 2, 'accepted capture retains screenshot and evidence attachments');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), 2);
  if (screenshot) await screenshot('capture-send-no-unsafe-retry');

  // 첨부만 보낸 요청: 본문을 지어내지 않고 빈 말풍선 없이 알약만 남긴다.
  await open(page, origin);
  await attachCapture(page);
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().messagesSent === 1);
  await page.waitForSelector('.ag-msg-user.ag-attachment-only .ag-msg-attachment');
  const attachmentOnly = await currentThread(page);
  const attachmentMessage = attachmentOnly.messages.filter((message) => message.role === 'user').at(-1);
  assert.equal(attachmentMessage.text, '');
  assert.ok(attachmentMessage.attachments.length >= 2, 'capture keeps its attachments');
  assert.equal(await page.$$eval('.ag-msg-user.ag-attachment-only .ag-msg-user-text', (nodes) => nodes.length), 0,
    'attachment-only message renders no text block');
  assert.ok(await page.$$eval('.ag-msg-user.ag-attachment-only .ag-msg-attachment', (nodes) => nodes.length) >= 2,
    'attachment pills stay visible');
  if (screenshot) await screenshot('capture-send-attachment-only');

  // 캡처도 최신 대화로 세션을 다시 열고 끊긴 턴 블록을 실으며 붙잡힌 대기열을 푼다.
  await open(page, origin);
  await sendText(page, '캡처 전에 끊긴 요청입니다.');
  await page.type('.ag-input', '이어서 보낼 대기 요청입니다.');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.ag-followup');
  await page.evaluate(() => window.sidebarPreview.restartHub());
  await page.waitForSelector('.ag-turn-interrupted-resume:not([hidden])');
  await attachCapture(page);
  await sendText(page, '캡처로 이어서 검토해 주세요.');
  const continued = await currentThread(page);
  assert.equal(interruptedMarker(continued).interruption.resolution, 'superseded');
  const snapshot = await page.evaluate(() => window.sidebarPreview.snapshot());
  const sent = snapshot.sentMessages.at(-1);
  assert.match(sent.text, /캡처로 이어서 검토해 주세요\.[\s\S]*<turn_interrupted reason="hub-restart">/);
  assert.equal(sent.text.match(/<turn_interrupted reason=/g).length, 1);
  assert.ok(sent.referenceIds.length >= 2);
  assert.ok(snapshot.chatStarts.at(-1).history.includes('캡처 전에 끊긴 요청입니다.'), 'restart carries the current conversation');
  assert.equal(await page.$eval('.ag-followups', (strip) => strip.dataset.hold ?? null), null);
  if (screenshot) await screenshot('capture-send-interrupted-continuation');

  // 수락을 기다리는 캡처는 기록하지 않는다. 채팅을 바꾼 뒤 거절돼도 원래 턴의 끊김을 되살린다.
  await open(page, origin);
  await sendText(page, '수락 전에 채팅을 바꿀 요청입니다.');
  await page.evaluate(() => window.sidebarPreview.restartHub());
  await page.waitForSelector('.ag-turn-interrupted-resume:not([hidden])');
  await attachCapture(page);
  const threadId = await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId());
  await page.evaluate(() => {
    const bridge = window.sidebarPreview.bridge;
    const original = bridge.sendUserMessage.bind(bridge);
    bridge.sendUserMessage = (...args) => args[6]?.requireAcceptance
      ? new Promise((resolve) => { window.pendingCaptureAcceptance = { args, resolve }; })
      : original(...args);
  });
  await page.type('.ag-input', '거절된 캡처 요청입니다.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.pendingCaptureAcceptance);
  const pending = await page.evaluate(() => ({
    args: window.pendingCaptureAcceptance.args.map((arg, index) => index === 4 ? null : arg),
    thread: window.sidebarPreview.threadStore.getThread(window.sidebarPreview.sidebar.currentThreadId()),
  }));
  assert.equal(pending.args[6].requireAcceptance, true);
  assert.match(pending.args[6].messageId, /^capture-/);
  assert.match(pending.args[0], /<turn_interrupted reason="hub-restart">/);
  assert.ok(!pending.thread.messages.some((message) => message.text === '거절된 캡처 요청입니다.'), 'unaccepted capture is absent from persisted history');
  await page.evaluate(() => window.sidebarPreview.sidebar.startDraftChat());
  await page.evaluate(() => window.pendingCaptureAcceptance.resolve(null));
  await page.waitForFunction((id) => {
    const thread = window.sidebarPreview.threadStore.getThread(id);
    return thread.messages.some((message) => message.kind === 'turn' && message.interruption && !message.interruption.resolution);
  }, {}, threadId);
  const rejected = await page.evaluate((id) => window.sidebarPreview.threadStore.getThread(id), threadId);
  assert.ok(!rejected.messages.some((message) => message.text === '거절된 캡처 요청입니다.'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId()), null, 'late receipt keeps the newly selected draft');

  // 첨부 업로드 중 채팅을 바꾸면 준비된 파일을 폐기하고 요청을 내보내지 않는다.
  await open(page, origin);
  await sendText(page, '스테이징 전에 보낸 요청입니다.');
  await page.evaluate(() => window.sidebarPreview.finishTurn());
  await attachCapture(page);
  await page.evaluate(() => {
    const preview = window.sidebarPreview;
    preview.setStageDelay(500);
    const original = preview.bridge.stageReference.bind(preview.bridge);
    preview.bridge.stageReference = (...args) => {
      window.captureStagingStarted = true;
      return original(...args);
    };
  });
  await page.type('.ag-input', '취소할 캡처 요청입니다.');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.captureStagingStarted);
  await page.evaluate(() => window.sidebarPreview.sidebar.startDraftChat());
  await page.waitForFunction(() => document.querySelector('#agent-sidebar')?.dataset.composerReady === 'true');
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), 1, 'cancelled staging never dispatches a request');
}

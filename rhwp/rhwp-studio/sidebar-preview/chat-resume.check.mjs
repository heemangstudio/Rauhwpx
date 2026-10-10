import assert from 'node:assert/strict';

/** A resumed session can become idle without replaying its old turn-end. */
export async function checkChatResume(page, origin, screenshot) {
  await page.goto(`${origin}/?theme=dark&width=480&reset=1&scenario=chat&hold=1`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.sidebarPreview && !document.querySelector('.ag-input').disabled);
  await page.type('.ag-input', '이어 가기 전에 이 요청을 기억해 줘');
  await page.click('.ag-send');
  await page.waitForFunction(() => window.sidebarPreview.bridge.isTurnRunning()
    && document.querySelector('.ag-send').classList.contains('ag-stop'));
  const threadId = await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId());

  // The fixture emits chat-started after replacing the provider, with no old
  // terminal event. Production Bridge applies the hub's status before this event.
  await page.evaluate(() => new Promise((resolve) => {
    const preview = window.sidebarPreview;
    const unsubscribe = preview.bridge.onEvent((event) => {
      if (event.type !== 'chat-started') return;
      unsubscribe();
      resolve();
    });
    preview.bridge.startChat('codex', 'gpt-6.1-sol', 'high', true, 'safe', 'direct',
      preview.sidebar.currentThreadId(), 'sidebar-preview', '사업 제안서.hwpx');
  }));
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
    && !document.querySelector('.ag-input').disabled);
  assert.equal(await page.$eval('.ag-send', (send) => send.classList.contains('ag-stop')), false,
    'an idle resumed session releases the stop button');
  assert.equal(await page.$eval('.ag-turn-pending', (pending) => pending.checkVisibility()), false,
    'an idle resumed session removes the pending spinner');
  assert.equal(await page.evaluate(() => window.sidebarPreview.sidebar.currentThreadId()), threadId,
    'the recovered conversation keeps its identity');
  assert.equal(await page.$$eval('.ag-msg-user', (messages) => messages.length), 1,
    'recovery preserves the original prompt');
  if (screenshot) await screenshot('chat-resume-idle');

  await page.evaluate(() => window.sidebarPreview.setHold(false));
  await page.type('.ag-input', '복원된 채팅에서 계속해 줘');
  await page.click('.ag-send');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
    && document.querySelectorAll('.ag-msg-user').length === 2
    && [...document.querySelectorAll('.ag-msg-assistant')].some((message) => message.textContent.trim()));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().messagesSent), 2,
    'the resumed chat can send another provider request');

  await page.evaluate(() => window.sidebarPreview.setHold(true));
  await page.type('.ag-input', '이번 작업은 멈춰 줘');
  await page.click('.ag-send');
  await page.waitForFunction(() => document.querySelector('.ag-send').classList.contains('ag-stop'));
  await page.click('.ag-send');
  await page.waitForFunction(() => !window.sidebarPreview.bridge.isTurnRunning()
    && !document.querySelector('.ag-send').classList.contains('ag-stop'));
  assert.equal(await page.evaluate(() => window.sidebarPreview.snapshot().interrupts), 1,
    'a later active turn still accepts cancellation');
}

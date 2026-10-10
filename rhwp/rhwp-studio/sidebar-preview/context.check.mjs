import assert from 'node:assert/strict';
import { resolve } from 'node:path';

/** 맥락 표시 · 수동 압축 · 중복 이벤트 · 다시 열기 · 프로바이더 전환과 커서 재개. */
export async function checkContextPreview(page, origin, artifacts) {
  const scene = async (query) => {
    await page.goto(`${origin}/?audit=1&controls=0&width=480&theme=light&${query}`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.body.dataset.auditReady === 'true');
  };
  const markerCount = (kind) => page.$$eval(`.ag-marker-${kind}`, (nodes) => nodes.length);

  await scene('reset=1&scenario=chat&play=1&context=92&surface=context');
  assert.equal(await page.$eval('.ag-context', (el) => el.dataset.level), 'high');
  assert.match(await page.$eval('.ag-context-btn', (el) => el.getAttribute('aria-label')), /92%/);
  assert.equal(await page.$eval('.ag-context-compact', (el) => el.getAttribute('aria-disabled')), 'false');
  await page.screenshot({ path: resolve(artifacts, 'context-meter.png') });

  // 수동 압축: 진행 표시가 바뀌고, 끝나면 구분선 하나와 줄어든 사용량이 남는다.
  await page.click('.ag-context-compact');
  await page.waitForFunction(() => document.querySelector('.ag-turn-pending-label')?.textContent === '맥락 압축 중…');
  assert.equal(await page.$eval('.ag-context-compact', (el) => el.getAttribute('aria-disabled')), 'true');
  await page.waitForSelector('.ag-marker-compaction');
  await page.waitForFunction(() => !window.sidebarPreview.snapshot().running);
  const marker = await page.$eval('.ag-marker-compaction', (el) => ({ id: el.dataset.compactionId, label: el.getAttribute('aria-label') }));
  assert.match(marker.label, /^맥락 압축됨 · 184K → 42K$/);
  assert.equal(await page.$eval('.ag-context', (el) => el.dataset.level), 'normal');
  await page.screenshot({ path: resolve(artifacts, 'context-compacted.png') });

  // 재전송된 완료 이벤트는 구분선을 더 만들지 않는다.
  await page.evaluate((id) => window.sidebarPreview.emitAgentEvent({
    type: 'compaction', agent: 'claude', compactionId: id, phase: 'completed', trigger: 'manual', beforeTokens: 184000, afterTokens: 42000,
  }), marker.id);
  assert.equal(await markerCount('compaction'), 1);

  // 다시 열면 구분선과 맥락 표시가 저장된 채팅에서 돌아온다.
  await page.click('.ag-header .ag-threads-btn');
  const threadId = await page.$eval('.ag-threads-item.ag-active', (node) => node.dataset.threadId);
  await new Promise((done) => setTimeout(done, 300));
  await scene('');
  await page.click('.ag-header .ag-threads-btn');
  await page.$eval('.ag-threads-list', (list, id) =>
    [...list.querySelectorAll('.ag-threads-item')].find((node) => node.dataset.threadId === id)?.click(), threadId);
  await page.waitForSelector('.ag-marker-compaction');
  assert.equal(await markerCount('compaction'), 1);
  assert.equal(await page.$eval('.ag-context', (el) => el.hidden), false);
  assert.match(await page.$eval('.ag-context-btn', (el) => el.getAttribute('aria-label')), /21%/);

  // 다른 프로바이더로 보낸 첫 메시지 앞에만 전환 구분선이 남고, 처음 쓰는 프로바이더는 커서 없이 시작한다.
  await scene('reset=1&scenario=chat&play=1&handoff=1');
  assert.equal(await markerCount('handoff'), 1);
  assert.equal(await page.$eval('.ag-marker-handoff', (el) => el.getAttribute('aria-label')), 'Codex로 전환');
  await page.screenshot({ path: resolve(artifacts, 'context-handoff.png') });
  const toCodex = await page.evaluate(() => window.sidebarPreview.snapshot().lastChatStart);
  assert.equal(toCodex.agent, 'codex');
  assert.equal(toCodex.providerSessionId, null);
  // Claude 로 돌아가면 자기 세션을 이어 받고, Codex 가 나눈 대화만 넘겨받는다. 피커만 바꾼 것은 구분선을 남기지 않는다.
  await page.click('[aria-label="프로바이더 선택"]');
  await page.click('.ag-provider-item[data-agent="claude"]');
  await page.waitForFunction(() => window.sidebarPreview.snapshot().lastChatStart?.agent === 'claude');
  const back = await page.evaluate(() => window.sidebarPreview.snapshot().lastChatStart);
  assert.match(back.providerSessionId, /^preview-claude-/);
  assert.equal(back.handoff, 3, 'Codex 차례의 사용자 메시지, 도구 요약, 답변');
  assert.equal(await markerCount('handoff'), 1);
}

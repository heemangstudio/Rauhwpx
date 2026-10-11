import assert from 'node:assert/strict';
import fs from 'node:fs';

import { registerHubSession } from '../../../../desktop/agent-hub.mjs';
import { openDocument, paraText, waitFor } from './lib.mjs';

/**
 * 가짜 pi 턴을 열고 mcp-stdio 와 같은 프레임으로 허브 /mcp 에 도구를 부른다.
 * 실제 허브 → 브리지 → 실행기 → 대기 편집 경로를 탄다. 턴은 finishTurnPath 파일이 생기면 끝난다.
 */
async function beginTurn({ page, hubPort, token, finishTurnPath }) {
  fs.rmSync(finishTurnPath, { force: true });
  await page.evaluate(async () => {
    window.__smokeTurn = false;
    const off = window.__agentBridge.onEvent((event) => {
      if (event.type === 'agent' && event.event.type === 'turn-start') { window.__smokeTurn = true; off(); }
    });
    await window.__agentBridge.sendUserMessage('Smoke edit.');
  });
  await waitFor(page, 'provider turn start', () => window.__smokeTurn);
  const { sessionId, capabilityEpoch } = await page.evaluate(() => ({
    sessionId: window.__agentBridge.getHubFontAccess().sessionId,
    capabilityEpoch: window.__agentBridge.getWorkflowState().capabilityEpoch,
  }));
  const health = await (await fetch(`http://127.0.0.1:${hubPort}/healthz?token=${token}`)).json();
  const { mcp } = await registerHubSession({ port: hubPort, token, launchId: health.launchId, sessionId });
  const ws = new WebSocket(`ws://127.0.0.1:${hubPort}/mcp?token=${encodeURIComponent(mcp)}&sessionId=${encodeURIComponent(sessionId)}&agent=pi`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('MCP socket failed')); });
  let nextId = 1;
  const call = (tool, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type !== 'tool-result' || msg.id !== id) return;
      ws.removeEventListener('message', onMessage);
      if (msg.ok) resolve(msg.result); else reject(new Error(`${tool}: ${msg.error?.code} ${msg.error?.message}`));
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ v: 5, type: 'tool-call', id, tool, args, workflow: 'direct', capabilityEpoch }));
  });
  const finish = async () => {
    ws.close();
    fs.writeFileSync(finishTurnPath, 'finish');
    await waitFor(page, 'turn end and review card', () => !window.__inputHandler.isUserEditingLocked()
      && document.querySelector('.ag-review-card .ag-approve:not(:disabled)'));
  };
  return { call, finish };
}

/** 문서 첫 문단 앞에 text 를 넣고, 승인 전 미리보기 상태를 확인한 뒤 턴을 끝낸다. */
async function stageInsert(ctx, text) {
  const { page } = ctx;
  const turn = await beginTurn(ctx);
  const { revision } = await turn.call('get_structure', {});
  await turn.call('insert_text', { expectedRevision: revision, sectionIdx: 0, paraIdx: 0, charOffset: 0, text });
  assert.ok((await paraText(page)).startsWith(text), 'staged edit is applied as a live preview');
  assert.ok(await page.evaluate(() => window.__agentBridge.pendingEdits.hasPending()), 'edit is held for review');
  await waitFor(page, 'insert highlight on the page', () => document.querySelector('.ag-pending-marker.ag-insert'));
  await turn.finish();
}

export default {
  name: 'agent edit: staged preview, approve, reject',
  async run(ctx) {
    const { page } = ctx;
    await waitFor(page, 'hub connection', () => window.__agentBridge?.getConnectionState() === 'connected');
    await openDocument(page, 'footnote-01.hwp');
    await waitFor(page, 'version history', () => window.__versionController?.getState().enabled);
    const original = await paraText(page);
    // 에이전트 모드(direct + safe): 쓰기는 미리보기로 쌓이고 턴이 끝나면 검토를 기다린다.
    await page.evaluate(() => window.__agentBridge.startChat('pi', 'mock-model', null, false, 'safe', 'direct'));
    await waitFor(page, 'pi chat', () => window.__agentBridge.getActiveAgent() === 'pi');

    await stageInsert(ctx, 'KEEP ');
    await page.click('.ag-review-card .ag-approve');
    await waitFor(page, 'approved edit', () => !window.__agentBridge.pendingEdits.hasPending()
      && !document.querySelector('.ag-pending-marker'));
    assert.equal(await paraText(page), `KEEP ${original}`, 'approved text stays');

    await stageInsert(ctx, 'DROP ');
    await page.click('.ag-review-card .ag-reject');
    await waitFor(page, 'rejected edit', () => !window.__agentBridge.pendingEdits.hasPending()
      && !document.querySelector('.ag-pending-marker'));
    assert.equal(await paraText(page), `KEEP ${original}`, 'rejected text is removed and the approved edit stays');
  },
};

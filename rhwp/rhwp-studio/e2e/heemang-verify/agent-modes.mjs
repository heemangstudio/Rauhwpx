/** 실제 HWP/HWPX에서 네 모드의 권한·검토·실행 취소·버전 저장을 확인한다. Pi는 턴 제어 fixture다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHubSession } from '../../../../desktop/agent-hub.mjs';
import * as L from './lib.mjs';

const out = L.ensureOut('agent-modes');
const wasm = fs.readFileSync(path.join(L.candidateRoot, 'rhwp/rhwp-studio/vendor/hm-wasm/hm_wasm_bg.wasm'));
const wasmSha256 = createHash('sha256').update(wasm).digest('hex');
const app = await L.startApp('candidate', L.candidateRoot, 5723);
let browser;
let provider;
const reports = [];

function must(frame, label) {
  assert.equal(frame.ok, true, `${label}: ${JSON.stringify(frame.error)}`);
  return frame.result;
}

async function attachProvider(page) {
  const response = await fetch(`http://127.0.0.1:${app.hubPort}/healthz`, {
    headers: { Authorization: `Bearer ${app.token}` },
  });
  assert.equal(response.status, 200);
  const health = await response.json();
  const sessionId = await page.evaluate(() => window.__agentBridge.getHubFontAccess()?.sessionId);
  const record = health.sessions.find(row => row.sessionId === sessionId);
  assert.ok(record?.session, 'the editor owns an authenticated hub session');
  const capabilities = await registerHubSession({
    port: app.hubPort, token: app.token, launchId: health.launchId, sessionId,
  });
  provider?.socket.close();
  const socket = new WebSocket(`ws://127.0.0.1:${app.hubPort}/mcp?token=${encodeURIComponent(capabilities.mcp)}`
    + `&sessionId=${encodeURIComponent(sessionId)}&agent=pi&role=chat`);
  const calls = new Map();
  let sequence = 0;
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'tool-result') return;
    const pending = calls.get(frame.id);
    if (!pending) return;
    calls.delete(frame.id); clearTimeout(pending.timer); pending.resolve(frame);
  });
  socket.addEventListener('close', () => {
    for (const pending of calls.values()) {
      clearTimeout(pending.timer); pending.reject(new Error('MCP connection closed before its result'));
    }
    calls.clear();
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Authenticated MCP connection failed')), { once: true });
  });
  provider = {
    socket,
    call(tool, args) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { calls.delete(id); reject(new Error(`Tool timeout: ${tool}`)); }, 30000);
        calls.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ v: 5, type: 'tool-call', id, tool, args,
          workflow: record.session.workflow, capabilityEpoch: record.session.capabilityEpoch }));
      });
    },
  };
  return record.session;
}

async function verifyDocument(fixture, name) {
  const { page, context, log } = await L.newPage(browser);
  const markers = Object.fromEntries(['chat', 'plan', 'approved', 'reject', 'agent1', 'agent2', 'stale', 'full1', 'full2']
    .map(key => [key, `CUTOVER_${name}_${key}_END `]));
  const has = text => page.evaluate(query => {
    const matches = window.__wasm.searchAllText(query, false, true);
    return (typeof matches === 'string' ? JSON.parse(matches) : matches).length > 0;
  }, text);
  const structure = async () => must(await provider.call('get_structure', { format: 'json' }), 'get_structure');
  const insert = (text, revision) => provider.call('insert_text', {
    sectionIdx: 0, paraIdx: 0, charOffset: 0, text, expectedRevision: revision,
  });
  const edit = async text => must(await insert(text, (await structure()).revision), 'insert_text');
  const mode = async value => {
    await page.click('.ag-mode-btn');
    await page.click(`.ag-mode-item[data-mode="${value}"]`);
    await L.waitFor(page, `mode ${value}`, expected => document.querySelector('.ag-mode')?.dataset.mode === expected,
      { args: [value] });
  };
  const start = async text => {
    fs.rmSync(app.finishTurnPath, { force: true });
    await L.waitFor(page, 'enabled composer', () => document.querySelector('.ag-input')?.disabled === false);
    await page.type('.ag-input', text); await page.click('.ag-send');
    await L.waitFor(page, 'controlled Pi turn', () => window.__agentBridge.getActiveAgent() === 'pi'
      && window.__agentBridge.isTurnRunning());
    return attachProvider(page);
  };
  const finish = async () => {
    fs.writeFileSync(app.finishTurnPath, '');
    await L.waitFor(page, 'completed Pi turn', () => !window.__agentBridge.isTurnRunning());
    fs.rmSync(app.finishTurnPath, { force: true });
  };
  const review = async action => {
    const selector = `.ag-review-card .ag-${action}`;
    await page.waitForSelector(selector, { visible: true });
    await page.click(selector);
    await L.waitFor(page, 'resolved document review', () => !window.__agentBridge.pendingEdits.hasPending());
  };
  const undo = async (redo = false) => {
    await page.evaluate(() => window.__inputHandler.focus());
    await page.keyboard.down('Meta');
    if (redo) await page.keyboard.down('Shift');
    await page.keyboard.press('z');
    if (redo) await page.keyboard.up('Shift');
    await page.keyboard.up('Meta');
  };
  const check = async (text, present, label) => {
    await L.waitFor(page, label, (query, expected) => {
      const result = window.__wasm.searchAllText(query, false, true);
      return (typeof result === 'string' ? JSON.parse(result) : result).length > 0 === expected;
    }, { args: [text, present] });
  };
  const blocked = async (text, code) => {
    const before = await structure();
    const denied = await insert(text, before.revision);
    assert.equal(denied.ok, false); assert.equal(denied.error?.code, code);
    assert.equal((await structure()).revision, before.revision);
    assert.equal(await has(text), false);
  };
  try {
    await L.loadApp(page, app.url);
    await page.evaluate(() => localStorage.setItem('rhwp-agent-prefs', JSON.stringify({
      defaultAgent: 'pi', defaultModel: 'mock-model', defaultEffort: '', defaultMode: 'chat',
    })));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await L.waitFor(page, 'connected editor', () => window.__wasm
      && window.__agentBridge?.getConnectionState() === 'connected', { timeout: 60000 });
    await L.openDocumentFile(page, fixture);
    await page.evaluate(async () => {
      await window.__versionController.whenIdle();
      if (!window.__versionController.getState().enabled) await window.__versionController.enable();
    });

    console.log(`${name}: Chat and Plan gates`);
    assert.equal((await start('Read the document without editing it.')).workflow, 'question');
    await blocked(markers.chat, 'QUESTION_WRITE_BLOCKED'); await finish();
    await mode('plan');
    assert.equal((await start('Prepare a small document edit for approval.')).phase, 'planning');
    await blocked(markers.plan, 'PLAN_WRITE_BLOCKED');
    must(await provider.call('present_implementation_plan', {
      goal: 'Insert the approved verification marker.', title: 'Insert one marker',
      summary: 'Add the agreed marker at the beginning of the first paragraph.', assumptions: [],
      decisions: ['Preserve the existing paragraph content.'],
      steps: [{ title: 'Insert the marker', target: 'Section 0, paragraph 0', preview: markers.approved }],
      files: [], validation: ['Read the paragraph after insertion.'], risks: [], exclusions: [],
    }), 'present_implementation_plan');
    await attachProvider(page);
    await blocked(markers.plan, 'PLAN_WRITE_BLOCKED');
    await finish();
    await page.waitForFunction(() => document.querySelector('.ag-plan-approve')?.disabled === false);
    await page.screenshot({ path: path.join(out, `${name}-plan-approval.png`) });
    await page.click('.ag-plan-approve');
    await L.waitFor(page, 'approved plan implementation', () => window.__agentBridge.isTurnRunning());
    const approved = await attachProvider(page);
    assert.equal(approved.phase, 'implementing'); assert.equal(approved.permissionProfile, 'safe');
    await edit(markers.approved); await check(markers.approved, true, 'approved plan live preview');
    await finish(); await review('approve');

    console.log(`${name}: Agent preview, rejection, acceptance and history`);
    // 승인한 계획도 에이전트 칩으로 표시된다. 채팅을 거쳐 독립 direct 세션으로 옮긴다.
    await mode('chat');
    await mode('agent');
    const agent = await start('Preview a change that will be rejected.');
    assert.equal(agent.workflow, 'direct'); assert.equal(agent.permissionProfile, 'safe');
    await edit(markers.reject); await check(markers.reject, true, 'Agent preview is live');
    await page.screenshot({ path: path.join(out, `${name}-agent-preview.png`) });
    await finish(); await review('reject');
    await check(markers.reject, false, 'rejection restores the document');
    await start('Preview two changes for one review.');
    const firstRevision = (await structure()).revision;
    must(await insert(markers.agent1, firstRevision), 'first Agent edit');
    const stale = await insert(markers.stale, firstRevision);
    assert.equal(stale.ok, false); assert.equal(stale.error?.code, 'REVISION_MISMATCH');
    assert.equal(await has(markers.stale), false);
    await edit(markers.agent2); await finish(); await review('approve');
    await undo();
    await check(markers.agent1, false, 'one undo removes first accepted edit');
    await check(markers.agent2, false, 'one undo removes second accepted edit');
    assert.equal(await has(markers.approved), true);
    await undo(true);
    await check(markers.agent1, true, 'redo restores first accepted edit');
    await check(markers.agent2, true, 'redo restores second accepted edit');

    console.log(`${name}: Full writes, separate undo steps and version commit`);
    await mode('full');
    const full = await start('Apply two independent writes immediately.');
    assert.equal(full.workflow, 'direct'); assert.equal(full.permissionProfile, 'unrestricted');
    await edit(markers.full1); await edit(markers.full2); await finish();
    assert.equal(await page.evaluate(() => window.__agentBridge.pendingEdits.hasPending()), false);
    assert.equal(await page.$('.ag-review-card .ag-reject'), null);
    await undo(); await check(markers.full2, false, 'Full undo removes only the last write');
    assert.equal(await has(markers.full1), true);
    await undo(); await check(markers.full1, false, 'second Full undo removes the first write');
    assert.equal(await has(markers.agent1), true);
    await undo(true); await check(markers.full1, true, 'first Full redo');
    assert.equal(await has(markers.full2), false);
    await undo(true); await check(markers.full2, true, 'second Full redo');
    await start('Commit the current document version.');
    const title = `Cutover ${name} mode verification`;
    const committed = must(await provider.call('commit_version', { message: title }), 'commit_version');
    assert.equal(committed.committed, true);
    const version = await page.evaluate(() => window.__versionController.getState());
    assert.ok(version.commits.some(row => row.title === title), 'the real IndexedDB version store has the commit');
    assert.equal(version.dirty, false);
    await finish();
    await page.screenshot({ path: path.join(out, `${name}-full-committed.png`) });

    const saved = [];
    for (const format of ['hwp', 'hwpx']) {
      const bytes = await page.evaluate(format => [...(format === 'hwp'
        ? window.__wasm.exportHwp() : window.__wasm.exportHwpx())], format);
      const target = path.join(out, `${name}-verified.${format}`);
      fs.writeFileSync(target, Buffer.from(bytes));
      await L.openDocumentFile(page, target);
      for (const key of ['approved', 'agent1', 'agent2', 'full1', 'full2']) assert.equal(await has(markers[key]), true, `${format}: ${key}`);
      for (const key of ['chat', 'plan', 'reject', 'stale']) assert.equal(await has(markers[key]), false, `${format}: ${key}`);
      saved.push({ format, bytes: bytes.length });
    }
    assert.deepEqual(log.pageErrors, []);
    assert.deepEqual(L.rhwpEngineRequests(log), []);
    reports.push({ source: path.relative(L.candidateRoot, fixture), name, chatWriteBlocked: true,
      planWriteBlockedBeforeApproval: true, planUiApproval: true, staleRevisionRejected: true,
      agentLivePreview: true, agentRejected: true, agentAcceptedSingleUndoRedo: true,
      fullOneUndoPerWrite: true, versionCommit: title, versionCommitId: version.commits.find(row => row.title === title).id,
      saved, pageErrors: log.pageErrors, legacyEngineRequests: [] });
  } catch (error) {
    await page.screenshot({ path: path.join(out, `${name}-failure.png`) });
    console.error(JSON.stringify({ name, pageErrors: log.pageErrors, console: log.console.slice(-12) }));
    throw error;
  } finally { provider?.socket.close(); await context.close(); }
}

try {
  browser = await L.launchBrowser();
  await verifyDocument(path.join(L.candidateRoot, 'rhwp/samples/footnote-01.hwp'), 'hwp');
  await verifyDocument(path.join(L.candidateRoot, 'rhwp/tests/fixtures/editing_parity/mac-hancom-12.30.0/body-mixed-text/edited.hwpx'), 'hwpx');
  const report = { url: app.url, provider: 'controlled Pi fixture; real Studio, authenticated hub and Heemang WASM',
    wasmSha256, wasmBytes: wasm.length, reports };
  fs.writeFileSync(path.join(out, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally { provider?.socket.close(); await browser?.close(); await app.stop(); }

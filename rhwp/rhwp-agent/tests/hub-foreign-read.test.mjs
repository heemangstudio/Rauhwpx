// 읽기 도구의 documentId 를 실제 허브로 고정한다: 이 채팅 문서 id 는 지워 라이브 읽기가 되고,
// 다른 문서는 source 를, "template" 은 활성 서식 틀을 붙여 스튜디오로 넘긴다. 외부 읽기 결과는
// 라이브 문서의 revision 으로 기록되지 않는다(플랜의 documentRevision 이 라이브 읽기 값을 유지한다).
import assert from 'node:assert/strict';
import test from 'node:test';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

async function uploadTemplate(hub) {
  const response = await fetch(`http://127.0.0.1:${hub.port}/templates?sessionId=${hub.sessionId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${hub.capabilities.template}`,
      Origin: 'http://127.0.0.1:7700',
      'Content-Type': 'application/x-hwp',
      'X-File-Name': 'form.hwp',
      'X-Template-Name': encodeURIComponent('Form'),
      'X-Template-Format': 'hwp',
      'X-Template-Page-Count': '1',
      'X-Template-Section-Count': '1',
    },
    body: Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.from('form')]),
  });
  assert.equal(response.status, 201);
  return (await response.json()).template;
}

test('read tools route documentId to the live document, another document or the active template', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t);
  const started = await hub.start({ workflow: 'plan' });
  const template = await uploadTemplate(hub);
  hub.studio.send({ type: 'chat-template-set', templateId: template.id });
  await hub.studio.next((frame) => frame.type === 'chat-template-changed');
  hub.message('HOLD');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HOLD_READY');

  const mcp = await connect(`ws://127.0.0.1:${hub.port}/mcp?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  const call = (id, tool, args) => mcp.send({
    type: 'tool-call', id, tool, args, workflow: 'plan', capabilityEpoch: started.capabilityEpoch,
  });
  const result = (id) => mcp.next((frame) => frame.type === 'tool-result' && frame.id === id);
  const request = (tool) => hub.studio.next((frame) => frame.type === 'tool-request' && frame.tool === tool);
  const respond = (frame, value) => hub.studio.send({ type: 'tool-response', id: frame.id, ok: true, result: value });

  // 이 채팅 문서의 id 는 지워져 평소의 라이브 읽기가 된다.
  call(1, 'get_structure', { documentId: 'document-live' });
  const live = await request('get_structure');
  assert.equal(Object.hasOwn(live.args, 'documentId'), false);
  assert.equal(live.source, undefined);
  respond(live, { revision: 5, lines: [] });
  assert.equal((await result(1)).ok, true);

  // 다른 문서는 documentId 를 유지하고 source 를 단다. 결과는 그대로 전달된다.
  call(2, 'get_structure', { documentId: 'document-other' });
  const foreign = await request('get_structure');
  assert.equal(foreign.args.documentId, 'document-other');
  assert.deepEqual(foreign.source, { kind: 'document', documentId: 'document-other' });
  assert.equal(foreign.template, undefined);
  // 스튜디오가 revision 을 빼먹지 않더라도 허브는 라이브 revision 으로 기록하지 않는다.
  respond(foreign, { revision: 99, documentId: 'document-other', name: 'other.hwp' });
  assert.equal((await result(2)).result.name, 'other.hwp');

  // 스튜디오 오류 코드는 그대로 통과한다.
  call(3, 'find_text', { documentId: 'document-other', query: 'x' });
  const missing = await request('find_text');
  hub.studio.send({ type: 'tool-response', id: missing.id, ok: false, error: { code: 'DOCUMENT_OPEN_ELSEWHERE', message: 'open in another window' } });
  assert.equal((await result(3)).error.code, 'DOCUMENT_OPEN_ELSEWHERE');

  // 서식 틀 읽기는 templateRevision 없이 활성 틀을 붙인다.
  call(4, 'get_structure', { documentId: 'template' });
  const templateRead = await request('get_structure');
  assert.equal(templateRead.args.documentId, 'template');
  assert.equal(templateRead.template.id, template.id);
  assert.equal(templateRead.source, undefined);
  respond(templateRead, { templateId: template.id, templateRevision: template.revision, revision: 77 });
  assert.equal((await result(4)).ok, true);

  // 스튜디오로 가기 전에 허브가 거절하는 경우.
  call(5, 'get_structure', { documentId: 'document-other', sinceRevision: 2 });
  assert.equal((await result(5)).error.code, 'INVALID_ARGS');
  call(6, 'get_text_range', { documentId: 'file:unknown', sectionIdx: 0, paraIdx: 0 });
  assert.equal((await result(6)).error.code, 'SOURCE_NOT_FOUND');
  call(7, 'get_document_info', { documentId: 'document-other' });
  const writeLike = (await result(7)).error;
  assert.equal(writeLike.code, 'INVALID_ARGS');
  assert.match(writeLike.message, /documentId is read-only/);
  call(8, 'read_batch', { reads: [{ tool: 'get_structure', args: { documentId: 'document-other' } }] });
  assert.equal((await result(8)).error.code, 'INVALID_ARGS');
  assert.equal(hub.studio.frames.some((frame) => frame.type === 'tool-request'), false, 'rejected calls never reach Studio');

  call(9, 'present_implementation_plan', {
    goal: 'Update the date', title: 'Date plan', summary: 'Change the cover date', assumptions: [], decisions: ['Keep formatting'],
    steps: [{ title: 'Replace', details: 'Replace the cover date' }], files: [], validation: ['Read it back'], risks: [], exclusions: [],
  });
  const planned = await result(9);
  assert.equal(planned.ok, true, JSON.stringify(planned.error));
  const ready = await hub.studio.next((frame) => frame.type === 'plan-ready');
  assert.equal(ready.plan.documentRevision, 5, 'only the live read sets the plan base revision');
});

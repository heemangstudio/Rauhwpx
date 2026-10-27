// 같은 문서의 파일 이름이 바뀌면(다른 이름으로 저장·이름 바꾸기) 허브 세션과 그 문서의 프로젝트가 새 이름을 따른다.
// 따르지 않으면 새 이름의 문서에서 가져온 자료가 옛 문서 이름의 프로젝트에 쌓여 다른 문서의 프로젝트처럼 보인다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { HUB_TOKEN, connect, startLiveHub } from './live-hub-fixture.mjs';

const DOCUMENT = 'doc-homework';

test('a renamed document keeps one project under its new name, and the agent imports into it', { timeout: 60_000 }, async (t) => {
  const hub = await startLiveHub(t, { documentId: DOCUMENT });
  await hub.start({ documentName: '1027 국어수행 백석 수라.hwpx' });
  const bound = await hub.studio.next((frame) => frame.type === 'project-bound');
  assert.equal(bound.project.name, '1027 국어수행 백석 수라');
  const projectId = bound.projectId;
  const projectNamed = (name) => hub.studio.next((frame) => frame.type === 'project-bound'
    && frame.projectId === projectId && frame.project.name === name);

  // 다른 이름으로 저장: Studio 는 같은 문서 id 로 새 이름을 알린다.
  hub.studio.send({ type: 'project-bind', threadId: hub.threadId, documentId: DOCUMENT, documentName: 'jj.hwpx' });
  const renamed = await projectNamed('jj');
  assert.deepEqual(renamed.project.members.map((member) => member.name), ['jj.hwpx']);

  // 다른 문서 id 의 이름은 이 세션의 문서 이름을 바꾸지 않는다.
  hub.studio.send({ type: 'project-bind', threadId: hub.threadId, documentId: 'doc-other', documentName: '남의 문서.hwpx' });
  // 같은 채팅을 다시 시작하면(설정이 같아 세션을 그대로 쓴다) 그 이름으로도 다시 맞춘다.
  const restarted = await hub.start({ documentName: 'apple firmness.hwpx' });
  assert.equal(restarted.projectId, projectId);
  await projectNamed('apple firmness');

  hub.message('HOLD');
  await hub.studio.next((frame) => frame.type === 'agent-event' && frame.event.text === 'HOLD_READY');
  const mcp = await connect(`ws://127.0.0.1:${hub.port}/mcp?token=${HUB_TOKEN}&sessionId=${hub.sessionId}&agent=pi`);
  t.after(() => mcp.socket.close());
  let id = 0;
  const call = async (tool, args) => {
    const callId = ++id;
    mcp.send({ type: 'tool-call', id: callId, tool, args, workflow: restarted.workflow, capabilityEpoch: restarted.capabilityEpoch });
    return mcp.next((frame) => frame.type === 'tool-result' && frame.id === callId);
  };
  const imported = await call('project_import', { text: '초음파 경도 측정 요약', name: '초음파.md' });
  assert.equal(imported.ok, true, JSON.stringify(imported));
  const summary = await call('project_read', { view: 'summary' });
  assert.equal(summary.result.id, projectId);
  assert.equal(summary.result.name, 'apple firmness');
  assert.deepEqual(summary.result.documents.map((document) => document.name), ['apple firmness.hwpx']);
  assert.equal(summary.result.counts.files, 1);
});

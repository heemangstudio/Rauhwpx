/**
 * HeemangEngine 문서에서 에이전트 텍스트 도구의 좌표가 엔진 주소로 바르게 옮겨지는지 —
 * 인라인 개체 옆 위치, 여러 줄 넣기, 스칼라 offset, 원자 배치 롤백.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';

test('글자 offset 은 인라인 그림을 세지 않고, 앵커 뒤 넣기는 그림을 건너 그 글자 뒤에 들어간다', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.bodyMixed);
  if (!env.modern) return t.skip('vendor/hm-wasm 가 ParagraphInfo.offsets 이전 빌드다 (HM_WASM_PKG 로 새 빌드를 준다)');
  const original = env.text(0);
  const anchor = '그림 앞의 글입니다.';
  assert.ok(original.startsWith(anchor));
  const found = await env.read('find_text', { query: '그림 뒤' });
  assert.deepEqual((found.matches as Array<{ charOffset: number }>).map((m) => m.charOffset), [original.indexOf('그림 뒤')]);
  await env.call('insert_text', { find: anchor, position: 'after', text: ' [A]' });
  assert.equal(env.text(0), `${anchor} [A]${original.slice(anchor.length)}`);
  // 그림 컨트롤은 그대로 남는다.
  assert.equal(env.adapter.paragraphs(0, [], 0, 1)[0].controls.filter((c) => c.kind === 'object').length, 1);
});

test('줄바꿈이 든 넣기는 문단을 나누고, 범위 바꾸기·지우기는 그 문단들에 맞게 적용된다', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.bodyMixed);
  if (!env.modern) return t.skip('vendor/hm-wasm 가 ParagraphInfo.offsets 이전 빌드다 (HM_WASM_PKG 로 새 빌드를 준다)');
  const original = env.text(0);
  const res = await env.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '첫 줄\n둘째 줄\n' });
  assert.deepEqual(res.insertedRange, { startParaIdx: 0, startCharOffset: 0, endParaIdx: 2, endCharOffset: 0 });
  assert.deepEqual([env.text(0), env.text(1), env.text(2)], ['첫 줄', '둘째 줄', original]);
  await env.call('replace_range', { sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 1, endCharOffset: 2, text: '하나' });
  assert.deepEqual([env.text(0), env.text(1)], ['하나 줄', original]);
  await env.call('delete_range', { sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 3 });
  assert.equal(env.text(0), '줄');
});

test('charOffset 은 유니코드 글자 단위다 (UTF-16 쌍을 한 글자로 센다)', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.cellMixed);
  if (!env.modern) return t.skip('vendor/hm-wasm 가 ParagraphInfo.offsets 이전 빌드다 (HM_WASM_PKG 로 새 빌드를 준다)');
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 0, text: 'a😀b' });
  assert.equal((await env.read('get_text_range', { sectionIdx: 0, paraIdx: 1 })).paraLength, 3);
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 2, text: '|' });
  assert.equal(env.text(1), 'a😀|b');
});

test('apply_edits 는 한 항목이라도 실패하면 문서와 엔진 이력을 배치 전으로 되돌린다', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.bodyMixed);
  if (!env.modern) return t.skip('vendor/hm-wasm 가 ParagraphInfo.offsets 이전 빌드다 (HM_WASM_PKG 로 새 빌드를 준다)');
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: '앞 ' });
  const text = env.text(0);
  const undo = env.adapter.state().undo;
  await assert.rejects(
    env.call('apply_edits', { edits: [
      { tool: 'insert_text', paraIdx: 0, charOffset: 0, text: 'Z' },
      { tool: 'insert_text', paraIdx: 99, charOffset: 0, text: 'Q' },
    ] }),
    (e: Error & { code?: string }) => e.code === 'INVALID_ARGS' && /rolled back/.test(e.message),
  );
  assert.equal(env.text(0), text);
  assert.equal(env.adapter.state().undo, undo);
  const ok = await env.call('apply_edits', { edits: [
    { tool: 'replace_range', find: '앞', occurrence: 1, text: '뒤' },
    { tool: 'insert_text', paraIdx: 0, charOffset: 0, text: '>> ' },
  ] });
  assert.equal(ok.applied, 2);
  assert.ok(env.text(0).startsWith('>> 뒤 '));
});

test('앞선 revision 으로 보낸 쓰기는 REVISION_MISMATCH 로 거절되고 문서는 그대로다', async (t) => {
  const env = await openHeemangAgent(t, FIXTURES.bodyMixed);
  if (!env.modern) return t.skip('vendor/hm-wasm 가 ParagraphInfo.offsets 이전 빌드다 (HM_WASM_PKG 로 새 빌드를 준다)');
  const stale = env.revision.revision;
  await env.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'A' });
  const text = env.text(0);
  await assert.rejects(
    env.executor.execute('insert_text', { expectedRevision: stale, sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'B' }, 'claude'),
    (e: Error & { code?: string }) => e.code === 'REVISION_MISMATCH',
  );
  assert.equal(env.text(0), text);
});

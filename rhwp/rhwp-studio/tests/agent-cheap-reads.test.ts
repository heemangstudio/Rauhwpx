/**
 * 저렴한 읽기 (P2.3) — read_batch 묶음 읽기와 get_structure 의 range/sinceRevision/pages/text:"full"
 * 증분 읽기 계약을 executor → 실제 PendingEditManager → 가짜 wasm 통합 경로로 검증한다.
 * 허브 측 스키마/프로필/정의 크기는 rhwp-agent/tests/tools.test.mjs 가 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addTable, expectErr, makeEnv } from './agent-test-env.ts';

type BatchResult = { tool: string | null; error?: { code: string; message: string } } & Record<string, unknown>;

const resultsOf = (r: Record<string, unknown>): BatchResult[] => r['results'] as BatchResult[];
const mcpText = (r: Record<string, unknown>): string =>
  ((r['mcpContent'] as Array<{ text: string }> | undefined)?.[0]?.text) ?? '';

// ─── read_batch ─────────────────────────────────────────

test('read_batch: 여러 읽기를 한 호출에 돌리고 최상위 revision 하나만 실린다', async () => {
  const h = makeEnv(['첫째 문단', '둘째 문단']);
  const r = await h.call('read_batch', {
    reads: [
      { tool: 'get_structure' },
      { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: 1 } },
      { tool: 'get_fields' },
    ],
  });
  assert.equal(r['revision'], h.revision.revision);
  const results = resultsOf(r);
  assert.equal(results.length, 3);
  assert.deepEqual(results.map((i) => i['tool']), ['get_structure', 'get_text_range', 'get_fields']);
  // mcpContent 텍스트 블록은 항목의 text 필드로 풀린다 — 중첩 JSON 에 image 블록이
  // 섞이는 결과를 막기 위해 render_page/materialize_document_snapshot 은 허용 목록 밖이다.
  assert.match(String(results[0]['text']), /s0 p0 \(5\) 첫째 문단/);
  assert.equal(results[0]['revision'], undefined, '항목별 revision 은 싣지 않는다');
  assert.equal(results[0]['mcpContent'], undefined);
  assert.equal(results[1]['text'], '둘째 문단');
  assert.equal(results[1]['paraLength'], 5);
  assert.deepEqual(results[2]['fields'], []);
});

test('read_batch: 한 항목의 실패가 나머지를 멈추지 않고 항목 오류로 보고된다', async () => {
  const h = makeEnv(['본문']);
  const r = await h.call('read_batch', {
    reads: [
      { tool: 'get_text_range', args: { sectionIdx: 0, paraIdx: 99 } }, // 범위 밖
      { tool: 'get_document_info' },                                    // 그래도 성공
      { tool: 'nonsense_tool' },                                        // 목록 밖 이름
      'not-an-object' as unknown as Record<string, never>,              // 잘못된 항목 자체
    ],
  });
  const results = resultsOf(r);
  assert.equal(results.length, 4);
  assert.equal(results[0]['error']?.code, 'INVALID_ARGS');
  assert.match(results[0]['error']?.message ?? '', /paraIdx 99 out of range/);
  assert.equal(results[1]['error'], undefined);
  assert.equal(results[1]['sourceFormat'], 'hwpx');
  assert.equal(results[2]['error']?.code, 'INVALID_ARGS');
  assert.match(results[2]['error']?.message ?? '', /read item tool must be one of/);
  assert.equal(results[3]['tool'], null);
  assert.equal(results[3]['error']?.code, 'INVALID_ARGS');
  assert.equal(r['revision'], h.revision.revision);
});

test('read_batch: 쓰기 도구·배치 도구·바이너리 읽기는 항목 오류로 거절된다', async () => {
  const h = makeEnv(['본문']);
  const r = await h.call('read_batch', {
    reads: [
      { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 0, charOffset: 0, text: 'x' } },
      { tool: 'apply_edits', args: { edits: [] } },
      { tool: 'read_batch', args: { reads: [] } },
      { tool: 'render_page', args: { pageIndex: 0 } },
      { tool: 'materialize_document_snapshot' },
      { tool: 'template_get_structure' },
    ],
  });
  for (const item of resultsOf(r)) {
    assert.equal(item['error']?.code, 'INVALID_ARGS', `${item['tool']}: 허용 목록 밖인데 통과함`);
  }
  assert.equal(h.body[0], '본문', '거절된 항목이 문서를 바꾸면 안 된다');
});

test('read_batch: reads 는 1-16개 배열이어야 한다', async () => {
  const h = makeEnv(['본문']);
  for (const reads of [[], Array.from({ length: 17 }, () => ({ tool: 'get_fields' })), 'x', undefined]) {
    const e = await expectErr(h.call('read_batch', { reads }), 'INVALID_ARGS');
    assert.match(e.message, /1\.\.16/);
  }
});

// ─── get_structure range ────────────────────────────────

test('get_structure range: 지정 본문 문단 범위만 읽고 머리 줄에 범위를 실는다', async () => {
  const h = makeEnv(['영', '하나', '둘', '셋']);
  const r = await h.call('get_structure', { range: { sectionIdx: 0, fromPara: 1, toPara: 2 } });
  const text = mcpText(r);
  assert.match(text, /range s0 p1-p2/);
  assert.match(text, /s0 p1 \(2\) 하나/);
  assert.match(text, /s0 p2 \(1\) 둘/);
  assert.ok(!text.includes('s0 p0 ') && !text.includes('s0 p3 '), '범위 밖 문단은 싣지 않는다');
});

test('get_structure range: json 도 같은 범위만 싣고 range 를 에코한다', async () => {
  const h = makeEnv(['영', '하나', '둘']);
  const r = await h.call('get_structure', { format: 'json', range: { sectionIdx: 0, fromPara: 2, toPara: 2 } });
  assert.deepEqual(r['range'], { sectionIdx: 0, fromPara: 2, toPara: 2 });
  const sections = r['sections'] as Array<{ sectionIdx: number; paragraphCount: number; paragraphs: Array<{ paraIdx: number }> }>;
  assert.equal(sections[0].paragraphCount, 3, 'paragraphCount 는 섹션 전체 기준을 유지한다');
  assert.deepEqual(sections[0].paragraphs.map((p) => p.paraIdx), [2]);
});

test('get_structure range: 끝을 넘긴 toPara 는 마지막 문단으로 당기고 실제로 읽은 범위를 알린다', async () => {
  const h = makeEnv(['영', '하나', '둘', '셋']);
  // 모델은 "s0 · 4 paragraphs" 에서 끝을 4 로 셈한다.
  const text = mcpText(await h.call('get_structure', { range: { sectionIdx: 0, fromPara: 2, toPara: 4 } }));
  assert.match(text.split('\n')[0], /· range s0 p2-p3$/);
  assert.match(text, /s0 p2 \(1\) 둘\ns0 p3 \(1\) 셋$/);
  const json = await h.call('get_structure', { format: 'json', range: { sectionIdx: 0, fromPara: 0, toPara: 99 } });
  assert.deepEqual(json['range'], { sectionIdx: 0, fromPara: 0, toPara: 3 });
  assert.equal((json['sections'] as Array<{ paragraphs: unknown[] }>)[0].paragraphs.length, 4);
});

test('get_structure range: 끝을 넘긴 시작·뒤집힌 순서·없는 구역은 INVALID_ARGS', async () => {
  const h = makeEnv(['본문', '둘']);
  const past = await expectErr(h.call('get_structure', { range: { sectionIdx: 0, fromPara: 2, toPara: 5 } }), 'INVALID_ARGS');
  assert.match(past.message, /fromPara <= 1 \(section 0 has paragraphs 0\.\.1\)/);
  await expectErr(h.call('get_structure', { range: { sectionIdx: 0, fromPara: 1, toPara: 0 } }), 'INVALID_ARGS');
  await expectErr(h.call('get_structure', { range: { sectionIdx: 3, fromPara: 0, toPara: 0 } }), 'INVALID_ARGS');
});

// ─── get_structure sinceRevision ───────────────────────

test('get_structure sinceRevision: 바뀐 문단과 누적 이동 경계만 돌려준다', async () => {
  const h = makeEnv(['앞', '중간', '뒤']);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 1, text: 'x\ny' });

  const r = await h.call('get_structure', { sinceRevision: base });
  assert.equal(r['revision'], h.revision.revision);
  assert.equal(r['sinceRevision'], base);
  const text = mcpText(r);
  assert.match(text, /changes since revision/);
  assert.match(text, /s0 changed p0-p1 \(was p0\):/);   // 삽입이 문단을 나눈 범위 (현재 좌표)
  assert.match(text, /s0 p0 \(2\) 앞x/);
  assert.match(text, /s0 p1 \(1\) y/);
  assert.match(text, /s0 shift p1\+ → \+1/);          // 저장된 p>=1 은 +1 이동
  assert.ok(!text.includes('중간') && !text.includes('뒤'), '안 바뀐 문단 텍스트는 싣지 않는다');
});

test('get_structure sinceRevision: 삭제는 was 범위와 음수 이동을 보고한다', async () => {
  const h = makeEnv(['a0', 'a1', 'a2', 'a3']);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('delete_range', {
    sectionIdx: 0, startParaIdx: 1, startCharOffset: 0, endParaIdx: 2, endCharOffset: 2,
  });
  const r = await h.call('get_structure', { sinceRevision: base, format: 'json' });
  const changes = r['changes'] as Array<{ paraStart: number; paraEnd: number; wasRanges: number[][] }>;
  assert.equal(changes.length, 1);
  assert.deepEqual({ s: changes[0].paraStart, e: changes[0].paraEnd, was: changes[0].wasRanges },
    { s: 1, e: 1, was: [[1, 2]] });
  const shifts = r['indexShifts'] as Array<{ sectionIdx: number; at: number; delta: number }>;
  assert.deepEqual(shifts, [{ sectionIdx: 0, at: 3, delta: -1 }]);
});

test('get_structure sinceRevision: since == 현재 revision 이면 변경 없음으로 돌아온다', async () => {
  const h = makeEnv(['본문']);
  const base = (await h.call('get_structure'))['revision'] as number;
  const r = await h.call('get_structure', { sinceRevision: base });
  assert.match(mcpText(r), /no recorded paragraph changes/);
  await expectErr(h.call('get_structure', { sinceRevision: base + 1 }), 'INVALID_ARGS');
  await expectErr(h.call('get_structure', { sinceRevision: -1 }), 'INVALID_ARGS');
});

test('get_structure sinceRevision: 저널이 덮지 못하는 구간이면 FULL_REFRESH_REQUIRED', async () => {
  const h = makeEnv(['본문']);
  const base = (await h.call('get_structure'))['revision'] as number;
  // 저널 없는 bump — 사용자 편집 등 기록 밖 변이를 흉내낸다.
  h.bus.emit('document-mutated', 'user-edit');
  const e = await expectErr(h.call('get_structure', { sinceRevision: base }), 'FULL_REFRESH_REQUIRED');
  assert.match(e.message, /Re-read with get_structure without sinceRevision/);
  // 로드 시점(0)도 저널이 시작되기 전이라 gap 이다.
  await expectErr(h.call('get_structure', { sinceRevision: 0 }), 'FULL_REFRESH_REQUIRED');
});

test('apply_edits: 한 revision bump 에 묶인 항목들이 저널에 각각 귀속된다', async () => {
  const h = makeEnv(['aa', 'bb', 'cc', 'dd']);
  const base = (await h.call('get_structure'))['revision'] as number;
  const r = await h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', args: { sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 2, text: 'AA' } },
      { tool: 'insert_text', args: { sectionIdx: 0, paraIdx: 1, charOffset: 0, text: 'x\ny' } },
    ],
  });
  assert.equal(r['revision'], base + 1, '배치는 revision 을 한 번만 올린다');

  const delta = await h.call('get_structure', { sinceRevision: base });
  const text = mcpText(delta);
  // 두 항목 모두 그 revision 의 델타에 들어와야 한다 — 중간 revision 이 없어
  // 버퍼 없이 개별 record 하면 (b,b] 빈 구간에 버려져 둘 다 사라진다 (회귀).
  // 인접 변경 구간은 하나로 합쳐진다: p0 교체 + p1 분할 → 현재 p0-p2.
  assert.match(text, /s0 changed p0-p2 \(was p0-p1\):/);
  assert.match(text, /s0 p0 \(2\) AA/);
  assert.match(text, /s0 p2 \(3\) ybb/);
  assert.match(text, /s0 shift p2\+ → \+1/);
});

test('get_structure sinceRevision + range: 범위와 겹치는 변경만 싣는다', async () => {
  const h = makeEnv(['p0', 'p1', 'p2', 'p3']);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('apply_edits', {
    edits: [
      { tool: 'replace_range', args: { sectionIdx: 0, startParaIdx: 0, startCharOffset: 0, endParaIdx: 0, endCharOffset: 2, text: 'X0' } },
      { tool: 'replace_range', args: { sectionIdx: 0, startParaIdx: 3, startCharOffset: 0, endParaIdx: 3, endCharOffset: 2, text: 'X3' } },
    ],
  });
  const r = await h.call('get_structure', { sinceRevision: base, range: { sectionIdx: 0, fromPara: 2, toPara: 3 } });
  const text = mcpText(r);
  assert.match(text, /s0 changed p3 \(was p3\):/);
  assert.match(text, /s0 p3 \(2\) X3/);
  assert.ok(!/changed p0/.test(text), 'range 밖 변경은 싣지 않는다');
});

test('read_batch 안의 get_structure 도 sinceRevision 델타를 돌려준다', async () => {
  const h = makeEnv(['하나', '둘']);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 1, text: '!' });
  const r = await h.call('read_batch', { reads: [{ tool: 'get_structure', args: { sinceRevision: base } }] });
  const item = resultsOf(r)[0];
  assert.equal(item['error'], undefined);
  assert.match(String(item['text']), /changes since revision/);
});

// ─── get_structure pages / text:"full" / 서식 태그 ─────────────

/** 쪽 시작 위치를 가진 가짜 조판 — starts[page] = [paraIdx, continued]. */
function withPages(starts: Array<[number, boolean]>) {
  return (wasm: Record<string, unknown>) => {
    Object.defineProperty(wasm, 'pageCount', { get: () => starts.length, configurable: true });
    wasm['getPositionOfPage'] = (page: number) => ({
      ok: true, sec: 0, para: starts[page][0], charOffset: 0, continued: starts[page][1],
    });
  };
}

const TWELVE = Array.from({ length: 12 }, (_, i) => `문단${i}`);
// 0쪽 p0, 1쪽 p4, 2쪽은 p8 가운데서 시작한다 (p8 이 1-2쪽에 걸친다).
const THREE_PAGES: Array<[number, boolean]> = [[0, false], [4, false], [8, true]];

test('get_structure: 전체 읽기에 쪽 표시를 넣고 문단 중간에서 넘어간 쪽은 그 문단 뒤에 적는다', async () => {
  const h = makeEnv(TWELVE, withPages(THREE_PAGES));
  const lines = mcpText(await h.call('get_structure')).split('\n');
  const at = (line: string) => lines.indexOf(line);
  assert.ok(at('-- page 1 (pageIndex 0) --') < at('s0 p0 (3) 문단0'));
  assert.ok(at('s0 p3 (3) 문단3') < at('-- page 2 (pageIndex 1) --') && at('-- page 2 (pageIndex 1) --') < at('s0 p4 (3) 문단4'));
  assert.ok(at('s0 p8 (3) 문단8') < at('-- page 3 (pageIndex 2, p8 continues) --')
    && at('-- page 3 (pageIndex 2, p8 continues) --') < at('s0 p9 (3) 문단9'));
});

test('get_structure pages: 쪽 범위를 본문 범위로 풀고 이어지는 문단은 끝 쪽에 포함한다', async () => {
  const h = makeEnv(TWELVE, withPages(THREE_PAGES));
  const middle = mcpText(await h.call('get_structure', { pages: [1, 1] }));
  assert.match(middle.split('\n')[0], /pageIndex 1-1/);
  assert.match(middle, /-- page 2 \(pageIndex 1\) --\ns0 p4 \(3\) 문단4/);
  assert.match(middle, /s0 p8 \(3\) 문단8/, '2쪽으로 넘어가는 p8 은 1쪽에서 시작하므로 싣는다');
  assert.ok(!middle.includes('s0 p3 ') && !middle.includes('s0 p9 '), '범위 밖 문단은 싣지 않는다');
  assert.ok(!middle.includes('-- page 3'), '범위 밖 쪽 표시는 싣지 않는다');

  const last = mcpText(await h.call('get_structure', { pages: [2, 2] }));
  assert.match(last, /-- page 3 \(pageIndex 2, p8 continues\) --\ns0 p8 \(3\) 문단8/);
  assert.match(last, /s0 p11 \(4\) 문단11/);
  assert.ok(!last.includes('s0 p7 '));

  const json = await h.call('get_structure', { pages: [0, 1], format: 'json' });
  assert.deepEqual(json['pages'], [0, 1]);
  const paras = (json['sections'] as Array<{ paragraphs: Array<{ paraIdx: number }> }>)[0].paragraphs;
  assert.deepEqual(paras.map((p) => p.paraIdx), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(json['pageStarts'], [
    { page: 0, sectionIdx: 0, paraIdx: 0, continued: false },
    { page: 1, sectionIdx: 0, paraIdx: 4, continued: false },
  ]);
});

test('get_structure range: 범위 앞에서 시작한 쪽을 머리에 한 번 적는다', async () => {
  const h = makeEnv(TWELVE, withPages(THREE_PAGES));
  const text = mcpText(await h.call('get_structure', { range: { sectionIdx: 0, fromPara: 5, toPara: 9 } }));
  const body = text.split('\n').slice(3);
  assert.deepEqual(body.slice(0, 2), ['-- page 2 (pageIndex 1) --', 's0 p5 (3) 문단5']);
  assert.match(text, /s0 p8 \(3\) 문단8\n-- page 3 \(pageIndex 2, p8 continues\) --\ns0 p9 \(3\) 문단9/);
});

test('get_structure pages: 마지막 쪽을 넘긴 last 는 당겨 읽지 않고 0 기준 쪽 번호를 알려 거절한다', async () => {
  const h = makeEnv(TWELVE, withPages(THREE_PAGES));
  // 1 부터 센 "2-3쪽" 을 [2, 3] 으로 보낸 경우 — 당겨 읽으면 3쪽만 조용히 읽힌다.
  const past = await expectErr(h.call('get_structure', { pages: [2, 3] }), 'INVALID_ARGS');
  assert.match(past.message, /pageIndex is 0-based \(the user's page N is pageIndex N-1\) and this document has pageIndex 0\.\.2/);
  await expectErr(h.call('get_structure', { pages: [0, 99], format: 'json' }), 'INVALID_ARGS');
  const text = mcpText(await h.call('get_structure', { pages: [1, 2] }));
  assert.match(text.split('\n')[0], /· pageIndex 1-2$/);
});

test('get_structure pages: range·sinceRevision 과 섞거나 첫 쪽이 범위를 벗어나면 INVALID_ARGS', async () => {
  const h = makeEnv(TWELVE, withPages(THREE_PAGES));
  await expectErr(h.call('get_structure', { pages: [0, 1], range: { sectionIdx: 0, fromPara: 0, toPara: 1 } }), 'INVALID_ARGS');
  await expectErr(h.call('get_structure', { pages: [0, 1], sinceRevision: 0 }), 'INVALID_ARGS');
  const past = await expectErr(h.call('get_structure', { pages: [3, 5] }), 'INVALID_ARGS');
  assert.match(past.message, /0 <= first <= last <= 2/);
  await expectErr(h.call('get_structure', { pages: [2, 1] }), 'INVALID_ARGS');
  await expectErr(h.call('get_structure', { pages: [1] }), 'INVALID_ARGS');
  await expectErr(h.call('get_structure', { text: 'all' }), 'INVALID_ARGS');
});

test('get_structure text:"full": 전문을 싣고 글자 예산을 넘기면 문단 경계에서 끊어 이어 읽을 범위를 알린다', async () => {
  const long = (ch: string) => ch.repeat(7000);
  const h = makeEnv([long('가'), long('나'), long('다'), '끝']);
  const preview = mcpText(await h.call('get_structure'));
  assert.match(preview, /s0 p0 \(7000\) 가{120}…/, 'preview 는 그대로 120자');

  const r = await h.call('get_structure', { text: 'full' });
  const text = mcpText(r);
  assert.equal(r['truncated'], true);
  assert.match(text.split('\n')[0], /full text · TRUNCATED — continue with range \{sectionIdx:0, fromPara:2, toPara:3\} text:"full"/);
  assert.ok(text.includes(`s0 p1 (7000) ${long('나')}\n`) || text.endsWith(`s0 p1 (7000) ${long('나')}`), 'p1 은 전문');
  assert.ok(!text.includes('s0 p2 '), '예산을 넘는 문단 앞에서 끊는다');

  const next = await h.call('get_structure', { text: 'full', range: { sectionIdx: 0, fromPara: 2, toPara: 3 }, format: 'json' });
  assert.equal(next['truncated'], false);
  assert.equal(next['continueFrom'], undefined);
  const paras = (next['sections'] as Array<{ paragraphs: Array<{ text: string }> }>)[0].paragraphs;
  assert.deepEqual(paras.map((p) => p.text.length), [7000, 1]);
});

test('get_structure text:"full": 예산보다 긴 첫 문단은 잘라 싣고 다음 문단부터 이어 읽게 한다', async () => {
  const h = makeEnv(['가'.repeat(20_000), '뒤']);
  const r = await h.call('get_structure', { text: 'full', format: 'json' });
  const paras = (r['sections'] as Array<{ paragraphs: Array<{ text: string; length: number }> }>)[0].paragraphs;
  assert.equal(paras.length, 1);
  assert.equal(paras[0].length, 20_000);
  assert.equal(paras[0].text.length, 16_000);
  assert.deepEqual(r['continueFrom'], { sectionIdx: 0, fromPara: 1, toPara: 1 });
});

test('get_structure text:"full": 표 셀 전문도 같은 예산으로 싣는다', async () => {
  const h = makeEnv(['표 앞', '', '표 뒤']);
  addTable(h, 1, [['셀'.repeat(300), '짧음']]);
  const text = mcpText(await h.call('get_structure', { text: 'full' }));
  assert.match(text, new RegExp(`r0 \\[0\\] ${'셀'.repeat(300)} \\| \\[1\\] 짧음`));
});

// ─── get_structure 줄 글: 양 끝 공백을 드러내는 따옴표 ─────────────

/** compact 줄의 글 부분을 문서 글로 되돌린다 — 잘림 표시를 떼고, 따옴표로 시작하면 JSON 문자열로 푼다. */
function lineTextToDocument(shown: string): string {
  const body = shown.replace(/…(\(\d+\))?$/, '');
  const text = body.startsWith('"') ? JSON.parse(body) as string : body;
  return text.replace(/⇥/g, '\t').replace(/⏎/g, '\n');
}

test('get_structure 줄 글: 양 끝이 공백인 문단만 JSON 따옴표로 감싸고 되돌리면 문서 글 그대로다', async () => {
  const body = [
    '  앞 공백', '뒤 공백  ', '  양쪽 ', '가운데 "따옴표" 줄', ' 공백과 "따옴표" \\ ', '"따옴표로 시작',
    '\t탭으로 시작', ' 탭\t가운데 ', '\u3000전각 공백', '   ', '평범한 줄',
  ];
  const h = makeEnv(body);
  const lines = mcpText(await h.call('get_structure')).split('\n').slice(3);
  assert.deepEqual(lines, [
    's0 p0 (6) "  앞 공백"',
    's0 p1 (6) "뒤 공백  "',
    's0 p2 (5) "  양쪽 "',
    's0 p3 (11) 가운데 "따옴표" 줄',                     // 양 끝이 공백이 아니면 예전 그대로
    's0 p4 (13) " 공백과 \\"따옴표\\" \\\\ "',
    's0 p5 (8) "\\"따옴표로 시작"',                      // 따옴표로 시작하는 줄은 언제나 JSON 문자열
    's0 p6 (7) ⇥탭으로 시작',                           // 치환된 탭은 보이므로 감싸지 않는다
    's0 p7 (7) " 탭⇥가운데 "',
    's0 p8 (6) "\u3000전각 공백"',
    's0 p9 (3) "   "',
    's0 p10 (5) 평범한 줄',
  ]);
  lines.forEach((line, i) => {
    assert.equal(lineTextToDocument(line.replace(/^s0 p\d+ \([^)]*\) /, '')), body[i], `p${i} 되돌리기`);
  });
  // JSON 은 글이 이미 정확하므로 감싸지 않는다.
  const json = await h.call('get_structure', { format: 'json' });
  const paras = (json['sections'] as Array<{ paragraphs: Array<{ text: string }> }>)[0].paragraphs;
  assert.deepEqual(paras.map((p) => p.text), body);
});

test('get_structure 줄 글: 잘린 미리보기는 닫는 따옴표 뒤에 … 를 붙인다', async () => {
  const body = ['  들여쓴 긴 문단입니다', '끝이 공백 에서 잘리는 문단', '그냥 긴 문단입니다'];
  const h = makeEnv(body);
  const lines = mcpText(await h.call('get_structure', { maxPreviewChars: 6 })).split('\n').slice(3);
  assert.deepEqual(lines, [
    's0 p0 (13) "  들여쓴 "…',
    's0 p1 (15) "끝이 공백 "…',
    's0 p2 (10) 그냥 긴 문…',
  ]);
  lines.forEach((line, i) => {
    assert.equal(lineTextToDocument(line.replace(/^s0 p\d+ \([^)]*\) /, '')), body[i].slice(0, 6));
  });
});

test('get_structure 줄 글: 셀 문단도 같은 규칙으로 감싸고 잘림 표시는 따옴표 밖에 둔다', async () => {
  const h = makeEnv(['표 앞', '']);
  const t = addTable(h, 1, [[' 성명 ', '값'], ['  들여쓴 긴 셀 문단', '']]);
  t.cells[1] = ['값', 'ㅇ ', ''];
  const text = mcpText(await h.call('get_structure'));
  assert.match(text, /\n {2}r0 \[0\] " 성명 " \| \[1\] 값⏎"ㅇ "⏎\n {2}r1 \[2\] " {2}들여쓴 긴 셀 문단" \| \[3\]$/);
  const cut = mcpText(await h.call('get_structure', { maxPreviewChars: 5 }));
  assert.match(cut, /\n {2}r1 \[2\] " {2}들여쓴"…\(12\) \| \[3\]$/);
  assert.equal(lineTextToDocument('"  들여쓴"…(12)'), '  들여쓴');
});

// ─── get_structure 서식 태그 ────────────────────────────────

type Shape = { bold?: boolean; italic?: boolean; underline?: boolean; size?: number };
/** 문단 하나의 서식 — runs 는 [끝 오프셋(제외), 모양] 목록이고, 없으면 문단 전체가 한 모양이다. */
type ParaFormat = Shape & { head?: string; level?: number; runs?: Array<[number, Shape]> };

/**
 * 서식 조회를 가진 가짜 — 본문 문단(formats[paraIdx])과 셀 문단(cells["cellIdx:cellParaIdx"])의 글자
 * 모양. 엔진처럼 같은 모양은 같은 charShapeId 를 받는다. calls 는 엔진 읽기 횟수다.
 */
function withFormats(formats: Record<number, ParaFormat>, cells: Record<string, ParaFormat> = {}) {
  const calls = { runs: 0, props: 0, cellRuns: 0, cellProps: 0 };
  const shapeIds = new Map<string, number>();
  const shapeId = (shape: Shape): number => {
    const key = JSON.stringify([shape.bold === true, shape.italic === true, shape.underline === true, shape.size ?? 1000]);
    if (!shapeIds.has(key)) shapeIds.set(key, shapeIds.size + 1);
    return shapeIds.get(key)!;
  };
  const runsOf = (format: ParaFormat | undefined, start: number, end: number) => {
    let from = start;
    return (format?.runs ?? [[end, format ?? {}] as [number, Shape]]).map(([to, shape]) => {
      const run = { startOffset: from, endOffset: to, charShapeId: shapeId(shape) };
      from = to;
      return run;
    });
  };
  const propsAt = (format: ParaFormat | undefined, offset: number) => {
    const shape: Shape = format?.runs?.find(([to]) => offset < to)?.[1] ?? format ?? {};
    return {
      fontFamily: '바탕', bold: shape.bold === true, italic: shape.italic === true,
      underline: shape.underline === true, fontSize: shape.size ?? 1000, charShapeId: shapeId(shape),
    };
  };
  const extend = (wasm: Record<string, unknown>) => {
    wasm['getParaPropertiesAt'] = (_s: number, p: number) => ({ headType: formats[p]?.head ?? 'None', paraLevel: formats[p]?.level ?? 0 });
    wasm['getCharShapeRuns'] = (_s: number, p: number, start: number, end: number) => {
      calls.runs++;
      return runsOf(formats[p], start, end);
    };
    wasm['getCharPropertiesAt'] = (_s: number, p: number, offset: number) => {
      calls.props++;
      return propsAt(formats[p], offset);
    };
    wasm['getCharShapeRunsInCellByPath'] = (_s: number, _p: number, path: string, start: number, end: number) => {
      calls.cellRuns++;
      const [{ cellIndex, cellParaIndex }] = JSON.parse(path) as Array<{ cellIndex: number; cellParaIndex: number }>;
      return runsOf(cells[`${cellIndex}:${cellParaIndex}`], start, end);
    };
    wasm['getCellCharPropertiesAt'] = (_s: number, _p: number, _c: number, cell: number, cp: number, offset: number) => {
      calls.cellProps++;
      return propsAt(cells[`${cell}:${cp}`], offset);
    };
  };
  return Object.assign(extend, { calls });
}

const B: Shape = { bold: true };
const PLAIN: Shape = {};

test('get_structure 태그: 짧은 문단에 개요 수준·굵게·본문과 다른 크기를 붙이고 긴 문단은 조회하지 않는다', async () => {
  const body = ['사업 개요', '가. 추진 배경', '본문'.repeat(45), '혼합 제목', '평범한 짧은 줄', '굵은긴문단'.repeat(16)];
  const h = makeEnv(body, withFormats({
    0: { head: 'Outline', level: 0, bold: true, size: 1400 },
    1: { head: 'Number', level: 1, bold: true },
    3: { runs: [[1, B], [5, PLAIN]] },
    5: { bold: true },
  }));
  const text = mcpText(await h.call('get_structure'));
  assert.match(text, /s0 p0 \(5 h1 B 14pt\) 사업 개요/);
  assert.match(text, /s0 p1 \(8 #2 B\) 가\. 추진 배경/);
  assert.match(text, /s0 p2 \(90\) 본문/, '긴 본문은 태그 없이');
  assert.match(text, /s0 p3 \(5 B0-1\) 혼합 제목/, '일부만 굵으면 그 구간을 적는다');
  assert.match(text, /s0 p4 \(8\) 평범한 짧은 줄/);
  assert.match(text, /s0 p5 \(80\) 굵은/, '제목 길이를 넘는 문단은 조회하지 않는다');
  const json = await h.call('get_structure', { format: 'json' });
  const paras = (json['sections'] as Array<{ paragraphs: Array<{ tag?: string }> }>)[0].paragraphs;
  assert.deepEqual(paras.map((p) => p.tag), ['h1 B 14pt', '#2 B', undefined, 'B0-1', undefined, undefined]);
});

test('get_structure 태그: 강조는 전체·구간·흩어짐으로 빠짐없이 적고 B 가 없으면 굵은 글자가 없다', async () => {
  const I: Shape = { italic: true };
  // [글, 글자 모양 구간, 기대 태그]
  const cases: Array<[string, Array<[number, Shape]>, string | undefined]> = [
    ['전체 굵게', [[5, B]], 'B'],
    ['제목   ', [[2, B], [5, PLAIN]], 'B'],                                  // 공백만 덮는 구간은 뺀다
    ['굵은 머리 그리고 본문', [[5, B], [12, PLAIN]], 'B0-5'],
    ['가나다라마 본문', [[2, B], [5, { bold: true, italic: true }], [8, PLAIN]], 'B0-5 I2-5'],   // 이어진 구간은 합친다
    ['가나 다라 마바', [[2, B], [3, PLAIN], [5, B], [8, PLAIN]], 'B0-5'],        // 사이 공백 구간은 잇는다
    ['AB cd EF gh', [[2, B], [6, PLAIN], [8, B], [11, PLAIN]], 'B0-2,6-8'],
    ['a1b2c3', [[1, B], [2, PLAIN], [3, B], [4, PLAIN], [5, B], [6, PLAIN]], 'B0-1,2-3,4-5'],
    ['a1b2c3d4', [[1, B], [2, PLAIN], [3, B], [4, PLAIN], [5, B], [6, PLAIN], [7, B], [8, PLAIN]], 'B~'],
    ['기울임 밑줄', [[6, { italic: true, underline: true }]], 'I U'],
    ['큰 글자와 굵은 끝', [[6, { size: 1400 }], [10, { bold: true, size: 1400 }]], 'B6-10 14pt'],
    ['크기가 섞인 줄', [[3, { size: 1400 }], [8, I]], 'I3-8 ~pt'],                 // 크기가 섞이면 본문 크기로 읽히지 않게 적는다
    ['😀 굵게', [[2, PLAIN], [4, B]], 'B2-4'],                                // 오프셋은 글자(scalar) 단위다
    ['모양만 다른 본문', [[3, PLAIN], [9, { size: 1000 }]], undefined],
    ['   ', [[1, B], [3, PLAIN]], 'B'],                                       // 공백뿐이면 첫 구간을 본다
  ];
  const formats: Record<number, ParaFormat> = {};
  cases.forEach(([, runs], i) => { formats[i] = { runs }; });
  const h = makeEnv(cases.map(([text]) => text), withFormats(formats));
  const json = await h.call('get_structure', { format: 'json' });
  const paras = (json['sections'] as Array<{ paragraphs: Array<{ tag?: string }> }>)[0].paragraphs;
  assert.deepEqual(paras.map((p) => p.tag), cases.map(([, , tag]) => tag));
  cases.forEach(([text, runs], i) => {
    let from = 0;
    const inkedBold = runs.some(([to, shape]) => {
      const inked = text.slice(from, to).trim() !== '';
      from = to;
      return inked && shape.bold === true;
    });
    if (text.trim() !== '') assert.equal(/\bB/.test(paras[i].tag ?? ''), inkedBold, `p${i}: B 태그와 굵은 글자 유무가 같아야 한다`);
  });
  assert.match(mcpText(await h.call('get_structure')), /s0 p1 \(5 B\) "제목 {3}"\n/);
});

test('get_structure 태그: 문단마다 모양 구간을 한 번, 글자 모양은 모양마다 한 번만 읽는다', async () => {
  const formats: Record<number, ParaFormat> = {
    0: { bold: true },
    1: { bold: true },
    2: { runs: [[2, B], [4, { italic: true }], [6, PLAIN]] },
    3: { runs: [[3, { italic: true }], [6, B]] },
  };
  const fake = withFormats(formats);
  const h = makeEnv(['제목 하나', '제목 둘', '가나다라마바', '다라마바사아', '본문'], fake);
  await h.call('get_structure');
  // 모양 구간: 본문 크기 표본(5) + 태그 판정(5). 글자 속성: 서로 다른 모양(굵게·기울임·보통)마다 한 번.
  assert.deepEqual(fake.calls, { runs: 5 + 5, props: 3, cellRuns: 0, cellProps: 0 });
  await h.call('get_structure', { text: 'full' });
  assert.deepEqual(fake.calls, { runs: 5 + 5, props: 3, cellRuns: 0, cellProps: 0 }, '같은 revision 은 메모를 쓴다');
});

test('get_structure 태그: 쓰기로 revision 이 오르면 서식을 다시 읽는다', async () => {
  const formats: Record<number, ParaFormat> = {};
  const h = makeEnv(['제목', '본문'], withFormats(formats));
  assert.match(mcpText(await h.call('get_structure')), /s0 p0 \(2\) 제목/);
  formats[0] = { bold: true };
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 2, text: '.' });
  assert.match(mcpText(await h.call('get_structure')), /s0 p0 \(2 B\) 제목/);
});

test('get_structure 태그: 깨끗한 문서를 바꿔 열어 revision 이 그대로여도 새 문서의 서식을 읽는다', async () => {
  const formats: Record<number, ParaFormat> = { 0: { bold: true, size: 1400 } };
  let fake: Record<string, unknown> = {};
  const h = makeEnv(['제목', '본문 하나', '본문 둘'], (wasm) => {
    withFormats(formats)(wasm);
    wasm['documentGeneration'] = 1;
    fake = wasm;
  });
  assert.match(mcpText(await h.call('get_structure')), /s0 p0 \(2 B 14pt\) 제목/);
  // 같은 좌표·길이의 다른 문서가 열렸다 — 로드는 revision 을 올리지 않고 문서 세대만 올린다.
  const revision = h.revision.revision;
  formats[0] = {};
  fake['documentGeneration'] = 2;
  assert.equal(h.revision.revision, revision);
  assert.match(mcpText(await h.call('get_structure')), /s0 p0 \(2\) 제목/);
});

// ─── get_structure 셀 태그 ─────────────────────────────────

test('get_structure 셀 태그: 짧은 셀 문단의 강조·크기를 cellIdx 뒤에 적고 여러 문단인 셀은 문단별로 적는다', async () => {
  const fake = withFormats({}, {
    '0:0': { bold: true, size: 2200 },
    '1:0': { bold: true },
    '2:0': { bold: true },
    '2:1': { runs: [[1, { italic: true }], [2, PLAIN]] },
    '3:0': { bold: true },
  });
  const h = makeEnv(['표 앞', ''], fake);
  const t = addTable(h, 1, [['표 제목', '머리'], ['', '긴'.repeat(70)]]);
  t.cells[2] = ['첫째', '둘째', '셋째', ''];
  const lines = mcpText(await h.call('get_structure')).split('\n');
  assert.deepEqual(lines.slice(-3), [
    '  table s0 p1 c0 2x2',
    '  r0 [0 B 22pt] 표 제목 | [1 B] 머리',
    `  r1 [2 p0 B p1 I0-1] 첫째⏎둘째⏎셋째⏎ | [3] ${'긴'.repeat(70)}`,
  ]);
  assert.equal(fake.calls.cellRuns, 5, '빈 문단과 긴 문단은 조회하지 않는다');

  const json = await h.call('get_structure', { format: 'json' });
  const table = (json['sections'] as Array<{ tables: Array<Record<string, unknown>> }>)[0].tables[0];
  const cells = table['cells'] as Array<{ paragraphs: Array<{ text: string; tag?: string }> }>;
  assert.deepEqual(cells.map((c) => c.paragraphs.map((p) => p.tag)), [
    ['B 22pt'], ['B'], ['B', 'I0-1', undefined, undefined], [undefined],
  ]);
  assert.equal(table['untaggedFromCellIdx'], undefined);
  assert.equal(fake.calls.cellRuns, 5, '같은 revision 은 셀 태그 메모를 쓴다');
});

test('get_structure 셀 태그: 표에서 가장 흔한 셀 글자 크기는 표 줄에 한 번만 적고 셀에는 다른 크기만 적는다', async () => {
  const small: Shape = { size: 900 };
  const smallBold: Shape = { bold: true, size: 900 };
  const fake = withFormats({}, {
    '0:0': smallBold,
    '1:0': smallBold,
    '2:0': { runs: [[1, smallBold], [2, small]] },
    '2:1': { runs: [[1, smallBold], [2, small]] },
    '3:0': smallBold,
    '3:2': smallBold,
    '4:0': {},                                           // 본문 크기(10pt)는 표 기준과 달라 적는다
    '5:0': { runs: [[2, small], [5, { size: 1400 }]] },  // 크기가 섞인 문단은 ~pt 로 적는다
  });
  const h = makeEnv(['표 앞', ''], fake);
  const t = addTable(h, 1, [['구분', '내용', ''], ['', '본문 크기', '섞인 크기']]);
  t.cells[2] = ['비고', '참고'];
  t.cells[3] = ['첫 줄', '', '둘째 줄'];
  const lines = mcpText(await h.call('get_structure')).split('\n');
  assert.deepEqual(lines.slice(-3), [
    '  table s0 p1 c0 2x3 cells 9pt',
    // 오프셋 구간은 문단 안 좌표라 문단이 여럿이면 같은 태그라도 문단을 밝힌다.
    '  r0 [0 B] 구분 | [1 B] 내용 | [2 p0 B0-1 p1 B0-1] 비고⏎참고',
    '  r1 [3 B] 첫 줄⏎⏎둘째 줄 | [4 10pt] 본문 크기 | [5 ~pt] 섞인 크기',
  ]);
  // JSON 의 셀 태그는 본문 문단처럼 본문 크기 기준이다.
  const json = await h.call('get_structure', { format: 'json' });
  const cells = (json['sections'] as Array<{ tables: Array<{ cells: Array<{ paragraphs: Array<{ tag?: string }> }> }> }>)[0].tables[0].cells;
  assert.deepEqual(cells.map((c) => c.paragraphs.map((p) => p.tag)), [
    ['B 9pt'], ['B 9pt'], ['B0-1 9pt', 'B0-1 9pt'], ['B 9pt', undefined, 'B 9pt'], [undefined], ['~pt'],
  ]);
});

test('get_structure 셀 태그: 읽기 한 번에 200개까지만 달고 끊긴 셀을 표 줄에 알린다', async () => {
  const cellFormats: Record<string, ParaFormat> = {};
  for (let i = 0; i < 204; i++) cellFormats[`${i}:0`] = { bold: true };
  const fake = withFormats({}, cellFormats);
  const h = makeEnv(['표 앞', '', ''], fake);
  // 빈 셀과 긴 셀은 한도를 쓰지 않는다 — 태그 후보는 cellIdx 2 부터 200개다.
  addTable(h, 1, [['', '긴'.repeat(70), ...Array.from({ length: 202 }, (_, i) => `c${i + 2}`)]]);
  addTable(h, 2, [['뒤 표']]);
  const text = mcpText(await h.call('get_structure'));
  assert.match(text, /\n {2}table s0 p1 c0 1x204 \(no cell tags from \[202\]\)\n/);
  assert.match(text, / \| \[201 B\] c201 \| \[202\] c202 \| \[203\] c203\n/);
  assert.match(text, /\n {2}table s0 p2 c0 1x1 \(no cell tags\)\n {2}r0 \[0\] 뒤 표$/);
  assert.equal(fake.calls.cellRuns, 200);

  const json = await h.call('get_structure', { format: 'json' });
  const tables = (json['sections'] as Array<{ tables: Array<Record<string, unknown>> }>)[0].tables;
  assert.deepEqual(tables.map((table) => table['untaggedFromCellIdx']), [202, 0]);
  assert.equal(fake.calls.cellRuns, 200, '다시 읽어도 같은 200개만 단다');
});

test('get_structure 셀 태그: 셀 서식 읽기가 없는 엔진에서는 조용히 태그 없이 싣는다', async () => {
  const cells = { '0:0': { bold: true, size: 2200 }, '1:0': { runs: [[1, B], [2, PLAIN]] as Array<[number, Shape]> } };
  const bare = makeEnv(['표 앞', ''], (wasm) => {
    withFormats({}, cells)(wasm);
    delete wasm['getCellCharPropertiesAt'];
  });
  addTable(bare, 1, [['표 제목', '머리']]);
  assert.match(mcpText(await bare.call('get_structure')), /\n {2}table s0 p1 c0 1x2\n {2}r0 \[0\] 표 제목 \| \[1\] 머리$/);

  // 모양 구간만 못 읽는 엔진은 본문처럼 첫 글자 모양으로 판정한다.
  const noRuns = makeEnv(['표 앞', ''], (wasm) => {
    withFormats({}, cells)(wasm);
    delete wasm['getCharShapeRunsInCellByPath'];
  });
  addTable(noRuns, 1, [['표 제목', '머리']]);
  assert.match(mcpText(await noRuns.call('get_structure')), /\n {2}r0 \[0 B 22pt\] 표 제목 \| \[1 B\] 머리$/);
});

test('get_structure 셀 태그: 문서를 바꿔 열면 같은 셀 주소·같은 charShapeId 라도 새 문서의 서식을 읽는다', async () => {
  let bold = true;
  let reads = 0;
  let fake: Record<string, unknown> = {};
  const h = makeEnv(['표 앞', ''], (wasm) => {
    wasm['documentGeneration'] = 1;
    wasm['getCharShapeRunsInCellByPath'] = (_s: number, _p: number, _path: string, start: number, end: number) =>
      [{ startOffset: start, endOffset: end, charShapeId: 7 }];
    wasm['getCellCharPropertiesAt'] = () => {
      reads++;
      return { bold, fontSize: 1000 };
    };
    fake = wasm;
  });
  addTable(h, 1, [['제목 셀', '둘째 셀']]);
  assert.match(mcpText(await h.call('get_structure')), /r0 \[0 B\] 제목 셀 \| \[1 B\] 둘째 셀$/);
  assert.equal(reads, 1, '같은 글자 모양은 한 번만 읽는다');
  await h.call('get_structure');
  assert.equal(reads, 1);
  // 같은 주소·같은 모양 번호의 다른 문서 — revision 은 그대로, 문서 세대만 오른다.
  const revision = h.revision.revision;
  bold = false;
  fake['documentGeneration'] = 2;
  assert.equal(h.revision.revision, revision);
  assert.match(mcpText(await h.call('get_structure')), /r0 \[0\] 제목 셀 \| \[1\] 둘째 셀$/);
  assert.equal(reads, 2);
});

// ─── get_structure sinceRevision: 같은 줄 표기 ───────────────────

test('get_structure sinceRevision: 바뀐 줄도 전체 읽기와 같은 따옴표·태그로 싣는다', async () => {
  const fake = withFormats(
    { 0: { bold: true, size: 1400 }, 1: { runs: [[6, PLAIN], [8, B], [10, PLAIN]] } },
    { '0:0': { bold: true }, '1:0': { runs: [[1, B], [3, PLAIN]] } },
  );
  const h = makeEnv(['머리', '  들여쓴 굵은 ', '', '끝'], fake);
  addTable(h, 2, [[' 셀 ', '가나']]);
  const base = (await h.call('get_structure'))['revision'] as number;
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 0, charOffset: 2, text: '말' });
  await h.call('insert_text', { sectionIdx: 0, paraIdx: 1, charOffset: 8, text: ' ' });
  await h.call('insert_text', {
    sectionIdx: 0, paraIdx: 0, charOffset: 2, text: '다', cell: { paraIdx: 2, controlIdx: 0, cellIdx: 1 },
  });

  const delta = mcpText(await h.call('get_structure', { sinceRevision: base })).split('\n');
  const changed = delta.slice(delta.findIndex((line) => line.startsWith('s0 changed')));
  assert.deepEqual(changed.filter((line) => !/^s0 (changed|shift) /.test(line)), [
    's0 p0 (3 B 14pt) 머리말',
    's0 p1 (10 B6-8) "  들여쓴 굵은  "',
    's0 p2 (0)',
    '  table s0 p2 c0 1x2',
    '  r0 [0 B] " 셀 " | [1 B0-1] 가나다',
  ]);
  const full = mcpText(await h.call('get_structure')).split('\n');
  for (const line of changed.filter((l) => !/^s0 (changed|shift) /.test(l))) {
    assert.ok(full.includes(line), `전체 읽기에 같은 줄이 있어야 한다: ${line}`);
  }
  const json = await h.call('get_structure', { sinceRevision: base, format: 'json' });
  const changes = json['changes'] as Array<{ paragraphs: Array<{ text: string; tag?: string }>; tables: Array<{ cells: Array<{ paragraphs: Array<{ tag?: string }> }> }> }>;
  assert.deepEqual(changes.flatMap((c) => c.paragraphs.map((p) => [p.text, p.tag])), [
    ['머리말', 'B 14pt'], ['  들여쓴 굵은  ', 'B6-8'], ['', undefined],
  ]);
  assert.deepEqual(changes.flatMap((c) => c.tables.flatMap((t) => t.cells.map((cell) => cell.paragraphs[0].tag))), ['B', 'B0-1']);
});

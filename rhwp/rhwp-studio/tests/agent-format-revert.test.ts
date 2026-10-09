/**
 * 에이전트 글자 서식의 거절·승인 후 undo — 혼합 서식 범위가 글자마다 원래 모양으로 돌아오는가.
 *
 * 서식 op 은 적용 전 글자 모양 구간을 잡아 두었다가 되돌릴 때 그대로 다시 입힌다. 범위가 적용
 * 직후 상태가 아니면(다른 턴의 편집·사용자 편집이 남아 있으면) 단일 샘플 역서식으로 폴백한다.
 * 가짜 엔진은 charShapeModel 로 글자마다 모양을 모사하고, 마지막 테스트는 실제 WASM 으로 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addTable, charShapeModel, makeEnv } from './agent-test-env.ts';
import type { FakeCharShape } from './agent-test-env.ts';
import type { PendingOp } from '../src/agent/types.ts';

const TEXT = '가나다라마바사아자';
const boldMarks = (shapes: FakeCharShape[]): string => shapes.map((s) => (s.bold ? 'B' : '.')).join('');
const formatOps = (h: ReturnType<typeof makeEnv>) => h.pending.getChangeSets()
  .flatMap((set) => set.ops)
  .filter((op): op is Extract<PendingOp, { kind: 'format' }> => op.kind === 'format');

/** 'BBB......' — 앞 세 글자만 굵은 문단 */
function boldHead() {
  const fmt = charShapeModel();
  const h = makeEnv([TEXT], fmt.extend);
  fmt.format(0, 0, 3, { bold: true });
  return { fmt, h, before: fmt.ids(0) };
}

test('거절: 앞 세 글자만 굵은 문단 전체에 bold:false 를 걸었다가 거절하면 글자마다 원래 모양이다', async () => {
  const { fmt, h, before } = boldHead();
  assert.equal(boldMarks(fmt.shapes(0)), 'BBB......');
  const r = await h.call('apply_char_format', { paraIdx: 0, bold: false });
  assert.equal(boldMarks(fmt.shapes(0)), '.........');
  h.pending.reject(String(r['changeSetId']));
  assert.equal(boldMarks(fmt.shapes(0)), 'BBB......');
  assert.deepEqual(fmt.ids(0), before);
});

test('거절: 크기·색·글꼴·장평·자간이 섞인 문단도 글자 모양 id 그대로 돌아온다', async () => {
  const fmt = charShapeModel();
  const h = makeEnv([TEXT], fmt.extend);
  fmt.format(0, 0, 3, { fontSize: 1400 });
  fmt.format(0, 5, 7, {
    italic: true, underline: true, textColor: '#c00000', fontId: 1,
    ratios: [90, 90, 90, 90, 90, 90, 90], spacings: [-5, -5, -5, -5, -5, -5, -5],
  });
  const before = fmt.ids(0);
  const r = await h.call('apply_char_format', { paraIdx: 0, fontSizePt: 11, italic: false });
  assert.deepEqual(fmt.shapes(0).map((s) => s.fontSize), new Array(9).fill(1100));
  h.pending.reject(String(r['changeSetId']));
  assert.deepEqual(fmt.ids(0), before);
  assert.deepEqual(fmt.shapes(0).map((s) => s.fontSize), [1400, 1400, 1400, 1000, 1000, 1000, 1000, 1000, 1000]);
  assert.deepEqual(fmt.shapes(0).map((s) => s.textColor === '#c00000'), [false, false, false, false, false, true, true, false, false]);
});

test('승인 뒤 undo 는 혼합 서식 원본으로, redo 는 에이전트 서식으로 간다', async () => {
  const { fmt, h, before } = boldHead();
  const r = await h.call('apply_char_format', { paraIdx: 0, bold: false, fontSizePt: 12 });
  const after = fmt.ids(0);
  assert.equal(h.pending.approve(String(r['changeSetId'])), true);
  assert.deepEqual(fmt.ids(0), after, '승인은 미리보기를 그대로 채택한다');
  assert.equal(h.recorded.length, 1);
  h.recorded[0].undo(h.wasm);
  assert.deepEqual(fmt.ids(0), before);
  assert.equal(boldMarks(fmt.shapes(0)), 'BBB......');
  h.recorded[0].execute(h.wasm);
  assert.deepEqual(fmt.ids(0), after);
});

test('셀 문단: 혼합 서식 셀에 건 서식을 거절하면 셀 글자마다 원래 모양이다', async () => {
  const fmt = charShapeModel();
  const h = makeEnv(['본문', '', '말미'], fmt.extend);
  const t = addTable(h, 1, [['굵은글자 보통', '옆 칸']]);
  fmt.formatCell(t, 0, 0, 0, 4, { bold: true, fontSize: 1200 });
  const before = fmt.cellIds(t, 0, 0);
  const r = await h.call('apply_char_format', {
    cell: { paraIdx: 1, controlIdx: 0, cellIdx: 0 }, paras: [0], bold: false, fontSizePt: 9,
  });
  assert.equal(boldMarks(fmt.cellShapes(h.tables[0], 0, 0)), '.......');
  h.pending.reject(String(r['changeSetId']));
  assert.deepEqual(fmt.cellIds(h.tables[0], 0, 0), before);
  assert.equal(boldMarks(fmt.cellShapes(h.tables[0], 0, 0)), 'BBBB...');
});

test('paras: 여러 문단을 한 번에 서식하고 통째로 거절해도 조판은 각각 한 번, 문단마다 원래 모양이다', async () => {
  const fmt = charShapeModel();
  const long = '긴 문단 '.repeat(500);
  const h = makeEnv(['굵은 제목 줄', '큰 글씨 문단', '밑줄 섞인 문단', long, '색 있는 문단', '보통 굵게 보통'], fmt.extend);
  fmt.format(0, 0, 2, { bold: true });
  fmt.format(1, 0, 7, { fontSize: 1400 });
  fmt.format(2, 1, 3, { underline: true, italic: true });
  fmt.format(4, 2, 4, { textColor: '#0070c0' });
  fmt.format(5, 3, 5, { bold: true, fontSize: 1200 });
  const before = h.body.map((_, p) => fmt.ids(p));
  const layouts = fmt.layouts.count;
  const r = await h.call('apply_char_format', { paras: [[0, 5]], bold: true, fontSizePt: 11, underline: false });
  assert.equal(r['paragraphs'], 6);
  assert.equal(fmt.layouts.count - layouts, 1, '여섯 문단의 적용은 조판 한 번이다');
  const ops = formatOps(h);
  assert.equal(ops.length, 6);
  // 긴 문단도 글자별이 아니라 구간으로 들고 있다
  assert.deepEqual(ops.map((op) => op.charShapeRuns?.length), [2, 1, 3, 1, 3, 3]);
  assert.equal(ops[3].appliedCharShapeRuns?.length, 1);
  h.pending.reject(String(r['changeSetId']));
  assert.equal(fmt.layouts.count - layouts, 2, '거절도 조판 한 번이다');
  assert.deepEqual(h.body.map((_, p) => fmt.ids(p)), before);
});

test('같은 턴에 서식 범위 안을 다시 서식하고 삽입·교체한 뒤 거절해도 원래 텍스트와 글자마다 원래 모양이다', async () => {
  const { fmt, h, before } = boldHead();
  await h.call('apply_char_format', { paraIdx: 0, bold: false, italic: true });
  await h.call('apply_char_format', { anchor: { text: '다라' }, underline: true });
  await h.call('insert_text', { paraIdx: 0, charOffset: 2, text: 'XY' });
  await h.call('replace_range', { anchor: { text: '마바' }, text: '오' });
  assert.equal(h.body[0], '가나XY다라오사아자');
  const [set] = h.pending.getChangeSets();
  assert.equal(set.ops.length, 4);
  h.pending.reject(set.id);
  assert.equal(h.body[0], TEXT);
  assert.deepEqual(fmt.ids(0), before);
  assert.equal(boldMarks(fmt.shapes(0)), 'BBB......');
});

test('같은 턴에 서식 범위 안으로 삽입한 뒤 승인·undo 해도 원래 모양이다', async () => {
  const { fmt, h, before } = boldHead();
  await h.call('apply_char_format', { paraIdx: 0, bold: false });
  await h.call('insert_text', { paraIdx: 0, charOffset: 4, text: '끼움' });
  const [set] = h.pending.getChangeSets();
  assert.equal(h.pending.approve(set.id), true);
  h.recorded[0].undo(h.wasm);
  assert.equal(h.body[0], TEXT);
  assert.deepEqual(fmt.ids(0), before);
});

test('구간을 읽을 수 없는 엔진이면 단일 샘플 역서식으로 되돌린다', async () => {
  const fmt = charShapeModel();
  const h = makeEnv([TEXT], (wasm, body, tables) => {
    fmt.extend(wasm, body, tables);
    delete wasm['getCharShapeRuns'];
    delete wasm['getCharShapeRunsInCellByPath'];
  });
  const before = fmt.ids(0);
  const r = await h.call('apply_char_format', { paraIdx: 0, bold: true });
  const [op] = formatOps(h);
  assert.equal(op.charShapeRuns, undefined);
  assert.deepEqual(op.inverse, { bold: false });
  h.calls.length = 0;
  h.pending.reject(String(r['changeSetId']));
  assert.deepEqual(h.calls.map((c) => [c.m, c.a[4]]), [['applyCharFormat', '{"bold":false}']]);
  assert.deepEqual(fmt.ids(0), before);
});

test('다른 턴의 삽입이 범위 안에 남아 있으면 구간을 덮어쓰지 않고 단일 샘플 역서식으로 되돌린다', async () => {
  const { fmt, h } = boldHead();
  const a = await h.call('apply_char_format', { paraIdx: 0, bold: false });
  h.pending.endTurn();
  await h.call('insert_text', { paraIdx: 0, charOffset: 5, text: 'XY' });
  assert.equal(h.pending.getChangeSets().length, 2);
  const writes = fmt.runWrites.count;
  h.calls.length = 0;
  h.pending.reject(String(a['changeSetId']));
  assert.equal(fmt.runWrites.count, writes, '길이가 달라진 범위에 캡처한 구간을 쓰지 않는다');
  assert.deepEqual(h.calls.map((c) => [c.m, c.a[4]]), [['applyCharFormat', '{"bold":true}']]);
  assert.equal(h.body[0], '가나다라마XY바사아자');
});

test('검토 중 사용자가 범위 안 서식을 바꿨으면 에이전트가 건 속성만 되돌리고 사용자 서식은 남긴다', async () => {
  const fmt = charShapeModel();
  const h = makeEnv([TEXT], fmt.extend);
  const r = await h.call('apply_char_format', { paraIdx: 0, bold: true });
  fmt.format(0, 2, 4, { italic: true });
  h.bus.emit('document-mutated', 'input-handler-edit');
  h.pending.reject(String(r['changeSetId']));
  assert.equal(boldMarks(fmt.shapes(0)), '.........');
  assert.deepEqual(fmt.shapes(0).map((s) => s.italic), [false, false, true, true, false, false, false, false, false]);
});

test('검토 중 사용자가 범위 안 텍스트를 고쳤으면 서식 op 은 드리프트로 문서에 남는다', async () => {
  const { fmt, h } = boldHead();
  const r = await h.call('apply_char_format', { paraIdx: 0, bold: false });
  const events: Array<{ type: string; drops?: Array<{ cause: string }> }> = [];
  h.pending.onChange((e) => events.push(e));
  h.body[0] = '가나다!라마바사아자';
  h.bus.emit('document-mutated', 'input-handler-edit');
  h.pending.reject(String(r['changeSetId']));
  assert.equal(h.body[0], '가나다!라마바사아자');
  assert.equal(boldMarks(fmt.shapes(0)), '..........');
  const drop = events.find((e) => e.type === 'invalidated');
  assert.deepEqual(drop?.drops?.map((d) => d.cause), ['text-changed']);
});

const here = dirname(fileURLToPath(import.meta.url));
const pkgWasm = join(here, '..', '..', 'pkg', 'rhwp_bg.wasm');

test('실제 WASM: 앞 세 글자만 굵은 문단의 bold:false 거절과 승인 후 undo 가 원래 모양이다', (t) => {
  if (!existsSync(pkgWasm)) {
    t.skip('rhwp/pkg 의 WASM 빌드가 필요하다 (wasm-pack build --target web)');
    return;
  }
  const result = spawnSync(process.execPath, [
    '--no-warnings',
    '--import', pathToFileURL(join(here, 'support', 'ts-transform-hooks.mjs')).href,
    join(here, 'support', 'pending-format-revert.runner.mjs'),
  ], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PENDING_FORMAT_REVERT_OK/);
});

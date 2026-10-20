import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertUndoRedoRestores,
  commandServices,
  documentFingerprint,
  startEditEngine,
} from './support/edit-history-env.ts';
import {
  PAGE_MARGIN_PRESET_IDS,
  matchPageMarginPreset,
  matchParaSpacingPreset,
  mmToHwpunit,
} from '../src/core/layout-presets.ts';
import { PAGE_MARGIN_PRESET_IDS as HUB_PAGE_MARGIN_PRESET_IDS } from '../../rhwp-agent/tools.mjs';

// 쪽 › 쪽 여백, 서식 › 문단 간격 프리셋을 실제 엔진·편집 라우터로 실행한다.
// 다구역 문서 전체에 한 번의 되돌리기로 걸리는지, 바꾸면 안 되는 속성이 남는지 본다.

const env = await startEditEngine();
test.after(() => env.close());

const [{ pageCommands }, { formatCommands }] = await Promise.all([
  env.load('/src/command/commands/page.ts'),
  env.load('/src/command/commands/format.ts'),
]);

// 구역 2개(둘째 구역은 가로 용지), 본문 문단 사이에 표가 있는 문서
const SAMPLE = readFileSync(new URL('../../samples/2026_oss_rst.hwp', import.meta.url));

function openSample() {
  const wasm = env.openDocument(new Uint8Array(SAMPLE), '2026_oss_rst.hwp');
  const host = env.createHost(wasm);
  host.cursor.moveTo({ sectionIndex: 0, paragraphIndex: 0, charOffset: 0 });
  return { wasm, host };
}

function run(commands: any[], id: string, host: any, params?: Record<string, unknown>): void {
  const command = commands.find((c) => c.id === id);
  assert.ok(command, `${id} 명령이 있어야 한다`);
  command.execute(commandServices(host), params);
}

function pageDefs(wasm: any) {
  return Array.from({ length: wasm.getSectionCount() }, (_, s) => wasm.getPageDef(s));
}

/** 표 셀 문단의 문단 속성 전부 (위치 → JSON) */
function cellParaProps(wasm: any): Map<string, string> {
  const out = new Map<string, string>();
  for (let s = 0; s < wasm.getSectionCount(); s++) {
    for (let p = 0; p < wasm.getParagraphCount(s); p++) {
      for (let c = 0; c < 8; c++) {
        let cellCount = 0;
        try { cellCount = wasm.getTableDimensions(s, p, c).cellCount; } catch { continue; }
        for (let cell = 0; cell < cellCount; cell++) {
          for (let cp = 0; cp < wasm.getCellParagraphCount(s, p, c, cell); cp++) {
            out.set(`${s}:${p}:${c}:${cell}:${cp}`, JSON.stringify(wasm.getCellParaPropertiesAt(s, p, c, cell, cp)));
          }
        }
      }
    }
  }
  return out;
}

function bodyParaProps(wasm: any) {
  const out: any[] = [];
  for (let s = 0; s < wasm.getSectionCount(); s++) {
    for (let p = 0; p < wasm.getParagraphCount(s); p++) out.push(wasm.getParaPropertiesAt(s, p));
  }
  return out;
}

test('hub set_page_layout marginPreset ids match the Studio preset table', () => {
  assert.deepEqual([...HUB_PAGE_MARGIN_PRESET_IDS], [...PAGE_MARGIN_PRESET_IDS]);
});

test('page:margin-preset sets margins in every section as one undo step and keeps paper/orientation', () => {
  const { wasm, host } = openSample();
  const before = pageDefs(wasm);
  assert.ok(before.length > 1);
  assert.equal(matchPageMarginPreset(before), null);
  const fingerprint = documentFingerprint(wasm);

  run(pageCommands, 'page:margin-preset', host, { preset: 'narrow2-hf' });

  const after = pageDefs(wasm);
  after.forEach((def: any, s: number) => {
    assert.deepEqual(
      [def.marginTop, def.marginBottom, def.marginLeft, def.marginRight, def.marginHeader, def.marginFooter],
      [5, 5, 10, 10, 10, 10].map(mmToHwpunit),
      `구역 ${s}`,
    );
    const old = before[s];
    assert.deepEqual(
      [def.width, def.height, def.landscape, def.binding, def.marginGutter],
      [old.width, old.height, old.landscape, old.binding, old.marginGutter],
      `구역 ${s} 용지·방향·제본`,
    );
  });
  assert.equal(matchPageMarginPreset(after), 'narrow2-hf', '체크 표시는 좁게2 에 간다');

  assertUndoRedoRestores(host, fingerprint, '(쪽 여백)');
  // 이미 그 여백이면 기록을 남기지 않는다 — 되돌리기 한 번이면 처음 문서다
  run(pageCommands, 'page:margin-preset', host, { preset: 'narrow2-hf' });
  host.handleUndo();
  assert.equal(documentFingerprint(wasm), fingerprint);
  assert.equal(host.history.canUndo(), false, '되돌리기 한 번으로 모든 구역이 돌아간다');
});

test('format:spacing-preset changes only spacing of body percent paragraphs, as one undo step', () => {
  const { wasm, host } = openSample();
  const body = bodyParaProps(wasm);
  const cells = cellParaProps(wasm);
  assert.ok(cells.size > 0, '표 셀 문단이 있어야 한다');
  const initialPreset = matchParaSpacingPreset(wasm.getDocumentParaSpacing());
  const fingerprint = documentFingerprint(wasm);

  run(formatCommands, 'format:spacing-preset', host, { preset: 'wide' });

  const after = bodyParaProps(wasm);
  let changed = 0;
  after.forEach((props: any, i: number) => {
    const old = body[i];
    // 정렬·여백·들여쓰기 등은 문단마다 그대로
    for (const key of ['alignment', 'marginLeft', 'marginRight', 'indent', 'lineSpacingType', 'headType', 'tabStops']) {
      assert.deepEqual(props[key], old[key], `문단 ${i} ${key}`);
    }
    if (old.lineSpacingType === 'Percent' && props.lineSpacing === 200) {
      changed += 1;
      assert.equal(props.spacingBefore, 0, `문단 ${i}`);
      assert.ok(props.spacingAfter > 0, `문단 ${i} 문단 아래 6pt`);
    }
  });
  assert.ok(changed > 0, '본문 문단이 바뀌어야 한다');
  assert.deepEqual(cellParaProps(wasm), cells, '표 셀 문단은 그대로');
  assert.equal(matchParaSpacingPreset(wasm.getDocumentParaSpacing()), 'wide', '체크 표시는 넓게 에 간다');

  assertUndoRedoRestores(host, fingerprint, '(문단 간격)');
  host.handleUndo();
  assert.equal(host.history.canUndo(), false, '되돌리기 한 번으로 돌아간다');
  assert.equal(matchParaSpacingPreset(wasm.getDocumentParaSpacing()), initialPreset);
});

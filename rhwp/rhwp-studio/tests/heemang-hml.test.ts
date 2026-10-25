import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES, rhwpFile } from './heemang-agent-env.ts';
import { exportDocumentForFormat, forgetDocumentExportForTests } from '../src/command/save-document-format.ts';

const HML = 'samples/hml/formatting_table.hml';

test('HML 문서를 편집하고 같은 형식으로 저장한 뒤 다시 연다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, HML);
  assert.equal(wasm.getSourceFormat(), 'hml');
  assert.equal(adapter.state().format, 'hml');
  assert.equal(adapter.readOnly, false);
  assert.equal(wasm.hasHmlExportCapability(), true);
  assert.deepEqual(wasm.getHmlSaveState(), { sourceFormat: 'hml', hmlSavable: true, blockers: [] });
  assert.equal(wasm.getHmlOpenMetadata()?.hwpmlVersion, '2.91');
  assert.equal(wasm.getHmlOpenMetadata()?.encoding, 'utf-8');
  const before = adapter.getParagraphText(0, 0);
  wasm.insertText(0, 0, 0, 'HML😀');
  assert.equal(adapter.getParagraphText(0, 0), `HML😀${before}`);
  const epoch = adapter.state().contentEpoch;
  const bytes = exportDocumentForFormat(wasm, 'hml');
  assert.equal(adapter.state().contentEpoch, epoch);
  assert.equal(adapter.state().dirty, true);
  wasm.loadDocument(bytes, 'edited.hml');
  assert.equal(wasm.getSourceFormat(), 'hml');
  assert.equal(adapter.getParagraphText(0, 0), `HML😀${before}`);
  assert.equal(adapter.readOnly, false);
  const serialized = adapter.serialize();
  assert.equal(adapter.markSaved(), true);
  wasm.loadDocument(serialized, 'saved.hml');
  assert.equal(adapter.getParagraphText(0, 0), `HML😀${before}`);
});

test('HWP와 HWPX 문서를 HML로 내보내고 HML은 두 형식으로 변환한다', async t => {
  for (const source of [FIXTURES.blankHwp, FIXTURES.blankHwpx]) {
    const { wasm, adapter } = await openHeemangAgent(t, source);
    assert.equal(wasm.getHmlOpenMetadata(), null);
    assert.deepEqual(wasm.getHmlSaveState(), {
      sourceFormat: source.endsWith('.hwp') ? 'hwp' : 'hwpx', hmlSavable: true, blockers: [],
    });
    wasm.insertText(0, 0, 0, '변환😀');
    const expected = adapter.getParagraphText(0, 0);
    const hml = exportDocumentForFormat(wasm, 'hml');
    wasm.loadDocument(hml, 'converted.hml');
    assert.equal(adapter.getParagraphText(0, 0), expected);
    for (const format of ['hwp', 'hwpx'] as const) {
      const bytes = exportDocumentForFormat(wasm, format);
      wasm.loadDocument(bytes, `converted.${format}`);
      assert.equal(adapter.getParagraphText(0, 0), expected);
      assert.equal(wasm.getHmlOpenMetadata(), null);
      wasm.loadDocument(hml, 'converted.hml');
    }
  }
});

test('HML 출처 정보는 내용 교체에 맞게 갱신되고 잘못된 열기는 현재 문서를 보존한다', async t => {
  const { wasm, adapter } = await openHeemangAgent(t, HML);
  const before = adapter.getParagraphText(0, 0);
  assert.throws(() => wasm.loadDocument(new TextEncoder().encode('<html>wrong</html>'), 'wrong.hml'));
  assert.equal(wasm.getSourceFormat(), 'hml');
  assert.equal(adapter.getParagraphText(0, 0), before);
  assert.equal(wasm.getHmlOpenMetadata()?.format, 'hml');
  wasm.replaceContentFromBytes(rhwpFile(FIXTURES.blankHwpx));
  assert.equal(wasm.getSourceFormat(), 'hwpx');
  assert.equal(wasm.getHmlOpenMetadata(), null);
  wasm.replaceContentFromBytes(rhwpFile(HML));
  assert.equal(wasm.getSourceFormat(), 'hml');
  assert.equal(wasm.getHmlOpenMetadata()?.format, 'hml');
  assert.equal(adapter.readOnly, false);
  forgetDocumentExportForTests();
});

test('실제 그림과 각주 문서는 HML 변환 뒤에도 개체 데이터와 내부 문단을 보존한다', async t => {
  for (const source of ['samples/test-image.hwp', 'samples/test-image.hwpx', 'samples/footnote-01.hwp']) {
    const { wasm, adapter } = await openHeemangAgent(t, source);
    const doc = () => adapter.hmDoc();
    const query = (request: unknown): any => JSON.parse(doc().query(JSON.stringify(request)));
    const contents = (list: any): any[] => query({ kind: 'paragraphs', list }).map((p: any) => ({
      text: p.text,
      controls: p.controls.map((c: any) => ({
        kind: c.kind, script: c.script, number: c.number, inline: c.inline,
        ...(c.kind === 'picture' ? { picture: query({ kind: 'pictureData', object: { list, para: p.index, control: c.index } }) } : {}),
        lists: Array.from({ length: c.lists }, (_, i) => contents({ ...list, steps: [...(list.steps ?? []), { para: p.index, control: c.index, index: i }] })),
      })),
    }));
    const expected = contents({ section: 0 });
    const hml = exportDocumentForFormat(wasm, 'hml');
    wasm.loadDocument(hml, 'converted.hml');
    assert.deepEqual(contents({ section: 0 }), expected, source);
    for (const format of ['hwp', 'hwpx'] as const) {
      const bytes = exportDocumentForFormat(wasm, format);
      wasm.loadDocument(bytes, `converted.${format}`);
      assert.deepEqual(contents({ section: 0 }), expected, `${source} → HML → ${format}`);
      wasm.loadDocument(hml, 'converted.hml');
    }
  }
});

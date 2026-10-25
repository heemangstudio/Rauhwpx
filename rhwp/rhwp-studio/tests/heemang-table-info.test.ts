import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { transformSync } from 'rolldown/utils';
import { Engine, initSync } from '../vendor/hm-wasm/hm_wasm.js';
import type { Doc, TableAddress, TableInfo } from '../vendor/hm-wasm/hm_wasm.js';
import type { HeemangAdapter } from '../src/core/heemang-adapter.ts';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('?url')) return {url:new URL(specifier,context.parentURL).href,shortCircuit:true};
    return next(specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (url.endsWith('?url')) return {format:'module',shortCircuit:true,source:`export default ${JSON.stringify(url)}`};
    if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true, source: transformSync(new URL(url).pathname, readFileSync(new URL(url), 'utf8')).code };
    return next(url, context);
  },
});
initSync({ module: readFileSync(new URL('../vendor/hm-wasm/hm_wasm_bg.wasm', import.meta.url)) });
const { HmCore } = await import('../src/core/hm/core.ts');
const tables = await import('../src/core/hm/table-editing.ts');
const { bodyList, logicalAddress, paraMap } = await import('../src/core/hm/address.ts');
const blank = new Uint8Array(readFileSync(new URL('../src/core/hm/blank.hwpx', import.meta.url)));

function open(t: test.TestContext) {
  const engine = new Engine(), documents: Doc[] = [];
  let doc = engine.open(blank), loaded = true;
  documents.push(doc);
  t.after(() => { for (const item of documents) item.free(); engine.free(); });
  const adapter = { documentInstance: 1, hmDoc: () => { if (!loaded) throw new Error('문서가 닫혔습니다'); return doc; },
    hasLoadedDocument: () => loaded, applyReceipt: () => {}, refreshLayout: () => {} };
  const core = new HmCore(adapter as unknown as HeemangAdapter);
  let queries = 0;
  const query = core.query.bind(core);
  core.query = request => { if ('kind' in request && request.kind === 'table') queries++; return query(request); };
  const fresh = (table: TableAddress, page?: number): TableInfo => JSON.parse(core.call(d => d.query(JSON.stringify({ kind:'table', table, ...(page === undefined ? {} : {page}) }))));
  const read = (table: TableAddress, page?: number) => tables.tableInfo(core,table,page);
  const create = (rows = 2, columns = 2, steps: TableAddress['steps'] = []) => {
    const list = {section:0,steps};
    core.transact([{op:'createTable',at:logicalAddress(core,list,0,0),rows,columns}]);
    return {section:0,steps,para:0,control:core.paragraph(list,0).controls.find(c => c.kind === 'table')!.index};
  };
  const expectFresh = (table: TableAddress, page?: number) => {
    const before = queries, value = read(table,page);
    assert.deepEqual(value,fresh(table,page));
    assert.deepEqual(read(table,page),value);
    assert.equal(queries,before+1,'the new lifetime is read once, then reused');
    return value;
  };
  return {core,engine,create,read,fresh,expectFresh,queries:()=>queries,doc:()=>doc,
    replace(bytes:Uint8Array) { doc = engine.open(bytes); documents.push(doc); adapter.documentInstance++; core.noteDocumentReplaced(); },
    useDocument(next:Doc) { doc=next; adapter.documentInstance++; },
    close() { loaded=false; doc.close(); },
  };
}

test('table signature, dimensions and geometry share one native read without exposing mutable projections', t => {
  const f = open(t), table = f.create(), before = f.core.state(), count = f.queries();
  const dimensions = tables.getTableDimensions(f.core,0,0,table.control);
  tables.getCellInfo(f.core,0,0,table.control,0);
  tables.getTableSignature(f.core,0,0,table.control);
  const box = tables.getTableBBox(f.core,0,0,table.control);
  const cells = tables.getTableCellBboxes(f.core,0,0,table.control);
  assert.equal(f.queries(),count+1,'one native table geometry query for all readers');
  assert.deepEqual(f.read(table),f.fresh(table));
  assert.deepEqual(f.core.state(),before,'reads preserve the complete document/history state');
  dimensions.rowCount=99; box.width=0; cells[0].w=0;
  assert.equal(tables.getTableDimensions(f.core,0,0,table.control).rowCount,2);
  assert.ok(tables.getTableBBox(f.core,0,0,table.control).width>0);
  assert.ok(tables.getTableCellBboxes(f.core,0,0,table.control)[0].w>0);
});

test('body and cell edits, structural edits and Undo/Redo invalidate table geometry and save the same table', t => {
  const f = open(t), table = f.create();
  f.expectFresh(table);
  f.core.transact([{op:'insertText',at:logicalAddress(f.core,bodyList(0),0,0),text:'앞글 '.repeat(40)}]);
  f.expectFresh(table);
  const cell = f.read(table).cells[0].list;
  f.core.transact([{op:'insertText',at:logicalAddress(f.core,{section:cell.section,steps:cell.steps??[]},0,0),text:'셀 내용 '.repeat(80)}]);
  const before = f.expectFresh(table);
  f.core.transact([{op:'insertTableRows',table,beforeRow:1,count:1}]);
  const after = f.expectFresh(table);
  assert.equal(after.rows,before.rows+1);
  f.core.mutate(doc => doc.undo());
  assert.deepEqual(f.expectFresh(table),before);
  f.core.mutate(doc => doc.redo());
  assert.deepEqual(f.expectFresh(table),after);
  f.replace(f.doc().serialize(false));
  const reopened = f.expectFresh(table);
  assert.equal(reopened.rows,after.rows);
  assert.equal(f.core.paragraph({section:cell.section,steps:cell.steps??[]},0).text,'셀 내용 '.repeat(80));
});

test('nested table paths and page filters keep distinct geometry entries', t => {
  const f = open(t), outer = f.create(1,2);
  const left = f.create(2,1,[{para:0,control:outer.control,index:0}]);
  const right = f.create(3,1,[{para:0,control:outer.control,index:1}]);
  assert.equal(f.expectFresh(left).rows,2);
  assert.equal(f.expectFresh(right).rows,3);
  assert.equal(f.read(left).rows,2);
  f.core.transact([{op:'split',at:{section:0,para:0,offset:paraMap(f.core.paragraph(bodyList(0),0)).end},pageBreak:true}]);
  const all = f.expectFresh(outer), page = all.rects[0].page;
  assert.ok(f.expectFresh(outer,page).rects.length>0);
  assert.deepEqual(f.expectFresh(outer,page+1).rects,[]);
  assert.deepEqual(f.read(outer),all);
});

test('font changes and document replacement with equal numeric epochs cannot reuse old table entries', t => {
  const f = open(t), table = f.create();
  f.expectFresh(table);
  const before = f.core.state();
  const font = new Uint8Array(readFileSync(new URL('../../ttfs/opensource/NotoSansKR-Regular.ttf',import.meta.url)));
  f.engine.addFont('NotoSansKR-Regular.ttf',font);
  assert.notEqual(f.core.state().fontGeneration,before.fontGeneration);
  assert.notEqual(f.core.state().layoutEpoch,before.layoutEpoch);
  f.expectFresh(table);
  const refreshed = f.core.state();
  f.engine.addFont('NotoSansKR-Regular.ttf',font);
  assert.notEqual(f.core.state().fontGeneration,refreshed.fontGeneration);
  assert.equal(f.core.state().layoutEpoch,refreshed.layoutEpoch,'outline refill can change fonts without reflow');
  f.expectFresh(table);
  const original = open(t), originalTable = original.create(2,1);
  original.expectFresh(originalTable);
  const other = open(t), otherTable = other.create(3,1);
  // 같은 편집 횟수의 다른 문서는 내용·조판·글꼴 epoch 가 모두 같을 수 있다.
  for (const key of ['contentEpoch','layoutEpoch','fontGeneration'] as const) assert.equal(other.core.state()[key],original.core.state()[key]);
  original.useDocument(other.doc());
  assert.equal(original.expectFresh(otherTable).rows,3);
  original.close();
  assert.throws(()=>original.read(otherTable),/닫혔습니다/,'a cached result never escapes a closed document');
});

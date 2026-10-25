/** 서식 틀 이식은 사용자의 서식 포함 클립보드와 한 번의 검토 이력을 보존한다. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { openHeemangAgent, FIXTURES } from './heemang-agent-env.ts';
const { AgentToolExecutor } = await import('../src/agent/tool-executor.ts');
const { ForeignDocumentPool } = await import('../src/agent/foreign-documents.ts');

test('서식 틀 블록을 승인하고 되돌려도 복사한 내용은 그대로 붙여넣는다', async t => {
  const env = await openHeemangAgent(t, FIXTURES.blankHwpx);
  const source = await openHeemangAgent(t, FIXTURES.blankHwpx);
  source.wasm.insertText(0, 0, 0, 'TEMPLATE');
  const bytes = source.wasm.exportHwpx();
  const pool = new ForeignDocumentPool({ createEngine: async () => source.wasm, storage: null });
  t.after(() => pool.dispose());
  const executor = new AgentToolExecutor({ wasm: env.wasm, editor: env.editor as never,
    documentState: { isDirty: () => true } as never, revision: env.revision, pending: env.pending,
    loadTemplateBytes: async () => bytes, foreignDocuments: { pool } });
  t.after(() => executor.dispose());
  const template = { id: 'clipboard-template', name: 'TEMPLATE', originalName: 'template.hwpx', format: 'hwpx' as const,
    size: bytes.length, pageCount: 1, sectionCount: 1, contentHash: 'clipboard-template', revision: 1, createdAt: '', updatedAt: '' };
  const capability = { workflow: 'direct' as const, template };
  env.wasm.insertText(0, 0, 0, 'A');
  env.wasm.applyCharFormat(0, 0, 0, 1, JSON.stringify({ bold: true }));
  env.wasm.copySelection(0, 0, 0, 0, 1);
  await executor.execute('get_structure', { format: 'json' }, 'claude', capability);
  await executor.execute('get_structure', { documentId: 'template', format: 'json' }, 'claude', capability);
  env.pending.beginTurn('claude');
  const result = await executor.execute('template_insert_block', { expectedRevision: env.revision.revision,
    templateRevision: 1, source: { sectionIdx: 0, startParaIdx: 0, endParaIdx: 0 },
    target: { sectionIdx: 0, paraIdx: 0, charOffset: 1 } }, 'claude', capability) as { pending: boolean };
  assert.equal(result.pending, true);
  assert.equal(env.text(0), 'ATEMPLATE');
  assert.equal(env.wasm.getClipboardText(), 'A');
  env.pending.endTurn('review');
  assert.equal(env.pending.approve(env.pending.getChangeSets()[0].id), true);
  assert.ok(env.history.undo(env.wasm));
  assert.equal(env.text(0), 'A');
  assert.ok(env.history.redo(env.wasm));
  assert.equal(env.text(0), 'ATEMPLATE');
  assert.throws(() => env.wasm.pasteDocumentBlock(bytes, 0, 99, 99, 0, 0, 1));
  assert.equal(env.text(0), 'ATEMPLATE');
  env.wasm.pasteInternal(0, 0, env.wasm.getParagraphLength(0, 0));
  assert.equal(env.text(0), 'ATEMPLATEA');
  assert.equal(env.wasm.getCharPropertiesAt(0, 0, 9).bold, true);
  for (const [bytes, name] of [[env.wasm.exportHwp(), 'saved.hwp'], [env.wasm.exportHwpx(), 'saved.hwpx']] as const) {
    env.wasm.loadDocument(bytes, name);
    assert.equal(env.text(0), 'ATEMPLATEA');
  }
});

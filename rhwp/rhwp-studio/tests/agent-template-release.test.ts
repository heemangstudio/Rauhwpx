// 서식 틀 문서는 창의 엔진 묶음에 있고, 서식 틀 도구가 쉬는 동안에만 내려놓는다. 쓰는 중에 놓으면 이식
// 도구가 해제된 문서를 읽는다. 채팅 하나를 닫아도 다른 채팅이 같이 쓰는 엔진은 그대로다.
import test from 'node:test';
import assert from 'node:assert/strict';

const { AgentToolExecutor } = await import('../src/agent/tool-executor.ts');
const { FOREIGN_DOCUMENT_IDLE_MS, ForeignDocumentPool } = await import('../src/agent/foreign-documents.ts');
const { makeEnv } = await import('./agent-test-env.ts');

const template = {
  id: 'tpl-1', name: '양식', originalName: '양식.hwpx', format: 'hwpx', size: 1, pageCount: 1, sectionCount: 1,
  contentHash: 'x', revision: 1, createdAt: '', updatedAt: '',
} as const;

test('서식 틀 문서는 마지막 서식 틀 도구 뒤 쉬는 시간이 차야 놓이고, 채팅을 닫아도 같이 쓰는 엔진은 놓지 않는다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeEnv(['본문']);
  let released = 0;
  const templateWasm = {
    loadDocument: () => {},
    getSectionCount: () => 1,
    getPageDef: () => ({ width: 59528, height: 84188 }),
    getSectionDef: () => ({}),
    getColumnDef: () => ({ columnCount: 1 }),
    getPageBorderFill: () => ({}),
    releaseDocument: () => { released += 1; },
  };
  const pool = new ForeignDocumentPool({ createEngine: async () => templateWasm as never, storage: null });
  const chat = () => new AgentToolExecutor({
    wasm: h.wasm as never,
    editor: {} as never,
    documentState: { isDirty: () => false } as never,
    revision: h.revision,
    pending: h.pending,
    loadTemplateBytes: async () => new Uint8Array(),
    foreignDocuments: { pool },
  });
  const first = chat();
  const second = chat();
  const layout = (executor: InstanceType<typeof AgentToolExecutor>) => executor.execute(
    'template_get_page_layout', { templateRevision: 1, sectionIdx: 0 }, 'claude', { workflow: 'direct', template },
  ) as Promise<Record<string, unknown>>;

  assert.equal((await layout(first))['templateId'], 'tpl-1');
  first.dispose();
  t.mock.timers.tick(FOREIGN_DOCUMENT_IDLE_MS - 1);
  await layout(second);
  t.mock.timers.tick(FOREIGN_DOCUMENT_IDLE_MS - 1);
  assert.equal(released, 0, '쓰는 사이와 다른 채팅을 닫을 때는 놓지 않는다');
  t.mock.timers.tick(1);
  assert.equal(released, 1, '쉬는 시간이 차면 놓는다');

  pool.dispose();
  assert.equal(released, 1, '이미 놓은 문서는 다시 놓지 않는다');
});

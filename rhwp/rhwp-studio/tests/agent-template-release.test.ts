// 템플릿 문서는 템플릿 도구가 쉬는 동안에만 내려놓는다. 쓰는 중에 놓으면 이식 도구가 해제된 문서를 읽는다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    if (/\.css$/.test(url)) return { format: 'module', source: 'export default {};', shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { AgentToolExecutor, TEMPLATE_IDLE_RELEASE_MS } = await import('../src/agent/tool-executor.ts');
const { makeEnv } = await import('./agent-test-env.ts');

const template = {
  id: 'tpl-1', name: '양식', originalName: '양식.hwpx', format: 'hwpx', size: 1, pageCount: 1, sectionCount: 1,
  contentHash: 'x', revision: 1, createdAt: '', updatedAt: '',
} as const;

test('템플릿 문서는 마지막 템플릿 도구 뒤 쉬는 시간이 차야 놓이고, 사이에 쓰면 시간이 다시 잰다', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = makeEnv(['본문']);
  let released = 0;
  const templateWasm = {
    getSectionCount: () => 1,
    getPageDef: () => ({ width: 59528, height: 84188 }),
    getSectionDef: () => ({}),
    getColumnDef: () => ({ columnCount: 1 }),
    getPageBorderFill: () => ({}),
    releaseDocument: () => { released += 1; },
  };
  const executor = new AgentToolExecutor({
    wasm: h.wasm as never,
    editor: {} as never,
    documentState: { isDirty: () => false } as never,
    revision: h.revision,
    pending: h.pending,
    loadTemplateBytes: async () => new Uint8Array(),
  });
  Object.assign(executor as unknown as Record<string, unknown>, {
    templateWasm, templateBytes: new Uint8Array(), templateKey: 'tpl-1:1',
  });
  const layout = () => executor.execute('template_get_page_layout', { templateRevision: 1, sectionIdx: 0 }, 'claude', {
    workflow: 'direct', template,
  }) as Promise<Record<string, unknown>>;

  assert.equal((await layout())['templateId'], 'tpl-1');
  t.mock.timers.tick(TEMPLATE_IDLE_RELEASE_MS - 1);
  await layout();
  t.mock.timers.tick(TEMPLATE_IDLE_RELEASE_MS - 1);
  assert.equal(released, 0, '쓰는 사이에는 놓지 않는다');
  t.mock.timers.tick(1);
  assert.equal(released, 1, '쉬는 시간이 차면 놓는다');

  executor.dispose();
  assert.equal(released, 1, '이미 놓은 문서는 다시 놓지 않는다');
});

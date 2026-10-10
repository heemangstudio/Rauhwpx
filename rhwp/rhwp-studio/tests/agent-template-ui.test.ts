import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentToolExecutor } from '../src/agent/tool-executor.ts';

// 템플릿 내용을 옮기기 전에 받은 매핑은 그때 읽은 문서 revision 에만 유효하다.
test('template mapping expires when the open document revision changes', () => {
  const tracker = { revision: 7 };
  const executor = Object.create(AgentToolExecutor.prototype) as any;
  Object.assign(executor, {
    deps: { revision: tracker },
    documentInspectionRevision: 7,
    templateInspectionKey: 'tpl-1:3',
  });
  const template = { id: 'tpl-1', revision: 3 };
  assert.doesNotThrow(() => executor.requireTemplateMapping(template));

  tracker.revision = 8;
  assert.throws(() => executor.requireTemplateMapping(template), { code: 'TEMPLATE_MAPPING_REQUIRED' });

  tracker.revision = 7;
  assert.throws(
    () => executor.requireTemplateMapping({ id: 'tpl-1', revision: 4 }),
    { code: 'TEMPLATE_MAPPING_REQUIRED' },
    'a newer template revision also needs a fresh inspection',
  );
});

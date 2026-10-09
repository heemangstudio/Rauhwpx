import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCUMENT_WRITE_TOOLS } from '../src/agent/tool-executor.ts';
import {
  BATCHABLE_EDIT_TOOL_NAMES,
  BATCHABLE_READ_TOOL_NAMES,
  TOOL_CLASSIFICATIONS,
} from '../../rhwp-agent/tools.mjs';
import { makeEnv } from './agent-test-env.ts';

// 스튜디오의 plan-mode 쓰기 게이트(DOCUMENT_WRITE_TOOLS)와 허브의
// document-write 분류(tools.mjs)가 어긋나면, 허브/스튜디오 phase skew 구간에서
// 누락된 쓰기 도구가 스튜디오 측 게이트를 우회한다. 두 실제 모듈의 값을 비교한다.

const hubTools = Object.keys(TOOL_CLASSIFICATIONS).sort();
const sorted = (names: Iterable<string>) => [...names].sort();

test('DOCUMENT_WRITE_TOOLS가 허브의 document-write 분류와 일치한다', () => {
  const hub = hubTools.filter((name) => TOOL_CLASSIFICATIONS[name] === 'document-write');
  assert.ok(hub.length > 0, 'tools.mjs에서 document-write 분류를 하나도 찾지 못함');
  assert.deepEqual(sorted(DOCUMENT_WRITE_TOOLS), hub);
});

// apply_edits 허용 목록 — 허브의 BATCHABLE_EDIT_TOOL_NAMES(스키마 enum)와 스튜디오
// dispatch 게이트가 어긋나면 허브 검증을 통과한 항목이 스튜디오에서 거부되거나 그 반대가
// 된다. 허브가 아는 모든 도구 이름을 실제 실행기에 한 항목씩 넣어 게이트가 받아들이는
// 이름을 모은다.
test('apply_edits 게이트가 받아들이는 도구가 허브 허용 목록과 일치한다', async () => {
  const accepted: string[] = [];
  for (const tool of hubTools) {
    const h = makeEnv(['본문']);
    const message = await h.call('apply_edits', { edits: [{ tool }] }).then(
      () => '',
      (error: Error) => error.message,
    );
    if (!/tool must be one of/.test(message)) accepted.push(tool);
  }
  assert.ok(BATCHABLE_EDIT_TOOL_NAMES.length > 0, 'tools.mjs에서 배치 허용 목록을 찾지 못함');
  assert.deepEqual(accepted, sorted(BATCHABLE_EDIT_TOOL_NAMES));
});

test('read_batch 게이트가 받아들이는 도구가 허브 허용 목록과 일치한다', async () => {
  const h = makeEnv(['본문']);
  const accepted: string[] = [];
  // read_batch 는 한 번에 16개까지 받는다.
  for (let start = 0; start < hubTools.length; start += 16) {
    const chunk = hubTools.slice(start, start + 16);
    const batch = await h.call('read_batch', { reads: chunk.map((tool) => ({ tool })) });
    const results = batch['results'] as Array<{ error?: { message: string } }>;
    chunk.forEach((tool, i) => {
      if (!/read item tool must be one of/.test(results[i].error?.message ?? '')) accepted.push(tool);
    });
  }
  assert.ok(BATCHABLE_READ_TOOL_NAMES.length > 0, 'tools.mjs에서 read_batch 허용 목록을 찾지 못함');
  assert.deepEqual(accepted, sorted(BATCHABLE_READ_TOOL_NAMES));
});

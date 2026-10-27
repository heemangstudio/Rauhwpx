// 문제 보고의 대화 기록에 실패 알림의 제목뿐 아니라 실제 프로바이더 문구가 실리는지.
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatThreadTranscript } from '../src/ui/issue-report/transcript.ts';
import type { ThreadFailureMessage } from '../src/agent/threads.ts';

test('a failure line in the report carries the provider text behind the notice title', () => {
  const error: ThreadFailureMessage = {
    role: 'system',
    kind: 'error',
    text: 'Codex 서버가 요청을 처리하지 못했어요',
    agent: 'codex',
    failure: {
      class: 'provider_error', agent: 'codex', code: null, retryable: true, resetAt: null,
      message: 'unexpected status 502 Bad Gateway',
    },
    origin: 'turn',
    at: 0,
  };
  const transcript = formatThreadTranscript({ title: '대화', agent: 'codex', model: 'sol', messages: [error] });
  assert.match(transcript, /\[오류\] Codex 서버가 요청을 처리하지 못했어요 — unexpected status 502 Bad Gateway/);
});

// 도구 호출 단계별 타이밍 추적 — RHWP_TOOL_TRACE=1 일 때만 켠다.
//
// 꺼져 있으면 허브는 추적 필드를 싣지 않고, mcp-stdio 와 스튜디오는 그 필드가 없으면
// 아무것도 기록하지 않는다. 켜면 허브가 JSONL 한 줄씩 남긴다 (RHWP_TOOL_TRACE_FILE,
// 기본은 작업 루트의 tool-trace.jsonl). 시각은 모두 epoch ms (performance.timeOrigin 기준,
// 소수점 셋째 자리) 라 같은 기계의 허브·mcp-stdio·브라우저 행을 한 시간축에 놓을 수 있다.
// 문서 내용과 인자 값은 기록하지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const TOOL_TRACE_ENABLED = process.env.RHWP_TOOL_TRACE === '1';

export const TOOL_TRACE_FILE = 'tool-trace.jsonl';

/** epoch ms, µs 정밀도. */
export function traceNow() {
  return Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
}

let stream = null;

/** 추적 파일 위치를 정한다. RHWP_TOOL_TRACE_FILE 이 있으면 그걸 쓴다. */
export function configureToolTrace(defaultDir) {
  if (!TOOL_TRACE_ENABLED || stream) return null;
  const file = process.env.RHWP_TOOL_TRACE_FILE || path.join(defaultDir, TOOL_TRACE_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  stream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
  stream.on('error', () => { stream = null; });
  return file;
}

/** 행 하나를 덧붙인다. 추적이 꺼져 있거나 파일이 없으면 버린다. */
export function writeToolTrace(row) {
  if (!TOOL_TRACE_ENABLED || !stream) return;
  try {
    stream.write(`${JSON.stringify(row)}\n`);
  } catch {
    // 추적 실패가 도구 호출을 막으면 안 된다.
  }
}

const FINITE_KEYS = /^[A-Za-z][A-Za-z0-9]{0,31}$/;

/** 원격(mcp-stdio·스튜디오)이 보낸 추적 객체에서 숫자·짧은 문자열 필드만 남긴다. */
export function sanitizeTraceFields(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw).slice(0, 32)) {
    if (!FINITE_KEYS.test(key)) continue;
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'string' && value.length <= 128) out[key] = value;
    else if (typeof value === 'boolean') out[key] = value;
  }
  return out;
}

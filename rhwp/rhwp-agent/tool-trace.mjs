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
import { createHash } from 'node:crypto';

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

/** 원본 provider JSON 인자를 값 노출 없이 연결한다. JSON 외 값은 받지 않는다. */
export function browserEvidenceArgsHash(value) {
  try {
    const canonical = input => {
      if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
      if (typeof input === 'number' && Number.isFinite(input)) return input;
      if (Array.isArray(input)) return input.map(canonical);
      if (input && Object.getPrototypeOf(input) === Object.prototype) {
        return Object.fromEntries(Object.keys(input).sort().map(key => [key, canonical(input[key])]));
      }
      throw new Error('Not JSON');
    };
    return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  } catch { return null; }
}

const ELEMENT_STRINGS = ['ref', 'tag', 'role', 'inputType', 'autocomplete', 'name', 'text', 'value', 'href', 'formMethod', 'formAction'];
const ELEMENT_BOOLEANS = ['sensitive', 'disabled', 'inViewport', 'checked', 'formSensitive'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const epoch = value => Number.isSafeInteger(value) && value >= 0;
const identityString = value => typeof value === 'string' && value.length > 0 && value.length <= 1024;
function selectedFields(source, fields, valid) {
  return Object.fromEntries(fields.filter(key => valid(source?.[key])).map(key => [key, source[key]]));
}
function evidenceSnapshot(raw) {
  if (!object(raw) || !identityString(raw.snapshotId) || !identityString(raw.tabId)
    || !epoch(raw.navigationEpoch) || !epoch(raw.controllerEpoch)
    || !['url', 'title', 'text'].every(key => typeof raw[key] === 'string')
    || !Array.isArray(raw.elements) || typeof raw.truncated !== 'boolean') throw new Error('Invalid snapshot');
  const snapshot = { snapshotId: raw.snapshotId, tabId: raw.tabId, navigationEpoch: raw.navigationEpoch,
    controllerEpoch: raw.controllerEpoch, url: raw.url, title: raw.title, text: raw.text,
    ...selectedFields(raw, ['selectedText'], value => typeof value === 'string'),
    truncated: raw.truncated, ...selectedFields(raw, ['compact'], value => typeof value === 'boolean') };
  snapshot.elements = raw.elements.map(element => {
    if (!object(element) || !identityString(element.ref)) throw new Error('Invalid element');
    const out = { ...selectedFields(element, ELEMENT_STRINGS, value => typeof value === 'string'),
      ...selectedFields(element, ELEMENT_BOOLEANS, value => typeof value === 'boolean') };
    if (object(element.rect) && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(element.rect[key]))) {
      out.rect = selectedFields(element.rect, ['x', 'y', 'width', 'height'], Number.isFinite);
    }
    return out;
  });
  return snapshot;
}

/** 이미 마스킹되어 provider 에게 전달된 스냅샷만 별도 JSONL 로 보관한다.
 * 동기 쓰기로 턴 종료 후 읽기와 경쟁하지 않는다. 실패는 도구 실행에 전파하지 않는다.
 */
export function createBrowserEvidenceWriter(file, { maxSnapshotBytes = 4 * 1024 * 1024, maxTotalBytes = 64 * 1024 * 1024 } = {}) {
  let fd = null, total = 0, closed = false, failed = false, captureStopped = false;
  const disabled = !file;
  const limitsValid = [maxSnapshotBytes, maxTotalBytes].every(value => Number.isSafeInteger(value) && value > 0);
  // 최대 1024자 식별자 8개가 모두 JSON escape 되어도 마지막 오류 행은 64 KiB 이하다.
  const errorReserve = 64 * 1024;
  function append(row, reserve = 0) {
    if (!limitsValid || closed || failed) return { status: 'error', code: 'writer-unavailable' };
    try {
      const bytes = Buffer.from(`${JSON.stringify(row)}\n`);
      if (total + bytes.length + reserve > maxTotalBytes) return { status: 'error', code: 'total-limit' };
      if (fd === null) {
        if (typeof fs.constants.O_NOFOLLOW !== 'number') throw new Error('No no-follow support');
        fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
        if (!fs.fstatSync(fd).isFile()) throw new Error('Not a regular file');
      }
      for (let offset = 0; offset < bytes.length;) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
        if (written <= 0) throw new Error('Incomplete evidence write');
        offset += written;
      }
      total += bytes.length;
      return { status: 'written' };
    } catch {
      failed = true;
      if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; }
      return { status: 'error', code: 'write-failed' };
    }
  }
  function write(row) {
    if (disabled) return { status: 'skipped', code: 'disabled' };
    if (captureStopped) return { status: 'error', code: 'capture-stopped' };
    try {
      if (row?.delivered !== true || row.result?.ok !== true || !object(row.result.snapshot)) return { status: 'skipped' };
      const actor = row.actor;
      if (!object(actor) || actor.isHuman !== false || actor.taskId != null
        || !identityString(actor.agentId) || !actor.agentId.endsWith(':root') || !identityString(actor.sessionId)) return { status: 'skipped', code: 'foreign-actor' };
      const base = { schema: 1, kind: 'browser-snapshot', t: traceNow(),
        actor: { sessionId: actor.sessionId, threadId: identityString(actor.threadId) ? actor.threadId : null,
          documentId: identityString(actor.documentId) ? actor.documentId : null, agentId: actor.agentId, taskId: null, isHuman: false },
        callId: identityString(row.callId) ? row.callId : null,
        argsHash: typeof row.argsHash === 'string' && /^[a-f0-9]{64}$/.test(row.argsHash) ? row.argsHash : null,
        tool: identityString(row.tool) ? row.tool : null,
        hub: { ...selectedFields(row.hub, ['seq'], value => epoch(value) && value > 0),
          ...selectedFields(row.hub, ['clientId'], epoch), ...selectedFields(row.hub, ['turnId', 'agent'], identityString) },
        args: { ...selectedFields(row.args, ['tabId', 'snapshotId', 'ref'], identityString),
          ...selectedFields(row.args, ['navigationEpoch', 'controllerEpoch'], epoch) } };
      const captureError = code => {
        const recorded = append({ ...base, args: {}, kind: 'browser-snapshot-capture-error', code });
        captureStopped = true;
        return { status: 'error', code, recorded: recorded.status === 'written' };
      };
      if (!base.callId || !base.argsHash || !base.tool) return captureError('missing-call-identity');
      let snapshot;
      try { snapshot = evidenceSnapshot(row.result.snapshot); } catch { return captureError('invalid-snapshot'); }
      if (Buffer.byteLength(JSON.stringify(snapshot)) > maxSnapshotBytes) return captureError('snapshot-limit');
      const result = append({ ...base, snapshot }, errorReserve);
      return result.code === 'total-limit' ? captureError('total-limit') : result;
    } catch { return { status: 'error', code: 'invalid-evidence' }; }
  }
  function close() {
    closed = true;
    if (fd !== null) { try { fs.closeSync(fd); } catch {} fd = null; }
  }
  return { write, close };
}

let browserEvidenceWriter;
export function writeBrowserEvidence(row) {
  const file = process.env.RHWP_BROWSER_BENCH_EVIDENCE_FILE;
  if (!file) return { status: 'skipped', code: 'disabled' };
  try {
    browserEvidenceWriter ??= createBrowserEvidenceWriter(file);
    return browserEvidenceWriter.write(row);
  } catch { return { status: 'error', code: 'writer-unavailable' }; }
}

// MCP 서버(mcp-stdio, 허브의 /mcp-http)가 허브의 /mcp 프로토콜로 도구를 부르는 클라이언트.
// 연결 수단만 다르다 — mcp-stdio 는 실제 WebSocket, 허브 내 HTTP 서버는 같은 프로세스의 가상 소켓.
// 호출 id·타임아웃·동시 호출 상한·끊김 처리·추적 보고는 여기 한 곳에서 같은 규칙으로 처리한다.
import { performance } from 'node:perf_hooks';

export const CONNECT_TIMEOUT_MS = 5_000;
export const CALL_TIMEOUT_MS = 180_000;
export const MAX_INFLIGHT_CALLS = 64;
const HUMAN_WAIT_TOOLS = new Set(['ask_user_question', 'detach_document']);
const SOCKET_OPEN = 1;

/** epoch ms (µs 정밀도) — 허브의 도구 추적(tool-trace.mjs)과 같은 시간축. */
export function traceNow() {
  return Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
}

export function hubError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const hubUnavailable = () => hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)');

/**
 * @param {{
 *   openSocket: () => any,
 *   workflow: string,
 *   capabilityEpoch?: string | null,
 *   log: (message: string) => void,
 *   onConnected?: () => void,
 * }} options
 * openSocket 은 WebSocket 처럼 open/message/error/close 이벤트와 send/terminate 를 가진 소켓을 돌려준다.
 */
export function createHubToolClient({ openSocket, workflow, capabilityEpoch = null, log, onConnected }) {
  /** @type {any} */
  let ws = null;
  /** @type {Promise<any> | null} */
  let connecting = null;
  let nextId = 1;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: any) => void, timer: NodeJS.Timeout | null, timing: any }>} */
  const inflight = new Map();

  function failAllInflight(err) {
    for (const [, entry] of inflight) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    inflight.clear();
  }

  function ensureConnected() {
    if (ws && ws.readyState === SOCKET_OPEN) return Promise.resolve(ws);
    if (connecting) return connecting;
    connecting = new Promise((resolve, reject) => {
      let sock;
      try {
        sock = openSocket();
      } catch (e) {
        connecting = null;
        reject(e?.code ? e : hubUnavailable());
        return;
      }
      const openTimer = setTimeout(() => {
        try { sock.terminate(); } catch {}
        connecting = null;
        reject(hubUnavailable());
      }, CONNECT_TIMEOUT_MS);

      sock.on('open', () => {
        clearTimeout(openTimer);
        ws = sock;
        connecting = null;
        onConnected?.();
        resolve(sock);
      });
      sock.on('message', (data) => {
        const receivedAt = traceNow();
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          log('ignoring unparseable hub frame');
          return;
        }
        if (msg?.type === 'tool-result') {
          const entry = inflight.get(msg.id);
          if (!entry) return;
          inflight.delete(msg.id);
          if (entry.timer) clearTimeout(entry.timer);
          // 허브가 추적 중일 때만 결과 프레임에 trace 가 붙는다.
          if (msg.trace && entry.timing) {
            entry.timing.wsRecv = receivedAt;
            entry.timing.parsed = traceNow();
            entry.timing.seq = msg.trace.seq;
            entry.timing.resultBytes = data.length ?? 0;
          }
          if (msg.ok) entry.resolve(msg.result);
          else entry.reject(hubError(msg.error?.code ?? 'RPC_ERROR', msg.error?.message ?? 'unknown hub error'));
        } else if (msg?.type === 'protocol-error') {
          log(`hub protocol error: ${msg.message}`);
        }
      });
      sock.on('error', (err) => {
        clearTimeout(openTimer);
        log(`ws error: ${err?.message ?? err}`);
        if (connecting) {
          connecting = null;
          reject(hubUnavailable());
        }
      });
      sock.on('close', () => {
        clearTimeout(openTimer);
        if (connecting && ws !== sock) {
          connecting = null;
          reject(hubUnavailable());
        }
        // 대체된 옛 소켓의 close 가 현재 연결의 in-flight 호출을 죽이면 안 된다.
        if (ws !== sock) return;
        ws = null;
        failAllInflight(hubError('HUB_UNAVAILABLE', 'connection to rhwp-agent hub was closed'));
      });
    });
    return connecting;
  }

  async function callHub(tool, args, timing = null) {
    const sock = await ensureConnected();
    if (timing) timing.connected = traceNow();
    if (inflight.size >= MAX_INFLIGHT_CALLS) {
      throw hubError('TOO_MANY_INFLIGHT_CALLS', `At most ${MAX_INFLIGHT_CALLS} tool calls may be in flight`);
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      // Human input is hub-owned and lives until answered, cancelled, or its provider
      // connection disappears. Applying the ordinary MCP timeout would turn a normal
      // pause into a false tool failure. Detaching may wait on the save dialog of a
      // never-saved document; the hub bounds that wait.
      const timer = HUMAN_WAIT_TOOLS.has(tool)
        ? null
        : setTimeout(() => {
          inflight.delete(id);
          reject(hubError('TOOL_TIMEOUT', 'The hub did not respond within 180s; if this was a document edit, re-read before retrying to avoid duplicates'));
        }, CALL_TIMEOUT_MS);
      inflight.set(id, { resolve, reject, timer, timing });
      if (timing) timing.clientId = id;
      try {
        sock.send(JSON.stringify({
          v: 5,
          type: 'tool-call',
          id,
          tool,
          args,
          workflow,
          ...(capabilityEpoch ? { capabilityEpoch } : {}),
        }));
        if (timing) timing.wsSend = traceNow();
      } catch (e) {
        inflight.delete(id);
        if (timer) clearTimeout(timer);
        reject(hubError('HUB_UNAVAILABLE', `failed to send to hub: ${e?.message ?? e}`));
      }
    });
  }

  /**
   * 허브가 추적 중이면(결과 프레임에 trace.seq) 이 구간 타이밍을 허브로 돌려보낸다.
   * CLI 응답을 늦추지 않도록 결과를 반환한 다음 틱에 보낸다.
   */
  function reportTiming(timing, extra) {
    if (!timing?.seq) return;
    timing.mcpOut = traceNow();
    const meta = extra?._meta;
    const toolUseId = meta && typeof meta['claudecode/toolUseId'] === 'string' ? meta['claudecode/toolUseId'] : null;
    const trace = {
      ...timing,
      rpcId: typeof extra?.requestId === 'number' || typeof extra?.requestId === 'string' ? extra.requestId : null,
      ...(toolUseId ? { toolUseId } : {}),
    };
    setImmediate(() => {
      try {
        if (ws && ws.readyState === SOCKET_OPEN) ws.send(JSON.stringify({ v: 5, type: 'tool-trace', trace }));
      } catch {}
    });
  }

  /** 남은 호출을 실패시키고 연결을 끊는다. */
  function close(err = hubError('HUB_UNAVAILABLE', 'mcp server is shutting down')) {
    failAllInflight(err);
    const sock = ws;
    ws = null;
    try { sock?.terminate(); } catch {}
  }

  return {
    ensureConnected,
    callHub,
    reportTiming,
    close,
    inflightCount: () => inflight.size,
  };
}

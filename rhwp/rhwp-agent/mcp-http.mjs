// 허브가 직접 여는 rhwp MCP 서버 (Streamable HTTP, POST/GET/DELETE /mcp-http).
//
// Claude·Codex 는 턴마다 새 프로세스로 뜬다. 예전에는 프로세스마다 Node 로 mcp-stdio 를 띄워
// (약 90 MB, 도구 목록까지 약 0.3 초) 허브 /mcp WebSocket 으로 프레임을 옮겼다. 이제 CLI 가
// 이 엔드포인트에 바로 붙는다. MCP 세션 하나가 mcp-stdio 프로세스 하나에 해당한다: 같은
// 도구 등록(mcp-tool-server.mjs)과 같은 허브 클라이언트(hub-tool-client.mjs)를 쓰고, 허브와는
// 같은 프로세스 안의 가상 소켓으로 /mcp 와 똑같은 프레임을 주고받는다. 그래서 신원 확인, 턴
// 묶기, revision 검사, 사용자 질문 대기, 끊김 처리 같은 허브 쪽 규칙이 그대로 적용된다.
import { EventEmitter } from 'node:events';
import { randomUUID, timingSafeEqual } from 'node:crypto';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createHubToolClient } from './hub-tool-client.mjs';
import {
  createRhwpMcpServer,
  guardDocumentIdArgs,
  mcpConnectionParams,
  visibleToolDefinitions,
} from './mcp-tool-server.mjs';

export const MCP_HTTP_PATH = '/mcp-http';
/** 도구 인자 상한 — /mcp WebSocket 의 provider 프레임 상한과 같다. */
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
/** 결과 프레임 상한 — mcp-stdio 가 알리던 maxPayload 와 같아 RESULT_TOO_LARGE 판정이 같다. */
const MAX_RESULT_FRAME_BYTES = 8 * 1024 * 1024;
/**
 * Claude·Codex 는 세션이 살아 있는 동안 GET 스트림을 열어 둔다. Claude 는 끝날 때 DELETE 를
 * 보내지 않으므로, 그 스트림이 닫히고 다른 요청도 없으면 프로세스가 끝난 것으로 보고 이 유예 뒤에
 * 세션을 지운다 (끊긴 스트림을 다시 여는 클라이언트는 그 사이에 돌아온다).
 */
export const MCP_HTTP_STREAM_GRACE_MS = 60 * 1000;
/**
 * GET 스트림을 연 적 없는 세션은 열린 요청 없이 이 시간이 지나면 지운다.
 * 쉬는 provider 프로세스를 내리는 시간(IDLE_PROCESS_RELEASE_MS, 10분)보다 길게 잡는다.
 */
export const MCP_HTTP_IDLE_TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
// 어댑터가 쿼리로 넘기는 MCP 설정(mcpCapabilityEnv)만 받는다. 토큰은 Authorization 헤더로만 받는다.
const PARAM_KEY = /^RHWP_[A-Z_]+$/;
const SECRET_PARAM_KEY = /TOKEN|SECRET|KEY/;

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

/**
 * 같은 프로세스 안의 WebSocket 짝. 허브 쪽 끝은 ws 의 WebSocket 처럼 보인다 (readyState·OPEN·
 * send·close·terminate, message/close 이벤트). 보낸 프레임은 순서대로, 닫힘보다 먼저 도착한다.
 */
class VirtualSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = CONNECTING;
    /** @type {VirtualSocket | null} */
    this.peer = null;
  }

  get OPEN() { return OPEN; }

  send(data) {
    if (this.readyState !== OPEN) throw new Error(`WebSocket is not open: readyState ${this.readyState}`);
    const peer = this.peer;
    const frame = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    queueMicrotask(() => peer.emit('message', frame, false));
  }

  close(code = 1000, reason = '') {
    closePair(this, code, reason);
  }

  terminate() {
    closePair(this, 1006, '');
  }
}

function closePair(sock, code, reason) {
  const peer = sock.peer;
  if (sock.readyState === CLOSED) return;
  const wasOpen = sock.readyState === OPEN;
  sock.readyState = CLOSED;
  peer.readyState = CLOSED;
  if (!wasOpen) return;
  // ws 처럼 close 이벤트는 비동기다. 이미 보낸 프레임(마이크로태스크)이 먼저 도착한다.
  setImmediate(() => {
    sock.emit('close', code, Buffer.from(String(reason)));
    peer.emit('close', code, Buffer.from(String(reason)));
  });
}

function socketPair() {
  const client = new VirtualSocket();
  const hub = new VirtualSocket();
  client.peer = hub;
  hub.peer = client;
  return { client, hub };
}

function bearerToken(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

function sameToken(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function jsonRpcError(res, status, code, message) {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }));
}

async function readJsonBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    const error = new Error('request body too large');
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Parse error: invalid JSON');
    error.status = 400;
    error.rpcCode = -32700;
    throw error;
  }
}

function isInitializeMessage(body) {
  const messages = Array.isArray(body) ? body : [body];
  return messages.some((message) => message?.method === 'initialize');
}

/** 쿼리의 RHWP_* 설정을 mcp-stdio 의 환경 변수와 같은 모양으로 꺼낸다. */
export function mcpHttpParamsFromUrl(url) {
  const env = {};
  for (const [key, value] of url.searchParams) {
    if (PARAM_KEY.test(key) && !SECRET_PARAM_KEY.test(key)) env[key] = value;
  }
  return env;
}

/**
 * @param {{
 *   acceptSocket: (identity: {
 *     token: string, sessionId: string | null, agent: string, role: string,
 *     workerJobId: string | null, workflow: string, capabilityEpoch: string | null,
 *     maxPayload: number,
 *   }, hubSocket: VirtualSocket) => void,
 *   log: (message: string) => void,
 *   idleTtlMs?: number,
 *   now?: () => number,
 * }} options
 * acceptSocket 은 /mcp WebSocket 업그레이드와 같은 인증을 하고 허브 쪽 소켓을 붙인다. 거절하면 던진다.
 */
export function createMcpHttpEndpoint({
  acceptSocket,
  log,
  idleTtlMs = MCP_HTTP_IDLE_TTL_MS,
  streamGraceMs = MCP_HTTP_STREAM_GRACE_MS,
  now = Date.now,
}) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  let sweepTimer = null;

  function ensureSweep() {
    if (sweepTimer) return;
    sweepTimer = setInterval(sweepIdleSessions, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  function sweepIdleSessions() {
    for (const session of sessions.values()) {
      const ttl = session.hadStream ? streamGraceMs : idleTtlMs;
      if (session.openRequests === 0 && session.hub.inflightCount() === 0 && session.lastActivity <= now() - ttl) {
        disposeSession(session, session.hadStream ? 'client gone' : 'idle');
      }
    }
    if (sessions.size === 0 && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function disposeSession(session, reason) {
    if (session.disposed) return;
    session.disposed = true;
    if (session.goneTimer) clearTimeout(session.goneTimer);
    if (session.id) sessions.delete(session.id);
    session.hub.close();
    void session.server.close().catch(() => {});
    log(`mcp http session closed (agent=${session.params.agentName}, session=${session.params.sessionId ?? 'missing'}, reason=${reason})`);
  }

  async function createSession(token, url) {
    const params = mcpConnectionParams(mcpHttpParamsFromUrl(url), { token });
    const identity = {
      token,
      sessionId: params.sessionId,
      agent: params.agentName,
      role: params.agentRole,
      workerJobId: params.copyLayoutJobId,
      workflow: params.workflow,
      capabilityEpoch: params.capabilityEpoch ?? null,
      maxPayload: MAX_RESULT_FRAME_BYTES,
    };
    const hub = createHubToolClient({
      openSocket() {
        const pair = socketPair();
        pair.client.readyState = OPEN;
        pair.hub.readyState = OPEN;
        try {
          acceptSocket(identity, pair.hub);
        } catch (error) {
          pair.client.readyState = CLOSED;
          pair.hub.readyState = CLOSED;
          throw error;
        }
        setImmediate(() => pair.client.emit('open'));
        return pair.client;
      },
      workflow: params.workflow,
      capabilityEpoch: params.capabilityEpoch,
      log: (message) => log(`[mcp-http] ${message}`),
    });
    // mcp-stdio 처럼 시작하자마자 허브에 붙는다. 신원이 틀린 클라이언트는 여기서 401 을 받는다.
    await hub.ensureConnected();
    const visibleTools = visibleToolDefinitions(params);
    const server = createRhwpMcpServer({
      visibleTools,
      imageRoots: params.imageRoots,
      callHub: hub.callHub,
      reportTiming: hub.reportTiming,
    });
    const session = {
      id: null,
      token,
      params,
      hub,
      server,
      transport: null,
      openRequests: 0,
      lastActivity: now(),
      hadStream: false,
      goneTimer: null,
      disposed: false,
    };
    session.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      onsessioninitialized: (id) => {
        session.id = id;
        sessions.set(id, session);
        ensureSweep();
      },
      onsessionclosed: () => {
        setImmediate(() => disposeSession(session, 'client closed'));
      },
    });
    await server.connect(session.transport);
    guardDocumentIdArgs(session.transport, visibleTools, (message) => log(`[mcp-http] ${message}`));
    server.server.onclose = () => disposeSession(session, 'transport closed');
    log(`mcp http session started (agent=${params.agentName}, session=${params.sessionId ?? 'missing'}, workflow=${params.workflow}, profile=${params.toolProfile}, epoch=${params.capabilityEpoch ?? 'legacy'})`);
    return session;
  }

  function track(session, req, res) {
    session.openRequests += 1;
    session.lastActivity = now();
    if (req.method === 'GET') session.hadStream = true;
    if (session.goneTimer) {
      clearTimeout(session.goneTimer);
      session.goneTimer = null;
    }
    res.once('close', () => {
      session.openRequests -= 1;
      session.lastActivity = now();
      if (!session.hadStream || session.openRequests > 0 || session.disposed) return;
      // 스트림까지 닫혔다 — CLI 프로세스가 끝났을 가능성이 크다. 돌아오지 않으면 유예 뒤에 지운다.
      session.goneTimer = setTimeout(() => {
        session.goneTimer = null;
        if (session.openRequests === 0 && session.hub.inflightCount() === 0) disposeSession(session, 'client gone');
      }, streamGraceMs);
      session.goneTimer.unref?.();
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL} url
   */
  async function handle(req, res, url) {
    // 브라우저 페이지는 이 엔드포인트를 쓸 일이 없다 (/mcp WebSocket 과 같은 규칙).
    if (req.headers.origin) {
      jsonRpcError(res, 403, -32000, 'Forbidden');
      return;
    }
    const token = bearerToken(req);
    if (!token) {
      jsonRpcError(res, 401, -32000, 'Unauthorized');
      return;
    }
    const sessionHeader = req.headers['mcp-session-id'];
    if (typeof sessionHeader === 'string' && sessionHeader) {
      const session = sessions.get(sessionHeader);
      if (!session || session.disposed) {
        jsonRpcError(res, 404, -32001, 'Session not found');
        return;
      }
      if (!sameToken(session.token, token)) {
        jsonRpcError(res, 401, -32000, 'Unauthorized');
        return;
      }
      let body;
      if (req.method === 'POST') {
        try {
          body = await readJsonBody(req);
        } catch (error) {
          jsonRpcError(res, error.status ?? 400, error.rpcCode ?? -32000, error.message);
          return;
        }
      }
      track(session, req, res);
      await session.transport.handleRequest(req, res, body);
      return;
    }
    if (req.method !== 'POST') {
      jsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      jsonRpcError(res, error.status ?? 400, error.rpcCode ?? -32000, error.message);
      return;
    }
    if (!isInitializeMessage(body)) {
      jsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
      return;
    }
    let session;
    try {
      session = await createSession(token, url);
    } catch (error) {
      log(`[mcp-http] connection refused (agent=${url.searchParams.get('RHWP_AGENT_NAME') ?? 'unknown'}): ${error?.message ?? error}`);
      jsonRpcError(res, 401, -32000, 'Unauthorized');
      return;
    }
    track(session, req, res);
    await session.transport.handleRequest(req, res, body);
    // initialize 가 실패해 세션 id 가 생기지 않았으면 남길 것이 없다.
    if (!session.id) disposeSession(session, 'initialize failed');
  }

  /** 허브 세션이 닫힐 때 그 세션의 MCP 연결을 모두 닫는다. */
  function closeSessionsFor(hubSessionId, reason = 'hub session closed') {
    for (const session of [...sessions.values()]) {
      if (session.params.sessionId === hubSessionId) disposeSession(session, reason);
    }
  }

  function closeAll(reason = 'hub shutting down') {
    for (const session of [...sessions.values()]) disposeSession(session, reason);
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  return {
    handle,
    closeSessionsFor,
    closeAll,
    sweepIdleSessions,
    sessionCount: () => sessions.size,
  };
}

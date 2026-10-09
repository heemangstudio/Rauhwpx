import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import {
  HUB_CAPABILITY_AUDIENCES,
  resolveHubIdentity,
  sessionIdFromScopedHubToken,
} from './hub-session-registry.mjs';
import {
  RHWP_TOOL_RULES,
  filterToolDefinitions,
  projectToolGatesFromEnv,
  toToolContent,
  toolAnnotations,
} from './tools.mjs';
import { imageRootsFromEnv } from './image-path-policy.mjs';
import { prepareInsertImageArgs } from './insert-image-source.mjs';

const WS_URL = process.env.RHWP_WS_URL ?? 'ws://127.0.0.1:5175/mcp';
const { token: TOKEN, development: DEVELOPMENT_AUTH } = resolveHubIdentity();
const SESSION_ID = process.env.RHWP_SESSION_ID
  ?? sessionIdFromScopedHubToken(TOKEN, { audience: HUB_CAPABILITY_AUDIENCES.MCP })
  ?? sessionIdFromScopedHubToken(TOKEN, { audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER })
  ?? (DEVELOPMENT_AUTH ? 'dev' : null);
const AGENT_NAME = process.env.RHWP_AGENT_NAME ?? 'unknown';
const AGENT_ROLE = process.env.RHWP_AGENT_ROLE ?? 'chat';
const COPY_LAYOUT_JOB_ID = /^copy-layout-worker:([^:]+):[A-Za-z0-9_-]+$/.exec(AGENT_ROLE)?.[1] ?? null;
const WORKFLOW = process.env.RHWP_AGENT_WORKFLOW ?? process.env.RHWP_WORKFLOW ?? 'direct';
const PHASE = process.env.RHWP_AGENT_PHASE ?? process.env.RHWP_PLAN_PHASE
  ?? (WORKFLOW === 'plan' ? 'planning' : WORKFLOW === 'question' ? 'questioning' : 'implementing');
const CAPABILITY_EPOCH = process.env.RHWP_CAPABILITY_EPOCH;
const TOOL_PROFILE = process.env.RHWP_TOOL_PROFILE
  ?? (WORKFLOW === 'direct' ? 'direct' : PHASE === 'questioning' ? 'question' : PHASE);
const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 180_000;
const MAX_PROVIDER_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_INFLIGHT_CALLS = 64;

// insert_image 가 읽을 수 있는 루트 디렉터리(세션 작업 공간·다운로드 등).
// 어댑터가 루트를 넘겨주면 그 밖의 절대경로 읽기는 전부 거부한다.
const IMAGE_ALLOWED_ROOTS = imageRootsFromEnv(process.env);

/** epoch ms (µs 정밀도) — 허브의 도구 추적(tool-trace.mjs)과 같은 시간축. */
function traceNow() {
  return Math.round((performance.timeOrigin + performance.now()) * 1000) / 1000;
}

function log(msg) {
  process.stderr.write(`[rhwp-mcp] ${msg}\n`);
}

function safeHubEndpoint(raw) {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '<invalid hub URL>';
  }
}

const LOG_WS_ENDPOINT = safeHubEndpoint(WS_URL);

function hubError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** @type {WebSocket | null} */
let ws = null;
/** @type {Promise<WebSocket> | null} */
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
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws);
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    let sock;
    try {
      if (!SESSION_ID) throw hubError('SESSION_REQUIRED', 'RHWP_SESSION_ID or a session-scoped hub token is required');
      const url = new URL(WS_URL);
      url.searchParams.set('token', TOKEN);
      url.searchParams.set('sessionId', SESSION_ID);
      url.searchParams.set('agent', AGENT_NAME);
      url.searchParams.set('role', AGENT_ROLE);
      if (COPY_LAYOUT_JOB_ID) url.searchParams.set('workerJobId', COPY_LAYOUT_JOB_ID);
      url.searchParams.set('workflow', WORKFLOW);
      if (CAPABILITY_EPOCH) url.searchParams.set('capabilityEpoch', CAPABILITY_EPOCH);
      // 허브가 이보다 큰 결과를 보내면 소켓이 1009 로 끊기므로 미리 알려 RESULT_TOO_LARGE 로 받는다.
      url.searchParams.set('maxPayload', String(MAX_PROVIDER_FRAME_BYTES));
      sock = new WebSocket(url, { maxPayload: MAX_PROVIDER_FRAME_BYTES });
    } catch (e) {
      connecting = null;
      reject(e?.code ? e : hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
      return;
    }
    const openTimer = setTimeout(() => {
      try { sock.terminate(); } catch {}
      connecting = null;
      reject(hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
    }, CONNECT_TIMEOUT_MS);

    sock.on('open', () => {
      clearTimeout(openTimer);
      ws = sock;
      connecting = null;
      log(`connected to hub at ${LOG_WS_ENDPOINT}`);
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
        reject(hubError('HUB_UNAVAILABLE', 'rhwp-agent hub is not running (node server.mjs)'));
      }
    });
    sock.on('close', () => {
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
    // pause into a false tool failure.
    const timer = tool === 'ask_user_question'
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
        workflow: WORKFLOW,
        ...(CAPABILITY_EPOCH ? { capabilityEpoch: CAPABILITY_EPOCH } : {}),
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
 * 허브가 추적 중이면(결과 프레임에 trace.seq) 이 프로세스 구간 타이밍을 허브로 돌려보낸다.
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
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ v: 5, type: 'tool-trace', trace }));
    } catch {}
  });
}

// 공유 규칙(revision·스테이징·셀 주소·오프셋·단위)은 도구 설명마다 반복하지 않고
// 서버 instructions 로 한 번만 보낸다. provider 브리프(agents/backend.mjs)도 같은 텍스트를 싣는다.
const server = new McpServer({ name: 'rhwp', version: '0.1.0' }, { instructions: RHWP_TOOL_RULES });

function registerTool(def) {
  server.registerTool(def.name, {
    description: def.description,
    inputSchema: def.shape,
    annotations: toolAnnotations(def.category),
    _meta: { 'rhwp/toolCategory': def.category },
  }, async (args, extra) => {
    const timing = { tool: def.name, mcpIn: traceNow() };
    try {
      def.validate?.(args ?? {});
      const result = await callHub(def.name, args ?? {}, timing);
      const content = toToolContent(result);
      reportTiming(timing, extra);
      return { content };
    } catch (e) {
      reportTiming(timing, extra);
      return { content: [{ type: 'text', text: `${e.code ?? 'RPC_ERROR'}: ${e.message}` }], isError: true };
    }
  });
}

// 도구 정의는 tools.mjs 가 단일 소스 — 테스트가 같은 정의를 임포트해 계약을 검증한다.
// 프로젝트 쓰기(채팅 설정)와 홈 폴더 검색(데스크톱)은 허브가 넣은 환경으로 등록을 가른다. 허브도 호출마다 다시 검사한다.
const visibleTools = filterToolDefinitions(TOOL_PROFILE, projectToolGatesFromEnv(process.env));
for (const def of visibleTools) {
  // insert_image 만 파일 읽기가 필요해 아래 커스텀 핸들러로 등록한다.
  if (def.name === 'insert_image') registerInsertImageTool(def);
  else registerTool(def);
}

// ─── 이미지 삽입 — 파일은 이 프로세스(로컬)가 읽어 base64 로 전달한다 ───

// insert_image 만 커스텀 등록 — description/shape 는 tools.mjs 정의를 그대로 쓴다.

function registerInsertImageTool(def) {
  server.registerTool(
    def.name,
    {
      description: def.description,
      inputSchema: def.shape,
      annotations: toolAnnotations(def.category),
      _meta: { 'rhwp/toolCategory': def.category },
    },
    async (args, extra) => {
      const timing = { tool: def.name, mcpIn: traceNow() };
      try {
        const payload = await prepareInsertImageArgs(args, IMAGE_ALLOWED_ROOTS);
        const result = await callHub('insert_image', payload, timing);
        const content = toToolContent(result);
        reportTiming(timing, extra);
        return { content };
      } catch (e) {
        reportTiming(timing, extra);
        const code = e.code ?? (e.syscall === 'open' ? 'FILE_NOT_FOUND' : 'RPC_ERROR');
        return { content: [{ type: 'text', text: `${code}: ${e.message}` }], isError: true };
      }
    }
  );
}

// 부모 CLI 가 시그널 대신 stdin 을 닫아 종료하는 경우에도 프로세스가 남지 않도록:
// 허브 WS 연결이 이벤트 루프를 붙들고 있으므로 transport 종료 시 명시적으로 나간다.
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  failAllInflight(hubError('HUB_UNAVAILABLE', 'mcp server is shutting down'));
  try { ws?.terminate(); } catch {}
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
// server.connect 가 transport.onclose 를 소유하므로 Protocol 레벨 onclose 훅을 쓴다.
server.server.onclose = () => shutdown('stdio transport closed');
process.stdin.on('end', () => shutdown('stdin EOF'));
process.stdin.on('close', () => shutdown('stdin closed'));
log(`rhwp MCP stdio server started (agent=${AGENT_NAME}, session=${SESSION_ID ?? 'missing'}, hub=${LOG_WS_ENDPOINT}, workflow=${WORKFLOW}, profile=${TOOL_PROFILE}, epoch=${CAPABILITY_EPOCH ?? 'legacy'})`);

ensureConnected().then(
  () => log('eager hub connection established'),
  (e) => log(`eager hub connection failed (will retry on demand): ${e?.message ?? e}`)
);

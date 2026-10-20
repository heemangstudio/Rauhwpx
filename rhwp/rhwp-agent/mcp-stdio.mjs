import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import WebSocket from 'ws';
import { resolveHubIdentity } from './hub-session-registry.mjs';
import { createHubToolClient, hubError } from './hub-tool-client.mjs';
import {
  createRhwpMcpServer,
  guardDocumentIdArgs,
  mcpConnectionParams,
  visibleToolDefinitions,
} from './mcp-tool-server.mjs';

// Claude·Codex 는 허브가 직접 여는 HTTP MCP(/mcp-http)를 쓰므로 이 프로세스를 띄우지 않는다.
// RHWP_MCP_TRANSPORT=stdio 로 띄운 허브와 stdio MCP 만 쓰는 클라이언트를 위한 대체 경로다.
const WS_URL = process.env.RHWP_WS_URL ?? 'ws://127.0.0.1:5175/mcp';
const { token: TOKEN, development: DEVELOPMENT_AUTH } = resolveHubIdentity();
const PARAMS = mcpConnectionParams(process.env, { token: TOKEN, development: DEVELOPMENT_AUTH });
const SESSION_ID = PARAMS.sessionId;
const AGENT_NAME = PARAMS.agentName;
const AGENT_ROLE = PARAMS.agentRole;
const COPY_LAYOUT_JOB_ID = PARAMS.copyLayoutJobId;
const WORKFLOW = PARAMS.workflow;
const CAPABILITY_EPOCH = PARAMS.capabilityEpoch;
const TOOL_PROFILE = PARAMS.toolProfile;
const MAX_PROVIDER_FRAME_BYTES = 8 * 1024 * 1024;

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

function openHubSocket() {
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
  return new WebSocket(url, { maxPayload: MAX_PROVIDER_FRAME_BYTES });
}

const hub = createHubToolClient({
  openSocket: openHubSocket,
  workflow: WORKFLOW,
  capabilityEpoch: CAPABILITY_EPOCH,
  log,
  onConnected: () => log(`connected to hub at ${LOG_WS_ENDPOINT}`),
});

// 프로젝트 쓰기(채팅 설정)와 홈 폴더 검색(데스크톱)은 허브가 넣은 환경으로 등록을 가른다. 허브도 호출마다 다시 검사한다.
const visibleTools = visibleToolDefinitions(PARAMS);
const server = createRhwpMcpServer({
  visibleTools,
  imageRoots: PARAMS.imageRoots,
  callHub: hub.callHub,
  reportTiming: hub.reportTiming,
});

// 부모 CLI 가 시그널 대신 stdin 을 닫아 종료하는 경우에도 프로세스가 남지 않도록:
// 허브 WS 연결이 이벤트 루프를 붙들고 있으므로 transport 종료 시 명시적으로 나간다.
let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  hub.close();
  process.exit(0);
}

const transport = new StdioServerTransport();
await server.connect(transport);
guardDocumentIdArgs(transport, visibleTools, log);
// server.connect 가 transport.onclose 를 소유하므로 Protocol 레벨 onclose 훅을 쓴다.
server.server.onclose = () => shutdown('stdio transport closed');
process.stdin.on('end', () => shutdown('stdin EOF'));
process.stdin.on('close', () => shutdown('stdin closed'));
log(`rhwp MCP stdio server started (agent=${AGENT_NAME}, session=${SESSION_ID ?? 'missing'}, hub=${LOG_WS_ENDPOINT}, workflow=${WORKFLOW}, profile=${TOOL_PROFILE}, epoch=${CAPABILITY_EPOCH ?? 'legacy'})`);

hub.ensureConnected().then(
  () => log('eager hub connection established'),
  (e) => log(`eager hub connection failed (will retry on demand): ${e?.message ?? e}`)
);

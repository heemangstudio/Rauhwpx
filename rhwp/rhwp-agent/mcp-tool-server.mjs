// rhwp MCP 서버 정의 — mcp-stdio(독립 프로세스)와 허브의 /mcp-http 가 같은 등록을 쓴다.
// 도구 목록·설명·주석·입력 스키마·오류 텍스트가 두 전송에서 같도록 이 파일 한 곳에서 만든다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { HUB_CAPABILITY_AUDIENCES, sessionIdFromScopedHubToken } from './hub-session-registry.mjs';
import { imageRootsFromEnv } from './image-path-policy.mjs';
import { prepareInsertImageArgs } from './insert-image-source.mjs';
import { traceNow } from './hub-tool-client.mjs';
import {
  RHWP_TOOL_RULES,
  documentIdArgError,
  filterToolDefinitions,
  projectToolGatesFromEnv,
  toToolContent,
  toolAnnotations,
} from './tools.mjs';

/**
 * 어댑터가 MCP 서버에 넘기는 RHWP_* 설정(mcpCapabilityEnv)에서 허브 연결 신원과 도구 범위를 정한다.
 * mcp-stdio 는 프로세스 환경을, /mcp-http 는 URL 쿼리를 넣는다.
 * @param {Record<string, string | undefined>} env
 * @param {{ token: string, development?: boolean }} identity
 */
export function mcpConnectionParams(env, { token, development = false }) {
  const sessionId = env.RHWP_SESSION_ID
    ?? sessionIdFromScopedHubToken(token, { audience: HUB_CAPABILITY_AUDIENCES.MCP })
    ?? sessionIdFromScopedHubToken(token, { audience: HUB_CAPABILITY_AUDIENCES.COPY_LAYOUT_WORKER })
    ?? (development ? 'dev' : null);
  const agentRole = env.RHWP_AGENT_ROLE ?? 'chat';
  const workflow = env.RHWP_AGENT_WORKFLOW ?? env.RHWP_WORKFLOW ?? 'direct';
  const phase = env.RHWP_AGENT_PHASE ?? env.RHWP_PLAN_PHASE
    ?? (workflow === 'plan' ? 'planning' : workflow === 'question' ? 'questioning' : 'implementing');
  return {
    sessionId,
    agentName: env.RHWP_AGENT_NAME ?? 'unknown',
    agentRole,
    copyLayoutJobId: /^copy-layout-worker:([^:]+):[A-Za-z0-9_-]+$/.exec(agentRole)?.[1] ?? null,
    workflow,
    phase,
    capabilityEpoch: env.RHWP_CAPABILITY_EPOCH,
    toolProfile: env.RHWP_TOOL_PROFILE
      ?? (workflow === 'direct' ? 'direct' : phase === 'questioning' ? 'question' : phase),
    gates: projectToolGatesFromEnv(env),
    // insert_image 가 읽을 수 있는 루트 디렉터리(세션 작업 공간·다운로드 등).
    // 어댑터가 루트를 넘겨주면 그 밖의 절대경로 읽기는 전부 거부한다.
    imageRoots: imageRootsFromEnv(env),
  };
}

/**
 * @param {{
 *   visibleTools: any[],
 *   imageRoots: string[],
 *   callHub: (tool: string, args: any, timing: any) => Promise<any>,
 *   reportTiming: (timing: any, extra: any) => void,
 * }} options
 */
export function createRhwpMcpServer({ visibleTools, imageRoots, callHub, reportTiming }) {
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

  // ─── 이미지 삽입 — 파일은 MCP 서버 쪽(로컬)이 읽어 base64 로 전달한다 ───
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
          const payload = await prepareInsertImageArgs(args, imageRoots);
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

  // 도구 정의는 tools.mjs 가 단일 소스 — 테스트가 같은 정의를 임포트해 계약을 검증한다.
  for (const def of visibleTools) {
    // insert_image 만 파일 읽기가 필요해 커스텀 핸들러로 등록한다.
    if (def.name === 'insert_image') registerInsertImageTool(def);
    else registerTool(def);
  }

  // rhwp 는 리소스를 내보내지 않는다. Codex 같은 CLI 가 list_mcp_resources 로 먼저 살펴볼 때
  // "Method not found" 실패 대신 빈 목록을 받도록 리소스 메서드에 빈 응답을 둔다.
  server.server.registerCapabilities({ resources: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: [] }));
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
  server.server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    throw new McpError(ErrorCode.InvalidParams, `rhwp exposes no MCP resources: ${request.params.uri}`);
  });
  return server;
}

/** 프로필·게이트로 걸러 MCP 에 등록할 도구 정의. */
export function visibleToolDefinitions(params) {
  return filterToolDefinitions(params.toolProfile, params.gates);
}

/**
 * MCP SDK 는 스키마에 없는 인자를 조용히 지운다. 쓰기 도구에 온 documentId 가 지워진 채 열린 문서에
 * 적용되지 않도록, SDK 가 인자를 파싱하기 전에 원본 tools/call 요청에서 거절한다.
 * server.connect(transport) 뒤에 부른다.
 */
export function guardDocumentIdArgs(transport, visibleTools, log) {
  const visibleToolsByName = new Map(visibleTools.map((def) => [def.name, def]));
  const deliver = transport.onmessage;
  transport.onmessage = (message, extra) => {
    const error = message?.method === 'tools/call' && message.id !== undefined
      ? documentIdArgError(visibleToolsByName.get(message.params?.name), message.params?.arguments)
      : null;
    if (!error) {
      deliver?.(message, extra);
      return;
    }
    transport.send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: `INVALID_ARGS: ${error}` }], isError: true },
    }).catch((e) => log(`documentId guard reply failed: ${e?.message ?? e}`));
  };
}

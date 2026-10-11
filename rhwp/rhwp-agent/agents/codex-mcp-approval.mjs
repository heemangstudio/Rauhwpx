import { TOOL_DEFINITIONS } from '../tools.mjs';

// 앱 브라우저의 계정·사이트 작업 승인은 허브가 검사한다. Codex의 auto는
// openWorldHint 도구를 거절하므로 헤드리스 실행에는 명시적인 사전 승인이 필요하다.
export function codexManagedToolApprovalConfig() {
  return TOOL_DEFINITIONS
    .filter(({ name, category }) => category === 'browser' || name === 'project_import' || name === 'download_file')
    .flatMap(({ name }) => ['-c', `mcp_servers.rhwp.tools.${name}.approval_mode="approve"`]);
}

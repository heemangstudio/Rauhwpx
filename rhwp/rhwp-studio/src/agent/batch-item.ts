/**
 * apply_edits 항목의 인자 풀기 — 실행기와 사이드바 표시가 같은 규칙을 쓴다.
 *
 * 모델은 항목을 네 가지 꼴로 보낸다: 평평한 {tool, …인자}, 감싼 {tool, args:{…}},
 * 둘을 섞은 꼴(중괄호를 일찍 닫아 인자가 args 옆에 놓인 경우 — args 안쪽 값이 우선),
 * 그리고 JSON 문자열로 된 args. args 가 객체로 풀리지 않으면 null 을 돌려준다.
 */
export function batchItemArgs(item: Record<string, unknown>): Record<string, unknown> | null {
  const { tool: _tool, args: rawArgs, ...flat } = item;
  let nested: unknown = rawArgs ?? {};
  if (typeof nested === 'string') {
    try {
      nested = JSON.parse(nested);
    } catch {
      return null;
    }
  }
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return null;
  return { ...flat, ...(nested as Record<string, unknown>) };
}

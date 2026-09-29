/**
 * 스타일 편집에서 글자/문단 모양 대화상자를 여러 번 열었을 때 변경분을 합친다 (DOM 없음).
 *
 * 하위 대화상자는 매번 스타일의 원래 모양에서 시작해 이번에 바꾼 항목만 돌려준다.
 * 결과로 대기 중인 변경분을 통째로 바꾸면 첫 번째 글자 모양(굵게)이 두 번째(색)에
 * 덮여 사라진다. 뒤에 바꾼 값이 이기도록 합친다.
 */
export function mergeShapeModsJson(previousJson: string, mods: object): string {
  let previous: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(previousJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      previous = parsed as Record<string, unknown>;
    }
  } catch {
    previous = {};
  }
  const next = mods as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...previous, ...next };
  // 전 언어 글꼴(fontId)과 언어별 글꼴(fontIds)은 서로를 덮는다 — 이전 쪽을 남기면
  // 엔진이 둘 다 적용해 순서에 따라 결과가 달라진다.
  if ('fontId' in next && !('fontIds' in next)) delete merged.fontIds;
  if ('fontIds' in next && !('fontId' in next)) delete merged.fontId;
  return JSON.stringify(merged);
}

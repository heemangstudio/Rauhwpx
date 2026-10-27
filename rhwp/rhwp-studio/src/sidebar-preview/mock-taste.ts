/**
 * 미리보기의 취향 학습(Rau-0.1) — 허브 taste-learner 의 설정과 되돌리기를 흉내 낸다.
 *
 * 설정은 모든 모의 브리지가 나눈다. 바꾸면 허브처럼 붙은 모든 브리지에 taste-settings 를 보낸다.
 * 되돌리기는 받은 요청을 `tasteUndos` 에 남기고, `skipTasteUndo(entryId)` 로 고른 항목은 skipped 로 답한다.
 * `?taste=sample` 의 표본 채팅과 AGENTS.md 변경안은 fixtures.ts 의 sampleTasteChat 과 이 모듈의 draft 가 만든다.
 */
import type { SidebarBridge } from '../agent/bridge.ts';
import { RAU_TASTE_NAME } from '../agent/taste.ts';
import type * as T from '../agent/types.ts';

const settings: T.TasteSettings = { enabled: true, provider: 'auto', model: null, effort: null };
const sinks = new Set<(event: T.SidebarEvent) => void>();
const skipped = new Set<string>();
/** 받은 되돌리기 요청 — 미리보기 확인이 읽는다. */
export const tasteUndos: Array<{ learnId: string; learnIds?: string[]; documentId: string; key: string; entryId: string | null; changes: number }> = [];

/** 이 항목의 되돌리기는 그새 바뀐 것으로 답한다. */
export function skipTasteUndo(entryId: string): void {
  skipped.add(entryId);
}

/** `?taste=sample` 구분선이 가리키는 AGENTS.md 변경안. */
export const SAMPLE_TASTE_DRAFT_ID = 'preview-taste-draft';

export function sampleTasteDraft(instructions: T.AgentInstructionsStatus): T.AgentInstructionsDraft {
  const now = Date.now();
  return {
    id: SAMPLE_TASTE_DRAFT_ID,
    content: `${instructions.content}\n- 표 제목 칸은 굵게 씁니다.`,
    expectedRevision: instructions.revision,
    reason: '두 문서에서 같은 표 제목 서식을 골랐습니다.',
    requestedBy: RAU_TASTE_NAME,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    confirmationToken: 'preview-taste-token',
  };
}

export type MockTaste = Pick<SidebarBridge, 'requestTasteSettings' | 'setTasteSettings' | 'undoTaste'>;

/** 허브 TasteSettingsStore 처럼 바꿀 칸만 얹는다. 공급자를 바꾸면 모델·추론을 비우고, 자동은 늘 비운다. */
function mergeSettings(patch: Partial<T.TasteSettings>): void {
  const providerChanged = patch.provider !== undefined && patch.provider !== settings.provider;
  Object.assign(settings, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)));
  if (providerChanged && patch.model === undefined) settings.model = null;
  if (providerChanged && patch.effort === undefined) settings.effort = null;
  if (settings.provider === 'auto') Object.assign(settings, { model: null, effort: null });
}

/** 모의 브리지 하나의 취향 학습 메서드. emit 은 이 브리지의 이벤트 구독자에게 보낸다. */
export function createMockTaste(emit: (event: T.SidebarEvent) => void): MockTaste {
  sinks.add(emit);
  const settle = <V>(value: V) => new Promise<V>((done) => setTimeout(() => done(value), 30));
  return {
    requestTasteSettings: () => settle({ ...settings }),
    setTasteSettings: (patch) => {
      mergeSettings(patch);
      const event: T.SidebarEvent = { type: 'taste-settings', settings: { ...settings } };
      setTimeout(() => sinks.forEach((sink) => sink(event)), 0);
      return settle({ ...settings });
    },
    undoTaste: ({ learnId, learnIds, documentId, key, changes, entryId }) => {
      tasteUndos.push({ learnId, ...(learnIds?.length ? { learnIds: [...learnIds] } : {}), documentId, key, entryId: entryId ?? null, changes: changes.length });
      const ids = entryId
        ? [entryId]
        : changes.flatMap((change) => {
          const id = (change as { entryId?: unknown } | null)?.entryId;
          return typeof id === 'string' ? [id] : [];
        });
      return settle({
        ok: true,
        learnId,
        reverted: ids.filter((id) => !skipped.has(id)),
        skipped: ids.filter((id) => skipped.has(id)),
      });
    },
  };
}

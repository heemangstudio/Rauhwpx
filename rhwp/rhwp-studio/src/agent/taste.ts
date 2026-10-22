/**
 * 취향 학습(Rau-0.1) — 허브 프레임 읽기와 화면에 쓰는 이름.
 *
 * 학습은 허브(rhwp-agent/taste-learner.mjs)가 턴 끝과 검토 신호 뒤에 돌린다. Studio 는 결과(taste-learned)를
 * 채팅의 구분선으로 남기고, 구분선에서 항목별로 되돌린다(taste-undo). 저장소 변경 목록(changes)은
 * 읽지 않고 그대로 들고 있다가 되돌릴 때 돌려보낸다.
 */
import type { TasteLearnItem, TasteLearned, TasteSettings, TasteUndoResult } from './types.ts';

/** 사용자에게 보이는 취향 학습의 이름. 화면 문구는 모두 이 값을 쓴다. */
export const RAU_TASTE_NAME = 'Rau-0.1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

/** 항목 하나를 읽는다. 모양이 틀리면 null — 구분선은 남은 항목만 보인다. */
export function readTasteLearnItem(value: unknown): TasteLearnItem | null {
  if (!isRecord(value)) return null;
  const { op, entryId, text, prevText, origin } = value;
  if (op !== 'add' && op !== 'update' && op !== 'remove') return null;
  if (typeof entryId !== 'string' || !entryId || typeof text !== 'string') return null;
  if (origin !== 'explicit' && origin !== 'learned') return null;
  return { op, entryId, text, origin, ...(op === 'update' && typeof prevText === 'string' ? { prevText } : {}) };
}

/** taste-learned 프레임. 필수 칸이 틀리거나 남은 항목이 없으면 null. */
export function readTasteLearned(msg: Record<string, unknown>): TasteLearned | null {
  const { threadId, turnId, documentId, key, learnId } = msg;
  if (typeof threadId !== 'string' || !threadId || typeof documentId !== 'string' || !documentId) return null;
  if (typeof key !== 'string' || !key || typeof learnId !== 'string' || !learnId) return null;
  if (!Array.isArray(msg.items) || !Array.isArray(msg.changes)) return null;
  const items = msg.items.map(readTasteLearnItem).filter((item): item is TasteLearnItem => item !== null);
  if (!items.length) return null;
  const draftId = isRecord(msg.proposal) && typeof msg.proposal.draftId === 'string' && msg.proposal.draftId
    ? msg.proposal.draftId
    : null;
  return {
    threadId,
    turnId: typeof turnId === 'string' && turnId ? turnId : null,
    documentId,
    key,
    learnId,
    items,
    changes: msg.changes,
    ...(draftId ? { proposal: { draftId } } : {}),
  };
}

export function readTasteUndoResult(msg: Record<string, unknown>): TasteUndoResult {
  const error = isRecord(msg.error)
    ? { code: typeof msg.error.code === 'string' ? msg.error.code : 'TASTE_UNDO_FAILED', message: typeof msg.error.message === 'string' ? msg.error.message : '' }
    : undefined;
  return {
    ok: msg.ok === true,
    learnId: typeof msg.learnId === 'string' ? msg.learnId : '',
    reverted: stringList(msg.reverted),
    skipped: stringList(msg.skipped),
    ...(error ? { error } : {}),
  };
}

export function readTasteSettings(value: unknown): TasteSettings | null {
  return isRecord(value) && typeof value.enabled === 'boolean' ? { enabled: value.enabled } : null;
}

/** 구분선 이름 — `Rau-0.1 3가지 배움`. */
export function tasteMarkerLabel(count: number): string {
  return `${RAU_TASTE_NAME} ${count}가지 배움`;
}

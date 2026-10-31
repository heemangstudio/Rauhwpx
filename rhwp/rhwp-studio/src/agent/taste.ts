/**
 * 취향 학습(Rau-0.1) — 허브 프레임 읽기와 화면에 쓰는 이름.
 *
 * 학습은 허브(rhwp-agent/taste-learner.mjs)가 턴 끝과 검토 신호 뒤에 돌린다. Studio 는 결과(taste-learned)를
 * 채팅의 구분선으로 남기고, 구분선에서 항목별로 되돌린다(taste-undo). 저장소 변경 목록(changes)은
 * 읽지 않고 그대로 들고 있다가 되돌릴 때 돌려보낸다.
 */
import type { TasteLearnChange, TasteLearnItem, TasteLearned, TasteSettings, TasteUndoResult } from './types.ts';

/** 사용자에게 보이는 취향 학습의 이름. 화면 문구는 모두 이 값을 쓴다. */
export const RAU_TASTE_NAME = 'Rau-0.1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

const LEARN_CHANGES: readonly TasteLearnChange[] = ['new', 'reinforced', 'dampened', 'escalated', 'retired', 'updated'];

function readStrengthChange(value: unknown): { from: number; to: number } | undefined {
  if (!isRecord(value) || typeof value.from !== 'number' || typeof value.to !== 'number') return undefined;
  if (!Number.isFinite(value.from) || !Number.isFinite(value.to)) return undefined;
  const clamp = (n: number) => Math.max(0, Math.min(5, Math.round(n)));
  return { from: clamp(value.from), to: clamp(value.to) };
}

/** 항목 하나를 읽는다. 모양이 틀리면 null — 구분선은 남은 항목만 보인다. */
export function readTasteLearnItem(value: unknown): TasteLearnItem | null {
  if (!isRecord(value)) return null;
  const { op, entryId, text, prevText, origin } = value;
  if (op !== 'add' && op !== 'update' && op !== 'remove') return null;
  if (typeof entryId !== 'string' || !entryId || typeof text !== 'string') return null;
  if (origin !== 'explicit' && origin !== 'learned') return null;
  const change = LEARN_CHANGES.includes(value.change as TasteLearnChange) ? value.change as TasteLearnChange : undefined;
  const tier = value.tier === 'account' || value.tier === 'document' ? value.tier : undefined;
  const strength = readStrengthChange(value.strength);
  const eventIds = stringList(value.eventIds);
  return {
    op,
    entryId,
    text,
    origin,
    ...(typeof prevText === 'string' && prevText && op !== 'add' ? { prevText } : {}),
    ...(change ? { change } : {}),
    ...(tier ? { tier } : {}),
    ...(typeof value.kind === 'string' && value.kind ? { kind: value.kind } : {}),
    ...(strength ? { strength } : {}),
    ...(eventIds.length ? { eventIds } : {}),
  };
}

/** 줄이 기억에 한 일. 옛 구분선에는 change 가 없어서 op 로 짐작한다. */
export function tasteItemChange(item: Pick<TasteLearnItem, 'op' | 'change'>): TasteLearnChange {
  if (item.change) return item.change;
  return item.op === 'add' ? 'new' : item.op === 'remove' ? 'retired' : 'updated';
}

/** 줄 머리의 낱말 — NEW·보강·감쇄·장기기억 승격·EXIT·고침. */
export const TASTE_CHANGE_LABELS: Readonly<Record<TasteLearnChange, string>> = {
  new: 'NEW',
  reinforced: '보강',
  dampened: '감쇄',
  escalated: '장기기억 승격',
  retired: 'EXIT',
  updated: '고침',
};

/** taste-learned 프레임. 필수 칸이 틀리거나 남은 항목이 없으면 null. */
export function readTasteLearned(msg: Record<string, unknown>): TasteLearned | null {
  const { threadId, turnId, documentId, key, learnId } = msg;
  if (typeof threadId !== 'string' || !threadId || typeof documentId !== 'string' || !documentId) return null;
  if (typeof key !== 'string' || !key || typeof learnId !== 'string' || !learnId) return null;
  if (!Array.isArray(msg.items) || !Array.isArray(msg.changes)) return null;
  const items = msg.items.map(readTasteLearnItem).filter((item): item is TasteLearnItem => item !== null);
  if (!items.length) return null;
  return {
    threadId,
    turnId: typeof turnId === 'string' && turnId ? turnId : null,
    documentId,
    key,
    learnId,
    items,
    changes: msg.changes,
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

/** 옛 허브는 enabled 만 보낸다 — 그때는 자동 경로다. */
export function readTasteSettings(value: unknown): TasteSettings | null {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') return null;
  return { enabled: value.enabled, provider: 'auto', model: null, effort: null };
}

/** 구분선 이름 — `Rau-0.1 3가지 배움`. */
export function tasteMarkerLabel(count: number): string {
  return `${RAU_TASTE_NAME} ${count}가지 배움`;
}

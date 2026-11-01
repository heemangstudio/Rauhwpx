/**
 * 사용자가 만든 연속 키(`mod+k l h`)의 입력 상태.
 *
 * 입력 처리기보다 먼저 키를 받아 단계를 따라간다. 이어지지 않는 키는 가져가지 않아 평소처럼 처리되고,
 * 기다리는 시간이 지나면 처음부터 다시 본다. DOM 에 기대지 않아 단독으로 시험할 수 있다.
 */

import {
  isChordStarter,
  isModifierKeyEvent,
  sequenceStepFromKeyboardEvent,
  type BindingId,
} from './shortcut-bindings.ts';

/** 다음 단계를 기다리는 시간. 지나면 이어지던 입력을 버린다. */
export const SEQUENCE_TIMEOUT_MS = 2000;

/**
 * - none: 이 키는 연속 키와 상관없다.
 * - pending: 다음 단계를 기다린다. consume 이 false 면 기본 연속 키의 첫 키라 편집기도 받아야 한다.
 * - match: 연속 키가 끝났다.
 */
export type SequenceStep =
  | { kind: 'none' }
  | { kind: 'pending'; consume: boolean }
  | { kind: 'match'; commandId: string };

export interface SequenceMatcher {
  feed(e: KeyboardEvent): SequenceStep;
  reset(): void;
}

export function createSequenceMatcher(
  entries: () => readonly (readonly [BindingId, string])[],
  { timeoutMs = SEQUENCE_TIMEOUT_MS, now = () => Date.now() }: { timeoutMs?: number; now?: () => number } = {},
): SequenceMatcher {
  let typed: BindingId | null = null;
  let lastAt = 0;

  const advance = (candidate: BindingId, at: number): SequenceStep => {
    const known = entries();
    const exact = known.find(([id]) => id === candidate);
    if (exact) {
      typed = null;
      return { kind: 'match', commandId: exact[1] };
    }
    if (!known.some(([id]) => id.startsWith(`${candidate} `))) return { kind: 'none' };
    typed = candidate;
    lastAt = at;
    return { kind: 'pending', consume: !isChordStarter(candidate) };
  };

  return {
    feed(e) {
      if (isModifierKeyEvent(e)) return { kind: 'none' };
      const at = now();
      if (typed !== null && at - lastAt > timeoutMs) typed = null;
      if (typed !== null) {
        if (e.repeat) return { kind: 'pending', consume: true };
        const step = sequenceStepFromKeyboardEvent(e, true);
        if (step) {
          const result = advance(`${typed} ${step}`, at);
          if (result.kind !== 'none') return result;
        }
        typed = null;
      }
      if (e.repeat || entries().length === 0) return { kind: 'none' };
      const first = sequenceStepFromKeyboardEvent(e, false);
      return first ? advance(first, at) : { kind: 'none' };
    },
    reset() {
      typed = null;
    },
  };
}

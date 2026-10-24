// 기록에서 배우기(Rau-0.1) — Studio 의 taste-history-learn 프레임을 받아 취향 학습기에 넘긴다.
//
// 짝은 Studio 가 찾는다 (에이전트가 쓴 글 → 사용자가 나중에 고친 글, kind 'history'). 허브는 검토 신호와
// 같은 규칙으로 짝을 거르고(normalizeReviewSignal), 문서 기억 키를 시트 요청과 같은 방법으로 고른 뒤
// tasteLearner.learnHistory 를 부른다. 한 문서(기억 키)에 한 번에 하나만 받는다. 답의 accepted 는 학습기에 넘긴
// 짝의 번호(받은 pairs 기준)다 — Studio 는 그 짝만 '이미 보냄'으로 남기고 나머지는 다음에 다시 보낸다.
//
// 학습기는 대화에서 배우기 설정과 상관없이 돈다 — 사용자가 시트에서 누른 요청이다. 문서를 열 때 Studio 가
// 저절로 보낸 요청(auto)만 설정을 따른다. 테스트 허브처럼 학습기를 쓸 수 없으면 둘 다 거절한다.
import { normalizeReviewSignal } from './taste-signals.mjs';

// 학습기 프롬프트가 싣는 신호 수와 같다 — 보낸 짝은 모두 모델이 본다.
export const MAX_HISTORY_PAIRS = 20;
const MAX_ID_LENGTH = 200;

function historyError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 짝 목록을 검증한다. 틀이 틀렸으면(배열·상한) null, 짝은 하나씩 걸러 history 만 남긴다.
 * @returns {{ signal: object, index: number }[] | null} index 는 받은 목록에서의 자리
 */
export function normalizeHistoryPairs(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_HISTORY_PAIRS) return null;
  return raw.flatMap((pair, index) => {
    const signal = pair?.kind === 'history' ? normalizeReviewSignal(pair) : null;
    return signal ? [{ signal, index }] : [];
  });
}

/**
 * @param {{
 *   learner: { learnHistory(input: object): Promise<{ learnId: string, key: string, items: object[], changes: object[], provider?: string }> },
 *   resolveKey: (record: object, documentId: string, msg: object) => Promise<string> | string,
 *   available?: () => boolean,
 *   enabled?: () => boolean,
 *   threadId?: (record: object) => string | null | undefined,
 *   log?: (message: string) => void,
 * }} deps
 */
export function createTasteHistoryHandler({ learner, resolveKey, available = () => true, enabled = () => true, threadId = () => null, log = () => {} }) {
  const inFlight = new Set();

  /** 프레임 하나를 처리하고 taste-history-result 의 몸통을 돌려준다. */
  async function handle(record, msg) {
    const claims = [];
    try {
      const documentId = typeof msg?.documentId === 'string' ? msg.documentId.trim() : '';
      if (!documentId || documentId.length > MAX_ID_LENGTH) throw historyError('TASTE_HISTORY_INVALID', 'documentId is required');
      const pairs = normalizeHistoryPairs(msg.pairs);
      if (!pairs) throw historyError('TASTE_HISTORY_INVALID', `pairs must be 1–${MAX_HISTORY_PAIRS} history signals`);
      if (pairs.length === 0) throw historyError('TASTE_HISTORY_INVALID', 'No valid history pair');
      if (!available()) throw historyError('TASTE_UNAVAILABLE', 'The taste learner is not available on this hub');
      if (msg.auto === true && !enabled()) throw historyError('TASTE_DISABLED', 'Learning from chats is turned off');
      if (inFlight.has(`doc:${documentId}`)) throw historyError('TASTE_HISTORY_BUSY', 'This document is already learning from history');
      inFlight.add(`doc:${documentId}`);
      claims.push(`doc:${documentId}`);
      const key = await resolveKey(record, documentId, msg);
      // 같은 기억을 나누는 작업 공간 사본끼리도 하나씩.
      if (inFlight.has(`key:${key}`)) throw historyError('TASTE_HISTORY_BUSY', 'This document memory is already learning from history');
      inFlight.add(`key:${key}`);
      claims.push(`key:${key}`);
      // Studio 는 새것부터 보낸다. 학습기는 최근 신호를 뒤에서부터 자르므로 오래된 것부터 넘긴다.
      const signals = [...pairs].sort((a, b) => Date.parse(a.signal.at) - Date.parse(b.signal.at)).map(({ signal }) => signal);
      const result = await learner.learnHistory({
        documentId,
        key,
        ...(threadId(record) ? { threadId: threadId(record) } : {}),
        signals,
      });
      // 모델이 답하지 않았으면(경로 없음·잘못된 답) 실패로 알린다 — Studio 가 다음에 다시 보낸다.
      if (!result?.provider) throw historyError('TASTE_HISTORY_NO_RESULT', 'The taste learner returned no result');
      log(`taste-history doc=${documentId} pairs=${pairs.length} items=${result.items.length}`);
      return {
        ok: true,
        learnId: result.learnId,
        key: result.key,
        items: result.items,
        changes: result.changes,
        accepted: pairs.map(({ index }) => index),
      };
    } catch (error) {
      // TASTE_CLOSED(허브가 닫히는 중)도 여기로 온다 — 실패로 답하면 Studio 가 다음에 다시 보낸다.
      return {
        ok: false,
        accepted: [],
        learnId: null,
        key: null,
        items: [],
        changes: [],
        error: { code: error?.code ?? 'TASTE_HISTORY_FAILED', message: String(error?.message ?? error) },
      };
    } finally {
      for (const claim of claims) inFlight.delete(claim);
    }
  }

  return { handle };
}

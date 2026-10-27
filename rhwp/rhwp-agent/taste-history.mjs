// 기록에서 배우기(Rau-0.1) — Studio 의 taste-history-learn 프레임을 받아 취향 학습기에 넘긴다.
//
// 짝은 Studio 가 찾는다 (에이전트가 쓴 글 → 사용자가 나중에 고친 글, kind 'history'). 허브는 검토 신호와
// 같은 규칙으로 짝을 거르고(normalizeReviewSignal), 문서 기억 키를 시트 요청과 같은 방법으로 고른 뒤
// tasteLearner.learnHistory 를 부른다. 한 문서(기억 키)에 한 번에 하나만 받는다. 답의 accepted 는 학습기에 넘긴
// 짝의 번호(받은 pairs 기준)다 — Studio 는 그 짝만 '이미 보냄'으로 남기고 나머지는 다음에 다시 보낸다.
//
// 사용자가 누른 요청(auto 아님)은 그 문서의 지난 채팅도 싣는다(chats: 사용자 요청과 에이전트의 마지막 답,
// 오래된 것부터). 짝이 없어도 채팅만으로 배운다.
//
// 학습기는 대화에서 배우기 설정과 상관없이 돈다 — 사용자가 시트에서 누른 요청이다. 문서를 열 때 Studio 가
// 저절로 보낸 요청(auto)만 설정을 따른다. 테스트 허브처럼 학습기를 쓸 수 없으면 둘 다 거절한다.
import { normalizeReviewSignal } from './taste-signals.mjs';

// 학습기 프롬프트가 싣는 신호 수와 같다 — 보낸 짝은 모두 모델이 본다.
export const MAX_HISTORY_PAIRS = 20;
// 채팅 기록은 최근 턴만, 턴마다 앞부분만 싣는다 — 프롬프트를 수만 자 안에 둔다.
export const MAX_HISTORY_CHATS = 40;
const CHAT_USER_CHARS = 800;
const CHAT_ANSWER_CHARS = 400;
const MAX_ID_LENGTH = 200;

function historyError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * 짝 목록을 검증한다. 틀이 틀렸으면(배열·상한) null, 짝은 하나씩 걸러 history 만 남긴다.
 * @returns {{ signal: object, index: number }[] | null} index 는 받은 목록에서의 자리
 */
export function normalizeHistoryPairs(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_HISTORY_PAIRS) return null;
  return raw.flatMap((pair, index) => {
    const signal = pair?.kind === 'history' ? normalizeReviewSignal(pair) : null;
    return signal ? [{ signal, index }] : [];
  });
}

function clipText(value, max) {
  const text = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/**
 * 채팅 기록을 검증한다. 틀이 틀렸으면 null. 사용자 글이 없는 턴은 버리고, 넘치면 최근 턴만 남긴다.
 * @returns {{ userText: string, answer: string }[] | null}
 */
export function normalizeHistoryChats(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((turn) => {
    const userText = clipText(turn?.userText, CHAT_USER_CHARS);
    return userText ? [{ userText, answer: clipText(turn?.answer, CHAT_ANSWER_CHARS) }] : [];
  }).slice(-MAX_HISTORY_CHATS);
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
      if (!pairs) throw historyError('TASTE_HISTORY_INVALID', `pairs must be at most ${MAX_HISTORY_PAIRS} history signals`);
      // 자동 요청은 채팅을 싣지 않는다 — 문서를 열 때마다 지난 대화를 다시 배우지 않게.
      const chats = msg.auto === true ? [] : normalizeHistoryChats(msg.chats);
      if (!chats) throw historyError('TASTE_HISTORY_INVALID', 'chats must be an array of turns');
      if (pairs.length === 0 && chats.length === 0) throw historyError('TASTE_HISTORY_INVALID', 'No valid history pair or chat');
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
        ...(chats.length ? { chats } : {}),
      });
      // 모델이 답하지 않았으면(경로 없음·잘못된 답) 실패로 알린다 — Studio 가 다음에 다시 보낸다.
      if (!result?.provider) throw historyError('TASTE_HISTORY_NO_RESULT', 'The taste learner returned no result');
      log(`taste-history doc=${documentId} pairs=${pairs.length} chats=${chats.length} items=${result.items.length}`);
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

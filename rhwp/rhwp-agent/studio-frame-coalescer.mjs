// 프로바이더 토큰 하나가 Studio WS 프레임 하나가 되지 않도록, 같은 소켓으로 가는
// 연속 스트리밍 이벤트를 잠깐 모아 한 프레임으로 보낸다.
//
// - text-delta: 텍스트 외 필드(agent·parentTaskId·turnId …)가 모두 같으면 이어 붙인다.
// - 진행 스냅샷(task-progress): 같은 작업의 더 새 스냅샷이 앞의 것을 대신한다.
//
// 순서는 그대로다. 같은 소켓으로 다른 프레임을 보내기 전에 flush 해야 하며(sendJson·sendRaw
// 가 그렇게 한다), 모인 프레임은 창이 끝나거나 크기 한도를 넘으면 바로 나간다.
//
// 창은 32ms(60Hz 화면 두 프레임). Studio 는 토큰이 아니라 완성된 문단 단위로 답변을
// 드러내므로 이 정도 지연은 보이지 않는다. 15~40ms 간격으로 토큰 1~3개씩 오는 흐름에서
// 16ms 창은 600프레임을 약 265개로, 32ms 창은 약 170개로 줄인다.

export const STUDIO_FRAME_WINDOW_MS = 32;
/** 이만큼 모이면 창을 기다리지 않고 보낸다 — 프레임 하나가 커지지 않게 한다. */
export const STUDIO_TEXT_DELTA_MAX_CHARS = 16 * 1024;

function sameFieldsExceptText(a, b) {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (key === 'text') continue;
    if (!Object.hasOwn(b, key) || a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * @param {object} options
 * @param {(sock: any, frame: object) => boolean} options.write 실제로 한 프레임을 보낸다.
 * @param {number} [options.windowMs]
 * @param {number} [options.maxChars]
 */
export function createStudioFrameCoalescer({
  write,
  windowMs = STUDIO_FRAME_WINDOW_MS,
  maxChars = STUDIO_TEXT_DELTA_MAX_CHARS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /** sock → { kind: 'text' | 'progress', frame, timer } */
  const pending = new Map();

  function flush(sock) {
    const entry = pending.get(sock);
    if (!entry) return true;
    pending.delete(sock);
    clearTimer(entry.timer);
    return write(sock, entry.frame);
  }

  function hold(sock, kind, frame) {
    const timer = setTimer(() => {
      if (pending.get(sock)?.timer === timer) flush(sock);
    }, windowMs);
    timer?.unref?.();
    pending.set(sock, { kind, frame, timer });
  }

  function isOpen(sock) {
    return Boolean(sock) && sock.readyState === sock.OPEN;
  }

  /** text-delta 이벤트를 모은다. 소켓이 열려 있으면 true(보낼 예정). */
  function pushTextDelta(sock, frame) {
    if (!isOpen(sock)) return false;
    const entry = pending.get(sock);
    const event = frame.event;
    if (entry?.kind === 'text' && sameFieldsExceptText(entry.frame.event, event)) {
      // 받은 이벤트 객체는 건드리지 않는다 — 처음 합칠 때 복사본을 만든다.
      if (!entry.owned) {
        entry.frame = { ...entry.frame, event: { ...entry.frame.event } };
        entry.owned = true;
      }
      entry.frame.event.text += event.text;
      if (entry.frame.event.text.length >= maxChars) return flush(sock);
      return true;
    }
    flush(sock);
    if (String(event.text ?? '').length >= maxChars) return write(sock, frame);
    hold(sock, 'text', frame);
    return true;
  }

  /** 같은 작업의 진행 스냅샷은 마지막 것만 보낸다. */
  function pushProgress(sock, frame) {
    if (!isOpen(sock)) return false;
    const entry = pending.get(sock);
    if (entry?.kind === 'progress' && entry.frame.event.taskId === frame.event.taskId) {
      entry.frame = frame;
      return true;
    }
    flush(sock);
    hold(sock, 'progress', frame);
    return true;
  }

  /** 닫힌 소켓의 모인 프레임을 버린다. */
  function discard(sock) {
    const entry = pending.get(sock);
    if (!entry) return;
    pending.delete(sock);
    clearTimer(entry.timer);
  }

  return { pushTextDelta, pushProgress, flush, discard };
}

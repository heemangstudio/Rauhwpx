// 한 채팅의 에이전트 작업을 그리는 브라우저 이벤트는 그 채팅을 연 Studio 에만 보낸다.
// 미리보기 활동과 에이전트 커서는 다른 창에서 탭을 열거나 커서를 그리면 안 된다.
const SESSION_SCOPED_EVENTS = new Set(['owned_browser_activity', 'owned_browser_pointer']);

export function browserEventReachesSession(event, sessionId) {
  return !SESSION_SCOPED_EVENTS.has(event?.type) || (typeof event.sessionId === 'string' && event.sessionId === sessionId);
}

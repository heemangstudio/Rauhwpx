// 라이선스가 읽기 전용(체험 끝·해지·확인 기한 지남·재활성화 필요)인 동안 앱은 문서 보기 전용이 된다.
// license-gate 가 켜고 끄며, 에이전트 사이드바는 이 신호 하나로 열기·집중 화면·입력기 첨부를 막는다.

type Listener = (locked: boolean) => void;

let locked = false;
/** 잠기기 직전 이 창의 에이전트 사이드바가 펼쳐 있었는지. 문서를 바꿔도 창 하나에 하나다. */
let agentOpenBeforeLock: boolean | null = null;
const listeners = new Set<Listener>();

export function isLicenseViewerMode(): boolean {
  return locked;
}

export function setLicenseViewerMode(value: boolean): void {
  if (locked === value) return;
  locked = value;
  for (const listener of [...listeners]) listener(locked);
}

export function onLicenseViewerModeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 잠길 때 화면에 붙은 사이드바가 한 번 적는다. 잠긴 동안 다시 적지 않는다. */
export function noteAgentOpenBeforeLock(open: boolean): void {
  if (agentOpenBeforeLock === null) agentOpenBeforeLock = open;
}

/** 풀릴 때 화면에 붙은 사이드바가 읽고 지운다. 문서를 바꾼 뒤라도 그 사이드바가 펼친다. */
export function takeAgentOpenBeforeLock(): boolean {
  const open = agentOpenBeforeLock === true;
  agentOpenBeforeLock = null;
  return open;
}

// 라이선스가 읽기 전용(체험 끝·해지·확인 기한 지남·재활성화 필요)인 동안 앱은 문서 보기 전용이 된다.
// license-gate 가 켜고 끄며, 에이전트 사이드바는 이 신호 하나로 열기·집중 화면·입력기 첨부를 막는다.

type Listener = (locked: boolean) => void;

let locked = false;
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

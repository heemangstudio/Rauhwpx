/**
 * 처음 설정이 떠 있거나 곧 뜰 차례인지 — 그동안 프로바이더 업데이트 토스트 같은 알림을 미룬다.
 * 설정 창 모듈을 끌어오지 않도록 상태만 따로 둔다.
 */
const holders = new Set<object>();
const listeners = new Set<() => void>();

export function isInitialSetupActive(): boolean {
  return holders.size > 0;
}

export function holdInitialSetup(owner: object): void {
  holders.add(owner);
}

export function releaseInitialSetup(owner: object): void {
  if (!holders.delete(owner) || holders.size > 0) return;
  for (const listener of [...listeners]) listener();
}

/** 이 창의 처음 설정에서 라이선스 키를 활성화했는지. 선물 창이 환영 인사로 뜬다. */
let licensedInSetup = false;

export function markLicensedInSetup(): void {
  licensedInSetup = true;
}

export function wasLicensedInSetup(): boolean {
  return licensedInSetup;
}

/** 처음 설정이 모두 닫히면 한 번씩 부른다. 해제 함수를 돌려준다. */
export function onInitialSetupInactive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

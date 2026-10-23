export type StudioEngineId = 'rhwp' | 'heemang';

export class EngineNotSupportedError extends Error {
  readonly code = 'ENGINE_NOT_SUPPORTED';
  readonly operation: string;
  constructor(operation: string) {
    super(`HeemangEngine에서 아직 지원하지 않는 기능입니다: ${operation}`);
    this.name = 'EngineNotSupportedError';
    this.operation = operation;
  }
}

/** 전체 글꼴 파일을 넘긴다. 메트릭 부분집합에는 글리프 윤곽선이 없다. */
type FontReceiver = (label: string, bytes: Uint8Array) => void;
const receivers = new Set<FontReceiver>();
export function receiveEngineFonts(receiver: FontReceiver): void { receivers.add(receiver); }
export function provideEngineFont(label: string, bytes: ArrayBuffer | Uint8Array): void {
  if (!receivers.size) return;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const receiver of receivers) receiver(label, view);
}

// 모든 엔진의 문서 번호는 같은 축을 쓴다. 세션을 바꿔도 서로 겹치지 않는다.
let documentGeneration = 0;
let documentInstance = 0;
export function nextDocumentGeneration(): number { return ++documentGeneration; }
export function nextDocumentInstance(): number { return ++documentInstance; }

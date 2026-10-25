import type { HmCore } from './core';
import { extendBridge } from './api';

/** 명시적 HWPX 출력은 미리 보기 이미지를 저장 방식으로 묶는다. 원본 직렬화 정책은 유지한다. */
export function exportHwpx(core: HmCore): Uint8Array {
  return core.call(doc => doc.exportHwpx()).slice();
}

extendBridge({ exportHwpx });

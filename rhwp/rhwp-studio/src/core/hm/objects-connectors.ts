/** 배치가 바뀐 개체에 붙은 연결선 끝점을 엔진 이력 한 단계로 갱신한다. */
import type { HmCore } from './core';
import { extendBridge } from './api';
export function updateConnectorsInSection(core: HmCore, sec: number): void {
  core.mutate(doc => (doc as unknown as { updateConnectors(section: number): string }).updateConnectors(sec));
}
extendBridge({ updateConnectorsInSection });

/**
 * 엔진이 멈춘 창에서 문서를 새로 올리는 명령을 막는다.
 *
 * 멈춘 엔진에 문서를 올리면 지금 문서를 먼저 해제한 뒤 실패하고, 그 문서의 복구본까지 지운다 —
 * 그 문서가 문서 복구에서 빠진다. 열기·새 문서는 저장 확인과 파일 선택부터 하므로 명령을 실행하기
 * 전에 막고 문서 복구로 안내한다 (hold 가 안내하고 true 를 돌려준다).
 */
import type { CommandDef } from '../command/types.ts';

export const DOCUMENT_LOADING_COMMANDS: readonly string[] = [
  'file:new-doc',
  'file:open',
  'file:open-recent',
  'file:import-legacy-history',
];

export function holdDocumentLoadingCommands(
  registry: { get(id: string): CommandDef | undefined; register(def: CommandDef): void },
  hold: () => boolean,
): void {
  for (const id of DOCUMENT_LOADING_COMMANDS) {
    const def = registry.get(id);
    if (!def) continue;
    registry.register({
      ...def,
      execute: (services, params) => {
        if (hold()) return;
        def.execute(services, params);
      },
    });
  }
}

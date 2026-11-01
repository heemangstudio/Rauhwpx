import type { PageDef } from '@/core/types';
import {
  matchPageMarginPreset,
  matchParaSpacingPreset,
  type DocumentParaSpacing,
} from '@/core/layout-presets';

interface PresetStateSource {
  getSectionCount(): number;
  getPageDef(sectionIdx: number): PageDef;
  getDocumentParaSpacing(): DocumentParaSpacing;
}

function markPresetItems(root: ParentNode, cmd: string, activeId: string | null): void {
  for (const item of root.querySelectorAll<HTMLElement>(`.md-item[data-cmd="${cmd}"][data-preset]`)) {
    const on = item.dataset.preset === activeId;
    item.classList.toggle('active', on);
    item.setAttribute('aria-checked', String(on));
  }
}

/**
 * 쪽 › 쪽 여백, 서식 › 문단 간격 메뉴의 체크 표시를 문서 상태에 맞춘다.
 * 모든 구역(문단 간격은 대상 문단 전부)이 한 프리셋과 같을 때만 그 항목에 체크한다.
 * 메뉴를 열 때와 네이티브 메뉴 동기화 직전에 부른다.
 */
export function syncSpacingPresetMenus(
  wasm: PresetStateSource,
  root: ParentNode = document,
  { layoutPending = false }: { layoutPending?: boolean } = {},
): void {
  let marginId: string | null = null;
  let spacingId: string | null = null;
  // 큰 문서를 앞쪽만 조판해 여는 동안에는 체크를 비워 둔다. 모든 문단을 읽으면 엔진이 남은 쪽을 한 번에
  // 조판해 첫 쪽이 늦게 뜬다. 조판이 끝나면 document-context-changed 로 다시 맞춘다.
  const sections = layoutPending ? 0 : wasm.getSectionCount();
  if (sections > 0) {
    try {
      marginId = matchPageMarginPreset(Array.from({ length: sections }, (_, i) => wasm.getPageDef(i)));
      spacingId = matchParaSpacingPreset(wasm.getDocumentParaSpacing());
    } catch {
      // 문서 전환 중이면 체크 없이 둔다.
    }
  }
  markPresetItems(root, 'page:margin-preset', marginId);
  markPresetItems(root, 'format:spacing-preset', spacingId);
}

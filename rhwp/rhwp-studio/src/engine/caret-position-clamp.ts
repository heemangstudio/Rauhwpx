import type { WasmBridge } from '@/core/wasm-bridge';
import type { DocumentPosition } from '@/core/types';
import { caretParagraphLength } from './command';

const DOCUMENT_START: DocumentPosition = Object.freeze({
  sectionIndex: 0,
  paragraphIndex: 0,
  charOffset: 0,
}) as DocumentPosition;

/** 히트 테스트가 덧붙인 화면 좌표를 뗀다. 편집·줌 뒤에는 맞지 않는 값이다. */
export function withoutHitRect(position: DocumentPosition): DocumentPosition {
  if (position.cursorRect === undefined) return { ...position };
  const { cursorRect: _cursorRect, ...rest } = position;
  return rest;
}

function clampIndex(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.trunc(value), max);
}

/**
 * 저장해 둔 캐럿을 지금 문서 범위 안으로 맞춘다. 문서가 그사이 바뀌었을 수 있다(백그라운드
 * 에이전트 편집 등). 셀·글상자 안 위치는 그 문단이 아직 있으면 오프셋만 맞추고, 없으면 바깥
 * 본문 문단의 처음으로 옮긴다. 조회가 모두 실패하면 문서 처음을 돌려준다.
 */
export function clampCaretPosition(
  wasm: WasmBridge,
  position: DocumentPosition | null | undefined,
): DocumentPosition {
  if (!position) return { ...DOCUMENT_START };
  try {
    const sectionCount = wasm.getSectionCount();
    if (sectionCount <= 0) return { ...DOCUMENT_START };
    const sectionIndex = clampIndex(position.sectionIndex, sectionCount - 1);
    const paragraphCount = wasm.getParagraphCount(sectionIndex);
    if (paragraphCount <= 0) return { sectionIndex, paragraphIndex: 0, charOffset: 0 };

    const nested = position.parentParaIndex !== undefined;
    if (nested) {
      const parent = position.parentParaIndex!;
      if (sectionIndex === position.sectionIndex && parent >= 0 && parent < paragraphCount) {
        try {
          const length = caretParagraphLength(wasm, position);
          return { ...withoutHitRect(position), charOffset: clampIndex(position.charOffset, length) };
        } catch {
          // 셀·글상자 경로가 사라졌다 — 바깥 문단으로 옮긴다.
        }
      }
      return {
        sectionIndex,
        paragraphIndex: clampIndex(parent, paragraphCount - 1),
        charOffset: 0,
      };
    }

    const paragraphIndex = clampIndex(position.paragraphIndex, paragraphCount - 1);
    const body: DocumentPosition = { sectionIndex, paragraphIndex, charOffset: 0 };
    const length = caretParagraphLength(wasm, body);
    return { ...body, charOffset: clampIndex(position.charOffset, length) };
  } catch {
    return { ...DOCUMENT_START };
  }
}

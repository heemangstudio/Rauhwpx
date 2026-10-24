import { EngineNotSupportedError } from '../core/engine-support.ts';
import type { SaveFormat } from './save-format.ts';
import { detectDocumentByteKind } from '../core/document-signature.ts';
import { engineMutationEpoch } from '../core/engine-trap.ts';

export interface DocumentFormatExporter {
  readonly engineKind?: string;
  readonly viewer?: {
    getSourceFormat(): string;
    serialize(markSaved: boolean): Uint8Array;
  };
  exportHml(): Uint8Array;
  exportHwp(): Uint8Array;
  exportHwpx(): Uint8Array;
  /** 문서를 들일 때마다 바뀌는 번호(WasmBridge). 있으면 같은 내용의 내보내기를 잠깐 함께 쓴다. */
  readonly documentGeneration?: number;
}

/**
 * 마지막 내보내기 한 벌. 저장·버전 지문·자동 저장이 같은 내용을 연달아 내보낼 때(문서를 떠나며 저장한 뒤
 * 커밋하는 길) 큰 문서는 한 번에 1초 넘게 걸린다. 그사이 어떤 엔진 쓰기도 없었으면(engineMutationEpoch)
 * 바이트가 같으므로 그대로 돌려준다. 한 벌만, 잠깐만 쥔다 — 버전 지문 캐시가 같은 바이트를 더 오래 쥔다.
 */
const EXPORT_MEMO_MS = 10_000;
let memo: { generation: number; format: SaveFormat; epoch: number; bytes: Uint8Array } | null = null;
let memoTimer: ReturnType<typeof setTimeout> | null = null;

function rememberExport(generation: number, format: SaveFormat, epoch: number, bytes: Uint8Array): void {
  memo = { generation, format, epoch, bytes };
  if (memoTimer !== null) clearTimeout(memoTimer);
  memoTimer = setTimeout(() => {
    memo = null;
    memoTimer = null;
  }, EXPORT_MEMO_MS);
  (memoTimer as { unref?: () => void }).unref?.();
}

function recallExport(generation: number, format: SaveFormat): Uint8Array | null {
  if (!memo || memo.generation !== generation || memo.format !== format) return null;
  // 넘겨준 버퍼가 다른 곳으로 옮겨졌으면(transfer) 쓰지 않는다.
  if (memo.epoch !== engineMutationEpoch() || memo.bytes.buffer.byteLength === 0) {
    memo = null;
    return null;
  }
  return memo.bytes;
}

/** 테스트 전용 — 기억한 내보내기를 버린다. */
export function forgetDocumentExportForTests(): void {
  memo = null;
}

export function exportDocumentForFormat(
  exporter: DocumentFormatExporter,
  format: SaveFormat,
): Uint8Array {
  const heemang = exporter.engineKind === 'heemang';
  if (heemang && (!exporter.viewer || format === 'hml' || exporter.viewer.getSourceFormat() !== format)) {
    throw new EngineNotSupportedError(`${format.toUpperCase()} 형식 변환`);
  }
  const generation = exporter.documentGeneration;
  const shareable = !heemang && typeof generation === 'number' && generation > 0;
  if (shareable) {
    const recalled = recallExport(generation, format);
    if (recalled) return recalled;
  }
  const epoch = engineMutationEpoch();
  const bytes = heemang ? exporter.viewer!.serialize(false) : format === 'hml'
    ? exporter.exportHml()
    : format === 'hwpx'
      ? exporter.exportHwpx()
      : exporter.exportHwp();
  const actual = detectDocumentByteKind(bytes);
  if (actual !== format) {
    throw new Error(
      `${format.toUpperCase()} 내보내기가 올바르지 않은 파일 형식(${actual})을 반환했습니다. 기존 파일은 변경하지 않았습니다.`,
    );
  }
  if (shareable) rememberExport(generation, format, epoch, bytes);
  return bytes;
}

import { exportDocumentForFormat } from '../command/save-document-format.ts';
import { defaultFormatForSource, saveFormatForFileName } from '../command/save-target.ts';
import { buildSnapshotFromWasm, buildSnapshotFromWasmInSlices, compareSnapshots } from '../compare/diff-engine.ts';
import type { CompareDocumentSnapshot, CompareOptions } from '../compare/types.ts';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CheckpointTitleSummary } from '../agent/types.ts';
import { fingerprintBytes } from './hash.ts';
import type { ContentFingerprint, VersionStats } from './types.ts';

export const VERSION_COMPARE_OPTIONS: CompareOptions = {
  caseSensitive: true,
  ignoreWhitespace: false,
  kinds: ['text', 'table', 'shape', 'image', 'chart', 'paragraphMeta'],
  strategy: 'identity',
  performanceTuning: {
    maxComputeMs: 1_200,
    hardSegmentCells: 80_000,
  },
};

// 실시간 캡처(로드/저장 직후 베이스라인·더티 추적·커밋 전 diff)는 강제 전체 재조판을 건너뛴다.
// 대형 문서에서 한 번의 재조판이 입력을 수 분간 멈추게 하며, 백그라운드에서
// 진행 중인 지연 조판을 통째로 무효화한다.
const LIVE_COMPARE_OPTIONS: CompareOptions = { ...VERSION_COMPARE_OPTIONS, refreshLayout: false };

export interface VersionContent {
  bytes: Uint8Array;
  fingerprint: ContentFingerprint;
}

export interface CapturedVersionSnapshot extends VersionContent {
  compareSnapshot: CompareDocumentSnapshot;
}

/** 쓰이지 않은 내보내기 바이트와 비교 스냅샷을 내려놓기까지의 시간. 지문은 남는다. */
const CACHE_RELEASE_MS = 30_000;

/** One editor revision owns one export, shared by dirty checks and checkpoints. */
export class VersionSnapshotCache {
  #key: string | null = null;
  #fingerprint: ContentFingerprint | null = null;
  #content: VersionContent | null = null;
  #snapshot: CapturedVersionSnapshot | null = null;
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;

  clear(): void {
    this.#key = null;
    this.#fingerprint = null;
    this.#release();
  }

  invalidateUnless(fingerprint: string): void {
    if (this.#fingerprint !== fingerprint) this.clear();
  }

  #release(): void {
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    this.#releaseTimer = null;
    this.#content = null;
    this.#snapshot = null;
  }

  #scheduleRelease(): void {
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = null;
      this.#content = null;
      this.#snapshot = null;
    }, CACHE_RELEASE_MS);
    (this.#releaseTimer as { unref?: () => void }).unref?.();
  }

  #select(wasm: WasmBridge, documentId: string | null, revision: number): void {
    const key = JSON.stringify([documentId, revision, currentSaveFormat(wasm), wasm.fileName, wasm.getSourceFormat()]);
    if (this.#key === key) return;
    this.clear();
    this.#key = key;
  }

  content(wasm: WasmBridge, documentId: string | null, revision: number): VersionContent {
    this.#select(wasm, documentId, revision);
    if (!this.#content) {
      const bytes = exportVersionContent(wasm);
      this.#content = { bytes, fingerprint: fingerprintBytes(bytes) };
      this.#fingerprint = this.#content.fingerprint;
    }
    this.#scheduleRelease();
    return this.#content;
  }

  /** 문서를 다시 내보내 캐시와 맞춘다. 내용이 그대로면 캐시한 지문과 스냅샷을 그대로 쓴다. */
  reexport(wasm: WasmBridge, documentId: string | null, revision: number): VersionContent {
    this.#select(wasm, documentId, revision);
    const bytes = exportVersionContent(wasm);
    if (!this.#content || !sameBytes(this.#content.bytes, bytes)) {
      this.#snapshot = null;
      this.#content = { bytes, fingerprint: fingerprintBytes(bytes) };
      this.#fingerprint = this.#content.fingerprint;
    }
    this.#scheduleRelease();
    return this.#content;
  }

  fingerprint(wasm: WasmBridge, documentId: string | null, revision: number): ContentFingerprint {
    this.#select(wasm, documentId, revision);
    return this.#fingerprint ?? this.content(wasm, documentId, revision).fingerprint;
  }

  capture(wasm: WasmBridge, documentId: string | null, revision: number): CapturedVersionSnapshot {
    const content = this.content(wasm, documentId, revision);
    return this.#snapshot ??= {
      ...content,
      compareSnapshot: buildSnapshotFromWasm(wasm, wasm.fileName, LIVE_COMPARE_OPTIONS),
    };
  }

  /** `capture`와 같은 캡처를 입력을 막지 않게 조각으로 나눠 만든다. 그사이 문서가 바뀌면 null. */
  async captureInSlices(
    wasm: WasmBridge,
    documentId: string | null,
    revision: number,
    isCurrent: () => boolean,
  ): Promise<CapturedVersionSnapshot | null> {
    const content = this.content(wasm, documentId, revision);
    if (this.#snapshot) return this.#snapshot;
    const key = this.#key;
    const compareSnapshot = await buildSnapshotFromWasmInSlices(wasm, wasm.fileName, LIVE_COMPARE_OPTIONS, isCurrent);
    if (!compareSnapshot) return null;
    const captured = { ...content, compareSnapshot };
    if (this.#key !== key) return captured;
    this.#content ??= content;
    this.#snapshot ??= captured;
    this.#scheduleRelease();
    return this.#snapshot;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export interface VersionDiffAnalysis {
  stats: VersionStats;
  titleSummary: CheckpointTitleSummary;
}

function currentSaveFormat(wasm: WasmBridge): 'hml' | 'hwp' | 'hwpx' {
  const targetName = wasm.currentFileHandle?.name ?? wasm.fileName;
  return saveFormatForFileName(targetName) ?? defaultFormatForSource(wasm.getSourceFormat());
}

export function captureVersionSnapshot(wasm: WasmBridge): CapturedVersionSnapshot {
  const compareSnapshot = buildSnapshotFromWasm(wasm, wasm.fileName, VERSION_COMPARE_OPTIONS);
  const bytes = exportVersionContent(wasm);
  const fingerprint = fingerprintBytes(bytes);
  return { bytes, fingerprint, compareSnapshot };
}

/** Export the same format-preserving payload used by checkpoints and dirty checks. */
export function exportVersionContent(wasm: WasmBridge): Uint8Array {
  return exportDraftContent(wasm).bytes;
}

/** 저장 대상 형식으로 내보내고, 실패해 HWP 로 대신 내보냈으면 실제 형식을 함께 알린다. */
export function exportDraftContent(wasm: WasmBridge): { bytes: Uint8Array; format: 'hml' | 'hwp' | 'hwpx' } {
  const format = currentSaveFormat(wasm);
  try {
    return { bytes: exportDocumentForFormat(wasm, format), format };
  } catch {
    return { bytes: wasm.exportHwp(), format: 'hwp' };
  }
}

export function fingerprintVersionContent(wasm: WasmBridge): ContentFingerprint {
  return fingerprintBytes(exportVersionContent(wasm));
}

export function analyzeVersionDiff(
  before: CompareDocumentSnapshot | null,
  after: CompareDocumentSnapshot,
): VersionDiffAnalysis {
  if (!before) {
    const added = after.paragraphs.length + after.controls.length;
    return {
      stats: { added, removed: 0, modified: 0 },
      titleSummary: {
        totals: { added: 1, removed: 0, modified: 0 },
        items: [{ change: 'added', objectType: 'document', heading: '버전 기록 시작' }],
      },
    };
  }
  const session = compareSnapshots(before, after, VERSION_COMPARE_OPTIONS);
  const stats = session.diffItems.reduce<VersionStats>((result, item) => {
    if (item.severity === 'added') result.added += 1;
    else if (item.severity === 'removed') result.removed += 1;
    else result.modified += 1;
    return result;
  }, { added: 0, removed: 0, modified: 0 });
  const totals = { ...stats };
  const items: CheckpointTitleSummary['items'] = [];
  for (const item of session.diffItems.slice(0, 12)) {
    const candidate = {
      change: item.severity,
      objectType: item.kind,
      heading: item.title.slice(0, 120),
      snippet: (item.rightPreview || item.leftPreview).slice(0, 220) || undefined,
    } as const;
    const next = [...items, candidate];
    if (new TextEncoder().encode(JSON.stringify({ totals, items: next })).byteLength > 4096) break;
    items.push(candidate);
  }
  return { stats, titleSummary: { totals, items } };
}

export function calculateVersionStats(
  before: CompareDocumentSnapshot | null,
  after: CompareDocumentSnapshot,
): VersionStats {
  return analyzeVersionDiff(before, after).stats;
}

export function compactVersionDiff(
  before: CompareDocumentSnapshot | null,
  after: CompareDocumentSnapshot,
): string[] {
  if (!before) return ['문서 버전 기록 시작'];
  return compareSnapshots(before, after, VERSION_COMPARE_OPTIONS).diffItems
    .slice(0, 12)
    .map((item) => {
      const location = item.path.paragraph === undefined
        ? `구역 ${item.path.section + 1}`
        : `구역 ${item.path.section + 1}, 문단 ${item.path.paragraph + 1}`;
      const preview = item.rightPreview || item.leftPreview;
      return `${item.severity} ${item.kind} · ${location} · ${item.title}${preview ? ` · ${preview}` : ''}`;
    });
}

export function buildCheckpointTitleSummary(
  before: CompareDocumentSnapshot | null,
  after: CompareDocumentSnapshot,
): CheckpointTitleSummary {
  return analyzeVersionDiff(before, after).titleSummary;
}

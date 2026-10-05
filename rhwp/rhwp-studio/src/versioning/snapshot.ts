import { exportDocumentForFormat } from '../command/save-document-format.ts';
import { defaultFormatForSource, saveFormatForFileName } from '../command/save-target.ts';
import { buildSnapshotFromWasm, compareSnapshots } from '../compare/diff-engine.ts';
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

export interface CapturedVersionSnapshot {
  bytes: Uint8Array;
  fingerprint: ContentFingerprint;
  compareSnapshot: CompareDocumentSnapshot;
}

/** One editor revision owns one export, shared by dirty checks and checkpoints. */
export class VersionSnapshotCache {
  #key: string | null = null;
  #content: { bytes: Uint8Array; fingerprint: ContentFingerprint } | null = null;
  #snapshot: CapturedVersionSnapshot | null = null;

  clear(): void {
    this.#key = null;
    this.#content = null;
    this.#snapshot = null;
  }

  invalidateUnless(fingerprint: string): void {
    if (this.#content?.fingerprint !== fingerprint) this.clear();
  }

  #getContent(wasm: WasmBridge, documentId: string | null, revision: number) {
    const key = JSON.stringify([documentId, revision, currentSaveFormat(wasm), wasm.fileName, wasm.getSourceFormat()]);
    if (this.#key !== key || !this.#content) {
      const bytes = exportVersionContent(wasm);
      this.#content = { bytes, fingerprint: fingerprintBytes(bytes) };
      this.#key = key;
      this.#snapshot = null;
    }
    return this.#content;
  }

  fingerprint(wasm: WasmBridge, documentId: string | null, revision: number): ContentFingerprint {
    return this.#getContent(wasm, documentId, revision).fingerprint;
  }

  capture(wasm: WasmBridge, documentId: string | null, revision: number): CapturedVersionSnapshot {
    const content = this.#getContent(wasm, documentId, revision);
    // 실시간 캡처(로드/저장 직후 베이스라인·더티 추적)는 강제 전체 재조판을 건너뛴다.
    // 대형 문서에서 한 번의 재조판이 입력을 수 분간 멈추게 하며, 백그라운드에서
    // 진행 중인 지연 조판을 통째로 무효화한다.
    return this.#snapshot ??= {
      ...content,
      compareSnapshot: buildSnapshotFromWasm(
        wasm, wasm.fileName, { ...VERSION_COMPARE_OPTIONS, refreshLayout: false },
      ),
    };
  }
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
  const format = currentSaveFormat(wasm);
  try {
    return exportDocumentForFormat(wasm, format);
  } catch {
    return wasm.exportHwp();
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

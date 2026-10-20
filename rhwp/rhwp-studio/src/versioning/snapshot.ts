import { exportDocumentForFormat } from '../command/save-document-format.ts';
import { defaultFormatForSource, saveFormatForFileName } from '../command/save-target.ts';
import { buildSnapshotFromWasm, buildSnapshotFromWasmInSlices, compareSnapshots } from '../compare/diff-engine.ts';
import type { CompareDocumentSnapshot, CompareOptions } from '../compare/types.ts';
import type { WasmBridge } from '../core/wasm-bridge.ts';
import type { CheckpointTitleSummary } from '../agent/types.ts';
import { engineMutationEpoch } from '../core/engine-trap.ts';
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
  /** #fingerprint 를 낸 내보내기 직전의 엔진 변경 번호. 그 뒤로 엔진을 바꾼 호출이 없으면 다시 내보내도 같다. */
  #contentEpoch = -1;
  /** 비교 스냅샷. 바이트 없이도 만든다(커밋 전 diff). 바이트는 커밋할 때에야 내보낸다. */
  #snapshot: CompareDocumentSnapshot | null = null;
  /** #snapshot 을 다 만든 뒤의 엔진 변경 번호. */
  #snapshotEpoch = -1;
  /** 바이트와 비교 스냅샷을 묶은 마지막 캡처. 같은 둘이면 같은 객체를 돌려준다. */
  #captured: CapturedVersionSnapshot | null = null;
  #releaseTimer: ReturnType<typeof setTimeout> | null = null;

  clear(): void {
    this.#key = null;
    this.#fingerprint = null;
    this.#contentEpoch = -1;
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
    this.#captured = null;
  }

  #compose(content: VersionContent, compareSnapshot: CompareDocumentSnapshot): CapturedVersionSnapshot {
    const captured = this.#captured;
    if (captured && captured.bytes === content.bytes && captured.compareSnapshot === compareSnapshot) return captured;
    return this.#captured = { ...content, compareSnapshot };
  }

  #scheduleRelease(): void {
    if (this.#releaseTimer !== null) clearTimeout(this.#releaseTimer);
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = null;
      this.#content = null;
      this.#snapshot = null;
      this.#captured = null;
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
      this.#contentEpoch = engineMutationEpoch();
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
    // 내보낸 뒤로 어떤 엔진 쓰기도 없었으면 같은 바이트가 나온다. 큰 문서는 내보내기만 1초 넘게 걸린다.
    if (this.#content && this.#contentEpoch === engineMutationEpoch()) {
      this.#scheduleRelease();
      return this.#content;
    }
    const epoch = engineMutationEpoch();
    const bytes = exportVersionContent(wasm);
    this.#contentEpoch = epoch;
    let content = this.#content;
    if (!content || !sameBytes(content.bytes, bytes)) {
      const fingerprint = fingerprintBytes(bytes);
      // 바이트 없이 만든 스냅샷은 그 뒤로 엔진이 그대로였을 때만 이 바이트의 것이다.
      const sameContent = this.#fingerprint === null ? this.#snapshotEpoch === epoch : fingerprint === this.#fingerprint;
      if (!sameContent) this.#snapshot = null;
      content = { bytes, fingerprint };
      this.#content = content;
      this.#fingerprint = fingerprint;
    }
    this.#scheduleRelease();
    return content;
  }

  /**
   * 내보내지 않고 아는 지문. 이 revision 에서 낸 지문이 있고 그 뒤로 어떤 엔진 쓰기도 없었을 때만 돌려준다.
   */
  knownFingerprint(wasm: WasmBridge, documentId: string | null, revision: number): ContentFingerprint | null {
    this.#select(wasm, documentId, revision);
    return this.#fingerprint !== null && this.#contentEpoch === engineMutationEpoch() ? this.#fingerprint : null;
  }

  /**
   * 커밋 전 diff 용 비교 스냅샷. 바이트를 내보내지 않는다. 만든 뒤로 엔진이 바뀌었으면 다시 만들고, 그때
   * 앞서 낸 바이트와 지문도 버린다(커밋할 때 다시 내보낸다). 그사이 문서가 바뀌면 null.
   */
  async compareSnapshotInSlices(
    wasm: WasmBridge,
    documentId: string | null,
    revision: number,
    isCurrent: () => boolean,
  ): Promise<CompareDocumentSnapshot | null> {
    this.#select(wasm, documentId, revision);
    const epoch = engineMutationEpoch();
    if (this.#fingerprint !== null && this.#contentEpoch !== epoch) {
      this.#fingerprint = null;
      this.#contentEpoch = -1;
      this.#content = null;
    }
    if (this.#snapshot && this.#snapshotEpoch === epoch) {
      this.#scheduleRelease();
      return this.#snapshot;
    }
    const key = this.#key;
    const compareSnapshot = await buildSnapshotFromWasmInSlices(wasm, wasm.fileName, LIVE_COMPARE_OPTIONS, isCurrent);
    if (!compareSnapshot) return null;
    // 만드는 동안 엔진이 바뀌었으면 어느 내용의 스냅샷인지 알 수 없으므로 기억하지 않는다.
    if (this.#key === key && engineMutationEpoch() === epoch) {
      this.#snapshot = compareSnapshot;
      this.#snapshotEpoch = epoch;
      this.#scheduleRelease();
    }
    return compareSnapshot;
  }

  fingerprint(wasm: WasmBridge, documentId: string | null, revision: number): ContentFingerprint {
    this.#select(wasm, documentId, revision);
    return this.#fingerprint ?? this.content(wasm, documentId, revision).fingerprint;
  }

  capture(wasm: WasmBridge, documentId: string | null, revision: number): CapturedVersionSnapshot {
    const content = this.content(wasm, documentId, revision);
    if (!this.#snapshot) {
      this.#snapshot = buildSnapshotFromWasm(wasm, wasm.fileName, LIVE_COMPARE_OPTIONS);
      this.#snapshotEpoch = engineMutationEpoch();
    }
    return this.#compose(content, this.#snapshot);
  }

  /** `capture`와 같은 캡처를 입력을 막지 않게 조각으로 나눠 만든다. 그사이 문서가 바뀌면 null. */
  async captureInSlices(
    wasm: WasmBridge,
    documentId: string | null,
    revision: number,
    isCurrent: () => boolean,
  ): Promise<CapturedVersionSnapshot | null> {
    const content = this.content(wasm, documentId, revision);
    if (this.#snapshot) return this.#compose(content, this.#snapshot);
    const key = this.#key;
    const compareSnapshot = await buildSnapshotFromWasmInSlices(wasm, wasm.fileName, LIVE_COMPARE_OPTIONS, isCurrent);
    if (!compareSnapshot) return null;
    if (this.#key !== key) return { ...content, compareSnapshot };
    this.#content ??= content;
    if (!this.#snapshot) {
      this.#snapshot = compareSnapshot;
      this.#snapshotEpoch = engineMutationEpoch();
    }
    this.#scheduleRelease();
    return this.#compose(this.#content, this.#snapshot);
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left === right) return true;
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

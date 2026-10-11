import type { AutosaveDataFormat, AutosaveDraftSummary } from './autosave-store.ts';

/** documentId 가 없는 draft 는 v3 이전에 만든 것이다. 바이트는 항상 HWP 이고 원본과 연결되지 않는다. */
export function isLegacyDraft(draft: Pick<AutosaveDraftSummary, 'documentId'>): boolean {
  return !draft.documentId;
}

export function draftDataFormat(draft: Pick<AutosaveDraftSummary, 'dataFormat'>): AutosaveDataFormat {
  return draft.dataFormat ?? 'hwp';
}

export function formatDraftSavedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '저장 시각 알 수 없음';
  return new Date(timestamp).toLocaleString('ko-KR');
}

export function formatDraftSize(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) return '크기 알 수 없음';
  if (byteLength < 1024) return `${byteLength} B`;
  const kb = byteLength / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function describeDraft(draft: AutosaveDraftSummary): string {
  const format = draft.sourceFormat.toUpperCase();
  // 예전 draft 는 HWP 로만 저장했다. 다른 형식에서 온 draft 는 HWP 로 열린다.
  const suffix = isLegacyDraft(draft) && ['hwpx', 'hml'].includes(draft.sourceFormat.toLowerCase())
    ? ' → HWP'
    : '';
  return `${formatDraftSavedAt(draft.savedAt)} · ${formatDraftSize(draft.byteLength)} · ${format}${suffix}`;
}

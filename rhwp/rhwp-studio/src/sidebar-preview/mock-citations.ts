/**
 * 인용 칩 · PDF 강조 · @ 멘션 · 영역 조각 미리보기 장면 (`?citations=chat|pdf|picker|clip`).
 *
 * 프로젝트 열과 index.ts 연결 전이라 미리보기가 직접 붙인다. 칩·미리보기·멘션
 * 목록은 모두 제품 코드이고, 항목·조각·PDF 는 아래 고정 자료다. 조각은 허브
 * reference-extractor.mjs 로 fixtures/research-guideline.pdf 에서 뽑은 그대로다.
 * fixtures/care-survey-scan.pdf 는 글자 층이 없는 스캔본(쪽마다 JPEG 하나)이라 영역 조각으로만 인용한다.
 */

import pdfUrl from './fixtures/research-guideline.pdf?url';
import scanUrl from './fixtures/care-survey-scan.pdf?url';
import guideline from './fixtures/research-guideline.chunks.json';
import type {
  ProjectChunk,
  ProjectClipItem,
  ProjectFileItem,
  ProjectFileText,
  ProjectNote,
  ProjectNoteItem,
  ProjectOp,
  ProjectOpsResult,
  ProjectSnapshot,
} from '../agent/types.ts';
import { renderChatMarkdown, refreshCitations } from '../ui/agent-sidebar/chat-markdown.ts';
import { projectCitationTarget, type CitationHooks } from '../ui/agent-sidebar/wikilinks.ts';
import { clipThumbElement } from '../ui/agent-sidebar/project/clip-thumbs.ts';
import { createProjectPreview, type ProjectPreview, type ProjectPreviewDeps } from '../ui/agent-sidebar/project/project-preview.ts';
import { createMentionPicker, renderMentionPill } from '../ui/agent-sidebar/mention-picker.ts';

/* ── 고정 자료 — mock-projects.ts 와 id 를 맞춘다 ───────────── */

export const CITATION_FIXTURE_IDS = {
  project: 'pcitepreview',
  guideline: 'fq7k2m4',
  budgetNote: 'n5r2c7d',
  precedent: 'fw3x6ab',
  document: 'd4pj2ka',
  scan: 'fs4cann',
  tableClip: 'rq7m3kd',
  chartClip: 'rt4b2xy',
} as const;

const now = Date.UTC(2026, 9, 9, 3, 0, 0);

function fileItem(overrides: Partial<ProjectFileItem> & Pick<ProjectFileItem, 'id' | 'title' | 'fileKind'>): ProjectFileItem {
  return {
    kind: 'file', column: 'key', order: 0, tags: [], pinned: false, summary: '',
    createdAt: now - 86_400_000, updatedAt: now - 3_600_000,
    addedBy: { kind: 'user' }, fileId: `ref-${overrides.id}`, scope: 'project',
    originalName: overrides.title, mimeType: 'application/octet-stream', size: 120_000,
    status: 'ready', chunkCount: 1, source: { kind: 'upload' },
    librarian: { status: 'done' }, locked: {},
    ...overrides,
  };
}

const PRECEDENT_TEXT = [
  '2025년 선도기술 사업 결과 보고',
  '',
  '참여 기관 12곳 가운데 9곳이 목표를 달성했고, 기술이전 수입의 30%를 후속 연구에 다시 투자했다.',
  '중간평가에서 감액된 과제는 2건이며 모두 연구장비 공동 활용 계획이 미흡했다.',
].join('\n');

const BUDGET_NOTE = [
  '## 예산 정리',
  '',
  '- 연간 한도 3억 원, 최대 3년 [[fq7k2m4#c0|과제당 연간 지원 한도는 3억 원]]',
  '- 민간 부담금 20% 이상, 중소기업 주관이면 10%',
  '- 간접비는 직접비의 15% 이내',
  '',
  '선행 사례: [[fw3x6ab#c0|기술이전 수입의 30%]]',
].join('\n');

export function citationProjectFixture(): ProjectSnapshot {
  const ids = CITATION_FIXTURE_IDS;
  const guidelineItem = fileItem({
    id: ids.guideline, title: '연구개발 운영 지침.pdf', fileKind: 'pdf', mimeType: 'application/pdf',
    originalName: 'research-guideline.pdf', chunkCount: guideline.chunks.length, pageCount: guideline.pages.length,
    tags: ['지침'], pinned: true,
  });
  const precedent = fileItem({
    id: ids.precedent, title: '2025 선도기술 결과 보고.docx', fileKind: 'docx', column: 'review', tags: ['사례'],
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
  const note: ProjectNoteItem = {
    id: ids.budgetNote, kind: 'note', title: '예산 메모', column: 'key', order: 1, tags: ['예산'], pinned: false,
    summary: '', createdAt: now - 7_200_000, updatedAt: now - 600_000, addedBy: { kind: 'agent', agent: 'claude' },
    bytes: BUDGET_NOTE.length,
  };
  const scan = fileItem({
    id: ids.scan, title: '2025 돌봄 실태조사 부록 스캔.pdf', fileKind: 'pdf', mimeType: 'application/pdf', column: 'review',
    originalName: 'care-survey-scan.pdf', chunkCount: 0, pageCount: 2, size: 78_733, tags: ['통계'],
  });
  const clip = (overrides: Pick<ProjectClipItem, 'id' | 'title' | 'page' | 'rect' | 'column' | 'order'> & Partial<ProjectClipItem>): ProjectClipItem => ({
    kind: 'clip', tags: [], pinned: false, summary: '', createdAt: now - 5_400_000, updatedAt: now - 1_800_000,
    addedBy: { kind: 'user' }, sourceId: ids.scan, ...overrides,
  });
  const tableClip = clip({
    id: ids.tableClip, title: '시군구 유형별 이용 표', page: 1, rect: [0.085, 0.288, 0.83, 0.186], column: 'inbox', order: -2, tags: ['통계'],
  });
  const chartClip = clip({
    id: ids.chartClip, title: '돌봄 인력 수급 전망 그림', page: 2, rect: [0.085, 0.13, 0.83, 0.318], column: 'inbox', order: -1,
    addedBy: { kind: 'agent', agent: 'claude' },
  });
  return {
    id: ids.project, name: '연구개발 제안서', goal: '2027 지원사업 제안서 작성', implicit: false, revision: 7,
    columns: [{ id: 'inbox', name: '수집함' }, { id: 'review', name: '검토 중' }, { id: 'key', name: '핵심' }, { id: 'hold', name: '보류' }],
    tags: [{ name: '지침', color: '#5b8fd4' }, { name: '예산', color: '#c4785a' }, { name: '사례', color: '#4a9a86' }],
    members: [{ documentId: 'preview-proposal', nodeId: ids.document, name: '사업 제안서.hwpx' }],
    items: [guidelineItem, note, precedent, scan, tableClip, chartClip],
    links: [
      { id: 'lclipa2b3', from: ids.tableClip, to: ids.scan, origin: 'clip' },
      { id: 'lclipc4d5', from: ids.chartClip, to: ids.scan, origin: 'clip' },
    ],
    graph: { pinned: {} },
    librarian: { state: 'idle', queued: 0, running: 0 },
    usage: { files: 3, bytes: 330_000 },
  };
}

export const CITATION_ANSWER = [
  '지침에서 제안서에 바로 쓸 조건을 정리했습니다.',
  '',
  '- 과제당 연간 한도는 **3억 원**, 기간은 최대 3년입니다 [[fq7k2m4#c0|과제당 연간 지원 한도는 3억 원]].',
  '- 중간평가 달성도가 60%에 못 미치면 협약 해지나 감액 대상입니다 [[fq7k2m4#c1|목표 달성도가 60% 미만인 과제는]].',
  '- 성과물은 종료 후 3개월 안에 등록합니다 [[fq7k2m4#p3]].',
  '',
  '예산 근거는 [[n5r2c7d]]에, 재투자 사례는 [[fw3x6ab#c0|기술이전 수입의 30%]]에 모았습니다. [[f2zzzzz]]는 휴지통으로 옮겨진 자료입니다.',
].join('\n');

/** 스캔본의 표·그림을 영역 조각으로 인용한 답변. 칩 바로 뒤의 마침표가 칩과 한 줄에 남는다. */
export const CLIP_ANSWER = [
  '스캔본이라 글자는 읽을 수 없어 그림으로 확인했습니다.',
  '',
  '- 군 지역의 돌봄 공백은 25.8%로 가장 높습니다 [[rq7m3kd]].',
  '- 2030년 수요는 공급보다 약 2만 4천 명 많습니다 [[rt4b2xy|인력 전망 그림]].',
  '',
  '두 조각 모두 제안서 3장의 근거로 넣을 수 있습니다.',
].join('\n');

/* ── 서비스 흉내 ─────────────────────────────────────────── */

export function createCitationService(project: ProjectSnapshot): ProjectPreviewDeps['service'] {
  let noteBody = BUDGET_NOTE;
  const ids = CITATION_FIXTURE_IDS;
  return {
    async fileBlob(_projectId, itemId) {
      const url = itemId === ids.guideline ? pdfUrl : itemId === ids.scan ? scanUrl : null;
      if (!url) throw new Error('no blob');
      const response = await fetch(url);
      return response.blob();
    },
    async chunk(_projectId, itemId, chunkId): Promise<ProjectChunk> {
      if (itemId === ids.precedent) {
        return { chunkId, page: null, start: 0, end: PRECEDENT_TEXT.length, text: PRECEDENT_TEXT };
      }
      const chunk = guideline.chunks.find((row) => row.id === chunkId);
      if (!chunk) throw new Error('no chunk');
      return { chunkId, page: chunk.page, start: chunk.start, end: chunk.end, text: chunk.text };
    },
    async fileText(_projectId, itemId, page): Promise<ProjectFileText> {
      if (itemId === ids.precedent) {
        return { page: null, text: PRECEDENT_TEXT, chunks: [{ id: 'c0', start: 0, end: PRECEDENT_TEXT.length }] };
      }
      if (itemId === ids.scan) return { page: page ?? 1, text: '', chunks: [] };
      const row = guideline.pages.find((entry) => entry.page === (page ?? 1)) ?? guideline.pages[0]!;
      return { page: row.page, text: row.text, chunks: [] };
    },
    async note(_projectId, noteId): Promise<ProjectNote> {
      return { id: noteId, title: '예산 메모', body: noteBody };
    },
    async applyOps(_projectId, ops: ProjectOp[]): Promise<ProjectOpsResult> {
      for (const op of ops) if (op.op === 'note' && op.id === ids.budgetNote) noteBody = op.body;
      project.revision += 1;
      return { revision: project.revision, applied: ops.length, created: {}, unresolvedLinks: [] };
    },
  };
}

export function citationHooks(
  project: () => ProjectSnapshot | null,
  open: CitationHooks['openCitation'],
  service: Pick<ProjectPreviewDeps['service'], 'fileBlob'> | null = null,
): CitationHooks {
  return {
    resolveItem: (id) => projectCitationTarget(project(), id),
    openCitation: open,
    chunkPage: (id, n) => (id === CITATION_FIXTURE_IDS.guideline
      ? guideline.chunks.find((row) => row.id === `c${n}`)?.page ?? null
      : null),
    clipThumb: (clip, source) => {
      const current = project();
      return service && current
        ? clipThumbElement({ projectId: current.id, clip, source, size: 'chip', load: service.fileBlob })
        : null;
    },
  };
}

/* ── 장면 ────────────────────────────────────────────────── */

interface PreviewHost {
  sidebar: { root: HTMLElement };
  snapshot(): { running: boolean };
  enterFocusMode(): Promise<void>;
}

const LAYER_STYLE = `
.preview-citation-layer { position: absolute; inset: 0; z-index: 40; display: flex; }
.preview-citation-layer[hidden] { display: none; }
.preview-citation-layer > .ag-pp { flex: 1; box-shadow: var(--ag-elev-sheet); }
`;

async function until<T>(read: () => T | null | false | undefined, timeout = 10_000): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error('citation scene timed out');
}

/** 사이드바 위에 미리보기 면을 띄운다. 실제 앱에서는 프로젝트 열 안에 붙는다. */
function mountPreviewLayer(root: HTMLElement, project: ProjectSnapshot, service: ProjectPreviewDeps['service']): ProjectPreview['open'] {
  if (!document.querySelector('#preview-citation-style')) {
    const style = document.createElement('style');
    style.id = 'preview-citation-style';
    style.textContent = LAYER_STYLE;
    document.head.append(style);
  }
  const layer = document.createElement('div');
  layer.className = 'preview-citation-layer';
  layer.hidden = true;
  const preview = createProjectPreview({
    service,
    project: () => project,
    onClose: () => { layer.hidden = true; },
  });
  layer.append(preview.element);
  root.append(layer);
  return (request) => {
    layer.hidden = false;
    return preview.open(request);
  };
}

export async function mountCitationScenes(preview: PreviewHost, params: URLSearchParams): Promise<void> {
  const scene = params.get('citations');
  if (scene !== 'chat' && scene !== 'pdf' && scene !== 'picker' && scene !== 'clip') return;
  const root = preview.sidebar.root;
  const project = citationProjectFixture();
  const service = createCitationService(project);
  const openPreview = mountPreviewLayer(root, project, service);
  const hooks = citationHooks(() => project, (request) => {
    void openPreview({ itemId: request.id, anchor: request.anchor, quote: request.quote });
  }, service);

  if (scene === 'chat' || scene === 'clip') {
    // 표본 답변이 끝난 말풍선을 인용이 든 답변으로 다시 그린다. 렌더러와 말풍선은 제품 그대로다.
    const bubble = await until(() => {
      const bubbles = root.querySelectorAll<HTMLElement>('.ag-msg-assistant');
      return !preview.snapshot().running && bubbles.length ? bubbles[bubbles.length - 1] : null;
    });
    renderChatMarkdown(bubble, scene === 'clip' ? CLIP_ANSWER : CITATION_ANSWER, { citations: hooks });
    refreshCitations(bubble, hooks);
    // 영역 칩은 썸네일이 그려진 뒤에 준비된 것으로 본다.
    if (scene === 'clip') await until(() => bubble.querySelector('.ag-cite .ag-clip-thumb[data-state="ready"]'), 20_000);
  }

  if (scene === 'pdf') {
    await openPreview({ itemId: CITATION_FIXTURE_IDS.guideline, anchor: 'c1', quote: '목표 달성도가 60% 미만인 과제는' });
    await until(() => root.querySelector('.ag-pdf-hit'));
  }

  if (scene === 'picker') {
    const input = await until(() => {
      const element = root.querySelector<HTMLTextAreaElement>('.ag-input');
      return element && !element.disabled ? element : null;
    });
    const pills = document.createElement('div');
    pills.className = 'ag-msg-attachments preview-mention-pills';
    const picker = createMentionPicker({
      textarea: input,
      getItems: () => project.items,
      columnName: (id) => project.columns.find((column) => column.id === id)?.name ?? null,
      onPick: (item) => {
        pills.append(renderMentionPill(item));
        if (!pills.isConnected) input.closest('.ag-composer')?.prepend(pills);
      },
    });
    input.focus();
    input.value = '@';
    input.setSelectionRange(1, 1);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until(() => picker.isOpen());
  }
  document.body.dataset.citationsReady = 'true';
}

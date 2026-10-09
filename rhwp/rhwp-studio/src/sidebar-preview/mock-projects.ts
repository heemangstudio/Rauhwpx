/**
 * 연구 프로젝트 미리보기 픽스처와 메모리 안의 ProjectService.
 * 허브처럼 연산을 적용하고 revision 을 올린 뒤 150ms 뒤에 project-changed 를 보낸다.
 */
import {
  applyProjectOps,
  createProjectStore,
  defaultProjectSettings,
  normalizeProjectSettings,
  ProjectRequestError,
  type ProjectClient,
  type ProjectService,
  type ProjectStore,
} from '../agent/project-service.ts';
import type {
  ProjectActivityEntry,
  ProjectActor,
  ProjectCapabilities,
  ProjectFileItem,
  ProjectFileKind,
  ProjectItem,
  ProjectLink,
  ProjectNoteItem,
  ProjectOp,
  ProjectSettings,
  ProjectSnapshot,
  ProjectSummary,
} from '../agent/types.ts';
import { citationProjectFixture, createCitationService } from './mock-citations.ts';

const HOUR = 3_600_000;

interface FileSeed {
  id: string;
  title: string;
  column: string;
  kind: ProjectFileKind;
  tags?: string[];
  pages?: number;
  size?: number;
  web?: string;
  summary?: string;
  librarian?: ProjectFileItem['librarian']['status'];
  failed?: boolean;
  pinned?: boolean;
  agent?: boolean;
}

interface NoteSeed {
  id: string;
  title: string;
  column: string;
  tags?: string[];
  summary?: string;
  pinned?: boolean;
}

const MIME: Record<ProjectFileKind, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  hwp: 'application/x-hwp',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
  image: 'image/png',
  text: 'text/plain',
  other: 'application/octet-stream',
};

const EXTENSION: Record<ProjectFileKind, string> = {
  pdf: 'pdf', docx: 'docx', hwp: 'hwp', pptx: 'pptx', xlsx: 'xlsx', html: 'html', image: 'png', text: 'txt', other: 'bin',
};

const FILES: FileSeed[] = [
  { id: 'fa2k7q', title: '2026 노인실태조사 결과보고서.pdf', column: 'key', kind: 'pdf', tags: ['통계'], pages: 412, size: 18_400_000, pinned: true, summary: '65세 이상 1만 명 표본. 돌봄 필요도와 이용 서비스, 가구 형태별 차이를 정리한 보고서.' },
  { id: 'fb3m2x', title: '지역사회 통합돌봄 기본계획.pdf', column: 'key', kind: 'pdf', tags: ['법령', '예산'], pages: 64, size: 3_200_000, summary: '2026–2030 통합돌봄 추진 방향과 재정 분담 원칙.' },
  { id: 'fc4n5r', title: '돌봄통합지원법 시행령 입법예고.hwp', column: 'key', kind: 'hwp', tags: ['법령'], pages: 22, size: 410_000, summary: '시·군·구 통합지원협의체 구성과 개인별 지원계획 수립 절차.' },
  { id: 'fd5p6s', title: '일본 지역포괄케어 운영 사례.pdf', column: 'review', kind: 'pdf', tags: ['해외 사례'], pages: 38, size: 2_100_000, summary: '중학교 학군 단위 지역포괄지원센터의 인력·예산 구조.' },
  { id: 'fe6q7t', title: '스웨덴 재가돌봄 개혁 평가.pdf', column: 'review', kind: 'pdf', tags: ['해외 사례'], pages: 51, size: 2_800_000 },
  { id: 'ff7r2u', title: '시도별 돌봄 예산 집행 현황.xlsx', column: 'review', kind: 'xlsx', tags: ['예산', '통계'], size: 240_000, summary: '17개 시도의 2023–2025 재가·시설 돌봄 예산과 집행률.' },
  { id: 'fg2s3v', title: '복지부 정책설명회 발표자료.pptx', column: 'review', kind: 'pptx', tags: ['법령'], pages: 31, size: 6_400_000, agent: true },
  { id: 'fh3t4w', title: '돌봄 공백 실태 기사 — 한겨레', column: 'review', kind: 'html', tags: ['인터뷰'], size: 64_000, web: 'https://www.hani.co.kr/', agent: true, summary: '퇴원 직후 2주 사이의 돌봄 공백을 다룬 현장 기사.' },
  { id: 'fi4u5x', title: '보건사회연구원 이슈앤포커스 461호.pdf', column: 'inbox', kind: 'pdf', pages: 12, size: 900_000, librarian: 'running' },
  { id: 'fj5v6y', title: 'scan_0412.pdf', column: 'inbox', kind: 'pdf', pages: 4, size: 1_300_000, librarian: 'queued' },
  { id: 'fk6w7z', title: '통합돌봄 선도사업 중간평가.docx', column: 'inbox', kind: 'docx', tags: ['예산'], pages: 28, size: 520_000, librarian: 'queued' },
  { id: 'fl7x2a', title: '방문간호 이용자 인터뷰 녹취.docx', column: 'inbox', kind: 'docx', tags: ['인터뷰'], pages: 17, size: 180_000 },
  { id: 'fm2y3b', title: '돌봄 인력 수급 전망 그래프.png', column: 'inbox', kind: 'image', tags: ['통계'], size: 340_000 },
  { id: 'fn3z4c', title: 'OECD Long-term Care Report 2025.pdf', column: 'hold', kind: 'pdf', tags: ['해외 사례', '통계'], pages: 186, size: 9_700_000 },
  { id: 'fo4a5d', title: '읽기 실패한 스캔본.pdf', column: 'hold', kind: 'pdf', size: 2_000_000, failed: true },
  { id: 'fp5b6e', title: '광역 돌봄 콜센터 운영 매뉴얼.hwp', column: 'hold', kind: 'hwp', pages: 40, size: 760_000 },
  { id: 'fq6c7f', title: '재가급여 이용 통계 2025.xlsx', column: 'key', kind: 'xlsx', tags: ['통계'], size: 410_000 },
  { id: 'fr7d2g', title: '네덜란드 뷔르트조르흐 모델 소개', column: 'review', kind: 'html', tags: ['해외 사례'], size: 52_000, web: 'https://www.buurtzorg.com/' },
];

const NOTES: NoteSeed[] = [
  { id: 'na3e4h', title: '핵심 주장 세 줄', column: 'key', tags: ['예산'], pinned: true, summary: '퇴원 후 2주 공백을 줄이는 것이 첫 과제. 근거는 실태조사 7장과 일본 사례.' },
  { id: 'nb4f5i', title: '해외 사례 비교 메모', column: 'review', tags: ['해외 사례'], summary: '일본·스웨덴·네덜란드의 인력 구조와 재정 분담 비교.' },
  { id: 'nc5g6j', title: '인터뷰에서 나온 공백 유형', column: 'review', tags: ['인터뷰'] },
  { id: 'nd6h7k', title: '예산 근거 정리', column: 'key', tags: ['예산', '통계'] },
  { id: 'ne7i2l', title: '목차 초안', column: 'inbox' },
  { id: 'nf2j3m', title: '확인할 숫자 목록', column: 'hold', tags: ['통계'] },
  { id: 'ng3k4n', title: '정책 제언 아이디어', column: 'inbox' },
];

const MEMBERS = [
  { documentId: 'preview-proposal', nodeId: 'dq7r2s', name: '사업 제안서.hwpx' },
  { documentId: 'preview-notes', nodeId: 'dr2s3t', name: '회의록.hwpx' },
];

const LINK_PAIRS: Array<[string, string, string?]> = [
  ['na3e4h', 'fa2k7q', '인용'], ['na3e4h', 'fd5p6s', '인용'], ['na3e4h', 'nd6h7k'], ['nb4f5i', 'fd5p6s'], ['nb4f5i', 'fe6q7t'],
  ['nb4f5i', 'fr7d2g'], ['nb4f5i', 'fn3z4c'], ['nc5g6j', 'fl7x2a', '인용'], ['nc5g6j', 'fh3t4w'], ['nd6h7k', 'ff7r2u', '인용'],
  ['nd6h7k', 'fq6c7f'], ['nd6h7k', 'fb3m2x'], ['fb3m2x', 'fc4n5r', '근거'], ['fg2s3v', 'fb3m2x'], ['fk6w7z', 'fb3m2x'],
  ['dq7r2s', 'na3e4h'], ['dq7r2s', 'fb3m2x', '인용'], ['dq7r2s', 'fa2k7q', '인용'], ['dq7r2s', 'nd6h7k'], ['dr2s3t', 'nc5g6j'],
  ['ne7i2l', 'na3e4h'], ['ng3k4n', 'nb4f5i'], ['fm2y3b', 'fa2k7q'], ['nf2j3m', 'fa2k7q', '반박'], ['nf2j3m', 'ff7r2u'],
];

export function sampleProject(now = Date.now()): ProjectSnapshot {
  const orderByColumn = new Map<string, number>();
  const nextOrder = (column: string) => {
    const order = orderByColumn.get(column) ?? 0;
    orderByColumn.set(column, order + 1);
    return order;
  };
  const items: ProjectItem[] = [];
  FILES.forEach((seed, index) => {
    const at = now - (index + 1) * 5 * HOUR;
    const file: ProjectFileItem = {
      id: seed.id,
      kind: 'file',
      title: seed.title,
      column: seed.column,
      order: nextOrder(seed.column),
      tags: seed.tags ?? [],
      pinned: seed.pinned ?? false,
      summary: seed.summary ?? '',
      createdAt: at,
      updatedAt: at + HOUR,
      addedBy: seed.agent ? { kind: 'agent', agent: 'Claude' } : { kind: 'user' },
      fileId: `ref-${seed.id}`,
      scope: 'project',
      originalName: seed.web ? `${seed.title}.html` : `${seed.title.replace(/\.[a-z]+$/, '')}.${EXTENSION[seed.kind]}`,
      mimeType: MIME[seed.kind],
      size: seed.size ?? 100_000,
      fileKind: seed.kind,
      status: seed.failed ? 'failed' : 'ready',
      chunkCount: Math.max(1, Math.round((seed.pages ?? 2) * 1.5)),
      ...(seed.pages ? { pageCount: seed.pages } : {}),
      source: seed.web ? { kind: 'web', url: seed.web, finalUrl: seed.web } : { kind: 'upload' },
      librarian: { status: seed.failed ? 'failed' : seed.librarian ?? 'done', ...(seed.failed ? { error: '텍스트를 찾지 못했습니다.' } : {}) },
      locked: {},
    };
    items.push(file);
  });
  NOTES.forEach((seed, index) => {
    const at = now - (index + 2) * 3 * HOUR;
    const note: ProjectNoteItem = {
      id: seed.id,
      kind: 'note',
      title: seed.title,
      column: seed.column,
      order: nextOrder(seed.column),
      tags: seed.tags ?? [],
      pinned: seed.pinned ?? false,
      summary: seed.summary ?? '',
      createdAt: at,
      updatedAt: at + HOUR / 2,
      addedBy: { kind: 'agent', agent: 'Claude' },
      bytes: 1800 + index * 420,
    };
    items.push(note);
  });
  const links: ProjectLink[] = LINK_PAIRS.map(([from, to, label], index) => ({
    id: `l${String(index).padStart(2, '0')}a2b3c4d`.slice(0, 9),
    from,
    to,
    origin: from.startsWith('n') ? 'note' : 'explicit',
    ...(label ? { label } : {}),
    ...(from.startsWith('n') ? { noteId: from } : {}),
  }));
  return {
    id: 'pk3m7q2x9za',
    name: '지역 돌봄 정책 연구',
    goal: '2027 지역 돌봄 통합지원 사업 제안서의 근거 정리',
    implicit: false,
    revision: 42,
    columns: [
      { id: 'inbox', name: '수집함' },
      { id: 'review', name: '검토 중' },
      { id: 'key', name: '핵심' },
      { id: 'hold', name: '보류' },
    ],
    tags: [
      { name: '통계', color: '#379cff' },
      { name: '법령', color: '#e7ae45' },
      { name: '해외 사례', color: '#cb79d7' },
      { name: '예산', color: '#53bdab' },
      { name: '인터뷰', color: '#ed8592' },
    ],
    members: MEMBERS.map((member) => ({ ...member })),
    items,
    links,
    graph: { pinned: { dq7r2s: [0, 0] } },
    librarian: { state: 'running', queued: 2, running: 1 },
    usage: { files: FILES.length, bytes: FILES.reduce((sum, seed) => sum + (seed.size ?? 100_000), 0) },
  };
}

function sampleActivity(now: number): ProjectActivityEntry[] {
  const entry = (id: string, minutes: number, actor: ProjectActor, summary: string, inverse: ProjectOp[] = [{ op: 'goal', body: '' }]): ProjectActivityEntry => ({
    id, at: now - minutes * 60_000, actor, summary, ops: [], inverse,
  });
  return [
    entry('a8', 2, { kind: 'librarian' }, '“scan_0412.pdf” 정리 대기'),
    entry('a7', 6, { kind: 'librarian' }, '“보건사회연구원 이슈앤포커스 461호.pdf”에 태그 2개'),
    entry('a6', 18, { kind: 'agent', agent: 'Claude' }, '노트 “핵심 주장 세 줄” 작성, 연결 3개'),
    entry('a5', 41, { kind: 'user' }, '“일본 지역포괄케어 운영 사례.pdf”를 검토 중으로 옮김'),
    entry('a4', 95, { kind: 'agent', agent: 'Claude' }, '웹 자료 2개 가져옴'),
    entry('a3', 240, { kind: 'librarian' }, '파일 6개 이름 정리, 핵심 3개 분류'),
    entry('a2', 1440, { kind: 'user' }, '열 “보류” 추가'),
    entry('a1', 2880, { kind: 'user' }, '프로젝트 만듦', []),
  ];
}

function inverseOf(project: ProjectSnapshot, op: ProjectOp): ProjectOp[] {
  const item = 'id' in op && op.id ? project.items.find((entry) => entry.id === op.id) : undefined;
  switch (op.op) {
    case 'rename': return item ? [{ op: 'rename', id: item.id, name: item.title }] : [];
    case 'tag': return item ? [{ op: 'tag', id: item.id, tags: [...item.tags], mode: 'set' }] : [];
    case 'move': return item?.column ? [{ op: 'move', id: item.id, column: item.column, index: item.order }] : [];
    case 'pin': return item ? [{ op: 'pin', id: item.id, pinned: item.pinned }] : [];
    case 'goal': return [{ op: 'goal', body: project.goal }];
    case 'columns': return [{ op: 'columns', columns: project.columns.map((column) => ({ ...column })) }];
    case 'trash': return [{ op: 'restore', id: op.id }];
    case 'restore': return [{ op: 'trash', id: op.id }];
    default: return [];
  }
}

function summarize(project: ProjectSnapshot, ops: ProjectOp[]): string {
  const [first] = ops;
  const title = (id: string) => project.items.find((item) => item.id === id)?.title ?? id;
  if (ops.length > 1 && first.op === 'trash') return `${ops.length}개 항목을 휴지통으로`;
  switch (first.op) {
    case 'move': return `“${title(first.id)}”을 ${project.columns.find((column) => column.id === first.column)?.name ?? ''}(으)로 옮김`;
    case 'rename': return `“${title(first.id)}” 이름 바꿈`;
    case 'trash': return `“${title(first.id)}”을 휴지통으로`;
    case 'restore': return `“${first.id}” 복원`;
    case 'goal': return '목표 고침';
    case 'columns': return '열 바꿈';
    case 'graph-pin': return `“${title(first.id)}” 그래프 위치 고정`;
    case 'graph-unpin': return `“${title(first.id)}” 그래프 고정 풀림`;
    default: return `${ops.length}개 변경`;
  }
}

export interface PreviewProjects extends ProjectClient {
  /** 브라우저 미리보기에서도 홈 폴더 검색 줄을 켜 볼 수 있다. */
  setHomeAccess(enabled: boolean): void;
}

export function createPreviewProjects(options: { homeAccess?: boolean; latencyMs?: number } = {}): PreviewProjects {
  const latency = options.latencyMs ?? 120;
  const now = Date.now();
  let project = sampleProject(now);
  // 인용 칩 장면의 PDF·노트·문서도 같은 프로젝트에 둔다 — 답변의 칩이 칸과 미리보기로 이어진다.
  const citations = citationProjectFixture();
  const citationIds = new Set(citations.items.map((item) => item.id));
  const citationService = createCitationService(citations);
  project = {
    ...project,
    // 영역 조각은 수집함 맨 위에 두어 보드 장면에서 바로 보이게 한다.
    items: [...project.items, ...citations.items.map((item, index) => ({ ...item, order: item.kind === 'clip' ? item.order : 100 + index }))],
    links: [...project.links, ...citations.links],
    tags: [...project.tags, ...citations.tags.filter((tag) => !project.tags.some((known) => known.name === tag.name))],
  };
  let trashed: ProjectItem[] = [
    { ...project.items.find((item) => item.id === 'fp5b6e')!, id: 'fs2t4u', title: '중복 — 콜센터 매뉴얼 사본.hwp', trashedAt: now - 26 * HOUR },
    { ...project.items.find((item) => item.id === 'ne7i2l')!, id: 'nt3u5v', title: '지난 목차', trashedAt: now - 3 * 24 * HOUR },
  ];
  let activity = sampleActivity(now);
  let settings: ProjectSettings = defaultProjectSettings();
  let capabilities: ProjectCapabilities = { homeAccess: options.homeAccess ?? false, platform: 'browser' };
  const others: ProjectSummary[] = [
    { id: 'pa7b2c3d4ef', name: '', implicit: true, members: [{ documentId: 'preview-notes', nodeId: 'dr2s3t', name: '회의록.hwpx' }], usage: { files: 3, bytes: 2_400_000 }, updatedAt: now - 30 * HOUR },
    { id: 'pz2y3x4w5vu', name: '2026 연차보고서', implicit: false, members: [], usage: { files: 41, bytes: 128_000_000 }, updatedAt: now - 9 * 24 * HOUR },
  ];
  let counter = 0;
  let emitTimer: ReturnType<typeof setTimeout> | null = null;
  const wait = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), latency));
  const base32 = 'abcdefghijklmnopqrstuvwxyz234567';
  const newId = (prefix: string, length = 6) => {
    counter += 1;
    let seed = Date.now() + counter * 7919;
    let id = prefix;
    for (let index = 0; index < length; index++) {
      id += base32[seed % 32];
      seed = Math.floor(seed / 32) + counter * 31;
    }
    return id;
  };

  // 서비스를 만든 뒤 채운다. emit 은 그 뒤에만 불린다.
  let store!: ProjectStore;

  function emit(): void {
    if (emitTimer) clearTimeout(emitTimer);
    emitTimer = setTimeout(() => {
      emitTimer = null;
      store.applyEvent({ type: 'project-changed', projectId: project.id, revision: project.revision, project });
    }, 150);
  }

  function requireProject(projectId: string): void {
    if (projectId !== project.id) throw new ProjectRequestError('PROJECT_NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
  }

  function commit(ops: ProjectOp[], actor: ProjectActor): { revision: number; created: Record<number, string> } {
    const before = project;
    for (const op of ops) {
      if ('id' in op && op.id && ['rename', 'tag', 'move', 'pin', 'trash', 'graph-pin', 'graph-unpin'].includes(op.op)
        && !before.items.some((item) => item.id === op.id) && !before.members.some((member) => member.nodeId === op.id)) {
        throw new ProjectRequestError('PROJECT_ITEM_NOT_FOUND', `항목 ${op.id}을 찾을 수 없습니다.`, 404);
      }
    }
    const inverse = ops.flatMap((op) => inverseOf(before, op)).reverse();
    for (const op of ops) {
      if (op.op === 'trash') {
        // 파일을 버리면 그 파일의 영역도 함께 휴지통으로 간다 (허브와 같다).
        const gone = before.items.filter((entry) => entry.id === op.id || (entry.kind === 'clip' && entry.sourceId === op.id));
        trashed = [...gone.map((item) => ({ ...item, trashedAt: Date.now() })), ...trashed];
      }
    }
    let next = applyProjectOps(before, ops, { tempId: () => newId('l', 8) });
    for (const op of ops) {
      if (op.op !== 'restore') continue;
      const item = trashed.find((entry) => entry.id === op.id);
      if (!item) continue;
      const back = trashed.filter((entry) => entry.id === op.id
        || (entry.kind === 'clip' && entry.sourceId === op.id && entry.trashedAt === item.trashedAt));
      trashed = trashed.filter((entry) => !back.includes(entry));
      for (const entry of back) {
        const { trashedAt: _trashedAt, ...restored } = entry;
        next = { ...next, items: [...next.items, { ...restored, order: 999 } as ProjectItem] };
      }
    }
    // 낙관 적용이 만든 임시 노트·영역 id 를 허브 모양의 id 로 바꾸고, 만든 순서대로 연산 번호에 붙인다.
    const renamed = new Map<string, string>();
    next.items = next.items.map((item) => {
      if (!item.id.startsWith('tmp-') && !/^l[a-z2-7]{8}$/.test(item.id)) return item;
      const id = newId(item.kind === 'clip' ? 'r' : 'n');
      renamed.set(item.id, id);
      return { ...item, id };
    });
    next.links = next.links.map((link) => ({ ...link, from: renamed.get(link.from) ?? link.from, to: renamed.get(link.to) ?? link.to }));
    const fresh = [...renamed.values()];
    const created: Record<number, string> = {};
    ops.forEach((op, index) => {
      if ((op.op === 'note' || op.op === 'clip') && !op.id && fresh.length) created[index] = fresh.shift()!;
    });
    project = { ...next, revision: before.revision + 1 };
    if (!ops.every((op) => op.op === 'graph-pin' || op.op === 'graph-unpin') || activity.length < 40) {
      activity = [{ id: newId('a', 4), at: Date.now(), actor, summary: summarize(before, ops), ops, inverse }, ...activity];
    }
    emit();
    return { revision: project.revision, created };
  }

  function settleLibrarian(itemId: string): void {
    setTimeout(() => {
      store.applyEvent({
        type: 'project-librarian-status', projectId: project.id, state: 'running', queued: 0, running: 1,
        items: [{ id: itemId, status: 'running' }],
      });
    }, 900);
    setTimeout(() => {
      project = {
        ...project,
        revision: project.revision + 1,
        items: project.items.map((item) => item.id === itemId && item.kind === 'file'
          ? { ...item, librarian: { status: 'done' }, tags: item.tags.length ? item.tags : ['통계'] }
          : item),
        librarian: { ...project.librarian, running: Math.max(0, project.librarian.running - 1) },
      };
      emit();
    }, 2600);
  }

  const service: ProjectService = {
    current: () => wait(project),
    list: () => wait([
      { id: project.id, name: project.name, implicit: false, members: project.members, usage: project.usage, updatedAt: Date.now() },
      ...others,
    ]),
    async get(projectId, getOptions) {
      requireProject(projectId);
      return wait(getOptions?.trash ? { ...project, items: [...project.items, ...trashed] } : project);
    },
    async create(input) {
      return wait({ ...sampleProject(), id: newId('p', 10), name: input.name, items: [], links: [], revision: 1 });
    },
    async remove(projectId) {
      const index = others.findIndex((entry) => entry.id === projectId);
      if (index >= 0) others.splice(index, 1);
      await wait(null);
    },
    async applyOps(projectId, ops, opsOptions) {
      requireProject(projectId);
      await wait(null);
      const { revision, created } = commit(ops, opsOptions?.actor ?? { kind: 'user' });
      return { revision, applied: ops.length, created, unresolvedLinks: [] };
    },
    async undo(projectId, activityId) {
      requireProject(projectId);
      const entry = activity.find((candidate) => candidate.id === activityId);
      if (!entry) throw new ProjectRequestError('PROJECT_OP_INVALID', '기록을 찾을 수 없습니다.', 400);
      await wait(null);
      const applicable = entry.inverse.filter((op) => op.op !== 'goal' || entry.ops.length > 0);
      const revision = applicable.length ? commit(applicable, { kind: 'user' }).revision : project.revision;
      return { revision, applied: applicable.length, skipped: entry.inverse.length - applicable.length };
    },
    async activity(projectId) {
      requireProject(projectId);
      return wait(activity.slice(0, 50));
    },
    async uploadFile(projectId, file, uploadOptions) {
      requireProject(projectId);
      await wait(null);
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      const kind: ProjectFileKind = extension === 'pdf' ? 'pdf' : ['png', 'jpg', 'jpeg', 'webp'].includes(extension) ? 'image'
        : extension === 'docx' ? 'docx' : ['hwp', 'hwpx'].includes(extension) ? 'hwp' : 'text';
      const column = uploadOptions?.column ?? project.columns[0].id;
      const item: ProjectFileItem = {
        id: newId('f'), kind: 'file', title: file.name, column, order: 999, tags: [], pinned: false, summary: '',
        createdAt: Date.now(), updatedAt: Date.now(), addedBy: { kind: 'user' }, fileId: newId('ref-'), scope: 'project',
        originalName: file.name, mimeType: file.type || MIME[kind], size: file.size, fileKind: kind, status: 'ready',
        chunkCount: 1, source: { kind: 'upload' }, librarian: { status: 'queued' }, locked: {},
      };
      project = {
        ...project,
        revision: project.revision + 1,
        items: [...project.items, item],
        librarian: { state: 'running', queued: project.librarian.queued + 1, running: project.librarian.running },
        usage: { files: project.usage.files + 1, bytes: project.usage.bytes + file.size },
      };
      emit();
      settleLibrarian(item.id);
      return item;
    },
    async fileBlob(projectId, itemId) {
      if (citationIds.has(itemId)) return citationService.fileBlob(projectId, itemId);
      return wait(new Blob(['미리보기 픽스처'], { type: 'text/plain' }));
    },
    async chunk(projectId, itemId, chunkId) {
      if (citationIds.has(itemId)) return citationService.chunk(projectId, itemId, chunkId);
      return wait({ chunkId, page: 1, start: 0, end: 40, text: `${itemId} 의 예시 조각입니다.` });
    },
    async fileText(projectId, itemId, page) {
      if (citationIds.has(itemId)) return citationService.fileText(projectId, itemId, page);
      const item = project.items.find((entry) => entry.id === itemId);
      return wait({ page: page ?? 1, text: item?.summary || '미리보기 픽스처 본문', chunks: [{ id: 'c0', start: 0, end: 20 }] });
    },
    async note(projectId, noteId) {
      if (citationIds.has(noteId)) return citationService.note(projectId, noteId);
      const item = project.items.find((entry) => entry.id === noteId);
      return wait({ id: noteId, title: item?.title ?? noteId, body: `# ${item?.title ?? ''}\n\n${item?.summary ?? ''}\n\n[[fa2k7q#c3|돌봄 필요도]]` });
    },
    async join() { return wait(project); },
    async leave() { return wait(project); },
    async emptyTrash(projectId) {
      if (projectId === project.id) trashed = [];
      await wait(null);
    },
    async librarian(projectId, action) {
      requireProject(projectId);
      await wait(null);
      const state = action === 'pause' ? 'paused' : 'running';
      project = {
        ...project,
        revision: project.revision + 1,
        librarian: { ...project.librarian, state },
        items: action === 'retry'
          ? project.items.map((item) => item.kind === 'file' && item.librarian.status === 'failed' ? { ...item, librarian: { status: 'queued' } } : item)
          : project.items,
      };
      emit();
    },
    async getSettings() {
      return wait({ settings: normalizeProjectSettings(settings), capabilities });
    },
    async saveSettings(next) {
      settings = normalizeProjectSettings(next);
      return wait({ settings, capabilities });
    },
  };

  store = createProjectStore({ service, reconcileDelayMs: 400 });
  store.replace(project);
  return {
    service,
    store,
    setHomeAccess(enabled) {
      capabilities = { ...capabilities, homeAccess: enabled };
    },
  };
}

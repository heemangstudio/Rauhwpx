/**
 * 프로젝트 그래프 — 캔버스 위의 살아 있는 힘 배치(d3-force, 처음 열 때 불러온다).
 *
 * 노드는 항목과 프로젝트 문서, 선은 노드 쌍의 연결 세기(graph-model.ts)다. 세기가 클수록
 * 용수철이 짧고 단단하며 선이 굵다. 시뮬레이션은 보이는 동안 낮은 alpha 를 유지하다가
 * 움직임이 멎으면 쉬고, 끌기·힘 조절·구조 변경에 다시 데워진다. 탭이나 창이 가려지면 멈추고,
 * 동작 줄이기 사용자는 한 번에 계산한 정지 배치를 본다.
 *
 * 노드를 끌면 이웃이 용수철로 따라오고, 놓으면 제자리로 돌아간다. 고정은 오른쪽 클릭 메뉴로
 * 하고(graph-pin), 고정한 노드는 끈 자리로 옮겨 고정한다. 빈 곳을 끌면 화면을 옮기고,
 * 휠·핀치는 커서 쪽으로 부드럽게 확대한다.
 */
import type { ForceCollide, ForceLink, ForceManyBody, ForceX, ForceY, Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { itemColumnId, otherWorktreeBranch, projectShowsWorktrees } from '../../../agent/project-service.ts';
import type { ProjectService, ProjectStore } from '../../../agent/project-service.ts';
import type { ProjectItem, ProjectSnapshot, ProjectWorktreeContext } from '../../../agent/types.ts';
import { cachedClipThumbUrl, clipThumbUrl } from './clip-thumbs.ts';
import { forceCollideFast, forceManyBodyFast } from './graph-forces.ts';
import {
  DEFAULT_FORCE_SETTINGS,
  FORCE_KEYS,
  buildGraphModel,
  edgeStyle,
  forceParams,
  labelAlpha,
  nodeRadius,
  normalizeForceSettings,
  springFor,
  type GraphForceParams,
  type GraphForceSettings,
} from './graph-model.ts';
import {
  button,
  columnColor,
  el,
  errorText,
  reducedMotion,
  worktreeColors,
  worktreeLabelActions,
} from './project-ui.ts';

export interface ProjectGraphDeps {
  store: ProjectStore;
  /** 영역 조각 노드의 썸네일 원본. 없으면 색 상자로 둔다. */
  service?: Pick<ProjectService, 'fileBlob'> | null;
  openPreview(itemId: string): void;
  /** 문서 노드를 눌렀을 때. 없으면 문서 노드는 누를 수 없다. */
  openDocument?(documentId: string): void;
  announce(message: string, tone?: 'error'): void;
  /** 이 채팅 문서의 작업 공간. 둘 이상일 때만 작업 공간 색과 표시 메뉴를 보인다. */
  worktrees?: () => ProjectWorktreeContext | null;
}

export interface ProjectGraph {
  element: HTMLElement;
  update(project: ProjectSnapshot | null): void;
  /** 탭이 보일 때만 그리고 시뮬레이션을 돌린다. */
  setActive(active: boolean): void;
  dispose(): void;
}

type ColorMode = 'column' | 'tag' | 'worktree';

interface GraphNode extends SimulationNodeDatum {
  id: string;
  label: string;
  kind: 'file' | 'note' | 'doc' | 'clip';
  radius: number;
  color: string;
  /** 보이는 연결 세기의 합. */
  strength: number;
  /** 용수철 수(태그 용수철 포함). 허브 용수철을 나눠 약하게 하는 데 쓴다. */
  springs: number;
  pinned: boolean;
  documentId?: string;
  /** 잘라 둔 이름과 그 너비. 글꼴이 바뀌면 다시 잰다. */
  labelText: string;
  labelWidth: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  /**
   * 끝은 처음부터 노드 객체다. id 문자열로 두면 d3 가 풀어 주기 전까지 그릴 수 없어서, 구조가
   * 그대로인 스냅샷(이름 바꾸기, 열 옮기기, 고정 노드 다시 고정)마다 선이 모두 사라졌다.
   */
  source: GraphNode;
  target: GraphNode;
  weight: number;
  /** 태그만 겹친 쌍은 그리지 않는 용수철이다. */
  visible: boolean;
  /** 영역 → 원본뿐이면 점선. */
  dashed: boolean;
  /** 쉬는 동안의 선 굵기(화면 px)·불투명도. 세기에서 한 번 계산한다. */
  width: number;
  alpha: number;
}

/** 굵기·불투명도·점선이 같은 선 묶음. 한 번의 stroke 로 긋는다. */
interface EdgeGroup {
  width: number;
  alpha: number;
  dashed: boolean;
  links: GraphLink[];
}

/** 측정용. 미리보기·성능 스크립트가 element.graphStats 로 읽는다. */
export interface ProjectGraphStats {
  nodes: number;
  links: number;
  ticks: number;
  /** 최근 틱 시간(ms) 지수 평균. */
  tickMs: number;
  draws: number;
  drawMs: number;
  /** 가장 오래 걸린 틱·그리기(ms). */
  maxTickMs: number;
  maxDrawMs: number;
  /** 마지막 틱의 평균·최대 이동(화면 px). */
  meanSpeed: number;
  maxSpeed: number;
  awake: boolean;
}

type D3Force = typeof import('d3-force');

let d3Loader: Promise<D3Force> | null = null;
function loadD3(): Promise<D3Force> {
  d3Loader ??= import('d3-force');
  return d3Loader;
}

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 4;
const DRAG_THRESHOLD_PX = 3;
/** 처음 열 때 미리 풀어 두는 틱 수와 시간 상한. */
const PREWARM_TICKS = 120;
const PREWARM_BUDGET_MS = 220;
const MAX_LABEL_CHARS = 26;
const MAX_LABELS = 260;
const UNTAGGED = '__untagged__';
/** 보이는 동안 유지하는 낮은 열. 움직임이 멎으면 루프가 쉰다. */
const IDLE_ALPHA = 0.012;
const DRAG_ALPHA = 0.3;
/** 한 프레임 틱 상한. 남는 시간이 있을 때만 두 번째 틱을 돈다. */
const MAX_TICKS_PER_FRAME = 2;
const TICK_BUDGET_MS = 6;
/**
 * 노드 평균 이동이 화면에서 이보다 작은 프레임이 이어지면 쉰다. 큰 그래프는 Barnes–Hut 근사로
 * 평형에서도 몇 노드가 조금씩 떨리므로 최댓값이 아니라 평균을 본다. 그래도 멎지 않으면
 * 마지막으로 깨운 뒤 REST_TIMEOUT_MS 가 지나 열이 식었을 때 쉰다.
 */
const REST_MEAN_PX = 0.03;
const REST_MAX_PX = 0.6;
const REST_FRAMES = 45;
const REST_TIMEOUT_MS = 10_000;
/** 이보다 큰 그래프는 겹침 힘을 한 틱 걸러 돌린다(틱 시간의 약 1/4). */
const LARGE_GRAPH = 1000;
const FADE_MS = 120;
const DIM_ALPHA = 0.16;
/** 휠 확대가 목표 배율로 다가가는 시간 상수(ms). 핀치는 손을 바로 따라오게 짧다. */
const ZOOM_TAU_MS = 70;
const PINCH_TAU_MS = 28;
const GRID_CELL = 48;
const FORCES_KEY_PREFIX = 'rhwp-agent-project-graph-forces:';

const FORCE_LABELS: Record<keyof GraphForceSettings, string> = {
  center: '중심 끌림',
  repel: '밀어내기',
  linkStrength: '연결 강도',
  linkDistance: '연결 거리',
};

function otherEnd(link: GraphLink, node: GraphNode): GraphNode {
  return link.source === node ? link.target : link.source;
}

function touch(adjacent: Map<string, GraphLink[]>, id: string, link: GraphLink): void {
  const list = adjacent.get(id);
  if (list) list.push(link);
  else adjacent.set(id, [link]);
}

/** 시뮬레이션에 넣은 구조(노드와 용수철)가 그대로인가. 이름·색·보이기만 바뀐 스냅샷은 배치를 다시 하지 않는다. */
function sameStructure(nodes: GraphNode[], nextNodes: GraphNode[], links: GraphLink[], nextLinks: GraphLink[]): boolean {
  if (nodes.length !== nextNodes.length || links.length !== nextLinks.length) return false;
  for (let index = 0; index < nodes.length; index++) if (nodes[index] !== nextNodes[index]) return false;
  for (let index = 0; index < links.length; index++) {
    if (links[index].id !== nextLinks[index].id || links[index].weight !== nextLinks[index].weight) return false;
  }
  return true;
}

function truncate(text: string): string {
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text;
}

function loadForces(projectId: string): GraphForceSettings {
  try {
    return normalizeForceSettings(JSON.parse(localStorage.getItem(FORCES_KEY_PREFIX + projectId) ?? 'null'));
  } catch {
    return { ...DEFAULT_FORCE_SETTINGS };
  }
}

function saveForces(projectId: string, settings: GraphForceSettings): void {
  try {
    const isDefault = FORCE_KEYS.every((key) => settings[key] === DEFAULT_FORCE_SETTINGS[key]);
    if (isDefault) localStorage.removeItem(FORCES_KEY_PREFIX + projectId);
    else localStorage.setItem(FORCES_KEY_PREFIX + projectId, JSON.stringify(settings));
  } catch {
    // 저장소가 막혀 있으면 이번 세션 값만 쓴다.
  }
}

export function createProjectGraph(deps: ProjectGraphDeps): ProjectGraph {
  const { store, announce } = deps;
  const worktrees = () => deps.worktrees?.() ?? null;
  /** 작업 공간 색 기준에서 작업 공간 id → 색. */
  let worktreeColorById = new Map<string, string>();
  let project: ProjectSnapshot | null = null;
  let itemById = new Map<string, ProjectItem>();
  let active = false;
  let disposed = false;
  let d3: D3Force | null = null;
  let simulation: Simulation<GraphNode, GraphLink> | null = null;
  let nodes: GraphNode[] = [];
  let links: GraphLink[] = [];
  let adjacent = new Map<string, GraphLink[]>();
  /** 보이는 선을 굵기 순으로 묶은 것. 선 세기가 바뀔 때만 다시 묶는다. */
  let edgeGroups: EdgeGroup[] = [];
  /** 이름을 놓는 순서: 문서 → 고정 → 세기 순. 초점과 이웃은 그릴 때 먼저 놓는다. */
  let labelOrder: GraphNode[] = [];
  /** labelOrder 에서 문서·고정 다음, 세기 순이 시작하는 자리. */
  let labelRanked = 0;
  /** 색이 같은 파일·노트 점. 색이 바뀔 때(recolor) 다시 묶는다. */
  let circleGroups: Array<{ color: string; nodes: GraphNode[] }> = [];
  /** 가운데가 빈 노트 점. */
  let noteNodes: GraphNode[] = [];
  /** 하나씩 그리는 문서·영역. */
  let singleNodes: GraphNode[] = [];
  let maxStrength = 0;
  const nodeById = new Map<string, GraphNode>();
  /** 마지막 스냅샷의 고정 노드 id. null 이면 아직 그래프를 만든 적이 없다. */
  let structurePinned: string | null = null;
  /** 보이지 않는 동안 받은 스냅샷. 보일 때 한 번만 다시 만든다(보드를 고칠 때마다 그래프를 만들지 않는다). */
  let rebuildPending = false;
  /** 구조가 바뀌었지만 아직 시뮬레이션에 넣지 않았다. 그래프가 보일 때 넣는다(d3 도 그때 불러온다). */
  let layoutStale = false;
  /** 다음 배치가 처음 배치다(미리 풀고 바로 맞춘다). */
  let firstLayout = false;
  let loadingD3 = false;
  let colorMode: ColorMode = 'column';
  let view = { x: 0, y: 0, k: 1 };
  /** 휠·전체 보기가 향하는 화면. 같은 비율로 x, y, k 를 옮기면 커서 아래 점이 그대로 있다. */
  let viewTarget: { x: number; y: number; k: number; tau: number } | null = null;
  let userMoved = false;
  let pendingFit = false;
  let hover: GraphNode | null = null;
  /** 흐려지기·밝아지기 중인 초점. hover 가 풀려도 다 사라질 때까지 남는다. */
  let focus: GraphNode | null = null;
  let fade = 0;
  let neighbors = new Set<string>();
  /** 초점의 이웃을 세기 순으로. 이름을 먼저 놓는다. */
  let neighborOrder: GraphNode[] = [];
  let frame = 0;
  let lastFrameAt = 0;
  let dirty = false;
  let simAwake = false;
  let quietFrames = 0;
  let wokeAt = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let palette = { text: '#000', muted: '#888', edge: '#ccc', bg: '#fff', font: 'system-ui' };
  let labelFont = '';
  let forcesProjectId = '';
  let forces: GraphForceSettings = { ...DEFAULT_FORCE_SETTINGS };
  let params: GraphForceParams = forceParams(forces);
  let grid: Map<number, GraphNode[]> | null = null;
  const stats: ProjectGraphStats = { nodes: 0, links: 0, ticks: 0, tickMs: 0, draws: 0, drawMs: 0, maxTickMs: 0, maxDrawMs: 0, meanSpeed: 0, maxSpeed: 0, awake: false };
  /** 영역 노드의 썸네일 그림. 불러오는 중이면 null. */
  const thumbs = new Map<string, HTMLImageElement | null>();

  const element = el('div', 'ag-pgraph');
  Object.defineProperty(element, 'graphStats', { value: stats });
  const canvas = el('canvas', 'ag-pgraph-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  const toolbar = el('div', 'ag-pgraph-toolbar');
  const modes = el('div', 'ag-pgraph-modes');
  modes.setAttribute('role', 'radiogroup');
  modes.setAttribute('aria-label', '색 기준');
  const modeButtons = new Map<ColorMode, HTMLButtonElement>();
  for (const [mode, label] of [['column', '열'], ['tag', '태그'], ['worktree', '작업 공간']] as const) {
    const choice = el('button', 'ag-pgraph-mode', label);
    choice.type = 'button';
    choice.setAttribute('role', 'radio');
    choice.addEventListener('click', () => {
      colorMode = mode;
      renderModes();
      recolor();
      draw();
    });
    modeButtons.set(mode, choice);
    modes.append(choice);
  }
  const forcesToggle = button('ag-pgraph-fit ag-pgraph-forces-toggle', '힘 조절', { icon: 'sliders' });
  forcesToggle.setAttribute('aria-expanded', 'false');
  forcesToggle.setAttribute('aria-haspopup', 'dialog');
  const fit = button('ag-pgraph-fit', '전체 보기', { icon: 'fit' });
  toolbar.append(modes, forcesToggle, fit);

  const forcesPanel = el('div', 'ag-pgraph-forces');
  forcesPanel.setAttribute('role', 'dialog');
  forcesPanel.setAttribute('aria-label', '힘 조절');
  forcesPanel.hidden = true;
  const sliders = new Map<keyof GraphForceSettings, HTMLInputElement>();
  for (const key of FORCE_KEYS) {
    const row = el('label', 'ag-pgraph-force');
    const input = el('input', 'ag-pgraph-range');
    input.type = 'range';
    input.min = '0';
    input.max = '100';
    input.step = '1';
    input.addEventListener('input', () => setForce(key, Number(input.value) / 100, false));
    input.addEventListener('change', () => setForce(key, Number(input.value) / 100, true));
    sliders.set(key, input);
    row.append(el('span', 'ag-pgraph-force-label', FORCE_LABELS[key]), input);
    forcesPanel.append(row);
  }
  const resetForces = el('button', 'ag-pgraph-forces-reset', '초기화');
  resetForces.type = 'button';
  forcesPanel.append(resetForces);

  const menu = el('div', 'ag-pgraph-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;

  const legend = el('ul', 'ag-pgraph-legend');
  legend.setAttribute('aria-label', '색 범례');
  const empty = el('p', 'ag-pgraph-empty', '연결할 항목이 없습니다.');
  empty.hidden = true;
  element.append(canvas, toolbar, forcesPanel, menu, legend, empty);

  function renderModes(): void {
    // 작업 공간이 하나로 줄면 작업 공간 기준을 감추고 열로 돌아간다.
    const showsWorktrees = projectShowsWorktrees(worktrees());
    if (!showsWorktrees && colorMode === 'worktree') colorMode = 'column';
    modeButtons.get('worktree')!.hidden = !showsWorktrees;
    for (const [mode, choice] of modeButtons) {
      const selected = mode === colorMode;
      choice.classList.toggle('ag-active', selected);
      choice.setAttribute('aria-checked', String(selected));
      choice.tabIndex = selected ? 0 : -1;
    }
  }
  renderModes();

  // ── 색과 크기 ─────────────────────────────────────────

  function readPalette(): void {
    const style = getComputedStyle(element);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    palette = {
      text: read('--ag-text', '#1f1f1f'),
      muted: read('--ag-text-muted', '#8a8a8a'),
      edge: read('--ag-border-strong', '#c8c8c8'),
      bg: read('--ag-rail-bg', read('--ag-bg', '#ffffff')),
      font: read('--ag-font', 'system-ui, sans-serif'),
    };
    const font = `11px ${palette.font}`;
    if (font !== labelFont) {
      labelFont = font;
      for (const node of nodes) node.labelWidth = -1;
    }
  }

  function nodeColor(node: GraphNode): string {
    if (!project) return palette.muted;
    if (node.kind === 'doc') return palette.text;
    const item = itemById.get(node.id);
    if (!item) return palette.muted;
    if (colorMode === 'column') return columnColor(project, itemColumnId(project, item));
    if (colorMode === 'worktree') return (item.origin && worktreeColorById.get(item.origin.worktreeId)) || palette.muted;
    const tag = item.tags.find((name) => project!.tags.some((entry) => entry.name === name));
    return tag ? project.tags.find((entry) => entry.name === tag)!.color : palette.muted;
  }

  function recolor(): void {
    const context = worktrees();
    const worktreeLegend = colorMode === 'worktree' && context && project
      ? worktreeColors(context, project.items, palette.muted)
      : null;
    worktreeColorById = worktreeLegend?.byId ?? new Map();
    const groups = new Map<string, GraphNode[]>();
    noteNodes = [];
    singleNodes = [];
    for (const node of nodes) {
      node.color = nodeColor(node);
      if (node.kind === 'doc' || node.kind === 'clip') {
        singleNodes.push(node);
        continue;
      }
      const group = groups.get(node.color);
      if (group) group.push(node);
      else groups.set(node.color, [node]);
      if (node.kind === 'note') noteNodes.push(node);
    }
    circleGroups = [...groups].map(([color, members]) => ({ color, nodes: members }));
    renderLegend(worktreeLegend?.legend ?? null);
  }

  function renderLegend(worktreeLegend: Array<{ key: string; label: string; color: string }> | null): void {
    legend.replaceChildren();
    if (!project) return;
    const entries: Array<{ key: string; label: string; color: string }> = [];
    if (worktreeLegend) {
      entries.push(...worktreeLegend);
    } else if (colorMode === 'column') {
      for (const column of project.columns) entries.push({ key: column.id, label: column.name, color: columnColor(project, column.id) });
    } else {
      const used = new Map<string, number>();
      for (const item of project.items) {
        const tag = item.tags.find((name) => project!.tags.some((entry) => entry.name === name)) ?? UNTAGGED;
        used.set(tag, (used.get(tag) ?? 0) + 1);
      }
      const ranked = [...used.entries()].filter(([name]) => name !== UNTAGGED).sort((a, b) => b[1] - a[1]).slice(0, 6);
      for (const [name] of ranked) {
        entries.push({ key: name, label: name, color: project.tags.find((tag) => tag.name === name)?.color ?? palette.muted });
      }
      if (used.has(UNTAGGED)) entries.push({ key: UNTAGGED, label: '태그 없음', color: palette.muted });
    }
    for (const entry of entries) {
      const row = el('li', 'ag-pgraph-legend-row');
      const swatch = el('span', 'ag-pgraph-swatch');
      swatch.style.setProperty('--ag-pgraph-swatch', entry.color);
      row.append(swatch, el('span', '', entry.label));
      legend.append(row);
    }
  }

  // ── 그래프 만들기 ─────────────────────────────────────

  function rebuild(): void {
    if (!project) {
      nodes = [];
      links = [];
      adjacent = new Map();
      edgeGroups = [];
      labelOrder = [];
      labelRanked = 0;
      circleGroups = [];
      noteNodes = [];
      singleNodes = [];
      nodeById.clear();
      itemById = new Map();
      structurePinned = null;
      return;
    }
    itemById = new Map(project.items.map((item) => [item.id, item]));
    const pinned = project.graph.pinned;
    const dragged = gesture?.kind === 'node' ? gesture.node : null;
    const nextNodes: GraphNode[] = [];
    const seen = new Set<string>();
    const add = (id: string, label: string, kind: GraphNode['kind'], documentId?: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const previous = nodeById.get(id);
      const node: GraphNode = previous ?? {
        id, label, kind, radius: 5, color: palette.muted, strength: 0, springs: 0, pinned: false, labelText: '', labelWidth: -1,
      };
      if (node.label !== label || !node.labelText) {
        node.labelText = truncate(label);
        node.labelWidth = -1;
      }
      node.label = label;
      node.kind = kind;
      node.documentId = documentId;
      node.strength = 0;
      node.springs = 0;
      const pin = pinned[id];
      node.pinned = Boolean(pin);
      if (node === dragged) {
        // 끄는 중인 노드는 손을 따른다.
      } else if (pin) {
        node.fx = pin[0];
        node.fy = pin[1];
        node.x ??= pin[0];
        node.y ??= pin[1];
      } else if (previous?.fx != null) {
        node.fx = null;
        node.fy = null;
      }
      nextNodes.push(node);
    };
    for (const member of project.members) add(member.nodeId, member.name, 'doc', member.documentId);
    for (const item of project.items) if (!item.trashedAt) add(item.id, item.title, item.kind === 'file' ? 'file' : item.kind);

    const model = buildGraphModel(project, seen);
    const index = new Map(nextNodes.map((node) => [node.id, node]));
    const nextLinks: GraphLink[] = [];
    const nextAdjacent = new Map<string, GraphLink[]>();
    const groups = new Map<number, EdgeGroup>();
    let visibleLinks = 0;
    for (const edge of model.edges) {
      const source = index.get(edge.source)!;
      const target = index.get(edge.target)!;
      const style = edgeStyle(edge.weight);
      const link: GraphLink = {
        id: edge.key, source, target, weight: edge.weight, visible: edge.visible, dashed: edge.dashed, width: style.width, alpha: style.alpha,
      };
      nextLinks.push(link);
      source.springs += 1;
      target.springs += 1;
      if (!edge.visible) continue;
      touch(nextAdjacent, edge.source, link);
      touch(nextAdjacent, edge.target, link);
      visibleLinks += 1;
      // 굵기는 0.2px, 불투명도는 1/40 단위로 묶는다.
      const width = Math.round(style.width * 5);
      const alpha = Math.round(style.alpha * 40);
      const key = (width * 64 + alpha) * 2 + (edge.dashed ? 1 : 0);
      const group = groups.get(key);
      if (group) group.links.push(link);
      else groups.set(key, { width: width / 5, alpha: alpha / 40, dashed: edge.dashed, links: [link] });
    }
    maxStrength = model.maxStrength;
    for (const node of nextNodes) {
      node.strength = model.strength.get(node.id) ?? 0;
      node.radius = nodeRadius(node.kind, node.strength);
    }
    // 새 노드는 이미 자리 잡은 이웃 곁에서 시작해 화면을 가로지르지 않게 한다.
    for (const node of nextNodes) {
      if (node.x !== undefined && node.y !== undefined) continue;
      const neighbor = (nextAdjacent.get(node.id) ?? [])
        .map((link) => otherEnd(link, node))
        .find((other) => other.x !== undefined);
      const angle = Math.random() * Math.PI * 2;
      const spread = neighbor ? 24 : 24 + Math.sqrt(nextNodes.length) * 6 * Math.random();
      node.x = (neighbor?.x ?? 0) + Math.cos(angle) * spread;
      node.y = (neighbor?.y ?? 0) + Math.sin(angle) * spread;
    }
    // 노드는 id 마다 같은 객체를 다시 쓰므로 객체와 연결 세기만 견주면 된다.
    const pinnedKey = Object.keys(pinned).sort().join(',');
    const first = structurePinned === null;
    const changed = first || pinnedKey !== structurePinned || !sameStructure(nodes, nextNodes, links, nextLinks);
    structurePinned = pinnedKey;
    nodes = nextNodes;
    links = nextLinks;
    adjacent = nextAdjacent;
    edgeGroups = [...groups.values()].sort((a, b) => a.width - b.width);
    if (changed) {
      const labelRank = (node: GraphNode) => (node.kind === 'doc' ? 0 : node.pinned ? 1 : 2);
      labelOrder = [...nextNodes].sort((a, b) => labelRank(a) - labelRank(b) || b.strength - a.strength);
      labelRanked = labelOrder.findIndex((node) => labelRank(node) === 2);
      if (labelRanked < 0) labelRanked = labelOrder.length;
    }
    nodeById.clear();
    for (const node of nodes) nodeById.set(node.id, node);
    grid = null;
    if (hover && !nodeById.has(hover.id)) setHover(null);
    else if (hover) setNeighbors(hover);
    stats.nodes = nodes.length;
    stats.links = visibleLinks;
    recolor();
    canvas.setAttribute('aria-label', `프로젝트 그래프, 노드 ${nodes.length}개, 연결 ${stats.links}개`);
    empty.hidden = nodes.length > 0;
    if (changed) {
      layoutStale = true;
      firstLayout ||= first;
    }
    requestDraw();
  }

  /** 힘 설정을 시뮬레이션에 넣는다. 용수철은 다시 계산된다. */
  function applyForces(): void {
    if (!simulation) return;
    (simulation.force('charge') as ForceManyBody<GraphNode>).strength(params.repel);
    (simulation.force('x') as ForceX<GraphNode>).strength(params.center);
    (simulation.force('y') as ForceY<GraphNode>).strength(params.center);
    const spring = (link: GraphLink) => springFor(link.weight, Math.min(link.source.springs, link.target.springs), params);
    (simulation.force('link') as ForceLink<GraphNode, GraphLink>)
      .strength((link) => spring(link).strength)
      .distance((link) => spring(link).distance + link.source.radius + link.target.radius);
  }

  async function layout(): Promise<void> {
    if (!d3) {
      // 불러오는 중이면 그 호출이 다 불러온 뒤 지금 상태로 배치한다.
      if (loadingD3) return;
      loadingD3 = true;
      try {
        d3 = await loadD3();
      } catch (error) {
        announce(`그래프를 불러오지 못했습니다. ${errorText(error)}`, 'error');
        return;
      } finally {
        loadingD3 = false;
      }
    }
    if (disposed || !active || !layoutStale) return;
    layoutStale = false;
    const first = firstLayout;
    firstLayout = false;
    if (!simulation) {
      simulation = d3.forceSimulation<GraphNode, GraphLink>()
        // 밀어내기·겹침은 d3 와 같은 값을 내는 typed array 판이다(graph-forces.ts).
        .force('charge', forceManyBodyFast<GraphNode>().theta(0.9).distanceMax(900))
        .force('link', d3.forceLink<GraphNode, GraphLink>().id((node) => node.id))
        .force('collide', alternate(forceCollideFast<GraphNode>().radius((node) => node.radius + 2).strength(0.7)))
        .force('x', d3.forceX<GraphNode>(0))
        .force('y', d3.forceY<GraphNode>(0))
        .alphaTarget(IDLE_ALPHA)
        // 틱은 이 파일의 프레임 루프가 직접 돈다(d3 타이머는 쓰지 않는다).
        .stop();
    }
    simulation.nodes(nodes);
    (simulation.force('link') as ForceLink<GraphNode, GraphLink>).links(links);
    applyForces();
    grid = null;
    if (reducedMotion()) {
      settleStatic(1);
      if (!userMoved) fitView(false);
      return;
    }
    if (first) {
      // 처음 열 때는 조금 미리 풀어 둔다. 흩어진 점이 모이는 과정을 길게 보이지 않는다.
      simulation.alpha(1);
      const started = performance.now();
      for (let index = 0; index < PREWARM_TICKS && performance.now() - started < PREWARM_BUDGET_MS; index++) simulation.tick();
      if (!userMoved) fitView(false);
      simulation.alpha(0.2);
    } else {
      simulation.alpha(Math.max(simulation.alpha(), 0.35));
    }
    pendingFit = !userMoved;
    wake();
    requestDraw();
  }

  /** 큰 그래프에서 한 틱 걸러 도는 힘. 작은 그래프는 매 틱 돈다. */
  function alternate(force: ForceCollide<GraphNode>): ForceCollide<GraphNode> {
    let turn = 0;
    const wrapped = ((alpha: number) => {
      turn += 1;
      if (nodes.length < LARGE_GRAPH || turn % 2 === 0) force(alpha);
    }) as ForceCollide<GraphNode>;
    wrapped.initialize = (next, random) => force.initialize?.(next, random);
    return wrapped;
  }

  /** 동작 줄이기: 남은 열을 한 번에 식혀 정지 배치를 만든다. */
  function settleStatic(alpha: number): void {
    if (!simulation) return;
    simulation.alphaTarget(0).alpha(alpha);
    const ticks = Math.ceil(Math.log(simulation.alphaMin() / alpha) / Math.log(1 - simulation.alphaDecay()));
    for (let index = 0; index < ticks; index++) simulation.tick();
    simulation.alphaTarget(IDLE_ALPHA);
    grid = null;
    requestDraw();
  }

  // ── 프레임 루프 ───────────────────────────────────────

  function canAnimate(): boolean {
    return active && !disposed && !document.hidden && !reducedMotion();
  }

  function requestFrame(): void {
    if (frame || !active || disposed || document.hidden) return;
    frame = requestAnimationFrame(step);
  }

  function requestDraw(): void {
    dirty = true;
    requestFrame();
  }

  /** 쉬던 시뮬레이션을 깨운다. alpha 를 주면 그만큼 데운다. */
  function wake(alpha = 0): void {
    if (!simulation) return;
    if (alpha > 0) simulation.alpha(Math.max(simulation.alpha(), alpha));
    quietFrames = 0;
    if (!canAnimate()) {
      if (alpha > 0 && reducedMotion() && active) settleStatic(Math.max(alpha, 0.3));
      return;
    }
    if (!simAwake || alpha > 0) wokeAt = performance.now();
    simAwake = true;
    stats.awake = true;
    requestFrame();
  }

  function step(now: number): void {
    frame = 0;
    if (!active || disposed || document.hidden) return;
    const dt = lastFrameAt ? Math.min(64, now - lastFrameAt) : 16;
    lastFrameAt = now;
    let animating = false;

    if (viewTarget) {
      const t = reducedMotion() ? 1 : 1 - Math.exp(-dt / viewTarget.tau);
      view = {
        x: view.x + (viewTarget.x - view.x) * t,
        y: view.y + (viewTarget.y - view.y) * t,
        k: view.k + (viewTarget.k - view.k) * t,
      };
      if (Math.abs(viewTarget.k - view.k) / viewTarget.k < 0.002 && Math.abs(viewTarget.x - view.x) < 0.3 && Math.abs(viewTarget.y - view.y) < 0.3) {
        view = { x: viewTarget.x, y: viewTarget.y, k: viewTarget.k };
        viewTarget = null;
      } else {
        animating = true;
      }
      dirty = true;
    }

    const fadeGoal = hover ? 1 : 0;
    if (fade !== fadeGoal) {
      const delta = reducedMotion() ? 1 : dt / FADE_MS;
      fade = fadeGoal > fade ? Math.min(1, fade + delta) : Math.max(0, fade - delta);
      if (fade === 0 && !hover) {
        focus = null;
        neighbors = new Set();
        neighborOrder = [];
      }
      if (fade !== fadeGoal) animating = true;
      dirty = true;
    }

    if (simulation && simAwake && canAnimate()) {
      const started = performance.now();
      let ticks = 0;
      do {
        simulation.tick();
        ticks += 1;
      } while (ticks < MAX_TICKS_PER_FRAME && performance.now() - started < TICK_BUDGET_MS / 2 && simulation.alpha() > 0.1);
      const spent = (performance.now() - started) / ticks;
      stats.ticks += ticks;
      stats.tickMs = stats.tickMs ? stats.tickMs * 0.9 + spent * 0.1 : spent;
      stats.maxTickMs = Math.max(stats.maxTickMs, spent);
      grid = null;
      let fastest = 0;
      let total = 0;
      for (const node of nodes) {
        const speed = Math.abs(node.vx ?? 0) + Math.abs(node.vy ?? 0);
        total += speed;
        if (speed > fastest) fastest = speed;
      }
      stats.meanSpeed = nodes.length ? total / nodes.length * view.k : 0;
      stats.maxSpeed = fastest * view.k;
      const cool = simulation.alpha() < IDLE_ALPHA * 2 && gesture?.kind !== 'node';
      const resting = cool && stats.meanSpeed < REST_MEAN_PX && stats.maxSpeed < REST_MAX_PX;
      quietFrames = resting ? quietFrames + 1 : 0;
      if (quietFrames > REST_FRAMES || (cool && now - wokeAt > REST_TIMEOUT_MS)) {
        simAwake = false;
        stats.awake = false;
        if (pendingFit && !userMoved) fitView(true);
        pendingFit = false;
      }
      if (fastest * view.k > 0.01) dirty = true;
      animating ||= simAwake;
    }

    if (dirty) draw();
    if (animating || viewTarget) requestFrame();
    else lastFrameAt = 0;
  }

  // ── 그리기 ────────────────────────────────────────────

  let resolutionQuery: MediaQueryList | null = null;
  const onResolutionChange = () => resize();

  function resize(): void {
    const rect = element.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    // 다른 화면으로 옮겨 배율이 바뀌면 다시 맞춘다.
    resolutionQuery?.removeEventListener('change', onResolutionChange);
    resolutionQuery = window.matchMedia?.(`(resolution: ${dpr}dppx)`) ?? null;
    resolutionQuery?.addEventListener('change', onResolutionChange);
    draw();
  }

  /** 영역 노드의 썸네일. 처음 부르면 불러오기 시작하고, 다 오면 다시 그린다. */
  function clipThumb(id: string): HTMLImageElement | null {
    const snapshot = project;
    const clip = itemById.get(id);
    const source = clip?.kind === 'clip' ? itemById.get(clip.sourceId) : undefined;
    const load = deps.service?.fileBlob;
    if (!snapshot || clip?.kind !== 'clip' || source?.kind !== 'file' || !load) return null;
    // 영역을 옮기거나 키우면 새 그림이 필요하다.
    const key = `${clip.id}:${clip.page}:${clip.rect.join(',')}`;
    if (thumbs.has(key)) return thumbs.get(key) ?? null;
    thumbs.set(key, null);
    const request = { projectId: snapshot.id, clip, source, size: 'node' as const, load };
    const url = cachedClipThumbUrl(request);
    void (url ? Promise.resolve(url) : clipThumbUrl(request)).then((src) => {
      const image = new Image();
      image.decoding = 'async';
      image.onload = () => {
        if (disposed) return;
        thumbs.set(key, image);
        requestDraw();
      };
      image.src = src;
    }, () => undefined);
    return null;
  }

  /** 영역 노드: 썸네일을 담은 작은 네모. 그림이 오기 전에는 색 네모다. */
  function drawClipNode(ctx: CanvasRenderingContext2D, node: GraphNode, ringed: boolean): void {
    const image = clipThumb(node.id);
    const aspect = image?.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1.3;
    const w = node.radius * 2.6 * Math.min(1.6, Math.sqrt(aspect));
    const h = Math.min(node.radius * 2.6, w / aspect);
    const x = node.x! - w / 2;
    const y = node.y! - h / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 1.5);
    if (image) {
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.clip();
      ctx.drawImage(image, x, y, w, h);
      ctx.restore();
      ctx.strokeStyle = node.color;
      ctx.lineWidth = 1.5 / view.k;
      ctx.stroke();
    } else {
      ctx.fillStyle = node.color;
      ctx.fill();
    }
    if (ringed) {
      ctx.strokeStyle = palette.text;
      ctx.lineWidth = 1.2 / view.k;
      ctx.beginPath();
      const pad = 2.5 / view.k;
      ctx.roundRect(x - pad, y - pad, w + pad * 2, h + pad * 2, 2.5);
      ctx.stroke();
    }
  }

  function draw(): void {
    dirty = false;
    if (!active || !width) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const started = performance.now();
    const k = view.k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (width / 2 + view.x), dpr * (height / 2 + view.y));
    // 보이는 세계 범위. 밖의 노드와 선은 건너뛴다.
    const margin = 40 / k;
    const left = (-width / 2 - view.x) / k - margin;
    const right = (width / 2 - view.x) / k + margin;
    const top = (-height / 2 - view.y) / k - margin;
    const bottom = (height / 2 - view.y) / k + margin;
    const related = (node: GraphNode) => focus !== null && (node === focus || neighbors.has(node.id));
    const inView = (node: GraphNode) => node.x !== undefined && node.y !== undefined
      && node.x + node.radius >= left && node.x - node.radius <= right && node.y + node.radius >= top && node.y - node.radius <= bottom;
    const dimmed = 1 - (1 - DIM_ALPHA) * fade;
    const dimmedStep = Math.round(dimmed * 40) / 40;

    // 선: rebuild 때 굵기·불투명도·점선별로 묶어 둔 대로 한 번에 긋는다. 초점에 닿은 선은
    // 건너뛰었다가 맨 위에 굵게 긋는다.
    const crosses = (link: GraphLink) => {
      const { source, target } = link;
      if (source.x === undefined || target.x === undefined) return false;
      return !(Math.max(source.x, target.x) < left || Math.min(source.x, target.x) > right
        || Math.max(source.y!, target.y!) < top || Math.min(source.y!, target.y!) > bottom);
    };
    const restDim = focus ? 1 - 0.8 * fade : 1;
    ctx.strokeStyle = palette.muted;
    for (const group of edgeGroups) {
      ctx.globalAlpha = Math.round(group.alpha * restDim * 40) / 40;
      ctx.lineWidth = group.width / k;
      ctx.setLineDash(group.dashed ? [3 / k, 2.5 / k] : []);
      ctx.beginPath();
      for (const link of group.links) {
        if (focus && (link.source === focus || link.target === focus)) continue;
        if (!crosses(link)) continue;
        ctx.moveTo(link.source.x!, link.source.y!);
        ctx.lineTo(link.target.x!, link.target.y!);
      }
      ctx.stroke();
    }
    if (focus) {
      const lit = new Map<number, { width: number; alpha: number; dashed: boolean; links: GraphLink[] }>();
      for (const link of adjacent.get(focus.id) ?? []) {
        if (!crosses(link)) continue;
        const lineWidth = Math.round((link.width + (link.width * 0.6 + 0.6) * fade) * 5);
        const alpha = Math.round((link.alpha + (0.8 - link.alpha) * fade) * 40);
        const key = (lineWidth * 64 + alpha) * 2 + (link.dashed ? 1 : 0);
        const bucket = lit.get(key);
        if (bucket) bucket.links.push(link);
        else lit.set(key, { width: lineWidth / 5, alpha: alpha / 40, dashed: link.dashed, links: [link] });
      }
      ctx.strokeStyle = palette.text;
      for (const bucket of [...lit.values()].sort((a, b) => a.width - b.width)) {
        ctx.globalAlpha = bucket.alpha;
        ctx.lineWidth = bucket.width / k;
        ctx.setLineDash(bucket.dashed ? [3 / k, 2.5 / k] : []);
        ctx.beginPath();
        for (const link of bucket.links) {
          ctx.moveTo(link.source.x!, link.source.y!);
          ctx.lineTo(link.target.x!, link.target.y!);
        }
        ctx.stroke();
      }
    }
    ctx.setLineDash([]);

    // 점: recolor 때 색별로 묶어 둔 대로 한 번에 채운다. 초점이 있으면 흐린 점을 먼저, 초점과
    // 이웃을 위에 채운다. 문서와 영역은 수가 적어 하나씩 그린다.
    const fillCircles = (list: GraphNode[], scale: number) => {
      let lit: GraphNode[] | null = null;
      ctx.globalAlpha = focus ? dimmedStep : 1;
      ctx.beginPath();
      for (const node of list) {
        if (!inView(node)) continue;
        if (focus && related(node)) {
          (lit ??= []).push(node);
          continue;
        }
        ctx.moveTo(node.x! + node.radius * scale, node.y!);
        ctx.arc(node.x!, node.y!, node.radius * scale, 0, Math.PI * 2);
      }
      ctx.fill();
      if (!lit) return;
      ctx.globalAlpha = 1;
      ctx.beginPath();
      for (const node of lit) {
        ctx.moveTo(node.x! + node.radius * scale, node.y!);
        ctx.arc(node.x!, node.y!, node.radius * scale, 0, Math.PI * 2);
      }
      ctx.fill();
    };
    for (const group of circleGroups) {
      ctx.fillStyle = group.color;
      fillCircles(group.nodes, 1);
    }
    ctx.fillStyle = palette.bg;
    fillCircles(noteNodes, 0.42);
    const rings: GraphNode[] = [];
    for (const node of nodes) {
      if (node.kind !== 'doc' && node.kind !== 'clip' && (node.pinned || (node === focus && fade > 0)) && inView(node)) rings.push(node);
    }
    for (const node of singleNodes) {
      if (!inView(node)) continue;
      ctx.globalAlpha = focus && !related(node) ? dimmed : 1;
      const ringed = node.pinned || (node === focus && fade > 0);
      if (node.kind === 'clip') {
        drawClipNode(ctx, node, ringed);
        continue;
      }
      const size = node.radius * 1.7;
      ctx.fillStyle = node.color;
      ctx.beginPath();
      ctx.roundRect(node.x! - size / 2, node.y! - size / 2, size, size, 2);
      ctx.fill();
      if (ringed) rings.push(node);
    }
    if (rings.length) {
      ctx.strokeStyle = palette.text;
      ctx.lineWidth = 1.2 / k;
      for (const node of rings) {
        ctx.globalAlpha = focus && !related(node) ? dimmed : 1;
        ctx.beginPath();
        ctx.arc(node.x!, node.y!, node.radius + 2.5 / k + (node.kind === 'doc' ? 1.5 : 0), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 이름은 화면 좌표에서 그린다. 확대할수록, 무거운 노드일수록 먼저 나타난다. 우선순위
    // (초점 → 이웃 → 문서 → 고정 → 세기 순)대로 놓고, 이미 놓인 이름과 겹치면 건너뛴다.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = labelFont;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = palette.bg;
    const placed: Array<[number, number, number, number]> = [];
    const place = (node: GraphNode, alpha: number) => {
      if (!inView(node)) return;
      if (node.labelWidth < 0) node.labelWidth = ctx.measureText(node.labelText).width;
      const sx = width / 2 + view.x + node.x! * k;
      const sy = height / 2 + view.y + (node.y! + node.radius) * k + 3;
      const half = node.labelWidth / 2 + 3;
      const box: [number, number, number, number] = [sx - half, sy - 1, sx + half, sy + 14];
      if (box[2] < 0 || box[0] > width || box[1] > height || box[3] < 0) return;
      if (node !== focus && placed.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) return;
      placed.push(box);
      ctx.globalAlpha = alpha;
      ctx.strokeText(node.labelText, sx, sy);
      ctx.fillStyle = node === focus || node.kind === 'doc' ? palette.text : palette.muted;
      ctx.fillText(node.labelText, sx, sy);
    };
    const restAlpha = (node: GraphNode) => node.kind === 'doc' ? 1 : labelAlpha(k, node.strength, maxStrength);
    if (focus) {
      for (const node of [focus, ...neighborOrder]) {
        if (placed.length >= MAX_LABELS) break;
        const alpha = Math.max(restAlpha(node), fade);
        if (alpha >= 0.03) place(node, alpha);
      }
    }
    const restFade = focus ? 1 - fade : 1;
    for (let index = 0; index < labelOrder.length && placed.length < MAX_LABELS; index++) {
      const node = labelOrder[index];
      if (focus && related(node)) continue;
      const alpha = restAlpha(node) * restFade;
      if (alpha >= 0.03) place(node, alpha);
      // 문서·고정 다음은 세기가 줄어드는 순서이고, 이름 불투명도도 세기를 따라 줄어든다.
      else if (index >= labelRanked) break;
    }
    ctx.globalAlpha = 1;
    stats.draws += 1;
    const spent = performance.now() - started;
    stats.drawMs = stats.drawMs ? stats.drawMs * 0.9 + spent * 0.1 : spent;
    stats.maxDrawMs = Math.max(stats.maxDrawMs, spent);
  }

  function fitView(animate: boolean): void {
    const placed = nodes.filter((node) => node.x !== undefined && node.y !== undefined);
    if (!placed.length || !width) {
      view = { x: 0, y: 0, k: 1 };
      viewTarget = null;
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of placed) {
      minX = Math.min(minX, node.x! - node.radius);
      maxX = Math.max(maxX, node.x! + node.radius);
      minY = Math.min(minY, node.y! - node.radius);
      maxY = Math.max(maxY, node.y! + node.radius + 14);
    }
    const padding = 48;
    const k = Math.max(MIN_ZOOM, Math.min(1.25, Math.min(
      (width - padding * 2) / Math.max(1, maxX - minX),
      (height - padding * 2) / Math.max(1, maxY - minY),
    )));
    const target = { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k };
    if (animate && !reducedMotion() && active) {
      viewTarget = { ...target, tau: 90 };
      requestFrame();
      return;
    }
    viewTarget = null;
    view = target;
    requestDraw();
  }

  // ── 상호작용 ──────────────────────────────────────────

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - width / 2 - view.x) / view.k,
      y: (clientY - rect.top - height / 2 - view.y) / view.k,
    };
  }

  const cellKey = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);

  /** 위치가 바뀐 뒤 처음 찾을 때 격자를 다시 만든다(틱마다가 아니라 찾을 때만). */
  function buildGrid(): Map<number, GraphNode[]> {
    const next = new Map<number, GraphNode[]>();
    for (const node of nodes) {
      if (node.x === undefined || node.y === undefined) continue;
      const key = cellKey(Math.floor(node.x / GRID_CELL), Math.floor(node.y / GRID_CELL));
      const cell = next.get(key);
      if (cell) cell.push(node);
      else next.set(key, [node]);
    }
    return next;
  }

  function nodeAt(clientX: number, clientY: number): GraphNode | null {
    const point = toWorld(clientX, clientY);
    const slack = 5 / view.k;
    const hit = { node: null as GraphNode | null, distance: Infinity };
    const consider = (list: readonly GraphNode[]) => {
      for (const node of list) {
        if (node.x === undefined || node.y === undefined) continue;
        const distance = Math.hypot(node.x - point.x, node.y - point.y);
        if (distance <= node.radius + slack && distance < hit.distance) {
          hit.node = node;
          hit.distance = distance;
        }
      }
    };
    if (simAwake) {
      // 움직이는 동안은 틱마다 위치가 바뀌어 찾을 때마다 격자를 새로 만들게 된다. 한 번 훑는 편이 싸다.
      consider(nodes);
      return hit.node;
    }
    grid ??= buildGrid();
    const reach = 16 + slack;
    for (let cx = Math.floor((point.x - reach) / GRID_CELL); cx <= Math.floor((point.x + reach) / GRID_CELL); cx++) {
      for (let cy = Math.floor((point.y - reach) / GRID_CELL); cy <= Math.floor((point.y + reach) / GRID_CELL); cy++) {
        consider(grid.get(cellKey(cx, cy)) ?? []);
      }
    }
    return hit.node;
  }

  function setNeighbors(node: GraphNode): void {
    neighborOrder = (adjacent.get(node.id) ?? []).map((link) => otherEnd(link, node)).sort((a, b) => b.strength - a.strength);
    neighbors = new Set(neighborOrder.map((other) => other.id));
  }

  function setHover(node: GraphNode | null): void {
    if (node === hover) return;
    hover = node;
    if (node) {
      // 다른 노드로 바로 옮기면 흐림을 유지한 채 초점만 바꾼다.
      focus = node;
      setNeighbors(node);
    }
    canvas.style.cursor = node ? 'pointer' : '';
    const branch = node && node.kind !== 'doc' ? otherWorktreeBranch(itemById.get(node.id)?.origin, worktrees()) : null;
    canvas.title = !node ? '' : branch && projectShowsWorktrees(worktrees()) ? `${node.label}\n작업 공간: ${branch}` : node.label;
    requestDraw();
  }

  function zoomAt(clientX: number, clientY: number, factor: number, tau = ZOOM_TAU_MS): void {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left - width / 2;
    const sy = clientY - rect.top - height / 2;
    const base = viewTarget ?? view;
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, base.k * factor));
    const wx = (sx - base.x) / base.k;
    const wy = (sy - base.y) / base.k;
    const target = { k, x: sx - wx * k, y: sy - wy * k };
    userMoved = true;
    pendingFit = false;
    if (reducedMotion()) {
      viewTarget = null;
      view = target;
      requestDraw();
      return;
    }
    viewTarget = { ...target, tau };
    requestFrame();
  }

  async function commitPin(op: { op: 'graph-pin'; id: string; x: number; y: number } | { op: 'graph-unpin'; id: string }): Promise<void> {
    try {
      await store.edit([op]);
    } catch (error) {
      announce(errorText(error), 'error');
    }
  }

  function pinNode(node: GraphNode): void {
    const x = Math.round(node.x ?? 0);
    const y = Math.round(node.y ?? 0);
    node.pinned = true;
    node.fx = x;
    node.fy = y;
    void commitPin({ op: 'graph-pin', id: node.id, x, y });
    requestDraw();
  }

  function unpinNode(node: GraphNode): void {
    node.pinned = false;
    node.fx = null;
    node.fy = null;
    void commitPin({ op: 'graph-unpin', id: node.id });
    wake(0.3);
    requestDraw();
  }

  function openNode(node: GraphNode): void {
    if (node.kind === 'doc') {
      if (node.documentId) deps.openDocument?.(node.documentId);
      return;
    }
    deps.openPreview(node.id);
  }

  // ── 노드 메뉴 ─────────────────────────────────────────

  function closeMenu(): void {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.replaceChildren();
  }

  function openMenu(node: GraphNode, clientX: number, clientY: number): void {
    closeForces();
    const entries: Array<[string, () => void]> = [];
    if (node.kind !== 'doc' || (node.documentId && deps.openDocument)) entries.push(['열기', () => openNode(node)]);
    entries.push(node.pinned ? ['고정 풀기', () => unpinNode(node)] : ['고정', () => pinNode(node)]);
    const item = node.kind === 'doc' ? null : itemById.get(node.id);
    for (const action of item ? worktreeLabelActions(item, worktrees()) : []) {
      entries.push([action.label, () => {
        void store.edit([{ op: 'label', id: node.id, origin: action.origin }])
          .then(() => announce(action.done), (error: unknown) => announce(errorText(error), 'error'));
      }]);
    }
    menu.replaceChildren();
    for (const [label, run] of entries) {
      const row = el('button', 'ag-pgraph-menu-item', label);
      row.type = 'button';
      row.setAttribute('role', 'menuitem');
      row.addEventListener('click', () => {
        closeMenu();
        run();
        canvas.focus({ preventScroll: true });
      });
      menu.append(row);
    }
    menu.hidden = false;
    const host = element.getBoundingClientRect();
    const box = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(clientX - host.left, host.width - box.width - 8)}px`;
    menu.style.top = `${Math.min(clientY - host.top, host.height - box.height - 8)}px`;
    menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      closeMenu();
      canvas.focus({ preventScroll: true });
    } else if (event.key === 'ArrowDown') items[(index + 1) % items.length]?.focus();
    else if (event.key === 'ArrowUp') items[(index - 1 + items.length) % items.length]?.focus();
    else return;
    event.preventDefault();
    event.stopPropagation();
  });

  canvas.addEventListener('contextmenu', (event) => {
    const node = nodeAt(event.clientX, event.clientY);
    if (!node) return;
    event.preventDefault();
    openMenu(node, event.clientX, event.clientY);
  });

  // ── 힘 조절 ───────────────────────────────────────────

  function renderForces(): void {
    for (const key of FORCE_KEYS) {
      const input = sliders.get(key)!;
      input.value = String(Math.round(forces[key] * 100));
      input.style.setProperty('--ag-pgraph-range', String(forces[key]));
    }
  }

  function loadProjectForces(projectId: string): void {
    if (projectId === forcesProjectId) return;
    forcesProjectId = projectId;
    forces = loadForces(projectId);
    params = forceParams(forces);
    renderForces();
    applyForces();
  }

  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  function setForce(key: keyof GraphForceSettings | null, value: number, committed: boolean): void {
    if (key) forces = { ...forces, [key]: value };
    else forces = { ...DEFAULT_FORCE_SETTINGS };
    params = forceParams(forces);
    renderForces();
    applyForces();
    pendingFit = !userMoved;
    // 동작 줄이기에서는 손을 뗄 때 한 번만 정지 배치를 다시 만든다.
    if (!reducedMotion()) wake(0.3);
    else if (committed) wake(0.5);
    if (saveTimer) clearTimeout(saveTimer);
    const projectId = forcesProjectId;
    const settings = forces;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (projectId) saveForces(projectId, settings);
    }, committed ? 0 : 300);
  }

  function closeForces(): void {
    if (forcesPanel.hidden) return;
    forcesPanel.hidden = true;
    forcesToggle.setAttribute('aria-expanded', 'false');
    forcesToggle.classList.remove('ag-active');
  }

  forcesToggle.addEventListener('click', () => {
    if (!forcesPanel.hidden) {
      closeForces();
      return;
    }
    closeMenu();
    renderForces();
    forcesPanel.hidden = false;
    forcesToggle.setAttribute('aria-expanded', 'true');
    forcesToggle.classList.add('ag-active');
    sliders.get('center')?.focus({ preventScroll: true });
  });
  resetForces.addEventListener('click', () => setForce(null, 0, true));
  forcesPanel.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeForces();
    forcesToggle.focus({ preventScroll: true });
  });

  const onOutsidePointer = (event: PointerEvent) => {
    const target = event.target as Node | null;
    if (!menu.hidden && !menu.contains(target)) closeMenu();
    if (!forcesPanel.hidden && !forcesPanel.contains(target) && !forcesToggle.contains(target)) closeForces();
  };
  document.addEventListener('pointerdown', onOutsidePointer, true);

  // ── 끌기와 화면 옮기기 ────────────────────────────────

  type Gesture =
    | { kind: 'node'; node: GraphNode; pointerId: number; startX: number; startY: number; moved: boolean }
    | { kind: 'pan'; pointerId: number; startX: number; startY: number; viewX: number; viewY: number };
  let gesture: Gesture | null = null;

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const node = nodeAt(event.clientX, event.clientY);
    canvas.setPointerCapture(event.pointerId);
    gesture = node
      ? { kind: 'node', node, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false }
      : { kind: 'pan', pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, viewX: view.x, viewY: view.y };
    if (!node) {
      canvas.classList.add('ag-panning');
      viewTarget = null;
    }
  });

  canvas.addEventListener('pointerenter', () => wake());

  canvas.addEventListener('pointermove', (event) => {
    if (!gesture) {
      setHover(nodeAt(event.clientX, event.clientY));
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    if (gesture.kind === 'pan') {
      view = { ...view, x: gesture.viewX + event.clientX - gesture.startX, y: gesture.viewY + event.clientY - gesture.startY };
      userMoved = true;
      pendingFit = false;
      requestDraw();
      return;
    }
    if (!gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < DRAG_THRESHOLD_PX) return;
    if (!gesture.moved) {
      gesture.moved = true;
      setHover(gesture.node);
      canvas.classList.add('ag-dragging');
      simulation?.alphaTarget(DRAG_ALPHA);
    }
    const point = toWorld(event.clientX, event.clientY);
    const node = gesture.node;
    node.fx = point.x;
    node.fy = point.y;
    pendingFit = false;
    if (reducedMotion() || !simulation) {
      node.x = point.x;
      node.y = point.y;
      grid = null;
      requestDraw();
    } else {
      wake(DRAG_ALPHA);
    }
  });

  const finishGesture = (event: PointerEvent, cancelled: boolean) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const current = gesture;
    gesture = null;
    canvas.classList.remove('ag-panning', 'ag-dragging');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (current.kind !== 'node') return;
    simulation?.alphaTarget(IDLE_ALPHA);
    const node = current.node;
    if (current.moved) {
      if (node.pinned && !cancelled) {
        // 고정한 노드는 놓은 자리로 고정을 옮긴다.
        pinNode(node);
      } else if (node.pinned) {
        const pin = project?.graph.pinned[node.id];
        if (pin) [node.fx, node.fy] = pin;
      } else {
        // 고정하지 않은 노드는 놓으면 용수철로 돌아간다.
        node.fx = null;
        node.fy = null;
      }
      wake(reducedMotion() ? 0.3 : 0.1);
      setHover(nodeAt(event.clientX, event.clientY));
      return;
    }
    if (cancelled) return;
    openNode(node);
  };
  canvas.addEventListener('pointerup', (event) => finishGesture(event, false));
  canvas.addEventListener('pointercancel', (event) => finishGesture(event, true));
  canvas.addEventListener('pointerleave', () => { if (!gesture) setHover(null); });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    closeMenu();
    // 트랙패드 핀치는 ctrlKey 휠로 온다. 손을 바로 따라오도록 더 빨리 다가간다.
    const pinch = event.ctrlKey;
    const scale = event.deltaMode === 1 ? 0.05 : 0.0018;
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * scale * (pinch ? 4 : 1)), pinch ? PINCH_TAU_MS : ZOOM_TAU_MS);
  }, { passive: false });

  canvas.addEventListener('keydown', (event) => {
    const rect = canvas.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (event.key === '+' || event.key === '=') zoomAt(cx, cy, 1.25);
    else if (event.key === '-') zoomAt(cx, cy, 0.8);
    else if (event.key === '0') {
      userMoved = false;
      fitView(true);
    } else return;
    event.preventDefault();
  });

  fit.addEventListener('click', () => {
    userMoved = false;
    fitView(true);
  });

  const onVisibility = () => {
    if (document.hidden) {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      lastFrameAt = 0;
      return;
    }
    if (active) {
      wake();
      requestDraw();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(element);
  const themeObserver = new MutationObserver(() => {
    readPalette();
    recolor();
    requestDraw();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-effective', 'data-theme', 'data-theme-preset', 'style'] });

  return {
    element,
    update(next) {
      project = next;
      renderModes();
      if (next) loadProjectForces(next.id);
      if (active) {
        rebuild();
        if (layoutStale) void layout();
      } else {
        rebuildPending = true;
      }
      if (!next) {
        simAwake = false;
        requestDraw();
      }
    },
    setActive(next) {
      if (active === next) return;
      active = next;
      if (!active) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        lastFrameAt = 0;
        closeMenu();
        closeForces();
        setHover(null);
        return;
      }
      readPalette();
      if (rebuildPending) {
        rebuildPending = false;
        rebuild();
      } else {
        recolor();
      }
      resize();
      if (layoutStale) void layout();
      else wake();
      requestDraw();
    },
    dispose() {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      if (saveTimer) {
        clearTimeout(saveTimer);
        if (forcesProjectId) saveForces(forcesProjectId, forces);
      }
      resizeObserver.disconnect();
      themeObserver.disconnect();
      resolutionQuery?.removeEventListener('change', onResolutionChange);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      element.remove();
    },
  };
}

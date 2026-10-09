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
import { itemColumnId } from '../../../agent/project-service.ts';
import type { ProjectService, ProjectStore } from '../../../agent/project-service.ts';
import type { ProjectItem, ProjectSnapshot } from '../../../agent/types.ts';
import { cachedClipThumbUrl, clipThumbUrl } from './clip-thumbs.ts';
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
} from './project-ui.ts';

export interface ProjectGraphDeps {
  store: ProjectStore;
  /** 영역 조각 노드의 썸네일 원본. 없으면 색 상자로 둔다. */
  service?: Pick<ProjectService, 'fileBlob'> | null;
  openPreview(itemId: string): void;
  /** 문서 노드를 눌렀을 때. 없으면 문서 노드는 누를 수 없다. */
  openDocument?(documentId: string): void;
  announce(message: string, tone?: 'error'): void;
}

export interface ProjectGraph {
  element: HTMLElement;
  update(project: ProjectSnapshot | null): void;
  /** 탭이 보일 때만 그리고 시뮬레이션을 돌린다. */
  setActive(active: boolean): void;
  dispose(): void;
}

type ColorMode = 'column' | 'tag';

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
  weight: number;
  /** 태그만 겹친 쌍은 그리지 않는 용수철이다. */
  visible: boolean;
  /** 영역 → 원본뿐이면 점선. */
  dashed: boolean;
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

function endpointId(end: string | number | GraphNode | undefined): string {
  return typeof end === 'object' && end ? end.id : String(end ?? '');
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
  let project: ProjectSnapshot | null = null;
  let itemById = new Map<string, ProjectItem>();
  let active = false;
  let disposed = false;
  let d3: D3Force | null = null;
  let simulation: Simulation<GraphNode, GraphLink> | null = null;
  let nodes: GraphNode[] = [];
  let links: GraphLink[] = [];
  let adjacent = new Map<string, GraphLink[]>();
  let maxStrength = 0;
  const nodeById = new Map<string, GraphNode>();
  let structureKey = '';
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
  for (const [mode, label] of [['column', '열'], ['tag', '태그']] as const) {
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
    const tag = item.tags.find((name) => project!.tags.some((entry) => entry.name === name));
    return tag ? project.tags.find((entry) => entry.name === tag)!.color : palette.muted;
  }

  function recolor(): void {
    for (const node of nodes) node.color = nodeColor(node);
    renderLegend();
  }

  function renderLegend(): void {
    legend.replaceChildren();
    if (!project) return;
    const entries: Array<{ key: string; label: string; color: string }> = [];
    if (colorMode === 'column') {
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
      nodeById.clear();
      itemById = new Map();
      structureKey = '';
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
    for (const edge of model.edges) {
      const link: GraphLink = { id: edge.key, source: edge.source, target: edge.target, weight: edge.weight, visible: edge.visible, dashed: edge.dashed };
      nextLinks.push(link);
      index.get(edge.source)!.springs += 1;
      index.get(edge.target)!.springs += 1;
      if (!edge.visible) continue;
      for (const id of [edge.source, edge.target]) {
        const list = nextAdjacent.get(id);
        if (list) list.push(link);
        else nextAdjacent.set(id, [link]);
      }
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
        .map((link) => nodeById.get(endpointId(link.source) === node.id ? endpointId(link.target) : endpointId(link.source)))
        .find((other) => other?.x !== undefined);
      const angle = Math.random() * Math.PI * 2;
      const spread = neighbor ? 24 : 24 + Math.sqrt(nextNodes.length) * 6 * Math.random();
      node.x = (neighbor?.x ?? 0) + Math.cos(angle) * spread;
      node.y = (neighbor?.y ?? 0) + Math.sin(angle) * spread;
    }
    nodes = nextNodes;
    links = nextLinks;
    adjacent = nextAdjacent;
    nodeById.clear();
    for (const node of nodes) nodeById.set(node.id, node);
    grid = null;
    if (hover && !nodeById.has(hover.id)) setHover(null);
    else if (hover) neighbors = neighborIds(hover);
    stats.nodes = nodes.length;
    stats.links = links.filter((link) => link.visible).length;
    recolor();
    canvas.setAttribute('aria-label', `프로젝트 그래프, 노드 ${nodes.length}개, 연결 ${stats.links}개`);
    empty.hidden = nodes.length > 0;
    const key = `${nodes.map((node) => node.id).join(',')}|${links.map((link) => `${link.id}:${link.weight}`).join(',')}|${Object.keys(pinned).sort().join(',')}`;
    const changed = key !== structureKey;
    const first = structureKey === '';
    structureKey = key;
    if (changed) void layout(first);
    else requestDraw();
  }

  /** 힘 설정을 시뮬레이션에 넣는다. 용수철은 다시 계산된다. */
  function applyForces(): void {
    if (!simulation) return;
    (simulation.force('charge') as ForceManyBody<GraphNode>).strength(params.repel);
    (simulation.force('x') as ForceX<GraphNode>).strength(params.center);
    (simulation.force('y') as ForceY<GraphNode>).strength(params.center);
    const spring = (link: GraphLink) => {
      const source = link.source as GraphNode;
      const target = link.target as GraphNode;
      return springFor(link.weight, Math.min(source.springs, target.springs), params);
    };
    (simulation.force('link') as ForceLink<GraphNode, GraphLink>)
      .strength((link) => spring(link).strength)
      .distance((link) => spring(link).distance + (link.source as GraphNode).radius + (link.target as GraphNode).radius);
  }

  async function layout(first: boolean): Promise<void> {
    try {
      d3 ??= await loadD3();
    } catch (error) {
      announce(`그래프를 불러오지 못했습니다. ${errorText(error)}`, 'error');
      return;
    }
    if (disposed) return;
    if (!simulation) {
      simulation = d3.forceSimulation<GraphNode, GraphLink>()
        .force('charge', d3.forceManyBody<GraphNode>().theta(0.9).distanceMax(900))
        .force('link', d3.forceLink<GraphNode, GraphLink>().id((node) => node.id))
        .force('collide', alternate(d3.forceCollide<GraphNode>().radius((node) => node.radius + 2).strength(0.7)))
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
    const related = (id: string) => focus !== null && (id === focus.id || neighbors.has(id));
    const dimmed = 1 - (1 - DIM_ALPHA) * fade;

    // 선: 굵기·불투명도·점선별로 묶어 한 번에 긋는다.
    const buckets = new Map<string, { width: number; alpha: number; lit: boolean; dashed: boolean; list: GraphLink[] }>();
    for (const link of links) {
      if (!link.visible) continue;
      const source = link.source as GraphNode;
      const target = link.target as GraphNode;
      if (source.x === undefined || target.x === undefined) continue;
      if (Math.max(source.x, target.x!) < left || Math.min(source.x, target.x!) > right) continue;
      if (Math.max(source.y!, target.y!) < top || Math.min(source.y!, target.y!) > bottom) continue;
      const style = edgeStyle(link.weight);
      const lit = focus !== null && (source.id === focus.id || target.id === focus.id);
      const lineWidth = lit ? style.width + (style.width * 0.6 + 0.6) * fade : style.width;
      const alpha = lit ? style.alpha + (0.8 - style.alpha) * fade : style.alpha * (focus ? 1 - 0.8 * fade : 1);
      const qWidth = Math.round(lineWidth * 5) / 5;
      const qAlpha = Math.round(alpha * 40) / 40;
      const key = `${qWidth}|${qAlpha}|${lit ? 1 : 0}|${link.dashed ? 1 : 0}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { width: qWidth, alpha: qAlpha, lit, dashed: link.dashed, list: [] };
        buckets.set(key, bucket);
      }
      bucket.list.push(link);
    }
    const ordered = [...buckets.values()].sort((a, b) => Number(a.lit) - Number(b.lit) || a.width - b.width);
    for (const bucket of ordered) {
      ctx.globalAlpha = bucket.alpha;
      ctx.strokeStyle = bucket.lit ? palette.text : palette.muted;
      ctx.lineWidth = bucket.width / k;
      ctx.setLineDash(bucket.dashed ? [3 / k, 2.5 / k] : []);
      ctx.beginPath();
      for (const link of bucket.list) {
        const source = link.source as GraphNode;
        const target = link.target as GraphNode;
        ctx.moveTo(source.x!, source.y!);
        ctx.lineTo(target.x!, target.y!);
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 점: 색·불투명도별로 묶는다. 문서와 영역은 수가 적어 하나씩 그린다.
    const circles = new Map<string, GraphNode[]>();
    const holes = new Map<number, GraphNode[]>();
    const rings: GraphNode[] = [];
    const singles: GraphNode[] = [];
    const visibleNodes: GraphNode[] = [];
    for (const node of nodes) {
      if (node.x === undefined || node.y === undefined) continue;
      if (node.x + node.radius < left || node.x - node.radius > right || node.y + node.radius < top || node.y - node.radius > bottom) continue;
      visibleNodes.push(node);
      if (node.kind === 'doc' || node.kind === 'clip') {
        singles.push(node);
        continue;
      }
      const alpha = focus && !related(node.id) ? Math.round(dimmed * 40) / 40 : 1;
      const key = `${node.color}|${alpha}`;
      const group = circles.get(key);
      if (group) group.push(node);
      else circles.set(key, [node]);
      if (node.kind === 'note') {
        const hole = holes.get(alpha);
        if (hole) hole.push(node);
        else holes.set(alpha, [node]);
      }
      if (node.pinned || (node === focus && fade > 0)) rings.push(node);
    }
    for (const [key, group] of circles) {
      const split = key.lastIndexOf('|');
      ctx.globalAlpha = Number(key.slice(split + 1));
      ctx.fillStyle = key.slice(0, split);
      ctx.beginPath();
      for (const node of group) {
        ctx.moveTo(node.x! + node.radius, node.y!);
        ctx.arc(node.x!, node.y!, node.radius, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.fillStyle = palette.bg;
    for (const [alpha, group] of holes) {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      for (const node of group) {
        ctx.moveTo(node.x! + node.radius * 0.42, node.y!);
        ctx.arc(node.x!, node.y!, node.radius * 0.42, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    for (const node of singles) {
      ctx.globalAlpha = focus && !related(node.id) ? dimmed : 1;
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
        ctx.globalAlpha = focus && !related(node.id) ? dimmed : 1;
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
    const rank = (node: GraphNode) => (node === focus ? 0 : related(node.id) ? 1 : node.kind === 'doc' ? 2 : node.pinned ? 3 : 4);
    const candidates: Array<{ node: GraphNode; alpha: number }> = [];
    for (const node of visibleNodes) {
      let alpha = node.kind === 'doc' ? 1 : labelAlpha(k, node.strength, maxStrength);
      if (focus) alpha = related(node.id) ? Math.max(alpha, fade) : alpha * (1 - fade);
      if (alpha < 0.03) continue;
      candidates.push({ node, alpha });
    }
    candidates.sort((a, b) => rank(a.node) - rank(b.node) || b.node.strength - a.node.strength);
    const placed: Array<[number, number, number, number]> = [];
    for (const { node, alpha } of candidates) {
      if (placed.length >= MAX_LABELS) break;
      if (node.labelWidth < 0) node.labelWidth = ctx.measureText(node.labelText).width;
      const sx = width / 2 + view.x + node.x! * k;
      const sy = height / 2 + view.y + (node.y! + node.radius) * k + 3;
      const half = node.labelWidth / 2 + 3;
      const box: [number, number, number, number] = [sx - half, sy - 1, sx + half, sy + 14];
      if (box[2] < 0 || box[0] > width || box[1] > height || box[3] < 0) continue;
      if (rank(node) > 0 && placed.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
      placed.push(box);
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3;
      ctx.strokeStyle = palette.bg;
      ctx.strokeText(node.labelText, sx, sy);
      ctx.fillStyle = node === focus || node.kind === 'doc' ? palette.text : palette.muted;
      ctx.fillText(node.labelText, sx, sy);
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
    grid ??= buildGrid();
    const reach = 16 + 5 / view.k;
    let best: GraphNode | null = null;
    let bestDistance = Infinity;
    for (let cx = Math.floor((point.x - reach) / GRID_CELL); cx <= Math.floor((point.x + reach) / GRID_CELL); cx++) {
      for (let cy = Math.floor((point.y - reach) / GRID_CELL); cy <= Math.floor((point.y + reach) / GRID_CELL); cy++) {
        for (const node of grid.get(cellKey(cx, cy)) ?? []) {
          const distance = Math.hypot(node.x! - point.x, node.y! - point.y);
          if (distance <= node.radius + 5 / view.k && distance < bestDistance) {
            best = node;
            bestDistance = distance;
          }
        }
      }
    }
    return best;
  }

  function neighborIds(node: GraphNode): Set<string> {
    const ids = new Set<string>();
    for (const link of adjacent.get(node.id) ?? []) {
      const source = endpointId(link.source);
      ids.add(source === node.id ? endpointId(link.target) : source);
    }
    return ids;
  }

  function setHover(node: GraphNode | null): void {
    if (node === hover) return;
    hover = node;
    if (node) {
      // 다른 노드로 바로 옮기면 흐림을 유지한 채 초점만 바꾼다.
      focus = node;
      neighbors = neighborIds(node);
    }
    canvas.style.cursor = node ? 'pointer' : '';
    canvas.title = node ? node.label : '';
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
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-effective', 'data-theme'] });

  return {
    element,
    update(next) {
      project = next;
      if (next) loadProjectForces(next.id);
      rebuild();
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
      recolor();
      resize();
      if (project && !simulation) void layout(true);
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

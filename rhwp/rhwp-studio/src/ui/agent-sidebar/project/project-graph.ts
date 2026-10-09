/**
 * 프로젝트 그래프 — 캔버스 위의 힘 배치(d3-force, 처음 열 때 불러온다).
 *
 * 노드는 항목과 프로젝트 문서, 선은 연결이다. 반발력은 forceManyBody(Barnes–Hut)가 맡는다.
 * 시뮬레이션은 alpha 가 내려앉으면 스스로 멈추고, 동작 줄이기 사용자는 한 번에 계산한
 * 정지 배치를 본다. 노드를 끌어 놓으면 그 자리에 고정(graph-pin)하고, 고정한 노드를
 * 두 번 누르면 풀린다. 빈 곳을 끌면 화면을 옮기고 휠로 확대한다.
 */
import type { ForceLink, Simulation, SimulationLinkDatum, SimulationNodeDatum } from 'd3-force';
import { itemColumnId } from '../../../agent/project-service.ts';
import type { ProjectStore } from '../../../agent/project-service.ts';
import type { ProjectSnapshot } from '../../../agent/types.ts';
import {
  button,
  columnColor,
  el,
  errorText,
  reducedMotion,
} from './project-ui.ts';

export interface ProjectGraphDeps {
  store: ProjectStore;
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
  kind: 'file' | 'note' | 'doc';
  radius: number;
  color: string;
  degree: number;
  pinned: boolean;
  documentId?: string;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  label?: string;
}

type D3Force = typeof import('d3-force');

let d3Loader: Promise<D3Force> | null = null;
function loadD3(): Promise<D3Force> {
  d3Loader ??= import('d3-force');
  return d3Loader;
}

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const LABEL_ZOOM = 0.85;
const DRAG_THRESHOLD_PX = 3;
const PREWARM_TICKS = 120;
const MAX_LABEL_CHARS = 26;
const UNTAGGED = '__untagged__';

function endpointId(end: string | number | GraphNode | undefined): string {
  return typeof end === 'object' && end ? end.id : String(end ?? '');
}

function truncate(text: string): string {
  return text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text;
}

export function createProjectGraph(deps: ProjectGraphDeps): ProjectGraph {
  const { store, announce } = deps;
  let project: ProjectSnapshot | null = null;
  let active = false;
  let disposed = false;
  let d3: D3Force | null = null;
  let simulation: Simulation<GraphNode, GraphLink> | null = null;
  let nodes: GraphNode[] = [];
  let links: GraphLink[] = [];
  const nodeById = new Map<string, GraphNode>();
  let structureKey = '';
  let colorMode: ColorMode = 'column';
  let view = { x: 0, y: 0, k: 1 };
  let userMoved = false;
  let hover: GraphNode | null = null;
  let neighbors = new Set<string>();
  let frame = 0;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let palette = { text: '#000', muted: '#888', edge: '#ccc', bg: '#fff', font: 'system-ui' };

  const element = el('div', 'ag-pgraph');
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
  const fit = button('ag-pgraph-fit', '전체 보기', { icon: 'fit' });
  toolbar.append(modes, fit);
  const legend = el('ul', 'ag-pgraph-legend');
  legend.setAttribute('aria-label', '색 범례');
  const empty = el('p', 'ag-pgraph-empty', '연결할 항목이 없습니다.');
  empty.hidden = true;
  element.append(canvas, toolbar, legend, empty);

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
  }

  function nodeColor(node: GraphNode): string {
    if (!project) return palette.muted;
    if (node.kind === 'doc') return palette.text;
    const item = project.items.find((entry) => entry.id === node.id);
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
      nodeById.clear();
      structureKey = '';
      return;
    }
    const pinned = project.graph.pinned;
    const nextNodes: GraphNode[] = [];
    const seen = new Set<string>();
    const add = (id: string, label: string, kind: GraphNode['kind'], documentId?: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const previous = nodeById.get(id);
      const node: GraphNode = previous ?? { id, label, kind, radius: 5, color: palette.muted, degree: 0, pinned: false };
      node.label = label;
      node.kind = kind;
      node.documentId = documentId;
      node.degree = 0;
      const pin = pinned[id];
      node.pinned = Boolean(pin);
      if (pin) {
        node.fx = pin[0];
        node.fy = pin[1];
        node.x ??= pin[0];
        node.y ??= pin[1];
      } else if (previous?.pinned) {
        node.fx = null;
        node.fy = null;
      }
      nextNodes.push(node);
    };
    for (const member of project.members) add(member.nodeId, member.name, 'doc', member.documentId);
    for (const item of project.items) if (!item.trashedAt) add(item.id, item.title, item.kind === 'note' ? 'note' : 'file');
    const nextLinks: GraphLink[] = [];
    for (const link of project.links) {
      if (!seen.has(link.from) || !seen.has(link.to) || link.from === link.to) continue;
      nextLinks.push({ id: link.id, source: link.from, target: link.to, label: link.label });
    }
    const index = new Map(nextNodes.map((node) => [node.id, node]));
    for (const link of nextLinks) {
      index.get(endpointId(link.source))!.degree += 1;
      index.get(endpointId(link.target))!.degree += 1;
    }
    // 새 노드는 이미 자리 잡은 이웃 곁에서 시작해 화면을 가로지르지 않게 한다.
    for (const node of nextNodes) {
      if (node.x !== undefined && node.y !== undefined) continue;
      const neighbor = nextLinks
        .map((link) => endpointId(link.source) === node.id ? endpointId(link.target) : endpointId(link.target) === node.id ? endpointId(link.source) : null)
        .map((id) => (id ? nodeById.get(id) : undefined))
        .find((other) => other?.x !== undefined);
      const angle = Math.random() * Math.PI * 2;
      node.x = (neighbor?.x ?? 0) + Math.cos(angle) * 24;
      node.y = (neighbor?.y ?? 0) + Math.sin(angle) * 24;
    }
    for (const node of nextNodes) {
      node.radius = node.kind === 'doc' ? 7 : 3.5 + Math.min(5, Math.sqrt(node.degree) * 1.6);
    }
    nodes = nextNodes;
    links = nextLinks;
    nodeById.clear();
    for (const node of nodes) nodeById.set(node.id, node);
    recolor();
    canvas.setAttribute('aria-label', `프로젝트 그래프, 노드 ${nodes.length}개, 연결 ${links.length}개`);
    empty.hidden = nodes.length > 0;
    const key = `${nodes.map((node) => node.id).join(',')}|${links.map((link) => `${endpointId(link.source)}>${endpointId(link.target)}`).join(',')}|${Object.keys(pinned).sort().join(',')}`;
    const changed = key !== structureKey;
    const first = structureKey === '';
    structureKey = key;
    if (changed) void layout(first);
    else draw();
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
        .force('charge', d3.forceManyBody<GraphNode>().strength(-90).theta(0.9).distanceMax(420))
        .force('link', d3.forceLink<GraphNode, GraphLink>().id((node) => node.id).distance(46).strength(0.5))
        .force('collide', d3.forceCollide<GraphNode>().radius((node) => node.radius + 3))
        .force('x', d3.forceX<GraphNode>(0).strength(0.05))
        .force('y', d3.forceY<GraphNode>(0).strength(0.05))
        .stop();
      simulation.on('tick', scheduleDraw);
      simulation.on('end', () => {
        if (!userMoved) fitView(false);
        scheduleDraw();
      });
    }
    simulation.nodes(nodes);
    (simulation.force('link') as ForceLink<GraphNode, GraphLink>).links(links);
    if (reducedMotion()) {
      simulation.stop();
      simulation.alpha(1);
      const ticks = Math.ceil(Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()));
      for (let index = 0; index < ticks; index++) simulation.tick();
      if (!userMoved) fitView(false);
      draw();
      return;
    }
    if (first) {
      // 처음 열 때는 조금 미리 풀어 둔다. 흩어진 점이 모이는 과정을 길게 보이지 않는다.
      simulation.alpha(1);
      for (let index = 0; index < PREWARM_TICKS; index++) simulation.tick();
      if (!userMoved) fitView(false);
      simulation.alpha(0.12);
    } else {
      simulation.alpha(Math.max(simulation.alpha(), 0.35));
    }
    if (active) simulation.restart();
    draw();
  }

  // ── 그리기 ────────────────────────────────────────────

  function resize(): void {
    const rect = element.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    width = Math.max(1, Math.round(rect.width));
    height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    draw();
  }

  function scheduleDraw(): void {
    if (frame || !active) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      draw();
    });
  }

  function draw(): void {
    if (!active || !width) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * view.k, 0, 0, dpr * view.k, dpr * (width / 2 + view.x), dpr * (height / 2 + view.y));
    const focus = hover;
    const dim = (id: string) => focus !== null && id !== focus.id && !neighbors.has(id);

    ctx.lineWidth = 1 / view.k;
    for (const link of links) {
      const source = link.source as GraphNode;
      const target = link.target as GraphNode;
      if (source.x === undefined || target.x === undefined) continue;
      const lit = focus !== null && (source.id === focus.id || target.id === focus.id);
      ctx.globalAlpha = focus === null ? 0.4 : lit ? 0.9 : 0.08;
      ctx.strokeStyle = lit ? palette.text : palette.muted;
      ctx.lineWidth = (lit ? 1.4 : 1) / view.k;
      ctx.beginPath();
      ctx.moveTo(source.x, source.y!);
      ctx.lineTo(target.x, target.y!);
      ctx.stroke();
    }

    for (const node of nodes) {
      if (node.x === undefined || node.y === undefined) continue;
      ctx.globalAlpha = dim(node.id) ? 0.18 : 1;
      ctx.fillStyle = node.color;
      ctx.beginPath();
      if (node.kind === 'doc') {
        const size = node.radius * 1.7;
        ctx.roundRect(node.x - size / 2, node.y - size / 2, size, size, 2);
      } else {
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      }
      ctx.fill();
      if (node.kind === 'note') {
        ctx.fillStyle = palette.bg;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
      if (node.pinned || node === focus) {
        ctx.strokeStyle = palette.text;
        ctx.lineWidth = 1.2 / view.k;
        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius + 2.5 / view.k + (node.kind === 'doc' ? 1.5 : 0), 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // 이름은 화면 좌표에서 그린다. 우선순위(가리킨 노드 → 이웃 → 문서 → 고정 → 연결 많은 순)대로
    // 놓고, 이미 놓인 이름과 겹치면 건너뛴다. 확대할수록 더 많은 이름이 자리를 얻는다.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = `11px ${palette.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    const rank = (node: GraphNode) => (node === focus ? 0 : focus && neighbors.has(node.id) ? 1 : node.kind === 'doc' ? 2 : node.pinned ? 3 : 4);
    const candidates = nodes
      .filter((node) => node.x !== undefined && node.y !== undefined)
      .filter((node) => {
        if (focus) return node === focus || neighbors.has(node.id);
        return view.k >= LABEL_ZOOM || node.kind === 'doc' || node.degree >= 4;
      })
      .sort((a, b) => rank(a) - rank(b) || b.degree - a.degree);
    const placed: Array<[number, number, number, number]> = [];
    for (const node of candidates) {
      const label = truncate(node.label);
      const sx = width / 2 + view.x + node.x! * view.k;
      const sy = height / 2 + view.y + (node.y! + node.radius) * view.k + 3;
      const half = ctx.measureText(label).width / 2 + 3;
      const box: [number, number, number, number] = [sx - half, sy - 1, sx + half, sy + 14];
      if (box[2] < 0 || box[0] > width || box[1] > height || box[3] < 0) continue;
      if (rank(node) > 1 && placed.some((other) => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1])) continue;
      placed.push(box);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = palette.bg;
      ctx.strokeText(label, sx, sy);
      ctx.fillStyle = node === focus || node.kind === 'doc' ? palette.text : palette.muted;
      ctx.fillText(label, sx, sy);
    }
    ctx.globalAlpha = 1;
  }

  function fitView(animate: boolean): void {
    void animate;
    const placed = nodes.filter((node) => node.x !== undefined && node.y !== undefined);
    if (!placed.length || !width) {
      view = { x: 0, y: 0, k: 1 };
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
    view = { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k };
    draw();
  }

  // ── 상호작용 ──────────────────────────────────────────

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left - width / 2 - view.x) / view.k,
      y: (clientY - rect.top - height / 2 - view.y) / view.k,
    };
  }

  function nodeAt(clientX: number, clientY: number): GraphNode | null {
    const point = toWorld(clientX, clientY);
    let best: GraphNode | null = null;
    let bestDistance = Infinity;
    for (const node of nodes) {
      if (node.x === undefined || node.y === undefined) continue;
      const distance = Math.hypot(node.x - point.x, node.y - point.y);
      if (distance <= node.radius + 5 / view.k && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }

  function setHover(node: GraphNode | null): void {
    if (node === hover) return;
    hover = node;
    neighbors = new Set();
    if (node) {
      for (const link of links) {
        const source = endpointId(link.source);
        const target = endpointId(link.target);
        if (source === node.id) neighbors.add(target);
        if (target === node.id) neighbors.add(source);
      }
    }
    canvas.style.cursor = node ? 'pointer' : '';
    canvas.title = node ? node.label : '';
    draw();
  }

  function zoomAt(clientX: number, clientY: number, factor: number): void {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left - width / 2;
    const sy = clientY - rect.top - height / 2;
    const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.k * factor));
    const ratio = k / view.k;
    view = { k, x: sx - (sx - view.x) * ratio, y: sy - (sy - view.y) * ratio };
    userMoved = true;
    draw();
  }

  async function commitPin(op: { op: 'graph-pin'; id: string; x: number; y: number } | { op: 'graph-unpin'; id: string }): Promise<void> {
    try {
      await store.edit([op]);
    } catch (error) {
      announce(errorText(error), 'error');
    }
  }

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
    if (!node) canvas.classList.add('ag-panning');
  });

  canvas.addEventListener('pointermove', (event) => {
    if (!gesture) {
      setHover(nodeAt(event.clientX, event.clientY));
      return;
    }
    if (event.pointerId !== gesture.pointerId) return;
    if (gesture.kind === 'pan') {
      view = { ...view, x: gesture.viewX + event.clientX - gesture.startX, y: gesture.viewY + event.clientY - gesture.startY };
      userMoved = true;
      draw();
      return;
    }
    if (!gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < DRAG_THRESHOLD_PX) return;
    gesture.moved = true;
    const point = toWorld(event.clientX, event.clientY);
    const node = gesture.node;
    node.fx = point.x;
    node.fy = point.y;
    if (reducedMotion() || !simulation) {
      node.x = point.x;
      node.y = point.y;
      draw();
    } else {
      simulation.alphaTarget(0.2).restart();
    }
  });

  const finishGesture = (event: PointerEvent, cancelled: boolean) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const current = gesture;
    gesture = null;
    canvas.classList.remove('ag-panning');
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (current.kind !== 'node') return;
    simulation?.alphaTarget(0);
    const node = current.node;
    if (current.moved) {
      if (cancelled) return;
      node.pinned = true;
      const x = Math.round(node.fx ?? node.x ?? 0);
      const y = Math.round(node.fy ?? node.y ?? 0);
      void commitPin({ op: 'graph-pin', id: node.id, x, y });
      return;
    }
    if (cancelled) return;
    if (node.kind === 'doc') {
      if (node.documentId) deps.openDocument?.(node.documentId);
      return;
    }
    deps.openPreview(node.id);
  };
  canvas.addEventListener('pointerup', (event) => finishGesture(event, false));
  canvas.addEventListener('pointercancel', (event) => finishGesture(event, true));
  canvas.addEventListener('pointerleave', () => { if (!gesture) setHover(null); });

  canvas.addEventListener('dblclick', (event) => {
    const node = nodeAt(event.clientX, event.clientY);
    if (!node?.pinned) return;
    node.pinned = false;
    node.fx = null;
    node.fy = null;
    void commitPin({ op: 'graph-unpin', id: node.id });
    if (simulation && !reducedMotion() && active) simulation.alpha(0.3).restart();
  });

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const scale = event.deltaMode === 1 ? 0.05 : 0.0018;
    zoomAt(event.clientX, event.clientY, Math.exp(-event.deltaY * scale * (event.ctrlKey ? 4 : 1)));
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

  const resizeObserver = new ResizeObserver(() => resize());
  resizeObserver.observe(element);
  const themeObserver = new MutationObserver(() => {
    readPalette();
    recolor();
    draw();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme-effective', 'data-theme'] });

  return {
    element,
    update(next) {
      project = next;
      if (!next) {
        rebuild();
        simulation?.stop();
        draw();
        return;
      }
      rebuild();
    },
    setActive(next) {
      if (active === next) return;
      active = next;
      if (!active) {
        simulation?.stop();
        setHover(null);
        return;
      }
      readPalette();
      recolor();
      resize();
      if (project && !simulation) void layout(true);
      else if (simulation && !reducedMotion() && simulation.alpha() > simulation.alphaMin()) simulation.restart();
      draw();
    },
    dispose() {
      disposed = true;
      simulation?.stop();
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      element.remove();
    },
  };
}

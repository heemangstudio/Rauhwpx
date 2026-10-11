/**
 * 프로젝트 그래프의 순수 계산 — 노드 쌍의 연결 세기, 힘 설정 → 물리 값, 선 굵기와 이름 표시.
 *
 * 연결 세기는 모든 관계를 더한다. 직접 연결(이름에 따라 조금씩 다름), 노트의 [[…]] 인용
 * (조각·쪽마다 따로 센다), 영역 → 원본, 같은 태그(약하게). 세기가 클수록 용수철이
 * 짧고 단단해지고 선이 굵어진다. 태그만 겹친 쌍은 보이지 않는 약한 용수철이다.
 */
import type { ProjectSnapshot } from '../../../agent/types.ts';

/** 관계 하나의 기본 세기. */
export const RELATION_WEIGHT = { link: 1, note: 1, clip: 1.5, tag: 0.2 } as const;

/** 직접 연결 이름별 세기. 반박은 끌어당김이 조금 약하다. */
export const LINK_LABEL_WEIGHT: Readonly<Record<string, number>> = { 인용: 1.2, 근거: 1.2, 반박: 0.7 };

/** 태그 하나에 이보다 많은 항목이 있으면 모두를 잇지 않고 이웃 둘씩만 잇는다(쌍 수를 n 에 비례하게). */
export const TAG_CLIQUE_MAX = 10;

export interface GraphEdge {
  /** 정렬한 두 끝 id 를 이은 열쇠. */
  key: string;
  source: string;
  target: string;
  weight: number;
  /** 직접·노트·영역 관계가 하나라도 있으면 그린다. 태그만 겹치면 용수철만 있다. */
  visible: boolean;
  /** 영역 → 원본 관계뿐이면 점선. */
  dashed: boolean;
  labels: string[];
}

export interface GraphModel {
  edges: GraphEdge[];
  /** 노드별 보이는 연결 세기의 합. */
  strength: Map<string, number>;
  maxStrength: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** 프로젝트 관계를 노드 쌍마다 하나의 가중 연결로 모은다. nodeIds 밖의 끝은 버린다. */
export function buildGraphModel(
  project: Pick<ProjectSnapshot, 'items' | 'links'>,
  nodeIds: ReadonlySet<string>,
): GraphModel {
  const pairs = new Map<string, GraphEdge & { solid: boolean }>();
  const add = (a: string, b: string, weight: number, kind: 'solid' | 'clip' | 'tag', label?: string) => {
    if (a === b || !nodeIds.has(a) || !nodeIds.has(b)) return;
    const key = pairKey(a, b);
    let edge = pairs.get(key);
    if (!edge) {
      const [source, target] = a < b ? [a, b] : [b, a];
      edge = { key, source, target, weight: 0, visible: false, dashed: false, labels: [], solid: false };
      pairs.set(key, edge);
    }
    edge.weight += weight;
    if (kind !== 'tag') edge.visible = true;
    if (kind === 'solid') edge.solid = true;
    if (label && !edge.labels.includes(label)) edge.labels.push(label);
  };

  for (const link of project.links) {
    // 영역 → 원본은 항목에서 직접 만든다. 허브가 스냅샷에 넣은 것과 두 번 세지 않는다.
    if (link.origin === 'clip') continue;
    if (link.origin === 'note') add(link.from, link.to, RELATION_WEIGHT.note, 'solid', link.label);
    else add(link.from, link.to, link.label ? LINK_LABEL_WEIGHT[link.label] ?? RELATION_WEIGHT.link : RELATION_WEIGHT.link, 'solid', link.label);
  }
  const tagMembers = new Map<string, string[]>();
  for (const item of project.items) {
    if (item.trashedAt || !nodeIds.has(item.id)) continue;
    if (item.kind === 'clip') add(item.id, item.sourceId, RELATION_WEIGHT.clip, 'clip');
    for (const tag of new Set(item.tags)) {
      const members = tagMembers.get(tag);
      if (members) members.push(item.id);
      else tagMembers.set(tag, [item.id]);
    }
  }
  for (const members of tagMembers.values()) {
    const count = members.length;
    if (count < 2) continue;
    if (count <= TAG_CLIQUE_MAX) {
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) add(members[i], members[j], RELATION_WEIGHT.tag, 'tag');
      continue;
    }
    for (let i = 0; i < count; i++) {
      add(members[i], members[(i + 1) % count], RELATION_WEIGHT.tag, 'tag');
      add(members[i], members[(i + 2) % count], RELATION_WEIGHT.tag, 'tag');
    }
  }

  const strength = new Map<string, number>();
  let maxStrength = 0;
  const edges: GraphEdge[] = [];
  for (const { solid, ...edge } of pairs.values()) {
    edge.weight = Math.round(edge.weight * 1000) / 1000;
    edge.dashed = edge.visible && !solid;
    edges.push(edge);
    if (!edge.visible) continue;
    for (const id of [edge.source, edge.target]) {
      const next = (strength.get(id) ?? 0) + edge.weight;
      strength.set(id, next);
      if (next > maxStrength) maxStrength = next;
    }
  }
  return { edges, strength, maxStrength };
}

// ── 힘 설정 ─────────────────────────────────────────────

/** 슬라이더 네 개의 자리(0..1). 0.5 가 기본 배치다. */
export interface GraphForceSettings {
  center: number;
  repel: number;
  linkStrength: number;
  linkDistance: number;
}

export const FORCE_KEYS = ['center', 'repel', 'linkStrength', 'linkDistance'] as const;

export const DEFAULT_FORCE_SETTINGS: Readonly<GraphForceSettings> = Object.freeze({
  center: 0.5,
  repel: 0.5,
  linkStrength: 0.5,
  linkDistance: 0.5,
});

/** 슬라이더 양 끝의 물리 값. 사이는 기하 보간이라 가운데가 두 끝의 기하 평균이다. */
export const FORCE_RANGES: Readonly<Record<keyof GraphForceSettings, readonly [number, number]>> = {
  center: [0.008, 0.3],
  repel: [12, 600],
  linkStrength: [0.25, 4],
  linkDistance: [16, 200],
};

export interface GraphForceParams {
  /** forceX/forceY 세기. */
  center: number;
  /** forceManyBody 세기(음수). */
  repel: number;
  /** 연결 용수철 세기에 곱하는 수. */
  linkStrength: number;
  /** 세기 1 인 연결의 기본 길이. */
  linkDistance: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function geometric([min, max]: readonly [number, number], position: number): number {
  return min * (max / min) ** clamp(position, 0, 1);
}

/** 저장된 값을 읽는다. 모르는 값은 기본으로, 범위 밖은 끝으로 돌린다. */
export function normalizeForceSettings(value: unknown): GraphForceSettings {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const settings = { ...DEFAULT_FORCE_SETTINGS };
  for (const key of FORCE_KEYS) {
    const raw = source[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) settings[key] = clamp(raw, 0, 1);
  }
  return settings;
}

export function forceParams(settings: GraphForceSettings): GraphForceParams {
  return {
    center: geometric(FORCE_RANGES.center, settings.center),
    repel: -geometric(FORCE_RANGES.repel, settings.repel),
    linkStrength: geometric(FORCE_RANGES.linkStrength, settings.linkStrength),
    linkDistance: geometric(FORCE_RANGES.linkDistance, settings.linkDistance),
  };
}

/** 세기 → 용수철 배율. 세기 1 이면 1, 로그로 자라 2.5 에서 멈춘다. */
function weightFactor(weight: number): number {
  return clamp(Math.log2(1 + Math.max(0, weight)), 0.1, 2.5);
}

/** 세기 1, 끝 연결 하나인 용수철의 기본 단단함. 세기가 커질 여유를 남긴다. */
const SPRING_BASE = 0.35;

/**
 * 연결 하나의 용수철. d3 기본처럼 두 끝 중 연결이 적은 쪽 수로 나눠 허브가 흔들리지 않게 하고,
 * 세기가 클수록 단단하고(최대 1) 짧다.
 */
export function springFor(weight: number, minEndpointCount: number, params: GraphForceParams): { strength: number; distance: number } {
  const strength = clamp(SPRING_BASE * params.linkStrength * weightFactor(weight) / Math.max(1, minEndpointCount), 0.002, 1);
  const distance = params.linkDistance * clamp(1.3 - 0.3 * Math.log2(1 + Math.max(0, weight)), 0.55, 1.3);
  return { strength, distance };
}

/** 선 굵기(화면 px)와 불투명도. */
export function edgeStyle(weight: number): { width: number; alpha: number } {
  const scale = Math.log2(1 + Math.max(0, weight));
  return {
    width: clamp(0.6 + 0.8 * scale, 0.6, 3),
    alpha: clamp(0.22 + 0.18 * scale, 0.22, 0.7),
  };
}

/** 노드 반지름(세계 좌표). 연결 세기의 제곱근에 비례하고, 문서는 조금 더 크다. */
export function nodeRadius(kind: 'file' | 'note' | 'doc' | 'clip', strength: number): number {
  const root = Math.sqrt(Math.max(0, strength));
  if (kind === 'doc') return 7 + Math.min(4, root * 0.9);
  if (kind === 'clip') return 8 + Math.min(3, root * 0.7);
  return 3.5 + Math.min(9, root * 1.7);
}

/** 이 배율에서 세기 0 인 노드의 이름이 다 보인다. */
export const LABEL_ZOOM = 0.85;

/**
 * 이름 불투명도. 확대할수록 나타나고, 무거운 노드는 더 작은 배율에서 먼저 나타난다.
 */
export function labelAlpha(zoom: number, strength: number, maxStrength: number): number {
  const share = maxStrength > 0 ? clamp(strength / maxStrength, 0, 1) : 0;
  const threshold = LABEL_ZOOM * (1 - 0.6 * Math.sqrt(share));
  const fadeIn = threshold * 0.35;
  return clamp((zoom - (threshold - fadeIn)) / fadeIn, 0, 1);
}

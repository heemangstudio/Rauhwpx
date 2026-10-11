import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FORCE_SETTINGS,
  FORCE_RANGES,
  TAG_CLIQUE_MAX,
  buildGraphModel,
  forceParams,
  labelAlpha,
  normalizeForceSettings,
  springFor,
} from '../src/ui/agent-sidebar/project/graph-model.ts';
import type { ProjectItem, ProjectLink, ProjectSnapshot } from '../src/agent/types.ts';

function item(id: string, kind: ProjectItem['kind'], tags: string[] = [], extra: Record<string, unknown> = {}): ProjectItem {
  return { id, kind, title: id, column: null, order: 0, tags, pinned: false, summary: '', createdAt: 0, updatedAt: 0, addedBy: { kind: 'user' }, ...extra } as ProjectItem;
}

function link(from: string, to: string, origin: ProjectLink['origin'], label?: string): ProjectLink {
  return { id: `l${from}${to}`, from, to, origin, ...(label ? { label } : {}) };
}

function model(project: Pick<ProjectSnapshot, 'items' | 'links'>, extraIds: string[] = []) {
  const ids = new Set([...project.items.filter((entry) => !entry.trashedAt).map((entry) => entry.id), ...extraIds]);
  const built = buildGraphModel(project, ids);
  const weight = (a: string, b: string) => built.edges.find((edge) => (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a));
  return { ...built, weight };
}

test('relations of every kind add up per node pair', () => {
  const { weight, strength, maxStrength } = model({
    items: [
      item('fa', 'file', ['통계', '예산']),
      item('fb', 'file', ['통계', '예산']),
      item('nc', 'note'),
      item('rd', 'clip', [], { sourceId: 'fa', page: 1, rect: [0, 0, 0.5, 0.5] }),
      item('fe', 'file', ['통계']),
      item('ft', 'file', [], { trashedAt: 1 }),
    ],
    links: [
      link('fa', 'fb', 'explicit', '인용'),
      link('fb', 'fe', 'explicit', '반박'),
      // 노트가 같은 파일의 두 조각을 인용하면 두 번 센다.
      link('nc', 'fa', 'note'),
      link('nc', 'fa', 'note'),
      link('dx', 'fa', 'explicit'),
      // 허브가 넣은 영역 연결은 항목에서 만든 것과 겹치지 않는다.
      link('rd', 'fa', 'clip'),
      link('nc', 'ft', 'note'),
    ],
  }, ['dx']);

  // 인용 1.2 + 같은 태그 둘(0.2 × 2).
  assert.equal(weight('fa', 'fb')!.weight, 1.6);
  assert.equal(weight('fa', 'fb')!.visible, true);
  assert.deepEqual(weight('fa', 'fb')!.labels, ['인용']);
  // 반박은 기본 연결보다 약하다. 태그 하나가 겹친다.
  assert.equal(weight('fb', 'fe')!.weight, 0.9);
  assert.equal(weight('nc', 'fa')!.weight, 2);
  assert.equal(weight('dx', 'fa')!.weight, 1);
  assert.equal(weight('rd', 'fa')!.weight, 1.5);
  assert.equal(weight('rd', 'fa')!.dashed, true);
  // 태그만 겹친 쌍은 보이지 않는 약한 용수철이다.
  assert.equal(weight('fa', 'fe')!.weight, 0.2);
  assert.equal(weight('fa', 'fe')!.visible, false);
  // 휴지통 항목으로 가는 연결은 없다.
  assert.equal(weight('nc', 'ft'), undefined);

  // 세기 합은 보이는 연결만 더한다: 1.6 + 2 + 1 + 1.5.
  assert.equal(strength.get('fa'), 6.1);
  assert.equal(strength.get('fe'), 0.9);
  assert.equal(maxStrength, 6.1);
});

test('large tags connect members linearly instead of as a clique', () => {
  const count = 400;
  const items = Array.from({ length: count }, (_, index) => item(`f${index}`, 'file', ['통계']));
  const { edges } = model({ items, links: [] });
  assert.ok(count > TAG_CLIQUE_MAX);
  assert.equal(edges.length, count * 2);
  assert.ok(edges.every((edge) => !edge.visible && edge.weight === 0.2));
});

test('force settings map into bounded physics and stronger links are shorter and stiffer', () => {
  const low = forceParams({ center: 0, repel: 0, linkStrength: 0, linkDistance: 0 });
  const high = forceParams({ center: 1, repel: 1, linkStrength: 1, linkDistance: 1 });
  assert.equal(low.center, FORCE_RANGES.center[0]);
  assert.ok(Math.abs(high.center - FORCE_RANGES.center[1]) < 1e-9);
  assert.equal(low.repel, -FORCE_RANGES.repel[0]);
  assert.ok(Math.abs(high.repel + FORCE_RANGES.repel[1]) < 1e-9);
  assert.equal(low.linkDistance, FORCE_RANGES.linkDistance[0]);

  const middle = forceParams(DEFAULT_FORCE_SETTINGS);
  assert.ok(middle.repel < 0 && middle.repel > high.repel && middle.repel < low.repel);
  assert.ok(Math.abs(middle.linkStrength - 1) < 1e-9);

  // 저장값이 망가져 있어도 범위 안으로 돌아온다.
  assert.deepEqual(normalizeForceSettings({ center: 9, repel: -2, linkStrength: 'x', linkDistance: Number.NaN }), {
    center: 1, repel: 0, linkStrength: 0.5, linkDistance: 0.5,
  });
  assert.deepEqual(normalizeForceSettings(null), { ...DEFAULT_FORCE_SETTINGS });

  const weak = springFor(0.2, 1, middle);
  const normal = springFor(1, 1, middle);
  const strong = springFor(5, 1, middle);
  assert.ok(weak.strength < normal.strength && normal.strength < strong.strength);
  assert.ok(weak.distance > normal.distance && normal.distance > strong.distance);
  // 용수철은 아무리 세게 해도 1 을 넘지 않고, 허브 쪽 연결은 나눠 약해진다.
  assert.ok(springFor(50, 1, high).strength <= 1);
  assert.ok(springFor(1, 8, middle).strength < normal.strength);
});

test('heavier nodes keep their labels at lower zoom', () => {
  assert.equal(labelAlpha(1, 0, 10), 1);
  assert.equal(labelAlpha(0.3, 0, 10), 0);
  assert.ok(labelAlpha(0.45, 10, 10) > 0.9);
  assert.ok(labelAlpha(0.45, 10, 10) > labelAlpha(0.45, 2, 10));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { SimulationNodeDatum } from 'd3-force';

import { forceCollideFast, forceManyBodyFast } from '../src/ui/agent-sidebar/project/graph-forces.ts';

interface Node extends SimulationNodeDatum {
  id: number;
  radius: number;
}

/** d3-force 의 lcg 와 같은 결정적 난수. */
function lcg(seed = 1): () => number {
  let state = seed;
  return () => (state = (1664525 * state + 1013904223) % 4294967296) / 4294967296;
}

/** 무리와 같은 자리 점, 작은 좌표·음수 좌표가 섞인 노드. */
function scatter(count: number, seed: number): Node[] {
  const random = lcg(seed);
  const nodes: Node[] = [];
  for (let index = 0; index < count; index++) {
    const cluster = index % 7 === 0;
    const node: Node = {
      id: index,
      index,
      radius: 3 + random() * 10,
      x: cluster ? 40 + random() * 2 : (random() - 0.5) * 1400,
      y: cluster ? -25 + random() * 2 : (random() - 0.5) * 900,
      vx: (random() - 0.5) * 4,
      vy: (random() - 0.5) * 4,
    };
    nodes.push(node);
  }
  // 같은 자리 점 사슬.
  for (const index of [5, 6, 11].filter((index) => index < count)) {
    nodes[index].x = nodes[4].x;
    nodes[index].y = nodes[4].y;
  }
  return nodes;
}

function clone(nodes: Node[]): Node[] {
  return nodes.map((node) => ({ ...node }));
}

function assertSameVelocities(actual: Node[], expected: Node[], tolerance = 1e-9): void {
  for (let index = 0; index < expected.length; index++) {
    const a = actual[index];
    const e = expected[index];
    for (const key of ['vx', 'vy'] as const) {
      const scale = Math.max(1, Math.abs(e[key]!));
      assert.ok(Math.abs(a[key]! - e[key]!) <= tolerance * scale, `node ${index} ${key}: ${a[key]} vs d3 ${e[key]}`);
    }
  }
}

test('Barnes–Hut repulsion matches d3.forceManyBody', () => {
  for (const [count, theta, distanceMax] of [[1, 0.9, Infinity], [2, 0.9, Infinity], [60, 0.9, 900], [1500, 0.9, 900], [400, 0.5, 120]] as const) {
    const expected = scatter(count, count + 3);
    const actual = clone(expected);
    const reference = forceManyBody<Node>().strength(-75).theta(theta).distanceMax(distanceMax);
    const fast = forceManyBodyFast<Node>().strength(-75).theta(theta).distanceMax(distanceMax);
    reference.initialize(expected, lcg(9));
    fast.initialize(actual, lcg(9));
    for (const alpha of [1, 0.3, 0.012]) {
      reference(alpha);
      fast(alpha);
      assertSameVelocities(actual, expected);
    }
  }
});

test('per-node repulsion strength is honored', () => {
  const expected = scatter(300, 17);
  const actual = clone(expected);
  const strength = (node: Node) => (node.id % 3 === 0 ? -120 : node.id % 3 === 1 ? -10 : 0);
  const reference = forceManyBody<Node>().strength(strength).theta(0.9);
  const fast = forceManyBodyFast<Node>().strength(strength).theta(0.9);
  reference.initialize(expected, lcg(2));
  fast.initialize(actual, lcg(2));
  reference(0.5);
  fast(0.5);
  assertSameVelocities(actual, expected);
});

test('collision matches d3.forceCollide', () => {
  for (const [count, strength, iterations] of [[1, 0.7, 1], [2, 0.7, 1], [80, 0.7, 1], [1500, 0.7, 1], [600, 1, 3]] as const) {
    const expected = scatter(count, count + 11);
    // 겹치는 쌍이 많도록 좁은 곳에 모은다.
    for (const node of expected) {
      node.x! *= 0.08;
      node.y! *= 0.08;
    }
    const actual = clone(expected);
    const radius = (node: Node) => node.radius + 2;
    const reference = forceCollide<Node>().radius(radius).strength(strength).iterations(iterations);
    const fast = forceCollideFast<Node>().radius(radius).strength(strength).iterations(iterations);
    reference.initialize!(expected, lcg(4));
    fast.initialize(actual, lcg(4));
    reference(1);
    fast(1);
    assertSameVelocities(actual, expected);
  }
});

test('a whole simulation lays out the same as with d3 forces', () => {
  const build = (fast: boolean) => {
    const nodes = scatter(700, 5).map((node) => ({ ...node, vx: 0, vy: 0 }));
    const links = nodes.slice(1).map((node, index) => ({ source: nodes[Math.floor(index / 3)], target: node }));
    const simulation = forceSimulation<Node>(nodes)
      .force('charge', (fast ? forceManyBodyFast<Node>() : forceManyBody<Node>()).theta(0.9).distanceMax(900).strength(-60))
      .force('link', forceLink<Node, { source: Node; target: Node }>(links).distance(30))
      .force('collide', (fast ? forceCollideFast<Node>() : forceCollide<Node>()).radius((node) => node.radius + 2).strength(0.7))
      .force('x', forceX<Node>(0).strength(0.05))
      .force('y', forceY<Node>(0).strength(0.05))
      .stop();
    for (let tick = 0; tick < 150; tick++) simulation.tick();
    return nodes;
  };
  const expected = build(false);
  const actual = build(true);
  for (let index = 0; index < expected.length; index++) {
    assert.ok(Math.abs(actual[index].x! - expected[index].x!) < 1e-6, `node ${index} x`);
    assert.ok(Math.abs(actual[index].y! - expected[index].y!) < 1e-6, `node ${index} y`);
  }
});

test('the forces skip nodes without a position instead of poisoning the rest', () => {
  const nodes = scatter(50, 3);
  nodes[7].x = Number.NaN;
  nodes[9].y = Number.POSITIVE_INFINITY;
  const charge = forceManyBodyFast<Node>().strength(-30);
  const collide = forceCollideFast<Node>().radius((node) => node.radius);
  charge.initialize(nodes, lcg());
  collide.initialize(nodes, lcg());
  charge(1);
  collide(1);
  for (const node of nodes) {
    if (node.id === 7 || node.id === 9) continue;
    assert.ok(Number.isFinite(node.vx) && Number.isFinite(node.vy), `node ${node.id} stays finite`);
  }
});

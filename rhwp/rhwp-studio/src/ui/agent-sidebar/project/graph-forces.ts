/**
 * 프로젝트 그래프의 밀어내기·겹침 힘. d3-force 의 forceManyBody·forceCollide 와 같은 값을 내지만
 * 틱마다 객체를 만들지 않는다.
 *
 * d3 는 틱마다 노드 수만큼 사분 트리 객체를 만들고, 노드마다 트리를 돌며 방문한 칸마다 또 객체를
 * 만든다. 큰 그래프에서는 이 할당과 콜백이 틱 시간의 대부분이다. 여기서는 같은 트리(범위, 나누기,
 * 같은 자리 점 묶음, 방문 순서까지 d3-quadtree 와 같다)를 typed array 에 쌓고 다시 쓴다.
 * 덧셈 순서도 d3 와 같아서 같은 값을 낸다(tests/project-graph-forces.test.ts).
 */
import type { ForceCollide, ForceManyBody, SimulationNodeDatum } from 'd3-force';

type Random = () => number;
type NodeNumber<N> = (node: N, index: number, nodes: N[]) => number;
type Floats = Float64Array<ArrayBuffer>;
type Ints = Int32Array<ArrayBuffer>;

function constant<N>(value: number): NodeNumber<N> {
  return () => value;
}

/** d3-force 의 jiggle 과 같다. 같은 자리 두 점의 방향을 정한다. */
function jiggle(random: Random): number {
  return (random() - 0.5) * 1e-6;
}

/** links 에서 칸 하나가 차지하는 칸 수: [첫 점, 자식 0, 1, 2, 3]. */
const LINK = 5;

/**
 * 칸을 번호로 쌓은 사분 트리. 뿌리는 0 번이고 자식은 언제나 부모보다 번호가 크다. 그래서 번호를
 * 거꾸로 훑으면 자식을 부모보다 먼저 본다(d3 의 visitAfter). 한 칸에서 함께 읽는 값은 붙여 둔다.
 */
class FlatQuadtree {
  /** 칸 수. 0 이면 빈 트리다. */
  size = 0;
  maxDepth = 0;
  /**
   * 칸마다 [첫 점, 자식 0..3]. 첫 점은 잎이면 같은 자리 사슬의 첫 점, 안쪽 칸이면 -1 이다.
   * 자식 0 은 비었다는 뜻이다(뿌리는 누구의 자식도 아니다).
   */
  links = new Int32Array(64 * LINK);
  /** 칸마다 [x0, y0, x1, y1]. */
  bounds = new Float64Array(64 * 4);
  depth = new Int32Array(64);
  /** 같은 자리 점 사슬. -1 이면 끝. */
  next = new Int32Array(0);
  private xs = new Float64Array(0);
  private ys = new Float64Array(0);

  /** 점 0..n-1 로 트리를 다시 쌓는다. 유한하지 않은 좌표는 넣지 않는다. */
  build(xs: Floats, ys: Floats, n: number): void {
    this.size = 0;
    this.maxDepth = 0;
    this.xs = xs;
    this.ys = ys;
    if (this.next.length < n) this.next = new Int32Array(Math.max(n, this.next.length * 2));
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = xs[i];
      const y = ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (minX > maxX) return;
    // d3-quadtree 의 cover: 가장 작은 점의 정수 바닥에서 두 배씩 키운 정사각형.
    const x0 = Math.floor(minX);
    const y0 = Math.floor(minY);
    let side = 1;
    while (maxX >= x0 + side || maxY >= y0 + side) side *= 2;
    let root = -1;
    for (let i = 0; i < n; i++) {
      const x = xs[i];
      const y = ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      this.next[i] = -1;
      if (root < 0) root = this.cell(x0, y0, x0 + side, y0 + side, i, 0);
      else this.insert(i, x, y);
    }
  }

  private cell(x0: number, y0: number, x1: number, y1: number, head: number, depth: number): number {
    const index = this.size++;
    if (index >= this.depth.length) this.grow();
    const link = index * LINK;
    this.links[link] = head;
    this.links[link + 1] = 0;
    this.links[link + 2] = 0;
    this.links[link + 3] = 0;
    this.links[link + 4] = 0;
    const box = index * 4;
    this.bounds[box] = x0;
    this.bounds[box + 1] = y0;
    this.bounds[box + 2] = x1;
    this.bounds[box + 3] = y1;
    this.depth[index] = depth;
    if (depth > this.maxDepth) this.maxDepth = depth;
    return index;
  }

  /** 칸 c 의 사분면에 새 칸을 만든다. 범위는 d3 의 visit 와 같은 식으로 나눈다. */
  private child(c: number, quadrant: number, head: number): number {
    const box = c * 4;
    const x0 = this.bounds[box];
    const y0 = this.bounds[box + 1];
    const x1 = this.bounds[box + 2];
    const y1 = this.bounds[box + 3];
    const xm = (x0 + x1) / 2;
    const ym = (y0 + y1) / 2;
    const index = this.cell(
      quadrant & 1 ? xm : x0,
      quadrant & 2 ? ym : y0,
      quadrant & 1 ? x1 : xm,
      quadrant & 2 ? y1 : ym,
      head,
      this.depth[c] + 1,
    );
    this.links[c * LINK + 1 + quadrant] = index;
    return index;
  }

  private quadrant(c: number, x: number, y: number): number {
    const box = c * 4;
    const bounds = this.bounds;
    return (y >= (bounds[box + 1] + bounds[box + 3]) / 2 ? 2 : 0) | (x >= (bounds[box] + bounds[box + 2]) / 2 ? 1 : 0);
  }

  /** d3-quadtree 의 add 와 같다. 같은 자리 점은 사슬 앞에 붙이고, 잎은 두 점이 갈릴 때까지 나눈다. */
  private insert(point: number, x: number, y: number): void {
    let c = 0;
    while (this.links[c * LINK] < 0) {
      const quadrant = this.quadrant(c, x, y);
      const child = this.links[c * LINK + 1 + quadrant];
      if (!child) {
        this.child(c, quadrant, point);
        return;
      }
      c = child;
    }
    const other = this.links[c * LINK];
    const xp = this.xs[other];
    const yp = this.ys[other];
    if (x === xp && y === yp) {
      this.next[point] = other;
      this.links[c * LINK] = point;
      return;
    }
    this.links[c * LINK] = -1;
    for (;;) {
      const mine = this.quadrant(c, x, y);
      const theirs = this.quadrant(c, xp, yp);
      if (mine !== theirs) {
        this.child(c, theirs, other);
        this.child(c, mine, point);
        return;
      }
      c = this.child(c, mine, -1);
    }
  }

  private grow(): void {
    const capacity = this.depth.length * 2;
    const links = new Int32Array(capacity * LINK);
    links.set(this.links);
    this.links = links;
    const bounds = new Float64Array(capacity * 4);
    bounds.set(this.bounds);
    this.bounds = bounds;
    const depth = new Int32Array(capacity);
    depth.set(this.depth);
    this.depth = depth;
  }
}

function ensure(array: Floats, size: number): Floats {
  return array.length >= size ? array : new Float64Array(Math.max(size, array.length * 2));
}

function ensureInt(array: Ints, size: number): Ints {
  return array.length >= size ? array : new Int32Array(Math.max(size, array.length * 2));
}

/** d3.forceManyBody 와 같은 Barnes–Hut 밀어내기. */
export function forceManyBodyFast<N extends SimulationNodeDatum>(): ForceManyBody<N> {
  let nodes: N[] = [];
  let random: Random = Math.random;
  let strength: NodeNumber<N> = constant(-30);
  let strengths = new Float64Array(0);
  let distanceMin2 = 1;
  let distanceMax2 = Infinity;
  let theta2 = 0.81;
  const tree = new FlatQuadtree();
  let xs = new Float64Array(0);
  let ys = new Float64Array(0);
  /** 칸마다 [세기 합, 무게 중심 x, y, 한 점으로 볼 최소 거리²]. */
  let cells = new Float64Array(0);
  let stack = new Int32Array(0);

  function initialize(): void {
    strengths = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) strengths[i] = +strength(nodes[i], i, nodes);
  }

  const force = ((alpha: number) => {
    const n = nodes.length;
    xs = ensure(xs, n);
    ys = ensure(ys, n);
    for (let i = 0; i < n; i++) {
      xs[i] = nodes[i].x ?? NaN;
      ys[i] = nodes[i].y ?? NaN;
    }
    tree.build(xs, ys, n);
    const size = tree.size;
    if (!size) return;
    cells = ensure(cells, size * 4);
    stack = ensureInt(stack, 3 * tree.maxDepth + 4);
    const { links, bounds, next } = tree;

    // 칸마다 세기의 합과 무게 중심(d3 의 accumulate). 자식 번호가 커서 거꾸로 훑으면 된다.
    for (let c = size - 1; c >= 0; c--) {
      const base = c * 4;
      const link = c * LINK;
      let sum = 0;
      let point = links[link];
      if (point < 0) {
        let weight = 0;
        let sx = 0;
        let sy = 0;
        for (let q = 1; q <= 4; q++) {
          const k = links[link + q] * 4;
          let w: number;
          if (k && (w = Math.abs(cells[k]))) {
            sum += cells[k];
            weight += w;
            sx += w * cells[k + 1];
            sy += w * cells[k + 2];
          }
        }
        cells[base + 1] = sx / weight;
        cells[base + 2] = sy / weight;
      } else {
        cells[base + 1] = xs[point];
        cells[base + 2] = ys[point];
        do {
          sum += strengths[point];
          point = next[point];
        } while (point >= 0);
      }
      cells[base] = sum;
      const w = bounds[base + 2] - bounds[base];
      cells[base + 3] = w * w / theta2;
    }

    for (let i = 0; i < n; i++) {
      const nx = xs[i];
      const ny = ys[i];
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue;
      const node = nodes[i];
      let vx = node.vx ?? 0;
      let vy = node.vy ?? 0;
      let top = 0;
      stack[top++] = 0;
      while (top > 0) {
        const c = stack[--top];
        const base = c * 4;
        const v = cells[base];
        if (!v) continue;
        let dx = cells[base + 1] - nx;
        let dy = cells[base + 2] - ny;
        let l = dx * dx + dy * dy;
        // 멀리 있는 칸은 한 점으로 본다.
        if (cells[base + 3] < l) {
          if (l < distanceMax2) {
            if (dx === 0) {
              dx = jiggle(random);
              l += dx * dx;
            }
            if (dy === 0) {
              dy = jiggle(random);
              l += dy * dy;
            }
            if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
            vx += dx * v * alpha / l;
            vy += dy * v * alpha / l;
          }
          continue;
        }
        const link = c * LINK;
        let point = links[link];
        if (point < 0) {
          // d3 처럼 자식 0, 1, 2, 3 순서로 들어간다.
          for (let q = 4; q >= 1; q--) {
            const k = links[link + q];
            if (k) stack[top++] = k;
          }
          continue;
        }
        if (l >= distanceMax2) continue;
        if (point !== i || next[point] >= 0) {
          if (dx === 0) {
            dx = jiggle(random);
            l += dx * dx;
          }
          if (dy === 0) {
            dy = jiggle(random);
            l += dy * dy;
          }
          if (l < distanceMin2) l = Math.sqrt(distanceMin2 * l);
        }
        do {
          if (point !== i) {
            const k = strengths[point] * alpha / l;
            vx += dx * k;
            vy += dy * k;
          }
          point = next[point];
        } while (point >= 0);
      }
      node.vx = vx;
      node.vy = vy;
    }
  }) as ForceManyBody<N>;

  force.initialize = (next: N[], nextRandom: Random) => {
    nodes = next;
    random = nextRandom;
    initialize();
  };
  force.strength = ((next?: number | NodeNumber<N>) => {
    if (next === undefined) return strength;
    strength = typeof next === 'function' ? next : constant(+next);
    initialize();
    return force;
  }) as ForceManyBody<N>['strength'];
  force.theta = ((next?: number) => {
    if (next === undefined) return Math.sqrt(theta2);
    theta2 = next * next;
    return force;
  }) as ForceManyBody<N>['theta'];
  force.distanceMin = ((next?: number) => {
    if (next === undefined) return Math.sqrt(distanceMin2);
    distanceMin2 = next * next;
    return force;
  }) as ForceManyBody<N>['distanceMin'];
  force.distanceMax = ((next?: number) => {
    if (next === undefined) return Math.sqrt(distanceMax2);
    distanceMax2 = next * next;
    return force;
  }) as ForceManyBody<N>['distanceMax'];
  return force;
}

/** d3.forceCollide 와 같은 겹침 힘. 다음 위치(x + vx)로 트리를 쌓고 겹친 쌍을 떼어 놓는다. */
export function forceCollideFast<N extends SimulationNodeDatum>(initialRadius?: number | NodeNumber<N>): ForceCollide<N> {
  let nodes: N[] = [];
  let random: Random = Math.random;
  let radius: NodeNumber<N> = typeof initialRadius === 'function' ? initialRadius : constant(initialRadius == null ? 1 : +initialRadius);
  let radii = new Float64Array(0);
  let strength = 1;
  let iterations = 1;
  const tree = new FlatQuadtree();
  let px = new Float64Array(0);
  let py = new Float64Array(0);
  let vxs = new Float64Array(0);
  let vys = new Float64Array(0);
  let xs = new Float64Array(0);
  let ys = new Float64Array(0);
  /** 칸마다 안에 든 가장 큰 반지름. */
  let reach = new Float64Array(0);
  let stack = new Int32Array(0);

  function initialize(): void {
    radii = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) radii[i] = +radius(nodes[i], i, nodes);
  }

  const force = ((_alpha: number) => {
    const n = nodes.length;
    px = ensure(px, n);
    py = ensure(py, n);
    vxs = ensure(vxs, n);
    vys = ensure(vys, n);
    xs = ensure(xs, n);
    ys = ensure(ys, n);
    for (let i = 0; i < n; i++) {
      const node = nodes[i];
      px[i] = node.x ?? NaN;
      py[i] = node.y ?? NaN;
      vxs[i] = node.vx ?? 0;
      vys[i] = node.vy ?? 0;
    }
    for (let k = 0; k < iterations; k++) {
      for (let i = 0; i < n; i++) {
        xs[i] = px[i] + vxs[i];
        ys[i] = py[i] + vys[i];
      }
      tree.build(xs, ys, n);
      const size = tree.size;
      if (!size) break;
      reach = ensure(reach, size);
      stack = ensureInt(stack, 3 * tree.maxDepth + 4);
      const { links, bounds } = tree;
      // d3 의 prepare. 잎은 사슬의 첫 점만 본다(d3 도 그렇다).
      for (let c = size - 1; c >= 0; c--) {
        const link = c * LINK;
        const point = links[link];
        if (point >= 0) {
          reach[c] = radii[point];
          continue;
        }
        let r = 0;
        for (let q = 1; q <= 4; q++) {
          const child = links[link + q];
          if (child && reach[child] > r) r = reach[child];
        }
        reach[c] = r;
      }
      for (let i = 0; i < n; i++) {
        const ri = radii[i];
        const ri2 = ri * ri;
        const xi = px[i] + vxs[i];
        const yi = py[i] + vys[i];
        if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
        let top = 0;
        stack[top++] = 0;
        while (top > 0) {
          const c = stack[--top];
          const rj = reach[c];
          const r = ri + rj;
          const link = c * LINK;
          const j = links[link];
          if (j >= 0) {
            // 쌍마다 한 번만, 번호가 큰 쪽을 만났을 때 민다.
            if (j <= i) continue;
            let x = xi - px[j] - vxs[j];
            let y = yi - py[j] - vys[j];
            let l = x * x + y * y;
            if (l < r * r) {
              if (x === 0) {
                x = jiggle(random);
                l += x * x;
              }
              if (y === 0) {
                y = jiggle(random);
                l += y * y;
              }
              l = Math.sqrt(l);
              l = (r - l) / l * strength;
              x *= l;
              y *= l;
              const rj2 = rj * rj;
              const share = rj2 / (ri2 + rj2);
              vxs[i] += x * share;
              vys[i] += y * share;
              const rest = 1 - share;
              vxs[j] -= x * rest;
              vys[j] -= y * rest;
            }
            continue;
          }
          const box = c * 4;
          if (bounds[box] > xi + r || bounds[box + 2] < xi - r || bounds[box + 1] > yi + r || bounds[box + 3] < yi - r) continue;
          for (let q = 4; q >= 1; q--) {
            const child = links[link + q];
            if (child) stack[top++] = child;
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      nodes[i].vx = vxs[i];
      nodes[i].vy = vys[i];
    }
  }) as ForceCollide<N>;

  force.initialize = (next: N[], nextRandom: Random) => {
    nodes = next;
    random = nextRandom;
    initialize();
  };
  force.radius = ((next?: number | NodeNumber<N>) => {
    if (next === undefined) return radius;
    radius = typeof next === 'function' ? next : constant(+next);
    initialize();
    return force;
  }) as ForceCollide<N>['radius'];
  force.strength = ((next?: number) => {
    if (next === undefined) return strength;
    strength = +next;
    return force;
  }) as ForceCollide<N>['strength'];
  force.iterations = ((next?: number) => {
    if (next === undefined) return iterations;
    iterations = +next;
    return force;
  }) as ForceCollide<N>['iterations'];
  return force;
}

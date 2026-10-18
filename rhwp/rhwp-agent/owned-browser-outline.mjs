// 모델이 읽는 페이지 개요. 관리형(Playwright AI aria JSON)과 네이티브(격리 세계 관찰)가 같은 노드 모양을 쓴다.
// 노드: { role, name?, ref?, value?, text?, checked?, disabled?, expanded?, pressed?, selected?, level?, children?: (node|string)[] }
export const OUTLINE_BYTES = 20_000;
export const OUTLINE_HINT = 'Narrow with scope or find.';
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem']);
// 범위(scope)로 고를 수 있는 컨테이너. 줄 수가 적어 ref를 붙여도 개요가 크게 늘지 않는다.
const CONTAINERS = new Set(['main', 'navigation', 'contentinfo', 'form', 'search', 'dialog', 'alertdialog', 'region', 'table', 'grid', 'tablist', 'menu', 'menubar', 'tree']);
// 기본 개요에서는 조작 요소가 많은 메뉴·바닥글을 한 줄로 접는다. find는 접기 전 전체 줄을, scope는 펼친 하위를 본다.
const COLLAPSIBLE = new Set(['navigation', 'contentinfo']);
const COLLAPSE_AFTER = 10;
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox', 'slider']);
const FLATTEN = new Set(['generic', 'none', 'presentation', 'group', 'rowgroup', 'strong', 'emphasis', 'mark', 'time', 'superscript', 'subscript', 'insertion', 'deletion', 'code', 'Section', 'figure', 'caption', 'label', 'legend', 'term', 'definition', 'note', 'status', 'log', 'marquee', 'timer', 'math']);
const DROP = new Set(['separator', 'LineBreak', 'presentation']);
const CELLS = new Set(['cell', 'columnheader', 'rowheader', 'gridcell']);
const HOLLOW = new Set(['list', 'listitem', 'banner', 'complementary', 'contentinfo', 'article', 'paragraph', 'row', 'table', 'blockquote', 'region', 'main', 'navigation', 'form', 'search']);
const STATES = ['level', 'checked', 'disabled', 'expanded', 'pressed', 'selected'];
const NAME_CHARS = 160, TEXT_CHARS = 400, OPTIONS = 20;
const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (value, max) => { const line = squash(value); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

/** Playwright AI JSON을 개요 노드로 줄인다. 조작 가능한 노드와 범위 컨테이너만 ref를 남기고 iframe은 읽지 않는다. */
export function outlineFromAria(nodes, { masked = new Set(), extra = new Map(), maskAll = false } = {}) {
  const convert = (node) => {
    if (typeof node === 'string') return node;
    if (!node || node.role === 'iframe') return null;
    // Playwright는 보이지 않는(크기 0) 요소에 ref를 주지 않는다. 누를 수 없는 조작 노드는 줄을 남기지 않는다.
    if (INTERACTIVE.has(node.role) && node.role !== 'option' && !node.ref) return node.children ? { role: 'generic', children: node.children.map(convert).filter((child) => child !== null) } : null;
    const local = typeof node.ref === 'string' && /^(?:f\d+)?e\d+$/.test(node.ref);
    // 이름 있는 generic은 대개 summary나 aria-label 위젯이다.
    const keep = local && (INTERACTIVE.has(node.role) || CONTAINERS.has(node.role) || node.cursor === 'pointer' || node.role === 'generic' && !!node.name || extra.has(node.ref) || masked.has(node.ref));
    const out = { role: keep && extra.get(node.ref) || node.role };
    if (node.name) out.name = node.name;
    if (keep) out.ref = node.ref;
    for (const key of STATES) if (node[key] !== undefined && node[key] !== false) out[key] = node[key];
    const secret = masked.has(node.ref) || maskAll && VALUE_ROLES.has(out.role);
    if (node.text) out[VALUE_ROLES.has(out.role) || secret ? 'value' : 'text'] = secret ? '[masked]' : node.text;
    if (Array.isArray(node.children) && !(secret && !VALUE_ROLES.has(out.role))) out.children = node.children.map(convert).filter((child) => child !== null);
    return out;
  };
  return (Array.isArray(nodes) ? nodes : []).map(convert).filter((node) => node !== null);
}

// 이름 없는 래퍼는 펼치고, 이름·라벨과 겹치는 글은 지우고, 자식이 하나인 래퍼는 자식으로 바꾼다.
function simplify(children, parent) {
  const flat = [];
  const push = (child) => {
    if (typeof child === 'string') { const line = squash(child); if (!line) return; if (typeof flat.at(-1) === 'string') flat[flat.length - 1] += ` ${line}`; else flat.push(line); return; }
    if (DROP.has(child.role) && !child.children || child.role === 'img' && !child.name && !child.ref) return;
    if (FLATTEN.has(child.role) && !child.ref && !child.name && !child.value) { if (child.text) push(child.text); for (const nested of child.children ?? []) push(nested); return; }
    const reduced = reduce(child);
    // 내용이 비어 남은 목록·구획 줄은 쓰지 않는다.
    if (!reduced.ref && !reduced.children && !reduced.text && !reduced.value && HOLLOW.has(reduced.role)) return;
    flat.push(reduced);
  };
  for (const child of children ?? []) push(child);
  const labels = flat.filter((child) => typeof child !== 'string').flatMap((child) => [child.name, child.value]).filter(Boolean).map(squash);
  const own = [parent?.name, parent?.value].filter(Boolean).map(squash);
  const echoes = (label, child) => label === child || child.length >= 4 && child.length * 2 >= label.length && label.includes(child);
  return flat.filter((child) => typeof child !== 'string' || !own.includes(child) && !labels.some((label) => echoes(label, child)));
}
const spoken = (node) => typeof node === 'string' ? node : [node.name, node.value ?? node.text, ...(node.children ?? []).map(spoken)].filter(Boolean).join(' ');
const hasRef = (node) => typeof node === 'object' && (!!node.ref || (node.children ?? []).some(hasRef));
function reduce(node) {
  const out = { ...node };
  if (out.children) out.children = simplify(out.children, out);
  // 이름이 내용에서 나온 조작 노드는 같은 내용을 자식으로 다시 쓰지 않는다. 안쪽 조작 노드와 선택지만 남긴다.
  if (out.ref && out.name && out.children && !['combobox', 'listbox'].includes(out.role)) out.children = out.children.filter(hasRef);
  if (!out.children?.length) delete out.children;
  const only = out.children?.length === 1 ? out.children[0] : undefined;
  if (typeof only === 'string' && !out.text && !out.value) { out.text = only; delete out.children; }
  // 그림 하나만 감싼 링크·버튼은 그림의 대체 글을 이름으로 쓴다.
  else if (only?.role === 'img' && out.ref && !out.name && !out.text && only.name && !only.ref) { out.name = only.name; delete out.children; }
  else if (only && typeof only === 'object' && !out.ref && out.name && squash(only.name) === squash(out.name)) delete out.name;
  // 내용에서 나온 이름이 자식 글과 겹치면 이름을 지운다(긴 셀·제목).
  else if (!out.ref && out.name && out.children && squash(out.children.map(spoken).join(' ')).includes(squash(out.name))) delete out.name;
  if (out.role === 'row' && out.children?.every((cell) => typeof cell === 'string' || CELLS.has(cell.role) && !cell.ref && !cell.children)) {
    out.text = out.children.map((cell) => typeof cell === 'string' ? cell : squash(cell.name ?? cell.text ?? '')).join(' | '); delete out.children;
  }
  if (out.role === 'combobox' && !out.value) { const chosen = out.children?.find((child) => child.role === 'option' && child.selected); if (chosen?.name) out.value = chosen.name; }
  if (out.text && out.name && squash(out.name).toLowerCase().includes(squash(out.text).toLowerCase())) delete out.text;
  // 이름·ref 없는 래퍼가 노드 하나만 감싸면 래퍼 줄을 없앤다. 제목은 구조로 남긴다.
  if (!out.ref && !out.name && !out.text && !out.value && out.role !== 'heading' && out.children?.length === 1 && typeof out.children[0] === 'object') return out.children[0];
  return out;
}

const quote = (value) => JSON.stringify(clip(value, NAME_CHARS));
function lineOf(node) {
  if (typeof node === 'string') return `- text: ${clip(node, TEXT_CHARS)}`;
  let line = `- ${node.role}`;
  if (node.name) line += ` ${quote(node.name)}`;
  for (const key of STATES) if (node[key] !== undefined) line += node[key] === true ? ` [${key}]` : ` [${key}=${node[key]}]`;
  if (node.ref) line += ` [ref=${node.ref}]`;
  const detail = node.value ?? node.text;
  if (detail) line += `: ${clip(detail, TEXT_CHARS)}`;
  return line;
}
const controls = (nodes) => nodes.flatMap((node) => typeof node === 'object' ? [...(node.ref ? [node] : []), ...controls(node.children ?? [])] : []);
function lines(nodes, depth, out, scoped, collapse) {
  for (const node of nodes) {
    const children = typeof node === 'string' ? undefined : node.children;
    const folded = collapse && node.ref && COLLAPSIBLE.has(node.role) && children ? controls(children) : [];
    if (folded.length > COLLAPSE_AFTER) { out.push({ depth, line: `${lineOf(node)}: +${folded.length} ${folded.every((entry) => entry.role === 'link') ? 'links' : 'controls'}` }); continue; }
    out.push({ depth, line: lineOf(node) });
    if (!children) continue;
    const options = ['combobox', 'listbox'].includes(node.role) && !scoped && children.length > OPTIONS + 5;
    lines(options ? children.slice(0, OPTIONS) : children, depth + 1, out, false, collapse);
    if (options) out.push({ depth: depth + 1, line: `- text: +${children.length - OPTIONS} more options` });
  }
  return out;
}
const find = (nodes, ref) => { for (const node of nodes) { if (typeof node === 'string') continue; if (node.ref === ref) return node; const nested = find(node.children ?? [], ref); if (nested) return nested; } return null; };

/** 개요를 만든다. refs에는 표시되는 ref 전체를, all에는 제한 전 전체 줄을 담는다. */
export function renderOutline(nodes, { scope, find: query, maxBytes = OUTLINE_BYTES } = {}) {
  let roots = simplify(nodes);
  const refs = new Map();
  const collect = (list) => { for (const node of list) if (typeof node === 'object') { if (node.ref) refs.set(node.ref, { role: node.role, name: squash(node.name), value: squash(node.value) }); collect(node.children ?? []); } };
  collect(roots);
  if (scope) { const found = find(roots, scope); roots = found ? [found] : []; }
  const all = lines(roots, 0, [], !!scope, false);
  let selected = scope ? all : lines(roots, 0, [], false, true);
  let matches;
  if (query) {
    const needle = squash(query).toLowerCase(); const keep = new Set(); const stack = [];
    all.forEach((entry, index) => {
      while (stack.length && all[stack.at(-1)].depth >= entry.depth) stack.pop();
      if (entry.line.toLowerCase().includes(needle)) { keep.add(index); for (const ancestor of stack) keep.add(ancestor); }
      stack.push(index);
    });
    matches = all.filter((entry, index) => keep.has(index) && entry.line.toLowerCase().includes(needle)).length;
    selected = all.filter((_, index) => keep.has(index));
  }
  const kept = []; let bytes = 0; let truncated = false;
  for (const entry of selected) {
    const line = `${'  '.repeat(entry.depth)}${entry.line}`; const size = Buffer.byteLength(line) + 1;
    if (bytes + size > maxBytes) { truncated = true; break; }
    kept.push(line); bytes += size;
  }
  return { outline: kept.join('\n'), truncated, refs, all: all.map((entry) => entry.line), ...(query ? { matches } : {}), ...(scope ? { scoped: roots.length > 0 } : {}) };
}

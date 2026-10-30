/**
 * 에이전트 도구가 쓰는 문서 단위 조회: 개요 트리와 문단 내용 지문.
 * 문단 서식은 엔진 formatRuns 조회 한 번으로 구역 전체를 읽는다.
 */
import type { ParagraphInfo } from '../../../vendor/hm-wasm/hm_wasm';
import { extendBridge } from './api';
import type { HmCore, ListAddress } from './core';
import { bodyList } from './address';

interface ListRef { kind: 'bullet' | 'numbering' | 'outline'; id: number; level: number }
interface ParagraphFormat {
  index: number; styleId: number; paraShapeId: number; list: ListRef | null;
  runs: Array<{ offset: number; charShapeId: number }>;
}

function formatRuns(core: HmCore, list: ListAddress, from: number, count: number): ParagraphFormat[] {
  return core.query<ParagraphFormat[]>({ kind: 'formatRuns', list, from, count });
}

/** 64비트 FNV-1a. 같은 내용이면 같은 지문이고, 바뀐 문단만 다르게 나오면 충분하다. */
function fnv(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** 본문 문단의 글자·개체·서식 지문. 엔진 배치가 바꾼 문단 구간을 찾는 데 쓴다. */
export function getParagraphContentDigest(core: HmCore, sec: number, para: number): string | null {
  const list = bodyList(sec);
  const info: ParagraphInfo = core.paragraph(list, para);
  const format = formatRuns(core, list, para, 1)[0];
  const controls = info.controls.map(c => [c.kind, c.offset, c.inline ?? null, c.script ?? null, c.lists]);
  return fnv(JSON.stringify([info.text, controls, format?.styleId, format?.paraShapeId, format?.list,
    format?.runs.map(run => [run.offset, run.charShapeId])]));
}

type OutlineNode = {
  level: number; kind: string; marker?: string; heading: string; section: number; paragraph: number;
  children: OutlineNode[];
};

/** 조문 제목 판정: 제N편/장/절/관/조, ①…⑳, 1., 가. */
function clauseHeading(text: string): { level: number; kind: string; marker: string } | null {
  const t = text.trimStart();
  const first = t.codePointAt(0);
  if (first !== undefined && first >= 0x2460 && first <= 0x2473) return { level: 6, kind: '항', marker: String.fromCodePoint(first) };
  const article = /^제\s*\d+\s*(편|장|절|관|조)(의\s*\d+)?/.exec(t);
  if (article) {
    const levels: Record<string, number> = { 편: 1, 장: 2, 절: 3, 관: 4, 조: 5 };
    return { level: levels[article[1]], kind: article[1], marker: article[0].replace(/\s+/g, '') };
  }
  const item = /^(\d+)\.(?=\s|$)/.exec(t);
  if (item) return { level: 7, kind: '호', marker: item[0] };
  const sub = /^([가-하])\.(?=\s|$)/.exec(t);
  if (sub && '가나다라마바사아자차카타파하'.includes(sub[1])) return { level: 8, kind: '목', marker: sub[0] };
  return null;
}

/** 개요(문단 개요·번호 수준) 또는 조문 패턴으로 제목 트리를 만든다. auto 는 개요가 있으면 개요다. */
export function getOutlineStructure(core: HmCore, mode: string): {
  mode: string; node_count: number; preamble?: string[]; roots: Array<Record<string, unknown>>;
} | null {
  if (mode !== 'auto' && mode !== 'outline' && mode !== 'clause') return null;
  const sections = core.adapter.getSectionCount();
  const paragraphs: Array<{ section: number; paragraph: number; text: string; list: ListRef | null }> = [];
  for (let section = 0; section < sections; section++) {
    const list = bodyList(section);
    const count = core.paragraphCount(list);
    const formats = formatRuns(core, list, 0, count);
    for (let p = 0; p < count; p++) {
      paragraphs.push({ section, paragraph: p, text: core.paragraph(list, p).text, list: formats[p]?.list ?? null });
    }
  }
  const numbered = (list: ListRef | null) => list?.kind === 'outline' || list?.kind === 'numbering';
  const used = mode === 'auto' ? (paragraphs.some(p => numbered(p.list)) ? 'outline' : 'clause') : mode;
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  let count = 0;
  for (const p of paragraphs) {
    const heading = used === 'outline'
      ? (numbered(p.list) ? { level: p.list!.level + 1, kind: 'outline', marker: '' } : null)
      : clauseHeading(p.text);
    const text = p.text.replace(/\s+/g, ' ').trim();
    if (!heading || !text) continue;
    const node: OutlineNode = { level: heading.level, kind: heading.kind, heading: text,
      section: p.section, paragraph: p.paragraph, children: [] };
    if (heading.marker) node.marker = heading.marker;
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    (stack.length ? stack[stack.length - 1].children : roots).push(node);
    stack.push(node);
    count += 1;
  }
  return { mode: used, node_count: count, roots };
}

extendBridge({ getParagraphContentDigest, getOutlineStructure });

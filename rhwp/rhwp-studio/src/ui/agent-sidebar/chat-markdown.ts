import {
  appendMarkdownBlocks,
  MarkdownTokenCache,
  type Block,
  type MarkdownNode,
  type MarkdownRenderOptions,
} from './plan-markdown.ts';
import { createIcon } from './icons.ts';
import { parseCssTimeMs } from './motion-model.ts';

type KatexModule = typeof import('katex');

let katexModule: KatexModule | null = null;
let katexLoad: Promise<void> | null = null;
const pendingMathTargets = new Set<HTMLElement>();
interface ChatMarkdownState {
  source: string;
  opts: ChatMarkdownOptions;
  tokens: MarkdownTokenCache;
  fenceLine: number;
  openFence: string | null;
  /** 수식 표기를 이미 찾아본 앞부분 길이. 이어 붙은 끝만 다시 본다. */
  mathScanned: number;
}
const markdownSourceByTarget = new WeakMap<HTMLElement, ChatMarkdownState>();
/** target 의 최상위 자식 순서대로, 각 노드를 만든 블록의 직렬화 키. */
const blockKeysByTarget = new WeakMap<HTMLElement, string[]>();
/** target 의 본문 블록 노드. 매 프레임 자식을 훑지 않도록 키와 함께 둔다. */
const blockNodesByTarget = new WeakMap<HTMLElement, HTMLElement[]>();
const keyByBlock = new WeakMap<Block, string>();

export interface ChatMarkdownOptions {
  /** 스트리밍 중에는 완성된 블록만 그린다. 쓰는 중인 마지막 블록은 다음 블록이 시작될 때까지 보류한다. */
  streaming?: boolean;
  /** 새로 붙은 블록에 등장 애니메이션을 준다. */
  animate?: boolean;
  /** 새로 만들거나 바꾼 최상위 블록마다 한 번 부른다. 수식 모듈이 늦게 와 다시 그릴 때도 부른다. */
  decorate?: (node: HTMLElement) => void;
}

/**
 * 한국어 키보드·문서에서 백슬래시가 실제 원화 기호로 들어온 LaTeX를 복구한다.
 * 변환은 수식 경계 안에서만 수행하므로 일반 채팅의 금액 표기는 바뀌지 않는다.
 */
export function normalizeKoreanLatex(source: string) {
  return source.replace(/[₩￦]/gu, '\\');
}

function loadKatex() {
  katexLoad ??= import('katex')
    .then((module) => {
      katexModule = module;
      for (const target of pendingMathTargets) {
        const entry = markdownSourceByTarget.get(target);
        if (!entry || !target.isConnected) continue;
        // 수식 노드만 달라지므로 같은 키라도 다시 그린다.
        blockKeysByTarget.delete(target);
        renderChatMarkdown(target, entry.source, { ...entry.opts, animate: false });
      }
      pendingMathTargets.clear();
    })
    .catch(() => {
      // 네트워크·청크 로드 실패 시 원문 수식을 그대로 유지한다.
      pendingMathTargets.clear();
    });
  return katexLoad;
}

export function renderChatMath(
  node: MarkdownNode,
  source: string,
  displayMode: boolean,
) {
  if (!katexModule || typeof HTMLElement === 'undefined' || !(node instanceof HTMLElement)) return false;
  try {
    katexModule.render(normalizeKoreanLatex(source), node, {
      displayMode,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      output: 'mathml',
      maxExpand: 1_000,
      maxSize: 20,
    });
    return true;
  } catch {
    return false;
  }
}

function mayContainMath(source: string) {
  return /\$|\\[([]|[₩￦][([]/u.test(source);
}

/** 끝의 공백 꼬리에 빈 줄이 있는지. /\n[ \t]*\n\s*$/u 와 같지만 답변 전체 대신 꼬리만 본다. */
function endsWithBlankLine(source: string): boolean {
  let start = source.length;
  while (start > 0 && /\s/u.test(source[start - 1]!)) start -= 1;
  return /\n[ \t]*\n/u.test(source.slice(start));
}

const RE_FENCE_MARK = /^ {0,3}(```|~~~)/u;

/** 여는 펜스와 같은 종류의 줄로만 닫는다. 다른 종류의 펜스 줄은 코드 본문이다. */
function fencesClosed(source: string): boolean {
  let open: string | null = null;
  for (const line of source.split('\n')) {
    const mark = RE_FENCE_MARK.exec(line)?.[1];
    if (!mark) continue;
    if (open === null) open = mark;
    else if (open === mark) open = null;
  }
  return open === null;
}

function cachedFencesClosed(state: ChatMarkdownState): boolean {
  let open = state.openFence;
  let start = state.fenceLine;
  while (start <= state.source.length) {
    const end = state.source.indexOf('\n', start);
    const mark = RE_FENCE_MARK.exec(state.source.slice(start, end < 0 ? undefined : end))?.[1];
    if (mark) open = open === null ? mark : open === mark ? null : open;
    // 마지막 줄은 다음 청크가 완성하므로 그 줄 앞의 상태만 저장한다.
    if (end < 0) return open === null;
    start = end + 1;
    state.fenceLine = start;
    state.openFence = open;
  }
  return open === null;
}

export function stableStreamingBlocks(
  blocks: readonly Block[],
  source: string,
  closedFences = fencesClosed(source),
): Block[] {
  if (blocks.length === 0) return [];
  const last = blocks[blocks.length - 1]!;
  const lastClosed = closedFences && endsWithBlankLine(source);
  if (lastClosed) return [...blocks];
  const stable = blocks.slice(0, -1);
  if (last.kind === 'list' && last.items.length > 1) {
    stable.push({ ...last, items: last.items.slice(0, -1) });
  }
  return stable;
}

function renderBlockNode(block: Block): HTMLElement | null {
  const fragment = document.createDocumentFragment();
  appendMarkdownBlocks(fragment, [block], document, CHAT_MARKDOWN_OPTIONS);
  let node = fragment.firstElementChild as HTMLElement | null;
  if (node && block.kind === 'code') node = wrapCodeBlock(node, block.lang, block.code);
  node?.setAttribute('data-md-block', '');
  return node;
}

const PLAIN_CODE_LANGS = new Set(['', 'text', 'plain', 'plaintext', 'txt']);

/** 채팅 코드 블록에 조용한 머리(언어 이름 + 복사 버튼)를 붙인다. */
function wrapCodeBlock(pre: HTMLElement, lang: string, code: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ag-md-codeblock';
  const head = document.createElement('div');
  head.className = 'ag-md-codeblock-head';
  // 평문 코드 블록은 언어 이름이 정보가 없으므로 머리 줄 없이 복사 버튼만 띄운다.
  const plain = PLAIN_CODE_LANGS.has((lang || '').trim().toLowerCase());
  if (plain) wrap.classList.add('ag-md-codeblock-plain');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'ag-md-codeblock-copy';
  copy.title = '복사';
  copy.setAttribute('aria-label', '코드 복사');
  copy.appendChild(createIcon('copy'));
  let resetTimer: number | null = null;
  copy.addEventListener('click', (event) => {
    event.stopPropagation();
    void navigator.clipboard?.writeText(code).then(() => {
      copy.classList.add('ag-copied');
      copy.replaceChildren(createIcon('check'));
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        resetTimer = null;
        copy.classList.remove('ag-copied');
        copy.replaceChildren(createIcon('copy'));
      }, 1400);
    }).catch(() => {});
  });
  if (plain) {
    head.append(copy);
  } else {
    const label = document.createElement('span');
    label.className = 'ag-md-codeblock-lang';
    label.textContent = lang;
    head.append(label, copy);
  }
  wrap.append(head, pre);
  return wrap;
}

/** 본문 블록만 고른다. 복사 버튼처럼 답변에 덧붙인 요소는 맞추기 대상이 아니다. */
function blockNodesOf(target: HTMLElement): HTMLElement[] {
  // 지난번 노드가 처음과 끝 모두 그대로 붙어 있으면 다시 훑지 않는다.
  const cached = blockNodesByTarget.get(target);
  if (cached?.length && cached[0]!.parentNode === target && cached[cached.length - 1]!.parentNode === target) {
    return cached;
  }
  return Array.from(target.children).filter((node): node is HTMLElement =>
    node instanceof HTMLElement && node.hasAttribute('data-md-block'));
}

interface EnteringMotion {
  duration: number;
  easing: string;
}
/** 등장 모션 토큰. 블록마다 계산 스타일을 읽지 않도록 한 번 읽어 두고, 동작 줄이기가 바뀌면 다시 읽는다. */
let enteringMotion: EnteringMotion | null | undefined;
let enteringMotionWatched = false;

function readEnteringMotion(): EnteringMotion | null {
  if (enteringMotion !== undefined) return enteringMotion;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  if (reduced && !enteringMotionWatched) {
    enteringMotionWatched = true;
    reduced.addEventListener?.('change', () => { enteringMotion = undefined; });
  }
  const root = getComputedStyle(document.documentElement);
  const token = root.getPropertyValue('--ag-dur-base');
  const duration = parseCssTimeMs(token, 220);
  const motion = duration < 20 || reduced?.matches ? null : {
    duration,
    easing: root.getPropertyValue('--ag-ease-out').trim() || 'cubic-bezier(0.22, 1, 0.36, 1)',
  };
  // 스타일시트가 아직 붙지 않았으면 다음 블록에서 다시 읽는다.
  if (token.trim()) enteringMotion = motion;
  return motion;
}

/** 클래스를 남기지 않는 애니메이션이라 다음 비교에서 노드가 달라 보이지 않는다. */
/**
 * 새 블록의 짧은 등장(base 토큰, ease-out 토큰). 동작 줄이기(1ms 토큰)나 20ms 아래에서는
 * 걸지 않는다 — 1ms 애니메이션도 첫 프레임을 opacity 0 으로 그려 한 번 깜빡인다.
 */
function markEntering(node: Element): void {
  const motion = readEnteringMotion();
  if (!motion) return;
  node.animate(
    [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
    motion,
  );
}

/** 같은 모양의 목록은 항목 단위로 맞춰, 이미 보이는 항목을 다시 만들지 않는다. */
function reconcileList(current: Element, next: Element, animate: boolean): void {
  const nextChildren = Array.from(next.children);
  nextChildren.forEach((child, index) => {
    const existing = current.children[index];
    if (existing?.isEqualNode(child)) return;
    if (
      existing
      && existing.tagName === child.tagName
      && existing.className === child.className
      && /^(?:UL|OL|LI)$/u.test(child.tagName)
      && existing.firstElementChild?.isEqualNode(child.firstElementChild)
    ) {
      reconcileList(existing, child, animate);
      return;
    }
    if (existing) existing.replaceWith(child);
    else current.appendChild(child);
    if (animate) markEntering(child);
  });
  while (current.children.length > nextChildren.length) current.lastElementChild?.remove();
}

const CHAT_MARKDOWN_OPTIONS: MarkdownRenderOptions = {
  links: true,
  renderMath: renderChatMath,
  fileChips: true,
};

/**
 * 채팅용 Markdown·수식을 안전한 DOM으로 렌더링한다. 블록 키가 같은 최상위 노드는
 * 그대로 두고 달라진 블록만 새로 만들어, 스트리밍 중에도 읽던 문단이 흔들리지 않는다.
 */
export function renderChatMarkdown(target: HTMLElement, source: string, opts: ChatMarkdownOptions = {}) {
  const state = markdownSourceByTarget.get(target) ?? {
    source: '', opts, tokens: new MarkdownTokenCache(), fenceLine: 0, openFence: null, mathScanned: 0,
  };
  if (!source.startsWith(state.source)) {
    state.fenceLine = 0;
    state.openFence = null;
    state.mathScanned = 0;
  }
  state.source = source;
  state.opts = opts;
  markdownSourceByTarget.set(target, state);
  const parsed = state.tokens.tokenize(source);
  const blocks = opts.streaming ? stableStreamingBlocks(parsed, source, cachedFencesClosed(state)) : parsed;
  const keys = blocks.map((block) => {
    let key = keyByBlock.get(block);
    if (key === undefined) {
      key = JSON.stringify(block);
      keyByBlock.set(block, key);
    }
    return key;
  });
  let nodes = blockNodesOf(target);
  let previous = blockKeysByTarget.get(target);
  if (!previous || previous.length !== nodes.length) {
    for (const node of nodes) node.remove();
    nodes = [];
    previous = [];
  }
  const animate = opts.animate === true;
  keys.forEach((key, index) => {
    if (previous[index] === key) return;
    const node = renderBlockNode(blocks[index]!);
    if (!node) return;
    const existing = nodes[index];
    if (
      existing
      && /^(?:UL|OL)$/u.test(node.tagName)
      && existing.tagName === node.tagName
      && existing.getAttribute('start') === node.getAttribute('start')
    ) {
      reconcileList(existing, node, animate);
      opts.decorate?.(existing);
      return;
    }
    if (existing) {
      existing.replaceWith(node);
      nodes[index] = node;
    } else {
      // 새 블록은 마지막 본문 블록 바로 뒤, 덧붙인 요소보다 앞에 들어간다.
      const last = nodes[nodes.length - 1];
      target.insertBefore(node, last ? last.nextSibling : target.firstChild);
      nodes.push(node);
    }
    if (animate) markEntering(node);
    opts.decorate?.(node);
  });
  while (nodes.length > keys.length) nodes.pop()?.remove();
  blockKeysByTarget.set(target, keys);
  blockNodesByTarget.set(target, nodes);
  if (!katexModule) {
    // 수식 표기는 두 글자를 넘지 않는다 — 지난번 끝 한 글자부터 이어 본다.
    const from = Math.max(0, state.mathScanned - 1);
    state.mathScanned = source.length;
    if (mayContainMath(from > 0 ? source.slice(from) : source)) {
      pendingMathTargets.add(target);
      void loadKatex();
    }
  }
}

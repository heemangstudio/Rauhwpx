/**
 * 취향 학습(Rau-0.1) 구분선 — `Rau-0.1 N가지 배움`.
 *
 * 압축 구분선과 같은 선 · 이름 · 선 모양이지만 누르면 펼쳐진다. 펼친 줄은 바뀐 기억 하나마다
 * 새로/고침/지움 표와 글, 되돌리기를 보이고, 끝에 모두 보기(문서 기억 시트)와 — 이 학습이 낸
 * AGENTS.md 변경안이 아직 기다리면 — 지시에 추가 제안을 둔다.
 * 되돌린 줄은 흐리게 남고, 그새 바뀐 줄은 되돌리기가 꺼진다.
 */
import type { ThreadTasteMarker } from '../../agent/threads.ts';
import { RAU_TASTE_NAME } from '../../agent/taste.ts';
import type { TasteLearnItem } from '../../agent/types.ts';
import { createChevron } from '../chevron.ts';

const OP_TAG: Record<TasteLearnItem['op'], string> = { add: '새로', update: '고침', remove: '지움' };

export interface TasteMarkerHandlers {
  /** 항목 하나를 되돌린다. 끝나면 호출한 쪽이 update 로 결과를 그린다. */
  onUndo(entryId: string): void;
  onShowAll(): void;
  onProposal(): void;
  /** 펼침을 바꿨다 — 다시 그려도 펼친 채로 남게 호출한 쪽이 기억한다. */
  onToggle?(expanded: boolean): void;
}

export interface TasteMarkerView {
  root: HTMLElement;
  /**
   * 같은 구분선의 새 상태(더해진 항목·되돌림·만료)를 그린다. proposalPending 을 주면 지시에 추가 제안도
   * 다시 정한다 — 같은 턴의 늦은 학습이 변경안을 들고 올 때 그 변경안은 이미 와 있다.
   */
  update(marker: ThreadTasteMarker, opts?: { proposalPending?: boolean }): void;
  setUndoPending(entryId: string, pending: boolean): void;
  setProposalPending(pending: boolean): void;
}

let viewSeq = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function createTasteMarkerView(
  marker: ThreadTasteMarker,
  handlers: TasteMarkerHandlers,
  opts: { live?: boolean; expanded?: boolean; proposalPending?: boolean } = {},
): TasteMarkerView {
  const bodyId = `ag-taste-${++viewSeq}`;
  const root = el('div', 'ag-taste');
  root.dataset.learnId = marker.learnId;
  const toggle = el('button', 'ag-marker ag-marker-taste');
  toggle.type = 'button';
  toggle.setAttribute('aria-controls', bodyId);
  toggle.classList.toggle('ag-marker-live', opts.live === true);
  const label = el('span', 'ag-marker-label');
  const brand = el('span', 'ag-taste-brand', RAU_TASTE_NAME);
  const count = el('span', 'ag-taste-count');
  label.append(brand, ' ', count);
  toggle.append(el('span', 'ag-marker-line'), label, createChevron('ag-taste-chevron'), el('span', 'ag-marker-line'));
  if (opts.live) {
    // 한 번만 움직인다 — 다시 그려도 다시 움직이지 않는다.
    label.addEventListener('animationend', () => toggle.classList.remove('ag-marker-live'), { once: true });
  }

  const body = el('div', 'ag-taste-body');
  body.id = bodyId;
  const rows = el('ul', 'ag-taste-rows');
  const actions = el('div', 'ag-taste-actions');
  const showAll = el('button', 'ag-taste-action', '모두 보기');
  showAll.type = 'button';
  showAll.addEventListener('click', () => handlers.onShowAll());
  const proposal = el('button', 'ag-taste-action', '지시에 추가 제안');
  proposal.type = 'button';
  proposal.addEventListener('click', () => handlers.onProposal());
  actions.append(showAll, proposal);
  body.append(rows, actions);
  root.append(toggle, body);

  const pendingUndo = new Set<string>();
  let current = marker;

  function setExpanded(expanded: boolean): void {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    root.classList.toggle('ag-taste-open', expanded);
    body.hidden = !expanded;
  }
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    setExpanded(expanded);
    handlers.onToggle?.(expanded);
  });

  function buildRow(item: TasteLearnItem): HTMLElement {
    const row = el('li', 'ag-taste-row');
    row.dataset.entryId = item.entryId;
    row.dataset.op = item.op;
    const undone = current.undone?.includes(item.entryId) === true;
    const stale = !undone && current.stale?.includes(item.entryId) === true;
    if (undone) row.dataset.state = 'undone';
    else if (stale) row.dataset.state = 'stale';
    const text = el('span', 'ag-taste-text', item.text);
    text.title = item.op === 'update' && item.prevText ? `${item.prevText} → ${item.text}` : item.text;
    row.append(el('span', 'ag-taste-tag', OP_TAG[item.op]), text);
    if (undone) {
      row.append(el('span', 'ag-taste-undone', '되돌림'));
      return row;
    }
    const undo = el('button', 'ag-taste-undo', '되돌리기');
    undo.type = 'button';
    undo.disabled = stale || pendingUndo.has(item.entryId);
    if (pendingUndo.has(item.entryId)) undo.setAttribute('aria-busy', 'true');
    undo.addEventListener('click', () => handlers.onUndo(item.entryId));
    row.append(undo);
    return row;
  }

  function render(): void {
    count.textContent = `${current.items.length}가지 배움`;
    toggle.setAttribute('aria-label', `${RAU_TASTE_NAME} ${current.items.length}가지 배움`);
    // 되돌리기 단추에 있던 초점은 다시 그린 같은 줄로 옮긴다.
    const focused = rows.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).closest<HTMLElement>('.ag-taste-row')?.dataset.entryId ?? null
      : null;
    rows.replaceChildren(...current.items.map(buildRow));
    if (focused) {
      const row = [...rows.children].find((node) => (node as HTMLElement).dataset.entryId === focused) as HTMLElement | undefined;
      const target = row?.querySelector<HTMLButtonElement>('.ag-taste-undo:not(:disabled)') ?? null;
      if (target) target.focus({ preventScroll: true });
      else toggle.focus({ preventScroll: true });
    }
  }

  setExpanded(opts.expanded === true);
  proposal.hidden = !current.proposalDraftId || opts.proposalPending !== true;
  render();

  return {
    root,
    update(next, updateOpts) {
      current = next;
      root.dataset.learnId = next.learnId;
      if (!next.proposalDraftId) proposal.hidden = true;
      else if (updateOpts?.proposalPending !== undefined) proposal.hidden = !updateOpts.proposalPending;
      render();
    },
    setUndoPending(entryId, pending) {
      if (pending) pendingUndo.add(entryId);
      else pendingUndo.delete(entryId);
      render();
    },
    setProposalPending(pending) {
      proposal.hidden = !current.proposalDraftId || !pending;
    },
  };
}

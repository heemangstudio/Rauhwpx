/**
 * 취향 학습(Rau-0.1) 구분선 — `Rau-0.1 N가지 배움`.
 *
 * 압축 구분선과 같은 선 · 이름 · 선 모양이지만 누르면 펼쳐진다. 펼친 줄은 바뀐 기억 하나마다
 * NEW/보강/감쇄/장기기억 승격/EXIT/고침 표와 글, 강도의 바뀜(물그릇), 되돌리기를 보이고, 끝에 모두 보기
 * (계정의 기억이 섞였으면 설정 → Rau, 아니면 문서 기억 시트)를 둔다.
 * 되돌린 줄은 흐리게 남고, 그새 바뀐 줄은 되돌리기가 꺼진다.
 */
import type { ThreadTasteMarker } from '../../agent/threads.ts';
import { RAU_TASTE_NAME, TASTE_CHANGE_LABELS, tasteItemChange } from '../../agent/taste.ts';
import type { TasteLearnItem } from '../../agent/types.ts';
import { createChevron } from '../chevron.ts';
import { createIcon } from './icons.ts';
import { createStrengthGauge } from './strength-gauge.ts';

/** 계정의 기억(설정 → Rau)에 닿은 줄이 있는가 — 모두 보기가 어디로 갈지 정한다. */
export function tasteMarkerTouchesAccount(items: readonly TasteLearnItem[]): boolean {
  return items.some((item) => item.tier === 'account');
}

export interface TasteMarkerHandlers {
  /** 항목 하나를 되돌린다. 끝나면 호출한 쪽이 update 로 결과를 그린다. */
  onUndo(entryId: string): void;
  /** account 가 참이면 설정 → Rau, 아니면 문서 기억 시트를 연다. */
  onShowAll(account: boolean): void;
  /** 펼침을 바꿨다 — 다시 그려도 펼친 채로 남게 호출한 쪽이 기억한다. */
  onToggle?(expanded: boolean): void;
}

export interface TasteMarkerView {
  root: HTMLElement;
  /** 같은 구분선의 새 상태(더해진 항목·되돌림·만료)를 그린다. */
  update(marker: ThreadTasteMarker): void;
  setUndoPending(entryId: string, pending: boolean): void;
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
  opts: { live?: boolean; expanded?: boolean } = {},
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
  showAll.addEventListener('click', () => handlers.onShowAll(tasteMarkerTouchesAccount(current.items)));
  actions.append(showAll);
  body.append(rows, actions);
  root.append(toggle, body);

  const pendingUndo = new Set<string>();
  let current = marker;
  /** 이미 물이 움직인 줄 — 다시 그려도 다시 움직이지 않는다. */
  const animated = new Set<string>();

  function setExpanded(expanded: boolean): void {
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    root.classList.toggle('ag-taste-open', expanded);
    body.hidden = !expanded;
  }
  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') !== 'true';
    setExpanded(expanded);
    if (expanded) render();
    handlers.onToggle?.(expanded);
  });

  function buildRow(item: TasteLearnItem): HTMLElement {
    const row = el('li', 'ag-taste-row');
    const change = tasteItemChange(item);
    row.dataset.entryId = item.entryId;
    row.dataset.op = item.op;
    row.dataset.change = change;
    if (item.tier === 'account') row.dataset.tier = 'account';
    const undone = current.undone?.includes(item.entryId) === true;
    const stale = !undone && current.stale?.includes(item.entryId) === true;
    if (undone) row.dataset.state = 'undone';
    else if (stale) row.dataset.state = 'stale';
    const text = el('span', 'ag-taste-text', item.text);
    text.title = item.prevText ? `${item.prevText} → ${item.text}` : item.text;
    row.append(el('span', 'ag-taste-tag', TASTE_CHANGE_LABELS[change]), text);
    if (item.strength && !undone) {
      // 펼친 뒤 처음 보일 때만 물이 움직인다 — 접힌 채로 움직이면 아무도 못 본다.
      const live = body.hidden === false && !animated.has(item.entryId);
      if (live) animated.add(item.entryId);
      row.append(createStrengthGauge(item.strength.to, {
        from: item.strength.from,
        animate: live,
        muted: item.strength.to === 0,
        // 다시 그리거나 움직임을 줄였을 때도 보강·감쇄가 새 기억과 구별되게 처음 강도를 쓴다.
        showFrom: true,
      }).root);
    }
    if (undone) {
      row.append(el('span', 'ag-taste-undone', '되돌림'));
      return row;
    }
    const undo = el('button', 'ag-taste-undo');
    undo.type = 'button';
    undo.setAttribute('aria-label', '되돌리기');
    undo.title = '되돌리기';
    undo.append(createIcon('undo'));
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
  // 다시 그린 구분선(새로고침·채팅 전환)이 펼쳐져 있으면 이미 본 것으로 친다.
  if (opts.expanded) for (const item of current.items) animated.add(item.entryId);
  render();

  return {
    root,
    update(next) {
      current = next;
      root.dataset.learnId = next.learnId;
      render();
    },
    setUndoPending(entryId, pending) {
      if (pending) pendingUndo.add(entryId);
      else pendingUndo.delete(entryId);
      render();
    },
  };
}

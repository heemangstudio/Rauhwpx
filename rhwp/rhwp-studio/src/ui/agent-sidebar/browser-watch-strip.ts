/**
 * 페이지 감시 — 입력기 위에 이 채팅이 맡긴 감시를 한 줄씩 보이고, 대화에는 바뀐 페이지 알림을 그린다.
 * DOM 만 맡는다. 허브 요청은 콜백으로만 알린다.
 */
import './browser-watch.css';
import {
  siteLabel,
  watchIntervalLabel,
  type BrowserWatchNotice,
  type BrowserWatchSummary,
} from '../../agent/browser-watch-notices.ts';
import { createIcon } from './icons.ts';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(className: string, url: string, text: string): HTMLAnchorElement {
  const anchor = el('a', className, text);
  anchor.href = url;
  anchor.title = url;
  anchor.rel = 'noreferrer';
  return anchor;
}

/** 마지막 확인 시각 — 방금, 5분 전, 2시간 전, 3일 전. */
export function watchCheckedLabel(at: number | null, now = Date.now()): string {
  if (at === null) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return '방금 확인';
  if (minutes < 60) return `${minutes}분 전 확인`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}시간 전 확인`;
  return `${Math.floor(minutes / (24 * 60))}일 전 확인`;
}

export interface BrowserWatchStrip {
  root: HTMLElement;
  render(watches: readonly BrowserWatchSummary[]): void;
}

export function createBrowserWatchStrip(options: { onCancel(watchId: string): void }): BrowserWatchStrip {
  const root = el('section', 'ag-watches');
  root.setAttribute('aria-label', '페이지 감시');
  root.hidden = true;
  const list = el('ul', 'ag-watches-list');
  root.append(list);

  return {
    root,
    render(watches) {
      list.replaceChildren(...watches.map((watch) => {
        const row = el('li', 'ag-watch');
        row.dataset.watchId = watch.watchId;
        row.dataset.status = watch.status;
        const icon = el('span', 'ag-watch-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.append(createIcon(watch.status === 'paused' ? 'pause' : 'eye'));
        const title = link('ag-watch-title', watch.url, watch.title || siteLabel(watch.url));
        const meta = el('span', 'ag-watch-meta', watch.status === 'paused'
          ? '멈춤'
          : [watchIntervalLabel(watch.intervalMinutes), watchCheckedLabel(watch.lastCheckedAt)].filter(Boolean).join(', '));
        const cancel = el('button', 'ag-watch-cancel');
        cancel.type = 'button';
        cancel.title = '감시 끝내기';
        cancel.setAttribute('aria-label', `${watch.title || siteLabel(watch.url)} 감시 끝내기`);
        cancel.append(createIcon('close'));
        cancel.addEventListener('click', () => {
          cancel.disabled = true;
          options.onCancel(watch.watchId);
        });
        row.append(icon, title, meta, cancel);
        return row;
      }));
      root.hidden = watches.length === 0;
    },
  };
}

/** 대화 속 감시 알림 한 덩이. */
export function renderWatchNotice(notice: BrowserWatchNotice): HTMLElement {
  const card = el('div', 'ag-watch-notice');
  card.dataset.change = notice.change;
  const head = el('div', 'ag-watch-notice-head');
  const icon = el('span', 'ag-watch-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon(notice.change === 'paused' ? 'pause' : 'eye'));
  head.append(
    icon,
    link('ag-watch-notice-title', notice.url, notice.title || siteLabel(notice.url)),
    el('span', 'ag-watch-notice-state', notice.change === 'paused' ? '사이트 접근이 필요해 확인을 멈췄습니다' : '페이지가 바뀌었습니다'),
  );
  card.append(head);
  if (notice.change === 'changed' && (notice.added.length || notice.removed.length)) {
    const diff = el('ul', 'ag-watch-notice-diff');
    for (const line of notice.added) diff.append(el('li', 'ag-watch-added', line));
    for (const line of notice.removed) diff.append(el('li', 'ag-watch-removed', line));
    const more = notice.addedCount + notice.removedCount - notice.added.length - notice.removed.length;
    if (more > 0) diff.append(el('li', 'ag-watch-more', `외 ${more}줄`));
    card.append(diff);
  }
  return card;
}

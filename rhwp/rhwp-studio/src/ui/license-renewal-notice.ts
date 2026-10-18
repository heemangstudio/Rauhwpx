import './license-renewal-notice.css';

/**
 * 결제가 실패했거나 기간이 끝난 연간 키를 알리는 카드. 문서 영역 왼쪽 아래에 떠 있고 화면을 막지 않는다.
 * 같은 안내(종류와 날짜)는 '닫기' 뒤 이 창에서 다시 띄우지 않는다. 다시 실행하면 다시 뜬다.
 */
export interface RenewalNoticeContent {
  /** 같은 안내인지 가르는 값. 바뀌면 닫았던 카드도 다시 뜬다. */
  id: string;
  title: string;
  detail: string;
  action: string;
  onAction: () => void;
  secondary?: { label: string; onClick: () => void };
}

export interface RenewalNotice {
  show(content: RenewalNoticeContent | null): void;
}

function button(className: string, label: string): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  return node;
}

export function createRenewalNotice(): RenewalNotice {
  const dismissed = new Set<string>();
  let card: HTMLElement | null = null;
  let shownId: string | null = null;

  function hide(): void {
    card?.remove();
    card = null;
    shownId = null;
  }

  function show(content: RenewalNoticeContent | null): void {
    if (!content || dismissed.has(content.id)) {
      hide();
      return;
    }
    if (shownId === content.id && card?.isConnected) return;
    hide();
    const root = document.createElement('section');
    root.className = 'license-renewal-notice';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    root.setAttribute('aria-labelledby', 'license-renewal-notice-title');
    const title = document.createElement('h2');
    title.id = 'license-renewal-notice-title';
    title.className = 'license-renewal-notice-title';
    title.textContent = content.title;
    const detail = document.createElement('p');
    detail.className = 'license-renewal-notice-detail';
    detail.textContent = content.detail;
    const actions = document.createElement('div');
    actions.className = 'license-renewal-notice-actions';
    const primary = button('license-renewal-notice-primary', content.action);
    primary.addEventListener('click', () => { content.onAction(); });
    actions.append(primary);
    if (content.secondary) {
      const secondary = button('license-renewal-notice-secondary', content.secondary.label);
      secondary.addEventListener('click', () => { content.secondary?.onClick(); });
      actions.append(secondary);
    }
    const close = button('license-renewal-notice-close', '닫기');
    close.addEventListener('click', () => {
      dismissed.add(content.id);
      hide();
    });
    actions.append(close);
    root.append(title, detail, actions);
    document.body.append(root);
    card = root;
    shownId = content.id;
  }

  return { show };
}

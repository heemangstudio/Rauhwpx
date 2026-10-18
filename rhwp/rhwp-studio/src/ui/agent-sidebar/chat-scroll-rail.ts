/** 집중 모드 대화의 턴 레일.
 *
 *  대화면 왼쪽 가장자리에 사용자 요청마다 짧은 눈금을 세워 스크롤바를 대신한다.
 *  보이는 턴의 눈금은 밝고 나머지는 옅다. 레일에 올리면 독처럼 가까운 눈금이 커지고,
 *  오른쪽에 요청과 답변 첫머리를 담은 카드가 뜬다. 눈금 사이를 옮기면 카드는 다시 뜨지
 *  않고 위아래로 미끄러진다. 누르면 그 요청으로 스크롤한다 — 스크롤과 따라가기는
 *  사이드바가 넘긴 콜백이 맡는다. */

import './chat-scroll-rail.css';

export interface ChatScrollRail {
  readonly root: HTMLElement;
  /** 집중 모드에서만 켠다. 꺼져 있으면 관찰도 쉰다. */
  setEnabled(on: boolean): void;
  dispose(): void;
}

/** 눈금 간격의 상한(px). 턴이 많으면 대화 높이에 맞춰 좁힌다. */
const MAX_PITCH_PX = 16;
/** 레일 위아래로 남기는 여백(px). */
const RAIL_INSET_PX = 24;
/** 카드가 대화 영역 위아래 끝에서 띄우는 여백(px). */
const PEEK_EDGE_PX = 8;
/** 레일을 떠난 뒤 카드를 거두기까지 — 대각선으로 옮겨도 깜빡이지 않는다. */
const LEAVE_GRACE_MS = 120;
const LABEL_MAX = 60;
const REPLY_MAX = 220;

function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function promptText(user: HTMLElement): string {
  const text = user.querySelector('.ag-msg-user-text');
  return collapse(text ? text.textContent : user.textContent);
}

/** 이 요청 뒤, 다음 요청 전의 첫 답변 글. */
function replyText(user: HTMLElement): string {
  for (let node = user.nextElementSibling; node; node = node.nextElementSibling) {
    if (node.classList.contains('ag-msg-user')) break;
    if (!node.classList.contains('ag-msg-assistant')) continue;
    // innerText 는 문단 사이를 띄워 준다. 올렸을 때 한 번만 읽는다.
    const text = collapse((node as HTMLElement).innerText);
    if (text) return clip(text, REPLY_MAX);
  }
  return '';
}

export function createChatScrollRail(opts: {
  /** 대화 스크롤러. 레일은 그 형제로 같은 부모 안에 선다. */
  messages: HTMLElement;
  /** 눈금을 누르면 그 요청으로 스크롤한다. */
  scrollToTurn: (user: HTMLElement) => void;
}): ChatScrollRail {
  const { messages, scrollToTurn } = opts;
  const root = document.createElement('nav');
  root.className = 'ag-scroll-rail';
  root.setAttribute('aria-label', '대화 탐색');
  root.hidden = true;
  const peek = document.createElement('div');
  peek.className = 'ag-scroll-rail-peek';
  // 눈금의 이름이 요청을 읽어 주므로 카드는 보이는 미리보기일 뿐이다.
  peek.setAttribute('aria-hidden', 'true');
  const card = document.createElement('div');
  card.className = 'ag-scroll-rail-card';
  const cardPrompt = document.createElement('div');
  cardPrompt.className = 'ag-scroll-rail-prompt';
  const cardReply = document.createElement('div');
  cardReply.className = 'ag-scroll-rail-reply';
  card.append(cardPrompt, cardReply);
  peek.appendChild(card);

  let enabled = false;
  let users: HTMLElement[] = [];
  let ticks: HTMLButtonElement[] = [];
  let tabIndex = 0;
  let hovered = -1;
  let frame: number | null = null;
  let leaveTimer: number | null = null;
  let lastBox = '';

  const schedule = (): void => {
    if (!enabled || frame !== null) return;
    frame = requestAnimationFrame(update);
  };
  const mutationObserver = typeof MutationObserver === 'function' ? new MutationObserver(schedule) : null;
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;

  function rebuild(next: HTMLElement[]): void {
    users = next;
    ticks = next.map((user, index) => {
      const tick = document.createElement('button');
      tick.type = 'button';
      tick.className = 'ag-scroll-rail-tick';
      tick.tabIndex = -1;
      tick.setAttribute('aria-label', clip(promptText(user), LABEL_MAX) || `요청 ${index + 1}`);
      tick.appendChild(document.createElement('span')).className = 'ag-scroll-rail-mark';
      return tick;
    });
    root.replaceChildren(...ticks);
    tabIndex = Math.min(tabIndex, Math.max(0, ticks.length - 1));
    if (ticks[tabIndex]) ticks[tabIndex].tabIndex = 0;
    if (hovered >= ticks.length) clearHover();
    else if (hovered >= 0) setHover(hovered);
  }

  function update(): void {
    frame = null;
    if (!enabled) return;
    const next = [...messages.children].filter((node): node is HTMLElement =>
      node instanceof HTMLElement && node.classList.contains('ag-msg-user') && !node.hidden);
    if (next.length !== users.length || next.some((user, index) => user !== users[index])) rebuild(next);
    const { scrollTop, scrollHeight, clientHeight } = messages;
    const show = users.length >= 2 && scrollHeight > clientHeight + 1 && messages.isConnected;
    if (!show) {
      setShown(false);
      return;
    }
    const height = messages.offsetHeight;
    const pitch = Math.max(2, Math.min(MAX_PITCH_PX, (height - 2 * RAIL_INSET_PX) / users.length));
    const box = `${messages.offsetTop}:${height}:${pitch}`;
    if (box !== lastBox) {
      lastBox = box;
      root.style.setProperty('--ag-scroll-rail-center', `${messages.offsetTop + height / 2}px`);
      root.style.setProperty('--ag-scroll-rail-pitch', `${pitch}px`);
    }
    // 턴은 그 요청 위끝부터 다음 요청 위끝(마지막은 내용 끝)까지다. 보이는 창과 겹치면 밝힌다.
    const origin = messages.getBoundingClientRect().top - scrollTop;
    const tops = users.map((user) => user.getBoundingClientRect().top - origin);
    const bottom = scrollTop + clientHeight;
    let firstInView = -1;
    tops.forEach((top, index) => {
      const end = tops[index + 1] ?? scrollHeight;
      const inView = top < bottom && end > scrollTop;
      if (inView && firstInView < 0) firstInView = index;
      ticks[index]!.toggleAttribute('data-current', inView);
    });
    // 키보드로 레일에 들어오면 지금 보이는 첫 턴에서 시작한다.
    if (firstInView >= 0 && !root.contains(document.activeElement)) setTabIndex(firstInView);
    setShown(true);
  }

  function setShown(on: boolean): void {
    if (root.hidden === !on) return;
    root.hidden = !on;
    if (!on) clearHover();
  }

  function setTabIndex(index: number): void {
    if (index === tabIndex && ticks[index]?.tabIndex === 0) return;
    if (ticks[tabIndex]) ticks[tabIndex].tabIndex = -1;
    tabIndex = index;
    if (ticks[index]) ticks[index].tabIndex = 0;
  }

  /** 가리킨 눈금과 이웃 두 칸을 키우고 카드를 그 눈금 옆으로 옮긴다. */
  function setHover(index: number): void {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
    const user = users[index];
    const tick = ticks[index];
    if (!user || !tick) return;
    ticks.forEach((other, at) => {
      const distance = Math.abs(at - index);
      if (distance <= 2) other.dataset.near = String(distance);
      else delete other.dataset.near;
    });
    const wasOpen = hovered >= 0;
    hovered = index;
    cardPrompt.textContent = promptText(user);
    const reply = replyText(user);
    cardReply.textContent = reply;
    cardReply.hidden = !reply;
    const host = peek.offsetParent ?? messages.parentElement!;
    const hostTop = host.getBoundingClientRect().top;
    const tickBox = tick.getBoundingClientRect();
    const center = tickBox.top + tickBox.height / 2 - hostTop;
    const cardHeight = peek.offsetHeight;
    const min = messages.offsetTop + PEEK_EDGE_PX;
    const max = messages.offsetTop + messages.offsetHeight - cardHeight - PEEK_EDGE_PX;
    const y = Math.round(Math.max(min, Math.min(max, center - cardHeight / 2)));
    if (!wasOpen) {
      // 처음 뜰 때는 제자리에서 나타난다. 미끄러짐은 이미 떠 있을 때만이다.
      peek.classList.remove('ag-scroll-rail-glide');
      peek.style.transform = `translateY(${y}px)`;
      void peek.offsetWidth;
      peek.classList.add('ag-scroll-rail-glide', 'ag-scroll-rail-open');
    } else {
      peek.style.transform = `translateY(${y}px)`;
    }
  }

  function clearHover(): void {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = null;
    if (hovered < 0) return;
    hovered = -1;
    for (const tick of ticks) delete tick.dataset.near;
    peek.classList.remove('ag-scroll-rail-open', 'ag-scroll-rail-glide');
  }

  function leaveSoon(): void {
    if (leaveTimer !== null) window.clearTimeout(leaveTimer);
    leaveTimer = window.setTimeout(clearHover, LEAVE_GRACE_MS);
  }

  const indexOf = (target: EventTarget | null): number =>
    ticks.indexOf((target as Element | null)?.closest?.('.ag-scroll-rail-tick') as HTMLButtonElement);

  root.addEventListener('pointerover', (event) => {
    const index = indexOf(event.target);
    if (index >= 0 && (index !== hovered || leaveTimer !== null)) setHover(index);
  });
  root.addEventListener('pointerleave', () => {
    // 키보드로 고른 눈금이 있으면 카드는 그 눈금으로 돌아간다.
    const focused = indexOf(root.querySelector(':focus-visible'));
    if (focused >= 0) setHover(focused);
    else leaveSoon();
  });
  root.addEventListener('focusin', (event) => {
    const index = indexOf(event.target);
    if (index < 0) return;
    setTabIndex(index);
    setHover(index);
  });
  root.addEventListener('focusout', (event) => {
    if (!root.contains(event.relatedTarget as Node | null) && !root.matches(':hover')) leaveSoon();
  });
  root.addEventListener('click', (event) => {
    const index = indexOf(event.target);
    const user = users[index];
    if (user?.isConnected) scrollToTurn(user);
  });
  root.addEventListener('keydown', (event) => {
    const current = indexOf(event.target);
    if (current < 0) return;
    const last = ticks.length - 1;
    const target = event.key === 'ArrowUp' ? Math.max(0, current - 1)
      : event.key === 'ArrowDown' ? Math.min(last, current + 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? last
            : -1;
    if (target < 0) return;
    event.preventDefault();
    ticks[target]!.focus();
  });

  function setEnabled(on: boolean): void {
    if (enabled === on) return;
    enabled = on;
    if (!on) {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      messages.removeEventListener('scroll', schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      setShown(false);
      return;
    }
    // 스트리밍 중 글이 자라 넘치기 시작하는 것도 잡도록 하위 변경까지 본다. 한 프레임에 한 번만 잰다.
    mutationObserver?.observe(messages, { childList: true, subtree: true, characterData: true });
    resizeObserver?.observe(messages);
    messages.addEventListener('scroll', schedule, { passive: true });
    lastBox = '';
    schedule();
  }

  messages.after(root, peek);

  return {
    root,
    setEnabled,
    dispose(): void {
      setEnabled(false);
      clearHover();
      root.remove();
      peek.remove();
    },
  };
}

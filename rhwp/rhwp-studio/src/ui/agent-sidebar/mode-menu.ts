/**
 * 입력기의 에이전트 모드 칩 — 현재 모드 이름을 모드 색으로 보이고, 누르면 네 모드
 * (채팅·플랜·에이전트·전체)를 고르는 작은 메뉴가 위로 열린다.
 *
 * 모드 전환의 실제 절차(확인 시트, 허브 전환, 잠금)는 사이드바가 onSelect 에서
 * 맡는다. 이 모듈은 표시와 메뉴 상호작용만 가진다.
 */
import { AGENT_MODES, AGENT_MODE_LABEL, type AgentMode } from '../../agent/types.ts';
import { createIcon } from './icons.ts';

/** 메뉴 행의 한 줄 설명 — 모드가 문서에 무엇을 하는지만 말한다. */
const MODE_DETAIL: Readonly<Record<AgentMode, string>> = {
  chat: '읽기 전용',
  plan: '계획 작성',
  agent: '검토 후 반영',
  full: '바로 반영',
};

export interface ModeMenuState {
  mode: AgentMode;
  disabled: boolean;
  /** 칩 툴팁. 비어 있으면 모드 이름만 쓴다. */
  hint?: string;
  /** null 이 아니면 채팅만 고를 수 있다. 짧은 이유가 막힌 행의 툴팁이 된다. */
  chatOnlyReason?: string | null;
}

export interface ModeMenu {
  readonly root: HTMLElement;
  readonly trigger: HTMLButtonElement;
  update(state: ModeMenuState): void;
  setOpen(open: boolean): void;
  dispose(): void;
}

export function createModeMenu(onSelect: (mode: AgentMode) => void): ModeMenu {
  const root = document.createElement('div');
  root.className = 'ag-mode';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ag-mode-btn';
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'ag-mode-menu');
  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'ag-mode-btn-label';
  trigger.append(triggerLabel, createIcon('updown', 'ag-mode-btn-caret'));

  const menu = document.createElement('div');
  menu.className = 'ag-model-menu ag-mode-menu';
  menu.id = 'ag-mode-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '에이전트 모드');
  menu.setAttribute('aria-hidden', 'true');

  const items = new Map<AgentMode, HTMLButtonElement>();
  for (const mode of AGENT_MODES) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'ag-model-item ag-mode-item';
    item.dataset.mode = mode;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
    item.tabIndex = -1;
    const text = document.createElement('span');
    text.className = 'ag-mode-text';
    const name = document.createElement('span');
    name.className = 'ag-mode-name';
    name.textContent = AGENT_MODE_LABEL[mode];
    const detail = document.createElement('span');
    detail.className = 'ag-mode-detail';
    detail.textContent = MODE_DETAIL[mode];
    text.append(name, detail);
    item.append(text, createIcon('check', 'ag-mode-check'));
    item.addEventListener('click', () => {
      setOpen(false);
      trigger.focus();
      onSelect(mode);
    });
    items.set(mode, item);
    // 전체는 검토 없이 문서를 바꾸므로 구분선 아래에 따로 둔다.
    if (mode === 'full') {
      const separator = document.createElement('div');
      separator.className = 'ag-mode-separator';
      separator.setAttribute('role', 'separator');
      menu.appendChild(separator);
    }
    menu.appendChild(item);
  }
  root.append(trigger, menu);

  let current: AgentMode = 'agent';
  let open = false;

  /** 키보드로 오가는 행 — 막힌 모드는 건너뛴다. */
  function menuItems(): HTMLButtonElement[] {
    return AGENT_MODES.map((mode) => items.get(mode)!).filter((item) => !item.disabled);
  }

  /** 열 때 초점을 둘 행 — 지금 모드가 막혀 있으면 고를 수 있는 첫 행. */
  function focusTarget(): HTMLButtonElement | undefined {
    const item = items.get(current);
    return item && !item.disabled ? item : menuItems()[0];
  }

  function setOpen(next: boolean): void {
    if (next && trigger.disabled) next = false;
    if (open === next) return;
    open = next;
    root.classList.toggle('ag-model-open', open);
    trigger.setAttribute('aria-expanded', String(open));
    menu.setAttribute('aria-hidden', String(!open));
    if (open) {
      document.addEventListener('pointerdown', onOutsidePointer, true);
    } else {
      document.removeEventListener('pointerdown', onOutsidePointer, true);
    }
  }

  function onOutsidePointer(event: PointerEvent): void {
    if (event.target instanceof Node && root.contains(event.target)) return;
    setOpen(false);
  }

  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(!open);
    if (open) focusTarget()?.focus();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      focusTarget()?.focus();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  });
  menu.addEventListener('keydown', (event) => {
    const list = menuItems();
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      trigger.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list[(Math.max(index, 0) + 1) % list.length]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      list[(Math.max(index, 0) - 1 + list.length) % list.length]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      list[0]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      list[list.length - 1]?.focus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  });

  function update(state: ModeMenuState): void {
    current = state.mode;
    const label = AGENT_MODE_LABEL[state.mode];
    triggerLabel.textContent = label;
    trigger.dataset.mode = state.mode;
    trigger.disabled = state.disabled;
    trigger.setAttribute('aria-label', `에이전트 모드: ${label}`);
    trigger.title = state.hint || label;
    root.dataset.mode = state.mode;
    const lockReason = state.chatOnlyReason ?? null;
    for (const [mode, item] of items) {
      item.setAttribute('aria-checked', String(mode === state.mode));
      item.classList.toggle('ag-active', mode === state.mode);
      const locked = lockReason !== null && mode !== 'chat';
      item.disabled = locked;
      item.title = locked ? lockReason : '';
    }
    if (state.disabled) setOpen(false);
  }

  return {
    root,
    trigger,
    update,
    setOpen,
    dispose: () => setOpen(false),
  };
}

const MODE_COMMANDS: Readonly<Record<string, AgentMode>> = {
  chat: 'chat',
  plan: 'plan',
  agent: 'agent',
  full: 'full',
  // 이전 명령은 메뉴에 보이지 않는 별칭으로만 남긴다.
  question: 'chat',
  build: 'agent',
};

/** `/chat 요약해 줘` 처럼 모드 명령으로 시작하는 입력을 모드와 나머지 본문으로 나눈다. */
export function parseModeCommand(text: string): { mode: AgentMode; rest: string } | null {
  const match = text.match(/^\/(chat|plan|agent|full|question|build)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { mode: MODE_COMMANDS[match[1].toLowerCase()]!, rest: (match[2] ?? '').trim() };
}

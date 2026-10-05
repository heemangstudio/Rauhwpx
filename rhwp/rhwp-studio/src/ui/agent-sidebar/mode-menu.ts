/**
 * 입력기의 에이전트 모드 칩 — 현재 모드 이름을 모드 색으로 보이고, 누르면 네 모드
 * (채팅·플랜·에이전트·전체)를 고르는 작은 메뉴가 위로 열린다.
 *
 * 모드 전환의 실제 절차(확인 시트, 허브 전환, 잠금)는 사이드바가 onSelect 에서
 * 맡는다. 이 모듈은 표시와 메뉴 상호작용만 가진다.
 */
import { AGENT_MODES, AGENT_MODE_LABEL, type AgentMode } from '../../agent/types.ts';

export interface ModeMenuState {
  mode: AgentMode;
  disabled: boolean;
  /** 지금 실행 위치에서 고를 수 없는 모드와 그 이유 (예: Cloud 의 에이전트). */
  unavailable?: ReadonlyMap<AgentMode, string>;
  /** 칩 툴팁. 비어 있으면 모드 이름만 쓴다. */
  hint?: string;
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
    const dot = document.createElement('span');
    dot.className = 'ag-mode-dot';
    dot.setAttribute('aria-hidden', 'true');
    item.append(dot, document.createTextNode(AGENT_MODE_LABEL[mode]));
    item.addEventListener('click', () => {
      if (item.disabled) return;
      setOpen(false);
      trigger.focus();
      onSelect(mode);
    });
    items.set(mode, item);
    menu.appendChild(item);
  }
  root.append(trigger, menu);

  let current: AgentMode = 'agent';
  let open = false;

  function enabledItems(): HTMLButtonElement[] {
    return AGENT_MODES.map((mode) => items.get(mode)!).filter((item) => !item.disabled);
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
    if (open) (items.get(current) && !items.get(current)!.disabled ? items.get(current)! : enabledItems()[0])?.focus();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      (items.get(current) ?? enabledItems()[0])?.focus();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      setOpen(false);
    }
  });
  menu.addEventListener('keydown', (event) => {
    const list = enabledItems();
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
    trigger.textContent = label;
    trigger.dataset.mode = state.mode;
    trigger.disabled = state.disabled;
    trigger.setAttribute('aria-label', `에이전트 모드: ${label}`);
    trigger.title = state.hint || label;
    root.dataset.mode = state.mode;
    for (const [mode, item] of items) {
      const reason = state.unavailable?.get(mode);
      item.disabled = reason !== undefined;
      item.setAttribute('aria-disabled', String(reason !== undefined));
      item.title = reason ?? '';
      item.setAttribute('aria-checked', String(mode === state.mode));
      item.classList.toggle('ag-active', mode === state.mode);
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

import './settings-search.css';
import { createIcon } from './icons.ts';
import { type SettingsNavIconId, createSettingsNavIcon } from './settings-nav-icons.ts';

/** 설정 검색이 찾는 한 항목: 화면의 머리말·라벨과 그것이 있는 곳. */
export interface SettingsSearchTarget {
  label: string;
  /** 'AI › 연결' 처럼 항목이 있는 곳. */
  path: string;
  /** 항목이 속한 탭의 목록 아이콘. AI 항목은 세부 탭(연결·사용량·사용자화)의 아이콘. */
  icon?: SettingsNavIconId;
  element: HTMLElement;
}

export interface SettingsSearch {
  root: HTMLElement;
  input: HTMLInputElement;
  focus(): void;
  clear(): void;
}

const MAX_RESULTS = 12;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '');
}

/**
 * 왼쪽 목록 맨 위의 검색 칸. 입력하는 동안 목록 대신 결과를 보이고, 고르면 그 설정으로 간다.
 * 찾을 항목은 열 때마다 화면에서 다시 모은다(불러온 뒤 생기는 구역도 잡힌다).
 */
export function createSettingsSearch(options: {
  collect(): SettingsSearchTarget[];
  open(target: SettingsSearchTarget): void;
  onActiveChange(active: boolean): void;
}): SettingsSearch {
  const root = document.createElement('div');
  root.className = 'ag-settings-search';
  const field = document.createElement('label');
  field.className = 'ag-settings-search-field';
  const input = document.createElement('input');
  input.className = 'ag-settings-search-input';
  input.type = 'search';
  input.placeholder = '설정 검색';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', '설정 검색');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const key = document.createElement('kbd');
  key.className = 'ag-settings-search-key';
  key.textContent = '/';
  key.setAttribute('aria-hidden', 'true');
  field.append(createIcon('search', 'ag-settings-search-icon'), input, key);

  const list = document.createElement('div');
  list.className = 'ag-settings-search-results';
  list.id = 'ag-settings-search-results';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', '설정 검색 결과');
  list.hidden = true;
  input.setAttribute('aria-controls', list.id);
  root.append(field, list);

  let results: SettingsSearchTarget[] = [];
  let activeIndex = 0;
  let active = false;

  function setActive(next: boolean): void {
    if (next === active) return;
    active = next;
    list.hidden = !next;
    input.setAttribute('aria-expanded', String(next));
    options.onActiveChange(next);
  }

  function search(query: string): SettingsSearchTarget[] {
    const needle = normalize(query);
    if (!needle) return [];
    const seen = new Set<string>();
    const scored: Array<{ target: SettingsSearchTarget; score: number; order: number }> = [];
    options.collect().forEach((target, order) => {
      const label = normalize(target.label);
      const path = normalize(target.path);
      let score: number;
      if (label.startsWith(needle)) score = 0;
      else if (label.includes(needle)) score = 1;
      else if (path.includes(needle)) score = 2;
      else return;
      const id = `${target.path}\u0000${target.label}`;
      if (seen.has(id)) return;
      seen.add(id);
      scored.push({ target, score, order });
    });
    scored.sort((a, b) => a.score - b.score || a.order - b.order);
    return scored.slice(0, MAX_RESULTS).map((entry) => entry.target);
  }

  function renderActive(): void {
    [...list.children].forEach((child, index) => {
      const selected = index === activeIndex;
      child.classList.toggle('ag-active', selected);
      child.setAttribute('aria-selected', String(selected));
      if (selected) {
        input.setAttribute('aria-activedescendant', child.id);
        (child as HTMLElement).scrollIntoView({ block: 'nearest' });
      }
    });
    if (!results.length) input.removeAttribute('aria-activedescendant');
  }

  function render(): void {
    const query = input.value.trim();
    results = search(query);
    activeIndex = 0;
    list.replaceChildren();
    if (!query) {
      setActive(false);
      return;
    }
    setActive(true);
    if (!results.length) {
      const empty = document.createElement('div');
      empty.className = 'ag-settings-search-empty';
      empty.textContent = '결과 없음';
      list.append(empty);
      input.removeAttribute('aria-activedescendant');
      return;
    }
    results.forEach((target, index) => {
      const option = document.createElement('div');
      option.className = 'ag-settings-search-result';
      option.id = `ag-settings-search-result-${index}`;
      option.setAttribute('role', 'option');
      const label = document.createElement('span');
      label.className = 'ag-settings-search-result-label';
      label.textContent = target.label;
      const path = document.createElement('span');
      path.className = 'ag-settings-search-result-path';
      path.textContent = target.path;
      const text = document.createElement('span');
      text.className = 'ag-settings-search-result-text';
      text.append(label, path);
      if (target.icon) option.append(createSettingsNavIcon(target.icon));
      option.append(text);
      // 입력 칸이 초점을 잃기 전에 고른다.
      option.addEventListener('mousedown', (event) => event.preventDefault());
      option.addEventListener('click', () => choose(index));
      option.addEventListener('mousemove', () => {
        if (activeIndex === index) return;
        activeIndex = index;
        renderActive();
      });
      list.append(option);
    });
    renderActive();
  }

  function clear(): void {
    input.value = '';
    render();
  }

  function choose(index: number): void {
    const target = results[index];
    if (!target) return;
    clear();
    input.blur();
    options.open(target);
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!results.length) return;
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + delta + results.length) % results.length;
      renderActive();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape' && input.value) {
      event.preventDefault();
      event.stopPropagation();
      clear();
    }
  });

  return {
    root,
    input,
    focus() {
      input.focus();
      input.select();
    },
    clear,
  };
}

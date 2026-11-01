import type { CommandRegistry } from '../command/registry';
import { shortcutLabelFor } from '../command/effective-shortcuts.ts';
import { formatShortcutLabel } from '../engine/navigation-keymap.ts';

/** 처음 손대기 전의 HTML 단축키 표시. null 이면 span 이 없어 새로 만든 항목이다. */
const originalShortcuts = new WeakMap<Element, string | null>();

/**
 * 메뉴 항목의 단축키 표시(.md-shortcut)를 실제 단축키로 맞춘다.
 * labelFor 가 문자열이면 그 표기로 적고, null 이면 표시를 비우고, undefined 이면 HTML 원래 값으로 둔다.
 */
export function syncMenuShortcutLabels(
  container: HTMLElement,
  registry: Pick<CommandRegistry, 'get'>,
  labelFor: (id: string) => string | null | undefined = (id) => shortcutLabelFor(id, registry.get(id)),
): void {
  const items = container.querySelectorAll('.md-item[data-cmd]');
  for (const item of items) {
    const el = item as HTMLElement;
    const cmdId = el.dataset.cmd;
    if (!cmdId) continue;

    const shortcutLabel = labelFor(cmdId);
    let shortcut = el.querySelector('.md-shortcut') as HTMLElement | null;
    if (shortcutLabel === undefined || shortcutLabel === '') {
      // 사용자 지정을 되돌렸으면 HTML 원래 표시(메뉴 안 한 글자 키 등)로 돌린다.
      if (!originalShortcuts.has(el)) continue;
      const original = originalShortcuts.get(el);
      if (shortcut) shortcut.textContent = original ?? '';
      continue;
    }
    if (!originalShortcuts.has(el)) originalShortcuts.set(el, shortcut ? shortcut.textContent : null);
    if (shortcutLabel === null) {
      if (shortcut) shortcut.textContent = '';
      continue;
    }
    if (!shortcut) {
      shortcut = document.createElement('span');
      shortcut.className = 'md-shortcut';
      el.appendChild(shortcut);
    }
    shortcut.textContent = formatShortcutLabel(shortcutLabel);
  }
}

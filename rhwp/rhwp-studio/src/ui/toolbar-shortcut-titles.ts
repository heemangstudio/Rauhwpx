import type { CommandRegistry } from '../command/registry';
import { shortcutLabelFor, shortcuts } from '../command/effective-shortcuts.ts';
import { formatShortcutLabel } from '../engine/navigation-keymap.ts';

/** data-cmd 가 없는 서식 막대 단추 */
const STYLE_BAR_BUTTONS: ReadonlyArray<readonly [string, string]> = [
  ['#btn-bold', 'format:bold'],
  ['#btn-italic', 'format:italic'],
  ['#btn-underline', 'format:underline'],
];

/** HTML 에 적힌 원래 title. 사용자 지정을 되돌리면 이 값으로 돌아간다. */
const baseTitles = new WeakMap<Element, string>();

const TRAILING_SHORTCUT = /\s*\(((?:Ctrl|Alt|Shift|Cmd|Option|F\d{1,2}|[⌘⌥⇧⌃])[^()]*)\)$/;

function titleWith(base: string, label: string | null): string {
  const stripped = base.replace(TRAILING_SHORTCUT, '');
  return label ? `${stripped} (${formatShortcutLabel(label)})` : stripped;
}

/**
 * 도구 막대 단추 title 의 끝 " (Ctrl+B)" 를 실제 단축키로 맞춘다.
 * labelFor 가 undefined 를 주면 HTML 원래 title 을 그대로 두고(사용자 지정 없음), null 이면 단축키 표기를 뺀다.
 * 기본값은 사용자 지정된 명령만 다시 적는다 — 지정이 없으면 title 은 HTML 그대로다.
 */
export function syncToolbarShortcutTitles(
  root: ParentNode,
  registry: Pick<CommandRegistry, 'get'>,
  labelFor: (id: string) => string | null | undefined = (id) => (
    shortcuts.isCustomized(id) ? shortcutLabelFor(id, registry.get(id)) : undefined
  ),
): void {
  const targets: Array<[Element, string]> = [];
  for (const el of Array.from(root.querySelectorAll('[data-cmd][title]'))) {
    const cmd = (el as HTMLElement).dataset?.cmd ?? el.getAttribute('data-cmd');
    if (cmd) targets.push([el, cmd]);
  }
  for (const [selector, cmd] of STYLE_BAR_BUTTONS) {
    const el = root.querySelector(selector);
    if (el && el.hasAttribute('title')) targets.push([el, cmd]);
  }
  for (const [el, cmd] of targets) {
    let base = baseTitles.get(el);
    if (base === undefined) {
      base = el.getAttribute('title') ?? '';
      baseTitles.set(el, base);
    }
    const label = labelFor(cmd);
    const next = label === undefined ? base : titleWith(base, label);
    if (el.getAttribute('title') !== next) el.setAttribute('title', next);
  }
}

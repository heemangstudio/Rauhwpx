import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../src/command/registry.ts';
import { shortcuts } from '../src/command/effective-shortcuts.ts';
import { syncToolbarShortcutTitles } from '../src/ui/toolbar-shortcut-titles.ts';

class FakeButton {
  private attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  constructor(title: string, cmd?: string) {
    this.attrs.set('title', title);
    if (cmd) {
      this.dataset.cmd = cmd;
      this.attrs.set('data-cmd', cmd);
    }
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  hasAttribute(name: string) { return this.attrs.has(name); }
}

function rootWith(buttons: { cmd: FakeButton[]; bold?: FakeButton }) {
  return {
    querySelectorAll(selector: string) {
      assert.equal(selector, '[data-cmd][title]');
      return buttons.cmd;
    },
    querySelector(selector: string) {
      return selector === '#btn-bold' ? buttons.bold ?? null : null;
    },
  } as unknown as ParentNode;
}

test('도구 막대 title 은 사용자 지정 단축키를 따르고, 되돌리면 HTML 원래 값으로 돌아간다', () => {
  const registry = new CommandRegistry();
  registry.register({ id: 'format:bold', label: '굵게', shortcutLabel: 'Ctrl+B', execute: () => {} });
  registry.register({ id: 'edit:find', label: '찾기', shortcutLabel: 'Ctrl+F', execute: () => {} });
  registry.register({ id: 'insert:image', label: '그림', execute: () => {} });
  const bold = new FakeButton('굵게 (Ctrl+B)');
  const find = new FakeButton('찾기 (Ctrl+F)', 'edit:find');
  const image = new FakeButton('그림', 'insert:image');
  const root = rootWith({ cmd: [find, image], bold });
  try {
    syncToolbarShortcutTitles(root, registry);
    assert.equal(bold.getAttribute('title'), '굵게 (Ctrl+B)');
    assert.equal(find.getAttribute('title'), '찾기 (Ctrl+F)');
    assert.equal(image.getAttribute('title'), '그림');

    shortcuts.assign('format:bold', 'mod+shift+b');
    shortcuts.remove('format:bold', 'mod+b');
    shortcuts.remove('edit:find', 'mod+f');
    shortcuts.assign('insert:image', 'mod+shift+9');
    syncToolbarShortcutTitles(root, registry);
    assert.equal(bold.getAttribute('title'), '굵게 (Ctrl+Shift+B)');
    assert.equal(find.getAttribute('title'), '찾기', '키가 없으면 단축키 표기를 뺀다');
    assert.equal(image.getAttribute('title'), '그림 (Ctrl+Shift+9)');

    shortcuts.resetAll();
    syncToolbarShortcutTitles(root, registry);
    assert.equal(bold.getAttribute('title'), '굵게 (Ctrl+B)');
    assert.equal(find.getAttribute('title'), '찾기 (Ctrl+F)');
    assert.equal(image.getAttribute('title'), '그림');
  } finally {
    shortcuts.resetAll();
  }
});

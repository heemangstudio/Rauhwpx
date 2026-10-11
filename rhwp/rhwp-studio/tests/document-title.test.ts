import test from 'node:test';
import assert from 'node:assert/strict';
import { installDocumentTitle } from '../src/ui/document-title.ts';

test('파일명과 설치형 표시 모드 전환에 맞춰 제목을 갱신한다', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const media = new EventTarget() as EventTarget & { matches: boolean };
  media.matches = false;
  const visibleTitle = { textContent: '', title: '', hidden: true };
  const pageDocument = {
    title: 'HamaEditor',
    getElementById: (id: string) => id === 'editor-document-title' ? visibleTitle : null,
  };
  let loaded = false;
  const bridge = {
    fileName: 'document.hwp',
    hasLoadedDocument: () => loaded,
    onFileNameChanged: undefined as ((fileName: string) => void) | undefined,
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => media } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: pageDocument });
  try {
    installDocumentTitle(bridge);
    assert.equal(pageDocument.title, 'HamaEditor', '문서 없는 상태는 기본 제목');
    assert.equal(visibleTitle.hidden, true);
    loaded = true;
    bridge.fileName = '검토 <원본> & 001.hwp';
    bridge.onFileNameChanged?.(bridge.fileName);
    assert.equal(pageDocument.title, '검토 <원본> & 001.hwp - HamaEditor');
    assert.equal(visibleTitle.textContent, bridge.fileName);
    assert.equal(visibleTitle.title, bridge.fileName);
    assert.equal(visibleTitle.hidden, false);
    media.matches = true;
    media.dispatchEvent(new Event('change'));
    assert.equal(pageDocument.title, '검토 <원본> & 001.hwp', '설치형 창은 앱 이름 중복을 피한다');
    bridge.fileName = '저장.hwpx';
    bridge.onFileNameChanged?.(bridge.fileName);
    assert.equal(pageDocument.title, '저장.hwpx');
    assert.equal(visibleTitle.textContent, '저장.hwpx');
    media.matches = false;
    media.dispatchEvent(new Event('change'));
    assert.equal(pageDocument.title, '저장.hwpx - HamaEditor');
    loaded = false;
    bridge.onFileNameChanged?.(bridge.fileName);
    assert.equal(pageDocument.title, 'HamaEditor', '문서가 없으면 파일명과 무관하게 기본 제목');
    assert.equal(visibleTitle.hidden, true);
    assert.equal(visibleTitle.textContent, '');
  } finally {
    for (const [key, descriptor] of [['window', originalWindow], ['document', originalDocument]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('이름을 바꿀 수 없는 문서는 제목을 두 번 눌러도 이름 칸을 열지 않는다', () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  /** 이 시험에 필요한 만큼만 흉내 낸 요소. */
  const fakeElement = () => {
    const node = new EventTarget() as EventTarget & Record<string, unknown>;
    const classes = new Set<string>();
    Object.assign(node, {
      textContent: '', title: '', hidden: false, className: '', style: { setProperty() {} },
      children: [] as unknown[],
      classList: { add: (name: string) => classes.add(name), toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)), contains: (name: string) => classes.has(name) },
      replaceChildren(...items: unknown[]) { (node.children as unknown[]).splice(0, Infinity, ...items); },
      querySelector: (selector: string) => (selector === '.inline-rename-input'
        ? (node.children as Array<Record<string, unknown>>).find((child) => child.className === 'inline-rename-input') ?? null
        : null),
      setAttribute() {}, removeAttribute() {}, focus() {}, setSelectionRange() {},
    });
    return node;
  };
  const host = fakeElement();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => Object.assign(new EventTarget(), { matches: false }) } });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      title: '',
      getElementById: (id: string) => (id === 'editor-document-title' ? host : null),
      createElement: () => fakeElement(),
      createElementNS: () => fakeElement(),
    },
  });
  try {
    let renamable = false;
    const bridge = { fileName: '보고서.hwp', hasLoadedDocument: () => true };
    installDocumentTitle(bridge, { rename: async (name) => name, canRename: () => renamable });
    const nameText = (host.children as Array<Record<string, unknown> & { children: unknown[] }>)[0]!;
    assert.equal((host.classList as { contains(name: string): boolean }).contains('editor-document-title-renamable'), false);
    host.dispatchEvent(new Event('dblclick', { cancelable: true }));
    assert.equal(nameText.children.length, 0, '브라우저 파일 핸들처럼 바꿀 수 없으면 칸을 열지 않는다');
    renamable = true;
    host.dispatchEvent(new Event('dblclick', { cancelable: true }));
    assert.equal((nameText.children[0] as { className?: string })?.className, 'inline-rename-input');
  } finally {
    for (const [key, descriptor] of [['window', originalWindow], ['document', originalDocument]] as const) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

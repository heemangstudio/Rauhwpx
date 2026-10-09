/**
 * 문서 세션 사이를 옮겨 다니는 페이지 퍼사드 — 화면은 퍼사드 하나를 쥐고 대상만 바꾼다.
 * 메서드가 붙은 문서로 가는지, 콜백 슬롯이 화면에 붙은 문서에서만 불리는지, 페이지 구독이
 * 새 세션 버스로 옮겨 가는지 본다.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttachableFacade } from '../src/core/attachable-facade.ts';
import { AttachableEventBus, EventBus } from '../src/core/event-bus.ts';

class FakeBridge {
  #secret: string;
  private _fileName: string;
  readonly label: string;
  onFileNameChanged?: (name: string) => void;

  constructor(label: string) {
    this.label = label;
    this.#secret = `secret-${label}`;
    this._fileName = `${label}.hwp`;
  }

  get fileName(): string { return this._fileName; }
  set fileName(name: string) {
    this._fileName = name;
    this.onFileNameChanged?.(name);
  }

  secret(): string { return this.#secret; }
  whoAmI(): string { return this.label; }
}

function bridges() {
  const a = new FakeBridge('a');
  const b = new FakeBridge('b');
  const handle = createAttachableFacade<FakeBridge>(a, { stickyKeys: ['onFileNameChanged'] });
  return { a, b, handle, facade: handle.facade };
}

test('메서드는 현재 대상으로 가고, 같은 대상이면 같은 bound 함수를 돌려준다', () => {
  const { a, b, handle, facade } = bridges();
  assert.equal(facade.whoAmI(), 'a');
  assert.equal(facade.secret(), 'secret-a', '#private 필드도 대상 자신으로 호출된다');
  const first = facade.whoAmI;
  assert.equal(facade.whoAmI, first, '호출마다 새 함수를 만들지 않는다');

  handle.retarget(b);
  assert.equal(handle.current(), b);
  assert.equal(facade.whoAmI(), 'b');
  assert.notEqual(facade.whoAmI, first);
  assert.equal(first(), 'a', '꺼내 둔 bound 메서드는 꺼낸 시점의 대상을 부른다');

  handle.retarget(a);
  assert.equal(facade.whoAmI, first, '같은 대상으로 돌아오면 캐시된 함수를 다시 쓴다');
  assert.ok(facade instanceof FakeBridge);
});

test('getter·setter 는 현재 대상의 값을 읽고 쓴다', () => {
  const { a, b, handle, facade } = bridges();
  assert.equal(facade.fileName, 'a.hwp');
  handle.retarget(b);
  facade.fileName = 'renamed.hwp';
  assert.equal(b.fileName, 'renamed.hwp');
  assert.equal(a.fileName, 'a.hwp');
  assert.equal(facade.label, 'b');
});

test('sticky 콜백은 화면에 붙은 대상에서만 불리고, 대상의 원래 콜백도 이어 부른다', () => {
  const { a, b, handle, facade } = bridges();
  const sessionB: string[] = [];
  b.onFileNameChanged = (name) => sessionB.push(name);
  const page: string[] = [];
  const onName = (name: string) => page.push(name);
  facade.onFileNameChanged = onName;
  assert.equal(facade.onFileNameChanged, onName, '퍼사드는 자기가 받은 값을 돌려준다');

  a.fileName = 'a1.hwp';
  handle.retarget(b);
  b.fileName = 'b1.hwp';
  a.fileName = 'a2.hwp';
  assert.deepEqual(page, ['a1.hwp', 'b1.hwp'], '떨어진 대상 a 의 알림은 페이지로 오지 않는다');
  assert.deepEqual(sessionB, ['b1.hwp'], 'b 가 원래 걸어 둔 콜백은 유지된다');

  handle.retarget(a);
  a.fileName = 'a3.hwp';
  b.fileName = 'b2.hwp';
  assert.deepEqual(page, ['a1.hwp', 'b1.hwp', 'a3.hwp']);
  assert.deepEqual(sessionB, ['b1.hwp', 'b2.hwp']);
});

test('페이지 구독은 새 세션 버스로 옮겨 가고, 세션 구독은 자기 버스에 남는다', () => {
  const busA = new EventBus();
  const busB = new EventBus();
  const page = new AttachableEventBus(busA);
  const heard: string[] = [];
  const off = page.on('document-changed', (who) => heard.push(`page:${who}`));
  busA.on('document-changed', (who) => heard.push(`sessionA:${who}`));
  busB.on('document-changed', (who) => heard.push(`sessionB:${who}`));

  busA.emit('document-changed', 'a');
  page.retarget(busB);
  assert.equal(page.current(), busB);
  busA.emit('document-changed', 'a-background');
  busB.emit('document-changed', 'b');
  page.emit('document-changed', 'via-page');
  assert.deepEqual(heard, [
    'page:a', 'sessionA:a',
    'sessionA:a-background',
    'sessionB:b', 'page:b',
    'sessionB:via-page', 'page:via-page',
  ]);

  heard.length = 0;
  page.emitPage('document-changed', 'page-only');
  assert.deepEqual(heard, ['page:page-only'], 'emitPage 는 세션 구독자에게 가지 않는다');

  heard.length = 0;
  off();
  page.retarget(busA);
  busA.emit('document-changed', 'a');
  busB.emit('document-changed', 'b');
  assert.deepEqual(heard, ['sessionA:a', 'sessionB:b'], '끊은 구독은 어느 버스에도 남지 않는다');
});

test('removeAll 은 페이지 구독만 끊는다', () => {
  const session = new EventBus();
  const page = new AttachableEventBus(session);
  const heard: string[] = [];
  page.on('x', () => heard.push('page'));
  session.on('x', () => heard.push('session'));
  page.removeAll();
  session.emit('x');
  assert.deepEqual(heard, ['session']);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_SETUP_STORAGE_KEY } from '../src/ui/initial-setup/state.ts';
import {
  markReleaseNotesSeen,
  pendingReleaseNotes,
  RELEASE_NOTES_STORAGE_KEY,
  releaseNotesSign,
} from '../src/ui/update-hippo/release-notes.ts';

const NOTES = { '3.1.0': ['가', '나', '다', '라', '마', '바'], '3.1.1': [] };

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    map,
  };
}

const existingUser = () => storage({ [INITIAL_SETUP_STORAGE_KEY]: '{"completed":true}' });

test('예전부터 쓰던 사람은 새 버전의 노트를 본 것으로 적을 때까지 매 실행 본다', () => {
  const store = existingUser();
  assert.deepEqual(pendingReleaseNotes('3.1.0', store, NOTES), NOTES['3.1.0']);
  assert.deepEqual(pendingReleaseNotes('3.1.0', store, NOTES), NOTES['3.1.0']);
  markReleaseNotesSeen('3.1.0', store);
  assert.equal(pendingReleaseNotes('3.1.0', store, NOTES), null);
});

test('다음 버전으로 올리면 그 버전의 노트를 다시 본다', () => {
  const store = existingUser();
  markReleaseNotesSeen('3.0.9', store);
  assert.deepEqual(pendingReleaseNotes('3.1.0', store, NOTES), NOTES['3.1.0']);
});

test('새로 설치하면 노트를 보이지 않고, 다음 업데이트부터 본다', () => {
  const store = storage();
  assert.equal(pendingReleaseNotes('3.1.0', store, NOTES), null);
  assert.equal(store.map.get(RELEASE_NOTES_STORAGE_KEY), '3.1.0');
  // 처음 설정을 마친 뒤 같은 버전을 다시 켜도 보이지 않는다.
  store.setItem(INITIAL_SETUP_STORAGE_KEY, '{"completed":true}');
  assert.equal(pendingReleaseNotes('3.1.0', store, NOTES), null);
});

test('노트가 없는 버전은 팻말을 들지 않는다', () => {
  assert.equal(pendingReleaseNotes('3.1.1', existingUser(), NOTES), null);
  assert.equal(pendingReleaseNotes('9.9.9', existingUser(), NOTES), null);
});

test('저장소가 막혀도 노트 확인이 실패하지 않는다', () => {
  const broken = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  assert.equal(pendingReleaseNotes('3.1.0', broken, NOTES), null);
  assert.doesNotThrow(() => markReleaseNotesSeen('3.1.0', broken));
});

test('팻말은 앞의 네 항목과 나머지 개수를 보이고, 잠깐 있다 내려간다', () => {
  const sign = releaseNotesSign('3.1.0', NOTES['3.1.0']);
  assert.equal(sign.heading, 'HamaEditor 3.1.0');
  assert.deepEqual(sign.lines, ['가', '나', '다', '라']);
  assert.equal(sign.footnote, '외 2개 더');
  assert.equal(sign.detail, '마\n바');
  assert.deepEqual(sign.actions, []);
  assert.ok(sign.transientMs && sign.transientMs > 0);
  assert.match(sign.spoken, /바/);
});

test('네 항목 이하면 "외 N개 더" 를 붙이지 않는다', () => {
  const sign = releaseNotesSign('3.1.0', ['가', '나']);
  assert.deepEqual(sign.lines, ['가', '나']);
  assert.equal(sign.footnote, undefined);
  assert.equal(sign.detail, undefined);
});

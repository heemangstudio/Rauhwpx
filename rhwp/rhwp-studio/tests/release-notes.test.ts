import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_SETUP_STORAGE_KEY } from '../src/ui/initial-setup/state.ts';
import {
  markReleaseNotesSeen,
  RELEASE_NOTES_RECALL_MS,
  RELEASE_NOTES_STORAGE_KEY,
  releaseNotesSign,
  releaseNotesView,
} from '../src/ui/update-hippo/release-notes.ts';

const NOTES = { '3.1.0': { added: ['가', '나'], fixed: ['다'] }, '3.1.1': { added: [], fixed: [] } };

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    map,
  };
}

const existingUser = () => storage({ [INITIAL_SETUP_STORAGE_KEY]: '{"completed":true}' });

const T0 = 1_000_000;
const view = (version: string, store: ReturnType<typeof storage>, now = T0) => releaseNotesView(version, store, now, NOTES);

test('예전부터 쓰던 사람은 누를 때까지 실행을 넘어, 하루가 지나도 클립보드를 든다', () => {
  const store = existingUser();
  assert.deepEqual(view('3.1.0', store), { note: NOTES['3.1.0'], seen: false, recallUntil: T0 + RELEASE_NOTES_RECALL_MS });
  const later = view('3.1.0', store, T0 + RELEASE_NOTES_RECALL_MS * 3);
  assert.equal(later?.seen, false);
  assert.equal(later?.recallUntil, T0 + RELEASE_NOTES_RECALL_MS);
});

test('본 노트는 업데이트하고 하루 동안 남고, 그 뒤에는 사라진다', () => {
  const store = existingUser();
  view('3.1.0', store);
  markReleaseNotesSeen('3.1.0', store);
  assert.equal(view('3.1.0', store, T0 + RELEASE_NOTES_RECALL_MS - 1)?.seen, true);
  assert.equal(view('3.1.0', store, T0 + RELEASE_NOTES_RECALL_MS), null);
});

test('다음 버전으로 올리면 그 버전의 노트와 하루를 새로 시작한다', () => {
  const store = existingUser();
  view('3.0.9', store);
  markReleaseNotesSeen('3.0.9', store);
  const next = T0 + RELEASE_NOTES_RECALL_MS * 10;
  assert.deepEqual(view('3.1.0', store, next), { note: NOTES['3.1.0'], seen: false, recallUntil: next + RELEASE_NOTES_RECALL_MS });
});

test('새로 설치하면 노트를 보이지 않고, 다음 업데이트부터 본다', () => {
  const store = storage();
  assert.equal(view('3.1.0', store), null);
  assert.equal(store.map.get(RELEASE_NOTES_STORAGE_KEY), '3.1.0');
  // 처음 설정을 마친 뒤 같은 버전을 다시 켜도 보이지 않는다.
  store.setItem(INITIAL_SETUP_STORAGE_KEY, '{"completed":true}');
  assert.equal(view('3.1.0', store), null);
});

test('노트가 없는 버전은 클립보드를 들지 않는다', () => {
  assert.equal(view('3.1.1', existingUser()), null);
  assert.equal(view('9.9.9', existingUser()), null);
});

test('저장소가 막혀도 노트 확인이 실패하지 않는다', () => {
  const broken = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('denied'); },
  };
  assert.equal(releaseNotesView('3.1.0', broken, T0, NOTES), null);
  assert.doesNotThrow(() => markReleaseNotesSeen('3.1.0', broken));
});

test('클립보드의 유일한 동작은 릴리스 노트 창 열기다', () => {
  const sign = releaseNotesSign('3.1.0');
  assert.deepEqual(sign.actions.map((action) => action.id), ['release-notes']);
  assert.equal(sign.transientMs, undefined);
});

test('이미 본 노트의 클립보드만 귀 뒤에서 기다린다', () => {
  assert.equal(releaseNotesSign('3.1.0').tucked, false);
  assert.equal(releaseNotesSign('3.1.0', true).tucked, true);
});

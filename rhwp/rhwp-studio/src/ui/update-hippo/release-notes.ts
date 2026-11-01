/**
 * 업데이트 뒤 문서 홈의 하마가 드는 클립보드와 그것을 누르면 뜨는 릴리스 노트 창
 * (release-card.ts)의 내용과 본 기록. DOM 이 없는 순수 함수라 하마·창·테스트가 같이 쓴다.
 *
 * 노트는 버전마다 여기에 적는다(package.json 버전을 올리는 PR 에서 같이). 새로 생긴 것은
 * added, 고친 문제는 fixed 에 적고, 창은 둘을 나눠 전부 보인다. 노트가 없는 버전은 클립보드를
 * 들지 않는다. 창은 클립보드를 눌러야만 뜨고, 그때 본 것으로 적는다. 누르기 전까지는 실행을
 * 넘어 클립보드가 남는다. 본 뒤에는 업데이트하고 하루가 지날 때까지 하마가 귀만 내놓고 남아,
 * 귀를 누르면 클립보드를 다시 든다. 업데이트 팻말이 있으면 그쪽이 먼저다.
 */
import { INITIAL_SETUP_STORAGE_KEY } from '../initial-setup/state.ts';
import type { UpdateSign } from './update-sign.ts';

export interface ReleaseNote {
  /** 새로 생긴 것. */
  added?: readonly string[];
  /** 고친 문제. "…던 문제" 까지만 적는다(카드가 "고친 문제" 로 묶는다). */
  fixed?: readonly string[];
}

export const RELEASE_NOTES: Readonly<Record<string, ReleaseNote>> = {
  '3.0.10': {
    added: [
      '문서 탭, Ctrl+Tab으로 전환',
      '내 수정에서 문체를 배우는 Rau-0.1',
      '홈 문서를 다른 앱으로 끌어 놓기',
      '에이전트가 내 ChatGPT·Claude에 질문',
      'ZIP, PowerPoint, Excel 첨부',
      '문서마다 쌓이는 문서 기억',
      '채팅에서 AGENTS.md 제안 승인',
      '채팅 입력창 위의 픽셀 하마',
      'Windows Claude·Codex 설치와 로그인 안정화',
      '이름을 바꾼 문서도 리서치 프로젝트 유지',
    ],
    fixed: [
      'Windows에서 Codex 채팅이 시작되지 않던 문제',
      'Claude 답변이 되풀이되던 문제',
    ],
  },
  '3.0.11': {
    added: [
      '제목 표시줄에서 바로 쓰는 자동 수정',
      '고친 결과까지 확인하는 자동 수정',
      '채팅 입력창 하마는 설정에서 켜기',
      'ChatGPT·Claude 로그인 창에서 브라우저 도구 막대 숨김',
    ],
    fixed: [
      '문서를 여는 중 입력이 사라지던 문제',
      '셀 블록에서 Ctrl+S가 셀 나누기를 열던 문제',
      '문단·글자 모양 창에서 입력이 문서로 가던 문제',
      '앱 브라우저에서 Ctrl+Z·Ctrl+W가 문서에 적용되던 문제',
      'Windows에서 마지막 창을 닫아도 앱이 남던 문제',
      '저장 안 함으로 버린 변경이 복구로 돌아오던 문제',
    ],
  },
  '3.1.0': {
    added: ['새 엔진 HeemangEngine'],
  },
};

/** 버전 노트의 모든 항목(새로 생긴 것 먼저). */
export function releaseNoteItems(note: ReleaseNote | undefined): readonly string[] {
  return [...(note?.added ?? []), ...(note?.fixed ?? [])];
}

/** 마지막으로 노트를 보인(또는 새로 설치해 건너뛴) 버전. */
export const RELEASE_NOTES_STORAGE_KEY = 'rhwp-release-notes-seen';
/** 이 버전으로 업데이트한 때. */
export const RELEASE_NOTES_UPDATED_KEY = 'rhwp-release-notes-updated';
/** 업데이트한 뒤 노트를 다시 부를 수 있는 시간. */
export const RELEASE_NOTES_RECALL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseNotesView {
  note: ReleaseNote;
  /** 이 버전의 창을 이미 열었다. */
  seen: boolean;
  /** 본 뒤에도 이때까지 귀로 남아 있다. */
  recallUntil: number;
}

export interface ReleaseNotesStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function read(storage: ReleaseNotesStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

export function markReleaseNotesSeen(version: string, storage: ReleaseNotesStorage): void {
  try {
    storage.setItem(RELEASE_NOTES_STORAGE_KEY, version);
  } catch {
    // 저장하지 못하면 다음 실행에 한 번 더 보인다.
  }
}

function updatedAt(version: string, storage: ReleaseNotesStorage, now: number): number | null {
  try {
    const record = JSON.parse(read(storage, RELEASE_NOTES_UPDATED_KEY) ?? 'null');
    if (record?.version === version && typeof record.at === 'number') return Math.min(record.at, now);
  } catch {
    // 망가진 기록은 없는 것으로 친다.
  }
  return null;
}

/**
 * 이번 실행의 릴리스 노트 상태. 보일 것이 없으면 null 이다. 이 버전을 처음 만난 때를 업데이트한
 * 때로 적는다. 처음 설정 기록이 없는 새 설치는 보이지 않고 이 버전을 본 것으로 적는다. 이 기능
 * 전부터 쓰던 사람은 기록이 없어도 처음 설정 기록이 있어 노트를 본다.
 */
export function releaseNotesView(
  version: string,
  storage: ReleaseNotesStorage,
  now = Date.now(),
  notes: Readonly<Record<string, ReleaseNote>> = RELEASE_NOTES,
): ReleaseNotesView | null {
  const lastSeen = read(storage, RELEASE_NOTES_STORAGE_KEY);
  if (lastSeen === null && read(storage, INITIAL_SETUP_STORAGE_KEY) === null) {
    markReleaseNotesSeen(version, storage);
    return null;
  }
  const note = notes[version];
  if (!releaseNoteItems(note).length) return null;
  const seen = lastSeen === version;
  let at = updatedAt(version, storage, now);
  if (at === null) {
    if (seen) return null;
    at = now;
    try {
      storage.setItem(RELEASE_NOTES_UPDATED_KEY, JSON.stringify({ version, at }));
    } catch {
      // 저장하지 못하면 다음 실행을 업데이트한 때로 친다.
    }
  }
  const recallUntil = at + RELEASE_NOTES_RECALL_MS;
  return seen && now >= recallUntil ? null : { note: note!, seen, recallUntil };
}

/** 하마가 드는 클립보드. 누르면 릴리스 노트 창이 뜬다. 이미 봤으면 귀만 내놓고 기다린다. */
export function releaseNotesSign(version: string, seen = false): UpdateSign {
  return {
    key: `notes:${version}`,
    tucked: seen,
    tone: 'plain',
    lines: [],
    progress: null,
    actions: [{ id: 'release-notes', label: 'Release Notes', icon: 'clipboard' }],
    spoken: `HamaEditor ${version} 릴리스 노트가 있어요.`,
  };
}

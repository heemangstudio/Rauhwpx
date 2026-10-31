/**
 * 새 버전의 첫 실행에 문서 홈 맨 위에 뜨는 릴리스 노트 카드(release-card.ts)의 내용과 본 기록.
 * DOM 이 없는 순수 함수라 카드와 테스트가 같이 쓴다.
 *
 * 노트는 버전마다 여기에 적는다(package.json 버전을 올리는 PR 에서 같이). 새로 생긴 것은
 * added, 고친 문제는 fixed 에 적고, 카드는 둘을 나눠 전부 보인다. 노트가 없는 버전은 카드를
 * 띄우지 않는다. 카드가 홈에 보이면 본 것으로 적고, 닫을 때까지 그 실행 동안 남는다.
 */
import { INITIAL_SETUP_STORAGE_KEY } from '../initial-setup/state.ts';

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

/**
 * 이번 실행에 보일 노트. 이미 본 버전이거나 노트가 없으면 null 이다. 처음 설정 기록이 없는 새
 * 설치는 보이지 않고 이 버전을 본 것으로 적는다. 이 기능 전부터 쓰던 사람은 기록이 없어도
 * 처음 설정 기록이 있어 노트를 본다.
 */
export function pendingReleaseNotes(
  version: string,
  storage: ReleaseNotesStorage,
  notes: Readonly<Record<string, ReleaseNote>> = RELEASE_NOTES,
): ReleaseNote | null {
  const seen = read(storage, RELEASE_NOTES_STORAGE_KEY);
  if (seen === version) return null;
  if (seen === null && read(storage, INITIAL_SETUP_STORAGE_KEY) === null) {
    markReleaseNotesSeen(version, storage);
    return null;
  }
  const note = notes[version];
  return releaseNoteItems(note).length ? note! : null;
}

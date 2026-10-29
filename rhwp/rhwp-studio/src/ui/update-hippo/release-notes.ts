/**
 * 새 버전의 첫 실행에 업데이트 하마가 드는 릴리스 노트 팻말. DOM 이 없는 순수 함수라
 * update-hippo.ts 와 테스트가 같이 쓴다.
 *
 * 노트는 버전마다 여기에 적는다(package.json 버전을 올리는 PR 에서 같이). 앞의 네 줄이 팻말에
 * 오르고, 나머지는 "외 N개 더" 로 접혀 팻말에 마우스를 올리면 읽힌다. 노트가 없는 버전은 팻말을
 * 들지 않는다. 팻말은 홈에 보인 뒤 잠깐 있다 내려가고, 그때 본 것으로 적는다. 업데이트 팻말이
 * 있으면 그쪽이 먼저다.
 */
import { INITIAL_SETUP_STORAGE_KEY } from '../initial-setup/state.ts';
import type { UpdateSign } from './update-sign.ts';

export const RELEASE_NOTES: Readonly<Record<string, readonly string[]>> = {
  '3.0.10': [
    '문서 탭, Ctrl+Tab으로 전환',
    '내 수정에서 문체를 배우는 Rau-0.1',
    '홈 문서를 다른 앱으로 끌어 놓기',
    '에이전트가 내 ChatGPT·Claude에 질문',
    'ZIP, PowerPoint, Excel 첨부',
    '문서마다 쌓이는 문서 기억',
    '채팅에서 AGENTS.md 제안 승인',
    '채팅 입력창 위의 픽셀 하마',
    'Windows Claude·Codex 설치와 로그인 안정화',
    'Windows에서 Codex 채팅이 시작되지 않던 문제 수정',
    '이름을 바꾼 문서도 리서치 프로젝트 유지',
    'Claude 답변이 되풀이되던 문제 수정',
  ],
  '3.0.11': [
    '제목 표시줄에서 바로 쓰는 자동 수정',
    '문서를 여는 중 입력이 사라지던 문제 수정',
    '고친 결과까지 확인하는 자동 수정',
    '채팅 입력창 하마는 설정에서 켜기',
    '셀 블록에서 Ctrl+S가 셀 나누기를 열던 문제 수정',
    '문단·글자 모양 창에서 입력이 문서로 가던 문제 수정',
    '앱 브라우저에서 Ctrl+Z·Ctrl+W가 문서에 적용되던 문제 수정',
    'Windows에서 마지막 창을 닫아도 앱이 남던 문제 수정',
    '저장 안 함으로 버린 변경이 복구로 돌아오던 문제 수정',
    'ChatGPT·Claude 로그인 창에서 브라우저 도구 막대 숨김',
  ],
  '3.1.0': [
    '새 엔진 : HeemangEngine',
  ],
};

/** 마지막으로 노트를 보인(또는 새로 설치해 건너뛴) 버전. */
export const RELEASE_NOTES_STORAGE_KEY = 'rhwp-release-notes-seen';
/** 팻말에 오르는 항목 수. */
const SHOWN_ITEMS = 4;
/** 홈에 보인 뒤 내려가기까지. 팻말에 마우스를 올려 두면 기다린다. */
export const RELEASE_NOTES_MS = 15_000;

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
  notes: Readonly<Record<string, readonly string[]>> = RELEASE_NOTES,
): readonly string[] | null {
  const seen = read(storage, RELEASE_NOTES_STORAGE_KEY);
  if (seen === version) return null;
  if (seen === null && read(storage, INITIAL_SETUP_STORAGE_KEY) === null) {
    markReleaseNotesSeen(version, storage);
    return null;
  }
  const items = notes[version];
  return items?.length ? items : null;
}

export function releaseNotesSign(version: string, items: readonly string[]): UpdateSign {
  const lines = items.slice(0, SHOWN_ITEMS);
  const rest = items.slice(SHOWN_ITEMS);
  const heading = `HamaEditor ${version}`;
  return {
    key: `notes:${version}`,
    tone: 'plain',
    heading,
    lines: [...lines],
    ...(rest.length ? { footnote: `외 ${rest.length}개 더`, detail: rest.join('\n') } : {}),
    progress: null,
    actions: [],
    spoken: `${heading}로 업데이트했어요. ${items.join('. ')}`,
    transientMs: RELEASE_NOTES_MS,
  };
}

/**
 * 데스크톱 저장 오류를 사용자에게 보일 문장으로 바꾼다.
 *
 * 메인 프로세스 오류는 IPC 를 건너며 code 를 잃고 메시지만 남는다
 * ("Error invoking remote method ...: Error: <message>"). 알려진 메시지는 이유와 할 일을
 * 알리고, 모르는 오류는 원문을 그대로 보인다.
 */
const MISSING_FILE_MATCH = 'This document was moved or deleted after it was opened';
const UNAVAILABLE_FILE_MATCH = 'The drive or network folder that holds this document is not available';

const KNOWN_SAVE_ERRORS: ReadonlyArray<{ match: string; message: string }> = [
  {
    // desktop/native-file-handles.mjs NATIVE_FILE_CONFLICT_MESSAGE
    match: 'This document changed on disk after it was opened',
    message: '문서를 연 뒤 다른 프로그램이 파일을 바꿨습니다. 덮어쓰지 않았습니다. 다른 이름으로 저장하거나 문서를 다시 여세요.',
  },
  {
    match: 'This document is marked read-only',
    message: '읽기 전용 파일이라 저장하지 못했습니다. 다른 이름으로 저장하세요.',
  },
  {
    match: 'Another program is using this document',
    message: '다른 프로그램(한글 등)이 이 문서를 열고 있어 저장하지 못했습니다. 그 프로그램에서 문서를 닫거나 잠시 뒤 다시 저장하세요.',
  },
  {
    match: 'Windows denied access to this document or its folder',
    message: '이 문서나 폴더에 쓸 권한이 없어 저장하지 못했습니다. 다른 이름이나 다른 폴더에 저장하세요.',
  },
  {
    // desktop/native-file-handles.mjs NATIVE_FILE_MISSING_MESSAGE
    match: MISSING_FILE_MATCH,
    message: '문서를 연 뒤 원래 파일이 지워졌거나 찾을 수 없는 곳으로 옮겨졌습니다. 새 파일을 만들지 않았습니다. 다른 이름으로 저장하세요.',
  },
  {
    // desktop/native-file-handles.mjs NATIVE_FILE_UNAVAILABLE_MESSAGE
    match: UNAVAILABLE_FILE_MATCH,
    message: '문서가 있는 드라이브나 네트워크 폴더에 연결할 수 없어 저장하지 못했습니다. 다시 연결한 뒤 저장하거나 다른 이름으로 저장하세요.',
  },
  {
    // desktop/native-file-handles.mjs NATIVE_FILE_MOVED_INTO_OPEN_MESSAGE
    match: 'This document was renamed to the name of another open document',
    message: '문서 파일의 이름이 지금 열려 있는 다른 문서의 이름으로 바뀌어 저장하지 않았습니다. 그 문서를 닫거나 다른 이름으로 저장하세요.',
  },
  {
    match: 'A native save is already in progress for this document',
    message: '이 문서를 저장하거나 파일 이름을 바꾸는 중입니다. 잠시 뒤 다시 저장하세요.',
  },
];

export function describeSaveError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return KNOWN_SAVE_ERRORS.find((known) => message.includes(known.match))?.message ?? message;
}

/**
 * 원래 파일에 닿지 못해 저장하지 않았다. missing: 지워졌거나 찾을 수 없는 곳으로 옮겨졌다.
 * unavailable: 드라이브나 네트워크 폴더에 연결할 수 없다. 둘 다 다른 이름으로 저장할 수 있다.
 */
export function unreachableFileSaveError(error: unknown): 'missing' | 'unavailable' | null {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes(MISSING_FILE_MATCH)) return 'missing';
  if (message.includes(UNAVAILABLE_FILE_MATCH)) return 'unavailable';
  return null;
}

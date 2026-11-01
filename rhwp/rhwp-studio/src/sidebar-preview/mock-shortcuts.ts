/**
 * 설정 → 단축키의 표본 명령 목록. 앱은 명령 레지스트리(main.ts)에서 같은 모양을 만든다.
 * 미리보기는 레지스트리를 싣지 않으므로 이름만 여기 적고, 어느 명령을 보일지·분류·고정 여부·연속 키는
 * 앱과 같은 함수(configurableCommandIds, shortcutCategoryOf, LOCKED_SHORTCUT_COMMANDS, chordLabelsFor)로 정한다.
 */
import {
  configurableCommandIds,
  LOCKED_SHORTCUT_COMMANDS,
  shortcutCategoryOf,
  type ShortcutCommandInfo,
} from '../command/shortcut-bindings.ts';
import { chordLabelsFor } from '../command/chord-map.ts';

/** 레지스트리의 명령 이름 (commands/*.ts 와 main.ts 의 label 그대로) */
const LABELS: Readonly<Record<string, string>> = {
  'file:new-doc': '새로 만들기',
  'file:open': '열기',
  'file:save': '저장',
  'file:save-as': '다른 이름으로 저장',
  'file:save-as-hwpx': 'HWPX로 저장',
  'file:print': '인쇄',
  'file:print-to-pdf': 'PDF로 내보내기…',
  'file:page-setup': '편집 용지',
  'edit:undo': '되돌리기',
  'edit:redo': '다시 실행',
  'edit:cut': '오려 두기',
  'edit:copy': '복사하기',
  'edit:paste': '붙이기',
  'edit:select-all': '모두 선택',
  'edit:delete': '지우기',
  'edit:format-copy': '모양 복사',
  'edit:format-paste': '모양 붙여넣기',
  'edit:find': '찾기(F)',
  'edit:find-replace': '찾아 바꾸기(E)',
  'edit:find-again': '다시 찾기(X)',
  'edit:goto': '찾아가기(G)',
  'edit:compare-documents': '문서 비교',
  'edit:document-history': '버전',
  'view:zoom-in': '확대',
  'view:zoom-out': '축소',
  'view:zoom-100': '100%',
  'view:zoom-fit-page': '쪽 맞춤',
  'view:zoom-fit-width': '폭 맞춤',
  'view:ctrl-mark': '조판 부호',
  'view:para-mark': '문단 부호',
  'view:border-transparent': '투명 선',
  'view:form-mode': '양식 모드',
  'view:toggle-grid': '격자 보기',
  'insert:symbols': '문자표',
  'insert:hyperlink': '하이퍼링크',
  'insert:bookmark': '책갈피',
  'insert:footnote': '각주',
  'insert:endnote': '미주',
  'insert:equation': '수식',
  'insert:image': '그림',
  'insert:textbox': '글상자',
  'insert:shape': '도형',
  'format:bold': '굵게',
  'format:italic': '기울임',
  'format:underline': '밑줄',
  'format:strikethrough': '취소선',
  'format:superscript': '위 첨자',
  'format:subscript': '아래 첨자',
  'format:script-cycle': '위 첨자/아래 첨자/보통',
  'format:normal-shape': '보통 모양',
  'format:char-shape': '글자 모양',
  'format:para-shape': '문단 모양',
  'format:para-num-shape': '문단 번호 모양',
  'format:style-dialog': '스타일',
  'format:line-spacing-decrease': '줄 간격 줄이기',
  'format:line-spacing-increase': '줄 간격 늘리기',
  'format:font-size-increase': '글꼴 크기 크게',
  'format:font-size-decrease': '글꼴 크기 작게',
  'format:char-ratio-decrease': '장평 줄이기',
  'format:char-ratio-increase': '장평 늘리기',
  'format:char-spacing-decrease': '자간 줄이기',
  'format:char-spacing-increase': '자간 늘리기',
  'format:align-left': '왼쪽 정렬',
  'format:align-justify': '양쪽 정렬',
  'format:align-right': '오른쪽 정렬',
  'format:align-center': '가운데 정렬',
  'format:align-distribute': '배분 정렬',
  'format:align-split': '나눔 정렬',
  'page:break': '쪽 나누기',
  'page:column-break': '단 나누기',
  'page:col-settings': '다단 설정',
  'page:hide': '감추기',
  'table:create': '표 만들기',
  'table:insert-row-col': '줄/칸 추가하기(I)...',
  'table:delete-row-col': '줄/칸 지우기(E)...',
  'table:block-avg': '블록 평균',
  'table:block-product': '블록 곱',
  'help:report-issue': '버그 제보',
};

/** 표에 키가 없는 고정 명령의 자기 처리기 키 (레지스트리의 shortcutLabel) */
const LOCKED_OWN_KEYS: Readonly<Record<string, string>> = {
  'edit:cut': 'Ctrl+X',
  'edit:copy': 'Ctrl+C',
  'edit:paste': 'Ctrl+V',
  'help:report-issue': 'Ctrl+Shift+/',
};

export const previewShortcutCatalog: ShortcutCommandInfo[] = configurableCommandIds().flatMap((id) => {
  const label = LABELS[id];
  if (!label) return [];
  const locked = LOCKED_SHORTCUT_COMMANDS.get(id);
  const own = LOCKED_OWN_KEYS[id];
  return [{
    id,
    label,
    category: shortcutCategoryOf(id),
    locked,
    fixed: [...chordLabelsFor(id), ...(own ? [own] : [])],
  }];
});

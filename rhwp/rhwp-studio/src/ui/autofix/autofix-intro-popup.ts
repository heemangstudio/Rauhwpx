/**
 * 자동 버그 수정 소개 창. 사이드바·설정의 확인 시트를 창 가운데 카드로 띄운다(문서 홈이 사이드바를
 * 가려도 보인다). 켜기면 true, 나중에·Esc·배경 클릭이면 false.
 * 언제 띄울지는 autofix-intro.ts 가 정한다.
 */
import '../agent-sidebar/sheet.css';
import { openSheet } from '../agent-sidebar/sheet.ts';

export const AUTOFIX_INTRO_MESSAGE = '다시 시도해도 풀리지 않는 오류가 나면, 연결된 AI가 이 컴퓨터의 앱 설정을 고치고 개발자에게 보고를 보냅니다.';

export async function openAutofixIntro(signal?: AbortSignal): Promise<boolean> {
  const result = await openSheet({
    title: '자동 버그 수정',
    message: AUTOFIX_INTRO_MESSAGE,
    confirmLabel: '켜기',
    cancelLabel: '나중에',
    // 기본은 꺼짐이다. Enter 한 번으로 켜지지 않게 초점은 나중에에 둔다.
    focusCancel: true,
    center: true,
    ...(signal ? { signal } : {}),
  });
  return result.confirmed;
}

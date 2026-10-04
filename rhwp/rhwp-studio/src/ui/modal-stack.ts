/**
 * 열린 모달 대화상자의 쌓임 순서.
 *
 * 모든 ModalDialog 는 document capture 단계에서 키를 가로챈다. 같은 노드의
 * 다른 리스너는 stopPropagation 으로 막히지 않으므로, 대화상자 위에 대화상자가
 * 열리면 아래 대화상자도 Enter/Escape 를 처리해 버린다(스타일 → 편집에서 Enter 가
 * 스타일 관리자의 설정까지 눌러 문서에 스타일을 적용). 가장 위의 대화상자만 키를
 * 처리하도록 이 스택으로 판정한다.
 */

const stack: object[] = [];

/** 대화상자를 맨 위로 올린다. 이미 열려 있으면 위치만 맨 위로 옮긴다. */
export function pushModal(token: object): void {
  const index = stack.indexOf(token);
  if (index >= 0) stack.splice(index, 1);
  stack.push(token);
}

/** 대화상자를 스택에서 뺀다. 이미 빠졌으면 아무것도 하지 않는다. */
export function popModal(token: object): void {
  const index = stack.indexOf(token);
  if (index >= 0) stack.splice(index, 1);
}

/** 이 대화상자가 가장 위에 열려 있는가 */
export function isTopModal(token: object): boolean {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

/** 열린 대화상자 수 (테스트·진단용) */
export function openModalCount(): number {
  return stack.length;
}

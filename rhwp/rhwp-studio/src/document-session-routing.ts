/**
 * 문서 세션 사이의 길 고르기 — 문서 없는 채팅을 지키는 규칙만 따로 둔다 (main.ts 가 쓴다).
 *
 * 문서 없이 시작한 채팅은 문서 세션 하나를 문서 없이 차지한다. 홈·파일 메뉴의 열기는 그 채팅에 문서를
 * 잇지 않으므로, 그 채팅이 쓰이는 동안에는 문서를 새 세션에 연다. 그 채팅에 문서를 잇는 열기만 그
 * 세션에 연다. 지난 문서 없는 채팅을 다시 열 때는 옮겨 갈 문서가 없으니 문서 없는 세션에서 잇는다.
 */

/** 길 고르기가 보는 채팅 하나. */
export interface RoutingChat {
  readonly sidebar: {
    /** 보이는 채팅에 문서가 없다. */
    isUnlinkedChat(): boolean;
    /** 문서 없는 채팅을 지금 쓰고 있다 (이 페이지에서 대화했거나 턴이 돈다). */
    hasActiveUnlinkedChat(): boolean;
    /** 보이는 채팅 id. 초안이거나 비어 있으면 null. */
    currentThreadId(): string | null;
  };
  readonly bridge: { isBusy(): boolean };
}

/** 길 고르기가 보는 문서 세션 하나. */
export interface RoutingSession<Chat extends RoutingChat = RoutingChat> {
  readonly wasm: { hasLoadedDocument(): boolean };
  readonly chats: readonly Chat[];
}

/**
 * 세션이 쓰이는 문서 없는 채팅을 들고 있다 — 일하는 중이거나 이 페이지에서 대화했다. 빈 초안이나 시작할 때
 * 복원만 한 지난 채팅은 아니다(그 자리에 문서를 열어도 잃을 것이 없고 레일에서 다시 잇는다).
 */
export function sessionHoldsActiveUnlinkedChat(session: RoutingSession): boolean {
  return !session.wasm.hasLoadedDocument() && session.chats.some((chat) => (
    chat.sidebar.isUnlinkedChat() && (chat.bridge.isBusy() || chat.sidebar.hasActiveUnlinkedChat())
  ));
}

/**
 * 홈·파일 메뉴의 열기를 지금 세션 대신 새 세션에 할지. 에이전트가 일하는 문서, 관리되는 작업 트리, 저장할 수
 * 없는 바뀐 문서는 뒤에 둔다. 문서가 없는 세션은 쓰이는 문서 없는 채팅이 있을 때만 뒤에 둔다. 그 채팅에
 * 이을 문서를 여는 중(linking)이면 이 세션에 연다.
 */
export function opensInNewSession(
  session: RoutingSession,
  state: { linking: boolean; busy: boolean; managedWorktree: boolean; readOnlyDirty: boolean },
): boolean {
  if (state.linking) return false;
  if (!session.wasm.hasLoadedDocument()) return sessionHoldsActiveUnlinkedChat(session);
  return state.busy || state.managedWorktree || state.readOnlyDirty;
}

/**
 * 이동이 진행 중일 때 들어온 열기를 그 이동 안에서 바로 할지(줄을 서지 않을지). 라이브러리 이동이 스스로
 * 내보내는 열기는 그 이동의 일부다. 문서 연결 중에는 연결이 직접 문서를 열므로, 그때 들어온 열기(밖에서 연
 * 파일·끌어 놓기)는 연결이 끝난 뒤로 줄을 선다 — 끼어들면 연결하는 세션에 열린다.
 */
export function opensNestedInNavigation(state: { navigationRunning: number; linking: boolean }): boolean {
  return state.navigationRunning > 0 && !state.linking;
}

/** 문서 연결의 열기 결과 — 그 열기가 세션에 올린 문서와, 에이전트가 만든 문서인지. */
export interface LinkLoad {
  created: boolean;
  documentId: string | null;
}

/**
 * 열기가 끝나고 진행 중인 입출력이 잦아든 뒤, 연결할 문서를 정한다. 세션의 문서가 그 열기가 올린 문서일 때만
 * 잇는다. 다른 열기가 그사이 세션의 문서를 바꿨으면 null — 남의 문서를 '이 채팅이 만든 문서'로 표시하지 않는다.
 */
export function settledLinkLoad(
  loaded: LinkLoad,
  currentDocumentId: string | null,
): { documentId: string; created: boolean } | null {
  if (!loaded.documentId || currentDocumentId !== loaded.documentId) return null;
  return { documentId: loaded.documentId, created: loaded.created };
}

export type UnlinkedThreadRoute<Chat extends RoutingChat = RoutingChat> =
  /** 이 창의 채팅 창 하나가 그 채팅을 이미 들고 있다 — 그리로 간다. */
  | { kind: 'holder'; chat: Chat }
  /** 지금 세션에 문서가 없다 — 그 자리에서 잇는다. */
  | { kind: 'in-place' }
  /** 지금 세션에 문서가 있다 — 문서 없는 새 세션을 열어 잇는다. */
  | { kind: 'new-session' };

/** 지난 문서 없는 채팅을 열 길. 옮겨 갈 문서가 없으므로 문서를 찾지 않는다. */
export function routeUnlinkedThread<Chat extends RoutingChat>(
  current: RoutingSession<Chat>,
  threadId: string,
  allChats: readonly Chat[],
): UnlinkedThreadRoute<Chat> {
  const holder = allChats.find((chat) => chat.sidebar.currentThreadId() === threadId);
  if (holder) return { kind: 'holder', chat: holder };
  return current.wasm.hasLoadedDocument() ? { kind: 'new-session' } : { kind: 'in-place' };
}

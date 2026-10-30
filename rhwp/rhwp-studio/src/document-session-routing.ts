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
 * 홈·파일 메뉴의 열기를 지금 세션 대신 새 세션에 할지. 열린 문서는 탭으로 남으므로 새 탭을 열 수 있으면(tabs)
 * 문서가 있는 세션은 뒤에 둔다. 열 수 없어도 에이전트가 일하는 문서와 관리되는 작업 트리는 뒤에 둔다. 문서가
 * 없는 세션은 쓰이는 문서 없는 채팅이 있을 때만 뒤에 둔다. 그 채팅에 이을 문서를 여는 중(linking)이면 이 세션에 연다.
 */
export function opensInNewSession(
  session: RoutingSession,
  state: { linking: boolean; tabs: boolean; busy: boolean; managedWorktree: boolean },
): boolean {
  if (state.linking) return false;
  if (!session.wasm.hasLoadedDocument()) return sessionHoldsActiveUnlinkedChat(session);
  return state.tabs || state.busy || state.managedWorktree;
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

/** 채팅 자리를 셀 때 보는 문서 세션 하나. */
export interface ChatCapacitySession {
  readonly chats: readonly unknown[];
  /** 화면에 붙어 있거나, 지금 채팅을 다는 세션이다. */
  readonly inUse: boolean;
  /** 에이전트 턴이 돈다. */
  readonly working: boolean;
  /** 닫으면 잃는 것이 있다 — 검토·답을 기다리는 채팅, 저장하지 않은 변경, 관리되는 작업 트리, 진행 중인 열기 같은 것. */
  readonly holds: boolean;
}

export type ChatCapacityPlan<Session> =
  | { kind: 'room'; release: Session[] }
  /** 닫을 수 있는 세션을 모두 닫아도 자리가 나지 않는다. working 은 화면 밖 자리를 모두 일하는 에이전트가 쥐었는지. */
  | { kind: 'full'; working: boolean };

/**
 * 새 채팅 하나의 자리를 낸다. 화면 밖에서 일을 마친 문서는 돌아올 때 곧바로 보이도록 열어 두지만, 그 문서들이
 * 자리를 다 차지하면 일하는 에이전트가 하나뿐이어도 새 채팅과 문서 전환이 막힌다. 자리가 모자라면 그런 세션을
 * 오래된 것부터 닫는다. 닫아도 자리가 나지 않으면 아무것도 닫지 않는다.
 */
export function planChatCapacity<Session extends ChatCapacitySession>(
  sessions: readonly Session[],
  limit: number,
): ChatCapacityPlan<Session> {
  let open = sessions.reduce((count, session) => count + session.chats.length, 0);
  const release: Session[] = [];
  for (const session of sessions) {
    if (open < limit) break;
    if (session.inUse || session.working || session.holds || session.chats.length === 0) continue;
    release.push(session);
    open -= session.chats.length;
  }
  if (open < limit) return { kind: 'room', release };
  return {
    kind: 'full',
    working: sessions.every((session) => session.inUse || session.working || session.chats.length === 0 || !session.holds),
  };
}

/**
 * 문서 하나를 고치는 채팅은 한 번에 하나다 — 그 채팅(주인)을 문서 세션에 둔다.
 *
 * 한 문서의 채팅들은 엔진 하나를 함께 쓴다. 채팅 모드 잠금(사이드바)은 비동기로 걸리고
 * 지연될 수 있어, 두 채팅이 함께 쓰기 모드로 일하는 틈이 생긴다. 쓰기 도구는 문서에 닿기
 * 직전에 주인 자리를 요구하고, 다른 채팅이 쥐고 있으면 아무것도 바꾸지 않고 거절된다.
 *
 * 주인은 따로 놓지 않는다. 주인 채팅이 더는 쓰기를 쥐지 않으면(턴이 끝나고 검토가 정리됨,
 * 멈춤, 닫힘) 다음 동기화나 요구가 그 자리를 비었다고 본다.
 */

/** 주인 자격을 보는 데 필요한 만큼의 채팅. */
export interface DocumentWriterChat {
  readonly bridge: { holdsDocumentWrites(): boolean };
}

/** 주인 자리를 가진 문서 — 엔진 하나와 그 엔진을 쓰는 채팅들. */
export interface DocumentWriterHost<C extends DocumentWriterChat> {
  readonly chats: readonly C[];
  writer: C | null;
}

/** 이 채팅이 아직 문서를 쥐고 있는가 — 이 문서의 채팅이고 쓰기 의도가 있다. */
function holds<C extends DocumentWriterChat>(doc: DocumentWriterHost<C>, chat: C): boolean {
  return doc.chats.includes(chat) && chat.bridge.holdsDocumentWrites();
}

/**
 * 채팅 상태가 바뀐 뒤 부른다. 주인이 놓았으면 비우고, 비었으면 방금 바뀐 채팅이 쥐었을 때
 * 그 채팅이, 아니면 쥔 채팅 중 처음 것이 잡는다. 먼저 쥔 채팅이 주인으로 남는다.
 */
export function syncDocumentWriter<C extends DocumentWriterChat>(doc: DocumentWriterHost<C>, changed?: C): void {
  if (doc.writer && holds(doc, doc.writer)) return;
  if (changed && holds(doc, changed)) {
    doc.writer = changed;
    return;
  }
  doc.writer = doc.chats.find((chat) => holds(doc, chat)) ?? null;
}

/**
 * 쓰기 도구가 문서에 닿기 직전에 부른다. 주인이 이 채팅이거나 비어 있으면(주인이 놓았으면)
 * 이 채팅이 잡고 true, 다른 채팅이 쥐고 있으면 false. 이 문서에서 떨어진 채팅은 쓰지 못한다.
 */
export function claimDocumentWriter<C extends DocumentWriterChat>(doc: DocumentWriterHost<C>, chat: C): boolean {
  if (!doc.chats.includes(chat)) return false;
  if (doc.writer === chat) return true;
  if (doc.writer && holds(doc, doc.writer)) return false;
  doc.writer = chat;
  return true;
}

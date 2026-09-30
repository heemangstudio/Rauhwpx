/**
 * 턴 스냅샷 — 사용자 메시지에 현재 문서의 get_structure 읽기를 실어 보낸다.
 *
 * 턴의 첫 모델 요청은 문서를 읽는 데만 쓰인다. Studio 는 Enter 를 누르는 순간 이미 문서를
 * 들고 있으므로 그 읽기를 메시지에 붙여, 간단한 편집이 쓰기 → 마무리 두 요청으로 끝나게 한다.
 * 에이전트가 마지막으로 본 문서 상태 그대로면 본문 대신 unchanged 표시만 보낸다.
 *
 * 읽기는 동기다 — 메시지 프레임은 예전과 같은 순서로 그 자리에서 나간다. 비용은 읽기 횟수로
 * 묶는다 (많아야 전체 1번 + 보는 쪽 2번). 스냅샷은 덤이라 만들지 못하면 null 이고 메시지는 그대로 나간다.
 */
import type { TurnDocumentSnapshot } from './types.ts';

/** 스냅샷 본문 글자 상한. 넘으면 범위를 줄이고, 그래도 넘으면 보내지 않는다. */
export const SNAPSHOT_MAX_CHARS = 8000;
/** 이 쪽 수까지는 문서 전체를 먼저 읽어 본다. */
export const SNAPSHOT_WHOLE_DOCUMENT_MAX_PAGES = 12;

export interface TurnSnapshotDeps {
  /** AgentToolExecutor.structureSnapshot — get_structure 도구와 같은 글. 읽을 수 없으면 null. */
  read(args: { text?: 'full'; pages?: [number, number] }): { revision: number; text: string; truncated: boolean } | null;
  /** AgentToolExecutor.documentUnchangedSince */
  documentUnchangedSince(revision: number): boolean;
  /** 현재 문서 revision */
  revision(): number;
  /** 쪽 수 — 문서가 없으면 0 */
  pageCount(): number;
  /** 사용자가 보고 있는 쪽 (0-based). 모르면 null */
  activePage(): number | null;
  /** 문서 인스턴스 번호 (WasmBridge.documentInstance) */
  documentInstance(): number | undefined;
}

export interface BuiltTurnSnapshot {
  snapshot: TurnDocumentSnapshot;
  /** 본문이 덮은 쪽 (0-based). 문서 전체면 null 이고, unchanged 는 직전 블록의 범위를 잇는다. */
  page: number | null;
}

export class TurnSnapshots {
  private readonly deps: TurnSnapshotDeps;
  /**
   * 이 채팅의 에이전트가 마지막으로 본 문서 상태 — 스냅샷을 보냈거나 그 뒤 도구 결과를 받은 시점.
   * page 는 마지막 블록이 덮은 범위다 (null = 문서 전체).
   */
  private shown: { revision: number; instance: number | undefined; page: number | null } | null = null;
  /** 이번 턴에 서브에이전트·배경 작업이 돌았다 — 루트가 보지 못한 쓰기가 섞인다. */
  private unseenWriters = false;

  constructor(deps: TurnSnapshotDeps) {
    this.deps = deps;
  }

  /** 프로바이더 맥락이 사라졌거나(새 채팅·세션 교체·재연결) 스냅샷이 닿았는지 알 수 없을 때 부른다. */
  reset(): void {
    this.shown = null;
  }

  beginTurn(): void {
    this.unseenWriters = false;
  }

  /**
   * 서브에이전트가 돌기 시작했다. Claude·Codex 의 서브에이전트는 루트의 MCP 소켓으로 호출해 도구 요청만으로는
   * 루트와 구분되지 않는다 — 그 쓰기를 루트가 본 것으로 이으면 다음 메시지가 낡은 좌표에 unchanged 를 준다.
   * 다음 턴이 시작될 때까지 본 상태를 잇지 않고, 다음 메시지에는 본문을 새로 싣는다.
   */
  noteSubagentActivity(): void {
    this.shown = null;
    this.unseenWriters = true;
  }

  /** 에이전트가 마지막으로 본 문서가 지금 문서와 내용이 같은가. */
  agentIsCurrent(): boolean {
    const shown = this.shown;
    if (!shown || this.unseenWriters) return false;
    try {
      return shown.instance === this.deps.documentInstance()
        && this.deps.documentUnchangedSince(shown.revision);
    } catch {
      return false;
    }
  }

  /**
   * 에이전트에게 보낸 성공한 도구 결과. 실행 직전에 agentIsCurrent() 였던 호출만 넘긴다 —
   * 그래야 결과 revision 까지가 에이전트가 아는 문서다. 사용자 편집을 건너뛴 뒤의 부분 읽기로
   * 전진하면 보지 못한 변경을 unchanged 로 덮게 된다.
   */
  noteToolResult(result: unknown): void {
    const shown = this.shown;
    if (!shown || this.unseenWriters || result === null || typeof result !== 'object') return;
    const revision = (result as { revision?: unknown }).revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision)) return;
    try {
      // 템플릿 읽기처럼 문서 revision 이 아닌 값은 범위 밖이다.
      if (revision < shown.revision || revision > this.deps.revision()) return;
      if (shown.instance !== this.deps.documentInstance()) return;
    } catch {
      return;
    }
    shown.revision = revision;
  }

  /**
   * 지금 보낼 스냅샷. 실패는 null 이다 — 메시지 전송을 막지 않는다.
   * 기억은 바꾸지 않는다 — 프레임이 실제로 나간 뒤 markSent 로 남긴다.
   */
  build(): BuiltTurnSnapshot | null {
    try {
      const pageCount = this.deps.pageCount();
      if (!Number.isInteger(pageCount) || pageCount <= 0) return null;
      const active = this.deps.activePage();
      const view = active !== null && Number.isInteger(active) && active >= 0 && active < pageCount ? active : null;
      const shown = this.shown;
      if (shown && this.agentIsCurrent()) {
        if (shown.page === null || view === null || view === shown.page) {
          return { snapshot: { revision: this.deps.revision(), unchanged: true }, page: shown.page };
        }
        // 문서는 그대로지만 다른 쪽을 보고 있다 — 블록은 "보고 있는 쪽"이라 unchanged 는 예전 쪽을 가리킨다.
        return this.readPage(view);
      }
      if (pageCount <= SNAPSHOT_WHOLE_DOCUMENT_MAX_PAGES) {
        const whole = this.read({ text: 'full' });
        if (whole) return { snapshot: whole, page: null };
      }
      // 전체가 들어가지 않으면 보고 있는 쪽만 — 머리 줄이 쪽 범위를 밝힌다.
      return view === null ? null : this.readPage(view);
    } catch {
      return null;
    }
  }

  markSent(built: BuiltTurnSnapshot): void {
    let instance: number | undefined;
    try {
      instance = this.deps.documentInstance();
    } catch {
      this.shown = null;
      return;
    }
    this.shown = { revision: built.snapshot.revision, instance, page: built.page };
  }

  private readPage(page: number): BuiltTurnSnapshot | null {
    const snapshot = this.read({ pages: [page, page], text: 'full' }) ?? this.read({ pages: [page, page] });
    return snapshot ? { snapshot, page } : null;
  }

  /** 잘리지 않고 상한 안에 드는 읽기만 돌려준다. */
  private read(args: { text?: 'full'; pages?: [number, number] }): TurnDocumentSnapshot | null {
    const result = this.deps.read(args);
    if (!result || result.truncated) return null;
    const { revision, text } = result;
    if (typeof text !== 'string' || text.length === 0 || text.length > SNAPSHOT_MAX_CHARS) return null;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
    return { revision, text };
  }
}

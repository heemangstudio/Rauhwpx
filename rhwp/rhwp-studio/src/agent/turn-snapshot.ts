/**
 * 턴 스냅샷 — 사용자 메시지에 현재 문서의 get_structure 읽기를 실어 보낸다.
 *
 * 턴의 첫 모델 요청은 문서를 읽는 데만 쓰인다. Studio 는 Enter 를 누르는 순간 이미 문서를
 * 들고 있으므로 그 읽기를 메시지에 붙여, 간단한 편집이 쓰기 → 마무리 두 요청으로 끝나게 한다.
 * 에이전트가 마지막으로 본 문서 상태 그대로면 본문 대신 unchanged 표시만 보낸다.
 *
 * 스냅샷은 덤이다 — 만들지 못하면 null 이고 메시지는 그대로 나간다.
 */
import type { AgentName, TurnDocumentSnapshot } from './types.ts';

/** 스냅샷 본문 글자 상한. 넘으면 범위를 줄이고, 그래도 넘으면 보내지 않는다. */
export const SNAPSHOT_MAX_CHARS = 8000;
/** 이 쪽 수까지는 문서 전체를 먼저 읽어 본다. */
export const SNAPSHOT_WHOLE_DOCUMENT_MAX_PAGES = 12;
/** 읽기가 이보다 오래 걸리면 스냅샷 없이 보낸다 — 평소에는 수십 ms 다. */
export const SNAPSHOT_BUILD_TIMEOUT_MS = 2000;

export interface TurnSnapshotDeps {
  /** AgentToolExecutor.execute — 본문이 get_structure 도구 결과와 글자 그대로 같아야 한다. */
  execute(tool: string, args: unknown, agent: AgentName): Promise<unknown>;
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

export class TurnSnapshots {
  private readonly deps: TurnSnapshotDeps;
  private readonly timeoutMs: number;
  /** 이 채팅의 에이전트가 마지막으로 본 문서 상태 — 스냅샷을 보냈거나 그 뒤 도구 결과를 받은 시점. */
  private shown: { revision: number; instance: number | undefined } | null = null;

  constructor(deps: TurnSnapshotDeps, timeoutMs = SNAPSHOT_BUILD_TIMEOUT_MS) {
    this.deps = deps;
    this.timeoutMs = timeoutMs;
  }

  /** 프로바이더 맥락이 사라졌거나(새 채팅·세션 교체·재연결) 스냅샷이 닿았는지 알 수 없을 때 부른다. */
  reset(): void {
    this.shown = null;
  }

  /** 에이전트가 마지막으로 본 문서가 지금 문서와 내용이 같은가. */
  agentIsCurrent(): boolean {
    const shown = this.shown;
    if (!shown) return false;
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
    if (!shown || result === null || typeof result !== 'object') return;
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
   * 지금 보낼 스냅샷. 실패·시간 초과는 null 이다 — 메시지 전송을 막지 않는다.
   * 기억은 바꾸지 않는다 — 프레임이 실제로 나간 뒤 markSent 로 남긴다.
   */
  async build(agent: AgentName): Promise<TurnDocumentSnapshot | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.timeoutMs);
    });
    try {
      return await Promise.race([this.select(agent), timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async select(agent: AgentName): Promise<TurnDocumentSnapshot | null> {
    const pageCount = this.deps.pageCount();
    if (!Number.isInteger(pageCount) || pageCount <= 0) return null;
    if (this.agentIsCurrent()) return { revision: this.deps.revision(), unchanged: true };
    if (pageCount <= SNAPSHOT_WHOLE_DOCUMENT_MAX_PAGES) {
      const whole = await this.read({ text: 'full' }, agent);
      if (whole) return whole;
    }
    // 전체가 들어가지 않으면 보고 있는 쪽만 — 머리 줄이 "pages p-p" 로 범위를 밝힌다.
    const page = this.deps.activePage();
    if (page === null || !Number.isInteger(page) || page < 0 || page >= pageCount) return null;
    return await this.read({ pages: [page, page], text: 'full' }, agent)
      ?? await this.read({ pages: [page, page] }, agent);
  }

  markSent(snapshot: TurnDocumentSnapshot): void {
    let instance: number | undefined;
    try {
      instance = this.deps.documentInstance();
    } catch {
      this.shown = null;
      return;
    }
    this.shown = { revision: snapshot.revision, instance };
  }

  /** 잘리지 않고 상한 안에 드는 읽기만 돌려준다. */
  private async read(args: Record<string, unknown>, agent: AgentName): Promise<TurnDocumentSnapshot | null> {
    const result = await this.deps.execute('get_structure', args, agent) as {
      revision?: unknown;
      truncated?: unknown;
      mcpContent?: Array<{ text?: unknown }>;
    } | null;
    const text = result?.mcpContent?.[0]?.text;
    const revision = result?.revision;
    if (typeof text !== 'string' || text.length === 0 || text.length > SNAPSHOT_MAX_CHARS) return null;
    if (result?.truncated === true) return null;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return null;
    return { revision, text };
  }
}

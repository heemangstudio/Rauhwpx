/** 창과 문서 세션 사이에서 워크트리의 편집 소유자를 하나로 제한한다. */
export class WorktreeOwnership<Owner extends object> {
  readonly #claims = new Map<Owner, {
    documentId: string;
    release: () => void;
    settle: (held: boolean) => void;
    ready: Promise<boolean>;
    held: boolean;
  }>();

  private readonly locks: Pick<LockManager, 'request'> | null;

  constructor(locks: Pick<LockManager, 'request'> | null) {
    this.locks = locks;
  }

  owns(owner: Owner, documentId: string): boolean {
    const claim = this.#claims.get(owner);
    return claim?.documentId === documentId && claim.held;
  }

  async claim(owner: Owner, documentId: string): Promise<boolean> {
    const existing = this.#claims.get(owner);
    if (existing?.documentId === documentId) return existing.ready;
    this.release(owner);
    // Web Locks가 없는 환경에서는 편집 소유권을 보장할 수 없어 읽기 전용으로 연다.
    if (!this.locks) return false;
    let release!: () => void;
    const lifetime = new Promise<void>((resolve) => { release = resolve; });
    let settle!: (held: boolean) => void;
    const ready = new Promise<boolean>((resolve) => { settle = resolve; });
    const claim = { documentId, release, settle, ready, held: false };
    this.#claims.set(owner, claim);
    const forget = () => {
      claim.held = false;
      if (this.#claims.get(owner) === claim) this.#claims.delete(owner);
    };
    try {
      void this.locks.request(`rhwp-worktree:${documentId}`, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
        if (!lock || this.#claims.get(owner) !== claim) {
          forget();
          settle(false);
          return;
        }
        claim.held = true;
        settle(true);
        await lifetime;
        forget();
      }).catch(() => { forget(); settle(false); });
    } catch {
      forget();
      settle(false);
    }
    return ready;
  }

  release(owner: Owner): void {
    const claim = this.#claims.get(owner);
    if (!claim) return;
    this.#claims.delete(owner);
    claim.held = false;
    claim.settle(false);
    claim.release();
  }
}

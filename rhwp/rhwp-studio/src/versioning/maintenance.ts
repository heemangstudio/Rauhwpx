import type { VersionGraphStore } from './store.ts';
import type { RepositoryId } from './types.ts';

const lockName = (id: RepositoryId) => `rhwp-version-history:${id}`;
type MaintenanceStore = Pick<VersionGraphStore, 'getRepository' | 'collectGarbage' | 'backfillObjectSizes'>;
interface MaintenanceOptions {
  enqueue: (operation: () => Promise<void>) => Promise<void>;
  locks?: LockManager | null;
  onError?: (error: unknown) => void;
  delayMs?: number;
}

/** Idle work never participates in the success or failure of an editor command. */
export class VersionMaintenance {
  readonly #pending = new Set<RepositoryId>();
  readonly #releases = new Set<() => void>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #idle: number | null = null;
  #disposed = false;
  private readonly store: MaintenanceStore;
  private readonly options: MaintenanceOptions;

  constructor(
    store: MaintenanceStore,
    options: MaintenanceOptions,
  ) { this.store = store; this.options = options; }

  async retainHistory(id: RepositoryId): Promise<() => void> {
    if (this.#disposed) throw new Error('Version maintenance is disposed');
    if (!this.options.locks) return () => {};
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    let failed!: (reason: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { acquired = resolve; failed = reject; });
    const done = this.options.locks.request(lockName(id), { mode: 'shared' }, async () => {
      acquired();
      await held;
    });
    void done.catch(failed);
    await ready;
    if (this.#disposed) { release(); throw new Error('Version maintenance is disposed'); }
    let released = false;
    const finish = () => {
      if (released) return;
      released = true;
      this.#releases.delete(finish);
      release();
      this.schedule(id);
    };
    this.#releases.add(finish);
    return finish;
  }

  schedule(id: RepositoryId): void {
    if (this.#disposed) return;
    this.#pending.add(id);
    if (this.#timer !== null || this.#idle !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const run = () => {
        this.#idle = null;
        if (!this.#disposed) void this.options.enqueue(() => this.runPending()).catch((error) => this.options.onError?.(error));
      };
      if (typeof requestIdleCallback === 'function') this.#idle = requestIdleCallback(run);
      else run();
    }, this.options.delayMs ?? 1500);
  }

  async runPending(): Promise<void> {
    if (this.#disposed) return;
    const id = this.#pending.values().next().value as RepositoryId | undefined;
    if (!id) return;
    this.#pending.delete(id);
    try {
      const backfill = await this.store.backfillObjectSizes(100);
      if (backfill.hasMore) this.schedule(id);
      // Without cross-window locks, defer destructive maintenance. In particular,
      // another open editor may still own a merge Undo/Redo command.
      if (this.options.locks) await this.options.locks.request(
        lockName(id), { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (!lock || this.#disposed) return;
          const repository = await this.store.getRepository(id);
          if (!repository) return;
          const result = await this.store.collectGarbage(id, repository.revision, { limit: 100 });
          if (result.hasMore) this.schedule(id);
        },
      );
    } catch (error) {
      this.options.onError?.(error);
    }
    const next = this.#pending.values().next().value;
    if (next) this.schedule(next);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    if (this.#idle !== null) cancelIdleCallback(this.#idle);
    this.#timer = null;
    this.#idle = null;
    this.#pending.clear();
    for (const release of this.#releases) release();
  }
}

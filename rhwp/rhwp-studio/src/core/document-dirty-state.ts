import type { EventBus } from './event-bus';

export interface DirtyStateChange {
  dirty: boolean;
  reason?: string;
}

/**
 * 저장되지 않은 문서 변경 상태를 관리한다.
 *
 * 브라우저는 beforeunload에서 앱 커스텀 모달을 허용하지 않으므로,
 * dirty 상태일 때만 브라우저 기본 이탈 확인창이 뜨도록 한다.
 */
export class DocumentDirtyState {
  private dirty = false;
  /**
   * 편집 세대. 이미 dirty 여도 markDirty 마다 증가한다.
   * 저장은 시작 시점의 세대를 잡아 두고, 쓰기가 끝났을 때 세대가 그대로일 때만 clean 으로 바꾼다.
   */
  private revision = 0;
  private beforeUnloadWindow: Window | null = null;
  private allowNextUnload = false;
  private readonly eventBus: EventBus;
  private readonly beforeUnloadHandler = (event: BeforeUnloadEvent): string | void => {
    if (this.allowNextUnload) {
      this.allowNextUnload = false;
      return;
    }
    if (!this.dirty) return;
    event.preventDefault();
    event.returnValue = '';
    return '';
  };

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  markDirty(reason?: string): void {
    this.revision += 1;
    this.setDirty(true, reason);
  }

  markClean(reason?: string): void {
    this.setDirty(false, reason);
  }

  /** 저장할 바이트를 만들기 직전에 호출해 현재 편집 세대를 받는다. */
  captureRevision(): number {
    return this.revision;
  }

  /**
   * 캡처 이후 편집이 없을 때만 clean 으로 바꾼다.
   * 저장이 파일을 쓰는 동안 들어온 입력이나 에이전트 커밋은 파일에 없으므로 dirty 로 남겨야
   * 닫기 확인과 자동 저장 draft 가 유지된다. clean 으로 바꿨으면 true.
   */
  markCleanIfUnchanged(token: number, reason?: string): boolean {
    if (token !== this.revision) return false;
    this.setDirty(false, reason);
    return true;
  }

  permitNextUnload(): void {
    this.allowNextUnload = true;
  }

  installBeforeUnload(windowLike: Window): () => void {
    if (this.beforeUnloadWindow === windowLike) {
      return () => this.uninstallBeforeUnload(windowLike);
    }
    this.beforeUnloadWindow?.removeEventListener('beforeunload', this.beforeUnloadHandler);
    this.beforeUnloadWindow = windowLike;
    windowLike.addEventListener('beforeunload', this.beforeUnloadHandler);
    return () => this.uninstallBeforeUnload(windowLike);
  }

  private uninstallBeforeUnload(windowLike: Window): void {
    if (this.beforeUnloadWindow !== windowLike) return;
    windowLike.removeEventListener('beforeunload', this.beforeUnloadHandler);
    this.beforeUnloadWindow = null;
  }

  private setDirty(next: boolean, reason?: string): void {
    if (this.dirty === next) return;
    this.dirty = next;
    this.eventBus.emit('document-dirty-changed', { dirty: next, reason } satisfies DirtyStateChange);
  }
}

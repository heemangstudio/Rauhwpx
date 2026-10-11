import type { WasmBridge } from '@/core/wasm-bridge';
import type { EventBus } from '@/core/event-bus';
import type { DocumentPosition } from '@/core/types';
import { CharFormatRecoveryError } from '../core/char-format-error';
import { SnapshotCommand, SubmodeSelectionSnapshotCommand } from './command';
import type { OperationDescriptor, RefreshPolicy } from './command';
import type { EditorDocumentState } from './input-handler';
import { clampCaretPosition, withoutHitRect } from './caret-position-clamp';

export interface HeadlessEditorHostDeps {
  /** 세션 자신의 브리지 (퍼사드가 아니다) */
  wasm: WasmBridge;
  /** 세션 자신의 버스 */
  eventBus: EventBus;
  /** 세션의 편집 상태. 히스토리와 캐럿을 그때그때 읽고 캐럿을 다시 써 넣는다. */
  state: EditorDocumentState;
  /** 읽기 전용 문서(템플릿 미리보기 등)면 편집을 받지 않는다. */
  isReadOnly?: () => boolean;
}

/**
 * 화면에 붙어 있지 않은 문서 세션의 편집기 대역. 에이전트가 세션의 브리지에 쓴 편집을 그 세션의
 * 히스토리에 InputHandler 와 같은 방식으로 기록하고, 문서 수준 이벤트(더티 표시·자동 저장·버전이
 * 듣는 document-mutated / document-changed)만 세션 버스에 낸다. 캐럿·선택·쪽 갱신 같은 화면
 * 이벤트는 내지 않는다 — 다시 붙을 때 화면이 문서를 통째로 다시 그린다.
 *
 * 지연 조판은 남기지 않는다. 텍스트 명령이 조판을 미루면 그 자리에서 끝내, 다음 에이전트 읽기와
 * 다시 붙을 때의 쪽 배치가 문서와 맞게 한다.
 *
 * 세션마다 하나를 만들어 세션이 닫힐 때 dispose() 한다. state 객체는 세션이 계속 같은 것을
 * 들고 있어야 한다(detach 결과는 Object.assign 으로 덮어쓴다).
 */
export class HeadlessEditorHost {
  private readonly wasm: WasmBridge;
  private readonly eventBus: EventBus;
  private readonly state: EditorDocumentState;
  private readonly isReadOnly: () => boolean;
  private readonly unsubscribe: () => void;

  constructor(deps: HeadlessEditorHostDeps) {
    this.wasm = deps.wasm;
    this.eventBus = deps.eventBus;
    this.state = deps.state;
    this.isReadOnly = deps.isReadOnly ?? (() => false);
    // InputHandler 와 같은 규칙: 히스토리 밖 변이(에이전트 스테이징·거절 등)가 있으면 마지막
    // 스냅샷을 다음 명령의 before 로 공유하지 않는다. 화면에 붙어 있을 때도 같은 히스토리라
    // 두 번 비워도 무해하다.
    this.unsubscribe = deps.eventBus.on('document-mutated', (reason) => {
      if (reason !== 'input-handler-edit') this.state.history.invalidateCurrentSnapshot();
    });
  }

  /** 세션 캐럿. 문서가 그사이 바뀌었을 수 있어 읽을 때마다 문서 범위로 맞춘다. */
  getCursorPosition(): DocumentPosition {
    const position = clampCaretPosition(this.wasm, this.state.cursor);
    this.state.cursor = position;
    return { ...position };
  }

  executeOperation(desc: OperationDescriptor): void {
    if (this.isReadOnly()) return;
    const history = this.state.history;
    switch (desc.kind) {
      case 'command': {
        let newPos: DocumentPosition;
        try {
          newPos = history.execute(desc.command, this.wasm);
        } catch (error) {
          // 복구 경로는 문서를 이미 바꿨으므로 문서 이벤트를 낸 뒤 실패를 그대로 올린다.
          if (error instanceof CharFormatRecoveryError) this.emitDocumentChanged('full');
          throw error;
        }
        const effects = history.consumeLastExecutionEffects();
        if (effects.documentPaginationPending) this.wasm.flushDeferredPagination();
        // 서식 명령은 커서를 옮기지 않는다 (InputHandler 와 같다).
        if (desc.command.type !== 'applyCharFormat' && desc.command.type !== 'applyParaFormat') {
          this.setCursor(newPos);
        }
        this.emitDocumentChanged(desc.meta?.refresh ?? 'auto');
        return;
      }
      case 'snapshot': {
        const cursorBefore = this.getCursorPosition();
        const cmd = desc.editContext
          ? new SubmodeSelectionSnapshotCommand(
              desc.operationType,
              cursorBefore,
              cursorBefore,
              desc.operation,
              desc.editContext,
              desc.editContextAfter ?? desc.editContext,
              desc.selectionBefore ?? null,
              desc.selectionAfter ?? null,
            )
          : new SnapshotCommand(desc.operationType, cursorBefore, cursorBefore, desc.operation);
        const newPos = history.execute(cmd, this.wasm);
        // [Task #2370] operation 이 무변경(null)을 알리면 기록도 이벤트도 없다.
        if ((cmd as unknown as { isNoOp?: () => boolean }).isNoOp?.()) return;
        this.setCursor(newPos);
        this.emitDocumentChanged(desc.meta?.refresh ?? 'full');
        return;
      }
      case 'record': {
        history.recordWithoutExecute(desc.command, this.wasm);
        this.emitDocumentChanged(desc.meta?.refresh ?? 'none');
        return;
      }
      default: {
        const exhaustive: never = desc;
        void exhaustive;
      }
    }
  }

  prepareSnapshotCapacity(additionalIds: number): void {
    this.state.history.prepareSnapshotCapacity(this.wasm, additionalIds);
  }

  retainExternalSnapshot(count = 1): void {
    this.state.history.retainExternalSnapshot(count);
  }

  releaseExternalSnapshot(count = 1): void {
    this.state.history.releaseExternalSnapshot(count);
  }

  /** 화면에 없는 문서에는 사용자 선택이 없다. */
  getUserSelectionContext(): null {
    return null;
  }

  dispose(): void {
    this.unsubscribe();
  }

  private setCursor(position: DocumentPosition): void {
    this.state.cursor = clampCaretPosition(this.wasm, withoutHitRect(position));
  }

  /**
   * InputHandler.refreshAfterOperation 이 내는 문서 수준 이벤트와 같다. 'none'·'selectionOnly' 는
   * 화면만 고치므로 내지 않고, 'pageLocal' 은 쪽 무효화(화면 이벤트)를 빼고 변이만 알린다.
   * 지연 조판이 남지 않으므로 'auto' 는 InputHandler 에서도 전체 갱신 경로다.
   */
  private emitDocumentChanged(policy: RefreshPolicy): void {
    switch (policy) {
      case 'none':
      case 'selectionOnly':
        return;
      case 'pageLocal':
        this.eventBus.emit('document-mutated', 'input-handler-edit');
        return;
      case 'full':
      case 'auto':
      default:
        this.eventBus.emit('document-mutated', 'input-handler-edit');
        this.eventBus.emit('document-changed');
    }
  }
}

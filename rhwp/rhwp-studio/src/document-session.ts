/**
 * 문서 세션 — 열려 있는 문서 하나가 가진 상태 전부.
 *
 * 편집기 화면(CanvasView·InputHandler)은 하나뿐이고 한 번에 한 세션에만 붙는다. 에이전트가
 * 일하는 문서는 화면에서 떨어져도 세션째 살아 있어, 그 문서의 에이전트가 자기 엔진·히스토리에
 * 계속 쓴다. 페이지 코드는 퍼사드(wasm·eventBus 등)로 지금 붙은 세션을 본다.
 */
import { WasmBridge } from '@/core/wasm-bridge';
import { EventBus } from '@/core/event-bus';
import { DocumentDirtyState } from '@/core/document-dirty-state';
import { CommandHistory } from '@/engine/history';
import { HeadlessEditorHost } from '@/engine/headless-editor-host';
import type { EditorDocumentState } from '@/engine/input-handler';
import type { CanvasViewState } from '@/view/canvas-view';
import {
  AutosaveManager,
  type AutosaveScheduleSettings,
  type AutosaveStatus,
} from '@/recovery/autosave-manager';
import { HostSaveTracker } from '@/recovery/host-save';
import type { AgentBridge } from '@/agent/bridge';
import type { AgentEditingLease } from '@/agent/types';
import type { DocumentVersionController } from '@/versioning/controller';
import type { AgentHubSessionLease, RendererSessionContext } from '@/desktop-integration';
import type { EditorEditMode } from '@/command/types';
import type { initAgentSidebar } from '@/ui/agent-sidebar/index';

/** 한 창에 동시에 열어 둘 수 있는 문서 수. 문서마다 엔진 메모리와 에이전트 프로세스를 쓴다. */
export const MAX_LIVE_DOCUMENT_SESSIONS = 6;

export type DocumentSessionSidebar = ReturnType<typeof initAgentSidebar>;

export interface DocumentSession {
  /** 데스크톱 문서 점유 슬롯. 첫 세션은 기본 슬롯(undefined)을 쓴다. */
  readonly slotId: string | undefined;
  readonly wasm: WasmBridge;
  readonly bus: EventBus;
  readonly documentState: DocumentDirtyState;
  readonly autosave: AutosaveManager;
  readonly hostSave: HostSaveTracker;
  /** 화면에서 떨어져 있는 동안의 히스토리와 캐럿. 같은 객체를 계속 쓴다. */
  readonly editorState: EditorDocumentState;
  /** 화면에서 떨어져 있는 동안 에이전트 편집을 받는 편집기 대역 */
  readonly editorHost: HeadlessEditorHost;
  viewState: CanvasViewState | null;
  documentId: string | null;
  editMode: EditorEditMode;
  agentLease: AgentEditingLease;
  bridge: AgentBridge | null;
  sidebar: DocumentSessionSidebar | null;
  versions: DocumentVersionController | null;
  /** 창의 기본 허브 세션을 쓰면 null, 따로 받은 허브 세션이면 그 임대 */
  hubSession: AgentHubSessionLease | null;
  usesDefaultHub: boolean;
  readonly disposers: Array<() => void>;
}

export interface DocumentSessionCoreOptions {
  slotId?: string;
  isReadOnly: () => boolean;
  autosave: {
    schedule: AutosaveScheduleSettings;
    locks: ConstructorParameters<typeof AutosaveManager>[0]['locks'];
    onStatus: (session: DocumentSession, status: AutosaveStatus) => void;
    owner: Promise<RendererSessionContext | null>;
  };
  /** 세션의 더티 상태가 바뀔 때 (붙어 있지 않은 세션도 포함) */
  onDirtyChanged?: (session: DocumentSession) => void;
}

/** 엔진·버스·더티 상태·자동 저장처럼 화면과 에이전트 없이 서는 부분을 만든다. */
export function createDocumentSessionCore(options: DocumentSessionCoreOptions): DocumentSession {
  const wasm = new WasmBridge();
  const bus = new EventBus();
  const documentState = new DocumentDirtyState(bus);
  const editorState: EditorDocumentState = { history: new CommandHistory(), cursor: null };
  const disposers: Array<() => void> = [];
  const session: DocumentSession = {
    slotId: options.slotId,
    wasm,
    bus,
    documentState,
    autosave: new AutosaveManager({
      exportBytes: () => wasm.exportHwp(),
      schedule: options.autosave.schedule,
      onStatus: (status) => options.autosave.onStatus(session, status),
      locks: options.autosave.locks,
    }),
    hostSave: new HostSaveTracker({
      documentState,
      setFileName: (fileName) => { wasm.fileName = fileName; },
      emitSaved: () => {
        bus.emit('document-context-changed');
        bus.emit('document-saved', {
          reason: 'host-save',
          fileName: wasm.fileName,
          sourceFormat: wasm.getSourceFormat(),
        });
      },
      discardDraft: (reason) => session.autosave.discardCurrentDraft(reason),
    }),
    editorState,
    editorHost: new HeadlessEditorHost({
      wasm,
      eventBus: bus,
      state: editorState,
      isReadOnly: options.isReadOnly,
    }),
    viewState: null,
    documentId: null,
    editMode: 'normal',
    agentLease: { active: false, agent: 'codex' },
    bridge: null,
    sidebar: null,
    versions: null,
    hubSession: null,
    usesDefaultHub: false,
    disposers,
  };

  disposers.push(documentState.installBeforeUnload(window));
  void options.autosave.owner.then((context) => {
    if (context) session.autosave.setOwner({ launchId: context.launchId, sessionId: context.sessionId });
  });
  disposers.push(session.autosave.connect(bus));
  // 더티 표시는 세션이 직접 한다. 화면에 붙어 있지 않은 동안 에이전트가 쓴 편집도 이 문서의 것이다.
  disposers.push(
    bus.on('document-mutated', (reason) => {
      documentState.markDirty(typeof reason === 'string' ? reason : 'document-mutated');
    }),
    bus.on('document-changed', (reason) => {
      documentState.markDirty(typeof reason === 'string' ? reason : 'document-changed');
    }),
    bus.on('document-dirty-changed', () => options.onDirtyChanged?.(session)),
  );
  return session;
}

export function isDocumentSessionBusy(session: DocumentSession): boolean {
  return session.bridge?.isBusy() ?? false;
}

export function createDocumentSessionSlotId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `slot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

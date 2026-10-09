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

/**
 * 한 창에서 동시에 살아 있을 수 있는 채팅(에이전트) 수. 채팅마다 허브 세션과 공급자 프로세스를 쓰고,
 * 문서는 채팅을 하나 이상 가지므로 열린 문서 수도 이 안에 든다.
 */
export const MAX_PARALLEL_CHATS = 6;

export type DocumentSessionSidebar = ReturnType<typeof initAgentSidebar>;

/**
 * 문서 하나에 붙은 채팅 하나 — 자기 브리지·허브 세션·사이드바를 가진다. 한 문서에서 여러 채팅이
 * 함께 돌 수 있고, 문서를 고칠 수 있는 채팅은 한 번에 하나다 (나머지는 채팅 모드만).
 */
export interface ChatSession {
  readonly id: string;
  readonly document: DocumentSession;
  readonly bridge: AgentBridge;
  readonly sidebar: DocumentSessionSidebar;
  /** 창의 기본 허브 세션을 쓰면 null, 따로 받은 허브 세션이면 그 임대 */
  readonly hubSession: AgentHubSessionLease | null;
  agentLease: AgentEditingLease;
  readonly disposers: Array<() => void>;
}

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
  /** 이 문서의 채팅들. 화면에는 activeChat 의 사이드바만 보인다. */
  readonly chats: ChatSession[];
  activeChat: ChatSession | null;
  /** 지금 보이는 채팅의 브리지·사이드바 (activeChat 의 것) */
  readonly bridge: AgentBridge | null;
  readonly sidebar: DocumentSessionSidebar | null;
  versions: DocumentVersionController | null;
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
    chats: [],
    activeChat: null,
    get bridge() { return session.activeChat?.bridge ?? null; },
    get sidebar() { return session.activeChat?.sidebar ?? null; },
    versions: null,
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

/** 이 문서의 채팅 중 하나라도 일하고 있다 (화면에서 떼어 둬야 한다). */
export function isDocumentSessionBusy(session: DocumentSession): boolean {
  return session.chats.some((chat) => chat.bridge.isBusy());
}

/** 이 채팅이 문서를 고칠 수 있는 상태로 일하고 있다 — 같은 문서의 다른 채팅은 채팅 모드만 쓴다. */
export function chatHoldsDocumentWrites(chat: ChatSession): boolean {
  return chat.bridge.holdsDocumentWrites();
}

/** 문서의 편집 잠금은 그 문서를 잡은 채팅의 것이다. 없으면 보이는 채팅의 (꺼진) 잠금. */
export function documentEditingLease(session: DocumentSession): AgentEditingLease {
  return session.chats.find((chat) => chat.agentLease.active)?.agentLease
    ?? session.activeChat?.agentLease
    ?? { active: false, agent: 'codex' };
}

export function createDocumentSessionSlotId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `slot-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

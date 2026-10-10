/**
 * AI 에이전트 사이드바 (ag- 접두어).
 *
 * SidebarBridge 의 SidebarEvent 스트림을 렌더링하고, 대기 중인 에이전트
 * 편집(change-set)의 승인/거절 UI 를 제공한다. 패널은 body 에 고정
 * 마운트하되, 펼침 시 body.ag-sidebar-open 으로 #editor-area 를 밀어
 * 눈금자·용지가 가려지지 않고 남은 폭 기준으로 다시 가운데 정렬되게 한다.
 */
import './motion.css';
import './agent-sidebar.css';
import './plan-presentation.css';
import '../../styles/inline-rename.css';
import { confirmSheet, dismissOpenSheets } from './sheet.ts';
import { createChangesDrawer, createJumpButton, renderPendingOpDiff, renderPendingOpsDiff, summarizeDiffItems } from './changes-drawer.ts';
import { TurnChanges, invalidatedMessage } from './turn-changes.ts';
import type { DiffItem } from '../../compare/types.ts';
import type { DocumentPosition } from '../../core/types.ts';

import type { EventBus } from '../../core/event-bus.ts';
import type { HubChat, SidebarBridge } from '../../agent/bridge.ts';
import type {
  AgentName,
  AgentPhase,
  AgentSetupStatusMap,
  AgentStreamEvent,
  AgentWorkflow,
  AgentWorkflowState,
  PermissionProfile,
  ServiceTier,
  PendingChangeSet,
  PendingEditsChangeEvent,
  PendingOp,
  SidebarEvent,
  StructuredPlan,
  CatalogRow,
  SkillCatalog,
  ProductSkillIcon,
  ProviderFailure,
  DocumentTemplate,
  TemplateCatalog,
  UserQuestionInteraction,
  StagedReference,
} from '../../agent/types.ts';
import {
  defaultModelForAgent,
  effortsForAgent,
  labelForEffort,
  labelForModel,
  modelGroupsForAgent,
  modelSupportsImages,
  resolveEffortForAgent,
  resolveModelForAgent,
  resolveServiceTier,
  agentSupportsFast,
} from '../../agent/models.ts';
import { loadAgentPrefs, type AgentPrefs } from '../../agent/agent-prefs.ts';
import { userSettings } from '../../core/user-settings.ts';
import { renderChatMarkdown, type ChatMarkdownOptions } from './chat-markdown.ts';
import { safeMarkdownHref } from './plan-markdown.ts';
import {
  clampFinite,
  finiteOr,
  parseCssTimeMs,
  planSpring,
  sampleSpring,
  springForDuration,
  snapToDevicePixel,
  springStateAt,
  stepSpring,
  type SpringPlan,
  type SpringState,
} from './motion-model.ts';
import {
  createEmptyThread,
  createPendingUserQuestionDraftSnapshot,
  createTurnMarker,
  createUserQuestionHistoryMessage,
  estimateTurnEnd,
  findTurnMarker,
  isTurnMarker,
  latestTurnMarker,
  settleStoredTurnMarker,
  settleTurnMarker,
  unsettledTurnMarkers,
  archivePendingUserQuestion,
  expirePendingUserQuestion,
  fallbackTitle,
  getThread,
  documentGroupKey,
  forgetDocumentThreads,
  listThreads,
  orderPinnedThreads,
  pinThread,
  placeThread,
  threadListKey,
  unpinThread,
  threadActivityAt,
  removeThread,
  renameThread,
  setThreadTitle,
  serializeThreadMessagesForProviderHistory,
  pendingUserQuestionMatchesInteraction,
  subscribeThreadChanges,
  waitForThreadsPersistence,
  threadMatchesDocument,
  upsertThread,
  type ChatThread,
  type ThreadMessage,
  type ThreadRetryPayload,
  type ThreadAttachment,
  type ThreadTaskRecord,
  type ThreadToolOutcome,
  type ThreadToolRecord,
  type ThreadTurnMessage,
  THREAD_TOOL_IMAGE_MAX_CHARS,
} from '../../agent/threads.ts';
import {
  clearChatStatus,
  getChatStatus,
  getChatWorkingSince,
  markChatFinished,
  markChatNeedsInput,
  markChatWorking,
  subscribeChatStatus,
  type ChatRunStatus,
} from '../../agent/chat-status.ts';
import { turnOutcomeFor, type TurnOutcome } from '../../agent/turn-outcome.ts';
import {
  createTurnFoldRow,
  isTurnWorkNode,
  planTurnFolds,
  settledTurnText,
  settledTurnView,
  type TurnFoldRow,
} from './turn-fold.ts';
import { createChevron, createColumnIcon } from '../chevron.ts';
import { showContextMenu } from '../native-context-menu.ts';
import { setMiddleTruncatedText } from '../middle-truncate.ts';
import { createInkRing, createIcon, createStopIcon } from './icons.ts';
import {
  attachThreadDrag,
  closeThreadRailSurfaces,
  createThreadsToolbar,
  threadRailSurfaceOpen,
  searchKey,
  showDocumentFilter,
  showDocumentPalette,
  formatShortAge,
  type DocumentFilterOption,
} from './thread-rail.ts';
import type { LibraryMoveResult } from '../../library/move-to-document.ts';
import {
  occupySidebarSlot,
  readSidebarPageLayout,
  vacateSidebarSlot,
  writeSidebarPageLayout,
  type SidebarPageLayout,
} from './page-layout.ts';
import { detectPlatformKind, formatShortcutLabel } from '../../engine/navigation-keymap.ts';
import { AGENT_LABEL, createProviderIcon, PROVIDER_ORDER } from './providers.ts';
import { createEffortSlider } from './effort-slider.ts';
import { createComposerRestingMotion } from './composer-resting.ts';
import { createArrivalGuard, typingActivity as windowTypingActivity, type TypingActivity } from './typing-guard.ts';
import { createDelayedStatus, revealAfterDelay } from './delayed-status.ts';
import { ownsTextInput } from '../../command/shortcut-target.ts';
import { createFocusGreeting } from './focus-greeting.ts';
import { createSubagentFleet, isSpawnToolName } from './subagent-fleet.ts';
import { createToolRow, type ToolRowHandle } from './tool-row.ts';
import { createFailureNoticeController, retryRequestText } from './failure-notice.ts';
import {
  baseToolName,
  parseToolArgs,
  presentToolResult,
  summarizeActivity,
  type ToolOutcomeView,
} from './tool-presentation.ts';
import { createSettingsPanel } from './settings.ts';
import {
  normalizeSettingsDestination,
  type EditorSettingsRuntime,
  type SettingsDestination,
} from './settings-contract.ts';
import { createWritingStyleCalibration } from './writing-style-calibration.ts';
import { maybeStartInitialSetup, type InitialSetupUi } from '../initial-setup/initial-setup.ts';
import { beginInlineRename } from '../inline-rename.ts';
import { loadInitialSetup, saveInitialSetup } from '../initial-setup/state.ts';
import { summarizePendingDiffs } from './pending-diff-summary.ts';
import { createReferenceLibrary } from './reference-library.ts';
import { createFollowUpStrip } from './follow-up-strip.ts';
import {
  createFollowUpController,
  type ComposedMessageOrigin,
  type ComposedMessageResult,
  type ComposedMessageSpec,
} from './follow-up-controller.ts';
import { engineTrap } from '../../core/engine-trap.ts';
import {
  createVersionManagerPage,
  type VersionManagerController,
} from './version-manager.ts';
import {
  isDesktopApp,
  openPublishedDocumentInNewWindow,
  parsePublishedDocumentLink,
} from '../../desktop-integration.ts';
import { showToast } from '../toast.ts';
import { fuzzyTemplateScore } from './template-fuzzy.ts';
import {
  defaultSkillIconForName,
  requestTextForSkillInvocation,
  skillGlyphForSkill,
} from './skill-presentation.ts';
import { createSkillsShelf } from './skills-shelf.ts';
import type {
  InlinePromptSendResponse,
  InlinePromptSubmission,
} from '../../agent/inline-prompt-context.ts';
import { createUserQuestionController, type UserQuestionDraftState } from './user-question-controller.ts';
import { decideStartupChat, STARTUP_HUB_ANSWER_TIMEOUT_MS, type StartupChatDecision } from './startup-chat.ts';
import { createModeMenu, parseModeCommand } from './mode-menu.ts';
import { createTurnRestoreActions } from './turn-restore-action.ts';
import type { TurnRestoreControl } from '../../agent/turn-checkpoints.ts';
import { agentModeFor, agentModeTarget, planTodoTitle, type AgentMode } from '../../agent/types.ts';
import './sidebar-button-modern.css';

export interface AgentSidebarDeps {
  bridge: SidebarBridge;
  /**
   * 리셋 후 이어서 보내기의 여유 시간 (기본 30초 — 시계 차이). 미리보기·검사가 짧게 줄인다.
   */
  failureResumeGraceMs?: number;
  /** inset 전환 후 용지 가운데 정렬을 요청할 때 사용 */
  eventBus?: EventBus;
  editorSettingsRuntime?: EditorSettingsRuntime;
  /** 헤더에 표시할 현재 문서와 선택 상태. */
  getDocumentContext?: () => {
    documentId?: string | null;
    documentName: string | null;
    selectionLabel: string | null;
    pageCount?: number;
  };
  /**
   * 다른 문서로 옮겨 간다 — 바뀐 내용이 있으면 저장한 뒤 대상 문서를 연다.
   * commit 이면 떠나기 전에 버전 기록에 커밋한다
   * (버전 기록이 켜져 있고 커밋하지 않은 변경이 있을 때만).
   */
  moveToLibraryDocument?: (
    target: { documentId: string | null; fileName: string | null },
    options?: { commit?: boolean },
  ) => Promise<LibraryMoveResult>;
  /** 문서 열기의 "새 문서"·"파일 열기…" — 편집기의 같은 명령을 부른다. */
  createDocument?: () => void;
  openDocumentFile?: () => void;
  /** 문서 열기가 보여 줄 최근 문서. */
  listRecentDocuments?: () => Promise<Array<{
    documentId: string;
    fileName: string;
    sourceFormat: string;
    openedAt: number;
  }>>;
  /** 현재 문서의 로컬 커밋과 브랜치를 관리한다. */
  versionController?: VersionManagerController;
  getAgentUndoEntry?: () => object | null;
  undoAgentTurn?: (entry: object) => boolean;
  /**
   * 요청마다 "이 작업 전으로 되돌리기" (agent/turn-checkpoints.ts). turn-start 에 그 턴의 요청을
   * 알리고, 사용자 말풍선의 되돌리기 버튼이 상태를 읽고 되돌린다. 없으면 버튼이 없다.
   */
  turnRestore?: TurnRestoreControl;
  navigateToChange?: (position: DocumentPosition, anchor?: DiffItem['rightAnchor']) => void;
  /** 기존 RHWP 문서 이력 대화상자를 연다. */
  openClassicVersionControl?: () => void;
  /**
   * false 면 화면에 붙이지 않은 채로 만든다 — 다른 문서의 사이드바가 화면을 가진
   * 동안 뒤에서 브리지 이벤트를 받는다. 기본 true.
   */
  startActive?: boolean;
  /**
   * 다른 문서의 채팅을 연다. 편집기가 문서 세션을 관리할 때 넘긴다. 있으면
   * 사이드바는 지금 도는 작업을 멈추지 않고 현재 채팅만 저장한 뒤 편집기에 맡긴다.
   * 편집기는 이 사이드바를 내리고 그 문서 세션의 사이드바를 올릴 수 있다.
   */
  openThreadDocument?: (
    thread: { id: string; documentId: string | null; docKey: string | null },
  ) => Promise<LibraryMoveResult>;
  /**
   * 새 채팅과 같은 문서의 다른 채팅 열기를 편집기에 먼저 맡긴다. 사이드바는 묻기 전에
   * 지금 채팅을 저장하고, 도는 작업은 멈추지 않는다. 'handled' 면 편집기가 다른 채팅
   * 창을 보이고 이 사이드바를 내렸다. 'local' 이면 이 사이드바가 직접 연다.
   */
  openChat?: (
    request: { kind: 'new' } | { kind: 'thread'; threadId: string },
  ) => Promise<'handled' | 'local'>;
  /**
   * 같은 문서의 다른 채팅이 문서를 고치는 동안 get() 이 이유를 돌려준다. 그동안 이
   * 채팅은 채팅 모드로만 보내고, 이유는 막힌 모드의 짧은 툴팁이 된다.
   */
  chatModeLock?: {
    get(): { reason: string } | null;
    subscribe(listener: () => void): () => void;
  };
  /** 문서 이름을 바꾼다. 바뀐 파일 이름, 바꾸지 못했으면 null (이유는 편집기가 알린다). */
  renameDocument?: (name: string) => Promise<string | null>;
  /** 쓰기 활동 — 기본은 창 전체 감시자. 미리보기가 '쓰는 중' 장면을 고정할 때만 바꾼다. */
  typingActivity?: TypingActivity;
}

export interface AgentSidebarHandle {
  root: HTMLElement;
  openVersions(): void;
  sendInlinePrompt(submission: InlinePromptSubmission): InlinePromptSendResponse;
  /** 화면에 붙인다 — 페이지 배치(펼침·폭·집중 모드·목록)를 이어받고 애니메이션은 다시 돌리지 않는다. */
  activate(): void;
  /** 화면에서 내린다. 브리지와 대화 상태는 그대로 두고, 페이지 배치는 다음 사이드바에 넘긴다. */
  deactivate(): void;
  isActive(): boolean;
  /** 이 문서의 채팅을 연다 — 편집기가 이 사이드바를 올린 뒤 부른다. */
  openThreadById(threadId: string): void;
  /** 이 세션에 다음으로 열리는 문서가 그 채팅의 문서면 그 채팅을 잇는다. */
  followThreadOnNextDocument(threadId: string): void;
  /**
   * 새 채팅 초안을 집중 모드로 연다. 첫 메시지를 보내기 전까지 스레드도 허브 채팅도
   * 만들지 않는다 — 편집기가 새로 띄운 채팅 창에서 부른다.
   */
  startDraftChat(): void;
  /** 이 사이드바가 보이는 채팅. 초안이거나 비어 있으면 null. */
  currentThreadId(): string | null;
  /**
   * 시작 채팅 고르기가 끝나면 풀린다 — 스레드 저장소와 허브의 첫 답을 기다린 뒤 살아 있는 채팅을
   * 잇거나 마지막 채팅을 복원한 다음이다. 그 뒤에 채팅을 다루는 스크립트·검사가 기다린다.
   */
  startupChatSettled(): Promise<void>;
  dispose(): void;
}

/* 첫 실행 안내는 페이지에 하나만 띄운다 — 문서마다 사이드바가 있어도 겹치지 않게. */
let initialSetupOwner: object | null = null;

/** 화면에서 내려간 사이드바가 남기는 자리 표시 이름. */
const ROOT_SLOT = 'agent-sidebar';
const COLLAPSE_TAB_SLOT = 'agent-sidebar-collapse-tab';

type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'replaced';

interface TurnActivityState {
  root: HTMLElement;
  label: HTMLElement;
  content: HTMLElement;
  toolCount: number;
  /** 활동 제목(“편집 3번 · 읽기 2번”)을 만드는 호출 목록 */
  calls: Array<{ callId: string; tool: string; argsJson: string; failed: boolean }>;
  failedToolCount: number;
  activeTools: Map<string, string>;
  acceptingTools: boolean;
  settled: boolean;
}

interface ToolRowState {
  row: ToolRowHandle;
  scroller: HTMLElement;
  startedAt: number;
  activity: TurnActivityState;
  /** 접두어를 뗀 도구 이름과 인자 — 실행기 결과를 이 행에 맞출 때 쓴다 */
  name: string;
  args: Record<string, unknown>;
  argsJson: string;
  /** 스튜디오 실행기가 먼저 알려 준 결과 */
  executed?: { ok: boolean; outcome: ToolOutcomeView };
}

/** 실행기 결과가 행보다 먼저 도착했을 때 잠시 붙잡아 두는 기록. */
interface PendingExecution {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  outcome: ToolOutcomeView;
  at: number;
}

/** 실행기 인자와 프로바이더 인자가 같은 호출인가 — 양쪽에 다 있는 키만 비교한다
 *  (허브 스키마가 기본값을 채우거나 모르는 키를 떨어뜨리므로). */
function sameToolArgs(provider: Record<string, unknown>, executed: Record<string, unknown>): boolean {
  for (const key of Object.keys(executed)) {
    if (!(key in provider)) continue;
    if (JSON.stringify(provider[key]) !== JSON.stringify(executed[key])) return false;
  }
  return true;
}

/** 저장용 결과 줄 — 그림은 줄여서 따로 채우므로 여기서는 뺀다. */
function storedOutcome(outcome: ToolOutcomeView): ThreadToolOutcome {
  const { image: _image, ...rest } = outcome;
  return rest;
}

/** 결과 그림을 기록에 넣을 크기로 줄인다 (긴 변 640px, webp). 실패하면 null. */
function shrinkToolImage(src: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight, 1));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL('image/webp', 0.82);
        resolve(url.length <= THREAD_TOOL_IMAGE_MAX_CHARS ? url : null);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

type ThreadActivityMessage = Extract<ThreadMessage, { kind: 'activity' }>;
type ThreadTasksMessage = Extract<ThreadMessage, { kind: 'tasks' }>;

interface ActivityTranscriptState {
  message: ThreadActivityMessage;
  acceptingTools: boolean;
}

const SIDEBAR_WIDTH_KEY = 'rhwp-agent-sidebar-width-v3';
const SIDEBAR_WIDTH_DEFAULT = 480;
/* 레이아웃 전·측정 실패 시 바닥. 실제 최솟값은 입력기 하단 한 줄의
   묶인 폭으로 매 프레임 다시 잰다. */
const SIDEBAR_WIDTH_MIN_FALLBACK = 280;
const SIDEBAR_PACKED_BUFFER_PX = 8;
const COMPOSER_COMPACT_WIDTH_PX = 400;
/** 한 번의 스크롤 제스처가 이만큼 위로 움직이면 입력기를 한 줄로 접는다. */
const COMPOSER_REST_SCROLL_PX = 24;
/** 휠 이벤트 사이가 이보다 벌어지면 새 제스처로 센다. */
const COMPOSER_REST_GESTURE_MS = 120;
/** 한 줄 입력의 textarea 높이 상한. 넘으면 접지 않는다. */
const COMPOSER_REST_MAX_INPUT_PX = 40;
/** 대화 끝이 이만큼 가려져야 입력기를 접는다. 접힐 때 넓어지는 높이보다 커야 한다. */
const COMPOSER_REST_END_CLEARANCE_PX = 80;
/** --ag-dur-slow 를 못 읽을 때의 사이드바 스프링 시간(motion.css 와 같은 값). */
const SIDEBAR_MOTION_DURATION_MS = 320;

/** 사이드바가 드러난 폭 하나를 움직이는 스프링과, 그 값으로 그린 WAAPI 묶음. */
interface InsetMotion {
  plan: SpringPlan;
  /** 모든 애니메이션이 공유하는 document.timeline 시각(ms) */
  startTime: number;
  animations: Animation[];
  paneWidth: number;
  open: boolean;
  /** 펼칠 때처럼 레이아웃 커밋을 끝까지 미룬 경우 */
  deferCommit: boolean;
  /** false 면 사이드바는 제자리이고 문서 층만 움직인다(폭 초기화). */
  drivesSidebar: boolean;
}

/* 전체 화면 전환은 한 번의 교차 페이드다(agent-sidebar.css
   --ag-fs-crossfade-duration 과 같은 값). 타이머는 끝날 때까지의 여유분을 포함한다. */
const FS_CROSSFADE_MS = 220;
const FS_MOTION_SETTLE_MS = FS_CROSSFADE_MS + 60;
const COMPACT_RAIL_HOVER_OPEN_DELAY_MS = 260;
const STREAMING_RENDER = { streaming: true, animate: true } as const;
/** '최근' 버튼은 마지막 내용이 이만큼 가려지면 나타나고, 이 아래로 드러나면 사라진다. */
const LATEST_SHOW_PX = 48;
const LATEST_HIDE_PX = 8;

const CLIPBOARD_IMAGE_EXTENSION: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

function imageFileName(source: File, type: string, label: string, stamp: string, index: number): string {
  const extension = CLIPBOARD_IMAGE_EXTENSION[type];
  const suppliedName = source.name.trim();
  const suppliedExtension = suppliedName.split('.').pop()?.toLowerCase();
  const hasMatchingExtension = extension === 'jpg'
    ? suppliedExtension === 'jpg' || suppliedExtension === 'jpeg'
    : suppliedExtension === extension;
  return hasMatchingExtension
    ? suppliedName
    : `${label} ${stamp}${index ? `-${index + 1}` : ''}.${extension}`;
}

function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue;
    const source = item.getAsFile();
    if (!source) continue;
    const type = (item.type || source.type).toLowerCase();
    const extension = CLIPBOARD_IMAGE_EXTENSION[type];
    if (!extension) continue;
    const name = imageFileName(source, type, '붙여넣은 이미지', stamp, files.length);
    files.push(new File([source], name, { type, lastModified: Date.now() }));
  }
  return files;
}

function droppedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return Array.from(data.files, (file, index) => {
    const type = file.type.toLowerCase();
    if (!CLIPBOARD_IMAGE_EXTENSION[type]) return file;
    const name = imageFileName(file, type, '드롭한 이미지', stamp, index);
    return name === file.name ? file : new File([file], name, { type, lastModified: file.lastModified });
  });
}

function transferHasFiles(data: DataTransfer | null): boolean {
  return Boolean(data && Array.from(data.types).includes('Files'));
}

function maxSidebarWidth(minWidth: number, viewportWidth = window.innerWidth): number {
  const viewport = Number.isFinite(viewportWidth) ? viewportWidth : minWidth * 2;
  return Math.max(minWidth, Math.floor(viewport * 0.5));
}

function clampSidebarWidth(
  width: number,
  minWidth: number,
  viewportWidth = window.innerWidth,
): number {
  // NaN·무한대 폭은 기본 폭으로 본다 — 한 번 새면 transform·여백이 모두 NaN 이 된다.
  const safe = Number.isFinite(width) ? width : SIDEBAR_WIDTH_DEFAULT;
  return Math.min(
    maxSidebarWidth(minWidth, viewportWidth),
    Math.max(minWidth, Math.round(safe)),
  );
}

function readStoredSidebarWidth(minWidth = SIDEBAR_WIDTH_MIN_FALLBACK): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return SIDEBAR_WIDTH_DEFAULT;
    const n = Number(raw);
    return Number.isFinite(n) ? clampSidebarWidth(n, minWidth) : SIDEBAR_WIDTH_DEFAULT;
  } catch {
    return SIDEBAR_WIDTH_DEFAULT;
  }
}

function horizontalChrome(el: HTMLElement, props: string[]): number {
  const style = getComputedStyle(el);
  return props.reduce((sum, prop) => sum + (Number.parseFloat(style.getPropertyValue(prop)) || 0), 0);
}

function persistSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
  } catch {
    /* ignore quota / private mode */
  }
}

const THREADS_RAIL_KEY = 'rhwp-agent-threads-rail-collapsed';
const ENVIRONMENT_PANEL_OPEN_KEY = 'rhwp-agent-environment-panel-open';

function readStoredThreadsRailCollapsed(): boolean {
  try {
    return localStorage.getItem(THREADS_RAIL_KEY) === '1';
  } catch {
    return false;
  }
}

function persistThreadsRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(THREADS_RAIL_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore quota / private mode */
  }
}

function readStoredEnvironmentPanelOpen(): boolean {
  try {
    return localStorage.getItem(ENVIRONMENT_PANEL_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function persistEnvironmentPanelOpen(open: boolean): void {
  try {
    localStorage.setItem(ENVIRONMENT_PANEL_OPEN_KEY, open ? '1' : '0');
  } catch {
    /* ignore quota / private mode */
  }
}

/* 전체 화면의 대화 목록과 변경 사항 drawer 폭. */
const RAIL_WIDTH_KEY = 'rhwp-agent-rail-width';
const RAIL_WIDTH_DEFAULT = 264;
const RAIL_WIDTH_MIN = 200;
const REVIEW_WIDTH_KEY = 'rhwp-agent-review-width';
const REVIEW_WIDTH_DEFAULT = 560;
const REVIEW_WIDTH_MIN = 320;

function maxRailWidth(viewportWidth = window.innerWidth): number {
  return Math.max(RAIL_WIDTH_MIN, Math.floor(viewportWidth * 0.3));
}

function clampRailWidth(width: number, viewportWidth = window.innerWidth): number {
  return Math.min(maxRailWidth(viewportWidth), Math.max(RAIL_WIDTH_MIN, Math.round(width)));
}

function maxReviewWidth(viewportWidth = window.innerWidth): number {
  return Math.max(REVIEW_WIDTH_MIN, Math.floor(viewportWidth * 0.45));
}

function clampReviewWidth(width: number, viewportWidth = window.innerWidth): number {
  return Math.min(maxReviewWidth(viewportWidth), Math.max(REVIEW_WIDTH_MIN, Math.round(width)));
}

function defaultReviewWidth(): number {
  return clampReviewWidth(REVIEW_WIDTH_DEFAULT);
}

function readStoredRailWidth(): number {
  try {
    const raw = localStorage.getItem(RAIL_WIDTH_KEY);
    if (!raw) return clampRailWidth(RAIL_WIDTH_DEFAULT);
    const n = Number(raw);
    return Number.isFinite(n) ? clampRailWidth(n) : clampRailWidth(RAIL_WIDTH_DEFAULT);
  } catch {
    return clampRailWidth(RAIL_WIDTH_DEFAULT);
  }
}

function persistRailWidth(width: number): void {
  try {
    localStorage.setItem(RAIL_WIDTH_KEY, String(width));
  } catch {
    /* ignore quota / private mode */
  }
}

function readStoredReviewWidth(): number {
  try {
    const raw = localStorage.getItem(REVIEW_WIDTH_KEY);
    if (!raw) return defaultReviewWidth();
    const n = Number(raw);
    return Number.isFinite(n) ? clampReviewWidth(n) : defaultReviewWidth();
  } catch {
    return defaultReviewWidth();
  }
}

function persistReviewWidth(width: number): void {
  try {
    localStorage.setItem(REVIEW_WIDTH_KEY, String(width));
  } catch {
    /* ignore quota / private mode */
  }
}

const CONN_LABEL: Record<ConnectionState, string> = {
  connected: '연결됨',
  connecting: '연결 중…',
  disconnected: '연결 끊김',
  replaced: '다른 탭에서 사용 중',
};

/** 입력기를 잠깐 잠그는 까닭. 먼저 맞는 것이 이긴다. */
type ComposerLock = 'replaced' | 'connecting' | 'disconnected' | 'starting' | 'switching' | 'attaching';

/* ── 작업 방식 (Direct / Plan / Question) ─────────────────
   계약은 `agent/types.ts`(AgentWorkflow · AgentPhase · StructuredPlan ·
   AgentWorkflowState)와 `agent/bridge.ts`(getWorkflowState · setWorkflow ·
   approvePlan · requestPlanChanges)에 있다. 사이드바는 그 상태를 그리고,
   승인/수정 요청 두 동작만 되돌려 보낸다. */

/** 지속 표시용 단계 라벨. direct 는 배지를 띄우지 않는다(소음). */
const PLANNING_PHASE_LABEL: Record<AgentPhase, string> = {
  direct: '바로 실행',
  planning: '구상 중',
  questioning: '질문 중',
  'awaiting-approval': '승인 대기',
  switching: '전환 중',
  implementing: '실행 중',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}


export function initAgentSidebar(deps: AgentSidebarDeps): AgentSidebarHandle {
  const {
    bridge,
    eventBus,
    editorSettingsRuntime,
    getDocumentContext,
    moveToLibraryDocument,
    createDocument,
    openDocumentFile,
    listRecentDocuments,
    versionController,
    openClassicVersionControl,
    openThreadDocument,
    openChat,
    chatModeLock,
  } = deps;

  /**
   * 이 사이드바가 화면에 붙어 있는가. 문서마다 사이드바가 하나씩 있고 화면에는
   * 하나만 선다. body·html 클래스, 페이지 CSS 변수, 문서 층 애니메이션, 전역
   * 단축키처럼 페이지 전체에 걸리는 일은 붙은 사이드바만 한다.
   */
  let active = deps.startActive !== false;
  /** 창 전체의 쓰기 활동 — 쓰는 중에 도착한 질문을 미루고, 보내면 연다. */
  const typing = deps.typingActivity ?? windowTypingActivity();
  /** 편집 영역 inset 을 이 사이드바가 커밋한 상태(body.ag-sidebar-inset 과 같다). */
  let editorInsetApplied = false;

  /** 페이지 클래스는 붙은 사이드바만 바꾼다. */
  function setPageClass(name: string, on: boolean): void {
    if (active) document.body.classList.toggle(name, on);
  }

  // 개인 기본값(설정 탭에서 저장) — 새 대화가 이 조합으로 열린다.
  let agentPrefs: AgentPrefs = loadAgentPrefs();
  let selectedAgent: AgentName = bridge.getActiveAgent() ?? agentPrefs.defaultAgent;
  let selectedModel = resolveModelForAgent(selectedAgent, agentPrefs.defaultModel);
  let selectedEffort = resolveEffortForAgent(selectedAgent, agentPrefs.defaultEffort, selectedModel);
  let selectedServiceTier: ServiceTier = resolveServiceTier(selectedAgent, null);
  let connState: ConnectionState = bridge.getConnectionState();
  /** 지금까지 실패한 연결 시도 수 — 점 색만 고른다. 화면에는 세지 않는다. */
  let connAttempt = 0;
  /* 연결 점과 입력기 잠금은 400ms 를 넘긴 상태만 보인다 — 짧은 재연결이나 채팅 시작이
     점·잠긴 입력기로 깜빡이지 않는다. 다른 탭 사용(replaced)은 바로 보인다. 판단은
     언제나 실제 상태(connState 등)로 한다. */
  const connStatus = createDelayedStatus<ConnectionState>(() => renderConnStatus(),
    { immediate: (state) => state === 'replaced' });
  /** 목록의 작업 중 표시를 드러낼 타이머와 그 시각(Date.now 기준). */
  let railRevealTimer: number | null = null;
  let railRevealAt = Number.POSITIVE_INFINITY;
  /** updateComposer 안에서 잠금이 바로 바뀌면 그 자리에서 그리므로 다시 부르지 않는다. */
  let composerUpdating = false;
  let composerUpdateQueued = false;
  const composerLock = createDelayedStatus<ComposerLock>(() => {
    if (!composerUpdating) scheduleComposerUpdate();
  }, { immediate: (lock) => lock === 'replaced' });
  let turnRunning = bridge.isTurnRunning();
  let mergeResolverLocked = false;
  /** 사용자 말풍선의 "이 작업 전으로 되돌리기" 버튼 */
  const restoreActions = deps.turnRestore
    ? createTurnRestoreActions({
      control: deps.turnRestore,
      threadId: () => currentThread.id,
      // 에이전트가 일하는 동안의 누름은 무시하지 않고 거절 사유(작업 중)를 알린다.
      locked: () => mergeResolverLocked,
      restored: (key) => handleTurnRestored(key),
    })
    : null;
  /** 지금 노란 불이 붙어 있는 스레드 — 턴이 끝나면 초록 점으로 넘긴다. */
  let runStatusThreadId: string | null = null;
  let workflowTransitionPending = false;
  /** chat-started 후 입력기를 여는 건 마지막으로 요청한 스레드뿐이다. */
  let chatStartPendingThreadId: string | null = null;
  /** 현재 스트리밍 중인 assistant 텍스트 (tool-call 이후에는 새로 연다). */
  let streamBubble: HTMLElement | null = null;
  /** 끝난 턴의 최종 답변. 다음 턴이 시작될 때까지 스크롤 기준점으로 남는다. */
  let settledAnswer: HTMLElement | null = null;
  /** '최근'을 누른 뒤에는 이번 턴 동안 답변 머리 대신 대화 끝을 따라간다. */
  let followConversationEnd = false;
  const toolRows = new Map<string, ToolRowState>();
  let pendingExecutions: PendingExecution[] = [];
  /**
   * 편대 카드로 간 서브에이전트 도구 호출 — 실행기 알림에는 호출 주인이 없어(허브가 모르는
   * 경우) 같은 이름·인자의 루트 행이 서브에이전트 결과를 가져가지 않도록 먼저 소비한다.
   */
  let subagentToolCalls: Array<{ callId: string; name: string; args: Record<string, unknown>; at: number }> = [];
  let turnActivity: TurnActivityState | null = null;
  let turnToolCount = 0;
  let turnFailedToolCount = 0;
  let activityTranscript: ActivityTranscriptState | null = null;
  const activityTranscripts = new Map<string, ActivityTranscriptState>();
  const transcriptTools = new Map<string, { tool: ThreadToolRecord; activity: ActivityTranscriptState; startedAt: number }>();
  let tasksTranscript: ThreadTasksMessage | null = null;
  const transcriptTasks = new Map<string, ThreadTaskRecord>();
  const taskToolRecords = new Map<string, { tool: ThreadToolRecord; task: ThreadTaskRecord; startedAt: number }>();
  const taskTextBuffers = new Map<string, string>();
  let turnPresentedPlan = false;
  let planCardPending = false;
  /**
   * 도는 턴의 표식 — 턴이 시작될 때 대화에 넣고, 끝나면 결과와 함께 정착하며 그 턴의
   * 작업을 접는다. markerId 는 같은 턴을 가리키는 키로도 쓴다(알림 등).
   */
  let openFold: { threadId: string; markerId: string } | null = null;
  /** 이번 턴에 'error' 이벤트를 받았는가 — 턴 결과를 실패로 본다. */
  let turnErrorSeen = false;
  /** 마지막 turn-end 의 결과 — 바로 뒤에 오는 실패 알림(turn-failure)이 대기열을 붙잡을지 가른다. */
  let lastTurnEndOutcome: TurnOutcome | null = null;
  /** 화면의 접힘 줄 — 표식 id 로 찾는다. 대화를 다시 그리면 같은 턴의 새 줄로 바뀐다. */
  const turnFoldRows = new Map<string, TurnFoldRow>();
  let followConversation = true;
  let conversationScrollRaf: number | null = null;
  let conversationScrollTargetNode: HTMLElement | null = null;
  let conversationScrollSmooth = false;
  /** 대화 스크롤 스프링 상태(scrollTop px, px/s). null = 멈춤 */
  let conversationScrollState: SpringState | null = null;
  /** 진행 중인 대화 스크롤의 스프링 설정. undefined 면 다음 프레임에서 읽는다. */
  let conversationScrollConfigCache: ReturnType<typeof springForDuration> | undefined;
  let conversationScrollLastFrame = 0;
  /** 스프링 목표의 캐시. null 이면 다음 프레임에서 다시 잰다. */
  let conversationScrollTargetValue: number | null = null;
  let conversationScrollTargetFor: HTMLElement | null = null;
  let conversationScrollLock = false;
  let conversationScrollUnlock: number | null = null;
  /** 잠금이 풀릴 시각과 걸려 있는 타이머가 깨어날 시각 (performance.now 기준). */
  let conversationScrollUnlockAt = 0;
  let conversationScrollUnlockTimerAt = 0;
  let conversationScrollPaused = false;
  let conversationLastScrollTop = 0;
  let replyPending = false;
  /** 편대 카드가 대신 나타내는 스폰 도구 호출 — 결과 행도 함께 접는다. */
  const suppressedSpawnCalls = new Set<string>();
  const reviewImageUrls = new Map<string, string>();
  /**
   * 서브에이전트·워크플로 카드. 턴이 도는 동안 입력기 위 도크 팝업이 서브에이전트
   * 작업을 보는 자리이고, 턴이 끝나면 태어날 때 예약한 슬롯으로 접혀 정착한다.
   */
  const fleetView = createSubagentFleet({
    doc: document,
    sessionModel: (agent) => (agent === selectedAgent ? selectedModel : null),
    // 카드가 태어난 자리를 흐름에 예약한다. 도구 활동 그룹과 같은 자리로 끼워
    // 넣어 흐름 순서를 지키고, 이 뒤의 도구 호출은 새 그룹으로 연다.
    mountSlot(slot) {
      flushAssistantBuffer({ kind: 'progress' });
      const milestone = compactStreamIntoActivity(selectedAgent);
      // 방금 닫는 도구 활동 그룹이 있으면 그 옆자리에 선다 — 정착한 기록이 바로 위
      // 도구 기록과 같은 들여쓰기로 줄을 맞춘다 (이정표 안의 그룹은 17px 들여쓴다).
      const neighbor = turnActivity?.root ?? null;
      closeCurrentActivityGroup();
      withAutoScroll(() => {
        if (milestone) milestone.appendChild(slot);
        else if (neighbor?.parentElement) neighbor.parentElement.appendChild(slot);
        else appendConversation(slot);
      });
      streamBubble = null;
    },
    // 팝업이 열리면 펼쳐 둔 도구 활동 그룹을 접는다 — 같은 모양의 살아 있는
    // 기록이 둘 펼쳐져 있지 않게 한다 (반대 방향은 그룹 토글이 맡는다).
    onPopupToggle(open) {
      if (open) collapseTurnActivity();
    },
  });
  /** 진행 중인 사이드바·문서 층 스프링 (null = 멈춤) */
  let insetMotion: InsetMotion | null = null;
  /** 멈춰 있을 때 사이드바가 드러나 있는지. 되돌리기 없이 새로 출발할 때의 시작 위치다. */
  let sidebarShownAtRest = false;
  /** 스프링이 멈춘 뒤 한 번 부를 일 (끌기 도중 다시 펼친 뒤 폭 추종 재개 등) */
  let afterInsetSettle: (() => void) | null = null;
  /** 손잡이를 끄는 중 (접힘·다시 펼침 구간 포함) */
  let widthDragging = false;
  /** 지금 레이아웃에 반영된 편집 영역 오른쪽 inset(px). 전이 폭 계산의 기준이다. */
  let committedEditorInsetPx = 0;
  let resizeMoveRaf: number | null = null;
  let resizeMoveX = 0;
  // ── 문서별 채팅 ──────────────────────────────────────
  // 채팅은 만들어질 때의 문서에 묶인다. 문서가 바뀌면 새 채팅을 시작하고,
  // 다른 문서의 채팅을 열면 그 문서로 옮겨 가서 잇는다.
  let currentDocKey: string | null = getDocumentContext?.().documentName ?? null;
  let currentDocumentId: string | null = getDocumentContext?.().documentId ?? null;
  /** 읽기 전용으로 열람 중인 다른 문서 채팅의 문서 라벨 (null = 정상 모드). */
  let readOnlyDocLabel: string | null = null;
  /** 다른 문서의 채팅을 열려고 문서를 바꾸는 중 — 그 문서가 열리면 이 채팅을 잇는다. */
  let pendingThreadSwitch: { threadId: string } | null = null;
  /** 채팅 목록 검색어와 문서 필터(키: documentGroupKey). */
  let threadQuery = '';
  let threadDocFilter: { key: string; label: string; missing: boolean } | null = null;
  let currentThread = createEmptyThread({
    agent: selectedAgent,
    model: selectedModel,
    effort: selectedEffort,
    serviceTier: selectedServiceTier,
    docKey: currentDocKey,
    documentId: currentDocumentId,
  });
  /**
   * 아직 보내지 않은 채팅 — 스레드를 저장하지 않고 브리지 채팅도 이 스레드로 열지 않는다.
   * 처음 뜬 빈 채팅과 새 채팅 초안이 여기에 든다. 첫 메시지를 보낼 때 채팅을 연다.
   */
  let draftChat = true;
  /** 초안을 버리면 돌아갈 채팅 — 새 채팅을 누르기 전에 보던 채팅이다. */
  let draftReturnThreadId: string | null = null;
  /** 이 사이드바가 브리지 채팅을 마지막으로 연 스레드. 멈추면 null. */
  let bridgeThreadId: string | null = null;
  /** 사용자나 편집기가 채팅을 고른 뒤에는 시작 때의 마지막 채팅 복원이 덮어쓰지 않는다. */
  let chatChosen = false;
  /**
   * 시작 채팅 고르기(settleStartupChat)가 아직 스레드 저장소와 허브의 첫 답을 기다린다. 그동안
   * 처음 뜬 초안은 문서가 열려도 새 채팅을 시작하지 않는다 — 허브에 살아 있는 이 창의 채팅을
   * 새 시작 요청이 갈아 치우지 않게 한다.
   */
  let startupChatPending = true;
  /** 같은 문서의 다른 채팅이 편집 중이면 그 이유 — 이 채팅은 채팅 모드만 쓴다. */
  let chatModeLockReason: string | null = null;
  /** 잠금 때문에 채팅 모드로 옮기려 했던 채팅 — 허브가 거절해도 같은 채팅에서 되풀이하지 않는다. */
  let chatModeLockForcedThreadId: string | null = null;
  let chatModeLockCheckQueued = false;
  const threadComposerDrafts = new Map<string, { text: string; files: File[] }>();
  let assistantBuffer = '';
  let assistantRenderFrame: number | null = null;
  let pendingAssistantBubble: HTMLElement | null = null;
  const assistantBubbleSources = new WeakMap<HTMLElement, string>();
  let attachmentsSending = false;
  let threadsPanelOpen = false;
  let restoringLiveQuestion = false;
  let skillsPanelOpen = false;
  let settingsPanelOpen = false;
  let versionsPanelOpen = false;
  let deferredVersionsOpenTimer: number | null = null;
  /** 에이전트 집중 모드 — 스레드 레일과 대화 무대로 문서를 덮는다. */
  let fullscreen = false;
  let threadsRailCollapsed = readStoredThreadsRailCollapsed();
  let workspaceCompact = false;
  let compactThreadsRailOpen = false;
  let compactRailHoverOpen = false;
  let compactRailLastPointerX: number | null = null;
  let compactRailHoverOpenTimer: number | null = null;
  let compactRailHoverCloseTimer: number | null = null;
  let environmentPanelOpen = readStoredEnvironmentPanelOpen();
  let desktopEnvironmentPanelOpen = environmentPanelOpen;
  // 검토 drawer는 focus mode에 들어갈 때마다 닫힌 상태로 시작하며,
  // 환경 패널의 `변경 사항` 행을 눌렀을 때만 열린다.
  const turnChanges = new TurnChanges();
  let turnOwnerThreadId: string | null = null;
  let workingDiff: DiffItem[] = [];
  let compactChangesOpen = false;
  let changesRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let reviewColCollapsed = true;
  let planColCollapsed = true;
  let planMinimized = false;
  /** 기록에서 연 계획은 표시 전용이며 현재 계획 workflow 상태를 절대 나타내지 않는다. */
  let activePlanHistorical = false;
  let pendingReviewOpCount = 0;
  let railWidth = readStoredRailWidth();
  let reviewWidth = readStoredReviewWidth();
  // 살아 있는 세션의 권한이 우선이고, 새로 시작하는 경우에만 기본 모드의 프로필을 쓴다.
  let permissionProfile: PermissionProfile = bridge.getActiveAgent() !== null
    ? bridge.getPermissionProfile()
    : agentModeTarget(agentPrefs.defaultMode).permissionProfile;
  let skillCatalog: SkillCatalog = { rows: [] };
  let activeComposerSkill: CatalogRow | null = null;
  let templateCatalog: TemplateCatalog = { revision: 0, templates: [] };
  let activeTemplate: DocumentTemplate | null = null;
  let configHideTimer: number | null = null;
  let configPanelOpen = false;

  const initialWorkflowState: AgentWorkflowState = bridge.getWorkflowState();
  let chatWorkflow: AgentWorkflow = initialWorkflowState.workflow;
  let planningPhase: AgentPhase = initialWorkflowState.phase;
  let activePlan: StructuredPlan | null = initialWorkflowState.latestPlan;
  /** 서버가 현재 살아 있다고 말한 계획만 승인할 수 있다(기록 복원본은 읽기 전용). */
  let planApprovable = activePlan !== null && planningPhase === 'awaiting-approval';
  let planActionPending = false;
  let revisionPlanId: string | null = null;

  /** 실패 알림 — 턴마다 하나, 실패에 맞는 조치만. 다시 보낼 요청과 리셋 후 이어서 보내기도 여기서 기억한다. */
  const failureNotices = createFailureNoticeController({
    thread: () => currentThread,
    persist: () => persistCurrentThread(),
    append: (node) => withAutoScroll(() => appendConversation(node)),
    agentLabel: (agent) => AGENT_LABEL[agent],
    // 보낸 메시지가 턴을 기다리는 동안도 다시 시도는 막힌다 — 같은 요청이 두 번 나간다.
    isTurnRunning: () => agentWorking(),
    isConnected: () => connState === 'connected',
    reconnected: (agent) => !authFailedAgents.has(agent) && setupStatuses?.[agent]?.authenticated === true,
    openLogin: (agent) => {
      requestSettingsOpen('ai');
      settingsPanel.beginAgentConnect(agent, { reauth: true });
    },
    openSettings: () => requestSettingsOpen('ai'),
    restartSession: () => restartAgentSession(),
    resend: (retry) => resendFailedRequest(retry),
    ...(deps.failureResumeGraceMs !== undefined ? { resumeGraceMs: deps.failureResumeGraceMs } : {}),
  });

  let planHistory: StructuredPlan[] = initialWorkflowState.latestPlan ? [initialWorkflowState.latestPlan] : [];
  /** 채팅별 계획 기록/모드 — 목록에서 되돌아왔을 때 표시를 복원한다. */
  const planArchives = new Map<string, StructuredPlan[]>();
  const threadWorkflows = new Map<string, AgentWorkflow>();

  function startCurrentBridgeChat(force = false): void {
    // 초안은 첫 메시지를 보낼 때 연다 — 그 전의 선택은 이 사이드바에만 남는다.
    if (draftChat) return;
    // 새 채팅·스레드 전환(force)만 입력기를 잠근다. 모델/추론 강도만 바꿀 때는
    // 같은 대화를 다시 열 뿐이라 입력칸·피커가 비활성으로 깜빡이지 않게 둔다.
    bridgeThreadId = currentThread.id;
    bridge.setServiceTier(selectedServiceTier);
    if (force) chatStartPendingThreadId = currentThread.id;
    const history = serializeThreadMessagesForProviderHistory(currentThread.messages);
    bridge.startChat(selectedAgent, selectedModel, selectedEffort, force, permissionProfile, chatWorkflow,
      currentThread.id, currentThread.documentId, currentThread.docKey, history);
    if (force) updateComposer();
  }

  // ── DOM 구성 ──────────────────────────────────────────
  const root = document.createElement('aside');
  root.id = 'agent-sidebar';
  root.className = 'ag-root';
  root.dataset.agent = selectedAgent;

  const collapseTab = el('button', 'ag-collapse-tab');
  collapseTab.type = 'button';
  collapseTab.setAttribute('aria-label', '에이전트 사이드바 숨기기');
  collapseTab.setAttribute('aria-expanded', 'true');
  collapseTab.title = '에이전트 사이드바 숨기기';
  const rauIcon = el('span', 'ag-rau-icon');
  rauIcon.setAttribute('aria-hidden', 'true');
  collapseTab.appendChild(rauIcon);

  const resizeHandle = el('div', 'ag-resize-handle');
  resizeHandle.setAttribute('role', 'separator');
  resizeHandle.setAttribute('aria-label', '사이드바 너비 조절');
  resizeHandle.setAttribute('aria-orientation', 'vertical');
  resizeHandle.title = '드래그하여 너비 조절';
  resizeHandle.tabIndex = 0;

  let sidebarWidthMin = SIDEBAR_WIDTH_MIN_FALLBACK;
  let sidebarWidth = readStoredSidebarWidth(sidebarWidthMin);

  /** --ag-sidebar-width 를 읽는 요소들. 끄는 동안에는 이들에만 걸어 문서 전체 재스타일을 피한다. */
  const SIDEBAR_WIDTH_CONSUMERS = ['editor-area', 'agent-editing-frame', 'agent-editing-status'];

  function writeSidebarWidthVar(px: number): void {
    const value = `${px}px`;
    root.style.setProperty('--ag-root-width', value);
    // 편집 영역 쪽 변수는 페이지의 것이다 — 화면에 붙은 사이드바만 쓴다.
    if (!active) return;
    for (const id of SIDEBAR_WIDTH_CONSUMERS) {
      document.getElementById(id)?.style.setProperty('--ag-sidebar-width', value);
    }
    // 루트 값은 나중에 붙는 요소가 물려받을 기준값이다. 끄는 도중에는 프레임마다
    // 모든 요소가 다시 스타일을 타므로, 끌기가 끝날 때 한 번만 맞춘다.
    if (!widthDragging) document.documentElement.style.setProperty('--ag-sidebar-width', value);
  }

  function applySidebarWidth(width: number, opts?: { persist?: boolean; recenter?: boolean }): number {
    const previous = sidebarWidth;
    sidebarWidth = clampSidebarWidth(width, sidebarWidthMin);
    writeSidebarWidthVar(sidebarWidth);
    resizeHandle.setAttribute('aria-valuenow', String(sidebarWidth));
    resizeHandle.setAttribute('aria-valuemin', String(sidebarWidthMin));
    resizeHandle.setAttribute('aria-valuemax', String(maxSidebarWidth(sidebarWidthMin)));
    if (opts?.persist) persistSidebarWidth(sidebarWidth);
    // 전이 대기 중(펼침 커밋 전)에는 inset 이 아직 레이아웃에 없다.
    if (editorInsetApplied) {
      committedEditorInsetPx = effectiveEditorInset(true);
    }
    // 여닫는 도중 폭이 바뀌면(끌다가 다시 펼치기) 지금 위치·속도에서 새 폭으로 이어 간다.
    if (insetMotion && sidebarWidth !== previous) {
      if (insetMotion.drivesSidebar) startInsetRecenterLoop();
      else startInsetRecenterLoop({ instant: true });
    }
    if (opts?.recenter !== false) notifyInsetChanged();
    return sidebarWidth;
  }

  function notifyInsetChanged(): void {
    if (active) eventBus?.emit('viewport-inset-changed');
  }

  /** body.ag-sidebar-inset 이 켜졌을 때 편집 영역이 실제로 비켜 줄 폭 (CSS 규칙과 같은 조건). */
  function effectiveEditorInset(applied: boolean): number {
    if (!applied || fullscreen) return 0;
    if (window.matchMedia('(max-width: 767px)').matches) return 0;
    return sidebarWidth;
  }

  function commitEditorInset(applied: boolean): void {
    editorInsetApplied = applied;
    setPageClass('ag-sidebar-inset', applied);
    committedEditorInsetPx = effectiveEditorInset(applied);
  }

  /** 사이드바 판의 실제 폭(px). 좁은 화면에서는 CSS 가 화면 폭으로 묶는다. */
  function sidebarPaneWidth(): number {
    const viewport = Math.max(0, finiteOr(window.innerWidth, sidebarWidth));
    return window.matchMedia('(max-width: 767px)').matches
      ? Math.min(sidebarWidth, viewport)
      : sidebarWidth;
  }

  /** WAAPI 와 같은 시계(ms). 입력 프레임의 타임라인 시각을 써서 첫 프레임부터 움직인다. */
  function motionNow(): number {
    const timeline = Number(document.timeline?.currentTime);
    const wall = performance.now();
    return Number.isFinite(timeline) ? Math.max(timeline, wall - 1000 / 60) : wall;
  }

  function slowMotionConfig(): ReturnType<typeof springForDuration> {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const token = getComputedStyle(document.documentElement).getPropertyValue('--ag-dur-slow');
    return springForDuration(parseCssTimeMs(token, SIDEBAR_MOTION_DURATION_MS), {
      dpr: window.devicePixelRatio,
    });
  }

  function cancelInsetAnimations(): void {
    const motion = insetMotion;
    insetMotion = null;
    if (!motion) return;
    for (const animation of motion.animations) {
      animation.onfinish = null;
      animation.cancel();
    }
  }

  function clearInsetRecenterLoop(): void {
    cancelInsetAnimations();
    afterInsetSettle = null;
    setPageClass('ag-sidebar-animating', false);
  }

  /** 사이드바 뒤를 따르는 문서 층. 상태 알약은 편집 영역 오른쪽 끝을 따라 두 배 움직인다. */
  function insetLayers(): Array<{ element: HTMLElement; factor: number }> {
    const layers: Array<{ element: HTMLElement; factor: number }> = [];
    const scrollContent = document.getElementById('scroll-content');
    const hRuler = document.getElementById('h-ruler');
    const editingStatus = document.getElementById('agent-editing-status');
    if (scrollContent) layers.push({ element: scrollContent, factor: 1 });
    if (hRuler) layers.push({ element: hRuler, factor: 1 });
    if (editingStatus && !editingStatus.hidden) layers.push({ element: editingStatus, factor: 2 });
    return layers;
  }

  function settleInsetMotion(): void {
    const motion = insetMotion;
    // finish 이벤트는 같은 프레임의 페인트 전에 돈다. 커밋·재정렬과 transform 제거를
    // 한 번에 해 끝 프레임에서 용지가 튀지 않게 한다.
    setPageClass('ag-sidebar-animating', false);
    if (motion) {
      sidebarShownAtRest = motion.open;
      if (motion.deferCommit) commitEditorInset(motion.open);
    }
    notifyInsetChanged();
    cancelInsetAnimations();
    const after = afterInsetSettle;
    afterInsetSettle = null;
    after?.();
  }

  /**
   * 사이드바가 드러난 폭 vis 하나를 임계 감쇠 스프링으로 움직이고, 사이드바 transform 과
   * 문서 층 transform 을 모두 그 값에서 계산해 같은 startTime 의 WAAPI 로 건다. 두 쪽이
   * 한 값·한 시계를 쓰므로 어긋날 수 없다. 레이아웃(여백·가운데 정렬)은 한 번만 바꾼다.
   * - inset 이 줄면: 시작할 때 커밋하고 문서는 이전 화면 위치에서 제자리로 미끄러진다.
   * - inset 이 늘면(펼칠 때): 사이드바가 덮어 오는 동안 전체 폭을 유지하고 끝에서 커밋한다
   *   (시작에서 줄이면 사이드바가 닿기 전 빈 띠가 드러난다).
   * - 움직이는 도중 다시 부르면 지금 위치·속도에서 새 목표로 이어 간다.
   * - docFromVis: 사이드바는 제자리에 두고 문서만 이 폭에서 새 폭으로 옮긴다(폭 초기화).
   */
  function startInsetRecenterLoop(opts?: { instant?: boolean; docFromVis?: number }): void {
    const wantOpen = !root.classList.contains('ag-collapsed');
    const paneWidth = sidebarPaneWidth();
    const target = wantOpen ? paneWidth : 0;
    const now = motionNow();
    const running = insetMotion;
    const drivesSidebar = opts?.docFromVis === undefined;
    let state: SpringState;
    if (running && !running.drivesSidebar && drivesSidebar) {
      // 폭 초기화 중의 plan 값은 용지 쪽 폭이라 사이드바에 쓸 수 없다. 사이드바는
      // 제자리에서 출발하고, 용지에 남은 몇 px 는 새 슬라이드 아래에서 맞춰진다.
      state = { x: sidebarShownAtRest ? paneWidth : 0, v: 0 };
    } else if (running) {
      state = springStateAt(running.plan, now - running.startTime);
      // 새 폭이 좁아졌으면 드러난 폭도 그 안으로 묶는다.
      state = { x: clampFinite(state.x, 0, Math.max(paneWidth, running.paneWidth), 0), v: state.v };
    } else if (!drivesSidebar) {
      state = { x: clampFinite(opts?.docFromVis ?? target, 0, paneWidth * 4, target), v: 0 };
    } else {
      state = { x: sidebarShownAtRest ? paneWidth : 0, v: 0 };
    }
    cancelInsetAnimations();

    // 화면에서 내려간 사이드바는 움직이지 않고 끝 상태만 맞춘다(문서 층은 페이지의 것이다).
    const config = opts?.instant || fullscreen || !eventBus || !active ? null : slowMotionConfig();
    const plan = config ? planSpring(state, target, config) : null;
    const nextInset = effectiveEditorInset(wantOpen);
    if (!plan || plan.durationMs <= 0) {
      setPageClass('ag-sidebar-animating', false);
      sidebarShownAtRest = wantOpen;
      commitEditorInset(wantOpen);
      notifyInsetChanged();
      const after = afterInsetSettle;
      afterInsetSettle = null;
      after?.();
      return;
    }

    const deferCommit = nextInset > committedEditorInsetPx;
    setPageClass('ag-sidebar-animating', true);
    if (!deferCommit) {
      // 레이아웃은 지금 한 번 바꾸고, 문서는 이전 화면 위치에서 출발시킨다.
      commitEditorInset(wantOpen);
      notifyInsetChanged();
    }

    const samples = sampleSpring(plan);
    const docFollows = effectiveEditorInset(true) > 0;
    const committed = committedEditorInsetPx;
    const timing: KeyframeAnimationOptions = { duration: plan.durationMs, easing: 'linear', fill: 'both' };
    const animations: Animation[] = [];
    if (drivesSidebar) {
      animations.push(root.animate(
        samples.map(({ offset, value }) => ({ offset, transform: `translateX(${paneWidth - value}px)` })),
        timing,
      ));
    }
    for (const { element, factor } of insetLayers()) {
      const shifts = samples.map(({ value }) => factor * (committed - (docFollows ? value : 0)) / 2);
      if (shifts.every((shift) => Math.abs(shift) < 0.01)) continue;
      animations.push(element.animate(
        samples.map(({ offset }, i) => ({ offset, transform: `translateX(${shifts[i]}px)` })),
        timing,
      ));
    }
    if (!animations.length) {
      setPageClass('ag-sidebar-animating', false);
      sidebarShownAtRest = wantOpen;
      commitEditorInset(wantOpen);
      notifyInsetChanged();
      return;
    }
    // 모든 층을 같은 시각에 묶는다. 대기(pending) 상태로 두면 층마다 시작 프레임이 갈린다.
    for (const animation of animations) animation.startTime = now;
    const motion: InsetMotion = {
      plan, startTime: now, animations, paneWidth, open: wantOpen, deferCommit, drivesSidebar,
    };
    insetMotion = motion;
    animations[0].onfinish = () => {
      if (insetMotion !== motion) return;
      settleInsetMotion();
    };
  }

  function setCollapsed(collapsed: boolean, opts?: { recenter?: boolean }): void {
    // 접힌 사이드바 안의 시트는 보이지 않으므로 취소로 닫고, 포커스·키가 닿지 않게 한다.
    if (collapsed && active) dismissOpenSheets();
    root.inert = collapsed;
    root.classList.toggle('ag-collapsed', collapsed);
    setPageClass('ag-sidebar-open', !collapsed);
    const label = collapsed ? '에이전트 사이드바 펼치기' : '에이전트 사이드바 숨기기';
    collapseTab.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    collapseTab.setAttribute('aria-label', label);
    collapseTab.title = label;
    if (active) eventBus?.emit('agent-sidebar-visibility-changed', { open: !collapsed });
    startInsetRecenterLoop(opts?.recenter === false ? { instant: true } : undefined);
  }

  applySidebarWidth(sidebarWidth, { persist: false, recenter: false });

  const RESIZE_DRAG_THRESHOLD_PX = 4;
  /* Mail 의 분할선처럼 최솟값을 이만큼 넘겨 끌면 사이드바를 접는다. */
  const RESIZE_COLLAPSE_OVERSHOOT_PX = 72;
  let resizing = false;
  let resizeArmed = false;
  let resizeStartX = 0;
  let resizeStartWidth = sidebarWidth;
  /** 드래그 도중 접힌 상태 — 놓기 전에 돌아오면 다시 펼친다. */
  let resizeDragCollapsed = false;

  function clearResizeResumeTimer(): void {
    afterInsetSettle = null;
  }

  function detachResizeWindowListeners(): void {
    window.removeEventListener('pointermove', onResizePointerMove, true);
    window.removeEventListener('pointerup', endSidebarResize, true);
    window.removeEventListener('pointercancel', endSidebarResize, true);
  }

  function beginSidebarResize(startX: number): void {
    resizing = true;
    widthDragging = true;
    resizeArmed = false;
    resizeStartX = startX;
    resizeStartWidth = sidebarWidth;
    resizeDragCollapsed = false;
    setConfigPanelOpen(false);
    setPageClass('ag-sidebar-resizing', true);
    setPageClass('ag-sidebar-animating', true);
    window.addEventListener('pointermove', onResizePointerMove, true);
    window.addEventListener('pointerup', endSidebarResize, true);
    window.addEventListener('pointercancel', endSidebarResize, true);
  }

  function applyResizeMove(): void {
    resizeMoveRaf = null;
    if (!resizing || !resizeArmed) return;
    const target = resizeStartWidth + (resizeStartX - resizeMoveX);
    const overshoot = !fullscreen && target < sidebarWidthMin - RESIZE_COLLAPSE_OVERSHOOT_PX;
    if (overshoot !== resizeDragCollapsed) {
      resizeDragCollapsed = overshoot;
      clearResizeResumeTimer();
      // 접고 펴는 동안은 편집 영역 여백도 전이로 따라가야 한다 — 리사이즈 클래스를
      // 잠시 내리고, 다시 펼친 뒤 전이가 끝나면 즉시 추종으로 돌아간다.
      setPageClass('ag-sidebar-resizing', false);
      setCollapsed(overshoot);
      if (!overshoot) {
        // 다시 펼침 스프링이 멈추면 곧바로 폭 추종으로 돌아간다(시간 추측 타이머 없이).
        const resume = () => {
          if (resizing && !resizeDragCollapsed) {
            setPageClass('ag-sidebar-resizing', true);
            setPageClass('ag-sidebar-animating', true);
          }
        };
        if (insetMotion) afterInsetSettle = resume;
        else resume();
      }
    }
    if (resizeDragCollapsed) return;
    applySidebarWidth(target, { persist: false, recenter: false });
  }

  function onResizePointerMove(e: PointerEvent): void {
    if (!resizing) return;
    e.preventDefault();
    resizeMoveX = e.clientX;
    if (!resizeArmed) {
      if (Math.abs(resizeMoveX - resizeStartX) < RESIZE_DRAG_THRESHOLD_PX) return;
      resizeArmed = true;
    }
    // pointermove 는 프레임보다 잦다. 폭·용지 정렬은 한 프레임에 한 번만 한다.
    if (resizeMoveRaf !== null) return;
    resizeMoveRaf = requestAnimationFrame(applyResizeMove);
  }

  function endSidebarResize(): void {
    if (!resizing) return;
    if (resizeMoveRaf !== null) {
      cancelAnimationFrame(resizeMoveRaf);
      applyResizeMove();
    }
    resizing = false;
    widthDragging = false;
    resizeArmed = false;
    clearResizeResumeTimer();
    setPageClass('ag-sidebar-resizing', false);
    // 접힘 전이가 도는 중이면 ag-sidebar-animating 은 그 루프가 거둔다.
    if (insetMotion === null) setPageClass('ag-sidebar-animating', false);
    detachResizeWindowListeners();
    if (resizeDragCollapsed) {
      // 다시 펼칠 때는 끌기 전 폭으로 돌아온다.
      resizeDragCollapsed = false;
      applySidebarWidth(resizeStartWidth, { persist: true, recenter: false });
      return;
    }
    applySidebarWidth(sidebarWidth, { persist: true, recenter: true });
  }

  function onResizeHandlePointerDown(e: PointerEvent): void {
    if (root.classList.contains('ag-collapsed')) return;
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    beginSidebarResize(e.clientX);
    resizeArmed = true;
  }

  collapseTab.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (fullscreen) return;
    setCollapsed(!root.classList.contains('ag-collapsed'));
  });

  resizeHandle.addEventListener('pointerdown', onResizeHandlePointerDown);
  // 두 번 누르면 기본 폭으로 돌아간다.
  resizeHandle.addEventListener('dblclick', (e) => {
    if (root.classList.contains('ag-collapsed')) return;
    e.preventDefault();
    if (sidebarWidth === clampSidebarWidth(SIDEBAR_WIDTH_DEFAULT, sidebarWidthMin)) return;
    const fromVis = committedEditorInsetPx;
    applySidebarWidth(SIDEBAR_WIDTH_DEFAULT, { persist: true, recenter: false });
    startInsetRecenterLoop(fromVis > 0 ? { docFromVis: fromVis } : undefined);
  });
  resizeHandle.addEventListener('keydown', (e) => {
    if (root.classList.contains('ag-collapsed')) return;
    const step = e.shiftKey ? 32 : 16;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      applySidebarWidth(sidebarWidth + step, { persist: true, recenter: true });
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      applySidebarWidth(sidebarWidth - step, { persist: true, recenter: true });
    } else if (e.key === 'Home') {
      e.preventDefault();
      applySidebarWidth(sidebarWidthMin, { persist: true, recenter: true });
    } else if (e.key === 'End') {
      e.preventDefault();
      applySidebarWidth(maxSidebarWidth(sidebarWidthMin), { persist: true, recenter: true });
    }
  });

  /* 연결된 프로바이더만 입력기 메뉴에 표시한다. 설정 탭에서는 모두 연결할 수 있다. */
  const connectedProviders = new Set<AgentName>();

  const header = el('header', 'ag-header');
  const selectors = el('div', 'ag-selectors');

  // ── 프로바이더 피커 ───────────────────────────────────
  const providerWrap = el('div', 'ag-model ag-provider');
  const providerTrigger = el('button', 'ag-model-trigger');
  providerTrigger.type = 'button';
  providerTrigger.setAttribute('aria-expanded', 'false');
  providerTrigger.setAttribute('aria-controls', 'ag-config-panel');
  providerTrigger.setAttribute('aria-label', '프로바이더 선택');
  let providerIcon = createProviderIcon(selectedAgent);
  const providerName = el('span', 'ag-model-name', AGENT_LABEL[selectedAgent]);
  providerTrigger.append(providerIcon, providerName);

  const providerMenu = el('div', 'ag-model-menu');
  providerMenu.setAttribute('role', 'menu');
  providerMenu.setAttribute('aria-hidden', 'true');
  const providerItems = new Map<AgentName, HTMLButtonElement>();

  function selectAgent(agent: AgentName): void {
    if (isSelectionLocked()) return;
    setSelectedAgent(agent);
    selectedModel = resolveModelForAgent(agent, selectedModel);
    selectedEffort = resolveEffortForAgent(agent, selectedEffort, selectedModel);
    selectedServiceTier = resolveServiceTier(agent, selectedServiceTier);
    rebuildLlmMenu();
    rebuildEffortMenu();
    updateWorkspaceAgentContext();
    startCurrentBridgeChat();
    refreshSidebarWidthMin();
    providerTrigger.focus();
  }

  for (const agent of PROVIDER_ORDER) {
    const item = el('button', 'ag-model-item ag-provider-item');
    item.type = 'button';
    item.dataset.agent = agent;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', 'false');
    item.append(createProviderIcon(agent), document.createTextNode(AGENT_LABEL[agent]));
    item.addEventListener('click', () => selectAgent(agent));
    providerItems.set(agent, item);
    providerMenu.appendChild(item);
  }

  /** 연결된 항목만 키보드로 탐색한다. */
  function visibleProviderItems(): HTMLButtonElement[] {
    return PROVIDER_ORDER
      .map((name) => providerItems.get(name))
      .filter((item): item is HTMLButtonElement => !!item && !item.hidden);
  }

  function syncProviderMenu(): void {
    for (const [agent, item] of providerItems) item.hidden = !connectedProviders.has(agent);
    if (document.activeElement instanceof HTMLButtonElement
      && document.activeElement.hidden
      && providerMenu.contains(document.activeElement)) {
      (visibleProviderItems()[0] ?? providerTrigger).focus();
    }
  }

  syncProviderMenu();

  providerTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSelectionLocked()) return;
    setConfigPanelOpen(!configPanelOpen);
  });
  providerTrigger.addEventListener('keydown', (e) => {
    if (isSelectionLocked()) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setConfigPanelOpen(true);
      (visibleProviderItems().find(item => item.dataset.agent === selectedAgent)
        ?? visibleProviderItems()[0] ?? providerTrigger).focus();
    } else if (e.key === 'Escape') {
      if (configPanelOpen) e.preventDefault();
      setConfigPanelOpen(false);
    }
  });
  providerMenu.addEventListener('keydown', (e) => {
    const items = visibleProviderItems();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setConfigPanelOpen(false);
      providerTrigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(Math.max(current, 0) + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(Math.max(current, 0) - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  });

  providerWrap.append(providerTrigger);

  // ── 모델 피커 (프로바이더에 따라 옵션 교체) ──────────
  const llmWrap = el('div', 'ag-model ag-llm');
  const llmTrigger = el('button', 'ag-model-trigger ag-llm-trigger');
  llmTrigger.type = 'button';
  llmTrigger.setAttribute('aria-expanded', 'false');
  llmTrigger.setAttribute('aria-controls', 'ag-config-panel');
  llmTrigger.setAttribute('aria-label', '모델 선택');
  const llmName = el('span', 'ag-llm-name', labelForModel(selectedAgent, selectedModel));
  llmTrigger.append(llmName);

  const llmMenu = el('div', 'ag-model-menu ag-llm-menu');
  llmMenu.setAttribute('role', 'menu');
  llmMenu.setAttribute('aria-hidden', 'true');
  let llmItems = new Map<string, HTMLButtonElement>();

  function selectModel(modelId: string): void {
    if (isSelectionLocked()) return;
    selectedModel = resolveModelForAgent(selectedAgent, modelId);
    selectedEffort = resolveEffortForAgent(selectedAgent, selectedEffort, selectedModel);
    llmName.textContent = labelForModel(selectedAgent, selectedModel);
    for (const [id, item] of llmItems) {
      const active = id === selectedModel;
      item.classList.toggle('ag-active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    rebuildEffortMenu();
    updateWorkspaceAgentContext();
    startCurrentBridgeChat();
    refreshSidebarWidthMin();
    llmTrigger.focus();
  }

  function rebuildLlmMenu(): void {
    llmMenu.replaceChildren();
    llmItems = new Map();
    for (const group of modelGroupsForAgent(selectedAgent)) {
      // 라벨이 있는 모델 묶음은 머리글과 함께 그린다.
      if (group.label) llmMenu.appendChild(el('span', 'ag-llm-group-label', group.label));
      for (const opt of group.options) {
        // 이름 + 한 줄 설명 + 선택 표시. 설명은 카탈로그가 줄 때만 그린다.
        const item = el('button', 'ag-model-item ag-llm-item');
        const copy = el('span', 'ag-llm-item-copy');
        copy.append(el('span', 'ag-llm-item-name', opt.label));
        if (opt.description) copy.append(el('span', 'ag-llm-item-description', opt.description));
        const check = el('span', 'ag-llm-item-check');
        check.setAttribute('aria-hidden', 'true');
        check.append(createIcon('check'));
        item.append(copy, check);
        item.type = 'button';
        item.dataset.model = opt.id;
        item.title = opt.id;
        item.setAttribute('role', 'menuitemradio');
        const active = opt.id === selectedModel;
        item.setAttribute('aria-checked', active ? 'true' : 'false');
        item.classList.toggle('ag-active', active);
        item.addEventListener('click', () => selectModel(opt.id));
        llmItems.set(opt.id, item);
        llmMenu.appendChild(item);
      }
    }
    llmName.textContent = labelForModel(selectedAgent, selectedModel);
  }

  llmTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSelectionLocked()) return;
    setConfigPanelOpen(!configPanelOpen);
  });
  llmTrigger.addEventListener('keydown', (e) => {
    if (isSelectionLocked()) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setConfigPanelOpen(true);
      llmItems.get(selectedModel)?.focus();
    } else if (e.key === 'Escape') {
      if (configPanelOpen) e.preventDefault();
      setConfigPanelOpen(false);
    }
  });
  llmMenu.addEventListener('keydown', (e) => {
    const ids = [...llmItems.keys()];
    const items = ids.map((id) => llmItems.get(id)!);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      setConfigPanelOpen(false);
      llmTrigger.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(Math.max(current, 0) + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(Math.max(current, 0) - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    }
  });

  rebuildLlmMenu();
  llmWrap.append(llmTrigger);

  // ── Effort 피커 (프로바이더/모델이 지원하는 수준) ────
  const effortWrap = el('div', 'ag-model ag-effort');
  const effortTrigger = el('button', 'ag-model-trigger ag-effort-trigger');
  effortTrigger.type = 'button';
  effortTrigger.setAttribute('aria-expanded', 'false');
  effortTrigger.setAttribute('aria-controls', 'ag-config-panel');
  effortTrigger.setAttribute('aria-label', '추론 강도 선택');
  const effortName = el(
    'span',
    'ag-effort-name',
    labelForEffort(selectedAgent, selectedEffort, selectedModel),
  );
  const summaryCaret = createChevron('ag-summary-caret');
  effortTrigger.append(effortName, summaryCaret);

  // 설정 패널의 '추론' 묶음 — 슬라이더는 이 안에 들어가므로 강도 옵션이 없는
  // 프로바이더(cursor, opencode 등)에서는 트리거뿐 아니라 이 묶음도 함께 접어야 빈 칸이 남지 않는다.
  const effortGroup = el('div', 'ag-config-group');
  const effortSlider = createEffortSlider({
    ariaLabel: '추론 강도',
    onChange: (effortId) => selectEffort(effortId),
    // 드래그 중 지나가는 눈금을 요약 라벨에 미리 비춘다.
    onPreview: (effortId) => {
      effortName.textContent = labelForEffort(selectedAgent, effortId, selectedModel);
    },
  });
  effortGroup.append(el('span', 'ag-config-label', '추론'), effortSlider.root);

  function selectEffort(effortId: string): void {
    if (isSelectionLocked()) return;
    selectedEffort = resolveEffortForAgent(selectedAgent, effortId, selectedModel);
    effortName.textContent = labelForEffort(selectedAgent, selectedEffort, selectedModel);
    effortSlider.setValue(selectedEffort);
    startCurrentBridgeChat();
    updateWorkspaceAgentContext();
    refreshSidebarWidthMin();
  }

  function rebuildEffortMenu(): void {
    const options = effortsForAgent(selectedAgent, selectedModel);
    // 추론 강도를 받지 않는 모델(pi의 비추론 모델, cursor/opencode 전체)에서는
    // 트리거와 설정 패널의 '추론' 묶음을 함께 접는다.
    const noEfforts = options.length === 0;
    effortWrap.hidden = noEfforts;
    effortGroup.hidden = noEfforts;
    // 카탈로그는 강함 → 약함 — 슬라이더는 왼쪽이 약함이라 뒤집어 깐다.
    effortSlider.setOptions([...options].reverse(), selectedEffort);
    effortName.textContent = labelForEffort(selectedAgent, selectedEffort, selectedModel);
  }

  effortTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isSelectionLocked()) return;
    setConfigPanelOpen(!configPanelOpen);
  });
  effortTrigger.addEventListener('keydown', (e) => {
    if (isSelectionLocked()) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setConfigPanelOpen(true);
      effortSlider.root.focus();
    } else if (e.key === 'Escape') {
      if (configPanelOpen) e.preventDefault();
      setConfigPanelOpen(false);
    }
  });
  effortSlider.root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setConfigPanelOpen(false);
      effortTrigger.focus();
    }
  });

  rebuildEffortMenu();
  effortWrap.append(effortTrigger);

  const threadsBtn = el('button', 'ag-threads-btn');
  threadsBtn.type = 'button';
  threadsBtn.setAttribute('aria-label', '채팅 목록');
  threadsBtn.setAttribute('aria-expanded', 'false');
  threadsBtn.setAttribute('aria-controls', 'ag-threads-panel');
  threadsBtn.title = '채팅 목록';
  threadsBtn.appendChild(createColumnIcon());

  /* 에이전트 모드 칩 — 채팅·플랜·에이전트·전체 중 하나. 전환 절차는 requestMode 가 맡는다. */
  const modeMenu = createModeMenu((mode) => { void requestMode(mode); });

  const skillsBtn = el('button', 'ag-skills-btn', '스킬');
  skillsBtn.type = 'button';
  skillsBtn.setAttribute('aria-label', '스킬 라이브러리');
  skillsBtn.setAttribute('aria-expanded', 'false');
  skillsBtn.setAttribute('aria-controls', 'ag-skills-panel');

  /* 허브 연결 상태 — 헤더의 점 하나. 연결되면 사라지고, 누르면 한 줄 팝오버가 열린다.
     conn 은 스크린리더와 테스트가 읽는 상태 문구다. */
  const connDot = el('button', 'ag-conn-dot');
  connDot.type = 'button';
  connDot.setAttribute('aria-haspopup', 'dialog');
  connDot.setAttribute('aria-expanded', 'false');
  connDot.setAttribute('aria-controls', 'ag-conn-popover');
  const conn = el('span', 'ag-conn');
  conn.setAttribute('role', 'status');
  conn.setAttribute('aria-live', 'polite');
  connDot.append(conn);

  const takeoverBtn = el('button', 'ag-takeover-btn', '이 탭에서 연결');
  takeoverBtn.type = 'button';
  takeoverBtn.hidden = true;
  takeoverBtn.addEventListener('click', () => bridge.takeOverConnection());

  const documentContext = el('div', 'ag-document-context');
  const documentName = el('span', 'ag-document-name', '문서 없음');
  const selectionContext = el('span', 'ag-selection-context', '선택 없음');
  documentContext.append(documentName, selectionContext);

  function isRenaming(target: HTMLElement): boolean {
    return target.querySelector('.inline-rename-input') !== null;
  }

  /** 문서 이름을 두 번 눌러 그 자리에서 바꾼다. 파일이 있으면 디스크의 파일 이름도 바뀐다. */
  function bindDocumentRename(target: HTMLElement): void {
    const rename = deps.renameDocument;
    if (!rename) return;
    target.classList.add('ag-renamable');
    target.addEventListener('dblclick', (event) => {
      const name = getDocumentContext?.()?.documentName;
      if (!name) return;
      event.preventDefault();
      beginInlineRename(target, {
        value: name,
        label: '문서 이름',
        selectBaseName: true,
        maxLength: 255,
        commit: async (next) => {
          const renamed = await rename(next);
          // 줄임 표시와 다른 자리의 이름은 입력 칸이 걷힌 뒤 다시 그린다.
          window.setTimeout(updateDocumentContext, 0);
          return renamed;
        },
      });
    });
  }
  bindDocumentRename(documentName);

  const headerActions = el('div', 'ag-header-actions');
  threadsBtn.classList.add('ag-header-icon-btn');

  const agentUndoBtn = el('button', 'ag-header-icon-btn ag-agent-undo-btn');
  agentUndoBtn.type = 'button';
  agentUndoBtn.hidden = true;
  agentUndoBtn.setAttribute('aria-label', '승인한 변경 되돌리기');
  agentUndoBtn.title = '승인한 변경 되돌리기';
  agentUndoBtn.appendChild(createIcon('undo'));
  agentUndoBtn.addEventListener('click', undoLatestAgentTurn);

  // 콘솔 펼치기 — 사이드바 폭에서는 diff 를 읽을 수 없어 전체 화면으로 넘긴다.
  const fullscreenBtn = el('button', 'ag-header-icon-btn ag-fullscreen-btn');
  fullscreenBtn.type = 'button';
  fullscreenBtn.setAttribute('aria-pressed', 'false');
  let fullscreenIcon = createIcon('expand');
  fullscreenBtn.appendChild(fullscreenIcon);
  fullscreenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    setFullscreen(!fullscreen);
  });

  // 설정 — 연결/기본값/사용량이 사는 페이지. 헤더 아이콘 한 자리만 쓴다.
  const settingsBtn = el('button', 'ag-header-icon-btn ag-settings-btn');
  settingsBtn.type = 'button';
  settingsBtn.setAttribute('aria-label', '설정');
  settingsBtn.setAttribute('aria-expanded', 'false');
  settingsBtn.setAttribute('aria-controls', 'ag-settings-panel');
  settingsBtn.title = '설정';
  settingsBtn.appendChild(createIcon('gear'));
  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    requestSettingsOpen();
  });

  const versionsBtn = el('button', 'ag-header-icon-btn ag-versions-btn');
  versionsBtn.type = 'button';
  versionsBtn.setAttribute('aria-label', '버전');
  versionsBtn.setAttribute('aria-expanded', 'false');
  versionsBtn.setAttribute('aria-controls', 'ag-versions-panel');
  versionsBtn.title = '버전';
  versionsBtn.appendChild(createIcon('changes'));
  // 커밋 전 변경 수 — 아이콘 오른쪽 위의 작은 숫자.
  const versionsBadge = el('span', 'ag-versions-badge');
  versionsBadge.setAttribute('aria-hidden', 'true');
  versionsBadge.hidden = true;
  versionsBtn.appendChild(versionsBadge);
  versionsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openConfiguredVersionControl();
  });
  // pane 액션은 문서 맥락 주변의 고정된 헤더 위치를 유지한다.
  headerActions.append(connDot, takeoverBtn, agentUndoBtn, versionsBtn, threadsBtn, settingsBtn);

  selectors.append(providerWrap, llmWrap, effortWrap);
  const modelSummary = el('div', 'ag-model-summary');

  const configPanel = el('div', 'ag-config-panel');
  configPanel.id = 'ag-config-panel';
  configPanel.hidden = true;
  configPanel.setAttribute('role', 'group');
  configPanel.setAttribute('aria-label', '에이전트 설정');
  configPanel.setAttribute('aria-hidden', 'true');
  const configPanelInner = el('div', 'ag-config-panel-inner');
  const providerGroup = el('div', 'ag-config-group');
  providerGroup.append(el('span', 'ag-config-label', '에이전트'), providerMenu);
  const llmGroup = el('div', 'ag-config-group');
  llmGroup.append(el('span', 'ag-config-label', '모델'), llmMenu);
  configPanelInner.append(providerGroup, llmGroup, effortGroup);
  configPanel.append(configPanelInner);

  const contextRow = el('div', 'ag-context-row');
  contextRow.append(documentContext);

  modelSummary.append(fullscreenBtn, contextRow, headerActions);
  header.append(modelSummary);

  function updateDocumentContext(): void {
    const context = getDocumentContext?.();
    const currentDocumentName = context?.documentName || '문서 없음';
    // 이름을 고치는 중인 칸은 다시 그리지 않는다 (입력 중인 글자가 사라진다).
    if (!isRenaming(documentName)) {
      setMiddleTruncatedText(documentName, currentDocumentName, context?.documentName || '');
    }
    selectionContext.textContent = context?.selectionLabel || '선택 없음';
    if (!isRenaming(workspaceDocumentName)) workspaceDocumentName.textContent = currentDocumentName;
    workspaceDocumentName.title = context?.documentName || '';
    focusGreeting.setDocumentName(context?.documentName || null);
    updateEnvironmentFilename(currentDocumentName);
    const nextKey = context?.documentName ?? null;
    const nextDocumentId = context?.documentId ?? null;
    if (nextKey !== currentDocKey || nextDocumentId !== currentDocumentId) {
      handleDocumentSwitch(nextKey, nextDocumentId);
    }
  }

  /** 스레드 목록이 지금 화면에 있는가 — 사이드바에선 패널일 때만,
      전체 화면에선 레일이 접혀 있지 않으면 항상 보인다. 내려간 사이드바는
      다시 붙을 때 한 번에 그린다. */
  function threadsListVisible(): boolean {
    return active && (threadsPanelOpen || (fullscreen && !threadsRailCollapsed));
  }

  /**
   * 문서가 바뀌면 현재 채팅을 끝내고 새 문서용 채팅을 연다. 메시지가
   * 있는 채팅은 원래 문서에 남고, 빈 채팅은 저장되지 않은 채 사라진다.
   */
  function handleDocumentSwitch(nextKey: string | null, nextDocumentId: string | null): void {
    const sameIdentity = Boolean(
      nextDocumentId && currentDocumentId && nextDocumentId === currentDocumentId,
    );
    if (sameIdentity) {
      // 첫 저장으로 파일명만 바뀐 경우 — 현재 문서의 채팅만 새 이름을 따른다.
      const activeThreadMatchesDocument = readOnlyDocLabel === null
        && threadMatchesDocument(currentThread, currentDocumentId, currentDocKey);
      currentDocKey = nextKey;
      currentDocumentId = nextDocumentId;
      if (activeThreadMatchesDocument) {
        currentThread.docKey = nextKey;
        currentThread.documentId = nextDocumentId;
        persistCurrentThread();
      }
      referenceLibrary.contextChanged();
      rebuildThreadsList();
      return;
    }
    currentDocKey = nextKey;
    currentDocumentId = nextDocumentId;
    // 채팅을 따라 옮겨 온 문서면 그 채팅을 잇고, 아니면 새 채팅을 연다.
    const followed = pendingThreadSwitch ? getThread(pendingThreadSwitch.threadId) : null;
    pendingThreadSwitch = null;
    if (followed && threadMatchesDocument(followed, nextDocumentId, nextKey)) {
      openThread(followed.id);
    } else if (!followed && adoptLiveChatForDocument(nextDocumentId, nextKey)) {
      // 새로고침 전부터 허브에서 돌던 이 문서의 채팅을 다시 시작하지 않고 이었다.
    } else if (!followed && startupChatPending && draftChat && !chatChosen) {
      // 시작 채팅은 허브의 첫 답을 본 뒤 이 문서 기준으로 고른다 — 지금 새 채팅을 열면
      // 허브에 살아 있는 이 창의 채팅을 시작 요청이 갈아 치운다.
      retargetStartupDraft();
    } else {
      startNewChat({ silent: true });
    }
    rebuildThreadsList();
  }

  /**
   * 새로고침 뒤 아직 붙이지 않은 허브의 채팅(문서가 늦게 열린 경우)이 이 문서의 것이면 그 채팅을
   * 연다. 데스크톱 실행 파일이나 문서 ID 를 지키는 자동 저장 복원이 시작 채팅 고르기 뒤에 도착할 때다.
   */
  function adoptLiveChatForDocument(documentId: string | null, docKey: string | null): boolean {
    if (!draftChat || bridgeThreadId !== null) return false;
    const live = bridge.getHubChat();
    const liveThread = live ? getThread(live.threadId) : null;
    if (!liveThread || !threadMatchesDocument(liveThread, documentId, docKey)) return false;
    openThread(liveThread.id, { routed: true });
    return currentThread.id === liveThread.id;
  }

  /** 아직 저장되지 않은 시작 초안을 새로 열린 문서에 맞춘다. */
  function retargetStartupDraft(): void {
    currentThread.docKey = currentDocKey;
    currentThread.documentId = currentDocumentId;
    referenceLibrary.contextChanged();
    enforceChatModeLock();
    updateWorkspaceChatTitle();
    updateComposer();
  }

  function setConfigPanelOpen(open: boolean): void {
    if (open && !configPanelOpen) collapseExpandedSurfaces('config');
    configPanelOpen = open;
    if (configHideTimer !== null) {
      window.clearTimeout(configHideTimer);
      configHideTimer = null;
    }
    if (open) {
      configPanel.hidden = false;
      // Ensure the collapsed grid is painted before expanding it.
      void configPanel.offsetHeight;
      configPanel.classList.add('ag-open');
    } else {
      configPanel.classList.remove('ag-open');
      configHideTimer = window.setTimeout(() => {
        if (!configPanelOpen) configPanel.hidden = true;
        configHideTimer = null;
      }, 240);
    }
    configPanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    composerMeta.classList.toggle('ag-expanded', open);
    for (const trigger of [providerTrigger, llmTrigger, effortTrigger]) {
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    for (const menu of [providerMenu, llmMenu]) {
      menu.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
  }

  const onDocPointerDown = (e: PointerEvent) => {
    if (!active) return;
    const t = e.target as Node;
    if (!composer.contains(t)) setConfigPanelOpen(false);
  };
  document.addEventListener('pointerdown', onDocPointerDown);

  /* Esc 로 전체 화면을 접는다. 설정 패널이 열려 있으면 그쪽이 먼저
     닫히고, 입력 중 IME 조합은 가로채지 않는다. */
  const onDocKeyDown = (e: KeyboardEvent) => {
    if (!active || e.key !== 'Escape' || !fullscreen) return;
    // 슬래시 메뉴·팝오버처럼 먼저 Esc 를 받은 쪽이 있으면 모드는 그대로 둔다.
    if (e.isComposing || e.defaultPrevented) return;
    if (configPanelOpen) {
      setConfigPanelOpen(false);
      e.preventDefault();
      return;
    }
    if (isCompactWorkspace() && compactThreadsRailOpen) {
      setCompactThreadsRailOpen(false);
      workspaceThreadsBtn.focus();
      e.preventDefault();
      return;
    }
    if (isCompactWorkspace() && environmentPanelOpen) {
      setEnvironmentPanelOpen(false, { persist: false });
      environmentToggle.focus();
      e.preventDefault();
      return;
    }
    if (root.classList.contains('ag-detail-drawer-open')) {
      if (root.classList.contains('ag-plan-drawer-open')) setPlanColCollapsed(true);
      else setReviewColCollapsed(true);
      environmentToggle.focus();
      e.preventDefault();
      return;
    }
    setFullscreen(false);
    e.preventDefault();
  };
  document.addEventListener('keydown', onDocKeyDown);

  /* 에이전트 명령 — 네이티브 메뉴(rhwp:agent-command)와 같은 동작을
     macOS 에서는 ⌃⌘S(사이드바 보이기/숨기기)·⌃⌘J(집중 모드)로도 연다.
     Windows 의 Ctrl+Alt 는 AltGr 문자 입력과 겹쳐 키는 두지 않는다. */
  function toggleAgentSidebarVisibility(): void {
    if (fullscreen) {
      setFullscreen(false, { then: () => setCollapsed(true) });
      return;
    }
    setCollapsed(!root.classList.contains('ag-collapsed'));
  }

  function toggleFocusChat(): void {
    if (fullscreen) {
      setFullscreen(false);
      return;
    }
    setFullscreen(true, { then: () => input.focus({ preventScroll: true }) });
  }

  const onAgentCommand = (event: Event) => {
    // 메뉴 명령은 화면에 붙은 문서의 사이드바만 받는다.
    if (!active) return;
    const command = (event as CustomEvent<{ command?: unknown }>).detail?.command;
    if (command === 'toggle-sidebar') toggleAgentSidebarVisibility();
    else if (command === 'toggle-focus-chat') toggleFocusChat();
  };
  window.addEventListener('rhwp:agent-command', onAgentCommand);

  const isMacPlatform = detectPlatformKind() === 'mac';
  /** 텍스트를 입력하는 자리. 집중 모드에서는 가려진 문서 입력기는 치지 않는다. */
  function focusOwnsText(target: Element | null): boolean {
    if (!target) return false;
    if (fullscreen && target.closest('[data-rhwp-editor-input]')) return false;
    return Boolean(target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ));
  }

  // 캡처 단계에서 받아 문서 단축키·입력기 처리보다 먼저 가져간다.
  const onAgentShortcutKeyDown = (e: KeyboardEvent) => {
    if (!active || e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
    if (isMacPlatform && e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey
      && (e.code === 'KeyS' || e.code === 'KeyJ')) {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      if (e.code === 'KeyS') toggleAgentSidebarVisibility();
      else toggleFocusChat();
      return;
    }
    // ⌘↑ / ⌘↓ — 대화의 처음·최신으로. 입력 칸 안에서는 캐럿 이동을 그대로 둔다.
    const jump = isMacPlatform
      ? e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      : false;
    if (!jump || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    if (root.classList.contains('ag-collapsed') || !chatPage.isConnected) return;
    const target = document.activeElement;
    const inConversation = fullscreen || (target instanceof Element && root.contains(target));
    if (!inConversation || focusOwnsText(target)) return;
    if (['ag-threads-open', 'ag-skills-open', 'ag-settings-open', 'ag-versions-open']
      .some((name) => root.classList.contains(name))) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'ArrowUp') scrollConversationToTop();
    else scrollConversationToLatest();
  };
  window.addEventListener('keydown', onAgentShortcutKeyDown, true);

  const stage = el('div', 'ag-stage');

  /* 집중 모드는 사이드바를 늘린 화면이 아니라 독립된 작업 공간이다.
     이 bar는 viewport 전체를 가로지르며 pane 토글, 문서 맥락,
     대화 제목, 실행 맥락과 종료 동작을 한 축에 고정한다. */
  const workspaceBar = el('header', 'ag-workspace-bar');
  const workspaceDrawerScrim = el('button', 'ag-workspace-drawer-scrim');
  workspaceDrawerScrim.type = 'button';
  workspaceDrawerScrim.tabIndex = -1;
  workspaceDrawerScrim.setAttribute('aria-label', '열린 패널 닫기');
  const compactRailHoverTarget = el('div', 'ag-compact-rail-hover-target');
  compactRailHoverTarget.setAttribute('aria-hidden', 'true');
  const workspaceLeading = el('div', 'ag-workspace-leading');
  const workspaceThreadsBtn = el('button', 'ag-workspace-icon-btn ag-workspace-threads-btn');
  workspaceThreadsBtn.type = 'button';
  workspaceThreadsBtn.setAttribute('aria-controls', 'ag-threads-panel');
  workspaceThreadsBtn.setAttribute('aria-expanded', 'true');
  workspaceThreadsBtn.setAttribute('aria-label', '대화 목록 접기');
  workspaceThreadsBtn.title = '대화 목록 접기';
  workspaceThreadsBtn.appendChild(createColumnIcon());
  const workspaceSettingsBack = el('button', 'ag-workspace-icon-btn ag-workspace-settings-back');
  workspaceSettingsBack.type = 'button';
  workspaceSettingsBack.setAttribute('aria-label', '대화로 돌아가기');
  workspaceSettingsBack.title = '대화로 돌아가기';
  workspaceSettingsBack.appendChild(createIcon('close'));
  // 레일 머리의 워드마크 — 편집기 도구 모음의 하마 마크와 제품 이름. 누르는 동작 없이
  // 창 끌기 영역에 남고, 레일이 접히거나 덮개가 되면 레일과 함께 빠진다.
  const workspaceBrand = el('span', 'ag-workspace-brand');
  const workspaceBrandMark = el('span', 'ag-rau-icon ag-workspace-brand-mark');
  workspaceBrandMark.setAttribute('aria-hidden', 'true');
  const workspaceBrandLockup = el('span', 'ag-workspace-brand-lockup');
  workspaceBrandLockup.append(workspaceBrandMark, el('span', 'ag-workspace-brand-name', 'Rauhwpx'));
  workspaceBrand.appendChild(workspaceBrandLockup);

  // 제목 줄 — 채팅 이름과 문서 이름을 한 줄에 나란히 둔다. 레일이 열려 있으면
  // 대화 면의 왼쪽 끝에, 접히면 레일 토글 바로 뒤에 선다.
  const workspaceDocumentContext = el('div', 'ag-workspace-document-context');
  const workspaceChatTitle = el('span', 'ag-workspace-chat-title', '새 채팅');
  const workspaceTitleSeparator = el('span', 'ag-workspace-title-sep', '/');
  workspaceTitleSeparator.setAttribute('aria-hidden', 'true');
  const workspaceDocumentName = el('span', 'ag-workspace-document-name', '문서 없음');
  workspaceDocumentContext.append(workspaceChatTitle, workspaceTitleSeparator, workspaceDocumentName);
  workspaceLeading.append(workspaceSettingsBack, workspaceThreadsBtn, workspaceBrand);

  function updateWorkspaceChatTitle(): void {
    if (isRenaming(workspaceChatTitle)) return;
    const title = currentThread.title || '새 채팅';
    workspaceChatTitle.textContent = title;
    workspaceChatTitle.title = title;
  }
  updateWorkspaceChatTitle();

  // 집중 화면 제목 줄: 채팅 이름과 문서 이름을 두 번 눌러 그 자리에서 바꾼다.
  workspaceChatTitle.classList.add('ag-renamable');
  workspaceChatTitle.addEventListener('dblclick', (event) => {
    event.preventDefault();
    beginInlineRename(workspaceChatTitle, {
      value: currentThread.title || '새 채팅',
      label: '채팅 이름',
      maxLength: 48,
      commit: (next) => {
        if (draftChat || currentThread.messages.length === 0) {
          // 초안은 아직 저장되지 않는다. 첫 메시지를 보낼 때 이 이름으로 만들어진다.
          currentThread.title = next.replace(/\s+/g, ' ').slice(0, 48);
        } else {
          const renamed = renameThread(currentThread.id, next);
          if (!renamed) return null;
          currentThread.title = renamed.title;
        }
        currentThread.titlePinned = true;
        window.setTimeout(() => {
          updateWorkspaceChatTitle();
          if (threadsListVisible()) rebuildThreadsList();
        }, 0);
        return currentThread.title;
      },
    });
  });
  bindDocumentRename(workspaceDocumentName);

  // 대화 화면에서는 제목을 비운다 — 대화 위에 '대화'라고 적는 것은 정보가 없다.
  const workspaceTitle = el('div', 'ag-workspace-title');

  function rememberThreadComposerDraft(): void {
    // 질문의 직접 입력이 입력기를 빌렸으면 먼저 돌려받는다 — 답은 질문 초안에 남고,
    // 입력기에는 이 채팅에서 쓰던 글이 돌아와 그 글이 초안으로 저장된다. 그러지 않으면
    // 질문이 나중에 끝날 때 이 채팅의 글이 그때 보이는 다른 채팅의 입력기에 쓰인다.
    questionController.releaseComposer();
    if (readOnlyDocLabel !== null) return;
    const files = referenceLibrary.snapshotDraftFiles();
    if (input.value || files.length) threadComposerDrafts.set(currentThread.id, { text: input.value, files });
    else threadComposerDrafts.delete(currentThread.id);
  }

  function restoreThreadComposerDraft(): void {
    const draft = threadComposerDrafts.get(currentThread.id);
    input.value = draft?.text ?? '';
    if (draft?.files.length) referenceLibrary.stageDraftFiles(draft.files);
    // 이 채팅의 질문이 직접 입력 중이었으면 되살린 초안을 맡기고 답을 다시 보인다.
    questionController.reclaimComposer();
    resizeComposerInput();
  }

  const workspaceTrailing = el('div', 'ag-workspace-trailing');
  const workspaceAgentContext = el(
    'span',
    'ag-workspace-agent-context',
    `${AGENT_LABEL[selectedAgent]} · ${labelForModel(selectedAgent, selectedModel)}`,
  );
  const environmentWrap = el('div', 'ag-environment-wrap');
  const environmentToggle = el('button', 'ag-workspace-icon-btn ag-environment-toggle');
  environmentToggle.type = 'button';
  environmentToggle.setAttribute('aria-controls', 'ag-environment-panel');
  environmentToggle.appendChild(createIcon('environment'));

  const environmentPanel = el('section', 'ag-environment-panel');
  environmentPanel.id = 'ag-environment-panel';
  environmentPanel.setAttribute('aria-labelledby', 'ag-environment-title');
  const environmentTitle = el('h2', 'ag-environment-title', '환경');
  environmentTitle.id = 'ag-environment-title';

  const environmentFileRow = el('div', 'ag-environment-file-row');
  environmentFileRow.tabIndex = 0;
  environmentFileRow.appendChild(createIcon('document'));
  const environmentFilenameViewport = el('span', 'ag-environment-filename-viewport');
  const environmentFilenameTrack = el('span', 'ag-environment-filename-track', '문서 없음');
  environmentFilenameViewport.appendChild(environmentFilenameTrack);
  environmentFileRow.appendChild(environmentFilenameViewport);

  const environmentPlanSection = el('section', 'ag-environment-section ag-environment-plan-section');
  const environmentPlan = el('button', 'ag-environment-plan');
  environmentPlan.type = 'button';
  environmentPlan.setAttribute('aria-controls', 'ag-plan-column');
  environmentPlan.setAttribute('aria-expanded', 'false');
  environmentPlan.appendChild(createIcon('plan'));
  const environmentPlanCopy = el('span', 'ag-environment-plan-copy');
  const environmentPlanLabel = el('span', 'ag-environment-plan-label', '계획');
  const environmentPlanTitle = el('span', 'ag-environment-plan-title');
  environmentPlanCopy.append(environmentPlanLabel, environmentPlanTitle);
  const environmentPlanStatus = el('span', 'ag-environment-plan-status', '없음');
  const environmentPlanChevron = createChevron('ag-environment-plan-chevron');
  environmentPlan.append(environmentPlanCopy, environmentPlanStatus, environmentPlanChevron);
  environmentPlanSection.appendChild(environmentPlan);

  const environmentChangesSection = el('section', 'ag-environment-section ag-environment-changes-section');
  const environmentChanges = el('button', 'ag-environment-changes');
  environmentChanges.type = 'button';
  environmentChanges.setAttribute('aria-controls', 'ag-review-column');
  environmentChanges.setAttribute('aria-expanded', 'false');
  environmentChanges.appendChild(createIcon('changes'));
  const environmentChangesLabel = el('span', 'ag-environment-changes-label', '변경 사항');
  const environmentDiffSummary = el('span', 'ag-environment-diff-summary');
  const environmentAdditions = el('span', 'ag-environment-additions');
  const environmentDeletions = el('span', 'ag-environment-deletions');
  const environmentDiffNeutral = el('span', 'ag-environment-diff-neutral', '변경 없음');
  const environmentChangesChevron = createChevron('ag-environment-changes-chevron');
  environmentDiffSummary.append(environmentAdditions, environmentDeletions, environmentDiffNeutral);
  environmentChanges.append(environmentChangesLabel, environmentDiffSummary, environmentChangesChevron);
  environmentChangesSection.appendChild(environmentChanges);

  // TODO: 파일 첨부나 대화 브랜치 기능이 생기면 해당 source/branch 상태를 이 환경 패널에 표시한다.
  environmentPanel.append(
    environmentTitle,
    environmentFileRow,
    environmentPlanSection,
    environmentChangesSection,
  );
  environmentWrap.append(environmentToggle, environmentPanel);

  const workspaceExitBtn = el('button', 'ag-workspace-exit-btn');
  workspaceExitBtn.type = 'button';
  workspaceExitBtn.setAttribute('aria-label', '문서 편집기로 돌아가기');
  workspaceExitBtn.title = '문서 편집기로 돌아가기 (Esc)';
  workspaceExitBtn.append(createIcon('contract'), el('span', 'ag-workspace-exit-label', '편집기로 돌아가기'));
  const workspaceSettingsBtn = el('button', 'ag-workspace-icon-btn ag-workspace-settings-btn');
  workspaceSettingsBtn.type = 'button';
  workspaceSettingsBtn.setAttribute('aria-label', '설정');
  workspaceSettingsBtn.setAttribute('aria-controls', 'ag-settings-panel');
  workspaceSettingsBtn.setAttribute('aria-expanded', 'false');
  workspaceSettingsBtn.title = '설정';
  workspaceSettingsBtn.appendChild(createIcon('gear'));
  workspaceTrailing.append(workspaceAgentContext, environmentWrap, workspaceSettingsBtn, workspaceExitBtn);
  workspaceBar.append(workspaceLeading, workspaceTitle, workspaceDocumentContext, workspaceTrailing);

  // 전역 설정이 꺼져 있어도 이 문서에 버전 기록이 있으면(예: 자동 저장본 복구) 버전 창을 연다.
  const versionsReachable = (): boolean => (
    userSettings.getUseHancomGit() || versionController?.getState().enabled === true
  );
  const applyHancomGitVisibility = (): void => {
    const reachable = versionsReachable();
    versionsBtn.hidden = !reachable;
    if (!reachable && versionsPanelOpen) closeVersionsPage();
  };
  applyHancomGitVisibility();
  const unsubscribeHancomGitSetting = userSettings.subscribeUseHancomGit(applyHancomGitVisibility);
  const unsubscribeVersionState = versionController?.subscribe(applyHancomGitVisibility) ?? (() => {});
  const unsubscribeHancomGitVisibility = (): void => {
    unsubscribeHancomGitSetting();
    unsubscribeVersionState();
  };

  function updateEnvironmentFilename(name: string): void {
    // 긴 이름은 가운데를 줄여 확장자·버전 표기를 남긴다. 전체 이름은 행 title 이 맡는다.
    setMiddleTruncatedText(environmentFilenameTrack, name, null);
    environmentFileRow.title = name === '문서 없음' ? '' : name;
    environmentFileRow.setAttribute('aria-label', `현재 문서: ${name}`);
  }

  function applyEnvironmentPanelState(): void {
    environmentPanel.classList.toggle('ag-open', environmentPanelOpen);
    environmentPanel.setAttribute('aria-hidden', environmentPanelOpen ? 'false' : 'true');
    environmentPanel.inert = !environmentPanelOpen;
    environmentToggle.classList.toggle('ag-active', environmentPanelOpen);
    root.classList.toggle('ag-environment-open', fullscreen && environmentPanelOpen);
    environmentToggle.setAttribute('aria-expanded', environmentPanelOpen ? 'true' : 'false');
    environmentToggle.setAttribute('aria-label', environmentPanelOpen ? '환경 패널 닫기' : '환경 패널 열기');
    environmentToggle.title = environmentPanelOpen ? '환경 패널 닫기' : '환경 패널 열기';
  }

  function setEnvironmentPanelOpen(open: boolean, opts?: { persist?: boolean }): void {
    environmentPanelOpen = open;
    if (opts?.persist !== false) {
      desktopEnvironmentPanelOpen = open;
      persistEnvironmentPanelOpen(open);
    }
    applyEnvironmentPanelState();
  }

  function updateWorkspaceAgentContext(): void {
    workspaceAgentContext.textContent =
      `${AGENT_LABEL[selectedAgent]} · ${labelForModel(selectedAgent, selectedModel)}`;
  }

  workspaceThreadsBtn.addEventListener('click', () => {
    if (isCompactWorkspace()) {
      compactRailHoverOpen = false;
      setCompactThreadsRailOpen(!compactThreadsRailOpen);
      return;
    }
    setThreadsRailCollapsed(!threadsRailCollapsed);
  });
  workspaceSettingsBack.addEventListener('click', () => void requestSettingsClose(workspaceSettingsBtn));
  workspaceSettingsBtn.addEventListener('click', () => {
    if (settingsPanelOpen) return;
    requestSettingsOpen();
  });
  environmentToggle.addEventListener('click', () => {
    const nextOpen = !environmentPanelOpen;
    setEnvironmentPanelOpen(nextOpen, { persist: !isCompactWorkspace() });
    if (nextOpen && isCompactWorkspace()) {
      window.requestAnimationFrame(() => environmentFileRow.focus({ preventScroll: true }));
    }
  });
  environmentChanges.addEventListener('click', () => {
    setReviewColCollapsed(false);
    setEnvironmentPanelOpen(false, { persist: !isCompactWorkspace() });
    // drawer 가 열리는 도중의 focus 가 조상 스크롤을 밀어 판 전체를
    // 옮기지 않도록 스크롤 없이 초점만 옮긴다.
    window.requestAnimationFrame(() => reviewColumnClose.focus({ preventScroll: true }));
  });
  environmentPlan.addEventListener('click', () => {
    if (!activePlan) return;
    setPlanColCollapsed(false);
    setEnvironmentPanelOpen(false, { persist: !isCompactWorkspace() });
    window.requestAnimationFrame(() => planColumnClose.focus({ preventScroll: true }));
  });
  workspaceExitBtn.addEventListener('click', () => {
    if (settingsPanelOpen) {
      void requestSettingsClose(workspaceExitBtn, () => setFullscreen(false));
      return;
    }
    setFullscreen(false);
  });
  applyEnvironmentPanelState();

  const chatPage = el('div', 'ag-chat-page');
  chatPage.id = 'ag-chat-page';
  chatPage.setAttribute('aria-hidden', 'false');

  /* 연결 팝오버 — 상태 한 줄, 필요할 때만 실행 명령, 다시 연결. */
  const connPopover = el('div', 'ag-conn-popover');
  connPopover.id = 'ag-conn-popover';
  connPopover.hidden = true;
  connPopover.setAttribute('role', 'dialog');
  connPopover.setAttribute('aria-label', '허브 연결');
  const connPopoverText = el('p', 'ag-conn-popover-text');
  const managedHub = isDesktopApp() || Boolean((import.meta as any).env?.DEV);
  const connCommand = el('div', 'ag-conn-command');
  connCommand.hidden = managedHub;
  const connCommandText = el('code', 'ag-conn-command-text', 'npm start');
  const connCommandCopy = el('button', 'ag-conn-command-copy');
  connCommandCopy.type = 'button';
  connCommandCopy.setAttribute('aria-label', '명령 복사');
  connCommandCopy.title = '복사';
  connCommandCopy.appendChild(createIcon('copy'));
  connCommandCopy.addEventListener('click', () => {
    void navigator.clipboard?.writeText('npm start').then(() => {
      connCommandCopy.replaceChildren(createIcon('check'));
      window.setTimeout(() => connCommandCopy.replaceChildren(createIcon('copy')), 1400);
    }).catch(() => {});
  });
  connCommand.append(connCommandText, connCommandCopy);
  const connRetry = el('button', 'ag-conn-retry', '다시 연결');
  connRetry.type = 'button';
  connRetry.addEventListener('click', () => {
    connPopoverText.textContent = '연결 중';
    void bridge.reconnectNow();
  });
  connPopover.append(connPopoverText, connCommand, connRetry);
  header.append(connPopover);

  function setConnPopoverOpen(open: boolean): void {
    if (open === !connPopover.hidden) return;
    connPopover.hidden = !open;
    connDot.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      renderConnStatus();
      requestAnimationFrame(() => connRetry.focus({ preventScroll: true }));
    }
  }
  connDot.addEventListener('click', (event) => {
    event.stopPropagation();
    setConnPopoverOpen(Boolean(connPopover.hidden));
  });
  const onConnPopoverOutside = (event: PointerEvent): void => {
    if (connPopover.hidden) return;
    const target = event.target as Node;
    if (connPopover.contains(target) || connDot.contains(target)) return;
    setConnPopoverOpen(false);
  };
  document.addEventListener('pointerdown', onConnPopoverOutside);
  connPopover.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    setConnPopoverOpen(false);
    connDot.focus();
  });

  const messages = el('div', 'ag-messages');
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-live', 'polite');
  const messagesEnd = el('div', 'ag-messages-end');
  messagesEnd.setAttribute('aria-hidden', 'true');
  const turnPending = el('div', 'ag-turn-pending');
  turnPending.hidden = true;
  turnPending.setAttribute('role', 'status');
  turnPending.setAttribute('aria-live', 'polite');
  const turnPendingLabel = el('span', 'ag-turn-pending-label');
  turnPending.append(createInkRing(), turnPendingLabel);
  messages.append(turnPending, messagesEnd);
  /* "편집 중…" 고리는 에이전트가 400ms 넘게 조용할 때 나타나고, 나타나면 400ms 는
     머문다 — 짧은 글과 빠른 도구가 번갈아 와도 대화 끝이 깜빡이지 않는다. 숨어
     있는 동안 새 내용은 고리 뒤(messagesEnd 앞)에 붙고, 나타날 때 끝으로 옮긴다. */
  const turnPendingStatus = createDelayedStatus<AgentName>((who) => {
    turnPending.hidden = who === null;
    if (!who) return;
    turnPendingLabel.textContent = `${AGENT_LABEL[who]} 편집 중…`;
    messages.insertBefore(turnPending, messagesEnd);
  });
  /**
   * 도는 턴의 접힘 자리표시(숨은 줄)와 숨어 있는 "편집 중…" 고리는 내용이 아니다 —
   * 스크롤 기준을 고를 때 건너뛴다. 숨은 고리는 지연 동안 대화 중간에 남아 있을 수 있다.
   */
  function skipTurnFoldPlaceholders(node: Element | null): Element | null {
    let current = node;
    while (
      current instanceof HTMLElement && current.hidden
      && (current === turnPending || current.classList.contains('ag-turn-fold'))
    ) {
      current = current.previousElementSibling;
    }
    return current;
  }
  /** 마지막 내용의 아래끝이 대화 영역 아래로 내려가 있으면 뒤처진 상태다. */
  function lastConversationContent(): HTMLElement | null {
    let last = messagesEnd.previousElementSibling;
    if (last === turnPending && turnPending.hidden) last = turnPending.previousElementSibling;
    last = skipTurnFoldPlaceholders(last);
    return last instanceof HTMLElement ? last : null;
  }
  /** 마지막 내용의 아래끝이 대화 영역 아래끝보다 얼마나 내려가 있는지. */
  function latestOverflowPx(): number {
    const last = lastConversationContent();
    if (!last) return Number.NEGATIVE_INFINITY;
    return last.getBoundingClientRect().bottom - messages.getBoundingClientRect().bottom;
  }
  const onMessagesScroll = (): void => {
    const previousTop = conversationLastScrollTop;
    conversationLastScrollTop = messages.scrollTop;
    // 휠 처리기가 conversationLastScrollTop 을 먼저 맞출 수 있어 방향은 따로 잰다.
    const scrolledDown = messages.scrollTop > composerRestLastScrollTop;
    composerRestLastScrollTop = messages.scrollTop;
    if (composerRest.resting && scrolledDown && isConversationEndVisible()) {
      composerRest.setResting(false);
    }
    if (conversationScrollLock) return;
    if (conversationScrollPaused) {
      // 현재 턴으로 다시 내려오면 새 출력을 따라간다.
      if (messages.scrollTop > previousTop && isConversationFollowingTurn()) {
        conversationScrollPaused = false;
        followConversation = true;
      }
      return;
    }
    followConversation = isConversationFollowingTurn();
  };
  const onMessagesWheel = (event: WheelEvent): void => {
    if (event.deltaY === 0) return;
    if (event.deltaY < 0 && !event.ctrlKey) {
      const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? messages.clientHeight : 1;
      noteConversationScrollUp(-event.deltaY * unit);
    }
    stopFollowingConversation();
    if (event.deltaY > 0 && isConversationFollowingTurn()) {
      conversationScrollPaused = false;
      followConversation = true;
    }
  };
  let messagesTouchStartY: number | null = null;
  let messagesTouchLastY: number | null = null;
  const onMessagesTouchStart = (event: TouchEvent): void => {
    messagesTouchStartY = event.touches[0]?.clientY ?? null;
    messagesTouchLastY = messagesTouchStartY;
  };
  const onMessagesTouchMove = (event: TouchEvent): void => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && messagesTouchLastY !== null && y > messagesTouchLastY) {
      noteConversationScrollUp(y - messagesTouchLastY);
    }
    messagesTouchLastY = y ?? null;
    if (y !== undefined && messagesTouchStartY !== null && Math.abs(y - messagesTouchStartY) > 6) {
      stopFollowingConversation();
    }
  };
  // 위로 읽기 시작하면 입력기를 한 줄로 접는다. 제스처 하나가 임계값을
  // 넘을 때만 접어서, 스크롤 휠의 작은 흔들림에는 반응하지 않는다.
  let composerRestScrollPx = 0;
  let composerRestLastScrollTop = 0;
  let composerRestScrollAt = Number.NEGATIVE_INFINITY;
  function noteConversationScrollUp(deltaPx: number): void {
    const now = performance.now();
    if (now - composerRestScrollAt > COMPOSER_REST_GESTURE_MS) composerRestScrollPx = 0;
    composerRestScrollAt = now;
    // 대화 끝이 충분히 가려진 뒤에만 접는다. 접히며 넓어진 화면에 끝이 다시 드러나
    // 곧바로 펼쳐지는 되튐을 막는다.
    const endHiddenPx = messagesEnd.getBoundingClientRect().top - messages.getBoundingClientRect().bottom;
    if (composerRest.resting || messages.scrollTop <= 0 || !canComposerRest() || endHiddenPx < COMPOSER_REST_END_CLEARANCE_PX) {
      composerRestScrollPx = 0;
      return;
    }
    composerRestScrollPx += deltaPx;
    if (composerRestScrollPx < COMPOSER_REST_SCROLL_PX) return;
    composerRestScrollPx = 0;
    composerRest.setResting(true);
  }
  function isConversationEndVisible(): boolean {
    return messagesEnd.getBoundingClientRect().top <= messages.getBoundingClientRect().bottom + 1;
  }
  const onMessagesPointerDown = (event: PointerEvent): void => {
    if (event.target === messages && event.offsetX >= messages.clientWidth) stopFollowingConversation();
  };
  messages.addEventListener('scroll', onMessagesScroll, { passive: true });
  messages.addEventListener('wheel', onMessagesWheel, { passive: true });
  messages.addEventListener('touchstart', onMessagesTouchStart, { passive: true });
  messages.addEventListener('touchmove', onMessagesTouchMove, { passive: true });
  messages.addEventListener('pointerdown', onMessagesPointerDown);
  /*
   * 대화가 바뀐 뒤 여백·따라가기·최신 알약을 한 번에 잰다. 같은 작업 안의 변경
   * (스트리밍 렌더, 도구 행, 관찰자 알림)은 마이크로태스크 하나로 모여, 프레임마다
   * 레이아웃을 한 번만 강제한다. 그리기 전에 돌아 한 프레임 늦지 않는다.
   */
  let conversationLayoutQueued = false;
  function queueConversationLayout(): void {
    if (conversationLayoutQueued) return;
    conversationLayoutQueued = true;
    queueMicrotask(runConversationLayout);
  }
  function runConversationLayout(): void {
    conversationLayoutQueued = false;
    if (root.dataset.disposed === 'true') return;
    // 내용 크기가 바뀌었을 수 있으니 스프링 목표를 다시 잰다.
    conversationScrollTargetValue = null;
    // 빈 채팅 배치가 먼저 풀려야 여백이 대화 영역의 최종 높이로 잰다.
    syncFocusGreeting();
    // 떨어져 있는 동안에는 잴 것이 없다 — 다시 붙을 때 restoreScrollPositions 가 맞춘다.
    if (!active) return;
    if (followConversation) scrollConversationToEnd();
    else syncConversationSpacer();
    scheduleLatestPillUpdate();
  }
  const messagesMutationObserver = typeof MutationObserver === 'function'
    ? new MutationObserver(queueConversationLayout)
    : null;
  messagesMutationObserver?.observe(messages, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  let messagesResizeFrame: number | null = null;
  const messagesResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        // 영역 크기가 바뀌면 다음 스프링 프레임부터 목표를 다시 잰다.
        conversationScrollTargetValue = null;
        // 계획 패널 전환 중 관찰한 레이아웃을 같은 전달 주기에서 다시 바꾸지 않는다.
        if (messagesResizeFrame !== null) return;
        messagesResizeFrame = window.requestAnimationFrame(() => {
          messagesResizeFrame = null;
          syncConversationSpacer();
          if (followConversation) scrollConversationToEnd();
          scheduleLatestPillUpdate();
        });
      })
    : null;
  messagesResizeObserver?.observe(messages);
  /*
   * 턴 접힘 줄이 나타나고 접히는 동안, 대화를 따라가던 화면은 기준점(최종 답변·대화 끝)을
   * 제자리에 둔다. 크기 관찰은 배치 뒤·그리기 전에 돌아 접히는 프레임과 어긋나지 않는다.
   * 스프링이 움직이는 중이면 목표만 비워 다음 프레임에 새로 잰다.
   */
  const turnFoldResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
        if (!active || !followConversation) return;
        syncConversationSpacer();
        conversationScrollTargetValue = null;
        if (conversationScrollRaf === null) {
          const anchor = latestTurnAnchor();
          const target = anchor ? roundedConversationTarget(anchor) : null;
          if (target !== null && Math.abs(target - messages.scrollTop) >= 1) {
            lockConversationScroll(80);
            messages.scrollTop = target;
            conversationLastScrollTop = messages.scrollTop;
          }
        }
        scheduleLatestPillUpdate();
      })
    : null;

  /* 위로 읽는 중에 보이는 "최신" 알약. 마지막 내용이 가려졌을 때만 뜨고,
     누르면 마지막 내용이 입력기 바로 위에 오도록 내려가 대화 끝을 따라간다. */
  const latestDock = el('div', 'ag-latest-dock');
  const latestPill = el('button', 'ag-latest-pill');
  latestPill.type = 'button';
  latestPill.hidden = true;
  latestPill.title = '최신 대화로 (⌘↓)';
  latestPill.append(createIcon('arrowDown'), el('span', 'ag-latest-pill-label', '최신'));
  latestDock.appendChild(latestPill);
  let latestPillFrame: number | null = null;

  function scheduleLatestPillUpdate(): void {
    if (latestPillFrame !== null) return;
    latestPillFrame = window.requestAnimationFrame(() => {
      latestPillFrame = null;
      // 끝을 따라가는 중이면 곧 따라잡으므로 띄우지 않는다.
      const catchingUp = followConversation && latestTurnAnchor() === messagesEnd;
      // 나타나는 선과 사라지는 선을 벌려 두어 경계 근처의 작은 흔들림에 깜빡이지 않는다.
      const overflow = latestOverflowPx();
      const behind = latestPill.hidden ? overflow > LATEST_SHOW_PX : overflow > LATEST_HIDE_PX;
      const show = messages.isConnected && messages.clientHeight > 0 && !catchingUp && behind;
      if (latestPill.hidden === !show) return;
      latestPill.hidden = !show;
    });
  }

  function scrollConversationToLatest(): void {
    followConversationEnd = true;
    scrollConversationToMessage(messagesEnd, { smooth: true });
    latestPill.hidden = true;
  }

  function scrollConversationToTop(): void {
    stopFollowingConversation();
    messages.scrollTo({
      top: 0,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
    scheduleLatestPillUpdate();
  }

  latestPill.addEventListener('click', () => scrollConversationToLatest());
  messages.addEventListener('scroll', scheduleLatestPillUpdate, { passive: true });
  const review = el('div', 'ag-review');
  review.tabIndex = 0;
  review.setAttribute('aria-label', '변경 사항 검토');
  const compactChanges = el('section', 'ag-compact-changes');
  compactChanges.hidden = true;
  const compactChangesToggle = el('button', 'ag-compact-changes-toggle');
  compactChangesToggle.type = 'button';
  compactChangesToggle.setAttribute('aria-controls', 'ag-compact-changes-content');
  compactChangesToggle.setAttribute('aria-expanded', 'false');
  compactChangesToggle.append(createIcon('changes'), el('span', '', '커밋 전'));
  const compactChangesCount = el('span', 'ag-compact-changes-count');
  compactChangesToggle.append(compactChangesCount, createChevron('ag-compact-changes-chevron'));
  compactChangesToggle.addEventListener('click', () => setCompactChangesOpen(!compactChangesOpen));
  const compactChangesContent = el('div', 'ag-compact-changes-content');
  compactChangesContent.id = 'ag-compact-changes-content';
  compactChangesContent.hidden = true;
  compactChanges.append(compactChangesToggle, compactChangesContent);
  const planSurface = el('section', 'ag-plan-surface');
  planSurface.setAttribute('aria-label', '실행 계획');
  const planCardSlot = el('div', 'ag-plan-card-slot');
  const planRestore = el('button', 'ag-plan-restore');
  planRestore.hidden = true;
  planRestore.type = 'button';
  planRestore.setAttribute('aria-label', '계획 펼치기');
  planRestore.title = '계획 펼치기';
  planRestore.setAttribute('aria-hidden', 'true');
  planRestore.inert = true;
  // 접힌 계획은 입력기 위 전체 폭의 한 줄 타임라인이다: 지금 할 일 · 진행 칸 · n/m · ⌃.
  const planRestoreMark = el('span', 'ag-plan-restore-mark');
  const planRestoreLabel = el('span', 'ag-plan-restore-label', '계획');
  const planRestoreTrack = el('span', 'ag-plan-restore-track');
  planRestoreTrack.setAttribute('aria-hidden', 'true');
  const planRestoreCount = el('span', 'ag-plan-restore-count');
  const planRestoreCaret = createChevron('ag-plan-restore-caret');
  planRestore.append(planRestoreMark, planRestoreLabel, planRestoreTrack, planRestoreCount, planRestoreCaret);
  planRestore.addEventListener('click', () => setPlanMinimized(false));
  planSurface.append(planCardSlot);
  let initialSetup: InitialSetupUi | null = null;
  const writingStyleCalibration = createWritingStyleCalibration(bridge, {
    onDismiss: (result) => {
      initialSetup?.notifyCalibrationClosed(result.completed);
      if (result.completed) settleCalibrationChip('done');
    },
  });

  /* 문체 보정 권유 칩 — 첫 실행을 마치고 첫 답을 받은 뒤 한 번 뜬다.
     닫거나 보정을 끝내면 다시 뜨지 않는다. */
  const calibrationChip = el('div', 'ag-calibration-chip');
  calibrationChip.hidden = true;
  const calibrationChipOpen = el('button', 'ag-calibration-chip-open');
  calibrationChipOpen.type = 'button';
  calibrationChipOpen.append(
    el('span', 'ag-calibration-chip-text', '원고를 올리면 내 말투로 씁니다'),
    el('span', 'ag-calibration-chip-action', '말투 맞추기'),
  );
  const calibrationChipClose = el('button', 'ag-calibration-chip-close');
  calibrationChipClose.type = 'button';
  calibrationChipClose.setAttribute('aria-label', '닫기');
  calibrationChipClose.appendChild(createIcon('close'));
  calibrationChip.append(calibrationChipOpen, calibrationChipClose);
  let writingStyleActive = false;
  calibrationChipOpen.addEventListener('click', () => writingStyleCalibration.open());
  calibrationChipClose.addEventListener('click', () => settleCalibrationChip('skipped'));

  function settleCalibrationChip(step: 'done' | 'skipped'): void {
    saveInitialSetup({ calibrationStep: step });
    calibrationChip.hidden = true;
  }

  function updateCalibrationChip(): void {
    const setup = loadInitialSetup();
    const eligible = setup.completed
      && setup.calibrationStep === 'pending'
      && !writingStyleActive
      && !turnRunning
      && currentThread.messages.some((message) => message.role === 'assistant');
    calibrationChip.hidden = !eligible || !reconnectChip.hidden;
  }

  /* 프로바이더 재연결 칩 — 고른 프로바이더의 로그인이 풀리면 같은 자리에 뜬다.
     누르면 설정의 로그인 모달로 바로 가고, 로그인이 돌아오면 세션을 새로 연다. */
  const reconnectChip = el('div', 'ag-calibration-chip ag-reconnect-chip');
  reconnectChip.hidden = true;
  reconnectChip.setAttribute('role', 'status');
  const reconnectChipOpen = el('button', 'ag-calibration-chip-open');
  reconnectChipOpen.type = 'button';
  const reconnectChipText = el('span', 'ag-calibration-chip-text');
  reconnectChipOpen.append(
    el('span', 'ag-reconnect-chip-dot'),
    reconnectChipText,
    el('span', 'ag-calibration-chip-action', '다시 로그인'),
  );
  reconnectChip.append(reconnectChipOpen);
  let setupStatuses: AgentSetupStatusMap | null = null;
  /** 턴이 인증 오류로 끝났지만 허브의 상태는 아직 로그인으로 보이는 프로바이더. */
  const authFailedAgents = new Set<AgentName>();
  /** 칩을 띄운 뒤 로그인이 돌아오면 세션을 다시 열 프로바이더. */
  const reconnectWaiting = new Set<AgentName>();
  reconnectChipOpen.addEventListener('click', () => {
    const agent = reconnectChip.dataset.agent as AgentName | undefined;
    if (!agent) return;
    requestSettingsOpen('ai');
    settingsPanel.beginAgentConnect(agent, { reauth: authFailedAgents.has(agent) });
  });
  /** 로그인 창이 열렸던 프로바이더 — 그 뒤의 로그인 상태는 새 자격 증명이다. */
  const authRunSeen = new Set<AgentName>();

  /** 인증 실패를 본 시각. 허브가 그 뒤에 자격 증명을 다시 확인하면 칩을 거둔다. */
  const authFailedAt = new Map<AgentName, number>();
  /** 턴이 도는 중에 로그인이 돌아와 턴이 끝난 뒤 다시 열 세션. */
  const reconnectRestartPending = new Set<AgentName>();

  function receiveSetupStatuses(statuses: AgentSetupStatusMap): void {
    setupStatuses = statuses;
    for (const agent of PROVIDER_ORDER) {
      const status = statuses[agent];
      if (status?.authenticating) {
        authRunSeen.add(agent);
      } else if (authRunSeen.has(agent)) {
        authRunSeen.delete(agent);
        if (status?.authenticated) authFailedAgents.delete(agent);
      }
      const failedAt = authFailedAt.get(agent);
      if (failedAt !== undefined && status?.authenticated
        && typeof status.authVerifiedAt === 'number' && status.authVerifiedAt >= failedAt) {
        authFailedAgents.delete(agent);
        authFailedAt.delete(agent);
      }
    }
    resumeReconnectedProviders();
    // 로그인이 돌아오면 로그인 알림이 '다시 시도' 로 바뀐다.
    failureNotices.refresh();
  }

  function providerNeedsLogin(agent: AgentName): boolean {
    if (!(PROVIDER_ORDER as readonly AgentName[]).includes(agent)) return false;
    const status = setupStatuses?.[agent];
    if (!status || status.authenticating) return false;
    // 설치만 됐고 한 번도 연결하지 않은 프로바이더는 입력기 메뉴에 없다.
    return (status.available && !status.authenticated) || authFailedAgents.has(agent);
  }

  function updateReconnectChip(): void {
    const agent = selectedAgent;
    const show = connState === 'connected' && providerNeedsLogin(agent);
    if (show) {
      reconnectWaiting.add(agent);
      reconnectChip.dataset.agent = agent;
      reconnectChipText.textContent = `${AGENT_LABEL[agent]} 로그인 필요`;
    }
    reconnectChip.hidden = !show;
  }

  /** 로그인이 돌아온 프로바이더의 세션을 새 자격 증명으로 다시 연다. */
  function resumeReconnectedProviders(): void {
    for (const agent of [...reconnectWaiting]) {
      const status = setupStatuses?.[agent];
      if (!status?.connected || status.authenticating || authFailedAgents.has(agent)) continue;
      reconnectWaiting.delete(agent);
      if (agent !== selectedAgent) continue;
      if (turnRunning) reconnectRestartPending.add(agent);
      else restartAgentSession();
      // 같은 허브 상태를 모든 문서의 사이드바가 받는다 — 알림은 보이는 사이드바 하나만.
      if (active) showToast({ message: `${AGENT_LABEL[agent]} 다시 연결됨`, durationMs: 2400 });
    }
  }

  /** 허브가 인증 실패로 분류한 턴 — 허브 상태가 늦게 따라올 때를 잡는다. */
  function noteProviderAuthFailure(agent: AgentName, failure: ProviderFailure): void {
    if (failure.class !== 'auth_required') return;
    authFailedAgents.add(agent);
    authFailedAt.set(agent, Date.now());
    updateReconnectChip();
    updateCalibrationChip();
    void bridge.requestAgentSetupStatus(true);
  }

  const composerUtilities = el('div', 'ag-composer-utilities');
  composerUtilities.setAttribute('aria-label', '채팅 도구');

  /** 계획 단계 배지 — 계획 모드에서만 보이는 작고 읽기 전용인 상태 표시다. */
  const phaseBadge = el('span', 'ag-phase-badge');
  phaseBadge.setAttribute('role', 'status');
  phaseBadge.setAttribute('aria-live', 'polite');
  phaseBadge.hidden = true;

  const composerUtilityActions = el('div', 'ag-composer-utility-actions');
  composerUtilityActions.append(phaseBadge, modeMenu.root);
  composerUtilities.append(composerUtilityActions);
  const composer = el('form', 'ag-composer');
  let composerBottomDistance: number | null = null;
  const composerRest = createComposerRestingMotion({
    composer,
    beforeChange: () => {
      composerBottomDistance = messages.scrollHeight - messages.clientHeight - messages.scrollTop;
    },
    // 펼쳐진 입력기는 대화 영역을 아래에서 줄인다. 아래쪽을 읽던 사람의 자리는
    // 맨 아래까지의 거리를 그대로 지켜, 마지막 줄이 입력기 뒤로 숨지 않게 한다.
    onChange: (resting) => {
      const distance = composerBottomDistance;
      composerBottomDistance = null;
      if (resting || distance === null || distance > messages.clientHeight) return;
      const maxScroll = Math.max(0, messages.scrollHeight - messages.clientHeight);
      lockConversationScroll(80);
      messages.scrollTop = Math.max(0, maxScroll - distance);
      composerRestLastScrollTop = messages.scrollTop;
      conversationLastScrollTop = messages.scrollTop;
      scheduleLatestPillUpdate();
    },
    // 흐름 안에 있는 행과 입력 줄의 요소만 제자리를 지킨다. 떠 있는 overlay·
    // 메뉴·도크는 입력기 위쪽 가장자리를 따라 자연스럽게 움직인다.
    movingParts: () => [
      ...Array.from(composer.children).filter((child): child is HTMLElement =>
        child instanceof HTMLElement
        && child !== composerField
        && (child === composerMeta || !['absolute', 'fixed'].includes(getComputedStyle(child).position))),
      ...Array.from(composerField.children).filter((child): child is HTMLElement => child instanceof HTMLElement),
    ],
  });
  function canComposerRest(): boolean {
    return !configPanelOpen
      && slashMenu.hidden
      && !questionController.isPresented()
      && !input.value.includes('\n')
      && input.scrollHeight <= COMPOSER_REST_MAX_INPUT_PX;
  }
  // 진행 상태는 계획/변경 surface와 별개인 입력기 overlay다. 이 행은 문서
  // 흐름의 높이를 차지하지 않으며, 왼쪽 작업 상태와 오른쪽 계획 복원 버튼이
  // 서로의 자리를 침범하지 않도록 하나의 semantic cluster로 묶는다.
  const composerOverlay = el('div', 'ag-composer-overlay');
  composerOverlay.setAttribute('aria-label', '현재 작업 상태');
  const composerMeta = el('div', 'ag-composer-meta');
  composerMeta.setAttribute('aria-label', '에이전트 및 채팅 설정');
  composerMeta.append(selectors, composerUtilities);
  const slashMenu = el('div', 'ag-slash-menu');
  slashMenu.id = 'ag-slash-menu';
  slashMenu.hidden = true;
  slashMenu.setAttribute('role', 'listbox');
  slashMenu.setAttribute('aria-label', '슬래시 명령과 스킬');
  const input = el('textarea', 'ag-input');
  input.placeholder = '문서 작업 입력';
  input.rows = 1;
  input.setAttribute('aria-label', '에이전트 메시지 입력');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', slashMenu.id);
  input.setAttribute('aria-expanded', 'false');
  // 보내기 버튼은 입력 필드 '안'에 산다. 라벨은 아이콘이 대신하고
  // 이름은 aria-label/title 로 남긴다.
  const send = el('button', 'ag-send');
  send.type = 'submit';
  send.append(createIcon('send'));
  send.setAttribute('aria-label', '보내기');
  send.title = '보내기';

  // 프롬프트 캐럿: 이 필드가 명령을 받는 자리라는 표시. 순수 장식이라 aria 에서 숨긴다.
  const caret = el('span', 'ag-caret', '>');
  caret.setAttribute('aria-hidden', 'true');
  // 실제로 존재하는 단축키만 노출한다 — 전송은 Enter, 줄바꿈은 Shift+Enter.
  const sendHint = el('span', 'ag-kbd', '⏎');
  sendHint.setAttribute('aria-hidden', 'true');

  const composerField = el('div', 'ag-composer-field');
  const composerSkill = el('span', 'ag-skill-token ag-composer-skill');
  composerSkill.hidden = true;
  const composerSkillIcon = el('span', 'ag-skill-token-icon');
  const composerSkillName = el('span', 'ag-skill-token-name');
  const composerSkillClear = el('button', 'ag-skill-token-clear');
  composerSkillClear.type = 'button';
  composerSkillClear.setAttribute('aria-label', '스킬 호출 해제');
  composerSkillClear.appendChild(createIcon('close'));
  composerSkill.append(composerSkillIcon, composerSkillName, composerSkillClear);
  composerField.append(caret, composerSkill, input, sendHint, send);
  const templateChip = el('div', 'ag-template-chip');
  templateChip.hidden = true;
  const templateChipName = el('span', 'ag-template-chip-name');
  const templateChipClear = el('button', 'ag-template-chip-clear');
  templateChipClear.type = 'button';
  templateChipClear.setAttribute('aria-label', '활성 템플릿 해제');
  templateChipClear.appendChild(createIcon('close'));
  templateChip.append(el('span', 'ag-template-chip-label', '템플릿'), templateChipName, templateChipClear);
  composer.append(composerOverlay, slashMenu, templateChip, composerField, composerMeta, configPanel);
  // 접힌 입력기는 손이 닿는 순간 편다. 보내기 버튼만은 접힌 채로 바로 누를 수 있다.
  composer.addEventListener('pointerdown', (event) => {
    if (!composerRest.resting || send.contains(event.target as Node)) return;
    composerRest.setResting(false);
    if (event.target === composer || event.target === composerField) {
      event.preventDefault();
      input.focus({ preventScroll: true });
    }
  });
  // 창으로 돌아올 때 원래 초점이 다시 들어오는 것은 사용자의 손길이 아니다.
  let windowRefocusFrame: number | null = null;
  const onWindowRefocus = (): void => {
    if (windowRefocusFrame !== null) window.cancelAnimationFrame(windowRefocusFrame);
    windowRefocusFrame = window.requestAnimationFrame(() => { windowRefocusFrame = null; });
  };
  window.addEventListener('focus', onWindowRefocus);
  // 창을 닫거나 새로고침하기 전에 모아 둔 도구 기록을 쓴다.
  const onPageHide = (): void => flushTranscriptPersist();
  window.addEventListener('pagehide', onPageHide);
  composer.addEventListener('focusin', (event) => {
    if (!composerRest.resting || event.target === send || windowRefocusFrame !== null) return;
    composerRest.setResting(false);
  });
  input.addEventListener('keydown', () => {
    if (composerRest.resting) composerRest.setResting(false);
  });

  // 편대 도크는 입력기 위에 뜨는 오버레이라서 입력기의 자식으로 붙는다 —
  // 사이드바·전체 화면 어디로 옮겨져도 입력기를 따라간다.
  composer.appendChild(fleetView.root);
  const questionTimelineAnchor = el('span', 'ag-question-timeline-anchor');
  questionTimelineAnchor.hidden = true;
  questionTimelineAnchor.setAttribute('aria-hidden', 'true');
  let questionTimelineAnchorInteractionId: string | null = null;
  /* 쓰는 중에 도착한 질문·계획 열은 쓰기를 멈출 때까지 미룬다 — 초점·숫자 키·한글
     조합·입력기의 글을 빼앗지 않는다. 화면에 없는 사이드바는 바로 보여 준다.
     질문은 입력기를 넘겨받으므로 입력기에서 열린 조합만 확정될 때까지 기다린다. */
  const arrivalGuard = createArrivalGuard(
    typing,
    () => active,
    (target) => target instanceof Node && input.contains(target),
  );
  /** 지금 미뤄 둔 질문의 보류 키 — 새 질문이 오면 앞 것을 거둔다. */
  let heldQuestionKey: string | null = null;
  const questionController = createUserQuestionController({
    input,
    submitAnswers: (interactionId, answers) => bridge.answerUserQuestion(interactionId, answers),
    stop: () => stopTurn(),
    // 입력기(질문이 넘겨받는다)와 텍스트가 아닌 곳의 초점만 옮긴다. 문서나 다른 칸에서 쓰던 초점은 그대로 둔다.
    canTakeFocus: () => active
      && !(ownsTextInput(document.activeElement) && document.activeElement !== input),
    onArrivalOpen: () => arrivalGuard.release(),
    onDraftChange(interaction, draft) {
      const target = interaction.threadId === currentThread.id ? currentThread : getThread(interaction.threadId);
      if (!target) return;
      target.pendingUserQuestion = {
        interaction,
        selectedOptionIdsByQuestionId: draft.selectedOptionIdsByQuestionId,
        otherTextByQuestionId: draft.otherTextByQuestionId,
        activeQuestionIndex: draft.activeQuestionIndex,
        updatedAt: Date.now(),
      };
      if (target === currentThread) persistCurrentThread();
      else upsertThread(target);
    },
    onComposerModeChange() {
      updateComposer();
    },
    onResolved(interaction, outcome) {
      const target = interaction.threadId === currentThread.id ? currentThread : getThread(interaction.threadId);
      if (!target) return;
      const historyMessage = archivePendingUserQuestion(target, interaction.interactionId, outcome)
        ?? createUserQuestionHistoryMessage(interaction, outcome);
      if (!target.messages.includes(historyMessage)) target.messages.push(historyMessage);
      upsertThread(target);
      if (target === currentThread) {
        const historyCard = renderUserQuestionHistory(historyMessage);
        withAutoScroll(() => {
          if (
            questionTimelineAnchorInteractionId === interaction.interactionId
            && questionTimelineAnchor.parentElement === messages
          ) {
            questionTimelineAnchor.replaceWith(historyCard);
          } else appendConversation(historyCard);
        });
      }
      if (questionTimelineAnchorInteractionId === interaction.interactionId) {
        questionTimelineAnchor.remove();
        questionTimelineAnchorInteractionId = null;
      }
    },
  });
  // 입력기 위에 떠 있는 요소(도크·계획 복원 버튼)가 서로 비켜 서도록 높이를 알린다.
  // 변수는 chatPage 에 걸어 입력기와 그 위의 질문 카드가 함께 물려받는다.
  // 도크가 차지하는 높이는 계획 복원 버튼(overlay)이 겹치지 않게 한다.
  const dockResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
      const height = entries[0]?.contentRect.height ?? 0;
      chatPage.style.setProperty('--ag-fleet-dock-h', height > 0 ? `${Math.ceil(height) + 6}px` : '0px');
    })
    : null;
  dockResizeObserver?.observe(fleetView.root);
  // 대기 메시지 — 에이전트가 일하는 동안 Enter 로 쌓아 두고, 턴이 정상으로 끝나면 하나씩 보낸다.
  // 입력기 바로 위(질문 카드 위)에 띠로 보인다. 규칙은 follow-up-controller.ts 가 정한다.
  const followUpStrip = createFollowUpStrip({
    isMac: isMacPlatform,
    skillDisplayName: (name) => skillDisplayName(name),
    onResume: () => followUps.resume(),
    onSendNow: (id) => followUps.sendNow(id),
    onRemove: (id) => followUps.removeItem(id),
    onEditStart: (id) => followUps.startEdit(id),
    onEditCommit: (id, text, viaKey) => followUps.commitEdit(id, text, viaKey),
    onEditCancel: (id) => followUps.cancelEdit(id),
  });
  const followUps = createFollowUpController<ThreadMessage, HTMLElement>({
    strip: followUpStrip,
    thread: () => currentThread,
    persist: () => persistCurrentThread(),
    send: (item) => sendComposedMessage({
      text: item.text,
      skillName: item.skillName,
      skillIcon: item.skillIcon,
      origin: 'queue',
      requireReceipt: true,
    }),
    unsend: (message, bubble) => unrecordUserMessage(message, bubble),
    interrupt: () => bridge.interrupt(),
    isTurnRunning: () => turnRunning,
    isWorking: () => agentWorking(),
    sendBlockedReason: () => followUpSendBlockedReason(),
    readOnly: () => readOnlyDocLabel !== null,
    turnContext: () => ({
      planAwaitingApproval: chatWorkflow === 'plan' && planningPhase === 'awaiting-approval',
      engineTrapped: engineTrap() !== null,
      mergeLocked: mergeResolverLocked,
    }),
    focusComposer: () => {
      if (active && !input.disabled) input.focus({ preventScroll: true });
    },
    onChange: () => updateComposer(),
    // 턴 접힘과 같은 한 플래그로 이 턴의 성패를 가른다.
    errorSeen: () => turnErrorSeen,
  });
  // 입력기 위에 흐름으로 쌓인 것들의 높이. 떠 있는 요소는 이들을 덮지 않고 한 겹 위에 선다.
  // attached 는 입력기와 한 면을 이루는 질문 카드, stack 은 그 위의 변경 막대와 칩이다.
  // 위치만 바꾸고 크기는 건드리지 않아 관찰 고리가 생기지 않는다.
  const composerStackNodes = [compactChanges, reconnectChip, calibrationChip, followUpStrip.root];
  let composerStackFrame = 0;
  function syncComposerStack(): void {
    const question = questionController.root;
    const attached = question.dataset.inactive === 'true' ? 0 : question.offsetHeight;
    let stack = 0;
    for (const node of composerStackNodes) {
      if (node.hidden) continue;
      stack += node.offsetHeight + (parseFloat(getComputedStyle(node).marginBottom) || 0);
    }
    composer.style.setProperty('--ag-attached-h', `${Math.ceil(attached)}px`);
    composer.style.setProperty('--ag-stack-h', `${Math.ceil(stack)}px`);
  }
  const composerStackResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => {
      cancelAnimationFrame(composerStackFrame);
      composerStackFrame = requestAnimationFrame(syncComposerStack);
    })
    : null;
  for (const node of [...composerStackNodes, questionController.root]) composerStackResizeObserver?.observe(node);
  // 사이드바에서는 변경 검토와 계획을 분리한다. 계획은 입력기 바로 위에
  // 머물러 접었을 때 작은 진행 표시로 이어지고, 변경 검토는 가려지지 않는다.
  // 질문 카드와 입력기는 인접 형제여야 하나의 입력 면으로 이어진다.
  /* 전체 화면의 빈 채팅은 인사와 입력기를 가운데에 모은다. 첫 메시지를 보내면
     같은 채팅 안에서만 입력기가 아래로 미끄러진다 — 채팅을 바꾸거나 전체 화면을
     오갈 때는 즉시 바뀌고, 새 빈 채팅마다 새 문장을 고른다. */
  const focusGreeting = createFocusGreeting({ page: chatPage, composer, conversation: messages });
  focusGreeting.documentButton.addEventListener('click', () => {
    openDocumentPalette(focusGreeting.documentButton);
  });
  let focusGreetingThreadId: string | null = null;
  function syncFocusGreeting(): void {
    const threadChanged = focusGreetingThreadId !== currentThread.id;
    focusGreetingThreadId = currentThread.id;
    focusGreeting.setActive(fullscreen && lastConversationContent() === null, {
      animate: fullscreen && !threadChanged,
      reroll: threadChanged,
    });
  }
  chatPage.append(header, messages, focusGreeting.root, review, compactChanges, planSurface, planRestore, reconnectChip, calibrationChip, followUpStrip.root, questionController.root, composer);
  messages.after(latestDock);

  /** 입력기 하단 한 줄이 겹치지 않고 붙는 폭을 재서 사이드바 최솟값으로 쓴다.
   *  펼쳐진 사이드바의 현재 폭이 아니라 max-content(말줄임 바닥)로 잰다.
   *  space-between 으로 벌어진 빈 칸이 최솟값에 섞이면 전자 앱에서 600px
   *  근처로 다시 잠긴다. */
  function measureComposerMetaFloor(): number {
    root.classList.add('ag-measuring-min');
    const prevWidth = composerMeta.style.width;
    composerMeta.style.width = 'max-content';
    const packed = composerMeta.getBoundingClientRect().width;
    composerMeta.style.width = prevWidth;
    root.classList.remove('ag-measuring-min');
    return packed;
  }

  function refreshSidebarWidthMin(): number {
    if (!composer.isConnected) return sidebarWidthMin;
    const packed = measureComposerMetaFloor();
    if (packed <= 0) return sidebarWidthMin;
    const chrome = horizontalChrome(composer, [
      'margin-left',
      'margin-right',
      'padding-left',
      'padding-right',
      'border-left-width',
      'border-right-width',
    ]) + horizontalChrome(root, ['border-left-width']);
    const nextMin = Math.min(
      SIDEBAR_WIDTH_DEFAULT,
      Math.max(
        SIDEBAR_WIDTH_MIN_FALLBACK,
        Math.ceil(packed + chrome + SIDEBAR_PACKED_BUFFER_PX),
      ),
    );
    if (nextMin === sidebarWidthMin) {
      resizeHandle.setAttribute('aria-valuemin', String(sidebarWidthMin));
      return sidebarWidthMin;
    }
    sidebarWidthMin = nextMin;
    applySidebarWidth(sidebarWidth, { persist: true, recenter: true });
    return sidebarWidthMin;
  }

  const threadsPage = el('div', 'ag-threads-page');
  threadsPage.id = 'ag-threads-panel';
  threadsPage.setAttribute('role', 'region');
  threadsPage.setAttribute('aria-label', '채팅 목록');
  threadsPage.setAttribute('aria-hidden', 'true');
  const threadsHeader = el('div', 'ag-threads-header');
  const threadsTitle = el('span', 'ag-threads-title', '채팅');
  const threadsClose = el('button', 'ag-threads-btn ag-threads-close');
  threadsClose.type = 'button';
  threadsClose.setAttribute('aria-label', '채팅으로 돌아가기');
  threadsClose.title = '채팅으로 돌아가기';
  threadsClose.appendChild(createColumnIcon());
  threadsHeader.append(threadsTitle, threadsClose);
  const threadsToolbar = createThreadsToolbar({
    onQueryChange(query) {
      threadQuery = query;
      rebuildThreadsList();
    },
    onOpenFilter: () => openDocumentFilter(),
    onOpenDocuments: () => openDocumentPalette(),
    onNewChat: () => requestNewChat(),
    onClearFilter() {
      setThreadDocFilter(null);
    },
    onEnterList() {
      threadNavItems()[0]?.focus();
    },
  });
  const threadsList = el('ul', 'ag-threads-list');
  threadsList.setAttribute('aria-label', '채팅');
  // 끌어 놓은 자리에 채팅이 남는다. 고정 구역에 놓으면 고정, 아래 목록에 놓으면 고정 해제.
  const threadDrag = attachThreadDrag({
    list: threadsList,
    host: root,
    onDrop: (drop) => moveThread(drop.id, drop.pinned, { before: drop.before, after: drop.after }),
    onDragEnd: () => rebuildThreadsList(),
  });
  threadsPage.append(threadsHeader, threadsToolbar.root, threadsToolbar.filterChip, threadsList);

  const skillsPage = el('div', 'ag-skills-page');
  skillsPage.id = 'ag-skills-panel';
  skillsPage.setAttribute('role', 'region');
  skillsPage.setAttribute('aria-label', '스킬 라이브러리');
  skillsPage.setAttribute('aria-hidden', 'true');
  const skillsHeader = el('div', 'ag-threads-header');
  const skillsTitle = el('span', 'ag-threads-title', '스킬');
  const skillsClose = el('button', 'ag-threads-btn ag-threads-close');
  skillsClose.type = 'button';
  skillsClose.setAttribute('aria-label', '채팅으로 돌아가기');
  skillsClose.appendChild(createColumnIcon());
  skillsHeader.append(skillsTitle, skillsClose);
  const skillsShelf = createSkillsShelf({
    readEditor: (name) => bridge.readSkillEditor(name),
    saveEditor: (name, body, base) => bridge.saveSkillEditor(name, body, base),
    refresh: () => { bridge.listSkills(); },
    onCommit(change) {
      bridge.commitSkill(change);
    },
    onListHarness() {
      bridge.listHarnessSkills();
    },
  });
  skillsPage.append(skillsHeader, skillsShelf.root);


  const referenceLibrary = createReferenceLibrary({
    bridge,
    getContext: () => ({
      threadId: currentThread.id,
      documentId: currentDocumentId,
      documentName: getDocumentContext?.().documentName ?? currentDocKey,
    }),
    onOpenChange(open) {
      if (open && settingsPanelOpen && settingsPanel.isDirty()) {
        referenceLibrary.setOpen(false);
        void requestSettingsClose(undefined, () => referenceLibrary.setOpen(true));
        return;
      }
      root.classList.toggle('ag-references-open', open);
      if (open) {
        setConfigPanelOpen(false);
        threadsPanelOpen = false;
        skillsPanelOpen = false;
        closeSettingsPage();
        closeVersionsPage();
        root.classList.remove('ag-threads-open', 'ag-skills-open');
        threadsBtn.setAttribute('aria-expanded', 'false');
        skillsBtn.setAttribute('aria-expanded', 'false');
        skillsPage.setAttribute('aria-hidden', 'true');
        skillsPage.inert = true;
        threadsPage.inert = true;
      } else if (fullscreen) {
        threadsPage.inert = threadsRailCollapsed;
        applyThreadsRailState();
      } else {
        threadsPage.inert = true;
      }
      chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
      chatPage.inert = open;
    },
    onDraftStateChange() {
      updateComposer();
    },
    onFileDeleted(fileId) {
      let changed = false;
      for (const message of currentThread.messages) {
        for (const attachment of message.attachments ?? []) {
          if (attachment.fileId !== fileId) continue;
          attachment.status = 'deleted';
          changed = true;
        }
      }
      if (changed) {
        persistCurrentThread();
        renderMessagesFromThread(currentThread);
      }
    },
  });
  composerUtilityActions.insertBefore(referenceLibrary.trigger, modeMenu.root);
  composerField.insertBefore(referenceLibrary.quickAddButton, sendHint);
  composer.insertBefore(referenceLibrary.quickUploads, composerField);

  let attachmentDragDepth = 0;
  const canStageComposerAttachments = (): boolean => {
    return connState === 'connected'
      && readOnlyDocLabel === null
      && chatStartPendingThreadId === null
      && !attachmentsSending
      && !referenceLibrary.isOpen();
  };
  const clearAttachmentDrag = (): void => {
    attachmentDragDepth = 0;
    root.classList.remove('ag-attachment-dragging');
  };
  const onAttachmentDragEnter = (event: DragEvent): void => {
    if (!transferHasFiles(event.dataTransfer) || !canStageComposerAttachments()) return;
    event.preventDefault();
    event.stopPropagation();
    attachmentDragDepth += 1;
    root.classList.add('ag-attachment-dragging');
  };
  const onAttachmentDragOver = (event: DragEvent): void => {
    if (!transferHasFiles(event.dataTransfer) || !canStageComposerAttachments()) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    root.classList.add('ag-attachment-dragging');
  };
  const onAttachmentDragLeave = (event: DragEvent): void => {
    if (!root.classList.contains('ag-attachment-dragging')) return;
    event.preventDefault();
    event.stopPropagation();
    attachmentDragDepth = Math.max(0, attachmentDragDepth - 1);
    if (attachmentDragDepth === 0) root.classList.remove('ag-attachment-dragging');
  };
  const onAttachmentDrop = (event: DragEvent): void => {
    if (!transferHasFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const files = droppedFiles(event.dataTransfer);
    clearAttachmentDrag();
    if (canStageComposerAttachments() && files.length > 0) referenceLibrary.stageDraftFiles(files);
  };
  const onAttachmentPaste = (event: ClipboardEvent): void => {
    if (!canStageComposerAttachments()) return;
    const images = clipboardImageFiles(event.clipboardData);
    if (images.length === 0) return;
    event.preventDefault();
    referenceLibrary.stageDraftFiles(images);
  };
  root.addEventListener('dragenter', onAttachmentDragEnter);
  root.addEventListener('dragover', onAttachmentDragOver);
  root.addEventListener('dragleave', onAttachmentDragLeave);
  root.addEventListener('drop', onAttachmentDrop);
  input.addEventListener('paste', onAttachmentPaste);

  /* 집중 모드의 변경 사항 drawer. 대화 위의 오른쪽 가장자리에서 열리고,
     사이드바로 돌아가면 .ag-review 노드는 기존 inline 자리로 되돌아간다. */
  const reviewColumn = el('aside', 'ag-review-column');
  reviewColumn.id = 'ag-review-column';
  reviewColumn.setAttribute('aria-labelledby', 'ag-review-column-title');
  const reviewColumnHead = el('div', 'ag-review-column-head');
  const reviewColumnClose = el('button', 'ag-header-icon-btn ag-review-column-close');
  reviewColumnClose.type = 'button';
  reviewColumnClose.setAttribute('aria-label', '검토 닫기');
  reviewColumnClose.title = '검토 닫기';
  reviewColumnClose.appendChild(createIcon('close'));
  reviewColumnClose.addEventListener('click', () => {
    setReviewColCollapsed(true);
    environmentToggle.focus();
  });
  const reviewColumnHeading = el('div', 'ag-review-column-heading');
  const reviewColumnTitle = el('span', 'ag-review-column-title', '변경 사항');
  reviewColumnTitle.id = 'ag-review-column-title';
  const reviewColumnMeta = el('span', 'ag-review-column-meta', '');
  reviewColumnHeading.append(reviewColumnTitle, reviewColumnMeta);
  const reviewColumnUndo = el('button', 'ag-header-icon-btn ag-review-column-undo');
  reviewColumnUndo.type = 'button';
  reviewColumnUndo.hidden = true;
  reviewColumnUndo.setAttribute('aria-label', '승인한 변경 되돌리기');
  reviewColumnUndo.title = '승인한 변경 되돌리기';
  reviewColumnUndo.appendChild(createIcon('undo'));
  reviewColumnUndo.addEventListener('click', undoLatestAgentTurn);
  const reviewColumnActions = el('div', 'ag-review-column-actions');
  reviewColumnActions.append(reviewColumnUndo, reviewColumnClose);
  reviewColumnHead.append(reviewColumnHeading, reviewColumnActions);
  reviewColumn.appendChild(reviewColumnHead);
  // 버전 창은 변경 탭이 changes drawer 를 품으므로 drawer 보다 먼저 만든다.
  const versionManagerPage = versionController
    ? createVersionManagerPage(versionController)
    : null;
  const changesDrawer = createChangesDrawer({
    versionController,
    isEditing: () => bridge.getEditingLease().active || mergeResolverLocked,
    onNavigate: (item) => {
      const location = item.contextOnRight ?? item.path;
      if (location.paragraph === undefined) return;
      navigateToChange({ sectionIndex: location.section, paragraphIndex: location.paragraph, charOffset: 0 }, item.rightAnchor);
    },
    onWorkingDiff: (items) => {
      workingDiff = items;
      updateCompactChangesVisibility();
      updateReviewControl(bridge.pendingEdits.getChangeSets());
    },
  });
  reviewColumn.append(changesDrawer.element);
  changesDrawer.setCompactHost(compactChangesContent);
  updateCompactChangesVisibility();

  function scheduleChangesRefresh(): void {
    clearTimeout(changesRefreshTimer);
    // '커밋 전' diff 는 문서 전체 스냅샷+비교를 메인 스레드에서 한다. 대형 문서에서
    // 편집마다 디바운스가 짧으면 연속 입력 사이사이 무거운 비교가 계속 끼어들어
    // 입력이 장시간 멈춘다 — 문서가 클수록 디바운스를 늘려 휴지 뒤 한 번만 계산한다.
    const pageCount = getDocumentContext?.().pageCount ?? 0;
    const delay = pageCount > 60 ? 3000 : pageCount > 20 ? 1200 : 300;
    changesRefreshTimer = setTimeout(() => { void changesDrawer.refresh(); }, delay);
  }

  function navigateToChange(position: DocumentPosition, anchor?: DiffItem['rightAnchor']): void {
    if (!deps.navigateToChange) return;
    const navigate = () => {
      window.requestAnimationFrame(() => deps.navigateToChange?.(position, anchor));
    };
    if (fullscreen) setFullscreen(false, { then: navigate });
    else navigate();
  }

  const planColumn = el('aside', 'ag-plan-column');
  planColumn.id = 'ag-plan-column';
  planColumn.setAttribute('aria-labelledby', 'ag-plan-column-title');
  const planColumnHead = el('div', 'ag-plan-column-head');
  const planColumnHeading = el('div', 'ag-plan-column-heading');
  const planColumnTitle = el('span', 'ag-plan-column-title', '계획');
  planColumnTitle.id = 'ag-plan-column-title';
  const planColumnMeta = el('span', 'ag-plan-column-meta', '활성 계획 없음');
  planColumnHeading.append(planColumnTitle, planColumnMeta);
  const planColumnClose = el('button', 'ag-header-icon-btn ag-plan-column-close');
  planColumnClose.type = 'button';
  planColumnClose.setAttribute('aria-label', '계획 닫기');
  planColumnClose.title = '계획 닫기';
  planColumnClose.appendChild(createIcon('close'));
  planColumnClose.addEventListener('click', () => {
    setPlanColCollapsed(true);
    environmentToggle.focus();
  });
  planColumnHead.append(planColumnHeading, planColumnClose);
  planColumn.appendChild(planColumnHead);

  /* 레일과 변경 사항 drawer의 경계 폭 조절 손잡이. */
  const railResize = el('div', 'ag-rail-resize');
  railResize.setAttribute('role', 'separator');
  railResize.setAttribute('aria-orientation', 'vertical');
  railResize.setAttribute('aria-label', '채팅 목록 너비 조절');
  railResize.title = '드래그하여 너비 조절';
  railResize.tabIndex = 0;

  /* 설정 페이지 — 자기 DOM 은 settings.ts 가 짓고, 페이지 전환만
     여기서 관리한다(스킬 페이지와 같은 계약). */
  const settingsPanel = createSettingsPanel({
    bridge,
    eventBus,
    editorRuntime: editorSettingsRuntime ?? {
      preview: () => undefined,
      committed: () => undefined,
    },
    getSelection: () => ({
      agent: selectedAgent,
      model: selectedModel,
      effort: selectedEffort,
      permission: permissionProfile,
    }),
    applyDefaults: (prefs) => applyAgentPrefs(prefs),
    openCalibration: () => writingStyleCalibration.open(),
    reconnectSession: () => restartAgentSession(),
    skillsSettings: skillsShelf.root,
    refreshSkills: () => bridge.listSkills(),
  });
  const settingsPage = settingsPanel.element;
  if (active && initialSetupOwner === null) {
    initialSetup = maybeStartInitialSetup({
      openAgentSetup: (agent) => settingsPanel.openAgentSetup(agent),
      beginAgentConnect: (agent) => settingsPanel.beginAgentConnect(agent),
      openCalibration: (options) => writingStyleCalibration.open(options),
    });
    if (initialSetup) initialSetupOwner = root;
  }
  settingsPage.addEventListener('ag-settings-close-request', () => {
    void requestSettingsClose(fullscreen ? workspaceSettingsBtn : settingsBtn);
  });
  settingsPage.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    void requestSettingsClose(fullscreen ? workspaceSettingsBtn : settingsBtn);
  });

  const versionsPage = versionManagerPage?.element ?? el('section', 'ag-versions-page');
  if (!versionManagerPage) {
    versionsPage.id = 'ag-versions-panel';
    versionsPage.setAttribute('aria-hidden', 'true');
    versionsPage.inert = true;
  }
  if (versionManagerPage) {
    changesDrawer.setCompactHost(versionManagerPage.changesHost);
    updateCompactChangesVisibility();
  }
  versionsPage.addEventListener('ag-versions-close', () => {
    setVersionsPanelOpen(false);
    versionsBtn.focus();
  });

  const reviewResize = el('div', 'ag-review-resize');
  reviewResize.setAttribute('role', 'separator');
  reviewResize.setAttribute('aria-orientation', 'vertical');
  reviewResize.setAttribute('aria-label', '검토 칸 너비 조절');
  reviewResize.title = '드래그하여 너비 조절';
  reviewResize.tabIndex = 0;

  stage.append(
    workspaceBar,
    workspaceDrawerScrim,
    compactRailHoverTarget,
    chatPage,
    threadsPage,
    referenceLibrary.page,
    settingsPage,
    versionsPage,
    reviewColumn,
    planColumn,
    railResize,
    reviewResize,
  );

  function applyRailWidth(width: number, opts?: { persist?: boolean }): void {
    railWidth = clampRailWidth(width);
    root.style.setProperty('--ag-rail-w', `${railWidth}px`);
    railResize.setAttribute('aria-valuenow', String(railWidth));
    railResize.setAttribute('aria-valuemin', String(RAIL_WIDTH_MIN));
    railResize.setAttribute('aria-valuemax', String(maxRailWidth()));
    if (opts?.persist) persistRailWidth(railWidth);
  }

  function applyReviewWidth(width: number, opts?: { persist?: boolean }): void {
    reviewWidth = clampReviewWidth(width);
    root.style.setProperty('--ag-review-w', `${reviewWidth}px`);
    reviewResize.setAttribute('aria-valuenow', String(reviewWidth));
    reviewResize.setAttribute('aria-valuemin', String(REVIEW_WIDTH_MIN));
    reviewResize.setAttribute('aria-valuemax', String(maxReviewWidth()));
    if (opts?.persist) persistReviewWidth(reviewWidth);
  }

  /* 두 손잡이는 같은 드래그 문법을 쓴다 — 포인터를 캡처해 무대
     좌표계로 환산하고, 놓을 때만 저장한다. */
  let columnResizing: 'rail' | 'review' | null = null;
  let columnResizePointerId: number | null = null;

  function columnHandle(kind: 'rail' | 'review'): HTMLElement {
    return kind === 'rail' ? railResize : reviewResize;
  }

  function detachColumnResizeWindowListeners(): void {
    window.removeEventListener('pointermove', onColumnResizePointerMove, true);
    window.removeEventListener('pointerup', endColumnResize, true);
    window.removeEventListener('pointercancel', endColumnResize, true);
    window.removeEventListener('blur', onColumnResizeWindowBlur);
  }

  function onColumnResizeWindowBlur(): void {
    endColumnResize();
  }

  function beginColumnResize(kind: 'rail' | 'review', e: PointerEvent): void {
    if (!fullscreen) return;
    // 이미 한 손가락이 끌고 있으면 두 번째 손가락은 무시한다.
    if (columnResizing) return;
    if (e.button !== 0 && e.pointerType !== 'touch') return;
    e.preventDefault();
    e.stopPropagation();
    columnResizing = kind;
    columnResizePointerId = e.pointerId;
    try {
      columnHandle(kind).setPointerCapture(e.pointerId);
    } catch {
      /* 캡처를 못 얻어도 pointermove 는 손잡이 위에서 계속 온다 */
    }
    root.classList.add('ag-col-resizing');
    setPageClass('ag-col-resizing', true);
    // The divider moves with the grid, so pointer events must continue even
    // after the cursor leaves its narrow hit target or pointer capture fails.
    window.addEventListener('pointermove', onColumnResizePointerMove, true);
    window.addEventListener('pointerup', endColumnResize, true);
    window.addEventListener('pointercancel', endColumnResize, true);
    window.addEventListener('blur', onColumnResizeWindowBlur);
  }

  function onColumnResizePointerMove(e: PointerEvent): void {
    if (!columnResizing) return;
    // 드래그를 시작한 포인터가 아니면 흘려보낸다.
    if (e.pointerId !== columnResizePointerId) return;
    e.preventDefault();
    const rect = stage.getBoundingClientRect();
    if (columnResizing === 'rail') applyRailWidth(e.clientX - rect.left);
    else applyReviewWidth(rect.right - e.clientX);
  }

  function endColumnResize(e?: PointerEvent): void {
    if (!columnResizing) {
      detachColumnResizeWindowListeners();
      root.classList.remove('ag-col-resizing');
      setPageClass('ag-col-resizing', false);
      return;
    }
    // 다른 손가락이 뗀 것이라면 진행 중인 드래그를 끝내지 않는다.
    if (e && e.pointerId !== columnResizePointerId) return;
    const kind = columnResizing;
    const pointerId = e?.pointerId ?? columnResizePointerId;
    columnResizing = null;
    columnResizePointerId = null;
    detachColumnResizeWindowListeners();
    root.classList.remove('ag-col-resizing');
    setPageClass('ag-col-resizing', false);
    const handle = columnHandle(kind);
    try {
      if (pointerId !== null && handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId);
      }
    } catch {
      /* the pointer may already be gone after a window blur */
    }
    if (kind === 'rail') applyRailWidth(railWidth, { persist: true });
    else applyReviewWidth(reviewWidth, { persist: true });
  }

  function onColumnResizeKeyDown(kind: 'rail' | 'review', e: KeyboardEvent): void {
    if (!fullscreen) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    // 손잡이가 눌린 방향으로 움직인다 — 검토 칸은 왼쪽 모서리라 반대다.
    const delta = e.key === 'ArrowRight' ? 16 : -16;
    if (kind === 'rail') applyRailWidth(railWidth + delta, { persist: true });
    else applyReviewWidth(reviewWidth - delta, { persist: true });
  }

  for (const kind of ['rail', 'review'] as const) {
    const handle = columnHandle(kind);
    handle.addEventListener('pointerdown', (e) => beginColumnResize(kind, e));
    handle.addEventListener('keydown', (e) => onColumnResizeKeyDown(kind, e));
  }

  /**
   * 전체 화면은 대화 목록 + 대화가 기본인 agent-focus 무대다.
   * 변경 사항은 환경 패널에서만 여는 오른쪽 drawer다.
   */
  /* 스레드 레일 접기 — 전체 화면에서만 뜻이 있다. 헤더의 목록
     버튼이 토글이고, 접힘 여부는 사이드바 폭처럼 세션 간 유지된다. */
  function applyThreadsRailState(): void {
    const compact = isCompactWorkspace();
    const expanded = fullscreen && (compact ? compactThreadsRailOpen : !threadsRailCollapsed);
    root.classList.toggle('ag-compact-rail-open', compact && compactThreadsRailOpen);
    root.classList.toggle('ag-compact-rail-hover-open', compact && compactRailHoverOpen);
    root.classList.toggle('ag-rail-collapsed', fullscreen && !expanded);
    if (!fullscreen) return;
    if (!expanded) closeThreadRailSurfaces(root);
    threadsBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    threadsBtn.title = expanded ? '채팅 목록 접기' : '채팅 목록 열기';
    threadsBtn.setAttribute('aria-label', threadsBtn.title);
    threadsPage.setAttribute('aria-hidden', expanded ? 'false' : 'true');
    workspaceThreadsBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    workspaceThreadsBtn.title = expanded ? '대화 목록 접기' : '대화 목록 열기';
    workspaceThreadsBtn.setAttribute('aria-label', workspaceThreadsBtn.title);
  }

  /**
   * 입력기 주변에서 펼쳐지는 면(커밋 전 변경, 계획, 모델 설정)은 한 번에 하나만 펼친다.
   * 하나를 펼치면 나머지는 접힌다 — 계획은 지우지 않고 '계획' 알약으로 접는다.
   */
  function collapseExpandedSurfaces(keep: 'changes' | 'plan' | 'config'): void {
    if (keep !== 'changes' && compactChangesOpen) setCompactChangesOpen(false);
    if (keep !== 'config' && configPanelOpen) setConfigPanelOpen(false);
    if (keep !== 'plan' && !fullscreen && activePlan !== null && !planMinimized && !planSurface.hidden) {
      setPlanMinimized(true);
    }
  }

  function isCompactWorkspace(): boolean {
    return fullscreen && workspaceCompact;
  }

  function setCompactChangesOpen(open: boolean): void {
    const next = open && !fullscreen && !compactChanges.hidden;
    if (compactChangesOpen === next) return;
    compactChangesOpen = next;
    if (next) collapseExpandedSurfaces('changes');
    compactChangesContent.hidden = !next;
    compactChangesToggle.setAttribute('aria-expanded', String(next));
    compactChanges.classList.toggle('ag-open', next);
    if (next) void changesDrawer.refresh();
  }

  /** 커밋 전 변경이 사는 곳 — 버전 창의 변경 탭. 버전 창이 없으면 예전 입력기 위 막대. */
  function compactChangesHost(): HTMLElement {
    return versionManagerPage?.changesHost ?? compactChangesContent;
  }

  function updateCompactChangesVisibility(): void {
    const state = versionController?.getState();
    const dirty = Boolean(state?.saved && state.enabled && state.dirty);
    // 입력기 위 막대 대신 헤더 버전 아이콘의 숫자와 변경 탭으로 보인다.
    const inVersionsTab = versionManagerPage !== null;
    compactChanges.hidden = inVersionsTab || fullscreen || !dirty;
    compactChangesCount.textContent = workingDiff.length ? `${workingDiff.length}건` : '';
    if (compactChanges.hidden) setCompactChangesOpen(false);
    const count = dirty ? workingDiff.length : 0;
    versionsBadge.hidden = !dirty;
    versionsBadge.textContent = count > 99 ? '99+' : count > 0 ? String(count) : '';
    versionsBadge.classList.toggle('ag-dot-only', dirty && count === 0);
    const label = dirty ? `버전 · 커밋 전 변경 ${count}` : '버전';
    versionsBtn.setAttribute('aria-label', label);
    versionsBtn.title = label;
    versionManagerPage?.setChangeCount(dirty ? Math.max(count, 1) : 0);
  }

  function clearCompactRailHoverClose(): void {
    if (compactRailHoverCloseTimer === null) return;
    window.clearTimeout(compactRailHoverCloseTimer);
    compactRailHoverCloseTimer = null;
  }

  function clearCompactRailHoverOpen(): void {
    if (compactRailHoverOpenTimer === null) return;
    window.clearTimeout(compactRailHoverOpenTimer);
    compactRailHoverOpenTimer = null;
  }

  function setCompactThreadsRailOpen(open: boolean, opts?: { focus?: boolean }): void {
    clearCompactRailHoverOpen();
    clearCompactRailHoverClose();
    compactThreadsRailOpen = isCompactWorkspace() && open;
    if (!compactThreadsRailOpen) compactRailHoverOpen = false;
    if (compactThreadsRailOpen) {
      reviewColCollapsed = true;
      planColCollapsed = true;
      applyReviewColState();
      if (environmentPanelOpen) setEnvironmentPanelOpen(false, { persist: false });
    }
    applyThreadsRailState();
    if (compactThreadsRailOpen) {
      rebuildThreadsList();
      if (opts?.focus !== false) {
        window.requestAnimationFrame(() => threadsToolbar.search.focus({ preventScroll: true }));
      }
    }
  }

  function scheduleCompactRailHoverClose(): void {
    if (!compactRailHoverOpen) return;
    clearCompactRailHoverClose();
    compactRailHoverCloseTimer = window.setTimeout(() => {
      compactRailHoverCloseTimer = null;
      // 문서 필터·문서 열기 팝오버는 레일 밖에 떠 있어도 레일의 일부다.
      if (!compactRailHoverOpen || threadsPage.contains(document.activeElement) || threadRailSurfaceOpen(root)) return;
      setCompactThreadsRailOpen(false);
    }, 100);
  }

  const onCompactRailPointerMove = (event: PointerEvent) => {
    compactRailLastPointerX = event.clientX;
  };
  const onCompactRailPointerExit = () => {
    compactRailLastPointerX = null;
    clearCompactRailHoverOpen();
  };
  const onCompactRailEdgeEnter = (event: PointerEvent) => {
    if (!isCompactWorkspace()) return;
    if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) return;
    if (compactRailLastPointerX === null || event.clientX >= compactRailLastPointerX) return;
    clearCompactRailHoverOpen();
    clearCompactRailHoverClose();
    compactRailHoverOpenTimer = window.setTimeout(() => {
      compactRailHoverOpenTimer = null;
      if (!isCompactWorkspace()) return;
      compactRailHoverOpen = true;
      setCompactThreadsRailOpen(true, { focus: false });
    }, COMPACT_RAIL_HOVER_OPEN_DELAY_MS);
  };
  const onCompactRailEdgeLeave = (event: PointerEvent) => {
    clearCompactRailHoverOpen();
    if (event.relatedTarget instanceof Node && threadsPage.contains(event.relatedTarget)) return;
    scheduleCompactRailHoverClose();
  };
  const onCompactRailPointerEnter = () => {
    clearCompactRailHoverOpen();
    clearCompactRailHoverClose();
  };
  const onCompactRailPointerLeave = (event: PointerEvent) => {
    if (event.relatedTarget instanceof Node && compactRailHoverTarget.contains(event.relatedTarget)) return;
    scheduleCompactRailHoverClose();
  };
  compactRailHoverTarget.addEventListener('pointerenter', onCompactRailEdgeEnter);
  compactRailHoverTarget.addEventListener('pointerleave', onCompactRailEdgeLeave);
  threadsPage.addEventListener('pointerenter', onCompactRailPointerEnter);
  threadsPage.addEventListener('pointerleave', onCompactRailPointerLeave);
  root.addEventListener('pointermove', onCompactRailPointerMove, { passive: true });
  root.addEventListener('pointerleave', onCompactRailPointerExit);

  function setThreadsRailCollapsed(collapsed: boolean): void {
    threadsRailCollapsed = collapsed;
    persistThreadsRailCollapsed(collapsed);
    applyThreadsRailState();
    // 접혀 있는 동안 문서가 바뀌었을 수 있다 — 다시 펼칠 때 새로 그린다.
    if (fullscreen && !collapsed) rebuildThreadsList();
  }

  /* 검토 drawer는 대화를 가리거나 composer를 옮기지 않는다. */
  function applyReviewColState(): void {
    // 나가는 애니메이션 중에도 전체 화면 DOM은 아직 유효하다.
    const focusLayoutActive = fullscreen || root.classList.contains('ag-fullscreen');
    const planActive = focusLayoutActive && !planColCollapsed && activePlan !== null;
    const changesActive = focusLayoutActive && !reviewColCollapsed && !planActive;
    const detailActive = changesActive || planActive;
    root.classList.toggle('ag-review-collapsed', focusLayoutActive && !changesActive);
    root.classList.toggle('ag-plan-collapsed', focusLayoutActive && !planActive);
    root.classList.toggle('ag-review-drawer-open', changesActive);
    root.classList.toggle('ag-plan-drawer-open', planActive);
    root.classList.toggle('ag-detail-drawer-open', detailActive);
    environmentChanges.classList.toggle('ag-active', changesActive);
    environmentChanges.setAttribute('aria-expanded', changesActive ? 'true' : 'false');
    environmentPlan.classList.toggle('ag-active', planActive);
    environmentPlan.setAttribute('aria-expanded', planActive ? 'true' : 'false');
    reviewColumn.setAttribute('aria-hidden', changesActive ? 'false' : 'true');
    reviewColumn.inert = !changesActive;
    changesDrawer.setOpen(changesActive);
    planColumn.setAttribute('aria-hidden', planActive ? 'false' : 'true');
    planColumn.inert = !planActive;
    reviewResize.setAttribute('aria-hidden', detailActive ? 'false' : 'true');
    reviewResize.tabIndex = detailActive ? 0 : -1;
    reviewResize.inert = !detailActive;
    if (focusLayoutActive) {
      chatPage.setAttribute('aria-hidden', 'false');
      if (composer.parentElement !== chatPage) chatPage.append(followUpStrip.root, questionController.root, composer);
    }
    applyPlanMinimizedState();
  }

  function setReviewColCollapsed(collapsed: boolean): void {
    reviewColCollapsed = collapsed;
    if (!collapsed) {
      planColCollapsed = true;
      if (isCompactWorkspace()) setCompactThreadsRailOpen(false);
    }
    applyReviewColState();
  }

  function setPlanColCollapsed(collapsed: boolean): void {
    planColCollapsed = collapsed;
    if (!collapsed) {
      reviewColCollapsed = true;
      if (isCompactWorkspace()) setCompactThreadsRailOpen(false);
    }
    applyReviewColState();
  }

  function dismissCompactDrawers(target: Node): void {
    const environmentOwnFocus = environmentPanel.contains(target) || environmentToggle.contains(target);
    if (environmentPanelOpen && !environmentOwnFocus) {
      setEnvironmentPanelOpen(false, { persist: false });
    }
    if (!isCompactWorkspace()) return;

    const threadsOwnFocus = threadsPage.contains(target)
      || workspaceThreadsBtn.contains(target)
      || threadsBtn.contains(target);
    if (compactThreadsRailOpen && !threadsOwnFocus) setCompactThreadsRailOpen(false);

    const detailOwnFocus = reviewColumn.contains(target) || planColumn.contains(target);
    if (root.classList.contains('ag-detail-drawer-open') && !detailOwnFocus) {
      reviewColCollapsed = true;
      planColCollapsed = true;
      applyReviewColState();
    }
  }

  const onCompactDrawerPointerDown = (event: PointerEvent) => {
    if (active) dismissCompactDrawers(event.target as Node);
  };
  const onCompactDrawerFocusIn = (event: FocusEvent) => {
    if (active) dismissCompactDrawers(event.target as Node);
  };
  document.addEventListener('pointerdown', onCompactDrawerPointerDown, true);
  document.addEventListener('focusin', onCompactDrawerFocusIn);

  function syncComposerOverlay(): void {
    const hasPlanRestore = !fullscreen && planMinimized && activePlan !== null;
    composerOverlay.classList.remove('ag-has-activity');
    composerOverlay.classList.toggle('ag-has-plan-restore', hasPlanRestore);
  }

  function applyPlanMinimizedState(): void {
    const compact = !fullscreen && planMinimized && activePlan !== null;
    planSurface.classList.toggle('ag-plan-minimized', compact);
    planCardSlot.setAttribute('aria-hidden', compact ? 'true' : 'false');
    planCardSlot.inert = compact;
    renderPlanTimeline();
    const restoreLabel = activePlanHistorical ? '계획 기록 펼치기' : '계획 펼치기';
    planRestore.setAttribute('aria-label', restoreLabel);
    planRestore.title = restoreLabel;
    // 접힌 계획 줄은 흐름 안의 한 줄이다 — 대화 위에 떠서 글자를 덮지 않는다.
    planRestore.hidden = !compact;
    planRestore.setAttribute('aria-hidden', compact ? 'false' : 'true');
    planRestore.inert = !compact;
    syncComposerOverlay();
  }

  /** 접힌 계획 줄을 지금 todo 상태로 다시 그린다. */
  function renderPlanTimeline(): void {
    const plan = activePlan;
    const todos = plan ? planTodos(plan) : [];
    const running = !activePlanHistorical && plan?.execution?.status === 'running';
    const current = plan?.execution
      ? todos.find((todo) => todo.status === 'in-progress')
        ?? todos.find((todo) => todo.status === 'blocked')
        ?? todos.find((todo) => todo.status === 'pending')
      : undefined;
    const done = todos.filter((todo) => todo.status === 'completed').length;
    const allDone = plan?.execution !== undefined && todos.length > 0 && done === todos.length;
    const status: PlanTodoStatus = allDone ? 'completed'
      : current?.status === 'in-progress' && !running ? 'pending' : current?.status ?? 'pending';
    planRestoreMark.replaceChildren(todoMark(status));
    planRestoreLabel.textContent = activePlanHistorical ? `계획 기록 · ${plan?.title ?? ''}`
      : current ? current.title
        : allDone ? '모든 할 일을 마쳤습니다'
          : plan?.title || '계획';
    planRestore.dataset.status = status;
    planRestoreTrack.replaceChildren(...(plan?.execution ? todos.slice(0, 24) : []).map((todo) => {
      const tick = el('span', 'ag-plan-restore-tick');
      tick.dataset.status = todo.status;
      return tick;
    }));
    planRestoreCount.textContent = plan?.execution ? `${done}/${todos.length}` : '';
  }

  function setPlanMinimized(minimized: boolean): void {
    planMinimized = minimized;
    if (!minimized) collapseExpandedSurfaces('plan');
    applyPlanMinimizedState();
    if (!minimized) {
      window.requestAnimationFrame(() => {
        planCardSlot.querySelector<HTMLElement>('.ag-plan-card')?.focus({ preventScroll: true });
      });
    }
  }

  function updateReviewControl(changeSets: readonly PendingChangeSet[]): void {
    const pending = summarizePendingDiffs(changeSets);
    pendingReviewOpCount = pending.opCount;
    const working = summarizeDiffItems(workingDiff);
    const diff = pending.opCount > 0 ? pending : {
      additions: working.additions, deletions: working.deletions,
      nonTextChanges: workingDiff.filter((item) => item.kind !== 'text').length,
    };
    const hasPending = pendingReviewOpCount > 0;
    const hasOtherChanges = !hasPending && workingDiff.length === 0 && versionController?.getState().dirty === true;
    reviewColumnTitle.textContent = '변경 사항';
    reviewColumnMeta.textContent = hasPending
      ? `검토 대기 ${pendingReviewOpCount}`
      : workingDiff.length ? `커밋 전 ${workingDiff.length}` : hasOtherChanges ? '커밋 전' : '';
    const hasTextDiff = diff.additions > 0 || diff.deletions > 0;
    environmentAdditions.hidden = diff.additions === 0;
    environmentAdditions.textContent = `+${diff.additions.toLocaleString('ko-KR')}`;
    environmentDeletions.hidden = diff.deletions === 0;
    environmentDeletions.textContent = `−${diff.deletions.toLocaleString('ko-KR')}`;
    environmentDiffNeutral.hidden = hasTextDiff;
    environmentDiffNeutral.textContent = hasPending
      ? `${diff.nonTextChanges || pendingReviewOpCount}개 변경`
      : workingDiff.length ? `${workingDiff.length}개 변경` : hasOtherChanges ? '변경 있음' : '변경 없음';
    environmentChanges.setAttribute(
      'aria-label',
      hasPending || workingDiff.length > 0
        ? `변경 사항 열기, 추가 ${diff.additions}자, 삭제 ${diff.deletions}자, 기타 ${diff.nonTextChanges}개`
        : hasOtherChanges ? '변경 사항 열기, 커밋되지 않은 변경' : '변경 사항 열기, 대기 중인 변경 없음',
    );
    const hasPlan = activePlan !== null && chatWorkflow === 'plan';
    environmentPlan.disabled = !hasPlan;
    environmentPlanTitle.textContent = hasPlan ? activePlan?.title || '' : '';
    environmentPlanStatus.textContent = hasPlan ? PLANNING_PHASE_LABEL[planningPhase] : '없음';
    environmentPlan.setAttribute(
      'aria-label',
      hasPlan
        ? `계획 열기, ${activePlan?.title || '제목 없는 계획'}, ${PLANNING_PHASE_LABEL[planningPhase]}`
        : '계획 없음',
    );
    planColumnMeta.textContent = hasPlan ? PLANNING_PHASE_LABEL[planningPhase] : '활성 계획 없음';
    applyReviewColState();
  }

  /* 전체 화면 전환. 새 화면을 짓지 않고 무대의 배치만 바꾼다.
     스레드·대화는 안정적인 shell로 남고 검토는 오른쪽 drawer로 옮긴다.
     DOM을 재생성하지 않으므로 스레드·모델·승인 상태가 모두 이어진다.

     전환은 한 번의 교차 페이드다. View Transition 이 바뀌기 전·후 화면을
     잡고, 작업 공간 쪽만 0.985 ↔ 1 로 살짝 커지거나 줄어든다. 지원하지
     않는 엔진이나 동작 줄이기 설정에서는 즉시 바뀐다. */
  type FsViewTransition = { finished: Promise<void>; skipTransition(): void };
  let fsTransition: FsViewTransition | null = null;

  function clearFsTransitionClasses(): void {
    if (active) document.documentElement.classList.remove('ag-fs-vt', 'ag-fs-vt-enter', 'ag-fs-vt-exit');
    root.classList.remove('ag-fs-motion');
  }

  function cancelFsMotionTimers(): void {
    const transition = fsTransition;
    fsTransition = null;
    transition?.skipTransition();
    clearFsTransitionClasses();
  }

  /** 전체 화면 무대를 걷고 사이드바 배치로 되돌린다. */
  function restoreSidebarLayout(): void {
    endColumnResize();
    applyThreadsRailState();
    applyReviewColState();
    threadsBtn.setAttribute('aria-expanded', 'false');
    threadsBtn.title = '채팅 목록';
    threadsBtn.setAttribute('aria-label', '채팅 목록');
    reviewColumn.setAttribute('aria-hidden', 'true');
    planColumn.setAttribute('aria-hidden', 'true');
    threadsPage.setAttribute('aria-hidden', 'true');
    chatPage.setAttribute('aria-hidden', 'false');
    // 변경 검토·계획·질문·입력기는 다시 사이드바의 분리된 inline 흐름으로 돌아간다.
    chatPage.append(review, compactChanges, planSurface, planRestore, followUpStrip.root, questionController.root, composer);
    changesDrawer.setCompactHost(compactChangesHost());
    updateCompactChangesVisibility();
    applyPlanMinimizedState();
  }

  /** 지금 DOM 에 반영된 집중 모드 배치. 교차 페이드는 다음 프레임에 배치를 바꾼다. */
  let fullscreenLayoutOn = false;

  function applyFullscreenLayout(on: boolean): void {
    fullscreenLayoutOn = on;
    root.classList.toggle('ag-fullscreen', on);
    setPageClass('ag-fullscreen-open', on);
    syncFocusGreeting();
    applyEnvironmentPanelState();
    fullscreenBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    fullscreenBtn.setAttribute('aria-label', on ? '사이드바로 돌아가기' : '에이전트 집중 모드');
    fullscreenBtn.title = on ? '사이드바로 돌아가기 (Esc)' : '에이전트 집중 모드';
    const nextIcon = createIcon(on ? 'contract' : 'expand');
    fullscreenIcon.replaceWith(nextIcon);
    fullscreenIcon = nextIcon;

    if (!on) {
      // 집중 모드를 닫으면 보내지 않은 초안은 버리고 앞 채팅으로 돌아간다.
      discardDraft();
      restoreSidebarLayout();
      setConfigPanelOpen(false);
      measure();
      // 용지는 즉시 제자리로 옮긴다 — 교차 페이드가 이미 두 화면을 잇는다.
      // 여기서 슬라이드를 한 번 더 걸면 페이드 아래에서 두 번째 움직임이 된다.
      startInsetRecenterLoop({ instant: true });
      scrollConversationToEnd();
      return;
    }

    // 접힌 상태에서 바로 펼칠 수 있어야 한다.
    setCollapsed(false, { recenter: false });
    // 페이지 전환 상태를 걷어내고 레일 + 대화 무대를 세운다.
    threadsPanelOpen = false;
    skillsPanelOpen = false;
    closeSettingsPage();
    closeVersionsPage();
    root.classList.remove('ag-threads-open', 'ag-skills-open');
    threadsBtn.setAttribute('aria-expanded', 'false');
    skillsBtn.setAttribute('aria-expanded', 'false');
    chatPage.setAttribute('aria-hidden', 'false');
    skillsPage.setAttribute('aria-hidden', 'true');
    threadsPage.setAttribute('aria-hidden', 'false');
    rebuildThreadsList();
    // 칸 폭은 클래스 규칙이 아니라 인라인 변수로 산다.
    applyRailWidth(railWidth, { persist: false });
    applyReviewWidth(reviewWidth, { persist: false });
    // 변경 사항과 계획은 각각의 환경 drawer에 둔다.
    setCompactChangesOpen(false);
    changesDrawer.setCompactHost(null);
    updateCompactChangesVisibility();
    changesDrawer.reviewSlot.appendChild(review);
    planColumn.appendChild(planSurface);
    reviewColCollapsed = true;
    planColCollapsed = true;
    applyThreadsRailState();
    applyReviewColState();

    setConfigPanelOpen(false);
    // 인라인 top/bottom 을 모드에 맞게 다시 잰다.
    measure();
    // 문서가 가려지거나 다시 드러나므로 용지 정렬을 즉시 다시 잡는다.
    startInsetRecenterLoop({ instant: true });
    scrollConversationToEnd();
  }

  /** `then` 은 새 배치가 DOM 에 반영된 뒤에 부른다 — 교차 페이드는
      다음 프레임에 배치를 바꾸므로, 바뀐 배치에 기대는 후속 동작은 여기로 넘긴다. */
  function setFullscreen(on: boolean, opts?: { then?: () => void }): void {
    if (fullscreen === on) {
      opts?.then?.();
      return;
    }
    if (on && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(undefined, () => setFullscreen(true, opts));
      return;
    }
    fullscreen = on;
    // 집중 화면은 늘 환경 패널을 닫은 채로 연다. 열고 싶으면 머리말의 토글로 연다.
    if (on) {
      environmentPanelOpen = false;
      threadsRailCollapsed = true;
      compactThreadsRailOpen = false;
    }
    closeThreadRailSurfaces(root);
    // 두 모드의 쉬는 모양이 달라서, 화면 전환은 펼친 입력기로 시작한다.
    composerRest.setResting(false);

    const startViewTransition = (document as unknown as {
      startViewTransition?: (update: () => void) => FsViewTransition;
    }).startViewTransition;
    // 교차 페이드는 페이지 전체를 잡으므로 화면에 붙은 사이드바만 건다.
    const animate = active
      && typeof startViewTransition === 'function'
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!animate) {
      cancelFsMotionTimers();
      // 즉시 바꿀 때도 패널 슬라이드·칸 전환이 새 배치 위에서 돌지 않게 한다.
      root.classList.add('ag-fs-motion');
      applyFullscreenLayout(on);
      opts?.then?.();
      void root.offsetHeight;
      root.classList.remove('ag-fs-motion');
      return;
    }

    const html = document.documentElement;
    html.classList.remove('ag-fs-vt-enter', 'ag-fs-vt-exit');
    html.classList.add('ag-fs-vt', on ? 'ag-fs-vt-enter' : 'ag-fs-vt-exit');
    root.classList.add('ag-fs-motion');
    // 새 전환이 앞선 전환을 건너뛰게 한다. 앞선 update 는 그래도 불리지만
    // 모드가 이미 다시 바뀌었으면 마지막 요청만 배치에 반영한다.
    const transition = startViewTransition.call(document, () => {
      if (fullscreen !== on) return;
      // 그사이 사이드바가 화면에서 내려가며 배치를 먼저 맞췄을 수 있다.
      if (fullscreenLayoutOn !== on) applyFullscreenLayout(on);
      opts?.then?.();
    });
    fsTransition = transition;
    void transition.finished.catch(() => {}).then(() => {
      if (fsTransition !== transition) return;
      fsTransition = null;
      clearFsTransitionClasses();
    });
  }

  /** 사용자에게 보이는 현재 모드. */
  function currentMode(): AgentMode {
    return agentModeFor(chatWorkflow, planningPhase, permissionProfile);
  }

  function updateModeChip(): void {
    const planRun = chatWorkflow === 'plan' && planningPhase === 'implementing';
    modeMenu.update({
      mode: currentMode(),
      disabled: isControlLocked() || connState !== 'connected',
      hint: planRun ? '승인한 계획을 실행 중' : (chatModeLockReason ?? ''),
      chatOnlyReason: chatModeLockReason,
    });
    refreshSidebarWidthMin();
  }

  /**
   * 모드 전환. 모드는 (workflow, 권한 프로필) 한 쌍이고, 허브에는 두 전환을 차례로 보낸다
   * (허브가 같은 전환 큐에서 순서대로 처리한다). 전체로 들어갈 때만 확인 시트를 띄운다.
   */
  async function requestMode(next: AgentMode): Promise<boolean> {
    if (modeBlockedByLock(next)) return false;
    if (modeNeedsConfirmation(next)) {
      const confirmed = await confirmSheet(modeMenu.trigger, '전체 접근', '승인 없이 편집하고 파일에 접근합니다.', { confirmLabel: '켜기' });
      if (!confirmed) return false;
    }
    return switchMode(next);
  }

  /** 전체 접근으로 넘어가는 전환만 확인을 받는다. */
  function modeNeedsConfirmation(next: AgentMode): boolean {
    return agentModeTarget(next).permissionProfile === 'unrestricted'
      && permissionProfile !== 'unrestricted';
  }

  /** 같은 문서의 다른 채팅이 편집하는 동안에는 채팅 말고는 고를 수 없다 — 칩이 이유를 보인다. */
  function modeBlockedByLock(next: AgentMode): boolean {
    if (chatModeLockReason === null || next === 'chat') return false;
    updateModeChip();
    return true;
  }

  /** 확인이 끝난 모드 전환. 전환을 시작했거나 이미 그 모드면 true. */
  function switchMode(next: AgentMode): boolean {
    const target = agentModeTarget(next);
    if (modeBlockedByLock(next)) return false;
    if (next === currentMode()) {
      input.focus();
      return true;
    }
    if (draftChat) {
      setDraftMode(next);
      input.focus();
      return true;
    }
    if (isControlLocked() || connState !== 'connected') {
      systemMessage(turnRunning ? '실행 중에는 모드를 바꿀 수 없습니다.' : '전환 중에는 모드를 바꿀 수 없습니다.');
      return false;
    }
    const restartCompletedPlan = target.workflow === 'plan' && chatWorkflow === 'plan' && planningPhase === 'implementing';
    if (target.workflow !== chatWorkflow || restartCompletedPlan) {
      return requestWorkflow(target.workflow, target.permissionProfile);
    }
    if (target.permissionProfile !== permissionProfile) sendPermissionProfile(target.permissionProfile);
    input.focus();
    return true;
  }

  /** 초안의 모드 — 허브 채팅이 아직 없으므로 첫 메시지를 보낼 때 이 모드로 연다. */
  function setDraftMode(next: AgentMode): void {
    const target = agentModeTarget(next);
    permissionProfile = target.permissionProfile;
    applyWorkflow(target.workflow);
  }

  /** 열린 채팅을 조용히 채팅 모드로 옮긴다. 결과는 workflow-changed 로 온다. */
  function forceChatWorkflow(): void {
    const target = agentModeTarget('chat');
    if (chatWorkflow !== target.workflow) {
      workflowTransitionPending = true;
      bridge.setWorkflow(target.workflow);
    }
    if (permissionProfile !== target.permissionProfile) sendPermissionProfile(target.permissionProfile);
    updateComposer();
  }

  /** 편집기가 알려 준 잠금을 다시 읽는다. 풀려도 모드는 그대로 둔다. */
  function readChatModeLock(): void {
    let lock: { reason: string } | null = null;
    try {
      lock = chatModeLock?.get() ?? null;
    } catch (error) {
      console.warn('[agent-sidebar] 채팅 모드 잠금을 읽지 못했습니다:', error);
    }
    const reason = lock ? lock.reason : null;
    if (reason !== chatModeLockReason) {
      chatModeLockReason = reason;
      // 잠금이 새로 걸리면 그 상태에서 한 번 더 옮겨 본다.
      chatModeLockForcedThreadId = null;
      if (!slashMenu.hidden) rebuildSlashMenu();
      updateModeChip();
    }
    enforceChatModeLock();
  }

  /** 상태가 가라앉은 뒤 한 번만 확인한다 — 입력기를 갱신할 때마다 부른다. */
  function scheduleChatModeLockCheck(): void {
    if (chatModeLockReason === null || chatModeLockCheckQueued) return;
    chatModeLockCheckQueued = true;
    queueMicrotask(() => {
      chatModeLockCheckQueued = false;
      enforceChatModeLock();
    });
  }

  /**
   * 잠겨 있는데 채팅 모드가 아니면 채팅 모드로 옮긴다. 이 채팅의 턴이 돌거나 전환 중이면
   * 끝난 뒤 입력기 갱신이 다시 부른다.
   */
  function enforceChatModeLock(): void {
    if (chatModeLockReason === null || root.dataset.disposed === 'true') return;
    if (currentMode() === 'chat') return;
    if (draftChat) {
      setDraftMode('chat');
      return;
    }
    if (readOnlyDocLabel !== null || turnRunning || isControlLocked() || connState !== 'connected') return;
    if (chatModeLockForcedThreadId === currentThread.id) return;
    chatModeLockForcedThreadId = currentThread.id;
    forceChatWorkflow();
  }

  function sendPermissionProfile(profile: PermissionProfile): void {
    if (bridge.getActiveAgent() === null) {
      // 세션 전에는 허브가 받을 곳이 없다 — 다음 startChat 이 이 프로필로 연다.
      permissionProfile = profile;
      updateModeChip();
      return;
    }
    workflowTransitionPending = true;
    updateComposer();
    try {
      bridge.setPermissionProfile(profile);
    } catch (err) {
      workflowTransitionPending = false;
      updateComposer();
      systemMessage(`모드 전환 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  updateModeChip();

  /** 스킬·설정·목록 세 페이지는 서로를 닫는다 — 무대에는 하나만 선다. */
  function closeSettingsPage(): void {
    settingsPanelOpen = false;
    root.classList.remove('ag-settings-open');
    settingsBtn.setAttribute('aria-expanded', 'false');
    workspaceSettingsBtn.setAttribute('aria-expanded', 'false');
    workspaceSettingsBtn.classList.remove('ag-active');
    workspaceTitle.textContent = '';
    settingsPage.setAttribute('aria-hidden', 'true');
    settingsPanel.close();
  }

  async function requestSettingsClose(
    returnFocus?: HTMLElement,
    afterClose?: () => void,
  ): Promise<boolean> {
    if (!settingsPanelOpen) {
      afterClose?.();
      return true;
    }
    if (!await settingsPanel.requestClose()) return false;
    closeSettingsPage();
    chatPage.setAttribute('aria-hidden', 'false');
    root.classList.remove('ag-settings-open');
    returnFocus?.focus();
    afterClose?.();
    return true;
  }

  function closeVersionsPage(): void {
    versionsPanelOpen = false;
    root.classList.remove('ag-versions-open');
    versionsBtn.setAttribute('aria-expanded', 'false');
    versionsPage.setAttribute('aria-hidden', 'true');
    versionsPage.inert = true;
    chatPage.inert = false;
    versionManagerPage?.close();
  }

  function setSkillsPanelOpen(open: boolean): void {
    if (open) {
      if (settingsPanelOpen && settingsPanel.isDirty()) {
        void requestSettingsClose(undefined, () => setSkillsPanelOpen(true));
        return;
      }
      setSettingsPanelOpen(true, 'skills');
      return;
    }
    if (open && referenceLibrary.isOpen()) referenceLibrary.setOpen(false);
    skillsPanelOpen = open;
    if (open) setConfigPanelOpen(false);
    threadsPanelOpen = false;
    closeSettingsPage();
    closeVersionsPage();
    root.classList.toggle('ag-skills-open', open);
    root.classList.remove('ag-threads-open');
    skillsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    skillsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (fullscreen) {
      // 전체 화면에서 이 두 속성은 레일 접힘 상태를 뜻하므로 덮어쓰지 않는다.
      applyThreadsRailState();
    } else {
      threadsBtn.setAttribute('aria-expanded', 'false');
      threadsPage.setAttribute('aria-hidden', 'true');
    }
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    skillsPage.inert = !open;
    if (!open) skillsShelf.showCatalog();
    if (open) {
      bridge.listSkills();
      skillsShelf.focusSearch();
    }
  }

  skillsBtn.addEventListener('click', () => setSkillsPanelOpen(true));
  skillsClose.addEventListener('click', () => { setSkillsPanelOpen(false); skillsBtn.focus(); });

  function setSettingsPanelOpen(open: boolean, destination?: SettingsDestination): void {
    if (!open && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(fullscreen ? workspaceSettingsBtn : settingsBtn);
      return;
    }
    if (open && referenceLibrary.isOpen()) referenceLibrary.setOpen(false);
    settingsPanelOpen = open;
    if (open) {
      setConfigPanelOpen(false);
      threadsPanelOpen = false;
      skillsPanelOpen = false;
      root.classList.remove('ag-threads-open', 'ag-skills-open');
      skillsBtn.setAttribute('aria-expanded', 'false');
      skillsPage.setAttribute('aria-hidden', 'true');
      closeVersionsPage();
    }
    root.classList.toggle('ag-settings-open', open);
    settingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    workspaceSettingsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    workspaceSettingsBtn.classList.toggle('ag-active', open);
    workspaceTitle.textContent = open ? '설정' : '';
    settingsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (fullscreen) {
      // 전체 화면에서 목록 관련 aria 는 레일 접힘 상태를 뜻하므로 덮어쓰지 않는다.
      applyThreadsRailState();
    } else if (open) {
      threadsBtn.setAttribute('aria-expanded', 'false');
      threadsPage.setAttribute('aria-hidden', 'true');
    }
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (open) {
      setCollapsed(false);
      settingsPanel.open(destination);
      settingsPage.querySelector<HTMLElement>('.ag-settings-nav-button.ag-active')?.focus();
    } else {
      settingsPanel.close();
    }
  }

  function requestSettingsOpen(destination?: SettingsDestination): void {
    if (eventBus) {
      eventBus.emit('settings:open', destination ? { destination } : undefined);
      return;
    }
    setCollapsed(false);
    setSettingsPanelOpen(true, destination);
  }

  function openConfiguredVersionControl(): void {
    if (!versionsReachable() && openClassicVersionControl) {
      closeVersionsPage();
      openClassicVersionControl();
      return;
    }
    setVersionsPanelOpen(true);
  }

  function setVersionsPanelOpen(open: boolean): void {
    if (!versionController) return;
    if (open && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(undefined, () => setVersionsPanelOpen(true));
      return;
    }
    if (deferredVersionsOpenTimer !== null) {
      window.clearTimeout(deferredVersionsOpenTimer);
      deferredVersionsOpenTimer = null;
    }
    if (fullscreen) {
      setFullscreen(false);
      deferredVersionsOpenTimer = window.setTimeout(() => {
        deferredVersionsOpenTimer = null;
        setVersionsPanelOpen(open);
      }, FS_MOTION_SETTLE_MS);
      return;
    }
    if (open && referenceLibrary.isOpen()) referenceLibrary.setOpen(false);
    versionsPanelOpen = open;
    if (open) {
      setConfigPanelOpen(false);
      threadsPanelOpen = false;
      skillsPanelOpen = false;
      closeSettingsPage();
      root.classList.remove('ag-threads-open', 'ag-skills-open');
      threadsBtn.setAttribute('aria-expanded', 'false');
      skillsBtn.setAttribute('aria-expanded', 'false');
      threadsPage.setAttribute('aria-hidden', 'true');
      skillsPage.setAttribute('aria-hidden', 'true');
    }
    root.classList.toggle('ag-versions-open', open);
    versionsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    versionsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    versionsPage.inert = !open;
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    chatPage.inert = open;
    if (open) {
      // 커밋할 변경이 있으면 변경 탭부터 보인다.
      if (!versionsBadge.hidden) versionManagerPage?.showTab('changes');
      versionManagerPage?.open();
      if (!versionsBadge.hidden) void changesDrawer.refresh();
    } else versionManagerPage?.close();
  }

  function applyFastCommand(action: 'on' | 'off' | 'status' | 'toggle'): void {
    if (!agentSupportsFast(selectedAgent)) {
      systemMessage('Fast는 Codex에서만 사용할 수 있습니다.');
      return;
    }
    if (action === 'status') {
      systemMessage(selectedServiceTier === 'fast'
        ? 'Codex Fast가 켜져 있습니다. 다음 턴부터 우선 처리됩니다.'
        : 'Codex Fast가 꺼져 있습니다.');
      return;
    }
    if (isControlLocked()) {
      systemMessage('응답이 끝난 뒤에 Fast를 바꿀 수 있습니다.');
      return;
    }
    const next: ServiceTier = action === 'toggle'
      ? (selectedServiceTier === 'fast' ? 'standard' : 'fast')
      : (action === 'on' ? 'fast' : 'standard');
    if (next === selectedServiceTier) {
      systemMessage(next === 'fast'
        ? 'Codex Fast가 이미 켜져 있습니다.'
        : 'Codex Fast가 이미 꺼져 있습니다.');
      return;
    }
    selectedServiceTier = next;
    currentThread.serviceTier = next;
    persistCurrentThread();
    if (!draftChat && bridge.getActiveAgent() === 'codex') bridge.setServiceTier(next);
    systemMessage(next === 'fast'
      ? 'Codex Fast를 켰습니다. 다음 턴부터 우선 처리됩니다.'
      : 'Codex Fast를 껐습니다.');
  }

  type SlashOption = {
    value: string;
    label: string;
    detail: string;
    local?: 'skills' | 'calibration' | 'settings' | 'templates' | 'fast';
    mode?: AgentMode;
    templateId?: string;
    skillName?: string;
    skillIcon?: ProductSkillIcon | null;
  };
  let slashOptions: SlashOption[] = [];
  let slashIndex = 0;

  function skillDisplayName(name: string): string {
    return name
      .split(/[-_]+/)
      .filter(Boolean)
      .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
      .join(' ');
  }

  /* 입력칸 높이. 상한은 CSS(.ag-input max-height) 한 곳에서 정하고 여기서는
     그 값을 읽는다. 줄 수가 바뀌면 짧게 이어 붙이고, IME 조합 중·쉬는 모양·
     동작 줄이기에서는 바로 맞춘다. 전환은 인라인으로만 걸어, 쉬는 모양이
     풀릴 때 입력기 전환의 측정과 겹치지 않게 한다. */
  let composerInputComposing = false;
  let composerInputTransitionTimer: number | null = null;
  input.addEventListener('compositionstart', () => { composerInputComposing = true; });
  input.addEventListener('compositionend', () => { composerInputComposing = false; });

  function resizeComposerInput(): void {
    // 값을 코드로 바꾼 뒤에도 이 경로를 지나므로 보내기 버튼의 쉼 상태를 함께 맞춘다.
    syncSendIdle();
    const from = Number.parseFloat(input.style.height);
    if (composerInputTransitionTimer !== null) {
      window.clearTimeout(composerInputTransitionTimer);
      composerInputTransitionTimer = null;
    }
    input.style.transition = 'none';
    input.style.height = 'auto';
    const cap = Number.parseFloat(getComputedStyle(input).maxHeight);
    const to = Number.isFinite(cap) ? Math.min(input.scrollHeight, cap) : input.scrollHeight;
    const animate = Number.isFinite(from) && Math.abs(to - from) >= 1
      && !composerInputComposing
      && !composer.classList.contains('ag-resting')
      && input.getClientRects().length > 0
      && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (animate) input.style.height = `${from}px`;
    else input.style.height = `${to}px`;
    // 전환을 되돌리기 전에 지금 높이를 확정해 auto → px 가 보간되지 않게 한다.
    void input.offsetHeight;
    if (!animate) {
      input.style.transition = '';
      return;
    }
    input.style.transition = 'height var(--ag-dur-fast) var(--ag-ease-out)';
    input.style.height = `${to}px`;
    composerInputTransitionTimer = window.setTimeout(() => {
      composerInputTransitionTimer = null;
      input.style.transition = '';
    }, 180);
  }

  function invocableSkill(name: string): CatalogRow | undefined {
    return skillCatalog.rows.find((row) => row.name === name && row.enabled);
  }

  function setComposerSkill(skill: CatalogRow | null, remainder?: string): void {
    activeComposerSkill = skill;
    composerSkill.hidden = skill === null;
    composerSkillName.textContent = skill ? skillDisplayName(skill.name) : '';
    composerSkillIcon.replaceChildren();
    if (skill) composerSkillIcon.appendChild(createIcon(skillGlyphForSkill(skill)));
    composerSkill.dataset.agent = skill ? selectedAgent : '';
    composerSkill.title = skill ? `/${skill.name} · ${skill.description}` : '';
    input.setAttribute('aria-label', skill ? `/${skill.name} 스킬 뒤의 메시지 입력` : '에이전트 메시지 입력');
    if (remainder !== undefined) input.value = remainder;
    resizeComposerInput();
    updateComposer();
  }

  composerSkillClear.addEventListener('click', () => {
    setComposerSkill(null);
    input.focus();
  });

  function setSlashMenuOpen(open: boolean): void {
    slashMenu.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open) input.removeAttribute('aria-activedescendant');
  }

  function renderActiveTemplate(): void {
    templateChip.hidden = activeTemplate === null;
    templateChipName.textContent = activeTemplate?.name ?? '';
    templateChip.title = activeTemplate ? `${activeTemplate.originalName} · r${activeTemplate.revision}` : '';
  }

  function selectTemplate(template: DocumentTemplate | null, sync = true): void {
    activeTemplate = template;
    currentThread.activeTemplateId = template?.id ?? null;
    renderActiveTemplate();
    // 초안의 템플릿은 첫 메시지를 보낼 때 브리지에 넘긴다.
    if (sync && !draftChat) bridge.setActiveTemplate(template?.id ?? null);
    persistCurrentThread();
  }

  templateChipClear.addEventListener('click', () => {
    selectTemplate(null);
    input.focus();
  });

  function rebuildSlashMenu(): void {
    if (activeComposerSkill) {
      setSlashMenuOpen(false);
      return;
    }
    const templateMatch = input.value.match(/^\s*\/templates(?:\s+([\s\S]*))?$/i);
    if (templateMatch && !input.value.trimStart().startsWith('//')) {
      const query = templateMatch[1] ?? '';
      const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase().trim();
      const completeName = [...templateCatalog.templates]
        .sort((a, b) => b.name.length - a.name.length)
        .find((template) => normalizedQuery.startsWith(`${template.name.normalize('NFKC').toLocaleLowerCase()} `));
      if (completeName) {
        setSlashMenuOpen(false);
        return;
      }
      slashOptions = templateCatalog.templates
        .map((template) => ({ template, score: fuzzyTemplateScore(template.name, query) }))
        .filter((item): item is { template: DocumentTemplate; score: number } => item.score !== null)
        .sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name, 'ko'))
        .map(({ template }) => ({
          value: `/templates ${template.name}`,
          label: template.name,
          detail: `${template.format.toUpperCase()} · ${template.pageCount}쪽 · r${template.revision}`,
          templateId: template.id,
        }));
      slashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));
      renderSlashRows();
      return;
    }
    const match = input.value.match(/^\s*\/([^\s/]*)$/);
    if (!match || input.value.trimStart().startsWith('//')) { setSlashMenuOpen(false); return; }
    const query = match[1].toLowerCase();
    const base: SlashOption[] = [
      { value: '/chat', label: '/chat', detail: '채팅 모드', mode: 'chat' },
      { value: '/plan', label: '/plan', detail: '플랜 모드', mode: 'plan' },
      { value: '/agent', label: '/agent', detail: '에이전트 모드', mode: 'agent' },
      { value: '/full', label: '/full', detail: '전체 모드', mode: 'full' },
      ...(agentSupportsFast(selectedAgent)
        ? [{
            value: '/fast',
            label: '/fast',
            detail: selectedServiceTier === 'fast' ? 'Codex Fast 끄기' : 'Codex Fast 켜기',
            local: 'fast' as const,
          }]
        : []),
      { value: '/calibration', label: '/calibration', detail: '말투 맞추기', local: 'calibration' },
      { value: '/settings', label: '/settings', detail: '설정 열기 (연결·기본값·사용량)', local: 'settings' },
      { value: '/templates', label: '/templates', detail: '문서 템플릿 선택', local: 'templates' },
      { value: '/skills', label: '/skills', detail: '스킬 라이브러리 열기', local: 'skills' },
    ];
    const product = skillCatalog.rows
      .filter((skill) => skill.enabled)
      .map((skill) => ({
        value: `/${skill.name}`,
        label: `/${skill.name}`,
        detail: skill.description,
        skillName: skill.name,
        skillIcon: skill.icon,
      }));
    // 다른 채팅이 편집하는 동안에는 채팅 말고 다른 모드 명령을 보이지 않는다.
    const offered = chatModeLockReason === null
      ? base
      : base.filter((option) => !option.mode || option.mode === 'chat');
    slashOptions = [...offered, ...product].filter((option) => option.label.slice(1).toLowerCase().includes(query));
    slashIndex = Math.min(slashIndex, Math.max(0, slashOptions.length - 1));
    renderSlashRows();
  }

  function renderSlashRows(): void {
    slashMenu.replaceChildren();
    slashOptions.forEach((option, index) => {
      const row = el('button', 'ag-slash-option');
      row.id = `ag-slash-option-${index}`;
      row.type = 'button';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', index === slashIndex ? 'true' : 'false');
      row.classList.toggle('ag-active', index === slashIndex);
      if (option.skillName) {
        row.classList.add('ag-skill-option');
        const icon = el('span', 'ag-slash-skill-icon');
        icon.appendChild(createIcon(skillGlyphForSkill({ name: option.skillName, icon: option.skillIcon })));
        row.append(icon, el('strong', 'ag-slash-name', option.label), el('span', 'ag-slash-detail', option.detail));
      } else {
        row.classList.add('ag-command-option');
        const icon = el('span', 'ag-slash-command-icon');
        icon.appendChild(createIcon('external'));
        row.append(icon, el('strong', 'ag-slash-name', option.label), el('span', 'ag-slash-detail', option.detail));
      }
      row.addEventListener('mousedown', (event) => { event.preventDefault(); chooseSlashOption(option); });
      slashMenu.appendChild(row);
    });
    const open = slashOptions.length > 0;
    setSlashMenuOpen(open);
    if (open) input.setAttribute('aria-activedescendant', `ag-slash-option-${slashIndex}`);
  }

  function chooseSlashOption(option: SlashOption): void {
    setSlashMenuOpen(false);
    if (option.skillName) {
      const skill = option.skillName ? invocableSkill(option.skillName) : undefined;
      if (skill) setComposerSkill(skill, '');
      input.focus();
      return;
    }
    if (option.templateId) {
      const template = templateCatalog.templates.find((item) => item.id === option.templateId) ?? null;
      if (template) selectTemplate(template);
      input.value = '';
      input.focus();
      return;
    }
    if (option.mode) {
      input.value = '';
      void requestMode(option.mode);
      return;
    }
    if (option.local === 'calibration') { input.value = ''; writingStyleCalibration.open(); return; }
    if (option.local === 'settings') { input.value = ''; requestSettingsOpen(); return; }
    if (option.local === 'templates') {
      input.value = '/templates ';
      input.focus();
      rebuildSlashMenu();
      return;
    }
    if (option.local === 'skills') { input.value = ''; setSkillsPanelOpen(true); return; }
    if (option.local === 'fast') { input.value = ''; applyFastCommand(selectedServiceTier === 'fast' ? 'off' : 'on'); return; }
    input.value = `${option.value} `;
    input.focus();
  }

  input.addEventListener('keydown', (e) => {
    if (questionController.isPresented()) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && questionController.usesComposerForOther()) {
        e.preventDefault();
        composer.requestSubmit();
      }
      return;
    }
    // 미뤄 둔 질문은 턴이 돌고 있다는 뜻이다. 글이 있는 Enter 는 아래에서 대기열에 들어가고(그러면 질문이 열린다),
    // 빈 입력기의 Enter 는 보낼 것 없이 질문만 연다. 어느 쪽도 턴을 멈추지 않는다.
    if (questionController.isHeld() && e.key === 'Enter' && !e.shiftKey && !e.isComposing
      && !input.value.trim() && !activeComposerSkill) {
      e.preventDefault();
      typing.noteSend();
      return;
    }
    if (!slashMenu.hidden && slashOptions.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashIndex = (slashIndex + (e.key === 'ArrowDown' ? 1 : -1) + slashOptions.length) % slashOptions.length;
        rebuildSlashMenu();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashMenuOpen(false);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        chooseSlashOption(slashOptions[slashIndex]!);
        return;
      }
    }
    if (e.key === 'Backspace' && !input.value && activeComposerSkill && !input.readOnly) {
      e.preventDefault();
      setComposerSkill(null);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // Ctrl+Enter(macOS 는 ⌘+Enter)는 '지금 보내기'다 — 일하는 중이면 턴을 멈추고 이것부터 보낸다.
      composerSubmitIntent = (isMacPlatform ? e.metaKey : e.ctrlKey) ? 'send-now' : 'enter';
      composer.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    syncSendIdle();
    if (questionController.isPresented()) {
      questionController.handleComposerInput();
      resizeComposerInput();
      return;
    }
    if (!activeComposerSkill) {
      const typedInvocation = input.value.match(/^\s*\/([a-z0-9-]+)\s+([\s\S]*)$/);
      const typedSkill = typedInvocation
        ? invocableSkill(typedInvocation[1])
        : null;
      if (typedSkill && typedInvocation) {
        setComposerSkill(typedSkill, typedInvocation[2]);
        setSlashMenuOpen(false);
        return;
      }
    }
    resizeComposerInput();
    rebuildSlashMenu();
  });
  /**
   * 입력기 제출의 뜻. Enter 는 keydown 이 정해 넘기고, 단추는 지금 모양(중지/보내기)이 정한다.
   * requestSubmit() 처럼 단추 없이 온 제출은 Enter 와 같다.
   */
  let composerSubmitIntent: 'enter' | 'send-now' | null = null;
  function takeComposerSubmitIntent(e: SubmitEvent): 'enter' | 'send-now' | 'stop' {
    const keyed = composerSubmitIntent;
    composerSubmitIntent = null;
    if (keyed) return keyed;
    return e.submitter === send && send.classList.contains('ag-stop') ? 'stop' : 'enter';
  }

  /** 턴이 돌거나, 보낸 메시지가 턴을 기다린다 — 이때 Enter 는 보내지 않고 대기열에 넣는다. */
  function agentWorking(): boolean {
    return turnRunning || replyPending;
  }

  /** 중지 — 입력기의 중지 단추와 질문 카드의 중지. 대기 메시지는 이 턴 끝에 '멈춤'으로 붙잡힌다. */
  function stopTurn(): void {
    followUps.noteUserStop();
    bridge.interrupt();
  }

  /** 대기 메시지를 지금 보낼 수 없는 이유(단추 제목). null 이면 보낼 수 있다. */
  function followUpSendBlockedReason(): string | null {
    if (mergeResolverLocked) return '병합 검토가 끝나면 보낼 수 있어요';
    if (connState !== 'connected') return '연결되면 보낼 수 있어요';
    if (planningPhase === 'switching' || workflowTransitionPending || planActionPending
      || chatStartPendingThreadId !== null || attachmentsSending) return '전환이 끝나면 보낼 수 있어요';
    return null;
  }

  /** 허브가 받지 않은 대기 메시지를 기록과 대화에서 걷는다 — 대기열 맨 앞으로 돌아간다. */
  function unrecordUserMessage(message: ThreadMessage, bubble: HTMLElement): void {
    const index = currentThread.messages.lastIndexOf(message);
    if (index >= 0) currentThread.messages.splice(index, 1);
    bubble.remove();
    persistCurrentThread();
    updateTurnPending();
  }

  /** 일하는 동안 입력기가 대기열에 넣는다는 것을 자리 표시와 ⏎ 힌트로 말한다. */
  function syncFollowUpComposerCues(): void {
    // 보이는 잠금(readOnly)이나 질문 카드가 입력기를 쥐고 있으면 그 문구가 먼저다.
    const queueing = agentWorking() && !input.disabled && !input.readOnly && !questionController.isPresented();
    if (queueing) input.placeholder = '작업이 끝나면 보낼 메시지 입력';
    sendHint.textContent = queueing ? '⏎ 대기' : '⏎';
    if (queueing) sendHint.hidden = (!input.value.trim() && !activeComposerSkill) || referenceLibrary.hasDrafts();
  }
  // 대기열에 넣지 못한 이유는 다음 입력까지만 보인다.
  input.addEventListener('input', () => {
    followUps.clearHint();
    syncFollowUpComposerCues();
  });

  const userMessageDispatchListeners = new Set<(origin: ComposedMessageOrigin) => void>();
  /** 사용자 메시지가 나갈 때마다(입력기·대기열·이어 가기) 알린다. 해제 함수를 돌려준다. */
  function onUserMessageDispatched(listener: (origin: ComposedMessageOrigin) => void): () => void {
    userMessageDispatchListeners.add(listener);
    return () => userMessageDispatchListeners.delete(listener);
  }
  function notifyUserMessageDispatched(origin: ComposedMessageOrigin): void {
    for (const listener of [...userMessageDispatchListeners]) {
      try { listener(origin); } catch (error) {
        console.warn('[agent-sidebar] 메시지 전송 리스너 오류:', error);
      }
    }
  }

  /**
   * 요청문을 내보내기 직전에 꾸민다 — 모든 보내기(입력기·대기열·이어 가기·인라인)가 지나는 한 자리.
   * 템플릿·스킬·계획 머리말을 붙인 뒤에 부른다. 지금은 그대로 돌려준다. 복원 안내(U6)는 앞에,
   * 끊긴 작업 블록(S3)은 뒤에 붙는다.
   */
  function decorateRequestText(base: string, _threadId: string): string {
    return base;
  }

  /**
   * 사용자 메시지 한 건을 보낸다 — 입력기, 대기열, 끊긴 작업 이어 가기(S3·U5), 인라인 프롬프트가
   * 함께 쓰는 한 길. 보내는 순간의 채팅 모드 잠금을 다시 읽어 잠겼으면 채팅 모드로 옮기고, 템플릿
   * 머리말과 스킬 요청문을 붙여(wire 가 있으면 그대로) 기록·말풍선을 남긴 뒤 브리지에 넘긴다.
   * 입력기를 비우는 일은 입력기 쪽이 한다. 입력기 밖에서 나가는 메시지는 사용자가 보던 패널을
   * 닫지 않고, 자동으로 나가는 메시지(queue·resume)는 대화를 끌어내리지 않는다.
   */
  function sendComposedMessage(
    spec: ComposedMessageSpec<StagedReference, NonNullable<ThreadMessage['selection']>>,
  ): ComposedMessageResult<ThreadMessage, HTMLElement> {
    const userAction = spec.origin === 'composer' || spec.origin === 'inline' || spec.origin === 'retry';
    if (spec.origin === 'composer') {
      if (threadsPanelOpen) setThreadsPanelOpen(false);
      if (skillsPanelOpen) setSkillsPanelOpen(false);
      if (settingsPanelOpen) setSettingsPanelOpen(false);
    }
    readChatModeLock();
    prepareChatForSend();
    const { skillName } = spec;
    let messageText: string;
    let requestText: string;
    if (spec.wire) {
      messageText = spec.wire.displayText;
      requestText = spec.wire.requestText;
    } else {
      const { text } = spec;
      messageText = activeTemplate && !skillName
          ? `/templates ${activeTemplate.name}${text ? ` ${text}` : ''}`
          : text;
      // 대화 기록은 skill block만 보이도록 빈 본문을 유지한다. 다만 wire
      // protocol은 비어 있지 않은 text를 요구하므로 명시적 slash 호출 자체를
      // 요청 본문으로 보낸다. 자연어 fallback을 UI나 기록에 숨겨 넣지 않는다.
      const skillRequestText = requestTextForSkillInvocation(text, skillName);
      requestText = spec.revisionPlanId && !skillName
        ? `현재 계획(${spec.revisionPlanId})을 다음 피드백에 맞게 수정해 주세요.\n\n${skillRequestText}`
        : skillRequestText;
    }
    // 실패하면 '다시 시도' 가 다시 보낼 요청 — 꾸밈 전 본문이다(꾸밈은 보낼 때마다 새로 붙는다).
    // 인라인 프롬프트의 선택 맥락은 그 시점 문서에 묶여 있어 다시 보낼 때 싣지 않는다.
    const retryPayload = {
      displayText: messageText,
      requestText: spec.origin === 'inline' ? messageText : requestText,
      ...(skillName ? { skillName } : {}),
      ...(skillName && spec.skillIcon ? { skillIcon: spec.skillIcon } : {}),
    };
    requestText = decorateRequestText(requestText, currentThread.id);
    const staged = spec.staged ?? [];
    const messageAttachments: ThreadAttachment[] = staged.map((file) => ({
      stageId: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.size,
      status: 'processing',
    }));
    const userMessage = recordUserMessage(messageText,
      messageAttachments,
      spec.selection,
      skillName,
      spec.skillIcon,
    );
    failureNotices.noteSend(currentThread.id, retryPayload);
    const userBubble = renderUserMessage(userMessage);
    userBubble.classList.add('ag-msg-enter');
    replyPending = true;
    if (userAction) {
      followConversation = true;
      appendConversation(userBubble);
    } else {
      withAutoScroll(() => appendConversation(userBubble));
    }
    updateTurnPending(selectedAgent);
    if (userAction) scrollConversationToMessage(userBubble, { smooth: true });
    const messageSent = bridge.sendUserMessage(
      requestText,
      skillName,
      staged.map((file) => file.id),
      spec.requireReceipt === true,
      spec.signal,
    );
    if (staged.length > 0) attachmentsSending = true;
    if (staged.length > 0 || spec.requireReceipt) {
      void messageSent.then((messageId) => {
        if (!messageId) {
          if (staged.length > 0) {
            attachmentsSending = false;
            updateComposer();
          }
          return;
        }
        // 첨부 처리 상태(reference-status)는 이 receipt id 로 메시지를 찾는다.
        userMessage.messageId = messageId;
        persistCurrentThread();
      });
    }
    updateComposer();
    notifyUserMessageDispatched(spec.origin);
    return { message: userMessage, bubble: userBubble, sent: messageSent };
  }

  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    composerRest.setResting(false);
    const intent = takeComposerSubmitIntent(e);
    if (intent === 'stop') {
      stopTurn();
      return;
    }
    if (readOnlyDocLabel !== null || mergeResolverLocked) return;
    if (questionController.isPresented()) {
      // 입력기로 답한 것도 보내기다 — 쓰기가 끝났다.
      if (questionController.handleComposerSubmit()) typing.noteSend();
      else stopTurn();
      return;
    }
    // 일하는 동안의 Enter 는 턴을 멈추지 않고 대기열에 넣는다. 멈추는 것은 중지 단추뿐이다.
    const queueing = agentWorking();
    if (queueing && intent === 'send-now' && !input.value.trim() && !activeComposerSkill) {
      followUps.sendNowHead();
      return;
    }
    if (!queueing && (planningPhase === 'switching' || workflowTransitionPending || planActionPending
      || chatStartPendingThreadId !== null || attachmentsSending || referenceLibrary.hasBlockingDrafts())) return;
    let text = input.value.trim();
    if ((!text && !activeComposerSkill && !referenceLibrary.hasDrafts()) || (!queueing && connState !== 'connected')) return;
    if (!queueing && referenceLibrary.hasImageDrafts() && !modelSupportsImages(selectedAgent, selectedModel)) {
      systemMessage(`${AGENT_LABEL[selectedAgent]} 현재 모델은 이미지 미지원 · 다른 모델 선택`);
      return;
    }
    if (!text && !activeComposerSkill) {
      text = referenceLibrary.allDraftsAreImages()
        ? '첨부 이미지 확인 필요'
        : '첨부 파일 확인 필요';
    }
    if (!activeComposerSkill && text.startsWith('//')) text = text.slice(1);
    // 잠긴 채팅은 계획 수정 요청도 채팅 모드의 질문으로 보낸다.
    if (chatModeLockReason !== null && currentMode() !== 'chat') revisionPlanId = null;
    // 일하는 동안 대기열에 넣은 글은 나중에 계획에 대한 의견으로 간다 — 수정 요청 경로를 타지 않는다.
    if (!queueing && revisionPlanId && !referenceLibrary.hasDrafts() && !activeComposerSkill && text) {
      const planId = revisionPlanId;
      if (!planApprovable || activePlan?.planId !== planId) {
        revisionPlanId = null;
        rebuildReview();
        return;
      }
      planActionPending = true;
      let sent = false;
      try {
        sent = bridge.requestPlanChanges(planId, text);
      } catch {
        sent = false;
      }
      // 계획 수정 요청은 같은 문구로 다시 보내면 안 된다.
      if (sent) failureNotices.clearLastSend();
      if (!sent) {
        planActionPending = false;
        updateComposer();
        rebuildReview();
        systemMessage('수정 요청을 보내지 못했습니다. 다시 시도해 주세요.');
        return;
      }
      const userMessage = recordUserMessage(text, []);
      const userBubble = renderUserMessage(userMessage);
      userBubble.classList.add('ag-msg-enter');
      followConversation = true;
      replyPending = true;
      appendConversation(userBubble);
      updateTurnPending(selectedAgent);
      scrollConversationToMessage(userBubble, { smooth: true });
      notifyUserMessageDispatched('composer');
      revisionPlanId = null;
      input.value = '';
      typing.noteSend();
      resizeComposerInput();
      updateComposer();
      rebuildReview();
      return;
    }
    const templateInvocation = activeComposerSkill ? null : text.match(/^\/templates(?:\s+([\s\S]*))?$/i);
    if (templateInvocation && queueing) {
      followUps.hint('template');
      return;
    }
    if (templateInvocation) {
      const tail = (templateInvocation[1] ?? '').trim();
      const match = [...templateCatalog.templates]
        .sort((a, b) => b.name.length - a.name.length)
        .find((template) => {
          const name = template.name.normalize('NFKC').toLocaleLowerCase();
          const value = tail.normalize('NFKC').toLocaleLowerCase();
          return value === name || value.startsWith(`${name} `);
        });
      if (!match) {
        input.value = tail ? `/templates ${tail}` : '/templates ';
        rebuildSlashMenu();
        return;
      }
      selectTemplate(match);
      text = tail.slice(match.name.length).trim();
      if (!text) {
        input.value = '';
        setSlashMenuOpen(false);
        input.focus();
        return;
      }
    }
    if (!activeComposerSkill) {
      const modeCommand = parseModeCommand(text);
      if (modeCommand) {
        const { mode, rest } = modeCommand;
        input.value = '';
        setSlashMenuOpen(false);
        if (modeNeedsConfirmation(mode)) {
          // 확인 시트는 비동기다 — 본문은 입력칸에 돌려 두고 확인 뒤에 다시 보낸다.
          if (rest) input.value = rest;
          void requestMode(mode);
          return;
        }
        if (!switchMode(mode)) {
          if (rest) input.value = rest;
          return;
        }
        if (!rest) {
          input.focus();
          return;
        }
        text = rest;
      }
      const fastCommand = text.match(/^\/fast(?:\s+(on|off|status))?$/i);
      if (fastCommand) {
        input.value = '';
        setSlashMenuOpen(false);
        const arg = fastCommand[1]?.toLowerCase();
        applyFastCommand(arg === 'on' || arg === 'off' || arg === 'status' ? arg : 'toggle');
        return;
      }
      if (/^\/fast\b/i.test(text)) {
        input.value = '';
        setSlashMenuOpen(false);
        systemMessage('/fast 인자: on, off, status');
        return;
      }
      if (text === '/calibration') { input.value = ''; writingStyleCalibration.open(); return; }
      if (text === '/settings') { input.value = ''; requestSettingsOpen(); return; }
      if (text === '/skills') { input.value = ''; setSkillsPanelOpen(true); return; }
    }
    let invokedSkill = activeComposerSkill;
    const invocation = activeComposerSkill ? null : text.match(/^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/);
    const matchedSkill = invocation
      ? invocableSkill(invocation[1])
      : undefined;
    if (invocation && matchedSkill) {
      invokedSkill = matchedSkill;
      text = invocation[2]?.trim() ?? '';
    }
    const skillNameForMessage = invokedSkill?.name;
    const skillIconForMessage = invokedSkill
      ? invokedSkill.icon ?? defaultSkillIconForName(invokedSkill.name)
      : undefined;
    if (queueing) {
      // 첨부는 지금 허브 세션의 스테이징에 묶여 있어 미뤄 보낼 수 없다 — 글은 입력기에 남긴다.
      if (referenceLibrary.hasDrafts()) {
        followUps.hint('attachment');
        return;
      }
      const queued = followUps.enqueue(
        { text, skillName: skillNameForMessage, skillIcon: skillIconForMessage },
        { atHead: intent === 'send-now' },
      );
      if (!queued) return;
      input.value = '';
      // 대기열에 넣은 글도 입력기를 떠났다 — 미뤄 둔 질문이 지금 열려도 잃을 것이 없다.
      typing.noteSend();
      setComposerSkill(null);
      setSlashMenuOpen(false);
      resizeComposerInput();
      if (intent === 'send-now') followUps.sendNow(queued.id);
      updateComposer();
      return;
    }
    const revisionFeedbackPlanId = revisionPlanId && referenceLibrary.hasDrafts() ? revisionPlanId : null;
    sendComposedMessage({
      text,
      skillName: skillNameForMessage,
      skillIcon: skillIconForMessage,
      staged: referenceLibrary.takeReadyDrafts(),
      origin: 'composer',
      revisionPlanId: revisionFeedbackPlanId,
    });
    input.value = '';
    // 보낸 글은 입력기를 떠났다 — 미뤄 둔 도착이 지금 열려도 잃을 것이 없다.
    typing.noteSend();
    revisionPlanId = null;
    setComposerSkill(null);
    setSlashMenuOpen(false);
    resizeComposerInput();
  });

  // resizeHandle 을 마지막에 두어 왼쪽 가장자리 히트 테스트를 확실히 가져간다.
  // 토글은 상단 아이콘 도구 모음의 오른쪽 끝에 둔다.
  root.append(stage, resizeHandle);
  // 화면에 붙지 않은 채로 시작한 사이드바는 activate() 에서 페이지 배치를 이어받으며 붙는다.
  if (active) {
    document.body.appendChild(root);
    document.getElementById('icon-toolbar')?.appendChild(collapseTab);
  }
  setCollapsed(false, { recenter: false });

  // ── 배치: #editor-area ↔ #status-bar 사이에 맞춘다 ────
  function updateComposerCompactLayout(): void {
    const compact = !fullscreen
      && root.clientWidth > 0
      && root.clientWidth <= COMPOSER_COMPACT_WIDTH_PX;
    root.classList.toggle('ag-composer-compact', compact);
  }

  const rootResizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(updateComposerCompactLayout)
    : null;
  rootResizeObserver?.observe(root);

  function measure(): void {
    updateComposerCompactLayout();
    const nextWorkspaceCompact = fullscreen && window.innerWidth <= 960;
    const enteringCompact = nextWorkspaceCompact && !workspaceCompact;
    workspaceCompact = nextWorkspaceCompact;
    root.classList.toggle('ag-workspace-compact', workspaceCompact);
    if (enteringCompact) {
      compactThreadsRailOpen = false;
      compactRailHoverOpen = false;
      clearCompactRailHoverOpen();
      clearCompactRailHoverClose();
      reviewColCollapsed = true;
      planColCollapsed = true;
      if (environmentPanelOpen) setEnvironmentPanelOpen(false, { persist: false });
      applyReviewColState();
    } else if (!workspaceCompact) {
      compactThreadsRailOpen = false;
      compactRailHoverOpen = false;
      clearCompactRailHoverOpen();
      clearCompactRailHoverClose();
    }
    applyThreadsRailState();
    // 전체 화면은 도구 모음·상태바까지 덮는다 — 인라인 배치를 걷어낸다.
    if (fullscreen) {
      root.style.top = '0px';
      root.style.bottom = '0px';
      // 창이 줄면 두 칸의 비율 상한이 내려간다 — 다시 클램프한다.
      applyRailWidth(railWidth, { persist: false });
      applyReviewWidth(reviewWidth, { persist: false });
      return;
    }
    const top = document.getElementById('editor-area')?.getBoundingClientRect().top ?? 96;
    const statusTop =
      document.getElementById('status-bar')?.getBoundingClientRect().top ?? window.innerHeight;
    // 장치 픽셀에 맞춰 두어 안쪽의 시트·입력기가 반 픽셀 위에서 쉬지 않게 한다.
    const dpr = window.devicePixelRatio;
    root.style.top = `${snapToDevicePixel(Math.max(0, top), dpr)}px`;
    root.style.bottom = `${snapToDevicePixel(Math.max(0, window.innerHeight - statusTop), dpr)}px`;
    refreshSidebarWidthMin();
    const clamped = clampSidebarWidth(sidebarWidth, sidebarWidthMin);
    if (clamped !== sidebarWidth) {
      applySidebarWidth(clamped, { persist: true, recenter: true });
    }
  }
  // 창 크기가 바뀌면 진행 중인 여닫기를 끝 상태로 바로 맞춘다. 움직이는 동안 보기는
  // 레이아웃을 다시 잡지 않으므로, 새 창 폭의 가운데 정렬은 커밋에서 한 번에 맞춘다.
  function onWindowResizeSettleInset(): void {
    if (insetMotion) startInsetRecenterLoop({ instant: true });
  }
  /* 내려간 사이드바는 다시 붙을 때 잰다. */
  function onWindowResizeMeasure(): void {
    if (active) measure();
  }
  window.addEventListener('resize', onWindowResizeSettleInset);
  window.addEventListener('resize', onWindowResizeMeasure);
  if (active) measure();
  void document.fonts?.ready?.then(() => refreshSidebarWidthMin());

  // ── 스레드(채팅 목록) ─────────────────────────────────
  /*
   * 도구 행·서브에이전트 근황처럼 자주 바뀌는 기록은 잠깐 모아 저장한다. 저장마다 스레드 전체를
   * 복제해 IndexedDB 와 다른 창에 보내기 때문이다. 즉시 저장(메시지·턴 끝·채팅 전환)이 오면
   * 모아 둔 변경도 함께 쓰이고, 페이지를 떠나거나 사이드바를 내리거나 정리할 때도 남김없이 쓴다.
   */
  const TRANSCRIPT_PERSIST_DELAY_MS = 120;
  let transcriptPersistTimer: number | null = null;
  function queueTranscriptPersist(): void {
    if (transcriptPersistTimer !== null) return;
    transcriptPersistTimer = window.setTimeout(() => {
      transcriptPersistTimer = null;
      persistCurrentThread();
    }, TRANSCRIPT_PERSIST_DELAY_MS);
  }
  function flushTranscriptPersist(): void {
    if (transcriptPersistTimer !== null) persistCurrentThread();
  }

  function persistCurrentThread(): void {
    if (transcriptPersistTimer !== null) {
      window.clearTimeout(transcriptPersistTimer);
      transcriptPersistTimer = null;
    }
    currentThread.agent = selectedAgent;
    currentThread.model = selectedModel;
    currentThread.effort = selectedEffort;
    currentThread.serviceTier = selectedServiceTier;
    currentThread.workflow = chatWorkflow;
    if (activePlan) currentThread.latestPlan = activePlan;
    else delete currentThread.latestPlan;
    if (planHistory.length > 0) currentThread.plans = [...planHistory];
    else delete currentThread.plans;
    // 보내지 않은 초안은 안내 문구가 붙어도 남기지 않는다.
    if (draftChat) {
      updateWorkspaceChatTitle();
      return;
    }
    if (currentThread.messages.length === 0) {
      removeThread(currentThread.id);
      updateWorkspaceChatTitle();
      return;
    }
    if (!currentThread.title || currentThread.title === '새 채팅') {
      currentThread.title = fallbackTitle(currentThread.messages);
    }
    upsertThread(currentThread);
    updateWorkspaceChatTitle();
  }

  function recordUserMessage(
    text: string,
    attachments: ThreadAttachment[] = [],
    selection?: NonNullable<ThreadMessage['selection']>,
    skillName?: string,
    skillIcon?: ProductSkillIcon,
    messageId?: string,
  ): ThreadMessage {
    const message: ThreadMessage = {
      role: 'user',
      text,
      agent: selectedAgent,
      // 이 요청이 시작한 턴들의 체크포인트가 묶이는 키 (이 작업 전으로 되돌리기)
      turnKey: transcriptId('turn'),
      ...(skillName ? { skillName } : {}),
      ...(skillName && skillIcon ? { skillIcon } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(selection ? { selection } : {}),
      ...(messageId ? { messageId } : {}),
    };
    currentThread.messages.push(message);
    currentThread.updatedAt = Date.now();
    persistCurrentThread();
    maybeRequestTitle();
    return message;
  }

  function formatAttachmentBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function renderPlanMessage(message: Extract<ThreadMessage, { kind: 'plan' }>): HTMLElement {
    const button = el('button', 'ag-msg-plan-action');
    button.type = 'button';
    button.dataset.planId = message.planId ?? '';
    const executed = message.planState === 'executed';
    button.classList.toggle('ag-executed', executed);
    button.setAttribute(
      'aria-label',
      `${message.text || '계획'} ${executed ? '완료된 계획' : '계획'} 열기`,
    );

    const icon = el('span', 'ag-msg-plan-icon');
    icon.appendChild(createIcon('changes'));
    const copy = el('span', 'ag-msg-plan-copy');
    copy.append(
      el('span', 'ag-msg-plan-kicker', executed ? '실행 됨' : '계획'),
      el('span', 'ag-msg-plan-title', message.text || '제목 없는 계획'),
    );
    const action = el('span', 'ag-msg-plan-open', '계획 열기');
    action.appendChild(createChevron('ag-msg-plan-chevron'));
    button.append(icon, copy, action);
    button.addEventListener('click', () => openPresentedPlan(message.planId));
    return button;
  }

  function renderUserMessage(message: ThreadMessage): HTMLElement {
    const bubble = el('div', 'ag-msg ag-msg-user');
    if (message.skillName) {
      bubble.classList.add('ag-has-skill');
      const skill = el('span', 'ag-skill-token ag-msg-skill');
      skill.dataset.agent = message.agent ?? currentThread.agent;
      const icon = el('span', 'ag-skill-token-icon');
      icon.appendChild(createIcon(skillGlyphForSkill({ name: message.skillName, icon: message.skillIcon })));
      skill.append(icon, el('span', 'ag-skill-token-name', skillDisplayName(message.skillName)));
      skill.title = `/${message.skillName}`;
      skill.setAttribute('aria-label', `사용한 스킬: ${skillDisplayName(message.skillName)}`);
      bubble.appendChild(skill);
    }
    if (message.selection) {
      const quote = el('div', 'ag-msg-selection');
      quote.title = message.selection.excerpt;
      quote.append(
        el('span', 'ag-msg-selection-label', message.selection.label),
        el('span', 'ag-msg-selection-excerpt', message.selection.excerpt),
      );
      bubble.appendChild(quote);
    }
    if (message.text) bubble.appendChild(el('div', 'ag-msg-user-text', message.text));
    if (message.attachments?.length) {
      const row = el('div', 'ag-msg-attachments');
      for (const attachment of message.attachments) {
        const pill = el('button', `ag-msg-attachment ag-${attachment.status}`);
        pill.type = 'button';
        pill.disabled = attachment.status !== 'ready' || !attachment.fileId;
        pill.append(
          createIcon(attachment.mimeType.startsWith('image/') ? 'image' : 'document'),
          el('span', 'ag-msg-attachment-name', attachment.name),
          el('span', 'ag-msg-attachment-meta', attachment.status === 'processing'
            ? '처리 중'
            : attachment.status === 'error'
              ? '실패'
              : attachment.status === 'deleted'
                ? '삭제됨'
                : formatAttachmentBytes(attachment.size)),
        );
        pill.title = attachment.error || attachment.name;
        if (attachment.fileId && attachment.status === 'ready') {
          pill.addEventListener('click', () => { void referenceLibrary.openFile(attachment.fileId!); });
        }
        row.appendChild(pill);
      }
      bubble.appendChild(row);
    }
    if (message.turnKey) {
      bubble.dataset.turnKey = message.turnKey;
      restoreActions?.sync(bubble);
    }
    return bubble;
  }

  /** 이 대화의 마지막 요청(사용자 메시지)의 키. 계획 실행처럼 메시지 없이 시작한 턴도 그 요청에 묶인다. */
  function latestUserTurnKey(): string | null {
    for (let i = currentThread.messages.length - 1; i >= 0; i--) {
      const message = currentThread.messages[i]!;
      if (message.role === 'user') return message.turnKey ?? null;
    }
    return null;
  }

  /**
   * 문서를 이 요청 전으로 되돌렸다 — 알리고, 빈 입력칸에 요청을 돌려준다 (보내지는 않는다).
   * 다음 요청에 붙는 안내는 편집기가 이 채팅의 브리지에 알린다 (noteDocumentRestored).
   */
  function handleTurnRestored(key: string): void {
    systemMessage(`문서를 이 작업 전으로 되돌렸습니다. ${formatShortcutLabel('Ctrl+Z')}로 다시 가져올 수 있습니다.`);
    const request = currentThread.messages.find((message) => message.role === 'user' && message.turnKey === key);
    if (request?.text && !input.value.trim() && !input.disabled) {
      input.value = request.text;
      resizeComposerInput();
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  /* 되돌릴 수 있는 상태가 바뀌면(턴 끝, 승인·거절, 되돌림, 문서 교체) 말풍선 버튼을 맞춘다. */
  const unsubTurnRestore = deps.turnRestore?.subscribe(() => restoreActions?.syncAll(messages)) ?? (() => {});

  /* 답변마다 호버 때 뜨는 복사 버튼. 마크다운 원문을 복사하고, 결과는
     토스트 없이 버튼 자체가 잠깐 체크 표시로 알린다. 스트리밍 중 다시
     그려도 같은 버튼을 다시 붙이므로 상태가 끊기지 않는다. */
  const assistantCopyButtons = new WeakMap<HTMLElement, HTMLButtonElement>();

  function assistantCopyButton(bubble: HTMLElement): HTMLButtonElement {
    const existing = assistantCopyButtons.get(bubble);
    if (existing) return existing;
    const button = el('button', 'ag-msg-copy');
    button.type = 'button';
    button.title = '복사';
    button.setAttribute('aria-label', '답변 복사');
    button.appendChild(createIcon('copy'));
    let resetTimer: number | null = null;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const source = assistantBubbleSources.get(bubble) ?? '';
      void navigator.clipboard?.writeText(source.trim()).then(() => {
        button.classList.add('ag-copied');
        button.title = '복사됨';
        button.setAttribute('aria-label', '복사됨');
        button.replaceChildren(createIcon('check'));
        if (resetTimer !== null) window.clearTimeout(resetTimer);
        resetTimer = window.setTimeout(() => {
          resetTimer = null;
          button.classList.remove('ag-copied');
          button.title = '복사';
          button.setAttribute('aria-label', '답변 복사');
          button.replaceChildren(createIcon('copy'));
        }, 1400);
      }).catch(() => {});
    });
    assistantCopyButtons.set(bubble, button);
    return button;
  }

  // 수식 모듈이 늦게 도착하면 chat-markdown 이 답변을 다시 그린다 — 호버 때 버튼을 되붙인다.
  messages.addEventListener('pointerover', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const bubble = target?.closest<HTMLElement>('.ag-msg-assistant');
    if (!bubble || !messages.contains(bubble)) return;
    if (!(assistantBubbleSources.get(bubble) ?? '').trim()) return;
    const button = assistantCopyButton(bubble);
    if (button.parentElement !== bubble) bubble.appendChild(button);
  });

  /** 복사 버튼 같은 덧붙임을 빼고, 답변 본문 블록이 하나라도 그려졌는지. */
  function hasRenderedBlocks(bubble: HTMLElement): boolean {
    return bubble.querySelector(':scope > [data-md-block]') !== null;
  }

  function renderAssistantMessage(bubble: HTMLElement, text: string, opts?: ChatMarkdownOptions): void {
    assistantBubbleSources.set(bubble, text);
    const wasEmpty = !hasRenderedBlocks(bubble);
    renderChatMarkdown(bubble, text, { ...opts, decorate: decorateAssistantBlock });
    const empty = !hasRenderedBlocks(bubble);
    // 첫 문단을 보류하는 동안에는 복사 버튼도 달지 않아 빈 답변이 감춰진 채로 남는다.
    if (bubble.classList.contains('ag-msg-assistant') && !empty) {
      const button = assistantCopyButton(bubble);
      // 이미 끝에 있으면 옮기지 않는다 — 옮기면 바뀐 것이 없는 프레임에도 대화 변경으로 잡힌다.
      if (bubble.lastElementChild !== button) bubble.appendChild(button);
    }
    if (bubble === streamBubble && wasEmpty !== empty) updateTurnPending();
  }

  /** 새로 그린 블록의 게시 문서 링크를 문서 열기 카드로 바꾼다. 그대로 남은 블록은 이미 바뀌어 있다. */
  function decorateAssistantBlock(block: HTMLElement): void {
    const links = block.querySelectorAll<HTMLAnchorElement>('a.ag-md-link:not(.ag-md-artifact-open)');
    for (const link of links) {
      const artifact = parsePublishedDocumentLink(link.href);
      if (!artifact) continue;
      const originalLabel = link.textContent?.trim() || '문서 열기';
      link.classList.add('ag-md-artifact-open');
      link.target = '';
      link.title = `${artifact.fileName} 새 창에서 열기`;
      link.setAttribute('aria-label', `${artifact.fileName} 새 창에서 열기`);
      const icon = el('span', 'ag-md-artifact-icon');
      icon.appendChild(createIcon('document'));
      const copy = el('span', 'ag-md-artifact-copy');
      copy.append(
        el('span', 'ag-md-artifact-name', artifact.fileName),
        el('span', 'ag-md-artifact-hint', originalLabel),
      );
      link.replaceChildren(icon, copy, el('span', 'ag-md-artifact-action', '열기'));
      link.addEventListener('click', (event) => {
        event.preventDefault();
        if (link.getAttribute('aria-busy') === 'true') return;
        link.setAttribute('aria-busy', 'true');
        link.classList.remove('ag-failed');
        void openPublishedDocumentInNewWindow(artifact, undefined, { readOnly: artifact.readOnly === true })
          .catch((error) => {
            link.classList.add('ag-failed');
            const message = error instanceof Error ? error.message : String(error);
            showToast({ message: `문서를 열지 못했습니다: ${message}`, durationMs: 5000 });
          })
          .finally(() => link.removeAttribute('aria-busy'));
      });

      const download = document.createElement('a');
      download.className = 'ag-md-artifact-download';
      download.href = artifact.downloadUrl;
      download.target = '_blank';
      download.rel = 'noopener noreferrer';
      download.download = artifact.fileName;
      download.textContent = '다운로드';
      download.title = `${artifact.fileName} 다운로드`;
      const card = el('span', 'ag-md-artifact-card');
      const parent = link.parentElement;
      if (parent) {
        parent.insertBefore(card, link);
        card.append(link, download);
      } else {
        link.insertAdjacentElement('afterend', download);
      }
    }
  }

  /** 턴을 마친 스트리밍 답변을 다음 턴 전까지 스크롤 기준점으로 남긴다. */
  function settleFinalAnswer(): void {
    const bubble = streamBubble;
    if (!bubble || bubble.parentElement !== messages || !hasRenderedBlocks(bubble)) return;
    settledAnswer = bubble;
  }

  /** 보류하던 마지막 블록까지 모두 그려 스트리밍 답변을 확정한다. */
  function flushPendingAssistantRender(): void {
    if (assistantRenderFrame !== null) {
      window.cancelAnimationFrame(assistantRenderFrame);
      assistantRenderFrame = null;
    }
    const bubble = pendingAssistantBubble ?? streamBubble;
    pendingAssistantBubble = null;
    if (!bubble) return;
    // 가려진 채팅도 답변을 확정해 둔다. 보이지 않는 등장 애니메이션은 걸지 않는다.
    withAutoScroll(() => renderAssistantMessage(bubble, assistantBubbleSources.get(bubble) ?? '', { animate: active }));
  }

  function scheduleAssistantRender(bubble: HTMLElement, text: string): void {
    assistantBubbleSources.set(bubble, text);
    pendingAssistantBubble = bubble;
    // 가려진 채팅은 원문만 쌓는다. activate() 가 한 번에 따라잡아 그린다.
    if (!active) return;
    if (assistantRenderFrame !== null) return;
    assistantRenderFrame = window.requestAnimationFrame(() => {
      assistantRenderFrame = null;
      const pending = pendingAssistantBubble;
      pendingAssistantBubble = null;
      if (pending) {
        withAutoScroll(() => renderAssistantMessage(pending, assistantBubbleSources.get(pending) ?? '', STREAMING_RENDER));
      }
    });
  }

  function cancelPendingAssistantRender(): void {
    if (assistantRenderFrame !== null) window.cancelAnimationFrame(assistantRenderFrame);
    assistantRenderFrame = null;
    pendingAssistantBubble = null;
  }

  function flushAssistantBuffer(opts?: { persist?: boolean; kind?: 'progress' }): void {
    const text = assistantBuffer;
    assistantBuffer = '';
    if (!text.trim()) return;
    if (opts?.persist === false) return;
    currentThread.messages.push({
      role: 'assistant',
      text,
      agent: selectedAgent,
      ...(opts?.kind ? { kind: opts.kind } : {}),
    });
    persistCurrentThread();
    maybeRequestTitle();
  }

  function maybeRequestTitle(): void {
    if (currentThread.titleRequested) return;
    if (!currentThread.messages.some((m) => m.role === 'user')) return;
    currentThread.titleRequested = true;
    persistCurrentThread();
    const preview = currentThread.messages
      // 턴 표식은 대화 내용이 아니다 — 제목 요청에 "어시스턴트: " 빈 줄로 새지 않게 뺀다. 실패 알림도 빠진다.
      .filter((m) => !isTurnMarker(m) && m.kind !== 'error')
      .slice(0, 6)
      .map((m) => {
        const text = m.role === 'user' && m.skillName
          ? `/${m.skillName}${m.text ? ` ${m.text}` : ''}`
          : m.text;
        return `${m.role === 'user' ? '사용자' : '어시스턴트'}: ${text}`;
      })
      .join('\n')
      .slice(0, 800);
    bridge.requestTitle(currentThread.id, preview);
  }

  function renderStoredTool(tool: ThreadToolRecord, agent: AgentName): HTMLElement {
    const row = createToolRow({ agent, tool: tool.tool, argsJson: tool.argsJson });
    row.setState(tool.status);
    row.setRawResult(tool.resultPreview);
    if (tool.elapsedMs !== null) row.elapsed.textContent = `${tool.elapsedMs}ms`;
    if (tool.status !== 'running') {
      row.setOutcome(tool.outcome ?? (tool.status === 'stopped' ? null : presentToolResult({
        tool: tool.tool,
        argsJson: tool.argsJson,
        ok: tool.status === 'completed',
        preview: tool.resultPreview,
      })));
    }
    return row.root;
  }

  function renderStoredActivity(message: ThreadActivityMessage, agent: AgentName): HTMLElement {
    const step = el('div', 'ag-progress-step ag-progress-step-tools-only');
    const activity = el('div', `ag-activity ag-${agent} ag-activity-collapsed ag-activity-${message.status}`);
    const toggle = el('button', 'ag-activity-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.append(
      createIcon('terminal', 'ag-activity-icon'),
      el('span', 'ag-activity-label', summarizeActivity(message.tools.map((tool) => ({
        tool: tool.tool,
        argsJson: tool.argsJson,
        failed: tool.status === 'failed' || tool.status === 'stopped',
      })))),
      createChevron('ag-activity-chevron'),
    );
    const collapse = el('div', 'ag-activity-collapse');
    const content = el('div', 'ag-activity-content');
    content.tabIndex = -1;
    for (const tool of message.tools) content.appendChild(renderStoredTool(tool, agent));
    collapse.appendChild(content);
    activity.append(toggle, collapse);
    toggle.addEventListener('click', () => {
      const collapsed = activity.classList.toggle('ag-activity-collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      content.tabIndex = collapsed ? -1 : 0;
    });
    step.appendChild(activity);
    return step;
  }

  function renderStoredTasks(message: ThreadTasksMessage, agent: AgentName): HTMLElement {
    const group = el('section', `ag-restored-task-group ag-${agent}`);
    const heading = el('button', 'ag-restored-task-heading');
    heading.type = 'button';
    heading.setAttribute('aria-expanded', 'false');
    const failed = message.tasks.filter((task) => task.status === 'failed').length;
    heading.append(
      createIcon(failed > 0 ? 'close' : 'check'),
      el('span', '', failed > 0
        ? `서브에이전트와 워크플로 · ${failed}개 오류`
        : `서브에이전트와 워크플로 · ${message.tasks.length}개`),
      createChevron('ag-restored-task-chevron'),
    );
    const body = el('div', 'ag-restored-task-body');
    body.hidden = true;
    for (const task of message.tasks) {
      const item = el('article', `ag-restored-task ag-${task.status}`);
      const title = task.workflowName || task.title;
      const meta = [
        task.status === 'completed' ? '완료' : task.status === 'failed' ? '실패' : '중단됨',
        task.totalTokens === null ? '' : `${task.totalTokens.toLocaleString()} tokens`,
      ].filter(Boolean).join(' · ');
      item.append(
        el('strong', 'ag-restored-task-title', title),
        el('span', 'ag-restored-task-meta', meta),
        el('p', 'ag-restored-task-summary', task.summary || task.activity || '기록된 요약 없음'),
      );
      if (task.tools.length > 0) {
        const tools = el('div', 'ag-restored-task-tools');
        for (const tool of task.tools) tools.appendChild(renderStoredTool(tool, agent));
        item.appendChild(tools);
      }
      body.appendChild(item);
    }
    heading.addEventListener('click', () => {
      body.hidden = !body.hidden;
      heading.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
    });
    group.append(heading, body);
    return group;
  }

  /** 저장된 메시지 하나를 그린다 (턴 표식은 renderMessagesFromThread 가 따로 다룬다). */
  function renderStoredMessage(msg: ThreadMessage, thread: ChatThread): HTMLElement {
    if (msg.role === 'user') return renderUserMessage(msg);
    // 실패 알림은 흐름에 남는다 — 접힘으로 옮기는 작업 메시지가 아니다.
    if (msg.kind === 'error') return failureNotices.mount(msg);
    if (msg.role !== 'assistant') return el('div', 'ag-msg ag-msg-system', msg.text);
    const agent = msg.agent ?? thread.agent;
    if (msg.kind === 'user-question') return renderUserQuestionHistory(msg);
    if (msg.kind === 'progress') {
      const step = el('div', 'ag-progress-step ag-progress-step-restored');
      const milestone = el('div', `ag-msg ag-progress-milestone ag-${agent}`);
      renderAssistantMessage(milestone, msg.text);
      step.appendChild(milestone);
      return step;
    }
    if (msg.kind === 'plan') return renderPlanMessage(msg);
    if (msg.kind === 'activity') return renderStoredActivity(msg, agent);
    if (msg.kind === 'tasks') return renderStoredTasks(msg, agent);
    const bubble = el('div', `ag-msg ag-msg-assistant ag-${agent}`);
    renderAssistantMessage(bubble, msg.text);
    return bubble;
  }

  function renderMessagesFromThread(thread: ChatThread): void {
    composerRest.setResting(false);
    cancelPendingAssistantRender();
    resetConversation();
    streamBubble = null;
    turnActivity = null;
    followConversation = true;
    assistantBuffer = '';
    toolRows.clear();
    activityTranscript = null;
    activityTranscripts.clear();
    transcriptTools.clear();
    tasksTranscript = null;
    transcriptTasks.clear();
    taskToolRecords.clear();
    taskTextBuffers.clear();
    // 정착한 턴은 작업을 한 줄 아래로 접는다. 정착 전 표식(도는 턴·끊긴 턴)은 접지 않고
    // 숨은 자리만 남긴다 — 살아 있는 턴이면 그 턴의 끝이 이 자리에서 접는다.
    const plan = planTurnFolds(thread.messages);
    const foldRows: TurnFoldRow[] = [];
    thread.messages.forEach((msg, index) => {
      const foldAt = plan.anchors.get(index);
      if (foldAt !== undefined) {
        const fold = plan.folds[foldAt];
        const row = mountTurnFoldRow(fold.id);
        row.setSummary(fold.view);
        row.setCollapsed(true, { animate: false });
        appendConversation(row.root);
        foldRows[foldAt] = row;
      }
      if (isTurnMarker(msg)) {
        if (msg.endedAt === null) {
          const placeholder = mountTurnFoldRow(msg.messageId);
          placeholder.root.hidden = true;
          appendConversation(placeholder.root);
        }
        return;
      }
      const node = renderStoredMessage(msg, thread);
      const placement = plan.placement[index];
      const row = placement === null || placement === undefined ? undefined : foldRows[placement];
      if (row) row.body.appendChild(node);
      else appendConversation(node);
    });
    if (questionController.interaction()?.threadId === thread.id) {
      questionController.setVisible(true);
      mountQuestionTimelineAnchor();
    }
    scrollConversationToEnd();
  }

  function renderUserQuestionHistory(message: Extract<ThreadMessage, { kind: 'user-question' }>): HTMLElement {
    const card = el('section', 'ag-question-history');
    card.setAttribute('aria-label', '에이전트 질문 기록');
    const status = message.outcome.status === 'answered'
      ? '답변 완료'
      : message.outcome.status === 'cancelled'
        ? '중단됨'
        : '만료됨';
    const title = el('div', 'ag-question-history-title');
    title.append(
      el('span', 'ag-question-history-label', '에이전트 질문'),
      el('span', 'ag-question-history-status', status),
    );
    card.append(title);
    for (const question of message.interaction.questions) {
      const item = el('div', 'ag-question-history-item');
      item.append(
        el('span', 'ag-question-history-header', question.header),
        el('p', 'ag-question-history-prompt', question.question),
      );
      if (message.outcome.status === 'answered') {
        const answer = message.outcome.answers[question.id];
        const selected = new Set(answer?.selectedOptionIds ?? []);
        const labels = question.options.filter((option) => selected.has(option.id)).map((option) => option.label);
        if (answer?.otherText) labels.push(answer.otherText);
        item.append(el('p', 'ag-question-history-answer', labels.join(', ') || '답변 없음'));
      }
      card.appendChild(item);
    }
    return card;
  }

  function clearChatUi(): void {
    cancelPendingAssistantRender();
    resetConversation();
    streamBubble = null;
    turnActivity = null;
    followConversation = true;
    assistantBuffer = '';
    sweepUnresolvedToolRows();
  }

  function applyThreadMeta(thread: ChatThread): void {
    selectedModel = resolveModelForAgent(thread.agent, thread.model);
    selectedEffort = resolveEffortForAgent(thread.agent, thread.effort, selectedModel);
    selectedServiceTier = resolveServiceTier(thread.agent, thread.serviceTier);
    setSelectedAgent(thread.agent);
    rebuildLlmMenu();
    rebuildEffortMenu();
    updateWorkspaceAgentContext();
    activeTemplate = templateCatalog.templates.find((template) => template.id === thread.activeTemplateId) ?? null;
    if (thread.activeTemplateId && templateCatalog.revision > 0 && !activeTemplate) {
      thread.activeTemplateId = null;
      upsertThread(thread);
    }
    renderActiveTemplate();
    bridge.setActiveTemplate(activeTemplate?.id ?? thread.activeTemplateId);
  }

  /**
   * 이름 바꾸기 — 행 자리에서 바로 편집한다. Enter 확정 / Esc 취소 /
   * 포커스 이탈 시 확정. 확정된 이름은 고정되어 자동 제목이 덮지 않는다.
   */
  function beginThreadRename(thread: ChatThread, row: HTMLElement): void {
    const title = row.querySelector<HTMLElement>('.ag-threads-item-title');
    if (!title) return;
    beginInlineRename(title, {
      value: thread.title || '새 채팅',
      label: '채팅 이름',
      maxLength: 48,
      commit: (value) => {
        const next = renameThread(thread.id, value);
        if (next && thread.id === currentThread.id) {
          currentThread.title = next.title;
          currentThread.titlePinned = true;
          updateWorkspaceChatTitle();
        }
        return next?.title ?? null;
      },
    });
    window.requestAnimationFrame(() => {
      const input = title.querySelector<HTMLInputElement>('.inline-rename-input');
      input?.focus({ preventScroll: true });
      input?.select();
    });
  }

  function docGroupLabel(docKey: string | null): string {
    return docKey ?? '문서 없음';
  }

  /**
   * 채팅 기록 삭제 — 문서 파일은 남기고 그 문서의 채팅을 모두 지운다.
   * 지금 열려 있는 채팅이 그 문서 소속이면 먼저 새 채팅으로 빠져나온다.
   */
  async function archiveDocumentGroup(group: Pick<ChatThread, 'documentId' | 'docKey'>): Promise<void> {
    const confirmed = await confirmSheet(root, '채팅 기록 삭제', '이 문서의 채팅을 모두 지웁니다. 문서는 그대로 둡니다.', { confirmLabel: '삭제', destructive: true });
    if (!confirmed) return;
    const currentInGroup = group.documentId
      ? currentThread.documentId === group.documentId
      : !currentThread.documentId && (currentThread.docKey ?? '') === (group.docKey ?? '');
    const leavingThreadId = currentThread.id;
    // startNewChat 이 현재 채팅을 저장하므로, 삭제는 빠져나온 뒤에 한다.
    if (currentInGroup) startNewChat({ silent: true });
    // 다른 문서 세션에서 아직 일하는 채팅은 남긴다 — 하나씩 지울 때처럼 작업 중에는 지우지 않는다.
    const removed = forgetDocumentThreads(group.documentId, group.docKey, (thread) => (
      thread.id !== leavingThreadId && getChatStatus(thread.id) === 'working'
    ));
    for (const id of removed) {
      planArchives.delete(id);
      threadWorkflows.delete(id);
      clearChatStatus(id);
    }
    rebuildThreadsList();
  }

  /** 실행 상태 점 — 노란 불(작업 중)·초록 점(완료)·빨간 점(승인 대기).
      작업 중·입력 대기는 옆 글자가 말하므로 완료 점만 이름을 갖는다. */
  function buildStatusDot(status: ChatRunStatus): HTMLElement {
    const dot = el('span', `ag-thread-status ag-thread-status-${status}`);
    if (status === 'finished') dot.title = '완료';
    else dot.setAttribute('aria-hidden', 'true');
    return dot;
  }

  /** "작업 중 2분"의 경과 부분. 1분이 안 되면 비운다. */
  function formatWorkingElapsed(since: number, now: number): string {
    const minutes = Math.floor((now - since) / 60_000);
    if (minutes < 1) return '';
    if (minutes < 60) return `${minutes}분`;
    return `${Math.floor(minutes / 60)}시간`;
  }

  /** 행 오른쪽 위 — 실행 중이면 점과 짧은 상태, 아니면 마지막 대화 이후 경과.
      작업 중은 시작 뒤 400ms 가 지나야 보인다 — 짧은 턴은 경과 표시에서 곧바로 완료 점으로 간다.
      입력 대기·완료 같은 다른 상태는 바로 보인다. 삭제·보관 판단은 실제 상태를 읽는다. */
  function fillThreadWhen(when: HTMLElement, thread: ChatThread, now = Date.now()): void {
    let status = getChatStatus(thread.id);
    const since = status === 'working' ? getChatWorkingSince(thread.id) : null;
    if (status === 'working') {
      const reveal = revealAfterDelay(since ?? now, now);
      if (!reveal.revealed) {
        status = null;
        scheduleRailReveal(reveal.revealInMs);
      }
    }
    when.dataset.status = status ?? '';
    let label: string;
    if (status === 'working') {
      const elapsed = since ? formatWorkingElapsed(since, now) : '';
      label = elapsed ? `작업 중 ${elapsed}` : '작업 중';
    } else if (status === 'needs-input') {
      label = '입력 대기';
    } else {
      label = formatShortAge(threadActivityAt(thread), now);
    }
    when.replaceChildren(
      ...(status ? [buildStatusDot(status)] : []),
      el('span', 'ag-threads-item-when-label', label),
    );
  }

  /** 보이는 목록 행의 상태·경과만 다시 채운다. */
  function refreshThreadWhens(): void {
    if (!threadsListVisible()) return;
    const now = Date.now();
    for (const item of threadNavItems()) {
      const entry = threadRowTargets.get(item);
      const when = item.querySelector<HTMLElement>('.ag-threads-item-when');
      if (entry && when) fillThreadWhen(when, entry.thread, now);
    }
  }

  /** 아직 드러나지 않은 작업 중 표시를 위해 타이머 하나를 가장 이른 시각에 둔다. */
  function scheduleRailReveal(inMs: number): void {
    const at = Date.now() + inMs;
    if (railRevealTimer !== null && railRevealAt <= at) return;
    if (railRevealTimer !== null) window.clearTimeout(railRevealTimer);
    railRevealAt = at;
    railRevealTimer = window.setTimeout(() => {
      railRevealTimer = null;
      railRevealAt = Number.POSITIVE_INFINITY;
      refreshThreadWhens();
    }, inMs);
  }

  /** 행 버튼 → 채팅. 키보드 삭제가 버튼에서 채팅을 되찾는다. */
  const threadRowTargets = new WeakMap<HTMLElement, { thread: ChatThread; row: HTMLElement }>();
  const threadsPlatformKind = detectPlatformKind();
  /** 문서를 옮겨 가는 동안 가라앉혀 보여 줄 채팅. */
  let openingThreadId: string | null = null;

  function findThreadRow(id: string): HTMLElement | null {
    for (const item of threadsList.querySelectorAll<HTMLElement>('.ag-threads-item')) {
      if (item.dataset.threadId === id) return item.closest<HTMLElement>('.ag-threads-row');
    }
    return null;
  }

  /** 키보드로 연 우클릭 메뉴는 좌표가 0 이다 — 요소 아래에 띄운다. */
  function contextMenuAnchor(event: MouseEvent, target: HTMLElement): { x: number; y: number } {
    if (event.clientX || event.clientY) return { x: event.clientX, y: event.clientY };
    const rect = target.getBoundingClientRect();
    return { x: rect.left + 12, y: rect.bottom };
  }

  /** 채팅 하나를 지운다 — 채팅 기록 삭제와 같은 정리를 한 채팅에만 한다. */
  async function deleteThreadWithConfirm(thread: ChatThread): Promise<boolean> {
    if (getChatStatus(thread.id) === 'working') return false;
    const confirmed = await confirmSheet(root, '채팅 삭제', `"${thread.title || '새 채팅'}" 채팅을 지웁니다.`, { confirmLabel: '삭제', destructive: true });
    if (!confirmed) return false;
    // startNewChat 이 현재 채팅을 저장하므로, 삭제는 빠져나온 뒤에 한다.
    if (thread.id === currentThread.id) startNewChat({ silent: true });
    removeThread(thread.id);
    planArchives.delete(thread.id);
    threadWorkflows.delete(thread.id);
    clearChatStatus(thread.id);
    rebuildThreadsList();
    return true;
  }

  /** 고정은 맨 위에 붙고, 풀면 아래 목록의 제자리로 돌아간다. */
  function toggleThreadPin(thread: ChatThread): void {
    if (thread.pinOrder !== undefined) unpinThread(thread.id);
    else pinThread(thread.id);
  }

  /** 끌기와 Alt+↑/↓ 가 같이 쓴다 — 이웃 사이에 채팅을 놓는다. */
  function moveThread(id: string, pinned: boolean, place: { before: string | null; after: string | null }): void {
    if (pinned) pinThread(id, place);
    else placeThread(id, place);
  }

  async function openThreadMenu(thread: ChatThread, anchor: { x: number; y: number }): Promise<void> {
    const pinned = thread.pinOrder !== undefined;
    const choice = await showContextMenu([
      { id: 'open', label: '열기', enabled: thread.id !== currentThread.id },
      { id: 'pin', label: pinned ? '고정 해제' : '고정' },
      { id: 'rename', label: '이름 바꾸기' },
      { type: 'separator' },
      { id: 'delete', label: '삭제', danger: true, enabled: getChatStatus(thread.id) !== 'working' },
    ], anchor);
    if (choice === 'open') {
      requestOpenThread(thread.id);
    } else if (choice === 'pin') {
      toggleThreadPin(thread);
    } else if (choice === 'rename') {
      // 메뉴가 떠 있는 동안 목록이 다시 그려졌을 수 있다.
      const row = findThreadRow(thread.id);
      if (row) beginThreadRename(thread, row);
    } else if (choice === 'delete') {
      void deleteThreadWithConfirm(thread);
    }
  }

  /**
   * 채팅 한 줄 — 위에는 제목과 상태(또는 경과), 아래에는 문서와 에이전트.
   * 문서 아이콘이 점선이면 문서 없이 시작한 채팅이다.
   */
  function buildThreadRow(thread: ChatThread): HTMLElement {
    const li = el('li', 'ag-threads-row');
    li.dataset.threadId = thread.id;
    const isCurrent = thread.id === currentThread.id;
    const opening = thread.id === openingThreadId;
    if (isCurrent) li.classList.add('ag-current');
    if (opening) li.classList.add('ag-opening');

    const btn = el('button', 'ag-threads-item');
    btn.type = 'button';
    btn.dataset.threadId = thread.id;
    btn.tabIndex = -1;
    if (isCurrent) {
      btn.classList.add('ag-active');
      btn.setAttribute('aria-current', 'true');
    }
    if (opening) btn.setAttribute('aria-busy', 'true');

    const top = el('span', 'ag-threads-item-top');
    const when = el('span', 'ag-threads-item-when');
    fillThreadWhen(when, thread);
    top.append(el('span', 'ag-threads-item-title', thread.title || '새 채팅'), when);

    const meta = el('span', 'ag-threads-item-meta');
    const docIcon = createIcon('document', 'ag-threads-item-doc-icon');
    if (!thread.documentId && !thread.docKey) docIcon.classList.add('ag-doc-missing');
    const docName = el('span', 'ag-threads-item-doc');
    setMiddleTruncatedText(docName, docGroupLabel(thread.docKey));
    const agent = el('span', 'ag-threads-item-agent');
    agent.title = `${AGENT_LABEL[thread.agent]} · ${labelForModel(thread.agent, thread.model)}`;
    agent.append(createProviderIcon(thread.agent), el('span', 'ag-sr-only', AGENT_LABEL[thread.agent]));
    meta.append(docIcon, docName, agent);

    btn.append(top, meta);
    // 두 번 누르기로는 열지 않는다 — 첫 클릭이 이미 대화를 열어버리므로
    // 이름 바꾸기는 연필 버튼과 우클릭 메뉴로 들어간다.
    btn.addEventListener('click', () => {
      if (!btn.querySelector('.inline-rename-input')) requestOpenThread(thread.id);
    });
    threadRowTargets.set(btn, { thread, row: li });

    const rename = el('button', 'ag-thread-rename');
    rename.type = 'button';
    // 키보드는 행 사이를 화살표로 오가고, 이름 바꾸기는 우클릭 메뉴로 닿는다.
    rename.tabIndex = -1;
    rename.setAttribute('aria-label', `${thread.title || '새 채팅'} 이름 바꾸기`);
    rename.title = '이름 바꾸기';
    rename.appendChild(createIcon('format'));
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      beginThreadRename(thread, li);
    });

    const pinned = thread.pinOrder !== undefined;
    const pin = el('button', 'ag-thread-pin');
    pin.type = 'button';
    pin.tabIndex = -1;
    pin.setAttribute('aria-pressed', pinned ? 'true' : 'false');
    pin.setAttribute('aria-label', `${thread.title || '새 채팅'} ${pinned ? '고정 해제' : '고정'}`);
    pin.title = pinned ? '고정 해제' : '고정';
    pin.appendChild(createIcon('pin'));
    pin.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleThreadPin(thread);
    });

    li.addEventListener('contextmenu', (event) => {
      if (li.querySelector('.inline-rename-input')) return;
      event.preventDefault();
      event.stopPropagation();
      void openThreadMenu(thread, contextMenuAnchor(event, li));
    });

    li.append(btn, pin, rename);
    return li;
  }

  function threadNavItems(): HTMLElement[] {
    return Array.from(threadsList.querySelectorAll<HTMLElement>('.ag-threads-item'));
  }

  /** Tab 정지점은 목록 안에 하나만 둔다(roving tabindex). */
  function syncThreadsRoving(focus?: HTMLElement | null): void {
    const items = threadNavItems();
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const current = (focus && items.includes(focus) ? focus : null)
      ?? (active && items.includes(active) ? active : null)
      ?? items.find((item) => item.classList.contains('ag-active'))
      ?? items[0];
    for (const item of items) item.tabIndex = item === current ? 0 : -1;
  }

  function threadNavKey(item: Element | null): string | null {
    if (!(item instanceof HTMLElement) || !threadsList.contains(item)) return null;
    return item.dataset.threadId ?? null;
  }

  function isThreadDeleteKey(e: KeyboardEvent): boolean {
    return threadsPlatformKind === 'mac'
      ? e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Backspace'
      : !e.metaKey && !e.ctrlKey && !e.altKey && e.key === 'Delete';
  }

  threadsList.addEventListener('focusin', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('.ag-threads-item')) {
      syncThreadsRoving(target);
    }
  });

  threadsList.addEventListener('keydown', (e) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !target.matches('.ag-threads-item')) return;
    const items = threadNavItems();
    const index = items.indexOf(target);
    if (isThreadDeleteKey(e)) {
      const entry = threadRowTargets.get(target);
      if (!entry) return;
      e.preventDefault();
      void deleteThreadWithConfirm(entry.thread).then((deleted) => {
        if (!deleted) return;
        const rest = threadNavItems();
        rest[Math.min(index, rest.length - 1)]?.focus();
      });
      return;
    }
    // Alt+↑/↓ — 채팅을 제 구역 안에서 한 칸씩 옮긴다.
    if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const entry = threadRowTargets.get(target);
      if (!entry) return;
      e.preventDefault();
      const rowId = (node: Element | null | undefined) => (
        node instanceof HTMLElement && node.matches('.ag-threads-row') ? node.dataset.threadId ?? null : null
      );
      const prev = entry.row.previousElementSibling;
      const next = entry.row.nextElementSibling;
      const place = e.key === 'ArrowUp'
        ? { after: rowId(prev?.previousElementSibling), before: rowId(prev) }
        : { after: rowId(next), before: rowId(next?.nextElementSibling) };
      // 구역 끝에서는 움직이지 않는다 — 고정을 넘나드는 건 끌기와 메뉴가 맡는다.
      if (e.key === 'ArrowUp' ? place.before : place.after) {
        moveThread(entry.thread.id, entry.thread.pinOrder !== undefined, place);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    let next: HTMLElement | undefined;
    if (e.key === 'ArrowDown') next = items[index + 1];
    else if (e.key === 'ArrowUp') next = index === 0 ? threadsToolbar.search : items[index - 1];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    else return;
    e.preventDefault();
    next?.focus();
  });

  /** 고정 구역과 아래 목록의 머리. 고정한 채팅이 없으면 끄는 동안에만 보인다. */
  function buildThreadsSection(name: 'pinned' | 'recent', label: string): HTMLElement {
    const section = el('li', 'ag-threads-section');
    section.dataset.section = name;
    section.appendChild(el('span', 'ag-threads-section-label', label));
    return section;
  }

  /**
   * 채팅 목록 — 고정한 채팅이 놓인 순서대로 맨 위에 서고, 나머지는 문서와
   * 상관없이 마지막 대화 활동 순이다. 끌어 놓은 채팅은 놓은 자리에 남는다. 검색어는 제목과 문서 이름에서 찾고,
   * 문서 필터는 한 문서의 채팅만 남긴다.
   */
  function rebuildThreadsList(): void {
    // 끄는 동안에는 행을 갈아 끼우지 않는다 — 놓을 때 한 번 다시 그린다.
    if (threadDrag.dragging() || threadsList.querySelector('.inline-rename-input')) return;
    // 다시 그려도 키보드 포커스는 같은 행에 남는다.
    const focusedKey = threadNavKey(document.activeElement);
    threadsList.replaceChildren();
    const all = listThreads();
    const filter = threadDocFilter;
    if (filter && !all.some((thread) => documentGroupKey(thread) === filter.key)) {
      setThreadDocFilter(null, { rebuild: false });
    }
    const query = searchKey(threadQuery);
    const visible = all.filter((thread) => (
      (!threadDocFilter || documentGroupKey(thread) === threadDocFilter.key)
      && (!query
        || searchKey(thread.title || '새 채팅').includes(query)
        || searchKey(docGroupLabel(thread.docKey)).includes(query))
    ));
    if (visible.length === 0) {
      threadsList.appendChild(el(
        'li',
        'ag-threads-empty',
        all.length === 0 ? '이전 채팅이 없습니다' : '일치하는 채팅이 없습니다',
      ));
      return;
    }
    const pinned = orderPinnedThreads(visible);
    threadsList.classList.toggle('ag-has-pinned', pinned.length > 0);
    threadsList.append(
      buildThreadsSection('pinned', '고정됨'),
      ...pinned.map(buildThreadRow),
      buildThreadsSection('recent', '최근'),
      ...visible
        .filter((thread) => thread.pinOrder === undefined)
        .sort((a, b) => threadListKey(b) - threadListKey(a))
        .map(buildThreadRow),
    );
    const restore = focusedKey
      ? threadNavItems().find((item) => threadNavKey(item) === focusedKey) ?? null
      : null;
    syncThreadsRoving(restore);
    restore?.focus({ preventScroll: true });
  }

  function setThreadDocFilter(
    filter: { key: string; label: string; missing: boolean } | null,
    opts?: { rebuild?: boolean },
  ): void {
    threadDocFilter = filter;
    threadsToolbar.setFilter(filter);
    if (opts?.rebuild !== false) rebuildThreadsList();
  }

  /** 채팅이 있는 문서 — 현재 문서가 맨 위, 나머지는 마지막 대화 순. */
  function documentFilterOptions(): Array<DocumentFilterOption & { sample: ChatThread }> {
    const byKey = new Map<string, DocumentFilterOption & { sample: ChatThread }>();
    for (const thread of listThreads()) {
      const key = documentGroupKey(thread);
      const entry = byKey.get(key);
      if (entry) {
        entry.chatCount += 1;
        if (!entry.sample.docKey && thread.docKey) {
          entry.sample = thread;
          entry.label = docGroupLabel(thread.docKey);
        }
        continue;
      }
      byKey.set(key, {
        key,
        label: docGroupLabel(thread.docKey),
        missing: !thread.documentId && !thread.docKey,
        chatCount: 1,
        sample: thread,
      });
    }
    const options = [...byKey.values()];
    const current = options.findIndex((option) => (
      threadMatchesDocument(option.sample, currentDocumentId, currentDocKey)
    ));
    if (current > 0) options.unshift(options.splice(current, 1)[0]!);
    return options;
  }

  function openDocumentFilter(): void {
    if (threadsToolbar.filterButton.getAttribute('aria-expanded') === 'true') {
      closeThreadRailSurfaces(root);
      return;
    }
    const documents = documentFilterOptions();
    showDocumentFilter({
      host: root,
      trigger: threadsToolbar.filterButton,
      alignTo: threadsToolbar.root,
      selectedKey: threadDocFilter?.key ?? null,
      documents,
      onSelect(key) {
        const option = key ? documents.find((doc) => doc.key === key) : null;
        setThreadDocFilter(option ? { key: option.key, label: option.label, missing: option.missing } : null);
      },
      onDocumentMenu(option, anchor) {
        const sample = documents.find((doc) => doc.key === option.key)?.sample;
        if (sample) void openDocumentMenu(sample, anchor);
      },
    });
  }

  async function openDocumentMenu(sample: ChatThread, anchor: { x: number; y: number }): Promise<void> {
    const isCurrent = threadMatchesDocument(sample, currentDocumentId, currentDocKey);
    const choice = await showContextMenu([
      { id: 'open', label: '문서 열기', enabled: !isCurrent && canFollowThreadDocument(sample) },
      { type: 'separator' },
      { id: 'archive', label: '채팅 기록 삭제', danger: true },
    ], anchor);
    if (choice === 'open') {
      void moveToDocument({ documentId: sample.documentId, fileName: sample.docKey });
    } else if (choice === 'archive') {
      void archiveDocumentGroup(sample);
    }
  }

  function openDocumentPalette(trigger: HTMLElement = threadsToolbar.openButton): void {
    if (trigger.getAttribute('aria-expanded') === 'true') {
      closeThreadRailSurfaces(root);
      return;
    }
    showDocumentPalette({
      host: root,
      trigger,
      alignTo: trigger === threadsToolbar.openButton ? threadsToolbar.root : trigger,
      centered: trigger !== threadsToolbar.openButton,
      selectedDocumentId: trigger === threadsToolbar.openButton ? undefined : currentDocumentId,
      recents: (listRecentDocuments?.() ?? Promise.resolve([]))
        .then((docs) => trigger === threadsToolbar.openButton
          ? docs.filter((doc) => doc.documentId !== currentDocumentId)
          : docs),
      onCreate: createDocument,
      onOpenFile: openDocumentFile,
      onOpenRecent: moveToLibraryDocument
        ? (doc) => void moveToDocument({ documentId: doc.documentId, fileName: doc.fileName })
        : undefined,
    });
  }

  /**
   * 레일에서 다른 문서로 옮겨 간다. 저장과 버전 기록 커밋은 편집기가 맡는다.
   * 편집기가 문서 세션을 관리하면(openThreadDocument) 지금 문서의 에이전트는
   * 그 세션에서 계속 돌고, 아니면 떠나기 전에 멈춘다.
   */
  async function moveToDocument(
    target: { documentId: string | null; fileName: string | null },
  ): Promise<LibraryMoveResult> {
    if (!moveToLibraryDocument) return 'failed';
    if (!openThreadDocument && bridge.isTurnRunning()) bridge.interrupt();
    flushAssistantBuffer();
    persistCurrentThread();
    try {
      return await moveToLibraryDocument(target, { commit: true });
    } catch (error) {
      console.warn('[agent-sidebar] 문서 이동 실패:', error);
      return 'failed';
    }
  }

  /**
   * 편집기에 채팅을 맡기기 전에 지금 채팅을 저장한다. 도는 턴의 답변 버퍼는 끊지 않는다 —
   * 끊으면 이어서 흐르는 답변이 말풍선 두 개로 갈라진다. 턴이 끝나면 그대로 저장된다.
   */
  function saveBeforeHandOff(): void {
    if (!turnRunning) flushAssistantBuffer();
    persistCurrentThread();
  }

  /** 다른 문서의 채팅을 편집기에 맡긴다 — 지금 채팅은 저장만 하고 멈추지 않는다. */
  async function handThreadToHost(thread: ChatThread): Promise<LibraryMoveResult> {
    if (!openThreadDocument) return 'failed';
    saveBeforeHandOff();
    try {
      return await openThreadDocument({ id: thread.id, documentId: thread.documentId, docKey: thread.docKey });
    } catch (error) {
      console.warn('[agent-sidebar] 채팅 문서 열기 실패:', error);
      return 'failed';
    }
  }

  /** 마지막으로 편집기에 물은 채팅 열기 — 그 뒤에 다른 것을 고르면 앞선 답은 버린다. */
  let openChatTicket = 0;

  /**
   * 새 채팅·같은 문서의 다른 채팅을 편집기에 먼저 묻는다. 이 사이드바가 열어야 하면 true.
   * 지금 채팅은 저장만 하고 도는 작업은 멈추지 않는다 — 바쁘면 편집기가 다른 채팅 창을 띄운다.
   */
  async function askHostToOpenChat(
    request: { kind: 'new' } | { kind: 'thread'; threadId: string },
  ): Promise<boolean> {
    if (!openChat) return true;
    saveBeforeHandOff();
    const ticket = ++openChatTicket;
    let result: 'handled' | 'local';
    try {
      result = await openChat(request);
    } catch (error) {
      console.warn('[agent-sidebar] 채팅 열기 실패:', error);
      return false;
    }
    if (ticket !== openChatTicket || root.dataset.disposed === 'true') return false;
    return result === 'local';
  }

  /** 새 채팅 진입점 — 사용자가 새 채팅을 고르는 곳은 모두 이리 온다. */
  function requestNewChat(): void {
    // 이 문서의 새 채팅 초안이 이미 열려 있으면 다시 만들지 않는다 — 초안 화면과 입력 칸으로만 간다.
    // 그사이 문서가 바뀌었으면 초안의 문서가 달라지므로 새로 만든다.
    if (
      draftChat
      && currentThread.messages.length === 0
      && threadMatchesDocument(currentThread, currentDocumentId, currentDocKey)
    ) {
      chatChosen = true;
      setThreadsPanelOpen(false);
      setFullscreen(true, { then: () => input.focus({ preventScroll: true }) });
      return;
    }
    chatChosen = true;
    if (!openChat) {
      startNewChat();
      return;
    }
    void askHostToOpenChat({ kind: 'new' }).then((local) => {
      if (local) startNewChat();
    });
  }

  /** 레일·메뉴·키보드로 채팅을 고른다. 이 문서의 다른 채팅은 편집기에 먼저 묻는다. */
  function requestOpenThread(id: string): void {
    chatChosen = true;
    const target = getThread(id);
    if (
      !openChat
      || !target
      || id === currentThread.id
      || !threadMatchesDocument(target, currentDocumentId, currentDocKey)
    ) {
      openThread(id);
      return;
    }
    void askHostToOpenChat({ kind: 'thread', threadId: id }).then((local) => {
      if (local) openThread(id);
    });
  }

  function canFollowThreadDocument(thread: Pick<ChatThread, 'documentId' | 'docKey'>): boolean {
    return Boolean(moveToLibraryDocument && (thread.documentId || thread.docKey));
  }

  /**
   * 다른 문서의 채팅을 연다 — 지금 문서를 저장·커밋하고 그 문서를 연다.
   * 문서가 바뀌는 순간 handleDocumentSwitch 가 이 채팅을 잇는다.
   */
  async function followThreadToDocument(thread: ChatThread): Promise<void> {
    pendingThreadSwitch = { threadId: thread.id };
    openingThreadId = thread.id;
    rebuildThreadsList();
    const result = openThreadDocument
      ? await handThreadToHost(thread)
      : await moveToDocument({ documentId: thread.documentId, fileName: thread.docKey });
    if (openingThreadId === thread.id) {
      openingThreadId = null;
      if (threadsListVisible()) rebuildThreadsList();
    }
    // 편집기가 그 문서 세션의 사이드바를 올렸다 — 채팅은 그 사이드바가 연다.
    if (!active) {
      if (pendingThreadSwitch?.threadId === thread.id) pendingThreadSwitch = null;
      return;
    }
    // 문서가 바뀌며 이미 이 채팅이 열렸거나, 그사이 다른 채팅을 골랐다.
    if (pendingThreadSwitch?.threadId !== thread.id) return;
    // 문서가 아직 바뀌기 전이면 바뀌는 순간 handleDocumentSwitch 가 잇는다.
    if (result === 'moved' && !threadMatchesDocument(thread, currentDocumentId, currentDocKey)) return;
    pendingThreadSwitch = null;
    // 이미 문서를 옮겼으니 다시 옮기지 않는다 — 맞지 않으면 읽기 전용으로 열린다.
    if (result === 'moved' || result === 'same') openThread(thread.id, { routed: true });
    // 문서를 열 수 없으면 기록만이라도 읽게 한다.
    else if (result === 'failed') openThread(thread.id, { viewOnly: true });
  }

  function setThreadsPanelOpen(open: boolean, opts?: { focus?: boolean }): void {
    // 전체 화면에서 스레드는 넘겨 보는 페이지가 아니라 상시 레일이다.
    // 목록만 갱신하고 페이지 전환은 하지 않는다.
    if (fullscreen) {
      rebuildThreadsList();
      return;
    }
    if (open && settingsPanelOpen && settingsPanel.isDirty()) {
      void requestSettingsClose(undefined, () => setThreadsPanelOpen(true));
      return;
    }
    if (open && referenceLibrary.isOpen()) referenceLibrary.setOpen(false);
    threadsPanelOpen = open;
    if (open) setConfigPanelOpen(false);
    if (open) skillsPanelOpen = false;
    closeSettingsPage();
    closeVersionsPage();
    root.classList.toggle('ag-threads-open', open);
    root.classList.remove('ag-skills-open');
    threadsBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    skillsBtn.setAttribute('aria-expanded', 'false');
    threadsPage.setAttribute('aria-hidden', open ? 'false' : 'true');
    skillsPage.setAttribute('aria-hidden', 'true');
    chatPage.setAttribute('aria-hidden', open ? 'true' : 'false');
    if (open) {
      rebuildThreadsList();
      if (opts?.focus !== false) threadsToolbar.search.focus({ preventScroll: true });
    } else {
      closeThreadRailSurfaces(root);
    }
  }

  /** 저장된 기본값을 지금 선택으로 세운다 (새 대화 진입점에서만 부른다). */
  function applyDefaultSelection(): void {
    const nextAgent = agentPrefs.defaultAgent;
    const nextModel = resolveModelForAgent(nextAgent, agentPrefs.defaultModel);
    const nextEffort = resolveEffortForAgent(nextAgent, agentPrefs.defaultEffort, nextModel);
    selectedModel = nextModel;
    selectedEffort = nextEffort;
    selectedServiceTier = resolveServiceTier(nextAgent, null);
    setSelectedAgent(nextAgent);
    rebuildLlmMenu();
    rebuildEffortMenu();
    permissionProfile = agentModeTarget(agentPrefs.defaultMode).permissionProfile;
    updateModeChip();
  }

  /** 다른 문서의 채팅을 열람만 한다 — 입력 잠금은 updateComposer 가 관리한다. */
  function enterReadOnlyMode(docLabel: string): void {
    readOnlyDocLabel = docLabel;
    input.value = '';
    setComposerSkill(null);
    composer.classList.add('ag-readonly');
    const note = el('div', 'ag-msg ag-msg-system ag-readonly-note',
      `"${docLabel}" 문서의 채팅 · 그 문서에서 이어서 대화합니다.`);
    appendConversation(note);
    scrollConversationToEnd();
    updateComposer();
  }

  function exitReadOnlyMode(): void {
    if (readOnlyDocLabel === null) return;
    readOnlyDocLabel = null;
    composer.classList.remove('ag-readonly');
    messages.querySelectorAll('.ag-readonly-note').forEach((n) => n.remove());
    updateComposer();
  }

  /**
   * 새 채팅. 사용자가 고른 새 채팅은 초안이다 — 집중 모드에 인사와 입력기만 띄우고, 첫
   * 메시지를 보낼 때 스레드를 저장하고 브리지 채팅을 연다. 앞 채팅은 저장된 그대로 두고
   * 브리지도 아직 멈추지 않는다. silent 는 문서 전환·삭제처럼 지금 채팅을 대신 세울 때로,
   * 빈 채팅의 브리지 채팅을 곧바로 연다.
   */
  function startNewChat(opts?: { silent?: boolean }): void {
    const draft = !opts?.silent;
    if (!opts?.silent) pendingThreadSwitch = null;
    rememberThreadComposerDraft();
    setComposerSkill(null);
    // 초안은 앞 채팅을 멈추지 않는다. 다만 편집기가 바쁜 채팅을 따로 띄우지 않으면
    // (openChat 없음) 예전처럼 도는 턴과 질문을 끝내 초안 화면에 흘러들지 않게 한다.
    const stopPrevious = bridge.isTurnRunning() || bridge.getPendingUserQuestion() !== null;
    if (bridge.isTurnRunning()) bridge.interrupt();
    flushAssistantBuffer();
    const previousThreadId = currentThread.id;
    const previousWasDraft = draftChat;
    const previousThreadWasEmpty = previousWasDraft || currentThread.messages.length === 0;
    const returnThreadId = previousWasDraft
      ? draftReturnThreadId
      : (previousThreadWasEmpty ? null : previousThreadId);
    followUps.detach();
    persistCurrentThread();
    if (previousWasDraft) threadComposerDrafts.delete(previousThreadId);
    input.value = '';
    referenceLibrary.discardDrafts();
    resizeComposerInput();
    clearChatUi();
    exitReadOnlyMode();
    // 새 대화는 개인 기본값으로 열린다 — 이전 대화의 임시 선택을 물려받지 않는다.
    applyDefaultSelection();
    const nextThread = createEmptyThread({
      agent: selectedAgent,
      model: selectedModel,
      effort: selectedEffort,
      serviceTier: selectedServiceTier,
      docKey: currentDocKey,
      documentId: currentDocumentId,
    });
    // 새 채팅은 기본 모드의 작업 방식으로 시작한다.
    threadWorkflows.set(nextThread.id, agentModeTarget(agentPrefs.defaultMode).workflow);
    restorePlanningForThread(nextThread.id, nextThread);
    if (previousThreadWasEmpty) {
      planArchives.delete(previousThreadId);
      threadWorkflows.delete(previousThreadId);
    }
    currentThread = nextThread;
    followUps.attach();
    draftChat = draft;
    draftReturnThreadId = draft ? returnThreadId : null;
    updateWorkspaceChatTitle();
    if (draft) {
      chatStartPendingThreadId = null;
      selectTemplate(null, false);
      if (stopPrevious) {
        bridgeThreadId = null;
        bridge.stopChat();
      }
      referenceLibrary.contextChanged();
      enforceChatModeLock();
      updateComposer();
      setThreadsPanelOpen(false);
      // 초안마다 새 인사를 고른다 — 이미 집중 모드여도 빈 채팅 배치를 다시 세운다.
      syncFocusGreeting();
      setFullscreen(true, { then: () => input.focus({ preventScroll: true }) });
      return;
    }
    selectTemplate(null);
    bridge.stopChat();
    referenceLibrary.contextChanged();
    startCurrentBridgeChat(true);
  }

  /**
   * 보내지 않은 초안을 조용히 버린다. 초안 전에 보던 채팅이 있으면 그리로 돌아가고,
   * 없으면 빈 채팅으로 남는다 — 어느 쪽이든 저장되는 것은 없다.
   */
  function discardDraft(): void {
    if (!draftChat) return;
    const returnThreadId = draftReturnThreadId;
    draftReturnThreadId = null;
    if (!returnThreadId || !getThread(returnThreadId)) return;
    openThread(returnThreadId, { routed: true });
  }

  /**
   * 보내기 직전에 부른다. 잠긴 채팅은 채팅 모드로 옮기고, 초안이면 브리지 채팅을 고른
   * 선택으로 연다. 브리지는 시작·전환이 끝날 때까지 메시지를 붙잡아 한 번만 보낸다.
   */
  function prepareChatForSend(): void {
    if (chatModeLockReason !== null && currentMode() !== 'chat') {
      if (draftChat) setDraftMode('chat');
      else if (!workflowTransitionPending) forceChatWorkflow();
    }
    if (!draftChat) return;
    draftChat = false;
    draftReturnThreadId = null;
    chatChosen = true;
    // 앞 채팅의 허브 세션을 닫고 이 스레드로 새로 연다.
    bridgeThreadId = null;
    bridge.stopChat();
    bridge.setActiveTemplate(activeTemplate?.id ?? null);
    startCurrentBridgeChat(true);
  }

  /**
   * 채팅을 연다. routed 는 편집기가 이미 이 문서로 옮겨 온 경우다 — 다시
   * 편집기에 맡기지 않는다(문서가 맞지 않으면 읽기 전용으로 연다).
   */
  function openThread(id: string, opts?: { viewOnly?: boolean; routed?: boolean }): void {
    // 채팅을 열어 보면 완료 점은 걷힌다. 다른 탭에서 아직 일하는 채팅의
    // 노란 불은 그 탭의 것이므로 여기서 지우지 않는다. 화면에서 내려간
    // 사이드바가 마지막 채팅을 되살릴 때는 아무도 보지 않았으므로 점을 남긴다.
    if (active && getChatStatus(id) === 'finished') clearChatStatus(id);
    if (id === currentThread.id) {
      setThreadsPanelOpen(false);
      return;
    }
    // During a reload the bridge reconstructs the authoritative question
    // before the drawer can bind it. Treat that snapshot as live too, so
    // opening its persisted thread never stops the still-blocked provider.
    const liveQuestion = questionController.interaction() ?? bridge.getPendingUserQuestion();
    const target = getThread(id);
    if (!target) return;
    // 다른 문서의 채팅은 그 문서로 옮겨 가서 잇는다. 편집기가 문서 세션을
    // 관리하면 지금 문서의 작업과 질문은 그 세션에 남으므로 언제나 맡긴다.
    // 아니면 에이전트가 답을 기다리는 동안에는 문서를 떠나지 않고 읽기 전용으로 연다.
    if (
      !opts?.viewOnly
      && !opts?.routed
      && !threadMatchesDocument(target, currentDocumentId, currentDocKey)
      && (openThreadDocument !== undefined || (!liveQuestion && canFollowThreadDocument(target)))
    ) {
      void followThreadToDocument(target);
      return;
    }
    pendingThreadSwitch = null;
    // 허브의 살아 있는 세션이 이 채팅이다(새로고침 뒤 다시 붙이기) — 멈추거나 다시 시작하지 않고 잇는다.
    const adopt = bridge.getHubChat()?.threadId === id;
    // 초안을 버리고 브리지가 아직 들고 있는 앞 채팅으로 돌아가면 다시 열지 않고 잇는다.
    const resume = adopt
      || (draftChat && !liveQuestion && bridgeThreadId === id && bridge.getActiveAgent() !== null);
    if (!resume && !liveQuestion && turnRunning) bridge.interrupt();
    flushAssistantBuffer();
    followUps.detach();
    persistCurrentThread();
    const loaded = getThread(id);
    if (!loaded) return;
    rememberThreadComposerDraft();
    if (draftChat) threadComposerDrafts.delete(currentThread.id);
    setComposerSkill(null);
    draftChat = false;
    draftReturnThreadId = null;
    threadWorkflows.set(id, loaded.workflow);
    planArchives.set(id, loaded.plans?.length
      ? loaded.plans
      : (loaded.latestPlan ? [loaded.latestPlan] : []));
    restorePlanningForThread(id, loaded);
    currentThread = {
      ...loaded,
      messages: loaded.messages.map((m) => ({ ...m })),
      titleRequested: Boolean(loaded.titleRequested),
    };
    followUps.attach();
    updateWorkspaceChatTitle();
    referenceLibrary.contextChanged();
    input.value = '';
    applyThreadMeta(currentThread);
    renderMessagesFromThread(currentThread);
    if (!liveQuestion && !resume) {
      bridgeThreadId = null;
      bridge.stopChat();
    }
    const matchesCurrentDocument = threadMatchesDocument(
      loaded,
      currentDocumentId,
      currentDocKey,
    );
    const showingLiveQuestion = liveQuestion?.threadId === currentThread.id;
    questionController.setVisible(showingLiveQuestion);
    if (showingLiveQuestion) mountQuestionTimelineAnchor();
    if (liveQuestion && !showingLiveQuestion) {
      enterReadOnlyMode('에이전트가 다른 채팅에서 답변을 기다리는 중');
      setThreadsPanelOpen(false);
      return;
    }
    if (!matchesCurrentDocument) {
      // 다른 문서의 채팅 — 열람은 되지만 이어가지는 못한다.
      enterReadOnlyMode(docGroupLabel(loaded.docKey));
      setThreadsPanelOpen(false);
      return;
    }
    // 파일명만 있던 레거시 채팅은 여기서 안정 ID를 얻는다. ID로 맞은 채팅도
    // 그룹이 갈라지지 않게 "다른 이름으로 저장" 개명을 따라간다.
    currentThread.documentId = currentDocumentId ?? currentThread.documentId;
    currentThread.docKey = currentDocKey ?? currentThread.docKey;
    persistCurrentThread();
    exitReadOnlyMode();
    restoreThreadComposerDraft();
    // 입력칸 복원 뒤에 묶는다 — 이어 붙인 질문의 '직접 입력' 답이 마지막에 들어간다.
    if (adopt) bindLiveChat(id);
    if (liveQuestion) {
      setThreadsPanelOpen(false);
      return;
    }
    if (resume) {
      // 브리지가 이 채팅을 그대로 들고 있다 — 모드와 계획만 브리지에 맞춘다.
      permissionProfile = bridge.getPermissionProfile();
      syncPlanningFromBridge();
      updateComposer();
      setThreadsPanelOpen(false);
      return;
    }
    startCurrentBridgeChat(true);
    setThreadsPanelOpen(false);
    input.focus();
  }

  /**
   * 브리지가 허브에서 이미 들고 있는 채팅(새로고침 전부터 돌던 턴·질문·계획 승인 대기)을 이 화면에
   * 묶는다. 멈추거나 다시 시작하지 않고 모드·진행 표시·질문 카드만 브리지에 맞춘다.
   */
  function bindLiveChat(id: string): void {
    bridgeThreadId = id;
    chatStartPendingThreadId = null;
    applyChatSessionState({
      agent: bridge.getActiveAgent() ?? selectedAgent,
      permissionProfile: bridge.getPermissionProfile(),
      serviceTier: bridge.getServiceTier(),
    });
    setTurnRunning(bridge.isTurnRunning());
    if (turnRunning) {
      runStatusThreadId = id;
      markChatWorking(id);
    }
    const interaction = bridge.getPendingUserQuestion();
    if (interaction?.threadId === id) {
      presentLiveQuestion(interaction);
      runStatusThreadId = id;
      markChatNeedsInput(id);
      updateComposer();
    } else {
      expireStalePendingQuestion();
    }
    const live = bridge.getHubChat();
    if (live?.threadId === id) onLiveChatAdopted(live);
  }

  /**
   * 허브의 살아 있는 턴을 이 채팅에 다시 묶은 직후(bindLiveChat, 또는 대기 중이던 시작 요청을
   * welcome 이 이어 붙인 chat-started)에 부른다. 순서를 지킨다:
   * - U4: 이 채팅의 마지막 턴 표식(kind:'turn')이 아직 열려 있으면 그 표식을 openFold 로 다시
   *   잡아, 이어 붙인 턴의 turn-end 가 그 접힘을 닫게 한다. (U4 가 채운다)
   * - S3: 이 턴을 중단으로 기록해 두었으면(live.turnId 가 같으면) 되살린다(reviveInterruptedTurn). (S3 가 채운다)
   * - U1: 대기열을 푼다(아래).
   */
  function onLiveChatAdopted(live: HubChat): void {
    // U4: 새로고침 전에 남긴 이 턴의 표식(아직 열림)을 다시 잡는다 — 그 턴의 실제 끝이 표식을
    // 정착하고, 새로고침 뒤 다시 그린 자리표시 줄 아래로 작업을 접는다.
    if (live.running) adoptUnsettledTurnFold();
    // 이어 붙인 턴의 끝은 이 사이드바가 본다 — 채팅을 열 때(attach) '작업이 끊겨'로 붙잡은 대기열을
    // 풀고, 그 턴이 끝나면 보통 규칙대로 하나씩 보낸다. 돌지 않는 세션(계획 승인 대기)에는 이 사이드바가
    // 볼 턴 끝이 없으니 붙잡은 채 둔다.
    if (live.running) followUps.adoptLiveTurn();
  }

  /** 허브 세션의 에이전트·모델·속도·권한·작업 방식을 이 채팅에 맞춘다 — chat-started 와 다시 붙이기가 함께 쓴다. */
  function applyChatSessionState(
    e: Pick<Extract<SidebarEvent, { type: 'chat-started' }>, 'agent' | 'model' | 'effort' | 'serviceTier' | 'permissionProfile'>,
  ): void {
    chatStartPendingThreadId = null;
    const prevAgent = selectedAgent;
    const prevModel = selectedModel;
    const prevEffort = selectedEffort;
    if (e.agent !== selectedAgent) {
      selectedModel = defaultModelForAgent(e.agent);
      selectedEffort = resolveEffortForAgent(e.agent, null, selectedModel);
    }
    setSelectedAgent(e.agent);
    selectedModel = resolveModelForAgent(selectedAgent, e.model ?? selectedModel);
    selectedEffort = resolveEffortForAgent(
      selectedAgent,
      e.effort ?? selectedEffort,
      selectedModel,
    );
    currentThread.agent = selectedAgent;
    currentThread.model = selectedModel;
    currentThread.effort = selectedEffort;
    if (e.serviceTier === 'fast' || e.serviceTier === 'standard') {
      selectedServiceTier = resolveServiceTier(selectedAgent, e.serviceTier);
      currentThread.serviceTier = selectedServiceTier;
    }
    if (e.permissionProfile) {
      permissionProfile = e.permissionProfile;
      updateModeChip();
    }
    // 로컬에서 이미 맞춰 둔 선택(추론 강도 등)을 서버가 그대로 메아리치면
    // 메뉴를 다시 그리지 않는다 — 열린 설정 패널이 깜빡이지 않게.
    if (selectedAgent !== prevAgent || selectedModel !== prevModel) rebuildLlmMenu();
    if (selectedAgent !== prevAgent || selectedModel !== prevModel || selectedEffort !== prevEffort) {
      rebuildEffortMenu();
    }
    updateComposer();
    // Socket-open precedes the authoritative welcome/chat-started frame,
    // so non-global reference scopes are refreshed only after the hub has
    // bound this exact thread and document identity.
    void referenceLibrary.refresh();
    // 새 채팅(welcome)·재시작 시 작업 방식과 계획 단계를 서버와 다시 맞춘다.
    syncPlanningFromBridge();
    persistCurrentThread();
  }

  /**
   * 브리지의 살아 있는 질문을 지금 채팅에 띄운다. 저장된 초안(단계·선택·직접 입력)이 같은 질문이면
   * 잇는다. 도착한 질문과 같은 길(requestQuestion)로 띄우므로, 사용자가 쓰는 중이면 이어 붙인 질문도
   * 띠로 미뤄 초점과 입력기를 빼앗지 않고 쓰기를 멈추면 열린다.
   */
  function presentLiveQuestion(interaction: UserQuestionInteraction): void {
    const stored = currentThread.pendingUserQuestion
      && pendingUserQuestionMatchesInteraction(currentThread.pendingUserQuestion, interaction)
      ? currentThread.pendingUserQuestion
      : undefined;
    currentThread.pendingUserQuestion = stored ?? createPendingUserQuestionDraftSnapshot(interaction);
    questionController.setVisible(true);
    requestQuestion(interaction, stored);
    mountQuestionTimelineAnchor();
    persistCurrentThread();
  }

  /**
   * 저장된 질문 초안이 허브의 살아 있는 질문과 이어지지 않으면 만료로 남긴다. 같은 틱에 재생될
   * 질문이 먼저 자리를 잡을 수 있게 마이크로태스크로 미룬다.
   */
  function expireStalePendingQuestion(): void {
    if (!currentThread.pendingUserQuestion) return;
    const pendingId = currentThread.pendingUserQuestion.interaction.interactionId;
    queueMicrotask(() => {
      if (currentThread.pendingUserQuestion?.interaction.interactionId !== pendingId) return;
      if (questionController.interaction()?.interactionId === pendingId) return;
      const expired = expirePendingUserQuestion(currentThread, 'request-invalidated', pendingId);
      if (!expired) return;
      persistCurrentThread();
      appendConversation(renderUserQuestionHistory(expired));
    });
  }

  threadsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    // 전체 화면에서는 페이지 전환이 아니라 레일 접기 토글이다.
    if (fullscreen) {
      if (isCompactWorkspace()) {
        compactRailHoverOpen = false;
        setCompactThreadsRailOpen(!compactThreadsRailOpen);
        return;
      }
      setThreadsRailCollapsed(!threadsRailCollapsed);
      return;
    }
    setThreadsPanelOpen(true);
  });
  threadsClose.addEventListener('click', (e) => {
    e.stopPropagation();
    setThreadsPanelOpen(false);
    threadsBtn.focus();
  });
  threadsPage.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // 전체 화면 레일에서는 문서 Esc 핸들러가 모드를 접도록 넘긴다.
      if (fullscreen && !isCompactWorkspace()) return;
      e.preventDefault();
      if (isCompactWorkspace()) {
        setCompactThreadsRailOpen(false);
        workspaceThreadsBtn.focus();
        return;
      }
      setThreadsPanelOpen(false);
      threadsBtn.focus();
    }
  });

  // ── 상태 반영 헬퍼 ────────────────────────────────────
  function setSelectedAgent(agent: AgentName): void {
    const agentChanged = agent !== selectedAgent;
    selectedAgent = agent;
    root.dataset.agent = agent;
    providerName.textContent = AGENT_LABEL[agent];
    if (agentChanged) {
      const nextIcon = createProviderIcon(agent);
      providerIcon.replaceWith(nextIcon);
      providerIcon = nextIcon;
    }
    for (const [name, item] of providerItems) {
      const active = name === agent;
      item.classList.toggle('ag-active', active);
      item.setAttribute('aria-checked', active ? 'true' : 'false');
    }
    syncProviderMenu();
    if (activeComposerSkill) composerSkill.dataset.agent = agent;
    updateWorkspaceAgentContext();
  }

  function setConnection(
    state: ConnectionState,
    meta?: { attempt?: number; retryInMs?: number },
  ): void {
    connState = state;
    if (typeof meta?.attempt === 'number') connAttempt = meta.attempt;
    if (state === 'connected') connAttempt = 0;
    takeoverBtn.hidden = state !== 'replaced';
    if (state === 'replaced') setConfigPanelOpen(false);
    // 점과 스크린리더 문구는 400ms 를 넘긴 상태만 보인다. 판단은 실제 connState 로 한다.
    connStatus.set(state === 'connected' ? null : state);
    renderConnStatus();
    referenceLibrary.setConnectionState(state);
    updateComposer();
  }

  /**
   * 점 색: 첫 시도·잠깐의 끊김은 회색 맥박, 두 번 넘게 실패하면 빨강.
   * 백오프 중 connecting/disconnected 가 번갈아 와도 점이 깜빡이지 않는다.
   * 400ms 안에 돌아온 연결은 점도 문구도 남기지 않는다(connStatus).
   */
  function renderConnStatus(): void {
    const shownState = connStatus.shown ?? 'connected';
    const down = shownState === 'disconnected' || (shownState === 'connecting' && connAttempt >= 2);
    const visual = shownState === 'connected'
      ? 'connected'
      : shownState === 'replaced'
        ? 'replaced'
        : down ? 'disconnected' : 'connecting';
    // 같은 문구를 다시 쓰면 스크린리더가 또 읽는다.
    if (conn.textContent !== CONN_LABEL[shownState]) conn.textContent = CONN_LABEL[shownState];
    connDot.dataset.state = visual;
    connDot.hidden = visual === 'connected';
    connDot.setAttribute('aria-label', CONN_LABEL[shownState]);
    connDot.title = visual === 'disconnected' ? '연결 끊김' : CONN_LABEL[shownState];
    if (visual === 'connected' || visual === 'replaced') {
      setConnPopoverOpen(false);
      return;
    }
    connPopoverText.textContent = visual === 'disconnected' ? '허브 연결 끊김' : '연결 중';
    connCommand.hidden = managedHub || visual !== 'disconnected';
  }

  function setTurnRunning(running: boolean): void {
    turnRunning = running;
    if (!running) replyPending = false;
    updateTurnPending();
    updateComposer();
    rebuildReview();
    // 다시 시도·리셋 후 이어서는 턴이 도는 동안 막힌다.
    failureNotices.refresh();
  }

  /** 턴이 정상 종료 경로 없이 꺼졌을 때(중단·재연결·오류) 노란 불을 걷는다. */
  function dropRunStatusIfIdle(): void {
    if (turnRunning || runStatusThreadId === null) return;
    clearChatStatus(runStatusThreadId);
    runStatusThreadId = null;
  }

  /** 계획에 응답이 닿았다(승인·수정 요청·무효화) — 빨간 점을 걷는다. */
  function settlePlanAttention(): void {
    if (getChatStatus(currentThread.id) === 'needs-input') clearChatStatus(currentThread.id);
  }

  /** 입력이 비어 있으면 보내기 버튼을 가라앉힌 색으로 쉬게 한다 — 눌림 동작은 그대로다. */
  function syncSendIdle(): void {
    const idle = !send.classList.contains('ag-stop')
      && input.value.trim() === ''
      && activeComposerSkill === null;
    send.classList.toggle('ag-send-idle', idle);
  }

  /** 입력기를 잠깐 잠그는 실제 까닭. 보이는 잠금은 composerLock 이 400ms 늦춰 정한다. */
  function realComposerLock(): ComposerLock | null {
    if (connState === 'replaced') return 'replaced';
    if (connState !== 'connected') return connState;
    if (chatStartPendingThreadId !== null) return 'starting';
    if (workflowTransitionPending || planActionPending) return 'switching';
    if (attachmentsSending) return 'attaching';
    return null;
  }

  /** 잠금 상태를 microtask 로 다시 그린다 — 지연 상태의 알림이 updateComposer 에 다시 들어오지 않게. */
  function scheduleComposerUpdate(): void {
    if (composerUpdateQueued) return;
    composerUpdateQueued = true;
    queueMicrotask(() => {
      composerUpdateQueued = false;
      if (root.dataset.disposed !== 'true') updateComposer();
    });
  }

  /** 보이는 잠금 — disabled 가 아니라 readOnly 라 입력기의 초점·캐럿·한글 조합이 그대로 남는다. */
  function showComposerLock(locked: boolean): void {
    if (input.readOnly === locked) return;
    input.readOnly = locked;
    if (locked) input.setAttribute('aria-disabled', 'true');
    else input.removeAttribute('aria-disabled');
    composer.classList.toggle('ag-composer-locked', locked);
  }

  function updateComposer(): void {
    if (composerRest.resting && !canComposerRest()) composerRest.setResting(false);
    updateReconnectChip();
    updateCalibrationChip();
    syncProviderMenu();
    const realLock = realComposerLock();
    composerUpdating = true;
    try {
      composerLock.set(realLock);
    } finally {
      composerUpdating = false;
    }
    const shownLock = composerLock.shown;
    const questionPresented = questionController.isPresented();
    const questionUsesComposer = questionController.usesComposerForOther();
    // 테스트·자동화가 읽는 실제 준비 상태. 보이는 잠금의 지연과 무관하다.
    root.dataset.composerReady = String(realLock === null
      && !mergeResolverLocked
      && readOnlyDocLabel === null
      && !(questionPresented && !questionUsesComposer));
    // 다른 문서의 채팅 열람 중에는 연결/작업 상태와 무관하게 잠긴다.
    if (mergeResolverLocked) {
      showComposerLock(false);
      input.disabled = true;
      send.disabled = true;
      composerSkillClear.disabled = true;
      input.placeholder = '병합 검토 중에는 에이전트 작업을 시작할 수 없습니다';
    } else if (readOnlyDocLabel !== null) {
      showComposerLock(false);
      input.disabled = true;
      send.disabled = true;
      composerSkillClear.disabled = true;
      input.placeholder = `"${readOnlyDocLabel}" 문서의 채팅 — 읽기 전용`;
    } else {
      // disabled 는 구조적인 잠금(질문이 입력기를 넘겨받음)에만 쓴다. 연결·시작·전환처럼
      // 잠깐 지나가는 잠금은 400ms 를 넘긴 뒤에만 readOnly 로 보인다. 보내기는 언제나
      // 실제 상태로 막는다(submit 처리기).
      const locked = shownLock !== null;
      input.disabled = questionPresented && !questionUsesComposer;
      showComposerLock(locked && !input.disabled);
      send.disabled = locked
        || (!questionPresented && referenceLibrary.hasBlockingDrafts());
      composerSkillClear.disabled = input.disabled || locked;
      input.placeholder = questionPresented
        ? questionUsesComposer ? '직접 답변 입력' : '위 질문에 답변'
        : shownLock === 'switching'
        ? '전환을 적용하는 중…'
        : shownLock === 'starting'
        ? '채팅을 여는 중…'
        : shownLock === 'connecting'
        ? '허브에 연결하는 중…'
        : shownLock === 'disconnected'
        ? '허브 연결이 끊겼어요. 다시 연결되면 입력할 수 있어요'
        : shownLock === 'replaced'
        ? CONN_LABEL.replaced
        : activeComposerSkill
          ? '추가 요청 (선택)'
        : chatWorkflow === 'plan' && planningPhase === 'awaiting-approval'
          ? revisionPlanId ? '계획에서 바꿀 부분' : '계획에 대해 질문하거나 의견 남기기'
          : chatWorkflow === 'question'
            ? '질문 입력'
          : chatWorkflow === 'plan' && planningPhase === 'planning'
            ? '구상할 내용 입력'
            : '문서 작업 입력';
    }
    const stopping = turnRunning && !(questionPresented && questionUsesComposer);
    const sendLabel = questionPresented && questionUsesComposer ? '답변 계속'
      : stopping ? '중지' : '보내기';
    const sendIcon = stopping ? 'stop' : 'send';
    if (send.dataset.icon !== sendIcon) {
      send.replaceChildren(stopping ? createStopIcon() : createIcon('send'));
      send.dataset.icon = sendIcon;
    }
    send.setAttribute('aria-label', sendLabel);
    send.title = sendLabel;
    send.classList.toggle('ag-stop', stopping);
    syncSendIdle();
    // 실행 중에는 Enter 가 전송이 아니므로 힌트를 숨긴다.
    // 잠깐 지나가는 잠금은 입력기처럼 보이는 잠금을 따른다 — 힌트도 깜빡이지 않는다.
    sendHint.hidden = stopping || shownLock !== null
      || referenceLibrary.hasBlockingDrafts()
      || readOnlyDocLabel !== null
      || mergeResolverLocked;
    // 실행 중이거나 작업 방식/계획→실행 전환 중에는 모드·모델·권한을 잠근다.
    const controlsLocked = isControlLocked();
    const selectionLocked = isSelectionLocked();
    providerTrigger.disabled = selectionLocked;
    llmTrigger.disabled = selectionLocked;
    effortTrigger.disabled = selectionLocked;
    effortSlider.setDisabled(selectionLocked);
    const selectionHint = selectionLocked
      ? '진행 중인 작업이 끝나면 바꿀 수 있습니다'
      : '프로바이더 · 모델 · 추론 강도 변경 (다음 턴부터 적용)';
    providerTrigger.title = selectionHint;
    llmTrigger.title = selectionHint;
    effortTrigger.title = selectionHint;
    updateModeChip();
    // 턴 실행·첨부·모드 전환 중에는 설정 패널을 접는다. 모델/추론 강도를 바꾸는
    // 순간 채팅을 다시 여는 잠금(chatStartPending)은 패널을 유지한다 — 바깥을
    // 누르기 전까지는 그대로 두고 이어서 고를 수 있게.
    if (selectionLocked && chatStartPendingThreadId === null) setConfigPanelOpen(false);
    updateWorkflowControl();
    scheduleChatModeLockCheck();
    syncFollowUpComposerCues();
    followUps.render();
  }

  function conversationTail(): HTMLElement {
    return !turnPending.hidden && turnPending.parentElement === messages
      ? turnPending
      : messagesEnd;
  }

  function appendConversation(node: HTMLElement): void {
    messages.insertBefore(node, conversationTail());
  }

  function questionArrivalKey(interactionId: string): string {
    return `question:${interactionId}`;
  }

  /** 질문을 띄운다. 사용자가 쓰는 중이면 띠로 미루고, 쓰기를 멈추면 연다. */
  function requestQuestion(
    interaction: UserQuestionInteraction,
    stored?: Partial<UserQuestionDraftState>,
  ): void {
    const key = questionArrivalKey(interaction.interactionId);
    // 새 질문이 앞 질문을 갈아 치우면 앞 질문의 보류는 거둔다.
    if (heldQuestionKey !== null && heldQuestionKey !== key) arrivalGuard.cancel(heldQuestionKey);
    heldQuestionKey = key;
    const held = arrivalGuard.hold(key, () => questionController.present());
    questionController.request(interaction, stored, { held });
  }

  function mountQuestionTimelineAnchor(): void {
    const interaction = questionController.interaction();
    if (interaction?.threadId !== currentThread.id) return;
    questionTimelineAnchorInteractionId = interaction.interactionId;
    if (questionTimelineAnchor.parentElement === messages) return;
    withAutoScroll(() => appendConversation(questionTimelineAnchor));
  }

  function resetConversation(): void {
    replyPending = false;
    settledAnswer = null;
    followConversationEnd = false;
    turnPendingStatus.reset();
    turnPending.hidden = true;
    // 편대 카드는 도구 행처럼 휘발성이다 — 대화를 갈아 끼우면 타이머까지 버린다.
    suppressedSpawnCalls.clear();
    fleetView.reset();
    questionTimelineAnchorInteractionId = null;
    turnFoldRows.clear();
    turnFoldResizeObserver?.disconnect();
    failureNotices.forgetNodes();
    messages.replaceChildren(turnPending, messagesEnd);
  }

  function latestTurnAnchor(): HTMLElement | null {
    const last = messagesEnd.previousElementSibling;
    let content = skipTurnFoldPlaceholders(last === turnPending ? turnPending.previousElementSibling : last);
    // 첫 문단을 보류 중인 빈 답변은 감춰져 있으므로 그 앞 메시지를 기준으로 삼는다.
    const answerVisible = Boolean(streamBubble && hasRenderedBlocks(streamBubble));
    if (streamBubble && content === streamBubble && !answerVisible) {
      content = skipTurnFoldPlaceholders(streamBubble.previousElementSibling);
    }
    if (!(content instanceof HTMLElement)) return null;
    // Keep a newly sent prompt near the top, then follow the moving end of the
    // current agent output instead of remaining pinned to that prompt.
    if (content.classList.contains('ag-msg-user')) return content;
    if (followConversationEnd) return messagesEnd;
    // A long answer stops following once its first line reaches the focus line,
    // so the reader starts at the top instead of chasing the newest paragraph.
    if (answerVisible) return streamBubble;
    // 끝난 답변 아래로 다른 내용이 붙으면 다시 끝을 따라간다.
    const settledIsLast = settledAnswer !== null && content === settledAnswer;
    return settledIsLast ? settledAnswer : messagesEnd;
  }

  function conversationAnchorTop(node: HTMLElement): number {
    return node.getBoundingClientRect().top - messages.getBoundingClientRect().top + messages.scrollTop;
  }

  function conversationScrollTarget(node: HTMLElement): number {
    const maxScroll = Math.max(0, messages.scrollHeight - messages.clientHeight);
    const target = Math.max(0, conversationAnchorTop(node) - conversationFocusOffset());
    return Math.min(target, maxScroll);
  }


  /** 새 턴이 뷰포트 위쪽에 머물고, 아래는 답변이 내려올 자리로 비운다. */
  function conversationFocusOffset(): number {
    return Math.round(messages.clientHeight * 0.14);
  }

  /**
   * 끝 여백은 마지막 질문이 초점선까지 올라갈 만큼만 둔다. 답변이 화면을 채우면
   * 여백이 사라져, 맨 아래로 내렸을 때 마지막 내용이 입력기 바로 위에 멈춘다.
   */
  function syncConversationSpacer(): void {
    const style = getComputedStyle(messages);
    const gap = Number.parseFloat(style.rowGap) || 0;
    const padding = Number.parseFloat(style.paddingBottom) || 0;
    setConversationEndStyle('marginTop', `${-gap}px`);
    let question = messagesEnd.previousElementSibling;
    while (question && !question.classList.contains('ag-msg-user')) question = question.previousElementSibling;
    if (!(question instanceof HTMLElement)) {
      setConversationEndStyle('minHeight', '0px');
      return;
    }
    const room = conversationAnchorTop(question) - conversationFocusOffset() + messages.clientHeight;
    const spacer = room - conversationAnchorTop(messagesEnd) - padding;
    setConversationEndStyle('minHeight', `${Math.max(0, Math.round(spacer))}px`);
  }

  /** 값이 같으면 쓰지 않는다 — 쓰기마다 레이아웃이 더러워져 다음 읽기가 다시 배치를 강제한다. */
  function setConversationEndStyle(property: 'marginTop' | 'minHeight', value: string): void {
    if (messagesEnd.style[property] === value) return;
    messagesEnd.style[property] = value;
    conversationScrollTargetValue = null;
  }

  function isConversationFollowingTurn(): boolean {
    const anchor = latestTurnAnchor();
    if (!anchor) {
      return messages.scrollHeight - messages.scrollTop - messages.clientHeight <= 56;
    }
    return Math.abs(messages.scrollTop - conversationScrollTarget(anchor)) <= 64;
  }

  function lockConversationScroll(ms: number): void {
    conversationScrollLock = true;
    const until = performance.now() + ms;
    conversationScrollUnlockAt = until;
    // 스프링은 프레임마다 잠금을 늘린다. 타이머를 매번 새로 걸지 않고, 깨어난 타이머가 남은 만큼 다시 잔다.
    if (conversationScrollUnlock !== null && conversationScrollUnlockTimerAt <= until) return;
    armConversationScrollUnlock(ms);
  }

  function armConversationScrollUnlock(ms: number): void {
    if (conversationScrollUnlock !== null) window.clearTimeout(conversationScrollUnlock);
    conversationScrollUnlockTimerAt = performance.now() + ms;
    conversationScrollUnlock = window.setTimeout(() => {
      conversationScrollUnlock = null;
      const remaining = conversationScrollUnlockAt - performance.now();
      if (remaining > 0) {
        armConversationScrollUnlock(remaining);
        return;
      }
      conversationScrollLock = false;
    }, ms);
  }

  function cancelConversationScroll(): void {
    conversationScrollTargetNode = null;
    conversationScrollTargetValue = null;
    conversationScrollSmooth = false;
    conversationScrollState = null;
    conversationScrollConfigCache = undefined;
    conversationScrollLastFrame = 0;
    if (conversationScrollRaf !== null) window.cancelAnimationFrame(conversationScrollRaf);
    conversationScrollRaf = null;
  }

  function stopFollowingConversation(): void {
    followConversation = false;
    conversationScrollPaused = true;
    conversationLastScrollTop = messages.scrollTop;
    cancelConversationScroll();
    conversationScrollLock = false;
    if (conversationScrollUnlock !== null) {
      window.clearTimeout(conversationScrollUnlock);
      conversationScrollUnlock = null;
    }
  }

  /** 이보다 작은 보정은 따라가지 않는다 — 블록마다 1px 씩 오르내리는 떨림을 막는다. */
  const CONVERSATION_SCROLL_DEADBAND_PX = 2;

  /**
   * 대화 스크롤 스프링. 전송은 slow 토큰, 스트리밍·턴 끝 재정렬은 base 토큰으로 움직인다.
   * 동작 줄이기(1ms 토큰)에서는 null — 바로 옮긴다.
   */
  function conversationScrollConfig(smooth: boolean): ReturnType<typeof springForDuration> {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
    const style = getComputedStyle(document.documentElement);
    const token = style.getPropertyValue(smooth ? '--ag-dur-slow' : '--ag-dur-base');
    return springForDuration(parseCssTimeMs(token, smooth ? 320 : 180), { dpr: window.devicePixelRatio });
  }

  function roundedConversationTarget(node: HTMLElement): number {
    return Math.round(conversationScrollTarget(node));
  }

  /**
   * 스프링 목표는 대화 내용·여백·영역 크기가 바뀔 때만 다시 잰다(대화 변경 처리,
   * 크기 관찰, 여백 쓰기가 비운다). 전송 직후 끝 여백·입력기 높이가 바뀌어도 그 변경이 비운다.
   */
  function springConversationTarget(node: HTMLElement): number {
    if (conversationScrollTargetValue === null || conversationScrollTargetFor !== node) {
      conversationScrollTargetValue = roundedConversationTarget(node);
      conversationScrollTargetFor = node;
    }
    return conversationScrollTargetValue;
  }

  function animateConversationScroll(now: number): void {
    conversationScrollRaf = null;
    const node = conversationScrollTargetNode;
    if (!node?.isConnected || !followConversation) {
      cancelConversationScroll();
      return;
    }
    const target = springConversationTarget(node);
    const actual = messages.scrollTop;
    // 설정은 스크롤을 시작할 때 한 번 읽는다. 매 프레임 계산 스타일을 읽으면 스타일 재계산이 강제된다.
    const config = conversationScrollConfigCache
      ?? (conversationScrollConfigCache = conversationScrollConfig(conversationScrollSmooth));
    if (!config) {
      lockConversationScroll(80);
      messages.scrollTop = target;
      cancelConversationScroll();
      return;
    }
    let state = conversationScrollState ?? { x: actual, v: 0 };
    // 브라우저가 스크롤을 잘라 냈으면(내용이 줄어듦) 실제 위치에서 이어 간다.
    if (Math.abs(actual - state.x) > 1.5) state = { x: actual, v: state.v };
    const dt = conversationScrollLastFrame > 0 ? now - conversationScrollLastFrame : 1000 / 60;
    const next = stepSpring(state, target, dt, config);
    conversationScrollLastFrame = now;
    lockConversationScroll(80);
    if (next.settled) {
      messages.scrollTop = target;
      cancelConversationScroll();
      return;
    }
    conversationScrollState = { x: next.x, v: next.v };
    messages.scrollTop = snapToDevicePixel(next.x, window.devicePixelRatio);
    conversationScrollRaf = window.requestAnimationFrame(animateConversationScroll);
  }

  function scrollConversationToMessage(node: HTMLElement, opts?: { smooth?: boolean }): void {
    followConversation = true;
    conversationScrollPaused = false;
    syncConversationSpacer();
    const smooth = opts?.smooth === true;
    const running = conversationScrollRaf !== null;
    if (!running) {
      // 멈춰 있을 때 2px 아래 보정은 무시한다. 목표를 정수로 반올림해 오르내림이 없다.
      const delta = roundedConversationTarget(node) - messages.scrollTop;
      if (Math.abs(delta) < CONVERSATION_SCROLL_DEADBAND_PX) {
        conversationScrollTargetNode = null;
        return;
      }
      const config = conversationScrollConfig(smooth);
      conversationScrollConfigCache = config;
      if (config && smooth) {
        // 전송은 정지에서 출발한다. 사이드바와 같은 출발 보정으로 첫 프레임부터 움직인다.
        const from = messages.scrollTop;
        conversationScrollState = { x: from, v: planSpring({ x: from, v: 0 }, from + delta, config).v0 };
      } else {
        conversationScrollState = null;
      }
      conversationScrollLastFrame = 0;
    }
    // 움직이는 중에는 목표만 바꾼다 — 위치·속도가 그대로 이어진다.
    conversationScrollTargetNode = node;
    const nextSmooth = conversationScrollSmooth && running ? true : smooth;
    // 도중에 slow↔base 가 바뀌면 다음 프레임에서 설정을 다시 읽는다.
    if (running && nextSmooth !== conversationScrollSmooth) conversationScrollConfigCache = undefined;
    conversationScrollSmooth = nextSmooth;
    if (conversationScrollRaf === null) conversationScrollRaf = window.requestAnimationFrame(animateConversationScroll);
  }

  function updateTurnPending(agent?: AgentName): void {
    const editAgent = bridge.pendingEdits.getChangeSets()
      .find((set) => set.status === 'open')?.agent ?? null;
    // 첫 문단이 완성되기 전의 빈 답변은 아직 대기 중으로 본다.
    const waiting = (replyPending || turnRunning) && !(streamBubble && hasRenderedBlocks(streamBubble));
    const show = waiting || editAgent !== null;
    turnPendingStatus.set(show ? agent ?? editAgent ?? selectedAgent : null);
    // 보이는 고리는 언제나 대화 끝에 선다.
    if (turnPendingStatus.shown !== null && turnPending.nextSibling !== messagesEnd) {
      messages.insertBefore(turnPending, messagesEnd);
    }
  }

  function scrollConversationToEnd(): void {
    const anchor = latestTurnAnchor();
    if (anchor) {
      scrollConversationToMessage(anchor);
      return;
    }
    followConversation = true;
    conversationScrollPaused = false;
    syncConversationSpacer();
  }

  /**
   * 새 출력은 따라가되, 사용자가 위로 스크롤하면 현재 위치를 존중한다.
   * 따라갈지는 바꾸기 전에 정하고, 재기는 대화 변경 처리 한 번에 맡긴다.
   */
  function withAutoScroll(mutate: () => void): void {
    const shouldFollow = followConversation || (!conversationScrollPaused && isConversationFollowingTurn());
    mutate();
    if (shouldFollow) {
      followConversation = true;
      conversationScrollPaused = false;
    }
    queueConversationLayout();
  }

  /** 실행 중인 도구 내역은 높이를 늘리지 않고 항상 최신 단계를 보여준다. */
  function isActivityFollowingLatest(content: HTMLElement): boolean {
    return content.scrollHeight - content.scrollTop - content.clientHeight <= 48;
  }

  function scrollActivityToLatest(content: HTMLElement, force = false): void {
    const scrollTop = content.scrollTop;
    window.requestAnimationFrame(() => {
      if (!content.isConnected || (!force && content.scrollTop !== scrollTop)) return;
      content.scrollTop = content.scrollHeight;
    });
  }

  function systemMessage(text: string): void {
    currentThread.messages.push({ role: 'system', text, agent: selectedAgent });
    persistCurrentThread();
    withAutoScroll(() => appendConversation(el('div', 'ag-msg ag-msg-system ag-msg-enter', text)));
  }

  /** 현재 대화의 CLI 세션을 강제로 다시 띄운다 (설정 탭·스폰 실패 재시도 공용). */
  function restartAgentSession(): void {
    startCurrentBridgeChat(true);
  }

  /**
   * 실패 알림의 '다시 시도' — 저장된 요청을 컴포저와 같은 길로 다시 보낸다. 입력 중인 초안은
   * 건드리지 않고, 컴포저와 같은 조건에서만 보낸다. 보내지 못했으면 false.
   */
  function resendFailedRequest(retry: ThreadRetryPayload): boolean {
    if (readOnlyDocLabel !== null || agentWorking() || questionController.hasPending()
      || engineTrap() !== null || followUpSendBlockedReason() !== null) {
      if (active) showToast({ message: '지금은 다시 보낼 수 없어요', durationMs: 2400 });
      return false;
    }
    const base: ThreadRetryPayload = {
      displayText: retry.displayText,
      requestText: retry.requestText,
      ...(retry.skillName ? { skillName: retry.skillName } : {}),
      ...(retry.skillName && retry.skillIcon ? { skillIcon: retry.skillIcon } : {}),
    };
    // 보내는 길은 하나다 — 템플릿·스킬 머리말은 다시 만들지 않고 저장한 요청문을 그대로 싣는다.
    sendComposedMessage({
      text: retry.displayText,
      origin: 'retry',
      wire: { displayText: retry.displayText, requestText: retryRequestText(retry) },
      ...(base.skillName ? { skillName: base.skillName } : {}),
      ...(base.skillIcon ? { skillIcon: base.skillIcon } : {}),
    });
    // 다음 실패의 다시 시도는 안내를 붙이기 전 본문에서 다시 시작한다 — 안내가 겹쳐 쌓이지 않는다.
    failureNotices.noteSend(currentThread.id, base);
    // 다시 보낸 요청이 대기열 앞에 선다. 붙잡음을 풀어 그 턴의 정상 종료가 맨 앞을 보내게 한다.
    followUps.release();
    return true;
  }

  /** 설정 탭에서 저장된 기본값 — 새 대화부터 적용된다. */
  function applyAgentPrefs(prefs: AgentPrefs): void {
    agentPrefs = prefs;
    rebuildLlmMenu();
  }

  function openAssistantBubble(agent: AgentName): HTMLElement {
    const bubble = el('div', `ag-msg ag-msg-assistant ag-${agent}`);
    streamBubble = bubble;
    updateTurnPending(agent);
    withAutoScroll(() => appendConversation(bubble));
    return bubble;
  }

  function setActivityLabel(
    activity: TurnActivityState,
    text: string,
  ): void {
    if (activity.label.textContent === text) return;
    activity.label.textContent = text;
  }

  /** 로그 행용 짧은 소요 시간 — 1초 미만은 ms, 그 위는 s. 폭이 흔들리지 않게 짧게. */
  function formatElapsed(startedAt: number): string {
    const ms = Math.max(0, performance.now() - startedAt);
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.round(ms / 60_000)}m`;
  }

  function activityLabel(activity: TurnActivityState): string {
    return summarizeActivity(activity.calls);
  }

  function settleActivity(activity: TurnActivityState) {
    if (activity.settled || activity.acceptingTools || activity.activeTools.size > 0) return;
    activity.settled = true;
    if (activity.failedToolCount > 0) {
      setActivityLabel(activity, activityLabel(activity));
      activity.root.classList.add('ag-activity-error');
    } else {
      setActivityLabel(activity, activityLabel(activity));
      activity.root.classList.add('ag-activity-complete');
    }
    activity.root.classList.remove('ag-activity-running');
  }

  function transcriptId(prefix: string): string {
    return globalThis.crypto?.randomUUID?.()
      ?? `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  function ensureActivityTranscript(agent: AgentName): ActivityTranscriptState {
    if (activityTranscript) return activityTranscript;
    const message: ThreadActivityMessage = {
      role: 'assistant',
      kind: 'activity',
      activityId: transcriptId('activity'),
      text: '도구 호출',
      agent,
      status: 'running',
      startedAt: Date.now(),
      completedAt: null,
      tools: [],
    };
    const state = { message, acceptingTools: true };
    currentThread.messages.push(message);
    activityTranscript = state;
    activityTranscripts.set(message.activityId, state);
    queueTranscriptPersist();
    return state;
  }

  function settleActivityTranscript(state: ActivityTranscriptState): void {
    if (state.acceptingTools || state.message.tools.some((tool) => tool.status === 'running')) return;
    state.message.completedAt = Date.now();
    state.message.status = state.message.tools.some((tool) => tool.status === 'failed')
      ? 'failed'
      : state.message.tools.some((tool) => tool.status === 'stopped')
        ? 'stopped'
        : 'completed';
    queueTranscriptPersist();
  }

  function closeActivityTranscript(): void {
    const state = activityTranscript;
    if (!state) return;
    state.acceptingTools = false;
    activityTranscript = null;
    settleActivityTranscript(state);
  }

  function recordActivityToolCall(event: Extract<AgentStreamEvent, { type: 'tool-call' }>): void {
    const state = ensureActivityTranscript(event.agent);
    const tool: ThreadToolRecord = {
      callId: event.callId,
      tool: event.tool,
      argsJson: event.argsJson,
      status: 'running',
      resultPreview: '',
      elapsedMs: null,
    };
    state.message.tools.push(tool);
    transcriptTools.set(event.callId, { tool, activity: state, startedAt: Date.now() });
    queueTranscriptPersist();
  }

  function recordActivityToolResult(event: Extract<AgentStreamEvent, { type: 'tool-result' }>): void {
    const entry = transcriptTools.get(event.callId);
    if (!entry) return;
    transcriptTools.delete(event.callId);
    entry.tool.status = event.ok ? 'completed' : 'failed';
    entry.tool.resultPreview = event.resultPreview;
    entry.tool.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
    settleActivityTranscript(entry.activity);
    queueTranscriptPersist();
  }

  function sweepActivityTranscripts(): void {
    const touched = new Set<ActivityTranscriptState>();
    for (const [, entry] of transcriptTools) {
      entry.tool.status = 'stopped';
      entry.tool.resultPreview ||= '(결과 없이 종료됨)';
      entry.tool.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
      touched.add(entry.activity);
    }
    transcriptTools.clear();
    for (const state of activityTranscripts.values()) state.acceptingTools = false;
    closeActivityTranscript();
    for (const state of touched) settleActivityTranscript(state);
    activityTranscripts.clear();
  }

  function ensureTasksTranscript(agent: AgentName): ThreadTasksMessage {
    if (tasksTranscript) return tasksTranscript;
    tasksTranscript = {
      role: 'assistant',
      kind: 'tasks',
      taskGroupId: transcriptId('tasks'),
      text: '서브에이전트와 워크플로',
      agent,
      status: 'running',
      tasks: [],
    };
    currentThread.messages.push(tasksTranscript);
    queueTranscriptPersist();
    return tasksTranscript;
  }

  function recordTaskStart(event: Extract<AgentStreamEvent, { type: 'task-start' }>): void {
    const group = ensureTasksTranscript(event.agent);
    const task: ThreadTaskRecord = {
      taskId: event.taskId,
      taskKind: event.taskKind,
      title: event.title,
      role: event.role ?? '',
      workflowName: event.workflowName ?? '',
      status: 'running',
      activity: '',
      summary: '',
      totalTokens: null,
      toolUses: null,
      durationMs: null,
      tools: [],
    };
    group.tasks.push(task);
    transcriptTasks.set(event.taskId, task);
    queueTranscriptPersist();
  }

  function recordTaskProgress(event: Extract<AgentStreamEvent, { type: 'task-progress' }>): void {
    const task = transcriptTasks.get(event.taskId);
    if (!task) return;
    if (event.lastTool) task.activity = `▸ ${event.lastTool}`;
    else if (event.activity) task.activity = event.activity;
    if (event.usage?.totalTokens !== undefined) task.totalTokens = event.usage.totalTokens;
    if (event.usage?.toolUses !== undefined) task.toolUses = event.usage.toolUses;
    if (event.usage?.durationMs !== undefined) task.durationMs = event.usage.durationMs;
    queueTranscriptPersist();
  }

  function recordTaskText(taskId: string, text: string): void {
    const task = transcriptTasks.get(taskId);
    if (!task) return;
    const buffer = `${taskTextBuffers.get(taskId) ?? ''}${text}`;
    taskTextBuffers.set(taskId, buffer.slice(-1000));
    task.activity = truncate(buffer, 140);
  }

  function recordTaskToolCall(event: Extract<AgentStreamEvent, { type: 'tool-call' }>): void {
    if (!event.parentTaskId) return;
    const task = transcriptTasks.get(event.parentTaskId);
    if (!task) return;
    const tool: ThreadToolRecord = {
      callId: event.callId,
      tool: event.tool,
      argsJson: event.argsJson,
      status: 'running',
      resultPreview: '',
      elapsedMs: null,
    };
    task.tools.push(tool);
    taskToolRecords.set(event.callId, { tool, task, startedAt: Date.now() });
    queueTranscriptPersist();
  }

  function recordTaskToolResult(event: Extract<AgentStreamEvent, { type: 'tool-result' }>): void {
    const entry = taskToolRecords.get(event.callId);
    if (!entry) return;
    taskToolRecords.delete(event.callId);
    entry.tool.status = event.ok ? 'completed' : 'failed';
    entry.tool.resultPreview = event.resultPreview;
    entry.tool.elapsedMs = Math.max(0, Date.now() - entry.startedAt);
    queueTranscriptPersist();
  }

  function recordTaskEnd(event: Extract<AgentStreamEvent, { type: 'task-end' }>): void {
    const task = transcriptTasks.get(event.taskId);
    if (!task) return;
    task.status = event.status;
    if (event.summary) {
      task.summary = event.summary;
      task.activity = event.summary;
    }
    if (event.usage?.totalTokens !== undefined) task.totalTokens = event.usage.totalTokens;
    if (event.usage?.toolUses !== undefined) task.toolUses = event.usage.toolUses;
    if (event.usage?.durationMs !== undefined) task.durationMs = event.usage.durationMs;
    queueTranscriptPersist();
  }

  function sweepTasksTranscript(): void {
    if (!tasksTranscript) return;
    for (const task of tasksTranscript.tasks) {
      if (task.status === 'running') task.status = 'stopped';
      for (const tool of task.tools) {
        if (tool.status === 'running') {
          tool.status = 'stopped';
          tool.resultPreview ||= '(결과 없이 종료됨)';
        }
      }
    }
    tasksTranscript.status = tasksTranscript.tasks.some((task) => task.status === 'failed')
      ? 'failed'
      : tasksTranscript.tasks.some((task) => task.status === 'stopped')
        ? 'stopped'
        : 'completed';
    tasksTranscript = null;
    transcriptTasks.clear();
    taskToolRecords.clear();
    taskTextBuffers.clear();
    persistCurrentThread();
  }

  function closeCurrentActivityGroup() {
    const activity = turnActivity;
    if (!activity) return;
    activity.acceptingTools = false;
    turnActivity = null;
    closeActivityTranscript();
    settleActivity(activity);
  }

  /**
   * 펼쳐 둔 도구 활동 그룹을 접는다 — 편대 팝업이 열릴 때 불린다.
   *
   * 지금 열려 있는 그룹(turnActivity)만 보면 안 된다: 카드가 슬롯을 잡을 때
   * closeCurrentActivityGroup 이 참조를 놓아 버리므로, 방금 닫힌 그룹을 사용자가
   * 펼쳐 두면 팝업과 함께 둘이 펼쳐진 채 남는다. 그룹 토글도 어느 그룹이든
   * 팝업을 닫으므로 이쪽도 흐름 전체를 훑어 대칭을 맞춘다.
   */
  function collapseTurnActivity() {
    const expanded = messages.querySelectorAll<HTMLElement>(
      '.ag-activity:not(.ag-activity-collapsed)',
    );
    for (const activity of expanded) {
      activity.classList.add('ag-activity-collapsed');
      activity.querySelector('.ag-activity-toggle')?.setAttribute('aria-expanded', 'false');
      const content = activity.querySelector<HTMLElement>('.ag-activity-content');
      if (content) content.tabIndex = -1;
    }
  }

  function ensureTurnActivity(agent: AgentName, milestone?: HTMLElement | null) {
    if (turnActivity) return turnActivity;

    const activity = el('div', `ag-activity ag-${agent} ag-activity-running ag-activity-collapsed`);
    const toggle = el('button', 'ag-activity-toggle') as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', 'false');
    const label = el('span', 'ag-activity-label', '도구 호출');
    label.setAttribute('aria-live', 'polite');
    const chevron = createChevron('ag-activity-chevron');
    toggle.append(createIcon('terminal', 'ag-activity-icon'), label, chevron);

    const collapse = el('div', 'ag-activity-collapse');
    const content = el('div', 'ag-activity-content');
    content.tabIndex = -1;
    content.setAttribute('aria-label', '도구 호출 내역');
    collapse.appendChild(content);
    activity.append(toggle, collapse);

    toggle.addEventListener('click', () => {
      const collapsed = activity.classList.toggle('ag-activity-collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      content.tabIndex = collapsed ? -1 : 0;
      if (!collapsed) {
        // 도구 기록을 펼치면 편대 팝업은 접는다 — 살아 있는 기록은 한 번에 하나만 펼친다.
        fleetView.closePopup();
        scrollActivityToLatest(content, true);
        if (followConversation) scrollConversationToEnd();
      }
    });

    if (milestone) {
      withAutoScroll(() => milestone.appendChild(activity));
    } else {
      const toolsOnly = el('div', 'ag-progress-step ag-progress-step-tools-only');
      toolsOnly.appendChild(activity);
      withAutoScroll(() => appendConversation(toolsOnly));
    }

    turnActivity = {
      root: activity,
      label,
      content,
      toolCount: 0,
      calls: [],
      failedToolCount: 0,
      activeTools: new Map(),
      acceptingTools: true,
      settled: false,
    };
    return turnActivity;
  }

  /** 도구 호출 앞의 진행 설명을 타임라인 이정표로 확정한다. */
  function compactStreamIntoActivity(agent: AgentName) {
    flushPendingAssistantRender();
    const bubble = streamBubble;
    if (!bubble) return null;
    if (!(assistantBubbleSources.get(bubble) ?? bubble.textContent ?? '').trim()) {
      bubble.remove();
      streamBubble = null;
      updateTurnPending(agent);
      return null;
    }
    const milestone = el('div', 'ag-progress-step');
    withAutoScroll(() => {
      messages.insertBefore(milestone, bubble);
      bubble.className = `ag-msg ag-progress-milestone ag-${agent}`;
      milestone.appendChild(bubble);
    });
    streamBubble = null;
    updateTurnPending(agent);
    return milestone;
  }

  function completeTurnActivity() {
    closeCurrentActivityGroup();
  }

  function appendCheckDocumentMessage(agent: AgentName): void {
    const text = '작업 완료 · 문서 확인';
    const message = openAssistantBubble(agent);
    renderAssistantMessage(message, text);
    message.classList.add('ag-msg-enter');
    assistantBuffer = text;
    flushAssistantBuffer();
    streamBubble = null;
  }

  // ── 턴 접힘 ─────────────────────────────────────────
  /** 펼쳐 둔 작업 — 이것이 있으면 사용자가 그 턴을 읽는 중이라 접지 않는다. */
  const EXPANDED_TURN_WORK = '.ag-activity:not(.ag-activity-collapsed), .ag-fleet:not(.ag-collapsed), .ag-restored-task-heading[aria-expanded="true"]';

  function mountTurnFoldRow(turnId: string): TurnFoldRow {
    const row = createTurnFoldRow(turnId, {
      // 줄을 눌러 펼치거나 접으면 그 자리를 읽는 중이다 — 끝을 따라가며 화면을 끌어가지 않는다.
      onUserToggle: () => stopFollowingConversation(),
    });
    turnFoldRows.set(turnId, row);
    turnFoldResizeObserver?.observe(row.root);
    return row;
  }

  /**
   * 새 턴의 표식을 대화에 넣고 곧바로 저장한다 — 턴 도중 앱이 죽어도 끝나지 않은 턴이
   * 기록에 남는다. 접힘 줄은 숨은 채 이 턴의 내용 앞에서 턴 끝을 기다린다.
   */
  function beginTurnFold(): void {
    turnErrorSeen = false;
    // 빈 채팅(새로고침 직후의 임시 채팅·초안)에는 표식을 남기지 않는다 — 표식 하나로
    // 목록에 빈 채팅이 생기거나 살아 있는 채팅을 되찾는 경로가 막히지 않게.
    if (draftChat || currentThread.messages.length === 0) return;
    const marker = createTurnMarker(Date.now(), transcriptId('turn'));
    currentThread.messages.push(marker);
    persistCurrentThread();
    const row = mountTurnFoldRow(marker.messageId);
    row.root.hidden = true;
    appendConversation(row.root);
    openFold = { threadId: currentThread.id, markerId: marker.messageId };
  }

  /**
   * 끝을 듣지 못하고 남은 표식(앱이 죽었거나 새로고침으로 끊긴 턴)을 중단으로 정착한다.
   * 새 턴이 시작됐으니 그 전 턴은 더 돌지 않는다. 화면은 다음에 다시 그릴 때 접힌다.
   */
  function settleStaleTurnMarkers(): void {
    const stale = unsettledTurnMarkers(currentThread.messages);
    if (stale.length === 0) return;
    for (const marker of stale) {
      const endedAt = estimateTurnEnd(currentThread.messages, marker);
      settleTurnMarker(marker, {
        endedAt,
        outcome: 'interrupted',
        text: settledTurnText(currentThread.messages, marker, 'interrupted', endedAt),
      });
    }
    persistCurrentThread();
  }

  /**
   * 살아 있는 턴을 그 표식에 다시 잇는다 — 새로고침 뒤 턴 시작을 보지 못한 채 그 턴의
   * 끝이 오거나, 살아 있는 채팅을 다시 붙잡을 때. 이 채팅의 마지막 표식이 정착 전이어야 하고,
   * 지켜본 턴이 다른 채팅의 것이면 잇지 않는다.
   */
  function adoptUnsettledTurnFold(): boolean {
    if (openFold || draftChat || bridgeThreadId !== currentThread.id) return false;
    if (turnOwnerThreadId !== null && turnOwnerThreadId !== currentThread.id) return false;
    const marker = latestTurnMarker(currentThread.messages);
    if (!marker || marker.endedAt !== null) return false;
    openFold = { threadId: currentThread.id, markerId: marker.messageId };
    return true;
  }

  /** 대화 영역 맨 위에 걸친 첫 내용 — 읽던 줄을 지키는 기준점. */
  function readerTopLine(): HTMLElement | null {
    const top = messages.getBoundingClientRect().top;
    for (const child of messages.children) {
      if (!(child instanceof HTMLElement) || child.hidden) continue;
      if (child.getBoundingClientRect().bottom > top) return child;
    }
    return null;
  }

  /**
   * 도는 턴을 결과와 함께 정착하고 그 턴의 작업을 접는다. 오류로 끝난 턴과 작업 없이
   * 끝난 턴은 접지 않는다. 중단된 턴은 작업이 없어도 한 줄을 남긴다.
   * reason 은 바깥이 턴을 끊은 이유(turnOutcomeFor 의 interruptionReason)로, 표식에 남는다.
   */
  function settleOpenTurnFold(outcome: TurnOutcome, reason: string | null = null): void {
    const fold = openFold;
    if (!fold) return;
    openFold = null;
    const endedAt = Date.now();
    const marker = fold.threadId === currentThread.id ? findTurnMarker(currentThread.messages, fold.markerId) : null;
    if (!marker) {
      // 턴 도중 다른 채팅으로 떠났다 — 화면은 이미 없고 저장된 기록만 정착한다.
      settleStoredTurnMarker(fold.threadId, fold.markerId, (thread, stored) => ({
        endedAt,
        outcome,
        reason,
        text: settledTurnText(thread.messages, stored, outcome, endedAt),
      }));
      return;
    }
    if (marker.endedAt !== null) return;
    settleTurnMarker(marker, {
      endedAt,
      outcome,
      reason,
      text: settledTurnText(currentThread.messages, marker, outcome, endedAt),
    });
    persistCurrentThread();
    foldSettledTurn(marker);
  }

  /** 정착한 턴의 작업 노드를 그 턴의 줄 아래로 옮긴다. 줄이 화면에 없으면 다음에 다시 그릴 때 접힌다. */
  function foldSettledTurn(marker: ThreadTurnMessage): void {
    const row = turnFoldRows.get(marker.messageId);
    if (!row || row.root.parentElement !== messages) return;
    // 이 턴의 작업은 줄 뒤에서 대화 끝(다음 턴의 줄) 사이에 있다. "편집 중…" 고리는 지연 동안
    // 숨은 채 그 사이에 남아 있을 수 있어 건너뛰기만 하고, 작업 노드가 아니라 접힘에 들지 않는다.
    const nodes: HTMLElement[] = [];
    for (
      let node = row.root.nextElementSibling;
      node && node !== messagesEnd && !node.classList.contains('ag-turn-fold');
      node = node.nextElementSibling
    ) {
      if (node !== turnPending && node instanceof HTMLElement && isTurnWorkNode(node)) nodes.push(node);
    }
    const view = settledTurnView(currentThread.messages, marker, nodes.length > 0);
    if (!view || view.outcome === 'failed' || (view.outcome === 'completed' && nodes.length === 0)) {
      turnFoldResizeObserver?.unobserve(row.root);
      turnFoldRows.delete(marker.messageId);
      row.root.remove();
      return;
    }
    row.setSummary(view);
    // 사용자가 그 턴을 읽는 중이면(위로 올려 읽거나 무언가 펼쳐 두었거나 초점이 안에 있으면)
    // 펼친 채로 두고 읽던 줄을 지킨다. 다음에 대화를 다시 그릴 때 접힌다.
    const focused = document.activeElement;
    const readerInside = active && (
      !followConversation
      || nodes.some((node) => node.matches(EXPANDED_TURN_WORK) || node.querySelector(EXPANDED_TURN_WORK) !== null)
      || (focused !== null && nodes.some((node) => node.contains(focused)))
    );
    // 아직 백그라운드로 도는 카드가 예약한 숨은 슬롯은 작업 노드 안에 있어도 흐름에 남긴다 —
    // 카드가 나중에 접힘 밖, 줄 바로 아래에 보이게 내려앉는다.
    const adoptWork = () => {
      const pendingSlots = nodes.flatMap((node) => [...node.querySelectorAll<HTMLElement>('.ag-fleet-slot[hidden]')]);
      row.root.hidden = false;
      row.adopt(nodes);
      if (pendingSlots.length > 0) row.root.after(...pendingSlots);
    };
    if (readerInside) {
      const anchor = readerTopLine();
      const before = anchor ? anchor.getBoundingClientRect().top : null;
      adoptWork();
      row.setCollapsed(false, { animate: false });
      if (anchor && before !== null) {
        const delta = anchor.getBoundingClientRect().top - before;
        if (Math.abs(delta) >= 0.5) {
          lockConversationScroll(80);
          messages.scrollTop += delta;
          conversationLastScrollTop = messages.scrollTop;
        }
      }
      return;
    }
    withAutoScroll(() => {
      if (!active) {
        // 가려진 사이드바는 보이지 않는 전환 없이 바로 접는다.
        adoptWork();
        row.setCollapsed(true, { animate: false });
        return;
      }
      // 작업이 차지하던 높이에서 출발해 그 자리만 닫는다. 따라가던 화면은 크기 관찰이 제자리에 둔다.
      const before = messagesEnd.getBoundingClientRect().top;
      adoptWork();
      row.setCollapsed(true, { animate: false });
      row.collapseFrom(before - messagesEnd.getBoundingClientRect().top);
    });
  }

  function addToolRow(
    evt: Extract<AgentStreamEvent, { type: 'tool-call' }>,
    milestone?: HTMLElement | null,
  ): void {
    const activity = ensureTurnActivity(evt.agent, milestone);
    activity.toolCount += 1;
    activity.calls.push({ callId: evt.callId, tool: evt.tool, argsJson: evt.argsJson, failed: false });
    activity.activeTools.set(evt.callId, evt.tool);
    turnToolCount += 1;
    setActivityLabel(activity, activityLabel(activity));

    // 로그 행의 주소: 왼쪽 거터의 op 번호 → 상태 → 동작 → 인자 요약 → 소요 시간.
    const row = createToolRow({
      agent: evt.agent,
      tool: evt.tool,
      argsJson: evt.argsJson,
      opNumber: activity.toolCount,
    });
    const followActivity = isActivityFollowingLatest(activity.content);
    withAutoScroll(() => activity.content.appendChild(row.root));
    if (followActivity) scrollActivityToLatest(activity.content);
    const entry: ToolRowState = {
      row,
      scroller: activity.content,
      startedAt: performance.now(),
      activity,
      name: row.view.name,
      args: parseToolArgs(evt.argsJson),
      argsJson: evt.argsJson,
    };
    toolRows.set(evt.callId, entry);
    // 실행기가 행보다 먼저 끝났으면 붙잡아 둔 결과를 바로 붙인다.
    const now = performance.now();
    pendingExecutions = pendingExecutions.filter((item) => now - item.at < 30_000);
    const early = pendingExecutions.findIndex((item) =>
      item.name === entry.name && sameToolArgs(entry.args, item.args));
    if (early >= 0) {
      const [execution] = pendingExecutions.splice(early, 1);
      attachExecution(evt.callId, entry, execution);
    }
    // 다음 text-delta 는 activity 아래의 최종 답변 후보로 연다.
    streamBubble = null;
  }

  /** 서브에이전트 도구 호출을 기억하고, 먼저 도착해 붙잡아 둔 실행 결과가 그 호출 것이면 버린다. */
  function trackSubagentToolCall(evt: Extract<AgentStreamEvent, { type: 'tool-call' }>): void {
    const call = { callId: evt.callId, name: baseToolName(evt.tool), args: parseToolArgs(evt.argsJson), at: performance.now() };
    const early = pendingExecutions.findIndex((item) => item.name === call.name && sameToolArgs(call.args, item.args));
    if (early >= 0) {
      pendingExecutions.splice(early, 1);
      return;
    }
    subagentToolCalls.push(call);
    if (subagentToolCalls.length > 64) subagentToolCalls.shift();
  }

  /** 실행기 결과를 행과 기록에 붙인다. 그림은 줄여서 기록에 따로 넣는다. */
  function attachExecution(callId: string, entry: ToolRowState, execution: { ok: boolean; outcome: ToolOutcomeView }): void {
    entry.executed = execution;
    const followActivity = isActivityFollowingLatest(entry.scroller);
    entry.row.setOutcome(execution.outcome);
    if (followActivity) scrollActivityToLatest(entry.scroller);
    const record = transcriptTools.get(callId)?.tool;
    if (!record) return;
    record.outcome = storedOutcome(execution.outcome);
    persistCurrentThread();
    const image = execution.outcome.image;
    if (!image) return;
    void shrinkToolImage(image).then((small) => {
      if (!small || !record.outcome) return;
      record.outcome = { ...record.outcome, image: small };
      persistCurrentThread();
    });
  }

  /**
   * 스튜디오 실행기가 끝낸 도구를 아직 결과가 없는 행에 맞춘다. 같은 이름·인자의 가장
   * 오래된 행이 주인이다. 행이 아직 없으면(프로바이더 이벤트가 늦으면) 잠시 붙잡아 둔다.
   */
  function handleToolExecuted(e: Extract<SidebarEvent, { type: 'tool-executed' }>): void {
    const name = baseToolName(e.tool);
    const args = e.args && typeof e.args === 'object' && !Array.isArray(e.args)
      ? e.args as Record<string, unknown>
      : {};
    let argsJson = '{}';
    try { argsJson = JSON.stringify(args); } catch { /* 순환 인자는 없다 */ }
    const outcome = presentToolResult({
      tool: name,
      argsJson,
      ok: e.ok,
      preview: '',
      result: e.result,
      error: e.error ?? null,
    });
    const execution = { ok: e.ok, outcome };
    if (e.parentTaskId) return;
    // 가장 먼저 시작한 같은 이름·인자의 호출이 주인이다 — 서브에이전트 호출이면 버린다.
    const subagentIdx = subagentToolCalls.findIndex((call) => call.name === name && sameToolArgs(call.args, args));
    const subagentAt = subagentIdx >= 0 ? subagentToolCalls[subagentIdx].at : Infinity;
    for (const [callId, entry] of toolRows) {
      if (entry.executed || entry.name !== name || !sameToolArgs(entry.args, args)) continue;
      if (subagentAt < entry.startedAt) break;
      attachExecution(callId, entry, execution);
      return;
    }
    if (subagentIdx >= 0) {
      subagentToolCalls.splice(subagentIdx, 1);
      return;
    }
    pendingExecutions.push({ name, args, ok: e.ok, outcome, at: performance.now() });
    if (pendingExecutions.length > 16) pendingExecutions.shift();
  }

  function resolveToolRow(evt: Extract<AgentStreamEvent, { type: 'tool-result' }>): void {
    const entry = toolRows.get(evt.callId);
    if (!entry) return;
    const followActivity = isActivityFollowingLatest(entry.scroller);
    toolRows.delete(evt.callId);
    entry.row.setState(evt.ok ? 'completed' : 'failed');
    entry.row.elapsed.textContent = formatElapsed(entry.startedAt);
    entry.row.setRawResult(evt.resultPreview);
    // 실행기 결과가 있고 성패가 같으면 그쪽이 더 자세하다 (잘리지 않은 결과·그림).
    if (!entry.executed || entry.executed.ok !== evt.ok) {
      entry.row.setOutcome(presentToolResult({
        tool: entry.name,
        argsJson: entry.argsJson,
        ok: evt.ok,
        preview: evt.resultPreview,
      }));
      const record = transcriptTools.get(evt.callId)?.tool;
      if (record?.outcome && entry.executed) delete record.outcome;
    }
    entry.activity.activeTools.delete(evt.callId);
    if (!evt.ok) {
      entry.activity.failedToolCount += 1;
      turnFailedToolCount += 1;
      const call = entry.activity.calls.find((item) => item.callId === evt.callId);
      if (call) call.failed = true;
    }
    setActivityLabel(entry.activity, activityLabel(entry.activity));
    settleActivity(entry.activity);
    if (followActivity) scrollActivityToLatest(entry.scroller);
  }

  /**
   * turn 종료(인터럽트/프로세스 종료 포함) 시 결과가 도착하지 않은 tool row 를
   * 정리한다 — 스피너가 영원히 돌거나 Map 엔트리가 새는 것을 막는다.
   */
  function sweepUnresolvedToolRows(): void {
    const touchedActivities = new Set<TurnActivityState>();
    for (const [callId, entry] of toolRows) {
      entry.row.setState('stopped');
      if (!entry.row.elapsed.textContent) entry.row.elapsed.textContent = '중단';
      if (!entry.row.result.textContent) entry.row.setRawResult('(결과 없이 종료됨)');
      entry.activity.activeTools.delete(callId);
      entry.activity.failedToolCount += 1;
      turnFailedToolCount += 1;
      const call = entry.activity.calls.find((item) => item.callId === callId);
      if (call) call.failed = true;
      touchedActivities.add(entry.activity);
    }
    toolRows.clear();
    pendingExecutions = [];
    subagentToolCalls = [];
    for (const activity of touchedActivities) {
      setActivityLabel(activity, activityLabel(activity));
      settleActivity(activity);
    }
  }

  /**
   * 브리지가 허브의 채팅을 들고 있지만 이 화면에 붙이지 않았다 — 새로고침 뒤 그 채팅의 문서가
   * 아직 열리지 않아 초안이 대신 떠 있다. 문서가 열리면 handleDocumentSwitch 가 붙인다.
   */
  function hubChatUnbound(): boolean {
    return draftChat && bridgeThreadId === null && bridge.getHubChat() !== null;
  }

  function handleAgentEvent(event: AgentStreamEvent): void {
    // 붙이지 않은 허브 턴의 스트림은 초안 화면에 그리지 않는다 — 그리면 초안이 그 답으로 저장된다.
    if (hubChatUnbound()) return;
    switch (event.type) {
      case 'turn-start':
        turnOwnerThreadId = currentThread.id;
        turnChanges.begin(currentThread.id);
        rebuildReview();
        // 이전 턴이 비정상 종료돼 남긴 실행 상태를 먼저 닫는다.
        sweepUnresolvedToolRows();
        sweepActivityTranscripts();
        sweepTasksTranscript();
        completeTurnActivity();
        // 끝을 듣지 못한 앞 턴은 중단으로 정착한다.
        settleOpenTurnFold('interrupted');
        settleStaleTurnMarkers();
        // 이 턴을 그 스레드의 마지막 요청에 묶는다 — 첫 쓰기 직전에 되돌릴 시점이 찍힌다.
        deps.turnRestore?.noteTurnStart(currentThread.id, latestUserTurnKey());
        // 이 턴의 표식을 남긴다.
        beginTurnFold();
        setTurnRunning(true);
        runStatusThreadId = currentThread.id;
        markChatWorking(runStatusThreadId);
        replyPending = true;
        followConversation = true;
        // 이전 턴이 turn-end 없이 끊겼다면 보류하던 마지막 문단까지 그려 둔다.
        flushPendingAssistantRender();
        settledAnswer = null;
        followConversationEnd = false;
        updateTurnPending(event.agent);
        scrollConversationToEnd();
        assistantBuffer = '';
        cancelPendingAssistantRender();
        streamBubble = null;
        turnActivity = null;
        turnToolCount = 0;
        turnFailedToolCount = 0;
        turnPresentedPlan = false;
        planCardPending = false;
        // 새 턴의 서브에이전트는 새 카드에 모인다.
        suppressedSpawnCalls.clear();
        fleetView.beginTurn();
        followUps.turnStarted();
        break;
      case 'text-delta': {
        // 서브에이전트가 낸 텍스트는 그 행의 근황일 뿐, 루트 답변 버퍼에 섞이지 않는다.
        if (event.parentTaskId) recordTaskText(event.parentTaskId, event.text);
        if (event.parentTaskId && fleetView.routeTextDelta(event)) break;
        assistantBuffer += event.text;
        if (!assistantBuffer.trim()) break;
        if (!streamBubble && turnActivity) closeCurrentActivityGroup();
        if (!streamBubble) {
          const bubble = openAssistantBubble(event.agent);
          withAutoScroll(() => {
            // 가려진 채팅에는 보이지 않는 등장 애니메이션을 걸지 않는다.
            renderAssistantMessage(bubble, assistantBuffer, active ? STREAMING_RENDER : { streaming: true });
            bubble.classList.add('ag-msg-enter');
          });
        } else {
          scheduleAssistantRender(streamBubble, assistantBuffer);
        }
        break;
      }
      case 'tool-call': {
        // 서브에이전트의 도구는 그 행의 드릴인으로 들어간다. 모르는 task 면 루트로 떨어진다.
        if (event.parentTaskId) recordTaskToolCall(event);
        if (event.parentTaskId && fleetView.routeToolCall(event)) {
          trackSubagentToolCall(event);
          break;
        }
        // 스폰 자체는 편대 카드가 나타내므로 도구 행을 따로 그리지 않는다.
        if (!event.parentTaskId && isSpawnToolName(event.tool)) {
          suppressedSpawnCalls.add(event.callId);
          turnToolCount += 1;
          break;
        }
        if (event.tool === 'present_implementation_plan') {
          planCardPending = true;
          systemMessage('계획 카드를 만드는 중');
        }
        // 도구 전 설명은 최종 답변과 구분된 진행 이정표로 보관한다.
        flushAssistantBuffer({ kind: 'progress' });
        const milestone = compactStreamIntoActivity(event.agent);
        recordActivityToolCall(event);
        addToolRow(event, milestone);
        updateTurnPending(event.agent);
        break;
      }
      case 'tool-result':
        if (suppressedSpawnCalls.delete(event.callId)) {
          if (!event.ok) turnFailedToolCount += 1;
          break;
        }
        if (event.parentTaskId) {
          recordTaskToolResult(event);
          subagentToolCalls = subagentToolCalls.filter((call) => call.callId !== event.callId);
        }
        if (event.parentTaskId && fleetView.routeToolResult(event)) break;
        recordActivityToolResult(event);
        resolveToolRow(event);
        break;
      case 'task-start':
        fleetView.taskStart(event);
        recordTaskStart(event);
        updateTurnPending(event.agent);
        break;
      case 'task-progress':
        fleetView.taskProgress(event);
        recordTaskProgress(event);
        break;
      case 'task-end':
        fleetView.taskEnd(event);
        recordTaskEnd(event);
        break;
      case 'session-info':
        if (event.mcpStatus !== undefined && event.mcpStatus !== 'connected') {
          systemMessage(`MCP 서버 연결 실패: ${event.mcpStatus}`);
        }
        break;
      case 'turn-end': {
        flushPendingAssistantRender();
        const finalBubble =
          streamBubble?.parentElement === messages
          && Boolean((assistantBubbleSources.get(streamBubble) ?? streamBubble.textContent ?? '').trim());
        if (finalBubble) settleFinalAnswer();
        setTurnRunning(false);
        if (runStatusThreadId !== null) {
          // 사용자가 멈춘 턴은 신호 없이 꺼진다. 계획이 승인을 기다리며 끝난
          // 턴은 빨간 점, 그 외에는 완료 점이 남는다.
          if (event.stopReason === 'interrupted') clearChatStatus(runStatusThreadId);
          else if (chatWorkflow === 'plan' && planningPhase === 'awaiting-approval' && planApprovable) {
            markChatNeedsInput(runStatusThreadId);
          } else markChatFinished(runStatusThreadId);
          runStatusThreadId = null;
        }
        flushAssistantBuffer();
        sweepUnresolvedToolRows();
        sweepActivityTranscripts();
        // 편대는 턴이 정착한 뒤 도착하지만, 남은 행은 여기서 중단됨으로 확정한다.
        suppressedSpawnCalls.clear();
        fleetView.sweep();
        sweepTasksTranscript();
        // 실패 문구는 브리지가 이 뒤에 보내는 turn-failure 알림 하나로 남는다.
        const completed =
          event.stopReason !== 'interrupted'
          && event.stopReason !== 'failed'
          && event.stopReason !== 'exited'
          && !event.errorMessage
          && turnFailedToolCount === 0;
        if (completed && authFailedAgents.delete(event.agent)) updateComposer();
        if (reconnectRestartPending.delete(event.agent) && event.agent === selectedAgent) {
          restartAgentSession();
        }
        if (planCardPending && !turnPresentedPlan) {
          systemMessage('계획 카드가 도착하지 않았습니다');
        }
        planCardPending = false;
        const editingPhase = chatWorkflow === 'direct' || planningPhase === 'implementing';
        if (turnToolCount > 0 && !turnPresentedPlan && !finalBubble && completed && editingPhase) {
          appendCheckDocumentMessage(event.agent);
        }
        completeTurnActivity();
        streamBubble = null;
        // 턴을 결과와 함께 정착하고 그 작업을 접는다. 새로고침으로 시작을 놓친 턴은 그 표식에 잇는다.
        if (!openFold) adoptUnsettledTurnFold();
        lastTurnEndOutcome = turnOutcomeFor(event, { errorSeen: turnErrorSeen });
        settleOpenTurnFold(lastTurnEndOutcome);
        // 턴의 도구·작업 기록은 턴 끝에서 바로 남긴다.
        flushTranscriptPersist();
        // 대기 메시지: 정상 종료면 맨 앞 하나를 보내고, 미심쩍은 끝이면 붙잡는다. 같은 errorSeen 을 읽은 뒤 비운다.
        followUps.turnEnded(event, turnOwnerThreadId === currentThread.id);
        turnErrorSeen = false;
        break;
      }
      case 'error':
        // 턴 접힘과 대기열이 함께 읽는 한 플래그다. 오류 문구는 브리지가 모아 턴 끝에 turn-failure
        // 알림 하나로 남기고, 턴 밖의 오류는 바로 알림으로 보낸다.
        if (turnRunning || openFold) turnErrorSeen = true;
        break;
    }
  }

  function handleSidebarEvent(e: SidebarEvent): void {
    writingStyleCalibration.handleEvent(e);
    // 설정 탭은 연결·프로바이더·사용량·문체 상태를 그대로 받아 그린다.
    settingsPanel.handleEvent(e);
    initialSetup?.handleEvent(e);
    if (e.type === 'model-catalog') rebuildLlmMenu();
    if (handlePlanningSidebarEvent(e)) return;
    switch (e.type) {
      case 'tool-executed':
        handleToolExecuted(e);
        break;
      case 'user-question-requested': {
        flushPendingAssistantRender();
        flushAssistantBuffer({ kind: 'progress' });
        compactStreamIntoActivity(e.interaction.agent);
        streamBubble = null;
        let target = e.interaction.threadId === currentThread.id ? currentThread : getThread(e.interaction.threadId);
        if (!target) break;
        // A fresh renderer starts on a disposable empty thread. On reconnect,
        // reclaim the persisted owner thread so the live card is immediately
        // visible; deliberate switches between real threads remain untouched.
        if (target !== currentThread && currentThread.messages.length === 0) {
          const wasRestoring = restoringLiveQuestion;
          restoringLiveQuestion = true;
          try { openThread(target.id); } finally { restoringLiveQuestion = wasRestoring; }
          target = currentThread.id === e.interaction.threadId ? currentThread : target;
        }
        const stored = target.pendingUserQuestion
          && pendingUserQuestionMatchesInteraction(target.pendingUserQuestion, e.interaction)
          ? target.pendingUserQuestion
          : undefined;
        target.pendingUserQuestion = stored ?? createPendingUserQuestionDraftSnapshot(e.interaction);
        if (target === currentThread) {
          questionController.setVisible(true);
          requestQuestion(e.interaction, stored);
          mountQuestionTimelineAnchor();
          persistCurrentThread();
        } else {
          upsertThread(target);
          questionController.setVisible(false);
        }
        runStatusThreadId = target.id;
        markChatNeedsInput(target.id);
        updateComposer();
        break;
      }
      case 'user-question-answer-result':
        questionController.answerResult(e);
        break;
      case 'user-question-resolved':
        {
        const activeQuestion = questionController.interaction();
        const targetThreadId = activeQuestion?.interactionId === e.interactionId
          ? activeQuestion.threadId
          : null;
        // 미뤄 둔 채 끝난 질문은 다시 열지 않는다.
        arrivalGuard.cancel(questionArrivalKey(e.interactionId));
        if (heldQuestionKey === questionArrivalKey(e.interactionId)) heldQuestionKey = null;
        questionController.resolve(e.interactionId, e.outcome);
        if (targetThreadId) {
          if (e.outcome.status === 'answered' && turnRunning) markChatWorking(targetThreadId);
          else if (e.outcome.status !== 'answered') clearChatStatus(targetThreadId);
        }
        updateComposer();
        break;
        }
      case 'connection':
        setConnection(e.state, { attempt: e.attempt, retryInMs: e.retryInMs });
        // 재연결 시 진행 상태를 브리지와 다시 동기화한다. 붙이지 않은 허브 턴은 초안의 일이 아니다.
        setTurnRunning(bridge.isTurnRunning() && !hubChatUnbound());
        dropRunStatusIfIdle();
        followUps.settle();
        failureNotices.connectionChanged(e.state === 'connected');
        break;
      case 'usage-report':
        // 한도 막대의 리셋 시각 — 실패에 리셋 시각이 없을 때 쓴다.
        failureNotices.setLimits(e.usage.limits);
        break;
      case 'turn-failure': {
        // 붙이지 않은 허브 턴의 실패는 초안 화면에 그리지 않는다 — 그리면 초안이 그 알림으로 저장된다.
        if (hubChatUnbound()) break;
        noteProviderAuthFailure(e.failure.agent, e.failure);
        const notice = failureNotices.add(e.failure, {
          origin: e.origin,
          turnId: e.turnId,
          userInitiated: e.userInitiated === true,
          wroteDocument: e.wroteDocument === true,
        });
        // 이 채팅의 턴이 실패로 끝났다 — 대기열을 그 이유와 함께 붙잡는다(턴 끝의 붙잡음에 설명을 더한다).
        // 사용자가 멈춘 턴은 대기열의 '멈춤' 그대로 둔다(알림만 왜 아무것도 못 했는지 말한다).
        if (e.origin === 'turn' && lastTurnEndOutcome === 'failed'
          && (turnOwnerThreadId === null || turnOwnerThreadId === currentThread.id)) {
          const hold = failureNotices.queueHold(notice);
          followUps.hold(hold.reason, hold.detail);
        }
        break;
      }
      case 'chat-started': {
        if (e.threadId && e.threadId !== currentThread.id) break;
        applyChatSessionState(e);
        // 재연결 welcome 이 이 채팅의 살아 있는 턴을 이었다(대기 중이던 시작 요청을 버리고) —
        // 진행 표시를 브리지에 맞춘다. 사이드바가 이미 돌고 있다고 알면 그대로 둔다.
        const live = bridge.getHubChat();
        if (live?.threadId === currentThread.id && live.running && !turnRunning) {
          bridgeThreadId = currentThread.id;
          setTurnRunning(true);
          runStatusThreadId = currentThread.id;
          markChatWorking(currentThread.id);
          onLiveChatAdopted(live);
        }
        const liveQuestion = bridge.getPendingUserQuestion();
        if (liveQuestion?.threadId === currentThread.id) presentLiveQuestion(liveQuestion);
        expireStalePendingQuestion();
        break;
      }
      case 'permission-changed':
        // 모드 칩이 곧 상태 표시다 — 따로 시스템 메시지를 남기지 않는다.
        workflowTransitionPending = false;
        permissionProfile = e.permissionProfile;
        updateModeChip();
        updateComposer();
        break;
      case 'service-tier-changed':
        selectedServiceTier = resolveServiceTier(selectedAgent, e.serviceTier);
        currentThread.serviceTier = selectedServiceTier;
        persistCurrentThread();
        break;
      case 'reference-status': {
        const message = currentThread.messages.find((item) => item.messageId === e.messageId);
        if (!message?.attachments) break;
        for (const update of e.attachments) {
          const attachment = message.attachments.find((item) => item.stageId === update.stageId);
          if (!attachment) continue;
          attachment.status = update.status;
          if (update.file) {
            attachment.fileId = update.file.id;
            attachment.name = update.file.name;
            attachment.mimeType = update.file.mimeType;
            attachment.size = update.file.size;
          }
          if (update.error) attachment.error = update.error;
          else delete attachment.error;
        }
        attachmentsSending = message.attachments.some((item) => item.status === 'processing');
        persistCurrentThread();
        renderMessagesFromThread(currentThread);
        updateComposer();
        if (!attachmentsSending) void referenceLibrary.refresh();
        break;
      }
      case 'skills-catalog':
        skillCatalog = e.catalog;
        skillsShelf.setCatalog(e.catalog.rows);
        if (activeComposerSkill) {
          const refreshed = invocableSkill(activeComposerSkill.name);
          if (!refreshed) setComposerSkill(null);
          else setComposerSkill(refreshed);
        }
        rebuildSlashMenu();
        break;
      case 'harness-list-result':
        skillsShelf.setHarness(e.rows);
        break;
      case 'skill-commit-result':
        skillsShelf.applyOutcome(e.outcome);
        break;
      case 'skills-error':
        skillsShelf.setStatus(e.message);
        break;
      case 'templates-catalog': {
        templateCatalog = e.catalog;
        const selected = currentThread.activeTemplateId
          ? templateCatalog.templates.find((template) => template.id === currentThread.activeTemplateId) ?? null
          : null;
        if (currentThread.activeTemplateId && !selected) {
          currentThread.activeTemplateId = null;
          activeTemplate = null;
          if (!draftChat) bridge.setActiveTemplate(null);
          if (e.change?.type === 'deleted') {
            systemMessage(`“${e.change.template.name}” 템플릿을 사용할 수 없어 이 채팅에서 해제했습니다.`);
          }
        } else {
          activeTemplate = selected;
        }
        renderActiveTemplate();
        rebuildSlashMenu();
        persistCurrentThread();
        break;
      }
      case 'chat-template-changed':
        activeTemplate = e.template;
        currentThread.activeTemplateId = e.template?.id ?? null;
        renderActiveTemplate();
        persistCurrentThread();
        if (e.reason === 'deleted') systemMessage('템플릿이 삭제되어 해제했습니다.');
        break;
      case 'pi-status':
        syncProviderMenu();
        if (selectedAgent === 'pi') {
          selectedModel = resolveModelForAgent('pi', selectedModel);
          selectedEffort = resolveEffortForAgent('pi', selectedEffort, selectedModel);
        }
        rebuildLlmMenu();
        rebuildEffortMenu();
        refreshSidebarWidthMin();
        break;
      case 'agent-setup-status':
        receiveSetupStatuses(e.statuses);
        connectedProviders.clear();
        for (const agent of PROVIDER_ORDER) {
          if (e.statuses[agent]?.connected) connectedProviders.add(agent);
        }
        syncProviderMenu();
        // 브리지가 동적 모델 레지스트리를 먼저 갱신했다. 현재 선택도 새 목록으로 접는다.
        if (selectedAgent === 'cursor' || selectedAgent === 'opencode') {
          selectedModel = resolveModelForAgent(selectedAgent, selectedModel);
          selectedEffort = resolveEffortForAgent(selectedAgent, selectedEffort, selectedModel);
          rebuildLlmMenu();
          rebuildEffortMenu();
          refreshSidebarWidthMin();
        }
        updateComposer();
        break;
      case 'writing-style-status':
      case 'writing-style-result':
        writingStyleActive = e.status.active === true;
        if (writingStyleActive) calibrationChip.hidden = true;
        break;
      case 'writing-style-progress':
      case 'writing-style-error':
      case 'writing-style-catalog':
        break;
      // 프로바이더 상태·pi 설정 진행은 설정 탭이 이미 받아 그렸다.
      case 'provider-status':
      case 'pi-setup-progress':
      case 'pi-catalog':
      case 'pi-error':
        break;
      case 'chat-stopped':
        setTurnRunning(false);
        dropRunStatusIfIdle();
        flushPendingAssistantRender();
        settleFinalAnswer();
        flushAssistantBuffer();
        sweepUnresolvedToolRows();
        sweepActivityTranscripts();
        suppressedSpawnCalls.clear();
        fleetView.sweep();
        sweepTasksTranscript();
        completeTurnActivity();
        streamBubble = null;
        // 멈춘 턴을 먼저 정착해 접고, 그다음 대기열이 다음 턴을 정한다.
        settleOpenTurnFold('interrupted');
        followUps.chatStopped();
        break;
      case 'title-result': {
        if (e.threadId !== currentThread.id && !getThread(e.threadId)) break;
        const title = e.title?.trim() || null;
        if (title) {
          setThreadTitle(e.threadId, title);
          if (e.threadId === currentThread.id) {
            currentThread.title = title;
            updateWorkspaceChatTitle();
          }
        } else if (e.threadId === currentThread.id) {
          currentThread.title = fallbackTitle(currentThread.messages);
          persistCurrentThread();
        } else {
          const t = getThread(e.threadId);
          if (t) setThreadTitle(e.threadId, fallbackTitle(t.messages));
        }
        if (threadsListVisible()) rebuildThreadsList();
        break;
      }
      case 'agent':
        handleAgentEvent(e.event);
        break;
      case 'hub-error': {
        chatStartPendingThreadId = null;
        // 보낸 대기 메시지를 허브가 받지 않았으면 대기열 맨 앞으로 되돌린다. 이유는 붙잡음 줄이 말한다.
        const followUpBounced = followUps.hubError(e);
        if (e.code === 'REFERENCE_COMMIT_FAILED' || e.code === 'INVALID_REFERENCE_MESSAGE') {
          attachmentsSending = false;
          for (const message of currentThread.messages) {
            for (const attachment of message.attachments ?? []) {
              if (attachment.status === 'processing') {
                attachment.status = 'error';
                attachment.error = e.message;
              }
            }
          }
          persistCurrentThread();
          renderMessagesFromThread(currentThread);
          updateComposer();
        }
        if (e.failure) {
          noteProviderAuthFailure(e.failure.agent, e.failure);
          // 되돌린 대기 메시지는 대기열 맨 앞에 있다 — 다시 시도까지 두면 보내는 길이 둘이 된다.
          const notice = failureNotices.add(e.failure, {
            origin: e.origin ?? 'send',
            turnId: null,
            userInitiated: e.origin !== 'start',
            ...(followUpBounced ? { noRetry: true } : {}),
          });
          // 되돌린 대기 메시지의 붙잡음(거절)은 대기열이 이미 말한다.
          if (!followUpBounced) {
            const hold = failureNotices.queueHold(notice);
            followUps.hold(hold.reason, hold.detail);
          }
        } else if (!followUpBounced) {
          systemMessage(`오류 (${e.code}): ${e.message}`);
        }
        workflowTransitionPending = false;
        planActionPending = false;
        syncPlanningFromBridge();
        setTurnRunning(bridge.isTurnRunning());
        // 허브 오류로 턴이 끝났으면 실패로 정착한다 — 접지 않고 모든 단계를 남긴다.
        if (!bridge.isTurnRunning()) settleOpenTurnFold('failed');
        dropRunStatusIfIdle();
        followUps.settle();
        break;
      }
    }
  }

  /**
   * 대기 편집 한 건 = 주소가 붙은 오퍼레이션. 머리줄이 좌표를 말하고
   * 아랫줄이 실제 -/+ diff 를 보여준다 — 요약 문장 대신 검토 가능한 형태.
   */
  function buildReviewOp(op: PendingOp, canNavigate = true): HTMLElement {
    const entry = renderPendingOpDiff(op, reviewImageUrls);
    const range = 'range' in op ? op.range : null;
    const obj = op.kind === 'object' ? op.obj : null;
    const cell = range?.cell ?? (obj && 'cell' in obj ? obj.cell : undefined);
    const paragraph = range?.startParaIdx ?? (obj && 'paraIdx' in obj ? obj.paraIdx : undefined);
    const section = range?.sectionIdx ?? (obj && 'sectionIdx' in obj ? obj.sectionIdx : undefined);
    const position: DocumentPosition | null = paragraph !== undefined && section !== undefined ? {
      sectionIndex: section,
      paragraphIndex: paragraph,
      charOffset: range?.startCharOffset ?? 0,
      ...(cell ? { parentParaIndex: cell.paraIdx, controlIndex: cell.controlIdx,
        cellIndex: cell.cellIdx, cellParaIndex: paragraph,
        cellPath: cell.path?.map((part, index) => index === cell.path!.length - 1
          ? { ...part, cellParaIndex: paragraph } : part) } : {}),
    } : null;
    if (position && canNavigate && deps.navigateToChange) {
      const jump = createJumpButton(`${entry.dataset.location ?? '문단'}으로 이동`, 'ag-changes-jump');
      jump.addEventListener('click', () => navigateToChange(position));
      entry.append(jump);
    }
    return entry;
  }

  // ── 계획 모드 ────────────────────────────────────────

  /** 실행 중이거나 첨부를 커밋하거나 전환 중에는 모드·모델·권한을 바꿀 수 없다. */
  function isSelectionLocked(): boolean {
    return readOnlyDocLabel !== null || isControlLocked();
  }

  function isControlLocked(): boolean {
    if (mergeResolverLocked) return true;
    return turnRunning || attachmentsSending || chatStartPendingThreadId !== null
      || workflowTransitionPending || planActionPending || planningPhase === 'switching';
  }

  function hasPendingDocumentEdits(): boolean {
    return bridge.pendingEdits.getChangeSets().length > 0;
  }

  function updateWorkflowControl(): void {
    // 모드 칩이 채팅·플랜을 이미 말하므로, 배지는 계획의 진행 단계(승인 대기·전환·실행)만 보인다.
    const planStage = chatWorkflow === 'plan'
      && (planningPhase === 'awaiting-approval' || planningPhase === 'switching' || planningPhase === 'implementing');
    phaseBadge.hidden = !planStage;
    phaseBadge.textContent = PLANNING_PHASE_LABEL[planningPhase];
    phaseBadge.dataset.phase = planningPhase;
    root.dataset.workflow = chatWorkflow;
    root.dataset.planningPhase = planningPhase;
    updateModeChip();
    root.dataset.agentMode = currentMode();
    refreshSidebarWidthMin();
  }

  function setPlanningPhase(phase: AgentPhase): void {
    if (planningPhase === phase) return;
    planningPhase = phase;
    updateWorkflowControl();
    updateComposer();
    rebuildReview();
  }

  function applyWorkflow(workflow: AgentWorkflow): void {
    chatWorkflow = workflow;
    if (workflow !== 'plan') revisionPlanId = null;
    currentThread.workflow = workflow;
    threadWorkflows.set(currentThread.id, workflow);
    if (workflow === 'direct') {
      planningPhase = 'direct';
      planApprovable = false;
    } else if (workflow === 'question') {
      planningPhase = 'questioning';
      planApprovable = false;
    } else if (planningPhase === 'direct' || planningPhase === 'questioning') {
      planningPhase = 'planning';
    }
    updateWorkflowControl();
    updateComposer();
    rebuildReview();
  }

  /**
   * 작업 방식 전환 요청. 검토 대기 중인 문서 편집이 있으면 계획 모드를 막는다.
   * profile 이 있고 지금과 다르면 같은 전환 큐 뒤에 프로필 전환을 잇는다.
   */
  function requestWorkflow(next: AgentWorkflow, profile?: PermissionProfile): boolean {
    const restartCompletedPlan = next === 'plan'
      && chatWorkflow === 'plan'
      && planningPhase === 'implementing';
    if (next === chatWorkflow && !restartCompletedPlan) {
      if (profile && profile !== permissionProfile && !isControlLocked() && connState === 'connected') {
        sendPermissionProfile(profile);
      }
      input.focus();
      return true;
    }
    if (isControlLocked() || connState !== 'connected') {
      systemMessage(
        turnRunning
          ? '실행 중에는 작업 방식을 바꿀 수 없습니다.'
          : '전환 중에는 작업 방식을 바꿀 수 없습니다.',
      );
      updateWorkflowControl();
      return false;
    }
    if (next === 'plan' && hasPendingDocumentEdits()) {
      systemMessage(
        '검토 대기 중인 편집을 먼저 처리합니다.',
      );
      updateWorkflowControl();
      return false;
    }
    workflowTransitionPending = true;
    bridge.setWorkflow(next);
    if (profile && profile !== permissionProfile) sendPermissionProfile(profile);
    input.focus();
    return true;
  }

  type PlanTodoStatus = 'pending' | 'in-progress' | 'completed' | 'blocked';

  /** 계획 카드와 접힌 타임라인이 같이 쓰는 todo 목록. 실행 전에는 계획 단계 그대로다. */
  function planTodos(plan: StructuredPlan): Array<{ id: string; title: string; status: PlanTodoStatus; note: string }> {
    if (plan.execution) {
      return plan.execution.steps.map((todo) => ({
        id: todo.stepId, title: planTodoTitle(plan, todo), status: todo.status, note: todo.note?.trim() ?? '',
      }));
    }
    // 별도 검증 항목은 todo 끝에 붙인다 — 실행 때 허브도 같은 순서로 목록을 연다.
    return [
      ...plan.steps.map((step, index) => ({
        id: step.id ?? `step-${index + 1}`, title: step.title || '단계', status: 'pending' as const, note: '',
      })),
      ...plan.validation.map((entry, index) => ({ id: `verify-${index + 1}`, title: entry, status: 'pending' as const, note: '' })),
    ];
  }

  /**
   * 터미널 todo 표시. glyph: □ 대기·진행, ■ 완료, ⊠ 확인 필요.
   * live(접힌 줄)에서는 진행 중인 할 일만 회전 표시로 살아 움직인다.
   */
  function todoMark(status: PlanTodoStatus, style: 'glyph' | 'live' = 'live'): HTMLElement {
    const mark = el('span', 'ag-todo-mark');
    mark.dataset.status = status;
    mark.setAttribute('aria-label', ({ pending: '대기', 'in-progress': '진행 중', completed: '완료', blocked: '확인 필요' })[status]);
    if (style === 'live' && status === 'in-progress') mark.appendChild(el('span', 'ui-spinner'));
    else mark.textContent = status === 'completed' ? '■' : status === 'blocked' ? '⊠' : '□';
    return mark;
  }

  function recordPlan(plan: StructuredPlan): void {
    planHistory = [...planHistory.filter((p) => p.planId !== plan.planId), plan];
    currentThread.latestPlan = plan;
    currentThread.plans = [...planHistory];
    planArchives.set(currentThread.id, planHistory);
    if (currentThread.messages.length > 0) persistCurrentThread();
  }

  function presentPlanInChat(plan: StructuredPlan): void {
    if (currentThread.messages.some((message) => message.kind === 'plan' && message.planId === plan.planId)) return;
    const message: Extract<ThreadMessage, { kind: 'plan' }> = {
      role: 'assistant',
      kind: 'plan',
      planId: plan.planId,
      text: plan.title || '제목 없는 계획',
      agent: selectedAgent,
    };
    currentThread.messages.push(message);
    currentThread.updatedAt = Date.now();
    persistCurrentThread();
    withAutoScroll(() => appendConversation(renderPlanMessage(message)));
  }

  function markPlanExecuted(planId: string): void {
    let presentation: Extract<ThreadMessage, { kind: 'plan' }> | null = null;
    for (const message of currentThread.messages) {
      if (message.kind !== 'plan' || message.planId !== planId) continue;
      message.planState = 'executed';
      presentation = message;
    }
    if (!presentation) return;

    const button = messages.querySelector<HTMLElement>(
      `.ag-msg-plan-action[data-plan-id="${CSS.escape(planId)}"]`,
    );
    button?.classList.add('ag-executed');
    button?.setAttribute('aria-label', `${presentation.text || '계획'} 완료된 계획 열기`);
    const kicker = button?.querySelector<HTMLElement>('.ag-msg-plan-kicker');
    if (kicker) kicker.textContent = '실행 됨';
  }

  function showPlanExecution(planId: string): void {
    if (activePlan?.planId !== planId) return;
    activePlanHistorical = false;
    if (activePlan.execution?.status === 'completed') markPlanExecuted(planId);
    rebuildReview();
  }

  function openPresentedPlan(planId: string): void {
    const plan = planHistory.find((candidate) => candidate.planId === planId)
      ?? (currentThread.latestPlan?.planId === planId ? currentThread.latestPlan : null);
    if (!plan) return;

    const workflowState = bridge.getWorkflowState();
    activePlan = plan;
    planApprovable = workflowState.latestPlan?.planId === planId
      && workflowState.phase === 'awaiting-approval';
    activePlanHistorical = workflowState.latestPlan?.planId !== planId
      || workflowState.latestPlan?.execution?.status === 'completed';
    rebuildReview();
    if (fullscreen) {
      setPlanColCollapsed(false);
      setEnvironmentPanelOpen(false, { persist: !isCompactWorkspace() });
    } else {
      setPlanMinimized(false);
    }
    window.requestAnimationFrame(() => {
      const card = planCardSlot.querySelector<HTMLElement>(`.ag-plan-card[data-plan-id="${CSS.escape(planId)}"]`);
      card?.scrollIntoView({ block: 'nearest' });
      card?.focus({ preventScroll: true });
    });
  }
  /**
   * 계획 문서 뷰어. 말풍선이 아니라 고정 리뷰 영역에 놓이는 문서다 —
   * 대화가 흘러가도 같은 자리에 남아 편집 모드 전환과 수정 요청을 받는다.
   * 표시는 Markdown 이지만 승인 대상은 언제나 구조화된 계획(planId)이다.
   */
  function buildPlanCard(plan: StructuredPlan): HTMLElement {
    const card = el('section', `ag-plan-card ag-plan-doc ag-${selectedAgent}`);
    card.setAttribute('role', 'article');
    const titleId = `ag-plan-title-${plan.planId}`;
    card.setAttribute('aria-labelledby', titleId);
    card.tabIndex = -1;
    card.dataset.planId = plan.planId;

    const head = el('header', 'ag-plan-head');
    // 머리는 한 줄이다: 제목 · 상태 · 접기. 목표·요약 문장은 제목 툴팁으로만 남긴다.
    const kickerRow = el('div', 'ag-plan-kicker-row');
    const title = el('h3', 'ag-plan-title', plan.title || '제목 없는 계획');
    title.id = titleId;
    const goalText = (plan.goal || plan.summary || '').trim();
    if (goalText) title.title = goalText;
    kickerRow.append(title);
    const phaseText = activePlanHistorical ? '계획 기록' : plan.execution
      ? ({ running: '실행 중', 'awaiting-review': '검토 대기', completed: '완료', blocked: '확인 필요', interrupted: '중단됨' })[plan.execution.status]
      : PLANNING_PHASE_LABEL[planningPhase];
    const phase = el('span', 'ag-plan-phase', plan.revision && plan.revision > 1 ? `v${plan.revision} · ${phaseText}` : phaseText);
    if (plan.changeSummary) phase.title = plan.changeSummary;
    kickerRow.append(phase);
    const planIdReadout = el('span', 'ag-plan-id', plan.planId);
    planIdReadout.title = plan.planId;
    kickerRow.append(planIdReadout);
    const minimize = el('button', 'ag-plan-minimize');
    minimize.type = 'button';
    minimize.setAttribute('aria-label', '계획 접기');
    minimize.title = '계획 접기';
    minimize.append(el('span', 'ag-plan-minimize-label', '접기'), createChevron('ag-plan-minimize-caret'));
    minimize.addEventListener('click', () => setPlanMinimized(true));
    kickerRow.append(minimize);
    head.appendChild(kickerRow);
    card.appendChild(head);

    const body = el('div', 'ag-plan-body');
    body.id = `ag-plan-body-${plan.planId}`;
    const todos = planTodos(plan);
    if (todos.length > 0) {
      // 코딩 에이전트의 todo 목록처럼 한 줄 항목만 늘어놓는다. 실행 중에는 에이전트가
      // update_todos 로 고친 목록 그대로다.
      const section = el('section', 'ag-plan-steps');
      const completed = todos.filter((todo) => todo.status === 'completed').length;
      const heading = el('div', 'ag-todo-heading');
      heading.appendChild(el('h4', '', '할 일'));
      const count = el('span', 'ag-todo-count', plan.execution ? `${completed}/${todos.length}` : `${todos.length}개`);
      count.setAttribute('role', 'status');
      count.setAttribute('aria-live', 'polite');
      heading.appendChild(count);
      section.appendChild(heading);
      const list = el('ol', 'ag-todo-list');
      for (const todo of todos) {
        const item = el('li', 'ag-todo');
        item.dataset.stepId = todo.id;
        item.dataset.status = todo.status;
        // ❯ □ 할 일 (진행 중) — 터미널 todo 목록 그대로.
        const caret = el('span', 'ag-todo-caret', todo.status === 'in-progress' ? '❯' : '');
        caret.setAttribute('aria-hidden', 'true');
        const text = el('span', 'ag-todo-text', todo.title);
        const suffix = ({ 'in-progress': '진행 중', blocked: '확인 필요' } as Partial<Record<PlanTodoStatus, string>>)[todo.status];
        if (suffix) text.appendChild(el('span', 'ag-todo-suffix', ` (${suffix})`));
        item.append(caret, todoMark(todo.status, 'glyph'), text);
        if (todo.note) item.appendChild(el('span', 'ag-todo-note', todo.note));
        list.appendChild(item);
      }
      section.appendChild(list);
      body.appendChild(section);
    }
    // 참고 자료는 맨 아래 한 줄 알약으로만 보인다. 설명은 툴팁이다.
    if (plan.sources?.length) {
      const sources = el('div', 'ag-plan-sources');
      sources.appendChild(el('span', 'ag-plan-sources-label', '참고'));
      for (const source of plan.sources) {
        const href = source.url ? safeMarkdownHref(source.url) : null;
        const pill = el(href ? 'a' : 'span', 'ag-plan-source-pill', source.title || href || '자료');
        if (href && pill instanceof HTMLAnchorElement) {
          pill.href = href;
          pill.target = '_blank';
          pill.rel = 'noopener noreferrer';
        }
        const tip = [source.note?.trim(), [source.fileId, source.chunkId].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
        if (tip) pill.title = tip;
        sources.appendChild(pill);
      }
      body.appendChild(sources);
    }
    card.appendChild(body);

    if (!activePlanHistorical) {
      const approvableNow = planApprovable
        && planningPhase === 'awaiting-approval'
        && !planActionPending
        && !turnRunning;
      const footer = el('footer', 'ag-plan-footer');
      const actions = el('div', 'ag-review-actions ag-plan-actions');
      // 승인은 실행 모드를 고른다: 에이전트(검토 후 반영) 또는 전체(바로 반영).
      const approve = el('button', 'ag-approve ag-plan-approve', '에이전트로 실행');
      approve.type = 'button';
      approve.disabled = !approvableNow;
      approve.addEventListener('click', () => { void approveActivePlan(plan.planId, 'safe'); });
      const approveFull = el('button', 'ag-approve ag-plan-approve-full', '전체 접근으로 실행');
      approveFull.type = 'button';
      approveFull.disabled = !approvableNow;
      approveFull.addEventListener('click', () => { void approveActivePlan(plan.planId, 'unrestricted', approveFull); });
      const revise = el('button', 'ag-reject ag-plan-revise', revisionPlanId === plan.planId ? '수정 내용 입력 중' : '수정 요청');
      revise.type = 'button';
      revise.disabled = !planApprovable || planActionPending || planningPhase === 'switching' || turnRunning;
      revise.addEventListener('click', () => preparePlanRevision(plan.planId));
      actions.append(revise, approveFull, approve);
      if (planningPhase === 'awaiting-approval') footer.appendChild(actions);

      let noteText = '';
      if (planningPhase === 'switching') {
        noteText = '승인했습니다. 실행 단계로 전환 중입니다…';
      } else if (planningPhase === 'implementing') {
        noteText = plan.execution?.status === 'completed' ? '작업을 마쳤습니다.'
          : plan.execution?.status === 'awaiting-review' ? '변경 사항을 검토해 주세요.'
            : plan.execution?.status === 'blocked' ? '진행을 위해 확인이 필요합니다.'
              : plan.execution?.status === 'interrupted' ? '작업이 중단됐습니다.'
                : '';
      }
      if (noteText) footer.appendChild(el('p', 'ag-plan-note', noteText));
      if (footer.childElementCount > 0) card.appendChild(footer);
    }
    return card;
  }

  function buildPlanDraftCard(): HTMLElement {
    const card = el('section', 'ag-plan-draft-card');
    const button = el('button', 'ag-plan-draft-action', '계획 초안 작성');
    button.type = 'button';
    button.disabled = turnRunning || planActionPending || planningPhase !== 'planning';
    button.addEventListener('click', () => {
      if (button.disabled) return;
      const text = input.value.trim();
      input.value = text ? `${text}\n\n현재 대화를 바탕으로 계획 초안을 작성해 주세요.`
        : '현재 대화를 바탕으로 계획 초안을 작성해 주세요.';
      composer.requestSubmit();
    });
    card.appendChild(button);
    return card;
  }

  /**
   * 계획 승인. profile 은 실행 모드다 — safe 는 에이전트(편집 검토 대기), unrestricted 는
   * 전체(편집 바로 반영). 전체로 실행할 때는 모드 칩과 같은 확인 시트를 거친다.
   */
  async function approveActivePlan(planId: string, profile: PermissionProfile, anchor?: HTMLElement): Promise<void> {
    const canApprove = (): boolean => planApprovable && !planActionPending && chatModeLockReason === null
      && planningPhase === 'awaiting-approval' && !turnRunning && activePlan?.planId === planId;
    if (!canApprove()) return;
    if (profile === 'unrestricted' && permissionProfile !== 'unrestricted') {
      const confirmed = await confirmSheet(anchor ?? root, '전체 접근', '승인 없이 편집하고 파일에 접근합니다.', { confirmLabel: '실행' });
      if (!confirmed || !canApprove()) return;
    }
    // 정확히 이 계획 id 로만 승인한다 — 오래된 카드가 다른 계획을 통과시키지 않는다.
    planActionPending = true;
    rebuildReview();
    try {
      if (!bridge.approvePlan(planId, profile)) {
        throw new Error('허브 연결이 끊겨 승인 요청을 보내지 못했습니다.');
      }
      failureNotices.clearLastSend();
    } catch (err) {
      planActionPending = false;
      rebuildReview();
      systemMessage(`계획 승인 실패: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function preparePlanRevision(planId: string): void {
    if (!planApprovable || planActionPending || planningPhase !== 'awaiting-approval') return;
    revisionPlanId = revisionPlanId === planId ? null : planId;
    rebuildReview();
    updateComposer();
    input.focus();
  }

  /** 계획 관련 사이드바 이벤트. 처리했으면 true. */
  function handlePlanningSidebarEvent(e: SidebarEvent): boolean {
    switch (e.type) {
      case 'workflow-changed':
        workflowTransitionPending = false;
        planActionPending = false;
        if (e.phase !== 'awaiting-approval') revisionPlanId = null;
        applyWorkflow(e.workflow);
        setPlanningPhase(e.phase);
        if (e.phase === 'awaiting-approval' && e.latestPlan) {
          activePlan = e.latestPlan;
          activePlanHistorical = false;
          planApprovable = true;
          recordPlan(e.latestPlan);
          rebuildReview();
        }
        return true;
      case 'plan-ready':
        planActionPending = false;
        revisionPlanId = null;
        turnPresentedPlan = true;
        planCardPending = false;
        activePlan = e.plan;
        activePlanHistorical = false;
        planMinimized = false;
        collapseExpandedSurfaces('plan');
        planApprovable = true;
        recordPlan(e.plan);
        presentPlanInChat(e.plan);
        applyWorkflow(e.workflow);
        setPlanningPhase(e.phase);
        rebuildReview();
        // 전체 화면에서는 정리된 계획이 곧바로 옆 문서 패널로 열린다. 쓰는 중이면 쓰기를
        // 멈출 때 연다 — 배치가 손 밑에서 움직이지 않게.
        if (fullscreen && planColCollapsed) {
          const planId = e.plan.planId;
          arrivalGuard.hold(`plan:${planId}`, () => {
            if (fullscreen && planColCollapsed && activePlan?.planId === planId) setPlanColCollapsed(false);
          });
        }
        return true;
      case 'plan-approved':
        // 서버가 승인했다고 말한 계획이 지금 카드와 다르면 표시를 건드리지 않는다.
        if (activePlan && e.planId && e.planId !== activePlan.planId) return true;
        planActionPending = false;
        revisionPlanId = null;
        planApprovable = false;
        settlePlanAttention();
        setPlanningPhase(e.phase);
        systemMessage('계획을 승인했습니다. 실행 단계로 전환 중입니다.');
        return true;
      case 'implementation-started':
        planActionPending = false;
        revisionPlanId = null;
        planApprovable = false;
        planMinimized = false;
        settlePlanAttention();
        if (e.latestPlan) {
          activePlan = e.latestPlan;
          recordPlan(e.latestPlan);
        }
        setPlanningPhase(e.phase);
        showPlanExecution(e.planId || activePlan?.planId || '');
        return true;
      case 'plan-progress':
        if (e.latestPlan?.planId !== e.planId) return true;
        planApprovable = false;
        revisionPlanId = null;
        activePlan = e.latestPlan;
        recordPlan(e.latestPlan);
        setPlanningPhase(e.phase);
        showPlanExecution(e.planId);
        renderPlanTimeline();
        return true;
      case 'planning-document-saved':
        systemMessage('문서를 저장했습니다');
        return true;
      case 'plan-invalidated':
        planActionPending = false;
        revisionPlanId = null;
        planApprovable = false;
        settlePlanAttention();
        activePlanHistorical = activePlan !== null;
        setPlanningPhase(e.phase);
        if (e.reason !== 'document-saved' && e.reason !== 'workflow-changed') {
          systemMessage('계획을 수정하고 있습니다.');
        }
        rebuildReview();
        return true;
      default:
        return false;
    }
  }

  /** 채팅 시작/재연결 시 브리지의 계획 상태와 다시 맞춘다. */
  function syncPlanningFromBridge(): void {
    const hadPendingAction = planActionPending;
    planActionPending = false;
    const state = bridge.getWorkflowState();
    const samePlanId = (activePlan?.planId ?? null) === (state.latestPlan?.planId ?? null)
      && activePlan?.revision === state.latestPlan?.revision
      && JSON.stringify(activePlan?.execution) === JSON.stringify(state.latestPlan?.execution);
    const sameApproval = planApprovable === (state.latestPlan !== null && state.phase === 'awaiting-approval');
    if (chatWorkflow === state.workflow && planningPhase === state.phase && samePlanId && sameApproval) {
      if (hadPendingAction) {
        updateComposer();
        rebuildReview();
      }
      return;
    }
    chatWorkflow = state.workflow;
    planningPhase = state.phase;
    if (state.phase !== 'awaiting-approval') revisionPlanId = null;
    planApprovable = false;
    activePlanHistorical = false;
    if (state.latestPlan) {
      recordPlan(state.latestPlan);
      activePlan = state.latestPlan;
      planApprovable = state.phase === 'awaiting-approval';
      if (state.latestPlan.execution?.status === 'completed') markPlanExecuted(state.latestPlan.planId);
    }
    threadWorkflows.set(currentThread.id, chatWorkflow);
    updateWorkflowControl();
    updateComposer();
    rebuildReview();
  }

  /** 채팅 전환 — 모드·계획 기록은 표시용으로만 복원한다. */
  function restorePlanningForThread(threadId: string, thread?: ChatThread): void {
    revisionPlanId = null;
    planArchives.set(currentThread.id, planHistory);
    planHistory = planArchives.get(threadId) ?? [];
    const latestPlan = planHistory[planHistory.length - 1] ?? null;
    activePlan = latestPlan;
    activePlanHistorical = false;
    planMinimized = false;
    planApprovable = false;
    chatWorkflow = threadWorkflows.get(threadId) ?? 'direct';
    planningPhase = chatWorkflow === 'plan'
      ? 'planning'
      : chatWorkflow === 'question'
        ? 'questioning'
        : 'direct';
    updateWorkflowControl();
    updateComposer();
    rebuildReview();
  }

  // ── 리뷰 카드 (change-set 승인/거절) ──────────────────
  function buildReviewCard(set: PendingChangeSet): HTMLElement {
    const editingLeaseActive = bridge.getEditingLease().active;
    const card = el('div', `ag-review-card ag-${set.agent}`);
    const summary = el('div', 'ag-review-summary');

    const title = el('div', 'ag-review-title');
    title.append(
      el('span', 'ag-review-title-text', `${AGENT_LABEL[set.agent]} 편집 대기`),
      el('span', 'ag-review-count', `${String(set.ops.length).padStart(2, '0')}건`),
    );
    summary.appendChild(title);
    summary.append(renderPendingOpsDiff(set.ops, buildReviewOp));
    card.appendChild(summary);
    if (set.turnStopped) {
      card.appendChild(el('p', 'ag-review-note', '작업이 중단됐습니다. 남은 편집을 유지하거나 버릴 수 있습니다.'));
    }

    const actions = el('div', 'ag-review-actions');
    const approve = el('button', 'ag-approve ag-change-action');
    approve.type = 'button';
    approve.append(
      createIcon('check', 'ag-review-action-icon'),
      el('span', 'ag-review-action-label', '변경 수락'),
    );
    approve.disabled = editingLeaseActive;
    approve.addEventListener('click', () => {
      if (bridge.getEditingLease().active) return;
      approve.disabled = true;
      reject.disabled = true;
      try {
        bridge.pendingEdits.approve(set.id);
      } catch (err) {
        approve.disabled = false;
        reject.disabled = false;
        systemMessage(`승인 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const reject = el('button', 'ag-reject ag-change-action');
    reject.type = 'button';
    reject.append(
      createIcon('close', 'ag-review-action-icon'),
      el('span', 'ag-review-action-label', '변경 거절'),
    );
    reject.disabled = editingLeaseActive;
    reject.addEventListener('click', () => {
      if (bridge.getEditingLease().active) return;
      approve.disabled = true;
      reject.disabled = true;
      try {
        bridge.pendingEdits.reject(set.id);
      } catch (err) {
        approve.disabled = false;
        reject.disabled = false;
        systemMessage(`거절 실패: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    actions.append(approve, reject);
    card.appendChild(actions);
    return card;
  }

  function updateComposerActivity(changeSets: readonly PendingChangeSet[]): void {
    const activeEdit = changeSets.find((set) => set.status === 'open');
    updateTurnPending(activeEdit?.agent);
  }

  function currentAgentUndoEntry(): object | null {
    const turn = turnChanges.get(currentThread.id, currentDocumentId);
    const entry = turn?.applied ? turn.undoEntry : null;
    return entry && deps.undoAgentTurn && deps.getAgentUndoEntry?.() === entry ? entry : null;
  }

  function updateAgentUndoButtons(): void {
    const available = currentAgentUndoEntry() !== null;
    const disabled = bridge.getEditingLease().active || mergeResolverLocked;
    for (const button of [agentUndoBtn, reviewColumnUndo]) {
      if (available && button.hidden) {
        button.classList.remove('ag-undo-arrive');
        void button.offsetWidth;
        button.classList.add('ag-undo-arrive');
      }
      button.hidden = !available;
      button.disabled = !available || disabled;
    }
  }

  function undoLatestAgentTurn(): void {
    if (bridge.getEditingLease().active || mergeResolverLocked) return;
    const entry = currentAgentUndoEntry();
    if (!entry) return;
    if (deps.undoAgentTurn?.(entry)) {
      turnChanges.begin(currentThread.id);
      rebuildReview();
      scheduleChangesRefresh();
    } else updateAgentUndoButtons();
  }

  /** 승인·거절로 사라지는 검토 카드는 제자리에서 접히며 빠진다. */
  function collapseLeavingReviewCard(card: HTMLElement, height: number): void {
    card.classList.add('ag-review-card-leaving');
    card.inert = true;
    card.style.height = `${height}px`;
    review.prepend(card);
    void card.offsetHeight;
    const remove = () => card.remove();
    requestAnimationFrame(() => {
      card.classList.add('ag-review-card-gone');
      card.style.height = '0px';
      card.addEventListener('transitionend', (event) => {
        if (event.propertyName === 'height') remove();
      });
      window.setTimeout(remove, 600);
    });
  }

  function rebuildReview(): void {
    const leavingCandidates = [...review.querySelectorAll<HTMLElement>(
      ':scope > .ag-review-card[data-set-id]:not(.ag-review-card-leaving)',
    )].map((card) => ({ card, height: card.offsetHeight }));
    const previousPlanId = planCardSlot.querySelector<HTMLElement>('.ag-plan-card')?.dataset.planId;
    const previousScrollTop = planCardSlot.scrollTop;
    const openStepIds = new Set([...planCardSlot.querySelectorAll<HTMLElement>('.ag-plan-step-details[open]')]
      .map((details) => details.closest<HTMLElement>('.ag-plan-step')?.dataset.stepId).filter(Boolean));
    const openSecondaryLabels = new Set([...planCardSlot.querySelectorAll<HTMLElement>('.ag-plan-secondary[open]')]
      .map((details) => details.dataset.label).filter(Boolean));
    const focused = planCardSlot.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusedStepId = focused?.closest<HTMLElement>('.ag-plan-step')?.dataset.stepId;
    const focusedSecondaryLabel = focused?.closest<HTMLElement>('.ag-plan-secondary')?.dataset.label;
    review.replaceChildren();
    planCardSlot.replaceChildren();
    // 계획과 문서 변경은 서로 다른 surface다. 긴 계획이 변경 목록을 밀어내지
    // 않고, 집중 모드의 환경 패널에서도 각각 독립적으로 열린다.
    const planShown = chatWorkflow === 'plan' && (activePlan !== null || planningPhase === 'planning');
    if (activePlan && chatWorkflow === 'plan') {
      const card = buildPlanCard(activePlan);
      if (previousPlanId === activePlan.planId) card.classList.add('ag-plan-update');
      planCardSlot.appendChild(card);
      if (activePlanHistorical && planningPhase === 'planning') planCardSlot.appendChild(buildPlanDraftCard());
      if (previousPlanId === activePlan.planId) {
        for (const details of planCardSlot.querySelectorAll<HTMLDetailsElement>('.ag-plan-step-details')) {
          if (openStepIds.has(details.closest<HTMLElement>('.ag-plan-step')?.dataset.stepId)) details.open = true;
        }
        for (const details of planCardSlot.querySelectorAll<HTMLDetailsElement>('.ag-plan-secondary')) {
          if (openSecondaryLabels.has(details.dataset.label)) details.open = true;
        }
        planCardSlot.scrollTop = previousScrollTop;
        if (focusedStepId || focusedSecondaryLabel) {
          const target = focusedStepId
            ? [...planCardSlot.querySelectorAll<HTMLElement>('.ag-plan-step-summary')]
              .find((summary) => summary.closest<HTMLElement>('.ag-plan-step')?.dataset.stepId === focusedStepId)
            : [...planCardSlot.querySelectorAll<HTMLElement>('.ag-plan-secondary summary')]
              .find((summary) => summary.closest<HTMLElement>('.ag-plan-secondary')?.dataset.label === focusedSecondaryLabel);
          target?.focus({ preventScroll: true });
        }
      }
    }
    else if (planShown) planCardSlot.appendChild(buildPlanDraftCard());
    planSurface.hidden = !planShown;
    if (!planShown) {
      planMinimized = false;
      planColCollapsed = true;
    }
    const changeSets = bridge.pendingEdits.getChangeSets();
    const reviewSets = changeSets.filter((set) => set.status !== 'open');
    const activeOps = new Set(changeSets.flatMap(set => set.ops.map(op => op.id)));
    for (const [id, url] of reviewImageUrls) {
      if (!activeOps.has(id)) {
        URL.revokeObjectURL(url);
        reviewImageUrls.delete(id);
      }
    }
    updateComposerActivity(changeSets);
    for (const set of reviewSets) {
      const card = buildReviewCard(set);
      card.dataset.setId = set.id;
      review.appendChild(card);
    }
    const liveSetIds = new Set(reviewSets.map((set) => set.id));
    const motionOk = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for (const { card, height } of leavingCandidates) {
      if (motionOk && height > 0 && !liveSetIds.has(card.dataset.setId ?? '')) {
        collapseLeavingReviewCard(card, height);
      }
    }
    updateAgentUndoButtons();
    applyPlanMinimizedState();
    updateReviewControl(changeSets);
  }

  // ── 구독 ──────────────────────────────────────────────
  const unsubBridge = bridge.onEvent(handleSidebarEvent);
  // 저장소 준비가 허브의 welcome 보다 늦어도 시작 채팅 고르기(settleStartupChat)가 둘 다 기다린
  // 뒤에 살아 있는 채팅을 잇는다 — 여기서 질문을 따로 되살리지 않는다.
  const unsubThreads = subscribeThreadChanges(() => {
    if (threadsListVisible()) rebuildThreadsList();
  });
  // 다른 탭의 채팅이 일을 시작하거나 끝내면 이 탭의 목록에도 불이 옮겨 붙는다.
  const unsubChatStatus = subscribeChatStatus(() => {
    if (threadsListVisible()) rebuildThreadsList();
  });
  /* "작업 중 2분"과 경과 표시는 목록이 보이는 동안 30초마다 고친다. */
  const threadClock = window.setInterval(refreshThreadWhens, 30_000);
  void bridge.listTemplates().then((catalog) => {
    templateCatalog = catalog;
    activeTemplate = currentThread.activeTemplateId
      ? catalog.templates.find((template) => template.id === currentThread.activeTemplateId) ?? null
      : null;
    if (currentThread.activeTemplateId && !activeTemplate) {
      currentThread.activeTemplateId = null;
      bridge.setActiveTemplate(null);
      upsertThread(currentThread);
    }
    renderActiveTemplate();
    rebuildSlashMenu();
  }).catch(() => { /* WebSocket catalog event retries after reconnect. */ });
  const unsubPending = bridge.pendingEdits.onChange((e: PendingEditsChangeEvent) => {
    turnChanges.capture(e, bridge.pendingEdits.getChangeSets(), turnOwnerThreadId ?? currentThread.id,
      currentDocumentId, deps.getAgentUndoEntry?.() ?? null);
    scheduleChangesRefresh();
    if (e.type === 'invalidated') systemMessage(invalidatedMessage(e));
    rebuildReview();
  });
  const unsubEditingLease = bridge.onEditingLeaseChange(() => {
    rebuildReview();
    changesDrawer.refreshEditingState();
    scheduleChangesRefresh();
  });
  const contextUnsubs = eventBus
    ? [
        eventBus.on('document-mutated', () => {
          scheduleChangesRefresh();
          updateAgentUndoButtons();
        }),
        eventBus.on('history-jumped', () => { turnChanges.clear(); rebuildReview(); scheduleChangesRefresh(); }),
        eventBus.on('document-swapped', () => { turnChanges.clear(); rebuildReview(); scheduleChangesRefresh(); updateDocumentContext(); }),
        eventBus.on('document-context-changed', updateDocumentContext),
        eventBus.on('cursor-format-changed', updateDocumentContext),
        eventBus.on('picture-object-selection-changed', updateDocumentContext),
        eventBus.on('table-object-selection-changed', updateDocumentContext),
        eventBus.on('merge-resolver-lock-changed', (locked) => {
          mergeResolverLocked = locked === true;
          root.classList.toggle('ag-merge-resolver-locked', mergeResolverLocked);
          changesDrawer.refreshEditingState();
          rebuildReview();
          updateComposer();
        }),
        eventBus.on('versions:open', () => {
          setCollapsed(false);
          openConfiguredVersionControl();
        }),
        eventBus.on('settings:open', (payload) => {
          const requested = (payload as { destination?: unknown } | undefined)?.destination;
          const destination = normalizeSettingsDestination(requested);
          setCollapsed(false);
          setSettingsPanelOpen(true, destination);
        }),
      ]
    : [];

  // 초기 상태 반영
  setSelectedAgent(selectedAgent);
  setConnection(connState);
  setTurnRunning(turnRunning);
  updateWorkflowControl();
  updateDocumentContext();
  /**
   * 재시작·새로고침 뒤 처음 띄울 채팅을 고른다. 스레드 저장소와 허브의 첫 답(welcome)이 모두 준비된
   * 뒤 한 번 돈다. 허브가 이 창의 채팅을 아직 돌리고 있으면(턴·질문·계획 승인 대기) 그 채팅을 다시
   * 시작하지 않고 잇고, 아니면 현재 문서의 마지막 채팅을 복원한다 — openThread 가 세션 시작을 맡는다.
   */
  let resolveStartupChatSettled: () => void = () => {};
  const startupChatSettled = new Promise<void>((resolve) => { resolveStartupChatSettled = resolve; });
  function settleStartupChat(): void {
    if (!startupChatPending) return;
    startupChatPending = false;
    try {
      chooseStartupChat();
    } finally {
      resolveStartupChatSettled();
    }
  }

  function chooseStartupChat(): void {
    if (root.dataset.disposed === 'true') return;
    const decision = decideStartupChat({
      live: bridge.getHubChat(),
      getThread,
      threads: listThreads(),
      documentId: currentDocumentId,
      docKey: currentDocKey,
    });
    reconcileStartupTurns(decision);
    if (restoringLiveQuestion || chatChosen) return;
    // 사용자가 이미 초안에 쓰기 시작했으면(한글 조합 중 포함) 아무것도 바꾸지 않는다.
    if (currentThread.messages.length > 0 || input.value !== '') return;
    if (decision.kind === 'adopt') {
      openThread(decision.threadId);
      return;
    }
    // 살아 있는 턴의 문서가 아직 없다 — 그 문서가 열리면 handleDocumentSwitch 가 잇는다.
    if (decision.kind === 'await-document') return;
    // 화면에 없는 다른 문서의 턴은 고칠 문서가 없다 — 복원 전에 끝낸다.
    if (decision.stopLive) bridge.stopChat();
    if (decision.threadId && decision.threadId !== currentThread.id) openThread(decision.threadId);
  }

  /**
   * 시작 채팅을 고르기 직전, 저장소와 허브의 첫 답이 모두 준비된 때 한 번 부른다(사용자나 편집기가
   * 이미 채팅을 골랐어도 부른다). 지금은 할 일이 없다.
   * - S3: 여기서 중단된 턴을 정리한다(reconcileInterruptedTurns). decision 이 adopt 면 그 채팅의 마지막
   *   미정 턴은 살아 있으니 남기고, adopt 가 아닌 살아 있는 턴(await-document·stopLive)은 이 화면에서
   *   끊긴 것으로 본다. 뒤에 문서가 열려 다시 붙으면 onLiveChatAdopted 가 되살린다.
   */
  function reconcileStartupTurns(_decision: StartupChatDecision): void {
    // S3 가 채운다.
  }

  // 허브가 첫 답을 끝내 주지 못하는 경우(세션 구성 조회가 멈춘 데스크톱 IPC 등)에도 복원은 한다 —
  // 그때 늦게 온 같은 채팅의 살아 있는 턴은 브리지가 시작 요청 대신 잇는다.
  const hubAnswer = Promise.race([
    bridge.hubSessionKnown(),
    new Promise<void>((resolve) => window.setTimeout(resolve, STARTUP_HUB_ANSWER_TIMEOUT_MS)),
  ]);
  void Promise.all([waitForThreadsPersistence(), hubAnswer]).then(() => {
    // 화면 밖에서 만든 채팅 창은 편집기가 곧바로 초안이나 채팅을 고른다 — 한 박자 미뤄 그 선택을 덮지 않는다.
    if (deps.startActive === false) window.setTimeout(settleStartupChat, 0);
    else settleStartupChat();
  });
  rebuildReview();
  // 같은 문서의 다른 채팅이 편집하는 동안 이 채팅은 채팅 모드만 쓴다.
  const unsubChatModeLock = chatModeLock?.subscribe(() => readChatModeLock()) ?? (() => {});
  readChatModeLock();

  /**
   * 인라인 프롬프트(문서 선택 위 입력 상자)에서 온 지시를 채팅으로 보낸다.
   * 말풍선에는 지시만 보이고, 에이전트에게는 선택 컨텍스트 블록을 함께 보낸다.
   */
  async function sendInlinePrompt(submission: InlinePromptSubmission): Promise<Awaited<InlinePromptSendResponse>> {
    const prompt = submission.prompt.trim();
    if (!prompt) return { ok: false, reason: '지시 입력 필요' };
    if (mergeResolverLocked) return { ok: false, reason: '병합 검토 진행 중' };
    if (readOnlyDocLabel !== null) return { ok: false, reason: '다른 문서의 채팅을 열람 중입니다' };
    if (connState !== 'connected') return { ok: false, reason: '에이전트 허브에 연결되어 있지 않습니다' };
    if (turnRunning) return { ok: false, reason: '에이전트가 응답 중입니다' };
    if (planningPhase === 'switching' || workflowTransitionPending || planActionPending
      || chatStartPendingThreadId !== null || attachmentsSending) {
      return { ok: false, reason: '잠시 후 다시 시도' };
    }
    setCollapsed(false);
    if (threadsPanelOpen) setThreadsPanelOpen(false);
    if (skillsPanelOpen) setSkillsPanelOpen(false);
    if (settingsPanelOpen) setSettingsPanelOpen(false);
    if (versionsPanelOpen) setVersionsPanelOpen(false);
    const files = submission.selection.attachments ?? [];
    let staged: Awaited<ReturnType<typeof referenceLibrary.stageInlineFiles>> = [];
    if (files.length > 0) {
      attachmentsSending = true;
      updateComposer();
      try {
        staged = await referenceLibrary.stageInlineFiles(files, submission.signal);
      } catch (caught) {
        attachmentsSending = false;
        updateComposer();
        return { ok: false, reason: caught instanceof Error ? caught.message : '선택 이미지를 첨부하지 못했습니다' };
      }
    }
    if (submission.signal?.aborted) {
      await referenceLibrary.discardInlineFiles(staged);
      attachmentsSending = false;
      updateComposer();
      return { ok: false, reason: '선택 자료 전송이 취소되었습니다.' };
    }
    // 선택 맥락은 그 문서 리비전에 묶여 있어 미뤄 보낼 수 없다 — 대기열 없이 지금 보낸다.
    // 말풍선에는 지시만 남고, 에이전트에게는 선택 맥락 블록이 앞에 붙은 요청문이 간다.
    let sent: ComposedMessageResult<ThreadMessage, HTMLElement> | null = null;
    let messageId: string | null = null;
    let failure: string | null = null;
    try {
      sent = sendComposedMessage({
        text: prompt,
        wire: { displayText: prompt, requestText: `${submission.selection.contextBlock}\n\n${prompt}` },
        staged,
        selection: {
          label: submission.selection.label,
          excerpt: submission.selection.excerpt,
          items: submission.selection.items,
          documentId: submission.selection.documentId,
          revision: submission.selection.revision,
        },
        origin: 'inline',
        requireReceipt: true,
        signal: submission.signal,
      });
      messageId = await sent.sent;
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : '선택 자료를 보내지 못했습니다';
    }
    if (!messageId) {
      // 기록보다 늦게 실패를 안다 — 남긴 말풍선과 응답 대기를 걷는다.
      if (sent) {
        unrecordUserMessage(sent.message, sent.bubble);
        if (!turnRunning) {
          replyPending = false;
          updateTurnPending();
        }
      }
      await referenceLibrary.discardInlineFiles(staged);
      attachmentsSending = false;
      updateComposer();
      return { ok: false, reason: failure ?? '선택 자료 전송 실패 · 다시 시도' };
    }
    attachmentsSending = false;
    updateComposer();
    return { ok: true };
  }

  // ── 화면에 붙이고 내리기 ──────────────────────────────
  /* 문서마다 사이드바가 하나씩 있고 화면에는 붙은 문서의 사이드바 하나만 선다.
     내려간 사이드바는 문서에서 떨어진 채 DOM 과 대화 상태를 그대로 품고 브리지
     이벤트를 계속 받는다. 문서에서 떨어져 있으니 id 와 접기 탭도 겹치지 않는다. */
  let savedScrollPositions: Array<[Element, number, number]> = [];

  function pageLayoutSnapshot(): SidebarPageLayout {
    return {
      collapsed: root.classList.contains('ag-collapsed'),
      fullscreen,
      threadsPanelOpen,
      sidebarWidth,
      railWidth,
      reviewWidth,
      threadsRailCollapsed,
      environmentPanelOpen,
      desktopEnvironmentPanelOpen,
    };
  }

  /** 앞서 붙어 있던 사이드바의 배치를 이어받는다. 전이·교차 페이드 없이 끝 상태로 선다. */
  function adoptPageLayout(layout: SidebarPageLayout | null): void {
    applySidebarWidth(layout?.sidebarWidth ?? sidebarWidth, { persist: false, recenter: false });
    if (layout) {
      applyRailWidth(layout.railWidth);
      applyReviewWidth(layout.reviewWidth);
      threadsRailCollapsed = layout.threadsRailCollapsed;
      environmentPanelOpen = layout.environmentPanelOpen;
      desktopEnvironmentPanelOpen = layout.desktopEnvironmentPanelOpen;
    }
    const nextFullscreen = layout?.fullscreen ?? fullscreen;
    const fullscreenChanged = nextFullscreen !== fullscreen || fullscreenLayoutOn !== nextFullscreen;
    if (fullscreenChanged) {
      fullscreen = nextFullscreen;
      cancelFsMotionTimers();
      composerRest.setResting(false);
      applyFullscreenLayout(fullscreen);
    } else {
      setPageClass('ag-fullscreen-open', fullscreen);
      applyEnvironmentPanelState();
      applyThreadsRailState();
    }
    // 집중 모드로 들어가는 배치는 이미 사이드바를 펼쳤다.
    if (!fullscreenChanged || !fullscreen) {
      const collapsed = !fullscreen && (layout?.collapsed ?? root.classList.contains('ag-collapsed'));
      setCollapsed(collapsed, { recenter: false });
    }
    if (!fullscreen && layout && layout.threadsPanelOpen !== threadsPanelOpen) {
      setThreadsPanelOpen(layout.threadsPanelOpen, { focus: false });
    }
  }

  /* 문서에서 떨어지면 스크롤 위치를 잃는다 — 내릴 때 적어 두고 붙일 때 되돌린다. */
  function rememberScrollPositions(): void {
    savedScrollPositions = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node: Node | null = walker.currentNode; node; node = walker.nextNode()) {
      const element = node as Element;
      if (element.scrollTop !== 0 || element.scrollLeft !== 0) {
        savedScrollPositions.push([element, element.scrollTop, element.scrollLeft]);
      }
    }
  }

  function restoreScrollPositions(): void {
    for (const [element, top, left] of savedScrollPositions) {
      if (!root.contains(element)) continue;
      element.scrollTop = top;
      element.scrollLeft = left;
    }
    savedScrollPositions = [];
    // 따라가던 대화는 그사이 늘어난 끝으로 움직임 없이 바로 간다.
    lockConversationScroll(80);
    syncConversationSpacer();
    if (followConversation) {
      const anchor = latestTurnAnchor();
      if (anchor) messages.scrollTop = roundedConversationTarget(anchor);
    }
    conversationLastScrollTop = messages.scrollTop;
    composerRestLastScrollTop = messages.scrollTop;
    scheduleLatestPillUpdate();
  }

  /** 다시 붙으며 처음부터 도는 CSS 등장 애니메이션은 끝 상태로 건너뛴다. 무한 반복(맥박·잉크)은 그대로 둔다. */
  function finishReplayedAnimations(): void {
    if (typeof root.getAnimations !== 'function') return;
    for (const animation of root.getAnimations({ subtree: true })) {
      const cssDriven = (typeof CSSAnimation !== 'undefined' && animation instanceof CSSAnimation)
        || (typeof CSSTransition !== 'undefined' && animation instanceof CSSTransition);
      if (!cssDriven) continue;
      const end = animation.effect?.getComputedTiming().endTime;
      if (typeof end === 'number' && Number.isFinite(end)) animation.finish();
    }
  }

  function activate(): void {
    if (active || root.dataset.disposed === 'true') return;
    active = true;
    // 배치는 문서에 붙이기 전에 맞춘다 — 스타일이 한 번에 계산되어 전이가 걸리지 않는다.
    adoptPageLayout(readSidebarPageLayout());
    occupySidebarSlot(COLLAPSE_TAB_SLOT, collapseTab, () => {
      document.getElementById('icon-toolbar')?.appendChild(collapseTab);
    });
    occupySidebarSlot(ROOT_SLOT, root, () => document.body.appendChild(root));
    measure();
    // 가려져 있던 동안 쌓인 답변을 등장 애니메이션 없이 한 번에 그린 뒤 스크롤을 되돌린다.
    const hiddenStream = pendingAssistantBubble;
    if (hiddenStream) {
      pendingAssistantBubble = null;
      renderAssistantMessage(hiddenStream, assistantBubbleSources.get(hiddenStream) ?? '', { streaming: true });
    }
    restoreScrollPositions();
    if (threadsListVisible()) rebuildThreadsList();
    updateDocumentContext();
    readChatModeLock();
    finishReplayedAnimations();
  }

  function deactivate(): void {
    if (!active || root.dataset.disposed === 'true') return;
    flushTranscriptPersist();
    // 다른 채팅이나 문서로 떠나면 보내지 않은 초안은 버린다.
    discardDraft();
    // 끌기·여닫기·교차 페이드는 끝 상태로 정리한다. 일시 클래스는 아직 붙어 있을 때 거둔다.
    endSidebarResize();
    endColumnResize();
    if (insetMotion) startInsetRecenterLoop({ instant: true });
    if (fullscreenLayoutOn !== fullscreen) applyFullscreenLayout(fullscreen);
    cancelFsMotionTimers();
    clearCompactRailHoverOpen();
    clearCompactRailHoverClose();
    closeThreadRailSurfaces(root);
    dismissOpenSheets();
    setConnPopoverOpen(false);
    // 펼침·inset·집중 모드 클래스는 남긴다 — 다음 사이드바가 그 배치를 이어받는다.
    writeSidebarPageLayout(pageLayoutSnapshot());
    rememberScrollPositions();
    // 위로 읽던 대화는 뒤에서 답이 늘어나도 그 자리를 지킨다.
    if (!followConversation) conversationScrollPaused = true;
    cancelConversationScroll();
    // 예약한 스트리밍 렌더는 접는다 — 답변 원문은 계속 쌓이고 activate() 가 그린다.
    if (assistantRenderFrame !== null) {
      window.cancelAnimationFrame(assistantRenderFrame);
      assistantRenderFrame = null;
    }
    active = false;
    // 떠나는 사이드바의 보류된 도착은 지금 연다. active 가 꺼졌으므로 초점은 옮기지 않는다.
    arrivalGuard.release();
    vacateSidebarSlot(COLLAPSE_TAB_SLOT, collapseTab);
    vacateSidebarSlot(ROOT_SLOT, root);
  }

  return {
    root,
    openVersions(): void {
      setCollapsed(false);
      openConfiguredVersionControl();
    },
    sendInlinePrompt,
    activate,
    deactivate,
    isActive: () => active,
    openThreadById(threadId: string): void {
      if (root.dataset.disposed === 'true') return;
      chatChosen = true;
      if (pendingThreadSwitch?.threadId === threadId) pendingThreadSwitch = null;
      openThread(threadId, { routed: true });
    },
    startDraftChat(): void {
      if (root.dataset.disposed === 'true') return;
      chatChosen = true;
      startNewChat();
    },
    currentThreadId(): string | null {
      return draftChat || currentThread.messages.length === 0 ? null : currentThread.id;
    },
    startupChatSettled: () => startupChatSettled,
    followThreadOnNextDocument(threadId: string): void {
      if (root.dataset.disposed === 'true') return;
      // 이 채팅을 열기로 정했으니, 늦게 도는 "마지막 채팅 복원"이 덮어쓰지 않게 한다.
      chatChosen = true;
      pendingThreadSwitch = { threadId };
    },
    dispose(): void {
      if (root.dataset.disposed === 'true') return;
      followUps.detach('interrupted');
      resolveStartupChatSettled();
      flushTranscriptPersist();
      // 붙어 있던 사이드바를 걷으면 다음에 붙는 사이드바가 이 배치를 이어받는다.
      if (active) writeSidebarPageLayout(pageLayoutSnapshot());
      root.dataset.disposed = 'true';
      for (const url of reviewImageUrls.values()) URL.revokeObjectURL(url);
      reviewImageUrls.clear();
      threadComposerDrafts.clear();
      arrivalGuard.dispose();
      connStatus.dispose();
      composerLock.dispose();
      turnPendingStatus.dispose();
      if (railRevealTimer !== null) window.clearTimeout(railRevealTimer);
      railRevealTimer = null;
      questionController.dispose();
      // 걸어 둔 '리셋 후 이어서' 는 창과 함께 사라진다.
      failureNotices.dispose();
      unsubChatModeLock();
      unsubTurnRestore();
      unsubBridge();
      unsubThreads();
      unsubChatStatus();
      window.clearInterval(threadClock);
      closeThreadRailSurfaces(root);
      unsubPending();
      unsubEditingLease();
      clearTimeout(changesRefreshTimer);
      changesDrawer.dispose();
      turnChanges.clear();
      unsubscribeHancomGitVisibility();
      contextUnsubs.forEach((unsub) => unsub());
      messagesMutationObserver?.disconnect();
      messagesResizeObserver?.disconnect();
      turnFoldResizeObserver?.disconnect();
      if (messagesResizeFrame !== null) window.cancelAnimationFrame(messagesResizeFrame);
      dockResizeObserver?.disconnect();
      composerStackResizeObserver?.disconnect();
      cancelAnimationFrame(composerStackFrame);
      rootResizeObserver?.disconnect();
      messages.removeEventListener('scroll', onMessagesScroll);
      messages.removeEventListener('wheel', onMessagesWheel);
      window.removeEventListener('focus', onWindowRefocus);
      window.removeEventListener('pagehide', onPageHide);
      composerRest.dispose();
      focusGreeting.dispose();
      messages.removeEventListener('touchstart', onMessagesTouchStart);
      messages.removeEventListener('touchmove', onMessagesTouchMove);
      messages.removeEventListener('pointerdown', onMessagesPointerDown);
      if (configHideTimer !== null) window.clearTimeout(configHideTimer);
      cancelConversationScroll();
      if (conversationScrollUnlock !== null) {
        window.clearTimeout(conversationScrollUnlock);
        conversationScrollUnlock = null;
      }
      if (deferredVersionsOpenTimer !== null) {
        window.clearTimeout(deferredVersionsOpenTimer);
        deferredVersionsOpenTimer = null;
      }
      window.removeEventListener('resize', onWindowResizeSettleInset);
      window.removeEventListener('resize', onWindowResizeMeasure);
      clearCompactRailHoverOpen();
      clearCompactRailHoverClose();
      compactRailHoverTarget.removeEventListener('pointerenter', onCompactRailEdgeEnter);
      compactRailHoverTarget.removeEventListener('pointerleave', onCompactRailEdgeLeave);
      threadsPage.removeEventListener('pointerenter', onCompactRailPointerEnter);
      threadsPage.removeEventListener('pointerleave', onCompactRailPointerLeave);
      root.removeEventListener('pointermove', onCompactRailPointerMove);
      root.removeEventListener('pointerleave', onCompactRailPointerExit);
      document.removeEventListener('pointerdown', onDocPointerDown);
      document.removeEventListener('pointerdown', onCompactDrawerPointerDown, true);
      document.removeEventListener('focusin', onCompactDrawerFocusIn);
      document.removeEventListener('keydown', onDocKeyDown);
      window.removeEventListener('keydown', onAgentShortcutKeyDown, true);
      window.removeEventListener('rhwp:agent-command', onAgentCommand);
      if (latestPillFrame !== null) window.cancelAnimationFrame(latestPillFrame);
      cancelFsMotionTimers();
      endSidebarResize();
      endColumnResize();
      root.classList.remove('ag-col-resizing');
      clearInsetRecenterLoop();
      if (resizeMoveRaf !== null) {
        cancelAnimationFrame(resizeMoveRaf);
        resizeMoveRaf = null;
      }
      document.removeEventListener('pointerdown', onConnPopoverOutside);
      writingStyleCalibration.dispose();
      settingsPanel.dispose();
      versionManagerPage?.dispose();
      versionController?.dispose?.();
      initialSetup?.dispose();
      if (initialSetupOwner === root) initialSetupOwner = null;
      clearAttachmentDrag();
      root.removeEventListener('dragenter', onAttachmentDragEnter);
      root.removeEventListener('dragover', onAttachmentDragOver);
      root.removeEventListener('dragleave', onAttachmentDragLeave);
      root.removeEventListener('drop', onAttachmentDrop);
      input.removeEventListener('paste', onAttachmentPaste);
      referenceLibrary.dispose();
      // 페이지 클래스는 화면에 붙어 있던 사이드바만 걷는다.
      if (active) {
        document.body.classList.remove(
          'ag-sidebar-open',
          'ag-sidebar-inset',
          'ag-sidebar-resizing',
          'ag-fullscreen-open',
          'ag-col-resizing',
        );
      }
      sweepUnresolvedToolRows();
      collapseTab.remove();
      root.remove();
    },
  };
}

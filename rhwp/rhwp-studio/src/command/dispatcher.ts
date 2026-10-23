import type { EventBus } from '@/core/event-bus';
import type { CommandRegistry } from './registry';
import type { CommandServices, EditorContext } from './types';

const FORM_MODE_BLOCKED_IDS = new Set([
  'edit:cut',
  'edit:paste',
  'edit:delete',
  'field:edit',
  'field:remove',
  // [#2361 리뷰] 편집 용지의 파일 메뉴/F7 변형. page:setup 은 'page:' prefix 로 차단되는데
  // 이 변형만 열려 있었다 — 양식 모드에선 snapshot 이 드롭되므로(입력-핸들러 게이트) 다이얼로그가
  // 열리면 확인이 무언 폐기된다. 두 진입점을 동일하게 차단해 정합.
  'file:page-setup',
]);

const FORM_MODE_BLOCKED_PREFIXES = [
  'format:',
  'insert:',
  'table:',
  'page:',
];

function isBlockedInFormMode(commandId: string, ctx: EditorContext): boolean {
  if (!ctx.isFormMode) return false;
  if (FORM_MODE_BLOCKED_IDS.has(commandId)) return true;
  return FORM_MODE_BLOCKED_PREFIXES.some(prefix => commandId.startsWith(prefix));
}

const READ_ONLY_ALLOWED_IDS = new Set([
  'edit:copy',
  'edit:select-all',
  'edit:find',
  'file:print',
]);

/** 문서 보기 전용(readOnlyCanOpen)에서 더 허용하는 명령. 문서를 열거나 읽기만 한다. */
const VIEWER_ALLOWED_IDS = new Set([
  'file:open',
  'file:open-recent',
  'file:about',
  'edit:compare-documents',
]);

/**
 * 에이전트가 문서를 잡은 동안에는 새 선택도 만들 수 없다. 다른 문서를 열거나 만드는 일은
 * 지금 문서를 건드리지 않는다 — 에이전트가 일하는 문서는 뒤에 남고 새 문서는 따로 열린다.
 */
const AGENT_LOCK_ALLOWED_IDS = new Set([
  'edit:copy',
  'file:print',
  'file:new-doc',
  'file:open',
  'file:open-recent',
]);

function isBlockedByDocumentEditLock(commandId: string, ctx: EditorContext): boolean {
  if (ctx.readOnly !== true && ctx.userEditingLocked !== true) return false;
  const allowed = ctx.userEditingLocked === true ? AGENT_LOCK_ALLOWED_IDS : READ_ONLY_ALLOWED_IDS;
  if (ctx.userEditingLocked !== true && ctx.readOnlyCanOpen === true && VIEWER_ALLOWED_IDS.has(commandId)) return false;
  return !allowed.has(commandId)
    && !commandId.startsWith('view:')
    && !commandId.startsWith('help:');
}

// 첫 편집 범위 밖의 명령은 구 엔진 API에 닿기 전에 막는다.
const HEEMANG_COMMANDS = new Set([
  'file:open', 'file:open-recent', 'file:clear-recent', 'file:about',
  'file:save', 'file:save-as', 'edit:undo', 'edit:redo',
]);

function isBlockedByEngine(commandId: string, ctx: EditorContext): boolean {
  if (ctx.engineKind !== 'heemang') return false;
  if (commandId === 'file:save-as-hwp') return ctx.sourceFormat !== 'hwp';
  if (commandId === 'file:save-as-hwpx') return ctx.sourceFormat !== 'hwpx';
  return !HEEMANG_COMMANDS.has(commandId)
    && !commandId.startsWith('view:zoom-')
    && !commandId.startsWith('view:theme-')
    && !commandId.startsWith('view:toolbox-')
    && !commandId.startsWith('help:');
}

/** 통합 커맨드 디스패처: 메뉴/툴바/키보드 모든 입력의 단일 실행 경로 */
export class CommandDispatcher {
  private registry: CommandRegistry;
  private services: CommandServices;
  private eventBus: EventBus;

  constructor(
    registry: CommandRegistry,
    services: CommandServices,
    eventBus: EventBus,
  ) {
    this.registry = registry;
    this.services = services;
    this.eventBus = eventBus;
  }

  /**
   * 커맨드 실행.
   * @returns true: 실행됨, false: 미등록 또는 비활성
   */
  dispatch(commandId: string, params?: Record<string, unknown>): boolean {
    const def = this.registry.get(commandId);
    if (!def) {
      console.warn(`[CommandDispatcher] 미등록 커맨드: ${commandId}`);
      return false;
    }

    const ctx = this.services.getContext();
    if (
      isBlockedByEngine(commandId, ctx)
      || isBlockedInFormMode(commandId, ctx)
      || isBlockedByDocumentEditLock(commandId, ctx)
    ) {
      return false;
    }
    if (def.canExecute && !def.canExecute(ctx)) {
      // canExecute 실패 — 비활성 상태
      return false;
    }

    try {
      def.execute(this.services, params);
      // 커맨드 실행 후 UI 상태 갱신 알림
      this.eventBus.emit('command-state-changed');
      return true;
    } catch (err) {
      console.error(`[CommandDispatcher] 커맨드 실행 실패: ${commandId}`, err);
      return false;
    }
  }

  /**
   * 커맨드가 현재 활성(실행 가능)인지 확인.
   * 메뉴/툴바의 enabled/disabled 상태 갱신에 사용.
   */
  isEnabled(commandId: string, context?: EditorContext): boolean {
    const def = this.registry.get(commandId);
    if (!def) return false;
    const ctx = context ?? this.services.getContext();
    if (
      isBlockedByEngine(commandId, ctx)
      || isBlockedInFormMode(commandId, ctx)
      || isBlockedByDocumentEditLock(commandId, ctx)
    ) return false;
    if (!def.canExecute) return true;
    return def.canExecute(ctx);
  }

  /**
   * 같은 상태에서 명령 여러 개의 활성 여부를 물을 때 쓴다. 컨텍스트(엔진 질의 십여 번)를
   * 처음 물을 때 한 번만 만들고 돌려쓴다. 상태가 바뀐 뒤에는 새로 받아야 한다.
   */
  enabledChecker(): (commandId: string) => boolean {
    let ctx: EditorContext | undefined;
    return (commandId) => this.registry.get(commandId) !== undefined
      && this.isEnabled(commandId, ctx ??= this.services.getContext());
  }
}

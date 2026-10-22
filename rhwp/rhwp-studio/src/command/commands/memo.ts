/**
 * 메모(한컴 "메모", 풍선 주석) 명령: 넣기·고치기·지우기·모두 지우기·보기 토글.
 *
 * 넣기는 선택 글자(선택이 없으면 캐럿의 낱말)에 새 풍선을 편집 상태로 연다. 내용을 쓰고
 * 확정해야 문서에 하나의 실행 취소 단위로 들어가고, 빈 새 메모에서 Esc 를 누르면 아무 기록
 * 없이 사라진다. 모든 쓰기는 executeOperation({kind:'snapshot'}) 이다.
 */
import type { CommandDef, CommandServices } from '../types';
import type { MemoNotePath } from '@/core/types';
import { hyperlinkRange, hyperlinkTarget } from '@/core/hyperlink';
import { userSettings } from '@/core/user-settings';
import { commitMemoDelete, commitMemoDeleteAll } from '@/core/memo-edits';
import { findWordSelectionRange } from '@/engine/word-selection';
import type { MemoOverlay } from '@/view/memo-overlay';
import { showToast } from '@/ui/toast';

let memoOverlay: MemoOverlay | null = null;
/** 우클릭한 메모 앵커 — 다음 memo:edit/memo:delete 한 번에 쓴다. */
let contextMemoFieldId: number | null = null;

export function setMemoOverlay(overlay: MemoOverlay | null): void {
  memoOverlay = overlay;
}

export function getMemoOverlay(): MemoOverlay | null {
  return memoOverlay;
}

/** 컨텍스트 메뉴가 연 메모 (null 이면 캐럿 위치 메모). */
export function setContextMemoFieldId(fieldId: number | null): void {
  contextMemoFieldId = fieldId;
}

function syncToggle(cmdId: string, on: boolean): void {
  document.querySelectorAll(`[data-cmd="${cmdId}"]`).forEach((el) => {
    el.classList.toggle('active', on);
    if (el.classList.contains('md-item')) {
      el.setAttribute('role', 'menuitemcheckbox');
      el.setAttribute('aria-checked', String(on));
    }
  });
}

/** 보기 › 메모 표시 상태를 메뉴·리본에 맞춘다. */
export function syncMemoViewToggle(on: boolean): void {
  syncToggle('view:memo', on);
}

export function memoPathFromTarget(target: { section: number; para: number; cellPath: [number, number, number][] }): MemoNotePath {
  return {
    sectionIdx: target.section,
    paraIdx: target.para,
    ...(target.cellPath.length
      ? {
        cellPath: target.cellPath.map(([controlIndex, cellIndex, cellParaIndex]) => ({
          controlIndex, cellIndex, cellParaIndex,
        })),
      }
      : {}),
  };
}

/** 캐럿 위치의 메모 fieldId (앵커 안), 없으면 null. */
export function memoAtCursor(services: CommandServices): number | null {
  const ih = services.getInputHandler();
  if (!ih) return null;
  try {
    const pos = ih.getCursorPosition();
    return services.wasm.getMemoNoteAt(memoPathFromTarget(hyperlinkTarget(pos)), pos.charOffset);
  } catch {
    return null;
  }
}

function targetMemo(services: CommandServices, params?: Record<string, unknown>): number | null {
  const explicit = params?.fieldId;
  if (typeof explicit === 'number') return explicit;
  const fromContext = contextMemoFieldId;
  contextMemoFieldId = null;
  return fromContext ?? memoAtCursor(services);
}

const canEditMemo = (ctx: Parameters<NonNullable<CommandDef['canExecute']>>[0]) =>
  ctx.hasDocument && ctx.isEditable && !ctx.isFormMode && !ctx.userEditingLocked;

export const memoCommands: CommandDef[] = [
  {
    id: 'insert:memo-note',
    label: '메모',
    icon: 'icon-comment',
    shortcutLabel: 'Ctrl+K,M',
    canExecute: (ctx) => canEditMemo(ctx)
      && !ctx.inCellSelectionMode && !ctx.inPictureObjectSelection && !ctx.inTableObjectSelection,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih || !memoOverlay) return;
      try {
        if (!ih.canEditHyperlink()) throw new Error('본문·표 셀·글상자의 글자에 메모를 달 수 있습니다.');
        const selection = ih.hasSelection() ? structuredClone(ih.getSelection()) : null;
        const range = hyperlinkRange(ih.getCursorPosition(), selection);
        let { start, end } = range;
        if (start === end) {
          // 선택이 없으면 캐럿이 놓인 낱말에 단다 (한컴과 같은 동작).
          const text = services.wasm.getHyperlinkContext(range.target).text;
          const word = findWordSelectionRange(text, start);
          if (!word) throw new Error('메모를 달 글자를 선택해 주세요.');
          start = word.start;
          end = word.end;
        }
        memoOverlay.openDraft(memoPathFromTarget(range.target), start, end);
      } catch (error) {
        showToast({ message: error instanceof Error ? error.message : String(error) });
      }
    },
  },
  {
    id: 'memo:edit',
    label: '메모 고치기',
    canExecute: canEditMemo,
    execute(services, params) {
      const fieldId = targetMemo(services, params);
      if (fieldId === null) {
        showToast({ message: '고칠 메모의 강조된 글자에 캐럿을 두세요.' });
        return;
      }
      memoOverlay?.openEditor(fieldId);
    },
  },
  {
    id: 'memo:delete',
    label: '메모 지우기',
    canExecute: canEditMemo,
    execute(services, params) {
      const fieldId = targetMemo(services, params);
      if (fieldId === null) {
        showToast({ message: '지울 메모의 강조된 글자에 캐럿을 두세요.' });
        return;
      }
      const ih = services.getInputHandler();
      if (ih) commitMemoDelete(ih, fieldId);
    },
  },
  {
    id: 'memo:delete-all',
    label: '모든 메모 지우기',
    canExecute: canEditMemo,
    execute(services) {
      const ih = services.getInputHandler();
      if (!ih) return;
      if (services.wasm.getMemoNoteList().length === 0) {
        showToast({ message: '문서에 메모가 없습니다.' });
        return;
      }
      const removed = commitMemoDeleteAll(ih);
      if (removed > 0) showToast({ message: `메모 ${removed}개를 지웠습니다.` });
    },
  },
  {
    id: 'view:memo',
    label: '메모',
    icon: 'icon-comment',
    canExecute: (ctx) => ctx.hasDocument,
    execute() {
      if (!memoOverlay) return;
      const next = !memoOverlay.isVisible();
      memoOverlay.setVisible(next);
      userSettings.setShowMemos(next);
      syncMemoViewToggle(next);
    },
  },
];

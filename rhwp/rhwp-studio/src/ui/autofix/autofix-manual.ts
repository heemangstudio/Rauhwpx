/**
 * 제목 막대의 자동 수정 단추(데스크톱, 설정에서 자동 수정을 켠 경우). 명령 검색 바로 왼쪽에 선다.
 * 오류 알림이 없어도 사용자가 지금 상태가 고장 났다고 판단하면 눌러, 상태를 짧게 적고 자동 수정을 돌린다
 * (버그 제보처럼). 시트(autofix-manual-sheet.ts)는 누를 때 불러온다.
 */
import { autofixApi, autofixReady, onAutofixSettings, prewarmAutofix } from './autofix.ts';
import type { ManualAutofixSheetOptions } from './autofix-manual-sheet.ts';

export const MANUAL_AUTOFIX_BUTTON_ID = 'editor-autofix-manual';

export interface ManualAutofixOptions {
  /** 단추를 그 바로 왼쪽에 붙일 요소. 기본은 명령 검색 단추. */
  anchor?: () => HTMLElement | null;
  /** 고치지 못했을 때 버그 제보를 연다. */
  reportIssue?: () => void;
  /** 시트를 연다. 테스트가 바꿔 끼운다. */
  open?: (options: ManualAutofixSheetOptions) => Promise<void>;
}

export interface ManualAutofix {
  element: HTMLButtonElement;
  dispose(): void;
}

async function openDefault(options: ManualAutofixSheetOptions): Promise<void> {
  (await import('./autofix-manual-sheet.ts')).openManualAutofixSheet(options);
}

/** 연장통. 명령 검색의 돋보기처럼 16px 선 아이콘이다. */
function toolboxIcon(): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const d of [
    'M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7',
    'M5 7h14a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V8.5A1.5 1.5 0 0 1 5 7Z',
    'M3.5 12.5h17',
    'M9.5 11v3M14.5 11v3',
  ]) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** 데스크톱이 아니면 null. 설정을 켜고 끌 때마다 단추를 붙이고 뗀다(숨기지 않고 떼어 옆 단추의 여백 규칙이 그대로 맞는다). */
export function installManualAutofix(options: ManualAutofixOptions = {}): ManualAutofix | null {
  if (!autofixApi()) return null;
  const anchor = options.anchor ?? (() => document.getElementById('editor-command-search'));
  const open = options.open ?? openDefault;
  const button = document.createElement('button');
  button.type = 'button';
  button.id = MANUAL_AUTOFIX_BUTTON_ID;
  button.className = 'editor-autofix-manual';
  button.title = '자동 수정 — 지금 상태가 이상하면 적어 주세요';
  button.setAttribute('aria-label', '자동 수정');
  button.setAttribute('aria-haspopup', 'dialog');
  // 메뉴 막대(role=menubar) 안의 단추는 명령 검색처럼 menuitem 이다.
  button.setAttribute('role', 'menuitem');
  button.append(toolboxIcon());
  const setBusy = (busy: boolean) => {
    if (busy) button.dataset.running = 'true';
    else delete button.dataset.running;
  };
  // 마우스를 올리면 곧 누를 것이다 — 메인이 쓸 제공자를 미리 고르게 한다.
  button.addEventListener('pointerenter', () => prewarmAutofix());
  button.addEventListener('click', () => {
    prewarmAutofix();
    void open({
      onBusy: setBusy,
      ...(options.reportIssue ? { reportIssue: options.reportIssue } : {}),
    }).catch((error) => console.warn('[autofix] 자동 수정 창을 열지 못했습니다:', error));
  });

  const sync = (): void => {
    const target = anchor();
    if (autofixReady() && target?.parentElement) {
      if (button.nextElementSibling !== target) target.before(button);
    } else {
      button.remove();
    }
  };
  const stop = onAutofixSettings(sync);
  sync();
  return {
    element: button,
    dispose() {
      stop();
      button.remove();
    },
  };
}

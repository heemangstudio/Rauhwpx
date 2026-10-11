/**
 * 페이지에 한 벌뿐인 사이드바 배치.
 *
 * 열린 문서마다 세션과 사이드바가 하나씩 있지만 화면에는 붙은 문서의 사이드바
 * 하나만 선다. 펼침·폭·집중 모드·목록 페이지처럼 화면 전체에 걸린 배치는
 * 사이드바가 아니라 페이지의 것이다. 내려가는 사이드바가 여기에 적어 두면
 * 올라오는 사이드바가 그대로 이어받아, 문서를 바꿔도 화면이 움직이지 않는다.
 */

export interface SidebarPageLayout {
  collapsed: boolean;
  fullscreen: boolean;
  /** 사이드바 배치에서 채팅 목록 페이지가 열려 있는가 */
  threadsPanelOpen: boolean;
  sidebarWidth: number;
  railWidth: number;
  reviewWidth: number;
  threadsRailCollapsed: boolean;
  environmentPanelOpen: boolean;
  /** 좁은 집중 화면에서 잠시 접기 전의 환경 패널 상태 */
  desktopEnvironmentPanelOpen: boolean;
}

let layout: SidebarPageLayout | null = null;

/** 마지막으로 화면에서 내려간 사이드바의 배치. 아직 없으면 null. */
export function readSidebarPageLayout(): SidebarPageLayout | null {
  return layout ? { ...layout } : null;
}

export function writeSidebarPageLayout(next: SidebarPageLayout): void {
  layout = { ...next };
}

/* 내려가는 사이드바는 루트와 접기 탭 자리에 표시를 남기고, 올라오는
   사이드바가 그 자리에 선다 — 도구 모음 순서와 겹침 순서가 그대로다. */
const slots = new Map<string, Comment>();

export function vacateSidebarSlot(name: string, node: ChildNode): void {
  if (!node.parentNode) return;
  const marker = document.createComment(name);
  node.replaceWith(marker);
  slots.get(name)?.remove();
  slots.set(name, marker);
}

export function occupySidebarSlot(name: string, node: ChildNode, mount: () => void): void {
  const marker = slots.get(name);
  slots.delete(name);
  if (marker?.parentNode) marker.replaceWith(node);
  else mount();
}

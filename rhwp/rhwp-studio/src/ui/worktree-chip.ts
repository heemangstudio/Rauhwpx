// 모양은 styles/worktree-chip.css (앱 전역·사이드바가 불러온다).
import type { VersionManagerState } from './agent-sidebar/version-manager.ts';
import { laneColor } from './version-lanes.ts';

/** 같은 문서의 작업 트리가 둘 이상일 때 그 문서가 어느 가지의 사본인지. */
export interface WorktreeIdentity {
  branch: string;
  primary: boolean;
  /** 버전 그래프에서 그 가지 끝 커밋의 줄 색. 그래프와 같은 색으로 짝을 맞춘다. */
  color: string;
}

/** 작업 트리가 하나뿐이면 이름만으로 충분하므로 null 이다. */
export function worktreeIdentity(state: VersionManagerState | null | undefined, documentId: string | null | undefined): WorktreeIdentity | null {
  if (!state || !documentId || state.worktrees.length < 2) return null;
  const tree = state.worktrees.find((entry) => entry.documentId === documentId);
  if (!tree) return null;
  const branch = state.branches.find((entry) => entry.name === tree.branch);
  const tip = branch ? state.commits.find((commit) => commit.id === branch.headId) : undefined;
  return { branch: tree.branch, primary: tree.primary, color: laneColor(tip?.lane ?? 0) };
}

export function worktreeLabel(identity: WorktreeIdentity): string {
  return identity.primary ? `작업 트리: ${identity.branch} (원본)` : `작업 트리: ${identity.branch}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 가지 표시 — 두 갈래로 나뉘는 줄기. 글자(⑂) 대신 그려 어느 글꼴에서도 같은 모양이다. */
export function createBranchIcon(className = 'branch-icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('width', '10');
  svg.setAttribute('height', '10');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3.5 2.2v7.6M3.5 6.6c0-1.9 5-1.3 5-3.6M3.5 2.2a1 1 0 1 0 0 .01M8.5 2.2a1 1 0 1 0 0 .01M3.5 9.8a1 1 0 1 0 0 .01');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

export function createWorktreeChip(): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'worktree-chip';
  chip.hidden = true;
  return chip;
}

export function paintWorktreeChip(chip: HTMLElement, identity: WorktreeIdentity | null): void {
  chip.hidden = !identity;
  if (!identity) {
    chip.replaceChildren();
    chip.removeAttribute('title');
    chip.removeAttribute('aria-label');
    return;
  }
  const label = document.createElement('span');
  label.className = 'worktree-chip-label';
  label.textContent = identity.branch;
  chip.replaceChildren(createBranchIcon(), label);
  chip.style.setProperty('--worktree-color', identity.color);
  chip.title = worktreeLabel(identity);
  chip.setAttribute('aria-label', worktreeLabel(identity));
}

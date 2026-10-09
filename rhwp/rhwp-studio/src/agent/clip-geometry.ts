/**
 * 영역 조각(clip) 좌표 계산. 영역은 쪽(이미지) 크기에 대한 0..1 비율 [x, y, w, h] 이고
 * 허브 project-store 와 같이 소수 넷째 자리로 맞춘다. 화면 끌기·잘라내기·썸네일이 모두
 * 이 순수 함수들을 거친다 (노드 테스트로 고정).
 */
import type { ProjectClipRect } from './types.ts';
import type { PixelBox } from './image-crop.ts';

/** 영역 한 변의 최소 비율 (허브 검증과 같다). */
export const MIN_CLIP_SIZE = 0.01;
/** PDF 쪽의 "원본 픽셀" — 96dpi (1pt = 4/3px). cropPx 와 결과 좌표가 이 단위다. */
export const PDF_PX_PER_PT = 96 / 72;

export interface NormalizedPoint { x: number; y: number }

export type ClipHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** 영역을 [0,1] 안으로 맞추고 넷째 자리로 반올림한다. 숫자가 아니거나 너무 작으면 null. */
export function normalizeClipRect(rect: readonly number[]): ProjectClipRect | null {
  if (rect.length !== 4 || rect.some((value) => !Number.isFinite(value))) return null;
  const left = clamp01(rect[0]!);
  const top = clamp01(rect[1]!);
  const right = clamp01(rect[0]! + rect[2]!);
  const bottom = clamp01(rect[1]! + rect[3]!);
  const x = round4(Math.min(left, right));
  const y = round4(Math.min(top, bottom));
  const w = round4(Math.min(1 - x, Math.abs(right - left)));
  const h = round4(Math.min(1 - y, Math.abs(bottom - top)));
  if (w < MIN_CLIP_SIZE || h < MIN_CLIP_SIZE) return null;
  return [x, y, w, h];
}

/** 끌어 그린 두 점(쪽 비율)으로 영역을 만든다. 어느 방향으로 끌어도 같다. */
export function rectFromPoints(a: NormalizedPoint, b: NormalizedPoint): ProjectClipRect | null {
  return normalizeClipRect([Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)]);
}

/**
 * 영역을 원본 픽셀 상자로 옮긴다. 가장자리는 바깥으로 넓혀 영역을 다 담고 원본 밖으로는
 * 나가지 않는다 (허브 rectToCropPx 와 같은 규칙).
 */
export function rectToPixelBox(rect: readonly number[], width: number, height: number): PixelBox {
  const [x, y, w, h] = rect as [number, number, number, number];
  const left = Math.min(width - 1, Math.max(0, Math.floor(x * width)));
  const top = Math.min(height - 1, Math.max(0, Math.floor(y * height)));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((x + w) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((y + h) * height)));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** 픽셀 상자를 영역 비율로 옮긴다 (결과 보고용, 넷째 자리). */
export function pixelBoxToRect(box: PixelBox, width: number, height: number): ProjectClipRect {
  return [
    round4(box.x / width),
    round4(box.y / height),
    round4(box.width / width),
    round4(box.height / height),
  ];
}

/**
 * 끌어서 옮기거나 크기를 바꾼 영역. dx·dy 는 쪽 비율 이동량이다. 옮기기는 쪽 안에 머물고,
 * 크기 조절은 반대쪽 모서리를 고정한 채 최소 크기를 지킨다.
 */
export function adjustClipRect(rect: ProjectClipRect, handle: ClipHandle, dx: number, dy: number): ProjectClipRect {
  let [x, y, w, h] = rect;
  if (handle === 'move') {
    x = Math.min(1 - w, Math.max(0, x + dx));
    y = Math.min(1 - h, Math.max(0, y + dy));
    return [round4(x), round4(y), w, h];
  }
  let left = x;
  let top = y;
  let right = x + w;
  let bottom = y + h;
  if (handle.includes('w')) left = Math.min(right - MIN_CLIP_SIZE, Math.max(0, left + dx));
  if (handle.includes('e')) right = Math.max(left + MIN_CLIP_SIZE, Math.min(1, right + dx));
  if (handle.includes('n')) top = Math.min(bottom - MIN_CLIP_SIZE, Math.max(0, top + dy));
  if (handle.includes('s')) bottom = Math.max(top + MIN_CLIP_SIZE, Math.min(1, bottom + dy));
  x = round4(left);
  y = round4(top);
  return [x, y, round4(Math.min(1 - x, right - left)), round4(Math.min(1 - y, bottom - top))];
}

/** 두 영역이 넷째 자리까지 같은가. */
export function sameClipRect(a: readonly number[], b: readonly number[]): boolean {
  return a.length === 4 && b.length === 4 && a.every((value, index) => round4(value) === round4(b[index]!));
}

/** PDF 쪽 크기(pt) → 96dpi 원본 픽셀 크기. */
export function pdfPagePixels(widthPt: number, heightPt: number): { width: number; height: number } {
  return {
    width: Math.max(1, Math.round(widthPt * PDF_PX_PER_PT)),
    height: Math.max(1, Math.round(heightPt * PDF_PX_PER_PT)),
  };
}

/**
 * 썸네일이 긴 변 size px 에 맞도록 하는 배율. 아주 작은 영역을 지나치게 키우지 않는다.
 * 결과는 PDF 96dpi 원본 픽셀 또는 이미지 원본 픽셀 기준의 zoom 이다.
 */
export function thumbnailZoom(crop: PixelBox, size: number): number {
  return Math.min(4, size / Math.max(1, crop.width, crop.height));
}

/**
 * 썸네일 캐시 키. 같은 원본 파일(fileId 는 내용과 범위로 정해진다)·쪽·영역·크기면 같은 그림이라
 * 프로젝트가 달라도 함께 쓴다.
 */
export function clipThumbKey(input: { fileId: string; page: number; rect: readonly number[]; size: number }): string {
  return `${input.fileId}|p${input.page}|${input.rect.map((value) => round4(value).toFixed(4)).join(',')}|${input.size}`;
}

/** 새 조각의 기본 제목: "<파일> p.N 영역" (이미지는 쪽 없이). 확장자는 뺀다. */
export function defaultClipTitle(sourceTitle: string, page: number, paged: boolean): string {
  const base = sourceTitle.replace(/\.[A-Za-z0-9]{1,5}$/u, '').trim() || sourceTitle;
  return paged ? `${base} p.${page} 영역` : `${base} 영역`;
}

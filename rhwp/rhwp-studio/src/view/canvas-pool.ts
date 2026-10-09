// 크기를 0으로 비운 canvas 요소만 재사용한다. 엔진이 렌더할 때마다 canvas 크기를 다시 정하므로
// 해제한 쪽의 backing store 를 남겨 둘 이유가 없다. 긴 문서에서 쪽마다 요소가 쌓이지 않도록
// 대기 요소 수도 작게 묶는다.
const MAX_RETAINED_CANVASES = 8;

export class CanvasPool {
  private available: HTMLCanvasElement[] = [];
  private inUse = new Map<number, HTMLCanvasElement>();

  /** Canvas를 할당한다 (풀에서 꺼내거나 새로 생성) */
  acquire(pageIdx: number): HTMLCanvasElement {
    const canvas = this.available.pop() ?? document.createElement('canvas');
    this.inUse.set(pageIdx, canvas);
    return canvas;
  }

  /** CanvasKit이 software fallback canvas로 교체한 경우 pool 소유권을 넘긴다. */
  replace(pageIdx: number, current: HTMLCanvasElement, replacement: HTMLCanvasElement): void {
    if (this.inUse.get(pageIdx) !== current) {
      throw new Error(`페이지 ${pageIdx} Canvas 교체 대상이 현재 pool 항목과 다릅니다`);
    }
    current.parentElement?.removeChild(current);
    current.width = 0;
    current.height = 0;
    this.inUse.set(pageIdx, replacement);
  }

  /** Canvas를 반환한다 (DOM에서 제거하고 backing store 를 비운 뒤 풀에 반환) */
  release(pageIdx: number): void {
    const canvas = this.inUse.get(pageIdx);
    if (!canvas) return;
    canvas.parentElement?.removeChild(canvas);
    this.inUse.delete(pageIdx);
    canvas.width = 0;
    canvas.height = 0;
    if (this.available.length < MAX_RETAINED_CANVASES) this.available.push(canvas);
  }

  /** 특정 페이지에 할당된 Canvas를 조회한다 */
  getCanvas(pageIdx: number): HTMLCanvasElement | undefined {
    return this.inUse.get(pageIdx);
  }

  /** 특정 페이지가 이미 할당되어 있는지 확인한다 */
  has(pageIdx: number): boolean {
    return this.inUse.has(pageIdx);
  }

  /** 모든 Canvas를 반환한다 */
  releaseAll(): void {
    const pages = Array.from(this.inUse.keys());
    for (const pageIdx of pages) {
      this.release(pageIdx);
    }
  }

  /** 현재 사용 중인 페이지 인덱스 목록 */
  get activePages(): number[] {
    return Array.from(this.inUse.keys());
  }

  /** 사용 중 + 풀 대기 Canvas 총 수 */
  get totalCount(): number {
    return this.inUse.size + this.available.length;
  }

  /** 풀 대기 canvas가 유지하는 RGBA backing-store 바이트. */
  get retainedBackingBytes(): number {
    return this.available.reduce((sum, canvas) => sum + canvas.width * canvas.height * 4, 0);
  }
}

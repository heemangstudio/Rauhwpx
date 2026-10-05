/**
 * RHWP - HWP 파일 뷰어 TypeScript 타입 정의
 *
 * WASM 모듈에서 노출되는 API의 TypeScript 타입.
 * wasm-pack이 자동 생성하는 pkg/rhwp.d.ts를 보완하는 설계 문서.
 */

/** HWP 문서 객체 */
export class HwpDocument {
  /** HWP 파일 바이트로부터 문서를 로드한다. */
  constructor(data: Uint8Array);

  /** Load one exact host-approved local file (the approval is single use). */
  static fromTrustedLocalFileBytes(data: Uint8Array): HwpDocument;

  /** 현재 파일 정체성을 유지한 채 문서 내용만 교체한다. */
  replaceContentFromBytes(data: Uint8Array): string;

  /** 빈 문서를 생성한다 (테스트/미리보기용). */
  static createEmpty(): HwpDocument;

  /** 중첩 경로의 셀 블록을 일반 방향으로 복사한다. */
  copyTableCellRange(section: number, parent: number, path: string, startRow: number, startCol: number, endRow: number, endCol: number): string;

  /** 내부 클립보드의 셀 블록을 대상 격자에 붙여넣는다. */
  pasteTableCellRange(section: number, parent: number, path: string, startRow: number, startCol: number): string;

  /** 셀 구조와 서식을 유지하면서 블록 내용을 비운다. */
  clearTableCellRange(section: number, parent: number, path: string, startRow: number, startCol: number, endRow: number, endCol: number): string;

  /** 총 페이지 수를 반환한다. */
  pageCount(): number;

  /** 특정 페이지를 SVG 문자열로 렌더링한다. */
  renderPageSvg(pageNum: number): string;

  /** 특정 페이지를 HTML 문자열로 렌더링한다. */
  renderPageHtml(pageNum: number): string;

  /** 특정 페이지를 Canvas 명령 수로 반환한다. */
  renderPageCanvas(pageNum: number): number;

  /** 페이지 정보를 JSON 문자열로 반환한다. */
  getPageInfo(pageNum: number): string;

  /** 전체 페이지 정보를 JSON 배열 문자열로 반환한다. */
  getAllPageInfo(): string;

  /** Web Canvas 이미지 캐시 점유량을 JSON 문자열로 반환한다. */
  getWebCanvasImageCacheStats(): string;

  /** 문서 정보를 JSON 문자열로 반환한다. */
  getDocumentInfo(): string;

  /** DPI를 설정한다. 양의 유한수가 아니면 무시한다. */
  setDpi(dpi: number): void;

  /** 현재 DPI를 반환한다. */
  getDpi(): number;

  /** 메모리를 해제한다 (WASM). */
  free(): void;
}

/** HWP 뷰어 컨트롤러 (뷰포트 관리 + 렌더링 스케줄링) */
export class HwpViewer {
  /** 뷰어를 생성한다. document 소유권이 이전된다. */
  constructor(document: HwpDocument);

  /** 뷰포트를 업데이트한다 (스크롤/리사이즈 시 호출). */
  updateViewport(scrollX: number, scrollY: number, width: number, height: number): void;

  /** 줌을 설정한다 (1.0 = 100%). */
  setZoom(zoom: number): void;

  /** 현재 보이는 페이지 목록을 반환한다. */
  visiblePages(): Uint32Array;

  /** 대기 중인 렌더링 작업 수를 반환한다. */
  pendingTaskCount(): number;

  /** 총 페이지 수를 반환한다. */
  pageCount(): number;

  /** 특정 페이지를 SVG 문자열로 렌더링한다. */
  renderPageSvg(pageNum: number): string;

  /** 특정 페이지를 HTML 문자열로 렌더링한다. */
  renderPageHtml(pageNum: number): string;

  /** 메모리를 해제한다 (WASM). */
  free(): void;
}

/** 페이지 정보 (getPageInfo 반환값) */
export interface PageInfo {
  pageIndex: number;
  width: number;
  height: number;
  sectionIndex: number;
}

/** 문서 정보 (getDocumentInfo 반환값) */
export interface DocumentInfo {
  version: string;
  sectionCount: number;
  pageCount: number;
  encrypted: boolean;
}

/** WASM 모듈 초기화 */
export default function init(): Promise<void>;

/** 버전 문자열 반환 */
export function version(): string;

/** RGBA 이미지를 지정한 영역에서 목표 크기로 Hermite 축소한다. */
export function smoothHermiteDownsampleRgba(
  pixels: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  cropLeft: number,
  cropTop: number,
  cropRight: number,
  cropBottom: number,
  targetWidth: number,
  targetHeight: number,
): Uint8Array;

/** RGBA 이미지를 지정한 영역에서 목표 크기로 양선형/최근접 샘플링한다. */
export function gridfitAffineSampleRgba(
  pixels: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  cropLeft: number,
  cropTop: number,
  cropRight: number,
  cropBottom: number,
  targetWidth: number,
  targetHeight: number,
  nearest: boolean,
): Uint8Array;

/**
 * 사용자가 설치한 폰트 바이트로 레이아웃용 글자 폭 메트릭을 등록한다.
 * aliasesJson 은 폰트명 별칭 JSON 배열. 같은 별칭 + bold + italic 은 교체한다.
 * 반환 JSON: `{registered:true,key,unitsPerEm,mappedChars,coversHangul,coversLatin,replaced}`
 * 또는 `{registered:false,reason}`. 반영하려면 이후 refreshLayout 을 호출한다.
 */
export function registerRuntimeFontMetrics(
  bytes: Uint8Array,
  aliasesJson: string,
  bold: boolean,
  italic: boolean,
): string;

/** 정확한 글꼴이 없을 때 로드할 엔진 대체 후보의 JSON 배열. 호스트 등록 상태와 무관하다. */
export function fontFallbackFamilies(fontFamily: string, fontSubst?: string): string;

/** 사용자 HFT 파일의 그리기 전용 윤곽선을 등록한다. 지원하지 않는 은행이면 false. */
export function registerHftFont(bytes: Uint8Array): boolean;

/** 등록된 HFT 글리프의 SVG 경로 (1000 = 1em). 없으면 빈 문자열. */
export function hftGlyphPathEm(family: string, codePoint: number): string;

/** 등록된 런타임 폰트 메트릭을 모두 제거한다. */
export function clearRuntimeFontMetrics(): void;

/**
 * 등록된 런타임 폰트 메트릭 JSON 배열:
 * `[{aliases,bold,italic,unitsPerEm,mappedChars,coversHangul,pages,hits}]`.
 */
export function getRuntimeFontMetricsReport(): string;

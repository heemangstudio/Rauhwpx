/**
 * 사용자 PC 의 한컴 HFT 서체를 엔진의 윤곽선·원본 전진폭 소스로 등록한다.
 * 등록한 원본 라틴 폭과 윤곽선은 다음 레이아웃·렌더의 서체 선택에 반영한다.
 * 서체 바이트는 이번 세션에만 쓰고 저장하지 않는다.
 */
const MAGIC = 'Han Unified Font File 1.0\x1a';

export interface HftWasmApi {
  register(bytes: Uint8Array): boolean;
  /** SVG path (1000 = 1em, y 아래쪽 양수, 원점 = 기준점). 없으면 빈 문자열. */
  glyphPath(family: string, codePoint: number, bold?: boolean, italic?: boolean): string;
}

let api: HftWasmApi | null = null;
let apiGeneration = 0;
const pathCache = new Map<string, string | null>();
let pendingChange = false;

/** wasm 초기화 후 한 번 연결한다. 이 기능이 없는 wasm 빌드면 null 로 둔다. */
export function setHftWasmApi(next: HftWasmApi | null): void {
  api = next;
  apiGeneration += 1;
  pathCache.clear();
}

export function hftWasmApiGeneration(): number {
  return apiGeneration;
}

export function isHftBytes(bytes: ArrayBuffer | Uint8Array): boolean {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (view.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (view[i] !== MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** HFT 바이트를 등록한다. 엔진이 읽을 수 있는 은행(신명 계열 등)이면 true. */
export function registerHftOutlines(bytes: ArrayBuffer | Uint8Array): boolean {
  if (!api || !isHftBytes(bytes)) return false;
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let ok = false;
  try {
    ok = api.register(view);
  } catch (error) {
    console.warn('[HFT] 윤곽선 등록 실패:', error);
    return false;
  }
  if (ok) {
    pathCache.clear();
    pendingChange = true;
  }
  return ok;
}

/** 마지막 확인 이후 새 HFT 윤곽선이 등록됐는지 (확인하면 초기화). 다시 그려야 하는지 판단한다. */
export function takeHftOutlineChange(): boolean {
  const changed = pendingChange;
  pendingChange = false;
  return changed;
}

/** `family` HFT 서체의 글리프 윤곽선. 없으면 null. */
export function hftGlyphPath(
  family: string, codePoint: number, bold = false, italic = false,
): string | null {
  if (!api || !family) return null;
  const key = `${family}\u0000${bold ? 1 : 0}${italic ? 1 : 0}\u0000${codePoint}`;
  if (pathCache.has(key)) return pathCache.get(key)!;
  let path: string | null = null;
  try {
    path = api.glyphPath(family, codePoint, bold, italic) || null;
  } catch {
    path = null;
  }
  pathCache.set(key, path);
  return path;
}

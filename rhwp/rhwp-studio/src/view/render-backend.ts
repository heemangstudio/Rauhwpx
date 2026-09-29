import type { LayerRenderProfile, PageInfo } from '@/core/types';

export type RenderBackend = 'canvas2d' | 'canvaskit';
export type RenderBackendPreference = 'auto' | RenderBackend;
export type CanvasKitRenderMode = 'default' | 'compat';
export type CanvasKitRenderModeUnsupportedReason = 'unsupportedCanvasKitMode';
export type CanvasKitRenderModeRequestSource = 'default' | 'storage' | 'url';
export type CanvasKitSurfacePreference = 'auto' | 'webgpu' | 'webgl' | 'software';
export type CanvasKitSurfaceUnsupportedReason = 'unsupportedSurfaceBackend';
export type RenderBackendUnsupportedReason = 'unsupportedRenderBackend';
export type RenderBackendFallbackReason =
  | RenderBackendUnsupportedReason
  | 'canvaskitDocumentIneligible'
  | 'canvaskitDocumentPreflightIncomplete'
  | 'canvaskitRevisionInvalidated'
  | 'canvaskitInitializationFailed'
  | 'canvaskitResourcePreparationFailed'
  | 'canvaskitRuntimeFailed';
export type RenderBackendRequestSource = 'default' | 'url';

export interface CanvasKitSurfaceRequest {
  preference: CanvasKitSurfacePreference;
  requested: string;
  unsupportedReason?: CanvasKitSurfaceUnsupportedReason;
}

export interface CanvasKitRenderModeRequest {
  mode: CanvasKitRenderMode;
  source: CanvasKitRenderModeRequestSource;
  requested?: string;
  unsupportedReason?: CanvasKitRenderModeUnsupportedReason;
}

export interface RenderBackendRequest {
  backend: RenderBackendPreference;
  source: RenderBackendRequestSource;
  requested?: string;
  unsupportedReason?: RenderBackendUnsupportedReason;
}

export type { LayerRenderProfile } from '@/core/types';

export const DEFAULT_CANVASKIT_SURFACE_REQUEST: CanvasKitSurfaceRequest = {
  preference: 'auto',
  requested: 'auto',
};

const CANVASKIT_MODE_STORAGE_KEY = 'rhwp.canvaskitMode';
const RENDER_PROFILE_STORAGE_KEY = 'rhwp.renderProfile';

function readStorage(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage can be unavailable in private contexts */
  }
}

function searchParam(search: string, ...keys: string[]): string | null {
  const params = new URLSearchParams(search);
  for (const key of keys) {
    const value = params.get(key);
    if (value !== null) return value;
  }
  return null;
}

export function resolveRenderBackend(search = ''): RenderBackendPreference {
  return resolveRenderBackendRequest(search).backend;
}

export function resolveRenderBackendRequest(search = ''): RenderBackendRequest {
  const explicit = searchParam(search, 'renderer', 'renderBackend', 'backend');
  const normalized = explicit?.trim().toLowerCase();
  if (!normalized) return { backend: 'canvas2d', source: 'default' };
  if (normalized === 'auto') {
    return { backend: 'auto', source: 'url', requested: normalized };
  }
  if (normalized === 'canvaskit' || normalized === 'skia') {
    return { backend: 'canvaskit', source: 'url', requested: normalized };
  }
  if (normalized === 'canvas' || normalized === 'canvas2d' || normalized === 'legacy') {
    return { backend: 'canvas2d', source: 'url', requested: normalized };
  }
  return {
    backend: 'canvas2d',
    source: 'url',
    requested: explicit ?? normalized,
    unsupportedReason: 'unsupportedRenderBackend',
  };
}

export function resolveCanvasKitRenderMode(search = ''): CanvasKitRenderMode {
  return resolveCanvasKitRenderModeRequest(search).mode;
}

export function resolveCanvasKitRenderModeRequest(search = ''): CanvasKitRenderModeRequest {
  const explicit = searchParam(search, 'canvaskitMode', 'skiaMode');
  const stored = explicit === null ? readStorage(CANVASKIT_MODE_STORAGE_KEY) : null;
  const requested = explicit ?? stored;
  const normalized = requested?.trim().toLowerCase();
  const source = explicit !== null ? 'url' : stored !== null ? 'storage' : 'default';
  if (!normalized) return { mode: 'default', source: 'default' };
  if (normalized === 'compat' || normalized === 'compatibility') {
    return { mode: 'compat', source, requested: normalized };
  }
  if (normalized === 'default' || normalized === 'direct') {
    return { mode: 'default', source, requested: normalized };
  }
  return {
    mode: 'default',
    source,
    requested: requested ?? normalized,
    unsupportedReason: 'unsupportedCanvasKitMode',
  };
}

export function persistCanvasKitRenderMode(value: CanvasKitRenderMode): void {
  writeStorage(CANVASKIT_MODE_STORAGE_KEY, value);
}

export function resolveCanvasKitSurfaceRequest(search = ''): CanvasKitSurfaceRequest {
  const requested = searchParam(search, 'canvaskitSurface', 'skiaSurface')?.trim().toLowerCase() ?? 'auto';
  if (requested === 'auto' || requested === 'webgpu' || requested === 'webgl' || requested === 'software') {
    return { preference: requested, requested };
  }
  if (requested === 'gpu') return { preference: 'webgl', requested };
  if (requested === 'sw' || requested === 'cpu') return { preference: 'software', requested };
  return {
    preference: 'auto',
    requested,
    unsupportedReason: 'unsupportedSurfaceBackend',
  };
}

export function resolveRenderProfile(search = ''): LayerRenderProfile {
  const explicit = searchParam(search, 'renderProfile', 'profile') ?? readStorage(RENDER_PROFILE_STORAGE_KEY);
  const normalized = explicit?.trim().toLowerCase();
  if (normalized === 'fast' || normalized === 'fast-preview' || normalized === 'fastpreview') return 'fastPreview';
  if (normalized === 'print') return 'print';
  if (normalized === 'high' || normalized === 'high-quality' || normalized === 'highquality') return 'highQuality';
  return 'screen';
}

export function persistRenderProfile(value: LayerRenderProfile): void {
  writeStorage(RENDER_PROFILE_STORAGE_KEY, value);
}

// 엔진 canvas 한도의 미러 — src/wasm_api.rs normalize_canvas_scale 이 같은 값으로 배율을
// 다시 자르고 canvas 크기를 직접 정한다. 값을 바꾸면 양쪽을 함께 고친다.
export const MIN_RENDER_SCALE = 0.25;
export const MAX_RENDER_SCALE = 12;
export const MAX_CANVAS_DIMENSION = 16_384;
/** iOS/WebKit과 GPU surface가 감당할 물리 픽셀 수 상한 (Studio 정책). */
export const MAX_RENDER_PIXELS = 67_108_864;

/**
 * 쪽 canvas 물리 배율을 정한다. 엔진이 요청 배율을 [0.25, 12]와 한 변 16384px로 다시
 * 자르므로 여기서 같은 규칙을 먼저 적용해, CanvasView 가 쓰는 dpr(= 배율 / zoom)이
 * 실제 비트맵과 늘 맞게 한다. 결과는 엔진 정규화를 다시 거쳐도 바뀌지 않는다.
 */
export function clampRenderScale(pageInfo: PageInfo, requestedScale: number): number {
  const requested = Number.isFinite(requestedScale) && requestedScale > 0 ? requestedScale : 1;
  let scale = Math.min(MAX_RENDER_SCALE, Math.max(MIN_RENDER_SCALE, requested));
  const { width, height } = pageInfo;
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    return scale;
  }
  // 면적 한도는 배율을 낮추기만 한다 (1배 미만으로는 내리지 않는다).
  scale = Math.min(scale, Math.max(1, Math.sqrt(MAX_RENDER_PIXELS / (width * height))));
  return Math.min(scale, MAX_CANVAS_DIMENSION / width, MAX_CANVAS_DIMENSION / height);
}

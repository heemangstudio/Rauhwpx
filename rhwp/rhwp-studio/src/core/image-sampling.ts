export type ImageDownsampleApi = (
  pixels: Uint8Array, sourceWidth: number, sourceHeight: number,
  left: number, top: number, right: number, bottom: number,
  width: number, height: number,
) => Uint8Array;

export type ImageAffineSampleApi = (
  ...args: [...Parameters<ImageDownsampleApi>, nearest: boolean]
) => Uint8Array;

let downsample: ImageDownsampleApi | null = null;
let affineSample: ImageAffineSampleApi | null = null;
let generation = 0;

/** 네이티브와 같은 RGBA 축소 경로를 WASM 초기화 때 연결한다. */
export function setImageDownsampleApi(next: ImageDownsampleApi | null): void {
  downsample = next;
  generation += 1;
}

export function setImageAffineSampleApi(next: ImageAffineSampleApi | null): void {
  affineSample = next;
  generation += 1;
}

export function imageDownsampleApiGeneration(): number {
  return generation;
}

export function imageDownsampleAvailable(): boolean {
  return downsample !== null;
}

export function imageAffineSampleAvailable(): boolean {
  return affineSample !== null;
}

export function downsampleImage(...args: Parameters<ImageDownsampleApi>): Uint8Array | null {
  return sampleImage(downsample, args);
}

export function affineSampleImage(...args: Parameters<ImageAffineSampleApi>): Uint8Array | null {
  return sampleImage(affineSample, args);
}

function sampleImage<A extends Parameters<ImageDownsampleApi> | Parameters<ImageAffineSampleApi>>(
  api: ((...args: A) => Uint8Array) | null, args: A,
): Uint8Array | null {
  if (!api) return null;
  try {
    const result = api(...args);
    return result instanceof Uint8Array && result.length === args[7] * args[8] * 4 ? result : null;
  } catch {
    return null;
  }
}

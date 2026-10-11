/**
 * 영역 조각 썸네일. 허브에는 그림을 두지 않고 원본(PDF·이미지)에서 바로 그린다.
 *
 * - 화면에 들어온 썸네일만 그리고, 한 번에 둘까지만 그린다.
 * - 메모리(주소)와 IndexedDB(JPEG)에 둔다. 키는 원본 fileId·쪽·영역·크기라 다시 그릴 일이 드물다.
 * - PDF 는 pdf-render.ts 의 문서 캐시를 함께 써서, 같은 파일의 조각 여럿이 한 번만 연다.
 */
import './clip-thumbs.css';
import { clipThumbKey, rectToPixelBox, thumbnailZoom } from '../../../agent/clip-geometry.ts';
import { createCanvas, encodeCanvas, planImageCrop } from '../../../agent/image-crop.ts';
import { renderPdfRegion, withPdf } from '../../../agent/pdf-render.ts';
import type { ProjectClipItem, ProjectFileItem, ProjectSnapshot } from '../../../agent/types.ts';
import { el, projectIcon } from './project-ui.ts';

export type ClipThumbSize = 'card' | 'chip' | 'node';

/** 긴 변 픽셀 (화면 크기 × 2). */
const SIZE_PX: Record<ClipThumbSize, number> = { card: 360, chip: 72, node: 144 };
const MAX_MEMORY = 400;
const MAX_STORED = 600;
const PARALLEL = 2;
const DB_NAME = 'rhwp-clip-thumbs';
const STORE = 'thumbs';

export type ProjectFileLoader = (projectId: string, itemId: string) => Promise<Blob>;

export interface ClipThumbRequest {
  projectId: string;
  clip: ProjectClipItem;
  source: ProjectFileItem;
  size: ClipThumbSize;
  load: ProjectFileLoader;
}

const memory = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
const waiting: Array<() => void> = [];
let running = 0;

function keyOf(request: Pick<ClipThumbRequest, 'clip' | 'source' | 'size'>): string {
  return clipThumbKey({ fileId: request.source.fileId, page: request.clip.page, rect: request.clip.rect, size: SIZE_PX[request.size] });
}

function remember(key: string, url: string): void {
  memory.delete(key);
  memory.set(key, url);
  while (memory.size > MAX_MEMORY) {
    const oldest = memory.keys().next().value as string;
    URL.revokeObjectURL(memory.get(oldest)!);
    memory.delete(oldest);
  }
}

/* ── IndexedDB ──────────────────────────────────────────── */

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('IndexedDB unavailable'));
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(STORE);
      store.createIndex('at', 'at');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
  }).catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

async function readStored(key: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise<Blob | null>((resolve) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve((request.result as { blob?: Blob } | undefined)?.blob ?? null);
      request.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

let writesSincePrune = 0;

async function store(key: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb();
    const transaction = db.transaction(STORE, 'readwrite');
    const objects = transaction.objectStore(STORE);
    objects.put({ blob, at: Date.now() }, key);
    writesSincePrune += 1;
    if (writesSincePrune >= 50) {
      writesSincePrune = 0;
      // 오래된 것부터 지워 상한을 지킨다.
      const count = objects.count();
      count.onsuccess = () => {
        let extra = count.result - MAX_STORED;
        if (extra <= 0) return;
        const cursor = objects.index('at').openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row || extra <= 0) return;
          row.delete();
          extra -= 1;
          row.continue();
        };
      };
    }
  } catch {
    // 저장소가 없거나 가득 차도 썸네일은 메모리로 보인다.
  }
}

/* ── 그리기 ─────────────────────────────────────────────── */

async function withSlot<T>(task: () => Promise<T>): Promise<T> {
  if (running >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

async function renderBlob(request: ClipThumbRequest): Promise<Blob> {
  const fit = SIZE_PX[request.size];
  const { clip, source, projectId, load } = request;
  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (source.fileKind === 'pdf') {
    const region = await withPdf(
      source.fileId,
      async () => new Uint8Array(await (await load(projectId, source.id)).arrayBuffer()),
      (doc) => renderPdfRegion(doc, { page: clip.page, rect: clip.rect, fit }),
    );
    canvas = region.canvas;
  } else {
    const bitmap = await createImageBitmap(await load(projectId, source.id));
    try {
      const box = rectToPixelBox(clip.rect, bitmap.width, bitmap.height);
      const plan = planImageCrop(bitmap.width, bitmap.height, box, thumbnailZoom(box, fit));
      canvas = createCanvas(plan.outWidth, plan.outHeight);
      const context = canvas.getContext('2d') as CanvasRenderingContext2D | null;
      if (!context) throw new Error('Canvas 2D context is unavailable');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, plan.outWidth, plan.outHeight);
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, plan.crop.x, plan.crop.y, plan.crop.width, plan.crop.height, 0, 0, plan.outWidth, plan.outHeight);
    } finally {
      bitmap.close();
    }
  }
  try {
    const bytes = await encodeCanvas(canvas, 'image/jpeg');
    return new Blob([bytes as BlobPart], { type: 'image/jpeg' });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** 이미 그린 썸네일 주소. 없으면 null. */
export function cachedClipThumbUrl(request: Pick<ClipThumbRequest, 'clip' | 'source' | 'size'>): string | null {
  return memory.get(keyOf(request)) ?? null;
}

/** 썸네일 주소. 메모리 → IndexedDB → 새로 그리기 순으로 찾는다. */
export function clipThumbUrl(request: ClipThumbRequest): Promise<string> {
  const key = keyOf(request);
  const known = memory.get(key);
  if (known) return Promise.resolve(known);
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = (async () => {
    let blob = await readStored(key);
    if (!blob) {
      blob = await withSlot(() => renderBlob(request));
      void store(key, blob);
    }
    const url = URL.createObjectURL(blob);
    remember(key, url);
    return url;
  })().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/* ── 요소 ───────────────────────────────────────────────── */

const pendingElements = new WeakMap<Element, () => void>();
let observer: IntersectionObserver | null = null;

function visibilityObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer!.unobserve(entry.target);
      pendingElements.get(entry.target)?.();
      pendingElements.delete(entry.target);
    }
  }, { rootMargin: '240px' });
  return observer;
}

/**
 * 썸네일 칸. 그린 적이 있으면 바로 채우고, 아니면 화면에 들어올 때 그린다.
 * 실패하면 영역 아이콘을 둔다.
 */
export function clipThumbElement(request: ClipThumbRequest, className = ''): HTMLElement {
  const frame = el('span', className ? `ag-clip-thumb ${className}` : 'ag-clip-thumb');
  frame.setAttribute('aria-hidden', 'true');
  // 그리기 전에는 A4 쪽(이미지는 4:3)으로 어림한 비율을 두어 자리가 덜 흔들리게 한다.
  const [, , w, h] = request.clip.rect;
  frame.style.setProperty('--ag-clip-aspect', String((w / h) * (request.source.fileKind === 'pdf' ? 210 / 297 : 4 / 3)));
  const image = el('img');
  image.alt = '';
  image.decoding = 'async';
  image.draggable = false;
  image.addEventListener('load', () => {
    if (image.naturalWidth && image.naturalHeight) {
      frame.style.setProperty('--ag-clip-aspect', String(image.naturalWidth / image.naturalHeight));
    }
  });
  const show = (url: string) => {
    image.src = url;
    frame.dataset.state = 'ready';
    if (!image.isConnected) frame.replaceChildren(image);
  };
  const fail = () => {
    frame.dataset.state = 'failed';
    frame.replaceChildren(projectIcon('clip'));
  };
  const cached = cachedClipThumbUrl(request);
  if (cached) {
    show(cached);
    return frame;
  }
  frame.dataset.state = 'loading';
  pendingElements.set(frame, () => {
    clipThumbUrl(request).then(show, fail);
  });
  visibilityObserver().observe(frame);
  return frame;
}

/** 스냅샷에서 조각의 원본을 찾아 썸네일 칸을 만든다. 원본이 없거나 받을 수 없으면 null. */
export function projectClipThumb(
  project: ProjectSnapshot,
  clip: ProjectClipItem,
  size: ClipThumbSize,
  load: ProjectFileLoader | null | undefined,
  className = '',
): HTMLElement | null {
  const source = project.items.find((item) => item.id === clip.sourceId);
  if (!load || !source || source.kind !== 'file') return null;
  return clipThumbElement({ projectId: project.id, clip, source, size, load }, className);
}

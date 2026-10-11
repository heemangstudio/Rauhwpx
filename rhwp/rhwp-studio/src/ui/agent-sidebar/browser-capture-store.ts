import type { BrowserFrame, BrowserTab } from '../../agent/types.ts';

export interface BrowserCaptureDestination { threadId: string; projectId: string | null; documentId: string | null; label?: string }
export interface BrowserCaptureDraft {
  kind: 'browser';
  id: string;
  createdAt: string;
  destination: BrowserCaptureDestination;
  comment: string;
  label: string;
  source: { tabId: string; url: string; title: string; navigationEpoch: number; frameId: string | null; viewport: { width: number; height: number; deviceScaleFactor: number; scrollX: number; scrollY: number } | null };
  mode: 'page' | 'element' | 'region';
  evidence: Record<string, unknown>;
  screenshotError?: string;
  files: File[];
}
function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('rhwp-browser-captures', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: 'id' }).createIndex('threadId', 'destination.threadId');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, set: (value: T) => void) => void): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', mode); let result: T;
    tx.oncomplete = () => { db.close(); resolve(result); }; tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    run(tx.objectStore('drafts'), (value) => { result = value; });
  });
}
export function listBrowserCaptureDrafts(threadId: string): Promise<BrowserCaptureDraft[]> {
  return transaction('readonly', (store, set) => { const request = store.index('threadId').getAll(threadId); request.onsuccess = () => set(request.result); });
}
export function removeBrowserCaptureDrafts(ids: string[]): Promise<void> {
  return transaction('readwrite', (store, set) => { for (const id of ids) store.delete(id); set(undefined); });
}
export async function saveBrowserCaptureDraft(args: {
  destination: BrowserCaptureDestination; tab: BrowserTab; frame: BrowserFrame | null;
  mode: BrowserCaptureDraft['mode']; comment: string; evidence: Record<string, unknown>; screenshotError?: string;
}): Promise<BrowserCaptureDraft> {
  const id = globalThis.crypto?.randomUUID?.() ?? `browser-${Date.now()}-${Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('')}`;
  let sourceUrl = args.tab.url; try { const url = new URL(sourceUrl); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; sourceUrl = url.href; } catch { sourceUrl = ''; }
  const source = { tabId: args.tab.tabId, url: sourceUrl, title: args.tab.title, navigationEpoch: args.tab.navigationEpoch,
    frameId: args.frame?.frameId ?? null, viewport: args.frame ? { width: args.frame.width, height: args.frame.height,
      deviceScaleFactor: args.frame.deviceScaleFactor, scrollX: args.frame.scrollX, scrollY: args.frame.scrollY } : null };
  const files: File[] = [];
  const image = (args.evidence.screenshot ?? args.evidence.image) as { data?: string; mimeType?: string } | undefined;
  if (image?.data && image.data.length <= 16 * 1024 * 1024) {
    const binary = atob(image.data.replace(/^data:[^,]+,/, '')); const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const mime = image.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
    files.push(new File([bytes], `browser-${id}.${mime === 'image/png' ? 'png' : 'jpg'}`, { type: mime }));
  }
  const evidence = { ...args.evidence }; delete evidence.screenshot; delete evidence.image;
  const record = { schemaVersion: 1, kind: 'browser' as const, id, createdAt: new Date().toISOString(), destination: { ...args.destination },
    comment: args.comment, label: args.tab.title || '브라우저 자료', source, mode: args.mode, evidence, screenshotError: args.screenshotError };
  files.push(new File([JSON.stringify(record, null, 2)], `browser-${id}.json`, { type: 'application/json' }));
  const draft: BrowserCaptureDraft = { ...record, files };
  const existing = await listBrowserCaptureDrafts(args.destination.threadId);
  if (existing.length >= 20) throw new Error('저장한 브라우저 자료가 20개입니다. 일부를 보내거나 지워 주세요.');
  await transaction<void>('readwrite', (store, set) => { store.add(draft); set(undefined); });
  return draft;
}

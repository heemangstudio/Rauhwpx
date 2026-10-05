/// <reference lib="webworker" />
/**
 * 글꼴 폴더 색인 Worker. 폴더 탐색·SFNT 파싱·TTC 추출을 메인 스레드 밖에서 한다.
 * 읽은 face 바이트는 복사 없이 넘기고(transfer) 여기에는 남기지 않는다.
 */
import { createFontFolderIndexer } from './font-folder-index.ts';
import { indexedDbFontFolderCache } from './font-folder-store.ts';
import type { FontFolderWorkerRequest, FontFolderWorkerResponse } from './font-folder.ts';

const indexer = createFontFolderIndexer({ cache: indexedDbFontFolderCache() });
const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (event: MessageEvent<FontFolderWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'index') {
      const index = await indexer.index(request.input, { refresh: request.refresh });
      scope.postMessage({ id: request.id, ok: true, index } satisfies FontFolderWorkerResponse);
    } else {
      const bytes = await indexer.read(request.faceId);
      scope.postMessage({ id: request.id, ok: true, bytes } satisfies FontFolderWorkerResponse, [bytes.buffer]);
    }
  } catch (error) {
    scope.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies FontFolderWorkerResponse);
  }
};

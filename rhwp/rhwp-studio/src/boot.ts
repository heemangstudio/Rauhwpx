/**
 * Studio 진입점. 2.0.11 이 이름을 바꿔 남긴 저장소를 정본에 합친 뒤 편집기를 불러온다.
 * 편집기 모듈은 불러오는 순간 저장소를 읽으므로 가져오기가 그보다 먼저 끝나야 한다.
 */
import { runRebrandedStorageImport } from './core/rebrand-storage-import.ts';

void (async () => {
  try {
    await runRebrandedStorageImport();
  } catch (error) {
    console.warn('[rebrand] 2.0.11 저장소를 옮기지 못했습니다:', error);
  }
  await import('./main.ts');
})();

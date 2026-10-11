// 배포에 포함할 공식 필터 원문과 엔진 스냅샷을 함께 갱신한다.
import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { FiltersEngine } from '@ghostery/adblocker';
import { downloadFilterLists, FILTER_CONFIG, FILTER_LISTS } from '../desktop/browser-adblock-lists.mjs';

const directory = new URL('../desktop/adblock/', import.meta.url);
await mkdir(directory, { recursive: true });
const lists = await downloadFilterLists();
const engine = FiltersEngine.parse(lists.join('\n'), FILTER_CONFIG);
await writeFile(new URL('engine.bin', directory), engine.serialize());
for (let index = 0; index < lists.length; index++) {
  await writeFile(new URL(index === 0 ? 'easylist.txt.gz' : 'easyprivacy.txt.gz', directory), gzipSync(lists[index]));
}
await writeFile(new URL('metadata.json', directory), JSON.stringify({ updatedAt: new Date().toISOString(), sources: FILTER_LISTS }, null, 2) + '\n');
console.log(`브라우저 광고 차단 필터를 갱신했습니다. ${engine.serialize().length} bytes`);

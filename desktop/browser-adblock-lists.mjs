// 필터 주소는 고정한다. 페이지 주소나 사용자 데이터는 업데이트 요청에 포함하지 않는다.
export const FILTER_LISTS = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt',
];
export const FILTER_CONFIG = { enableCompression: true, loadExtendedSelectors: false };

export async function downloadFilterLists(fetcher = fetch) {
  const signal = AbortSignal.timeout(15_000);
  return Promise.all(FILTER_LISTS.map(async url => {
    const response = await fetcher(url, { signal, credentials: 'omit', redirect: 'error' });
    if (!response.ok) throw new Error('Filter download failed');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) { await response.body.cancel().catch(() => {}); throw new Error('Filter list is too large'); }
      chunks.push(Buffer.from(chunk));
    }
    const source = Buffer.concat(chunks).toString('utf8');
    if (!source.startsWith('[Adblock Plus') || source.split('\n').length < 1000) throw new Error('Filter list is invalid');
    return source;
  }));
}

/** 새 탭은 저장된 검색 엔진의 시작 페이지를 연다. */
export function browserHomepageURL(engine = 'google'): string {
  const homepages: Record<string, string> = { duckduckgo: 'https://duckduckgo.com/', google: 'https://www.google.com/', bing: 'https://www.bing.com/', naver: 'https://www.naver.com/' };
  return homepages[engine] ?? homepages.google;
}

/** 주소 입력과 검색어를 구분하고 저장된 검색 엔진을 적용한다. */
export function browserAddressURL(input: string, engine = 'google'): string {
  const value = input.trim();
  if (/^https?:\/\//i.test(value) || value === 'about:blank') return value;
  if (/^(?:localhost|[\w.-]+\.[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]|$)/i.test(value)) return `https://${value}`;
  const endpoints: Record<string, string> = { duckduckgo: 'https://duckduckgo.com/?q=', google: 'https://www.google.com/search?q=', bing: 'https://www.bing.com/search?q=', naver: 'https://search.naver.com/search.naver?query=' };
  return (endpoints[engine] ?? endpoints.google) + encodeURIComponent(value);
}

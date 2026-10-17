import { parse as parseDomain } from 'tldts';

/**
 * 허브 browser-policy.mjs siteScope 와 같은 사이트 범위. HTTPS 이고 공개 접미사 목록(사설 접미사 포함)에 있는
 * 등록 도메인이면 그 도메인 전체(key https://coupang.com, domain coupang.com)다. IP·localhost·알 수 없는 접미사·HTTP 는
 * 정확한 출처만 덮는다(domain null).
 */
export function siteScope(value) {
  const url = new URL(String(value));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP or HTTPS website origins are supported.');
  const origin = url.origin;
  if (url.protocol !== 'https:') return { origin, key: origin, domain: null };
  const parsed = parseDomain(url.hostname, { allowPrivateDomains: true });
  if (parsed.isIp || !parsed.domain || !(parsed.isIcann || parsed.isPrivate)) return { origin, key: origin, domain: null };
  return { origin, key: `https://${parsed.domain}${url.port ? `:${url.port}` : ''}`, domain: parsed.domain };
}

/** 두 출처가 같은 사이트인가 — 같은 출처이거나 같은 등록 도메인(HTTPS)이다. */
export function sameSite(left, right) {
  try {
    const a = siteScope(left); const b = siteScope(right);
    return a.origin === b.origin || (!!a.domain && a.key === b.key);
  } catch { return false; }
}

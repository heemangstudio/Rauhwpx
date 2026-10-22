// 에이전트가 페이지를 읽고 인용하는 데 쓰는 순수 도우미. 브라우저 서비스가 페이지에서 뽑은 값을 다듬는다.
import { sameSite } from './browser-policy.mjs';

// 추적·광고 매개변수. 인용 주소에서 뺀다.
const TRACKING = /^(?:utm_[a-z0-9_]*|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|mc_cid|mc_eid|igshid|igsh|_ga|_gl|_hsenc|_hsmi|mkt_tok|ref_src|ref_url|spm|scm|vero_id|oly_anon_id|oly_enc_id|rb_clickid|s_cid|trk|trkCampaign|sc_campaign|sc_channel|cmpid|ncid|ocid|xtor|__twitter_impression|fb_action_ids|fb_action_types|fb_source|share|shared)$/i;
// 서명·인증 값. 주소에 남으면 다른 사람이 그 권한으로 열 수 있다.
const SECRET = /^(?:x-amz-[a-z-]*|x-goog-[a-z-]*|signature|sig|sign|signed|token|access_token|id_token|refresh_token|auth|authorization|apikey|api_key|key|secret|session|sessionid|sid|jsessionid|phpsessid|state|nonce|password|passwd|pwd|otp|expires|policy|key-pair-id|skoid|sktid|ticket|hmac|hash|jwt)$/i;
// 이름과 상관없이 긴 불투명 값(서명·세션)은 뺀다.
const OPAQUE = /^[A-Za-z0-9+/_=.%-]{40,}$/;

/** 인용용 주소: 계정 정보·조각·추적 매개변수·서명 값을 뺀 http(s) 주소. 웹 주소가 아니면 null. */
export function citationURL(value) {
  let url;
  try { url = new URL(String(value)); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  url.username = ''; url.password = ''; url.hash = '';
  for (const [name, setting] of [...url.searchParams]) {
    if (TRACKING.test(name) || SECRET.test(name) || OPAQUE.test(setting)) url.searchParams.delete(name);
  }
  if (![...url.searchParams].length) url.search = '';
  return url.href;
}

/** 페이지가 밝힌 대표 주소는 같은 사이트일 때만 믿는다. 다른 사이트를 가리키면 지금 주소를 쓴다. */
export function canonicalCitationURL(pageUrl, declared) {
  const page = citationURL(pageUrl);
  if (!declared) return page;
  let absolute;
  try { absolute = new URL(declared, pageUrl).href; } catch { return page; }
  const canonical = citationURL(absolute);
  return canonical && page && sameSite(canonical, page) ? canonical : page;
}

export const squash = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
const clip = (value, max) => { const line = squash(value); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

/** 날짜 문자열을 YYYY-MM-DD 로 줄인다. 읽을 수 없으면 null. */
export function isoDate(value) {
  const raw = squash(value);
  if (!raw) return null;
  const plain = raw.match(/^(\d{4})[-./년\s]+(\d{1,2})[-./월\s]+(\d{1,2})/);
  if (plain) {
    const [, y, m, d] = plain.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  const year = new Date(parsed).getUTCFullYear();
  return year >= 1990 && year <= 2200 ? new Date(parsed).toISOString().slice(0, 10) : null;
}

/** 페이지 안에서 실행한다. 인용에 필요한 메타 정보(대표 주소, 제목, 사이트, 날짜, 저자)를 모은다. */
export function pageCitationMetadata() {
  const meta = (selector) => document.querySelector(selector)?.getAttribute('content')?.trim() || '';
  const nodes = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const visit = (value) => { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') { nodes.push(value); if (value['@graph']) visit(value['@graph']); } };
      visit(JSON.parse(script.textContent ?? ''));
    } catch {}
    if (nodes.length > 50) break;
  }
  const article = nodes.find((node) => /Article|Posting|Report|WebPage|BlogPosting/i.test(String(node['@type'] ?? ''))) ?? nodes[0] ?? {};
  const nameOf = (value) => (Array.isArray(value) ? value.map(nameOf).filter(Boolean).join(', ') : typeof value === 'string' ? value : value?.name ?? '');
  const time = document.querySelector('article time[datetime], main time[datetime], time[datetime]');
  return {
    canonical: document.querySelector('link[rel~="canonical" i]')?.getAttribute('href') || meta('meta[property="og:url"]'),
    title: meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || String(article.headline ?? '') || document.title,
    siteName: meta('meta[property="og:site_name"]') || meta('meta[name="application-name"]') || nameOf(article.publisher),
    published: meta('meta[property="article:published_time"]') || String(article.datePublished ?? '') || meta('meta[name="citation_publication_date"]')
      || meta('meta[name="pubdate"]') || meta('meta[name="publishdate"]') || meta('meta[name="date"]') || meta('meta[name="dc.date"]') || meta('meta[name="DC.date.issued"]')
      || meta('meta[itemprop="datePublished"]') || document.querySelector('[itemprop="datePublished"]')?.getAttribute('datetime') || time?.getAttribute('datetime') || '',
    modified: meta('meta[property="article:modified_time"]') || String(article.dateModified ?? ''),
    author: meta('meta[name="author"]') || meta('meta[property="article:author"]') || nameOf(article.author),
    lang: document.documentElement.lang || '',
  };
}

/** 페이지 메타 정보와 인용문으로 인용 기록을 만든다. accessed 는 오늘(지역 날짜)이다. */
export function citationRecord({ quote, pageUrl, pageTitle, metadata = {}, now = new Date() }) {
  const url = canonicalCitationURL(pageUrl, metadata.canonical);
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
  const title = clip(metadata.title || pageTitle || host, 300);
  const siteName = clip(metadata.siteName || host, 120);
  const published = isoDate(metadata.published);
  const accessed = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const author = clip(metadata.author, 160);
  // 각주 한 줄: 저자, 「제목」, 사이트, 게시일. 주소 (접속일)
  const footnote = [author, `「${title}」`, siteName && siteName !== title ? siteName : '', published ?? ''].filter(Boolean).join(', ') + `. ${url} (${accessed} 접속)`;
  return { quote, title, url, siteName, ...(author ? { author } : {}), ...(published ? { published } : {}), accessed, ...(metadata.lang ? { lang: clip(metadata.lang, 20) } : {}), footnote };
}

/** 페이지 안에서 실행한다. 본문(article·main)을 우선 읽고, 짧으면 body 전체를 읽는다. */
export function pageReadableText() {
  const pick = [document.querySelector('article'), document.querySelector('main'), document.querySelector('[role="main"]')].find((el) => el && (el.innerText ?? '').trim().length >= 200);
  return { text: (pick ?? document.body)?.innerText ?? '', title: document.title };
}

/** 읽은 글을 줄 단위로 정리하고 한도에 맞춘다. find 가 있으면 그 글이 든 줄만 남긴다. */
export function compactText(raw, { find, maxChars = 3000 } = {}) {
  const lines = [];
  let previous;
  for (const line of String(raw ?? '').split('\n')) {
    const tidy = squash(line);
    if (!tidy || tidy === previous) continue;
    lines.push(tidy); previous = tidy;
  }
  const needle = find ? squash(find).toLowerCase() : '';
  const chosen = needle ? lines.filter((line) => line.toLowerCase().includes(needle)) : lines;
  let text = ''; let truncated = false;
  for (const line of chosen) {
    if (text.length + line.length + 1 > maxChars) { truncated = true; const room = maxChars - text.length - 1; if (room > 40) text += `${text ? '\n' : ''}${line.slice(0, room - 1)}…`; break; }
    text += `${text ? '\n' : ''}${line}`;
  }
  return { text, truncated, ...(needle ? { matches: chosen.length } : {}) };
}

/** 같은 길이로 가린다. 찾기의 위치가 바뀌지 않게 한다. */
export function maskSameLength(value, secrets) {
  let out = String(value ?? '');
  for (const secret of secrets ?? []) if (secret) out = out.split(secret).join('•'.repeat(secret.length));
  return out;
}

/** 텍스트에서 needle(대소문자 무시)이 나오는 위치와 앞뒤 문맥을 찾는다. */
export function findMatches(haystack, needle, { limit = 20, context = 40 } = {}) {
  const query = String(needle ?? '').toLowerCase();
  const lower = String(haystack ?? '').toLowerCase();
  const offsets = [];
  if (!query) return { count: 0, matches: [] };
  for (let at = lower.indexOf(query); at >= 0; at = lower.indexOf(query, at + query.length)) offsets.push(at);
  const matches = offsets.slice(0, limit).map((at, index) => {
    const start = Math.max(0, at - context), end = Math.min(haystack.length, at + query.length + context);
    return { index: index + 1, text: `${start > 0 ? '…' : ''}${squash(haystack.slice(start, end))}${end < haystack.length ? '…' : ''}` };
  });
  return { count: offsets.length, offsets, matches };
}

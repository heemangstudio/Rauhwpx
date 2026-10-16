/** Real public-site tasks. Checkers require browser evidence as well as an answer.
 * Read-only Chromium probes: 2026-10-16, /tmp/browser-agent-{site,interaction}-probes.json.
 * External content and consent UI vary; missing interaction evidence fails validation; observed access challenges are blocked.
 */
const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const decoded = value => { try { return decodeURI(String(value ?? '')); } catch { return String(value ?? ''); } };
const hasUrl = (row, pattern) => pattern.test(decoded(row?.url));
const body = row => text(row?.text);
const result = (checks, blocked = false) => ({ passed: checks.every(c => c.ok), blocked: checks.some(c => !c.ok) && blocked, details: checks });
const test = (name, ok) => ({ name, ok: Boolean(ok) });
const siteBlocked = c => c.tabs.some(t => t.challenge?.kind === 'captcha' || t.challenge?.type === 'captcha' || t.challenge?.code === 'BROWSER_ACCESS_CHALLENGE') || c.snapshots.some(s => /(?:access denied|verify you are human|unusual traffic|robot check|captcha challenge|403 forbidden)/i.test(body(s)));

function failedReceipt(value, depth = 0, verifiedAttachment = false) {
  if (!value || depth > 12) return false;
  if (typeof value === 'string') {
    // Claude SDK can replace a successful oversized tool result with this exact
    // notice. Only a suite-verified full attachment for this call can vouch for it.
    if (verifiedAttachment && /^Error: result \([\d,]+ characters across \d+ lines?\) exceeds maximum allowed tokens\. Output has been saved to \/tmp\/[^\r\n]+\/tool-results\/[^\r\n]+\.txt\.\r?\nFormat: Plain text(?:\r?\n|$)/.test(value)) return false;
    try { return failedReceipt(JSON.parse(value), depth + 1, verifiedAttachment); } catch { return /^(?:Error:|BROWSER_[A-Z_]+:)/.test(value); }
  }
  if (Array.isArray(value)) return value.some(item => failedReceipt(item, depth + 1, verifiedAttachment));
  if (value.ok === false || value.isError === true || value.is_error === true) return true;
  if (value.type === 'text' && failedReceipt(value.text, depth + 1, verifiedAttachment)) return true;
  return ['resultPreview', 'result', 'content', 'structuredContent', 'tool_use_result'].some(key => failedReceipt(value[key], depth + 1, verifiedAttachment));
}

function context(input) {
  const verifiedAttachments = new Set(input.verifiedAttachmentCallIds ?? []);
  const receiptFailed = receipt => failedReceipt(receipt, 0, typeof receipt?.callId === 'string' && verifiedAttachments.has(receipt.callId));
  const snapshots = [...(input.snapshots ?? [])];
  // Truncated previews cannot verify DOM; parse only structured browser results.
  const collect = (value, depth = 0) => {
    if (!value || depth > 10) return;
    if (typeof value === 'string') { try { collect(JSON.parse(value), depth + 1); } catch {} return; }
    if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); return; }
    if (value.snapshotId && typeof value.url === 'string' && typeof value.text === 'string') snapshots.push(value);
    for (const key of ['resultPreview', 'snapshot', 'result', 'content']) collect(value[key], depth + 1);
    if (value.type === 'text') collect(value.text, depth + 1);
  };
  for (const item of input.toolResults ?? []) if (item?.ok === true && !receiptFailed(item)) collect(item);
  const rawCalls = (input.calls ?? []).map(call => {
    let args = call.args ?? call.arguments ?? call.argsJson ?? call.input ?? {};
    try { if (typeof args === 'string') args = JSON.parse(args); } catch { args = {}; }
    return { ...call, args, action: args.action ?? call.action ?? String(call.tool ?? call.name ?? '').match(/browser_(click|type|press|scroll|navigate|open|snapshot|downloads)$/)?.[1] ?? '' };
  });
  const calls = rawCalls.filter(call => {
    const receipts = (input.toolResults ?? []).filter(receipt => call.callId && receipt?.callId === call.callId);
    return receipts.some(receipt => receipt.ok === true) && !receipts.some(receipt => receiptFailed(receipt));
  });
  return { ...input, authoritativeSnapshots: input.currentSnapshots ?? input.snapshots ?? [], hasTabInventory: Array.isArray(input.tabs), snapshots, rawCalls, calls, rawAnswer: String(input.answer ?? ''), answer: text(input.answer), tabs: input.tabs ?? [], downloads: input.downloads ?? [], events: input.browserEvents ?? [] };
}
const acted = (c, action) => c.calls.some(call => call.action === action || String(call.tool ?? call.name ?? '').endsWith(`_${action}`));
const comparableURL = url => decoded(url).split(/[?#]/)[0].replace(/\/$/, '');
const currentSnapshots = c => {
  if (!c.hasTabInventory) return c.authoritativeSnapshots;
  const seen = new Set();
  return c.authoritativeSnapshots.filter(s => {
    if (seen.has(s.tabId) || !c.tabs.some(t => t.tabId === s.tabId && comparableURL(t.url) === comparableURL(s.url))) return false;
    seen.add(s.tabId); return true;
  });
};
const page = (c, pattern, content) => currentSnapshots(c).find(s => hasUrl(s, pattern) && (!content || content.test(body(s))));
const urls = c => [...c.events, ...c.snapshots, ...c.tabs].flatMap(e => [e, e.tab, ...(e.tabs ?? [])]).filter(Boolean);
const answerIncludes = (c, value) => c.answer.toLocaleLowerCase().includes(text(value).toLocaleLowerCase());
const pairedQuotes = (answer, min = 16) => [...answer.matchAll(/"([^"\r\n]*)"|“([^”]*)”|「([^」]*)」/g)]
  .map(match => text(match[1] ?? match[2] ?? match[3])).filter(quote => quote.length >= min && quote.length <= 400);
const literalQuotes = (answer, min = 16) => [...pairedQuotes(text(answer), min), ...String(answer ?? '').split(/\r?\n/)
  .filter(line => /^\s*>/.test(line)).map(line => text(line.replace(/^\s*>\s?/, ''))).filter(quote => quote.length >= min && quote.length <= 400)];
const unescapeAnswerPunctuation = answer => answer.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]\^_`{|}~])/g, '$1');
const quoteEvidence = (c, s, min = 16) => {
  // Require a literal source quotation, so generic or memorized answers cannot pass.
  const quotes = literalQuotes(c.rawAnswer, 8);
  return quotes.some(q => q.length >= min && body(s).includes(q));
};
const wikiPath = title => new RegExp(`^https://ko\\.wikipedia\\.org/wiki/${title}(?:[#?]|$)`);

// The knowledge panel precedes a run of website results; later modules are excluded.
// Missing panel/module boundaries leave ranking unverified rather than guessing it.
function naverWebResults(snapshot) {
  const raw = String(snapshot?.text ?? '');
  const start = raw.indexOf('관련정보');
  if (start < 0) return [];
  const lines = raw.slice(start).split(/\r?\n/).map(text);
  const end = lines.findIndex(line => /^(?:네이버 클립|뉴스|함께 많이 찾는|이미지)$/.test(line));
  if (end < 0) return [];
  const results = [];
  for (let i = 0; i < end; i++) {
    const domain = lines[i].match(/^((?:[a-z0-9-]+\.)+[a-z]{2,})(?:›|\/|$)/i)?.[1]?.replace(/^www\./, '');
    if (!domain || results.some(r => r.domain === domain)) continue;
    const title = lines.slice(i + 1, end).find(line => line && line !== '새 창 열림');
    if (title && snapshot.elements?.some(e => e.role === 'link' && text(e.name).replace(/(?:\s*새\s*창\s*열림)+$/, '') === title)) results.push({ domain, title });
  }
  return results;
}
function arxivAuthor(snapshot) {
  const authors = snapshot?.elements?.filter(e => e.role === 'link' && /^(?:https?:\/\/arxiv\.org)?\/(?:search|a)\//.test(e.href ?? ''));
  if (authors?.length) return text(authors[0].name);
  const lines = String(snapshot?.text ?? '').split(/\r?\n/).map(text).filter(Boolean);
  const labeled = lines.findIndex(line => /^Authors?:/i.test(line));
  if (labeled >= 0) return text(lines[labeled].replace(/^Authors?:\s*/i, '') || lines[labeled + 1]).split(',')[0];
  const title = text(snapshot?.title).replace(/^\[[^\]]+\]\s*/, '');
  const titleIndex = lines.findIndex(line => line.replace(/^Title:\s*/i, '') === title);
  const next = lines[titleIndex + 1];
  // Legacy arXiv renders an unlabeled, standalone comma-separated author line.
  const candidate = next?.split(',')[0];
  const authorLink = snapshot?.elements?.some(e => e.role === 'link' && text(e.name) === candidate);
  return titleIndex >= 0 && next && !/^(?:Abstract|Comments|Subjects|Submitted|Title):/i.test(next) && (next.includes(',') || authorLink) ? candidate : null;
}
const englishCountryOrder = new Intl.Collator('en', { usage: 'sort', sensitivity: 'base', numeric: false, ignorePunctuation: false });
const countryName = value => text(value).replace(/\[[^\]]*\]/g, '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim();
function populationRows(rows) {
  return rows.flatMap(row => {
    const cells = (Array.isArray(row) ? row : String(row).split('\t')).map(text);
    const countryIndex = /^\d+$/.test(cells[0]) ? 1 : 0;
    const country = countryName(cells[countryIndex]);
    const population = text(cells[countryIndex + 1]).replace(/\[[^\]]*\]/g, '').trim();
    if (!country || country === 'World' || /^(?:Location|Country|Dependency)$/i.test(country) || !/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(population)) return [];
    return [{ country, population }];
  });
}
function populationFirstRows(snapshot) {
  const lines = String(snapshot?.text ?? '').split(/\r?\n/);
  const header = lines.findIndex(line => /^(?:Location|Country.*Dependency)\tPopulation/.test(line));
  return header < 0 ? [] : populationRows(lines.slice(header + 1)).slice(0, 3);
}
function clickedElement(c, source, predicate) {
  return c.calls.some(call => call.action === 'click' && call.args.ref && (!call.args.tabId || call.args.tabId === source.tabId) && call.args.snapshotId === source.snapshotId && source.elements?.some(element => element.ref === call.args.ref && predicate(element)));
}

function boundSource(c, call, sourcePattern, predicate) {
  if (!call.args.tabId || !call.args.snapshotId || !call.args.ref) return null;
  for (const source of c.snapshots) {
    if (source.tabId !== call.args.tabId || source.snapshotId !== call.args.snapshotId || !hasUrl(source, sourcePattern)) continue;
    const element = source.elements?.find(e => e.ref === call.args.ref && predicate(e));
    if (element) return { source, element };
  }
  return null;
}
const getQueryField = (e, formPattern) => ['textbox', 'searchbox', 'combobox'].includes(e.role) && /검색|search/i.test(text(e.name)) && String(e.formMethod).toLowerCase() === 'get' && hasUrl({ url: e.formAction }, formPattern);
const fullURL = value => {
  try { const url = new URL(value); url.searchParams.sort(); return decoded(url.origin + url.pathname + url.search); } catch { return null; }
};
const producerIndex = (c, snapshot) => {
  const receipt = (c.snapshotReceipts ?? []).find(r => r.snapshotId === snapshot.snapshotId);
  return receipt ? c.calls.findIndex(call => call.callId === receipt.callId) : -1;
};
function submittedSearch(c, query, hostPattern) {
  const law = /law/.test(hostPattern.source);
  const sourcePattern = law ? /^https:\/\/(?:www\.)?law\.go\.kr\// : /^https:\/\/search\.naver\.com\/search\.naver(?:[?#]|$)/;
  const formPattern = law ? /^https:\/\/(?:www\.)?law\.go\.kr\/LSW\/lsSc\.do(?:[?#]|$)/ : sourcePattern;
  return c.calls.some((call, i) => {
    if (call.action !== 'type' || text(call.args.text ?? call.args.value) !== query) return false;
    const binding = boundSource(c, call, sourcePattern, e => getQueryField(e, formPattern));
    if (!binding) return false;
    if (call.args.submit === true) return true;
    for (const next of c.calls.slice(i + 1)) {
      if (next.args.tabId !== call.args.tabId) continue;
      if (next.action === 'type') break;
      if (next.action === 'press' && /^(?:Enter|Return)$/i.test(String(next.args.key))) {
        return !next.args.ref || Boolean(boundSource(c, next, sourcePattern, e => getQueryField(e, formPattern)));
      }
      if (next.action === 'click') return Boolean(boundSource(c, next, sourcePattern, e => /^(?:검색(?:\s+검색)*|검색하기|Search)$/i.test(text(e.name)) && String(e.formMethod).toLowerCase() === 'get' && hasUrl({ url: e.formAction }, formPattern)));
      if (next.action === 'press' && /^Tab$/i.test(String(next.args.key))) break;
    }
    return false;
  });
}



export const browserTasks = [
  {
    id: 'naver-second-result',
    urls: ['https://search.naver.com/search.naver?query=대한민국'],
    prompt: 'On this Naver search page, replace 대한민국 in the actual search box with 한글날 10월 9일 and submit the search using Enter or the search control. Then find the second distinct external website result after the Hangul Day knowledge panel, excluding advertisements, clips, blogs and news modules. Open its title link. Keep the search tab open. Report the exact result title, destination URL, and one factual sentence quoted verbatim from the destination. Take a snapshot of the search results before opening it. If ranking or access cannot be established, report the blocker.',
    check(input) {
      const c = context(input);
      c.answer = unescapeAnswerPunctuation(c.answer);
      c.rawAnswer = unescapeAnswerPunctuation(c.rawAnswer);
      const search = page(c, /^https:\/\/search\.naver\.com\//, /한글날/);
      const typed = c.calls.some(call => call.action === 'type' && text(call.args.text ?? call.args.value) === '한글날 10월 9일');
      const queryObserved = search?.elements?.some(e => ['textbox', 'searchbox', 'combobox'].includes(e.role) && text(e.value) === '한글날 10월 9일');
      const ranked = naverWebResults(search);
      const second = ranked[1];
      const destination = second && currentSnapshots(c).find(s => {
        try { return new URL(s.url).hostname.replace(/^www\./, '') === second.domain && body(s).length > 100; } catch { return false; }
      });
      return result([
        test('Actual search query was typed, submitted, and observed in the search DOM', typed && queryObserved && submittedSearch(c, '한글날 10월 9일', /search\.naver\.com/)),
        test('Second distinct website is independently ranked from domain/title pairs bounded by the knowledge panel and next module', second),
        test('Second destination has independent DOM evidence', destination && body(destination).length > 100),
        test('The ranked second title link was clicked', second && destination && c.calls.some(call => call.action === 'click' && boundSource(c, call, /^https:\/\/search\.naver\.com\/search\.naver(?:[?#]|$)/, e => e.role === 'link' && text(e.name).replace(/(?:\s*새\s*창\s*열림)+$/, '') === second.title && comparableURL(e.href) === comparableURL(destination.url)))),
        test('Answer names destination and quotes its content', destination && second && answerIncludes(c, second.title) && answerIncludes(c, destination.url) && quoteEvidence(c, destination)),
      ], siteBlocked(c));
    },
  },
  {
    id: 'law-statute-frame',
    urls: ['https://www.law.go.kr/LSW/main.html'],
    prompt: 'On the official law.go.kr homepage, type 대한민국헌법 into the current-law search box and submit its nonsensitive GET search form. Open the constitution from the results and read its statute pane/frame. Find Article 1 and quote both paragraphs exactly, with the effective date. Keep the statute page open and report any frame/access blocker if its text cannot be read.',
    check(input) {
      const c = context(input);
      const statute = page(c, /^https:\/\/(?:www\.)?law\.go\.kr\//, /대한민국은 민주공화국이다/);
      const search = c.snapshots.find(s => hasUrl(s, /^https:\/\/(?:www\.)?law\.go\.kr\/LSW\/lsSc\.do/) && s.elements?.some(e => ['textbox', 'searchbox', 'combobox'].includes(e.role) && text(e.value) === '대한민국헌법'));
      const typed = c.calls.some(call => call.action === 'type' && String(call.args.text ?? call.args.value ?? '').includes('대한민국헌법'));
      const openedResult = statute && c.calls.some((call, at) => c.snapshots.some(source => {
        if (!hasUrl(source, /^https:\/\/(?:www\.)?law\.go\.kr\/LSW\/lsSc\.do(?:[?#]|$)/)) return false;
        const links = source.elements?.filter(e => e.role === 'link' && /대한민국헌법/.test(text(e.name))) ?? [];
        if (call.action === 'click') return call.args.tabId === source.tabId && call.args.snapshotId === source.snapshotId && links.some(e => e.ref === call.args.ref);
        return producerIndex(c, source) >= 0 && producerIndex(c, source) < at && ['open', 'navigate'].includes(call.action) && /^https:\/\/(?:www\.)?law\.go\.kr\//.test(String(call.args.url)) && links.some(e => fullURL(e.href) && fullURL(e.href) === fullURL(call.args.url));
      }));
      const clauses = ['대한민국은 민주공화국이다', '대한민국의 주권은 국민에게 있고, 모든 권력은 국민으로부터 나온다'];
      return result([
        test('Genuine search form input and results were observed', typed && search && submittedSearch(c, '대한민국헌법', /law\.go\.kr/)),
        test('Constitution was opened from an observed official search result', openedResult),
        test('Official statute DOM contains both Article 1 clauses', statute && clauses.every(v => body(statute).includes(v))),
        test('Browser visited the statute wrapper or frame', urls(c).some(s => hasUrl(s, /law\.go\.kr\/(?:법령\/대한민국헌법|LSW\/.*lsInfoP\.do|LSW\/lsSc\.do)/))),
        test('Answer quotes both clauses and effective date evidenced in DOM', statute && clauses.every(v => c.answer.includes(v)) && /1988[.년\s/-]+0?2[.월\s/-]+0?25/.test(c.answer) && /시행\s*1988[.년\s/-]+0?2[.월\s/-]+0?25(?:[.일\s\]]|$)/.test(body(statute))),
      ], siteBlocked(c));
    },
  },
  {
    id: 'korean-wikipedia-three-hop',
    urls: ['https://ko.wikipedia.org/wiki/대한민국'],
    prompt: 'Starting at 대한민국 on Korean Wikipedia, follow article links in exactly this order: 서울특별시 → 한강 → 황해. Use clicks for all three hops. Leave 황해 open. Report the path and the average depth from the final article infobox, quoting that infobox line.',
    check(input) {
      const c = context(input); const final = page(c, wikiPath('황해'), /평균 수심/);
      const path = ['대한민국', '서울특별시', '한강', '황해'];
      let previous = -1;
      const hops = path.slice(0, -1).every((title, i) => {
        const index = c.calls.findIndex((call, at) => at > previous && call.action === 'click' && boundSource(c, call, wikiPath(title), e => e.role === 'link' && hasUrl({ url: e.href }, wikiPath(path[i + 1]))));
        if (index < 0) return false;
        previous = index; return true;
      });
      const infobox = String(final?.text ?? '').match(/(?:^|\n)\s*(평균 수심[^\S\r\n]+[^\r\n]+)/)?.[1];
      const literal = text(infobox);
      const quotes = literalQuotes(c.rawAnswer, 8);
      return result([
        test('All three required article links were clicked in source-page order using successful bound refs', hops),
        test('Fresh final article DOM contains its average-depth infobox line', final && literal),
        test('Answer reports the path and literally quotes the observed infobox line', path.every(title => c.answer.includes(title)) && literal && quotes.includes(literal)),
      ], siteBlocked(c));

    },
  },
  {
    id: 'github-stars-release',
    urls: ['https://github.com/microsoft/playwright'],
    prompt: 'On microsoft/playwright on GitHub, read the currently displayed star count, then open its latest release. Keep the repository and release tabs open. Report the displayed star count, latest release tag, and release heading. Quote one sentence from the release notes.',
    check(input) {
      const c = context(input); const repo = page(c, /^https:\/\/github\.com\/microsoft\/playwright\/?$/, /Star/);
      const release = page(c, /^https:\/\/github\.com\/microsoft\/playwright\/releases\/tag\//);
      const star = body(repo).match(/Star\s*([\d,.]+\s*[km]?)/i)?.[1];
      const tag = release?.url?.split('/tag/')[1]?.split(/[?#]/)[0];
      const heading = text(release?.title).match(/^Release (.+?) · microsoft\/playwright · GitHub$/)?.[1];
      return result([
        test('Repository DOM has a star count', star), test('Release tag URL and notes DOM exist', release && body(release).length > 100),
        test('Answer matches displayed stars, live release tag and observed release heading', star && tag && heading && answerIncludes(c, star) && answerIncludes(c, tag) && answerIncludes(c, heading)),
        test('Release is labeled latest in independent DOM', release && /Latest/.test(body(release))),
        test('Answer quotes release notes', release && quoteEvidence(c, release)),
      ], siteBlocked(c));
    },
  },
  {
    id: 'wikipedia-sortable-table',
    urls: ['https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population'],
    prompt: 'Click the population table’s Location header to put its displayed rows in ascending alphabetical order. Leave that table open. Report the first three country/dependency names and their populations exactly as displayed after the click.',
    check(input) {
      const c = context(input); const table = page(c, /^https:\/\/en\.wikipedia\.org\/wiki\/List_of_countries_and_dependencies_by_population/);
      const observed = populationFirstRows(table);
      const distinct = new Set(observed.map(row => row.country));
      const sortHeader = table?.elements?.find(e => /^(?:Location|Country.*Dependency)$/i.test(text(e.name)));
      const sort = sortHeader?.ariaSort ?? sortHeader?.['aria-sort'];
      const ascending = observed.length === 3 && observed.every((row, i) => i === 0 || englishCountryOrder.compare(observed[i - 1].country, row.country) <= 0) && distinct.size === 3;
      const changedByHeaderClick = c.snapshots.some(source => {
        if (!table || source.tabId !== table.tabId || comparableURL(source.url) !== comparableURL(table.url) || source.snapshotId === table.snapshotId) return false;
        const before = populationFirstRows(source);
        return before.length === 3 && !before.every((row, i) => row.country === observed[i]?.country && row.population === observed[i]?.population) && c.calls.some((call, i) => producerIndex(c, source) >= 0 && producerIndex(c, source) < i && call.action === 'click' && boundSource(c, call, /^https:\/\/en\.wikipedia\.org\/wiki\/List_of_countries_and_dependencies_by_population(?:[?#]|$)/, e => /^(?:Location|Country.*Dependency)$/i.test(text(e.name)) && /columnheader|button/.test(e.role))?.source.snapshotId === source.snapshotId);
      });
      const checked = result([
        test('Fresh current table exposes three unique rows in English display-name order', ascending),
        test('Successful snapshot-bound Location header click changed the pre-click first three rows', changedByHeaderClick),
        test('Exposed sort state is ascending when available', !sort || sort === 'ascending'),
        test('Answer includes the fresh observed countries and exact populations', observed.length === 3 && observed.every(row => c.answer.includes(row.country) && c.answer.includes(row.population))),
      ], siteBlocked(c));
      const insufficient = Boolean(table && /(?:^|\n)Location\tPopulation/.test(String(table.text)) && observed.length < 3 && table.truncated);
      return { ...checked, measurementInsufficient: insufficient, measurementReason: insufficient ? 'incomplete-current-table-rows' : null };

    },
  },
  {
    id: 'arxiv-page-three',
    urls: ['https://arxiv.org/list/cs.AI/recent?show=25'],
    prompt: 'Use arXiv Artificial Intelligence recent-submissions pagination with 25 entries per page to reach page three (entries 51–75). Open the first paper on that page in a new tab. Keep both tabs open and report its arXiv ID, exact title and first author.',
    check(input) {
      const c = context(input); const listing = page(c, /^https:\/\/arxiv\.org\/list\/cs\.AI\/recent(?:[?#]|$)/, /\[51\]\s*arXiv:/);
      const entries = [...body(listing).matchAll(/\[(\d+)\]\s*arXiv:([\d.]+)/g)];
      const proper = entries.length === 25 && entries.every((match, i) => Number(match[1]) === 51 + i);
      const pagination = listing && c.calls.some(call => call.action === 'click' && boundSource(c, call, /^https:\/\/arxiv\.org\/list\/cs\.AI\/recent(?:[?#]|$)/, e => {
        if (e.role !== 'link') return false;
        try { const href = new URL(e.href); return href.origin === 'https://arxiv.org' && href.pathname === '/list/cs.AI/recent' && href.searchParams.get('skip') === '50' && href.searchParams.get('show') === '25'; } catch { return false; }
      })?.source.tabId === listing.tabId && call.args.snapshotId !== listing.snapshotId);
      const id = body(listing).match(/\[51\]\s*arXiv:([\d.]+)/)?.[1];
      const article = id && page(c, new RegExp(`^https://arxiv\\.org/abs/${id.replace('.', '\\.')}($|v|[?#])`));
      const title = text(article?.title).replace(/^\[[^\]]+\]\s*/, '');
      const firstAuthor = arxivAuthor(article);
      return result([
        test('Page three URL and numbered listing DOM', proper && id), test('First paper abstract and page-three listing remain in separate current tabs', article && body(article).includes(id) && c.hasTabInventory && listing.tabId !== article.tabId && [listing.tabId, article.tabId].every(tabId => c.tabs.some(t => t.tabId === tabId))),
        test('Successful page-three pagination click is bound to its observed page-three link and retained listing tab', pagination),
        test('Answer contains ID, exact title and first author', id && answerIncludes(c, id) && title && answerIncludes(c, title) && firstAuthor && answerIncludes(c, firstAuthor)),
      ], siteBlocked(c));
    },
  },
  {
    id: 'wikipedia-autocomplete',
    urls: ['https://en.wikipedia.org/wiki/Main_Page'],
    prompt: 'In Wikipedia’s search box, type Albert Eins without submitting. Wait for autocomplete suggestions, then click the Albert Einstein suggestion for the German-born theoretical physicist. Leave the resulting article open. Report the exact suggestion label and quote one factual sentence about his scientific work from the article.',
    check(input) {
      const c = context(input);
      const article = page(c, /^https:\/\/en\.wikipedia\.org\/wiki\/Albert_Einstein(?:[?#]|$)/, /Albert Einstein/);
      let suggestion;
      for (const source of c.snapshots.filter(s => hasUrl(s, /^https:\/\/en\.wikipedia\.org\/(?:wiki\/Main_Page|w\/index\.php)/))) {
        const elements = source.elements ?? [];
        if (!elements.some(e => ['textbox', 'searchbox', 'combobox'].includes(e.role) && text(e.value) === 'Albert Eins' && String(e.formMethod).toLowerCase() === 'get' && comparableURL(e.formAction) === 'https://en.wikipedia.org/w/index.php')) continue;
        const index = elements.findIndex(e => e.tag === 'li' && e.role === 'option' && /^Albert Einstein\s*German-born theoretical physicist/.test(text(e.name)));
        const option = elements[index]; const anchor = elements[index + 1];
        if (index < 0 || anchor?.tag !== 'a' || anchor.role !== 'link' || text(anchor.name) !== text(option.name)) continue;
        let correctLink = false;
        try { const href = new URL(anchor.href); correctLink = href.origin === 'https://en.wikipedia.org' && ((href.pathname === '/w/index.php' && href.searchParams.get('search') === 'Albert Einstein') || href.pathname === '/wiki/Albert_Einstein'); } catch {}
        if (!correctLink) continue;
        const typedIndex = c.calls.findIndex(call => call.action === 'type' && text(call.args.text) === 'Albert Eins' && call.args.submit !== true && call.args.tabId === source.tabId && boundSource(c, call, /^https:\/\/en\.wikipedia\.org\/(?:wiki\/Main_Page|w\/index\.php)(?:[?#]|$)/, e => getQueryField(e, /^https:\/\/en\.wikipedia\.org\/w\/index\.php(?:[?#]|$)/)));
        const clickIndex = c.calls.findIndex(call => call.action === 'click' && call.args.snapshotId === source.snapshotId && (call.args.ref === anchor.ref || call.args.ref === option.ref) && (!call.args.tabId || call.args.tabId === source.tabId));
        suggestion = { label: text(option.name), name: 'Albert Einstein', description: text(option.name).slice('Albert Einstein'.length).trim(), clicked: typedIndex >= 0 && clickIndex > typedIndex };
        if (suggestion.clicked) break;
      }
      const fact = literalQuotes(c.rawAnswer).some(quote => (/physic|relativity|Nobel|photoelectric|quantum/i.test(quote) || /\b(?:publish(?:ed|ing)?|author(?:ed|ing)?)\b/i.test(quote) && /\b(?:scientific|research|groundbreaking)\b/i.test(quote) && /\b(?:papers?|articles?|work)\b/i.test(quote)) && body(article).includes(quote));
      return result([
        test('Actual GET search autocomplete option and its child anchor were observed', suggestion),
        test('Successful typing preceded a successful snapshot-bound suggestion-anchor click', suggestion?.clicked),
        test('Fresh final Wikipedia article verifies Albert Einstein', article),
        test('Answer matches the actual suggestion label and quotes a scientific fact from final DOM', suggestion && answerIncludes(c, suggestion.name) && answerIncludes(c, suggestion.description) && /Albert Einstein/.test(c.answer) && fact),
      ], siteBlocked(c));
    },
  },
  {
    id: 'docs-target-blank',
    urls: ['https://playwright.dev/docs/intro'],
    prompt: 'On the Playwright installation documentation, click the visible GitHub repository link and let it open a new tab. Keep the documentation and repository tabs open. Report the repository’s full name and quote one factual sentence from its description or README.',
    check(input) {
      const c = context(input);
      const source = page(c, /^https:\/\/playwright\.dev\/docs\/intro(?:[?#]|$)/, /Playwright/);
      const target = page(c, /^https:\/\/github\.com\/microsoft\/playwright\/?$/, /Playwright/);
      const clicked = c.snapshots.some(s => hasUrl(s, /^https:\/\/playwright\.dev\/docs\/intro(?:[?#]|$)/) && clickedElement(c, s, e => e.role === 'link' && text(e.name) === 'GitHub repository' && comparableURL(e.href) === 'https://github.com/microsoft/playwright'));
      const quoted = literalQuotes(c.rawAnswer).some(quote => /Playwright|testing|automation|Chromium|Firefox|WebKit/i.test(quote) && body(target).includes(quote));
      return result([
        test('Original documentation and repository have fresh DOM in separate retained tabs', source && target && source.tabId !== target.tabId),
        test('Successful snapshot-bound GitHub repository link click was recorded', clicked),
        test('Owned browser recorded the exact opener and popup target', source && target && c.events.some(e => e.type === 'owned_browser_popup' && e.openerTabId === source.tabId && e.tab?.tabId === target.tabId)),
        test('Answer names the repository and quotes its independently observed contents', /microsoft\/playwright/i.test(c.answer) && quoted),
      ], siteBlocked(c));
    },
  },
  {
    id: 'news-modal-dismissal',
    urls: ['https://www.404media.co/#/portal/signup'],
    prompt: 'The 404 Media homepage opens with its newsletter signup modal. Observe its Name, Email and Close popup controls, then press Escape to dismiss it without submitting. Take a fresh homepage snapshot to confirm the modal disappeared. Click “How ChatGPT Targets Ads To You Based On Your Prompts, Phone Number, and Email”. Leave the article open and report its headline, byline and a brief factual quote from its body.',
    check(input) {
      const c = context(input);
      const articleURL = 'https://www.404media.co/how-chatgpt-targets-ads-to-you-based-on-your-prompts-phone-number-and-email';
      const article = currentSnapshots(c).find(s => comparableURL(s.url) === articleURL && /ChatGPT/.test(body(s)));
      const modalPresent = s => ['Name', 'Email', 'Close popup'].every(name => s.elements?.some(e => text(e.name) === name && (name === 'Close popup' ? e.role === 'button' : ['textbox', 'combobox'].includes(e.role))));
      const producerIndex = s => {
        const receipt = (input.snapshotReceipts ?? []).find(r => r.snapshotId === s.snapshotId);
        return receipt ? c.calls.findIndex(call => call.callId === receipt.callId) : -1;
      };
      let orderedDismissal = false;
      for (const before of c.snapshots.filter(s => comparableURL(s.url) === 'https://www.404media.co' && modalPresent(s))) {
        const beforeIndex = producerIndex(before);
        if (beforeIndex < 0) continue;
        const escapeIndex = c.calls.findIndex((call, i) => i > beforeIndex && call.action === 'press' && /^Escape$/i.test(String(call.args.key)) && call.args.tabId === before.tabId && (!call.args.snapshotId || call.args.snapshotId === before.snapshotId));
        if (escapeIndex < 0) continue;
        for (const after of c.snapshots.filter(s => s.tabId === before.tabId && comparableURL(s.url) === 'https://www.404media.co' && !s.truncated && !modalPresent(s))) {
          const afterIndex = producerIndex(after);
          if (afterIndex < escapeIndex) continue;
          const clickIndex = c.calls.findIndex((call, i) => i > afterIndex && call.action === 'click' && call.args.tabId === after.tabId && call.args.snapshotId === after.snapshotId && after.elements?.some(e => e.ref === call.args.ref && e.role === 'link' && comparableURL(e.href) === articleURL));
          if (clickIndex >= 0 && article?.tabId === after.tabId) { orderedDismissal = true; break; }
        }
        if (orderedDismissal) break;
      }
      const byline = String(article?.text ?? '').split(/\r?\n/).map(text).find(line => /^JOSEPH COX$/i.test(line));
      const authorLink = article?.elements?.some(e => e.role === 'link' && comparableURL(e.href) === 'https://www.404media.co/author/joseph-cox');
      const quote = literalQuotes(c.rawAnswer).some(q => /ChatGPT|OpenAI|advertis|target/i.test(q) && !text(article?.title).includes(q) && !text(byline).includes(q) && body(article).includes(q));
      return result([
        test('Modal observation, successful Escape, fresh modal-free homepage and bound article click occurred in order on the same tab', orderedDismissal),
        test('Fresh selected article DOM independently verifies headline and author', article && byline && authorLink),
        test('Answer includes observed headline, byline and a factual body quote', article && byline && answerIncludes(c, article.title) && answerIncludes(c, byline) && quote),
      ], siteBlocked(c));
    },
  },
  {
    id: 'arxiv-pdf-download',
    urls: ['https://arxiv.org/abs/1706.03762'],
    prompt: 'Open Attention Is All You Need on arXiv and download its public PDF through the managed browser download controls. Leave the abstract tab open. Report the paper title, downloaded filename and completed download ID. A PDF viewer tab alone is not a completed download.',
    check(input) {
      const c = context(input); const abstract = page(c, /^https:\/\/arxiv\.org\/abs\/1706\.03762/, /Attention Is All You Need/);
      const browserJobs = c.downloads.filter(d => /^https:\/\/arxiv\.org\/pdf\/1706\.03762(?:v\d+)?(?:[?#]|$)/.test(d.url ?? d.sourceUrl ?? d.source?.url ?? '') && ['downloaded', 'imported', 'saved'].includes(d.state ?? d.status) && Number(d.size ?? d.receivedBytes) > 1000 && /\.pdf$/i.test(d.filename ?? ''));
      const download = browserJobs.find(job => {
        const id = job.downloadId ?? job.jobId;
        if (!id || !c.answer.includes(id) || !c.answer.includes(job.filename)) return false;
        const sourcePage = comparableURL(job.source?.pageUrl);
        if (!abstract || job.target?.tabId !== abstract.tabId || sourcePage !== comparableURL(abstract.url)) return false;
        const ownedEvent = c.events.some(e => e.type === 'browser-download' && (e.job?.downloadId ?? e.job?.jobId) === id && e.job?.target?.tabId === job.target.tabId && comparableURL(e.job?.source?.url) === comparableURL(job.source?.url) && comparableURL(e.job?.source?.pageUrl) === sourcePage);
        const controls = c.calls.some(call => /browser_downloads$/.test(String(call.tool ?? call.name ?? ''))) || c.calls.some(call => call.action === 'click' && boundSource(c, call, /^https:\/\/arxiv\.org\/abs\/1706\.03762(?:[?#]|$)/, e => e.role === 'link' && /^https:\/\/arxiv\.org\/pdf\/1706\.03762(?:v\d+)?(?:[?#]|$)/.test(e.href ?? ''))?.source.tabId === job.target.tabId);
        return ownedEvent && controls;
      });
      return result([
        test('Official abstract DOM verifies title', abstract), test('Answered completed job has owned-browser event provenance and a successful managed-browser control action', download),
        test('Answer matches title, filename and actual download ID', download && c.answer.includes('Attention Is All You Need') && c.answer.includes(download.filename) && c.answer.includes(download.downloadId ?? download.jobId ?? 'NO_DOWNLOAD_ID')),
      ], siteBlocked(c));
    },
  },
];

export function selectBrowserTasks(csv) {
  if (!csv || csv === 'all') return browserTasks;
  const ids = String(csv).split(',').map(id => id.trim()).filter(Boolean);
  const unknown = ids.filter(id => !browserTasks.some(task => task.id === id));
  if (unknown.length) throw new Error(`Unknown browser task IDs: ${unknown.join(', ')}`);
  return ids.map(id => browserTasks.find(task => task.id === id));
}

export const browserTaskProbeMetadata = {
  date: '2026-10-16', browser: 'Playwright Chromium 1248, headless, no paid calls',
  reports: ['/tmp/browser-agent-site-probes.json', '/tmp/browser-agent-interaction-probes.json', '/tmp/browser-agent-refinement-probes.json', '/tmp/browser-agent-law-search-probe.json', '/tmp/browser-agent-law-form-submit-probe.json', '/tmp/browser-agent-naver-search-form-probe.json'],
  observed: 'All ten starting sites responded 200. Guardian privacy notice appeared in a sourcepoint iframe. law.go.kr wrapper and statute frame both exposed empty body text during probe. Reuters was rejected with HTTP 401 and CAPTCHA and is not used.',
  limitations: 'Probe confirms page accessibility and content, not full agent completion. Observed external access challenges are blocked; empty statute-frame snapshots fail as unverified browser capability. Missing autocomplete/modal history or changed ranking fails validation without establishing a site blocker.',
};

for (const task of browserTasks) task.probe = { ...browserTaskProbeMetadata, startingUrl: task.urls[0], validated: false };

const expectedDestinations = {
  'naver-second-result': null,
  'law-statute-frame': /^https:\/\/(?:www\.)?law\.go\.kr\/(?:법령\/대한민국헌법|LSW\/.*lsInfoP\.do|LSW\/lsSc\.do)/,
  'korean-wikipedia-three-hop': wikiPath('황해'),
  'github-stars-release': /^https:\/\/github\.com\/microsoft\/playwright\/releases\/tag\//,
  'wikipedia-sortable-table': /^https:\/\/en\.wikipedia\.org\/wiki\/List_of_countries_and_dependencies_by_population/,
  'arxiv-page-three': /^https:\/\/arxiv\.org\/abs\//,
  'wikipedia-autocomplete': /^https:\/\/en\.wikipedia\.org\/wiki\/Albert_Einstein(?:[?#]|$)/,
  'docs-target-blank': /^https:\/\/github\.com\/microsoft\/playwright\/?$/,
  'news-modal-dismissal': /^https:\/\/www\.404media\.co\/how-chatgpt-targets-ads-to-you-based-on-your-prompts-phone-number-and-email\/?$/,
  'arxiv-pdf-download': /^https:\/\/arxiv\.org\/abs\/1706\.03762/,
};
for (const task of browserTasks) {
  const check = task.check;
  task.check = input => {
    const rows = input.tabs?.length ? input.tabs : input.snapshots ?? [];
    const startPaths = task.urls.map(url => decoded(url).split(/[?#]/)[0].replace(/\/$/, ''));
    let expected = expectedDestinations[task.id];
    if (task.id === 'naver-second-result') {
      const ranked = naverWebResults(context(input).snapshots.find(s => hasUrl(s, /search\.naver\.com/)));
      if (ranked[1]) expected = { test: url => { try { return new URL(url).hostname.replace(/^www\./, '') === ranked[1].domain; } catch { return false; } } };
    }
    const wrongURL = Boolean(expected) && !rows.some(row => hasUrl(row, expected)) && rows.some(row => /^https?:/.test(row.url ?? '') && !startPaths.includes(decoded(row.url).split(/[?#]/)[0].replace(/\/$/, '')));
    return { ...check(input), wrongURL };
  };
}

browserTasks.find(task => task.id === 'law-statute-frame').probe.searchForm = { method: 'GET', observedSubmitMethod: 'GET', readOnlyUiProbe: 'Typed query then Enter; results page exposed both Article 1 clauses and effective date in main DOM', action: 'https://www.law.go.kr/LSW/lsSc.do', input: 'query', nonsensitiveQuery: '대한민국헌법', backgroundRequests: ['POST /LSW/lsScListR.do', 'POST /LSW/lsInfoR.do'], servicePolicyUnchanged: true, limitation: 'Background result loading uses POST; normal browser policy still applies. No browser exception was added.' };

browserTasks.find(task => task.id === 'naver-second-result').probe.searchForm = { startingQuery: '대한민국', targetQuery: '한글날 10월 9일', method: 'GET', observedSubmitMethod: 'GET', interaction: 'Visible query input, type, Enter or search control', observedRanking: 'namu.wiki then hangeul.go.kr after knowledge panel; ranking is derived from each run DOM' , report: '/tmp/browser-agent-naver-search-form-probe.json', servicePolicyUnchanged: true };

Object.assign(browserTasks.find(t => t.id === 'wikipedia-autocomplete').probe, { originalId: 'naver-map-autocomplete', originalStartingUrl: 'https://map.naver.com/p/', replacementReason: 'Naver Map autocomplete was not established through question/safe; Wikipedia GET autocomplete was exercised with actual option/child-anchor refs and successful owned-browser receipts.', proof: '/tmp/owned-browser-followup-20261016/wikipedia-autocomplete-confirmed-proof.json', policyMode: 'question/safe' });
Object.assign(browserTasks.find(t => t.id === 'docs-target-blank').probe, { originalStartingUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/a', replacementReason: 'MDN Baseline popup was not established; Playwright GitHub repository link produced a genuine owned_browser_popup with retained source/target DOM.', proof: '/tmp/owned-browser-followup-20261016/docs-popup-confirmed-proof.json', policyMode: 'question/safe' });
Object.assign(browserTasks.find(t => t.id === 'wikipedia-sortable-table').probe, { proof: '/tmp/owned-browser-followup-20261016/wikipedia-sortable-table-proof.json', correction: 'Read the actual fresh first three rows after a successful bound Location header click; validate English display-name order, uniqueness and change from the pre-click first three. Full-table capture is unnecessary.', measurementReason: 'incomplete-current-table-rows' });

Object.assign(browserTasks.find(t => t.id === 'news-modal-dismissal').probe, { originalId: 'news-consent-modal', originalStartingUrl: 'https://www.theguardian.com/international', replacementReason: 'Guardian consent controls were inside an unavailable iframe. The 404 Media newsletter modal is visible to the shared stock service and was dismissed by page Escape; this task makes no cookie-consent claim.', proofs: ['/tmp/owned-browser-followup-20261016/404-modal-before-proof.json', '/tmp/owned-browser-followup-20261016/404-article-after-proof.json'], policyMode: 'question/safe', orderingContract: 'snapshotReceipts:[{snapshotId,callId}] correlated to successful calls: modalBefore producer < Escape <= modalFreeHome producer < bound article click' });

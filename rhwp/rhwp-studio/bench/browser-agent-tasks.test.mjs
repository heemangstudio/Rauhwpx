import test from 'node:test';
import assert from 'node:assert/strict';
import { browserTasks, selectBrowserTasks } from './browser-agent-tasks.mjs';

const rawTask = id => selectBrowserTasks(id)[0];
// Existing positive fixtures describe successful browser actions. Attach explicit
// call/result receipts; failure-provenance cases below use rawTask directly.
const successfulFixture = (evidence = {}) => {
  const calls = (evidence.calls ?? []).map((call, i) => ({ ...call, callId: call.callId ?? `fixture-call-${i}` }));
  const toolResults = [...(evidence.toolResults ?? [])];
  for (const call of calls) if (!toolResults.some(result => result.callId === call.callId)) toolResults.push({ callId: call.callId, ok: true, resultPreview: JSON.stringify({ ok: true }) });
  return { ...evidence, calls, toolResults };
};
const task = id => ({ check: evidence => rawTask(id).check(successfulFixture(evidence)) });
const snapshot = (url, text, extra = {}) => ({ snapshotId: 'snapshot', tabId: 'tab', url, title: 'Page', text, elements: [], ...extra });
const click = { tool: 'mcp__rhwp__browser_click', args: { tabId: 'tab', ref: 'header', snapshotId: 'snapshot' } };
const typeIn = (source, ref, value, submit = false) => ({ tool: 'browser_type', args: { tabId: source.tabId, snapshotId: source.snapshotId, ref, text: value, submit } });

function tableFixture(rows = [['Abkhazia[a]', '244,236'], ['Afghanistan', '43,844,000'], ['Åland Islands (Finland)', '30,654'], ['Albania', '2,335,930'], ['Éire', '5,000,000'], ['Zimbabwe', '10,000,000']]) {
  const allRows = [['Location', 'Population'], ['World', '8,232,000,000'], ...rows];
  return snapshot('https://en.wikipedia.org/wiki/List_of_countries_and_dependencies_by_population', allRows.map(r => r.join('\t')).join('\n'), { elements: [{ ref: 'header', role: 'columnheader', name: 'Location', ariaSort: 'ascending' }], tables: [{ headers: [{ text: 'Location', ariaSort: 'ascending' }, { text: 'Population' }], rows: allRows, rowCount: allRows.length, complete: true }] });
}
function sortFixture(source = tableFixture()) {
  const [header, ...rows] = source.text.split('\n');
  const before = { ...source, snapshotId: 'snapshot', text: [header, ...rows.reverse()].join('\n') };
  const current = { ...source, snapshotId: 'after-sort' };
  return { snapshots: [current, before], currentSnapshots: [current], tabs: [current], calls: [{ callId: 'before-read', tool: 'browser_snapshot', args: { tabId: source.tabId } }, click], snapshotReceipts: [{ snapshotId: before.snapshotId, callId: 'before-read' }] };
}

function docsFixture() {
  const source = snapshot('https://playwright.dev/docs/intro', 'Installation | Playwright', { snapshotId: 'docs-before', tabId: 'source', elements: [{ ref: 'github', role: 'link', name: 'GitHub repository', href: 'https://github.com/microsoft/playwright' }] });
  const target = snapshot('https://github.com/microsoft/playwright', 'Playwright is a framework for Web Testing and Automation.', { tabId: 'target' });
  return { snapshots: [source, target], currentSnapshots: [source, target], tabs: [source, target], calls: [{ tool: 'browser_click', args: { ref: 'github', snapshotId: 'docs-before', tabId: 'source' } }], browserEvents: [{ type: 'owned_browser_popup', openerTabId: 'source', tab: { tabId: 'target' } }], answer: 'microsoft/playwright “Playwright is a framework for Web Testing and Automation.”' };
}

test('answers and missing evidence cannot establish completion or an external blocker', () => {
  for (const candidate of browserTasks) {
    const checked = candidate.check({ answer: candidate.prompt + ' 45 m 1988년 2월 25일' });
    assert.equal(checked.passed, false, candidate.id);
    assert.equal(checked.blocked, false, candidate.id);
    assert.equal(typeof checked.wrongURL, 'boolean', candidate.id);
  }
});

test('external access denial is blocked; local approval and empty statute snapshots are unverified failures', () => {
  const github = task('github-stars-release');
  assert.equal(github.check({ snapshots: [snapshot('https://github.com/microsoft/playwright', 'Access denied')] }).blocked, true);
  assert.equal(github.check({ tabs: [{ url: 'https://github.com/microsoft/playwright', status: 'approval-required' }] }).blocked, false);
  const law = task('law-statute-frame').check({ snapshots: [snapshot('https://www.law.go.kr/법령/대한민국헌법', '', { title: '대한민국헌법' })] });
  assert.equal(law.passed, false);
  assert.equal(law.blocked, false);
});

test('wrongURL describes an observed wrong destination, not absent evidence or the untouched starting page', () => {
  const github = task('github-stars-release');
  assert.equal(github.check({ tabs: [{ url: 'https://github.com/another/project' }] }).wrongURL, true);
  assert.equal(github.check({ tabs: [{ url: 'https://github.com/microsoft/playwright' }] }).wrongURL, false);
  assert.equal(github.check({ tabs: [{ url: 'https://github.com/microsoft/playwright/releases/tag/v1.0' }] }).wrongURL, false);
});

test('target blank requires a successful exact link click, real popup, and fresh retained source and target DOM', () => {
  const evidence = docsFixture();
  assert.equal(task('docs-target-blank').check(evidence).passed, true);
  const blockquote = { ...evidence, answer: 'microsoft/playwright\n\n> Playwright is a framework for Web Testing and Automation.' };
  assert.equal(task('docs-target-blank').check(blockquote).passed, true);
  assert.equal(task('docs-target-blank').check({ ...blockquote, answer: blockquote.answer.replace('Web Testing', 'invented testing') }).passed, false);
  assert.equal(task('docs-target-blank').check({ ...evidence, browserEvents: [] }).passed, false);
  assert.equal(task('docs-target-blank').check({ ...evidence, browserEvents: [{ type: 'owned_browser_popup', openerTabId: 'another', tab: { tabId: 'target' } }] }).passed, false);
  assert.equal(task('docs-target-blank').check({ ...evidence, calls: [{ tool: 'browser_open', args: { url: evidence.tabs[1].url } }, click] }).passed, false);
  assert.equal(task('docs-target-blank').check({ ...evidence, currentSnapshots: [evidence.currentSnapshots[0]] }).passed, false);
  assert.equal(task('docs-target-blank').check({ ...evidence, tabs: [evidence.tabs[0]] }).passed, false);
});

test('PDF download requires a completed nonempty managed job and matching ID', () => {
  const abstract = snapshot('https://arxiv.org/abs/1706.03762', 'Attention Is All You Need by Ashish Vaswani.', { elements: [{ ref: 'pdf', role: 'link', name: 'View PDF', href: 'https://arxiv.org/pdf/1706.03762' }] });
  const job = { downloadId: 'bd_test', state: 'downloaded', size: 1102000, filename: '1706.03762.pdf', target: { tabId: 'tab' }, source: { url: 'https://arxiv.org/pdf/1706.03762', pageUrl: 'https://arxiv.org/abs/1706.03762' } };
  const evidence = { snapshots: [abstract], downloads: [job], browserEvents: [{ type: 'browser-download', job }], calls: [{ tool: 'browser_click', args: { tabId: 'tab', snapshotId: 'snapshot', ref: 'pdf' } }], answer: 'Attention Is All You Need 1706.03762.pdf bd_test' };
  assert.equal(task('arxiv-pdf-download').check(evidence).passed, true);
  assert.equal(task('arxiv-pdf-download').check({ ...evidence, calls: [] }).passed, false);
  assert.equal(task('arxiv-pdf-download').check({ ...evidence, browserEvents: [] }).passed, false);
  const generic = { ...job, downloadId: 'bd_generic', source: { ...job.source, pageUrl: job.source.url } };
  assert.equal(task('arxiv-pdf-download').check({ ...evidence, downloads: [generic, job] }).passed, true);
  const genericOnly = { ...evidence, downloads: [generic], browserEvents: [{ type: 'browser-download', job: generic }], calls: [{ tool: 'download_file', args: { url: generic.source.url } }], answer: 'Attention Is All You Need 1706.03762.pdf bd_generic' };
  assert.equal(task('arxiv-pdf-download').check(genericOnly).passed, false);
  assert.equal(task('arxiv-pdf-download').check({ ...genericOnly, calls: [{ tool: 'browser_downloads', args: { action: 'list' } }] }).passed, false);
  assert.equal(task('arxiv-pdf-download').check({ ...evidence, calls: [{ tool: 'browser_downloads', args: { action: 'list' } }] }).passed, true);

  for (const incomplete of [{ ...job, state: 'downloading' }, { ...job, size: 0 }, { ...job, source: { url: 'https://example.com/fake.pdf' } }]) {
    assert.equal(task('arxiv-pdf-download').check({ ...evidence, downloads: [incomplete] }).passed, false);
  }
});

test('arxiv first author comes from its author line, supporting labeled and observed legacy DOM', () => {
  const before = snapshot('https://arxiv.org/list/cs.AI/recent', '[1] arXiv:1706.00001', { snapshotId: 'page-one', tabId: 'listing', elements: [{ ref: 'page-three', role: 'link', name: '51-75', href: 'https://arxiv.org/list/cs.AI/recent?skip=50&show=25' }] });
  const listing = snapshot('https://arxiv.org/list/cs.AI/recent', Array.from({ length: 25 }, (_, i) => `[${51 + i}] arXiv:${i ? '1706.' + String(i).padStart(5, '0') : '1706.03762'}`).join('\n'), { snapshotId: 'page-three', tabId: 'listing' });
  // The legacy title/author layout was observed in the live 2026-10-16 probe.
  const prefix = 'Computer Science > Computation and Language\n[Submitted on 12 Jun 2017]\n';
  const article = snapshot('https://arxiv.org/abs/1706.03762', prefix + 'Attention Is All You Need\nAshish Vaswani, Noam Shazeer, Niki Parmar\nThe dominant sequence transduction models...\nCite as: arXiv:1706.03762', { title: '[1706.03762] Attention Is All You Need', tabId: 'abstract' });
  const evidence = { snapshots: [listing, article, before], currentSnapshots: [listing, article], tabs: [listing, article], calls: [{ tool: 'browser_click', args: { tabId: 'listing', snapshotId: 'page-one', ref: 'page-three' } }], answer: '1706.03762 Attention Is All You Need Ashish Vaswani' };
  assert.equal(task('arxiv-page-three').check(evidence).passed, true);
  assert.equal(task('arxiv-page-three').check({ ...evidence, calls: [click] }).passed, false);
  const wrongRef = { ...evidence.calls[0], args: { ...evidence.calls[0].args, ref: 'unrelated' } };
  assert.equal(task('arxiv-page-three').check({ ...evidence, calls: [wrongRef] }).passed, false);
  const nextLink = { ...before, elements: [{ ...before.elements[0], name: 'Next' }] };
  assert.equal(task('arxiv-page-three').check({ ...evidence, snapshots: [listing, article, nextLink] }).passed, true);
  const wrongPageLink = { ...before, elements: [{ ...before.elements[0], href: 'https://arxiv.org/list/cs.AI/recent?skip=75&show=25' }] };
  assert.equal(task('arxiv-page-three').check({ ...evidence, snapshots: [listing, article, wrongPageLink] }).passed, false);
  const sameTab = { ...article, tabId: listing.tabId };
  assert.equal(task('arxiv-page-three').check({ ...evidence, snapshots: [listing, sameTab, before], currentSnapshots: [listing, sameTab], tabs: [listing, sameTab] }).passed, false);
  const incomplete = { ...listing, text: '[51] arXiv:1706.03762\n[75] arXiv:1706.00001' };
  assert.equal(task('arxiv-page-three').check({ ...evidence, snapshots: [incomplete, article, before], currentSnapshots: [incomplete, article], tabs: [incomplete, article] }).passed, false);

  const labeled = { ...article, text: prefix + 'Title: Attention Is All You Need\nAuthors: Ashish Vaswani, Noam Shazeer\nAbstract: The dominant sequence transduction models...\nCite as: arXiv:1706.03762' };
  assert.equal(task('arxiv-page-three').check({ ...evidence, snapshots: [listing, labeled, before], currentSnapshots: [listing, labeled] }).passed, true);
  assert.equal(task('arxiv-page-three').check({ ...evidence, answer: '1706.03762 Attention Is All You Need Noam Shazeer' }).passed, false);
  const single = { ...article, text: prefix + 'Attention Is All You Need\nAshish Vaswani\nAbstract: Test abstract.\nCite as: arXiv:1706.03762', elements: [{ role: 'link', name: 'Ashish Vaswani' }] };
  assert.equal(task('arxiv-page-three').check({ ...evidence, snapshots: [listing, single, before], currentSnapshots: [listing, single] }).passed, true);
});

test('sorting reads changed fresh first rows with English Unicode ordering and footnote removal', () => {
  const source = tableFixture();
  const evidence = { ...sortFixture(source), answer: 'Abkhazia 244,236 Afghanistan 43,844,000 Åland Islands (Finland) 30,654' };
  assert.equal(task('wikipedia-sortable-table').check(evidence).passed, true);
  assert.equal(task('wikipedia-sortable-table').check({ ...evidence, snapshotReceipts: [] }).passed, false);
  assert.equal(task('wikipedia-sortable-table').check({ ...evidence, calls: [...evidence.calls].reverse() }).passed, false);

  assert.equal(task('wikipedia-sortable-table').check({ ...evidence, answer: 'Afghanistan 43,844,000 Albania 2,335,930 Algeria 47,400,000' }).passed, false);
  const unsorted = tableFixture([['Afghanistan', '43,844,000'], ['Abkhazia[a]', '244,236'], ['Åland Islands (Finland)', '30,654'], ['Albania', '2,335,930']]);
  assert.equal(task('wikipedia-sortable-table').check({ ...evidence, ...sortFixture(unsorted) }).passed, false);
  const descending = { ...source, elements: [{ ref: 'header', role: 'columnheader', name: 'Location', ariaSort: 'descending' }] };
  assert.equal(task('wikipedia-sortable-table').check({ ...evidence, ...sortFixture(descending) }).passed, false);
  const duplicate = tableFixture([['Abkhazia', '244,236'], ['Abkhazia', '244,236'], ['Afghanistan', '43,844,000']]);
  assert.equal(task('wikipedia-sortable-table').check({ ...evidence, ...sortFixture(duplicate) }).passed, false);
});

test('table validation needs only fresh first rows and before-click proof; missing initial evidence cannot establish sorting', () => {
  const source = { ...tableFixture(), tables: undefined, truncated: true };
  const evidence = { ...sortFixture(source), answer: 'Abkhazia 244,236 Afghanistan 43,844,000 Åland Islands (Finland) 30,654' };
  assert.equal(task('wikipedia-sortable-table').check(evidence).passed, true);
  assert.equal(task('wikipedia-sortable-table').check({ ...evidence, snapshots: evidence.currentSnapshots }).passed, false);
  const alreadySorted = { ...evidence.snapshots[1], text: evidence.currentSnapshots[0].text };
  assert.equal(task('wikipedia-sortable-table').check({ ...evidence, snapshots: [evidence.currentSnapshots[0], alreadySorted] }).passed, false);
  const incomplete = { ...source, text: 'Location\tPopulation\nAbkhazia\t244,236\nAfghanistan\t43,844,000' };
  const checked = task('wikipedia-sortable-table').check(sortFixture(incomplete));
  assert.equal(checked.passed, false);
  assert.equal(checked.blocked, false);
  assert.equal(checked.measurementInsufficient, true);
  assert.equal(checked.measurementReason, 'incomplete-current-table-rows');
  assert.equal(task('wikipedia-sortable-table').check({}).measurementInsufficient, false);
  assert.equal(task('wikipedia-sortable-table').check({ snapshots: [snapshot('https://example.org/', 'Location\tPopulation')] }).measurementInsufficient, false);
});

test('Naver ranking uses distinct website domains and titles bounded by the next search module', () => {
  const search = snapshot('https://search.naver.com/search.naver', '한글날\n관련정보\nfirst.example.org›one\n새 창 열림\nFirst result\nsecond.example.org›two\n새 창 열림\nSecond result\n네이버 클립\n', { tabId: 'search', elements: [{ ref: 'query', role: 'textbox', name: '검색어 입력', value: '한글날 10월 9일', formMethod: 'get', formAction: 'https://search.naver.com/search.naver' }, { role: 'link', ref: 'result1', name: 'First result새 창 열림' }, { role: 'link', ref: 'result2', href: 'https://second.example.org/two', name: 'Second result새 창 열림' }] });
  const destination = snapshot('https://second.example.org/two', 'A documented factual statement long enough for independent source quotation. '.repeat(3), { tabId: 'destination' });
  const evidence = { snapshots: [search, destination], tabs: [search, destination], calls: [typeIn(search, 'query', '한글날 10월 9일'), { tool: 'browser_press', args: { tabId: search.tabId, key: 'Enter' } }, { tool: 'browser_click', args: { tabId: search.tabId, snapshotId: search.snapshotId, ref: 'result2' } }], answer: 'Second result https://second.example.org/two “A documented factual statement long enough for independent source quotation.”' };
  assert.equal(task('naver-second-result').check(evidence).passed, true);
  const blockquote = { ...evidence, answer: 'Second result https://second.example.org/two\n\n> A documented factual statement long enough for independent source quotation.' };
  assert.equal(task('naver-second-result').check(blockquote).passed, true);
  assert.equal(task('naver-second-result').check({ ...blockquote, answer: blockquote.answer.replace('documented factual', 'invented factual') }).passed, false);
  const submit = { ...search, elements: [...search.elements, { role: 'button', ref: 'search-submit', name: '검색 검색', formMethod: 'get', formAction: 'https://search.naver.com/search.naver' }] };
  const viaButton = { ...evidence, snapshots: [submit, destination], calls: [evidence.calls[0], { tool: 'browser_click', args: { tabId: submit.tabId, ref: 'search-submit', snapshotId: submit.snapshotId } }, evidence.calls[2]] };
  assert.equal(task('naver-second-result').check(viaButton).passed, true);
  assert.equal(task('naver-second-result').check({ ...viaButton, snapshots: [{ ...submit, elements: submit.elements.map(e => e.ref === 'search-submit' ? { ...e, name: '검색 결과 삭제' } : e) }, destination] }).passed, false);
  const failedSubmit = successfulFixture(viaButton);
  failedSubmit.toolResults[1] = { callId: failedSubmit.calls[1].callId, ok: false, resultPreview: 'BROWSER_REF_NOT_FOUND' };
  assert.equal(rawTask('naver-second-result').check(failedSubmit).passed, false);
  const foreignType = { ...evidence.calls[0], args: { ...evidence.calls[0].args, ref: 'not-query' } };
  assert.equal(task('naver-second-result').check({ ...evidence, calls: [foreignType, ...evidence.calls.slice(1)] }).passed, false);
  assert.equal(task('naver-second-result').check({ ...evidence, calls: [evidence.calls[0], { ...evidence.calls[1], args: { tabId: 'foreign', key: 'Enter' } }, evidence.calls[2]] }).passed, false);
  assert.equal(task('naver-second-result').check({ ...evidence, calls: [...evidence.calls.slice(0, 2), { ...evidence.calls[2], args: { ...evidence.calls[2].args, tabId: 'foreign' } }] }).passed, false);
  const wrongHref = { ...search, elements: search.elements.map(e => e.ref === 'result2' ? { ...e, href: 'https://second.example.org/unrelated' } : e) };
  assert.equal(task('naver-second-result').check({ ...evidence, snapshots: [wrongHref, destination] }).passed, false);


  assert.equal(task('naver-second-result').check({ ...evidence, calls: [click] }).passed, false);
  assert.equal(task('naver-second-result').check({ ...evidence, calls: [{ tool: 'browser_type', args: { text: '한글날 10월 9일' } }, click] }).passed, false);
  const unbounded = { ...search, text: search.text.replace('네이버 클립', '') };
  assert.equal(task('naver-second-result').check({ ...evidence, snapshots: [unbounded, destination] }).passed, false);
});

test('historical content cannot satisfy a closed or currently changed popup destination', () => {
  const evidence = docsFixture();
  const changed = { ...evidence.currentSnapshots[1], text: 'Current repository content has no quoted description.' };
  assert.equal(task('docs-target-blank').check({ ...evidence, currentSnapshots: [evidence.currentSnapshots[0], changed] }).passed, false);
  assert.equal(task('docs-target-blank').check({ ...evidence, currentSnapshots: [], tabs: evidence.tabs }).passed, false);
});

test('GitHub requires both current repository and release evidence, not a closed historical repository', () => {
  const repo = snapshot('https://github.com/microsoft/playwright', 'Playwright Public Star97.8k', { tabId: 'repo' });
  const release = snapshot('https://github.com/microsoft/playwright/releases/tag/v1.2.3', 'Latest\nA real release note sentence quoted exactly for the evidence contract.\n'.repeat(3), { tabId: 'release', title: 'Release v1.2.3 · microsoft/playwright · GitHub' });
  const evidence = { snapshots: [repo, release], tabs: [repo, release], answer: '97.8k v1.2.3 “A real release note sentence quoted exactly for the evidence contract.”' };
  assert.equal(task('github-stars-release').check(evidence).passed, true);
  assert.equal(task('github-stars-release').check({ ...evidence, tabs: [release] }).passed, false);
});

test('Wikipedia autocomplete requires observed LI and child anchor, successful bound selection, and final scientific fact', () => {
  const label = 'Albert EinsteinGerman-born theoretical physicist (1879–1955)';
  const source = snapshot('https://en.wikipedia.org/wiki/Main_Page', 'Wikipedia search', { snapshotId: 'suggestions', tabId: 'wiki', elements: [{ ref: 'query', role: 'combobox', name: 'Search Wikipedia', value: 'Albert Eins', formMethod: 'get', formAction: 'https://en.wikipedia.org/w/index.php' }, { tag: 'li', role: 'option', ref: 'option', name: label }, { tag: 'a', role: 'link', ref: 'child', name: label, href: 'https://en.wikipedia.org/w/index.php?title=Special%3ASearch&search=Albert+Einstein&wprov=acrw1_0' }] });
  const final = snapshot('https://en.wikipedia.org/wiki/Albert_Einstein', 'Albert Einstein developed the theory of relativity.', { tabId: 'wiki' });
  const evidence = { snapshots: [source, final], currentSnapshots: [final], tabs: [final], calls: [typeIn(source, 'query', 'Albert Eins'), { tool: 'browser_click', args: { tabId: 'wiki', snapshotId: 'suggestions', ref: 'child' } }], answer: `${label} “Albert Einstein developed the theory of relativity.”` };
  assert.equal(task('wikipedia-autocomplete').check(evidence).passed, true);
  const blockquote = { ...evidence, answer: `${label}\n\n> Albert Einstein developed the theory of relativity.` };
  assert.equal(task('wikipedia-autocomplete').check(blockquote).passed, true);
  assert.equal(task('wikipedia-autocomplete').check({ ...blockquote, answer: blockquote.answer.replace('relativity', 'telepathy') }).passed, false);
  assert.equal(task('wikipedia-autocomplete').check({ ...evidence, calls: [{ ...evidence.calls[0], args: { ...evidence.calls[0].args, ref: 'unrelated-query' } }, evidence.calls[1]] }).passed, false);
  assert.equal(task('wikipedia-autocomplete').check({ ...evidence, calls: [evidence.calls[0], { tool: 'browser_open', args: { url: final.url } }] }).passed, false);
  assert.equal(task('wikipedia-autocomplete').check({ ...evidence, snapshots: [final] }).passed, false);
  assert.equal(task('wikipedia-autocomplete').check({ ...evidence, answer: 'Albert Einstein “Albert Einstein developed the theory of relativity.”' }).passed, false);
  assert.equal(task('wikipedia-autocomplete').check({ ...evidence, currentSnapshots: [] }).passed, false);
});

test('news modal dismissal requires successful ordered modal, Escape, fresh home, bound article click and observed byline', () => {
  const headline = 'How ChatGPT Targets Ads To You Based On Your Prompts, Phone Number, and Email';
  const url = 'https://www.404media.co/how-chatgpt-targets-ads-to-you-based-on-your-prompts-phone-number-and-email/';
  const modalControls = [{ role: 'textbox', name: 'Name' }, { role: 'textbox', name: 'Email' }, { role: 'button', name: 'Close popup' }];
  const before = snapshot('https://www.404media.co/', 'Newsletter signup', { snapshotId: 'modal-before', tabId: 'news', elements: modalControls });
  const after = snapshot('https://www.404media.co/', headline, { snapshotId: 'home-after', tabId: 'news', elements: [{ ref: 'article', role: 'link', name: headline, href: url }] });
  const article = snapshot(url, `${headline}\nJOSEPH COX\nOpenAI lets advertisers target ChatGPT users based on their email addresses.`, { tabId: 'news', title: headline, elements: [{ role: 'link', name: 'Joseph Cox', href: 'https://www.404media.co/author/joseph-cox/' }] });
  const calls = [{ callId: 'modal-read', tool: 'browser_snapshot', args: { tabId: 'news' } }, { callId: 'dismiss', tool: 'browser_press', args: { tabId: 'news', key: 'Escape', snapshotId: 'modal-before' } }, { callId: 'home-read', tool: 'browser_snapshot', args: { tabId: 'news' } }, { callId: 'article-click', tool: 'browser_click', args: { tabId: 'news', snapshotId: 'home-after', ref: 'article' } }];
  const evidence = { snapshots: [before, after, article], currentSnapshots: [article], tabs: [article], calls, snapshotReceipts: [{ snapshotId: 'modal-before', callId: 'modal-read' }, { snapshotId: 'home-after', callId: 'home-read' }], answer: `${headline} Joseph Cox “OpenAI lets advertisers target ChatGPT users based on their email addresses.”` };
  assert.equal(task('news-modal-dismissal').check(evidence).passed, true);
  const blockquote = { ...evidence, answer: `${headline} Joseph Cox\n\n> OpenAI lets advertisers target ChatGPT users based on their email addresses.` };
  assert.equal(task('news-modal-dismissal').check(blockquote).passed, true);
  for (const quote of [headline, 'JOSEPH COX', 'OpenAI lets advertisers invent unobserved targeting data.']) assert.equal(task('news-modal-dismissal').check({ ...blockquote, answer: `${headline} Joseph Cox\n\n> ${quote}` }).passed, false);
  for (const headingQuote of [headline, 'How ChatGPT Targets Ads To You']) assert.equal(task('news-modal-dismissal').check({ ...evidence, answer: `${headline} Joseph Cox “${headingQuote}” “OpenAI lets advertisers invent unobserved targeting data.”` }).passed, false);
  assert.equal(task('news-modal-dismissal').check({ ...evidence, answer: `${headline} Joseph Cox “JOSEPH COX”` }).passed, false);
  assert.equal(task('news-modal-dismissal').check({ ...evidence, snapshotReceipts: [] }).passed, false);
  assert.equal(task('news-modal-dismissal').check({ ...evidence, calls: calls.filter(c => c.callId !== 'dismiss') }).passed, false);
  assert.equal(task('news-modal-dismissal').check({ ...evidence, calls: [calls[0], calls[2], calls[1], calls[3]] }).passed, false);
  assert.equal(task('news-modal-dismissal').check({ ...evidence, snapshots: [before, { ...after, elements: [...after.elements, ...modalControls] }, article] }).passed, false);
  assert.equal(task('news-modal-dismissal').check({ ...evidence, calls: [...calls.slice(0, 3), { tool: 'browser_open', args: { url } }] }).passed, false);
  assert.equal(task('news-modal-dismissal').check({ ...evidence, answer: `${headline} “OpenAI lets advertisers target ChatGPT users based on their email addresses.”` }).passed, false);
  assert.equal(task('news-modal-dismissal').check({ ...evidence, currentSnapshots: [] }).passed, false);
});

test('law requires a bound GET search and opening an observed result, with the exact effective date in source DOM', () => {
  const source = snapshot('https://www.law.go.kr/LSW/lsSc.do', '대한민국헌법 검색 결과', { snapshotId: 'law-results', elements: [{ ref: 'query', role: 'textbox', name: '검색어 입력', value: '대한민국헌법', formMethod: 'get', formAction: 'https://www.law.go.kr/LSW/lsSc.do' }, { ref: 'constitution', role: 'link', name: '대한민국헌법', href: 'https://www.law.go.kr/법령/대한민국헌법' }] });
  const statute = snapshot('https://www.law.go.kr/법령/대한민국헌법', '대한민국헌법\n[시행 1988. 2. 25.]\n제1조 ① 대한민국은 민주공화국이다.\n② 대한민국의 주권은 국민에게 있고, 모든 권력은 국민으로부터 나온다.', { snapshotId: 'statute' });
  const evidence = { snapshots: [statute, source], currentSnapshots: [statute], tabs: [statute], calls: [typeIn(source, 'query', '대한민국헌법', true), { tool: 'browser_click', args: { tabId: source.tabId, snapshotId: source.snapshotId, ref: 'constitution' } }], answer: '1988년 2월 25일 대한민국은 민주공화국이다. 대한민국의 주권은 국민에게 있고, 모든 권력은 국민으로부터 나온다.' };
  assert.equal(task('law-statute-frame').check(evidence).passed, true);
  assert.equal(task('law-statute-frame').check({ ...evidence, answer: evidence.answer.replace('1988년 2월 25일', '1988-02-25') }).passed, true);
  const read = { callId: 'law-results-read', tool: 'browser_snapshot', args: { tabId: 'tab' } };
  const navigate = { tool: 'browser_navigate', args: { tabId: 'tab', url: source.elements[1].href } };
  const resultReceipts = [{ snapshotId: source.snapshotId, callId: read.callId }];
  assert.equal(task('law-statute-frame').check({ ...evidence, calls: [read, evidence.calls[0], navigate], snapshotReceipts: resultReceipts }).passed, true);
  const queryBefore = { ...source, snapshotId: 'query-before', url: 'https://www.law.go.kr/LSW/main.html', elements: [source.elements[0]] };
  assert.equal(task('law-statute-frame').check({ ...evidence, snapshots: [queryBefore, statute, source], calls: [typeIn(queryBefore, 'query', '대한민국헌법', true), navigate, read], snapshotReceipts: resultReceipts }).passed, false);
  assert.equal(task('law-statute-frame').check({ ...evidence, calls: [] }).passed, false);
  const noResult = { ...source, elements: [source.elements[0]] };
  assert.equal(task('law-statute-frame').check({ ...evidence, snapshots: [statute, noResult], calls: [evidence.calls[0], { tool: 'browser_navigate', args: { tabId: 'tab', url: source.elements[1].href } }] }).passed, false);
  const wrongDate = { ...statute, text: statute.text.replace('[시행 1988. 2. 25.]', '[시행 2000. 1. 1.] 1988년은 개정 이력이다.') };
  assert.equal(task('law-statute-frame').check({ ...evidence, snapshots: [wrongDate, source], currentSnapshots: [wrongDate] }).passed, false);
});

test('Naver accepts recorded browser_type submit:true and combobox semantics with snapshot-bound title clicks', () => {
  // These argument/role/wrapper shapes occurred in the retained Claude r1 recording.
  // Content is trimmed fixture data, not a reconstruction of its missing oversized result.
  const search = snapshot('https://search.naver.com/search.naver', '한글날\n관련정보\nnamu.wiki›한글날\n새 창 열림\n한글날 - 나무위키\nwww.hangeul.go.kr›exhibition\n새 창 열림\n기획특별전\n네이버 클립', { snapshotId: 'bound-search', tabId: 'naver', elements: [{ ref: 'e7', role: 'combobox', name: '검색어 입력', value: '한글날 10월 9일', formMethod: 'get', formAction: 'https://search.naver.com/search.naver' }, { ref: 'e53', role: 'link', name: '한글날 - 나무위키새 창 열림' }, { ref: 'e71', role: 'link', href: 'https://www.hangeul.go.kr/exhibition/676', name: '기획특별전새 창 열림' }] });
  const currentSearch = { ...search, snapshotId: 'afterturn-search' };
  const destination = snapshot('https://www.hangeul.go.kr/exhibition/676', '국립한글박물관의 기획전시에서 확인한 독립적인 사실 문장입니다. '.repeat(5), { tabId: 'museum' });
  const evidence = { currentSnapshots: [currentSearch, destination], snapshots: [currentSearch, destination], tabs: [currentSearch, destination], calls: [{ tool: 'browser_type', args: { tabId: 'naver', snapshotId: 'bound-search', ref: 'e7', text: '한글날 10월 9일', submit: true, intent: 'search', snapshot: false } }, { tool: 'browser_click', args: { tabId: 'naver', snapshotId: 'bound-search', ref: 'e71', navigationEpoch: 4, controllerEpoch: 1, snapshot: false } }], toolResults: [{ tool: 'browser_wait', ok: true, resultPreview: JSON.stringify([{ type: 'text', text: JSON.stringify({ ok: true, action: 'wait', snapshot: search }) }]) }], answer: '기획특별전 https://www.hangeul.go.kr/exhibition/676 “국립한글박물관의 기획전시에서 확인한 독립적인 사실 문장입니다.”' };
  assert.equal(task('naver-second-result').check(evidence).passed, true);
  assert.equal(task('naver-second-result').check({ ...evidence, calls: [{ ...evidence.calls[0], args: { ...evidence.calls[0].args, submit: false } }, evidence.calls[1]] }).passed, false);
  assert.equal(task('naver-second-result').check({ ...evidence, toolResults: [] }).passed, false);
});

test('interaction proof requires a matching successful receipt and rejects nested failures', () => {
  const source = tableFixture([['Afghanistan', '43,844,111'], ['Albania', '2,402,113'], ['Algeria', '47,400,000']]);
  const call = { tool: 'browser_click', callId: 'sort-click', args: { tabId: 'tab', ref: 'header', snapshotId: 'snapshot' } };
  const evidence = { ...sortFixture(source), calls: [...sortFixture(source).calls.slice(0, 1), call], answer: 'Afghanistan 43,844,111 Albania 2,402,113 Algeria 47,400,000' };
  const checker = rawTask('wikipedia-sortable-table');
  assert.equal(checker.check({ ...evidence, toolResults: [{ callId: 'before-read', ok: true }, { callId: 'sort-click', ok: true, resultPreview: '{"ok":true}' }] }).passed, true);
  const rejected = [
    [],
    [{ callId: 'another-click', ok: true }],
    [{ callId: 'sort-click', ok: false, resultPreview: 'BROWSER_REF_NOT_FOUND: Invalid reference' }],
    [{ callId: 'sort-click', ok: true, resultPreview: JSON.stringify({ result: { isError: true, content: [{ type: 'text', text: 'BROWSER_REF_NOT_FOUND: Invalid reference' }] } }) }],
    [{ callId: 'sort-click', ok: true, resultPreview: JSON.stringify([{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'BROWSER_REF_NOT_FOUND' } }) }]) }],
  ];
  for (const toolResults of rejected) assert.equal(checker.check({ ...evidence, toolResults: [{ callId: 'before-read', ok: true }, ...toolResults] }).passed, false);
});

test('SDK oversized success notices require verified attachment provenance for the same call', () => {
  const source = tableFixture([['Afghanistan', '43,844,111'], ['Albania', '2,402,113'], ['Algeria', '47,400,000']]);
  const notice = 'Error: result (138,485 characters across 1 line) exceeds maximum allowed tokens. Output has been saved to /tmp/provider-session/home/.claude/projects/session/tool-results/mcp-rhwp-browser_click-1792095338916.txt.\nFormat: Plain text\nSearch within the file for relevant content.';
  const receipt = { callId: 'click', ok: true, resultPreview: notice };
  const evidence = { ...sortFixture(source), calls: [...sortFixture(source).calls.slice(0, 1), { tool: 'browser_click', callId: 'click', args: { tabId: 'tab', ref: 'header', snapshotId: 'snapshot' } }], toolResults: [{ callId: 'before-read', ok: true }, receipt], answer: 'Afghanistan 43,844,111 Albania 2,402,113 Algeria 47,400,000' };
  const checker = rawTask('wikipedia-sortable-table');
  assert.equal(checker.check(evidence).passed, false);
  assert.equal(checker.check({ ...evidence, verifiedAttachmentCallIds: ['another-call'] }).passed, false);
  assert.equal(checker.check({ ...evidence, verifiedAttachmentCallIds: ['click'] }).passed, true);
  assert.equal(checker.check({ ...evidence, verifiedAttachmentCallIds: ['click'], toolResults: [{ callId: 'before-read', ok: true }, { ...receipt, result: { isError: true } }] }).passed, false);
  assert.equal(checker.check({ ...evidence, verifiedAttachmentCallIds: ['click'], toolResults: [{ callId: 'before-read', ok: true }, { ...receipt, resultPreview: 'Error: BROWSER_STALE_NAVIGATION: Take a new snapshot.' }] }).passed, false);
  assert.equal(checker.check({ ...evidence, verifiedAttachmentCallIds: ['click'], toolResults: [{ callId: 'before-read', ok: true }, { ...receipt, ok: false }] }).passed, false);
});

test('autocomplete accepts exact label components and a successful option selection without losing later scientific quotes', () => {
  const label = 'Albert EinsteinGerman-born theoretical physicist (1879–1955)';
  const source = snapshot('https://en.wikipedia.org/wiki/Main_Page', 'Search', { snapshotId: 'suggestions', tabId: 'wiki', elements: [{ ref: 'q', role: 'combobox', name: 'Search Wikipedia', value: 'Albert Eins', formMethod: 'get', formAction: 'https://en.wikipedia.org/w/index.php' }, { tag: 'li', role: 'option', ref: 'option', name: label }, { tag: 'a', role: 'link', ref: 'anchor', name: label, href: 'https://en.wikipedia.org/wiki/Albert_Einstein' }] });
  const scientific = 'In 1905, he published four groundbreaking papers.';
  const final = snapshot('https://en.wikipedia.org/wiki/Albert_Einstein', 'Albert Einstein. ' + scientific, { tabId: 'wiki' });
  const evidence = { snapshots: [source, final], currentSnapshots: [final], tabs: [final], calls: [typeIn(source, 'q', 'Albert Eins'), { tool: 'browser_click', args: { tabId: 'wiki', snapshotId: 'suggestions', ref: 'option' } }], answer: `“Albert Einstein” — “German-born theoretical physicist (1879–1955)”. Scientific work: “${scientific}”` };
  assert.equal(task('wikipedia-autocomplete').check(evidence).passed, true);
  for (const answer of [evidence.answer.replace('theoretical physicist', 'artist'), evidence.answer.replace(scientific, 'Albert Einstein was born in Germany.'), evidence.answer.replace(scientific, 'He published a popular travel book.'), evidence.answer.replace(scientific, scientific + ' Added invented words.')]) assert.equal(task('wikipedia-autocomplete').check({ ...evidence, answer }).passed, false);
  for (const nonscientific of ['Albert Einstein was born in Germany.', 'He published a popular travel book.']) {
    const observed = { ...final, text: nonscientific };
    assert.equal(task('wikipedia-autocomplete').check({ ...evidence, snapshots: [source, observed], currentSnapshots: [observed], answer: evidence.answer.replace(scientific, nonscientific) }).passed, false);
  }
  assert.equal(task('wikipedia-autocomplete').check({ ...evidence, calls: [evidence.calls[0], { ...evidence.calls[1], args: { ...evidence.calls[1].args, ref: 'foreign' } }] }).passed, false);
  const failed = successfulFixture(evidence); failed.toolResults[1].ok = false;
  assert.equal(rawTask('wikipedia-autocomplete').check(failed).passed, false);
});

test('paired quotes preserve literal source requirements after short labels', () => {
  const repo = snapshot('https://github.com/microsoft/playwright', 'Star 100k', { tabId: 'repo' });
  const sentence = 'This release improves browser automation.';
  const release = snapshot('https://github.com/microsoft/playwright/releases/tag/v1.2.3', `Latest ${sentence} ${sentence} ${sentence}`, { title: 'Release v1.2.3 · microsoft/playwright · GitHub' });
  const evidence = { snapshots: [repo, release], currentSnapshots: [repo, release], tabs: [repo, release], answer: `100k “v1.2.3” “Latest” “${sentence}”` };
  assert.equal(task('github-stars-release').check(evidence).passed, true);
  const blockquote = { ...evidence, answer: `100k v1.2.3\n\n> ${sentence}` };
  assert.equal(task('github-stars-release').check(blockquote).passed, true);
  assert.equal(task('github-stars-release').check({ ...blockquote, answer: blockquote.answer.replace('improves', 'breaks') }).passed, false);
  assert.equal(task('github-stars-release').check({ ...evidence, answer: evidence.answer.replace(sentence, sentence + '.') }).passed, false);
});

test('CommonMark ASCII punctuation escapes in answers preserve exact Naver words and source facts', () => {
  const title = 'Second <result>';
  const search = snapshot('https://search.naver.com/search.naver', `한글날\n관련정보\nfirst.example.org›one\nFirst result\nsecond.example.org›two\n${title}\n네이버 클립`, { tabId: 'search', elements: [{ ref: 'query', role: 'textbox', name: '검색어 입력', value: '한글날 10월 9일', formMethod: 'get', formAction: 'https://search.naver.com/search.naver' }, { role: 'link', name: 'First result', ref: 'first' }, { role: 'link', name: title, ref: 'second', href: 'https://second.example.org/two' }] });
  const destination = snapshot('https://second.example.org/two', 'A factual source sentence with <literal> punctuation. '.repeat(3), { tabId: 'destination' });
  const evidence = { snapshots: [search, destination], currentSnapshots: [search, destination], tabs: [search, destination], calls: [typeIn(search, 'query', '한글날 10월 9일', true), { tool: 'browser_click', args: { tabId: search.tabId, ref: 'second', snapshotId: search.snapshotId } }], answer: 'Second \\<result\\> https://second.example.org/two “A factual source sentence with \\<literal\\> punctuation.”' };
  assert.equal(task('naver-second-result').check(evidence).passed, true);
  assert.equal(task('naver-second-result').check({ ...evidence, answer: evidence.answer.replace('literal', 'invented') }).passed, false);
  assert.equal(task('naver-second-result').check({ ...evidence, answer: evidence.answer.replace('Second', 'Secon\\d') }).passed, false);
});


test('Korean three-hop navigation requires each successful article-link ref in order and a literal infobox quote', () => {
  const path = ['대한민국', '서울특별시', '한강', '황해'];
  const pages = path.map((title, i) => snapshot(`https://ko.wikipedia.org/wiki/${encodeURIComponent(title)}`, i === 3 ? '황해\n평균 수심\t45 m\n수면 면적\t380,000km²' : title, { snapshotId: `hop-${i}`, tabId: 'wiki', elements: i < 3 ? [{ ref: 'next', role: 'link', name: path[i + 1], href: `https://ko.wikipedia.org/wiki/${encodeURIComponent(path[i + 1])}` }] : [] }));
  const calls = pages.slice(0, 3).map(page => ({ tool: 'browser_click', args: { tabId: 'wiki', snapshotId: page.snapshotId, ref: 'next' } }));
  const evidence = { snapshots: pages, currentSnapshots: [pages[3]], tabs: [pages[3]], calls, answer: `${path.join(' → ')} “평균 수심 45 m”` };
  assert.equal(task('korean-wikipedia-three-hop').check(evidence).passed, true);
  assert.equal(task('korean-wikipedia-three-hop').check({ ...evidence, answer: path.join(' → ') + '\n\n> 평균 수심\t45 m' }).passed, true);
  assert.equal(task('korean-wikipedia-three-hop').check({ ...evidence, answer: path.join(' → ') + ' 평균 수심 45 m' }).passed, false);
  assert.equal(task('korean-wikipedia-three-hop').check({ ...evidence, answer: path.join(' → ') + ' “평균 수심 46 m”' }).passed, false);
  assert.equal(task('korean-wikipedia-three-hop').check({ ...evidence, calls: [click, click, click] }).passed, false);
  assert.equal(task('korean-wikipedia-three-hop').check({ ...evidence, calls: [...calls].reverse() }).passed, false);
  assert.equal(task('korean-wikipedia-three-hop').check({ ...evidence, calls: calls.map(call => ({ ...call, args: { ...call.args, tabId: 'foreign' } })) }).passed, false);
  const wrong = { ...pages[1], elements: [{ ...pages[1].elements[0], href: 'https://ko.wikipedia.org/wiki/제주도' }] };
  assert.equal(task('korean-wikipedia-three-hop').check({ ...evidence, snapshots: [pages[0], wrong, ...pages.slice(2)] }).passed, false);
  const failed = successfulFixture(evidence); failed.toolResults[1].ok = false;
  assert.equal(rawTask('korean-wikipedia-three-hop').check(failed).passed, false);
});

test('GitHub answer must include the independently observed release heading, not just its URL tag', () => {
  const repo = snapshot('https://github.com/microsoft/playwright', 'Star 100k', { tabId: 'repo' });
  const quote = 'This release improves browser automation.';
  const release = snapshot('https://github.com/microsoft/playwright/releases/tag/v1.2.3', `Latest ${quote} ${quote} ${quote}`, { tabId: 'release', title: 'Release Browser automation improvements · microsoft/playwright · GitHub' });
  const evidence = { snapshots: [repo, release], currentSnapshots: [repo, release], tabs: [repo, release], answer: `100k v1.2.3 Browser automation improvements “${quote}”` };
  assert.equal(task('github-stars-release').check(evidence).passed, true);
  assert.equal(task('github-stars-release').check({ ...evidence, answer: `100k v1.2.3 “${quote}”` }).passed, false);
});


test('blockquote facts stay on one line and preserve literal punctuation and source provenance', () => {
  const evidence = docsFixture();
  const source = evidence.currentSnapshots[1];
  const sentence = "Playwright's browser automation runs on Chromium.";
  const observed = { ...source, text: sentence };
  const current = { ...evidence, snapshots: [evidence.snapshots[0], observed], currentSnapshots: [evidence.currentSnapshots[0], observed], answer: `microsoft/playwright\n\n> ${sentence}` };
  assert.equal(task('docs-target-blank').check(current).passed, true);
  assert.equal(task('docs-target-blank').check({ ...current, answer: current.answer.replace("Playwright's", 'Playwright’s') }).passed, false);
  assert.equal(task('docs-target-blank').check({ ...current, answer: `microsoft/playwright\n\n> Playwright's\n> browser\n> automation\n> runs on\n> Chromium.` }).passed, false);
  assert.equal(task('docs-target-blank').check({ ...current, currentSnapshots: [evidence.currentSnapshots[0], { ...observed, text: 'The current README no longer contains that fact.' }] }).passed, false);
});

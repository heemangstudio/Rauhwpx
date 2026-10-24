/**
 * 사용량 구역의 보기 전환(한도/토큰)과 토큰 보기. 한도 카드는 settings.ts 가 그대로 그린다.
 */
import './token-usage.css';
import type { SidebarBridge } from '../../agent/bridge.ts';
import type { TokenUsageAgent, TokenUsageDays, TokenUsageReport } from '../../agent/types.ts';
import { createIcon } from './icons.ts';
import { createProviderIcon } from './providers.ts';
import { AGENT_NAME, createTokenUsageChart } from './token-usage-chart.ts';
import { formatCompact } from './token-usage-format.ts';

export type UsageView = 'limits' | 'tokens';

const VIEW_KEY = 'rhwp-settings-usage-view';
const DAYS_KEY = 'rhwp-settings-token-days';
const ORDER: TokenUsageAgent[] = ['claude', 'codex', 'pi'];

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function stored(key: string): string | null {
  try { return sessionStorage.getItem(key); } catch { return null; }
}

function store(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* 저장소가 막혀도 보기는 바뀐다. */ }
}

function select(label: string, options: ReadonlyArray<readonly [string, string]>, value: string): HTMLSelectElement {
  const element = node('select', 'ag-settings-select ag-token-usage-select');
  element.setAttribute('aria-label', label);
  for (const [id, text] of options) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = text;
    element.append(option);
  }
  element.value = value;
  // 테두리 없이, 키보드로 옮겨 온 초점만 옅은 채움으로 보인다.
  element.addEventListener('pointerdown', () => { element.dataset.pointerFocus = ''; });
  element.addEventListener('blur', () => { delete element.dataset.pointerFocus; });
  return element;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createUsageViews(bridge: SidebarBridge, options: { section: HTMLElement; refreshLimits: () => void }) {
  let view: UsageView = stored(VIEW_KEY) === 'tokens' ? 'tokens' : 'limits';
  const savedDays = Number(stored(DAYS_KEY));
  let days: TokenUsageDays = savedDays === 7 || savedDays === 90 ? savedDays : 30;
  let active = false;
  let limitsRefreshing = false;
  let loading = false;
  let loadingDays: TokenUsageDays | null = null;
  let failed = false;
  let sequence = 0;
  let shown: TokenUsageReport | null = null;
  const reports = new Map<TokenUsageDays, { report: TokenUsageReport; at: number }>();

  const controls = node('div', 'ag-token-usage-controls');
  const viewSelect = select('사용량 보기', [['limits', '한도'], ['tokens', '토큰']], view);
  // 한도와 토큰의 글자 폭이 달라 바꿀 때 자리가 흔들리지 않게 폭을 고정한다.
  viewSelect.classList.add('ag-token-usage-view-select');
  const daysSelect = select('기간', [['7', '7일'], ['30', '30일'], ['90', '90일']], String(days));
  const refreshButton = node('button', 'ag-settings-quota-refresh ag-token-usage-refresh');
  refreshButton.type = 'button';
  refreshButton.append(createIcon('refresh'));
  controls.append(daysSelect, viewSelect, refreshButton);

  const element = node('div', 'ag-token-usage');
  const chart = createTokenUsageChart();

  viewSelect.addEventListener('change', () => {
    view = viewSelect.value === 'tokens' ? 'tokens' : 'limits';
    store(VIEW_KEY, view);
    render();
    if (view === 'tokens') ensure();
  });
  daysSelect.addEventListener('change', () => {
    const next = Number(daysSelect.value);
    days = next === 7 || next === 90 ? next : 30;
    store(DAYS_KEY, String(days));
    ensure();
    render();
  });
  refreshButton.addEventListener('click', () => {
    if (view === 'limits') options.refreshLimits();
    else void load(true);
  });

  /** 같은 기간을 5분 안에 다시 열면 받아 둔 값을 쓴다. */
  function ensure() {
    if (!active || view !== 'tokens') return;
    const cached = reports.get(days);
    if (cached && Date.now() - cached.at < 5 * 60_000) return;
    if (loading && loadingDays === days) return;
    void load(false);
  }

  async function load(refresh: boolean) {
    const id = ++sequence;
    const period = days;
    loadingDays = period;
    loading = true;
    failed = false;
    render();
    const report = await bridge.requestTokenUsage(period, refresh).catch(() => null);
    if (id !== sequence) return;
    loading = false;
    loadingDays = null;
    if (report) reports.set(period, { report, at: Date.now() });
    else failed = true;
    render();
  }

  function render() {
    options.section.dataset.usageView = view;
    daysSelect.hidden = view !== 'tokens';
    const busy = view === 'limits' ? limitsRefreshing : loading;
    const title = view === 'limits' ? '한도 새로고침' : '토큰 사용량 새로고침';
    refreshButton.title = title;
    refreshButton.setAttribute('aria-label', title);
    refreshButton.disabled = busy;
    refreshButton.setAttribute('aria-busy', String(busy));
    if (view !== 'tokens') return;
    const report = reports.get(days)?.report ?? (loading ? shown : null);
    element.setAttribute('aria-busy', String(loading));
    element.dataset.state = report ? (loading ? 'updating' : 'ready') : loading ? 'loading' : 'failed';
    if (!report) {
      shown = null;
      element.replaceChildren(loading ? skeleton() : node('p', 'ag-settings-note ag-token-usage-error', '토큰 기록 불러오기 실패'));
      return;
    }
    if (report === shown) {
      element.querySelector('.ag-token-usage-error[data-request]')?.remove();
      if (failed) element.prepend(requestError());
      return;
    }
    const animate = shown === null && !reducedMotion();
    shown = report;
    element.replaceChildren(...content(report, animate));
  }

  function requestError() {
    const line = node('p', 'ag-settings-note ag-token-usage-error', '새로고침 실패, 이전 기록 표시');
    line.dataset.request = '';
    return line;
  }

  function skeleton() {
    const root = node('div', 'ag-token-usage-skeleton');
    root.setAttribute('aria-label', '토큰 기록 읽는 중');
    root.append(node('span', 'ag-token-skeleton-total'), node('span', 'ag-token-skeleton-line'));
    for (let i = 0; i < 2; i++) root.append(node('span', 'ag-token-skeleton-row'));
    root.append(node('span', 'ag-token-skeleton-chart'));
    return root;
  }

  function content(report: TokenUsageReport, animate: boolean): HTMLElement[] {
    const parts: HTMLElement[] = [];
    if (failed) parts.push(requestError());
    for (const error of report.errors ?? []) parts.push(node('p', 'ag-settings-note ag-token-usage-error', error));
    const providers = [...report.providers]
      .filter((provider) => provider.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens || ORDER.indexOf(a.agent) - ORDER.indexOf(b.agent));
    if (!providers.length) {
      parts.push(node('p', 'ag-token-usage-empty', '이 기간의 토큰 기록 없음'));
      return parts;
    }
    const summary = node('div', 'ag-token-usage-summary');
    summary.append(node('div', 'ag-token-usage-total', formatCompact(report.totalTokens)));
    parts.push(summary);
    const list = node('ul', 'ag-token-usage-providers');
    for (const provider of providers) {
      const row = node('li', 'ag-token-usage-provider');
      row.dataset.agent = provider.agent;
      const name = node('div', 'ag-token-usage-provider-name');
      name.append(node('span', 'ag-token-dot'), createProviderIcon(provider.agent), node('span', 'ag-token-usage-provider-label', AGENT_NAME[provider.agent]));
      row.append(name, node('div', 'ag-token-usage-provider-total', formatCompact(provider.tokens)));
      list.append(row);
    }
    parts.push(list);
    chart.update(report, ORDER.filter((agent) => providers.some((provider) => provider.agent === agent)), animate);
    parts.push(chart.element);
    return parts;
  }

  render();

  return {
    controls,
    element,
    /** 사용량 구역이 보일 때만 토큰 기록을 읽는다. */
    setActive(next: boolean) {
      active = next;
      ensure();
    },
    setLimitsRefreshing(next: boolean) {
      limitsRefreshing = next;
      render();
    },
    dispose() {
      active = false;
      sequence += 1;
      chart.dispose();
    },
  };
}

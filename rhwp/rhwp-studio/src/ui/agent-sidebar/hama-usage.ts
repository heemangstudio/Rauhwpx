/**
 * Hama 사용량 — 입력기 줄 Hama 표 안의 작은 고리(가장 빠듯한 창)와 설정 패널의 '사용량' 묶음(5시간·주간·월간).
 * Hama 를 고른 동안만 보인다. 입력기 줄에는 숫자를 두지 않는다 — 줄 폭이 사용량에 따라 출렁이지 않고, 숫자와
 * 초기화까지 남은 시간은 패널(과 고리의 툴팁)에 있다. 카운트다운은 분 경계에 한 번씩만 다시 그리고, 숨으면 멈춘다.
 */
import type { HamaCap, HamaStatus } from '../../agent/types.ts';
import './hama-harness.css';
import {
  bindingWindow,
  formatResetIn,
  hamaGauge,
  msToNextMinute,
  type HamaGaugeWindow,
} from './hama-harness.ts';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CAP_LABEL: Record<HamaCap, string> = { cap_5h: '5시간', cap_week: '주간', cap_month: '월간' };

export interface HamaUsageView {
  /** 입력기 줄 Hama 표 안의 고리(가장 빠듯한 창). 막히면 빨강이다. */
  readonly meter: HTMLSpanElement;
  /** 설정 패널의 '사용량' 묶음. */
  readonly group: HTMLElement;
  /** 상태와 보임 여부를 반영한다. 보이지 않으면 타이머를 멈춘다. */
  update(status: HamaStatus | null, visible: boolean): void;
  dispose(): void;
}

function span(className: string, text?: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function ring(): { svg: SVGSVGElement; fill: SVGCircleElement } {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ag-hama-ring');
  svg.setAttribute('viewBox', '0 0 12 12');
  svg.setAttribute('aria-hidden', 'true');
  const circle = (className: string) => {
    const node = document.createElementNS(SVG_NS, 'circle');
    node.setAttribute('class', className);
    node.setAttribute('cx', '6');
    node.setAttribute('cy', '6');
    node.setAttribute('r', '4.5');
    node.setAttribute('pathLength', '100');
    svg.append(node);
    return node;
  };
  circle('ag-hama-ring-track');
  return { svg, fill: circle('ag-hama-ring-fill') };
}

export function createHamaUsage(options: { now?: () => number } = {}): HamaUsageView {
  const now = options.now ?? Date.now;
  const meter = span('ag-hama-meter');
  meter.hidden = true;
  const { svg, fill } = ring();
  meter.append(svg);

  const group = document.createElement('div');
  group.className = 'ag-config-group ag-hama-usage';
  group.hidden = true;
  const rows = document.createElement('div');
  rows.className = 'ag-hama-usage-rows';
  const label = span('ag-config-label', '사용량');
  group.append(label, rows);

  let windows: HamaGaugeWindow[] = [];
  let shown = false;
  let timer: number | null = null;

  function stopTimer(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  }

  function schedule(): void {
    stopTimer();
    if (!shown || document.hidden || !windows.some((entry) => entry.resetsAt !== null)) return;
    timer = window.setTimeout(() => {
      timer = null;
      paint();
      schedule();
    }, msToNextMinute(now()));
  }

  function paint(): void {
    const at = now();
    const binding = bindingWindow(windows);
    if (binding) {
      const resetIn = binding.blocked ? formatResetIn(binding.resetsAt, at) : null;
      meter.dataset.blocked = binding.blocked ? 'true' : 'false';
      fill.style.strokeDasharray = `${binding.percent} 100`;
      meter.title = resetIn
        ? `${CAP_LABEL[binding.cap]} 한도 도달 · ${resetIn} 후 초기화`
        : `${CAP_LABEL[binding.cap]} ${binding.percent}%`;
    }
    rows.replaceChildren(...windows.map((entry) => {
      const row = span('ag-hama-usage-row');
      row.dataset.cap = entry.cap;
      if (entry.blocked) row.dataset.blocked = 'true';
      const bar = span('ag-hama-usage-bar');
      const barFill = span('ag-hama-usage-fill');
      barFill.style.width = `${entry.percent}%`;
      bar.append(barFill);
      const resetIn = formatResetIn(entry.resetsAt, at);
      row.append(
        span('ag-hama-usage-name', CAP_LABEL[entry.cap]),
        bar,
        span('ag-hama-usage-pct', `${entry.percent}%`),
        span('ag-hama-usage-reset', resetIn ? `${resetIn} 후 초기화` : ''),
      );
      return row;
    }));
  }

  const onVisibility = () => {
    if (document.hidden) stopTimer();
    else if (shown) {
      paint();
      schedule();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    meter,
    group,
    update(status, visible) {
      windows = hamaGauge(status);
      shown = visible && windows.length > 0;
      meter.hidden = !shown;
      group.hidden = !shown;
      if (shown) paint();
      schedule();
    },
    dispose() {
      stopTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

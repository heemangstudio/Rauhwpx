/**
 * agent-live-suite.mjs 결과(JSON) 여러 개를 과제별로 나란히 비교한다.
 *
 * 실행: node bench/agent-live-compare.mjs a.json b.json [c.json …]
 * 과제마다 실행 평균: 벽시계 초, 모델 요청, 도구 호출, 실패한 호출, 점수, 비용.
 */
import fs from 'node:fs';
import path from 'node:path';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (files.length < 1) {
  console.error('usage: node bench/agent-live-compare.mjs a.json b.json [c.json …]');
  process.exit(2);
}

// 브라우저 과제는 성공한 3회·같은 날짜·같은 과제 정의로만 속도를 비교한다.
const browserInputs = files.map((file) => ({ file, data: JSON.parse(fs.readFileSync(file, 'utf8')) }));
if (browserInputs.some(({ data }) => data.meta?.taskDefinitionHash)) {
  if (!browserInputs.every(({ data }) => data.meta?.taskDefinitionHash)) {
    console.error('Browser and document benchmark files must be compared separately.');
    process.exit(2);
  }
  const { summarizeBrowserRuns, compareBrowserRuns } = await import('./browser-agent-suite.mjs');
  const scorecard = {
    sources: browserInputs.map(({ file, data }) => ({
      file: path.resolve(file), label: data.meta.round ?? data.meta.label,
      summaries: summarizeBrowserRuns(data.runs ?? []),
    })),
    comparisons: browserInputs.slice(1).map(({ file, data }) => ({
      baseline: path.resolve(browserInputs[0].file), candidate: path.resolve(file),
      ...compareBrowserRuns(browserInputs[0].data, data),
    })),
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(scorecard, null, 2));
  else {
    console.table(scorecard.sources.flatMap((source) => source.summaries.map((row) => ({
      source: source.label, task: row.task, arm: row.arm, passed: row.passed + '/' + row.runs,
      blocked: row.blocked, failed: row.failed, medianMs: row.medianWallMs,
      invalid: row.invalidCalls, clickFailures: row.clickFailures, navigationFailures: row.navigationFailures,
      actualCostUsd: row.costUsd, pendingUsd: row.pendingReservationUsd,
    }))));
    for (const comparison of scorecard.comparisons) {
      console.log(path.basename(comparison.candidate));
      console.table(comparison.arms);
    }
  }
  process.exit(0);
}

const mean = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const fmt = (v, digits = 1) => (v === null ? '-' : v.toFixed(digits));

const sources = files.map((file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const meta = data.meta ?? {};
  const label = `${meta.agent ?? '?'}:${String(meta.model ?? '?').split('/').pop()}${meta.effort ? `@${meta.effort}` : ''}`;
  const byTask = new Map();
  for (const run of data.runs ?? []) {
    if (!byTask.has(run.task)) byTask.set(run.task, []);
    byTask.get(run.task).push(run);
  }
  return { file: path.basename(file), label, byTask };
});

const tasks = [...new Set(sources.flatMap((s) => [...s.byTask.keys()]))];
const columns = [
  ['wall s', (rows) => fmt(mean(rows.map((r) => r.wallMs / 1000)))],
  ['req', (rows) => fmt(mean(rows.map((r) => r.modelRequests)))],
  ['tools', (rows) => fmt(mean(rows.map((r) => r.toolCalls)))],
  ['failed', (rows) => fmt(mean(rows.map((r) => r.failedToolCalls)))],
  ['score', (rows) => fmt(mean(rows.map((r) => r.score)), 2)],
  ['cost $', (rows) => fmt(mean(rows.map((r) => (r.costUsd === null || r.costUsd === undefined ? NaN : Number(r.costUsd)))), 4)],
  ['n', (rows) => String(rows.filter((r) => r.status !== 'harness-error').length)],
];

const header = ['task', 'source', ...columns.map(([name]) => name)];
const lines = [];
for (const task of tasks) {
  for (const source of sources) {
    const rows = (source.byTask.get(task) ?? []).filter((r) => r.status !== 'harness-error');
    lines.push([task, source.label, ...columns.map(([, f]) => (rows.length ? f(rows) : '-'))]);
  }
}
// 전체 평균 행
for (const source of sources) {
  const rows = [...source.byTask.values()].flat().filter((r) => r.status !== 'harness-error');
  lines.push(['ALL', source.label, ...columns.map(([, f]) => (rows.length ? f(rows) : '-'))]);
}

const widths = header.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i].length)));
const row = (cells) => cells.map((c, i) => (i < 2 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
console.log(sources.map((s) => `${s.label} = ${s.file}`).join('\n'));
console.log(`\n${row(header)}`);
let lastTask = null;
for (const line of lines) {
  if (lastTask !== null && line[0] !== lastTask) console.log('');
  lastTask = line[0];
  console.log(row(line));
}

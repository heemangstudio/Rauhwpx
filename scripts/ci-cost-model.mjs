import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// USD list rates, checked 2026-10-02 at https://www.blacksmith.sh/pricing.
// Larger Linux/Windows sizes are modeled by proportional vCPU scaling. These
// estimates exclude credits, free tier, storage, queue time and vendor rounding.
export const rates = Object.freeze({
  'blacksmith-2vcpu-ubuntu-2404': 0.004,
  'blacksmith-4vcpu-ubuntu-2404': 0.008,
  'blacksmith-8vcpu-ubuntu-2404': 0.016,
  'blacksmith-4vcpu-ubuntu-2404-arm': 0.005,
  'blacksmith-2vcpu-windows-2025': 0.008,
  'blacksmith-4vcpu-windows-2025': 0.016,
  'blacksmith-6vcpu-macos-15': 0.08,
  // These labels are free compute ONLY for this public repository.
  'ubuntu-24.04': 0,
  'macos-15': 0,
  'windows-2025': 0,
});

export function modelRun(run) {
  if (!Array.isArray(run.jobs) || !run.jobs.length) throw new Error('Missing job evidence');
  const jobs = run.jobs.map((job) => {
    if (job.head_sha !== run.head_sha) throw new Error(`Wrong head for job ${job.id}`);
    const runner = job.labels?.find((label) => Object.hasOwn(rates, label));
    if (!runner) throw new Error(`Unknown runner for job ${job.id}`);
    if (!['success', 'failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'neutral', 'startup_failure'].includes(job.conclusion)) {
      throw new Error(`Job ${job.id} has no terminal conclusion`);
    }
    const seconds = job.conclusion === 'skipped' ? 0
      : (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`Invalid timestamps for job ${job.id}`);
    return { id: job.id, name: job.name, runner, seconds, conclusion: job.conclusion,
      durationEquivalentUSD: seconds / 60 * rates[runner],
      roundedMinuteScenarioUSD: Math.ceil(seconds / 60) * rates[runner] };
  });
  return { id: run.id, head_sha: run.head_sha, conclusion: run.conclusion, jobs,
    durationEquivalentUSD: jobs.reduce((sum, job) => sum + job.durationEquivalentUSD, 0),
    roundedMinuteScenarioUSD: jobs.reduce((sum, job) => sum + job.roundedMinuteScenarioUSD, 0),
    note: 'Run-level duration/list-rate model, not measured vendor charges or realized billing. Rounded scenario is not a verified billing policy.' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2] ?? new URL('../docs/ci-cost/baseline-runs.json', import.meta.url);
  const evidence = JSON.parse(readFileSync(file, 'utf8'));
  console.log(JSON.stringify(evidence.runs.map(modelRun), null, 2));
}

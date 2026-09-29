import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_DIRECTORIES = Object.freeze([
  '.', 'rhwp/rhwp-agent', 'rhwp/rhwp-studio',
  'cloud', 'cloud/install/provider-runtime', 'rhwp/rau-credits',
]);

// npm bundles node-gyp and its undici, so overrides cannot patch them. node-gyp only
// downloads Node headers with fetch; these advisories need undici's WebSocket client.
export const ADVISORY_EXCEPTIONS = Object.freeze([
  Object.freeze({
    directory: 'rhwp/rhwp-agent',
    node: 'node_modules/npm/node_modules/undici',
    advisories: Object.freeze(['GHSA-3wwx-pv8p-q78v', 'GHSA-rfgv-xxqx-mfg5']),
  }),
]);

const BLOCKING = new Set(['high', 'critical']);

function advisoryId(via) {
  return via.url?.split('/').pop() ?? String(via.source);
}

function excepted(directory, vulnerability, via) {
  return ADVISORY_EXCEPTIONS.some((exception) => exception.directory === directory
    && vulnerability.nodes.every((node) => node === exception.node)
    && exception.advisories.includes(advisoryId(via)));
}

// Returns the high/critical advisories left after exceptions, following transitive
// entries (`via` strings) to the package that carries the advisory.
export function blockingAdvisories(directory, report) {
  const vulnerabilities = report.vulnerabilities ?? {};
  const memo = new Map();
  const visit = (name) => {
    if (memo.has(name)) return memo.get(name);
    memo.set(name, []);
    const vulnerability = vulnerabilities[name];
    const found = [];
    for (const via of vulnerability?.via ?? []) {
      if (typeof via === 'string') {
        found.push(...visit(via));
      } else if (BLOCKING.has(via.severity) && !excepted(directory, vulnerability, via)) {
        found.push(`${via.name} ${advisoryId(via)} (${via.severity}): ${via.title}`);
      }
    }
    memo.set(name, found);
    return found;
  };
  return [...new Set(Object.keys(vulnerabilities).flatMap(visit))];
}

// High/critical advisories block changes. Nightly also records lower severities.
export function auditProduction({ report = false, run = spawnSync, log = console.log } = {}) {
  let failed = false;
  for (const directory of PRODUCTION_DIRECTORIES) {
    log(`Production dependency audit: ${directory}`);
    const options = { cwd: directory, shell: process.platform === 'win32' };
    if (report) {
      const result = run('npm', ['audit', '--omit=dev', '--audit-level=low'], { ...options, stdio: 'inherit' });
      if (result.error) throw result.error;
      failed ||= result.status !== 0;
      continue;
    }
    const result = run('npm', ['audit', '--omit=dev', '--json'], {
      ...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      log(`npm audit returned no report (exit ${result.status}): ${result.stderr ?? ''}`);
      failed = true;
      continue;
    }
    if (parsed.error) {
      log(`npm audit failed: ${parsed.error.summary ?? JSON.stringify(parsed.error)}`);
      failed = true;
      continue;
    }
    const blocking = blockingAdvisories(directory, parsed);
    for (const finding of blocking) log(`  ${finding}`);
    failed ||= blocking.length > 0;
  }
  if (report && failed) log('Advisory report contains findings; high/critical findings are enforced by audit:production.');
  return report ? 0 : Number(failed);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = auditProduction({ report: process.argv.includes('--report') });
}

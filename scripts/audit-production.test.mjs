import assert from 'node:assert/strict';
import test from 'node:test';
import { auditProduction, PRODUCTION_DIRECTORIES } from './audit-production.mjs';

const advisory = (id, severity = 'high') => ({
  source: 1, name: 'undici', title: 'advisory', severity, url: `https://github.com/advisories/${id}`,
});
const report = (vulnerabilities = {}) => JSON.stringify({ vulnerabilities });
const undici = (node, ...via) => ({ undici: { name: 'undici', severity: 'high', via, nodes: [node] } });

function audit(reports) {
  const visited = [];
  const status = auditProduction({
    log() {},
    run(command, args, options) {
      assert.equal(command, 'npm');
      assert.deepEqual(args, ['audit', '--omit=dev', '--json']);
      visited.push(options.cwd);
      return { status: reports[options.cwd] ? 1 : 0, stdout: reports[options.cwd] ?? report() };
    },
  });
  return { status, visited };
}

for (const affected of ['rhwp/rhwp-studio', 'site-api']) {
  test(`production audit fails when ${affected} has a blocking advisory`, () => {
    const { status, visited } = audit({ [affected]: report(undici('node_modules/undici', advisory('GHSA-new'))) });
    assert.equal(status, 1);
    assert.deepEqual(visited, PRODUCTION_DIRECTORIES, 'one finding must not skip remaining package audits');
  });
}

test('production audit follows transitive findings to their advisory', () => {
  const vulnerabilities = {
    ...undici('node_modules/pi/node_modules/undici', advisory('GHSA-new')),
    pi: { name: 'pi', severity: 'high', via: ['undici'], nodes: ['node_modules/pi'] },
  };
  assert.equal(audit({ 'rhwp/rhwp-agent': report(vulnerabilities) }).status, 1);
});

test('production audit ignores moderate advisories', () => {
  assert.equal(audit({ 'rhwp/rhwp-agent': report(undici('node_modules/undici', advisory('GHSA-new', 'moderate'))) }).status, 0);
});

test('production audit blocks advisories in bundled npm dependencies too', () => {
  const bundled = 'node_modules/npm/node_modules/undici';
  assert.equal(audit({ 'rhwp/rhwp-agent': report(undici(bundled, advisory('GHSA-rfgv-xxqx-mfg5'))) }).status, 1);
  assert.equal(audit({ 'rhwp/rhwp-agent': report(undici(bundled, advisory('GHSA-new'))) }).status, 1);
  assert.equal(audit({ 'rhwp/rhwp-agent': report(undici('node_modules/undici', advisory('GHSA-rfgv-xxqx-mfg5'))) }).status, 1);
});

test('production audit fails when npm returns no report', () => {
  const status = auditProduction({
    log() {},
    run: () => ({ status: 1, stdout: '', stderr: 'network down' }),
  });
  assert.equal(status, 1);
});

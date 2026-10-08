import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { changedPaths, selectChecks } from './ci-changes.mjs';

const readYaml = (path) => yaml.load(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const workflows = Object.fromEntries(
  readdirSync(new URL('../.github/workflows/', import.meta.url))
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [file, readYaml(`.github/workflows/${file}`)]),
);
const enabled = (files) => Object.entries(selectChecks(files)).filter(([, value]) => value).map(([key]) => key).sort();

for (const [description, files, expected] of [
  ['documentation', ['README.md', 'CONTRIBUTING.md', 'docs/releasing.md', 'rhwp/rhwp-agent/README.md'], []],
  ['engine changes', ['rhwp/src/parser/hwp.rs'], ['browser', 'engine']],
  ['corpus changes', ['rhwp/samples/report.hwpx', 'rhwp/pdf/reference.pdf'], ['browser', 'engine']],
  ['Cargo manifest', ['rhwp/Cargo.toml', 'rhwp/Cargo.lock'], ['browser', 'engine']],
  ['desktop shell', ['desktop/main.mjs'], ['app', 'sessions']],
  ['agent hub source', ['rhwp/rhwp-agent/server.mjs'], ['app', 'sessions']],
  ['shared package', ['rhwp/rhwp-shared/package.json'], ['app', 'browser']],
  ['site service', ['site-api/server.mjs'], ['app']],
  ['Studio unit tests', ['rhwp/rhwp-studio/tests/save.test.ts'], ['app', 'browser']],
  ['desktop session tests', ['rhwp/rhwp-studio/tests/desktop-shell.test.ts'], ['app', 'browser', 'sessions']],
  ['installer packaging', ['build/entitlements.plist'], []],
]) {
  test(`change selection covers ${description}`, () => assert.deepEqual(enabled(files), expected));
}

test('unknown paths and build/CI configuration fail safe to full checks', () => {
  for (const file of ['new-component/index.ts', '.github/workflows/checks.yml', 'scripts/ci-changes.mjs', 'package.json', 'new-fixture.txt']) {
    assert.ok(Object.values(selectChecks([file])).every(Boolean), file);
  }
});

test('deletions and renamed code still select checks', () => {
  const event = { pull_request: { base: { sha: 'a'.repeat(40) }, head: { sha: 'b'.repeat(40) } } };
  const paths = changedPaths(event, (args) => {
    assert.deepEqual(args, ['diff', '--name-only', '--no-renames', '-z', 'a'.repeat(40), 'b'.repeat(40), '--']);
    return 'rhwp/src/removed.rs\0docs/removed.md\0';
  });
  assert.deepEqual(enabled(paths), ['browser', 'engine']);
});

test('dispatch and new-branch events request full verification', () => {
  assert.ok(Object.values(selectChecks(changedPaths({}))).every(Boolean));
  assert.ok(Object.values(selectChecks(changedPaths({ before: '0'.repeat(40), after: 'a'.repeat(40) }))).every(Boolean));
  assert.throws(() => changedPaths({ before: '--unsafe', after: 'a'.repeat(40) }), /Invalid event commit SHA/);
});

function ancestors(workflow, id, visited = new Set()) {
  const job = workflow.jobs[id];
  assert.ok(job, `Unknown job dependency: ${id}`);
  const needs = job.needs == null ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
  for (const dependency of needs) {
    assert.notEqual(dependency, id, 'A job cannot depend on itself');
    if (!visited.has(dependency)) {
      visited.add(dependency);
      ancestors(workflow, dependency, visited);
    }
  }
  return visited;
}

test('one PR-only workflow owns each protected check name', () => {
  const pr = Object.values(workflows).filter((workflow) => Object.hasOwn(workflow.on, 'pull_request'));
  assert.equal(pr.length, 1);
  const names = Object.values(pr[0].jobs).flatMap((job) => {
    if (job.strategy?.matrix?.include) return job.strategy.matrix.include.map((entry) => job.name.replace('${{ matrix.label }}', entry.label).replace('${{ matrix.os }}', entry.os));
    return [job.name];
  });
  for (const name of ['Session tests (macos-15)', 'Session tests (windows-latest)', 'Hostile document input boundaries', 'Auth and resource boundary regressions']) {
    assert.equal(names.filter((actual) => actual === name).length, 1, name);
  }
  assert.equal(Object.hasOwn(pr[0].on, 'push'), false);
});

test('tagged releases depend on verification within the same workflow run', () => {
  const release = workflows['release.yml'];
  for (const platform of ['macos', 'windows']) {
    const checkout = release.jobs[platform].steps.find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkout.with.ref, '${{ github.sha }}', `release packages the verified commit on ${platform}`);
  }
  const publish = ancestors(release, 'publish');
  for (const dependency of ['verification', 'macos', 'windows', 'linux']) assert.ok(publish.has(dependency), dependency);
  const publication = release.jobs.publish.steps.map((step) => step.run ?? '').join('\n');
  for (const pattern of ['*.dmg', '*.zip', '*.exe', '*.AppImage', '*.deb', 'SHA256SUMS.txt']) {
    assert.ok(publication.includes(pattern), pattern);
  }
});

test('desktop installers share one Linux-built WASM package', () => {
  // Windows wasm-opt crashed in Binaryen on engine code that optimizes fine on Linux.
  const release = workflows['release.yml'];
  const desktopPackage = readYaml('.github/actions/package-desktop/action.yml');
  const upload = release.jobs.wasm.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with.name, 'release-wasm');
  assert.match(release.jobs.wasm['runs-on'], /ubuntu/);
  for (const platform of ['macos', 'windows']) {
    assert.ok(release.jobs[platform].needs.includes('wasm'), platform);
    const step = release.jobs[platform].steps.find((item) => item.uses === './.github/actions/package-desktop');
    assert.equal(step.with['wasm-artifact'], 'release-wasm', platform);
  }
  assert.ok(release.jobs.linux.needs.includes('wasm'));
  const linuxWasm = release.jobs.linux.steps.find((step) => step.uses === './.github/actions/build-wasm');
  assert.equal(linuxWasm.with.artifact, 'release-wasm');
  const desktopWasm = desktopPackage.runs.steps.find((step) => step.uses === './.github/actions/build-wasm');
  assert.equal(desktopWasm.with.artifact, '${{ inputs.wasm-artifact }}');
});

test('nightly runs verification daily without building or publishing installers', () => {
  const nightly = workflows['nightly.yml'];
  assert.deepEqual(nightly.on.schedule, [{ cron: '0 18 * * *' }]);
  assert.ok(Object.hasOwn(nightly.on, 'workflow_dispatch'));
  assert.deepEqual(Object.keys(nightly.jobs).sort(), ['app', 'engine']);
  assert.equal(nightly.jobs.app.needs, 'engine');
  assert.equal(nightly.concurrency.group, 'nightly-${{ github.ref }}');
  assert.equal(nightly.concurrency['cancel-in-progress'], false);
  const commands = Object.values(nightly.jobs).flatMap((job) => job.steps)
    .map((step) => `${step.uses ?? ''} ${step.run ?? ''}`).join('\n');
  assert.match(commands, /cargo nextest run --locked --workspace --test-threads 8/);
  assert.match(commands, /cargo test --locked --workspace --doc/);
  assert.match(commands, /cargo audit --no-fetch -D warnings/);
  assert.doesNotMatch(commands, /package-desktop|gh release|git tag|git push|secrets\./);
  const upload = nightly.jobs.engine.steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  const download = nightly.jobs.app.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  assert.equal(upload.with.name, 'tested-wasm');
  assert.equal(download.with.name, upload.with.name);
});

test('cached pinned audit tool avoids rebuilds and incorrect tools still reinstall or fail', { skip: process.platform === 'win32' }, () => {
  const run = workflows['nightly.yml'].jobs.engine.steps
    .find((step) => step.name === 'Install pinned cargo-audit').run;
  for (const initial of ['cargo-audit 0.22.2', 'cargo-audit-audit 0.22.2', 'cargo-audit 0.22.1', '', 'cargo-audit 0.22.2-untrusted']) {
    const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
      cargo() {
        if [[ "$1 $2" == 'audit --version' ]]; then
          [[ -n "$RAU_AUDIT_TEST_CURRENT" ]] || return 127
          printf '%s\\n' "$RAU_AUDIT_TEST_CURRENT"
        elif [[ "$*" == 'install cargo-audit --version 0.22.2 --locked --force' ]]; then
          printf 'INSTALL_PINNED_AUDIT\\n'
          RAU_AUDIT_TEST_CURRENT='cargo-audit-audit 0.22.2'
        else
          return 2
        fi
      }
      ${run}
    `], { encoding: 'utf8', timeout: 5000, env: { ...process.env, RAU_AUDIT_TEST_CURRENT: initial } });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes('INSTALL_PINNED_AUDIT'), !['cargo-audit 0.22.2', 'cargo-audit-audit 0.22.2'].includes(initial));
  }
  const broken = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', `
    cargo() { if [[ "$1" == install ]]; then return 0; fi; printf 'cargo-audit 0.22.1\\n'; }
    ${run}
  `], { encoding: 'utf8', timeout: 5000 });
  assert.equal(broken.status, 1);
  assert.match(broken.stderr, /Unexpected cargo-audit version/);
});

test('PR checks run desktop main-process tests and nightly keeps the sidebar check', () => {
  const appSteps = workflows['checks.yml'].jobs.app.steps;
  assert.ok(appSteps.some((step) => step.run?.includes('npm run test:desktop')));
  const nightlyCommands = workflows['nightly.yml'].jobs.app.steps.map((step) => step.run ?? '').join('\n');
  assert.match(nightlyCommands, /npm run test:sidebar/);
});

test('production verification audits every lock and checks the bundled runtime on supported hosts', () => {
  const job = workflows['checks.yml'].jobs['production-dependencies'];
  const commands = job.steps.map((step) => step.run ?? '').join('\n');
  for (const directory of ['rhwp/rhwp-agent', 'rhwp/rhwp-studio', 'site-api']) {
    assert.ok(commands.includes(directory), directory);
  }
  assert.match(commands, /npm run audit:production/);
  assert.match(commands, /node node_modules\/electron\/install\.js/);
  const installIndex = job.steps.findIndex((step) => step.run?.includes('node node_modules/electron/install.js'));
  const verifyIndex = job.steps.findIndex((step) => step.run?.includes('verify-production-dependencies.mjs --electron'));
  assert.ok(installIndex >= 0 && installIndex < verifyIndex);
  assert.match(commands, /verify-production-dependencies\.mjs --electron/);
  assert.doesNotMatch(commands, /--force|--ignore-engines|engine-strict=false/);
});

test('every workflow keeps compute on Blacksmith', () => {
  for (const [filename, workflow] of Object.entries(workflows)) {
    for (const [id, job] of Object.entries(workflow.jobs)) {
      if (job['runs-on'] === '${{ matrix.runner }}') {
        assert.ok(job.strategy.matrix.include.length > 0);
        for (const entry of job.strategy.matrix.include) assert.match(entry.runner, /^blacksmith-/, `${filename}/${id}`);
      } else {
        assert.match(job['runs-on'], /blacksmith-/, `${filename}/${id}`);
      }
    }
  }
});

test('PR checks stay on Blacksmith and preserve platform architectures', () => {
  const checks = workflows['checks.yml'];
  for (const job of Object.values(checks.jobs)) {
    assert.match(job['runs-on'], /blacksmith/);
    if (!job.strategy?.matrix?.include) assert.match(job['runs-on'], /blacksmith-\d+vcpu-ubuntu-2404/);
  }
  for (const id of ['session-tests', 'production-dependencies']) {
    const job = checks.jobs[id];
    for (const entry of job.strategy.matrix.include) {
      assert.equal(entry.runner, { 'macos-15': 'blacksmith-6vcpu-macos-15', 'windows-latest': 'blacksmith-2vcpu-windows-2025', 'ubuntu-24.04': 'blacksmith-4vcpu-ubuntu-2404' }[entry.os]);
      assert.equal(entry.architecture, entry.os === 'macos-15' ? 'arm64' : 'x64');
    }
    const architecture = job.steps.find((step) => step.name === 'Assert runner architecture');
    assert.equal(architecture.env.EXPECTED_NODE_ARCH, '${{ matrix.architecture }}');
    assert.match(architecture.run, /process\.arch/);
    assert.equal(job.if, '${{ !cancelled() }}');
  }
});

test('production dependency download cache keys cover all locks without replacing real installs', () => {
  const job = workflows['checks.yml'].jobs['production-dependencies'];
  const setup = job.steps.find((step) => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(setup.with.cache, 'npm');
  assert.deepEqual(setup.with['cache-dependency-path'].trim().split('\n'), [
    'package-lock.json', 'rhwp/rhwp-agent/package-lock.json', 'rhwp/rhwp-studio/package-lock.json',
    'site-api/package-lock.json',
  ]);
  const installs = job.steps.find((step) => step.name === 'Install actual packaged dependencies');
  assert.equal(installs.if, "needs.changes.outputs.app != 'false'");
  assert.match(installs.run, /ci --no-audit --no-fund/);
});

test('only release publication and GitHub Pages receive write permissions', () => {
  for (const [filename, workflow] of Object.entries(workflows)) {
    assert.deepEqual(workflow.permissions, { contents: 'read' }, filename);
    for (const [id, job] of Object.entries(workflow.jobs)) {
      for (const [scope, access] of Object.entries(job.permissions ?? {})) {
        if (access === 'write') {
          const allowed = filename === 'release.yml' && id === 'publish' && scope === 'contents'
            || filename === 'pages.yml' && id === 'deploy' && (scope === 'pages' || scope === 'id-token');
          assert.ok(allowed, `${filename}/${id}/${scope}`);
        }
      }
      if (id !== 'publish') {
        for (const step of job.steps ?? []) {
          if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with?.['persist-credentials'], false, `${filename}/${id}`);
        }
      }
    }
  }
});

test('third-party Rust toolchain and installer actions are immutable', () => {
  const actions = ['setup-rust', 'package-desktop'].map((name) => readYaml(`.github/actions/${name}/action.yml`));
  const steps = [
    ...Object.values(workflows).flatMap((workflow) => Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])),
    ...actions.flatMap((action) => action.runs.steps),
  ];
  for (const step of steps) {
    if (/^(dtolnay\/rust-toolchain|taiki-e\/install-action)@/.test(step.uses ?? '')) assert.match(step.uses.split('@')[1], /^[a-f0-9]{40}$/);
  }
});

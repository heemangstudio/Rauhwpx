import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? path.resolve(args[args.indexOf(name) + 1]) : fallback;
const agent = option('--agent-root', path.join(root, 'rhwp/rhwp-agent'));
const provider = option('--provider-root', path.join(root, 'cloud/install/provider-runtime'));
const json = (filename) => JSON.parse(readFileSync(filename, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const environment = { ...process.env, PI_SKIP_VERSION_CHECK: '1', npm_config_update_notifier: 'false' };

function nodeFloor(version) {
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 22 || major === 22 && minor >= 19, `Pi requires Node >=22.19; got ${version}`);
}

function run(command, argv, env = environment) {
  const result = spawnSync(command, argv, { encoding: 'utf8', env, timeout: 15000, maxBuffer: 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout.trim();
}

function artifact(project, name) {
  const provenance = json(path.join(project, 'vendor/provenance.json'));
  const packed = path.join(project, 'vendor', provenance.downstream.file);
  assert.equal(sha256(readFileSync(packed)), provenance.downstream.sha256, packed);
  const installed = path.join(project, 'node_modules', name);
  const manifest = json(path.join(installed, 'package.json'));
  assert.equal(manifest.version, provenance.downstream.version);
  return { provenance, installed, manifest };
}

function braceCopies(directory, found = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const child = path.join(directory, entry.name);
    if (entry.name === 'brace-expansion') {
      assert.equal(json(path.join(child, 'package.json')).version, '5.0.12', child);
      found.push(child);
    }
    braceCopies(child, found);
  }
  return found;
}

nodeFloor(process.versions.node);
const npm = artifact(agent, 'npm');
const pi = artifact(provider, '@earendil-works/pi-coding-agent');
const npmRequire = createRequire(path.join(npm.installed, 'package.json'));
assert.equal(npmRequire('brace-expansion/package.json').version, '5.0.12');
assert.equal(npmRequire('undici/package.json').version, '6.28.1');
assert.equal(npmRequire('http-cache-semantics/package.json').version, npm.provenance.verification.packedHttpCacheSemantics);
assert.equal(npmRequire('ip-address/package.json').version, npm.provenance.verification.packedIpAddress);
assert.equal(createRequire(path.join(pi.installed, 'package.json'))('minimatch/package.json').version, '10.2.6');
const copies = [agent, provider].flatMap((project) => braceCopies(path.join(project, 'node_modules')));
assert.ok(copies.length >= 2);

const chunk = readFileSync(path.join(pi.installed, pi.provenance.verification.bundle.file), 'utf8');
assert.equal(sha256(chunk), pi.provenance.verification.bundle.sha256);
const startMarker = 'var balanced=';
const endMarker = 'var assertValidPattern=';
assert.equal(chunk.split(startMarker).length, 2, 'Pi parser start must occur exactly once');
assert.equal(chunk.split(endMarker).length, 2, 'Pi parser end must occur exactly once');
const start = chunk.indexOf(startMarker);
const end = chunk.indexOf(endMarker);
assert.ok(end > start);
const region = chunk.slice(start, end);
assert.equal(sha256(region), pi.provenance.verification.bundle.braceRegionSha256);

if (args.includes('--runtime-child')) {
  const { expand } = await import(pathToFileURL(npmRequire.resolve('brace-expansion')));
  const context = vm.createContext({});
  vm.runInContext(region, context, { timeout: 1000 });
  const patterns = [
    'file-{a,b}.hwpx', '{1..10..2}', 'x{{a,b}}y', '\\{a,b\\}', '${a,b}', '{a},b}', '{a,{b,c}}', '',
    '{' + '{a},'.repeat(7000) + 'b}', '{{x},' + 'a,'.repeat(125000) + 'b}',
    '{'.repeat(3200) + 'a,b' + '}'.repeat(3200), '{a,'.repeat(4000) + 'z' + '}'.repeat(4000),
    '{a}'.repeat(20000) + ',b}',
  ];
  for (const pattern of patterns) {
    context.pattern = pattern;
    const expected = expand(pattern);
    const actual = vm.runInContext('expand(pattern)', context, { timeout: 1000 });
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'Pi and fixed npm parser disagree');
    assert.ok(actual.length <= 100000);
  }
  console.log(JSON.stringify({ runtimePatterns: patterns.length, equivalent: true }));
} else {
  const { bundledNpmLaunch } = await import(pathToFileURL(path.join(agent, 'npm-runtime.mjs')));
  const npmLaunch = bundledNpmLaunch();
  assert.equal(run(npmLaunch.command, [...npmLaunch.leadingArgs, '--version']), npm.manifest.version);
  for (const name of ['@anthropic-ai/claude-code', '@openai/codex', '@earendil-works/pi-coding-agent']) {
    const installed = path.join(provider, 'node_modules', name);
    const manifest = json(path.join(installed, 'package.json'));
    const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin)[0];
    const executable = path.join(installed, bin);
    const version = /\.[cm]?js$/.test(bin)
      ? run(process.execPath, [executable, '--version'])
      : run(executable, ['--version']);
    assert.ok(version.includes(manifest.version), name);
  }
  const runtime = run(process.execPath, ['--max-old-space-size=256', fileURLToPath(import.meta.url), ...args, '--runtime-child']);
  let electronNode = null;
  if (args.includes('--electron')) {
    // electron의 main 모듈은 바이너리가 없으면 설치를 시작하므로, 설치된 경로만 읽는다.
    const manifest = createRequire(path.join(root, 'package.json')).resolve('electron/package.json');
    const directory = path.dirname(manifest);
    const electron = path.join(directory, 'dist', readFileSync(path.join(directory, 'path.txt'), 'utf8').trim());
    const relative = path.relative(path.join(directory, 'dist'), electron);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Electron path must stay inside dist');
    assert.ok(existsSync(electron), 'Electron executable is not installed');
    const env = { ...environment, ELECTRON_RUN_AS_NODE: '1' };
    electronNode = run(electron, ['-p', 'process.versions.node'], env);
    nodeFloor(electronNode);
    const launch = bundledNpmLaunch({ nodeCommand: electron });
    assert.equal(run(launch.command, [...launch.leadingArgs, '--version'], env), npm.manifest.version);
    const bin = Object.values(pi.manifest.bin)[0];
    assert.equal(run(electron, [path.join(pi.installed, bin), '--version'], env), pi.manifest.version);
  }
  console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, architecture: process.arch,
    npm: npm.manifest.version, pi: pi.manifest.version, braceCopies: copies.length, electronNode,
    runtime: JSON.parse(runtime) }, null, 2));
}

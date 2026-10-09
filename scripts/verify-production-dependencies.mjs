import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = path.join(root, 'rhwp/rhwp-agent');
const json = (filename) => JSON.parse(readFileSync(filename, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const environment = { ...process.env, npm_config_update_notifier: 'false' };

function nodeFloor(version) {
  const [major, minor] = version.split('.').map(Number);
  assert.ok(major > 22 || major === 22 && minor >= 19, `The agent hub requires Node >=22.19; got ${version}`);
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
const npmRequire = createRequire(path.join(npm.installed, 'package.json'));
assert.equal(npmRequire('brace-expansion/package.json').version, '5.0.12');
assert.equal(npmRequire('undici/package.json').version, '6.28.1');
assert.equal(npmRequire('http-cache-semantics/package.json').version, npm.provenance.verification.packedHttpCacheSemantics);
assert.equal(npmRequire('ip-address/package.json').version, npm.provenance.verification.packedIpAddress);
const copies = braceCopies(path.join(agent, 'node_modules'));
assert.ok(copies.length >= 1);

const { bundledNpmLaunch } = await import(pathToFileURL(path.join(agent, 'npm-runtime.mjs')));
const npmLaunch = bundledNpmLaunch();
assert.equal(run(npmLaunch.command, [...npmLaunch.leadingArgs, '--version']), npm.manifest.version);
let electronNode = null;
if (process.argv.includes('--electron')) {
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
}
console.log(JSON.stringify({ node: process.versions.node, platform: process.platform, architecture: process.arch,
  npm: npm.manifest.version, braceCopies: copies.length, electronNode }, null, 2));

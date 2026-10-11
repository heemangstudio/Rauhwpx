import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listPackage } from '@electron/asar';

import { packagedStagedNativeExtractorPath } from '../desktop/native-rhwp-path.mjs';
import { normalizeArchivePath } from './desktop-package-paths.mjs';
import { verifyKeyringBinding } from './verify-keyring-binding.mjs';
import { smokePackagedAgentHub, smokePackagedSetupTerminal } from './packaged-agent-hub-smoke.mjs';

const releaseDir = resolve(process.argv[2] ?? 'release');
const resourcesDir = process.platform === 'darwin'
  ? join(releaseDir, 'mac-arm64', 'HamaEditor.app', 'Contents', 'Resources')
  : join(releaseDir, 'win-unpacked', 'resources');
const unpackedAgent = join(resourcesDir, 'app.asar.unpacked', 'rhwp', 'rhwp-agent');
const extractor = join(resourcesDir, 'bin', process.platform === 'win32' ? 'rhwp.exe' : 'rhwp');
const desktopExecutable = process.platform === 'darwin'
  ? join(releaseDir, 'mac-arm64', 'HamaEditor.app', 'Contents', 'MacOS', 'HamaEditor')
  : join(releaseDir, 'win-unpacked', 'HamaEditor.exe');

const archive = join(resourcesDir, 'app.asar');
const required = [
  archive,
  join(unpackedAgent, 'server.mjs'),
  join(unpackedAgent, 'copy-layout-runner.mjs'),
  join(unpackedAgent, 'skills', 'copy-layout', 'scripts', 'copy_layout.py'),
  join(unpackedAgent, 'owned-browser-service.mjs'),
  join(unpackedAgent, 'owned-browser-runtime.mjs'),
  join(unpackedAgent, 'owned-browser-network.mjs'),
  ...['browser-policy', 'browser-credentials', 'browser-auth-store', 'browser-os-secret-store', 'browser-downloads', 'browser-cleanup']
    .map((name) => join(unpackedAgent, `${name}.mjs`)),
  join(unpackedAgent, 'package.json'),
  join(unpackedAgent, 'node_modules', 'playwright', 'package.json'),
  join(unpackedAgent, 'node_modules', 'playwright-core', 'package.json'),
  join(unpackedAgent, 'node_modules', 'playwright-core', 'browsers.json'),
  join(unpackedAgent, 'node_modules', '@napi-rs', 'keyring', 'package.json'),
  join(unpackedAgent, 'node_modules', 'ws', 'package.json'),
  extractor,
  packagedStagedNativeExtractorPath(resourcesDir, process.platform, process.arch),
  desktopExecutable,
];
for (const path of required) {
  if (!existsSync(path)) throw new Error(`Packaged file is missing: ${path}`);
}

verifyKeyringBinding(unpackedAgent);

const forbidden = [
  join(unpackedAgent, 'README.md'),
  join(unpackedAgent, 'package-lock.json'),
  join(unpackedAgent, 'tsconfig.agents.json'),
  join(unpackedAgent, 'tests'),
  join(unpackedAgent, 'node_modules', 'typescript'),
  join(unpackedAgent, 'node_modules', '@typescript'),
];
for (const path of forbidden) {
  if (existsSync(path)) throw new Error(`Development-only file was packaged: ${path}`);
}

// @electron/asar builds listing entries with the host path implementation:
// `/desktop/main.mjs` on POSIX and `\desktop\main.mjs` on Windows. Compare a
// canonical archive namespace so the same package contract is enforced on
// both builders.
const archivedFiles = listPackage(archive).map(normalizeArchivePath);
const requiredArchiveFiles = [
  '/desktop/main.mjs',
  '/desktop/browser-host.mjs',
  '/desktop/browser-cdp.mjs',
  '/desktop/browser-guest-preload.cjs',
  '/desktop/browser-popout-preload.cjs',
  '/desktop/browser-popout.cjs',
  '/desktop/browser-popout.css',
  '/desktop/browser-popout.html',
  '/desktop/unique-install.mjs',
  '/desktop/system-fonts.mjs',
  '/rhwp/rhwp-shared/fonts/font-index-core.mjs',
  '/rhwp/rhwp-studio/dist/index.html',
];
for (const path of requiredArchiveFiles) {
  if (!archivedFiles.includes(path)) throw new Error(`Packaged archive file is missing: ${path}`);
}
if (!archivedFiles.some((path) => /^\/rhwp\/rhwp-studio\/dist\/assets\/rhwp_bg-.*\.wasm$/.test(path))) {
  throw new Error('Packaged archive is missing the Studio WASM engine');
}
const forbiddenArchiveFiles = [
  '/rhwp/rhwp-studio/dist/rhwp.js',
  '/rhwp/rhwp-studio/dist/rhwp.d.ts',
  '/rhwp/rhwp-studio/dist/rhwp_bg.wasm.d.ts',
];
for (const path of forbiddenArchiveFiles) {
  if (archivedFiles.includes(path)) throw new Error(`Stale generated file was packaged: ${path}`);
}
const forbiddenArchivePrefixes = [
  '/rhwp/rhwp-studio/dist/samples/',
  '/rhwp/rhwp-agent/tests/',
];
for (const prefix of forbiddenArchivePrefixes) {
  if (archivedFiles.some((path) => path.startsWith(prefix))) {
    throw new Error(`Development-only archive path was packaged: ${prefix}`);
  }
}

if (process.platform !== 'win32' && (statSync(extractor).mode & 0o111) === 0) {
  throw new Error(`Packaged document extractor is not executable: ${extractor}`);
}

await smokePackagedSetupTerminal({ executable: desktopExecutable, agentDir: unpackedAgent });

const hub = await smokePackagedAgentHub({
  executable: desktopExecutable,
  agentDir: unpackedAgent,
});

console.log(`Verified desktop package resources, provider login terminal, and Agent Hub session ${hub.sessionId} at ${resourcesDir}`);

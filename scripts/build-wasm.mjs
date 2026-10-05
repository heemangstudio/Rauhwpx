import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `wasm-pack build` crashes inside wasm-opt on current rustc output:
// the binaryen release wasm-pack vendors/falls back to (117) hits
// `UNREACHABLE at Precompute.cpp:838` — a fail-fast abort (0xc0000409 on
// Windows) that also leaves rhwp/pkg without package.json. binaryen 118+
// optimizes the same module cleanly. wasm-pack prefers a wasm-opt found on
// PATH over its managed download, so we put a pinned binaryen on PATH for
// the wasm-pack child process instead of disabling optimization.
const MIN_WASM_OPT_VERSION = 118;
const PINNED_BINARYEN_VERSION = 125;

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const toolsRoot = join(repoRoot, '.tools', 'binaryen');

const binaryenAssets = {
  'win32:x64': {
    archive: 'binaryen-version_125-x86_64-windows.tar.gz',
    sha256: '7d20f9f22ee1d1a195aecccb21390f8c599b5025219520c7c9f04673b39d2c20',
  },
  'linux:x64': {
    archive: 'binaryen-version_125-x86_64-linux.tar.gz',
    sha256: '7c3bc16599c8274a04d34a504fe4be2047884f900e0e2da2f6fb9cd667183be4',
  },
  'linux:arm64': {
    archive: 'binaryen-version_125-aarch64-linux.tar.gz',
    sha256: 'd0382de3c189a7cbb9fdda93e2966f4557f6a00f201e2c4937c27ca01cead4fc',
  },
  'darwin:x64': {
    archive: 'binaryen-version_125-x86_64-macos.tar.gz',
    sha256: '72a98df1bfb81dd1e241d2b022e15c72edbd49e29d84abc6a1129c7d083072dd',
  },
  'darwin:arm64': {
    archive: 'binaryen-version_125-arm64-macos.tar.gz',
    sha256: '28bab047c4ce845c5c1da111222ffee5fafcec0bbedd046ad8b3dcae0fd57076',
  },
};

export function parseWasmOptVersion(output) {
  const match = /wasm-opt version (\d+)/.exec(output ?? '');
  return match ? Number(match[1]) : null;
}

export function binaryenAssetFor(platform, arch) {
  return binaryenAssets[`${platform}:${arch}`] ?? null;
}

function probeWasmOpt(command) {
  try {
    const out = execFileSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return parseWasmOptVersion(out);
  } catch {
    return null;
  }
}

function isUsable(version) {
  return version !== null && version >= MIN_WASM_OPT_VERSION;
}

function cachedWasmOpt() {
  const dir = join(toolsRoot, `binaryen-version_${PINNED_BINARYEN_VERSION}`, 'bin');
  const candidate = join(dir, process.platform === 'win32' ? 'wasm-opt.exe' : 'wasm-opt');
  return existsSync(candidate) ? candidate : null;
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} for ${url}`);
  }
  const stream = createWriteStream(dest);
  Readable.fromWeb(response.body).pipe(stream);
  await once(stream, 'finish');
}

function sha256File(path) {
  const digest = createHash('sha256');
  digest.update(readFileSync(path));
  return digest.digest('hex');
}

async function ensurePinnedBinaryen(asset, platform, log) {
  const cached = cachedWasmOpt();
  if (cached && isUsable(probeWasmOpt(cached))) return dirname(cached);

  const tgz = join(toolsRoot, asset.archive);
  mkdirSync(toolsRoot, { recursive: true });
  if (!existsSync(tgz) || sha256File(tgz) !== asset.sha256) {
    const url = `https://github.com/WebAssembly/binaryen/releases/download/version_${PINNED_BINARYEN_VERSION}/${asset.archive}`;
    log(`downloading pinned binaryen ${PINNED_BINARYEN_VERSION} (${asset.archive})`);
    await download(url, tgz);
  }
  if (sha256File(tgz) !== asset.sha256) {
    throw new Error(`sha256 mismatch for ${asset.archive}`);
  }
  // Git Bash's MSYS tar reads "C:" as a remote host; Windows 10+ ships bsdtar
  // at System32\tar.exe, which understands drive-letter paths.
  const tar = platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tar, ['-xzf', tgz, '-C', toolsRoot]);
  const extracted = cachedWasmOpt();
  if (!extracted) throw new Error('binaryen archive did not contain bin/wasm-opt');
  return dirname(extracted);
}

export async function prepareWasmOptPath({ platform = process.platform, arch = process.arch, env = process.env, log = console.log, probe = probeWasmOpt } = {}) {
  const systemVersion = probe('wasm-opt');
  if (isUsable(systemVersion)) {
    log(`using wasm-opt ${systemVersion} from PATH`);
    return env.PATH ?? '';
  }
  const asset = binaryenAssetFor(platform, arch);
  if (!asset) {
    log(`no pinned binaryen for ${platform}/${arch}; wasm-pack will manage wasm-opt itself`);
    return env.PATH ?? '';
  }
  try {
    const binDir = await ensurePinnedBinaryen(asset, platform, log);
    return `${binDir}${platform === 'win32' ? ';' : ':'}${env.PATH ?? ''}`;
  } catch (error) {
    log(`pinned binaryen unavailable (${error.message}); wasm-pack will manage wasm-opt itself`);
    return env.PATH ?? '';
  }
}

async function main() {
  const passthrough = process.argv.slice(2);
  const path = await prepareWasmOptPath();
  const result = spawnSync('wasm-pack', ['build', '--target', 'web', ...passthrough], {
    cwd: join(repoRoot, 'rhwp'),
    env: { ...process.env, PATH: path },
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

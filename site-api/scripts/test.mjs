import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `npm test`: runs every tests/*.test.mjs (or the files given) with node --test. The Postgres tests
 * use SITE_API_TEST_DATABASE_URL; without it this starts a throwaway cluster (initdb + pg_ctl from
 * PATH, Homebrew's postgresql@*, or Debian's /usr/lib/postgresql/*) in a temp directory on a free
 * port and stops it afterwards. Without Postgres binaries those tests skip, unless
 * SITE_API_REQUIRE_POSTGRES=1 makes them fail. The exit code is the test run's.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(args) {
  if (args.length) return args;
  return readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => path.join('tests', name));
}

function versionOf(dir) {
  return Number(/postgresql(?:@|\/)(\d+)/.exec(dir)?.[1] ?? 0);
}

function listDirs(parent, pattern) {
  try {
    return readdirSync(parent).filter((name) => pattern.test(name)).map((name) => path.join(parent, name, 'bin'));
  } catch {
    return [];
  }
}

/** The bin directory holding both initdb and pg_ctl, newest version first; null when none is found. */
export function findPostgresBin(env = process.env) {
  const candidates = [
    ...String(env.PATH ?? '').split(path.delimiter).filter(Boolean),
    ...listDirs('/opt/homebrew/opt', /^postgresql@\d+$/).sort((a, b) => versionOf(b) - versionOf(a)),
    ...listDirs('/usr/local/opt', /^postgresql@\d+$/).sort((a, b) => versionOf(b) - versionOf(a)),
    ...listDirs('/usr/lib/postgresql', /^\d+$/).sort((a, b) => versionOf(b) - versionOf(a)),
  ];
  return candidates.find((dir) => existsSync(path.join(dir, 'initdb')) && existsSync(path.join(dir, 'pg_ctl'))) ?? null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** initdb + pg_ctl start on 127.0.0.1:<free port>. Resolves to `{ url, stop }`. */
async function startCluster(bin) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'site-api-pg-'));
  const data = path.join(dir, 'data');
  const port = await freePort();
  // macOS postgres refuses to start without a valid LC_ALL ("postmaster became multithreaded").
  const env = { ...process.env, LC_ALL: 'C' };
  try {
    execFileSync(path.join(bin, 'initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C', '--no-sync'], { stdio: 'pipe', env });
    execFileSync(path.join(bin, 'pg_ctl'), [
      '-D', data, '-l', path.join(dir, 'postgres.log'), '-w', '-t', '30',
      '-o', `-p ${port} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`,
      'start',
    ], { stdio: 'pipe', env });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`could not start a throwaway Postgres: ${String(error.stderr ?? error.message).trim()}`);
  }
  let stopped = false;
  return {
    url: `postgresql://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        execFileSync(path.join(bin, 'pg_ctl'), ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'pipe', env });
      } catch {
        // Already gone; the directory is removed either way.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function runTests(files, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--test', '--test-force-exit', ...files], { cwd: root, env, stdio: 'inherit' });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('exit', (code, signal) => {
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

async function main() {
  const files = testFiles(process.argv.slice(2));
  const env = { ...process.env };
  let cluster = null;
  if (!env.SITE_API_TEST_DATABASE_URL) {
    const bin = findPostgresBin(env);
    if (bin) {
      try {
        cluster = await startCluster(bin);
        env.SITE_API_TEST_DATABASE_URL = cluster.url;
        process.stderr.write(`[site-api test] throwaway Postgres from ${bin}\n`);
      } catch (error) {
        process.stderr.write(`[site-api test] ${error.message}\n`);
      }
    } else {
      process.stderr.write('[site-api test] no initdb/pg_ctl found and SITE_API_TEST_DATABASE_URL is unset: Postgres tests skip\n');
    }
  }
  try {
    process.exitCode = await runTests(files, env);
  } finally {
    cluster?.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

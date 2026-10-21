// 타입 검사기 비교: TypeScript 7 (tsc), tsrs (oxc), tsc-rs (pingdotgg/ts-rust) 를 Studio 와 허브
// tsconfig 에 같은 순서로 돌려 벽시계 시간, 최대 RSS, 진단 지문을 적는다.
//
// 사용 (rhwp/rhwp-studio 에서):
//   node bench/typecheck-bench.mjs [--runs=10] [--out=<json>] [--tsc-rs-wasm=<ts-rust/npm/wasm/bin/tsc-wasm.js>]
//
// 비교 대상은 저장소 의존성에 넣지 않고 <repo>/.run/typecheck-bench/tools 에 고정 버전으로 설치한다.
// tsc-rs 의 wasm 빌드는 npm 에 없어서 ts-rust 저장소에서 scripts/wasm/build.sh 로 만든 것을
// --tsc-rs-wasm 으로 넘길 때만 잰다. 첫 실행은 예열로 버리고 중앙값과 최솟값을 적는다.
// 진단 지문이 tsc 와 다르면 그 검사기는 결과가 다르다는 뜻이다.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const studioRoot = fileURLToPath(new URL('../', import.meta.url));
const repoRoot = path.resolve(studioRoot, '../..');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=');
  return [key, value.join('=') || true];
}));
const runs = Number(args.runs ?? 10);

const VERSIONS = {
  tsrs: '0.18.0-ts7.1.0-dev.20260929',
  '@tsrs/wasm': '0.18.0-ts7.1.0-dev.20260929',
  'tsc-rs': '0.7.0',
};
const toolsDir = path.join(repoRoot, '.run/typecheck-bench/tools');
const stamp = path.join(toolsDir, 'versions.json');
if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== JSON.stringify(VERSIONS)) {
  fs.rmSync(toolsDir, { recursive: true, force: true });
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'package.json'), '{"private":true}');
  // tsc-rs 의 postinstall 은 플랫폼 패키지가 빠졌을 때만 쓰는 대체 경로라 스크립트 없이 설치한다.
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', ...Object.entries(VERSIONS).map(([n, v]) => `${n}@${v}`)], {
    cwd: toolsDir, stdio: 'inherit', shell: process.platform === 'win32',
  });
  fs.writeFileSync(stamp, JSON.stringify(VERSIONS));
}

// 세 검사기 모두 Node 런처를 거쳐 네이티브 실행 파일을 띄운다. 런처 비용(약 20–30 ms, tsc-rs 는
// postinstall 실행 여부에 따라 달라짐)을 빼고 검사기만 비교하도록 플랫폼 패키지의 실행 파일을 바로 부른다.
const target = `${process.platform}-${process.arch}`;
const exe = process.platform === 'win32' ? '.exe' : '';
const native = (dir, rel) => [path.join(dir, 'node_modules', `${rel}${exe}`)];
const node = (script) => [process.execPath, script];
const checkers = [
  ['tsc 7', (dir) => native(dir, `@typescript/typescript-${target}/lib/tsc`)],
  ['tsrs', () => native(toolsDir, `@tsrs/${target}${process.platform === 'linux' ? '-gnu' : ''}/tsrs`)],
  ['tsc-rs', () => native(toolsDir, `@tsc-rs/${target}/lib/tsc`)],
  ['tsc-rs --fast', () => [...native(toolsDir, `@tsc-rs/${target}/lib/tsc`), '--fast']],
  ['tsrs wasm', () => node(path.join(toolsDir, 'node_modules/@tsrs/wasm/bin/tsrs-wasm.js'))],
  ...(args['tsc-rs-wasm'] ? [['tsc-rs wasm', () => node(path.resolve(args['tsc-rs-wasm']))]] : []),
];
const projects = [
  ['studio', studioRoot, 'tsconfig.json'],
  ['hub', path.join(repoRoot, 'rhwp/rhwp-agent'), 'tsconfig.agents.json'],
];

// macOS 는 BSD time -l (바이트), 리눅스는 GNU time -v (KiB). 없으면 메모리는 비운다.
const timeFlag = { darwin: '-l', linux: '-v' }[process.platform];
const hasTime = timeFlag && fs.existsSync('/usr/bin/time');
function peakRss(stderr) {
  const bsd = stderr.match(/(\d+)\s+maximum resident set size/);
  if (bsd) return Number(bsd[1]) / 2 ** 20;
  const gnu = stderr.match(/Maximum resident set size \(kbytes\): (\d+)/);
  return gnu ? Number(gnu[1]) / 1024 : null;
}

const rows = [];
for (const [project, cwd, config] of projects) {
  for (const [checker, command] of checkers) {
    const argv = [...command(cwd), '-p', config];
    const times = [];
    let rss = null;
    let diagnostics = [];
    for (let i = 0; i <= runs; i++) {
      const [file, ...rest] = hasTime ? ['/usr/bin/time', timeFlag, ...argv] : argv;
      const start = process.hrtime.bigint();
      const result = spawnSync(file, rest, { cwd, encoding: 'utf8' });
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (result.error) throw result.error;
      if (i === 0) {
        diagnostics = result.stdout.split(/\r?\n/).filter((line) => /error TS\d+/.test(line)).sort();
        continue;
      }
      times.push(ms);
      const peak = peakRss(result.stderr);
      if (peak != null) rss = Math.max(rss ?? 0, peak);
    }
    times.sort((a, b) => a - b);
    rows.push({
      project,
      checker,
      medianMs: Math.round(times[times.length >> 1]),
      minMs: Math.round(times[0]),
      peakRssMiB: rss == null ? null : Math.round(rss),
      errors: diagnostics.length,
      diagnostics: createHash('sha1').update(diagnostics.join('\n')).digest('hex').slice(0, 8),
    });
  }
}

console.log(`${os.platform()} ${os.arch()}, ${os.cpus().length} CPUs, ${os.cpus()[0]?.model ?? ''}, node ${process.version}, runs ${runs}`);
console.table(rows);
if (args.out) fs.writeFileSync(args.out, `${JSON.stringify({ host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length }, versions: VERSIONS, rows }, null, 2)}\n`);

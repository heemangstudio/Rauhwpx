import { spawn as nodeSpawn } from 'node:child_process';
import { readlink, realpath } from 'node:fs/promises';
import path from 'node:path';

// 자동 수정 에이전트의 프로세스 정리. CLI 가 끝나면 부모 연결을 잃은 손자(백그라운드로 띄운 것 등)는
// 트리 종료로 찾을 수 없다. 그래서 도는 동안 자손을 주기적으로 기록해 두고, 끝난 뒤 아직 살아 있는 것을
// 시작 시각까지 같을 때만(PID 재사용 방지) 끝낸다.

/** macOS·Linux `ps -A -o pid=,ppid=,pgid=,uid=,lstart=` 출력. lstart 는 `Tue Oct 21 10:00:00 2026` 모양이다. */
export function parsePsListing(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), uid: Number(match[4]), start: match[5] });
  }
  return rows;
}

/** Windows PowerShell 이 찍은 `pid,ppid,creationFileTime` 줄. */
export function parseWindowsProcessListing(text) {
  const rows = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+),(\d+),(\d*)\s*$/.exec(line);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: null, start: match[3] || null });
  }
  return rows;
}

const WINDOWS_LIST_SCRIPT = 'Get-CimInstance Win32_Process | ForEach-Object { "{0},{1},{2}" -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { "" }) }';

function windowsSystemPath(env, ...parts) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR ?? 'C:\\Windows';
  return path.win32.join(root, 'System32', ...parts);
}

/** 창 없이 한 번 실행하고 stdout 을 돌려준다. 시간이 넘거나 실패하면 null. */
function runHidden(spawnProcess, command, args, { env, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(command, args, { shell: false, detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(null); }, timeoutMs);
    child.stdout?.on('data', (chunk) => { out += String(chunk); });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code === 0 ? out : null); });
  });
}

/**
 * 지금의 프로세스 목록을 읽는 함수. 실패하면 null(정리 결과를 'uncertain' 으로 남긴다).
 * @returns {() => Promise<Array<{ pid: number, ppid: number, pgid: number|null, start: string|null }> | null>}
 */
export function createProcessLister({ platform = process.platform, spawnProcess = nodeSpawn, env = process.env } = {}) {
  if (platform === 'win32') {
    const powershell = windowsSystemPath(env, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return async () => {
      const out = await runHidden(spawnProcess, powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_LIST_SCRIPT], { env, timeoutMs: 20_000 });
      return out === null ? null : parseWindowsProcessListing(out);
    };
  }
  return async () => {
    const out = await runHidden(spawnProcess, '/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,uid=,lstart='], { env: { ...env, LC_ALL: 'C' } });
    return out === null ? null : parsePsListing(out);
  };
}

/** 목록에서 root 의 자손(그리고 POSIX 에서는 root 의 프로세스 그룹)을 찾는다. root 자신도 넣는다. */
export function treeMembers(rootPid, listing) {
  const children = new Map();
  for (const row of listing) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const found = new Map();
  const queue = listing.filter((row) => row.pid === rootPid || (row.pgid !== null && row.pgid === rootPid));
  while (queue.length > 0) {
    const row = queue.shift();
    if (found.has(row.pid)) continue;
    found.set(row.pid, row);
    for (const child of children.get(row.pid) ?? []) queue.push(child);
  }
  return [...found.values()];
}

/**
 * 도는 동안 root 트리를 주기적으로 기록한다. 같은 PID 가 다른 시작 시각으로 다시 보이면 다른 프로세스다.
 */
export function createTreeWatcher({ rootPid, list, intervalMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
  /** pid → start */
  const tracked = new Map();
  /**
   * 기록된 프로세스가 이끈 프로세스 그룹. CLI 가 명령마다 새 그룹을 만들면(Claude 의 Bash 도구) 그 셸이 곧 끝나도
   * 셸이 백그라운드로 남긴 것은 같은 그룹 id 를 지닌다. 그 셸을 한 번이라도 봤다면 고아가 된 뒤에도 찾는다.
   */
  const groups = new Set([rootPid]);
  let timer = null;
  let stopped = false;
  let pending = Promise.resolve();
  let failures = 0;
  async function snapshot() {
    const listing = await list().catch(() => null);
    if (!listing) {
      failures += 1;
      return null;
    }
    for (const row of treeMembers(rootPid, listing)) {
      if (!tracked.has(row.pid)) tracked.set(row.pid, row.start);
    }
    for (const row of listing) {
      if (tracked.has(row.pid) && row.pgid === row.pid) groups.add(row.pid);
    }
    for (const row of listing) {
      if (tracked.has(row.pid) || row.pgid === null || row.pgid <= 1 || !groups.has(row.pgid)) continue;
      tracked.set(row.pid, row.start);
    }
    // root 와 연결이 끊긴(부모가 먼저 끝난) 기록된 프로세스의 자식도 따라간다. 부모가 같은 시작 시각일 때만.
    const byPid = new Map(listing.map((row) => [row.pid, row]));
    let added = true;
    while (added) {
      added = false;
      for (const row of listing) {
        if (tracked.has(row.pid)) continue;
        const parent = byPid.get(row.ppid);
        if (!parent || !tracked.has(parent.pid)) continue;
        const start = tracked.get(parent.pid);
        if (start && parent.start && start !== parent.start) continue;
        tracked.set(row.pid, row.start);
        added = true;
      }
    }
    return listing;
  }
  const tick = () => {
    if (stopped) return;
    pending = snapshot().finally(() => {
      if (!stopped) timer = setTimer(tick, intervalMs);
    });
  };
  tick();
  return {
    tracked,
    get failures() { return failures; },
    /** 마지막 기록이 끝날 때까지 기다리고 멈춘다. */
    async stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      await pending.catch(() => {});
    },
    snapshot,
  };
}

/** 기록된 것 가운데 같은 시작 시각으로 아직 살아 있는 것. */
export function aliveTracked(tracked, listing, { exclude = [] } = {}) {
  const alive = [];
  for (const row of listing) {
    if (exclude.includes(row.pid) || !tracked.has(row.pid)) continue;
    const start = tracked.get(row.pid);
    if (start && row.start && start !== row.start) continue;
    alive.push(row);
  }
  return alive;
}

/** 프로세스 하나(Windows 는 그 아래 트리까지)를 끝낸다. */
export function createProcessKiller({ platform = process.platform, spawnProcess = nodeSpawn, env = process.env, killProcess = process.kill } = {}) {
  if (platform === 'win32') {
    const taskkill = windowsSystemPath(env, 'taskkill.exe');
    return (pid) => runHidden(spawnProcess, taskkill, ['/PID', String(pid), '/T', '/F'], { env, timeoutMs: 10_000 }).then(() => undefined);
  }
  return async (pid) => {
    try { killProcess(pid, 'SIGKILL'); } catch {}
  };
}

/**
 * 살아남은 기록된 프로세스를 끝내고 다시 확인한다.
 * @returns {Promise<{ found: number, remaining: number | null }>} remaining 이 null 이면 목록을 읽지 못했다.
 */
export async function killSurvivors({ tracked, list, kill, exclude = [], settleMs = 300, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const listing = await list().catch(() => null);
  if (!listing) return { found: 0, remaining: null };
  const survivors = aliveTracked(tracked, listing, { exclude });
  if (survivors.length === 0) return { found: 0, remaining: 0 };
  for (const row of survivors) await kill(row.pid);
  await sleep(settleMs);
  const after = await list().catch(() => null);
  if (!after) return { found: survivors.length, remaining: null };
  return { found: survivors.length, remaining: aliveTracked(tracked, after, { exclude }).length };
}

/**
 * POSIX 프로세스들의 현재 폴더. macOS 는 lsof, Linux 는 /proc/<pid>/cwd. 읽지 못한 것은 빠진다.
 * @returns {(pids: number[]) => Promise<Map<number, string>>}
 */
export function createCwdReader({ platform = process.platform, spawnProcess = nodeSpawn, env = process.env } = {}) {
  if (platform === 'win32') return async () => new Map();
  if (platform === 'linux') {
    return async (pids) => {
      const out = new Map();
      for (const pid of pids) {
        const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
        if (cwd) out.set(pid, cwd);
      }
      return out;
    };
  }
  return async (pids) => {
    const out = new Map();
    if (pids.length === 0) return out;
    const text = await runHidden(spawnProcess, '/usr/sbin/lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fpn'], { env });
    let pid = null;
    for (const line of String(text ?? '').split('\n')) {
      if (line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
    }
    return out;
  };
}

/**
 * 트리 기록으로 못 찾은 고아. 명령마다 새 프로세스 그룹을 만들고 곧 끝나는 셸(Claude 의 Bash 도구)이 백그라운드로
 * 남긴 것은 부모 연결도 그룹 리더도 남지 않는다. 그래서 아래를 모두 만족할 때만 이번 실행이 남긴 것으로 본다:
 * launchd/init(1) 아래로 넘어갔고, 같은 사용자이고, 실행 중에 시작했고, 그룹 리더가 아니고(데몬·앱은 리더다),
 * 현재 폴더가 이번 실행의 작업 폴더(앱의 사용자 데이터 폴더) 안이다.
 */
export async function findRunOrphans({ listing, tracked, since, uid, dir, readCwd, resolvePath = (file) => realpath(file).catch(() => file) }) {
  if (!dir || uid === null || uid === undefined) return [];
  const candidates = listing.filter((row) => row.ppid === 1 && row.uid === uid && !tracked.has(row.pid)
    && row.pgid !== row.pid && Number.isFinite(Date.parse(row.start)) && Date.parse(row.start) >= since - 1_000);
  if (candidates.length === 0) return [];
  const root = await resolvePath(dir);
  const cwds = await readCwd(candidates.map((row) => row.pid)).catch(() => new Map());
  // POSIX 에서만 돈다(Windows 는 uid 가 없다). 경로 구분자도 POSIX 것으로 본다.
  const inside = (cwd) => cwd === root || cwd.startsWith(root.endsWith('/') ? root : `${root}/`);
  const found = [];
  for (const row of candidates) {
    const cwd = cwds.get(row.pid);
    if (cwd && inside(await resolvePath(cwd))) found.push(row);
  }
  return found;
}

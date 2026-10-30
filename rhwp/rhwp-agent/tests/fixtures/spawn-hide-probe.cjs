'use strict';

/**
 * 테스트 프로브: libuv 로 내려가는 스폰마다 windowsHide 플래그가 실렸는지 기록한다. child_process 의 어떤
 * 래퍼(spawn, exec, cross-spawn …)를 지나든 마지막에 process_wrap 의 Process#spawn 을 부르므로 그 한 곳을 본다.
 * Node 24 는 (file, args, cwd, envPairs, stdio, flags, …), Node 22 는 옵션 객체 하나를 넘긴다.
 *
 * `--require` 로 읽히고 RHWP_TEST_HUB_SPAWN_PROBE 가 결과 파일 경로면, 허브가 준비 줄을 쓴 직후 서드파티
 * 코드처럼 windowsHide 없이 콘솔 프로그램을 하나 띄우고 그 스폰의 플래그를 JSON 으로 남긴다.
 */

const fs = require('fs');

const wrap = process.binding('process_wrap');
const HIDE = wrap.constants ? wrap.constants.kProcessFlagWindowsHide : 0;
/** @type {{ args: string[], windowsHide: boolean }[]} */
const spawns = [];
const original = wrap.Process.prototype.spawn;
wrap.Process.prototype.spawn = function spawn(first, ...rest) {
  const positional = typeof first !== 'object' || first === null;
  spawns.push({
    args: (positional ? rest[0] : first.args) ?? [],
    windowsHide: positional ? Boolean(rest[4] & HIDE) : first.windowsHide === true,
  });
  return original.call(this, first, ...rest);
};

const HUB_PROBE_MARKER = 'rhwp-hub-spawn-probe';

function spawnAfterHubReady(out) {
  const write = process.stdout.write;
  process.stdout.write = function probeWrite(chunk, ...rest) {
    if (String(chunk).startsWith('RHWP_HUB_READY ')) {
      process.stdout.write = write;
      setImmediate(() => {
        const child = require('child_process').spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `rem ${HUB_PROBE_MARKER}`], {
          stdio: 'ignore',
        });
        child.on('error', () => {});
        const flags = spawns
          .filter((spawn) => spawn.args.some((arg) => String(arg).includes(HUB_PROBE_MARKER)))
          .map((spawn) => spawn.windowsHide);
        fs.writeFileSync(`${out}.tmp`, JSON.stringify(flags));
        fs.renameSync(`${out}.tmp`, out);
      });
    }
    return write.call(this, chunk, ...rest);
  };
}

if (module.isPreloading === true && process.env.RHWP_TEST_HUB_SPAWN_PROBE) {
  spawnAfterHubReady(process.env.RHWP_TEST_HUB_SPAWN_PROBE);
}

module.exports = { spawns };

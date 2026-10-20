import { promises as fs } from 'node:fs';
import { resolveCommandOnPath } from './npm-cli-launch.mjs';

/**
 * CLI `--version` 출력을 실행 파일의 실제 경로·크기·수정 시각·inode 로 기억한다.
 * 설치나 업데이트로 파일이 바뀌면 키가 달라져 다시 실행한다. 성공한 출력만 기억하고,
 * 같은 파일을 동시에 묻는 요청은 한 번의 실행으로 합친다. 설정 상태와 제공자 상태가 함께 쓴다.
 */
export function createCliVersionCache({ stat = fs.stat, realpath = fs.realpath, resolveCommand = resolveCommandOnPath } = {}) {
  const outputs = new Map();
  const inFlight = new Map();

  async function fileKey(command, env) {
    try {
      const file = resolveCommand(command, { env: env ?? process.env });
      if (!file) return null;
      const real = await realpath(file);
      const info = await stat(real);
      return `${real}\0${info.size}\0${info.mtimeMs}\0${info.ino}`;
    } catch {
      return null;
    }
  }

  return {
    /**
     * run() 은 `{ ok, stdout }` 를 돌려준다. 기억한 성공 출력이 있으면 run() 을 부르지 않는다.
     * @param {string} command
     * @param {() => Promise<{ ok: boolean, stdout?: string } & Record<string, unknown>>} run
     */
    async probe(command, run, { env } = {}) {
      const key = await fileKey(command, env);
      if (!key) return run();
      if (outputs.has(key)) return { ok: true, stdout: outputs.get(key), cached: true };
      const running = inFlight.get(key);
      if (running) {
        // 다른 쪽이 돌린 실행이 실패하면 그 실패 내용 대신 내 실행으로 다시 확인한다.
        const shared = await running;
        return shared?.ok ? { ok: true, stdout: shared.stdout, cached: true } : run();
      }
      const pending = Promise.resolve().then(run).then((result) => {
        if (result?.ok) outputs.set(key, String(result.stdout ?? ''));
        return result;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, pending);
      return pending;
    },
  };
}

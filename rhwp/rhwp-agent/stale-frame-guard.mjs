/**
 * Playwright 1.64 의 CDP 이벤트 처리기는 세션이 사라진 프레임의 lifecycle 이벤트를 받으면
 * `Frame has been detached.` 를 던진다. 이벤트 처리기 안이라 잡히지 않고 허브 전체가 종료된다.
 * 이 오류만 기록하고 넘기며, 다른 예외는 그대로 프로세스를 끝내 데스크톱이 허브를 다시 띄우게 한다.
 */
export function isPlaywrightStaleFrameError(error) {
  return error instanceof Error && error.message === 'Frame has been detached.'
    && /[\\/]playwright-core[\\/]/.test(error.stack ?? '') && /_eventBelongsToStaleFrame|_sessionForFrame/.test(error.stack ?? '');
}

export function installStaleFrameGuard(target = process, log = console) {
  let reported = 0;
  target.on('uncaughtException', (error, origin) => {
    if (isPlaywrightStaleFrameError(error)) {
      if (reported++ < 5) log.warn('[rhwp-agent] ignored a Playwright event for a detached browser frame');
      return;
    }
    log.error(origin === 'unhandledRejection' ? '[rhwp-agent] unhandled rejection' : '[rhwp-agent] uncaught exception', error);
    target.exit(1);
  });
}

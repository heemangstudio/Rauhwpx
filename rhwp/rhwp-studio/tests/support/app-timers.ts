/**
 * 앱 코드가 건 타이머(토스트 닫기, 다운로드 URL 정리 같은 수 초짜리 뒷정리)를 모은다.
 * 테스트가 끝난 뒤에도 이 타이머가 프로세스를 붙잡아 파일 하나가 수 초씩 늘어나므로,
 * 끝날 때 프로세스 수명에서 떼어 낸다(unref). 동작은 바꾸지 않는다.
 */
export function trackAppTimers(): () => void {
  const original = globalThis.setTimeout;
  const handles: Array<ReturnType<typeof setTimeout>> = [];
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = original(...args);
    handles.push(handle);
    return handle;
  }) as typeof setTimeout;
  return () => {
    globalThis.setTimeout = original;
    for (const handle of handles) (handle as { unref?: () => void }).unref?.();
  };
}

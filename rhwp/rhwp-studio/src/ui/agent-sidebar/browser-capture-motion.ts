/** 캡처와 첨부를 이어 주는 짧은 피드백. 페이지 입력과 저장은 기다리지 않는다. */
export function createBrowserCaptureMotion(trigger: HTMLElement) {
  let pulse: Animation | null = null;
  let cleanupFlight: (() => void) | null = null;
  let generation = 0;
  let origin: DOMRect | null = null;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const highlight = (target: HTMLElement) => target.animate([
    { boxShadow: '0 0 0 0 rgba(100, 160, 120, 0)' },
    { boxShadow: '0 0 0 3px rgba(100, 160, 120, .32)', offset: .3 },
    { boxShadow: '0 0 0 0 rgba(100, 160, 120, 0)' },
  ], { duration: 300, easing: 'ease-out' });

  function stop(): void {
    generation++;
    pulse?.cancel(); pulse = null;
    cleanupFlight?.(); cleanupFlight = null;
  }
  return {
    start() {
      stop(); origin = trigger.getBoundingClientRect();
      pulse = trigger.animate([{ opacity: 1 }, { opacity: .45 }, { opacity: 1 }],
        { duration: reduced() ? 1200 : 700, iterations: Infinity, easing: 'ease-in-out' });
    },
    finish(file: File | undefined, destination: HTMLElement | null) {
      pulse?.cancel(); pulse = null;
      const source = origin; origin = null;
      const target = destination?.getBoundingClientRect();
      if (!destination || !target?.width || !target.height || !destination.checkVisibility()) {
        highlight(trigger); return;
      }
      if (reduced() || !file || !source?.width) { highlight(destination); return; }
      const token = generation;
      const thumbnail = document.createElement('img');
      thumbnail.className = 'ag-browser-capture-flight'; thumbnail.alt = ''; thumbnail.setAttribute('aria-hidden', 'true');
      const url = URL.createObjectURL(file); thumbnail.src = url;
      // 뷰포트 전체를 복제하지 않고 작은 카드 한 장만 잠깐 유지한다.
      const width = 80, height = 60;
      const x = source.x + source.width / 2 - width / 2;
      const y = Math.max(0, source.y + source.height / 2 - height / 2);
      Object.assign(thumbnail.style, { left: `${x}px`, top: `${y}px` });
      let flight: Animation | null = null; let arrival: Animation | null = null;
      const cleanup = () => {
        flight?.cancel(); arrival?.cancel(); thumbnail.remove(); URL.revokeObjectURL(url);
        if (cleanupFlight === cleanup) cleanupFlight = null;
      };
      cleanupFlight = cleanup;
      void thumbnail.decode().then(() => {
        if (generation !== token || !destination.isConnected) { cleanup(); return; }
        document.body.append(thumbnail);
        const dx = target.x + Math.min(target.width / 2, 32) - width / 2 - x;
        const dy = target.y + target.height / 2 - height / 2 - y;
        flight = thumbnail.animate([
          { transform: 'translate(0, 0) scale(.7)', opacity: 0 },
          { transform: 'translate(0, -8px) scale(1)', opacity: .95, offset: .18 },
          { transform: `translate(${dx * .8}px, -8px) scale(.8)`, opacity: .9, offset: .55 },
          { transform: `translate(${dx}px, ${dy}px) scale(.18)`, opacity: 0 },
        ], { duration: 620, easing: 'cubic-bezier(.22, .8, .3, 1)', fill: 'both' });
        void flight.finished.then(async () => {
          thumbnail.remove(); URL.revokeObjectURL(url);
          if (!destination.isConnected || generation !== token) return;
          arrival = highlight(destination); await arrival.finished;
        }).catch(() => undefined).finally(cleanup);
      }).catch(cleanup);
    },
    cancel: stop,
  };
}

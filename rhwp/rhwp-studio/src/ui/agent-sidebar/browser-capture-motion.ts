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
      const thumbnail = document.createElement('canvas');
      thumbnail.className = 'ag-browser-capture-flight'; thumbnail.setAttribute('aria-hidden', 'true');
      thumbnail.width = 20; thumbnail.height = 15;
      // 실제 첨부는 원본 그대로 두고 동작에 쓸 픽셀 덩어리만 작게 만든다.
      const width = 80, height = 60;
      const x = source.x + source.width / 2 - width / 2;
      const y = Math.max(0, source.y + source.height / 2 - height / 2);
      Object.assign(thumbnail.style, { left: `${x}px`, top: `${y}px` });
      let flight: Animation | null = null; let arrival: Animation | null = null;
      const cleanup = () => {
        flight?.cancel(); arrival?.cancel(); thumbnail.remove();
        if (cleanupFlight === cleanup) cleanupFlight = null;
      };
      cleanupFlight = cleanup;
      void createImageBitmap(file, { resizeWidth: 20, resizeHeight: 15, resizeQuality: 'pixelated' }).then(bitmap => {
        try {
          if (generation !== token || !destination.isConnected) { cleanup(); return; }
          const context = thumbnail.getContext('2d')!;
          context.imageSmoothingEnabled = false;
          context.drawImage(bitmap, 0, 0);
          context.fillStyle = 'rgba(100, 160, 120, .18)'; context.fillRect(0, 0, 20, 15);
        } finally { bitmap.close(); }
        document.body.append(thumbnail);
        const dx = target.x + Math.min(target.width / 2, 32) - width / 2 - x;
        const dy = target.y + target.height / 2 - height / 2 - y;
        // 같은 비율로 X/Y를 옮겨 직선으로 흘러가며 투명도만 바꾼다.
        flight = thumbnail.animate([
          { transform: 'translate(0, 0)', opacity: 0 },
          { transform: `translate(${dx * .08}px, ${dy * .08}px)`, opacity: .65, offset: .08 },
          { transform: `translate(${dx * .85}px, ${dy * .85}px)`, opacity: .5, offset: .85 },
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 0 },
        ], { duration: 1300, easing: 'linear', fill: 'both' });
        void flight.finished.then(async () => {
          thumbnail.remove();
          if (!destination.isConnected || generation !== token) return;
          arrival = highlight(destination); await arrival.finished;
        }).catch(() => undefined).finally(cleanup);
      }).catch(cleanup);
    },
    cancel: stop,
  };
}

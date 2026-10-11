/** 입력을 막지 않고 캡처 버튼과 실제 첨부에만 짧게 피드백을 준다. */
export function createBrowserCaptureMotion(trigger: HTMLElement) {
  let pulse: Animation | null = null;
  let press: Animation | null = null;
  let arrival: Animation | null = null;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function stop(): void {
    pulse?.cancel(); pulse = null;
    press?.cancel(); press = null;
    arrival?.cancel(); arrival = null;
  }
  return {
    start() {
      stop();
      if (!reduced()) press = trigger.animate([
        { transform: 'scale(1)' },
        { transform: 'scale(.94)', offset: .35 },
        { transform: 'scale(1)' },
      ], { duration: 200, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      pulse = trigger.animate([{ opacity: 1 }, { opacity: .72 }, { opacity: 1 }],
        { duration: 1000, iterations: Infinity, easing: 'ease-in-out' });
    },
    finish(destination: HTMLElement | null) {
      pulse?.cancel(); pulse = null;
      const target = destination?.getBoundingClientRect();
      const node = destination && target?.width && target.height && destination.checkVisibility() ? destination : trigger;
      const frames: Keyframe[] = [
        { opacity: .55, boxShadow: '0 0 0 0 rgba(100, 160, 120, 0)' },
        { opacity: 1, boxShadow: '0 0 0 2px rgba(100, 160, 120, .18)', offset: .5 },
        { opacity: 1, boxShadow: '0 0 0 0 rgba(100, 160, 120, 0)' },
      ];
      if (!reduced() && node === destination) {
        frames[0].transform = 'scale(.985)';
        frames[1].transform = frames[2].transform = 'scale(1)';
      }
      arrival = node.animate(frames, { duration: 260, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    },
    cancel: stop,
  };
}

/** 처음 설정의 말풍선과 하마. 사이드바의 그림·공중제비·잠수·헤엄 동작을 함께 쓴다. */
import { Hama, type ChatHamaMode } from '../agent-sidebar/chat-hama.ts';

const TYPE_MS = 40;
const TRICKS = ['backflip', 'swim', 'splash', 'hop', 'shuffle'] as const;

export interface Hippo {
  element: HTMLElement;
  say(line: string): void;
  cheer(line?: string): void;
  celebrate(line: string): void;
  dispose(): void;
}

export function createHippo(): Hippo {
  const element = document.createElement('div');
  element.className = 'rhwp-setup-hippo';
  const stage = document.createElement('button');
  stage.className = 'rhwp-setup-hippo-stage';
  stage.type = 'button';
  stage.setAttribute('aria-label', '하마 재주 보기');
  const hama = new Hama(1);
  hama.idleActions = TRICKS;
  hama.setBounds(0, 6);
  stage.append(hama.el);

  const bubble = document.createElement('p');
  bubble.className = 'rhwp-setup-say';
  const typed = document.createElement('span');
  typed.className = 'rhwp-setup-say-typed';
  typed.setAttribute('aria-hidden', 'true');
  const spoken = document.createElement('span');
  spoken.className = 'visually-hidden';
  spoken.setAttribute('aria-live', 'polite');
  bubble.append(typed, spoken);
  element.append(stage, bubble);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let visible = false;
  let typeTimer = 0;
  let poseTimer = 0;
  let trickIndex = 0;

  function sync(): void {
    hama.setActive(visible && element.isConnected && document.visibilityState !== 'hidden', !reducedMotion.matches);
  }

  function setMode(mode: ChatHamaMode): void {
    hama.setMode(mode);
    sync();
  }

  function performTrick(): void {
    if (reducedMotion.matches) return;
    setMode('idle');
    const trick = TRICKS[trickIndex++ % TRICKS.length]!;
    stage.dataset.action = trick;
    hama.play(trick);
  }

  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? false;
    sync();
  });
  observer?.observe(element);
  document.addEventListener('visibilitychange', sync);
  reducedMotion.addEventListener('change', sync);
  stage.addEventListener('click', () => {
    if (hama.mode === 'talk' || hama.mode === 'done') return;
    performTrick();
  });

  function say(line: string, done?: () => void): void {
    window.clearInterval(typeTimer);
    window.clearTimeout(poseTimer);
    spoken.textContent = line;
    if (reducedMotion.matches) {
      typed.textContent = line;
      setMode('idle');
      done?.();
      return;
    }
    const chars = Array.from(line);
    let shown = 0;
    typed.textContent = '';
    setMode('talk');
    typeTimer = window.setInterval(() => {
      typed.textContent = chars.slice(0, ++shown).join('');
      if (shown >= chars.length) {
        window.clearInterval(typeTimer);
        setMode('idle');
        done?.();
      }
    }, TYPE_MS);
  }

  return {
    element,
    say,
    cheer(line?: string): void {
      const cheer = () => {
        setMode('done');
        poseTimer = window.setTimeout(() => setMode('idle'), 1400);
      };
      if (line) say(line, cheer);
      else cheer();
    },
    celebrate(line: string): void {
      say(line, () => setMode('done'));
    },
    dispose(): void {
      window.clearInterval(typeTimer);
      window.clearTimeout(poseTimer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
      reducedMotion.removeEventListener('change', sync);
      hama.dispose();
    },
  };
}

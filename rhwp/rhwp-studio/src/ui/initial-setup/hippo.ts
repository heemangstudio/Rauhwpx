/**
 * 설정 화면의 하마. 설명은 UI 문구 대신 하마의 말풍선 한 줄로 한다.
 *
 * 자세는 scripts/generate-boot-logo.py 가 만든 public/images/boot/hama-sprites.png 의 칸이다.
 * 칸 순서(SPRITE_POSES)와 크기를 바꾸면 여기도 같이 바꾼다.
 */

export const HIPPO_POSES = ['closed', 'talk', 'open', 'blink'] as const;
export type HippoPose = (typeof HIPPO_POSES)[number];

const CELL_WIDTH = 26;
const SCALE = 3;
const TYPE_MS = 40;
const MOUTH_MS = 120;
const CHEER_MS = 900;

export interface Hippo {
  element: HTMLElement;
  /** 말풍선에 한 줄을 타이핑하며 입을 움직인다. */
  say(line: string): void;
  /** 잘 됐을 때 앱 아이콘처럼 입을 크게 벌린다. */
  cheer(line?: string): void;
  dispose(): void;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function createHippo(): Hippo {
  const element = document.createElement('div');
  element.className = 'rhwp-setup-hippo';

  const sprite = document.createElement('span');
  sprite.className = 'rhwp-setup-hippo-sprite';
  sprite.setAttribute('aria-hidden', 'true');

  const bubble = document.createElement('p');
  bubble.className = 'rhwp-setup-say';
  // 글자를 하나씩 찍는 쪽은 읽지 않고, 완성된 문장만 한 번 읽힌다.
  const typed = document.createElement('span');
  typed.className = 'rhwp-setup-say-typed';
  typed.setAttribute('aria-hidden', 'true');
  const spoken = document.createElement('span');
  spoken.className = 'visually-hidden';
  spoken.setAttribute('aria-live', 'polite');
  bubble.append(typed, spoken);
  element.append(sprite, bubble);

  let typeTimer = 0;
  let mouthTimer = 0;
  let poseTimer = 0;
  let blinkTimer = 0;

  function pose(name: HippoPose): void {
    sprite.style.backgroundPositionX = `${-HIPPO_POSES.indexOf(name) * CELL_WIDTH * SCALE}px`;
    element.dataset.pose = name;
  }

  function stopTalking(): void {
    window.clearInterval(typeTimer);
    window.clearInterval(mouthTimer);
  }

  function stopMotion(): void {
    stopTalking();
    window.clearTimeout(poseTimer);
  }

  function scheduleBlink(): void {
    window.clearTimeout(blinkTimer);
    if (prefersReducedMotion()) return;
    blinkTimer = window.setTimeout(() => {
      if (element.dataset.pose === 'closed') {
        pose('blink');
        window.setTimeout(() => {
          if (element.dataset.pose === 'blink') pose('closed');
        }, 140);
      }
      scheduleBlink();
    }, 2600 + Math.random() * 2400);
  }

  function say(line: string): void {
    stopMotion();
    spoken.textContent = line;
    if (prefersReducedMotion()) {
      typed.textContent = line;
      pose('closed');
      return;
    }
    const chars = Array.from(line);
    let shown = 0;
    typed.textContent = '';
    let mouthOpen = false;
    mouthTimer = window.setInterval(() => {
      mouthOpen = !mouthOpen;
      pose(mouthOpen ? 'talk' : 'closed');
    }, MOUTH_MS);
    typeTimer = window.setInterval(() => {
      shown += 1;
      typed.textContent = chars.slice(0, shown).join('');
      if (shown >= chars.length) {
        stopTalking();
        pose('closed');
      }
    }, TYPE_MS);
  }

  function cheer(line?: string): void {
    if (line) say(line);
    if (prefersReducedMotion()) return;
    const start = () => {
      stopMotion();
      if (line) typed.textContent = line;
      pose('open');
      poseTimer = window.setTimeout(() => pose('closed'), CHEER_MS);
    };
    if (line) poseTimer = window.setTimeout(start, Array.from(line).length * TYPE_MS);
    else start();
  }

  pose('closed');
  scheduleBlink();

  return {
    element,
    say,
    cheer,
    dispose(): void {
      stopMotion();
      window.clearTimeout(blinkTimer);
    },
  };
}

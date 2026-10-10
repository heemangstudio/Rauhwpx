/**
 * 설정 화면의 하마. 설명은 UI 문구 대신 하마의 말풍선 한 줄로 한다.
 *
 * 자세는 scripts/generate-boot-logo.py 가 만든 public/images/boot/hama-sprites.png 의 칸이다.
 * 칸 순서(SPRITE_POSES)와 크기를 바꾸면 여기도 같이 바꾼다.
 *
 * 가만히 있을 때도 가끔 눈을 깜빡이고, 발을 구르고, 폴짝 뛴다. 누르면 폴짝 뛰고, 30초 안에
 * 30번을 누르면 그때만 뒤로 공중제비를 돈다. 움직임은 스프라이트 픽셀(3px)과 90° 단위로만
 * 끊어 픽셀이 흐려지지 않는다. 동작 줄이기 설정이면 움직이지 않는다.
 */

export const HIPPO_POSES = ['closed', 'talk', 'open', 'blink', 'step', 'crouch'] as const;
export type HippoPose = (typeof HIPPO_POSES)[number];

const CELL_WIDTH = 26;
const SCALE = 3;
const TYPE_MS = 40;
const MOUTH_MS = 120;
const CHEER_MS = 900;

/** 한 장면. 좌표는 스프라이트 픽셀, turn 은 90° 단위(음수가 뒤로 도는 쪽). */
interface MotionFrame {
  ms: number;
  legs?: 'closed' | 'step' | 'crouch';
  x?: number;
  y?: number;
  turn?: number;
}

const HOP: readonly MotionFrame[] = [
  { ms: 80, legs: 'crouch' },
  { ms: 60, legs: 'step', y: -2 },
  { ms: 70, legs: 'step', y: -3 },
  { ms: 60, legs: 'step', y: -2 },
  { ms: 70, legs: 'crouch' },
  { ms: 60, legs: 'closed' },
];

const SHUFFLE: readonly MotionFrame[] = [
  { ms: 150, legs: 'step' },
  { ms: 150, legs: 'closed' },
  { ms: 150, legs: 'step', x: 1 },
  { ms: 150, legs: 'closed', x: 1 },
  { ms: 150, legs: 'step' },
  { ms: 150, legs: 'closed' },
];

const BACKFLIP: readonly MotionFrame[] = [
  { ms: 110, legs: 'crouch' },
  { ms: 60, legs: 'step', y: -3 },
  { ms: 60, legs: 'step', y: -6, turn: -1 },
  { ms: 70, legs: 'step', y: -8, turn: -2 },
  { ms: 60, legs: 'step', y: -6, turn: -3 },
  { ms: 60, legs: 'step', y: -3, turn: -4 },
  { ms: 100, legs: 'crouch' },
  { ms: 60, legs: 'closed' },
];

/** 가만히 있을 때 고르는 동작과 그 비율. */
const IDLE_CHOICES: ReadonlyArray<[number, 'blink' | 'shuffle' | 'hop']> = [
  [0.5, 'blink'],
  [0.8, 'shuffle'],
  [1, 'hop'],
];

/** 공중제비는 숨은 보상이다: 이 시간 안에 이만큼 눌러야 한 번 돈다. */
export const BACKFLIP_CLICKS = 30;
export const BACKFLIP_WINDOW_MS = 30_000;

export interface Hippo {
  element: HTMLElement;
  /** 말풍선에 한 줄을 타이핑하며 입을 움직인다. */
  say(line: string): void;
  /** 잘 됐을 때 앱 아이콘처럼 입을 크게 벌리고 한 번 뛴다. */
  cheer(line?: string): void;
  /** 설정을 마쳤을 때: 말을 마치면 입을 벌린 채 계속 폴짝인다. */
  celebrate(line: string): void;
  dispose(): void;
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

export function createHippo(): Hippo {
  const element = document.createElement('div');
  element.className = 'rhwp-setup-hippo';

  const stage = document.createElement('span');
  stage.className = 'rhwp-setup-hippo-stage';
  stage.setAttribute('aria-hidden', 'true');
  const sprite = document.createElement('span');
  sprite.className = 'rhwp-setup-hippo-sprite';
  stage.append(sprite);

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
  element.append(stage, bubble);

  // 입(말함·벌림)이 다리 자세보다 앞선다. 칸 하나에 둘을 함께 그릴 수 없어서다.
  let mouth: 'closed' | 'talking' | 'open' = 'closed';
  let mouthOpen = false;
  let blinking = false;
  let legs: MotionFrame['legs'] | null = null;
  let excited = false;

  let typeTimer = 0;
  let mouthTimer = 0;
  let poseTimer = 0;
  let idleTimer = 0;
  let actionTimer = 0;
  let acting = false;

  function render(): void {
    const name: HippoPose = mouth === 'talking'
      ? (mouthOpen ? 'talk' : 'closed')
      : mouth === 'open'
        ? 'open'
        : blinking ? 'blink' : legs ?? 'closed';
    sprite.style.backgroundPositionX = `${-HIPPO_POSES.indexOf(name) * CELL_WIDTH * SCALE}px`;
    element.dataset.pose = name;
  }

  function place(x: number, y: number, turn: number): void {
    sprite.style.transform = x || y || turn
      ? `translate(${x * SCALE}px, ${y * SCALE}px) rotate(${turn * 90}deg)`
      : '';
  }

  function cancelAction(): void {
    window.clearTimeout(actionTimer);
    acting = false;
    legs = null;
    place(0, 0, 0);
  }

  /** 장면을 차례로 보여 준다. 동작 줄이기면 아무것도 하지 않는다. */
  function act(frames: readonly MotionFrame[], done?: () => void): void {
    cancelAction();
    if (prefersReducedMotion()) return;
    acting = true;
    element.dataset.action = frames === BACKFLIP ? 'backflip' : frames === SHUFFLE ? 'shuffle' : 'hop';
    let index = 0;
    const next = () => {
      const frame = frames[index++];
      if (!frame) {
        acting = false;
        legs = null;
        delete element.dataset.action;
        place(0, 0, 0);
        render();
        done?.();
        return;
      }
      legs = frame.legs ?? null;
      place(frame.x ?? 0, frame.y ?? 0, frame.turn ?? 0);
      render();
      actionTimer = window.setTimeout(next, frame.ms);
    };
    next();
  }

  function blink(): void {
    blinking = true;
    render();
    window.setTimeout(() => {
      blinking = false;
      render();
    }, 140);
  }

  function scheduleIdle(): void {
    window.clearTimeout(idleTimer);
    if (prefersReducedMotion()) return;
    idleTimer = window.setTimeout(() => {
      if (element.isConnected && !acting && !excited && mouth === 'closed') {
        const roll = Math.random();
        const choice = IDLE_CHOICES.find(([limit]) => roll < limit)![1];
        if (choice === 'blink') blink();
        else act(choice === 'shuffle' ? SHUFFLE : HOP);
      }
      scheduleIdle();
    }, 2400 + Math.random() * 2400);
  }

  /* 누르면 폴짝. 30초 안에 30번째로 누르면 공중제비를 돌고 다시 처음부터 센다. */
  let clicks: number[] = [];
  stage.addEventListener('click', () => {
    const now = Date.now();
    clicks = [...clicks.filter((at) => now - at < BACKFLIP_WINDOW_MS), now];
    // 신난 동안 다음 폴짝 예약이 누른 동작을 끊지 않게 한다. 끝나면 이어서 다시 뛴다.
    if (excited) window.clearTimeout(poseTimer);
    if (clicks.length >= BACKFLIP_CLICKS) {
      clicks = [];
      act(BACKFLIP, resumeExcitement);
    } else if (!acting) {
      act(HOP, resumeExcitement);
    }
  });

  function stopTalking(): void {
    window.clearInterval(typeTimer);
    window.clearInterval(mouthTimer);
  }

  function stopMotion(): void {
    stopTalking();
    window.clearTimeout(poseTimer);
    excited = false;
    delete element.dataset.excited;
    cancelAction();
  }

  function say(line: string): void {
    stopMotion();
    spoken.textContent = line;
    if (prefersReducedMotion()) {
      typed.textContent = line;
      mouth = 'closed';
      render();
      return;
    }
    const chars = Array.from(line);
    let shown = 0;
    typed.textContent = '';
    mouth = 'talking';
    mouthTimer = window.setInterval(() => {
      mouthOpen = !mouthOpen;
      render();
    }, MOUTH_MS);
    typeTimer = window.setInterval(() => {
      shown += 1;
      typed.textContent = chars.slice(0, shown).join('');
      if (shown >= chars.length) {
        stopTalking();
        mouth = 'closed';
        render();
      }
    }, TYPE_MS);
  }

  function afterLine(line: string | undefined, start: () => void): void {
    if (line && !prefersReducedMotion()) {
      poseTimer = window.setTimeout(() => {
        stopTalking();
        typed.textContent = line;
        start();
      }, Array.from(line).length * TYPE_MS);
    } else {
      start();
    }
  }

  function cheer(line?: string): void {
    if (line) say(line);
    afterLine(line, () => {
      mouth = 'open';
      render();
      act(HOP);
      poseTimer = window.setTimeout(() => {
        mouth = 'closed';
        render();
      }, CHEER_MS);
    });
  }

  /* 신난 동안: 입을 벌린 채 폴짝폴짝 뛴다. */
  function resumeExcitement(): void {
    if (!excited) return;
    window.clearTimeout(poseTimer);
    poseTimer = window.setTimeout(() => act(HOP, resumeExcitement), 160);
  }

  function celebrate(line: string): void {
    say(line);
    afterLine(line, () => {
      mouth = 'open';
      excited = true;
      element.dataset.excited = 'true';
      render();
      resumeExcitement();
    });
  }

  render();
  scheduleIdle();

  return {
    element,
    say,
    cheer,
    celebrate,
    dispose(): void {
      stopMotion();
      window.clearTimeout(idleTimer);
    },
  };
}

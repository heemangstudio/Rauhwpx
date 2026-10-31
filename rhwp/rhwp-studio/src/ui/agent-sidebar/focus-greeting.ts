/** 전체 화면의 빈 채팅 무대.
 *
 *  대화가 비어 있으면 입력기를 대화면 가운데로 모으고, 그 위에 픽셀 장면
 *  (pixel-greeting.ts)과 문서 이름을 띄운다. 첫 메시지를 보내면 배치는 한 번에 바뀌고 움직임은
 *  FLIP 으로 이어 붙인다 — 입력기는 가운데에서 아래 자리로 미끄러져 내려가고, 장면은
 *  떠나기 직전 자리에 남은 채 칸이 빠져 사라진다. transform·opacity 만 움직이므로
 *  대화 영역은 첫 프레임부터 최종 크기다. */

import './focus-greeting.css';
import { parseCssTimeMs } from './motion-model.ts';
import { createPixelGreeting } from './pixel-greeting.ts';

const FALLBACK_EASING = 'cubic-bezier(0.25, 1, 0.5, 1)';
const CLEANUP_BUFFER_MS = 50;

export interface FocusGreeting {
  readonly root: HTMLElement;
  readonly active: boolean;
  /** 문서 이름. 누르면 문서 선택기가 열린다. */
  readonly documentButton: HTMLButtonElement;
  /** 빈 채팅 배치를 켜고 끈다. 켜질 때와 `reroll` 일 때 새 장면을 고른다.
      `animate` 는 끌 때만 뜻이 있다 — 첫 메시지를 보낸 순간의 전환이다. */
  setActive(active: boolean, opts?: { animate?: boolean; reroll?: boolean }): void;
  setDocumentName(name: string | null): void;
  dispose(): void;
}

export function createFocusGreeting(opts: {
  /** `ag-chat-empty` 를 다는 대화면. 위치 기준 상자이기도 하다. */
  page: HTMLElement;
  composer: HTMLElement;
  /** 입력기가 내려가는 동안 함께 떠오르는 대화 영역. */
  conversation: HTMLElement;
}): FocusGreeting {
  const { page, composer, conversation } = opts;
  const root = document.createElement('div');
  root.className = 'ag-focus-greeting';

  // 동작 줄이기 설정에서는 움직임 토큰이 1ms 로 줄어든다.
  const art = createPixelGreeting({ reducedMotion: () => cssMs('--ag-dur-slow', 320) < 20 });
  const documentLine = document.createElement('button');
  documentLine.type = 'button';
  documentLine.setAttribute('aria-haspopup', 'dialog');
  documentLine.setAttribute('aria-expanded', 'false');
  documentLine.className = 'ag-focus-greeting-doc';
  documentLine.hidden = true;
  root.append(art.canvas, documentLine);

  let active = false;
  let tweens: Animation[] = [];
  let cleanupTimer: number | null = null;

  function stop(): void {
    if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
    cleanupTimer = null;
    for (const tween of tweens) tween.cancel();
    tweens = [];
    root.classList.remove('ag-leaving');
    root.style.removeProperty('top');
    root.style.removeProperty('left');
    root.style.removeProperty('width');
  }

  function cssMs(name: string, fallback: number): number {
    return parseCssTimeMs(getComputedStyle(composer).getPropertyValue(name), fallback);
  }

  function animate(target: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation {
    try {
      return target.animate(keyframes, options);
    } catch {
      // linear() 곡선을 모르는 엔진은 같은 성격의 cubic-bezier 로 대신한다.
      return target.animate(keyframes, { ...options, easing: FALLBACK_EASING });
    }
  }

  function leave(fromComposer: DOMRect, fromGreeting: DOMRect): void {
    const glide = cssMs('--ag-dur-slow', 320);
    const fade = cssMs('--ag-dur-base', 220);
    // 동작 줄이기 설정에서는 토큰이 1ms 로 줄어 즉시 바뀐다.
    if (glide < 20) {
      art.stop();
      return;
    }
    const spring = getComputedStyle(composer).getPropertyValue('--ag-spring').trim() || FALLBACK_EASING;
    const easeOut = getComputedStyle(composer).getPropertyValue('--ag-ease-out').trim() || FALLBACK_EASING;
    art.dissolve(fade);
    const dy = fromComposer.top - composer.getBoundingClientRect().top;

    // 장면은 흐름에서 빠졌으므로 떠나기 직전 자리에 띄워 둔 채 칸이 빠져 사라진다.
    const box = page.getBoundingClientRect();
    root.classList.add('ag-leaving');
    root.style.top = `${fromGreeting.top - box.top}px`;
    root.style.left = `${fromGreeting.left - box.left}px`;
    root.style.width = `${fromGreeting.width}px`;

    // 모든 조각을 입력이 들어온 프레임의 시각에 묶어 서로 한 프레임도 어긋나지 않게 한다.
    const startTime = Number(document.timeline?.currentTime);
    const running = [
      // 픽셀이 번지지 않게 자리는 그대로 두고, 디더가 끝나는 순간 상자를 숨긴다.
      animate(root, [{ opacity: 1 }, { opacity: 0 }], { duration: fade, easing: 'steps(1, end)', fill: 'forwards' }),
      animate(conversation, [{ opacity: 0 }, { opacity: 1 }], { duration: glide, easing: easeOut, fill: 'backwards' }),
    ];
    if (Math.abs(dy) >= 0.5) {
      running.push(animate(composer, [
        { transform: `translateY(${dy}px)` },
        { transform: 'none' },
      ], { duration: glide, easing: spring, fill: 'backwards' }));
    }
    if (Number.isFinite(startTime)) for (const tween of running) tween.startTime = startTime;
    tweens = running;
    const finish = (): void => {
      if (tweens === running) stop();
    };
    void Promise.all(running.map((tween) => tween.finished)).catch(() => undefined).then(finish);
    // 멈춘 문서 타임라인에서도 결국 정리되게 한다.
    cleanupTimer = window.setTimeout(finish, Math.max(glide, fade) + CLEANUP_BUFFER_MS);
  }

  function setActive(next: boolean, options?: { animate?: boolean; reroll?: boolean }): void {
    if (next && (!active || options?.reroll)) art.start();
    if (next === active) return;
    const from = !next && options?.animate && root.getClientRects().length > 0
      ? { composer: composer.getBoundingClientRect(), greeting: root.getBoundingClientRect() }
      : null;
    stop();
    active = next;
    page.classList.toggle('ag-chat-empty', next);
    if (from) leave(from.composer, from.greeting);
    else if (!next) art.stop();
  }

  function setDocumentName(name: string | null): void {
    documentLine.hidden = false;
    documentLine.textContent = name || '문서 선택';
    documentLine.title = '문서 전환';
    documentLine.setAttribute('aria-label', `${name || '문서 없음'}: 문서 전환`);
  }

  return {
    root,
    documentButton: documentLine,
    get active() { return active; },
    setActive,
    setDocumentName,
    dispose() {
      stop();
      art.stop();
    },
  };
}

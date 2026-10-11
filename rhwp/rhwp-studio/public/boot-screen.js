// 부트 화면 — 첫 실행은 하마 애니메이션, 그 뒤로는 정지 로고를 편집기가 준비될 때까지 보인다.
//
// 첫 페인트 전에 정해야 하므로 theme-init.js 와 같은 이유로 인라인이 아니라 외부 동기 스크립트다
// (확장 CSP, #1444). 결정은 window.__rhwpBoot 에 남기고, 닫기는 src/ui/boot-screen.ts 가 맡는다.
// 파일과 함께 처음 켜지면 문서를 가리지 않도록 정지 로고만 보이고 설정은 미룬다.
(() => {
  const screen = document.getElementById('boot-screen');
  const logo = document.getElementById('boot-screen-logo');
  const state = {
    mode: 'off',
    launchedWithFile: false,
    shownAt: 0,
    animationMs: 0,
    decided: Promise.resolve(),
  };
  window.__rhwpBoot = state;
  if (!screen || !logo) return;

  const params = new URLSearchParams(location.search);
  let suppressed = params.get('boot') === 'off';
  try {
    suppressed = suppressed || navigator.webdriver === true;
  } catch {
    // 아래 프레임 검사로 넘어간다.
  }
  try {
    suppressed = suppressed || window.parent !== window;
  } catch {
    suppressed = true;
  }
  if (suppressed) {
    screen.remove();
    return;
  }

  let setup = {};
  try {
    setup = JSON.parse(localStorage.getItem('rhwp-initial-setup') || '{}') || {};
  } catch {
    setup = {};
  }
  const forced = params.has('initial-setup')
    && ['', '1', 'true'].includes(params.get('initial-setup') || '');
  const firstRun = forced || (setup.completed !== true && setup.deferred !== true);
  const reducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const theme = document.documentElement.dataset.themeEffective === 'dark' ? 'dark' : 'light';

  const show = (animated) => {
    state.mode = animated ? 'intro' : 'still';
    state.animationMs = animated ? 2700 : 0;
    logo.src = animated
      ? `/images/boot/hama-boot-${theme}.gif`
      : `/images/boot/hama-boot-${theme}-still.png`;
    state.shownAt = performance.now();
  };

  screen.hidden = false;
  state.mode = 'pending';
  if (!firstRun) {
    show(false);
    return;
  }

  const desktop = window.rhwpDesktop;
  const pendingDesktopFiles = desktop && typeof desktop.getLaunchFiles === 'function'
    ? Promise.race([
      Promise.all([
        desktop.getLaunchFiles(),
        typeof desktop.getLaunchGeneratedDocument === 'function'
          ? desktop.getLaunchGeneratedDocument()
          : null,
      ]).then(([files, generated]) => (Array.isArray(files) && files.length > 0) || !!generated),
      new Promise((resolve) => setTimeout(() => resolve(false), 400)),
    ]).catch(() => false)
    : Promise.resolve(false);

  state.decided = pendingDesktopFiles.then((desktopFile) => {
    state.launchedWithFile = !forced && (desktopFile || params.has('url'));
    show(!state.launchedWithFile && !reducedMotion);
  });

  // 아무 키나 누르면 바로 마지막 프레임으로 건너뛴다.
  const skip = () => {
    if (state.mode !== 'intro') return;
    show(false);
  };
  window.addEventListener('pointerdown', skip, { capture: true, once: true });
  window.addEventListener('keydown', skip, { capture: true, once: true });
})();

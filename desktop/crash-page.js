// 렌더러가 죽은 창의 안내 화면. 처음에는 다시 열기, 다시 죽었거나 다시 열기가 실패하면 자동 수정을 권한다.
const params = new URLSearchParams(location.search);
const button = document.getElementById('action');
const desktop = window.rhwpDesktop;
const DOTS = ['...', '..', '.'];
const RESULT_MS = 1500;
const UNAVAILABLE_MS = 1600;
let busy = false;

function showAutofix() {
  button.className = 'autofix';
  button.disabled = false;
  button.textContent = '자동 수정';
  button.removeAttribute('aria-label');
}

function reopen() {
  button.disabled = true;
  desktop?.crashPage?.reopen().catch(() => {
    button.disabled = false;
  });
}

async function runAutofix() {
  if (busy) return;
  busy = true;
  button.className = 'autofix running';
  button.disabled = true;
  button.setAttribute('aria-label', '자동 수정 중');
  let frame = 0;
  button.textContent = DOTS[0];
  const timer = setInterval(() => {
    frame = (frame + 1) % DOTS.length;
    button.textContent = DOTS[frame];
  }, 420);
  let result = { status: 'failed' };
  try {
    result = await desktop.autofix.run({
      surface: 'renderer-crash',
      title: `편집기 화면이 비정상 종료됨 (${params.get('reason') || 'unknown'})`,
      detail: `render-process-gone (${params.get('reason') || 'unknown'}), crashes in this window: ${params.get('crashes') || '?'}`,
      attempts: Number(params.get('crashes')) || 0,
    });
  } catch {
    result = { status: 'failed' };
  }
  clearInterval(timer);
  button.removeAttribute('aria-label');
  if (result?.status === 'unavailable') {
    button.className = 'unavailable';
    button.disabled = true;
    button.textContent = '사용 불가';
    setTimeout(() => { busy = false; showAutofix(); }, UNAVAILABLE_MS);
    return;
  }
  const fixed = result?.status === 'fixed';
  button.className = 'autofix';
  button.textContent = fixed ? '고침' : '실패';
  setTimeout(() => {
    busy = false;
    if (fixed) reopen();
    else showAutofix();
  }, RESULT_MS);
}

if (params.get('mode') === 'autofix') showAutofix();
button.addEventListener('click', () => {
  if (button.classList.contains('autofix')) void runAutofix();
  else reopen();
});

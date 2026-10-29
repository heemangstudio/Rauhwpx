let zoomFactor = 1;
const address = document.getElementById('url');
const status = document.getElementById('status');
function run(payload) {
  window.ownedBrowserPresentation.command(payload).catch((error) => {
    status.textContent = error.message;
    status.title = error.message;
    document.body.dataset.error = 'true';
  });
}
document.getElementById('navigation').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!address.readOnly) run({ command: 'navigate', url: address.value });
});
for (const button of document.querySelectorAll('[data-command]')) {
  button.addEventListener('click', () => run({ command: button.dataset.command }));
}
for (const button of document.querySelectorAll('[data-zoom]')) {
  button.addEventListener('click', () => run({ command: 'zoom', factor: button.dataset.zoom === 'reset' ? 1 : Math.max(.25, Math.min(3, Math.round((zoomFactor + (button.dataset.zoom === 'out' ? -.1 : .1)) * 100) / 100)) }));
}
document.getElementById('close').addEventListener('click', () => run({ command: 'close' }));
window.ownedBrowserPresentation.onState((state) => {
  document.querySelector('.browser-chrome').hidden = state.signInPresentation === true;
  if (document.activeElement !== address) address.value = state.url;
  const human = state.controller === 'human';
  zoomFactor = typeof state.zoomFactor === 'number' ? state.zoomFactor : 1;
  document.getElementById('zoom-percent').textContent = `${Math.round(zoomFactor * 100)}%`;
  for (const button of document.querySelectorAll('[data-zoom]')) button.disabled = !human;
  document.querySelector('.browser-chrome').title = state.error || '';
  address.readOnly = !human;
  document.getElementById('go').disabled = !human;
  document.querySelector('[data-command="back"]').disabled = !human || !state.canGoBack;
  document.querySelector('[data-command="forward"]').disabled = !human || !state.canGoForward;
  const reload = document.getElementById('reload');
  const reloadLabel = state.loading ? '로딩 중지' : '새로고침';
  reload.disabled = !human;
  reload.dataset.command = state.loading ? 'stop' : 'reload';
  reload.title = reloadLabel;
  reload.setAttribute('aria-label', reloadLabel);
  reload.querySelector('[data-reload]').toggleAttribute('hidden', !!state.loading);
  reload.querySelector('[data-stop]').toggleAttribute('hidden', !state.loading);
  // 조작권 단추는 허브가 정한 사용자 점유(held)를 따른다. 물리 입력 허용(controller)과 구분한다.
  const held = state.held === true;
  const control = document.getElementById('control');
  const controlLabel = held ? '에이전트에게 돌려주기' : '직접 조작';
  control.dataset.command = held ? 'return-agent' : 'take-control';
  control.title = controlLabel;
  control.setAttribute('aria-label', controlLabel);
  control.setAttribute('aria-pressed', String(held));
  control.querySelector('[data-control-hand]').toggleAttribute('hidden', held);
  control.querySelector('[data-control-agent]').toggleAttribute('hidden', !held);
  status.textContent = state.error || (held ? '직접 조작' : '에이전트 제어');
  status.title = state.error || (held ? '브라우저를 직접 조작하고 있습니다' : '에이전트가 브라우저를 제어하고 있습니다');
  document.body.dataset.error = String(!!state.error);
});

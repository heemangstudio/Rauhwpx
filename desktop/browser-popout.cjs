const floating = new URLSearchParams(location.search).get('presentation') === 'float';
document.body.dataset.presentation = floating ? 'float' : 'popout';
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
document.addEventListener('keydown', event => { if (floating && event.key === 'Escape' && document.activeElement !== address) run({ command: 'close' }); });
document.getElementById('close').addEventListener('click', () => run({ command: 'close' }));
window.ownedBrowserPresentation.onState((state) => {
  if (document.activeElement !== address) address.value = state.url;
  const human = state.controller === 'human';
  if (floating) { document.body.inert = !state.interactive; document.body.dataset.agentControlled = String(!state.interactive); }
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
  const control = document.getElementById('control');
  const controlLabel = human ? '에이전트에게 반환' : '제어권 가져오기';
  control.dataset.command = human ? 'return-agent' : 'take-control';
  control.title = controlLabel;
  control.setAttribute('aria-label', controlLabel);
  control.setAttribute('aria-pressed', String(human));
  control.querySelector('[data-control-hand]').toggleAttribute('hidden', human);
  control.querySelector('[data-control-agent]').toggleAttribute('hidden', !human);
  status.textContent = state.error || (human ? '직접 제어' : '에이전트 제어');
  status.title = state.error || (human ? '브라우저를 직접 제어하고 있습니다' : '에이전트가 브라우저를 제어하고 있습니다');
  document.body.dataset.error = String(!!state.error);
});

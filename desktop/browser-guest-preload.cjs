// Website guests intentionally expose no contextBridge API. This preload only
// reports focus, passkey requests and explicitly authorized login capture to Electron main.
const { ipcRenderer, webFrame } = require('electron');

// 페이지가 패스키를 요청하면 Chrome 로그인을 권하도록 알린다. 요청은 그대로 진행한다.
// 자동완성용(conditional) 요청은 페이지를 열 때마다 오므로 알리지 않는다.
webFrame.executeJavaScript(`(() => {
  const container = navigator.credentials;
  if (!container) return;
  for (const kind of ['get', 'create']) {
    const original = container[kind];
    if (typeof original !== 'function') continue;
    Object.defineProperty(container, kind, { configurable: true, writable: true, value: function (options) {
      if (options && options.publicKey && options.mediation !== 'conditional') window.dispatchEvent(new Event('rhwp-passkey-request'));
      return original.apply(this, arguments);
    } });
  }
})()`).catch(() => {});
window.addEventListener('rhwp-passkey-request', () => ipcRenderer.send('desktop:browser-guest-passkey'));
window.addEventListener('focusin', (event) => {
  const field = event.target;
  ipcRenderer.send('desktop:browser-guest-focus', { sensitive: field?.type === 'password' });
  if (event.isTrusted && field instanceof HTMLInputElement && (field.type === 'password' || field === loginFields(field)?.username)) {
    ipcRenderer.send('desktop:browser-guest-autocomplete', { eligible: true });
  }
}, true);
window.addEventListener('focusout', () => {
  ipcRenderer.send('desktop:browser-guest-focus', { sensitive: false });
}, true);

// Electron main renews explicit opt-in only on the same HTTPS origin. Secrets travel to main,
// never through the renderer bridge or the agent hub.
let saveToken = null;
function loginFields(target) {
  const containers = target?.form ? [target.form] : [...document.forms, document];
  for (const container of containers) {
    const passwords = [...container.querySelectorAll('input[type="password"]')].filter(field => !field.disabled && !field.readOnly && field.getBoundingClientRect().width > 0);
    if (passwords.length !== 1) continue;
    const password = passwords[0];
    const fields = [...container.querySelectorAll('input')].filter(field => !field.disabled && !field.readOnly && ['text', 'email', 'tel'].includes(field.type) && field.getBoundingClientRect().width > 0);
    const username = fields.find(field => field.autocomplete === 'username' || field.type === 'email' || ['username', 'email'].includes(field.name)) ?? fields.filter(field => field.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
    if (username) return { username, password };
  }
  return null;
}
function captureLogin(target) {
  if (!saveToken) return;
  const fields = loginFields(target);
  if (!fields?.username.value || !fields.password.value) return;
  ipcRenderer.send('desktop:browser-guest-save-login', { token: saveToken, username: fields.username.value, password: fields.password.value });
}
ipcRenderer.on('desktop:browser-guest-arm-save', (_event, token) => {
  saveToken = token;
  if (token) captureLogin(document.activeElement);
});
window.addEventListener('change', event => {
  if (event.isTrusted && event.target instanceof HTMLInputElement) captureLogin(event.target);
}, true);
window.addEventListener('submit', event => {
  if (event.isTrusted) captureLogin(event.target);
}, true);

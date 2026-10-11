// Website guests intentionally expose no contextBridge API. This preload only
// reports whether the focused field needs masking to its owning main process.
const { ipcRenderer } = require('electron');
window.addEventListener('focusin', (event) => {
  const field = event.target;
  ipcRenderer.send('desktop:browser-guest-focus', { sensitive: field?.type === 'password' });
  if (event.isTrusted && field instanceof HTMLInputElement && field.matches('input[type="password"],input[autocomplete="username"],input[type="email"]')) {
    ipcRenderer.send('desktop:browser-guest-autocomplete', { eligible: true });
  }
}, true);
window.addEventListener('focusout', () => {
  ipcRenderer.send('desktop:browser-guest-focus', { sensitive: false });
}, true);

// Explicit opt-in lasts only for this document. Secrets travel to Electron main,
// never through the renderer bridge or the agent hub.
let saveToken = null;
function captureLogin(target) {
  if (!saveToken) return;
  const containers = target?.form ? [target.form] : [...document.forms, document];
  for (const container of containers) {
    const passwords = [...container.querySelectorAll('input[type="password"]')].filter(field => !field.disabled && field.getBoundingClientRect().width > 0);
    if (passwords.length !== 1 || !passwords[0].value) continue;
    const password = passwords[0];
    const fields = [...container.querySelectorAll('input')].filter(field => !field.disabled && ['text', 'email', 'tel'].includes(field.type) && field.getBoundingClientRect().width > 0);
    const username = fields.find(field => field.autocomplete === 'username' || field.type === 'email') ?? fields.filter(field => field.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1);
    if (!username?.value) continue;
    ipcRenderer.send('desktop:browser-guest-save-login', { token: saveToken, username: username.value, password: password.value });
    return;
  }
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

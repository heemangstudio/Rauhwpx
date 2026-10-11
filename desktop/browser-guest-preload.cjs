// Website guests intentionally expose no contextBridge API. This preload only
// reports focus and explicitly authorized login capture to Electron main.
const { ipcRenderer } = require('electron');
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

// Explicit opt-in lasts only for this document. Secrets travel to Electron main,
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

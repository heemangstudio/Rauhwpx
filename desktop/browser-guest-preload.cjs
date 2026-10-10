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

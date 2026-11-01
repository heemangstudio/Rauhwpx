const { contextBridge, ipcRenderer } = require('electron');

// 활성화 창 전용 브리지. 메인은 이 창의 webContents 에서 온 요청만 받는다.
contextBridge.exposeInMainWorld('hamaLicense', {
  getStatus: () => ipcRenderer.invoke('license:status'),
  activate: (key) => ipcRenderer.invoke('license:activate', String(key ?? '')),
  signIn: () => ipcRenderer.invoke('license:sign-in'),
  deactivate: () => ipcRenderer.invoke('license:deactivate'),
  checkNow: () => ipcRenderer.invoke('license:check'),
  openPricing: () => ipcRenderer.invoke('license:open-pricing'),
  openPaymentFix: () => ipcRenderer.invoke('license:open-payment-fix'),
  openSupport: () => ipcRenderer.invoke('license:open-support'),
  close: () => ipcRenderer.invoke('license:close-window'),
  onChange: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('license:changed', listener);
    return () => ipcRenderer.removeListener('license:changed', listener);
  },
});

const { contextBridge, ipcRenderer } = require('electron');

// Windows·Linux 의 alert()·confirm() 창은 제목에 앱 이름(사용자 데이터 때문에 남긴 'Rauhwpx')을 단다.
// 메인이 제품 이름을 제목으로 띄우도록 보낸다 (desktop/js-dialogs.mjs). macOS 경고창에는 제목이 없다.
if (process.platform !== 'darwin') {
  contextBridge.executeInMainWorld({
    func: (show) => {
      window.alert = (message) => { show('alert', message === undefined ? '' : String(message)); };
      window.confirm = (message) => show('confirm', message === undefined ? '' : String(message)) === true;
    },
    args: [(kind, message) => ipcRenderer.sendSync('desktop:js-dialog', kind, message)],
  });
}

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

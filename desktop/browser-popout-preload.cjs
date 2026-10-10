const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ownedBrowserPresentation', {
  command: (payload) => ipcRenderer.invoke('desktop:browser-popout-command', payload),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('desktop:browser-popout-state', listener);
    return () => ipcRenderer.removeListener('desktop:browser-popout-state', listener);
  },
});

// Preload for the tab-strip overlay
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabbar', {
  getState: () => ipcRenderer.invoke('tabs-get-state'),
  switchTab: (index) => ipcRenderer.invoke('tabs-switch', index),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  onState: (cb) => ipcRenderer.on('tabs-state', (_e, state) => cb(state))
});

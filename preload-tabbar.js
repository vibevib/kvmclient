// Preload for the tab-strip overlay
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tabbar', {
  getState: () => ipcRenderer.invoke('tabs-get-state'),
  // Resolved theme ('dark'/'light'). Read synchronously so a <head> script can
  // stamp it before the first paint; `onTheme` keeps it current afterwards.
  theme: ipcRenderer.sendSync('theme-sync'),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  switchTab: (index) => ipcRenderer.invoke('tabs-switch', index),
  closeTab: (index) => ipcRenderer.invoke('tabs-close', index),
  contextMenu: (index) => ipcRenderer.invoke('tabs-context-menu', index),
  onState: (cb) => ipcRenderer.on('tabs-state', (_e, state) => cb(state))
});

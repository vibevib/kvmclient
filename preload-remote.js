// Preload script for the remote browser session
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kvmAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  // Resolved theme ('dark'/'light'). Read synchronously so a <head> script can
  // stamp it before the first paint; `onTheme` keeps it current afterwards.
  theme: ipcRenderer.sendSync('theme-sync'),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, t) => cb(t)),
  getConnectionError: () => ipcRenderer.invoke('get-connection-error'),
  connect: (host) => ipcRenderer.invoke('connect', host),
  openServers: (ids) => ipcRenderer.invoke('open-servers', ids),
  setupComplete: (setup) => ipcRenderer.invoke('setup-complete', setup),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getAppName: () => ipcRenderer.invoke('get-app-name')
});

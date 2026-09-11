// Preload script for the remote browser session
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kvmAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getConnectionError: () => ipcRenderer.invoke('get-connection-error'),
  connect: (host) => ipcRenderer.invoke('connect', host),
  openServers: (ids) => ipcRenderer.invoke('open-servers', ids),
  openSettings: () => ipcRenderer.invoke('open-settings'),
  getAppName: () => ipcRenderer.invoke('get-app-name')
});

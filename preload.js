const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kvmAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  reloadSession: () => ipcRenderer.invoke('reload-session'),
  getConnectionError: () => ipcRenderer.invoke('get-connection-error'),
  connect: (host) => ipcRenderer.invoke('connect', host),
  getAppName: () => ipcRenderer.invoke('get-app-name')
});

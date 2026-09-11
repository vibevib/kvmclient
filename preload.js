const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kvmAPI', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  updateCSS: (overrides) => ipcRenderer.invoke('update-css', overrides),
  updateTabs: (tabs) => ipcRenderer.invoke('update-tabs', tabs),
  showTabsHere: () => ipcRenderer.invoke('show-tabs-here'),
  getVideoWB: () => ipcRenderer.invoke('get-video-wb'),
  previewVideoWB: (vals) => ipcRenderer.invoke('preview-video-wb', vals),
  saveVideoWB: (vals) => ipcRenderer.invoke('save-video-wb', vals),
  reloadSession: () => ipcRenderer.invoke('reload-session'),
  getConnectionError: () => ipcRenderer.invoke('get-connection-error'),
  connect: (host) => ipcRenderer.invoke('connect', host),
  getAppName: () => ipcRenderer.invoke('get-app-name')
});

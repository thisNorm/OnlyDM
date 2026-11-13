'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onlydm', {
  back: () => ipcRenderer.send('onlydm:back'),
  retry: () => ipcRenderer.send('onlydm:retry'),
  settings: (open) => ipcRenderer.send('onlydm:settings', open),
  setWorkMode: (enabled) => ipcRenderer.send('onlydm:work-mode', enabled),
  search: (query) => ipcRenderer.send('onlydm:search', query),
  selectProfile: (id) => ipcRenderer.send('onlydm:select-profile', id),
  addProfile: () => ipcRenderer.send('onlydm:add-profile'),
  linkedProfile: () => ipcRenderer.send('onlydm:linked-profile'),
  onState: (render) => ipcRenderer.on('onlydm:state', (_event, state) => render(state)),
});

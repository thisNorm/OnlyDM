'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onlydm', {
  back: () => ipcRenderer.send('onlydm:back'),
  retry: () => ipcRenderer.send('onlydm:retry'),
  search: (query) => ipcRenderer.send('onlydm:search', query),
  selectProfile: (id) => ipcRenderer.send('onlydm:select-profile', id),
  addProfile: () => ipcRenderer.send('onlydm:add-profile'),
  linkedProfile: () => ipcRenderer.send('onlydm:linked-profile'),
  onState: (render) => ipcRenderer.on('onlydm:state', (_event, state) => render(state)),
});

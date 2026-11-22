'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('onlydm', {
  back: () => ipcRenderer.send('onlydm:back'),
  showFriends: () => ipcRenderer.send('onlydm:show-friends'),
  showChats: () => ipcRenderer.send('onlydm:show-chats'),
  newChat: (open) => ipcRenderer.send('onlydm:new-chat', open),
  createChat: (handles) => ipcRenderer.send('onlydm:create-chat', handles),
  chatAction: (action) => ipcRenderer.send('onlydm:chat-action', action),
  renameChat: (name) => ipcRenderer.send('onlydm:rename-chat', name),
  setPreference: (key, value) => ipcRenderer.send('onlydm:preference', { key, value }),
  autoStart: (enabled) => ipcRenderer.send('onlydm:auto-start', enabled),
  logout: () => ipcRenderer.send('onlydm:logout'),
  hide: () => ipcRenderer.send('onlydm:hide'),
  retry: () => ipcRenderer.send('onlydm:retry'),
  settings: (open) => ipcRenderer.send('onlydm:settings', open),
  setWorkMode: (enabled) => ipcRenderer.send('onlydm:work-mode', enabled),
  setChatTheme: (chatTheme, chatColors, appColors) => ipcRenderer.send('onlydm:chat-theme', { chatTheme, chatColors, appColors }),
  update: () => ipcRenderer.send('onlydm:update'),
  search: (query) => ipcRenderer.send('onlydm:search', query),
  selectProfile: (id) => ipcRenderer.send('onlydm:select-profile', id),
  addProfile: () => ipcRenderer.send('onlydm:add-profile'),
  linkedProfile: () => ipcRenderer.send('onlydm:linked-profile'),
  onState: (render) => ipcRenderer.on('onlydm:state', (_event, state) => render(state)),
});

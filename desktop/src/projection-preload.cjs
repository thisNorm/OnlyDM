'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Only the application-controlled projection world receives this bridge.
if (process.isMainFrame) {
  contextBridge.exposeInIsolatedWorld(1001, 'onlydmHost', {
    post: (message) => ipcRenderer.send('onlydm:projection', message),
    subscribe: (listener) => {
      ipcRenderer.on('onlydm:command', (_event, data) => listener(data));
    },
  });
}

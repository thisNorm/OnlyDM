'use strict';

const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Only the application-controlled projection world receives this bridge.
if (process.isMainFrame) {
  ipcRenderer.on('onlydm:projection-zoom', (_event, factor) => {
    if ([0.25, 0.4, 1].includes(factor)) webFrame.setZoomFactor(factor);
  });
  contextBridge.exposeInIsolatedWorld(1001, 'onlydmHost', {
    post: (message) => ipcRenderer.send('onlydm:projection', message),
    subscribe: (listener) => {
      ipcRenderer.on('onlydm:command', (_event, data) => listener(data));
    },
  });
}

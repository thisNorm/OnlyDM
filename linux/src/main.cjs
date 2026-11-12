'use strict';

const { app, dialog } = require('electron');
const { createOnlyDM } = require('./app.cjs');

app.setName('OnlyDM');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window;
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.whenReady().then(async () => {
    ({ window } = await createOnlyDM());
  }).catch(() => {
    dialog.showErrorBox('OnlyDM', 'OnlyDM을 시작할 수 없습니다. Please reinstall or rebuild OnlyDM.');
    app.quit();
  });
  app.on('window-all-closed', () => app.quit());
}

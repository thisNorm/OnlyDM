'use strict';

const { app, dialog, Menu } = require('electron');
const { createOnlyDM } = require('./app.cjs');

app.setName('OnlyDM');
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window;
  let opening;
  let quitting = false;

  async function showWindow() {
    if (quitting) return;
    if (!window || window.isDestroyed()) {
      opening ||= createOnlyDM().then((controller) => {
        window = controller.window;
        window.once('closed', () => { window = null; });
        if (process.platform === 'darwin') {
          window.on('close', (event) => {
            if (quitting) return;
            event.preventDefault();
            window.hide();
          });
        }
        if (quitting) window.close();
      }).finally(() => { opening = null; });
      await opening;
    }
    if (quitting || !window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  function startupFailed() {
    if (quitting) return;
    dialog.showErrorBox('OnlyDM', 'OnlyDM을 시작할 수 없습니다. Please reinstall or rebuild OnlyDM.');
    app.quit();
  }

  app.on('before-quit', () => { quitting = true; });
  app.on('second-instance', () => {
    void app.whenReady().then(showWindow).catch(startupFailed);
  });
  app.on('activate', () => {
    void app.whenReady().then(showWindow).catch(startupFailed);
  });
  app.whenReady().then(async () => {
    if (quitting) return;
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]));
    }
    await showWindow();
  }).catch(startupFailed);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

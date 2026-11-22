'use strict';

const { app, dialog, Menu } = require('electron');
const { createOnlyDM } = require('./app.cjs');

app.setName('OnlyDM');
if (!app.requestSingleInstanceLock() || process.argv?.includes('--onlydm-cli-stop')) {
  app.quit();
} else {
  let window;
  let controller;
  let opening;
  let quitting = false;

  async function showWindow(initial = false) {
    if (quitting) return;
    if (!window || window.isDestroyed()) {
      opening ||= createOnlyDM().then((created) => {
        controller = created;
        window = created.window;
        window.once('closed', () => { window = null; controller = null; });
        {
          window.on('close', (event) => {
            if (quitting || (process.platform !== 'darwin' && !controller?.hasTray)) return;
            event.preventDefault();
            window.hide();
          });
        }
        if (quitting) window.close();
      }).finally(() => { opening = null; });
      await opening;
    }
    if (quitting || !window || window.isDestroyed()) return;
    if (initial && controller?.hideAtStartup) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  async function stopFromCli() {
    await app.whenReady();
    if (opening) await opening;
    if (!controller || await controller.confirmCloseForMaintenance()) app.quit();
  }

  function startupFailed() {
    if (quitting) return;
    dialog.showErrorBox('OnlyDM', 'OnlyDM을 시작할 수 없습니다. Please reinstall or rebuild OnlyDM.');
    app.quit();
  }

  app.on('before-quit', () => { quitting = true; });
  app.on('second-instance', (_event, argv) => {
    if (argv?.includes('--onlydm-cli-stop')) {
      void stopFromCli().catch(() => {});
      return;
    }
    void app.whenReady().then(showWindow).catch(startupFailed);
  });
  app.on('activate', () => {
    void app.whenReady().then(showWindow).catch(startupFailed);
  });
  app.whenReady().then(async () => {
    if (quitting) return;
    if (app.isPackaged && ['linux', 'darwin'].includes(process.platform)) {
      const cleanup = require('./cli-process.cjs').registerCliProcess(app);
      app.once('will-quit', cleanup);
    }
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]));
    }
    await showWindow(true);
  }).catch(startupFailed);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

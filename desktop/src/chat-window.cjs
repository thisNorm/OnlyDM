'use strict';

const path = require('node:path');
const { BrowserWindow } = require('electron');

// The owner supplies room views/state and explicitly destroys windows during disposal.
function createChatWindow({ icon, palette = {}, lang = 'en', title, onHide, onReady, onDestroyed } = {}) {
  const window = new BrowserWindow({
    title: title || (lang === 'ko' ? 'OnlyDM 채팅' : 'OnlyDM Chat'),
    icon,
    width: 400,
    height: 650,
    minWidth: 350,
    minHeight: 420,
    show: false,
    frame: true,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 10, y: 8 } }
      : { titleBarOverlay: { color: palette.chrome || '#F0F2F4',
        symbolColor: palette.chromeText || '#1A1C1F', height: 30 } }),
    backgroundColor: palette.surface || '#FFFFFF',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      preload: path.join(__dirname, 'shell-preload.cjs'),
    },
  });
  const contents = window.webContents;
  let disposed = false;
  let hidden = false;

  const denyNavigation = event => event.preventDefault();
  const markHidden = () => { hidden = true; };
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeListener('close', hide);
    window.removeListener('hide', markHidden);
    window.removeListener('closed', dispose);
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate'])
      contents.removeListener(name, denyNavigation);
    contents.removeListener('did-fail-load', failedLoad);
    contents.removeListener('render-process-gone', dispose);
    contents.removeListener('destroyed', dispose);
    if (!window.isDestroyed()) window.destroy();
    try { onDestroyed?.(window); } catch { /* Cleanup must not leave an unhandled load rejection. */ }
  }
  function hide(event) {
    event.preventDefault();
    hidden = true;
    window.hide();
    try { Promise.resolve(onHide?.(window)).catch(dispose); }
    catch { dispose(); }
  }
  function failedLoad(_event, _code, _description, _url, isMainFrame) {
    if (isMainFrame) dispose();
  }

  if (process.platform !== 'darwin') window.removeMenu();
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate'])
    contents.on(name, denyNavigation);
  contents.on('did-fail-load', failedLoad);
  contents.on('render-process-gone', dispose);
  contents.on('destroyed', dispose);
  window.on('close', hide);
  window.on('hide', markHidden);
  window.once('closed', dispose);

  // Start after returning so the owner can attach views and IPC before document loading.
  void Promise.resolve().then(() => {
    if (!disposed) return window.loadFile(path.join(__dirname, 'shell.html'));
  }).then(() => {
    if (!disposed) return onReady?.(window);
  }).then(() => {
    if (disposed || hidden || window.isDestroyed() || contents.isDestroyed()) return;
    window.show();
    window.focus();
  }).catch(dispose);
  return window;
}

module.exports = { createChatWindow };

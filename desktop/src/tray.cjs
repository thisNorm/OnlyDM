'use strict';

const path = require('node:path');

// Call after app.whenReady(); the parent owns settings, startup registration and windows.
function createTray({ getState, onAction, icon, lang = 'auto' }) {
  let tray = null;
  let app;
  let Menu;
  let createNativeTray;
  const controller = { refresh, destroy, get available() { return !!tray && !tray.isDestroyed(); } };

  function destroy() {
    createNativeTray = null;
    releaseTray();
  }

  function releaseTray() {
    const current = tray;
    tray = null;
    if (!current) return;
    try {
      current.removeAllListeners();
      if (!current.isDestroyed()) current.destroy();
    } catch { /* The native indicator may already be unavailable. */ }
  }

  function dispatch(origin, action, value) {
    if (origin !== tray || !controller.available) return;
    try { onAction(action, value); }
    finally { refresh(); }
  }

  function refresh() {
    if (!createNativeTray) return false;
    try {
      if (!tray) createNativeTray();
      if (!controller.available) return false;
      const current = tray;
      const state = getState();
      const language = state.lang || lang;
      const korean = /^ko(?:-|$)/i.test(language === 'auto' ? app.getLocale() : language);
      const text = (ko, en) => korean ? ko : en;
      const notifications = state.notificationsEnabled !== false;
      const workMode = state.workModeEnabled === true;
      const checkbox = (id, label, checked, enabled = true) => ({
        id, label, type: 'checkbox', checked, enabled,
        click: item => dispatch(current, id, item.checked),
      });
      const menu = Menu.buildFromTemplate([
        { id: 'show', label: text('OnlyDM 열기', 'Open OnlyDM'), click: () => dispatch(current, 'show') },
        { id: 'settings', label: text('설정', 'Settings'), click: () => dispatch(current, 'settings') },
        { type: 'separator' },
        checkbox('notifications', text('알림 받기', 'Notifications'), notifications),
        checkbox('work-mode', text('열일 모드', 'Work mode'), workMode, notifications),
        checkbox('notification-preview', text('메시지 내용 표시', 'Show message previews'),
          state.notificationPreviewEnabled !== false, notifications && !workMode),
        { type: 'separator' },
        { id: 'theme', label: text('테마', 'Theme'), submenu: ['light', 'dark'].map(theme => ({
          id: 'theme-' + theme,
          label: theme === 'light' ? text('라이트', 'Light') : text('다크', 'Dark'),
          type: 'radio', checked: state.theme === theme, click: () => dispatch(current, 'theme', theme),
        })) },
        checkbox('start-in-tray', process.platform === 'darwin' ? text('메뉴 막대에서 시작', 'Start in menu bar')
          : text('트레이에서 시작', 'Start in tray'), state.startInTray === true),
        checkbox('auto-start', process.platform === 'win32' ? text('Windows 시작 시 자동 실행', 'Start with Windows')
          : text('로그인 시 자동 실행', 'Start at login'), state.autoStart === true),
        { type: 'separator' },
        { id: 'quit', label: text('종료', 'Quit'), click: () => dispatch(current, 'quit') },
      ]);
      const unread = Number.isSafeInteger(state.unreadCount) && state.unreadCount > 0 ? state.unreadCount : 0;
      current.setToolTip(unread ? text(`OnlyDM - 읽지 않은 대화 ${unread}개`, `OnlyDM - ${unread} unread`) : 'OnlyDM');
      // Linux requires setContextMenu again for checkbox and enabled-state updates.
      current.setContextMenu(menu);
      return true;
    } catch {
      releaseTray();
      return false;
    }
  }

  try {
    const electron = require('electron');
    ({ app, Menu } = electron);
    if (typeof electron.Tray !== 'function' || typeof Menu?.buildFromTemplate !== 'function') return controller;
    const source = icon ?? (app.isPackaged
      ? process.platform === 'linux' ? '/usr/share/pixmaps/onlydm.png' : path.join(process.resourcesPath, 'OnlyDM.png')
      : path.join(__dirname, '..', '..', 'src', 'OnlyDM', 'Assets', 'OnlyDM.png'));
    let image = typeof source === 'string' ? electron.nativeImage.createFromPath(source) : source;
    if (!image || image.isEmpty()) return controller;
    if (process.platform === 'darwin') {
      image = image.resize({ width: 18, height: 18 });
      image.setTemplateImage(true);
    }
    createNativeTray = () => {
      tray = new electron.Tray(image);
      const current = tray;
      const show = () => dispatch(current, 'show');
      current.on('double-click', show);
      if (process.platform === 'linux') current.on('click', show);
    };
    refresh();
  } catch { destroy(); }
  return controller;
}

module.exports = { createTray };

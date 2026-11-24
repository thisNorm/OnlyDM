'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const filename = path.join(__dirname, '../src/tray.cjs');

function host({ platform = 'win32', locale = 'en-US', isPackaged = false, unavailable, emptyIcon = false } = {}) {
  const state = { lang: 'en', theme: 'light', workModeEnabled: false, notificationsEnabled: true,
    notificationPreviewEnabled: true, startInTray: false, autoStart: false, unreadCount: 3 };
  const actions = [];
  const trays = [];
  const imagePaths = [];
  let failure;
  class Image {
    constructor(source) { this.source = source; }
    isEmpty() { return emptyIcon; }
    resize(size) { const result = new Image(this.source); result.size = size; return result; }
    setTemplateImage(value) { this.template = value; }
  }
  class Tray extends EventEmitter {
    constructor(image) {
      super();
      if (unavailable === 'indicator') throw new Error('Native indicator unavailable.');
      this.image = image;
      this.destroyed = false;
      this.destroys = 0;
      this.menus = [];
      trays.push(this);
    }
    isDestroyed() { return this.destroyed; }
    setContextMenu(menu) {
      if (failure === 'menu') throw new Error('Native menu unavailable.');
      this.menu = menu;
      this.menus.push(menu);
    }
    setToolTip(text) {
      if (failure === 'tooltip') throw new Error('Native tooltip unavailable.');
      this.tooltip = text;
    }
    destroy() { this.destroyed = true; this.destroys++; this.menu = null; }
  }
  const copyMenu = template => template.map(item => ({ ...item,
    ...(item.submenu ? { submenu: copyMenu(item.submenu) } : {}),
  }));
  const electron = {
    app: { isPackaged, getLocale: () => locale },
    Tray: unavailable === 'tray' ? undefined : Tray,
    Menu: unavailable === 'menu' ? undefined : { buildFromTemplate: copyMenu },
    nativeImage: { createFromPath(source) { imagePaths.push(source); return new Image(source); } },
  };
  const module = { exports: {} };
  const resourcesPath = path.resolve('onlydm-test-resources');
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), process: { platform, resourcesPath },
    require(id) {
      if (id === 'electron') {
        if (unavailable === 'electron') throw new Error('Electron unavailable.');
        return electron;
      }
      if (id === 'node:path') return path;
      throw new Error('Unexpected dependency: ' + id);
    },
  }, { filename });
  function create(options = {}) {
    const onAction = options.onAction;
    return module.exports.createTray({ getState: () => state, ...options,
      onAction(action, value) { actions.push({ action, value }); onAction?.(action, value); },
    });
  }
  function item(id, menu = trays.at(-1).menu) {
    for (const entry of menu) {
      if (entry.id === id) return entry;
      if (entry.submenu) {
        const found = item(id, entry.submenu);
        if (found) return found;
      }
    }
  }
  function activate(id) {
    const entry = item(id);
    assert.ok(entry, id);
    assert.notEqual(entry.enabled, false, id + ' must be enabled');
    if (entry.type === 'checkbox') entry.checked = !entry.checked;
    if (entry.type === 'radio') entry.checked = true;
    entry.click(entry);
  }
  return { create, state, actions, trays, imagePaths, resourcesPath, Image, item, activate,
    fail: value => { failure = value; } };
}

test('native menu exposes every requested action with current state and primitive values', () => {
  const h = host();
  const controller = h.create();
  assert.equal(controller.available, true);
  assert.equal(h.item('show').label, 'Open OnlyDM');
  assert.equal(h.item('notifications').checked, true);
  assert.equal(h.item('notification-preview').checked, true);
  assert.equal(h.item('work-mode').checked, false);
  assert.equal(h.item('start-in-tray').checked, false);
  assert.equal(h.item('auto-start').checked, false);
  assert.equal(h.item('theme-light').type, 'radio');
  assert.equal(h.item('theme-light').checked, true);
  assert.equal(h.item('theme-dark').checked, false);
  for (const id of ['show', 'settings', 'quit', 'work-mode', 'notifications', 'notification-preview',
    'start-in-tray', 'auto-start', 'theme-dark', 'theme-light']) h.activate(id);
  assert.deepEqual(h.actions, [
    { action: 'show', value: undefined }, { action: 'settings', value: undefined }, { action: 'quit', value: undefined },
    { action: 'work-mode', value: true }, { action: 'notifications', value: false },
    { action: 'notification-preview', value: false }, { action: 'start-in-tray', value: true },
    { action: 'auto-start', value: true }, { action: 'theme', value: 'dark' }, { action: 'theme', value: 'light' },
  ]);
  assert.equal(h.state.notificationsEnabled, true, 'the parent owns preference changes');
  assert.equal(h.item('notifications').checked, true, 'refresh restores state when the parent rejects a change');
  controller.destroy();
});

test('refresh follows parent state and Windows notification dependencies, including Linux menu rebinding', () => {
  const h = host({ platform: 'linux' });
  const controller = h.create({ onAction(action, value) {
    if (action === 'notifications') h.state.notificationsEnabled = value;
  } });
  h.activate('notifications');
  assert.equal(h.item('notifications').checked, false);
  assert.equal(h.item('work-mode').enabled, false);
  assert.equal(h.item('notification-preview').enabled, false);
  assert.equal(h.item('notification-preview').checked, true, 'disabling notifications preserves the preview preference');
  Object.assign(h.state, { notificationsEnabled: true, workModeEnabled: true, theme: 'dark', autoStart: true, startInTray: true });
  assert.equal(controller.refresh(), true);
  assert.equal(h.item('work-mode').enabled, true);
  assert.equal(h.item('work-mode').checked, true);
  assert.equal(h.item('notification-preview').enabled, false);
  assert.equal(h.item('theme-dark').checked, true);
  assert.equal(h.item('theme-light').checked, false);
  assert.equal(h.item('auto-start').checked, true);
  assert.equal(h.item('start-in-tray').checked, true);
  h.state.workModeEnabled = false;
  controller.refresh();
  assert.equal(h.item('notification-preview').enabled, true);
  assert.equal(h.trays[0].menus.length, 4, 'a fresh native menu is installed after each state change');
  controller.destroy();
});

test('language changes and auto locale resolution update labels and unread tooltip', () => {
  const h = host({ locale: 'ko-KR' });
  h.state.lang = undefined;
  const controller = h.create({ lang: 'auto' });
  assert.equal(h.item('show').label, 'OnlyDM 열기');
  assert.equal(h.item('settings').label, '설정');
  assert.equal(h.trays[0].tooltip, 'OnlyDM - 읽지 않은 대화 3개');
  h.state.lang = 'en';
  h.state.unreadCount = 12;
  controller.refresh();
  assert.equal(h.item('show').label, 'Open OnlyDM');
  assert.equal(h.trays[0].tooltip, 'OnlyDM - 12 unread');
  h.state.lang = 'ko';
  controller.refresh();
  assert.equal(h.item('quit').label, '종료');
  controller.destroy();
  const fallback = host({ locale: 'fr-FR' });
  fallback.state.lang = undefined;
  const second = fallback.create({ lang: 'ko' });
  assert.equal(fallback.item('show').label, 'OnlyDM 열기');
  second.destroy();
  const third = fallback.create();
  assert.equal(fallback.item('show').label, 'Open OnlyDM');
  third.destroy();
});

test('the macOS tray names the menu bar in both languages', () => {
  const h = host({ platform: 'darwin' });
  const controller = h.create();
  assert.equal(h.item('start-in-tray').label, 'Start in menu bar');
  h.state.lang = 'ko';
  controller.refresh();
  assert.equal(h.item('start-in-tray').label, '메뉴 막대에서 시작');
  controller.destroy();
});

test('tooltip contains only a validated count and never account, message, or error details', () => {
  const h = host();
  Object.assign(h.state, { account: 'private-account', message: 'private-message', title: 'private-title' });
  const controller = h.create();
  for (const unreadCount of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'private-message\n42', null, {}]) {
    h.state.unreadCount = unreadCount;
    controller.refresh();
    assert.equal(h.trays[0].tooltip, 'OnlyDM');
  }
  h.state.unreadCount = Number.MAX_SAFE_INTEGER;
  controller.refresh();
  assert.equal(h.trays[0].tooltip, 'OnlyDM - 9007199254740991 unread');
  assert.ok(h.trays[0].tooltip.length <= 63);
  controller.destroy();
});

test('icons use supplied NativeImage or file paths and safe existing application resource locations', () => {
  const development = path.join(__dirname, '..', '..', 'src', 'OnlyDM', 'Assets', 'OnlyDM.png');
  assert.ok(existsSync(development));
  for (const [platform, isPackaged] of [['win32', false], ['linux', true], ['darwin', true]]) {
    const h = host({ platform, isPackaged });
    const controller = h.create();
    assert.deepEqual(h.imagePaths, [!isPackaged ? development
      : platform === 'linux' ? '/usr/share/pixmaps/onlydm.png' : path.join(h.resourcesPath, 'OnlyDM.png')]);
    if (platform === 'darwin') {
      assert.equal(h.trays[0].image.template, true);
      assert.equal(h.trays[0].image.size.width, 18);
      assert.equal(h.trays[0].image.size.height, 18);
    } else assert.equal(h.trays[0].image.template, undefined);
    controller.destroy();
  }
  const h = host();
  const image = new h.Image('provided');
  const native = h.create({ icon: image });
  assert.equal(h.trays[0].image, image);
  assert.deepEqual(h.imagePaths, []);
  native.destroy();
  const custom = path.resolve('provided-tray.ico');
  const fromPath = h.create({ icon: custom });
  assert.deepEqual(h.imagePaths, [custom]);
  fromPath.destroy();
});

test('Windows double click and Linux activation request show without window lifecycle ownership', () => {
  for (const [platform, event] of [['win32', 'double-click'], ['linux', 'click']]) {
    const h = host({ platform });
    const controller = h.create();
    h.trays[0].emit(event, { private: 'event details' });
    assert.deepEqual(h.actions, [{ action: 'show', value: undefined }]);
    controller.destroy();
  }
});

test('destroy releases native tray and listeners once, and stale menu callbacks become inert', () => {
  const h = host();
  const controller = h.create();
  const stale = h.item('show').click;
  const native = h.trays[0];
  controller.destroy();
  controller.destroy();
  assert.equal(controller.available, false);
  assert.equal(controller.refresh(), false);
  assert.equal(native.destroys, 1);
  assert.deepEqual(native.eventNames(), []);
  assert.equal(native.menu, null);
  stale({});
  native.emit('double-click');
  assert.deepEqual(h.actions, []);
});

test('missing Electron APIs, empty icons and unavailable Linux indicators produce a safe unavailable controller', () => {
  for (const unavailable of ['electron', 'tray', 'menu', 'indicator']) {
    const h = host({ platform: 'linux', unavailable });
    const controller = h.create();
    assert.equal(controller.available, false, unavailable);
    assert.equal(controller.refresh(), false);
    assert.doesNotThrow(() => controller.destroy());
    assert.deepEqual(h.actions, []);
  }
  const empty = host({ emptyIcon: true });
  assert.equal(empty.create().available, false);
  assert.equal(empty.trays.length, 0, 'never create an invisible tray with an empty image');
});

test('refresh recreates the Linux tray after a transient native menu failure', () => {
  const h = host({ platform: 'linux' });
  const controller = h.create();
  const staleClick = h.item('show').click;
  h.fail('menu');
  assert.equal(controller.refresh(), false);
  assert.equal(controller.available, false);
  assert.equal(h.trays[0].destroys, 1);

  h.fail(undefined);
  h.state.unreadCount = 12;
  assert.equal(controller.refresh(), true);
  assert.equal(controller.available, true);
  assert.equal(h.trays[1].tooltip, 'OnlyDM - 12 unread');
  staleClick();
  h.trays[1].emit('click');
  assert.deepEqual(h.actions, [{ action: 'show', value: undefined }]);
  controller.destroy();
  assert.equal(controller.refresh(), false);
});

test('native failures clean up created trays and externally destroyed trays stay unavailable', () => {
  for (const failure of ['menu', 'tooltip']) {
    const h = host({ platform: 'linux' });
    const controller = h.create();
    h.fail(failure);
    assert.equal(controller.refresh(), false);
    assert.equal(controller.available, false);
    assert.equal(h.trays[0].destroys, 1);
    assert.deepEqual(h.trays[0].eventNames(), []);
    controller.destroy();
    assert.equal(h.trays[0].destroys, 1);
    const initial = host({ platform: 'linux' });
    initial.fail(failure);
    assert.equal(initial.create().available, false);
    assert.equal(initial.trays[0].destroys, 1);
  }
  const h = host();
  const controller = h.create();
  h.trays[0].destroy();
  assert.equal(controller.available, false);
  assert.equal(controller.refresh(), false);
  controller.destroy();
  assert.equal(h.trays[0].destroys, 1);
});

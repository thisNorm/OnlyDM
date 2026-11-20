'use strict';

const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { tmpdir } = require('node:os');
const vm = require('node:vm');

const engine = 'AppleWebKit/537.36 (KHTML, like Gecko)';
const browser = 'Chrome/154.0.8113.42 Safari/537.36';

test('macOS Instagram normalizes the Ferdium Apple macOS case without pinning Chromium', () => {
  const { normalizeInstagramUserAgent } = require('../src/platform.cjs');
  assert.equal(normalizeInstagramUserAgent(
    'Mozilla/5.0 (Macintosh; Apple macOS 26.1) ' + engine
      + ' OnlyDM/0.1.0-beta.7 Chrome/154.0.8113.42 Electron/45.3.1 Safari/537.36', 'darwin'),
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' + engine + ' ' + browser);
});

test('macOS strips both the product and existing package tokens and is idempotent', () => {
  const { normalizeInstagramUserAgent } = require('../src/platform.cjs');
  const expected = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' + engine + ' ' + browser;
  for (const name of ['OnlyDM', 'onlydm-linux']) {
    const input = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' + engine
      + ' ' + name + '/0.1.0-beta.7 Chrome/154.0.8113.42 Electron/45.3.1 Safari/537.36';
    assert.equal(normalizeInstagramUserAgent(input, 'darwin'), expected);
  }
  assert.equal(normalizeInstagramUserAgent(expected, 'darwin'), expected);
});

test('macOS normalization preserves other platform and product tokens', () => {
  const { normalizeInstagramUserAgent } = require('../src/platform.cjs');
  const input = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) ' + engine
    + ' OnlyDM/1.2.3 Chrome/160.2.3.4 Electron/50.0.0 Safari/537.36 OtherElectron/2.0';
  assert.equal(normalizeInstagramUserAgent(input, 'darwin'),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_1) ' + engine
    + ' Chrome/160.2.3.4 Safari/537.36 OtherElectron/2.0');
});

test('Ubuntu browser User-Agent is byte-for-byte unchanged', () => {
  const { normalizeInstagramUserAgent } = require('../src/platform.cjs');
  const input = 'Mozilla/5.0 (X11; Linux x86_64) ' + engine
    + ' onlydm-linux/0.1.0-beta.7  Chrome/154.0.8113.42 Electron/45.3.1 Safari/537.36';
  assert.equal(normalizeInstagramUserAgent(input, 'linux'), input);
});

test('macOS leaves BrowserWindow icon to the application bundle', () => {
  const { windowIcon } = require('../src/platform.cjs');
  for (const isPackaged of [true, false]) {
    assert.equal(windowIcon({ isPackaged, platform: 'darwin' }), undefined);
  }
});

test('Ubuntu retains its installed pixmap and development source icon paths', () => {
  const { windowIcon } = require('../src/platform.cjs');
  assert.equal(windowIcon({ isPackaged: true, platform: 'linux' }), '/usr/share/pixmaps/onlydm.png');
  const development = path.join(__dirname, '..', '..', 'src', 'OnlyDM', 'Assets', 'OnlyDM.png');
  assert.equal(windowIcon({ isPackaged: false, platform: 'linux' }), development);
  assert.ok(existsSync(development), 'the shared development PNG exists');
});

function appHost(t, platform) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'onlydm-platform-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'profiles.json'), JSON.stringify({
    activeProfileId: 'default',
    profiles: [{ id: 'default' }, { id: '1234567890abcdef1234567890abcdef' }],
  }));
  const originalUA = 'Mozilla/5.0 (Macintosh; Apple macOS 26.1) ' + engine
    + ' onlydm-linux/0.1.0-beta.7 Chrome/154.0.8113.42 Electron/45.3.1 Safari/537.36';
  const sessions = new Map();
  const views = [];
  const ipcMain = new EventEmitter();
  const windows = [];

  class Contents extends EventEmitter {
    constructor(instagram) {
      super();
      this.session = instagram;
      this.userAgent = instagram?.getUserAgent();
      this.href = '';
      this.destroyed = false;
    }
    isDestroyed() { return this.destroyed; }
    close() { this.destroyed = true; this.emit('destroyed'); }
    setWindowOpenHandler() {}
    getURL() { return this.href; }
    async loadURL(href) { this.href = href; }
    send() {}
  }
  class View {
    constructor({ webPreferences }) {
      this.webPreferences = webPreferences;
      this.webContents = new Contents(webPreferences.session);
      this.visible = false;
      views.push(this);
    }
    setBounds() {}
    setVisible(visible) { this.visible = visible; }
    getVisible() { return this.visible; }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new Contents();
      this.children = [];
      this.contentView = {
        addChildView: view => this.children.push(view),
        removeChildView: view => this.children.splice(this.children.indexOf(view), 1),
      };
      this.menuRemoved = false;
      windows.push(this);
    }
    removeMenu() { this.menuRemoved = true; }
    getContentBounds() { return { width: 390, height: 720 }; }
    async loadFile() {}
    show() {}
    setBackgroundColor() {}
    setTitleBarOverlay() {}
    isDestroyed() { return this.destroyed === true; }
    close() { this.destroyed = true; this.emit('closed'); }
  }
  const electron = {
    app: { getLocale: () => 'en', getPath: () => root, getVersion: () => '1.1.8', isPackaged: true },
    BrowserWindow: Window,
    WebContentsView: View,
    ipcMain,
    nativeTheme: Object.assign(new EventEmitter(), { shouldUseDarkColors: false }),
    session: {
      fromPartition(partition) {
        if (!sessions.has(partition)) {
          const instagram = new EventEmitter();
          let userAgent = originalUA;
          Object.assign(instagram, {
            getUserAgent: () => userAgent,
            setUserAgent: value => { userAgent = value; },
            setPermissionCheckHandler: handler => { instagram.checkPermission = handler; },
            setPermissionRequestHandler: handler => { instagram.requestPermission = handler; },
          });
          sessions.set(partition, instagram);
        }
        return sessions.get(partition);
      },
    },
  };
  function load(filename) {
    const realRequire = createRequire(filename);
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module, __dirname: path.dirname(filename), process: { platform },
      setTimeout, clearTimeout, clearInterval, queueMicrotask, URL, console,
      require(id) {
        if (id === 'electron') return electron;
        if (id === './updates.cjs') return { createUpdater: () => null };
        if (['./platform.cjs', './background-inboxes.cjs', './calls.cjs', './tray.cjs', './chat-window.cjs'].includes(id))
          return load(path.join(path.dirname(filename), id));
        if (id === 'node:fs') return {
          ...fs,
          readFileSync(file, ...args) {
            return path.basename(path.dirname(file)) === 'generated' ? '' : fs.readFileSync(file, ...args);
          },
        };
        return realRequire(id);
      },
    }, { filename });
    return module.exports;
  }
  return { ...load(path.join(__dirname, '../src/app.cjs')), views, sessions, ipcMain, windows, originalUA };
}

test('macOS foreground and background views share the normalized session UA before loading', async t => {
  const h = appHost(t, 'darwin');
  const controller = await h.createOnlyDM();
  t.after(() => controller.window.close());
  assert.equal(h.views.length, 2, 'one foreground inbox and one background watcher');
  for (const view of h.views) {
    assert.equal(view.webContents.userAgent,
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' + engine + ' ' + browser);
    assert.equal(view.webPreferences.sandbox, true);
    assert.equal(view.webPreferences.contextIsolation, true);
    assert.equal(view.webPreferences.nodeIntegration, false);
    assert.equal(view.webPreferences.backgroundThrottling, false);
  }
  assert.deepEqual([...h.sessions.keys()].sort(), [
    'persist:onlydm-instagram', 'persist:onlydm-instagram-1234567890abcdef1234567890abcdef',
  ]);
  assert.equal(controller.window.options.icon, undefined);
  assert.equal(controller.window.menuRemoved, false, 'keep the native macOS application menu');
});

test('Ubuntu foreground/background UA and icon stay unchanged and direct fixture close disposes resources', async t => {
  const h = appHost(t, 'linux');
  const controller = await h.createOnlyDM();
  t.after(() => controller.window.close());
  assert.equal(h.views.length, 2);
  for (const view of h.views) assert.equal(view.webContents.userAgent, h.originalUA);
  assert.equal(controller.window.options.icon, '/usr/share/pixmaps/onlydm.png');
  assert.equal(controller.window.menuRemoved, true);
  controller.window.close();
  assert.ok(h.views.every(view => view.webContents.isDestroyed()));
  assert.deepEqual(h.ipcMain.eventNames(), []);
  for (const instagram of h.sessions.values()) assert.equal(instagram.listenerCount('will-download'), 0);
});

'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const main = readFileSync(path.join(__dirname, '../src/main.cjs'), 'utf8');
const turn = () => new Promise(setImmediate);

// Electron's native event boundary is unavailable to Node's test runner.
// Execute the production entry point with controllable native events instead.
function host(platform, { locked = true, pending = false, fail = false, maintenanceAccepted = true, argv = [] } = {}) {
  const app = new EventEmitter();
  const windows = [];
  const menus = [];
  const errors = [];
  let ready;
  let finishOpening;
  let creations = 0;
  let disposals = 0;
  let quits = 0;
  let isReady = false;
  let quitting = false;
  const readiness = new Promise(resolve => { ready = () => { isReady = true; resolve(); }; });
  Object.assign(app, {
    setName(name) { this.name = name; },
    getName() { return this.name; },
    requestSingleInstanceLock: () => locked,
    isReady: () => isReady,
    whenReady: () => readiness,
    quit() {
      if (quitting) return;
      quits++;
      quitting = true;
      app.emit('before-quit');
      for (const window of windows) if (!window.isDestroyed()) window.close();
    },
  });

  function createWindow() {
    const window = new EventEmitter();
    let visible = true;
    let minimized = false;
    let destroyed = false;
    let focuses = 0;
    Object.assign(window, {
      isDestroyed: () => destroyed,
      isVisible: () => visible,
      isMinimized: () => minimized,
      minimize() { minimized = true; },
      restore() { minimized = false; },
      hide() { visible = false; },
      show() { visible = true; },
      focus() { focuses++; },
      close() {
        let prevented = false;
        window.emit('close', { preventDefault() { prevented = true; } });
        if (prevented || destroyed) return;
        destroyed = true;
        visible = false;
        window.emit('closed');
        if (!quitting) app.emit('window-all-closed');
      },
      destroy() {
        destroyed = true;
        visible = false;
        window.emit('closed');
        if (!quitting) app.emit('window-all-closed');
      },
    });
    Object.defineProperty(window, 'focuses', { get: () => focuses });
    window.once('closed', () => { disposals++; });
    windows.push(window);
    return { window, confirmCloseForMaintenance: async () => maintenanceAccepted };
  }

  const electron = {
    app,
    dialog: { showErrorBox: (...args) => errors.push(args) },
    Menu: {
      buildFromTemplate: template => template,
      setApplicationMenu(menu) {
        assert.equal(isReady, true, 'install native menus after Electron is ready');
        menus.push(menu);
      },
    },
  };
  const createOnlyDM = async () => {
    creations++;
    if (fail) throw new Error('fixture startup failure');
    if (pending) await new Promise(resolve => { finishOpening = resolve; });
    return createWindow();
  };
  vm.runInNewContext(main, {
    process: { platform, argv },
    require(id) {
      if (id === 'electron') return electron;
      if (id === './app.cjs') return { createOnlyDM };
      throw new Error('Unexpected dependency: ' + id);
    },
  }, { filename: 'main.cjs' });

  return {
    app, windows, menus, errors, ready,
    finishOpening: () => finishOpening(),
    get creations() { return creations; },
    get disposals() { return disposals; },
    get quits() { return quits; },
  };
}

test('CLI maintenance stop quits on both platforms only after draft confirmation accepts', async () => {
  for (const platform of ['linux', 'darwin']) for (const maintenanceAccepted of [true, false]) {
    const h = host(platform, { maintenanceAccepted });
    h.ready(); await turn();
    h.app.emit('second-instance', {}, ['OnlyDM', '--onlydm-cli-stop']);
    await turn();
    assert.equal(h.quits, maintenanceAccepted ? 1 : 0);
    assert.equal(h.windows[0].isDestroyed(), maintenanceAccepted);
  }
});

test('cold CLI stop does not open a window or wait for app startup', () => {
  const h = host('darwin', { argv: ['OnlyDM', '--onlydm-cli-stop'] });
  assert.equal(h.quits, 1);
  assert.equal(h.creations, 0);
});

test('macOS installs native app, Edit and Window roles for Quit, Hide and clipboard shortcuts', async () => {
  const h = host('darwin');
  assert.equal(h.menus.length, 0);
  h.ready();
  await turn();
  assert.equal(h.menus.length, 1);
  assert.deepEqual(Array.from(h.menus[0], item => item.role), ['appMenu', 'editMenu', 'windowMenu']);
  assert.equal(h.app.name, 'OnlyDM');
});

test('macOS close hides the same window and keeps its inbox resources until explicit quit', async () => {
  const h = host('darwin');
  h.ready();
  await turn();
  const [window] = h.windows;
  for (let i = 0; i < 2; i++) {
    window.close();
    assert.equal(window.isDestroyed(), false);
    assert.equal(window.isVisible(), false);
    assert.equal(h.disposals, 0, 'closing to the Dock retains the existing inbox owner');
    h.app.emit(i === 0 ? 'activate' : 'second-instance');
    await turn();
    assert.equal(window.isVisible(), true);
  }
  assert.equal(h.creations, 1, 'restoring must not start duplicate inbox watchers');
  assert.equal(h.quits, 0);
  window.close();
  h.app.quit();
  assert.equal(window.isDestroyed(), true);
  assert.equal(h.disposals, 1);
  h.app.emit('activate');
  h.app.emit('second-instance');
  await turn();
  assert.equal(h.creations, 1, 'quit cannot resurrect the app');
});

test('second-instance restores a minimized window on macOS and Ubuntu', async () => {
  for (const platform of ['darwin', 'linux']) {
    const h = host(platform);
    h.ready();
    await turn();
    const [window] = h.windows;
    window.minimize();
    window.hide();
    const focuses = window.focuses;
    h.app.emit('second-instance');
    await turn();
    assert.equal(window.isMinimized(), false, platform);
    assert.equal(window.isVisible(), true, platform);
    assert.ok(window.focuses > focuses, platform);
    assert.equal(h.creations, 1, platform);
  }
});

test('activate and second-instance during startup wait for one in-flight window', async () => {
  const h = host('darwin', { pending: true });
  h.app.emit('second-instance');
  h.app.emit('activate');
  assert.equal(h.creations, 0);
  h.ready();
  await turn();
  h.app.emit('activate');
  h.app.emit('second-instance');
  await turn();
  assert.equal(h.creations, 1);
  h.finishOpening();
  await turn();
  assert.equal(h.windows.length, 1);
  assert.equal(h.windows[0].isVisible(), true);
});

test('macOS can reopen after a destroyed window without duplicate concurrent creations', async () => {
  const h = host('darwin');
  h.ready();
  await turn();
  h.windows[0].destroy();
  assert.equal(h.quits, 0);
  h.app.emit('activate');
  h.app.emit('second-instance');
  await turn();
  assert.equal(h.creations, 2);
  assert.equal(h.windows.filter(window => !window.isDestroyed()).length, 1);
  assert.equal(h.disposals, 1);
});

test('Ubuntu close still disposes the window and quits without a macOS application menu', async () => {
  const h = host('linux');
  h.ready();
  await turn();
  h.windows[0].close();
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.equal(h.disposals, 1);
  assert.equal(h.quits, 1);
  assert.equal(h.menus.length, 0);
});

test('losing the single-instance lock quits without opening a window or installing menus', async () => {
  const h = host('darwin', { locked: false });
  h.ready();
  await turn();
  assert.equal(h.quits, 1);
  assert.equal(h.creations, 0);
  assert.equal(h.menus.length, 0);
});

test('startup failure shows the existing safe error and quits once', async () => {
  const h = host('darwin', { fail: true });
  h.ready();
  h.app.emit('activate');
  h.app.emit('second-instance');
  await turn();
  assert.equal(h.creations, 1);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0][0], 'OnlyDM');
  assert.equal(h.quits, 1);
});

test('explicit quit during startup closes any late window instead of hiding it', async () => {
  const h = host('darwin', { pending: true });
  h.ready();
  await turn();
  h.app.quit();
  h.finishOpening();
  await turn();
  assert.equal(h.windows[0].isDestroyed(), true);
  assert.equal(h.disposals, 1);
});

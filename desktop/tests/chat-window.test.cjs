'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const filename = path.join(__dirname, '../src/chat-window.cjs');
const turn = () => new Promise(setImmediate);
const palette = { surface: '#101418', chrome: '#202830', chromeText: '#FFFFFF' };
const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

// Only Electron's native boundary is replaced; no renderer, network or live profile is opened.
function runtime(platform = 'linux') {
  assert.ok(existsSync(filename), 'chat-window factory must exist');
  const windows = [], order = [];
  let resolveLoad, rejectLoad;
  const state = { throwLoad: false };
  const loading = new Promise((resolve, reject) => { resolveLoad = resolve; rejectLoad = reject; });
  class Contents extends EventEmitter {
    constructor() { super(); this.destroyed = false; }
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler(handler) { this.open = handler; }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new Contents();
      this.destroyed = false;
      this.visible = false;
      this.focuses = 0;
      this.loads = [];
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    removeMenu() { this.menuRemoved = true; }
    show() { assert.equal(this.destroyed, false); order.push('show'); this.visible = true; }
    focus() { assert.equal(this.destroyed, false); order.push('focus'); this.focuses++; }
    hide() { this.visible = false; this.emit('hide'); }
    loadFile(file) {
      this.loads.push(file);
      assert.equal(typeof this.webContents.open, 'function', 'popup guard precedes the load');
      assert.ok(this.webContents.listenerCount('will-navigate'), 'navigation guard precedes the load');
      if (state.throwLoad) throw new Error('synchronous load failure');
      return loading;
    }
    close() {
      const e = event();
      this.emit('close', e);
      if (!e.defaultPrevented) this.destroy();
      return e;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.destroyed = true;
      this.webContents.emit('destroyed');
      this.emit('closed');
    }
  }
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, __dirname: path.dirname(filename), process: { platform },
    require(id) {
      if (id === 'electron') return { BrowserWindow: Window };
      if (id === 'node:path') return path;
      throw new Error('Unexpected dependency: ' + id);
    },
  }, { filename });
  return { create: module.exports.createChatWindow, windows, order, state, resolveLoad, rejectLoad };
}

test('returns an independent secured shell synchronously, then initializes before showing', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const r = runtime(platform), ready = [], destroyed = [];
    const window = r.create({ icon: '/fixture/icon.png', palette, lang: 'ko', title: 'Local room',
      onReady(value) { ready.push(value); r.order.push('ready'); },
      onDestroyed: value => destroyed.push(value) });
    assert.equal(window, r.windows[0]);
    assert.equal(window.visible, false);
    assert.equal(ready.length, 0);
    const options = window.options;
    assert.equal(options.title, 'Local room');
    assert.equal(options.icon, '/fixture/icon.png');
    assert.equal(options.width, 400);
    assert.equal(options.height, 650);
    assert.equal(options.minWidth, 350);
    assert.equal(options.minHeight, 420);
    assert.equal(options.show, false);
    assert.equal(options.frame, true);
    assert.equal(options.titleBarStyle, 'hidden');
    assert.equal(options.backgroundColor, palette.surface);
    assert.equal(options.parent, undefined, 'room windows are independent');
    for (const [key, value] of Object.entries({ sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false }))
      assert.equal(options.webPreferences[key], value, key);
    assert.equal(options.webPreferences.preload, path.join(path.dirname(filename), 'shell-preload.cjs'));
    if (platform === 'darwin') {
      assert.equal(options.trafficLightPosition.x, 10);
      assert.equal(options.trafficLightPosition.y, 8);
      assert.equal(options.titleBarOverlay, undefined);
      assert.equal(window.menuRemoved, undefined);
    } else {
      assert.equal(options.titleBarOverlay.color, palette.chrome);
      assert.equal(options.titleBarOverlay.symbolColor, palette.chromeText);
      assert.equal(options.titleBarOverlay.height, 30);
      assert.equal(window.menuRemoved, true);
    }
    // The owner can install room views/handlers before any load completion callback.
    window.ownerAttached = true;
    await turn();
    assert.deepEqual(window.loads, [path.join(path.dirname(filename), 'shell.html')]);
    assert.equal(window.visible, false);
    r.resolveLoad();
    await turn();
    assert.deepEqual(ready, [window]);
    assert.deepEqual(r.order, ['ready', 'show', 'focus']);
    assert.equal(window.ownerAttached, true);
    window.destroy();
    assert.deepEqual(destroyed, [window]);
  }
});

test('blocks shell navigation, redirects, subframe navigation and popup requests', async () => {
  const r = runtime(), window = r.create({ palette });
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    const e = event();
    window.webContents.emit(name, e, 'https://example.com/');
    assert.equal(e.defaultPrevented, true, name);
  }
  assert.equal(window.webContents.open({ url: 'https://example.com/' }).action, 'deny');
  r.resolveLoad();
  await turn();
  window.destroy();
});

test('native close preserves the renderer and calls onHide for each close', async () => {
  const r = runtime(), hidden = [], destroyed = [];
  const window = r.create({ palette, onHide: value => hidden.push(value), onDestroyed: value => destroyed.push(value) });
  r.resolveLoad();
  await turn();
  const contents = window.webContents;
  assert.equal(window.close().defaultPrevented, true);
  assert.equal(window.visible, false);
  assert.equal(window.isDestroyed(), false);
  assert.equal(contents.isDestroyed(), false);
  window.show();
  window.close();
  assert.deepEqual(hidden, [window, window]);
  assert.deepEqual(destroyed, []);
  window.destroy();
  assert.deepEqual(destroyed, [window]);
});

test('closing before load completion initializes the hidden window without resurrecting it', async () => {
  const r = runtime(), ready = [];
  const window = r.create({ palette, onReady: value => ready.push(value) });
  window.close();
  r.resolveLoad();
  await turn();
  assert.deepEqual(ready, [window]);
  assert.equal(window.visible, false);
  assert.equal(window.focuses, 0);
  window.destroy();
});

test('explicit disposal cancels pending readiness and removes only factory listeners', async () => {
  const r = runtime(), ready = [], destroyed = [];
  const window = r.create({ palette, onReady: value => ready.push(value), onDestroyed: value => destroyed.push(value) });
  const ownerListener = () => {};
  window.webContents.on('will-navigate', ownerListener);
  window.destroy();
  r.resolveLoad();
  await turn();
  assert.deepEqual(ready, []);
  assert.deepEqual(destroyed, [window]);
  assert.deepEqual(window.webContents.listeners('will-navigate'), [ownerListener]);
  assert.equal(window.webContents.listenerCount('will-redirect'), 0);
  assert.equal(window.webContents.listenerCount('will-frame-navigate'), 0);
  assert.equal(window.webContents.listenerCount('render-process-gone'), 0);
  assert.equal(window.webContents.listenerCount('destroyed'), 0);
  assert.equal(window.listenerCount('close'), 0);
  assert.equal(window.listenerCount('hide'), 0);
});

test('load failures and renderer loss destroy once without ready callbacks or late shows', async () => {
  for (const failure of ['reject', 'throw', 'failed-main-load', 'crash', 'contents-destroyed']) {
    const r = runtime(), ready = [], destroyed = [];
    r.state.throwLoad = failure === 'throw';
    const window = r.create({ palette, onReady: value => ready.push(value), onDestroyed: value => destroyed.push(value) });
    await turn();
    if (failure === 'reject') r.rejectLoad(new Error('failed shell load'));
    else if (failure === 'failed-main-load') window.webContents.emit('did-fail-load', {}, -6, 'missing shell', 'file:///shell.html', true);
    else if (failure === 'crash') window.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    else if (failure === 'contents-destroyed') window.webContents.emit('destroyed');
    await turn();
    r.resolveLoad();
    await turn();
    assert.equal(window.isDestroyed(), true, failure);
    assert.deepEqual(ready, [], failure);
    assert.deepEqual(destroyed, [window], failure);
    assert.equal(window.focuses, 0, failure);
  }
});

test('subframe failures do not discard the room shell', async () => {
  const r = runtime(), window = r.create({ palette });
  window.webContents.emit('did-fail-load', {}, -6, 'missing subresource', 'file:///frame.html', false);
  r.resolveLoad();
  await turn();
  assert.equal(window.isDestroyed(), false);
  assert.equal(window.visible, true);
  window.destroy();
});

test('waits for asynchronous owner setup and honors hide or destroy while setup is pending', async () => {
  for (const action of ['show', 'hide', 'destroy', 'reject']) {
    const r = runtime();
    let finishReady, failReady, destroyed = 0;
    const ready = new Promise((resolve, reject) => { finishReady = resolve; failReady = reject; });
    const window = r.create({ palette, onReady: () => ready, onDestroyed() { destroyed++; } });
    r.resolveLoad();
    await turn();
    assert.equal(window.visible, false, 'wait for owner views/state');
    if (action === 'hide') window.hide();
    else if (action === 'destroy') window.destroy();
    if (action === 'reject') failReady(new Error('owner setup failed'));
    else finishReady();
    await turn();
    assert.equal(window.visible, action === 'show');
    assert.equal(window.focuses, action === 'show' ? 1 : 0);
    if (action === 'reject' || action === 'destroy') assert.equal(destroyed, 1);
    window.destroy();
  }
});

test('owner disposal during ready suppresses show and callback failures still clean up', async () => {
  for (const callback of ['dispose', 'ready-throws', 'destroyed-throws', 'hide-throws']) {
    const r = runtime();
    let count = 0;
    const window = r.create({ palette,
      onReady(value) { if (callback === 'dispose') value.destroy(); else if (callback !== 'hide-throws') throw new Error('owner ready failure'); },
      onHide() { if (callback === 'hide-throws') throw new Error('owner hide failure'); },
      onDestroyed() { count++; if (callback === 'destroyed-throws') throw new Error('owner cleanup failure'); } });
    if (callback === 'hide-throws') window.close();
    r.resolveLoad();
    await turn();
    assert.equal(window.isDestroyed(), true, callback);
    assert.equal(window.focuses, 0, callback);
    assert.equal(count, 1, callback);
  }
});

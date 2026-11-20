'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const navigation = require('../src/navigation.cjs');
const { normalizeInstagramUserAgent } = require('../src/platform.cjs');

const CALL = 'https://www.instagram.com/call/?call_id=fixture&has_video=false';
const NEXT = 'https://www.instagram.com/call/?call_id=other&has_video=true';
const UA = 'Mozilla/5.0 (Macintosh; Apple macOS 26.1) OnlyDM/1.1.10 Chrome/154.0.8113.42 Electron/45.3.1 Safari/537.36';
const turn = () => new Promise(setImmediate);
const rejected = [
  'http://www.instagram.com/call/',
  'https://www.instagram.com:8443/call/',
  'https://instagram.com.evil.test/call/',
  'https://evil.test/call/?next=https://www.instagram.com/call/',
  'https://www.instagram.com@evil.test/call/',
  'https://evil.test@www.instagram.com/call/',
  'https://user:password@instagram.com/call/',
  'https://@www.instagram.com/call/',
  'https://www.instagram.com./call/',
  'https://%69nstagram.com/call/',
  'https://www.instagram.com/',
  'https://www.instagram.com/direct/inbox/',
  'https://www.instagram.com/accounts/login/?next=/call/',
  'https://www.instagram.com/call',
  'https://www.instagram.com/call/child/',
  'https://www.instagram.com/CALL/',
  'https://www.instagram.com/direct/call/',
  'https://www.instagram.com/%63all/',
  'https://www.instagram.com/other/../call/',
  'https://www.instagram.com/other/%2e%2e/call/',
  'https://www.instagram.com/call/../direct/inbox/',
  'https://www.instagram.com/call/%2f..',
  'https://www.instagram.com\\call/',
  ' https://www.instagram.com/call/',
  'https://www.instagram.com/call/\n',
  'https://www.insta\tgram.com/call/',
  '//www.instagram.com/call/',
  'about:blank', 'file:///call/', 'javascript:window.close()',
  'data:text/html,https://www.instagram.com/call/',
  '', null, undefined, 123, {},
];

function event(fields = {}) {
  return { ...fields, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
}

// Exercise the real host; replace only Electron's native window boundary, with no network or media.
function runtime({ platform = 'linux', lang = 'en' } = {}) {
  const windows = [];
  const state = { throwOnCreate: false, load: null };
  class Contents extends EventEmitter {
    constructor(instagram) {
      super();
      this.session = instagram;
      this.href = '';
      this.userAgent = UA;
      this.destroyed = false;
    }
    isDestroyed() { return this.destroyed; }
    getURL() { return this.href; }
    getUserAgent() { return this.userAgent; }
    setUserAgent(value) { this.userAgent = value; }
    setWindowOpenHandler(handler) { this.windowOpen = handler; }
    destroy() { this.destroyed = true; this.emit('destroyed'); }
  }
  class Window extends EventEmitter {
    constructor(options) {
      super();
      if (state.throwOnCreate) throw new Error('native creation failed');
      this.options = options;
      this.webContents = new Contents(options.webPreferences.session);
      this.loads = [];
      this.destroyed = false;
      this.visible = false;
      this.minimized = false;
      this.focuses = 0;
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isMinimized() { return this.minimized; }
    restore() { this.minimized = false; }
    show() { this.visible = true; }
    focus() { this.focuses++; }
    removeMenu() { this.menuRemoved = true; }
    loadURL(url) {
      this.loads.push({ url, userAgent: this.webContents.userAgent });
      assert.equal(typeof this.webContents.windowOpen, 'function', 'guard popups before the first load');
      assert.ok(this.webContents.listenerCount('will-navigate'), 'guard navigation before the first load');
      this.webContents.href = url;
      return state.load ? state.load(url) : Promise.resolve();
    }
    close() {
      if (this.beforeUnload) {
        const e = event();
        this.webContents.emit('will-prevent-unload', e);
        if (!e.defaultPrevented) return;
      }
      this.destroy();
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.webContents.destroy();
      this.emit('closed');
    }
  }
  const parent = Object.assign(new EventEmitter(), { destroyed: false, isDestroyed() { return this.destroyed; } });
  const filename = path.join(__dirname, '../src/calls.cjs');
  const module = { exports: {} };
  vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module, process: { platform }, URL,
    require(id) {
      if (id === 'electron') return { BrowserWindow: Window };
      if (id === './navigation.cjs') return navigation;
      if (id === './platform.cjs') return {
        normalizeInstagramUserAgent: value => normalizeInstagramUserAgent(value, platform),
      };
      throw new Error('Unexpected call host dependency: ' + id);
    },
  }, { filename });
  const host = module.exports.createCallHost({ parent, icon: '/fixture/OnlyDM.png', lang });
  const instagram = Object.freeze({ profile: 'first' });
  return { host, parent, windows, instagram, state, allowCallMedia: module.exports.allowCallMedia };
}

test('media permission is limited to the owned main call frame and exact audio/video types', () => {
  const { host, instagram, allowCallMedia } = runtime();
  host.open({ url: CALL }, instagram);
  const contents = host.window.webContents;
  const options = { contents, permission: 'media', origin: 'https://www.instagram.com', owns: host.owns,
    details: { requestingUrl: CALL, isMainFrame: true, mediaTypes: ['audio', 'video'], mediaType: 'audio' } };
  assert.equal(allowCallMedia(options), true);
  assert.equal(allowCallMedia({ ...options, check: true }), true);
  for (const change of [
    { permission: 'display-capture' }, { contents: null }, { owns: () => false }, { origin: 'https://evil.invalid/' },
    { details: undefined }, { details: { ...options.details, isMainFrame: false } },
    { details: { ...options.details, requestingUrl: 'https://www.instagram.com/direct/inbox/' } },
    { details: { ...options.details, mediaTypes: [] } },
    { details: { ...options.details, mediaTypes: ['screen'] } },
    { check: true, details: { ...options.details, mediaType: 'unknown' } },
  ]) assert.equal(allowCallMedia({ ...options, ...change }), false);
  contents.href = 'https://www.instagram.com/direct/inbox/';
  assert.equal(allowCallMedia(options), false);
  host.close();
  assert.equal(allowCallMedia(options), false);
});

test('opens only canonical official HTTPS call paths, preserving call query and fragment', () => {
  const { host, windows, instagram } = runtime();
  for (const [url, expected] of [
    [CALL, CALL],
    ['https://instagram.com/call/', 'https://instagram.com/call/'],
    ['HTTPS://WWW.INSTAGRAM.COM:443/call/?has_video=true#cancelled',
      'https://www.instagram.com/call/?has_video=true#cancelled'],
    ['https://www.instagram.com/call/?next=%2Fdirect%2Finbox%2F',
      'https://www.instagram.com/call/?next=%2Fdirect%2Finbox%2F'],
  ]) {
    assert.equal(host.open({ url }, instagram), true, url);
    assert.equal(host.window.loads.at(-1).url, expected);
  }
  assert.equal(windows.length, 1);
});

test('rejects spoofed origins, userinfo, other paths, parser-normalized paths and non-URLs', () => {
  const { host, windows, instagram } = runtime();
  for (const url of rejected) assert.equal(host.open({ url }, instagram), false, String(url));
  for (const details of [undefined, null, {}, CALL,
    { url: CALL, frameName: 'onlydm-external-link' }]) {
    assert.equal(host.open(details, instagram), false);
  }
  assert.equal(windows.length, 0);
  assert.equal(host.window, null);
});

test('never falls back to a default session when the supplied profile session is missing', () => {
  const { host, windows } = runtime();
  for (const instagram of [undefined, null, false, '', 1]) {
    assert.equal(host.open({ url: CALL }, instagram), false);
  }
  assert.equal(windows.length, 0);
});

test('configures native close chrome, full content size and isolated renderers before loading', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const { host, parent } = runtime({ platform, lang: 'ko' });
    // Session data and permission policies belong to the caller, never to the popup host.
    const instagram = new Proxy({}, { get() { assert.fail('must not inspect or mutate the supplied session'); } });
    assert.equal(host.open({ url: CALL, features: 'nodeIntegration=yes,frame=no,width=1' }, instagram), true);
    const window = host.window;
    const options = window.options;
    assert.equal(options.parent, parent);
    assert.equal(options.icon, '/fixture/OnlyDM.png');
    assert.equal(options.title, 'OnlyDM 통화');
    assert.equal(options.width, 1010);
    assert.equal(options.height, 760);
    assert.equal(options.useContentSize, true);
    assert.equal(options.minWidth, 700);
    assert.equal(options.frame, true);
    assert.equal(options.closable, true);
    assert.equal(options.fullscreenable, false);
    assert.equal(options.titleBarStyle, undefined);
    const preferences = options.webPreferences;
    assert.equal(preferences.session, instagram);
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.equal(preferences.nodeIntegrationInSubFrames, false);
    assert.equal(preferences.nodeIntegrationInWorker, false);
    assert.equal(preferences.webviewTag, false);
    assert.equal(preferences.webSecurity, true);
    assert.equal(preferences.allowRunningInsecureContent, false);
    assert.equal(preferences.disableHtmlFullscreenWindowResize, true);
    assert.equal(preferences.preload, undefined);
    const expectedUA = platform === 'darwin'
      ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/154.0.8113.42 Safari/537.36' : UA;
    assert.equal(window.loads[0].userAgent, expectedUA);
    assert.equal(host.owns(window.webContents), true);
    assert.equal(host.owns({ ...window.webContents }), false);
    assert.equal(host.owns(null), false);
  }
});

test('deduplicates repeated requests and restores one popup, loading a changed URL once', () => {
  const { host, windows, instagram } = runtime();
  host.open({ url: CALL }, instagram);
  const window = host.window;
  window.minimized = true;
  window.visible = false;
  assert.equal(host.open({ url: CALL }, instagram), true);
  assert.equal(window.loads.length, 1);
  assert.equal(window.visible, true);
  assert.equal(window.minimized, false);
  assert.equal(window.focuses, 2);
  assert.equal(host.open({ url: NEXT }, instagram), true);
  assert.equal(host.window, window);
  assert.deepEqual(window.loads.map(load => load.url), [CALL, NEXT]);
  assert.equal(windows.length, 1);
  for (const url of rejected) assert.equal(host.open({ url }, instagram), false);
  assert.equal(host.window, window);
  assert.equal(window.loads.length, 2);
});

test('switching profiles destroys the old popup and never reuses its authenticated session', () => {
  const { host, windows, instagram } = runtime();
  host.open({ url: CALL }, instagram);
  const previous = host.window;
  const other = Object.freeze({ profile: 'second' });
  assert.equal(host.open({ url: CALL }, other), true);
  assert.equal(previous.isDestroyed(), true);
  assert.equal(host.owns(previous.webContents), false);
  assert.equal(host.window.webContents.session, other);
  assert.equal(host.owns(host.window.webContents), true);
  assert.equal(windows.length, 2);
  previous.emit('closed');
  previous.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(host.window, windows[1], 'late events cannot clear or close a replacement');
});

test('closing, a renderer crash or destroyed contents revoke ownership and permit a fresh popup', () => {
  for (const finish of [
    window => window.close(),
    window => window.destroy(),
    window => window.webContents.destroy(),
    window => window.webContents.emit('render-process-gone', {}, { reason: 'crashed' }),
  ]) {
    const { host, instagram } = runtime();
    host.open({ url: CALL }, instagram);
    const previous = host.window;
    finish(previous);
    assert.equal(host.window, null);
    assert.equal(host.owns(previous.webContents), false);
    assert.equal(previous.isDestroyed(), true);
    assert.equal(host.open({ url: NEXT }, instagram), true);
    assert.notEqual(host.window, previous);
    host.close(); host.close();
    assert.equal(host.window, null);
  }
});

test('parent shutdown disposes the call and cannot resurrect it', () => {
  const { host, parent, instagram, windows } = runtime();
  host.open({ url: CALL }, instagram);
  const contents = host.window.webContents;
  parent.destroyed = true;
  parent.emit('closed');
  assert.equal(host.window, null);
  assert.equal(host.owns(contents), false);
  assert.equal(host.open({ url: NEXT }, instagram), false);
  assert.equal(windows.length, 1);
});

test('blocks nested popups and non-call navigation and redirects, including frame navigation', () => {
  const { host, windows, instagram } = runtime();
  host.open({ url: CALL }, instagram);
  const contents = host.window.webContents;
  for (const url of [CALL, NEXT, 'https://example.com/']) {
    assert.equal(contents.windowOpen({ url }).action, 'deny');
  }
  for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate']) {
    assert.ok(contents.listenerCount(name), name);
    for (const isMainFrame of [true, false]) {
      for (const url of [CALL, NEXT, 'https://instagram.com/call/#ended', ...rejected]) {
        const e = event({ url, isMainFrame });
        contents.emit(name, e);
        assert.equal(e.defaultPrevented, rejected.includes(url), name + ': ' + String(url));
      }
    }
    // Electron retains deprecated positional navigation parameters as well.
    const legacy = event();
    contents.emit(name, legacy, 'https://example.com/', false, true);
    assert.equal(legacy.defaultPrevented, true);
  }
  assert.equal(windows.length, 1);
  assert.equal(host.owns(contents), true);
});

test('committed and same-document escapes close the host; official finish screens retain native close', () => {
  for (const name of ['did-navigate', 'did-navigate-in-page']) {
    const { host, instagram } = runtime();
    host.open({ url: CALL }, instagram);
    const window = host.window;
    for (const url of ['https://instagram.com/call/#cancelled', NEXT + '#ended']) {
      window.webContents.emit(name, {}, url, true);
      assert.equal(host.window, window);
    }
    assert.equal(host.open({ url: NEXT + '#ended' }, instagram), true);
    assert.equal(window.loads.length, 1, 'an official in-page transition is already loaded');
    window.webContents.emit(name, {}, 'https://www.instagram.com/direct/inbox/', true);
    assert.equal(window.isDestroyed(), true);
    assert.equal(host.window, null);
  }
});

test('a page cannot resize away the close controls or veto native close on a cancelled call', () => {
  const { host, instagram } = runtime();
  host.open({ url: CALL }, instagram);
  const window = host.window;
  const bounds = event();
  window.webContents.emit('content-bounds-updated', bounds, { x: -5000, y: -5000, width: 1, height: 1 });
  assert.equal(bounds.defaultPrevented, true);
  window.beforeUnload = true;
  window.close();
  assert.equal(window.isDestroyed(), true);
  assert.equal(host.window, null);
});

test('Escape offers a native exit even when call controls have disappeared', () => {
  const { host, instagram } = runtime();
  host.open({ url: CALL }, instagram);
  const window = host.window;
  const e = event();
  window.webContents.emit('before-input-event', e, { type: 'keyDown', key: 'Escape' });
  assert.equal(e.defaultPrevented, true);
  assert.equal(window.isDestroyed(), true);
});

test('native creation and synchronous load failures return false and clean up', () => {
  const { host, instagram, state, windows } = runtime();
  state.throwOnCreate = true;
  assert.equal(host.open({ url: CALL }, instagram), false);
  assert.equal(host.window, null);
  state.throwOnCreate = false;
  state.load = () => { throw new Error('native load failed'); };
  assert.equal(host.open({ url: CALL }, instagram), false);
  assert.equal(host.window, null);
  assert.equal(windows[0].isDestroyed(), true);
});

test('an official client-side call transition can abort the initial load without closing its host', async () => {
  for (const failure of [Object.assign(new Error('ERR_ABORTED'), { code: 'ERR_ABORTED' }),
    Object.assign(new Error('navigation replaced'), { errno: -3 })]) {
    const { host, instagram, state } = runtime();
    let rejectLoad;
    state.load = () => new Promise((_resolve, reject) => { rejectLoad = reject; });
    host.open({ url: CALL }, instagram);
    const window = host.window;
    window.webContents.emit('did-navigate', {}, NEXT, 200, 'OK');
    rejectLoad(failure);
    await turn();
    assert.equal(host.window, window);
    assert.equal(host.owns(window.webContents), true);
    assert.equal(host.open({ url: NEXT }, instagram), true);
    assert.equal(window.loads.length, 1);
  }
});

test('failed async loads close only the current request, never a newer URL or replacement popup', async () => {
  const { host, instagram, state } = runtime();
  const failures = [];
  state.load = () => new Promise((_resolve, reject) => failures.push(reject));
  assert.equal(host.open({ url: CALL }, instagram), true);
  const first = host.window;
  host.open({ url: NEXT }, instagram);
  host.open({ url: CALL }, instagram);
  failures[0](new Error('aborted first request'));
  failures[1](new Error('aborted second request'));
  await turn();
  assert.equal(host.window, first, 'an older URL rejection must not discard the latest request');
  host.close();
  host.open({ url: CALL }, instagram);
  const replacement = host.window;
  failures[2](new Error('closed previous window'));
  await turn();
  assert.equal(host.window, replacement);
  failures[3](new Error('offline'));
  await turn();
  assert.equal(host.window, null);
  assert.equal(host.owns(replacement.webContents), false);
  assert.equal(replacement.isDestroyed(), true);
});

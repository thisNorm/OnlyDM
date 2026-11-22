'use strict';

require('./fixture-runtime.cjs');

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, session } = require('electron');
const { createCallHost } = require('../src/calls.cjs');

const root = mkdtempSync(join(tmpdir(), 'onlydm-calls-smoke-'));
app.setPath('userData', root);
app.setPath('sessionData', root);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
app.on('window-all-closed', () => {});
app.once('quit', () => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* Chromium can retain locks during shutdown. */ }
});

const origin = 'https://www.instagram.com';
const parentUrl = origin + '/direct/t/calls-fixture/';
const firstUrl = origin + '/call/?fixture=first';
const nextUrl = origin + '/call/?fixture=next';
const escapeUrl = origin + '/explore/?fixture=escape';
const frameEscape = origin + '/direct/inbox/?fixture=frame-escape';
const externalUrl = 'https://onlydm-calls-smoke.invalid/escape';
const frameUrl = origin + '/call/?fixture=frame';
const fixtures = new Set();
const requests = [];
const forbidden = [];
const consoleEvents = [];
const navigations = [];
const rendererErrors = [];
const limitations = new Set();
let inputSequence = 0;
let active;
let parent;
let host;
let phase = 'starting Electron';
let finished = false;

function html(body) {
  return new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">'
    + '<style>body{margin:24px;font:16px sans-serif}button{display:block;margin:12px 0;padding:12px}'
    + 'iframe{display:block;width:360px;height:180px}</style>' + body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; "
        + "img-src data:; frame-src https:; connect-src 'none'; form-action 'none'; base-uri 'none'",
    },
  });
}

function callPage() {
  return html(`<h1>Synthetic call fixture</h1><p id="status">No real call or media</p>
    <button id="cancel">Cancel synthetic call</button>
    <button id="finish">Show synthetic finished screen</button>
    <button id="nested">Attempt a nested popup</button>
    <button id="escape">Attempt another Instagram path</button>
    <button id="external">Attempt an external navigation</button>
    <button id="frame">Create an official call frame</button>
    <button id="frame-escape">Attempt a frame escape</button>
    <script>
      window.fixtureReady = true;
      const trusted = event => {
        if (!event.isTrusted) throw new Error('This fixture requires native input');
        console.log('onlydm-calls-fixture:' + event.currentTarget.id + ':trusted');
      };
      document.querySelector('#cancel').onclick = event => {
        trusted(event);
        history.replaceState({}, '', '/call/?fixture=cancelled');
        document.querySelector('#status').textContent = 'Synthetic call cancelled';
        window.close();
      };
      document.querySelector('#finish').onclick = event => {
        trusted(event);
        history.replaceState({}, '', '/call/?fixture=finished');
        document.querySelector('#status').textContent = 'Synthetic call ended';
        window.addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; });
      };
      document.querySelector('#nested').onclick = event => {
        trusted(event);
        window.fixtureNestedDenied = window.open('/call/?fixture=nested', 'nested-call') === null;
      };
      document.querySelector('#escape').onclick = event => { trusted(event); location.href = ${JSON.stringify(escapeUrl)}; };
      document.querySelector('#external').onclick = event => { trusted(event); location.href = ${JSON.stringify(externalUrl)}; };
      document.querySelector('#frame').onclick = event => {
        trusted(event);
        const frame = document.createElement('iframe');
        frame.id = 'fixture-frame'; frame.src = ${JSON.stringify(frameUrl)}; document.body.append(frame);
      };
      document.querySelector('#frame-escape').onclick = event => {
        trusted(event);
        document.querySelector('#fixture-frame').contentWindow.location.href = ${JSON.stringify(frameEscape)};
      };
    </script>`);
}

// Intercept HTTPS in EVERY session, with no network fallback or net.fetch. All other
// network schemes are cancelled, and no persistent Instagram profile or cookie API is used.
app.on('session-created', created => {
  created.setPermissionCheckHandler(() => false);
  created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  created.on('will-download', event => event.preventDefault());
  created.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, ({ url }, callback) => {
    const target = new URL(url);
    callback({ cancel: !fixtures.has(created) || target.protocol !== 'https:'
      || ![origin, 'https://instagram.com'].includes(target.origin) });
  });
  created.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (!fixtures.has(created) || ![origin, 'https://instagram.com'].includes(url.origin)
        || request.method !== 'GET' || !['/call/', '/direct/t/calls-fixture/'].includes(url.pathname)) {
      forbidden.push(url.href);
      return new Response('Blocked synthetic destination', { status: 403 });
    }
    requests.push({ session: created, url: url.href });
    if (url.pathname === '/call/') return callPage();
    return html('<h1>Synthetic conversation</h1><p>Separate session storage fixture</p>');
  });
});

async function waitFor(label, probe) {
  phase = label;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(40);
  }
  const window = host?.window || (parent && !parent.isDestroyed() ? parent : null);
  const diagnostic = window ? {
    visible: window.isVisible(), focused: window.isFocused(),
    document: await window.webContents.executeJavaScript(`({
      ready: document.readyState, focused: document.hasFocus(), url: location.href,
      input: window.fixtureInput, active: document.activeElement?.id
    })`),
  } : { windowsDestroyed: true };
  throw new Error('Timed out: ' + label + ' ' + JSON.stringify({ ...diagnostic, rendererErrors }));
}

async function click(window, selector) {
  const contents = window.webContents;
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
  contents.focus();
  // Let the native focus/compositor update before hit testing the newly shown window.
  await delay(80);
  const point = await contents.executeJavaScript(`(() => {
    if (!window.fixtureInput) {
      window.fixtureInput = [];
      for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'keyup']) document.addEventListener(type, event => {
        window.fixtureInput.push({ type, id: event.target.id, trusted: event.isTrusted, key: event.key });
      }, true);
    }
    const element = document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({ block: 'nearest' });
    const bounds = element.getBoundingClientRect();
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    return { x, y, hit: document.elementFromPoint(x, y) === element };
  })()`);
  assert.equal(point.hit, true, selector + ' must be reachable without being cut off');
  await contents.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').focus()');
  const marker = 'onlydm-calls-input:' + (++inputSequence) + ':';
  let activated = false;
  const observed = event => { if (event.message === marker + 'true') activated = true; };
  contents.on('console-message', observed);
  await contents.executeJavaScript('document.querySelector(' + JSON.stringify(selector)
    + ').addEventListener("click", event => console.log(' + JSON.stringify(marker)
    + ' + event.isTrusted), { capture: true, once: true })');
  // Native Enter activates the focused button with a trusted click.
  try {
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    contents.sendInputEvent({ type: 'char', keyCode: 'Enter' });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor('native input activates ' + selector, () => activated);
  } finally {
    contents.removeListener('console-message', observed);
  }
}

function observe(window) {
  const contents = window.webContents;
  contents.on('console-message', event => {
    if (event.message.startsWith('onlydm-calls-fixture:')) consoleEvents.push(event.message);
    else if (event.level === 'error' && rendererErrors.length < 5) rendererErrors.push(event.message);
  });
  for (const name of ['will-navigate', 'will-frame-navigate']) {
    // Installed after the production host: verify its guard, independently of network blocking.
    contents.on(name, event => navigations.push({
      name, url: event.url, main: event.isMainFrame, prevented: event.defaultPrevented,
    }));
  }
}

async function openCall(url = firstUrl) {
  const previous = host.window;
  assert.equal(host.open({ url }, active), true);
  const window = host.window;
  if (window !== previous) observe(window);
  await waitFor('official synthetic call document', () => !window.isDestroyed()
    && !window.webContents.isLoadingMainFrame() && window.webContents.getURL() === url
    && window.webContents.executeJavaScript('window.fixtureReady === true'));
  return window;
}

function assertNativeWindow(window) {
  assert.ok(window instanceof BrowserWindow);
  assert.equal(window.isVisible(), true);
  assert.equal(window.isClosable(), true);
  assert.equal(window.isFullScreenable(), false);
  assert.equal(window.getParentWindow(), parent);
  assert.ok(window.getNativeWindowHandle().some(byte => byte !== 0), 'a real OS window handle exists');
  const [width, height] = window.getContentSize();
  assert.equal(width, 1010, '1010px is the content width, without a title-bar cutoff');
  assert.ok(Math.abs(height - 760) <= 1, '760px content height allows one DIP of native DPI rounding: ' + height);
  const bounds = window.getBounds();
  const content = window.getContentBounds();
  const minimumContentWidth = window.getMinimumSize()[0] - (bounds.width - content.width);
  assert.ok(Math.abs(minimumContentWidth - 700) <= 1, 'minimum content width includes native frame conversion: '
    + minimumContentWidth);
  if (process.platform === 'linux' && process.env.ONLYDM_FIXTURE_NO_WINDOW_MANAGER === '1') {
    // Bare Xvfb cannot draw OS decorations; opt in explicitly, never silently pass a frameless window.
    limitations.add('bare Xvfb: native frame decoration cannot be verified without a window manager');
  } else {
    assert.ok(bounds.height > content.height, 'native frame must occupy space outside web content: '
      + JSON.stringify({ bounds, content }));
  }
  const preferences = window.webContents.getLastWebPreferences();
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  assert.equal(preferences.preload, undefined);
}

async function exercise() {
  await app.whenReady();
  assert.equal(app.getPath('userData'), root);
  assert.equal(app.getPath('sessionData'), root);
  const first = session.fromPartition('onlydm-calls-smoke-first', { cache: false });
  const second = session.fromPartition('onlydm-calls-smoke-second', { cache: false });
  for (const profile of [first, second]) {
    assert.equal(profile.isPersistent(), false);
    fixtures.add(profile);
  }
  active = first;
  parent = new BrowserWindow({ width: 420, height: 400, title: 'OnlyDM calls fixture parent',
    webPreferences: { session: first, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  parent.removeMenu();
  parent.webContents.on('console-message', event => {
    if (rendererErrors.length < 5) rendererErrors.push(event.message);
  });
  host = createCallHost({ parent, lang: 'en' });
  parent.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await parent.loadURL(parentUrl);
  await parent.webContents.executeJavaScript("localStorage.setItem('onlydm-call-fixture', 'first-profile')");

  let call = await openCall();
  assertNativeWindow(call);
  assert.equal(call.webContents.session, first);
  assert.equal(host.owns(call.webContents), true);
  assert.equal(host.owns(parent.webContents), false);
  assert.equal(await call.webContents.executeJavaScript("localStorage.getItem('onlydm-call-fixture')"), 'first-profile');
  assert.deepEqual(await call.webContents.executeJavaScript(`[
    typeof require, typeof process, typeof Buffer, typeof module, typeof onlydmHost,
    typeof window.chrome?.webview, window.opener === null, innerWidth,
    document.documentElement.scrollWidth <= innerWidth
  ]`), ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', true, 1010, true]);
  assert.ok(Math.abs(await call.webContents.executeJavaScript('innerHeight') - 760) <= 1);

  const original = call;
  for (let index = 0; index < 2; index++) assert.equal(await openCall(), original);
  assert.equal(requests.filter(request => request.session === first && request.url === firstUrl).length, 1);
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'one parent and exactly one call popup');
  call = await openCall(nextUrl);
  assert.equal(call, original, 'a changed call URL reuses the same session popup');
  assert.equal(requests.filter(request => request.url === nextUrl).length, 1);

  await click(call, '#nested');
  await waitFor('nested popup is denied', () => call.webContents.executeJavaScript('window.fixtureNestedDenied === true'));
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  assert.equal(requests.some(request => request.url.includes('fixture=nested')), false);
  for (const [selector, url] of [['#escape', escapeUrl], ['#external', externalUrl]]) {
    await click(call, selector);
    await waitFor('production navigation guard denies ' + selector, () =>
      navigations.some(event => event.url === url && event.main && event.prevented));
    assert.equal(call.webContents.getURL(), nextUrl);
  }
  await click(call, '#frame');
  await waitFor('official call frame loads', () => call.webContents.executeJavaScript(`(() => {
    const frame = document.querySelector('#fixture-frame')?.contentWindow;
    return frame?.location.href === ${JSON.stringify(frameUrl)} && frame.fixtureReady === true;
  })()`));
  assert.deepEqual(await call.webContents.executeJavaScript(`(() => {
    const frame = document.querySelector('#fixture-frame').contentWindow;
    return [typeof frame.require, typeof frame.process, typeof frame.onlydmHost];
  })()`), ['undefined', 'undefined', 'undefined']);
  await click(call, '#frame-escape');
  await waitFor('production frame guard denies another path', () => navigations.some(event =>
    event.name === 'will-frame-navigate' && event.url === frameEscape && !event.main && event.prevented));
  assert.equal(await call.webContents.executeJavaScript(
    "document.querySelector('#fixture-frame').contentWindow.location.href"), frameUrl);

  const cancelledContents = call.webContents;
  await click(call, '#cancel');
  await waitFor('trusted cancellation uses window.close and cleans up the popup', () => call.isDestroyed() && host.window === null);
  assert.ok(consoleEvents.includes('onlydm-calls-fixture:cancel:trusted'));
  assert.equal(cancelledContents.isDestroyed(), true);
  assert.equal(host.owns(cancelledContents), false);
  assert.equal(BrowserWindow.getAllWindows().length, 1);

  const previous = await openCall(nextUrl);
  const previousContents = previous.webContents;
  active = second;
  call = await openCall(nextUrl);
  assert.equal(previous.isDestroyed(), true, 'changing profiles destroys the first authenticated renderer');
  assert.equal(previousContents.isDestroyed(), true);
  assert.equal(host.owns(previousContents), false);
  assert.equal(call.webContents.session, second);
  assert.equal(BrowserWindow.getAllWindows().length, 2);
  assert.equal(await call.webContents.executeJavaScript("localStorage.getItem('onlydm-call-fixture')"), null);
  await call.webContents.executeJavaScript("localStorage.setItem('onlydm-call-fixture', 'second-profile')");
  assert.equal(await parent.webContents.executeJavaScript("localStorage.getItem('onlydm-call-fixture')"), 'first-profile');

  await click(call, '#finish');
  await waitFor('official finished screen retains the native close control', () => call.webContents.getURL()
    === origin + '/call/?fixture=finished');
  assertNativeWindow(call);
  let preventedUnload = false;
  call.webContents.on('will-prevent-unload', event => { preventedUnload = event.defaultPrevented; });
  call.close();
  await waitFor('native close succeeds even if the finished page vetoes unload', () => call.isDestroyed() && host.window === null);
  assert.equal(preventedUnload, true);

  call = await openCall();
  const finalContents = call.webContents;
  parent.close();
  await waitFor('parent closure destroys the call renderer', () => parent.isDestroyed()
    && call.isDestroyed() && finalContents.isDestroyed() && host.window === null);
  assert.equal(host.owns(finalContents), false);
  assert.equal(host.open({ url: firstUrl }, second), false, 'a closed parent cannot resurrect a call');
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  assert.deepEqual(forbidden, [], 'no forbidden destination reached even the local HTTPS fixture');
}

const watchdog = setTimeout(() => finish(new Error('overall calls smoke timeout')), 45000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  host?.close();
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  if (error) console.error('OnlyDM calls smoke failed (' + phase + '):', error.stack || error.message);
  else console.log('OnlyDM calls smoke passed: Electron ' + process.versions.electron + ' on ' + process.platform
    + ', native 1010x~760 popup, duplicate reuse, isolated profile sessions, trusted cancel/window.close,'
    + ' navigation/frame guards, no Node bridge, finished-page native close and parent cleanup; synthetic HTTPS only.'
    + (limitations.size ? ' Limit: ' + [...limitations].join('; ') + '.' : ' Native frame decoration verified.'));
  app.exit(error ? 1 : 0);
}

exercise().then(() => finish(), finish);

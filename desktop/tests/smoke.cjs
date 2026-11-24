'use strict';

require('./fixture-runtime.cjs');

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, screen, session, webContents, WebContentsView } = require('electron');

const origin = 'https://www.instagram.com';
const inboxPath = '/direct/inbox/';
const loginPath = '/accounts/login/';
const threadPath = '/direct/t/123456789/';
const external = 'https://onlydm-smoke.invalid/';
const title = 'Synthetic conversation';
const message = 'OnlyDM smoke message';
const rowSelector = '#OnlyDmShell .onlydm-thread-row';
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const loginPage = `
  <form method="post" action="${loginPath}">
    <button id="fixture-sign-in">Synthetic sign in</button>
  </form>`;

const inboxPage = `
  <main>
    <div id="fixture-row" role="button" tabindex="0" style="height:64px;max-width:300px">
      <img src="${avatar}" width="40" height="40" alt="">
      <span title="${title}">${title}</span><span>Synthetic preview</span><span>1m</span>
    </div>
  </main>
  <script>
    document.querySelector('#fixture-row').addEventListener('click', () => {
      location.assign(${JSON.stringify(threadPath)});
    });
  </script>`;

const chatPage = `
  <main id="fixture-page" style="height:100dvh !important;overflow:hidden">
    <aside id="fixture-sidebar">Synthetic sidebar</aside>
    <section>
      <header><h1>${title}</h1></header>
      <div data-pagelet="IGDMessagesList" style="overflow:auto">
        <div id="fixture-incoming" role="presentation" style="width:116px;margin:4px 6px;background:#999"><span>Synthetic history</span></div>
        <div id="fixture-outgoing" role="presentation" style="width:116px;margin:4px 6px 4px auto;background:#777"><span>Synthetic reply</span></div>
        <p><a id="fixture-external" href="${external}" target="_blank"><span>Open website</span></a></p>
        <p><a id="fixture-redirect" href="https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2F">Open shared link</a></p>
        <button id="fixture-photo" type="button" aria-label="Open photo">
          <img src="${avatar}" width="48" height="48" alt="Synthetic photo thumbnail">
        </button>
        <button id="fixture-reel" type="button" aria-label="Open reel">Synthetic Reel</button>
      </div>
      <form id="fixture-compose">
        <textarea id="fixture-message" aria-label="Message" required></textarea>
        <button id="fixture-send">Send</button>
      </form>
    </section>
  </main>
  <script>
    document.querySelector('#fixture-photo').addEventListener('click', () => {
      // The native page's conversation keeps its full height when the portal mounts.
      document.querySelector('#fixture-page').style.minHeight = '100dvh';
      const portal = document.createElement('div');
      portal.id = 'fixture-photo-portal';
      // The portal stays in body flow after the full-height main; only its dimmer is fixed.
      portal.style.height = '100vh';
      portal.innerHTML = '<div id="fixture-photo-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.7)"></div>'
        + '<div role="dialog" aria-modal="true" aria-label="Photo" style="position:relative;display:flex;height:100%;align-items:center;justify-content:center;pointer-events:none">'
        + '<img src="${avatar}" width="240" height="180" alt="Synthetic full photo" style="pointer-events:auto;max-width:80vw;max-height:70vh"></div>'
        + '<button id="fixture-photo-close" aria-label="Close" style="position:fixed;top:12px;right:12px;z-index:1">Close</button>';
      portal.querySelector('#fixture-photo-close').addEventListener('click', () => portal.remove());
      document.body.append(portal);
    });
    const reel = document.querySelector('#fixture-reel');
    reel.addEventListener('click', () => {
      const portal = document.createElement('div');
      portal.id = 'fixture-reel-portal';
      portal.style.height = '100dvh';
      portal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.7)"></div>'
        + '<div role="dialog" aria-modal="true" aria-label="Reel" style="position:relative;width:540px;margin:0 auto;padding-top:40vh">'
        + '<header data-fixture-reel-chrome>Synthetic creator <button>Follow</button></header>'
        + '<div style="position:relative">'
        + '<video id="fixture-reel-video" width="540" height="960" autoplay muted playsinline></video>'
        + '<div data-fixture-reel-chrome style="position:absolute;inset:0;background:#333">Loading slate</div></div>'
        + '<footer data-fixture-reel-chrome><button>Like</button><button>Comment</button><button>Share</button></footer>'
        + '</div><button id="fixture-reel-close" type="button" aria-label="Close" style="position:fixed;top:12px;right:12px;z-index:1">×</button>';
      document.body.append(portal);
      reel.dataset.closed = 'false';
      const video = reel.fixturePlayer = portal.querySelector('video');
      const canvas = document.createElement('canvas');
      canvas.width = 360;
      canvas.height = 640;
      const context = canvas.getContext('2d');
      const stream = canvas.captureStream(10);
      video.srcObject = stream;
      let frame = 0;
      const paint = setInterval(() => {
        context.fillStyle = frame++ % 2 ? '#485492' : '#6879c4';
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 100);
      portal.querySelector('#fixture-reel-close').addEventListener('click', () => {
        clearInterval(paint);
        stream.getVideoTracks()[0].stop();
        portal.remove();
        reel.dataset.closed = 'true';
      }, { once: true });
    });
    const input = document.querySelector('#fixture-message');
    input.addEventListener('input', (event) => {
      if (event.isTrusted) input.dataset.typed = input.value;
    });
    document.querySelector('#fixture-compose').addEventListener('submit', (event) => {
      event.preventDefault();
      const sent = document.createElement('p');
      sent.id = 'fixture-sent';
      sent.textContent = input.value;
      document.querySelector('[data-pagelet="IGDMessagesList"]').append(sent);
      input.value = '';
    });
  </script>`;

function html(body) {
  return new Response(`<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">${body}`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

const isInstagram = (url) => url.origin === origin || url.origin === 'https://instagram.com';
const pathOf = (path) => path.replace(/\/+$/, '');

function atPath(contents, path) {
  const href = contents.getURL();
  if (!href || contents.isLoadingMainFrame()) return false;
  const url = new URL(href);
  return isInstagram(url) && pathOf(url.pathname) === pathOf(path);
}

let phase = 'starting Electron';

async function waitFor(label, probe) {
  phase = label;
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const result = await probe();
    if (result) return result;
    await delay(50);
  }
  const diagnostics = await Promise.all(webContents.getAllWebContents().map(async contents => {
    try {
      const state = { id: contents.id, type: contents.getType(), url: contents.getURL(),
        loading: contents.isLoadingMainFrame(), zoom: contents.getZoomFactor(), focused: contents.isFocused() };
      state.input = await Promise.race([
        contents.executeJavaScript('window.__onlydmFixtureInput || null'),
        delay(500).then(() => null),
      ]);
      state.projection = await Promise.race([
        contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `JSON.stringify({
          ready: document.readyState, sourceRows: document.querySelectorAll('[role="button"]').length,
          projectedRows: document.querySelectorAll('#OnlyDmShell .onlydm-thread-row').length,
          inbox: typeof window.__onlydmState === 'function' ? window.__onlydmState() : null,
          chat: !!document.querySelector('[data-onlydm-chat]'),
          composer: !!document.querySelector('#fixture-message'),
          rowBounds: document.querySelector('#OnlyDmShell .onlydm-thread-row')?.getBoundingClientRect().toJSON(),
          viewport: [innerWidth, innerHeight, devicePixelRatio, visualViewport?.scale]
        })` }]),
        delay(500).then(() => 'renderer did not answer'),
      ]);
      return state;
    } catch (error) { return { error: error.message }; }
  }));
  const windows = BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focused: window.isFocused(), content: window.getContentSize(),
    views: window.contentView.children.filter(view => view.webContents).map(view => ({
      id: view.webContents.id, visible: view.getVisible(), bounds: view.getBounds(),
    })),
  }));
  console.error('Fixture timeout state:', JSON.stringify({ windows, contents: diagnostics }));
  throw new Error('timed out after 8 seconds');
}

async function assertNoBridge(contents) {
  const leaked = await contents.executeJavaScript(`(() => {
    const names = ['require', 'process', 'module', 'exports', 'Buffer', '__dirname',
      '__filename', 'electron', 'ipcRenderer', 'onlydm', 'onlydmHost', '__onlydmBridge'];
    const present = names.filter((name) => typeof globalThis[name] !== 'undefined');
    if (typeof globalThis.chrome?.webview !== 'undefined') present.push('chrome.webview');
    return present;
  })()`);
  assert.deepEqual(leaked, [], 'Instagram main world exposes Node or a host bridge');
}

async function doubleClickRow(contents) {
  await clickElement(contents, rowSelector, [1, 2]);
}

async function clickElement(contents, selector, clicks = [1], button = 'left') {
  if (process.platform === 'darwin') {
    const owner = BrowserWindow.getAllWindows().find(window => window.webContents === contents
      || window.contentView.children.some(view => view.webContents === contents));
    assert.ok(owner, 'fixture input must target an attached view');
    if (!owner.isFocused()) app.focus({ steal: true });
    owner.focus();
    contents.focus();
    await waitFor('native focus before mouse input to ' + selector, () =>
      owner.isFocused() && contents.isFocused() && contents.executeJavaScript('document.hasFocus()'));
  }
  if (selector === rowSelector) {
    await contents.executeJavaScript(`(() => {
      window.__onlydmFixtureInput = [];
      if (window.__onlydmFixtureInputInstalled) return;
      window.__onlydmFixtureInputInstalled = true;
      for (const type of ['mousedown', 'mouseup', 'click', 'dblclick']) {
        document.addEventListener(type, event => {
          window.__onlydmFixtureInput.push({ type, x: event.clientX, y: event.clientY,
            trusted: event.isTrusted, row: !!event.target.closest?.(${JSON.stringify(rowSelector)}) });
        }, { capture: true });
      }
    })()`);
  }
  const hit = await contents.executeJavaScript(`(() => {
    const selector = ${JSON.stringify(selector)};
    const element = document.querySelector(selector);
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const bounds = element.getBoundingClientRect();
    const x = bounds.left + bounds.width / 2;
    const y = bounds.top + bounds.height / 2;
    const target = document.elementFromPoint(x, y);
    return { x, y, matched: !!target?.closest(selector),
      debug: [bounds.toJSON(), innerWidth, innerHeight, target?.tagName, target?.id, getComputedStyle(element).visibility] };
  })()`);
  assert.ok(hit.matched, `the element must be clickable: ${selector} ${JSON.stringify(hit.debug)}`);
  // Electron mouse input uses view DIPs; DOM rectangles use zoomed CSS pixels.
  const zoom = contents.getZoomFactor();
  const x = Math.round(hit.x * zoom);
  const y = Math.round(hit.y * zoom);
  contents.focus();
  contents.sendInputEvent({ type: 'mouseMove', x, y });
  for (const clickCount of clicks) {
    for (const type of ['mouseDown', 'mouseUp']) {
      contents.sendInputEvent({ x, y, type, button, clickCount });
    }
    await delay(16);
  }
}

async function assertComposerVisible(contents, label) {
  phase = label;
  const visible = await contents.executeJavaScript(`(() => {
    const input = document.querySelector('#fixture-message');
    const clipped = [];
    for (const element of [input, document.querySelector('#fixture-compose')]) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.left < -1 || rect.top < -1
          || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1) {
        clipped.push(element.id + ': viewport');
      }
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const bounds = ancestor.getBoundingClientRect();
        const left = bounds.left + ancestor.clientLeft;
        const top = bounds.top + ancestor.clientTop;
        if ((/^(hidden|clip|auto|scroll)$/.test(style.overflowX)
              && (rect.left < left - 1 || rect.right > left + ancestor.clientWidth + 1))
            || (/^(hidden|clip|auto|scroll)$/.test(style.overflowY)
              && (rect.top < top - 1 || rect.bottom > top + ancestor.clientHeight + 1))) {
          clipped.push(element.id + ': ' + (ancestor.id || ancestor.tagName));
        }
      }
    }
    const bounds = input.getBoundingClientRect();
    const point = { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    return { clipped, point, hit: document.elementFromPoint(point.x, point.y) === input };
  })()`);
  assert.deepEqual(visible.clipped, [], `${label}: input and composer must be completely visible`);
  assert.ok(visible.hit, `${label}: input must receive the pointer hit`);
  contents.focus();
  const input = contents.debugger;
  input.attach();
  try {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await input.sendCommand('Input.dispatchMouseEvent', {
        ...visible.point, type, button: 'left', clickCount: 1,
      });
    }
  } finally {
    if (input.isAttached()) input.detach();
  }
  assert.ok(await contents.executeJavaScript(
    "document.activeElement === document.querySelector('#fixture-message')"),
  `${label}: clicking the input must focus it`);
}

async function pressEscape(contents) {
  contents.focus();
  const input = contents.debugger;
  input.attach();
  try {
    for (const type of ['keyDown', 'keyUp']) {
      await input.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
      });
    }
  } finally {
    if (input.isAttached()) input.detach();
  }
}

async function assertReelVisible(contents, size) {
  await waitFor(`offline Reel loads a 9:16 frame at ${size}`, () => contents.executeJavaScript(`(() => {
    const video = document.querySelector('#fixture-reel').fixturePlayer;
    return video?.videoWidth === 360 && video.videoHeight === 640;
  })()`));
  let state;
  try {
    await waitFor(`Reel video is centered and fully visible at ${size}`, async () => {
      state = await contents.executeJavaScript(`(() => {
        const video = document.querySelector('#fixture-reel-video');
        if (!video) return null;
        const { left, top, right, bottom, width, height } = video.getBoundingClientRect();
        const x = left + width / 2;
        const y = top + height / 2;
        const visibility = { opacityProperty: true, visibilityProperty: true };
        return {
          bounds: [left, top, width, height].map(Math.round),
          original: video === document.querySelector('#fixture-reel').fixturePlayer && video.srcObject?.active,
          controls: video.controls,
          centered: Math.abs(x - innerWidth / 2) <= 4 && Math.abs(y - innerHeight / 2) <= 32,
          fits: width >= 100 && height >= 175 && left >= -1 && top >= -1
            && right <= innerWidth + 1 && bottom <= innerHeight + 1
            && (Math.abs(width - height * 9 / 16) <= 2 || /^(contain|scale-down)$/.test(getComputedStyle(video).objectFit)),
          hittable: video.checkVisibility(visibility)
            && [[x, y], [x, top + 4], [x, bottom - 4], [left + 4, y], [right - 4, y]]
              .every(([px, py]) => document.elementFromPoint(px, py) === video),
          visibleChrome: [...document.querySelectorAll('[data-fixture-reel-chrome]')]
            .filter(element => element.checkVisibility(visibility)).length,
        };
      })()`);
      return state?.original && state.controls && state.centered && state.fits && state.hittable && !state.visibleChrome;
    });
  } catch (error) {
    console.error('Reel fixture geometry:', JSON.stringify(state));
    throw error;
  }
}

async function smoke() {
  const profile = mkdtempSync(join(tmpdir(), 'onlydm-smoke-'));
  app.once('quit', () => {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold files. */ }
  });
  app.setPath('userData', profile);
  writeFileSync(join(profile, 'settings.json'), JSON.stringify({
    chatTheme: 'custom', chatColors: { background: '#182139', incoming: '#0E5144', outgoing: '#FFE79C' },
  }));
  app.commandLine.appendSwitch('disable-background-networking');

  let fixtureSession;
  app.on('session-created', (created) => {
    created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, respond) => {
      respond({ cancel: created !== fixtureSession || !url.startsWith('https://') });
    });
  });

  const { createOnlyDM, PARTITION } = require('../src/app.cjs');
  assert.equal(PARTITION, 'persist:onlydm-instagram');
  await app.whenReady();
  fixtureSession = session.fromPartition(PARTITION);

  let signedIn = false;
  let guestRedirects = 0;
  let threadLoads = 0;
  let forbiddenRequests = 0;
  fixtureSession.protocol.handle('https', (request) => {
    const url = new URL(request.url);
    if (url.href === external || (isInstagram(url) && url.pathname === '/')) {
      forbiddenRequests++;
      return html('<p>Forbidden destination reached</p>');
    }
    if (isInstagram(url)) {
      switch (pathOf(url.pathname)) {
        case pathOf(inboxPath):
          if (signedIn) return html(inboxPage);
          guestRedirects++;
          return Response.redirect(new URL(loginPath, url), 302);
        case pathOf(loginPath):
          if (request.method !== 'POST') return html(loginPage);
          signedIn = true;
          return Response.redirect(new URL(inboxPath, url), 303);
        case pathOf(threadPath):
          if (signedIn) {
            threadLoads++;
            return html(chatPage);
          }
      }
    }
    return new Response('No offline fixture for this request', { status: 404 });
  });

  async function assertBlocked(contents, pane) {
    for (const [name, target] of [['Instagram feed', origin + '/'], ['external site', external]]) {
      phase = `${pane} blocks ${name}`;
      const initialUrl = contents.getURL();
      // loadURL() would bypass the renderer navigation policy.
      await contents.executeJavaScript(`location.assign(${JSON.stringify(target)})`);
      await delay(250);
      assert.equal(forbiddenRequests, 0, 'navigation reached a forbidden fixture');
      assert.equal(contents.getURL(), initialUrl, 'navigation changed the pane URL');
    }
  }

  phase = 'creating the production host';
  const opened = [];
  const { window, inbox } = await createOnlyDM({ separateChatWindows: false, openExternal: href => { opened.push(href); } });
  const contents = inbox.webContents;
  assert.equal(contents.session, fixtureSession, 'inbox must use the fixture partition');
  const root = window.contentView;
  let peakChats = 0;
  function chats() {
    const views = root.children.filter((view) => view instanceof WebContentsView && view !== inbox);
    peakChats = Math.max(peakChats, views.length);
    return views;
  }
  // Record synchronous adds too, so a chat added before removing its predecessor cannot slip past polling.
  const addChildView = root.addChildView;
  root.addChildView = function (...args) {
    const result = addChildView.apply(this, args);
    chats();
    return result;
  };
  assert.ok(root.children.includes(inbox), 'inbox view is attached');
  assert.equal(chats().length, 0, 'starts without a chat view');

  await waitFor('guest inbox redirects to sign in', () => atPath(contents, loginPath) && inbox.getVisible()
    && contents.executeJavaScript("Boolean(document.querySelector('#fixture-sign-in'))"));
  assert.ok(guestRedirects > 0, 'the host requested inbox before sign in');
  await assertNoBridge(contents);
  phase = 'submitting synthetic sign in';
  await contents.executeJavaScript("document.querySelector('#fixture-sign-in').click()");

  const projected = `document.querySelector(${JSON.stringify(rowSelector)})
    ?.querySelector('.onlydm-thread-title')?.textContent === ${JSON.stringify(title)}`;
  const inboxReady = () => atPath(contents, inboxPath) && inbox.getVisible()
    && contents.executeJavaScript(projected);
  await waitFor('signed-in inbox projects the no-href row', inboxReady);
  assert.ok(await contents.executeJavaScript(
    "Array.from(document.querySelectorAll('#OnlyDmShell .onlydm-chip')).filter(el => getComputedStyle(el).cursor === 'pointer').length === 2"),
  'the All and Unread chips use the hand cursor');
  phase = 'changing inbox filters with the keyboard';
  const allChip = '.onlydm-chip[data-mode="all"]';
  const unreadChip = '.onlydm-chip[data-mode="unread"]';
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
  contents.focus();
  await contents.executeJavaScript(`document.querySelector('${allChip}').focus()`);
  const focused = selector => contents.executeJavaScript(`document.activeElement?.matches('${selector}')`);
  assert.equal(await focused(allChip), true, 'the All filter accepts keyboard focus');
  const press = (keyCode, modifiers = []) => {
    const eventTypes = keyCode === 'Enter' ? ['keyDown', 'char', 'keyUp'] : ['keyDown', 'keyUp'];
    for (const type of eventTypes) contents.sendInputEvent({ type, keyCode, modifiers });
  };
  press('Tab');
  await waitFor('Tab moves focus to the Unread filter', () => focused(unreadChip));
  press('Enter');
  await waitFor('Enter activates Unread and filters out the read room', () => contents.executeJavaScript(
    `document.querySelector('${unreadChip}').getAttribute('aria-pressed') === 'true'
      && !document.querySelector('${rowSelector}')`));
  assert.equal(chats().length, 0, 'activating a filter does not open a conversation');
  press('Tab', ['shift']);
  await waitFor('Shift+Tab returns focus to the All filter', () => focused(allChip));
  press('Space');
  await waitFor('Space activates All and restores the read room', () => contents.executeJavaScript(
    `document.querySelector('${allChip}').getAttribute('aria-pressed') === 'true'
      && !!document.querySelector('${rowSelector}')`));
  await assertNoBridge(contents);
  await assertBlocked(contents, 'inbox');
  await waitFor('authenticated inbox retains desktop projection zoom', () =>
    contents.getZoomFactor() === 0.25 && contents.executeJavaScript('innerWidth >= 1000'));

  async function openChat(label, activate = () => doubleClickRow(contents)) {
    phase = label;
    await activate();
    const chat = await waitFor(label, async () => {
      const [view] = chats();
      if (!view?.getVisible() || !atPath(view.webContents, threadPath)) return false;
      const isolated = await view.webContents.executeJavaScript(`(() => {
        const chat = document.querySelector('[data-onlydm-chat="1"]');
        return chat?.contains(document.querySelector('[data-pagelet="IGDMessagesList"]'))
          && chat.contains(document.querySelector('#fixture-message'))
          && document.querySelector('#fixture-sidebar').getClientRects().length === 0;
      })()`);
      return isolated && view.webContents;
    });
    assert.ok(root.children.includes(inbox), 'inbox stays attached while chatting');
    assert.equal(peakChats, 1, 'at most one chat view may be attached');
    assert.equal(chat.session, fixtureSession, 'chat must use the fixture partition');
    assert.ok(threadLoads > 0, 'full thread navigation loaded the offline fixture');
    await assertNoBridge(chat);
    return chat;
  }

  const chat = await openChat('arrow and Enter open an isolated chat', async () => {
    press('Down');
    await waitFor('Down selects a conversation from the filter', () => contents.executeJavaScript(
      `document.querySelector('${rowSelector}')?.dataset.selected === 'true'
        && document.activeElement?.matches('.onlydm-thread-list')`));
    press('Enter');
  });
  const renderedPalette = await chat.executeJavaScript(`(() => [
    getComputedStyle(document.body).backgroundColor,
    ...['incoming', 'outgoing'].flatMap(side => {
      const bubble = document.getElementById('fixture-' + side);
      return [getComputedStyle(bubble).backgroundColor, getComputedStyle(bubble.firstElementChild).color];
    }),
  ])()`);
  if (renderedPalette[1] !== 'rgb(14, 81, 68)') {
    console.log('Fixture bubble geometry:', await chat.executeJavaScript(`JSON.stringify(Array.from(
      document.querySelectorAll('[data-onlydm-chat], [data-pagelet="IGDMessagesList"], #fixture-incoming, #fixture-outgoing')
    ).map(el => [el.id || el.className, el.getBoundingClientRect().toJSON(), getComputedStyle(el).display]))`));
  }
  assert.deepEqual(renderedPalette, ['rgb(24, 33, 57)', 'rgb(14, 81, 68)', 'rgb(255, 255, 255)', 'rgb(255, 231, 156)', 'rgb(0, 0, 0)'],
  'the first visible chat frame uses the saved custom colors and readable text');
  await assertBlocked(chat, 'chat');
  phase = 'synthetic link activation remains blocked';
  await chat.executeJavaScript("document.querySelector('#fixture-external').click()");
  await delay(250);
  assert.deepEqual(opened, []);
  phase = 'trusted link activation';
  await clickElement(chat, '#fixture-external span');
  await waitFor('message link opens in default browser', () => opened.length === 1);
  assert.deepEqual(opened, [external]);
  await clickElement(chat, '#fixture-redirect', [1], 'middle');
  await waitFor('Instagram link wrapper opens in default browser', () => opened.length === 2);
  assert.equal(opened[1], 'https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2F');
  assert.ok(atPath(chat, threadPath), 'the conversation remains open after handing off links');
  await assertComposerVisible(chat, 'composer is visible before resizing');
  for (const [width, height] of [[350, 420], [600, 700]]) {
    window.setContentSize(width, height);
    await waitFor(`chat viewport resizes to ${width}x${height}`, () => {
      const bounds = chats()[0].getBounds();
      // macOS may constrain the window to its display's available work area.
      const [contentWidth, contentHeight] = window.getContentSize();
      return contentWidth === width && bounds.width === contentWidth && bounds.y + bounds.height === contentHeight
        && chat.executeJavaScript(`innerWidth === ${bounds.width} && innerHeight === ${bounds.height}`);
    });
    const [contentWidth, contentHeight] = window.getContentSize();
    console.log('Fixture resize:', JSON.stringify({ requested: [width, height],
      content: [contentWidth, contentHeight], workArea: screen.getDisplayMatching(window.getBounds()).workArea }));
    await assertComposerVisible(chat, `composer is visible at ${contentWidth}x${contentHeight}`);

    const draft = 'Unsent Reel draft';
    const closeWith = width === 350 ? 'X' : 'Escape';
    await chat.insertText(draft);
    assert.equal(await chat.executeJavaScript("document.querySelector('#fixture-message').value"), draft);
    await chat.executeJavaScript("document.querySelector('#fixture-reel').click()");
    await assertReelVisible(chat, `${width}x${height}`);
    phase = `closing the Reel with ${closeWith}`;
    if (closeWith === 'Escape') {
      await pressEscape(chat);
    } else {
      assert.ok(await chat.executeJavaScript(`(() => {
        const close = document.querySelector('#fixture-reel-close');
        const { left, top, width, height } = close.getBoundingClientRect();
        if (!close.contains(document.elementFromPoint(left + width / 2, top + height / 2))) return false;
        close.click();
        return true;
      })()`), 'the original Reel close button must receive the pointer hit');
    }
    await waitFor(`Reel closes through the original button with ${closeWith}`, () => chat.isDestroyed()
      || chat.executeJavaScript("!document.querySelector('#fixture-reel-portal') && document.querySelector('#fixture-reel').dataset.closed === 'true'"));
    assert.equal(chat.isDestroyed(), false, `${closeWith} must close only the Reel`);
    assert.ok(chats()[0]?.getVisible() && atPath(chat, threadPath), `${closeWith} must stay in the chat`);
    await assertComposerVisible(chat, `composer remains usable after closing the Reel with ${closeWith}`);
    assert.equal(await chat.executeJavaScript("document.querySelector('#fixture-message').value"), draft);
    await chat.executeJavaScript("document.querySelector('#fixture-message').value = ''");
  }
  for (const closeWith of ['button', 'Escape']) {
    phase = `opening the photo before closing with ${closeWith}`;
    await chat.executeJavaScript("document.querySelector('#fixture-photo').click()");
    await waitFor(`photo is visible and hittable before closing with ${closeWith}`, () => chat.executeJavaScript(`(() => {
      const dialog = document.querySelector('#fixture-photo-portal [role="dialog"][aria-modal="true"]');
      const image = dialog?.querySelector('img');
      if (!image?.complete || !image.naturalWidth) return false;
      const rect = image.getBoundingClientRect();
      return dialog.getBoundingClientRect().top === 0 && rect.width >= 100 && rect.height >= 100
        && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
        && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === image;
    })()`));
    phase = `closing the photo with ${closeWith}`;
    if (closeWith === 'button') {
      assert.ok(await chat.executeJavaScript(`(() => {
        const close = document.querySelector('#fixture-photo-close');
        const rect = close.getBoundingClientRect();
        if (document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) !== close) return false;
        close.click();
        return true;
      })()`), 'the photo close button must receive the pointer hit');
    } else {
      await pressEscape(chat);
    }
    await waitFor(`photo closes with ${closeWith}`, () => chat.isDestroyed()
      || chat.executeJavaScript("!document.querySelector('#fixture-photo-portal')"));
    assert.equal(chat.isDestroyed(), false, `${closeWith} must close only the photo`);
    assert.equal(chats().length, 1, `${closeWith} must keep the chat attached`);
    assert.ok(chats()[0].getVisible() && atPath(chat, threadPath), `${closeWith} must stay in the chat`);
  }
  await assertComposerVisible(chat, 'composer remains usable after closing the photo');
  phase = 'typing into the chat composer';
  chat.focus();
  await chat.executeJavaScript("document.querySelector('#fixture-message').focus()");
  await chat.insertText(message);
  await waitFor('composer receives trusted text input', () => chat.executeJavaScript(`(() => {
    const input = document.querySelector('#fixture-message');
    return input.value === ${JSON.stringify(message)} && input.dataset.typed === input.value;
  })()`));

  phase = 'submitting the fixture message';
  await chat.executeJavaScript("document.querySelector('#fixture-send').click()");
  await waitFor('fixture receives the submitted message', () => chat.executeJavaScript(`
    document.querySelector('#fixture-sent')?.textContent === ${JSON.stringify(message)}
      && document.querySelector('#fixture-message').value === ''
  `));

  const shell = window.webContents;
  await waitFor('local Back button is visible', () =>
    shell.executeJavaScript("document.querySelector('#back')?.hidden === false"));
  await chat.executeJavaScript("document.querySelector('#fixture-message').value = 'local retained draft'");
  await shell.executeJavaScript("document.querySelector('#back').click()");
  await waitFor('Back restores the projected inbox and hides the bounded cached chat', () => !chat.isDestroyed() && chats().length === 1
    && !chats()[0].getVisible()
    && inboxReady());
  await openChat('reopening the chat from the inbox');
  assert.equal(await chat.executeJavaScript("document.querySelector('#fixture-message').value"), 'local retained draft');
  assert.equal(forbiddenRequests, 0, 'no forbidden navigation reached a fixture');
}

let finished = false;
const watchdog = setTimeout(() => finish(1, new Error('overall timeout after 45 seconds')), 45_000);

function finish(code, error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (code) {
    const detail = String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300);
    console.error(`OnlyDM smoke failed (${phase}): ${detail}`);
  } else {
    console.log('OnlyDM smoke passed: sign-in, inbox, chat, photo and Reel dialogs, send, browser link handoff, Back/reopen, and navigation/isolation checks.');
  }
  app.exit(code);
}

smoke().then(() => finish(0), (error) => finish(1, error));

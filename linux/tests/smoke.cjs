'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, session, WebContentsView } = require('electron');

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
        <p>Synthetic history</p>
        <p><a id="fixture-external" href="${external}" target="_blank"><span>Open website</span></a></p>
        <p><a id="fixture-redirect" href="https://l.instagram.com/?u=https%3A%2F%2Fexample.com%2F">Open shared link</a></p>
        <button id="fixture-photo" type="button" aria-label="Open photo">
          <img src="${avatar}" width="48" height="48" alt="Synthetic photo thumbnail">
        </button>
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
  const { x, y } = hit;
  // Chromium dispatches the clicks in view coordinates without needing a window manager.
  const input = contents.debugger;
  input.attach();
  try {
    for (const clickCount of clicks) {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await input.sendCommand('Input.dispatchMouseEvent', { x, y, type, button, clickCount });
      }
    }
  } finally {
    if (input.isAttached()) input.detach();
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

async function smoke() {
  const profile = mkdtempSync(join(tmpdir(), 'onlydm-smoke-'));
  app.once('quit', () => {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold files. */ }
  });
  app.setPath('userData', profile);
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
  const { window, inbox } = await createOnlyDM({ openExternal: href => { opened.push(href); } });
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
  await assertNoBridge(contents);
  await assertBlocked(contents, 'inbox');

  async function openChat(label) {
    phase = label;
    await doubleClickRow(contents);
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

  const chat = await openChat('double click opens an isolated chat');
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
      return bounds.width === width && bounds.y + bounds.height === height
        && chat.executeJavaScript(`innerWidth === ${bounds.width} && innerHeight === ${bounds.height}`);
    });
    await assertComposerVisible(chat, `composer is visible at ${width}x${height}`);
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
      chat.focus();
      chat.debugger.attach();
      try {
        for (const type of ['keyDown', 'keyUp']) {
          await chat.debugger.sendCommand('Input.dispatchKeyEvent', {
            type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
          });
        }
      } finally {
        if (chat.debugger.isAttached()) chat.debugger.detach();
      }
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
  await shell.executeJavaScript("document.querySelector('#back').click()");
  await waitFor('Back restores the projected inbox', () => chat.isDestroyed() && chats().length === 0
    && inboxReady());
  await openChat('reopening the chat from the inbox');
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
    console.log('OnlyDM smoke passed: sign-in, inbox, chat, photo dialog, send, browser link handoff, Back/reopen, and navigation/isolation checks.');
  }
  app.exit(code);
}

smoke().then(() => finish(0), (error) => finish(1, error));

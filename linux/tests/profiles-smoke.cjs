'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, session } = require('electron');
const { createOnlyDM, PARTITION } = require('../src/app.cjs');

const profile = mkdtempSync(join(tmpdir(), 'onlydm-switch-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');

const origin = 'https://www.instagram.com';
const inboxPath = '/direct/inbox/';
const loginPath = '/accounts/login/';
const threadPath = '/direct/t/101/';
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const states = new Map();
const body = text => new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">' + text, {
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});

app.on('session-created', created => {
  const partitionName = basename(created.storagePath || '').toLowerCase();
  const isFixture = /^onlydm-instagram(?:-[a-z0-9-]+)?$/.test(partitionName);
  created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, respond) => {
    respond({ cancel: !isFixture || new URL(url).origin !== origin });
  });
  if (!isFixture) return;

  const primary = partitionName === 'onlydm-instagram';
  const state = { signedIn: false, label: primary ? 'fixture_main' : 'fixture_alternate' };
  states.set(created, state);
  created.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.pathname === loginPath) {
      if (request.method === 'POST') {
        state.signedIn = true;
        return Response.redirect(origin + inboxPath, 303);
      }
      return body('<form action="/accounts/login/" method="post"><button id="fixture-sign-in">Sign in</button></form>');
    }
    if (url.pathname === inboxPath) {
      if (!state.signedIn) return Response.redirect(origin + loginPath, 302);
      return body('<nav><a href="/' + state.label + '/">Profile</a></nav>'
        + '<div role="button" tabindex="0" style="width:280px;height:64px">'
        + '<img width="40" height="40" src="' + avatar + '"><a href="' + threadPath + '"><span title="'
        + state.label + '">' + state.label + '</span></a><span>fixture preview</span></div>');
    }
    if (url.pathname === threadPath && state.signedIn) {
      return body('<section><div data-pagelet="IGDMessagesList"><p>fixture history</p></div>'
        + '<form><textarea aria-label="Message"></textarea></form></section>');
    }
    return new Response('', { status: 404 });
  });
});

async function waitFor(label, test) {
  const deadline = Date.now() + 7500;
  while (Date.now() < deadline) {
    if (await test()) return;
    await delay(100);
  }
  throw new Error('Timed out: ' + label);
}

const visibleAt = (controller, path) => {
  const view = controller.inbox;
  return view.getVisible() && new URL(view.webContents.getURL() || origin).pathname === path;
};
const projected = (controller, expected) => visibleAt(controller, inboxPath)
  && controller.inbox.webContents.executeJavaScript(
    "document.querySelector('#OnlyDmShell .onlydm-thread-title')?.textContent === " + JSON.stringify(expected));

function select(controller, id) {
  return controller.window.webContents.executeJavaScript(
    "(() => { const select = document.querySelector('#profiles'); select.value = " + JSON.stringify(id)
      + "; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
}

function selectedId(controller) {
  return controller.window.webContents.executeJavaScript("document.querySelector('#profiles').value");
}

async function exercise() {
  await app.whenReady();
  const controller = await createOnlyDM();
  const original = controller.inbox.webContents;
  assert.equal(original.session, session.fromPartition(PARTITION));
  assert.ok(states.has(original.session), 'the default account has a synthetic browser session');
  await waitFor('default account login', () => visibleAt(controller, loginPath));
  const originalId = await selectedId(controller);
  assert.ok(originalId);
  await original.executeJavaScript("document.querySelector('#fixture-sign-in').click()");
  await waitFor('default account conversations', () => projected(controller, 'fixture_main'));

  await controller.window.webContents.executeJavaScript("document.querySelector('#search').value = 'previous account text'");
  await original.executeJavaScript("document.querySelector('#OnlyDmShell .onlydm-thread-row').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  let oldChat;
  await waitFor('default account chat opens', () => {
    oldChat = controller.window.contentView.children.find(view =>
      view !== controller.inbox && view.webContents && view.getVisible());
    return Boolean(oldChat);
  });
  assert.equal(oldChat.webContents.session, original.session);
  const oldChatContents = oldChat.webContents;
  await select(controller, '__add__');
  await waitFor('second account starts with its own login', () => controller.inbox.webContents !== original && visibleAt(controller, loginPath));
  await waitFor('old inbox and chat views close', () => original.isDestroyed() && oldChatContents.isDestroyed());
  const alternative = controller.inbox.webContents;
  const alternativeSession = alternative.session;
  assert.notEqual(alternativeSession, session.fromPartition(PARTITION));
  assert.equal(states.get(alternativeSession)?.signedIn, false);
  assert.equal(await controller.window.webContents.executeJavaScript("document.querySelector('#search').value"), '');
  const alternativeId = await selectedId(controller);
  assert.notEqual(alternativeId, originalId);
  assert.notEqual(alternativeId, '__add__');
  await alternative.executeJavaScript("document.querySelector('#fixture-sign-in').click()");
  await waitFor('alternate account conversations', () => projected(controller, 'fixture_alternate'));

  await select(controller, originalId);
  await waitFor('original account returns without sign-in', () => projected(controller, 'fixture_main'));
  await waitFor('alternate browser view closes', () => alternative.isDestroyed());
  assert.equal(controller.inbox.webContents.session, session.fromPartition(PARTITION));

  await select(controller, alternativeId);
  await waitFor('alternate account returns without sign-in', () => projected(controller, 'fixture_alternate'));
  assert.equal(controller.inbox.webContents.session, alternativeSession);

  controller.window.close();
  const reopened = await createOnlyDM();
  await waitFor('last selected account is restored', () => projected(reopened, 'fixture_alternate'));
  assert.equal(await selectedId(reopened), alternativeId);
  reopened.window.close();
}

const timeout = setTimeout(() => finish(new Error('overall profile smoke timeout')), 45000);
function finish(error) {
  clearTimeout(timeout);
  if (error) console.error('OnlyDM profile smoke failed:', error.message);
  else console.log('OnlyDM profile smoke passed: separate sign-ins, A/B switching, and last account restored.');
  app.once('quit', () => {
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* Browser shutdown can still hold files. */ }
  });
  app.exit(error ? 1 : 0);
}
exercise().then(() => finish(), finish);

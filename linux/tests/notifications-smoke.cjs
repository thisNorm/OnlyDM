'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, basename } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, webContents } = require('electron');
const { createOnlyDM } = require('../src/app.cjs');

const secondId = '1234567890abcdef1234567890abcdef';
const root = mkdtempSync(join(tmpdir(), 'onlydm-all-account-alerts-'));
app.setPath('userData', root);
app.commandLine.appendSwitch('disable-background-networking');
// Keep the runner alive until renderer cleanup assertions complete.
app.on('window-all-closed', () => {});
writeFileSync(join(root, 'profiles.json'), JSON.stringify({
  activeProfileId: 'default',
  profiles: [{ id: 'default', handle: 'fixture_main' }, { id: secondId, handle: 'fixture_alternate' }],
}));
const origin = 'https://www.instagram.com';
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const bySession = new Map();
const notices = [];
const delayBudget = 12000;

app.on('session-created', created => {
  const base = basename(created.storagePath || '');
  const fixture = /^onlydm-instagram(?:-[a-f0-9]+)?$/.test(base);
  created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, respond) =>
    respond({ cancel: !fixture || new URL(url).origin !== origin }));
  if (!fixture) return;
  const isMain = base === 'onlydm-instagram';
  bySession.set(created, isMain ? 'default' : secondId);
  created.protocol.handle('https', request => {
    if (new URL(request.url).pathname !== '/direct/inbox/') return new Response('', { status: 404 });
    const handle = isMain ? 'fixture_main' : 'fixture_alternate';
    return new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">'
      + '<nav><a href="/' + handle + '/">Profile</a></nav>'
      + '<main style="height:300px;width:320px;overflow:auto"><div role="button" tabindex="0" style="height:76px;width:310px">'
      + '<img width="40" height="40" src="' + avatar + '"><span title="Synthetic friend" style="font-weight:600">Synthetic friend</span>'
      + '<p id="preview">historical unread</p><small id="time">1h</small></div></main>', {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  });
});

async function waitFor(name, predicate, timeout = delayBudget) {
  const end = Date.now() + timeout;
  do {
    if (await predicate()) return;
    await delay(100);
  } while (Date.now() < end);
  throw new Error('Timed out: ' + name);
}
const remoteFor = id => webContents.getAllWebContents().find(wc => !wc.isDestroyed()
  && bySession.get(wc.session) === id && wc.getURL() === origin + '/direct/inbox/');
const update = (wc, text) => wc.executeJavaScript("document.querySelector('#preview').textContent = " + JSON.stringify(text));

async function exercise() {
  await app.whenReady();
  const controller = await createOnlyDM({
    notify: notification => { notices.push(notification); },
  });
  const { window } = controller;
  await waitFor('active inbox', () => controller.inbox.getVisible());
  await waitFor('inactive monitor starts', () => remoteFor(secondId));
  const secondary = remoteFor(secondId);
  assert.notEqual(secondary, controller.inbox.webContents);
  assert.equal(bySession.get(controller.inbox.webContents.session), 'default');
  await delay(4800);
  assert.equal(notices.length, 0, 'existing unread history is silent');
  assert.equal(await secondary.executeJavaScript("!document.querySelector('#OnlyDmShell') && document.querySelector('main').scrollTop === 0"), true);

  assert.ok(await secondary.executeJavaScript('window.innerWidth >= 1000'), 'inactive inbox uses the desktop layout');

  await update(secondary, 'incoming message for the alternate account');
  await waitFor('alert arrives while another account is active', () => notices.length === 1);
  assert.equal(bySession.get(controller.inbox.webContents.session), 'default', 'an alert does not switch accounts by itself');
  const notice = notices[0];
  assert.equal(notice.profileId, secondId);
  assert.match(notice.title, /fixture_alternate/);
  assert.ok(!String(notice.body).includes('incoming message for the alternate account'), 'the Linux notification defaults to private content');

  await secondary.executeJavaScript("document.querySelector('#time').textContent = '2m'");
  await delay(1200);
  await update(secondary, 'incoming message for the alternate account');
  await delay(1200);
  assert.equal(notices.length, 1, 'unchanged unread messages and time updates stay deduplicated');

  await window.webContents.executeJavaScript("document.querySelector('#search').value = 'old search'");
  notice.onClick();
  await waitFor('notification click switches to the correct account', () =>
    bySession.get(controller.inbox.webContents.session) === secondId && controller.inbox.getVisible());
  await waitFor('old alternate watcher is closed', () => secondary.isDestroyed());
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#search').value"), '');
  assert.ok(window.isVisible());
  await waitFor('previously active account becomes monitored', () => remoteFor('default'));
  const previous = remoteFor('default');
  await delay(4800);
  const before = notices.length;
  await update(previous, 'message for the other account after switching');
  await waitFor('other account still alerts after switching', () => notices.length === before + 1);
  assert.equal(notices.at(-1).profileId, 'default');

  // A crash or connectivity failure must not leave inactive notifications off.
  previous.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  await waitFor('failed monitor closes', () => previous.isDestroyed());
  await waitFor('failed monitor reconnects automatically', () => {
    const remote = remoteFor('default');
    return remote && remote !== previous;
  }, 18000);
  const recovered = remoteFor('default');
  await delay(4800);
  const recoveredBefore = notices.length;
  await update(recovered, 'incoming after background reconnect');
  await waitFor('notifications resume after reconnect', () => notices.length === recoveredBefore + 1);
  assert.equal(notices.at(-1).profileId, 'default');
  window.close();
  await waitFor('all monitored account renderers close', () => !remoteFor('default') && !remoteFor(secondId));
}
let finished = false;
const timer = setTimeout(() => finish(new Error('overall notification smoke timeout')), 50000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error) console.error('OnlyDM all-account notification smoke failed:', error.message);
  else console.log('OnlyDM all-account notification smoke passed: background alerts, no repeated unread alerts, correct account on click, automatic reconnect, cleanup.');
  app.once('quit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  app.exit(error ? 1 : 0);
}
exercise().then(() => finish(), finish);

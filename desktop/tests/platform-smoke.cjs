'use strict';

require('./fixture-runtime.cjs');

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, ipcMain, Menu, webContents } = require('electron');

const root = mkdtempSync(join(tmpdir(), 'onlydm-platform-smoke-'));
app.setPath('userData', root);
app.commandLine.appendSwitch('disable-background-networking');
writeFileSync(join(root, 'profiles.json'), JSON.stringify({
  activeProfileId: 'default',
  profiles: [{ id: 'default' }, { id: '1234567890abcdef1234567890abcdef' }],
}));

const originalUA = new Map();
app.on('session-created', created => {
  const fixture = /^onlydm-instagram(?:-[0-9a-f]{32})?$/.test(basename(created.storagePath || ''));
  created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, respond) => {
    respond({ cancel: !fixture || new URL(url).origin !== 'https://www.instagram.com' });
  });
  if (!fixture) return;
  originalUA.set(created, created.getUserAgent());
  created.protocol.handle('https', request => {
    if (new URL(request.url).pathname !== '/direct/inbox/') return new Response('', { status: 404 });
    return new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">'
      + '<nav><a href="/fixture_account/">Profile</a></nav>'
      + '<div role="button" tabindex="0" style="width:280px;height:64px">'
      + '<img width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">'
      + '<a href="/direct/t/101/"><span title="Fixture conversation">Fixture conversation</span></a>'
      + '<span>Synthetic preview</span></div>', {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  });
});

async function waitFor(label, probe) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(50);
  }
  throw new Error('Timed out: ' + label);
}

function remotes() {
  return webContents.getAllWebContents().filter(contents => originalUA.has(contents.session));
}

function menuRoles(items) {
  return items.flatMap(item => [item.role, ...(item.submenu ? menuRoles(item.submenu.items) : [])]);
}

let finished = false;
const timer = setTimeout(() => fail(new Error('overall platform smoke timeout')), 25000);
app.once('quit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
function fail(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.error('OnlyDM platform smoke failed:', error.message);
  app.exit(1);
}

async function exercise() {
  await app.whenReady();
  await waitFor('one production window and both inboxes', () => BrowserWindow.getAllWindows().length === 1
    && BrowserWindow.getAllWindows()[0].isVisible() && remotes().length === 2);
  const [window] = BrowserWindow.getAllWindows();
  const owned = remotes();
  await waitFor('foreground and background fixture documents', () => owned.every(contents =>
    !contents.isLoadingMainFrame() && contents.getURL() === 'https://www.instagram.com/direct/inbox/'));
  for (const contents of owned) {
    const ua = contents.getUserAgent();
    assert.equal(await contents.executeJavaScript('navigator.userAgent'), ua);
    if (process.platform === 'darwin') {
      assert.doesNotMatch(ua, /(?:OnlyDM|onlydm-linux|Electron)\//i);
      assert.doesNotMatch(ua, /Macintosh; Apple macOS/);
      assert.equal(ua.match(/Chrome\/[\d.]+/)[0], originalUA.get(contents.session).match(/Chrome\/[\d.]+/)[0]);
    } else {
      assert.equal(ua, originalUA.get(contents.session));
    }
  }
  if (process.platform === 'darwin') {
    const roles = menuRoles(Menu.getApplicationMenu().items);
    for (const role of ['quit', 'hide', 'copy', 'paste', 'minimize']) assert.ok(roles.includes(role), role);
  }

  const ids = owned.map(contents => contents.id).sort();
  for (const event of ['activate', 'second-instance', 'activate']) {
    if (process.platform === 'darwin') window.close();
    else window.hide();
    assert.equal(window.isDestroyed(), false);
    assert.equal(window.isVisible(), false);
    assert.ok(owned.every(contents => !contents.isDestroyed()), 'hidden inbox watchers stay alive');
    app.emit(event);
    await waitFor(event + ' restores the same window', () => window.isVisible());
    assert.deepEqual(BrowserWindow.getAllWindows().map(item => item.id), [window.id]);
    assert.deepEqual(remotes().map(contents => contents.id).sort(), ids, 'restoring cannot duplicate watchers');
  }

  app.once('will-quit', event => {
    // Hold the process only long enough to inspect the production quit cleanup.
    event.preventDefault();
    void waitFor('quit disposes all inbox views', () => owned.every(contents => contents.isDestroyed())).then(() => {
      assert.equal(window.isDestroyed(), true);
      assert.deepEqual(ipcMain.eventNames().filter(name => String(name).startsWith('onlydm:')), []);
      for (const instagram of originalUA.keys()) assert.equal(instagram.listenerCount('will-download'), 0);
      assert.deepEqual(remotes(), []);
      finished = true;
      clearTimeout(timer);
      console.log('OnlyDM platform smoke passed: Electron ' + process.versions.electron + ' on ' + process.platform
        + ', production window restore, stable foreground/background views, UA and quit cleanup'
        + (process.platform === 'darwin' ? ', native menu roles.' : ' (macOS native menu checks skipped).'));
      app.quit();
    }).catch(fail);
  });
  if (process.platform === 'darwin') app.quit();
  else window.close();
}

// Use the production lifecycle, rather than createOnlyDM's standalone fixture mode.
require('../src/main.cjs');
exercise().catch(fail);

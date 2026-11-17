'use strict';

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, basename } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { createOnlyDM } = require('../src/app.cjs');

const root = mkdtempSync(join(tmpdir(), 'onlydm-linked-fixture-'));
app.setPath('userData', root);
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-background-networking');
const origin = 'https://www.instagram.com';
let handle = 'fixture_main';
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

app.on('session-created', created => {
  const fixture = basename(created.storagePath || '') === 'onlydm-instagram';
  created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, respond) =>
    respond({ cancel: !fixture || new URL(url).origin !== origin }));
  if (!fixture) return;
  created.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.pathname === '/direct/inbox/' && url.searchParams.has('fixture_select')) {
      handle = 'fixture_linked';
      return Response.redirect(origin + '/direct/inbox/', 303);
    }
    if (url.pathname !== '/direct/inbox/') return new Response('', { status: 404 });
    const markup = '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">'
      + '<main><nav><a href="/' + handle + '/">Profile</a></nav>'
      + '<div id="switch" role="button"><svg aria-label="Down chevron icon"></svg></div>'
      + '<section id="private-underlay">Private underlay</section>'
      + '<div role="button" tabindex="0" style="width:310px;height:76px"><img width="40" height="40" src="' + avatar + '">'
      + '<span title="' + handle + '">' + handle + '</span><span>fixture preview</span></div></main>'
      + '<script>document.getElementById("switch").onclick=()=>{setTimeout(()=>{'
      + 'const dialog=document.createElement("div");dialog.setAttribute("role","dialog");dialog.innerHTML='
      + JSON.stringify('<button id="pick-linked">fixture_linked</button><button id="cancel-linked">Cancel</button>')
      + ';document.body.append(dialog);document.getElementById("pick-linked").onclick=()=>location.assign("/direct/inbox/?fixture_select=1");'
      + 'document.getElementById("cancel-linked").onclick=()=>dialog.remove();},200)};</script>';
    return new Response(markup, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  });
});
async function waitFor(name, test) {
  const end = Date.now() + 15000;
  do {
    if (await test()) return;
    await delay(100);
  } while (Date.now() < end);
  throw new Error('Timed out: ' + name);
}
async function exercise() {
  await app.whenReady();
  const controller = await createOnlyDM();
  const { window } = controller;
  await waitFor('original inbox', () => controller.inbox.getVisible()
    && controller.inbox.webContents.executeJavaScript("!!document.querySelector('#OnlyDmShell')"));
  await waitFor('linked chooser is available once the inbox is ready', () => window.webContents.executeJavaScript(
    "Boolean(document.querySelector('#profiles option[value=__linked__]'))"));
  const original = controller.inbox.webContents;
  await window.webContents.executeJavaScript("document.querySelector('#profiles').value='__linked__';document.querySelector('#profiles').dispatchEvent(new Event('change'))");
  await waitFor('official chooser is visible', () => controller.inbox.webContents.executeJavaScript(
    "!!document.querySelector('#pick-linked') && getComputedStyle(document.querySelector('#OnlyDmShell')).display === 'none'"));
  assert.equal(await original.executeJavaScript("getComputedStyle(document.querySelector('#private-underlay')).visibility"), 'hidden',
    'opening the official account chooser does not reveal the underlying Instagram UI');
  assert.equal(original.getZoomFactor(), 1, 'official sign-in and chooser keep normal sizing');
  await original.executeJavaScript("document.querySelector('#pick-linked').click()");
  await waitFor('linked identity has a fresh list', () => controller.inbox.getVisible()
    && controller.inbox.webContents.executeJavaScript(
      "document.querySelector('#OnlyDmShell .onlydm-thread-title')?.textContent === 'fixture_linked'"));
  await waitFor('app updates the account name', () => window.webContents.executeJavaScript(
    "document.querySelector('#profiles').selectedOptions[0].textContent === '@fixture_linked'"));
  assert.equal(controller.inbox.webContents.getZoomFactor(), .25);
  window.close();
}
const timer = setTimeout(() => finish(new Error('overall linked-account test timeout')), 30000);
function finish(error) {
  clearTimeout(timer);
  if (error) console.error('OnlyDM linked account smoke failed:', error.message);
  else console.log('OnlyDM linked account smoke passed: official chooser, hidden underlay, full-page switch, updated identity.');
  app.once('quit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  app.exit(error ? 1 : 0);
}
exercise().then(() => finish(), finish);

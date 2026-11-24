'use strict';

require('./fixture-runtime.cjs');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app } = require('electron');
const { createOnlyDM } = require('../src/app.cjs');

const temp = resolve(tmpdir());
const profile = mkdtempSync(join(temp, 'onlydm-read-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
writeFileSync(join(profile, 'settings.json'), JSON.stringify({ language: 'en' }));
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');

const origin = 'https://www.instagram.com';
const title = 'Duplicate display name';
const ids = ['101', '102', '103'];
const route = id => '/direct/t/' + id + '/';
const avatar = id => origin + '/fixture-avatar/' + id + '.gif';
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const row = (id, name) => '<div id="source-' + id + '" role="button" tabindex="0" style="height:64px;width:300px">'
  + '<img src="' + avatar(id) + '" width="40" height="40">'
  + (id === '102' ? '<a href="' + route(id) + '">' : '') + '<span title="' + name + '">' + name + '</span>'
  + (id === '102' ? '</a>' : '') + '<span id="preview-' + id + '" style="font-weight:600">First message ' + id + '</span>'
  + '<time datetime="2026-01-01T00:00:00Z">1m</time></div>';
const inboxPage = '<nav><a href="/fixture_read/">Profile</a></nav><main>' + row('101', title) + row('102', title) + row('103', 'Failed room') + '</main>'
  + '<script>document.querySelector("#source-101").onclick = () => history.pushState({}, "", "/direct/t/101/");'
  + 'document.querySelector("#source-103").onclick = () => location.assign("/direct/t/103/");</script>';
const conversation = '<section><header><h1>Fixture conversation</h1></header>'
  + '<div data-pagelet="IGDMessagesList"><p>Synthetic history</p></div>'
  + '<form><textarea aria-label="Message"></textarea></form></section>';
const chatPage = '<body>Loading fixture conversation'
  + '<script>window.mountConversation = () => { document.body.innerHTML = ' + JSON.stringify(conversation) + '; };</script>';
const html = body => new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">' + body, {
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
});
let chatLoads = 0;
const failedLoads = [];
app.on('web-contents-created', (_, contents) => {
  contents.on('did-fail-load', (_event, code, _error, url, isMainFrame) => {
    if (isMainFrame && code !== -3) failedLoads.push(url);
  });
});
app.on('session-created', created => {
  created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, done) => {
    done({ cancel: new URL(url).origin !== origin });
  });
  created.protocol.handle('https', request => {
    const url = new URL(request.url);
    if (url.origin !== origin) return Response.error();
    if (ids.some(id => url.href === avatar(id))) return new Response(gif, { headers: { 'content-type': 'image/gif' } });
    if (url.pathname === '/direct/inbox/') return html(inboxPage);
    if (url.pathname === route('101')) { chatLoads++; return html(chatPage); }
    return Response.error();
  });
});

async function waitFor(label, probe) {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(50);
  }
  throw new Error('Timed out: ' + label);
}

async function exercise() {
  await app.whenReady();
  const controller = await createOnlyDM({ notify() {} });
  const inbox = controller.inbox.webContents;
  const shell = controller.window.webContents;
  const projectedRow = '#OnlyDmShell .onlydm-thread-row';
  const target = projectedRow + '[data-title="' + title + '"][data-href=""]';
  const unread = (selector) => inbox.executeJavaScript(
    'document.querySelector(' + JSON.stringify(selector) + ')?.dataset.unread');
  const totals = async (count) => await inbox.executeJavaScript('document.querySelector(".onlydm-chip-count")?.textContent') === String(count)
    && await shell.executeJavaScript('document.querySelector("#hint").textContent.endsWith(" · Unread ' + count + '")');
  const commands = (code) => inbox.executeJavaScriptInIsolatedWorld(1001, [{ code }]);
  const seen = () => commands('fixtureCommands');
  const reads = async () => (await seen()).filter(command => command.type === 'mark-thread-read');
  await waitFor('confirmed fixture account and three unread rooms', async () => await totals(3)
    && await shell.executeJavaScript('document.querySelector("#profiles").textContent.includes("fixture_read")'));
  await commands('globalThis.fixtureCommands = []; onlydmHost.subscribe(data => {'
    + 'if (["open-row", "mark-thread-read"].includes(data.type)) fixtureCommands.push(data); });');
  const targetKey = await inbox.executeJavaScript('document.querySelector(' + JSON.stringify(target) + ').dataset.key');
  assert.match(targetKey, /^name:/, 'the target starts without a URL');

  async function open(selector) {
    if (process.platform === 'darwin' && !controller.window.isFocused()) app.focus({ steal: true });
    controller.window.focus();
    await waitFor('foreground inbox', () => controller.window.isFocused());
    await inbox.executeJavaScript('document.querySelector(' + JSON.stringify(selector)
      + ').dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))');
  }
  async function receive(text, stamp) {
    await inbox.executeJavaScript('document.querySelector("#preview-101").textContent = ' + JSON.stringify(text)
      + '; document.querySelector("#source-101 time").dateTime = ' + JSON.stringify(stamp));
    await waitFor('new DM restores the red badge and both unread totals', async () =>
      await totals(3) && await unread(target) === 'true');
  }
  async function confirmReady(expectedCommands, beforeInboxReturns) {
    await controller.chat.webContents.executeJavaScript('mountConversation()');
    if (beforeInboxReturns) await beforeInboxReturns();
    await waitFor('ready chat clears only the target badge and totals', async () =>
      controller.chat?.getVisible() && await totals(2) && await unread(target) === 'false');
    assert.deepEqual(await reads(),
      Array.from({ length: expectedCommands }, () => ({ type: 'mark-thread-read', href: origin + route('101'), key: targetKey })));
    assert.equal(await unread(projectedRow + '[data-href$="/102"]'), 'true', 'a same-title room stays unread');
    assert.equal(await unread(projectedRow + '[data-title="Failed room"]'), 'true');
  }
  const waitForPlaceholder = () => waitFor('chat URL without a ready conversation', () =>
    controller.chat?.webContents.executeJavaScript('typeof mountConversation === "function"').catch(() => false));

  await open(projectedRow + '[data-title="Failed room"]');
  await waitFor('cold address resolves but chat navigation fails', () => failedLoads.includes(origin + route('103')));
  assert.equal(controller.chat.getVisible(), false);
  assert.equal(await totals(3), true, 'a failed chat keeps the unread totals');
  assert.equal(await unread(projectedRow + '[data-title="Failed room"]'), 'true');
  assert.equal((await reads()).length, 0);
  controller.chatWindow.destroy();

  // Hold the inbox on its temporary thread route until the new window reports ready.
  await commands('history.back = () => { globalThis.fixtureBackPending = true; }; void 0');
  await open(target);
  await waitForPlaceholder();
  await waitFor('inbox held on the temporary SPA route', () => commands(
    'globalThis.fixtureBackPending && location.pathname === "/direct/t/101/"'));
  assert.equal(await totals(3), true, 'resolving a cold URL is insufficient');
  await confirmReady(1, async () => {
    await waitFor('one read signal while the inbox is on the SPA route', async () => (await reads()).length === 1);
    await commands('delete history.back; history.back();');
  });
  const existing = controller.chatWindow;
  existing.close();
  await receive('New DM after the first read', '2026-01-01T00:01:00Z');
  await open(target);
  await waitFor('ready cached window clears unread again', async () => await totals(2) && await unread(target) === 'false');
  assert.equal(controller.chatWindow.id, existing.id);
  assert.equal(chatLoads, 1, 'the existing window keeps its renderer');
  assert.equal((await reads()).length, 2);

  existing.destroy();
  // Identical text with a later native datetime still represents a new message.
  await receive('New DM after the first read', '2026-01-01T00:02:00Z');
  await open(target);
  await waitForPlaceholder();
  assert.equal(chatLoads, 2);
  assert.equal(await totals(3), true, 'the known URL still waits for ready');
  assert.equal((await seen()).filter(command => command.type === 'open-row').length, 2,
    'only the two cold opens need inbox routing');
  await confirmReady(3);
}

app.once('quit', () => {
  assert.equal(dirname(resolve(profile)), temp);
  assert.match(basename(profile), /^onlydm-read-/);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold disposable files. */ }
});
exercise().then(() => {
  console.log('OnlyDM read smoke passed: failed open, cold route, ready room reuse, cached URL, new message and same-title isolation.');
  app.exit(0);
}, error => {
  console.error(error);
  app.exit(1);
});

'use strict';
require('./fixture-runtime.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tmpdir } = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { app, dialog } = require('electron');
const { createOnlyDM } = require('../src/app.cjs');

const root = fs.mkdtempSync(path.join(tmpdir(), 'onlydm-appearance-smoke-'));
app.setPath('userData', root);
app.commandLine.appendSwitch('disable-background-networking');
app.on('window-all-closed', () => {});
const saved = path.join(root, 'settings.json');
const chatColors = { background: '#FFF3DA', incoming: '#ABCDEF', outgoing: '#345678' };
fs.writeFileSync(saved, JSON.stringify({ chatTheme: 'custom', chatColors, appColors: { chrome: '#121212', background: '#FAFAFA' } }));
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
app.on('session-created', session => {
  session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, done) =>
    done({ cancel: new URL(url).origin !== 'https://www.instagram.com' }));
  session.protocol.handle('https', () => new Response(
    '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><nav><a href="/fixture_main/">Profile</a></nav>'
    + '<main style="height:400px;overflow:auto"><div role="button" tabindex="0" style="height:76px;width:310px">'
    + '<img width="40" height="40" src="' + avatar + '"><span title="Synthetic friend">Synthetic friend</span>'
    + '<p>Synthetic preview</p><small>1h</small></div></main>', { headers: { 'content-type': 'text/html' } }));
});
const checks = [];
let controller;
let offered = false;
let starts = 0;
const errors = [];
dialog.showMessageBox = async (_window, options) => { errors.push(options.message); return { response: 1 }; };
async function until(name, predicate) {
  const end = Date.now() + 12000;
  do { if (await predicate()) return; await delay(60); } while (Date.now() < end);
  throw new Error('Timed out: ' + name);
}
const evaluate = (fn, argument) => controller.window.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(argument) + ')');
const click = selector => evaluate(selector => document.querySelector(selector).click(), selector);
const edit = (selector, value) => evaluate(([selector, value]) => {
  const input = document.querySelector(selector); input.value = value; input.dispatchEvent(new Event('input', { bubbles: true }));
}, [selector, value]);
const waitForUpdater = Promise.withResolvers();
const watchdog = setTimeout(() => { console.error('Appearance fixture exceeded its deadline.'); app.exit(1); }, 45000);

void app.whenReady().then(async () => {
  controller = await createOnlyDM({
    separateChatWindows: false,
    notify() {},
    updater: { check: async () => { await waitForUpdater.promise; return { version: '9.9.9', tag: 'v9.9.9' }; },
      start: async () => { starts++; throw new Error('Inert installer failure'); } },
  });
  try {
    await until('projected inbox', () => controller.inbox.getVisible());
    assert.equal(await evaluate(() => document.querySelector('#update').hidden), true);
    offered = true; waitForUpdater.resolve();
    await until('conditional update button', () => evaluate(() => !document.querySelector('#update').hidden));
    const frame = await evaluate(() => ({
      title: getComputedStyle(document.querySelector('#window-titlebar')).backgroundColor,
      rail: getComputedStyle(document.querySelector('#nav-rail')).backgroundColor,
      text: getComputedStyle(document.querySelector('#settings')).color,
    }));
    assert.equal(frame.title, 'rgb(18, 18, 18)'); assert.equal(frame.title, frame.rail);
    assert.equal(frame.text, 'rgb(255, 255, 255)');
    checks.push('Conditional updater hidden then shown; title bar and rail share custom dark color with white icons');
    await click('#settings');
    await until('settings modal hides native view', () => !controller.inbox.getVisible() && evaluate(() => document.querySelector('#settings-dialog').open));
    assert.equal(await evaluate(() => document.querySelectorAll('#color-presets button').length), 9);
    await click('#color-presets button[aria-label="#DDF3E7"]');
    assert.equal(await evaluate(() => document.querySelector('#app-chrome-hex').value), '#DDF3E7');
    await edit('#color-hue', '240');
    const beforePointerColor = await evaluate(() => document.querySelector('#app-chrome-hex').value);
    const bounds = await evaluate(() => {
      const node = document.querySelector('#color-spectrum'); node.scrollIntoView({ block: 'center' });
      const rect = node.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    const contents = controller.window.webContents;
    const point = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
    controller.window.focus();
    contents.sendInputEvent({ type: 'mouseMove', ...point });
    contents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    contents.sendInputEvent({ type: 'mouseMove', x: point.x + 20, y: point.y + 8, modifiers: ['leftButtonDown'] });
    contents.sendInputEvent({ type: 'mouseUp', x: point.x + 20, y: point.y + 8, button: 'left', clickCount: 1 });
    await until('spectrum pointer updates HEX', () => evaluate(previous => document.querySelector('#app-chrome-hex').value !== previous, beforePointerColor));
    const pointerColor = await evaluate(() => document.querySelector('#app-chrome-hex').value);
    assert.match(pointerColor, /^#[0-9A-F]{6}$/); assert.notEqual(pointerColor, '#DDF3E7');
    checks.push('Presets, hue input and native pointer drag synchronize the active HEX field');
    const before = fs.readFileSync(saved, 'utf8');
    await edit('#app-chrome-hex', '#12');
    assert.equal(await evaluate(() => document.querySelector('#chat-theme-apply').disabled), true);
    assert.equal(fs.readFileSync(saved, 'utf8'), before);
    await edit('#app-chrome-hex', '#FFFFFF'); await edit('#app-background-hex', '#151515');
    await click('#chat-theme-apply');
    await until('custom app settings persisted', () => JSON.parse(fs.readFileSync(saved, 'utf8')).appColors.background === '#151515');
    const stored = JSON.parse(fs.readFileSync(saved, 'utf8'));
    assert.deepEqual(stored.chatColors, chatColors); assert.deepEqual(stored.appColors, { chrome: '#FFFFFF', background: '#151515' });
    await click('#settings-close'); await until('native inbox restored', () => controller.inbox.getVisible());
    // The native view processes its theme IPC separately from settings persistence.
    await until('existing inbox applies the saved background', async () =>
      await controller.inbox.webContents.executeJavaScript('getComputedStyle(document.querySelector("#OnlyDmShell")).backgroundColor') === 'rgb(21, 21, 21)');
    assert.deepEqual(await evaluate(() => ({
      rail: getComputedStyle(document.querySelector('#nav-rail')).backgroundColor,
      header: getComputedStyle(document.querySelector('#window-titlebar')).backgroundColor,
      icon: getComputedStyle(document.querySelector('#settings')).color,
      scheme: getComputedStyle(document.querySelector('#profiles')).colorScheme,
    })), { rail: 'rgb(255, 255, 255)', header: 'rgb(255, 255, 255)', icon: 'rgb(0, 0, 0)', scheme: 'light' });
    checks.push('Invalid HEX cannot save; app and chat colors persist independently; existing inbox repaints without reload');
    await click('#update');
    await until('inert updater failure restores native inbox and button', async () =>
      starts === 1 && errors.length === 1 && controller.inbox.getVisible()
      && await evaluate(() => !document.querySelector('#update').disabled));
    checks.push('Updater error leaves app and native inbox usable; no real helper, package install or restart');
    console.log('Appearance smoke passed: ' + JSON.stringify({ platform: process.platform, checks, isolatedData: true, realInstaller: false }));
  } finally {
    clearTimeout(watchdog); if (!offered) waitForUpdater.resolve();
    controller?.window.close(); await delay(100);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Chromium may retain profile handles until process exit. */ }
  }
  app.quit();
}).catch(error => { clearTimeout(watchdog); console.error(error); app.exit(1); });

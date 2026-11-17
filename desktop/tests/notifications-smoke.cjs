'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, basename } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, webContents } = require('electron');
const { createOnlyDM } = require('../src/app.cjs');

const secondId = '1234567890abcdef1234567890abcdef';
const root = mkdtempSync(join(tmpdir(), 'onlydm-all-account-alerts-'));
const settingsFile = join(root, 'settings.json');
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
const workNotices = {
  System: [
    'A check is required.',
    'An item is pending.',
    'Check the task status.',
    'A new review has been requested.',
    'Check the next scheduled review.',
  ],
  시스템: [
    '점검이 필요합니다.',
    '처리 대기 중인 항목이 있습니다.',
    '작업 상태를 확인해 주세요.',
    '새로운 확인 요청이 있습니다.',
    '다음 점검 일정을 확인해 주세요.',
  ],
};

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
const click = (wc, selector) => wc.executeJavaScript('document.querySelector(' + JSON.stringify(selector) + ').click()');
const dialogOpen = "document.querySelector('#settings-dialog').open";
const switchChecked = "document.querySelector('#work-mode').checked";
const readSettings = () => JSON.parse(readFileSync(settingsFile, 'utf8'));
const customColors = { background: '#767676', incoming: '#757575', outgoing: '#F5AB00' };

async function openSettingsDialog({ window, inbox }) {
  await click(window.webContents, '#settings');
  await waitFor('settings dialog opens and hides the native inbox', () =>
    !inbox.getVisible() && window.webContents.executeJavaScript(dialogOpen));
}

async function waitForSettingsClosed({ window, inbox }) {
  await waitFor('settings dialog closes and restores the native inbox', async () =>
    inbox.getVisible() && !(await window.webContents.executeJavaScript(dialogOpen)));
}

async function toggleWorkMode(wc, enabled) {
  await click(wc, '#work-mode');
  await waitFor('Work mode saves ' + enabled + ' while settings is open', () =>
    existsSync(settingsFile) && readSettings().workModeEnabled === enabled
    && wc.executeJavaScript(dialogOpen + ' && ' + switchChecked + ' === ' + enabled));
}

async function editChatTheme(wc) {
  const edit = (selector, value, event = 'input') => wc.executeJavaScript(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  })()`);
  assert.equal(await wc.executeJavaScript("document.querySelector('#chat-theme').value"), 'system');
  const shellBackground = 'getComputedStyle(document.body).backgroundColor';
  const before = await wc.executeJavaScript(shellBackground);
  await edit('#chat-theme', 'custom', 'change');
  assert.deepEqual(await wc.executeJavaScript("[...document.querySelectorAll('.chat-palette input[type=color]')].map(input => input.value)"),
    ['#ffffff', '#f0f2f4', '#4257c9']);
  await edit('#chat-background-hex', '#123');
  assert.ok(await wc.executeJavaScript(`
    document.querySelector('#chat-theme-apply').disabled
    && !document.querySelector('#chat-hex-error').hidden
    && document.querySelector('#chat-background-hex').getAttribute('aria-invalid') === 'true'`));
  await edit('#chat-background-hex', '767676');
  await edit('#chat-incoming-color', '#757575');
  await edit('#chat-outgoing-hex', '#f5ab00');
  assert.deepEqual(await wc.executeJavaScript(`
    ['#chat-preview', '.preview-incoming', '.preview-outgoing'].map(selector => {
      const style = getComputedStyle(document.querySelector(selector));
      return [style.backgroundColor, style.color];
    })`), [
    ['rgb(118, 118, 118)', 'rgb(0, 0, 0)'],
    ['rgb(117, 117, 117)', 'rgb(255, 255, 255)'],
    ['rgb(245, 171, 0)', 'rgb(0, 0, 0)'],
  ], 'live palette and contrasting text render under the shell CSP');
  assert.equal(existsSync(settingsFile), false, 'editing has not saved anything');
  await toggleWorkMode(wc, true);
  assert.equal(readSettings().chatTheme, 'system', 'saving Work mode does not save the theme draft');
  assert.equal(await wc.executeJavaScript("document.querySelector('#chat-outgoing-hex').value"), '#f5ab00',
    'saving Work mode does not reset the theme draft');
  await click(wc, '#chat-theme-apply');
  await waitFor('applying the theme saves the entire palette', () => readSettings().chatTheme === 'custom'
    && wc.executeJavaScript("document.querySelector('#chat-theme-apply').disabled"));
  assert.deepEqual(readSettings(), { workModeEnabled: true, chatTheme: 'custom', chatColors: customColors });
  assert.equal(await wc.executeJavaScript(shellBackground), before, 'the chat theme does not recolor the shell');
  await edit('#chat-outgoing-hex', '#FF0000'); // Leave an unapplied edit to discard on close.
}

function assertMasked(notice, profileId) {
  assert.equal(notice.profileId, profileId);
  assert.match(notice.title, /^(System|시스템)$/);
  assert.ok(workNotices[notice.title].includes(notice.body), 'expected a generic Work mode notice, got: ' + notice.body);
  assert.equal(typeof notice.onClick, 'function');
}

function assertUnmaskedAlternate(notice) {
  assert.equal(notice.profileId, secondId);
  assert.equal(notice.title, '@fixture_alternate · Synthetic friend');
  assert.match(notice.body, /^(A new message has arrived\.|새 메시지가 도착했습니다\.)$/);
}

async function closeWindow(window) {
  window.close();
  await waitFor('all monitored account renderers close', () =>
    window.isDestroyed() && !remoteFor('default') && !remoteFor(secondId));
}

async function exercise() {
  await app.whenReady();
  const notify = notification => { notices.push(notification); };
  const controller = await createOnlyDM({ notify });
  const { window } = controller;
  const shell = window.webContents;
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
  await waitFor('inactive account alerts with Work mode off by default', () => notices.length === 1);
  assertUnmaskedAlternate(notices[0]);

  window.setContentSize(350, 420);
  await waitFor('shell resizes to 350x420', () => shell.executeJavaScript('innerWidth === 350 && innerHeight === 420'));
  await openSettingsDialog(controller);
  assert.ok(await shell.executeJavaScript(`(() => {
    const dialog = document.querySelector('#settings-dialog');
    const rect = dialog.getBoundingClientRect();
    return dialog.matches(':modal') && rect.width > 0 && rect.height > 0
      && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      && dialog.scrollWidth <= dialog.clientWidth && dialog.scrollHeight <= dialog.clientHeight
      && document.documentElement.scrollWidth <= innerWidth
      && ['#work-mode', '#settings-close'].every(selector => {
        const control = document.querySelector(selector);
        const { x, y, width, height } = control.getBoundingClientRect();
        return control.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      });
  })()`), 'the settings dialog and its controls fit and are visible at 350x420');
  assert.ok(await shell.executeJavaScript("document.querySelector('#work-mode').matches('input[type=checkbox][role=switch]:not(:checked)')"),
    'the Work mode switch starts unchecked');
  await editChatTheme(shell);
  await click(shell, '#settings-close');
  await waitForSettingsClosed(controller);

  const incoming = 'private incoming message with the same preview in both accounts';
  await update(controller.inbox.webContents, incoming);
  await waitFor('active inbox sends a Work mode alert', () => notices.length === 2);
  assertMasked(notices[1], 'default');

  await update(secondary, incoming);
  await waitFor('alert arrives while another account is active', () => notices.length === 3);
  assert.equal(bySession.get(controller.inbox.webContents.session), 'default', 'an alert does not switch accounts by itself');
  const notice = notices[2];
  assertMasked(notice, secondId);

  await secondary.executeJavaScript("document.querySelector('#time').textContent = '2m'");
  await delay(1200);
  await update(secondary, incoming);
  await delay(1200);
  assert.equal(notices.length, 3, 'unchanged unread messages and time updates stay deduplicated');

  await shell.executeJavaScript("document.querySelector('#search').value = 'old search'");
  notice.onClick();
  await waitFor('notification click switches to the correct account', () =>
    bySession.get(controller.inbox.webContents.session) === secondId && controller.inbox.getVisible());
  await waitFor('old alternate watcher is closed', () => secondary.isDestroyed());
  assert.equal(await shell.executeJavaScript("document.querySelector('#search').value"), '');
  assert.ok(window.isVisible());

  await openSettingsDialog(controller);
  assert.equal(await shell.executeJavaScript(switchChecked), true, 'switching accounts keeps Work mode on');
  assert.equal(await shell.executeJavaScript("document.querySelector('#chat-outgoing-hex').value"), customColors.outgoing,
    'reopening settings discards unapplied colors');
  shell.focus();
  shell.debugger.attach();
  try {
    for (const type of ['keyDown', 'keyUp']) {
      await shell.debugger.sendCommand('Input.dispatchKeyEvent', {
        type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
      });
    }
  } finally {
    if (shell.debugger.isAttached()) shell.debugger.detach();
  }
  await waitForSettingsClosed(controller);

  await waitFor('previously active account becomes monitored', () => remoteFor('default'));
  const previous = remoteFor('default');
  await delay(4800);
  const before = notices.length;
  await update(previous, incoming);
  // Wait through a full watcher poll to catch a repeat after recreating the renderer.
  await delay(3200);
  assert.equal(notices.length, before, 'the new watcher does not repeat an already announced message');
  await update(previous, 'message for the other account after switching');
  await waitFor('other account still alerts after switching', () => notices.length === before + 1);
  assertMasked(notices.at(-1), 'default');

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
  assertMasked(notices.at(-1), 'default');
  await closeWindow(window);

  const reopened = await createOnlyDM({ notify });
  const reopenedShell = reopened.window.webContents;
  await waitFor('reopened inbox', () => reopened.inbox.getVisible());
  await openSettingsDialog(reopened);
  assert.equal(await reopenedShell.executeJavaScript(switchChecked), true, 'reopening OnlyDM restores Work mode');
  assert.equal(await reopenedShell.executeJavaScript("document.querySelector('#chat-theme').value"), 'custom',
    'reopening OnlyDM restores the theme');
  await toggleWorkMode(reopenedShell, false);
  assert.deepEqual(readSettings().chatColors, customColors, 'saving Work mode preserves the custom palette');
  await click(reopenedShell, '#settings-close');
  await waitForSettingsClosed(reopened);

  const offBefore = notices.length;
  await update(reopened.inbox.webContents, 'private preview after disabling Work mode');
  await waitFor('alert arrives with Work mode off', () => notices.length === offBefore + 1);
  assertUnmaskedAlternate(notices.at(-1));
  await closeWindow(reopened.window);
}
let finished = false;
const timer = setTimeout(() => finish(new Error('overall notification smoke timeout')), 75000);
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error) console.error('OnlyDM all-account notification smoke failed:', error.message);
  else console.log('OnlyDM notification smoke passed: chat theme preview and settings, Work mode masking, account routing, deduplication, reconnect, cleanup.');
  app.once('quit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  app.exit(error ? 1 : 0);
}
exercise().then(() => finish(), finish);

'use strict';

require('./fixture-runtime.cjs');

const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, basename } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, ipcMain, webContents } = require('electron');
const { createOnlyDM } = require('../src/app.cjs');
const { openContacts } = require('../src/contacts.cjs');

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
const threadHref = origin + '/direct/t/101/';
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const bySession = new Map();
const notices = [];
const projectionEvents = [];
ipcMain.on('onlydm:projection', (event, message) => {
  if (!bySession.has(event.sender.session) || !['thread-notification', 'projection-error', 'inbox-ready'].includes(message?.type)) return;
  projectionEvents.push({ profile: bySession.get(event.sender.session), type: message.type,
    previewLength: typeof message.preview === 'string' ? message.preview.length : 0 });
  if (projectionEvents.length > 30) projectionEvents.shift();
});
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
    const pathname = new URL(request.url).pathname;
    if (pathname === '/direct/t/101/') {
      return new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">'
        + '<main><section><div data-pagelet="IGDMessagesList"><p id="fixture-chat-history">Synthetic notification chat history</p></div>'
        + '<form><textarea id="fixture-message" aria-label="Message"></textarea></form></section></main>', {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }
    if (pathname !== '/direct/inbox/') return new Response('', { status: 404 });
    const handle = isMain ? 'fixture_main' : 'fixture_alternate';
    return new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">'
      + '<nav><a href="/' + handle + '/">Profile</a></nav>'
      + '<main style="height:300px;width:320px;overflow:auto"><div role="button" tabindex="0" style="height:76px;width:310px">'
      + '<img width="40" height="40" src="' + avatar + '"><a href="/direct/t/101/"><span title="Synthetic friend" style="font-weight:600">Synthetic friend</span></a>'
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

async function waitForWatcherBaseline(contents, label) {
  // Navigation can finish before the isolated projection seeds its unread baseline.
  await waitFor(label + ' projection seeds its baseline', () => contents.executeJavaScriptInIsolatedWorld(1001, [{
    code: 'typeof window.__onlydmInboxRerun === "function" && window.__onlydmInboxRerun() === true',
  }]));
  await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `
    window.__onlydmFixtureTicks = 0;
    setInterval(() => { window.__onlydmFixtureTicks++; }, 500);
  ` }]);
  await delay(4800);
  const ticks = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: 'window.__onlydmFixtureTicks' }]);
  console.log('Notification watcher baseline: ' + JSON.stringify({ label, ticks, backgroundThrottling: contents.getBackgroundThrottling() }));
}

async function openSettingsDialog(controller) {
  await click(controller.window.webContents, '#settings');
  await waitFor('settings dialog opens above the native inbox', () =>
    controller.inbox.getVisible() && controller.settingsContents?.executeJavaScript(dialogOpen));
  return controller.settingsContents;
}

async function waitForSettingsClosed(controller) {
  await waitFor('settings layer is removed and the inbox stays visible', () =>
    controller.inbox.getVisible() && !controller.settingsContents);
}

async function toggleWorkMode(wc, enabled) {
  await click(wc, '#work-mode');
  await waitFor('Work mode saves ' + enabled + ' while settings is open', () =>
    existsSync(settingsFile) && readSettings().workModeEnabled === enabled
    && wc.executeJavaScript(dialogOpen + ' && ' + switchChecked + ' === ' + enabled));
}

async function togglePreference(wc, key, selector, enabled) {
  assert.equal(await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).checked`), !enabled);
  assert.equal(await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).disabled`), false);
  await click(wc, selector);
  await waitFor(key + ' saves ' + enabled, () => readSettings()[key] === enabled
    && wc.executeJavaScript(`${dialogOpen} && document.querySelector(${JSON.stringify(selector)}).checked === ${enabled}`));
}

const localized = (ko, en) => /^ko(?:-|$)/i.test(app.getLocale()) ? ko : en;
const genericBody = () => localized('새 메시지가 도착했습니다.', 'A new message has arrived.');

async function editChatTheme(wc) {
  const edit = (selector, value, event = 'input') => wc.executeJavaScript(`(() => {
    const control = document.querySelector(${JSON.stringify(selector)});
    control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true }));
  })()`);
  assert.equal(await wc.executeJavaScript("document.querySelector('#chat-theme').value"), 'system');
  const dialogBackground = 'getComputedStyle(document.querySelector("#settings-dialog")).backgroundColor';
  await edit('#chat-theme', 'custom', 'change');
  assert.deepEqual(await wc.executeJavaScript("[...document.querySelectorAll('.chat-palette input[type=color]')].map(input => input.value)"),
    ['#eef1f5', '#ffffff', '#ffffff', '#f0f2f4', '#4257c9']);
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
  assert.deepEqual(readSettings(), { workModeEnabled: true, chatTheme: 'custom', chatColors: customColors,
    appColors: { chrome: '#EEF1F5', background: '#FFFFFF' }, language: 'auto', notificationsEnabled: true,
    notificationPreviewEnabled: true, startInTray: false });
  assert.equal(await wc.executeJavaScript(dialogBackground), 'rgb(255, 255, 255)', 'custom app background stays independent of chat colors');
  await edit('#chat-outgoing-hex', '#FF0000'); // Leave an unapplied edit to discard on close.
}

function assertMasked(notice, profileId) {
  assert.equal(notice.profileId, profileId);
  assert.equal(notice.title, localized('시스템', 'System'));
  assert.ok(workNotices[notice.title].includes(notice.body), 'expected a generic Work mode notice, got: ' + notice.body);
  assert.equal(typeof notice.onClick, 'function');
}

function assertUnmasked(notice, profileId, body, name = 'Synthetic friend') {
  assert.equal(notice.profileId, profileId);
  assert.equal(notice.title, (profileId === secondId ? '@fixture_alternate' : '@fixture_main') + ' · ' + name);
  assert.equal(typeof notice.body, 'string');
  assert.equal(notice.body, body);
  assert.equal(typeof notice.onClick, 'function');
}

async function closeWindow(window) {
  window.close();
  await waitFor('all monitored account renderers close', () =>
    window.isDestroyed() && !remoteFor('default') && !remoteFor(secondId));
}

async function exercise() {
  await app.whenReady();
  const notify = notification => { notices.push(notification); };
  const controller = await createOnlyDM({ separateChatWindows: false, notify });
  const { window } = controller;
  const shell = window.webContents;
  await waitFor('active inbox', () => controller.inbox.getVisible());
  await waitFor('inactive monitor starts', () => remoteFor(secondId));
  const secondary = remoteFor(secondId);
  assert.notEqual(secondary, controller.inbox.webContents);
  assert.equal(bySession.get(controller.inbox.webContents.session), 'default');
  await waitForWatcherBaseline(secondary, 'inactive account');
  assert.equal(notices.length, 0, 'existing unread history is silent');
  assert.equal(await secondary.executeJavaScript("!document.querySelector('#OnlyDmShell') && document.querySelector('main').scrollTop === 0"), true);

  assert.ok(await secondary.executeJavaScript('window.innerWidth >= 1000'), 'inactive inbox uses the desktop layout');

  const firstPreview = 'incoming message for the alternate account';
  await update(secondary, firstPreview);
  await waitFor('inactive account alerts with Work mode off by default', () => notices.length === 1);
  assertUnmasked(notices[0], secondId, firstPreview);

  window.setContentSize(350, 420);
  await waitFor('shell resizes to 350x420 with native DPI rounding', () => shell.executeJavaScript('innerWidth === 350 && innerHeight >= 420 && innerHeight <= 424'));
  let modal = await openSettingsDialog(controller);
  assert.ok(await modal.executeJavaScript(`(() => {
    const dialog = document.querySelector('#settings-dialog');
    const rect = dialog.getBoundingClientRect();
    return dialog.matches(':modal') && rect.width > 0 && rect.height > 0
      && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
      && dialog.scrollWidth <= dialog.clientWidth && getComputedStyle(dialog).overflowY === 'auto'
      && document.documentElement.scrollWidth <= innerWidth
      && ['#work-mode', '#settings-close'].every(selector => {
        const control = document.querySelector(selector);
        const { x, y, width, height } = control.getBoundingClientRect();
        return control.contains(document.elementFromPoint(x + width / 2, y + height / 2));
      });
  })()`), 'the settings dialog fits 350x420 and scrolls vertically without horizontal clipping');
  for (const selector of ['#language', '#notifications-enabled', '#notification-preview-enabled', '#start-in-tray', '#auto-start', '#logout']) {
    assert.ok(await modal.executeJavaScript(`(() => {
      const control=document.querySelector(${JSON.stringify(selector)});
      control.scrollIntoView({block:'center'});
      const r=control.getBoundingClientRect();
      const close=document.querySelector('#settings-close'), c=close.getBoundingClientRect();
      return r.width>0 && r.height>0 && control.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))
        && close.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2));
    })()`), selector + ' remains reachable while the close button stays visible');
  }
  assert.ok(await modal.executeJavaScript("document.querySelector('#work-mode').matches('input[type=checkbox][role=switch]:not(:checked)')"),
    'the Work mode switch starts unchecked');
  assert.deepEqual(await modal.executeJavaScript("['#notifications-enabled', '#notification-preview-enabled'].map(selector => document.querySelector(selector).checked)"),
    [true, true], 'notifications and message previews default on');
  await editChatTheme(modal);
  await click(modal, '#settings-close');
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
    bySession.get(controller.inbox.webContents.session) === secondId);
  await waitFor('notification click opens the notified room after the selected inbox becomes ready', () =>
    controller.chat?.getVisible() && controller.chat.webContents.getURL() === threadHref);
  assert.equal(bySession.get(controller.chat.webContents.session), secondId, 'the room uses the notified account session');
  assert.equal(controller.inbox.getVisible(), false, 'the selected room replaces the inbox view');
  assert.equal(await controller.chat.webContents.executeJavaScript("document.querySelector('#fixture-chat-history').textContent"),
    'Synthetic notification chat history');
  assert.equal(await controller.chat.webContents.executeJavaScript("document.querySelector('#fixture-message').value"), '');
  await waitFor('old alternate watcher is closed', () => secondary.isDestroyed());
  assert.equal(await shell.executeJavaScript("document.querySelector('#search').value"), '');
  assert.ok(window.isVisible());
  await click(shell, '#back');
  await waitFor('Back returns to the selected account inbox after opening a notification', () =>
    !controller.chat && controller.inbox.getVisible() && controller.inbox.webContents.getURL() === origin + '/direct/inbox/');

  modal = await openSettingsDialog(controller);
  assert.equal(await modal.executeJavaScript(switchChecked), true, 'switching accounts keeps Work mode on');
  assert.equal(await modal.executeJavaScript("document.querySelector('#chat-outgoing-hex').value"), customColors.outgoing,
    'reopening settings discards unapplied colors');
  modal.focus();
  modal.debugger.attach();
  try {
    await modal.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
    });
  } catch (error) {
    // The closing renderer can detach before Chromium acknowledges the key press.
    if (!/target closed while handling command/i.test(error.message)) throw error;
  } finally {
    if (!modal.isDestroyed() && modal.debugger.isAttached()) modal.debugger.detach();
  }
  await waitForSettingsClosed(controller);
  assert.ok(window.isVisible(), 'Escape closes the modal and keeps the main window open');

  await waitFor('previously active account becomes monitored', () => remoteFor('default'));
  const previous = remoteFor('default');
  await waitForWatcherBaseline(previous, 'previously active account');
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
  await waitForWatcherBaseline(recovered, 'reconnected account');
  const recoveredBefore = notices.length;
  await update(recovered, 'incoming after background reconnect');
  await waitFor('notifications resume after reconnect', () => notices.length === recoveredBefore + 1);
  assertMasked(notices.at(-1), 'default');
  await closeWindow(window);

  const reopened = await createOnlyDM({ separateChatWindows: false, notify });
  await waitFor('reopened inbox', () => reopened.inbox.getVisible());
  modal = await openSettingsDialog(reopened);
  assert.equal(await modal.executeJavaScript(switchChecked), true, 'reopening OnlyDM restores Work mode');
  assert.equal(await modal.executeJavaScript("document.querySelector('#chat-theme').value"), 'custom',
    'reopening OnlyDM restores the theme');
  await toggleWorkMode(modal, false);
  assert.deepEqual(readSettings().chatColors, customColors, 'saving Work mode preserves the custom palette');
  await click(modal, '#settings-close');
  await waitForSettingsClosed(reopened);

  const offBefore = notices.length;
  const unmaskedPreview = 'private preview after disabling Work mode';
  await update(reopened.inbox.webContents, unmaskedPreview);
  await waitFor('alert arrives with Work mode off', () => notices.length === offBefore + 1);
  assertUnmasked(notices.at(-1), secondId, unmaskedPreview);
  assert.equal(readSettings().notificationPreviewEnabled, true, 'Work mode never changes the preview preference');

  modal = await openSettingsDialog(reopened);
  await togglePreference(modal, 'notificationPreviewEnabled', '#notification-preview-enabled', false);
  await click(modal, '#settings-close');
  await waitForSettingsClosed(reopened);
  const hiddenPreview = 'this exact private preview must not reach the notification';
  const hiddenBefore = notices.length;
  await update(reopened.inbox.webContents, hiddenPreview);
  await waitFor('disabled previews use the generic body', () => notices.length === hiddenBefore + 1);
  assertUnmasked(notices.at(-1), secondId, genericBody());

  await waitFor('reopened inactive account watcher', () => remoteFor('default'));
  const inactive = remoteFor('default');
  await waitForWatcherBaseline(inactive, 'reopened inactive account');
  modal = await openSettingsDialog(reopened);
  await togglePreference(modal, 'notificationsEnabled', '#notifications-enabled', false);
  assert.equal(await modal.executeJavaScript("document.querySelector('#notification-preview-enabled').disabled"), true);
  await click(modal, '#settings-close');
  await waitForSettingsClosed(reopened);
  const silentBefore = notices.length;
  const projected = profileId => projectionEvents.filter(event => event.profile === profileId && event.type === 'thread-notification').length;
  const activeBefore = projected(secondId), inactiveBefore = projected('default');
  await update(reopened.inbox.webContents, 'active account message with notifications disabled');
  await update(inactive, 'inactive account message with notifications disabled');
  await waitFor('both projections detect messages while notifications are disabled', () =>
    projected(secondId) > activeBefore && projected('default') > inactiveBefore);
  await delay(1200);
  assert.equal(notices.length, silentBefore, 'notifications off suppresses both active and inactive accounts');

  modal = await openSettingsDialog(reopened);
  await togglePreference(modal, 'notificationsEnabled', '#notifications-enabled', true);
  assert.equal(await modal.executeJavaScript("document.querySelector('#notification-preview-enabled').disabled"), false);
  assert.equal(await modal.executeJavaScript("document.querySelector('#notification-preview-enabled').checked"), false);
  await click(modal, '#settings-close');
  await waitForSettingsClosed(reopened);
  await delay(1200);
  assert.equal(notices.length, silentBefore, 'reenabling notifications does not replay suppressed messages');
  await update(reopened.inbox.webContents, 'new message after reenabling notifications');
  await waitFor('new notifications resume with previews still disabled', () => notices.length === silentBefore + 1);
  assertUnmasked(notices.at(-1), secondId, genericBody());

  modal = await openSettingsDialog(reopened);
  await togglePreference(modal, 'notificationPreviewEnabled', '#notification-preview-enabled', true);
  await click(modal, '#settings-close');
  await waitForSettingsClosed(reopened);
  const restoredPreview = 'exact preview after reenabling message previews';
  const restoredBefore = notices.length;
  await update(reopened.inbox.webContents, restoredPreview);
  await waitFor('reenabled previews deliver the exact message', () => notices.length === restoredBefore + 1);
  assertUnmasked(notices.at(-1), secondId, restoredPreview);

  // Seed only the synthetic inactive account's local store; its next alert reads that account's alias.
  const localBook = openContacts(root, { id: 'default', handle: 'fixture_main' });
  const alias = 'Fixture local alias';
  assert.equal(localBook.setRoomAlias(threadHref, alias), true);
  const aliasPreview = 'exact inactive message with a local room alias';
  const aliasBefore = notices.length;
  await update(inactive, aliasPreview);
  await waitFor('inactive notification uses its local alias', () => notices.length === aliasBefore + 1);
  assertUnmasked(notices.at(-1), 'default', aliasPreview, alias);
  assert.deepEqual([readSettings().notificationsEnabled, readSettings().notificationPreviewEnabled, readSettings().workModeEnabled],
    [true, true, false]);
  await closeWindow(reopened.window);
}
let finished = false;
const timer = setTimeout(() => finish(new Error('overall notification smoke timeout')), 90000);
async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  if (error) {
    console.error('OnlyDM all-account notification smoke failed:', error.message);
    const diagnostics = await Promise.race([
      Promise.all(webContents.getAllWebContents().filter(contents => !contents.isDestroyed() && bySession.has(contents.session))
        .map(async contents => {
          const profile = bySession.get(contents.session);
          try {
            const state = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `JSON.stringify({
              ready: document.readyState, visibility: document.visibilityState, now: performance.now(),
              polling: typeof window.__onlydmInboxRerun, ticks: window.__onlydmFixtureTicks,
              previewLength: document.querySelector('#preview')?.textContent.length,
              rows: [...document.querySelectorAll('div[role="button"][tabindex="0"]')].map(row => {
                const rect = row.getBoundingClientRect();
                return { width: rect.width, height: rect.height, avatar: !!row.querySelector('img') };
              })
            })` }]);
            return { profile, state: JSON.parse(state) };
          } catch (diagnosticError) { return { profile, error: diagnosticError.message }; }
        })),
      delay(2000).then(() => 'renderer diagnostics timed out'),
    ]);
    console.error('Notification fixture diagnostics: ' + JSON.stringify({ notices: notices.length, projectionEvents, renderers: diagnostics }));
  }
  else console.log('OnlyDM notification smoke passed: exact preview bodies, generic bodies without previews, Work mode masking, notifications off/on, local aliases, account routing, deduplication, reconnect, cleanup.');
  app.once('quit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
  app.exit(error ? 1 : 0);
}
exercise().then(() => finish(), finish);

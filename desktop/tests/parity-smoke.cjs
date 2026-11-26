'use strict';

require('./fixture-runtime.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog, ipcMain, session, webContents } = require('electron');
const { createOnlyDM } = require('../src/app.cjs');
const { openContacts } = require('../src/contacts.cjs');

const root = path.resolve(os.tmpdir());
const profile = fs.mkdtempSync(path.join(root, 'onlydm-parity-'));
app.setPath('userData', profile);
app.setPath('sessionData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND');
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({ language: 'en', chatTheme: 'custom',
  chatColors: { background: '#101418', incoming: '#303840', outgoing: '#4257C9' },
  appColors: { chrome: '#121212', background: '#101418' }, notificationsEnabled: true,
  notificationPreviewEnabled: true }), { mode: 0o600 });

const origin = 'https://www.instagram.com';
const people = [{ handle: 'alice_work', name: 'Alice Original' },
  { handle: 'bob_team', name: 'Bob Original' }, { handle: 'carol_home', name: 'Carol Original' }];
const avatar = handle => origin + '/fixture-avatar/' + handle + '.gif';
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const transactions = [], projectionEvents = [], notices = [], blocked = [], languageChanges = [];
const nativeMessages = [];
dialog.showMessageBox = async (_window, options) => {
  nativeMessages.push(options);
  return { response: 1 };
};
let sourceLanguage = 'ko';
const html = body => new Response('<!doctype html><html lang="' + sourceLanguage + '"><meta charset="utf-8"><link rel="icon" href="data:,">' + body,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
const row = (id, name, handles) => `<div id="source-${id}" role="button" tabindex="0" style="height:72px;width:300px">
  ${handles.map(handle => `<img src="${avatar(handle)}" width="40" height="40">`).join('')}
  <a href="/direct/t/${id}/"><span title="${name}">${name}</span></a>
  <span>${handles[0]}</span><span id="preview-${id}">Synthetic preview ${id}</span><span>1m</span></div>`;

function inboxPage() {
  return `<nav><a href="/fixture_main/">Profile</a></nav><input id="source-search" aria-label="Search Instagram">
  <button id="source-new-message"><svg aria-label="New message"></svg></button>
  <main id="source-rows">${row(101, people[0].name, ['alice_work'])}${row(102, 'Original group', ['bob_team', 'carol_home'])}</main>
  <script>
  document.querySelector('#source-new-message').onclick = () => {
    document.querySelector('#source-recipients')?.remove();
    const dialog = document.createElement('div'); dialog.id = 'source-recipients'; dialog.role = 'dialog';
    dialog.innerHTML = '<input id="source-recipient-search" aria-label="Search recipients"><div id="source-results"></div><button id="source-confirm" aria-disabled="true">Chat</button>';
    const selected = new Set(), history = ['open'];
    const people = ${JSON.stringify(people)};
    const input = dialog.querySelector('input'), results = dialog.querySelector('#source-results');
    function render() {
      results.replaceChildren();
      for (const person of people.filter(p => p.handle.includes(input.value))) {
        const label = document.createElement('label');
        label.setAttribute('role', 'option');
        label.innerHTML = '<img alt="User avatar" width="32" height="32" src="${origin}/fixture-avatar/' + person.handle + '.gif"><span dir="auto">' + person.name + '</span><span dir="auto">' + person.handle + '</span><input type="checkbox">';
        label.querySelector('input').checked = selected.has(person.handle);
        label.onclick = event => {
          event.preventDefault();
          if (selected.has(person.handle)) selected.delete(person.handle); else selected.add(person.handle);
          history.push('pick:' + person.handle);
          dialog.querySelector('#source-confirm').setAttribute('aria-disabled', String(!selected.size));
          render();
        };
        results.append(label);
      }
    }
    input.oninput = () => { history.push('search:' + input.value); render(); };
    dialog.querySelector('#source-confirm').onclick = async () => {
      if (!selected.size) return;
      const handles = [...selected]; history.push('confirm');
      await fetch('/fixture-create?data=' + encodeURIComponent(JSON.stringify({ handles, history })));
      if (handles.length > 1 && !document.querySelector('#source-103'))
        document.querySelector('#source-rows').insertAdjacentHTML('beforeend', ${JSON.stringify(row(103, 'New group', ['alice_work', 'bob_team']))});
      dialog.remove(); location.assign('/direct/t/' + (handles.length > 1 ? '103' : '101') + '/');
    };
    document.body.append(dialog); render();
  };
  </script>`;
}

function friendsPage() {
  return `<nav><a href="/fixture_main/">Profile</a><img alt="profile picture" src="${avatar('fixture_main')}"></nav>
    <div><span>3</span><a id="source-following" href="#following"><span>Following</span></a></div>
    <script>document.querySelector('#source-following').onclick = event => {
      event.preventDefault(); if (document.querySelector('#source-following-dialog')) return;
      const dialog = document.createElement('div'); dialog.role='dialog'; dialog.id='source-following-dialog';
      const rows = ${JSON.stringify(people.map(person => `<div style="width:300px;height:64px"><img src="${avatar(person.handle)}" width="32" height="32"><a href="/${person.handle}/">${person.handle}</a><a href="/${person.handle}/">${person.name}</a></div>`))};
      const scroller = document.createElement('div');
      scroller.style.cssText = 'width:320px;height:100px;overflow-y:auto';
      const list = document.createElement('div');
      list.style.cssText = 'position:relative;height:260px';
      const row = document.createElement('div');
      row.style.position = 'absolute';
      const show = page => { row.style.top = (page * 80) + 'px'; row.innerHTML = rows[page]; };
      let pending;
      scroller.addEventListener('scroll', () => {
        const page = Math.round(scroller.scrollTop / 80);
        clearTimeout(pending);
        // A fast second scroll cancels the delayed middle page of the virtual list.
        pending = setTimeout(() => show(page), page === 1 ? 1300 : 100);
      });
      show(0);
      list.append(row); scroller.append(list); dialog.append(scroller);
      document.body.append(dialog);
    };</script>`;
}

function chatPage(id) {
  const person = id === '101', title = person ? people[0].name : id === '102' ? 'Original group' : 'New group';
  return `<section id="source-conversation"><header>${person ? `<span id="source-person">${title}</span>` : `<h1>${title}</h1>`}
    <button id="source-voice"><svg aria-label="Audio call"></svg></button>
    <button id="source-video"><svg aria-label="Video call"></svg></button>
    <button id="source-info"><svg aria-label="Conversation information"></svg></button></header>
    <div data-pagelet="IGDMessagesList">
      <p>Synthetic history only</p>
      <div role="separator" id="source-unread-divider"><span>New messages</span></div>
      <div id="source-centered-divider" style="display:flex;justify-content:center"><span>New messages</span></div>
      <div role="row" style="display:flex;justify-content:center">
        <div role="presentation" style="background:#888"><span id="source-unread-quote">New messages</span></div>
      </div>
    </div>
    <form><textarea id="source-draft" placeholder="Message..." aria-label="Message..."></textarea>
    <button id="source-send" type="button" aria-label="Send">Send</button></form></section>
    <script>
    document.querySelector('#source-info').onclick = () => {
      const existing=document.querySelector('#source-info-panel'); if(existing) { existing.remove(); return; }
      const panel=document.createElement('aside'); panel.id='source-info-panel';
      panel.innerHTML=${JSON.stringify(`<h2>${title}</h2><div><a id="source-member" href="/alice_work/">${people[0].name}</a></div><button id="source-delete">Delete chat</button><button id="source-report">Report</button>`)};
      document.body.append(panel);
    };
    </script>`;
}

app.on('session-created', created => {
  created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, done) => {
    const approved = new URL(url).origin === origin;
    if (!approved) blocked.push(url);
    done({ cancel: !approved });
  });
  created.protocol.handle('https', async request => {
    const url = new URL(request.url);
    assert.equal(url.origin, origin, 'No request may escape the synthetic official origin');
    if (url.pathname.startsWith('/fixture-avatar/')) return new Response(gif, { headers: { 'content-type': 'image/gif' } });
    if (url.pathname === '/fixture-create') {
      transactions.push(JSON.parse(url.searchParams.get('data')));
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/accounts/language/') return html('<select id="source-language">'
      + '<option value="en"' + (sourceLanguage === 'en' ? ' selected' : '') + '>English</option>'
      + '<option value="ko"' + (sourceLanguage === 'ko' ? ' selected' : '') + '>한국어</option></select>'
      + '<script>document.querySelector("select").onchange=event=>fetch("/fixture-language?value="+event.target.value)</script>');
    if (url.pathname === '/fixture-language') {
      await delay(240);
      const chosen = url.searchParams.get('value');
      if (!request.signal.aborted && ['en', 'ko'].includes(chosen)) {
        sourceLanguage = chosen;
        languageChanges.push(chosen);
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }
    if (url.pathname === '/call/') return html('<title>Fixture Instagram call</title>');
    if (url.pathname === '/direct/inbox/') return html(inboxPage());
    if (url.pathname === '/accounts/login/') return html('<form><input id="fixture-login" aria-label="Username"></form>');
    if (url.pathname === '/fixture_main/') return html(friendsPage());
    const match = /^\/direct\/t\/(101|102|103)\/$/.exec(url.pathname);
    return match ? html(chatPage(match[1])) : new Response('', { status: 404 });
  });
});
const observe = (_event, message) => {
  if (['set-alias', 'friends-ready', 'friends-roster', 'chat-controls', 'thread-person', 'projection-error', 'friends-error'].includes(message?.type))
    projectionEvents.push({ type: message.type, stage: message.stage, message: message.message });
};
ipcMain.on('onlydm:projection', observe);

let controller, phase = 'startup';
const evaluate = (contents, code) => contents.executeJavaScript(code);
async function until(label, probe, milliseconds = 7000) {
  phase = label;
  const end = Date.now() + milliseconds;
  while (Date.now() < end) { const value = await probe(); if (value) return value; await delay(60); }
  throw new Error('Timed out: ' + label);
}
async function activate(contents, selector) {
  const owner = BrowserWindow.getAllWindows().find(window => window.webContents === contents
    || window.contentView.children.some(view => view.webContents === contents)) || controller.window;
  if (!owner.isVisible()) owner.show();
  if (process.platform === 'darwin' && !owner.isFocused()) app.focus({ steal: true });
  owner.focus();
  contents.focus();
  await until('native window/view focus for ' + selector, () => owner.isFocused() && contents.isFocused()
    && evaluate(contents, 'document.hasFocus()'));
}
async function click(contents, selector, counts = [1]) {
  if (!contents.getURL().startsWith('file:')) {
    // Exercise the real browser projection DOM; native header/checkbox input stays in the shell.
    await evaluate(contents, `(() => {const e=document.querySelector(${JSON.stringify(selector)});
      if(!e) throw new Error('Missing browser control'); e.click();
      ${counts.length > 1 ? "e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));" : ''} })()`);
    await delay(60);
    return;
  }
  await activate(contents, selector);
  const hit = await evaluate(contents, `(() => {
    if(!window.__parityClicks){window.__parityClicks=[]; document.addEventListener('click',event=>window.__parityClicks.push({x:event.clientX,y:event.clientY,trusted:event.isTrusted,target:event.target.className}),true);}
    const e=document.querySelector(${JSON.stringify(selector)}); if(!e) return null;
    e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect();
    const x=r.x+r.width/2,y=r.y+r.height/2; return {x,y,ok:r.width>0&&r.height>0&&e.contains(document.elementFromPoint(x,y))};
  })()`);
  assert.ok(hit?.ok, 'Native click target not hittable: ' + selector);
  const x = Math.round(hit.x * contents.getZoomFactor()), y = Math.round(hit.y * contents.getZoomFactor());
  console.log('Native click', JSON.stringify({selector,x,y,zoom:contents.getZoomFactor(),focused:contents.isFocused(),url:contents.getURL()}));
  for (const clickCount of counts) {
    contents.sendInputEvent({ type: 'mouseMove', x, y });
    contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount });
    contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount });
    await delay(60);
  }
}
async function edit(contents, selector, value, enter = false) {
  if (!contents.getURL().startsWith('file:')) {
    await evaluate(contents, `(() => {const e=document.querySelector(${JSON.stringify(selector)}); e.focus();
      if('value' in e)e.value=${JSON.stringify(value)}; else e.textContent=${JSON.stringify(value)};
      e.dispatchEvent(new Event('input',{bubbles:true})); ${enter ? "e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); e.blur(); e.dispatchEvent(new FocusEvent('blur'));" : ''} })()`);
    return;
  }
  await click(contents, selector);
  const target = JSON.stringify(selector);
  await until('native click focuses editable ' + selector, () => contents.isFocused() && evaluate(contents, `(() => {
    const field = document.querySelector(${target});
    if (!field || !document.hasFocus() || document.activeElement !== field) return false;
    // Select the field contents without depending on a platform keyboard shortcut.
    if (field instanceof HTMLInputElement && !field.disabled && !field.readOnly) field.select();
    else if (field.isContentEditable) document.getSelection().selectAllChildren(field);
    else return false;
    const edit = window.__parityEdit = { selector: ${target}, before: field.value ?? field.textContent };
    field.addEventListener('input', event => {
      if (event.isTrusted) edit.value = field.value ?? field.textContent;
    }, { once: true });
    if (${enter}) field.addEventListener('keydown', event => {
      edit.key = { key: event.key, trusted: event.isTrusted };
    }, { capture: true, once: true });
    return true;
  })()`));
  if (value) await contents.insertText(value);
  else contents.delete();
  await until('trusted edit of ' + selector + ' to ' + JSON.stringify(value), () => evaluate(contents,
    `window.__parityEdit.value === ${JSON.stringify(value)}`));
  if (!enter) return;
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
  contents.debugger.attach();
  try {
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key });
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    await until('trusted Enter keydown in ' + selector, () => evaluate(contents,
      "window.__parityEdit.key?.key === 'Enter' && window.__parityEdit.key.trusted"));
  } finally {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  }
}
async function assertIsolated(contents) {
  assert.deepEqual(await evaluate(contents, `['require','process','module','exports','Buffer','electron','ipcRenderer','onlydmHost','__onlydmBridge','onlydm']
    .filter(name=>typeof globalThis[name]!=='undefined')`), []);
}
const book = () => openContacts(profile, { id: 'default', handle: 'fixture_main' });
const header = () => controller.chatWindow?.webContents || controller.window.webContents;
async function chatAt(id) {
  await until('real ready chat ' + id, () => controller.chat?.getVisible()
    && new URL(controller.chat.webContents.getURL()).pathname === '/direct/t/' + id + '/'
    && evaluate(header(), "!document.querySelector('#chat-info').disabled"));
  await assertIsolated(controller.chat.webContents);
  assert.ok(await evaluate(header(),
    "['chat-voice','chat-video','chat-info'].every(id=>!document.getElementById(id).disabled)"));
}
async function back() {
  await click(header(), '#back');
  await until('back restores its originating list', () => controller.inbox.getVisible() || controller.friends?.getVisible());
  if (!controller.inbox.getVisible()) await click(controller.window.webContents, '#chats-icon');
  await until('back to projected inbox', () => controller.inbox.getVisible());
}

async function assertFriendsScale() {
  const view = controller.friends;
  const width = view.getBounds().width;
  const { viewport, avatar, row } = await until('Friends uses the zoomed-out source viewport', async () => {
    const layout = await evaluate(view.webContents, `({
      viewport: innerWidth,
      avatar: document.querySelector('.onlydm-friend .onlydm-avatar').getBoundingClientRect().width,
      row: document.querySelector('.onlydm-friend').getBoundingClientRect().height
    })`);
    return layout.viewport > width * 2 && layout;
  });
  // Convert the rendered CSS bounds back to desktop pixels using the actual viewport.
  const zoom = width / viewport;
  assert.ok(Math.abs(avatar * zoom - 44) < 1, `Friend avatar displayed at ${avatar * zoom}px instead of 44px`);
  assert.ok(Math.abs(row * zoom - 60) < 1, `Friend row displayed at ${row * zoom}px instead of 60px`);
}

async function exercise() {
  await app.whenReady();
  controller = await createOnlyDM({ notify: notice => notices.push(notice) });
  const shell = controller.window.webContents;
  await until('official synthetic inbox and own account', () => controller.inbox.getVisible()
    && evaluate(shell, "document.querySelector('#profiles').textContent.includes('fixture_main')"));
  assert.deepEqual(languageChanges, ['en'], 'startup must apply the selected app language through Instagram');
  assert.equal(await evaluate(controller.inbox.webContents, 'document.documentElement.lang'), 'en');
  await assertIsolated(controller.inbox.webContents);
  assert.equal(await evaluate(shell, 'typeof require'), 'undefined');
  await click(shell, '#friends-icon');
  await until('all three following rows harvested through real projection', () => controller.friends?.getVisible()
    && book().friends.length === 3
    && evaluate(controller.friends.webContents, "document.querySelectorAll('#OnlyDmFriends .onlydm-friend').length===3"), 12000);
  const friends = controller.friends.webContents;
  await assertIsolated(friends);
  assert.ok(projectionEvents.some(e => e.type === 'friends-roster'));
  await assertFriendsScale();
  for (const [query, handle] of [['bob_team', 'bob_team'], ['Alice Original', 'alice_work']]) {
    await edit(shell, '#search', query);
    await until('friend search ' + query, () => evaluate(friends,
      `document.querySelectorAll('.onlydm-friend').length === 1
        && !!document.querySelector('.onlydm-friend[data-handle="${handle}"]')`));
  }
  await edit(shell, '#search', '');
  await until('search cleared before profile click', () => evaluate(friends, "document.querySelectorAll('.onlydm-friend').length===3"));
  await click(friends, '.onlydm-friend[data-handle=alice_work]');
  await until('profile card', () => evaluate(friends, "!!document.querySelector('.onlydm-card-name[contenteditable=true]')"));
  await edit(friends, '.onlydm-card-name', 'Alice Local', true);
  await until('profile alias reaches actual private store and friend row', () => book().aliasFor('alice_work') === 'Alice Local'
    && evaluate(friends, "document.querySelector('.onlydm-friend[data-handle=alice_work] .onlydm-name').textContent==='Alice Local'"));
  await click(friends, '.onlydm-card-actions .primary');
  await chatAt('101');
  assert.ok(controller.chatWindow && controller.chatWindow !== controller.window, 'a real independent chat window opens');
  assert.ok(controller.friends.getVisible(), 'the main friends list stays visible while the separate chat is open');
  assert.equal(controller.inbox.webContents.getZoomMode(), 'isolated');
  assert.equal(controller.chat.webContents.getZoomMode(), 'isolated');
  const personThread = origin + '/direct/t/101/';
  assert.equal(book().handleForThread(personThread), null);
  await edit(header(), '#room-title', 'Alice Early', true);
  await until('rename persists while the other account is unknown', () => book().roomAlias(personThread) === 'Alice Early');
  await evaluate(controller.chat.webContents, `(() => {
    const name = document.querySelector('#source-person');
    const profileLink = document.createElement('a');
    profileLink.href = '/alice_work/';
    profileLink.textContent = name.textContent;
    name.replaceWith(profileLink);
  })()`);
  await until('late profile identity moves the room rename to the friend list', () => book().aliasFor('alice_work') === 'Alice Early'
    && evaluate(friends, "document.querySelector('.onlydm-friend[data-handle=alice_work] .onlydm-name').textContent==='Alice Early'"));
  assert.equal(book().roomAlias(personThread), null);
  await click(friends, '.onlydm-friend[data-handle=alice_work]');
  await until('profile card can edit the linked alias', () => evaluate(friends, "!!document.querySelector('.onlydm-card-name[contenteditable=true]')"));
  await edit(friends, '.onlydm-card-name', 'Alice Local', true);
  await until('friend alias reaches chat header', () => evaluate(header(), "document.querySelector('#room-title').textContent==='Alice Local'"));
  await edit(header(), '#room-title', 'Alice Header', true);
  await until('native Enter rename persists', () => book().aliasFor('alice_work') === 'Alice Header');
  await click(header(), '#chat-info');
  await until('real source info panel and local member alias', () => evaluate(controller.chat.webContents,
    "document.querySelector('#source-member')?.textContent==='Alice Header' && document.querySelector('#source-delete')?.getBoundingClientRect().width>0"));
  assert.equal(await evaluate(controller.chat.webContents, "getComputedStyle(document.querySelector('#source-report')).display"), 'none');
  await click(header(), '#chat-info');
  await edit(controller.chat.webContents, '#source-draft', 'Private unsent fixture draft');
  await back();
  await until('alias reaches actual inbox row', () => evaluate(controller.inbox.webContents,
    "document.querySelector('.onlydm-thread-row[data-href*=\"101\"] .onlydm-thread-title')?.textContent==='Alice Header'"));
  await click(controller.inbox.webContents, '.onlydm-thread-row[data-href*="101"]', [1, 2]);
  await chatAt('101');
  assert.equal(await evaluate(controller.chat.webContents, "document.querySelector('#source-draft').value"), 'Private unsent fixture draft');
  await edit(controller.chat.webContents, '#source-draft', '');
  await back();
  await click(shell, '#friends-icon');
  await until('cached roster and alias survive Back', () => controller.friends.getVisible()
    && evaluate(friends, "document.querySelector('.onlydm-friend[data-handle=alice_work] .onlydm-name').textContent==='Alice Header'"));
  assert.equal(book().friends.length, 3);
  await click(shell, '#chats-icon');

  for (const handles of [['alice_work'], ['alice_work', 'bob_team']]) {
    await click(shell, '#new-chat');
    await until('real shell recipient modal', () => evaluate(shell, "document.querySelector('#new-chat-dialog').open"));
    for (const handle of handles) {
      await edit(shell, '#new-chat-search', handle);
      await until('filtered actual checkbox ' + handle, () => evaluate(shell,
        `!!document.querySelector('#new-chat-roster input[value="${handle}"]')`));
      await click(shell, `#new-chat-roster input[value="${handle}"]`);
    }
    const beforeTransactions = transactions.length;
    await click(shell, '#new-chat-confirm');
    await until('Instagram recipient confirmation completes', () => transactions.length > beforeTransactions);
    await chatAt(handles.length === 1 ? '101' : '103');
    assert.deepEqual(transactions.at(-1)?.handles, handles);
    assert.ok(transactions.at(-1).history.includes('confirm'));
    for (const handle of handles) assert.ok(transactions.at(-1).history.includes('pick:' + handle));
    if (handles.length === 2) {
      await edit(header(), '#room-title', 'Local Group', true);
      await until('group-only room alias stored', () => book().roomAlias(origin + '/direct/t/103/') === 'Local Group');
    }
    await back();
  }
  await until('new group rename reaches projected list', () => evaluate(controller.inbox.webContents,
    "document.querySelector('.onlydm-thread-row[data-href*=\"103\"] .onlydm-thread-title')?.textContent==='Local Group'"));
  await controller.inbox.webContents.executeJavaScript("document.querySelector('#preview-101').textContent='Synthetic newly received notification'");
  await until('real inbox watcher notification uses local alias', () => notices.some(n => n.title.endsWith('Alice Header')), 9000);

  await click(controller.inbox.webContents, '.onlydm-thread-row[data-href*="101"]', [1, 2]);
  await chatAt('101');
  const firstWindow = controller.chatWindow;
  const languageChat = controller.chat.webContents;
  await edit(controller.chat.webContents, '#source-draft', 'Draft retained through room cleanup');
  await click(controller.inbox.webContents, '.onlydm-thread-row[data-href*="103"]', [1, 2]);
  await chatAt('103');
  const secondWindow = controller.chatWindow;
  assert.notEqual(firstWindow.id, secondWindow.id);
  assert.ok(firstWindow.isVisible() && secondWindow.isVisible(), 'two independent rooms remain visible together');
  assert.ok(controller.inbox.getVisible(), 'the main list stays available beside both rooms');
  assert.equal(controller.inbox.webContents.getZoomFactor(), 0.25);
  secondWindow.close();
  await until('native close hides and preserves the second room', () => !secondWindow.isVisible() && !secondWindow.isDestroyed());
  await click(controller.inbox.webContents, '.onlydm-thread-row[data-href*="103"]', [1, 2]);
  await chatAt('103');
  assert.equal(controller.chatWindow.id, secondWindow.id, 'reopening reuses the hidden native room');
  firstWindow.close();
  secondWindow.close();
  await click(controller.inbox.webContents, '.onlydm-thread-row[data-href*="102"]', [1, 2]);
  await chatAt('102');
  controller.chatWindow.close();
  await until('only two hidden room renderers are retained', () => controller.chatWindows.length === 2
    && controller.chatWindows.every(window => !window.isVisible()));
  assert.equal(firstWindow.isDestroyed(), false, 'cache cleanup must not close the oldest room when it contains a draft');
  await click(controller.inbox.webContents, '.onlydm-thread-row[data-href*="101"]', [1, 2]);
  await chatAt('101');
  assert.equal(controller.chatWindow.id, firstWindow.id);
  assert.equal(await evaluate(controller.chat.webContents, "document.querySelector('#source-draft').value"),
    'Draft retained through room cleanup');
  await edit(controller.chat.webContents, '#source-draft', '');
  await back();

  controller.window.setContentSize(350, 420);
  await until('350x420 viewport with native DPI rounding', () => evaluate(shell, 'innerWidth===350&&innerHeight>=420&&innerHeight<=424'));
  await click(shell, '#new-chat');
  await until('narrow modal', () => evaluate(shell, "document.querySelector('#new-chat-dialog').open"));
  const bounds = await evaluate(shell, `(() => {
    const ids=['new-chat-dialog','new-chat-search','new-chat-close','new-chat-confirm'];
    return ids.map(id=>{const r=document.getElementById(id).getBoundingClientRect();
      return {id,inside:r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1};}); })()`);
  assert.ok(bounds.every(b => b.inside), JSON.stringify(bounds));
  assert.equal(await evaluate(shell, "getComputedStyle(document.querySelector('#window-titlebar')).backgroundColor"), 'rgb(18, 18, 18)');
  await click(shell, '#new-chat-close');
  const openFixtureCall = async () => {
    const url = origin + '/call/';
    await evaluate(languageChat, 'void window.open(' + JSON.stringify(url) + ')');
    return until('native call loads its synthetic document', async () => {
      const call = BrowserWindow.getAllWindows().find(room => room.webContents.getURL() === url);
      return call && await evaluate(call.webContents, "document.title === 'Fixture Instagram call'") && call;
    });
  };
  const call = await openFixtureCall();
  assert.equal(call.getTitle(), 'OnlyDM Call');
  await click(shell, '#settings');
  await until('settings opens over the inbox for language selection', () => controller.inbox.getVisible()
    && controller.settingsContents && evaluate(controller.settingsContents, "document.querySelector('#settings-dialog').open"));
  let modal = controller.settingsContents;
  const chooseLanguage = lang => evaluate(modal, `(() => {
    const select = document.querySelector('#language');
    select.value = ${JSON.stringify(lang)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const readComposer = () => evaluate(languageChat, `(() => {
    const draft = document.querySelector('#source-draft');
    const send = document.querySelector('#source-send');
    return [draft.placeholder, draft.getAttribute('aria-label'), send.textContent, send.getAttribute('aria-label')];
  })()`);
  const englishComposer = ['Message…', 'Message…', 'Send', 'Send'];
  assert.deepEqual(await readComposer(), englishComposer);
  assert.deepEqual(await evaluate(modal, "[...document.querySelector('#language').options].map(option => option.value)"),
    ['auto', 'ko', 'en']);
  await edit(languageChat, '#source-draft', 'Synthetic unsent draft for locale checks');
  await evaluate(modal, "document.querySelector('#logout').click()");
  await until('English logout confirmation', () => nativeMessages.length === 1
    && evaluate(modal, "!document.querySelector('#logout').disabled"));
  assert.deepEqual(nativeMessages[0].buttons, ['Log out', 'Cancel']);
  assert.match(nativeMessages[0].message, /unsent messages/);
  await chooseLanguage('ko');
  await until('language uses the real Instagram language control and returns to the inbox', async () => languageChanges.includes('ko')
    && controller.inbox.getVisible() && new URL(controller.inbox.webContents.getURL()).pathname === '/direct/inbox/'
    && await evaluate(controller.inbox.webContents, "document.documentElement.lang==='ko'")
    && await evaluate(shell, "document.documentElement.lang==='ko'"));
  assert.equal(await evaluate(modal, "document.querySelector('#language-auto').textContent"), '시스템 기본값');
  assert.equal(await evaluate(firstWindow.webContents, "document.documentElement.lang"), 'ko');
  assert.deepEqual(await readComposer(), ['메시지 입력…', '메시지 입력…', '보내기', '보내기']);
  assert.equal(call.getTitle(), 'OnlyDM 통화', 'the open call title follows the app language');
  call.destroy();
  const reopenedCall = await openFixtureCall();
  assert.equal(reopenedCall.getTitle(), 'OnlyDM 통화', 'new call titles use the current language');
  reopenedCall.destroy();
  await evaluate(modal, "document.querySelector('#logout').click()");
  await until('Korean logout confirmation', () => nativeMessages.length === 2
    && evaluate(modal, "!document.querySelector('#logout').disabled"));
  assert.deepEqual(nativeMessages[1].buttons, ['로그아웃', '취소']);
  assert.match(nativeMessages[1].message, /보내지 않은 메시지/);
  assert.equal(await evaluate(languageChat, "document.querySelector('#source-draft').value"),
    'Synthetic unsent draft for locale checks');
  const readDividers = () => evaluate(languageChat,
    "['#source-unread-divider', '#source-centered-divider', '#source-unread-quote']"
      + ".map(selector => document.querySelector(selector).textContent.trim())");
  await until('the cached chat updates the unread labels without touching a message', async () =>
    JSON.stringify(await readDividers()) === JSON.stringify(['새 메시지', '새 메시지', 'New messages']));
  await evaluate(languageChat, "document.querySelector('#source-unread-divider span').firstChild.data = 'New messages'");
  await until('an unread divider recycled by the source is localized again', async () =>
    (await readDividers())[0] === '새 메시지');
  const previousInbox = controller.inbox.webContents;
  await evaluate(previousInbox, `(() => {
    for (const [id, value] of [[101, 'You: Keep this English message'], [102, 'You sent an attachment.']]) {
      const preview = document.querySelector('#preview-' + id);
      preview.previousElementSibling.remove();
      const time = document.createElement('abbr');
      time.setAttribute('aria-label', 'Fixture relative time');
      time.textContent = preview.nextElementSibling.textContent;
      preview.nextElementSibling.remove();
      const slot = document.createElement('span');
      slot.dir = 'auto';
      const frame = document.createElement('div');
      preview.before(frame);
      preview.textContent = value;
      slot.append(preview);
      frame.append(slot, time);
    }
  })()`);
  const previewText = id => evaluate(previousInbox,
    `document.querySelector('.onlydm-thread-row[data-href*="${id}"] .onlydm-thread-preview')?.textContent`);
  await until('Korean projection localizes sent labels and preserves the English message', async () =>
    await previewText(101) === '회원님: Keep this English message' && await previewText(102) === '회원님: 첨부 파일을 보냈습니다.');
  const unreadBadge = () => evaluate(previousInbox, "document.querySelector('.onlydm-chip-count')?.textContent");
  await evaluate(previousInbox, "document.querySelector('#preview-102').style.fontWeight = '600'");
  await until('unread changes update both the header and the chip', async () =>
    await unreadBadge() === '1' && await evaluate(shell, "document.querySelector('#hint').textContent.includes('안 읽음 1')"));
  for (const [source, expected] of [
    ['테스트사용자 sent an attachment.', '테스트사용자: 첨부 파일을 보냈습니다.'],
    ['테스트사용자 sent a photo.', '테스트사용자: 사진을 보냈습니다.'],
    ['테스트사용자 shared a reel.', '테스트사용자: 릴스를 보냈습니다.'],
    ['The person you asked about sent a photo.', 'The person you asked about sent a photo.'],
  ]) {
    await evaluate(previousInbox, `document.querySelector('#preview-102').textContent = ${JSON.stringify(source)}`);
    await until('Korean preview for ' + source, async () => await previewText(102) === expected);
  }
  await evaluate(previousInbox, "document.querySelector('#preview-102').style.fontWeight = '400'");
  await until('clearing unread updates the header without changing the total room count', async () =>
    await unreadBadge() === '' && await evaluate(shell, "!document.querySelector('#hint').textContent.includes('안 읽음')"));
  await click(modal, '#settings-close');
  await until('settings closes before opening the Friends view', () => !controller.settingsContents);
  await click(shell, '#friends-icon');
  await until('Korean Friends view shows the current roster', () => controller.friends?.getVisible()
    && evaluate(controller.friends.webContents, "document.querySelector('#OnlyDmFriends .onlydm-friend[data-handle=alice_work]') !== null"));
  const openFriends = controller.friends.webContents;
  const friendsViewId = openFriends.id;
  await edit(shell, '#search', 'alice_work');
  await until('filtered Friends list', () => evaluate(openFriends, "document.querySelectorAll('.onlydm-friend').length === 1"));
  await click(openFriends, '.onlydm-friend[data-handle=alice_work]');
  await until('friend card opens in Korean', () => evaluate(openFriends, "document.querySelector('.onlydm-card-actions .primary')?.textContent === '1:1 채팅'"));
  await click(shell, '#settings');
  await until('settings opens above the Friends view', () => controller.settingsContents
    && evaluate(controller.settingsContents, "document.querySelector('#settings-dialog').open"));
  modal = controller.settingsContents;
  await chooseLanguage('en');
  await until('language returns to English while the cached chat and Friends view stay open', async () => languageChanges.at(-1) === 'en'
    && controller.inbox.webContents.getURL() === origin + '/direct/inbox/'
    && controller.friends?.getVisible() && await evaluate(controller.friends.webContents, "document.querySelector('#OnlyDmFriends')?.lang === 'en'")
    && await evaluate(firstWindow.webContents, "document.documentElement.lang === 'en'"));
  assert.equal(controller.friends.webContents.id, friendsViewId, 'locale refresh retains the Friends renderer');
  await assertFriendsScale();
  assert.deepEqual(await evaluate(openFriends, `[
    document.querySelector('.onlydm-card-actions .primary')?.textContent,
    document.querySelector('.onlydm-card-name')?.textContent,
    document.querySelectorAll('.onlydm-friend').length
  ]`), ['Chat', 'Alice Header', 1]);
  assert.deepEqual(await readComposer(), englishComposer);
  assert.equal(await evaluate(languageChat, "document.querySelector('#source-draft').value"),
    'Synthetic unsent draft for locale checks');
  await edit(languageChat, '#source-draft', '');
  await evaluate(previousInbox, "localStorage.setItem('onlydm-synthetic-logout-check','fixture-only-data')");
  await click(modal, '#logout');
  await until('logout disposes all rooms and replaces the inbox', () => previousInbox.isDestroyed()
    && controller.chatWindows.length === 0 && controller.inbox.getVisible());
  assert.equal(await evaluate(controller.inbox.webContents, "localStorage.getItem('onlydm-synthetic-logout-check')"), null);
  assert.equal(book().aliasFor('alice_work'), 'Alice Header', 'logout retains local presentation preferences');
  await click(shell, '#new-chat');
  await until('recipient picker before session expiry', () => evaluate(shell, "document.querySelector('#new-chat-dialog').open"));
  await controller.inbox.webContents.loadURL(origin + '/accounts/login/');
  await until('inbox requires sign-in while the picker is open', () => evaluate(shell,
    "document.body.dataset.pane === 'login' && document.querySelector('#new-chat-dialog').open"));
  await click(shell, '#new-chat-close');
  await until('sign-in becomes accessible after closing the recipient picker', () => controller.inbox.getVisible()
    && evaluate(shell, "!document.querySelector('#new-chat-dialog').open"));
  assert.equal(projectionEvents.filter(e => /error/.test(e.type)).length, 0, JSON.stringify(projectionEvents));
  assert.deepEqual(blocked, []);
}

let finishing = false;
const deadline = setTimeout(() => finish(new Error('60-second parity fixture deadline')), 60000);
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  ipcMain.removeListener('onlydm:projection', observe);
  if (error) {
    if (controller && !controller.window.isDestroyed()) {
      fs.writeFileSync(path.resolve(__dirname, '../../../parity-smoke-worker-failure.png'),
        (await controller.window.capturePage()).toPNG());
      console.error('Views', JSON.stringify(controller.window.contentView.children.filter(view=>view.webContents).map(view=>({
        url:view.webContents.getURL(),visible:view.getVisible(),bounds:view.getBounds(),focused:view.webContents.isFocused()}))));
    }
    console.error('OnlyDM parity smoke failed at ' + phase + ':', error.stack || error);
    const diagnostics = await Promise.all(webContents.getAllWebContents().map(async contents => {
      try { return { url: contents.getURL(), state: await Promise.race([evaluate(contents,
        `({
          pane: document.body?.dataset.pane, title: document.querySelector('#room-title')?.textContent,
          focused: document.hasFocus(), active: document.activeElement?.id,
          search: document.querySelector('#search')?.value, edit: window.__parityEdit, clicks: window.__parityClicks,
          friends: document.querySelectorAll('.onlydm-friend').length,
          friendRect: document.querySelector('.onlydm-friend')?.getBoundingClientRect().toJSON(),
          viewport: [innerWidth, innerHeight, devicePixelRatio], sourceRows: document.querySelectorAll('[role=button]').length,
          text: document.body?.innerText.slice(0, 800)
        })`),
      delay(700).then(() => 'no renderer response')]) }; } catch { return {}; }
    }));
    console.error(JSON.stringify({ diagnostics, projectionEvents, transactions }));
  } else console.log('OnlyDM parity smoke passed: friends/search, native room windows/aliases/drafts, late profile identity, 1:1 and group recipients, small dialogs, expired sessions, EN/KO composer and friend card refresh, native titles and prompts, localized previews, synchronized unread counts and logout.');
  app.once('quit', () => {
    assert.equal(path.dirname(profile), root);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium can still hold disposable fixture files during shutdown. */ }
  });
  app.exit(error ? 1 : 0);
}
exercise().then(() => finish(), finish);

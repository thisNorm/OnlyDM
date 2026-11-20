'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const colors = require('../src/colors.js');
const html = readFileSync(join(__dirname, '../src/shell.html'), 'utf8');
const source = readFileSync(join(__dirname, '../src/shell.js'), 'utf8');

// This checks shell event/state behavior; native focus, layout and view layering need Electron.
function fixture() {
  const elements = new Map();
  let document;
  class Element {
    constructor(tag = 'div', id = '') {
      this.tagName = tag.toUpperCase(); this.id = id;
      this.children = []; this.listeners = new Map(); this.attributes = new Map();
      this.value = ''; this._text = ''; this.hidden = false; this.disabled = false;
      this.dataset = {}; this.open = false; this.checked = false;
      this.style = { setProperty() {} };
      this.classes = new Set();
      this.classList = { toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name) };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
    set innerHTML(_) { throw new Error('Shell must render user text through textContent'); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    emit(type, values = {}) {
      const event = { target: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...values };
      for (const listener of this.listeners.get(type) || []) listener(event);
      return event;
    }
    click() { if (!this.disabled) this.emit('click'); }
    focus() {
      if (document.activeElement === this) return;
      document.activeElement?.blur(); document.activeElement = this; this.emit('focus');
    }
    blur() { if (document.activeElement === this) document.activeElement = null; this.emit('blur'); }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { this.children = []; this._text = ''; this.append(...children); }
    remove() { this.parentElement.children = this.parentElement.children.filter(child => child !== this); }
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(selector.split(',').includes(child.tagName.toLowerCase()) ? [child] : []), ...child.querySelectorAll(selector),
      ]);
    }
    closest() { return ['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) || this.contentEditable === 'plaintext-only' ? this : null; }
    showModal() { assert.equal(this.open, false); this.open = true; this.openCalls = (this.openCalls || 0) + 1; }
    close() { assert.equal(this.open, true); this.open = false; this.closeCalls = (this.closeCalls || 0) + 1; }
  }
  for (const [, tag, attributes, id] of html.matchAll(/<([a-z][a-z0-9-]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(tag, id);
    element.hidden = /\shidden(?:\s|>)/.test(attributes + '>');
    elements.set(id, element);
  }
  document = new Element('document');
  document.documentElement = new Element('html'); document.body = new Element('body');
  document.querySelector = selector => {
    assert.ok(elements.has(selector.slice(1)), 'Known shell selector: ' + selector);
    return elements.get(selector.slice(1));
  };
  document.createElement = tag => new Element(tag);
  document.querySelectorAll = selector => {
    if (selector.startsWith('#')) {
      const [id, descendants] = selector.split(' ');
      return document.querySelector(id).querySelectorAll(descendants);
    }
    if (selector.startsWith('[')) return [];
    return [...new Set([...elements.values()].flatMap(element => [
      ...(selector.split(',').includes(element.tagName.toLowerCase()) ? [element] : []), ...element.querySelectorAll(selector),
    ]))];
  };
  elements.get('search').parentElement = new Element('div');
  elements.get('color-target').value = 'app:chrome';
  const calls = [];
  let render;
  const methods = ['back', 'retry', 'settings', 'setWorkMode', 'setChatTheme', 'update', 'search', 'selectProfile', 'addProfile',
    'linkedProfile', 'showChats', 'showFriends', 'newChat', 'createChat', 'chatAction', 'renameChat', 'setPreference', 'autoStart', 'logout', 'hide'];
  const onlydm = Object.fromEntries(methods.map(method => [method, (...args) => calls.push([method, ...args])]));
  onlydm.onState = listener => { render = listener; };
  runInNewContext(source, { document, navigator: { language: 'en-US' }, window: { onlydm, onlydmColors: colors },
    Option: function (label, id) { const option = new Element('option'); option.textContent = label; option.value = id; return option; } });
  let state = { lang: 'en', pane: 'inbox', title: 'Chats', platform: 'linux', activeProfileId: 'main', profiles: [{ id: 'main', label: 'Main' }],
    chatTheme: 'system', chatColors: colors.chatDefaults, appColors: colors.appDefaults, roster: [], labels: {} };
  const update = patch => { state = { ...state, ...patch }; render(state); };
  update({});
  return { get: id => elements.get(id), calls, update, document };
}

test('rail and header actions follow panes, host control availability, and maintenance state', () => {
  const f = fixture();
  f.get('chats-icon').click(); f.get('friends-icon').click(); f.get('new-chat').click();
  assert.deepEqual(f.calls, [['showChats'], ['showFriends'], ['newChat', true]]);
  f.update({ pane: 'friends', title: 'Friends', query: 'local alias' });
  assert.equal(f.get('nav-rail').hidden, false);
  assert.equal(f.get('friends-icon').getAttribute('aria-pressed'), 'true');
  assert.equal(f.get('search').value, 'local alias');
  for (const pane of ['login', 'chat']) {
    f.update({ pane });
    assert.equal(f.get('nav-rail').hidden, true);
    assert.equal(f.get('new-chat').hidden, true);
    assert.equal(f.get('search').parentElement.hidden, true);
  }
  f.update({ chatControls: { voice: true, video: false, info: true } });
  for (const action of ['voice', 'video', 'info']) f.get('chat-' + action).click();
  assert.deepEqual(f.calls.slice(-2), [['chatAction', 'voice'], ['chatAction', 'info']]);
  f.update({ updating: true, updateAvailable: { version: '9.9.9' } });
  assert.equal(f.get('chat-voice').disabled, true);
  assert.equal(f.get('update').disabled, true);
  f.update({ updating: false });
  assert.equal(f.get('chat-video').disabled, true);
  assert.equal(f.get('chat-voice').disabled, false);
  f.get('update').click();
  assert.deepEqual(f.calls.at(-1), ['update']);
});

test('friend picker searches names, @handles and local shown aliases while preserving selection', () => {
  const f = fixture();
  const roster = [{ handle: 'alice', name: '<img onerror=attack()>', shown: '우리 팀', avatar: 'javascript:attack()' },
    { handle: 'bob', name: 'Bob', avatar: 'https://example.test/avatar.png' }];
  f.update({ newChatOpen: true, roster });
  assert.equal(f.get('new-chat-dialog').openCalls, 1);
  assert.equal(f.document.activeElement, f.get('new-chat-search'));
  const search = value => { f.get('new-chat-search').value = value; f.get('new-chat-search').emit('input'); };
  search('우리');
  let row = f.get('new-chat-roster').children[0];
  assert.equal(row.children[1].children[0].textContent, '우리 팀');
  assert.equal(row.children[0].children.length, 0);
  row.children[2].checked = true; row.children[2].emit('change');
  search('@BoB');
  assert.equal(f.get('new-chat-roster').children.length, 1);
  assert.equal(f.get('new-chat-roster').children[0].children[1].children[1].textContent, '@bob');
  search('onerror');
  assert.equal(f.get('new-chat-roster').children.length, 1);
  search('absent');
  assert.equal(f.get('new-chat-empty').textContent, 'No friends found.');
  assert.equal(f.get('new-chat-count').textContent, '1 selected');
  f.update({});
  assert.equal(f.get('new-chat-count').textContent, '1 selected');
  assert.equal(f.get('new-chat-dialog').openCalls, 1);
  f.get('new-chat-form').emit('submit'); f.get('new-chat-form').emit('submit');
  assert.equal(f.calls.filter(call => call[0] === 'createChat').length, 1);
  assert.deepEqual(Array.from(f.calls.at(-1)[1]), ['alice']);
  f.update({ newChatBusy: true, newChatOpen: false });
  assert.equal(f.get('new-chat-dialog').closeCalls, 1);
  f.update({ newChatBusy: false, newChatOpen: true, lang: 'ko' });
  assert.equal(f.get('new-chat-count').textContent, '0명 선택');
  assert.equal(f.get('new-chat-confirm').disabled, true);
  assert.equal(f.get('new-chat-search').value, '');
});

test('picker drops unavailable selections and uses plain text for hostile names', () => {
  const f = fixture();
  f.update({ newChatOpen: true, roster: [{ handle: 'literal', name: '<svg onload=attack()>' }] });
  const row = f.get('new-chat-roster').children[0];
  assert.equal(row.children[1].children[0].textContent, '<svg onload=attack()>');
  row.children[2].checked = true; row.children[2].emit('change');
  f.update({ roster: [] });
  assert.equal(f.get('new-chat-count').textContent, '0 selected');
  assert.equal(f.get('new-chat-confirm').disabled, true);
});

test('native Escape owns modal dismissal, syncs the host once, and never hides the shell', () => {
  const f = fixture();
  f.update({ settingsOpen: true, newChatOpen: true });
  const escape = target => f.document.emit('keydown', { key: 'Escape', target });
  assert.equal(escape(f.get('new-chat-cancel')).defaultPrevented, false);
  assert.equal(f.calls.length, 0);
  const cancel = f.get('new-chat-dialog').emit('cancel');
  assert.equal(cancel.defaultPrevented, false);
  assert.equal(f.calls.length, 0);
  // The browser's uncancelled default action closes the top dialog, then emits close.
  f.get('new-chat-dialog').close(); f.get('new-chat-dialog').emit('close');
  assert.deepEqual(f.calls.at(-1), ['newChat', false]);
  f.update({ newChatOpen: false });
  assert.equal(f.get('new-chat-dialog').closeCalls, 1);
  assert.equal(escape(f.get('settings-close')).defaultPrevented, false);
  assert.equal(f.calls.length, 1);
  assert.equal(f.get('settings-dialog').emit('cancel').defaultPrevented, false);
  f.get('settings-dialog').close(); f.get('settings-dialog').emit('close');
  assert.deepEqual(f.calls.at(-1), ['settings', false]);
  assert.equal(escape(f.document.body).defaultPrevented, false);
  assert.equal(f.calls.length, 2);
  f.update({ settingsOpen: false });
  // A host-driven close must not echo another close request back to the host.
  f.update({ settingsOpen: true }); f.update({ settingsOpen: false });
  f.get('settings-dialog').emit('close');
  assert.equal(f.calls.length, 2);
  f.update({ newChatOpen: true });
  assert.equal(escape(f.get('new-chat-search')).defaultPrevented, false);
  f.get('new-chat-dialog').close(); f.get('new-chat-dialog').emit('close');
  assert.deepEqual(f.calls.at(-1), ['newChat', false]);
  assert.equal(escape(f.document.body).defaultPrevented, false);
  f.update({ newChatOpen: false });
  const count = f.calls.length;
  assert.equal(escape(f.get('search')).defaultPrevented, false);
  assert.equal(f.calls.length, count);
  assert.equal(escape(f.document.body).defaultPrevented, true);
  assert.deepEqual(f.calls.at(-1), ['hide']);
});

test('ordinary keys remain native and Back still works after a cached chat is reopened', () => {
  const f = fixture();
  for (const settingsOpen of [false, true]) {
    f.update({ settingsOpen });
    for (const target of [f.document.body, f.get('search'), f.get('settings-close')]) {
      for (const key of ['a', '가', 'Enter', 'Tab', 'Backspace', 'ArrowLeft'])
        assert.equal(f.document.emit('keydown', { key, target }).defaultPrevented, false);
    }
  }
  assert.equal(f.calls.length, 0);
  f.update({ settingsOpen: false, pane: 'chat', title: 'Cached chat', chatRenameEnabled: true });
  assert.equal(f.get('back').hidden, false); f.get('back').click();
  f.update({ pane: 'inbox', title: 'Chats' });
  assert.equal(f.get('back').hidden, true);
  f.update({ pane: 'chat', title: 'Cached chat' });
  assert.equal(f.get('back').hidden, false); f.get('back').click();
  assert.deepEqual(f.calls, [['back'], ['back']]);
});

test('existing room-title supports plain local rename with Enter, blur, Escape and Korean composition', () => {
  const f = fixture();
  const title = f.get('room-title');
  f.update({ pane: 'chat', title: 'Original', chatRenameEnabled: true });
  assert.equal(title.contentEditable, 'plaintext-only');
  title.focus(); title.textContent = '  우리   팀  ';
  f.update({ chatControls: { info: true } });
  assert.equal(title.textContent, '  우리   팀  ');
  title.emit('keydown', { key: 'Enter', isComposing: true });
  assert.equal(f.calls.length, 0);
  title.emit('keydown', { key: 'Enter' });
  assert.deepEqual(f.calls.at(-1), ['renameChat', '우리 팀']);
  f.update({ title: '우리 팀' });
  title.focus(); title.textContent = 'Discard'; title.emit('keydown', { key: 'Escape' });
  assert.equal(title.textContent, '우리 팀');
  assert.equal(f.calls.length, 1);
  title.focus(); title.textContent = 'Blur name'; title.blur();
  assert.deepEqual(f.calls.at(-1), ['renameChat', 'Blur name']);
  f.update({ title: 'Blur name' });
  title.focus(); title.textContent = '   '; title.blur();
  assert.equal(title.textContent, 'Blur name');
  assert.deepEqual(f.calls.at(-1), ['renameChat', '']);
  assert.equal(f.calls.length, 3);
  f.update({ title: 'Original' });
  assert.equal(title.textContent, 'Original');
  title.focus(); title.textContent = ''; title.emit('keydown', { key: 'Escape' });
  assert.equal(title.textContent, 'Original');
  assert.equal(f.calls.length, 3);
  title.focus(); title.textContent = ''; title.emit('keydown', { key: 'Enter' });
  assert.equal(title.textContent, 'Original');
  assert.deepEqual(f.calls.at(-1), ['renameChat', '']);
  assert.equal(f.calls.length, 4);
  title.focus(); title.textContent = 'Original'; title.blur();
  assert.equal(f.calls.length, 4);
  title.focus(); title.textContent = 'Must not cross panes';
  f.update({ pane: 'inbox', title: 'Chats' }); title.blur();
  assert.equal(f.calls.length, 4);
  assert.equal(title.contentEditable, 'false');
});

test('settings wire preference keys, defaults, Korean fallback, autostart, logout and existing appearance', () => {
  const f = fixture();
  assert.equal(f.get('notifications-enabled').checked, true);
  assert.equal(f.get('notification-preview-enabled').checked, true);
  f.update({ lang: 'ko', settingsOpen: true, language: 'auto' });
  assert.equal(f.get('language-label').textContent, '언어');
  f.get('language').value = 'en'; f.get('language').emit('change');
  for (const id of ['notifications-enabled', 'notification-preview-enabled', 'start-in-tray']) {
    f.get(id).checked = true; f.get(id).emit('change');
  }
  f.get('auto-start').checked = true; f.get('auto-start').emit('change'); f.get('logout').click();
  assert.deepEqual(f.calls, [['setPreference', 'language', 'en'], ['setPreference', 'notificationsEnabled', true],
    ['setPreference', 'notificationPreviewEnabled', true], ['setPreference', 'startInTray', true], ['autoStart', true], ['logout']]);
  f.update({ notificationsEnabled: false, language: 'ko', autoStart: true, updateAvailable: { version: '9.9.9' } });
  assert.equal(f.get('notification-preview-enabled').disabled, true);
  assert.equal(f.get('language').value, 'ko');
  assert.equal(f.get('auto-start').checked, true);
  assert.equal(f.get('update').hidden, false);
  f.get('chat-theme').value = 'light'; f.get('chat-theme').emit('change'); f.get('chat-theme-apply').click();
  assert.equal(f.calls.at(-1)[0], 'setChatTheme');
  assert.equal(f.calls.at(-1)[1], 'light');
  f.update({ updating: true });
  assert.equal(f.get('chat-theme-apply').disabled, true);
  f.update({ settingsOpen: false });
  assert.equal(f.get('settings-dialog').closeCalls, 1);
});

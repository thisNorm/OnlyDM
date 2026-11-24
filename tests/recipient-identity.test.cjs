'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { setImmediate: flush } = require('node:timers/promises');
const source = fs.readFileSync(path.join(__dirname, '../src/OnlyDM/WebViewScripts.cs'), 'utf8');
const start = source.indexOf('  function normaliseHandle(value)');
const end = source.indexOf('  // Instagram decides one-to-one', start);
assert.ok(start > 0 && end > start);

function selection() {
  const scope = { URL, location: { origin: 'https://www.instagram.com' }, textLines: node => node.lines || [] };
  vm.runInNewContext(source.slice(start, end) + ';globalThis.score=recipientScore;globalThis.normalize=normaliseHandle;', scope);
  return scope;
}

function avatar(lines, links = [], avatars = 1) {
  const row = { parentElement: null, lines, textContent: lines.join(' '),
    querySelectorAll(selector) {
      if (selector === 'img') return Array(avatars).fill({});
      if (selector === 'a[href]') return links.map(href => ({ getAttribute: () => href }));
      throw new Error('Unexpected selector');
    } };
  return { parentElement: row };
}

test('recipient usernames preserve dots and underscores and reject partial names', () => {
  const s = selection();
  assert.notEqual(s.normalize('a.bc'), s.normalize('ab.c'));
  assert.notEqual(s.normalize('a_bc'), s.normalize('ab_c'));
  assert.equal(s.normalize('@ALICE_work'), 'alice_work');
  assert.equal(s.score(avatar(['Alice Original', 'a.bc']), 'a.bc'), 3);
  assert.equal(s.score(avatar(['Alice Original', 'ab.c']), 'a.bc'), 0);
  assert.equal(s.score(avatar(['Alice Original', 'a.bc_more']), 'a.bc'), 0);
});

test('an official profile link outranks a display name and conflicting identities fail closed', () => {
  const s = selection();
  assert.equal(s.score(avatar(['a.bc', 'Different User'], ['/ab.c/']), 'a.bc'), 0);
  assert.equal(s.score(avatar(['ab.c', 'a.bc'], ['/a.bc/']), 'a.bc'), 3);
  assert.equal(s.score(avatar(['Display name'], ['/a.bc/', '/ab.c/']), 'a.bc'), 0);
  assert.equal(s.score(avatar(['a.bc', 'ab.c']), 'a.bc'), 0);
  assert.equal(s.score(avatar(['a.bc'], [], 2), 'a.bc'), 0);
});

function option(name, username) {
  const result = avatar([name, username]);
  const row = result.parentElement;
  const select = row.querySelectorAll;
  row.querySelectorAll = selector => selector === 'span[dir]'
    ? [name, username].map(textContent => ({ textContent })) : select(selector);
  result.closest = selector => selector === '[role="option"]' ? row : null;
  return result;
}

test('official option rows identify the username in the second display field', () => {
  const s = selection();
  assert.equal(s.score(option('Alice', 'a.bc'), 'a.bc'), 3);
  assert.equal(s.score(option('a.bc', 'ab.c'), 'a.bc'), 0);
});

test('failed friend handle lookup uses recipient selection without display-name routing', async () => {
  const first = source.indexOf('  async function openFriend(name, handle)');
  const last = source.indexOf('  function openSelectedThread()', first);
  assert.ok(first > 0 && last > first);
  const calls = [];
  const scope = { opening: false, openingKey: '', nfc: value => value.normalize('NFC'),
    renderThreadList() {}, finishOpening() { calls.push('finished'); },
    openFriendViaSearch: async handle => { calls.push(['handle', handle]); return false; },
    startNewChat: async (handle, name) => { calls.push(['recipient', handle, name]); },
    findSourceRow: () => assert.fail('a display name cannot identify a room'),
    reportProjectionError: (...args) => assert.fail(JSON.stringify(args)) };
  vm.runInNewContext(source.slice(first, last) + ';globalThis.open=openFriend;', scope);
  await scope.open('Alex', 'a.bc');
  assert.deepEqual(calls, [['handle', 'a.bc'], ['recipient', 'a.bc', 'Alex'], 'finished']);
});

function recipientDialogFixture(t, { inputDelay = 0 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const origin = 'https://www.instagram.com';
  const selected = [];
  const messages = [];
  const listeners = new Set();
  let live = null;

  class Input {
    get value() { return this.text || ''; }
    set value(value) { this.text = value; }
    focus() {}
    dispatchEvent(event) {
      if (event.type === 'input' && event.bubbles && this === live?.input) live.query = this.value;
    }
  }

  function mount(withInput) {
    const dialog = {
      input: withInput ? new Input() : null,
      query: '',
      querySelector(selector) {
        assert.match(selector, /^input, textarea/);
        return dialog.input;
      },
      querySelectorAll(selector) {
        if (selector.startsWith('img[alt')) {
          if (!dialog.query) return [];
          return [['a.bc', 'ab.c'], ['Alex', 'a.bc'], ['Dev', 'dev_x']].map(([name, username]) => {
            const result = option(name, username);
            result.click = result.parentElement.click = () => {
              if (dialog !== live) return;
              selected.push(username);
              mount(true); // The official composer replaces both the dialog and its input.
            };
            return result;
          });
        }
        assert.equal(selector, '[role="button"], button');
        return [{
          textContent: 'Chat',
          getAttribute: name => name === 'aria-disabled' && !selected.length ? 'true' : null,
          click() {
            if (dialog !== live || !selected.length) return;
            live = null;
            const href = origin + '/direct/t/' + (selected.length === 1 ? '101' : '404');
            for (const listener of listeners) listener({ data: { type: 'thread-route', href } });
          },
        }];
      },
    };
    live = dialog;
  }

  const compose = { click() {
    mount(!inputDelay);
    if (inputDelay) setTimeout(() => mount(true), inputDelay);
  } };
  const shell = { id: 'OnlyDmShell', querySelector: () => null };
  const document = {
    readyState: 'loading',
    body: { children: [shell] },
    addEventListener() {},
    getElementById: () => shell,
    querySelector(selector) {
      if (selector.includes('svg[aria-label')) return { closest: () => compose };
      if (selector === 'div[role="dialog"]') return live;
      if (selector === 'div[role="dialog"] input') return live?.input;
      throw new Error('Unexpected document selector: ' + selector);
    },
    querySelectorAll(selector) {
      if (['input', 'a[href^="/"]', 'div[role="button"][tabindex="0"]'].includes(selector)) return [];
      throw new Error('Unexpected document selector: ' + selector);
    },
  };
  const context = {
    document, URL, Event, HTMLInputElement: Input, setTimeout,
    location: { origin, pathname: '/direct/inbox/' },
    chrome: { webview: {
      postMessage: message => messages.push(message),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    } },
  };
  context.window = context;
  const marker = 'return $$"""';
  const from = source.indexOf(marker, source.indexOf('public static string BuildInboxScript('));
  const to = source.indexOf('""";', from + marker.length);
  assert.ok(from >= 0 && to > from, 'locate the actual inbox script');
  const script = source.slice(from + marker.length, to)
    .replaceAll('{{paletteJson}}', '{}')
    .replaceAll('{{localeJson}}', '"ko"')
    .replaceAll('{{uiJson}}', '{}')
    .replaceAll('{{shellScale}}', '1')
    .replaceAll('{{JsonSerializer.Serialize(notificationsOnly)}}', 'false')
    .replace(/\}\)\(\);\s*$/, 'globalThis.composeFixture = { openFriend, startRoom }; })();');
  vm.runInNewContext(script, context, { filename: 'WebViewScripts.BuildInboxScript.js' });

  return {
    async open(action, ...args) {
      let done = false;
      const pending = context.composeFixture[action](...args);
      const settle = () => { done = true; };
      pending.then(settle, settle);
      for (let elapsed = 0; !done && elapsed < 18000; elapsed += 50) {
        t.mock.timers.tick(50);
        await flush();
      }
      assert.ok(done, 'the recipient flow finished');
      await pending;
      return {
        selected,
        opened: messages.filter(message => message.type === 'open-thread').map(message => message.href),
        errors: messages.filter(message => message.type === 'projection-error').map(message => message.message),
      };
    },
  };
}

test('single-recipient selection waits for the search field inside a newly mounted dialog', async (t) => {
  const fixture = recipientDialogFixture(t, { inputDelay: 350 });
  assert.deepEqual(await fixture.open('openFriend', 'Alex', 'a.bc'), {
    selected: ['a.bc'], opened: ['https://www.instagram.com/direct/t/101'], errors: [],
  });
});

test('single-recipient selection confirms on the live dialog after selecting the exact result', async (t) => {
  const fixture = recipientDialogFixture(t);
  assert.deepEqual(await fixture.open('openFriend', 'Alex', 'a.bc'), {
    selected: ['a.bc'], opened: ['https://www.instagram.com/direct/t/101'], errors: [],
  });
});

test('group selection searches for each exact recipient in the latest dialog input', async (t) => {
  const fixture = recipientDialogFixture(t);
  assert.deepEqual(await fixture.open('startRoom', ['a.bc', 'dev_x']), {
    selected: ['a.bc', 'dev_x'], opened: ['https://www.instagram.com/direct/t/404'], errors: [],
  });
});

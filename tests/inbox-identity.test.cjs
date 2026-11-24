'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { setImmediate: flush } = require('node:timers/promises');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function inboxScript(language, notificationsOnly) {
  const source = readFileSync(resolve(__dirname, '../src/OnlyDM/WebViewScripts.cs'), 'utf8');
  const method = source.indexOf('public static string BuildInboxScript(');
  const marker = 'return $$"""';
  const start = source.indexOf(marker, method);
  const end = source.indexOf('""";', start + marker.length);
  assert.ok(method >= 0 && start >= 0 && end > start, 'locate the actual inbox script');
  const labels = Object.fromEntries(Array.from(
    source.slice(method, start).matchAll(/(\w+) = AppLanguageChoice\.Text\(language, ("[^"]+"), ("[^"]+")\)/g),
    ([, key, ko, en]) => [key, JSON.parse(language === 'ko' ? ko : en)],
  ));
  const script = source.slice(start + marker.length, end)
    .replaceAll('{{paletteJson}}', '{}')
    .replaceAll('{{localeJson}}', JSON.stringify(language))
    .replaceAll('{{uiJson}}', JSON.stringify(labels))
    .replaceAll('{{shellScale}}', '1')
    .replaceAll('{{JsonSerializer.Serialize(notificationsOnly)}}', JSON.stringify(notificationsOnly));
  assert.ok(/\}\)\(\);\s*$/.test(script), 'locate the inbox closure end');
  // Expose real operations and read-only state; replace no production functions.
  return script.replace(/\}\)\(\);\s*$/, `
    globalThis.inboxTest = {
      render: renderThreadList,
      open: openThreadByKey,
      items: () => Array.from(threadStore.values()),
      snapshot: (key) => threadSnapshot.get(key),
      notifiedCount: (key) => notifiedPreview.get(key)?.size,
    };
  })();`);
}

function projectionElement() {
  return {
    children: [], dataset: {}, style: {}, textContent: '', scrollTop: 0, clientHeight: 1, scrollHeight: 1,
    setAttribute() {},
    addEventListener(type, listener) { this['on' + type] = listener; },
    appendChild(child) { this.append(child); },
    append(...children) {
      for (const child of children) child.parentElement = this;
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    },
    replaceWith(element) {
      const parent = this.parentElement;
      parent.children[parent.children.indexOf(this)] = element;
      element.parentElement = parent;
    },
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(selector === '.' + child.className ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  };
}

function sourceInbox(t, titles = ['동명 테스트', '동명 테스트'], virtualized = false,
    { initiallyUnread = 0, language = 'ko', sharedAvatar = false, notificationsOnly = false } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const messages = [];
  const listeners = new Set();
  const routes = ['https://www.instagram.com/direct/t/101', 'https://www.instagram.com/direct/t/202'];
  const rows = titles.map((title, index) => {
    const image = { src: `https://fixtures.invalid/avatar-${sharedAvatar ? 0 : index}.png`, currentSrc: '' };
    const span = {
      getAttribute: name => name === 'title' ? title : null,
      closest: () => null,
      contains: node => node.parentElement === span,
      get fontWeight() { return row.unread ? '600' : '400'; },
      childNodes: [{ nodeType: 3, textContent: title }],
      getBoundingClientRect: () => ({ width: 180, height: 20 }),
    };
    const row = {
      title,
      href: '',
      unread: index < initiallyUnread,
      preview: index === 0 ? 'synthetic first latest' : 'synthetic second latest',
      parentElement: null,
      closest: () => null,
      getBoundingClientRect: () => ({ left: 0, top: index * 76, width: 310, height: 76 }),
      scrollIntoView() {},
      querySelector(selector) {
        if (selector === 'img') return image;
        if (selector === 'span[title]') return span;
        if (selector === '[href*="/direct/t/"]') {
          return this.href ? { getAttribute: name => name === 'href' ? this.href : null } : null;
        }
        throw new Error(`Unexpected source-row selector: ${selector}`);
      },
      querySelectorAll(selector) {
        if (selector === 'img') return [image];
        if (selector === 'span, div') return [span];
        throw new Error(`Unexpected source-row selector: ${selector}`);
      },
      dispatchEvent(event) {
        // Model the host's blocked-navigation reply, only after this exact row is clicked.
        if (event.type === 'click') {
          for (const listener of listeners) {
            listener({ data: { type: 'thread-route', href: routes[index] } });
          }
        }
        return true;
      },
    };
    return row;
  });
  let sourceTop = 0;
  const scroller = {
    clientHeight: 720,
    scrollHeight: 1440,
    parentElement: null,
    get scrollTop() { return sourceTop; },
    set scrollTop(value) { sourceTop = Math.max(0, Math.min(value, 720)); },
  };
  // Each virtual page mounts one real source row. The host route is known only on click.
  const visibleRows = () => virtualized ? [rows[sourceTop >= 720 ? 1 : 0]] : rows;
  if (virtualized) for (const row of rows) row.parentElement = scroller;

  const document = {
    // Render directly while the fixture controls which source rows are mounted.
    readyState: 'loading',
    body: projectionElement(),
    addEventListener() {},
    createElement: projectionElement,
    getElementById(id) {
      return id === 'onlydm-inbox-style' ? {} : this.body.children.find(child => child.id === id) ?? null;
    },
    contains: element => visibleRows().includes(element),
    querySelectorAll(selector) {
      if (selector === 'div[role="button"][tabindex="0"]') return visibleRows();
      if (selector === 'a[href^="/"]') return [];
      if (selector.startsWith('#OnlyDmShell ')) return this.body.querySelectorAll(selector.split(' ')[1]);
      throw new Error(`Unexpected document selector: ${selector}`);
    },
    createTreeWalker(element) {
      const parts = element.previewParts ?? [{ text: element.preview }];
      const nodes = [
        { textContent: element.title, parentElement: element.querySelector('span[title]') },
        ...[...parts, { text: element.timestamp ?? '1m', tag: element.timeTag ?? 'time', dateTime: element.dateTime }].map(
          ({ text, role, tag, slot, dateTime }) => {
            const leaf = {
              localName: 'span', childElementCount: 0,
              getAttribute: name => name === 'role' ? role ?? null : name === 'datetime' ? dateTime ?? null : null,
              closest(selector) {
                if (selector === 'time[datetime]' && tag === 'time' && dateTime) return leaf;
                return selector.split(',').some(part => part.trim() === tag) ? leaf : null;
              },
            };
            if (slot) {
              leaf.parentElement = {
                localName: 'span', childElementCount: 1,
                hasAttribute: name => name === 'dir',
                parentElement: { localName: 'div', childElementCount: 2 },
              };
            }
            const node = { textContent: text, parentElement: leaf };
            leaf.childNodes = [node];
            return node;
          }),
      ];
      let index = 0;
      return {
        currentNode: null,
        nextNode() {
          if (index === nodes.length) return false;
          this.currentNode = nodes[index++];
          return true;
        },
      };
    },
  };
  const context = {
    document,
    URL,
    location: { pathname: '/direct/inbox/', origin: 'https://www.instagram.com' },
    NodeFilter: { SHOW_TEXT: 4 },
    MouseEvent: class { constructor(type) { this.type = type; } },
    getComputedStyle: (element) => ({ fontWeight: element.fontWeight ?? '400', backgroundColor: 'transparent' }),
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    chrome: { webview: {
      postMessage: message => messages.push(message),
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    } },
  };
  context.window = context;
  runInNewContext(inboxScript(language, notificationsOnly), context, { filename: 'WebViewScripts.BuildInboxScript.js' });
  const inbox = context.inboxTest;
  inbox.render();
  assert.deepEqual(messages.filter(message => message.type === 'projection-error'), []);

  return {
    rows, messages, inbox, scroller,
    shell: document.getElementById('OnlyDmShell'),
    dispatch(data) { for (const listener of listeners) listener({ data }); },
    async open(item) {
      assert.ok(item, 'the chosen avatar must have a projected room');
      let done = false;
      const pending = inbox.open(item.key, item.title).finally(() => { done = true; });
      for (let elapsed = 0; !done && elapsed < 12000; elapsed += 100) {
        t.mock.timers.tick(100);
        await flush();
      }
      assert.ok(done, 'the actual source-row lookup must finish');
      await pending;
    },
  };
}

test('distinct-name URL-less rows can open the exact chosen avatar (harness control)', async (t) => {
  const { inbox, messages, open } = sourceInbox(t, ['Synthetic first', 'Synthetic second']);
  const chosen = inbox.items().find(item => item.avatarSrcs[0] === 'https://fixtures.invalid/avatar-1.png');
  await open(chosen);
  assert.deepEqual(messages.filter(message => message.type === 'projection-error'), []);
  assert.deepEqual(messages.filter(message => message.type === 'open-thread').map(message => ({
    href: message.href, key: message.key,
  })), [{ href: 'https://www.instagram.com/direct/t/202', key: chosen.key }]);
});

test('same-name URL-less rows retain separate newest previews for distinct visible avatars', (t) => {
  const { inbox, rows } = sourceInbox(t);
  rows[0].preview = 'synthetic first newest incoming';
  inbox.render();
  assert.deepEqual(Array.from(inbox.items(), item => ({
    title: item.title, avatar: item.avatarSrcs[0], preview: item.preview,
  })), [
    { title: '동명 테스트', avatar: 'https://fixtures.invalid/avatar-0.png', preview: 'synthetic first newest incoming' },
    { title: '동명 테스트', avatar: 'https://fixtures.invalid/avatar-1.png', preview: 'synthetic second latest' },
  ], 'merging the second same-name room must not erase the first room or its newest preview');
  assert.equal(new Set(Array.from(inbox.items(), item => item.key)).size, 2);
});

test('a URL-less room keeps its key when the visible avatar CDN host, crop and query refresh', (t) => {
  const { inbox, rows } = sourceInbox(t, ['Synthetic first', 'Synthetic second']);
  const originalKey = inbox.items().find(item => item.title === 'Synthetic first').key;
  rows[0].querySelector('img').src = 'https://cdn-refresh.invalid/v/profile/c0.0.150.150a/s320x320/avatar-0.png?expires=999&signature=refreshed';
  rows[0].preview = 'synthetic first newest after avatar refresh';
  inbox.render();
  const refreshed = inbox.items().find(item => item.title === 'Synthetic first');
  assert.equal(refreshed.key, originalKey, 'presentation-only avatar URL changes must not create a new room key');
  assert.equal(refreshed.preview, 'synthetic first newest after avatar refresh');
  assert.equal(inbox.items().length, 2, 'the refreshed row must replace its earlier snapshot');
});

test('a projected same-name URL-less room opens its exact avatar rather than rejecting both rows', async (t) => {
  const { inbox, messages, open } = sourceInbox(t);
  // Choose the second row, then the first: always picking either edge is incorrect.
  for (const [avatar, href] of [
    ['https://fixtures.invalid/avatar-1.png', 'https://www.instagram.com/direct/t/202'],
    ['https://fixtures.invalid/avatar-0.png', 'https://www.instagram.com/direct/t/101'],
  ]) {
    const chosen = inbox.items().find(item => item.avatarSrcs[0] === avatar);
    const before = messages.length;
    await open(chosen);
    const replies = messages.slice(before);
    assert.deepEqual({
      opened: replies.filter(message => message.type === 'open-thread').map(message => ({
        href: message.href, key: message.key,
      })),
      errors: replies.filter(message => message.type === 'projection-error').map(message => message.message),
    }, {
      opened: [{ href, key: chosen.key }],
      errors: [],
    }, 'the projected key must select the chosen source row even when another row has the same title');
  }
});

test('opening a cached room searches past a mounted same-name peer instead of routing to it', async (t) => {
  const { inbox, messages, open, scroller } = sourceInbox(t, undefined, true);
  const chosen = inbox.items()[0]; // Cached first room, with its original avatar and newest preview.
  assert.equal(chosen.avatarSrcs[0], 'https://fixtures.invalid/avatar-0.png');
  scroller.scrollTop = 720; // A harvest/search has mounted only the other same-name room.
  await open(chosen);
  assert.deepEqual(messages.filter(message => message.type === 'open-thread').map(message => ({
    href: message.href, key: message.key,
  })), [{ href: 'https://www.instagram.com/direct/t/101', key: chosen.key }],
  'a same-title peer is not a valid fallback for the cached selected room');
  assert.deepEqual(messages.filter(message => message.type === 'projection-error'), []);
});

for (const linkedRow of [0, 1]) {
  test(`a real href on same-name row ${linkedRow + 1} does not absorb the other avatar identity`, (t) => {
    const { inbox, rows, scroller } = sourceInbox(t, undefined, true);
    if (linkedRow === 0) {
      rows[0].href = 'https://www.instagram.com/direct/t/101';
      inbox.render();
    } else {
      rows[1].href = 'https://www.instagram.com/direct/t/202';
    }
    const firstKey = inbox.items()[0].key;
    scroller.scrollTop = 720;
    inbox.render();
    assert.deepEqual(Array.from(inbox.items(), item => ({ avatar: item.avatarSrcs[0], href: item.href })), [
      { avatar: 'https://fixtures.invalid/avatar-0.png', href: linkedRow === 0 ? 'https://www.instagram.com/direct/t/101' : '' },
      { avatar: 'https://fixtures.invalid/avatar-1.png', href: linkedRow === 1 ? 'https://www.instagram.com/direct/t/202' : '' },
    ], 'only the same public avatar identity may be promoted to a real href');
    assert.equal(inbox.items()[0].key, firstKey, 'the peer must not replace the first room key');
    assert.equal(new Set(Array.from(inbox.items(), item => item.key)).size, 2);
  });
}

test('the same avatar identity promotes from URL-less to real href as one openable entry', async (t) => {
  const { inbox, rows, messages, open } = sourceInbox(t, undefined, true);
  rows[0].querySelector('img').src = 'https://cdn-refresh.invalid/c0.0.150.150a/s320x320/avatar-0.png?signature=renewed';
  rows[0].href = 'https://www.instagram.com/direct/t/101';
  inbox.render();
  const promoted = inbox.items();
  assert.equal(promoted.length, 1, 'a refreshed CDN URL must not prevent same-identity href promotion');
  assert.equal(promoted[0].key, 'https://www.instagram.com/direct/t/101');
  assert.equal(promoted[0].href, 'https://www.instagram.com/direct/t/101');
  assert.equal(promoted[0].preview, 'synthetic first latest');
  await open(promoted[0]);
  assert.deepEqual(messages.filter(message => message.type === 'open-thread').map(message => ({
    href: message.href, key: message.key,
  })), [{ href: 'https://www.instagram.com/direct/t/101', key: 'https://www.instagram.com/direct/t/101' }]);
  assert.deepEqual(messages.filter(message => message.type === 'projection-error'), []);
});

test('a changed avatar filename fails closed instead of opening by the cached title alone', async (t) => {
  const { inbox, rows, messages, open } = sourceInbox(t, ['Synthetic first', 'Synthetic second']);
  const chosen = inbox.items().find(item => item.avatarSrcs[0] === 'https://fixtures.invalid/avatar-0.png');
  rows[0].querySelector('img').src = 'https://fixtures.invalid/replacement-avatar.png';
  await open(chosen);
  assert.deepEqual(messages.filter(message => message.type === 'open-thread'), [],
    'a new avatar filename cannot establish that a same-title row is the cached room');
  assert.equal(messages.some(message => message.type === 'projection-error' && message.stage === 'open'), true);
});

for (const parts of [
  ['Typing...'], ['입력 중...'], ['Typing', '…'], ['Fixture Friend is typing …'],
  ['Fixture Member is typing...'], ['Fixture Member', 'is typing…'], ['Fixture Member님이 입력 중…'],
  ['@fixture_member: Typing…'], ['Sent a message.'], ['Fixture Friend sent a message'],
  ['Fixture Member:', 'Sent a message'], ['Fixture Friend님이 메시지를 보냈습니다.'],
]) {
  test('preview status stays silent and preserves the last message: ' + parts.join(' '), (t) => {
    const { inbox, rows, messages } = sourceInbox(t, ['Fixture Friend', 'Fixture Group']);
    const key = inbox.items()[0].key;
    const previous = rows[0].preview;
    const status = parts.map(text => ({ text }));
    rows[0].previewParts = status;
    inbox.render();
    assert.equal(inbox.items().find(item => item.key === key).preview, previous,
      'a source status must not replace the last message');
    assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);
    delete rows[0].previewParts;
    inbox.render();
    assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);
    rows[0].preview = 'I sent a message while you were typing…';
    inbox.render();
    rows[0].previewParts = status;
    inbox.render();
    delete rows[0].previewParts;
    inbox.render();
    assert.deepEqual(messages.filter(message => message.type === 'thread-notification').map(message => message.preview),
      ['I sent a message while you were typing…'], 'only the real incoming message is announced once');
  });
}

test('an incoming sentence split across text nodes can end with the status wording', (t) => {
  const { inbox, rows, messages } = sourceInbox(t);
  rows[0].previewParts = [{ text: 'I' }, { text: 'sent a message.' }];
  inbox.render();
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification').map(message => message.preview),
    ['I sent a message.']);
});

test('a message mentioning someone typing still notifies with the full body', (t) => {
  const { inbox, rows, messages } = sourceInbox(t);
  rows[0].preview = 'Fixture Member is typing... so please wait.';
  inbox.render();
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification').map(message => message.preview),
    [rows[0].preview]);
});

for (const notificationsOnly of [false, true]) {
  const mode = notificationsOnly ? 'background' : 'foreground';
  test(mode + ' unread badges stay silent until each actual message appears', (t) => {
    const { inbox, rows, messages, shell } = sourceInbox(t, undefined, false, { notificationsOnly });
    if (notificationsOnly) t.mock.timers.tick(4_001);
    const row = rows[0];
    const notices = () => messages.filter(message => message.type === 'thread-notification').map(message => message.preview);
    row.unread = true;
    for (const status of [
      [{ text: '4+ new messages', slot: true }],
      [{ text: '4+ new messages', slot: true }, { text: 'Unread' }],
      [{ text: 'Unread · 5 + unread messages' }],
      [{ text: '새 메시지 4개 이상', slot: true }],
      [{ text: '2 new messages Unread', slot: true }],
      [{ text: '3 new messages', slot: true }, { text: 'Unread' }],
      [{ text: '새 메시지 2개', role: 'status' }, { text: '안 읽음' }],
      [{ text: 'Unread · 4 unread messages' }],
      [{ text: '5 new messages' }],
    ]) {
      row.previewParts = status;
      inbox.render();
      assert.deepEqual(notices(), [], 'badges must not be reported as messages');
      if (!notificationsOnly)
        assert.equal(shell.querySelector('.onlydm-thread-preview').textContent, row.preview);
    }

    const key = inbox.items()[0].key;
    const first = '첫 실제 메시지';
    const firstParts = [{ text: first, slot: true }, { text: '2 new messages' }, { text: 'Unread' }];
    row.previewParts = firstParts;
    inbox.render();
    row.previewParts = [{ text: 'Unread' }];
    inbox.render();

    row.previewParts = [{ text: '4+ new messages', slot: true }, { text: 'Unread' }];
    inbox.render();
    assert.equal(inbox.items().find(item => item.key === key).preview, first);
    assert.equal(inbox.snapshot(key)?.previewKey, first);
    assert.equal(inbox.notifiedCount(key), 1);
    if (!notificationsOnly) {
      const projected = shell.querySelector('.onlydm-thread-row');
      assert.equal(projected.dataset.unread, 'true');
      assert.equal(projected.querySelector('.onlydm-thread-preview').textContent, first);
    }

    row.previewParts = firstParts;
    inbox.render();
    assert.deepEqual(notices(), [first], 'the same body returning after the count stays silent');
    const second = 'Please review the 4+ new messages when you can.';
    row.previewParts = [{ text: second, slot: true }, { text: '3 new messages' }, { text: 'Unread' }];
    inbox.render();
    inbox.render();
    assert.deepEqual(notices(), [first, second]);
    if (!notificationsOnly) assert.equal(shell.querySelector('.onlydm-thread-preview').textContent, second);
  });
}

test('a different real address overrides a shared visual identity during lookup', async (t) => {
  const { inbox, rows, scroller, messages, open } = sourceInbox(t, ['Shared title', 'Shared title'], true);
  rows[0].href = 'https://www.instagram.com/direct/t/101';
  rows[1].href = 'https://www.instagram.com/direct/t/202';
  rows[1].querySelector('img').src = rows[0].querySelector('img').src;
  inbox.render();
  const chosen = inbox.items().find(item => item.href.endsWith('/101'));
  scroller.scrollTop = 720;
  inbox.render();
  await open(chosen);
  assert.deepEqual(messages.filter(message => message.type === 'open-thread').map(message => message.href),
    ['https://www.instagram.com/direct/t/101'], 'a unique real address must take precedence over shared display metadata');
});

test('an open requested before href promotion still reaches the promoted room', async (t) => {
  const { inbox, rows, messages, open, dispatch } = sourceInbox(t, undefined, true, { initiallyUnread: 1 });
  const provisional = inbox.items()[0];
  const href = 'https://www.instagram.com/direct/t/101';
  rows[0].href = href;

  await open(provisional);

  assert.deepEqual(messages.filter(message => message.type === 'open-thread').map(message => ({
    key: message.key, href: message.href,
  })), [{ key: provisional.key, href }]);
  assert.equal(inbox.items().find(item => item.key === href).unread, true, 'requesting a room alone does not mark it read');
  dispatch({ type: 'mark-thread-read', href, key: provisional.key });
  assert.equal(inbox.items().find(item => item.key === href).unread, false);
});

test('a URL-less fallback must agree with the requested room once it routes', async (t) => {
  const { inbox, rows, scroller, messages, open } = sourceInbox(t, undefined, true);
  const href = 'https://www.instagram.com/direct/t/101';
  rows[0].href = href;
  rows[1].querySelector('img').src = rows[0].querySelector('img').src;
  inbox.render();
  const chosen = inbox.items().find(item => item.key === href);
  scroller.scrollTop = 720; // The indistinguishable URL-less peer actually routes to /202.

  await open(chosen);

  assert.deepEqual(messages.filter(message => message.type === 'open-thread').map(message => message.href),
    [href], 'a conflicting route must be rejected and the exact room found');
});

test('two real addresses replace their former shared provisional row without announcing history', (t) => {
  const { inbox, rows, messages } = sourceInbox(t, undefined, false, {
    initiallyUnread: 2, sharedAvatar: true,
  });
  assert.equal(inbox.items().length, 1);
  const hrefs = ['https://www.instagram.com/direct/t/101', 'https://www.instagram.com/direct/t/202'];
  rows.forEach((row, index) => { row.href = hrefs[index]; });
  inbox.render();
  assert.deepEqual(Array.from(inbox.items(), item => item.key), hrefs);
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);
});

test('a URL-less remount cannot announce a preview under a different addressed room', (t) => {
  const { inbox, rows, scroller, messages } = sourceInbox(t, undefined, true);
  const expected = 'https://www.instagram.com/direct/t/101';
  const peer = 'https://www.instagram.com/direct/t/202';
  rows[0].href = expected;
  rows[1].href = peer;
  rows[1].querySelector('img').src = rows[0].querySelector('img').src;
  inbox.render();
  scroller.scrollTop = 720;
  inbox.render();

  scroller.scrollTop = 0;
  rows[0].href = '';
  rows[0].preview = 'New message for the first room';
  rows[0].unread = true;
  inbox.render();
  const notices = () => messages.filter(message => message.type === 'thread-notification').map(message => ({
    key: message.key, preview: message.preview,
  }));
  assert.deepEqual(notices(), []);
  assert.equal(inbox.items().find(item => item.key === peer).preview, 'synthetic second latest');

  rows[0].href = expected;
  inbox.render();
  inbox.render();
  assert.deepEqual(notices(), [{ key: expected, preview: 'New message for the first room' }]);
});

test('a recycled source element cannot redirect an already selected addressed room', async (t) => {
  const { inbox, rows, messages, open } = sourceInbox(t);
  const wanted = 'https://www.instagram.com/direct/t/101';
  rows[0].href = wanted;
  inbox.render();
  const chosen = inbox.items().find(item => item.key === wanted);

  const pending = open(chosen);
  // Replace the selected element's address before the async lookup hands it to the opener.
  // The mounted replacement for the real room has the same public visual identity too.
  rows[0].href = 'https://www.instagram.com/direct/t/303';
  rows[1].href = wanted;
  rows[1].querySelector('img').src = rows[0].querySelector('img').src;
  await pending;

  assert.deepEqual(messages.filter(message => message.type === 'open-thread').map(message => ({
    key: message.key, href: message.href,
  })), [{ key: wanted, href: wanted }]);
});

test('a cached room can still open while its preview is a typing indicator', async (t) => {
  const { inbox, rows, messages, open } = sourceInbox(t, ['Synthetic first', 'Synthetic second']);
  const chosen = inbox.items()[0];
  rows[0].preview = 'Typing...';
  inbox.render();
  await open(chosen);
  assert.deepEqual(messages.filter(message => message.type === 'open-thread').map(message => message.href),
    ['https://www.instagram.com/direct/t/101'], 'typing changes the preview, not the identity or availability of the room');
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);
});

test('the timestamp finishing hydration does not mark an opened room unread again', async (t) => {
  const { inbox, rows, messages, open, dispatch } = sourceInbox(t, undefined, false, { initiallyUnread: 1 });
  rows[0].href = 'https://www.instagram.com/direct/t/101';
  inbox.render();
  await open(inbox.items()[0]);
  assert.equal(inbox.items()[0].unread, true, 'a failed or pending navigation cannot clear the badge');
  dispatch({ type: 'mark-thread-read', href: rows[0].href });
  assert.equal(inbox.items()[0].unread, false);

  rows[0].dateTime = '2026-11-20T03:10:00Z';
  inbox.render();
  assert.equal(inbox.items()[0].unread, false);
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);

  rows[0].dateTime = '2026-11-20T03:10:01Z';
  inbox.render();
  assert.equal(inbox.items()[0].unread, true, 'a later message with the same body is still unread');
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification').map(({ preview }) => preview), [rows[0].preview]);
});

test('a ready cached chat clears only its badge and count while the inbox source is stale', (t) => {
  const { inbox, rows, messages, shell, dispatch } = sourceInbox(t, undefined, false, { initiallyUnread: 2 });
  const href = 'https://www.instagram.com/direct/t/101/';
  const unreadChip = shell.querySelectorAll('.onlydm-chip').find(chip => chip.dataset.mode === 'unread');
  const count = () => unreadChip.querySelector('.onlydm-chip-count').textContent;
  const flags = () => shell.querySelectorAll('.onlydm-thread-row').map(row => row.dataset.unread);
  const key = inbox.items()[0].key;

  dispatch({ type: 'mark-thread-read', href: 'https://example.invalid/direct/t/101/', key });
  assert.deepEqual(flags(), ['true', 'true']);
  dispatch({ type: 'mark-thread-read', href, key });
  assert.equal(rows[0].unread, true, 'the native badge is intentionally still stale');
  assert.deepEqual(flags(), ['false', 'true']);
  assert.equal(count(), '1');
  assert.equal(messages.findLast(message => message.type === 'inbox-count').unread, 1);

  inbox.render();
  assert.deepEqual(flags(), ['false', 'true']);
  rows[0].unread = false;
  inbox.render();
  rows[0].unread = true;
  inbox.render();
  assert.deepEqual(flags(), ['true', 'true'], 'a fresh unread flag works even when the body is unchanged');
  assert.equal(count(), '2');
});

test('a newly visible timestamp does not promote an older conversation', (t) => {
  const titles = ['Recent conversation', 'Older conversation'];
  const { inbox, rows, scroller, shell } = sourceInbox(t, titles, true);
  const visibleTitles = () => shell.querySelectorAll('.onlydm-thread-row').map(row => row.dataset.title);
  scroller.scrollTop = 720;
  inbox.render();
  assert.deepEqual(visibleTitles(), titles);

  rows[1].dateTime = '2026-11-20T03:10:00Z';
  inbox.render();
  assert.deepEqual(visibleTitles(), titles);

  rows[1].dateTime = '2026-11-20T03:10:01Z';
  inbox.render();
  assert.deepEqual(visibleTitles(), [titles[1], titles[0]], 'a later same-body message still promotes the room');
});

test('a newly mounted top row appears before cached conversations', (t) => {
  const { inbox, rows, scroller } = sourceInbox(t, ['Previous head', 'Cached history', 'New conversation'], true);
  scroller.scrollTop = 720;
  inbox.render();
  scroller.scrollTop = 0;
  inbox.render();
  assert.deepEqual(Array.from(inbox.items(), item => item.title), ['Previous head', 'Cached history']);

  const newHead = rows[2];
  newHead.unread = true;
  rows[0] = newHead;
  inbox.render();
  assert.deepEqual(Array.from(inbox.items(), item => item.title), ['New conversation', 'Previous head', 'Cached history']);
});

test('unread-only changes update the header, chip and filtered rows from the same 40-room inbox', (t) => {
  const titles = Array.from({ length: 40 }, (_, i) => 'Fixture room ' + i);
  const { inbox, rows, messages, shell } = sourceInbox(t, titles, false, { initiallyUnread: 40 });
  const chip = shell.querySelectorAll('.onlydm-chip').find(element => element.dataset.mode === 'unread');
  const chipCount = chip.querySelector('.onlydm-chip-count');
  const list = shell.querySelector('.onlydm-thread-list');
  const changedKey = list.children[0].dataset.key;
  assert.equal(chipCount.textContent, '40');
  assert.equal(list.children[0].dataset.unread, 'true');

  rows[0].unread = false;
  inbox.render();
  assert.equal(chipCount.textContent, '39');
  assert.equal(list.children[0].dataset.unread, 'false');
  chip.onclick();
  list.onscroll(); // Draw the next projected page without touching the source scroller.
  assert.equal(list.children.length, 39);
  assert.ok(list.children.every(row => row.dataset.unread === 'true' && row.dataset.key !== changedKey));
  assert.deepEqual(messages.filter(message => message.type === 'inbox-count')
    .map(({ count, unread }) => [count, unread]), [[40, 40], [40, 39]]);
});

test('a title-only virtual remount preserves the same unread room preview', (t) => {
  const { inbox, rows, messages, scroller, shell } = sourceInbox(t, undefined, true, { initiallyUnread: 1 });
  const key = inbox.items()[0].key;
  scroller.scrollTop = 720;
  inbox.render();
  rows[0].preview = '';
  rows[0].unread = false; // The recycled row has mounted before the text and unread decoration.
  scroller.scrollTop = 0;
  inbox.render();

  const row = shell.querySelectorAll('.onlydm-thread-row').find(candidate => candidate.dataset.key === key);
  assert.equal(row.querySelector('.onlydm-thread-preview').textContent, 'synthetic first latest');
  assert.equal(row.dataset.unread, 'true');
  assert.deepEqual(Array.from(inbox.items(), item => item.preview), ['synthetic first latest', 'synthetic second latest']);

  rows[0].unread = true;
  rows[0].preview = 'synthetic first latest';
  inbox.render();
  assert.deepEqual(messages.filter(({ type }) => ['thread-notification', 'open-thread', 'request-open'].includes(type)), []);
});

for (const [language, countLabel] of [
  ['ko', '새 메시지 4개 이상'],
  ['en', '4+ new messages'],
]) {
  test(language + ' cold unread history shows the count until its body hydrates', (t) => {
    const { inbox, rows, messages, scroller, shell } = sourceInbox(t, undefined, true, { language });
    rows[1].unread = true;
    rows[1].previewParts = [{ text: '4+ new messages', slot: true }, { text: 'Unread' }];
    scroller.scrollTop = 720;
    inbox.render();

    const row = shell.querySelectorAll('.onlydm-thread-row')[1];
    const preview = row.querySelector('.onlydm-thread-preview');
    const key = row.dataset.key;
    assert.equal(row.dataset.unread, 'true');
    assert.ok(row.querySelector('.onlydm-unread-badge'));
    const item = inbox.items().find(item => item.key === key);
    assert.deepEqual({
      shown: preview.textContent,
      body: item.preview,
      previewKey: item.previewKey,
      snapshot: { ...inbox.snapshot(key) },
      notifiedCount: inbox.notifiedCount(key),
    }, {
      shown: countLabel,
      body: '',
      previewKey: '',
      snapshot: { previewKey: '', messageTime: '' },
      notifiedCount: undefined,
    });
    assert.deepEqual(messages.filter(({ type }) => type === 'thread-notification'), []);

    // The actual body happens to match the conversation title while the count still lingers.
    rows[1].previewParts.unshift({ text: rows[1].title });
    inbox.render();
    assert.equal(preview.textContent, rows[1].title);
    assert.equal(row.dataset.unread, 'true');
    assert.deepEqual(messages.filter(({ type }) => ['thread-notification', 'open-thread', 'request-open'].includes(type)), []);
    assert.equal(inbox.notifiedCount(key), undefined);
  });
}

test('the first unread message in a known empty room is announced once after mounting', (t) => {
  const { inbox, rows, messages, scroller } = sourceInbox(t, undefined, true);
  rows[1].preview = '';
  scroller.scrollTop = 720;
  inbox.render(); // Learn this room as read, without a preview.

  rows[1].unread = true;
  inbox.render(); // The unread mark arrives before the body.
  rows[1].preview = 'Synthetic first unread message';
  inbox.render();
  inbox.render();
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification').map(message => message.preview),
    ['Synthetic first unread message']);
});

for (const timeTag of ['time', 'abbr']) {
  test('reading a count-only room stays read through ' + timeTag + ' hydration and a later message alerts', (t) => {
    const { inbox, rows, messages, scroller, dispatch } = sourceInbox(t, undefined, true);
    const row = rows[1];
    row.href = 'https://www.instagram.com/direct/t/202';
    row.unread = true;
    row.timeTag = timeTag === 'abbr' ? 'abbr[aria-label]' : timeTag;
    if (timeTag === 'time') row.dateTime = '2026-01-01T12:00:00Z';
    row.previewParts = [{ text: '4+ new messages', slot: true }, { text: 'Unread' }];
    scroller.scrollTop = 720;
    inbox.render();
    dispatch({ type: 'mark-thread-read', href: row.href });

    const current = () => inbox.items().find(item => item.key === row.href);
    const notices = () => messages.filter(({ type }) => type === 'thread-notification').map(({ preview }) => preview);
    assert.equal(current().unread, false);
    row.previewParts = [{ text: 'Historical message', slot: true }, { text: 'Unread' }];
    if (timeTag === 'abbr') row.timestamp = '2m';
    inbox.render();
    assert.equal(current().preview, 'Historical message');
    assert.equal(current().unread, false);
    assert.deepEqual(notices(), []);
    assert.equal(messages.findLast(({ type }) => type === 'inbox-count').unread, 0);

    row.previewParts[0].text = 'New message after reading';
    if (timeTag === 'time') row.dateTime = '2026-01-01T12:01:00Z';
    else row.timestamp = 'now';
    inbox.render();
    assert.equal(current().unread, true);
    assert.deepEqual(notices(), ['New message after reading']);
  });
}

test('a count-only room still alerts when a newer body arrives before historical hydration', (t) => {
  const { inbox, rows, messages, scroller, dispatch } = sourceInbox(t, undefined, true);
  const row = rows[1];
  row.href = 'https://www.instagram.com/direct/t/202';
  row.unread = true;
  row.timeTag = 'abbr[aria-label]';
  row.previewParts = [{ text: '4+ new messages', slot: true }, { text: 'Unread' }];
  scroller.scrollTop = 720;
  inbox.render();
  dispatch({ type: 'mark-thread-read', href: row.href });

  row.previewParts[0].text = 'New message before old preview';
  row.timestamp = 'now';
  inbox.render();
  assert.equal(inbox.items().find(item => item.key === row.href).unread, true);
  assert.deepEqual(messages.filter(({ type }) => type === 'thread-notification').map(({ preview }) => preview),
    ['New message before old preview']);
});

test('reading a new body before its timestamp arrives keeps the room read until the next message', (t) => {
  const { inbox, rows, messages, dispatch } = sourceInbox(t, ['Fixture room']);
  const [row] = rows;
  row.href = 'https://www.instagram.com/direct/t/101';
  row.dateTime = '2026-01-01T12:00:00Z';
  inbox.render();
  row.unread = true;
  row.preview = 'New body, old timestamp';
  inbox.render();
  dispatch({ type: 'mark-thread-read', href: row.href });
  assert.equal(inbox.items()[0].unread, false);

  row.dateTime = '2026-01-01T12:01:00Z';
  inbox.render();
  assert.equal(inbox.items()[0].unread, false);
  assert.equal(messages.filter(({ type }) => type === 'thread-notification').length, 1);

  row.dateTime = '2026-01-01T12:02:00Z';
  inbox.render();
  assert.equal(inbox.items()[0].unread, true);
  assert.equal(messages.filter(({ type }) => type === 'thread-notification').length, 2);
});


test('a newly prepended unread room announces its first preview after hydrating', (t) => {
  const { inbox, rows, messages, shell } = sourceInbox(t);
  const href = 'https://www.instagram.com/direct/t/303';

  // Reuse the top source element for a new unread room before the message body mounts.
  rows[0].href = href;
  rows[0].querySelector('img').src = 'https://fixtures.invalid/avatar-new.png';
  rows[0].unread = true;
  rows[0].previewParts = [{ text: '4+ new messages', slot: true }, { text: 'Unread' }];
  inbox.render();
  assert.deepEqual({ ...inbox.snapshot(href) }, { previewKey: '', messageTime: '' },
    'the count must leave the message identity empty');
  assert.equal(inbox.notifiedCount(href), undefined);
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);

  delete rows[0].previewParts;
  rows[0].preview = 'Typing…';
  inbox.render();
  rows[0].preview = 'Sent a message';
  inbox.render();
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);
  assert.equal(inbox.items().find(item => item.key === href).preview, '');

  const firstRoom = rows[0];
  rows.reverse(); // Another conversation can move above it while the preview is pending.
  firstRoom.preview = 'First message from the new room';
  inbox.render();
  inbox.render();
  const projected = shell.querySelectorAll('.onlydm-thread-row').find(row => row.dataset.key === href);
  assert.equal(projected.querySelector('.onlydm-thread-preview').textContent, 'First message from the new room');
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification').map(message => ({
    key: message.key, preview: message.preview,
  })), [{ key: href, preview: 'First message from the new room' }]);
});

test('adjacent author and preview slots remain readable as the native abbreviation time updates', (t) => {
  const { inbox, rows, messages, shell } = sourceInbox(t);
  rows[0].previewParts = [{ text: 'fixture_handle' }, { text: 'Synthetic preview' }];
  rows[0].timeTag = 'abbr[aria-label]';
  rows[0].timestamp = '1개월';
  inbox.render();
  rows[0].timestamp = '2개월';
  inbox.render();

  const row = shell.querySelector('.onlydm-thread-row');
  assert.equal(row.querySelector('.onlydm-thread-preview').textContent, 'fixture_handle Synthetic preview');
  assert.equal(row.querySelector('.onlydm-thread-time').textContent, '2개월');
  assert.deepEqual(messages.filter(message => message.type === 'thread-notification').map(message => message.preview),
    ['fixture_handle Synthetic preview']);
});

for (const [language, sent, attachment] of [
  ['ko', '회원님:', '첨부 파일을 보냈습니다.'],
  ['en', 'You:', 'Sent an attachment.'],
]) {
  test(language + ' localizes regular sent slots while retaining the exact body', (t) => {
    const { inbox, rows, messages, shell } = sourceInbox(t, undefined, false, { language });
    const projectedText = () => shell.querySelectorAll('.onlydm-thread-preview').map(element => element.textContent);
    const body = 'You:  그대로 ' + '\u1100\u1161';
    const notices = () => messages.filter(message => message.type === 'thread-notification').map(message => message.preview);

    for (const prefix of ['You:', '회원님:']) {
      rows[0].previewParts = [{ text: prefix + ' ' + body, slot: true }];
      inbox.render();
      assert.equal(projectedText()[0], sent + ' ' + body);
      rows[0].previewParts = [{ text: prefix }, { text: body, slot: true }];
      inbox.render();
      assert.equal(projectedText()[0], sent + ' ' + body);
    }
    for (const label of ['You sent an attachment.', '회원님이 첨부 파일을 보냈습니다.']) {
      rows[0].previewParts = [{ text: label, slot: true }];
      inbox.render();
      assert.equal(projectedText()[0], sent + ' ' + attachment);
    }
    assert.deepEqual(notices(), [], 'generated sent metadata must not start a notification');

    const quoted = 'You sent an attachment. 이것은 본문입니다.';
    rows[0].previewParts = [{ text: quoted, slot: true }];
    inbox.render();
    assert.equal(projectedText()[0], quoted, 'an attachment summary must match the whole slot');

    rows[1].preview = '회원님: 다른 형태의 본문';
    inbox.render();
    assert.equal(projectedText()[1], rows[1].preview, 'other DOM shapes retain their original preview');
    assert.deepEqual(notices(), [quoted], 'the legacy own-prefix notification filter still covers read rows');

    rows[1].unread = true;
    const received = ['You:', body, '회원님: 본문', 'You sent an attachment.', '회원님이 첨부 파일을 보냈습니다.',
      '1 new message', '전화 걸기 전'];
    for (const text of received) {
      rows[1].previewParts = [{ text, slot: true }];
      inbox.render();
      assert.equal(projectedText()[1], text);
    }
    rows[1].previewParts = [{ text: body, slot: true }];
    inbox.render();
    assert.deepEqual(notices(), [quoted, ...received], 'unread lookalikes should announce once with their original body');
  });
}

for (const [language, parts, unread, expected, title = '테스트 단체방'] of [
  ['ko', ['김테스트 sent an attachment.'], true, '김테스트: 첨부 파일을 보냈습니다.'],
  ['ko', ['Fixture Sender sent a photo.'], true, 'Fixture Sender: 사진을 보냈습니다.', 'Fixture Sender'],
  ['ko', ['Fixture Sender', 'sent a reel.'], true, 'Fixture Sender: 릴스를 보냈습니다.'],
  ['ko', ['You sent a photo.'], false, '회원님: 사진을 보냈습니다.'],
  ['ko', ['You sent a reel.'], false, '회원님: 릴스를 보냈습니다.'],
  ['en', ['Fixture Sender', 'sent a photo.'], true, 'Fixture Sender: Sent a photo.'],
  ['en', ['Sent a reel.'], true, 'Sent a reel.'],
]) {
  test(language + ' media previews format ' + parts.join(' '), (t) => {
    const { inbox, rows, shell } = sourceInbox(t, [title, '다른 채팅방'], false, { language });
    rows[0].unread = unread;
    rows[0].previewParts = parts.map((text, index) => ({ text, slot: index === parts.length - 1 }));
    inbox.render();

    assert.equal(shell.querySelector('.onlydm-thread-preview').textContent, expected);
  });
}

test('media previews leave actual messages with media-related wording intact', (t) => {
  const { inbox, rows, shell } = sourceInbox(t);
  rows[0].unread = true;
  rows[1].previewParts = [{ text: 'You: I sent a photo.', slot: true }];
  for (const parts of [
    [{ text: '김테스트 sent an attachment. 이건 안내 문구예요.', slot: true }],
    [{ text: 'The person you asked about sent a photo.', slot: true }],
    [{ text: 'Someone sent a photo.', slot: true }],
    [{ text: 'Fixture Sender:' }, { text: 'sent a photo.', slot: true }],
  ]) {
    rows[0].previewParts = parts;
    inbox.render();

    const [received, sent] = shell.querySelectorAll('.onlydm-thread-preview');
    assert.equal(received.textContent, parts.map(({ text }) => text).join(' '));
    assert.equal(sent.textContent, '회원님: I sent a photo.');
  }
});

for (const [language, source, expected, timestamp, shownTime] of [
  ['en', 'sample_handle님이 메시지를 좋아합니다', 'sample_handle: Liked a message.', '22분', '22m'],
  ['en', '메시지를 좋아합니다', 'Liked a message.', '1개월', '1mo'],
  ['ko', 'sample_handle liked a message.', 'sample_handle: 메시지를 좋아합니다.', '22m', '22분'],
  ['ko', 'Liked a message', '메시지를 좋아합니다.', '2w', '2주'],
]) {
  test(language + ' formats a reaction and time from the other locale: ' + source, (t) => {
    const { inbox, rows, shell } = sourceInbox(t, undefined, false, { language });
    rows[0].previewParts = [{ text: source, slot: true }];
    rows[0].timeTag = 'abbr[aria-label]';
    rows[0].timestamp = timestamp;
    rows[1].previewParts = [{ text: 'She said someone liked a message.', slot: true }];
    inbox.render();

    const [reaction, message] = shell.querySelectorAll('.onlydm-thread-preview');
    assert.equal(reaction.textContent, expected);
    assert.equal(message.textContent, 'She said someone liked a message.');
    assert.equal(shell.querySelector('.onlydm-thread-time').textContent, shownTime);
  });
}

for (const notificationsOnly of [false, true]) {
  const mode = notificationsOnly ? 'background' : 'foreground';
  test('media previews preserve one raw ' + mode + ' notification', (t) => {
    const { inbox, rows, messages, shell } = sourceInbox(t, undefined, false, { notificationsOnly });
    if (notificationsOnly) t.mock.timers.tick(4_001);

    rows[0].unread = true;
    rows[0].previewParts = [{ text: 'Fixture Sender' }, { text: 'sent a photo.', slot: true }];
    inbox.render();
    const preview = shell?.querySelector('.onlydm-thread-preview');
    if (!notificationsOnly) assert.equal(preview?.textContent, 'Fixture Sender: 사진을 보냈습니다.');

    const raw = 'Fixture Sender sent a photo.';
    rows[0].previewParts = [{ text: raw }];
    rows[0].timestamp = '2m';
    inbox.render();
    if (!notificationsOnly) assert.equal(preview?.textContent, raw);

    const notices = messages.filter(message => message.type === 'thread-notification');
    assert.deepEqual(notices.map(message => message.preview), [raw]);
    assert.deepEqual({ ...notices[0].caption }, {
      ko: 'Fixture Sender: 사진을 보냈습니다.',
      en: 'Fixture Sender: Sent a photo.',
    });
  });

  test(mode + ' alerts once when a new body arrives before its timestamp', (t) => {
    const { inbox, rows, messages } = sourceInbox(t, ['Fixture room'], false, { notificationsOnly });
    const [row] = rows;
    row.dateTime = '2026-01-01T12:00:00Z';
    inbox.render();
    if (notificationsOnly) t.mock.timers.tick(4_001);
    const notices = () => messages.filter(({ type }) => type === 'thread-notification').map(({ preview }) => preview);
    assert.deepEqual(notices(), []);

    row.unread = true;
    row.preview = 'Can you bring the keys?';
    inbox.render();
    inbox.render();
    assert.deepEqual(notices(), [row.preview], 'the body alerts immediately');
    row.dateTime = '2026-01-01T12:01:00Z';
    inbox.render();
    assert.deepEqual(notices(), [row.preview], 'its timestamp catch-up is silent');
    row.dateTime = '2026-01-01T12:02:00Z';
    inbox.render();
    assert.deepEqual(notices(), [row.preview, row.preview], 'the identical text at a later time is a separate message');
  });

  test(mode + ' alerts for repeated text separated by another message when timestamps lag', (t) => {
    const { inbox, rows, messages } = sourceInbox(t, ['Fixture room'], false, { notificationsOnly });
    const [row] = rows;
    row.dateTime = '2026-01-01T12:00:00Z';
    inbox.render();
    if (notificationsOnly) t.mock.timers.tick(4_001);
    row.unread = true;
    const bodies = ['Sure.', 'What time?', 'Sure.'];
    for (const [index, body] of bodies.entries()) {
      row.preview = body;
      inbox.render();
      row.dateTime = '2026-01-01T12:0' + (index + 1) + ':00Z';
      inbox.render();
    }
    assert.deepEqual(messages.filter(({ type }) => type === 'thread-notification').map(({ preview }) => preview), bodies);
  });

  test(mode + ' stays silent when an already-read history preview mounts', (t) => {
    const { inbox, rows, messages, scroller } = sourceInbox(t, undefined, true, { notificationsOnly });
    rows[1].preview = '';
    scroller.scrollTop = 720;
    inbox.render();
    if (notificationsOnly) t.mock.timers.tick(4_001);
    rows[1].preview = 'This older message is already read.';
    inbox.render();
    assert.equal(inbox.items().find(item => item.preview === rows[1].preview)?.unread, false);
    assert.deepEqual(messages.filter(({ type }) => type === 'thread-notification'), []);
  });
}

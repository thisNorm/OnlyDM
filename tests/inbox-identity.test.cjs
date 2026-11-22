'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { setImmediate: flush } = require('node:timers/promises');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function inboxScript(language) {
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
    .replaceAll('{{uiJson}}', JSON.stringify(labels))
    .replaceAll('{{shellScale}}', '1')
    .replaceAll('{{JsonSerializer.Serialize(notificationsOnly)}}', 'false');
  assert.ok(/\}\)\(\);\s*$/.test(script), 'locate the inbox closure end');
  // Expose real operations and read-only state; replace no production functions.
  return script.replace(/\}\)\(\);\s*$/, `
    globalThis.inboxTest = {
      render: renderThreadList,
      open: openThreadByKey,
      items: () => Array.from(threadStore.values()),
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
    { initiallyUnread = 0, language = 'ko' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const messages = [];
  const listeners = new Set();
  const routes = ['https://www.instagram.com/direct/t/101', 'https://www.instagram.com/direct/t/202'];
  const rows = titles.map((title, index) => {
    const image = { src: `https://fixtures.invalid/avatar-${index}.png`, currentSrc: '' };
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
      if (selector.startsWith('#OnlyDmShell ')) return this.body.querySelectorAll(selector.split(' ')[1]);
      throw new Error(`Unexpected document selector: ${selector}`);
    },
    createTreeWalker(element) {
      const parts = element.previewParts ?? [{ text: element.preview }];
      const nodes = [
        { textContent: element.title, parentElement: element.querySelector('span[title]') },
        ...[...parts, { text: element.timestamp ?? '1m', tag: element.timeTag ?? 'time' }].map(
          ({ text, role, tag, slot }) => {
            const leaf = {
              localName: 'span', childElementCount: 0,
              getAttribute: name => name === 'role' ? role ?? null : null,
              closest(selector) {
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
  runInNewContext(inboxScript(language), context, { filename: 'WebViewScripts.BuildInboxScript.js' });
  const inbox = context.inboxTest;
  inbox.render();
  assert.deepEqual(messages.filter(message => message.type === 'projection-error'), []);

  return {
    rows, messages, inbox, scroller,
    shell: document.getElementById('OnlyDmShell'),
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

for (const indicator of ['Typing...', '입력 중...']) {
  test('typing status preserves the last message and never announces it again: ' + indicator, (t) => {
    const { inbox, rows, messages } = sourceInbox(t);
    const key = inbox.items()[0].key;
    const previous = rows[0].preview;
    rows[0].preview = indicator;
    inbox.render();
    assert.equal(inbox.items().find(item => item.key === key).preview, previous,
      'a transient typing indicator must not replace the last message');
    assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);
    rows[0].preview = previous;
    inbox.render();
    assert.deepEqual(messages.filter(message => message.type === 'thread-notification'), []);
    rows[0].preview = 'synthetic incoming after typing';
    inbox.render();
    rows[0].preview = indicator;
    inbox.render();
    rows[0].preview = 'synthetic incoming after typing';
    inbox.render();
    assert.deepEqual(messages.filter(message => message.type === 'thread-notification').map(message => message.preview),
      ['synthetic incoming after typing'], 'only the real incoming message is announced once');
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

test('a cold unread row shows an honest fallback and fills its preview without opening', (t) => {
  const { inbox, rows, messages, scroller, shell } = sourceInbox(t, undefined, true);
  rows[1].unread = true;
  rows[1].previewParts = [{ text: '1 new message', role: 'status' }];
  scroller.scrollTop = 720;
  inbox.render();

  const row = shell.querySelectorAll('.onlydm-thread-row')[1];
  const preview = row.querySelector('.onlydm-thread-preview');
  assert.equal(row.dataset.unread, 'true');
  assert.equal(preview.textContent, '미리보기 없음');

  // The actual body happens to match the conversation title.
  rows[1].previewParts.unshift({ text: rows[1].title });
  inbox.render();
  assert.equal(preview.textContent, rows[1].title);
  assert.equal(row.dataset.unread, 'true');
  assert.deepEqual(messages.filter(({ type }) => ['thread-notification', 'open-thread', 'request-open'].includes(type)), []);
});

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
  ['ko', '나:', '첨부 파일'],
  ['en', 'You:', 'Attachment'],
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

'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { setImmediate: flush } = require('node:timers/promises');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

function inboxScript() {
  const source = readFileSync(resolve(__dirname, '../src/OnlyDM/WebViewScripts.cs'), 'utf8');
  const method = source.indexOf('public static string BuildInboxScript(');
  const marker = 'return $$"""';
  const start = source.indexOf(marker, method);
  const end = source.indexOf('""";', start + marker.length);
  assert.ok(method >= 0 && start >= 0 && end > start, 'locate the actual inbox script');
  const script = source.slice(start + marker.length, end)
    .replaceAll('{{paletteJson}}', '{}')
    .replaceAll('{{localeJson}}', '"ko"')
    .replaceAll('{{uiJson}}', '{}')
    .replaceAll('{{shellScale}}', '1')
    .replaceAll('{{JsonSerializer.Serialize(notificationsOnly)}}', 'false');
  assert.ok(/\}\)\(\);\s*$/.test(script), 'locate the inbox closure end');
  // Expose operations and read-only state inside the extracted closure. No production
  // function is replaced, including harvesting, finishing, polling and notification detection.
  return script.replace(/\}\)\(\);\s*$/, `
    globalThis.inboxTest = {
      open: openThreadByKey,
      state: () => ({ opening, harvesting, items: Array.from(threadStore.values()) }),
    };
  })();`);
}

test('queued old-room opens restore the inbox head before monitoring stale virtual rows', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 0 });
  const messages = [];
  const scrollConflicts = [];
  const staleOrders = [];
  let mountedPage = 0;
  let physicalTop = 0;
  let paintTimer;
  let guardQueue = false;
  let watchRestoration = false;

  function row(id, title) {
    const element = {
      href: `https://www.instagram.com/direct/t/${id}`,
      title,
      preview: 'historical message',
      parentElement: null,
      closest: () => null,
      getBoundingClientRect: () => ({ width: 310, height: 76 }),
      scrollIntoView() {},
    };
    const titleSpan = {
      getAttribute: name => name === 'title' ? title : null,
      closest: () => null,
      contains: node => node.parentElement === titleSpan,
      childNodes: [{ nodeType: 3, textContent: title }],
      getBoundingClientRect: () => ({ width: 180, height: 20 }),
    };
    const image = { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', currentSrc: '' };
    const link = { getAttribute: name => name === 'href' ? element.href : null };
    element.querySelector = selector => {
      if (selector === 'img') return image;
      if (selector === 'span[title]') return titleSpan;
      if (selector === '[href*="/direct/t/"]') return link;
      throw new Error(`Unexpected source-row selector: ${selector}`);
    };
    element.querySelectorAll = selector => {
      if (selector === 'img') return [image];
      if (selector === 'span, div') return [titleSpan];
      throw new Error(`Unexpected source-row selector: ${selector}`);
    };
    return element;
  }

  const pages = [
    [row(101, 'Newest one'), row(102, 'Newest two')],
    [row(201, 'Older one'), row(202, 'Older two')],
    [row(301, 'Queued older one'), row(302, 'Queued older two')],
  ];
  const newest = pages[0][0];
  const newestKeys = pages[0].map(item => item.href);
  const opened = () => messages.filter(message => message.type === 'open-thread');
  const scroller = {
    clientHeight: 720,
    scrollHeight: 2160,
    parentElement: null,
    get scrollTop() { return physicalTop; },
    set scrollTop(value) {
      const next = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
      if (next === physicalTop) return;
      if (guardQueue && opened().length < 2 && next === 0) scrollConflicts.push(Date.now());
      physicalTop = next;
      clearTimeout(paintTimer);
      // The scroll offset changes before the virtualized source mounts its new rows.
      // Immediate rendering at offset zero still sees the previous tail for 100 ms.
      paintTimer = setTimeout(() => { mountedPage = Math.floor(next / 720); }, 100);
    },
  };
  for (const page of pages) for (const item of page) item.parentElement = scroller;

  // Omit only the projected shell's visual list. The real renderThreadList still
  // extracts, merges and detects changes before it reaches that missing UI surface.
  const shell = { id: 'OnlyDmShell', querySelector: () => null };
  const document = {
    readyState: 'complete',
    body: { children: [shell] },
    documentElement: {},
    addEventListener() {},
    getElementById: id => id === shell.id ? shell : id === 'onlydm-inbox-style' ? {} : null,
    contains: element => pages[mountedPage].includes(element),
    querySelectorAll(selector) {
      if (selector === 'div[role="button"][tabindex="0"]') return pages[mountedPage];
      if (selector === 'a[href^="/"]') return [];
      throw new Error(`Unexpected document selector: ${selector}`);
    },
    createTreeWalker(element) {
      const values = [element.title, element.preview, '1m'];
      const time = { closest: selector => selector.split(',').some(part => part.trim() === 'time') ? time : null };
      const parents = [element.querySelector('span[title]'), element, time];
      let index = 0;
      return {
        currentNode: null,
        nextNode() {
          if (index === values.length) return false;
          this.currentNode = { textContent: values[index], parentElement: parents[index] };
          index += 1;
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
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ fontWeight: '400', backgroundColor: 'transparent' }),
    performance: { now: () => Date.now() },
    setTimeout, clearTimeout, setInterval, clearInterval,
    chrome: { webview: { postMessage: message => messages.push(message), addEventListener() {} } },
  };
  context.window = context;
  runInNewContext(inboxScript(), context, { filename: 'WebViewScripts.BuildInboxScript.js' });
  const inbox = context.inboxTest;
  const headKeys = () => Array.from(inbox.state().items, item => item.key).slice(0, 2);

  async function advance(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 25) {
      t.mock.timers.tick(Math.min(25, ms - elapsed));
      await flush();
      if (watchRestoration && physicalTop === 0 && mountedPage !== 0
          && JSON.stringify(headKeys()) !== JSON.stringify(newestKeys)) {
        staleOrders.push(headKeys());
      }
    }
  }

  // Let the real initial harvest populate the store and remembered source offsets.
  // The next 1200 ms monitor tick will fall inside the first open's queued-open gap.
  await advance(12700);
  assert.equal(inbox.state().harvesting, false, 'initial source harvesting completed');
  assert.equal(inbox.state().items.length, 6, 'all three virtual pages were really harvested');
  assert.deepEqual(headKeys(), newestKeys);
  assert.equal(messages.some(message => message.type === 'projection-error'), false);
  assert.equal(messages.some(message => message.type === 'thread-notification'), false);

  watchRestoration = true;
  const first = inbox.open(pages[1][0].href, pages[1][0].title);
  await flush();
  assert.equal(inbox.state().opening, true);
  assert.ok(physicalTop > 0, 'the real finder moved below the newest source page');
  guardQueue = true;
  await inbox.open(pages[2][0].href, pages[2][0].title);
  await advance(550); // Includes the periodic tick while the next open is queued.
  await first;
  assert.equal(opened().length, 1, 'the queued open has not started before its delay');
  assert.deepEqual(scrollConflicts, [], 'periodic monitoring must not fight the pending open');
  await advance(900);
  assert.equal(opened().length, 2, 'both actual open operations completed');
  assert.equal(opened()[1].href, pages[2][0].href);
  assert.deepEqual(scrollConflicts, [], 'monitoring must not reset the source during either open');
  assert.equal(inbox.state().opening, false);

  newest.preview = 'new incoming message after opening old rooms';
  await advance(1500);
  const notices = messages.filter(message => message.type === 'thread-notification');
  assert.deepEqual(staleOrders, [], 'restoring scrollTop must not promote stale virtual tail rows');
  assert.deepEqual({
    sourceTop: physicalTop,
    preview: inbox.state().items.find(item => item.key === newest.href).preview,
    notified: Array.from(notices, message => ({ key: message.key, preview: message.preview })),
  }, {
    sourceTop: 0,
    preview: 'new incoming message after opening old rooms',
    notified: [{ key: newest.href, preview: 'new incoming message after opening old rooms' }],
  }, 'finishOpening must restore the head so normal monitoring observes and notifies the newest change');
  assert.deepEqual(headKeys(), newestKeys);
});

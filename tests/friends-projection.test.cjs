'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { setImmediate: flush } = require('node:timers/promises');

const source = fs.readFileSync(path.join(__dirname, '../src/OnlyDM/FriendsScript.cs'), 'utf8');
// Capture the roster the shell would render while exercising the real message handlers.
const rawScript = source.match(/return \$\$"""\r?\n([\s\S]*?)\r?\n""";/)[1];

function projection(lang) {
  const copy = { lang };
  for (const [, key, ko, en] of source.matchAll(/(\w+) = AppLanguageChoice.Text\(language, "([^"]*)", "([^"]*)"\)/g)) {
    copy[key] = lang === 'ko' ? ko : en;
  }
  return rawScript.replace(/\{\{(paletteJson|uiJson|shellZoom|barWidth|barRadius|barBorder)\}\}/g,
    (_, name) => name === 'uiJson' ? JSON.stringify(copy) : name === 'paletteJson' ? '{}' : '1');
}

const script = projection('en')
  .replace("  if (document.readyState === 'loading') {",
    "  ensureShell = () => {}; render = () => paint([...friendStore.keys()]);\n$&");

function fixture(t, initialSource) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const messages = [];
  let profile = initialSource;
  let dialog = null;
  let visible = [];
  let generation = 0;
  let onMessage;
  let projected = [];

  const anchor = handle => {
    const control = { contains: () => false };
    const buttonText = { textContent: 'Following', parentElement: { closest: () => control } };
    const link = { getAttribute: () => '/' + handle + '/', lines: [handle], querySelector: () => null };
    const row = {
      getBoundingClientRect: () => ({ width: 300, height: 60 }),
      lines: profile.names ? [handle, buttonText, profile.names[handle] || ''] : [handle, 'Fixture ' + handle],
      querySelector: () => null,
      querySelectorAll: () => [link],
      contains: node => node === control,
    };
    if (profile.adjacent) {
      row.parentElement = {
        ...row,
        getBoundingClientRect: () => ({ width: 300, height: 120 }),
        lines: visible,
        querySelectorAll: () => visible.map(peer => ({ getAttribute: () => '/' + peer + '/' })),
      };
    }
    link.parentElement = row;
    return link;
  };

  function mountDialog(offset = 0) {
    const viewport = 100;
    const step = 80;
    const limit = (profile.pages.length - 1) * step;
    const scroller = {
      clientHeight: viewport,
      scrollHeight: viewport + limit,
      get scrollTop() { return offset; },
      set scrollTop(value) {
        const next = Math.max(0, Math.min(limit, value));
        if (next === offset) return;
        offset = next;
        const page = Math.round(offset / step);
        const request = ++generation;
        const detached = profile.detachAt === page;
        if (detached) dialog = null;
        setTimeout(() => {
          // A request for a newer window supersedes a render at the old offset.
          if (request !== generation) return;
          if (detached) mountDialog(next);
          visible = profile.pages[page];
        }, profile.delays?.[page] ?? 100);
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: viewport }),
      dispatchEvent(event) { assert.equal(event.type, 'wheel'); },
    };
    dialog = {
      querySelectorAll(selector) {
        if (selector === 'div') return [scroller];
        assert.equal(selector, 'a[href^="/"]');
        return visible.map(anchor);
      },
    };
  }

  const trigger = {
    tagName: 'A',
    textContent: 'Following',
    parentElement: { get textContent() { return profile.label + ' Following'; } },
    click() {
      mountDialog();
      if (!profile.firstDelay) {
        visible = profile.pages[0];
        return;
      }
      const request = ++generation;
      setTimeout(() => {
        if (request === generation) visible = profile.pages[0];
      }, profile.firstDelay);
    },
  };
  const document = {
    readyState: 'complete',
    body: { lines: [{ textContent: 'Following', parentElement: trigger }] },
    addEventListener() {},
    querySelector(selector) {
      if (selector === 'div[role="dialog"]:not(.onlydm-card)') return dialog;
      assert.match(selector, /^nav a|^img/);
      return null;
    },
    createTreeWalker(node) {
      const lines = node.lines[Symbol.iterator]();
      return {
        currentNode: null,
        nextNode() {
          const { value, done } = lines.next();
          if (!done) this.currentNode = typeof value === 'string' ? { textContent: value } : value;
          return !done;
        },
      };
    },
  };
  const window = {
    chrome: { webview: {
      addEventListener(type, listener) { assert.equal(type, 'message'); onMessage = listener; },
      postMessage(message) { messages.push(message); },
    } },
  };
  vm.runInNewContext(script, {
    window, document, setTimeout, location: { pathname: '/fixture_self/' },
    NodeFilter: { SHOW_TEXT: 4 }, WheelEvent: Event,
    paint(handles) { projected = handles; },
  });

  const send = data => onMessage({ data });
  async function advance(ms) {
    for (let elapsed = 0; elapsed < ms; elapsed += 100) {
      t.mock.timers.tick(100);
      await flush();
    }
  }
  return {
    advance,
    async finish() {
      for (let elapsed = 0; window.__onlydmFriendsState().harvesting && elapsed < 30000; elapsed += 100) {
        await advance(100);
      }
      assert.equal(window.__onlydmFriendsState().harvesting, false, 'harvest should settle');
      assert.equal(messages.some(message => message.type === 'friends-error'), false);
    },
    seed(handles) { send({ type: 'friends-seed', people: handles.map(handle => ({ handle })) }); },
    refresh() { send({ type: 'friends-refresh' }); },
    setSource(next) { profile = next; dialog = null; visible = []; generation += 1; },
    get projected() { return Array.from(projected); },
    get people() { return Array.from(messages.findLast(message => message.type === 'friends-roster')?.people || []); },
    get rosters() {
      return messages.filter(message => message.type === 'friends-roster')
        .map(message => Array.from(message.people, person => person.handle));
    },
  };
}

test('a late virtual page is captured before the next scroll supersedes it', async t => {
  const fx = fixture(t, {
    label: '3', pages: [['fixture_first'], ['fixture_middle'], ['fixture_last']],
    delays: [100, 1300, 100],
  });
  await fx.advance(1800);
  await fx.finish();

  assert.deepEqual(fx.rosters, [['fixture_first', 'fixture_middle', 'fixture_last']]);
});

test('harvest waits for the first rows and recovers a replaced scroller', async t => {
  const fx = fixture(t, {
    label: '3', pages: [['fixture_first'], ['fixture_middle'], ['fixture_last']],
    firstDelay: 1100, detachAt: 1, delays: [100, 3400, 100],
  });
  await fx.advance(1800);
  await fx.finish();

  assert.deepEqual(fx.rosters, [['fixture_first', 'fixture_middle', 'fixture_last']]);
});

test('a short refresh keeps the seeded roster and a complete retry replaces it', async t => {
  const cached = ['fixture_a', 'fixture_b', 'fixture_c'];
  const fx = fixture(t, { label: '3', pages: [['fixture_a']] });
  fx.seed(cached);
  await fx.advance(1800);
  fx.refresh();
  await fx.finish();

  assert.deepEqual(fx.rosters, [], 'a short result must not replace the host cache');
  assert.deepEqual(fx.projected, cached);

  fx.setSource({ label: '2', pages: [['fixture_a', 'fixture_new']] });
  fx.refresh();
  await fx.finish();

  assert.deepEqual(fx.rosters, [['fixture_a', 'fixture_new']]);
  assert.deepEqual(fx.projected, ['fixture_a', 'fixture_new']);
});

test('a cold scan shows incoming pages and publishes a usable partial roster', async t => {
  const fx = fixture(t, { label: '3', pages: [['fixture_first'], ['fixture_second']] });
  await fx.advance(1800);
  assert.deepEqual(fx.projected, ['fixture_first']);

  await fx.advance(700);
  assert.deepEqual(fx.projected, ['fixture_first', 'fixture_second']);
  assert.deepEqual(fx.rosters, []);

  await fx.finish();
  assert.deepEqual(fx.rosters, [['fixture_first', 'fixture_second']]);
});

test('a seed arriving during a cold scan survives an incomplete result', async t => {
  const cached = ['fixture_a', 'fixture_b', 'fixture_c'];
  const fx = fixture(t, { label: '3', pages: [['fixture_start'], ['fixture_a']] });
  await fx.advance(1800);
  fx.seed(cached);
  assert.deepEqual(fx.projected, cached);

  await fx.finish();
  assert.deepEqual(fx.rosters, []);
  assert.deepEqual(fx.projected, cached);
});

test('abbreviated counts preserve the cache and an exact zero clears it', async t => {
  const cached = ['fixture_a', 'fixture_b', 'fixture_c'];
  const fx = fixture(t, { label: '1K', pages: [['fixture_a']] });
  fx.seed(cached);
  await fx.advance(1800);
  fx.refresh();
  await fx.finish();
  assert.deepEqual(fx.rosters, []);
  assert.deepEqual(fx.projected, cached);

  fx.setSource({ label: '0', pages: [[]] });
  fx.refresh();
  await fx.finish();
  assert.deepEqual(fx.rosters, [[]]);
  assert.deepEqual(fx.projected, []);
});

test('following buttons do not become names and names that match UI words survive', async t => {
  const fx = fixture(t, {
    label: '2', pages: [['fixture_a', 'fixture_b']],
    names: { fixture_a: '인증됨', fixture_b: 'Following' },
  });
  await fx.advance(1800);
  await fx.finish();

  assert.deepEqual(fx.people.map(person => person.name), ['인증됨', 'Following']);
});

test('a nameless profile does not inherit its adjacent contact’s handle', async t => {
  const handles = ['fixture_a', 'fixture_b'];
  const fx = fixture(t, { label: '2', pages: [handles], names: {}, adjacent: true });
  await fx.advance(1800);
  await fx.finish();

  assert.deepEqual(fx.people.map(person => person.name), handles);
});

// Model just the DOM operations used by the isolated projection. Source text and
// the host bridge are fixtures, and control creation and event handlers run as written.
function controlsFixture({ count = '3', sourceLabel = 'Following', lang = 'en', ready = true } = {}) {
  const messages = [];
  const listeners = {};
  let receive;
  let avatar = null;
  let sourceDialog = null;
  let triggerClicks = 0;

  function matches(node, selector) {
    const [simple, attr] = selector.split('[');
    if (attr && (attr !== 'data-selected="true"]' || node.dataset.selected !== 'true')) return false;
    if (simple.startsWith('#')) return node.id === simple.slice(1);
    if (simple.startsWith('.')) return node.className.split(' ').includes(simple.slice(1));
    return node.tagName === simple.toUpperCase();
  }

  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); }
    children = [];
    className = '';
    classList = { add: () => {}, contains: name => this.className.split(' ').includes(name) };
    dataset = {};
    attributes = {};
    handlers = {};
    textContent = '';

    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    querySelectorAll(selector) {
      const descendants = this.children.flatMap(node => [node, ...node.querySelectorAll('*')]);
      return selector === '*' ? descendants : descendants.filter(node => node.closest(selector) === node);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) {
      const parts = selector.split(' ');
      for (let node = this; node; node = node.parentElement) {
        if (!matches(node, parts.at(-1))) continue;
        if (parts.length === 1 || node.parentElement?.closest(parts[0])) return node;
      }
      return null;
    }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    get isConnected() { return root.contains(this); }
    get isContentEditable() { return this.contentEditable === 'true'; }
    addEventListener(type, handler) { (this.handlers[type] ??= []).push(handler); }
    fire(type, event) { for (const handler of this.handlers[type] || []) handler(event); }
    click() { this.fire('click', { target: this }); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    blur() { document.activeElement = document.body; this.fire('blur', {}); }
    remove() { this.parentElement.children = this.parentElement.children.filter(node => node !== this); }
  }

  const root = new Element('html');
  root.lang = sourceLabel === 'Following' ? 'en' : 'ko';
  root.append(new Element('head'), new Element('body'));
  const [head, body] = root.children;
  const trigger = new Element('a');
  trigger.textContent = sourceLabel;
  trigger.parentElement = new Element('div');
  trigger.parentElement.textContent = count + ' ' + sourceLabel;
  trigger.addEventListener('click', () => {
    triggerClicks += 1;
    sourceDialog = new Element('div');
  });
  const document = {
    body, head, documentElement: root, activeElement: body, readyState: ready ? 'complete' : 'loading',
    querySelectorAll: selector => root.querySelectorAll(selector),
    getElementById: id => root.querySelector('#' + id),
    createElement: tag => new Element(tag),
    addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); },
    querySelector(selector) {
      if (selector === 'div[role="dialog"]') return root.querySelector('.onlydm-card') || sourceDialog;
      if (selector === 'div[role="dialog"]:not(.onlydm-card)') return sourceDialog;
      return selector.startsWith('img[alt') ? avatar : root.querySelector(selector);
    },
    createTreeWalker() {
      let visited = false;
      return { currentNode: { textContent: sourceLabel, parentElement: trigger },
        nextNode() { if (visited) return false; visited = true; return true; } };
    },
  };
  const window = { chrome: { webview: {
    addEventListener(type, handler) { assert.equal(type, 'message'); receive = handler; },
    postMessage(message) { messages.push(message); },
  } } };
  const context = vm.createContext({ window, document, setTimeout: () => {}, location: { pathname: '/fixture_self/' },
    NodeFilter: { SHOW_TEXT: 4 } });
  const inject = nextLang => vm.runInContext(projection(nextLang), context);
  inject(lang);
  return {
    inject, messages, document,
    get triggerClicks() { return triggerClicks; },
    ready() {
      document.readyState = 'complete';
      for (const handler of listeners.DOMContentLoaded || []) handler();
    },
    query: selector => document.querySelector(selector),
    send: data => receive({ data }),
    addAvatar() { avatar = { src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7' }; },
    key(key, isComposing = false) {
      const event = { key, isComposing, defaultPrevented: false, stopPropagation() {},
        preventDefault() { this.defaultPrevented = true; } };
      const target = document.activeElement;
      for (const handler of listeners.keydown || []) handler(event);
      target.fire('keydown', event);
      return event.defaultPrevented;
    },
  };
}

test('reinjection switches existing accessibility labels and card controls in place', () => {
  const fx = controlsFixture();
  fx.send({ type: 'friends-seed', people: [{ handle: 'fixture_a', name: '원래 이름' }] });
  fx.query('.onlydm-friend').click();
  const editor = fx.query('.onlydm-card-name');
  editor.focus();
  editor.textContent = 'Editing 별명';
  const actions = fx.query('.onlydm-card-actions');
  const refresh = fx.query('.onlydm-refresh');
  for (const [lang, buttonTitle, editLabel, names] of [
    ['ko', '팔로잉 목록 새로고침', '표시 이름 편집', ['1:1 채팅', '음성 통화', '영상 통화']],
    ['en', 'Refresh following list', 'Edit display name', ['Chat', 'Audio call', 'Video call']],
  ]) {
    fx.inject(lang);
    assert.equal(fx.query('#OnlyDmFriends').lang, lang);
    assert.equal(fx.document.documentElement.lang, 'en');
    assert.equal(refresh.title, buttonTitle);
    assert.equal(refresh.getAttribute('aria-label'), buttonTitle);
    assert.equal(editor.getAttribute('aria-label'), editLabel);
    assert.equal(fx.document.getElementById(editor.getAttribute('aria-describedby')).textContent,
      fx.query('.onlydm-card-hint').textContent);
    assert.deepEqual(actions.children.map(button => button.textContent), names);
    assert.equal(fx.document.activeElement, editor);
    assert.equal(editor.textContent, 'Editing 별명');
  }
  assert.equal(fx.query('.onlydm-name').textContent, 'fixture_self');
  assert.equal(fx.query('.onlydm-friend .onlydm-name').textContent, '원래 이름');
  assert.equal(fx.messages.some(message => message.type === 'set-alias'), false);
});

test('reinjecting before DOM ready starts the projection once in the selected language', () => {
  const fx = controlsFixture({ ready: false });
  fx.inject('ko');
  fx.ready();

  assert.equal(fx.query('#OnlyDmFriends').lang, 'ko');
  assert.equal(fx.query('.onlydm-refresh').getAttribute('aria-label'), '팔로잉 목록 새로고침');
  assert.equal(fx.messages.filter(message => message.type === 'friends-ready').length, 1);
});

test('the account button activates once after the avatar arrives and native Enter stays available', () => {
  const fx = controlsFixture({ lang: 'ko' });
  const account = fx.query('.onlydm-me');
  fx.addAvatar();
  fx.inject('ko');

  account.click();
  assert.equal(fx.messages.filter(message => message.type === 'switch-account').length, 1);
  assert.equal(account.tagName, 'BUTTON');
  assert.equal(account.title, '계정 전환');
  account.focus();
  assert.equal(fx.key('Enter'), false);
});

test('the empty label follows the filter and abbreviations do not render as truncated totals', () => {
  const fx = controlsFixture({ count: '1.2만', sourceLabel: '팔로잉' });
  assert.match(fx.query('.onlydm-empty').textContent, /Loading/);
  fx.send({ type: 'friends-filter', query: 'missing' });
  assert.equal(fx.query('.onlydm-empty').textContent, 'No results found.');
  fx.send({ type: 'friends-filter', query: '' });
  fx.send({ type: 'friends-seed', people: [{ handle: 'fixture_a' }, { handle: 'fixture_b' }] });
  assert.equal(fx.query('.onlydm-section-label').textContent, 'Following 2');
  const empty = controlsFixture({ count: '0', lang: 'ko' });
  assert.equal(empty.query('.onlydm-empty').textContent, '팔로잉하는 계정이 없습니다.');
});

test('keyboard selection reaches the friend card and restores focus on Escape', () => {
  const fx = controlsFixture();
  fx.send({ type: 'friends-seed', people: [{ handle: 'fixture_a' }, { handle: 'fixture_b' }] });
  const first = fx.query('.onlydm-friend');
  assert.equal(first.tagName, 'BUTTON');
  first.focus();
  assert.equal(fx.key('ArrowDown'), true);
  const second = fx.document.activeElement;
  assert.equal(second.dataset.handle, 'fixture_b');
  assert.equal(fx.key('Enter'), false);
  second.click();
  assert.equal(fx.document.activeElement.getAttribute('role'), 'dialog');
  assert.equal(fx.query('.onlydm-friend-list').inert, true);
  assert.equal(fx.key('Escape'), true);
  assert.equal(fx.document.activeElement, second);
  assert.equal(fx.query('.onlydm-friend-list').inert, false);
});

test('the friend card cannot satisfy a refresh waiting for Instagram’s following dialog', async () => {
  const fx = controlsFixture({ count: '0' });
  fx.send({ type: 'friends-seed', people: [{ handle: 'fixture_a' }] });
  fx.query('.onlydm-friend').click();
  fx.send({ type: 'friends-refresh' });
  assert.equal(fx.triggerClicks, 1);
  await flush();
  assert.equal(fx.messages.find(message => message.type === 'friends-roster')?.people.length, 0);
});

test('Enter from the host only opens a visible friend and IME keys leave the editor active', () => {
  const fx = controlsFixture({ lang: 'ko' });
  fx.send({ type: 'friends-seed', people: [{ handle: 'fixture_a' }, { handle: 'fixture_b' }] });
  fx.query('.onlydm-friend').click();
  fx.send({ type: 'friends-key', key: 'Escape' });
  fx.send({ type: 'friends-filter', query: 'fixture_b' });
  fx.send({ type: 'friends-key', key: 'Enter' });
  assert.equal(fx.query('.onlydm-card-handle').textContent, '@fixture_b');

  const editor = fx.query('.onlydm-card-name');
  editor.focus();
  editor.textContent = '새 별명';
  for (const key of ['Enter', 'Escape']) {
    assert.equal(fx.key(key, true), false);
    assert.equal(fx.document.activeElement, editor);
    assert.equal(editor.textContent, '새 별명');
  }
  assert.equal(fx.messages.some(message => message.type === 'set-alias'), false);
  assert.equal(fx.key('Enter'), true);
  assert.equal(fx.messages.find(message => message.type === 'set-alias')?.alias, '새 별명');
});

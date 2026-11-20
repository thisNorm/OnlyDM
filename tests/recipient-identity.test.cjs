'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
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

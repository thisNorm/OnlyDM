'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
const { draftPresence } = require('../src/draft-presence.cjs');

function inspect(location, input, files = []) {
  let reads = 0;
  const document = {
    querySelector() { reads++; return input; },
    querySelectorAll() { reads++; return files; },
  };
  const value = runInNewContext('(' + draftPresence.toString() + ')()', { location, document });
  return { value, reads };
}
test('draft checking returns a boolean without touching login or non-official documents', () => {
  const poison = { get value() { throw new Error('auth field touched'); } };
  for (const location of [
    { origin: 'https://www.instagram.com', pathname: '/accounts/login/' },
    { origin: 'https://www.instagram.com', pathname: '/challenge/' },
    { origin: 'https://www.instagram.com', pathname: '/direct/inbox/' },
    { origin: 'https://instagram.com.example.test', pathname: '/direct/t/123/' },
  ]) assert.deepEqual(inspect(location, poison), { value: false, reads: 0 });
});
test('thread draft presence covers empty, text, editable and selected attachment', () => {
  const location = { origin: 'https://www.instagram.com', pathname: '/direct/t/123/' };
  assert.equal(inspect(location, { value: '   ' }).value, false);
  assert.equal(inspect(location, { value: 'synthetic draft' }).value, true);
  assert.equal(inspect(location, { textContent: 'synthetic editable' }).value, true);
  assert.equal(inspect(location, { value: '' }, [{ files: { length: 1 } }]).value, true);
});

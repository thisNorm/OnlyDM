'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { INBOX, routeFor } = require('../src/navigation.cjs');

test('accepts the official inbox, chat, and sign-in steps', () => {
  assert.equal(routeFor(INBOX).kind, 'inbox');
  assert.deepEqual(routeFor('https://www.instagram.com/direct/t/123456?source=inbox#latest'), {
    kind: 'thread',
    id: '123456',
    href: 'https://www.instagram.com/direct/t/123456/',
  });
  for (const path of ['/accounts/login/?next=%2Fdirect%2Finbox%2F', '/accounts/login/two_factor/', '/challenge/123/', '/checkpoint/']) {
    assert.equal(routeFor('https://www.instagram.com' + path).kind, 'login');
  }
});

test('refuses feed, profiles, off-site and ambiguous chat URLs', () => {
  for (const url of [
    'https://www.instagram.com/',
    'https://www.instagram.com/explore/',
    'https://www.instagram.com/direct/requests/',
    'https://www.instagram.com/direct/t/',
    'https://www.instagram.com/direct/t/123%2f456',
    'https://www.instagram.com/direct/t/123/456/',
    'http://www.instagram.com/direct/inbox/',
    'https://www.instagram.com:8443/direct/inbox/',
    'https://www.instagram.com@example.com/direct/inbox/',
    'https://example.com@www.instagram.com/direct/inbox/',
    'https://instagram.com.example.com/direct/t/123/',
    'file:///direct/inbox/',
    '',
  ]) assert.equal(routeFor(url), null, url);
});

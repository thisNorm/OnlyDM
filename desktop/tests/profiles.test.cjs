'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const test = require('node:test');
const { DEFAULT_PROFILE_ID, openProfiles } = require('../src/profiles.cjs');

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const C = 'c'.repeat(32);
const D = 'd'.repeat(32);

function fixture(t, profiles, activeProfileId = DEFAULT_PROFILE_ID) {
  const tempRoot = resolve(tmpdir());
  const userData = mkdtempSync(join(tempRoot, 'onlydm-profiles-test-'));
  t.after(() => {
    assert.equal(dirname(userData), tempRoot);
    rmSync(userData, { recursive: true, force: true });
  });
  const file = join(userData, 'profiles.json');
  writeFileSync(file, JSON.stringify({ profiles, activeProfileId }) + '\n');
  return { userData, file, store: openProfiles(userData) };
}

test('known duplicate handles collapse case-insensitively in input order', (t) => {
  const { store } = fixture(t, [
    { id: DEFAULT_PROFILE_ID, handle: 'Primary.User' },
    { id: A, handle: 'other_user' },
    { id: B, handle: 'PRIMARY.USER' },
    { id: C, handle: 'third' },
    { id: D, handle: 'OTHER_USER' },
  ]);

  assert.deepEqual(store.list.map(({ id }) => id), [DEFAULT_PROFILE_ID, A, C]);
  assert.equal(store.list[0].handle, 'Primary.User');
});

test('an active duplicate wins over an earlier default without moving its position', (t) => {
  const { store } = fixture(t, [
    { id: DEFAULT_PROFILE_ID, handle: 'same.user' },
    { id: A, handle: 'before' },
    { id: B, handle: 'SAME.USER' },
    { id: C, handle: 'after' },
    { id: D, handle: 'Same.User' },
  ], B);

  assert.deepEqual(store.list.map(({ id }) => id), [A, B, C]);
  assert.equal(store.activeId, B);
  assert.equal(store.list[1].handle, 'SAME.USER');
});

test('a nonduplicate active slot keeps the base default and first inactive duplicate', (t) => {
  const { store } = fixture(t, [
    { id: DEFAULT_PROFILE_ID, handle: 'base' },
    { id: A, handle: 'same' },
    { id: B, handle: 'SAME' },
    { id: C, handle: 'active' },
  ], C);

  assert.deepEqual(store.list.map(({ id }) => id), [DEFAULT_PROFILE_ID, A, C]);
  assert.equal(store.activeId, C);
});

test('all unlabelled session slots stay visible alongside known accounts', (t) => {
  const { store } = fixture(t, [
    { id: DEFAULT_PROFILE_ID },
    { id: A },
    { id: B, handle: 'known' },
    { id: C },
    { id: D, handle: 'KNOWN' },
  ], C);

  assert.deepEqual(store.list, [
    { id: DEFAULT_PROFILE_ID },
    { id: A },
    { id: B, handle: 'known' },
    { id: C },
  ]);
});

test('filtering retains raw duplicates and session files across selection and reopening', (t) => {
  const stored = [
    { id: DEFAULT_PROFILE_ID, handle: 'same' },
    { id: A, handle: 'SAME' },
    { id: B, handle: 'other' },
  ];
  const { store, userData, file } = fixture(t, stored, A);
  const metadata = readFileSync(file);
  const sentinels = stored.map(({ id }, index) => {
    const partition = id === DEFAULT_PROFILE_ID ? 'onlydm-instagram' : 'onlydm-instagram-' + id;
    const directory = join(userData, 'Partitions', partition);
    mkdirSync(directory, { recursive: true });
    const sentinel = join(directory, 'session-sentinel');
    const contents = Buffer.from([0, index, 127, 255]);
    writeFileSync(sentinel, contents);
    return { sentinel, contents };
  });

  assert.deepEqual(store.list.map(({ id }) => id), [A, B]);
  assert.deepEqual(openProfiles(userData).list, store.list);
  assert.deepEqual(readFileSync(file), metadata, 'reading the list never rewrites metadata');

  assert.equal(store.select(DEFAULT_PROFILE_ID), true, 'a hidden slot is still selectable');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    profiles: stored,
    activeProfileId: DEFAULT_PROFILE_ID,
  });
  const reopened = openProfiles(userData);
  assert.equal(reopened.activeId, DEFAULT_PROFILE_ID);
  assert.deepEqual(reopened.list.map(({ id }) => id), [DEFAULT_PROFILE_ID, B]);
  assert.deepEqual(reopened.list, store.list);
  for (const { sentinel, contents } of sentinels) {
    assert.deepEqual(readFileSync(sentinel), contents, 'session partition contents stay unchanged');
  }
});

test('a hidden duplicate reappears when its slot adopts a different handle', (t) => {
  const { store, userData, file } = fixture(t, [
    { id: DEFAULT_PROFILE_ID, handle: 'same' },
    { id: A, handle: 'SAME' },
    { id: B, handle: 'other' },
  ]);

  assert.deepEqual(store.list.map(({ id }) => id), [DEFAULT_PROFILE_ID, B]);
  assert.equal(store.select(A), true);
  assert.deepEqual(store.list.map(({ id }) => id), [A, B]);
  assert.equal(store.setHandle('different_user'), true);
  assert.deepEqual(store.list.map(({ id }) => id), [DEFAULT_PROFILE_ID, A, B]);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    profiles: [
      { id: DEFAULT_PROFILE_ID, handle: 'same' },
      { id: A, handle: 'different_user' },
      { id: B, handle: 'other' },
    ],
    activeProfileId: A,
  });
  assert.deepEqual(openProfiles(userData).list, store.list);
});

test('invalid handles never conflate unlabelled slots or valid accounts', (t) => {
  const invalid = ['', null, 42, false, {}, ['known'], '@known', 'known ', ' known', 'known/name', 'x'.repeat(31)];
  const unknown = invalid.map((handle, index) => ({ id: index.toString(16).padStart(32, '0'), handle }));
  const { store } = fixture(t, [
    { id: DEFAULT_PROFILE_ID, handle: 'known' },
    ...unknown,
    { id: A, handle: 'KNOWN' },
  ], unknown[0].id);

  assert.deepEqual(store.list, [
    { id: DEFAULT_PROFILE_ID, handle: 'known' },
    ...unknown.map(({ id }) => ({ id })),
  ]);
  assert.equal(store.activeId, unknown[0].id);
});

test('adding a slot keeps it visible and learning a duplicate handle only filters the list', (t) => {
  const stored = [
    { id: DEFAULT_PROFILE_ID, handle: 'primary' },
    { id: A, handle: 'other' },
  ];
  const { store, file } = fixture(t, stored, A);

  assert.equal(store.add(), true);
  const addedId = store.activeId;
  assert.match(addedId, /^[0-9a-f]{32}$/);
  assert.notEqual(addedId, A);
  assert.deepEqual(store.list, [...stored, { id: addedId }]);

  assert.equal(store.setHandle('PRIMARY'), true);
  assert.deepEqual(store.list, [stored[1], { id: addedId, handle: 'PRIMARY' }]);
  const saved = { profiles: [...stored, { id: addedId, handle: 'PRIMARY' }], activeProfileId: addedId };
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved);

  assert.equal(store.select('missing'), false);
  assert.equal(store.select('f'.repeat(32)), false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), saved);
  assert.equal(store.select(DEFAULT_PROFILE_ID), true);
  assert.deepEqual(store.list, stored);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...saved, activeProfileId: DEFAULT_PROFILE_ID });
});

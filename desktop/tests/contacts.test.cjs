'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openContacts } = require('../src/contacts.cjs');

const identity = { id: 'default', handle: 'My.Account' };
const one = 'https://www.instagram.com/direct/t/101/';
const two = 'https://www.instagram.com/direct/t/202/';

function fixture(t) {
  const root = path.resolve(os.tmpdir());
  const userData = fs.mkdtempSync(path.join(root, 'onlydm-contacts-'));
  t.after(() => {
    assert.equal(path.dirname(userData), root);
    fs.rmSync(userData, { recursive: true, force: true });
  });
  return { userData, store: openContacts(userData, identity),
    file() {
      const files = fs.readdirSync(path.join(userData, 'contacts'));
      assert.equal(files.length, 1);
      assert.match(files[0], /^[a-f0-9]{64}\.json$/);
      return path.join(userData, 'contacts', files[0]);
    } };
}

test('roster, aliases, person links, room names and remembered URLs survive reopening', t => {
  const { userData, store, file } = fixture(t);
  assert.deepEqual(store.friends, []);
  assert.equal(store.setFriends([{ handle: 'ALICE', name: ' Cafe\u0301 ', avatar: 'https://cdn.example/avatar.jpg' },
    { handle: 'alice', name: 'Duplicate' }, { handle: 'bob', name: 'Bob' }]), true);
  assert.deepEqual(store.friends, [{ handle: 'alice', name: 'Café', avatar: 'https://cdn.example/avatar.jpg' },
    { handle: 'bob', name: 'Bob', avatar: '' }]);
  assert.equal(store.setAlias('Alice', ' A\u0301lice at work '), true);
  assert.equal(store.linkPerson('https://instagram.com/direct/t/101?source=inbox', 'ALICE'), true);
  assert.equal(store.rememberThread('name:row-a', one, 'Café'), true);
  assert.equal(store.rememberThread('name:row-b', two, 'Café'), true);
  assert.equal(store.setRoomAlias(two, ' Project group '), true);
  const reopened = openContacts(userData, { id: 'default', handle: 'MY.ACCOUNT' });
  assert.deepEqual(reopened.friends, store.friends);
  assert.equal(reopened.aliasFor('ALICE'), 'Álice at work');
  assert.equal(reopened.handleForThread(one), 'alice');
  assert.equal(reopened.threadUrl('name:row-a'), one);
  assert.equal(reopened.roomAlias(two), 'Project group');
  assert.equal(reopened.display(one, 'Café'), 'Álice at work');
  assert.equal(reopened.display(two, 'Café'), 'Project group');
  assert.equal(reopened.display('', 'Café', 'name:row-a'), 'Álice at work');
  assert.equal(reopened.byThread()['name:row-a'], 'Álice at work');
  assert.equal(reopened.byThread()[one], 'Álice at work');
  assert.equal(reopened.byThread()[one.slice(0, -1)], 'Álice at work');
  assert.equal(reopened.byThread()['/direct/t/101'], 'Álice at work');
  assert.equal(reopened.byThread()['name:row-b'], 'Project group');
  assert.ok(fs.statSync(file()).size > 0);
});

test('the first verified link promotes a pending room name over an existing friend alias', t => {
  const { userData, store } = fixture(t);
  const other = { ...identity, handle: 'other.account' };
  assert.equal(openContacts(userData, other).setAlias('alice', 'Other account'), true);
  assert.equal(store.setAlias('alice', 'Person name'), true);
  assert.equal(store.rememberThread('row', one, 'Original'), true);
  assert.equal(store.setRoomAlias(one, ' Room edit '), true);
  assert.equal(store.setRoomAlias(two, 'Project group'), true);
  assert.equal(store.display(one, 'Original'), 'Room edit');

  assert.equal(openContacts(userData, identity).linkPerson(one, 'ALICE'), true);
  const reopened = openContacts(userData, identity);
  assert.equal(reopened.handleForThread(one), 'alice');
  assert.equal(reopened.aliasFor('alice'), 'Room edit');
  assert.equal(reopened.roomAlias(one), null);
  assert.equal(reopened.byThread().row, 'Room edit');
  assert.equal(reopened.display(two, 'Original'), 'Project group');
  assert.equal(openContacts(userData, other).aliasFor('alice'), 'Other account');

  assert.equal(reopened.setAlias('alice', 'Later friend edit'), true);
  assert.equal(reopened.linkPerson(one, 'alice'), true);
  assert.equal(reopened.display(one, 'Original'), 'Later friend edit');
  assert.equal(reopened.setAlias('ALICE', ''), true);
  assert.equal(reopened.display(one, ' Original '), 'Original');
});

test('relinking an already linked room leaves its former person alias with that person', t => {
  const { userData, store } = fixture(t);
  assert.equal(store.linkPerson(one, 'alice'), true);
  assert.equal(store.setRoomAlias(one, 'Legacy room name'), true);
  assert.equal(store.linkPerson(one, 'ALICE'), true);
  assert.equal(store.display(one, 'Original'), 'Legacy room name');
  assert.equal(store.setAlias('alice', 'Alice locally'), true);

  assert.equal(store.linkPerson(one, 'bob'), true);
  const reopened = openContacts(userData, identity);
  assert.equal(reopened.handleForThread(one), 'bob');
  assert.equal(reopened.aliasFor('alice'), 'Alice locally');
  assert.equal(reopened.aliasFor('bob'), null);
  assert.equal(reopened.roomAlias(one), null);
  assert.equal(reopened.display(one, 'Original'), 'Original');
});

test('equal titles never infer people or merge group rooms', t => {
  const { store } = fixture(t);
  store.setFriends([{ handle: 'alice', name: 'Same' }, { handle: 'bob', name: 'Same' }]);
  store.setAlias('alice', 'Alice locally');
  store.setAlias('bob', 'Bob locally');
  store.rememberThread('row-a', one, 'Same');
  store.rememberThread('row-b', two, 'Same');
  store.setRoomAlias(one, 'Only this room');
  assert.equal(store.display(two, 'Same'), 'Same');
  assert.equal(store.byThread()['row-b'], undefined);
  store.linkPerson(two, 'bob');
  assert.equal(store.display(two, 'Same'), 'Bob locally');
  assert.equal(store.display(one, 'Same'), 'Only this room');
  assert.equal(store.display(one, 'Same', 'row-b'), 'Only this room');
});

test('a reused provisional row key becomes ambiguous across reopen, without conflating the rooms', t => {
  const { userData, store } = fixture(t);
  store.setRoomAlias(one, 'First');
  store.setRoomAlias(two, 'Second');
  assert.equal(store.rememberThread('name:collision', one, 'Same'), true);
  assert.equal(store.rememberThread('name:collision', two, 'Same'), true);
  assert.equal(store.threadUrl('name:collision'), null);
  assert.equal(store.byThread()['name:collision'], undefined);
  assert.equal(store.byThread()[one], 'First');
  assert.equal(store.byThread()[two], 'Second');
  const reopened = openContacts(userData, identity);
  assert.equal(reopened.threadUrl('name:collision'), null);
  assert.equal(reopened.rememberThread('name:collision', one, 'Same'), true);
  assert.equal(reopened.threadUrl('name:collision'), null);
});

test('only exact official HTTPS DM thread routes are accepted and canonicalized', t => {
  const { store, file } = fixture(t);
  assert.equal(store.rememberThread('row', 'https://instagram.com/direct/t/Ab_c-9?x=1#end', 'Title'), true);
  assert.equal(store.threadUrl('row'), 'https://www.instagram.com/direct/t/Ab_c-9/');
  const before = fs.readFileSync(file());
  for (const href of [null, {}, '', '/direct/t/101/', 'http://www.instagram.com/direct/t/101/',
    'https://www.instagram.com.evil.test/direct/t/101/', 'https://evil.test/direct/t/101/',
    'https://user:password@www.instagram.com/direct/t/101/', 'https://www.instagram.com:444/direct/t/101/',
    'https://www.instagram.com/direct/inbox/', 'https://www.instagram.com/direct/t/',
    'https://www.instagram.com/direct/t/../101/', 'https://www.instagram.com/direct/inbox/../t/101/',
    'https://www.instagram.com/direct/t/%31/', 'https://www.instagram.com/direct/t/101/extra/',
    'https://www.instagram.com//direct/t/101/', 'https://www.instagram.com/direct/t/101//',
    'https://www.instagram.com/direct/t/101/\n', 'https://www.instagram.com\\direct/t/101/',
    'file:///direct/t/101', 'javascript:alert(1)', one + '?q=' + 'x'.repeat(2048)]) {
    assert.equal(store.linkPerson(href, 'alice'), false, String(href));
    assert.equal(store.setRoomAlias(href, 'Alias'), false, String(href));
    assert.equal(store.rememberThread('row', href, 'Title'), false, String(href));
    assert.equal(store.handleForThread(href), null);
    assert.equal(store.roomAlias(href), null);
    assert.equal(store.display(href, 'Original', 'row'), 'Original');
  }
  assert.deepEqual(fs.readFileSync(file()), before);
});

test('account id and normalized current handle both isolate private hashed storage', t => {
  const { userData, store } = fixture(t);
  store.setAlias('friend', 'Private to A');
  for (const other of [{ id: 'other-slot', handle: identity.handle }, { id: identity.id, handle: 'other.account' }]) {
    const isolated = openContacts(userData, other);
    assert.equal(isolated.aliasFor('friend'), null);
    assert.deepEqual(isolated.friends, []);
    assert.equal(isolated.setAlias('friend', 'Private to B'), true);
  }
  assert.equal(openContacts(userData, identity).aliasFor('friend'), 'Private to A');
  const files = fs.readdirSync(path.join(userData, 'contacts'));
  assert.equal(files.length, 3);
  assert.ok(files.every(file => /^[a-f0-9]{64}\.json$/.test(file)));
});

test('unknown or invalid identity and relative data roots are inert and never touch session files', t => {
  const { userData } = fixture(t);
  const sentinel = path.join(userData, 'Cookies');
  fs.writeFileSync(sentinel, 'unrelated session sentinel');
  for (const who of [undefined, null, 'account', {}, { id: 'default' }, { id: '../escape', handle: 'valid' },
    { id: '..\\escape', handle: 'valid' }, { id: '/absolute', handle: 'valid' },
    { id: 'x'.repeat(129), handle: 'valid' }, { id: 'default', handle: '@invalid' }]) {
    const store = openContacts(userData, who);
    assert.equal(store.setAlias('alice', 'Name'), false);
    assert.equal(store.setFriends([]), false);
    assert.deepEqual(store.friends, []);
    assert.deepEqual(store.byThread(), {});
  }
  assert.equal(openContacts('../outside', identity).setAlias('alice', 'Name'), false);
  assert.deepEqual(fs.readdirSync(userData), ['Cookies']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unrelated session sentinel');
});

test('search translates handles, NFC original names and local person aliases to original roster names', t => {
  const { store } = fixture(t);
  store.setFriends([{ handle: 'alice.work', name: 'Cafe\u0301' }, { handle: 'alice.home', name: 'CAFÉ' },
    { handle: 'bob', name: 'Other' }]);
  store.setAlias('alice.work', ' Boss ');
  assert.deepEqual(store.aliasesFor('@ALICE'), ['Café']);
  assert.deepEqual(store.aliasesFor('boSS'), ['Café']);
  assert.deepEqual(store.aliasesFor('Cafe\u0301'), ['Café']);
  assert.deepEqual(store.aliasesFor('other'), ['Other']);
  for (const query of ['', 'a', '  ', null, {}, 'x'.repeat(257)]) assert.deepEqual(store.aliasesFor(query), []);
  store.setFriends(Array.from({ length: 25 }, (_, i) => ({ handle: 'match' + i, name: 'Person ' + i })));
  assert.equal(store.aliasesFor('match').length, 20);
});

test('getters and returned alias maps cannot mutate the store, including prototype-shaped keys', t => {
  const { store, userData } = fixture(t);
  store.setFriends([{ handle: '__proto__', name: 'Original' }]);
  store.setAlias('__proto__', 'Local');
  store.linkPerson(one, '__proto__');
  store.rememberThread('__proto__', one, 'Original');
  const friends = store.friends;
  friends[0].name = 'Changed';
  friends.push({ handle: 'extra', name: 'Extra' });
  const byHandle = store.byHandle();
  assert.equal(Object.getPrototypeOf(byHandle), Object.prototype);
  assert.equal(Object.hasOwn(byHandle, '__proto__'), true);
  byHandle.__proto__ = 'Changed';
  const byThread = store.byThread();
  assert.equal(byThread.__proto__, 'Local');
  byThread.__proto__ = 'Changed';
  assert.equal(store.friends.length, 1);
  assert.equal(store.friends[0].name, 'Original');
  assert.equal(store.aliasFor('__proto__'), 'Local');
  assert.equal(store.byThread().__proto__, 'Local');
  assert.equal(openContacts(userData, identity).byThread().__proto__, 'Local');
});

test('invalid or oversized updates retain all previous data and persist only the presentation whitelist', t => {
  const { store, file } = fixture(t);
  store.setFriends([{ handle: 'alice', name: 'Original', message: 'SECRET_MESSAGE',
    cookies: 'SECRET_COOKIE', password: 'SECRET_PASSWORD' }]);
  const before = fs.readFileSync(file());
  for (const roster of [null, {}, [null], [{ handle: '../alice', name: 'Name' }],
    [{ handle: 'alice', name: '' }], [{ handle: 'alice', name: 'x'.repeat(257) }],
    [{ handle: 'alice', name: 'Name', avatar: 'file:///private/cookies' }],
    [{ handle: 'alice', name: 'Name', avatar: 'https://user:password@example.com/a' }],
    Array.from({ length: 2001 }, () => ({ handle: 'alice', name: 'Name' }))]) {
    assert.equal(store.setFriends(roster), false);
  }
  for (const handle of [null, {}, '@alice', '../alice', 'x'.repeat(31), 'alice\n']) {
    assert.equal(store.setAlias(handle, 'Name'), false);
    assert.equal(store.linkPerson(one, handle), false);
  }
  for (const value of [null, {}, 'x'.repeat(257), 'line\u0000break']) {
    assert.equal(store.setAlias('alice', value), false);
    assert.equal(store.setRoomAlias(one, value), false);
    assert.equal(store.rememberThread('row', one, value), false);
  }
  assert.equal(store.rememberThread('x'.repeat(513), one, 'Title'), false);
  const giant = Array.from({ length: 2000 }, (_, i) => ({ handle: 'person' + i, name: 'Name',
    avatar: 'https://cdn.example/' + 'x'.repeat(1950) }));
  assert.equal(store.setFriends(giant), false, 'the whole serialized store is bounded too');
  assert.deepEqual(fs.readFileSync(file()), before);
  assert.doesNotMatch(before.toString(), /SECRET_|message|cookies|password/);
});

test('failed name promotion retains both aliases and leaves the room unlinked until retry', t => {
  const { store, file } = fixture(t);
  assert.equal(store.setAlias('alice', 'Before'), true);
  assert.equal(store.setRoomAlias(one, 'Pending'), true);
  const target = file(), backup = target + '.backup';
  const saved = fs.readFileSync(target);
  fs.renameSync(target, backup);
  fs.mkdirSync(target);
  assert.equal(store.linkPerson(one, 'alice'), false);
  assert.equal(store.handleForThread(one), null);
  assert.equal(store.aliasFor('alice'), 'Before');
  assert.equal(store.roomAlias(one), 'Pending');
  assert.equal(fs.readdirSync(path.dirname(target)).some(name => name.endsWith('.tmp')), false);
  assert.deepEqual(fs.readFileSync(backup), saved);
  fs.rmdirSync(target);
  fs.renameSync(backup, target);
  assert.equal(store.linkPerson(one, 'alice'), true);
  assert.equal(store.aliasFor('alice'), 'Pending');
  assert.equal(store.roomAlias(one), null);
  assert.equal(fs.readdirSync(path.dirname(target)).length, 1);
});

test('malformed, incompatible and oversized files load empty without rewriting or reading session data', t => {
  const { userData, store, file } = fixture(t);
  store.setAlias('alice', 'Name');
  const target = file();
  for (const content of ['{', 'null', '[]', '{"version":99}', ' '.repeat(2 * 1024 * 1024 + 1)]) {
    fs.writeFileSync(target, content);
    const opened = openContacts(userData, identity);
    assert.deepEqual(opened.friends, []);
    assert.equal(opened.aliasFor('alice'), null);
    assert.deepEqual(opened.byThread(), {});
    assert.equal(fs.statSync(target).size, Buffer.byteLength(content));
  }
});

test('explicitly saving an empty roster repairs a corrupt cache instead of claiming an unwritten success', t => {
  const { userData, store, file } = fixture(t);
  store.setAlias('alice', 'Old');
  const target = file();
  fs.writeFileSync(target, '{broken');
  const reopened = openContacts(userData, identity);
  assert.equal(reopened.setFriends([]), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')).friends, []);
  assert.equal(openContacts(userData, identity).aliasFor('alice'), null);
});

test('a conflicting URL-shaped cached row key cannot rename a different room', t => {
  const { userData, store, file } = fixture(t);
  store.setRoomAlias(one, 'First');
  store.setRoomAlias(two, 'Second');
  store.rememberThread('row-a', one, 'Same');
  store.rememberThread('row-b', two, 'Same');
  assert.equal(store.rememberThread(one, two, 'Same'), false);
  const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  saved.rows[one] = two;
  fs.writeFileSync(file(), JSON.stringify(saved));
  const reopened = openContacts(userData, identity);
  assert.notEqual(reopened.byThread()[one], 'Second');
  assert.equal(reopened.threadUrl(one), null);
});

test('existing symlinked contact directories cannot redirect writes outside the data root', t => {
  const { userData } = fixture(t);
  const outside = path.join(userData, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(userData, 'contacts'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(openContacts(userData, identity).setAlias('alice', 'Name'), false);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('POSIX files/directories are private; linked files cannot read or overwrite another file', {
  skip: process.platform === 'win32',
}, t => {
  const { userData, store, file } = fixture(t);
  store.setAlias('alice', 'Private');
  const target = file();
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  fs.chmodSync(target, 0o666);
  assert.equal(store.setAlias('alice', 'Private'), true);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'even an idempotent save restores private file permissions');
  const outside = path.join(userData, 'unrelated.json');
  fs.renameSync(target, outside);
  fs.symlinkSync(outside, target);
  const linked = openContacts(userData, identity);
  assert.equal(linked.aliasFor('alice'), null);
  assert.equal(linked.setAlias('alice', 'Changed'), false);
  assert.ok(fs.readFileSync(outside, 'utf8').includes('Private'));
});

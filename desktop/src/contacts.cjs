'use strict';

const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE = 2 * 1024 * 1024;
const MAX_PEOPLE = 2000;
const MAX_ROWS = 4000;
const CONTROL = /[\u0000-\u001f\u007f]/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const handle = value => typeof value === 'string' && !CONTROL.test(value)
  && /^[a-z0-9._]{1,30}$/i.test(value) ? value.toLowerCase() : null;

function text(value, limit = 256) {
  return typeof value === 'string' && value.length <= limit && !CONTROL.test(value)
    ? value.normalize('NFC').trim() : null;
}

function rowKey(value) {
  return typeof value === 'string' && value.length <= 512 && !CONTROL.test(value)
    ? value.normalize('NFC') : null;
}

function thread(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  const url = /^https:\/\/((?:www\.)?instagram\.com(?::443)?)(\/[^?#]*)(?:[?#].*)?$/i.exec(value);
  const route = url && /^\/direct\/t\/([a-zA-Z0-9_-]{1,200})\/?$/.exec(url[2]);
  return route ? `https://www.instagram.com/direct/t/${route[1]}/` : null;
}

function threadForKey(key) {
  return thread(key) || (key.startsWith('/direct/t/') ? thread('https://www.instagram.com' + key) : null);
}

function roster(value) {
  if (!Array.isArray(value) || value.length > MAX_PEOPLE) return null;
  const people = new Map();
  for (const person of value) {
    if (!object(person)) return null;
    const username = handle(person.handle), name = text(person.name);
    let avatar = person.avatar === undefined ? '' : person.avatar;
    if (!username || !name || typeof avatar !== 'string' || avatar.length > 2048 || CONTROL.test(avatar)) return null;
    if (avatar) {
      try {
        const url = new URL(avatar);
        if (url.protocol !== 'https:' || url.username || url.password) return null;
        avatar = url.href;
      } catch { return null; }
    }
    if (!people.has(username)) people.set(username, { handle: username, name, avatar });
  }
  return [...people.values()];
}

function empty() {
  return { friends: [], aliases: new Map(), people: new Map(), rooms: new Map(), threads: new Map(), rows: new Map() };
}

function encode(data) {
  return JSON.stringify({ version: 1, friends: data.friends,
    ...Object.fromEntries(['aliases', 'people', 'rooms', 'threads', 'rows']
      .map(key => [key, Object.fromEntries(data[key])])) }) + '\n';
}

function decode(saved) {
  if (!object(saved) || saved.version !== 1) throw new Error('Unsupported contacts file');
  const data = empty();
  data.friends = roster(saved.friends);
  if (!data.friends) throw new Error('Invalid roster');
  for (const key of ['aliases', 'people', 'rooms', 'threads', 'rows']) {
    if (!object(saved[key])) throw new Error('Invalid contacts map');
    const entries = Object.entries(saved[key]);
    if (entries.length > (key === 'rows' ? MAX_ROWS : MAX_PEOPLE)) throw new Error('Contacts limit');
    for (const [rawKey, rawValue] of entries) {
      const name = key === 'aliases' ? handle(rawKey) : key === 'rows' ? rowKey(rawKey) : thread(rawKey);
      const value = key === 'people' ? handle(rawValue) : key === 'rows'
        ? rawValue === null ? null : thread(rawValue) : text(rawValue);
      if (!name || (value === null && !(key === 'rows' && rawValue === null))
        || (!value && key !== 'rows' && key !== 'threads')) throw new Error('Invalid contacts entry');
      data[key].set(name, value);
    }
  }
  for (const [key, href] of data.rows) {
    const addressed = threadForKey(key);
    if (href !== null && (!data.threads.has(href) || (addressed && addressed !== href)))
      throw new Error('Invalid remembered thread');
  }
  return data;
}

/** Identity is supplied by the host: { id: opaque account slot, handle: current own handle }.
 * Both scope the file. An unidentified account is inert until the host reopens it.
 * Keep one live store per identity; independent writers do not coordinate snapshots.
 */
function openContacts(userData, identity) {
  const username = object(identity) && handle(identity.handle);
  const validIdentity = username && typeof identity.id === 'string' && !CONTROL.test(identity.id)
    && /^[a-zA-Z0-9_-]{1,128}$/.test(identity.id);
  const enabled = !!validIdentity && typeof userData === 'string' && userData.length <= 4096
    && !CONTROL.test(userData) && path.isAbsolute(userData) && !userData.split(/[\\/]/).includes('..');
  const directory = enabled ? path.join(userData, 'contacts') : '';
  const file = enabled ? path.join(directory,
    createHash('sha256').update(JSON.stringify([identity.id, username])).digest('hex') + '.json') : '';
  let data = empty();
  let savedPayload = null;

  function directories(create = false) {
    if (create) fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
    const root = fs.lstatSync(userData);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Invalid data directory');
    if (create) {
      try { fs.mkdirSync(directory, { mode: 0o700 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid contacts directory');
    if (create) fs.chmodSync(directory, 0o700);
  }

  function regularFile() {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Invalid contacts file');
      return stat;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  if (enabled) {
    let fd;
    try {
      directories();
      const stat = regularFile();
      if (stat && stat.size <= MAX_FILE) {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        const opened = fs.fstatSync(fd);
        if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_FILE) throw new Error('Invalid contacts file');
        const buffer = Buffer.alloc(MAX_FILE + 1);
        let size = 0, count;
        do {
          count = fs.readSync(fd, buffer, size, buffer.length - size, null);
          size += count;
        } while (count && size < buffer.length);
        if (size > MAX_FILE) throw new Error('Contacts file too large');
        data = decode(JSON.parse(buffer.subarray(0, size).toString('utf8')));
        savedPayload = encode(data);
      }
    } catch { /* Missing/corrupt cache never opens session data or prevents startup. */ }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }

  function save(next) {
    if (!enabled || next.friends.length > MAX_PEOPLE || ['aliases', 'people', 'rooms', 'threads']
      .some(key => next[key].size > MAX_PEOPLE) || next.rows.size > MAX_ROWS) return false;
    const payload = encode(next);
    if (Buffer.byteLength(payload) > MAX_FILE) return false;
    const temp = file + '.' + randomBytes(12).toString('hex') + '.tmp';
    let fd, created = false;
    try {
      directories(true);
      const existing = regularFile();
      if (existing && payload === savedPayload
        && (process.platform === 'win32' || (existing.mode & 0o777) === 0o600)) return true;
      fd = fs.openSync(temp, 'wx', 0o600);
      created = true;
      fs.writeFileSync(fd, payload);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, file);
      created = false;
      data = next;
      savedPayload = payload;
      return true;
    } catch { return false; }
    finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (created) { try { fs.unlinkSync(temp); } catch { /* Preserve unrelated files. */ } }
    }
  }

  function setMap(key, name, value) {
    const map = new Map(data[key]);
    if (value === '') map.delete(name); else map.set(name, value);
    return save({ ...data, [key]: map });
  }

  function knownUrl(key) {
    const normalized = rowKey(key);
    if (normalized === null) return null;
    if (data.rows.has(normalized)) return data.rows.get(normalized);
    const href = threadForKey(normalized);
    return data.threads.has(href) ? href : null;
  }

  function localName(href) {
    return data.aliases.get(data.people.get(href)) || data.rooms.get(href) || null;
  }

  return {
    get friends() { return data.friends.map(person => ({ ...person })); },
    setFriends(people) {
      const friends = roster(people);
      return friends !== null && save({ ...data, friends });
    },
    setAlias(value, alias) {
      const name = handle(value), normalized = text(alias);
      return !!name && normalized !== null && setMap('aliases', name, normalized);
    },
    aliasFor(value) { return data.aliases.get(handle(value)) || null; },
    byHandle() { return Object.fromEntries(data.aliases); },
    linkPerson(href, value) {
      const url = thread(href), name = handle(value);
      if (!url || !name) return false;
      const previousHandle = data.people.get(url);
      const roomAlias = data.rooms.get(url);
      if (!roomAlias || previousHandle === name) return setMap('people', url, name);

      const people = new Map(data.people).set(url, name);
      const rooms = new Map(data.rooms);
      rooms.delete(url);
      // A legacy room name belonging to a previous link cannot follow a different person.
      const aliases = previousHandle ? data.aliases : new Map(data.aliases).set(name, roomAlias);
      return save({ ...data, people, rooms, aliases });
    },
    handleForThread(href) { return data.people.get(thread(href)) || null; },
    setRoomAlias(href, alias) {
      const url = thread(href), normalized = text(alias);
      return !!url && normalized !== null && setMap('rooms', url, normalized);
    },
    roomAlias(href) { return data.rooms.get(thread(href)) || null; },
    rememberThread(key, href, title) {
      const url = thread(href), normalized = rowKey(key), name = text(title);
      if (!url || normalized === null || name === null) return false;
      const addressedKey = threadForKey(normalized);
      if (addressedKey && addressedKey !== url) return false;
      const threads = new Map(data.threads).set(url, name);
      const rows = new Map(data.rows);
      // Provisional projection keys can collide; never redirect one to another room.
      if (normalized) rows.set(normalized, !rows.has(normalized) || rows.get(normalized) === url ? url : null);
      return save({ ...data, threads, rows });
    },
    threadUrl(key) { return knownUrl(key); },
    display(href, title, key = '') {
      const url = thread(href) || (!href ? knownUrl(key) : null);
      return localName(url) || text(title) || '';
    },
    byThread() {
      const map = new Map();
      for (const href of new Set([...data.people.keys(), ...data.rooms.keys()])) {
        const alias = localName(href);
        if (!alias) continue;
        const pathname = href.slice('https://www.instagram.com'.length);
        for (const key of [href, href.slice(0, -1), pathname, pathname.slice(0, -1),
          href.replace('www.', ''), href.replace('www.', '').slice(0, -1)]) map.set(key, alias);
      }
      for (const [key, href] of data.rows) {
        const alias = localName(href);
        if (alias) map.set(key, alias);
      }
      return Object.fromEntries(map);
    },
    aliasesFor(query) {
      const normalized = text(query);
      const search = normalized?.replace(/^@/, '').toLowerCase();
      if (!search || search.length < 2) return [];
      const originals = new Map();
      for (const person of data.friends) {
        if ([person.handle, person.name, data.aliases.get(person.handle) || '']
          .some(value => value.toLowerCase().includes(search))) {
          const key = person.name.toLowerCase();
          if (!originals.has(key)) originals.set(key, person.name);
          if (originals.size === 20) break;
        }
      }
      return [...originals.values()];
    },
  };
}

module.exports = { openContacts };

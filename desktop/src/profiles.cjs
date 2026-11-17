'use strict';

const { randomBytes } = require('node:crypto');
const { readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const DEFAULT_PROFILE_ID = 'default';
const opaqueId = () => randomBytes(16).toString('hex');
const validId = (id) => id === DEFAULT_PROFILE_ID || (typeof id === 'string' && /^[0-9a-f]{32}$/.test(id));
const validHandle = (handle) => typeof handle === 'string' && /^[A-Za-z0-9._]{1,30}$/.test(handle);

function readProfiles(file) {
  const profiles = new Map();
  let activeProfileId = DEFAULT_PROFILE_ID;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(saved?.profiles)) {
      for (const profile of saved.profiles) {
        const id = profile?.id;
        if (!validId(id) || profiles.has(id)) continue;
        profiles.set(id, validHandle(profile.handle) ? { id, handle: profile.handle } : { id });
      }
      if (profiles.has(saved.activeProfileId)) activeProfileId = saved.activeProfileId;
    }
  } catch { /* Missing or unreadable metadata uses the original partition. */ }
  const defaultProfile = profiles.get(DEFAULT_PROFILE_ID) || { id: DEFAULT_PROFILE_ID };
  profiles.delete(DEFAULT_PROFILE_ID);
  return { profiles: [defaultProfile, ...profiles.values()], activeProfileId };
}

function openProfiles(userData) {
  const file = path.join(userData, 'profiles.json');
  let data = readProfiles(file);

  function save(next) {
    const temp = file + '.' + opaqueId() + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temp, file);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        try { unlinkSync(temp); } catch { /* The temporary file may not exist. */ }
      }
      console.error('OnlyDM could not save account profiles.');
      return false;
    }
    data = next;
    return true;
  }

  return {
    get list() { return data.profiles; },
    get activeId() { return data.activeProfileId; },
    select(id) {
      if (!validId(id) || id === data.activeProfileId || !data.profiles.some((profile) => profile.id === id)) return false;
      return save({ ...data, activeProfileId: id });
    },
    add() {
      let id = opaqueId();
      while (data.profiles.some((profile) => profile.id === id)) id = opaqueId();
      return save({ profiles: [...data.profiles, { id }], activeProfileId: id });
    },
    setHandle(handle) {
      if (!validHandle(handle)) return false;
      const active = data.profiles.find((profile) => profile.id === data.activeProfileId);
      if (active.handle === handle) return false;
      return save({
        ...data,
        profiles: data.profiles.map((profile) => profile === active ? { id: active.id, handle } : profile),
      });
    },
  };
}

module.exports = { DEFAULT_PROFILE_ID, openProfiles };

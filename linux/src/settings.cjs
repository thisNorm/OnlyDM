'use strict';

const { randomUUID } = require('node:crypto');
const { readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const CHAT_THEMES = ['system', 'light', 'dark', 'custom'];
const LIGHT_CHAT_COLORS = Object.freeze({ background: '#FFFFFF', incoming: '#F0F2F4', outgoing: '#4257C9' });
const COLOR_KEYS = Object.keys(LIGHT_CHAT_COLORS);

function normalizeChatColors(colors) {
  if (!colors || typeof colors !== 'object' || Object.keys(colors).length !== COLOR_KEYS.length) return null;
  const normalized = {};
  for (const key of COLOR_KEYS) {
    const value = colors[key];
    if (!Object.hasOwn(colors, key) || typeof value !== 'string' || !/^#?[0-9a-f]{6}$/i.test(value)) return null;
    normalized[key] = '#' + value.replace(/^#/, '').toUpperCase();
  }
  return Object.freeze(normalized);
}

function openSettings(userData) {
  const file = path.join(userData, 'settings.json');
  let stored;
  try {
    stored = JSON.parse(readFileSync(file, 'utf8'));
  } catch { /* Use defaults if the file is missing or unreadable. */ }
  let state = {
    workModeEnabled: stored?.workModeEnabled === true,
    chatTheme: CHAT_THEMES.includes(stored?.chatTheme) ? stored.chatTheme : 'system',
    chatColors: normalizeChatColors(stored?.chatColors) || LIGHT_CHAT_COLORS,
  };

  function save(next) {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temp, file);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        try { unlinkSync(temp); } catch { /* The temporary file may not exist. */ }
      }
      console.error('OnlyDM could not save settings.');
      return false;
    }
    state = next;
    return true;
  }

  return {
    get workModeEnabled() { return state.workModeEnabled; },
    get chatTheme() { return state.chatTheme; },
    get chatColors() { return state.chatColors; },
    setWorkMode(enabled) {
      if (typeof enabled !== 'boolean') return false;
      return enabled === state.workModeEnabled || save({ ...state, workModeEnabled: enabled });
    },
    setChatTheme(chatTheme, colors) {
      const chatColors = normalizeChatColors(colors);
      if (!CHAT_THEMES.includes(chatTheme) || !chatColors) return false;
      if (chatTheme === state.chatTheme && COLOR_KEYS.every(key => chatColors[key] === state.chatColors[key])) return true;
      return save({ ...state, chatTheme, chatColors });
    },
  };
}

module.exports = { openSettings };

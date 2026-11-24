'use strict';

const { randomUUID } = require('node:crypto');
const { readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const CHAT_THEMES = ['system', 'light', 'dark', 'custom'];
const LANGUAGES = ['auto', 'ko', 'en'];
const BOOLEAN_PREFERENCES = ['notificationsEnabled', 'notificationPreviewEnabled', 'startInTray'];
const LIGHT_CHAT_COLORS = Object.freeze({ background: '#FFFFFF', incoming: '#F0F2F4', outgoing: '#4257C9' });
const { appDefaults: LIGHT_APP_COLORS } = require('./colors.js');
const COLOR_KEYS = Object.keys(LIGHT_CHAT_COLORS);

function normalizeColors(colors, keys) {
  if (!colors || typeof colors !== 'object' || Object.keys(colors).length !== keys.length) return null;
  const normalized = {};
  for (const key of keys) {
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
    appColors: normalizeColors(stored?.appColors, ['chrome', 'background']) || LIGHT_APP_COLORS,
    language: LANGUAGES.includes(stored?.language) ? stored.language : 'auto',
    notificationsEnabled: typeof stored?.notificationsEnabled === 'boolean' ? stored.notificationsEnabled : true,
    notificationPreviewEnabled: typeof stored?.notificationPreviewEnabled === 'boolean' ? stored.notificationPreviewEnabled : true,
    startInTray: stored?.startInTray === true,
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
    get appColors() { return state.appColors; },
    get language() { return state.language; },
    get notificationsEnabled() { return state.notificationsEnabled; },
    get notificationPreviewEnabled() { return state.notificationPreviewEnabled; },
    get startInTray() { return state.startInTray; },
    setPreference(key, value) {
      if (typeof key !== 'string') return false;
      if (key === 'language' ? !LANGUAGES.includes(value)
        : !BOOLEAN_PREFERENCES.includes(key) || typeof value !== 'boolean') return false;
      return value === state[key] || save({ ...state, [key]: value });
    },
    setWorkMode(enabled) {
      if (typeof enabled !== 'boolean') return false;
      return enabled === state.workModeEnabled || save({ ...state, workModeEnabled: enabled });
    },
    setChatTheme(chatTheme, colors, appColors = state.appColors) {
      const chatColors = normalizeChatColors(colors);
      const normalizedApp = normalizeColors(appColors, ['chrome', 'background']);
      if (!CHAT_THEMES.includes(chatTheme) || !chatColors || !normalizedApp) return false;
      if (chatTheme === state.chatTheme && COLOR_KEYS.every(key => chatColors[key] === state.chatColors[key])
        && normalizedApp.chrome === state.appColors.chrome && normalizedApp.background === state.appColors.background) return true;
      return save({ ...state, chatTheme, chatColors, appColors: normalizedApp });
    },
  };
}

function normalizeChatColors(colors) { return normalizeColors(colors, COLOR_KEYS); }

function resolveLanguage(preference, systemLocale) {
  if (preference !== 'auto') return preference;
  return /^ko(?:-|$)/i.test(systemLocale) ? 'ko' : 'en';
}

module.exports = { openSettings, resolveLanguage };

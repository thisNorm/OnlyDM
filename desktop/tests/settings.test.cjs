'use strict';

const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { openSettings } = require('../src/settings.cjs');
const lightColors = { background: '#FFFFFF', incoming: '#F0F2F4', outgoing: '#4257C9' };
const customColors = { background: '#123456', incoming: '#ABCDEF', outgoing: '#455674' };
const appColors = { chrome: '#EEF1F5', background: '#FFFFFF' };
const preferenceDefaults = { language: 'auto', notificationsEnabled: true, notificationPreviewEnabled: true, startInTray: false };

function fixture(t) {
  const userData = mkdtempSync(join(tmpdir(), 'onlydm-settings-test-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  return { userData, file: join(userData, 'settings.json') };
}

test('Work mode defaults off for missing, malformed, or non-boolean settings', (t) => {
  const { userData, file } = fixture(t);
  assert.equal(openSettings(userData).workModeEnabled, false, 'missing file');
  for (const data of ['{', 'null', '[]', '{}', '{"workModeEnabled":"true"}', '{"workModeEnabled":1}',
    '{"workModeEnabled":null}', '{"workModeEnabled":{}}']) {
    writeFileSync(file, data);
    assert.equal(openSettings(userData).workModeEnabled, false, data);
  }
});

test('only a boolean updates Work mode and survives reopening settings', (t) => {
  const { userData, file } = fixture(t);
  writeFileSync(file, '{"workModeEnabled":false,"unrelated":true}');
  const settings = openSettings(userData);
  assert.equal(settings.setWorkMode(true), true);
  assert.equal(settings.workModeEnabled, true);
  const expected = { workModeEnabled: true, chatTheme: 'system', chatColors: lightColors, appColors, ...preferenceDefaults };
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), expected);
  assert.equal(openSettings(userData).workModeEnabled, true);

  for (const invalid of ['false', 0, 1, null, undefined, {}]) {
    assert.equal(settings.setWorkMode(invalid), false);
    assert.equal(settings.workModeEnabled, true);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), expected);

  assert.equal(settings.setWorkMode(false), true);
  assert.equal(settings.workModeEnabled, false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { ...expected, workModeEnabled: false });
  assert.equal(openSettings(userData).workModeEnabled, false);
});

test('legacy and malformed chat settings default to system and the light colors', (t) => {
  const { userData, file } = fixture(t);
  for (const stored of [{ workModeEnabled: true }, { chatTheme: 'other', chatColors: { background: '#101010' } }]) {
    writeFileSync(file, JSON.stringify(stored));
    const settings = openSettings(userData);
    assert.equal(settings.chatTheme, 'system');
    assert.deepEqual(settings.chatColors, lightColors);
    assert.equal(settings.workModeEnabled, stored.workModeEnabled === true);
  }
});

test('chat settings validate and normalize the whole palette without changing Work mode', (t) => {
  const { userData, file } = fixture(t);
  const settings = openSettings(userData);
  assert.equal(settings.setWorkMode(true), true);
  assert.equal(settings.setChatTheme('custom', { ...customColors, background: '123456', incoming: '#abcdef' }), true);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
    workModeEnabled: true, chatTheme: 'custom', chatColors: customColors, appColors, ...preferenceDefaults,
  });

  const saved = readFileSync(file, 'utf8');
  for (const colors of [null, { background: '#123456' }, { ...customColors, extra: '#FFFFFF' },
    { ...customColors, incoming: '#123' }, { ...customColors, outgoing: '#123456\n' },
    { ...customColors, outgoing: '#12345678' }, { ...customColors, incoming: 123456 }]) {
    assert.equal(settings.setChatTheme('light', colors), false);
  }
  assert.equal(settings.setChatTheme('sepia', customColors), false);
  assert.equal(readFileSync(file, 'utf8'), saved);
  assert.equal(settings.chatTheme, 'custom');
  assert.deepEqual(settings.chatColors, customColors);

  assert.equal(settings.setWorkMode(false), true);
  const reopened = openSettings(userData);
  assert.equal(reopened.workModeEnabled, false);
  assert.equal(reopened.chatTheme, 'custom');
  assert.deepEqual(reopened.chatColors, customColors);
  assert.equal(reopened.setChatTheme('dark', reopened.chatColors), true);
  assert.deepEqual(openSettings(userData).chatColors, customColors, 'switching to a preset keeps the custom palette');
});

test('a failed save leaves the active Work mode and chat theme unchanged', (t) => {
  const { userData, file } = fixture(t);
  const settings = openSettings(userData);
  assert.equal(settings.setWorkMode(true), true);
  assert.equal(settings.setChatTheme('custom', customColors), true);
  // A directory in place of the target file blocks replacement even when running as root.
  rmSync(file);
  mkdirSync(file);
  assert.equal(settings.setWorkMode(false), false);
  assert.equal(settings.workModeEnabled, true);
  assert.equal(settings.setChatTheme('light', lightColors), false);
  assert.equal(settings.chatTheme, 'custom');
  assert.deepEqual(settings.chatColors, customColors);
});

test('new preferences default safely for missing, legacy, malformed, and invalid stored values', t => {
  const { userData, file } = fixture(t);
  const checkDefaults = () => {
    const settings = openSettings(userData);
    for (const [key, value] of Object.entries(preferenceDefaults)) assert.equal(settings[key], value, key);
  };
  checkDefaults();
  assert.equal(existsSync(file), false, 'reading defaults does not create a settings file');
  for (const data of ['{', 'null', '[]', '42', '"settings"', '{"workModeEnabled":true}',
    JSON.stringify({ language: 'fr', notificationsEnabled: 'false', notificationPreviewEnabled: 0, startInTray: 1 }),
    JSON.stringify({ language: ['ko'], notificationsEnabled: null, notificationPreviewEnabled: {}, startInTray: [] })]) {
    writeFileSync(file, data);
    checkDefaults();
    assert.equal(readFileSync(file, 'utf8'), data, 'opening settings never overwrites the stored file');
  }
});

test('preferences persist across reopen and existing Work mode and palette updates', t => {
  const { userData, file } = fixture(t);
  const settings = openSettings(userData);
  for (const language of ['ko', 'en', 'auto']) {
    assert.equal(settings.setPreference('language', language), true);
    assert.equal(settings.language, language);
    assert.equal(openSettings(userData).language, language);
  }
  for (const key of ['notificationsEnabled', 'notificationPreviewEnabled', 'startInTray']) {
    for (const value of [false, true]) {
      assert.equal(settings.setPreference(key, value), true);
      assert.equal(settings[key], value);
      assert.equal(openSettings(userData)[key], value);
    }
  }
  assert.equal(settings.setPreference('language', 'ko'), true);
  assert.equal(settings.setPreference('notificationsEnabled', false), true);
  assert.equal(settings.setPreference('notificationPreviewEnabled', false), true);
  assert.equal(settings.setWorkMode(true), true);
  assert.equal(settings.setChatTheme('custom', customColors, { chrome: '#123456', background: '#ABCDEF' }), true);
  const reopened = openSettings(userData);
  assert.equal(reopened.language, 'ko');
  assert.equal(reopened.notificationsEnabled, false);
  assert.equal(reopened.notificationPreviewEnabled, false);
  assert.equal(reopened.startInTray, true);
  assert.equal(reopened.workModeEnabled, true);
  assert.equal(reopened.chatTheme, 'custom');
  assert.deepEqual(reopened.chatColors, customColors);
  assert.deepEqual(reopened.appColors, { chrome: '#123456', background: '#ABCDEF' });
  assert.deepEqual(readdirSync(userData), ['settings.json'], 'atomic saves leave no temporary files');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).language, 'ko');
});

test('setPreference accepts exactly the known string keys and their primitive types', t => {
  const { userData, file } = fixture(t);
  const settings = openSettings(userData);
  for (const [key, value] of Object.entries(preferenceDefaults)) assert.equal(settings.setPreference(key, value), true);
  assert.equal(existsSync(file), false, 'unchanged defaults do not write');
  assert.equal(settings.setPreference('language', 'en'), true);
  const saved = readFileSync(file, 'utf8');
  for (const key of ['language', 'notificationsEnabled', 'notificationPreviewEnabled', 'startInTray']) {
    const invalid = key === 'language'
      ? ['', 'fr', 'KO', 'ko-KR', true, 1, null, undefined, [], {}, new String('ko')]
      : ['true', 'false', 0, 1, null, undefined, [], {}, new Boolean(false)];
    for (const value of invalid) assert.equal(settings.setPreference(key, value), false, key);
  }
  for (const key of ['workModeEnabled', 'chatTheme', 'chatColors', 'appColors', 'autoStart', '__proto__', 'constructor',
    'toString', 'Language', ' startInTray', null, undefined, 0, Symbol('language'), new String('language'),
    { toString() { throw new Error('Keys must not be coerced.'); } }]) {
    assert.equal(settings.setPreference(key, true), false);
  }
  assert.equal(settings.setPreference('language', 'en'), true);
  assert.equal(readFileSync(file, 'utf8'), saved, 'invalid and unchanged values never write');
  assert.equal(settings.language, 'en');
});

test('failed preference saves retain every active value and clean up the atomic temporary file', t => {
  const { userData, file } = fixture(t);
  const settings = openSettings(userData);
  assert.equal(settings.setPreference('language', 'ko'), true);
  assert.equal(settings.setWorkMode(true), true);
  assert.equal(settings.setChatTheme('custom', customColors), true);
  rmSync(file);
  mkdirSync(file);
  for (const [key, value] of Object.entries({ language: 'en', notificationsEnabled: false,
    notificationPreviewEnabled: false, startInTray: true })) {
    assert.equal(settings.setPreference(key, value), false);
    assert.equal(settings[key], key === 'language' ? 'ko' : preferenceDefaults[key]);
  }
  assert.equal(settings.workModeEnabled, true);
  assert.equal(settings.chatTheme, 'custom');
  assert.deepEqual(settings.chatColors, customColors);
  assert.deepEqual(readdirSync(userData), ['settings.json']);
});

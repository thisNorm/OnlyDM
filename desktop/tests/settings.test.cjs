'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { openSettings } = require('../src/settings.cjs');
const lightColors = { background: '#FFFFFF', incoming: '#F0F2F4', outgoing: '#4257C9' };
const customColors = { background: '#123456', incoming: '#ABCDEF', outgoing: '#455674' };

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
  const expected = { workModeEnabled: true, chatTheme: 'system', chatColors: lightColors };
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
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { workModeEnabled: true, chatTheme: 'custom', chatColors: customColors });

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

'use strict';

const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { openSettings } = require('../src/settings.cjs');

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
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { workModeEnabled: true });
  assert.equal(openSettings(userData).workModeEnabled, true);

  for (const invalid of ['false', 0, 1, null, undefined, {}]) {
    assert.equal(settings.setWorkMode(invalid), false);
    assert.equal(settings.workModeEnabled, true);
  }
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { workModeEnabled: true });

  assert.equal(settings.setWorkMode(false), true);
  assert.equal(settings.workModeEnabled, false);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { workModeEnabled: false });
  assert.equal(openSettings(userData).workModeEnabled, false);
});

test('a failed save leaves the active Work mode unchanged', (t) => {
  const { userData, file } = fixture(t);
  const settings = openSettings(userData);
  assert.equal(settings.setWorkMode(true), true);
  // A directory in place of the target file blocks replacement even when running as root.
  rmSync(file);
  mkdirSync(file);
  assert.equal(settings.setWorkMode(false), false);
  assert.equal(settings.workModeEnabled, true);
});

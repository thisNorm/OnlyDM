'use strict';

const { randomUUID } = require('node:crypto');
const { readFileSync, renameSync, unlinkSync, writeFileSync } = require('node:fs');
const path = require('node:path');

function openSettings(userData) {
  const file = path.join(userData, 'settings.json');
  let workModeEnabled = false;
  try {
    workModeEnabled = JSON.parse(readFileSync(file, 'utf8'))?.workModeEnabled === true;
  } catch { /* Existing installs start with Work mode off. */ }

  return {
    get workModeEnabled() { return workModeEnabled; },
    setWorkMode(enabled) {
      if (typeof enabled !== 'boolean') return false;
      if (enabled === workModeEnabled) return true;
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        writeFileSync(temp, JSON.stringify({ workModeEnabled: enabled }) + '\n', { flag: 'wx', mode: 0o600, flush: true });
        renameSync(temp, file);
      } catch (error) {
        if (error.code !== 'EEXIST') {
          try { unlinkSync(temp); } catch { /* The temporary file may not exist. */ }
        }
        console.error('OnlyDM could not save settings.');
        return false;
      }
      workModeEnabled = enabled;
      return true;
    },
  };
}

module.exports = { openSettings };

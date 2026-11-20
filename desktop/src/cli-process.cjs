'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function registerCliProcess(app) {
  const file = path.join(app.getPath('userData'), 'cli-process.json');
  let record;
  try {
    const startTime = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='],
      { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } }).trim();
    if (!startTime) return () => {};
    record = { pid: process.pid, executable: process.execPath, startTime };
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(record) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } catch { return () => {}; }
  return () => {
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (current.pid === record.pid && current.executable === record.executable && current.startTime === record.startTime)
        fs.unlinkSync(file);
    } catch { /* A stale or already-removed PID record cannot block quitting. */ }
  };
}
module.exports = { registerCliProcess };

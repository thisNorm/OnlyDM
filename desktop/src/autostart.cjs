'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Use the same user-owned entries as `odm on/off`, so both controls agree.
function createAutostart({ platform = process.platform, executable = process.execPath,
  home = os.homedir(), config = process.env.XDG_CONFIG_HOME, packaged = true } = {}) {
  const boundary = platform === 'linux'
    ? config && path.isAbsolute(config) ? config : path.join(home, '.config') : home;
  const file = platform === 'linux'
    ? path.join(config && path.isAbsolute(config) ? config : path.join(home, '.config'), 'autostart', 'onlydm.desktop')
    : path.join(home, 'Library', 'LaunchAgents', 'org.thisnorm.onlydm.plist');
  const xml = executable.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
  const content = platform === 'linux'
    ? '[Desktop Entry]\nType=Application\nName=OnlyDM\n'
      + `Exec=${executable}\nIcon=onlydm\nTerminal=false\nX-OnlyDM-Managed=true\n`
    : '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
      + '<!-- Managed by OnlyDM CLI -->\n<plist version="1.0"><dict>\n'
      + '<key>Label</key><string>org.thisnorm.onlydm</string>\n'
      + `<key>ProgramArguments</key><array><string>${xml}</string></array>\n`
      + '<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Interactive</string>\n</dict></plist>\n';
  function checkDirectories() {
    let current = path.dirname(file);
    for (;;) {
      try {
        const info = fs.lstatSync(current);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe startup directory.');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current === boundary || current === path.dirname(current)) break;
      current = path.dirname(current);
    }
  }
  function read() {
    checkDirectories();
    try {
      const info = fs.lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16384
          || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe startup entry.');
      return fs.readFileSync(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return {
    get enabled() { try { return read() === content; } catch { return false; } },
    set(enabled) {
      if (typeof enabled !== 'boolean' || !packaged || !['linux', 'darwin'].includes(platform)) return false;
      try {
        const previous = read();
        if (previous !== null && previous !== content) return false;
        if (!enabled) { if (previous !== null) fs.unlinkSync(file); return true; }
        if (previous === content) return true;
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        checkDirectories();
        fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600, flush: true });
        return true;
      } catch { return false; }
    },
  };
}

module.exports = { createAutostart };

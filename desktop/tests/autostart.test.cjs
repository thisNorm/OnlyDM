'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const filename = path.join(__dirname, '../src/autostart.cjs');

function fixture(t, platform, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlydm-autostart-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'private home');
  const config = options.config === 'absolute' ? path.join(root, 'XDG config') : options.config || '';
  const directory = platform === 'linux'
    ? path.join(config && path.isAbsolute(config) ? config : path.join(home, '.config'), 'autostart')
    : path.join(home, 'Library', 'LaunchAgents');
  const file = path.join(directory, platform === 'linux' ? 'onlydm.desktop' : 'org.thisnorm.onlydm.plist');
  const executable = platform === 'linux' ? '/opt/onlydm/onlydm'
    : '/Applications/OnlyDM & <QA> "quoted" \'copy\'.app/Contents/MacOS/OnlyDM';
  const calls = [];
  function privatePath(file) {
    const relative = path.relative(root, file);
    assert.ok(relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), file);
  }
  const scopedFs = { ...fs };
  for (const operation of ['mkdirSync', 'writeFileSync', 'unlinkSync']) {
    scopedFs[operation] = (file, ...args) => {
      privatePath(file);
      calls.push({ operation, file, args });
      if (options.failure === operation) throw Object.assign(new Error('Private fixture storage failure.'), { code: 'ENOSPC' });
      return fs[operation](file, ...args);
    };
  }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, process: { platform, execPath: executable, env: {},
      ...(process.getuid ? { getuid: () => process.getuid() } : {}) },
    require(id) {
      if (id === 'node:fs') return scopedFs;
      if (id === 'node:os') return { homedir: () => home };
      if (id === 'node:path') return path;
      throw new Error('Unexpected dependency: ' + id);
    },
  }, { filename });
  const create = overrides => module.exports.createAutostart({ platform, executable, home, config,
    packaged: options.packaged ?? true, ...overrides });
  return { root, home, config, directory, file, executable, calls, create, controller: create() };
}

function cliContent(platform, executable) {
  if (platform === 'linux') return '[Desktop Entry]\nType=Application\nName=OnlyDM\n'
    + `Exec=${executable}\nIcon=onlydm\nTerminal=false\nX-OnlyDM-Managed=true\n`;
  const escaped = executable.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<!-- Managed by OnlyDM CLI -->\n<plist version="1.0"><dict>\n'
    + '<key>Label</key><string>org.thisnorm.onlydm</string>\n'
    + `<key>ProgramArguments</key><array><string>${escaped}</string></array>\n`
    + '<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Interactive</string>\n</dict></plist>\n';
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: creates the CLI-compatible entry privately and preserves unrelated files`, t => {
    const f = fixture(t, platform);
    fs.mkdirSync(f.home, { recursive: true });
    const profile = path.join(f.home, 'profile-sentinel');
    fs.writeFileSync(profile, 'keep profile');
    assert.equal(f.controller.enabled, false);
    assert.equal(f.controller.set(false), true);
    assert.deepEqual(f.calls, [], 'disabling an absent entry creates nothing');
    assert.equal(f.controller.set(true), true);
    assert.equal(fs.readFileSync(f.file, 'utf8'), cliContent(platform, f.executable));
    assert.equal(f.controller.enabled, true);
    assert.equal(f.create().enabled, true, 'a new controller recognizes the existing CLI entry');
    const mkdir = f.calls.find(call => call.operation === 'mkdirSync');
    const write = f.calls.find(call => call.operation === 'writeFileSync');
    assert.equal(mkdir.file, f.directory);
    assert.equal(mkdir.args[0].mode, 0o700);
    assert.equal(write.file, f.file);
    assert.equal(write.args[1].mode, 0o600);
    assert.equal(write.args[1].flag, 'wx');
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
      assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    }
    const unrelated = path.join(f.directory, 'other-application');
    fs.writeFileSync(unrelated, 'keep other app');
    const count = f.calls.length;
    assert.equal(f.controller.set(true), true);
    assert.equal(f.calls.length, count, 'enabling twice does not replace the entry');
    assert.equal(f.controller.set(false), true);
    assert.equal(f.controller.enabled, false);
    assert.equal(fs.existsSync(f.file), false);
    assert.equal(fs.readFileSync(profile, 'utf8'), 'keep profile');
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep other app');
  });

  test(`${platform}: unmanaged and oversized files and directories are never overwritten or removed`, t => {
    const f = fixture(t, platform);
    fs.mkdirSync(f.directory, { recursive: true });
    for (const content of ['unrelated user configuration', 'X-OnlyDM-Managed=true\nuser configuration', 'x'.repeat(16385)]) {
      fs.writeFileSync(f.file, content);
      assert.equal(f.controller.enabled, false);
      assert.equal(f.controller.set(true), false);
      assert.equal(f.controller.set(false), false);
      assert.equal(fs.readFileSync(f.file, 'utf8'), content);
    }
    fs.rmSync(f.file);
    fs.mkdirSync(f.file);
    assert.equal(f.controller.set(true), false);
    assert.equal(f.controller.set(false), false);
    assert.ok(fs.lstatSync(f.file).isDirectory());
    assert.deepEqual(f.calls, []);
  });

  test(`${platform}: development mode and invalid preference types never change startup entries`, t => {
    const f = fixture(t, platform, { packaged: false });
    for (const value of [true, false, 'true', 'false', 0, 1, null, undefined, {}]) assert.equal(f.controller.set(value), false);
    assert.equal(f.controller.enabled, false);
    assert.equal(fs.existsSync(f.directory), false);
    assert.deepEqual(f.calls, []);
    fs.mkdirSync(f.directory, { recursive: true });
    const previous = cliContent(platform, f.executable);
    fs.writeFileSync(f.file, previous);
    assert.equal(f.controller.set(false), false, 'development mode cannot remove an installed entry');
    assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
    const packaged = f.create({ packaged: true });
    for (const value of ['true', 0, null, undefined, {}, []]) assert.equal(packaged.set(value), false);
    assert.deepEqual(f.calls, []);
  });

  test(`${platform}: storage failures return false without creating an enabled entry`, t => {
    const f = fixture(t, platform, { failure: 'writeFileSync' });
    assert.equal(f.controller.set(true), false);
    assert.equal(f.controller.enabled, false);
    assert.equal(fs.existsSync(f.file), false);
  });

  test(`${platform}: symlinked files cannot expose or overwrite another private fixture file`, t => {
    const f = fixture(t, platform);
    fs.mkdirSync(f.directory, { recursive: true });
    const target = path.join(f.root, 'unrelated-entry');
    const previous = cliContent(platform, f.executable);
    fs.writeFileSync(target, previous);
    try { fs.symlinkSync(target, f.file, 'file'); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Windows does not permit file symlink creation; directory junction coverage still runs.');
        return;
      }
      throw error;
    }
    assert.equal(f.controller.enabled, false);
    assert.equal(f.controller.set(true), false);
    assert.equal(f.controller.set(false), false);
    assert.ok(fs.lstatSync(f.file).isSymbolicLink());
    assert.equal(fs.readFileSync(target, 'utf8'), previous);
    assert.deepEqual(f.calls, []);
  });

  test(`${platform}: symlinked startup directories cannot redirect creation or deletion`, t => {
    const f = fixture(t, platform);
    fs.mkdirSync(path.dirname(f.directory), { recursive: true });
    const target = path.join(f.root, 'other-private-directory');
    fs.mkdirSync(target);
    fs.symlinkSync(target, f.directory, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(f.controller.set(true), false, 'refuse a linked parent directory');
    assert.deepEqual(fs.readdirSync(target), []);
    const otherFile = path.join(target, path.basename(f.file));
    const previous = cliContent(platform, f.executable);
    fs.writeFileSync(otherFile, previous);
    assert.equal(f.controller.enabled, false, 'never trust an entry reached through a link');
    assert.equal(f.controller.set(false), false);
    assert.equal(fs.readFileSync(otherFile, 'utf8'), previous);
  });
}

test('Linux honors absolute XDG_CONFIG_HOME and ignores relative config; macOS ignores XDG', t => {
  for (const config of ['absolute', 'relative-config', '']) {
    const f = fixture(t, 'linux', { config });
    assert.equal(f.controller.set(true), true);
    assert.ok(fs.existsSync(f.file));
    assert.equal(fs.existsSync(path.join(f.home, '.config', 'autostart', 'onlydm.desktop')), config !== 'absolute');
  }
  const mac = fixture(t, 'darwin', { config: 'absolute' });
  assert.equal(mac.controller.set(true), true);
  assert.equal(fs.existsSync(mac.config), false);
  assert.ok(fs.existsSync(path.join(mac.home, 'Library', 'LaunchAgents', 'org.thisnorm.onlydm.plist')));
});

test('unsupported platforms cannot change startup entries', t => {
  const f = fixture(t, 'win32');
  assert.equal(f.controller.set(true), false);
  assert.equal(f.controller.set(false), false);
  assert.equal(f.controller.enabled, false);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.existsSync(f.home), false);
});

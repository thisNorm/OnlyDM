'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const path = require('node:path').posix;
const { run } = require('../cli/posix.cjs');
const { createUpdater } = require('../desktop/src/updates.cjs');

// A virtual filesystem and process table keep all tests away from the host profile and installed apps.
function fixture(platform, { present = true, userApp = false, env = {}, uid = 1000 } = {}) {
  const home = `/fixture/User & 'Quoted' Space`;
  const bundle = userApp ? `${home}/Applications/OnlyDM.app` : '/Applications/OnlyDM.app';
  const executable = platform === 'linux' ? '/opt/onlydm/onlydm' : `${bundle}/Contents/MacOS/OnlyDM`;
  const manifest = platform === 'linux' ? '/opt/onlydm/resources/app/package.json'
    : `${bundle}/Contents/Resources/app/package.json`;
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : `${home}/.config`;
  const metadata = platform === 'linux' ? `${config}/OnlyDM/cli-process.json`
    : `${home}/Library/Application Support/OnlyDM/cli-process.json`;
  const autostart = platform === 'linux' ? `${config}/autostart/onlydm.desktop`
    : `${home}/Library/LaunchAgents/org.thisnorm.onlydm.plist`;
  const entries = new Map();
  const faults = new Map();
  const table = new Map();
  const calls = { spawn: [], sync: [], updater: [], writes: [], removes: [], log: [], events: [] };
  const state = {
    release: { version: '1.2.0', tag: 'v1.2.0' }, cancelStop: false,
    neverStarts: false, spawnExit: null, installLaunch: true, startResult: undefined, systemStatus: 0,
  };
  let clock = 0;

  function error(code) { return Object.assign(new Error(`fixture ${code}`), { code }); }
  function check(operation, file) { if (faults.has(`${operation}:${file}`)) throw error(faults.get(`${operation}:${file}`)); }
  function put(file, data = '', attributes = {}) {
    if (file !== '/' && !entries.has(path.dirname(file))) put(path.dirname(file), '', { type: 'dir' });
    entries.set(file, { type: 'file', data, uid, mode: 0o600, ...attributes });
  }
  put('/', '', { type: 'dir' });
  put('/proc', '', { type: 'dir' });
  put(home, '', { type: 'dir' });

  function stat(file) {
    const entry = entries.get(file);
    if (!entry) throw error('ENOENT');
    return {
      ...entry, size: Buffer.byteLength(entry.data),
      isDirectory: () => entry.type === 'dir', isFile: () => entry.type === 'file',
      isSymbolicLink: () => entry.type === 'link',
    };
  }

  function addInstalled(version = '1.1.8') {
    put(executable, 'binary');
    put(manifest, JSON.stringify({ name: 'onlydm', version }));
  }
  function addProcess({ pid = 410, target = executable, identity = '321', owner = uid,
    startTime = 'Fri Nov 20 10:11:12 2026', writeMetadata = true } = {}) {
    table.set(pid, { target, identity, owner, startTime });
    put(`/proc/${pid}`, '', { type: 'dir', uid: owner });
    put(`/proc/${pid}/exe`, target, { type: 'link' });
    put(`/proc/${pid}/stat`, `${pid} (OnlyDM display name) ${['S', ...Array(18).fill('0'), identity].join(' ')}`);
    if (writeMetadata) put(metadata, JSON.stringify({ pid, executable, startTime }));
  }
  function clearProcess(pid = 410, keepMetadata = false) {
    table.delete(pid);
    for (const key of entries.keys()) if (key === `/proc/${pid}` || key.startsWith(`/proc/${pid}/`)) entries.delete(key);
    if (!keepMetadata) entries.delete(metadata);
  }
  function removeApp() {
    const root = platform === 'linux' ? '/opt/onlydm' : bundle;
    for (const key of entries.keys()) if (key === root || key.startsWith(`${root}/`)) entries.delete(key);
  }
  const fs = {
    constants: { W_OK: 2, O_WRONLY: 1, O_CREAT: 64, O_TRUNC: 512, O_NOFOLLOW: 131072 },
    lstatSync(file) { check('stat', file); return stat(file); },
    statSync(file) { check('stat', file); return stat(file); },
    readFileSync(file) { check('read', file); return stat(file).data; },
    readlinkSync(file) { check('readlink', file); return stat(file).data; },
    realpathSync(file) { check('realpath', file); stat(file); return file; },
    accessSync(file) { check('access', file); stat(file); },
    opendirSync(file) {
      assert.equal(file, '/proc'); check('scan', file);
      const names = [...entries.keys()].filter(key => path.dirname(key) === file).map(key => path.basename(key));
      let index = 0;
      return {
        readSync() {
          state.scanReads = (state.scanReads || 0) + 1;
          if (state.endlessScan) return { name: 'not-a-pid' };
          return index < names.length ? { name: names[index++] } : null;
        },
        closeSync() { state.scanClosed = true; },
      };
    },
    mkdirSync(file, options) {
      check('mkdir', file); calls.writes.push({ operation: 'mkdir', file, options }); put(file, '', { type: 'dir' });
    },
    writeFileSync(file, data, options) {
      check('write', file); calls.writes.push({ operation: 'write', file, data, options }); put(file, data);
    },
    unlinkSync(file) {
      check('unlink', file); stat(file); calls.removes.push(file); entries.delete(file);
    },
    rmSync(file, options) {
      check('rm', file); assert.equal(file, bundle); assert.deepEqual(options, { recursive: true });
      calls.removes.push(file); removeApp();
    },
  };
  const options = {
    platform, arch: platform === 'linux' ? 'x64' : 'arm64', home, env, fs,
    getuid: () => uid, now: () => clock, timeout: 450, startTimeout: 450,
    wait: async ms => { clock += ms; if (state.onWait) state.onWait(); },
    log: message => calls.log.push(message),
    spawn(file, args, spawnOptions) {
      assert.equal(file, executable, 'Only the canonical installed binary may launch');
      calls.spawn.push({ file, args, options: spawnOptions });
      calls.events.push(args.length ? 'stop' : 'launch');
      const child = new EventEmitter();
      child.unref = () => { child.unreferenced = true; };
      queueMicrotask(() => {
        if (state.spawnError) { child.emit('error', error(state.spawnError)); return; }
        child.emit('spawn');
        if (args[0] === '--onlydm-cli-stop') {
          if (state.onStop) state.onStop();
          else if (!state.cancelStop) clearProcess();
          child.emit('exit', 0);
        } else if (state.spawnExit !== null) child.emit('exit', state.spawnExit);
        else if (!state.neverStarts) {
          addProcess();
          if (state.afterLaunch) state.afterLaunch();
        }
      });
      return child;
    },
    spawnSync(file, args, spawnOptions) {
      calls.sync.push({ file, args, options: spawnOptions });
      if (file === '/bin/ps') {
        assert.equal(spawnOptions.env.LC_ALL, 'C');
        if (args.includes('-A')) {
          assert.equal(spawnOptions.timeout, 2000);
          assert.equal(spawnOptions.maxBuffer, 2 * 1024 * 1024);
          if (state.scanError) return { status: null, error: error(state.scanError) };
          return { status: state.scanStatus || 0,
            stdout: [...table].map(([pid, process]) => ` ${pid} ${process.owner} ${process.target}\n`).join('') };
        }
        const pid = Number(args[args.indexOf('-p') + 1]);
        const entry = table.get(pid);
        if (!entry) return { status: 1, stdout: '' };
        const field = args.at(-1);
        return { status: 0, stdout: ` ${field === 'uid=' ? entry.owner : field === 'comm=' ? entry.target : entry.startTime}\n` };
      }
      assert.ok(['/usr/bin/dpkg', '/usr/bin/sudo', '/usr/bin/pkexec', '/usr/bin/osascript'].includes(file));
      calls.events.push('remove');
      if (state.systemError) return { status: null, error: error(state.systemError) };
      if (state.systemStatus === 0 && !state.removeDoesNothing) removeApp();
      return { status: state.systemStatus, signal: state.systemSignal, stderr: state.systemStderr };
    },
    createUpdater(updaterOptions) {
      calls.updater.push({ method: 'create', options: updaterOptions });
      return {
        async check(checkOptions) {
          assert.deepEqual(checkOptions, { strict: true, includeLatest: true });
          calls.events.push('check'); calls.updater.push({ method: 'check', options: checkOptions });
          if (state.checkError) throw new Error(state.checkError);
          if (state.afterCheck) state.afterCheck();
          return { release: state.release, latestVersion: state.release?.version ?? updaterOptions.version };
        },
        async start(release, startOptions) {
          calls.updater.push({ method: 'start', release, options: startOptions });
          if (state.startError) throw new Error(state.startError);
          await startOptions.beforeInstall();
          calls.events.push('install');
          if (state.startResult === false) return false;
          if (!state.noInstall) addInstalled(state.installVersion ?? release.version);
          if (state.installLaunch) addProcess();
          return state.startResult;
        },
      };
    },
  };
  if (present) addInstalled();
  put('/usr/bin/sudo', 'fixture authorization');
  put(`${home}/profile-sentinel`, 'account data');
  put('/fixture/npm/bin/odm', 'npm wrapper');
  return {
    run: command => run(command, options), platform, options, state, calls, entries, faults, table,
    executable, bundle, manifest, metadata, autostart, home, put, addProcess, clearProcess, addInstalled,
  };
}

for (const platform of ['linux', 'darwin']) {
  test(`${platform}: missing status and stop are read only and never launch an app`, async () => {
    const f = fixture(platform, { present: false });
    assert.equal(await f.run('status'), 0);
    assert.deepEqual(f.calls.log, ['OnlyDM: not installed', 'Version: -', 'Status: stopped', 'Start at login: off']);
    assert.equal(await f.run('stop'), 0);
    assert.equal(f.calls.log.at(-1), 'OnlyDM is already stopped.');
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.updater, []);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.removes, []);
  });

  test(`${platform}: installed status uses app version and independently verifies PID, executable and start time`, async () => {
    const f = fixture(platform);
    f.addProcess();
    assert.equal(await f.run('status'), 0);
    assert.deepEqual(f.calls.log, ['OnlyDM: installed', 'Version: 1.1.8', 'Status: running', 'Start at login: off']);
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.writes, []);
  });

  test(`${platform}: start launches the canonical app from its own directory and waits for metadata`, async () => {
    const f = fixture(platform);
    assert.equal(await f.run('start'), 0);
    assert.deepEqual(f.calls.spawn, [{ file: f.executable, args: [], options: {
      detached: true, stdio: 'ignore', cwd: path.dirname(f.executable),
    } }]);
    assert.deepEqual(f.calls.log, ['OnlyDM started.']);
    assert.equal(await f.run('stop'), 0);
    assert.deepEqual(f.calls.log, ['OnlyDM started.', 'OnlyDM stopped.']);
    assert.deepEqual(f.calls.updater, []);
  });

  test(`${platform}: start does not launch a duplicate running app`, async () => {
    const f = fixture(platform);
    f.addProcess();
    await f.run('start');
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.log, ['OnlyDM is already running.']);
  });

  test(`${platform}: first start and install delegate verified installation and relaunch to the shared updater`, async () => {
    for (const command of ['start', 'install', 'update']) {
      const f = fixture(platform, { present: false });
      assert.equal(await f.run(command), 0);
      assert.deepEqual(f.calls.updater[0], { method: 'create', options: {
        version: '0.0.0', platform, arch: f.options.arch, executable: f.executable, packaged: true,
      } });
      const start = f.calls.updater.at(-1);
      assert.equal(start.method, 'start');
      assert.equal(start.release, f.state.release);
      assert.equal(start.options.waitForParent, false);
      assert.deepEqual(f.calls.spawn, [], 'Updater owns installer and relaunch');
      assert.deepEqual(f.calls.log, ['OnlyDM v1.2.0 installed.']);
    }
  });

  test(`${platform}: update checks before requesting a graceful stop and awaits installation`, async () => {
    const f = fixture(platform);
    f.addProcess();
    await f.run('update');
    assert.equal(f.calls.updater[0].options.version, '1.1.8');
    assert.deepEqual(f.calls.events, ['check', 'stop', 'install']);
    assert.deepEqual(f.calls.log, ['OnlyDM updated to v1.2.0.']);
    assert.deepEqual(f.calls.spawn.map(call => call.args), [['--onlydm-cli-stop']]);
    assert.deepEqual(f.calls.removes, []);
  });

  test(`${platform}: latest-version update is a no-op and install starts an existing stopped app`, async () => {
    const f = fixture(platform);
    f.addInstalled('1.1.10');
    f.addProcess();
    f.state.release = null;
    assert.equal(await f.run('update'), 0);
    assert.deepEqual(f.calls.log, ['OnlyDM is up to date (v1.1.10).']);
    assert.deepEqual(f.calls.spawn, []);
    assert.ok(f.table.has(410));
    f.clearProcess();
    await f.run('install');
    assert.deepEqual(f.calls.spawn.map(call => call.args), [[]]);
    assert.equal(f.calls.updater.filter(call => call.method === 'start').length, 0);
    assert.deepEqual(f.calls.log, Array(2).fill('OnlyDM is up to date (v1.1.10).'));
  });

  test(`${platform}: install does not report success when a current app fails to start`, async () => {
    const f = fixture(platform);
    f.state.release = null;
    f.state.neverStarts = true;
    await assert.rejects(f.run('install'), /OnlyDM started/);
    assert.deepEqual(f.calls.log, []);
  });

  test(`${platform}: a canceled close prevents update, restart and uninstall`, async () => {
    for (const command of ['update', 'restart', 'uninstall']) {
      const f = fixture(platform);
      f.addProcess(); f.state.cancelStop = true;
      await assert.rejects(f.run(command), {
        message: 'OnlyDM is still running. Confirm the close prompt and try again.',
      });
      assert.deepEqual(f.calls.log, []);
      assert.equal(f.calls.spawn.length, 1);
      assert.deepEqual(f.calls.spawn[0].args, ['--onlydm-cli-stop']);
      assert.ok(!f.calls.events.includes('install'));
      assert.deepEqual(f.calls.removes, []);
      assert.ok(f.entries.has(f.executable));
      assert.ok(f.table.has(410));
    }
  });

  test(`${platform}: restart stops the verified process before launching it again`, async () => {
    const f = fixture(platform);
    f.addProcess();
    await f.run('restart');
    assert.deepEqual(f.calls.events, ['stop', 'launch']);
    assert.deepEqual(f.calls.log, ['OnlyDM restarted.']);
    assert.deepEqual(f.calls.updater, []);

    const stopped = fixture(platform);
    assert.equal(await stopped.run('restart'), 0);
    assert.deepEqual(stopped.calls.events, ['launch']);
    assert.deepEqual(stopped.calls.log, ['OnlyDM started.']);
  });

  test(`${platform}: stale metadata, unrelated processes, foreign owners and reused PIDs never receive stop`, async () => {
    for (const attributes of [null, { target: '/unrelated/OnlyDM' }, { owner: 2000 }]) {
      const f = fixture(platform);
      f.addProcess();
      if (attributes === null) f.clearProcess(410, true);
      else f.addProcess({ ...attributes, writeMetadata: false });
      await f.run('stop');
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.removes, []);
      assert.deepEqual(f.calls.log, ['OnlyDM is already stopped.']);
    }
  });

  test(`${platform}: older 1.1.8 processes without metadata block maintenance without any mutation`, async () => {
    for (const command of ['install', 'update', 'uninstall', 'stop', 'restart']) {
      const f = fixture(platform);
      f.addProcess({ writeMetadata: false });
      await assert.rejects(f.run(command), error => {
        assert.match(error.message, /Quit the older OnlyDM app once, then run odm update/);
        if (platform === 'darwin') assert.match(error.message, /Cmd\+Q/);
        return true;
      });
      assert.deepEqual(f.calls.updater, []);
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.writes, []);
      assert.deepEqual(f.calls.removes, []);
      assert.ok(f.table.has(410));
      assert.ok(f.entries.has(f.executable));
      assert.ok(!f.entries.has(f.metadata));
    }
  });

  test(`${platform}: status reports a legacy process as running and start never launches a duplicate`, async () => {
    const f = fixture(platform);
    f.addProcess({ writeMetadata: false });
    await f.run('status');
    assert.match(f.calls.log.join('\n'), /Status: running \(older app\)/);
    assert.doesNotMatch(f.calls.log.join('\n'), /stopped/);
    await f.run('start');
    assert.equal(f.calls.log.at(-1), 'OnlyDM is already running.');
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.updater, []);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.removes, []);
  });

  test(`${platform}: stale PID and start-time records fall back to exact legacy detection`, async () => {
    for (const stale of ['pid', 'startTime']) {
      const f = fixture(platform);
      f.addProcess();
      if (stale === 'pid') {
        f.clearProcess(410, true);
        f.addProcess({ pid: 411, writeMetadata: false });
      } else f.addProcess({ startTime: 'new process start', writeMetadata: false });
      await assert.rejects(f.run('update'), /Quit the older OnlyDM app once/);
      await f.run('status');
      assert.match(f.calls.log.join('\n'), /Status: running \(older app\)/);
      assert.deepEqual(f.calls.updater, []);
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.writes, []);
      assert.deepEqual(f.calls.removes, []);
    }
  });

  test(`${platform}: legacy discovery ignores other users and similar executable names`, async () => {
    for (const attributes of [
      { owner: 2000 }, { target: '/unrelated/OnlyDM' }, { target: fakedExecutable(platform) + '-helper' },
    ]) {
      const f = fixture(platform);
      f.addProcess({ ...attributes, writeMetadata: false });
      await f.run('status');
      assert.match(f.calls.log.join('\n'), /Status: stopped/);
      await f.run('update');
      assert.equal(f.calls.updater.filter(call => call.method === 'start').length, 1);
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.writes, []);
      assert.deepEqual(f.calls.removes, []);
    }
  });

  test(`${platform}: a legacy process appearing during release lookup prevents the installer`, async () => {
    const f = fixture(platform);
    f.state.afterCheck = () => f.addProcess({ writeMetadata: false });
    await assert.rejects(f.run('update'), /Quit the older OnlyDM app once/);
    assert.equal(f.calls.updater.filter(call => call.method === 'check').length, 1);
    assert.equal(f.calls.updater.filter(call => call.method === 'start').length, 0);
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.removes, []);
  });

  test(`${platform}: malicious metadata is rejected without launching or signalling any process`, async () => {
    for (const data of [
      null, {}, { pid: -5 }, { pid: 0 }, { pid: 1 }, { pid: '410' }, { pid: 4.5 }, { pid: 0x80000000 },
      { pid: 410, executable: '/bin/sh', startTime: 'a' },
      { pid: 410, executable: fakedExecutable(platform), startTime: '' },
    ]) {
      const f = fixture(platform);
      f.put(f.metadata, JSON.stringify(data));
      await assert.rejects(f.run('stop'), /Invalid OnlyDM process metadata/);
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.sync, []);
    }
    for (const attributes of [{ uid: 0 }, { mode: 0o666 }, { type: 'dir' }, { type: 'link' }]) {
      const f = fixture(platform);
      f.addProcess(); Object.assign(f.entries.get(f.metadata), attributes);
      await assert.rejects(f.run('stop'), /Unsafe OnlyDM process metadata|unsafe OnlyDM path/);
      assert.deepEqual(f.calls.spawn, []);
    }
  });

  test(`${platform}: process replacement during stop fails the maintenance operation`, async () => {
    const f = fixture(platform);
    f.addProcess();
    f.state.onStop = () => f.addProcess({ identity: '999', startTime: 'new launch' });
    await assert.rejects(f.run('update'), /restarted before/);
    assert.ok(!f.calls.events.includes('install'));
    assert.equal(f.calls.spawn.length, 1);
  });

  test(`${platform}: asynchronous spawn errors, early exits and missing startup metadata fail start`, async () => {
    for (const state of [{ spawnError: 'ENOENT' }, { spawnExit: 7 }, { neverStarts: true }]) {
      const f = fixture(platform);
      Object.assign(f.state, state);
      await assert.rejects(f.run('start'), /ENOENT|exited before|OnlyDM started/);
      assert.equal(f.calls.spawn.length, 1);
      assert.ok(!f.calls.log.some(message => /started\./.test(message)));
    }
  });

  test(`${platform}: unreadable startup metadata fails after spawn without reporting success`, async () => {
    const f = fixture(platform);
    f.state.afterLaunch = () => f.faults.set(`read:${f.metadata}`, 'EACCES');
    await assert.rejects(f.run('start'), /EACCES/);
    assert.equal(f.calls.spawn.length, 1);
    assert.ok(!f.calls.log.some(message => /started\./.test(message)));
  });

  test(`${platform}: release, download, helper, installation and relaunch failures are propagated`, async () => {
    for (const state of [
      { release: null }, { checkError: 'Unsupported architecture' }, { checkError: 'network failure' },
      { startError: 'SHA-256 mismatch' }, { startError: 'authorization canceled' },
      { startResult: false }, { noInstall: true }, { installLaunch: false },
    ]) {
      const f = fixture(platform, { present: false });
      Object.assign(f.state, state);
      await assert.rejects(f.run('install'), /No OnlyDM installer|Could not check for updates|SHA-256|authorization|did not complete|did not create|OnlyDM started/);
      assert.deepEqual(f.calls.log, []);
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.removes, []);
    }
  });

  test(`${platform}: an installer that leaves the old version cannot report an update`, async () => {
    const f = fixture(platform);
    f.state.installVersion = '1.1.8';
    await assert.rejects(f.run('update'), { message: 'Could not verify the OnlyDM update.' });
    assert.deepEqual(f.calls.log, []);
  });

  test(`${platform}: update checks distinguish failures, incompatible assets and verified versions`, async () => {
    const name = platform === 'darwin' ? 'OnlyDM-mac-arm64.dmg' : 'OnlyDM-linux-x64.deb';
    const releases = 'https://github.com/thisNorm/OnlyDM/releases';
    const incomplete = {
      tag_name: 'v1.2.0', draft: false, prerelease: false, html_url: `${releases}/tag/v1.2.0`,
      assets: [{ name, state: 'uploaded', size: 1, browser_download_url: `${releases}/download/v1.2.0/${name}` }],
    };

    const checksum = name + '.sha256';
    const complete = { ...incomplete, assets: [...incomplete.assets, {
      name: checksum, state: 'uploaded', size: 1, browser_download_url: `${releases}/download/v1.2.0/${checksum}`,
    }] };
    const invalidPair = { ...complete, assets: [incomplete.assets[0], {
      ...complete.assets[1], browser_download_url: 'https://example.invalid/checksum',
    }] };
    const checkFailure = 'Could not check for updates. Try again.';
    for (const [fetch, installedVersion, message, success = false] of [
      [async () => { throw new TypeError('fetch failed'); }, '1.1.10', checkFailure],
      [async () => new Response('unavailable', { status: 503 }), '1.1.10', checkFailure],
      [async () => new Response(JSON.stringify({ ...incomplete, draft: true })), '1.1.10', checkFailure],
      [async () => new Response(JSON.stringify({ ...incomplete, assets: null })), '1.1.10', checkFailure],
      [async () => new Response(JSON.stringify({ ...incomplete, assets: null })), '1.2.0', checkFailure],
      [async () => new Response(JSON.stringify(incomplete)), '1.1.10', 'No update is available for this device.'],
      [async () => new Response(JSON.stringify(incomplete)), null, 'No OnlyDM installer is available for this device.'],
      [async () => new Response(JSON.stringify(invalidPair)), '1.1.10', checkFailure],
      [async () => new Response(JSON.stringify({ ...incomplete, assets: [] })), '1.2.0', 'OnlyDM is up to date (v1.2.0).', true],
      [async () => new Response(JSON.stringify(complete)), '1.2.0', 'OnlyDM is up to date (v1.2.0).', true],
      [async () => new Response(JSON.stringify(incomplete)), '1.3.0', 'OnlyDM v1.3.0 is newer than the latest release (v1.2.0).', true],
    ]) {
      const f = fixture(platform, { present: installedVersion !== null });
      if (installedVersion) {
        f.addInstalled(installedVersion);
        f.addProcess();
      }
      f.options.createUpdater = options => ({
        check: createUpdater({ ...options, deps: { fetch } }).check,
        start: () => assert.fail('This lookup must never reach the installer.'),
      });
      if (success) {
        assert.equal(await f.run('update'), 0);
        assert.deepEqual(f.calls.log, [message]);
      } else {
        await assert.rejects(f.run('update'), { message });
        assert.deepEqual(f.calls.log, []);
      }
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.writes, []);
      assert.deepEqual(f.calls.removes, []);
      assert.equal(f.table.has(410), installedVersion !== null);
    }
  });

  test(`${platform}: installer download and preflight failures leave the running app untouched`, async () => {
    for (const failure of ['Update HTTP request failed (503).', 'Required OS tool unavailable: fixture']) {
      const f = fixture(platform);
      f.addProcess();
      f.state.startError = failure;
      await assert.rejects(f.run('update'), { message: failure });
      assert.ok(f.table.has(410), failure);
      assert.deepEqual(f.calls.spawn, []);
    }
  });

  test(`${platform}: an acceptance write failure restarts the app stopped for the update`, async () => {
    const f = fixture(platform);
    f.addProcess();
    const failure = Object.assign(new Error('fixture ENOSPC publishing acceptance'), { code: 'ONLYDM_UPDATE_NOT_ACCEPTED' });
    f.options.createUpdater = () => ({
      check: async () => ({ release: f.state.release, latestVersion: f.state.release.version }),
      async start(_release, { beforeInstall }) {
        await beforeInstall?.();
        throw failure;
      },
    });
    await assert.rejects(f.run('update'), failure);
    assert.deepEqual(f.calls.events, ['stop', 'launch']);
    assert.ok(f.table.has(410));
  });

  test(`${platform}: on and off change only the owned autostart file and preserve the running app`, async () => {
    const f = fixture(platform);
    f.addProcess();
    await f.run('on');
    assert.deepEqual(f.calls.log, ['Start at login is on.']);
    const write = f.calls.writes.find(call => call.operation === 'write');
    assert.equal(write.file, f.autostart);
    assert.equal(write.options.mode, 0o600);
    assert.ok(write.options.flag & f.options.fs.constants.O_NOFOLLOW);
    if (platform === 'linux') assert.match(write.data, /Exec=\/opt\/onlydm\/onlydm\n/);
    else assert.match(write.data, /<key>RunAtLoad<\/key><true\/>/);
    await f.run('status');
    assert.equal(f.calls.log.at(-1), 'Start at login: on');
    await f.run('off');
    assert.equal(f.calls.log.at(-1), 'Start at login is off.');
    assert.deepEqual(f.calls.removes, [f.autostart]);
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.updater, []);
    assert.ok(f.table.has(410));
    assert.ok(f.entries.has(`${f.home}/profile-sentinel`));
  });

  test(`${platform}: on requires installation and off without an entry is a no-op`, async () => {
    const f = fixture(platform, { present: false });
    await assert.rejects(f.run('on'), /not installed/);
    await f.run('off');
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.removes, []);
  });

  test(`${platform}: unowned autostart files are never overwritten or deleted`, async () => {
    for (const command of ['on', 'off', 'uninstall']) {
      const f = fixture(platform);
      f.addProcess(); f.put(f.autostart, 'unrelated user configuration');
      await assert.rejects(f.run(command), /not managed by the OnlyDM CLI/);
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.writes, []);
      assert.deepEqual(f.calls.removes, []);
    }
  });

  test(`${platform}: storage errors and symlinked paths fail without touching another path`, async () => {
    for (const [command, operation, file] of [
      ['status', 'read', 'manifest'], ['stop', 'read', 'metadata'], ['start', 'stat', 'metadata'],
      ['on', 'write', 'autostart'], ['off', 'unlink', 'autostart'],
    ]) {
      const f = fixture(platform);
      f.addProcess();
      if (command === 'off') await f.run('on');
      f.faults.set(`${operation}:${f[file]}`, operation === 'write' ? 'ENOSPC' : 'EACCES');
      await assert.rejects(f.run(command), /ENOSPC|EACCES/);
      assert.deepEqual(f.calls.spawn, []);
      assert.deepEqual(f.calls.removes, []);
      assert.ok(f.table.has(410));
    }
    for (const file of ['autostart', 'executable', 'metadata']) {
      const f = fixture(platform);
      f.put(f[file], '/unrelated/personal-data', { type: 'link' });
      await assert.rejects(f.run(file === 'autostart' ? 'on' : 'uninstall'), /unsafe OnlyDM path/);
      assert.deepEqual(f.calls.removes, []);
      assert.deepEqual(f.calls.spawn, []);
    }
  });

  test(`${platform}: uninstall removes only the installed app and owned autostart, retaining profile and global wrapper`, async () => {
    const f = fixture(platform);
    await f.run('on'); f.addProcess();
    await f.run('uninstall');
    assert.ok(!f.entries.has(f.executable));
    assert.ok(!f.entries.has(f.autostart));
    assert.equal(f.entries.get(`${f.home}/profile-sentinel`).data, 'account data');
    assert.equal(f.entries.get('/fixture/npm/bin/odm').data, 'npm wrapper');
    assert.deepEqual(f.calls.events, ['stop', 'remove'].filter(event => platform === 'linux' || event !== 'remove'));
    assert.deepEqual(f.calls.log, ['Start at login is on.', 'OnlyDM uninstalled. Local data kept.']);
    if (platform === 'linux') {
      assert.deepEqual(f.calls.sync.filter(call => call.file !== '/bin/ps'), [{
        file: '/usr/bin/sudo', args: ['--', '/usr/bin/dpkg', '--remove', 'onlydm'], options: { stdio: 'inherit' },
      }]);
    } else assert.deepEqual(f.calls.removes, [f.bundle, f.autostart]);
  });

  test(`${platform}: missing uninstall is a no-op and malformed installed metadata prevents maintenance`, async () => {
    const f = fixture(platform, { present: false });
    assert.equal(await f.run('uninstall'), 0);
    assert.deepEqual(f.calls.log, ['OnlyDM is not installed.']);
    assert.deepEqual(f.calls.spawn, []); assert.deepEqual(f.calls.removes, []);
    f.addInstalled(); f.put(f.manifest, '{broken');
    await assert.rejects(f.run('update'), SyntaxError);
    await assert.rejects(f.run('uninstall'), SyntaxError);
    assert.deepEqual(f.calls.spawn, []); assert.deepEqual(f.calls.removes, []);
    assert.deepEqual(f.calls.updater, []);
  });
}

function fakedExecutable(platform) {
  return platform === 'linux' ? '/opt/onlydm/onlydm' : '/Applications/OnlyDM.app/Contents/MacOS/OnlyDM';
}

test('Linux honors absolute XDG_CONFIG_HOME and ignores a relative setting', async () => {
  for (const XDG_CONFIG_HOME of ['/fixture/xdg custom', 'relative-config']) {
    const f = fixture('linux', { env: { XDG_CONFIG_HOME } });
    f.addProcess();
    await f.run('on'); await f.run('status');
    assert.equal(f.calls.writes.find(call => call.operation === 'write').file, f.autostart);
    assert.match(f.calls.log.join('\n'), /Status: running/);
    assert.ok(f.autostart.startsWith(XDG_CONFIG_HOME.startsWith('/') ? XDG_CONFIG_HOME : `${f.home}/.config`));
  }
});

test('Linux removal uses graphical authorization or direct dpkg for root without reading passwords', async () => {
  for (const uid of [0, 1000]) {
    const f = fixture('linux', { uid, env: { DISPLAY: ':1' } });
    f.put('/usr/bin/pkexec', 'fixture authorization');
    await f.run('uninstall');
    const call = f.calls.sync.find(entry => entry.file !== '/bin/ps');
    assert.equal(call.file, uid === 0 ? '/usr/bin/dpkg' : '/usr/bin/pkexec');
    assert.deepEqual(call.args, uid === 0 ? ['--remove', 'onlydm'] : ['/usr/bin/dpkg', '--remove', 'onlydm']);
  }
});

test('Linux removal distinguishes a dismissed authorization prompt from a failed command', async () => {
  for (const [state, message, exitCode] of [
    [{ systemStatus: 126 }, 'OnlyDM uninstall canceled.', 126],
    [{ systemStatus: 127 }, 'Could not uninstall OnlyDM.', 127],
    [{ systemStatus: null, systemSignal: 'SIGINT' }, 'OnlyDM uninstall interrupted.', null],
  ]) {
    const f = fixture('linux', { env: { DISPLAY: ':1' } });
    f.put('/usr/bin/pkexec', 'fixture authorization');
    await f.run('on');
    Object.assign(f.state, state);
    await assert.rejects(f.run('uninstall'), { message, exitCode });
    assert.deepEqual(f.calls.log, ['Start at login is on.']);
    assert.ok(f.entries.has(f.autostart));
    assert.ok(f.entries.has(f.executable));
    assert.deepEqual(f.calls.removes, []);
  }
});

test('Linux removal launch errors and incomplete removal preserve autostart and profile', async () => {
  for (const state of [{ systemError: 'ENOENT' }, { removeDoesNothing: true }]) {
    const f = fixture('linux');
    await f.run('on'); Object.assign(f.state, state);
    await assert.rejects(f.run('uninstall'), /ENOENT|did not remove/);
    assert.ok(f.entries.has(f.autostart));
    assert.ok(f.entries.has(`${f.home}/profile-sentinel`));
    assert.deepEqual(f.calls.removes, []);
  }
});

test('macOS supports an existing user Applications bundle and escapes its LaunchAgent path', async () => {
  const f = fixture('darwin', { userApp: true });
  await f.run('start');
  assert.equal(f.calls.spawn[0].file, `${f.home}/Applications/OnlyDM.app/Contents/MacOS/OnlyDM`);
  await f.run('on');
  const contents = f.entries.get(f.autostart).data;
  assert.match(contents, /User &amp; &apos;Quoted&apos; Space/);
  await f.run('update');
  assert.equal(f.calls.updater[0].options.executable, f.executable);
  await f.run('uninstall');
  assert.deepEqual(f.calls.removes, [f.bundle, f.autostart]);
});

test('macOS protected bundle removal uses OS authorization with a literal, quoted OnlyDM target', async () => {
  const f = fixture('darwin', { userApp: true });
  f.faults.set(`access:${path.dirname(f.bundle)}`, 'EACCES');
  await f.run('uninstall');
  const call = f.calls.sync.find(entry => entry.file === '/usr/bin/osascript');
  assert.deepEqual(call.args.slice(0, 1), ['-e']);
  assert.match(call.args[1], /^do shell script "\/bin\/rm -rf -- '/);
  assert.match(call.args[1], /OnlyDM\.app'" with administrator privileges$/);
  assert.ok(call.args[1].includes("'\\\\''Quoted'\\\\''"));
  assert.ok(f.entries.has(`${f.home}/profile-sentinel`));
});

test('macOS removal distinguishes cancellation from other authorization errors with the same exit code', async () => {
  for (const [stderr, message] of [
    ['0:75: execution error: User canceled. (-128)\n', 'OnlyDM uninstall canceled.'],
    ['0:75: execution error: Authorization failed. (-60005)\n', 'Could not uninstall OnlyDM.'],
  ]) {
    const f = fixture('darwin');
    await f.run('on');
    f.faults.set('access:/Applications', 'EPERM');
    f.state.systemStatus = 1;
    f.state.systemStderr = stderr;
    await assert.rejects(f.run('uninstall'), { message, exitCode: 1 });
    assert.deepEqual(f.calls.log, ['Start at login is on.']);
    assert.ok(f.entries.has(f.executable));
    assert.ok(f.entries.has(f.autostart));
    assert.deepEqual(f.calls.removes, []);
  }
});

test('unsupported platforms and invalid home paths fail before filesystem or process mutations', async () => {
  const f = fixture('linux');
  await assert.rejects(run('start', { ...f.options, platform: 'freebsd' }), /Unsupported platform/);
  await assert.rejects(run('start', { ...f.options, home: 'relative' }), /Invalid home/);
  await assert.rejects(run('not-a-command', f.options), /Unknown command/);
  assert.deepEqual(f.calls.spawn, []);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.removes, []);
});

test('unsupported POSIX installer architectures fail before release lookup or process changes', async () => {
  for (const [platform, arch] of [['linux', 'arm64'], ['darwin', 'ia32']]) {
    const f = fixture(platform);
    f.addProcess();
    await assert.rejects(run('update', { ...f.options, arch }), { message: 'The OnlyDM installer does not support this device.' });
    assert.deepEqual(f.calls.updater, []);
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.removes, []);
  }
});

test('Linux legacy discovery stops at its entry/time limits and always closes the proc directory', async () => {
  for (const limit of ['entries', 'time']) {
    const f = fixture('linux');
    f.state.endlessScan = true;
    let ticks = 0;
    if (limit === 'time') f.options.now = () => ++ticks * 1000;
    await assert.rejects(f.run('update'), /bounded scan limit/);
    assert.ok(f.state.scanReads <= 8192);
    if (limit === 'time') assert.ok(f.state.scanReads < 8192);
    assert.equal(f.state.scanClosed, true);
    assert.deepEqual(f.calls.updater, []);
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.removes, []);
  }
});

test('Linux cannot overwrite an app when an owned process executable cannot be inspected', async () => {
  const f = fixture('linux');
  f.addProcess({ writeMetadata: false });
  f.faults.set('readlink:/proc/410/exe', 'EACCES');
  await assert.rejects(f.run('update'), /EACCES/);
  assert.equal(f.state.scanClosed, true);
  assert.deepEqual(f.calls.updater, []);
  assert.deepEqual(f.calls.spawn, []);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.removes, []);
});

test('macOS legacy discovery failures, timeout and output limits prevent installation', async () => {
  for (const state of [{ scanStatus: 1 }, { scanError: 'ETIMEDOUT' }, { scanError: 'ENOBUFS' }]) {
    const f = fixture('darwin');
    Object.assign(f.state, state);
    await assert.rejects(f.run('update'), /Cannot safely inspect|ETIMEDOUT|ENOBUFS/);
    assert.deepEqual(f.calls.updater, []);
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.removes, []);
  }
});

test('macOS detects an older user Applications instance even when the system bundle also exists', async () => {
  const f = fixture('darwin');
  const userExecutable = `${f.home}/Applications/OnlyDM.app/Contents/MacOS/OnlyDM`;
  f.put(userExecutable, 'other installed OnlyDM bundle');
  f.addProcess({ target: userExecutable, writeMetadata: false });
  await assert.rejects(f.run('update'), /Quit the older OnlyDM app once/);
  await f.run('start');
  assert.deepEqual(f.calls.updater, []);
  assert.deepEqual(f.calls.spawn, []);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.removes, []);
});

test('macOS dual bundles use the validated running bundle for status, start and maintenance', async () => {
  for (const userApp of [true, false]) {
    for (const command of ['status', 'start', 'stop', 'install', 'update', 'uninstall']) {
      const f = fixture('darwin', { userApp });
      const otherBundle = userApp ? '/Applications/OnlyDM.app' : `${f.home}/Applications/OnlyDM.app`;
      const otherExecutable = `${otherBundle}/Contents/MacOS/OnlyDM`;
      const otherManifest = `${otherBundle}/Contents/Resources/app/package.json`;
      f.put(otherExecutable, 'other installed binary');
      f.put(otherManifest, JSON.stringify({ name: 'onlydm', version: '9.9.9' }));
      f.addProcess();
      await f.run(command);
      if (command === 'status') {
        assert.match(f.calls.log.join('\n'), /Version: 1\.1\.8[\s\S]*Status: running/);
        assert.doesNotMatch(f.calls.log.join('\n'), /older app/);
      }
      if (['install', 'update'].includes(command)) {
        assert.equal(f.calls.updater[0].options.executable, f.executable);
        assert.equal(f.calls.updater[0].options.version, '1.1.8');
      }
      if (command === 'uninstall') assert.deepEqual(f.calls.removes, [f.bundle]);
      if (['status', 'start'].includes(command)) assert.deepEqual(f.calls.spawn, []);
      assert.equal(f.entries.get(otherExecutable).data, 'other installed binary');
      assert.equal(JSON.parse(f.entries.get(otherManifest).data).version, '9.9.9');
      assert.equal(f.entries.get(`${f.home}/profile-sentinel`).data, 'account data');
      assert.equal(f.entries.get('/fixture/npm/bin/odm').data, 'npm wrapper');
    }
  }
});

test('macOS dual bundles keep system preference for missing, dead, foreign or mismatched process records', async () => {
  for (const scenario of ['missing', 'dead', 'foreign', 'executable']) {
    const f = fixture('darwin');
    const userExecutable = `${f.home}/Applications/OnlyDM.app/Contents/MacOS/OnlyDM`;
    f.put(userExecutable, 'other installed binary');
    f.put(`${f.home}/Applications/OnlyDM.app/Contents/Resources/app/package.json`,
      JSON.stringify({ name: 'onlydm', version: '9.9.9' }));
    if (scenario !== 'missing') {
      const startTime = 'Fri Nov 20 10:11:12 2026';
      f.put(f.metadata, JSON.stringify({ pid: 410, executable: userExecutable, startTime }));
      if (scenario !== 'dead') f.addProcess({
        target: scenario === 'executable' ? '/bin/sh' : userExecutable,
        owner: scenario === 'foreign' ? 2000 : 1000, startTime, writeMetadata: false,
      });
    }
    f.state.release = null;
    await f.run('status');
    assert.match(f.calls.log.join('\n'), /Version: 1\.1\.8[\s\S]*Status: stopped/);
    await f.run('update');
    assert.equal(f.calls.updater[0].options.executable, f.executable);
    assert.equal(f.calls.updater[0].options.version, '1.1.8');
    assert.equal(f.calls.updater.filter(call => call.method === 'start').length, 0);
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.removes, []);
  }
});

test('macOS dual bundles never trust a stale start time to select or control the user app', async () => {
  const f = fixture('darwin');
  const userExecutable = `${f.home}/Applications/OnlyDM.app/Contents/MacOS/OnlyDM`;
  f.put(userExecutable, 'other installed binary');
  f.put(`${f.home}/Applications/OnlyDM.app/Contents/Resources/app/package.json`,
    JSON.stringify({ name: 'onlydm', version: '9.9.9' }));
  f.addProcess({ target: userExecutable, startTime: 'new process start', writeMetadata: false });
  f.put(f.metadata, JSON.stringify({ pid: 410, executable: userExecutable, startTime: 'old process start' }));
  await f.run('status');
  assert.match(f.calls.log.join('\n'), /Version: 1\.1\.8[\s\S]*Status: running \(older app\)/);
  await assert.rejects(f.run('update'), /Quit the older OnlyDM app once/);
  assert.deepEqual(f.calls.updater, []);
  assert.deepEqual(f.calls.spawn, []);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.removes, []);
});

test('macOS bundle selection rejects arbitrary executable paths even with a matching current PID and user', async () => {
  for (const target of ['/tmp/OnlyDM.app/Contents/MacOS/OnlyDM', '/bin/sh']) {
    const f = fixture('darwin', { userApp: true });
    f.put('/Applications/OnlyDM.app/Contents/MacOS/OnlyDM', 'other installed binary');
    const startTime = 'Fri Nov 20 10:11:12 2026';
    f.addProcess({ target, startTime, writeMetadata: false });
    f.put(f.metadata, JSON.stringify({ pid: 410, executable: target, startTime }));
    await assert.rejects(f.run('update'), /Invalid OnlyDM process metadata/);
    assert.deepEqual(f.calls.sync, []);
    assert.deepEqual(f.calls.updater, []);
    assert.deepEqual(f.calls.spawn, []);
    assert.deepEqual(f.calls.writes, []);
    assert.deepEqual(f.calls.removes, []);
  }
});

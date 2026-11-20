'use strict';

const path = require('node:path').posix;
const os = require('node:os');
const filesystem = require('node:fs');
const processes = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

// Dependencies are injectable so command tests never touch an installed app or profile.
async function run(command, {
  platform = process.platform, arch = process.arch, env = process.env, home = os.homedir(),
  fs = filesystem, spawn = processes.spawn, spawnSync = processes.spawnSync,
  getuid = () => process.getuid(), wait = delay, now = Date.now, timeout = 120_000, startTimeout = 15_000,
  log = console.log, createUpdater = options => require('../desktop/src/updates.cjs').createUpdater(options),
} = {}) {
  if (!['linux', 'darwin'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  if (!path.isAbsolute(home) || /[\x00-\x1f\x7f]/.test(home)) throw new Error('Invalid home directory.');
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config');
  const bundles = ['/Applications/OnlyDM.app', path.join(home, 'Applications/OnlyDM.app')];
  const executables = platform === 'linux' ? ['/opt/onlydm/onlydm']
    : bundles.map(bundle => path.join(bundle, 'Contents/MacOS/OnlyDM'));

  function stat(file) {
    try { return fs.lstatSync(file); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function safePath(file) {
    let current = '/';
    for (const component of file.split('/').filter(Boolean)) {
      current = path.join(current, component);
      const entry = stat(current);
      if (entry && (entry.isSymbolicLink() || (current !== file && !entry.isDirectory()))) {
        throw new Error(`Refusing an unsafe OnlyDM path: ${current}`);
      }
    }
    return file;
  }

  const metadata = platform === 'linux' ? path.join(config, 'OnlyDM/cli-process.json')
    : path.join(home, 'Library/Application Support/OnlyDM/cli-process.json');
  const currentRecord = platform === 'darwin' ? verifiedRecord() : null;
  const executable = currentRecord?.executable || executables.find(file => stat(file)) || executables[0];
  const bundle = platform === 'darwin' ? bundles[executables.indexOf(executable)] : null;
  const manifest = platform === 'linux' ? '/opt/onlydm/resources/app/package.json'
    : path.join(bundle, 'Contents/Resources/app/package.json');
  const autostart = platform === 'linux' ? path.join(config, 'autostart/onlydm.desktop')
    : path.join(home, 'Library/LaunchAgents/org.thisnorm.onlydm.plist');
  const legacyQuit = 'Quit the older OnlyDM app once, then run odm update.'
    + (platform === 'darwin' ? ' On macOS, use Cmd+Q to quit.' : '');

  function installed() {
    const entry = stat(safePath(executable));
    if (entry && !entry.isFile()) throw new Error('The installed OnlyDM executable is not a regular file.');
    return !!entry;
  }

  function version() {
    if (!installed()) return '0.0.0';
    const data = JSON.parse(fs.readFileSync(safePath(manifest), 'utf8'));
    if (!['onlydm', 'onlydm-linux'].includes(data.name)
      || typeof data.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(data.version)) {
      throw new Error('Cannot read the installed OnlyDM version.');
    }
    return data.version;
  }

  function ps(pid, fields) {
    const result = spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', fields], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, env: { ...env, LC_ALL: 'C' },
    });
    if (result.error) throw result.error;
    if (result.status === 1) return null;
    if (result.status !== 0) throw new Error('Cannot inspect the OnlyDM process.');
    return result.stdout.trim();
  }

  function inspect(pid, includeStartTime = false, target = executable) {
    try {
      if (platform === 'linux') {
        if (fs.statSync(`/proc/${pid}`).uid !== getuid()
          || fs.readlinkSync(`/proc/${pid}/exe`) !== target) return null;
        const data = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = data.slice(data.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (!/^\d+$/.test(fields[19] || '')) throw new Error('Cannot inspect the OnlyDM process start time.');
        return { pid, identity: fields[19], startTime: includeStartTime ? ps(pid, 'lstart=') : undefined };
      }
      const owner = ps(pid, 'uid=');
      if (owner === null || owner !== String(getuid()) || ps(pid, 'comm=') !== target) return null;
      const identity = ps(pid, 'lstart=');
      return identity ? { pid, identity, startTime: identity } : null;
    } catch (error) {
      if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
      throw error;
    }
  }

  function verifiedRecord() {
    const entry = stat(safePath(metadata));
    if (!entry) return null;
    if (!entry.isFile() || entry.size > 4096 || entry.uid !== getuid() || (entry.mode & 0o022)) {
      throw new Error('Unsafe OnlyDM process metadata.');
    }
    const data = JSON.parse(fs.readFileSync(metadata, 'utf8'));
    if (!data || !Number.isInteger(data.pid) || data.pid <= 1 || data.pid > 0x7fffffff
      || !executables.includes(data.executable) || typeof data.startTime !== 'string' || !data.startTime.trim()) {
      throw new Error('Invalid OnlyDM process metadata.');
    }
    const active = inspect(data.pid, true, data.executable);
    return active && active.startTime === data.startTime ? { ...active, executable: data.executable } : null;
  }

  function recordedProcess() {
    const current = verifiedRecord();
    return current && current.executable === executable ? current : null;
  }

  function legacyProcess() {
    if (platform === 'darwin') {
      const result = spawnSync('/bin/ps', ['-ww', '-A', '-o', 'pid=,uid=,comm='], {
        encoding: 'utf8', timeout: 2000, maxBuffer: 2 * 1024 * 1024, env: { ...env, LC_ALL: 'C' },
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error('Cannot safely inspect existing OnlyDM processes.');
      for (const line of result.stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (match && Number(match[1]) > 1 && Number(match[1]) <= 0x7fffffff
          && Number(match[2]) === getuid() && executables.includes(match[3])) {
          return { pid: Number(match[1]), legacy: true };
        }
      }
      return null;
    }
    const deadline = now() + 2000;
    const directory = fs.opendirSync('/proc');
    try {
      for (let scanned = 0; scanned < 8192 && now() < deadline; scanned++) {
        const entry = directory.readSync();
        if (!entry) return null;
        if (!/^[1-9]\d*$/.test(entry.name)) continue;
        const pid = Number(entry.name);
        if (pid <= 1 || pid > 0x7fffffff) continue;
        let sameUser = false;
        try {
          sameUser = fs.statSync(`/proc/${pid}`).uid === getuid();
          if (sameUser && executables.includes(fs.readlinkSync(`/proc/${pid}/exe`))) return { pid, legacy: true };
        } catch (error) {
          if (['ENOENT', 'ESRCH'].includes(error.code)) continue;
          if (!sameUser && ['EACCES', 'EPERM'].includes(error.code)) continue;
          throw error;
        }
      }
      throw new Error('Cannot safely inspect existing OnlyDM processes within the bounded scan limit.');
    } finally {
      directory.closeSync();
    }
  }

  function running(requireControl = false) {
    const current = recordedProcess() || legacyProcess();
    if (requireControl && current && current.legacy) throw new Error(legacyQuit);
    return current;
  }

  async function launch(args = []) {
    safePath(executable);
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', cwd: path.dirname(executable) });
    let failure;
    child.on('error', error => { failure = error; });
    child.once('exit', (code, signal) => {
      if (code !== 0) failure = new Error(`OnlyDM exited before the command completed (${signal || code}).`);
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return () => { if (failure) throw failure; };
  }

  async function waitForStart(checkFailure = () => {}) {
    const deadline = now() + startTimeout;
    do {
      checkFailure();
      if (recordedProcess()) return;
      await wait(150);
    } while (now() < deadline);
    throw new Error('OnlyDM did not report a running process. Check that the desktop session can start OnlyDM.');
  }

  async function stop() {
    const current = running(true);
    if (!current) { log('OnlyDM is not running.'); return; }
    const checkFailure = await launch(['--onlydm-cli-stop']);
    const deadline = now() + timeout;
    do {
      checkFailure();
      const active = inspect(current.pid);
      if (!active || active.identity !== current.identity) {
        if (running()) throw new Error('OnlyDM restarted before the command completed. Try again.');
        log('OnlyDM stopped.');
        return;
      }
      await wait(150);
    } while (now() < deadline);
    throw new Error('OnlyDM is still running. Confirm the close prompt in OnlyDM and try again.');
  }

  async function install() {
    running(true);
    const wasInstalled = installed();
    if (!((platform === 'linux' && arch === 'x64') || (platform === 'darwin' && ['arm64', 'x64'].includes(arch)))) {
      throw new Error(`No compatible OnlyDM release for ${platform}/${arch}.`);
    }
    const updater = createUpdater({ version: version(), platform, arch, executable, packaged: true });
    const release = await updater.check({ strict: true });
    const current = running(true);
    if (!release) {
      if (!wasInstalled) throw new Error('No compatible OnlyDM release is available.');
      log('No newer compatible OnlyDM release was confirmed.');
      if (command === 'install' && !current) await waitForStart(await launch());
      return;
    }
    if (current) await stop();
    if (await updater.start(release, { waitForParent: false }) === false) {
      throw new Error('OnlyDM installation did not complete.');
    }
    if (!installed()) throw new Error('OnlyDM installation did not create the installed executable.');
    await waitForStart();
    log(`OnlyDM ${version()} installed.`);
  }

  function autostartContent(target = executable) {
    if (platform === 'linux') {
      return '[Desktop Entry]\nType=Application\nName=OnlyDM\n'
        + `Exec=${target}\nIcon=onlydm\nTerminal=false\nX-OnlyDM-Managed=true\n`;
    }
    const escaped = target.replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    })[character]);
    return '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
      + '<!-- Managed by OnlyDM CLI -->\n<plist version="1.0"><dict>\n'
      + '<key>Label</key><string>org.thisnorm.onlydm</string>\n'
      + `<key>ProgramArguments</key><array><string>${escaped}</string></array>\n`
      + '<key>RunAtLoad</key><true/>\n<key>ProcessType</key><string>Interactive</string>\n</dict></plist>\n';
  }

  function readAutostart() {
    const entry = stat(safePath(autostart));
    if (!entry) return null;
    if (!entry.isFile() || entry.uid !== getuid() || entry.size > 16_384) throw new Error('Unsafe OnlyDM autostart file.');
    return fs.readFileSync(autostart, 'utf8');
  }

  function setAutostart(enabled) {
    const previous = readAutostart();
    if (previous !== null && !executables.some(target => previous === autostartContent(target))) {
      throw new Error('Refusing to replace an autostart file not managed by the OnlyDM CLI.');
    }
    if (enabled) {
      if (!installed()) throw new Error("OnlyDM is not installed. Run 'odm install' first.");
      fs.mkdirSync(safePath(path.dirname(autostart)), { recursive: true, mode: 0o700 });
      safePath(autostart);
      fs.writeFileSync(autostart, autostartContent(), {
        encoding: 'utf8', mode: 0o600,
        flag: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      });
    } else if (previous !== null) {
      fs.unlinkSync(safePath(autostart));
    }
    log(`OnlyDM auto start ${enabled ? 'enabled' : 'disabled'}.`);
  }

  function checked(file, args) {
    const result = spawnSync(file, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(`OnlyDM removal failed (${result.signal || result.status}).`);
      error.exitCode = result.status;
      throw error;
    }
  }

  async function uninstall() {
    if (!installed()) { log('OnlyDM is not installed.'); return; }
    version();
    // Validate every destructive target before stopping the app or requesting authorization.
    if (bundle) {
      if (!bundles.includes(bundle) || fs.realpathSync(safePath(bundle)) !== bundle) {
        throw new Error('Refusing to remove an unexpected application bundle.');
      }
    }
    const previous = readAutostart();
    if (previous !== null && !executables.some(target => previous === autostartContent(target))) {
      throw new Error('Refusing to remove an autostart file not managed by the OnlyDM CLI.');
    }
    if (running(true)) await stop();
    if (platform === 'linux') {
      safePath(executable);
      if (getuid() === 0) checked('/usr/bin/dpkg', ['--remove', 'onlydm']);
      else if ((env.DISPLAY || env.WAYLAND_DISPLAY) && stat('/usr/bin/pkexec')) {
        checked('/usr/bin/pkexec', ['/usr/bin/dpkg', '--remove', 'onlydm']);
      } else if (stat('/usr/bin/sudo')) checked('/usr/bin/sudo', ['--', '/usr/bin/dpkg', '--remove', 'onlydm']);
      else throw new Error('System authorization is unavailable for removing OnlyDM.');
    } else {
      safePath(bundle);
      try {
        fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
        fs.rmSync(bundle, { recursive: true });
      } catch (error) {
        if (!['EACCES', 'EPERM'].includes(error.code)) throw error;
        safePath(bundle);
        const quoted = `'${bundle.replace(/'/g, "'\\''")}'`;
        const script = `/bin/rm -rf -- ${quoted}`.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        checked('/usr/bin/osascript', ['-e', `do shell script "${script}" with administrator privileges`]);
      }
    }
    if (installed()) throw new Error('OnlyDM removal did not remove the installed executable.');
    setAutostart(false);
    log('OnlyDM uninstalled. Account data and the npm command are kept.');
  }

  switch (command) {
    case 'install': case 'update': await install(); break;
    case 'restart': await stop(); // fall through
    case 'start': {
      const current = running();
      if (current) log(`OnlyDM is already running.${current.legacy ? ' ' + legacyQuit : ''}`);
      else if (!installed()) await install();
      else { await waitForStart(await launch()); log('OnlyDM started.'); }
      break;
    }
    case 'stop': await stop(); break;
    case 'status': {
      const present = installed();
      log(`OnlyDM      ${present ? 'installed' : 'not installed'}`);
      log(`Version     ${present ? version() : 'not installed'}`);
      const current = running();
      log(`Process     ${current ? 'running' + (current.legacy ? ' (older app)' : '') : 'stopped'}`);
      const content = readAutostart();
      log(`Auto start  ${executables.some(target => content === autostartContent(target)) ? 'on' : 'off'}`);
      break;
    }
    case 'on': setAutostart(true); break;
    case 'off': setAutostart(false); break;
    case 'uninstall': await uninstall(); break;
    default: throw new Error(`Unknown command: ${command}`);
  }
  return 0;
}

module.exports = { run };

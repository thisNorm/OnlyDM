'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { test } = require('node:test');
const { createUpdater } = require('../src/updates.cjs');

const payload = Buffer.from('inert package, never installed');
const digest = createHash('sha256').update(payload).digest('hex');
const base = 'https://github.com/thisNorm/OnlyDM/releases/download/v1.2.0/';

function release(name = 'OnlyDM-linux-x64.deb') {
  return {
    tag_name: 'v1.2.0', draft: false, prerelease: false,
    html_url: 'https://github.com/thisNorm/OnlyDM/releases/tag/v1.2.0',
    assets: [
      { name, state: 'uploaded', size: payload.length, browser_download_url: base + name },
      { name: name + '.sha256', state: 'uploaded', size: Buffer.byteLength(`${digest}  ${name}\n`),
        browser_download_url: base + name + '.sha256' },
    ],
  };
}

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlydm-update-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { release: release(), calls: [], spawns: [], behavior: 'ready' };
  const updater = createUpdater({
    version: '1.1.8', platform: 'linux', arch: 'x64', executable: '/opt/onlydm/onlydm', packaged: true,
    ...overrides,
    deps: {
      tmpdir: () => root, startStamp: async () => '12345',
      timeouts: { check: 40, download: 80, ready: 100, complete: 200 },
      fetch: async (url, options) => {
        state.calls.push({ url, options });
        if (state.fetch) return state.fetch(url, options);
        if (url.includes('/releases/latest')) return new Response(JSON.stringify(state.release));
        if (url.endsWith('.sha256')) {
          const name = state.release.assets[0].name;
          return new Response(state.checksum ?? `${digest}  ${name}\n`);
        }
        return new Response(state.payload ?? payload);
      },
      spawn: (command, args, options) => {
        const child = new EventEmitter();
        child.unref = () => { child.unreferenced = true; };
        child.kill = () => assert.fail('The updater must never kill a process.');
        const work = args[1];
        state.spawns.push({ command, args, options, work, child });
        setTimeout(() => {
          if (state.behavior === 'error') return child.emit('error', new Error('spawn denied'));
          if (state.behavior === 'exit') return child.emit('exit', 1, null);
          if (state.behavior === 'timeout') return;
          if (state.behavior === 'failed') {
            fs.writeFileSync(path.join(work, 'failed'), 'Package validation failed');
            return child.emit('exit', 1, null);
          }
          const token = fs.readFileSync(path.join(work, 'token'), 'utf8');
          fs.writeFileSync(path.join(work, 'ready'), state.behavior === 'bad-ready' ? 'wrong token' : token);
          if (state.behavior === 'complete') {
            fs.writeFileSync(path.join(work, 'installed'), token);
            child.emit('exit', 0, null);
          }
        }, 5);
        return child;
      },
      ...overrides.deps,
    },
  });
  return { root, state, updater };
}

test('stable uploaded public asset pair is pinned to its tag', async (t) => {
  const { state, updater } = fixture(t);
  const result = await updater.check();
  assert.equal(result.version, '1.2.0');
  assert.equal(result.tag, 'v1.2.0');
  assert.deepEqual(result.asset, { name: 'OnlyDM-linux-x64.deb', size: payload.length, url: base + 'OnlyDM-linux-x64.deb' });
  assert.equal(result.checksum.name, 'OnlyDM-linux-x64.deb.sha256');
  assert.equal(state.calls[0].url, 'https://api.github.com/repos/thisNorm/OnlyDM/releases/latest');
  assert.equal(state.calls[0].options.redirect, 'manual');
  assert.ok(state.calls[0].options.signal);
  assert.equal((await updater.check({ strict: true })).version, '1.2.0');
});

test('public macOS asset names match each supported architecture', async (t) => {
  for (const arch of ['arm64', 'x64']) {
    const { updater, state } = fixture(t, { platform: 'darwin', arch,
      executable: '/Applications/OnlyDM.app/Contents/MacOS/OnlyDM' });
    state.release = release(`OnlyDM-mac-${arch}.dmg`);
    assert.equal((await updater.check()).asset.name, `OnlyDM-mac-${arch}.dmg`);
  }
});

test('unsupported platforms, architectures and development apps do not use the network', async (t) => {
  for (const options of [{ platform: 'win32' }, { platform: 'linux', arch: 'arm64' },
    { platform: 'darwin', arch: 'ia32' }, { packaged: false }]) {
    const { updater, state } = fixture(t, options);
    assert.equal(await updater.check(), null);
    await assert.rejects(updater.check({ strict: true }), /unsupported|packaged|target/i);
    assert.equal(state.calls.length, 0);
    await assert.rejects(updater.start(release()), /unsupported|packaged/i);
  }
});

test('three numeric components compare numerically and reject unstable/malformed versions', async (t) => {
  for (const version of ['1.2.0', '1.20.0', '2.0.0', '1.1.8-beta.1', '1.1', '01.1.8', '', '1.1.8+meta', '9007199254740992.0.0', '1.1.8\n']) {
    const { updater } = fixture(t, { version });
    assert.equal(await updater.check(), null, version);
    if (['1.2.0', '1.20.0', '2.0.0'].includes(version)) assert.equal(await updater.check({ strict: true }), null, version);
  }
  const { updater, state } = fixture(t, { version: '1.9.99' });
  state.release = release();
  state.release.tag_name = 'v1.10.0';
  state.release.html_url = state.release.html_url.replace('1.2.0', '1.10.0');
  for (const asset of state.release.assets) asset.browser_download_url = asset.browser_download_url.replace('1.2.0', '1.10.0');
  assert.equal((await updater.check()).version, '1.10.0');
});

test('malformed, draft, incomplete and untrusted releases are ignored', async (t) => {
  const mutations = [
    () => null, () => [], (r) => ({ ...r, draft: true }), (r) => ({ ...r, prerelease: true }),
    (r) => ({ ...r, tag_name: 'v1.2.0-rc.1' }), (r) => ({ ...r, assets: r.assets.slice(0, 1) }),
    (r) => ({ ...r, assets: [...r.assets, r.assets[0]] }),
    (r) => { r.assets[0].state = 'new'; return r; },
    (r) => { r.assets[0].size = 0; return r; },
    (r) => { r.assets[0].size = 1024 ** 3; return r; },
    (r) => { r.assets[1].size = 5000; return r; },
    (r) => { r.assets[0].browser_download_url = base.replace('v1.2.0', 'latest') + r.assets[0].name; return r; },
    (r) => { r.assets[0].browser_download_url = base.replace('thisNorm/OnlyDM', 'attacker/OnlyDM') + r.assets[0].name; return r; },
    (r) => { r.assets[0].browser_download_url = base.replace('github.com', 'github.com.evil.test') + r.assets[0].name; return r; },
    (r) => { r.assets[0].browser_download_url += '?download=1'; return r; },
    (r) => { r.assets[0].browser_download_url = 'http' + r.assets[0].browser_download_url.slice(5); return r; },
  ];
  for (const mutate of mutations) {
    const { updater, state } = fixture(t);
    state.release = mutate(release());
    assert.equal(await updater.check(), null);
    await assert.rejects(updater.check({ strict: true }), /release|asset|version/i);
  }
});

test('check bounds the entire request, bad JSON, HTTP failures and response bytes', async (t) => {
  for (const response of [new Response('{'), new Response('denied', { status: 403 }),
    new Response('x'.repeat(1024 * 1024 + 1))]) {
    const { updater, state } = fixture(t);
    state.fetch = async () => response;
    assert.equal(await updater.check(), null);
  }
  for (const [body, options] of [['{', {}], ['denied', { status: 503 }], ['x'.repeat(1024 * 1024 + 1), {}]]) {
    const { updater, state } = fixture(t);
    state.fetch = async () => new Response(body, options);
    const quiet = updater.check();
    const strict = updater.check({ strict: true });
    await assert.rejects(strict, /JSON|HTTP|size|parse|Unexpected/i);
    assert.equal(await quiet, null);
    assert.equal(state.calls.length, 1, 'Quiet callers must not swallow a shared strict error.');
  }
  for (const strictFirst of [false, true]) {
    const { updater, state } = fixture(t);
    const failure = new Error('offline fixture');
    state.fetch = async () => { throw failure; };
    const first = updater.check({ strict: strictFirst });
    const second = updater.check({ strict: !strictFirst });
    await assert.rejects(strictFirst ? first : second, (error) => error === failure);
    assert.equal(await (strictFirst ? second : first), null);
    assert.equal(state.calls.length, 1);
  }
  const { updater, state } = fixture(t);
  state.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const quiet = updater.check();
  await assert.rejects(updater.check({ strict: true }), /timed out/i);
  assert.equal(await quiet, null);
});

test('start verifies downloads before a detached private helper handshake', async (t) => {
  const { updater, state } = fixture(t);
  await updater.start(await updater.check());
  const { command, args, options, work, child } = state.spawns[0];
  assert.equal(command, '/bin/bash');
  assert.equal(args[0], path.join(work, 'update-helper.sh'));
  assert.equal(options.detached, true);
  assert.equal(options.stdio, 'ignore');
  assert.equal(options.shell, undefined);
  assert.equal(child.unreferenced, true);
  assert.deepEqual(fs.readFileSync(path.join(work, 'OnlyDM-linux-x64.deb')), payload);
  assert.equal(fs.readFileSync(path.join(work, 'accepted'), 'utf8'), fs.readFileSync(path.join(work, 'token'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(work, 'mode'), 'utf8'), 'parent');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(work).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(work, 'token')).mode & 0o777, 0o600);
  }
});

test('first installation and foreground CLI mode await completion without parent exit', async (t) => {
  const { updater, state } = fixture(t, { version: undefined });
  state.behavior = 'complete';
  await updater.start(await updater.check(), { waitForParent: false });
  const { work, options, child } = state.spawns[0];
  assert.equal(fs.readFileSync(path.join(work, 'mode'), 'utf8'), 'foreground');
  assert.equal(options.detached, false);
  assert.equal(options.stdio, 'inherit');
  assert.equal(child.unreferenced, undefined);
  assert.equal(fs.readFileSync(path.join(work, 'accepted'), 'utf8'), fs.readFileSync(path.join(work, 'token'), 'utf8'));
});

test('wrong checksum names, digests, sizes and extra lines cannot reach the helper', async (t) => {
  for (const checksum of [`${digest}  wrong.deb\n`, `${'0'.repeat(64)}  OnlyDM-linux-x64.deb\n`,
    `${digest}  OnlyDM-linux-x64.deb\nextra`, `${digest}\n`]) {
    const { updater, state } = fixture(t);
    const result = await updater.check();
    state.checksum = checksum;
    await assert.rejects(updater.start(result), /checksum|size/i);
    assert.equal(state.spawns.length, 0);
  }
  const { updater, state } = fixture(t);
  const result = await updater.check();
  state.payload = Buffer.from('truncated');
  await assert.rejects(updater.start(result), /size|checksum/i);
  assert.equal(state.spawns.length, 0);
});

test('download redirects allow only GitHub release asset storage', async (t) => {
  const { updater, state } = fixture(t);
  const result = await updater.check();
  state.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://evil.test/package' } });
  await assert.rejects(updater.start(result), /redirect|trusted/i);
  assert.equal(state.spawns.length, 0);
});

test('checksum parser consumes the entire uploaded checksum rather than accepting a second newline', async (t) => {
  const { updater, state } = fixture(t);
  state.checksum = `${digest}  OnlyDM-linux-x64.deb\n\n`;
  state.release.assets[1].size = Buffer.byteLength(state.checksum);
  await assert.rejects(updater.start(await updater.check()), /checksum/i);
  assert.equal(state.spawns.length, 0);
});

test('helper spawn, exit, validation, token and timeout failures reject without killing', async (t) => {
  for (const behavior of ['error', 'exit', 'failed', 'bad-ready', 'timeout']) {
    const { updater, state } = fixture(t);
    state.behavior = behavior;
    await assert.rejects(updater.start(await updater.check()), /helper|validation|token|timed out|spawn/i);
    const { work } = state.spawns[0];
    assert.equal(fs.existsSync(path.join(work, 'cancelled')), true, behavior);
    assert.equal(fs.existsSync(path.join(work, 'accepted')), false, behavior);
  }
});

test('trusted signed asset redirects, concurrent checks and duplicate starts are bounded', async (t) => {
  const { updater, state } = fixture(t);
  const [first, second] = await Promise.all([updater.check(), updater.check()]);
  assert.equal(first, second);
  assert.equal(state.calls.length, 1);
  // The checksum redirect also needs its small, correctly named checksum body.
  state.fetch = async (url) => {
    if (url.startsWith(base)) return new Response(null, { status: 302,
      headers: { location: 'https://release-assets.githubusercontent.com/' + (url.endsWith('.sha256') ? 'checksum' : 'package') } });
    return new Response(url.endsWith('/checksum') ? `${digest}  OnlyDM-linux-x64.deb\n` : payload);
  };
  const starting = updater.start(first);
  await assert.rejects(updater.start(first), /already/i);
  await starting;
});

test('foreground mode rejects a missing installation receipt and unfinished helpers', async (t) => {
  for (const behavior of ['ready', 'exit', 'failed']) {
    const { updater, state } = fixture(t);
    state.behavior = behavior;
    await assert.rejects(updater.start(await updater.check(), { waitForParent: false }), /helper|failed|timed out/i);
  }
});

// These execute the production shell logic, with every installation/GUI command
// redirected to inert tools inside a temporary directory. Never use the real installer.
const shellTest = process.platform === 'linux' ? test : test.skip;
const mockTool = `#!/bin/bash
set -eu
tool=\${0##*/}
printf '%s' "$tool" >> "$MOCK_ROOT/calls"
printf ' <%s>' "$@" >> "$MOCK_ROOT/calls"
printf '\\n' >> "$MOCK_ROOT/calls"
case $tool in
  uname) printf '%s\\n' "\${MOCK_SYSTEM:-Linux}" ;;
  stat)
    if [[ $1 == -f ]]; then
      case $2 in %u) code=%u ;; %Lp) code=%a ;; %z) code=%s ;; *) exit 91 ;; esac
      exec /usr/bin/stat -c "$code" "$3"
    fi
    exec /usr/bin/stat "$@" ;;
  dpkg-deb)
    if [[ \${MOCK_PREPARE_GATE:-0} == 1 ]]; then
      printf preparing > "$MOCK_ROOT/preparing"
      while [[ ! -e $MOCK_ROOT/release-validation ]]; do /bin/sleep 0.01; done
    fi
    case $3 in
      Package) printf '%s' "\${MOCK_PACKAGE_NAME:-onlydm}" ;;
      Version) printf '%s' "\${MOCK_PACKAGE_VERSION:-1.2.0}" ;;
      Architecture) printf '%s' "\${MOCK_PACKAGE_ARCH:-amd64}" ;;
      *) exit 92 ;;
    esac ;;
  dpkg-query) [[ -f $MOCK_ROOT/status ]] && /bin/cat "$MOCK_ROOT/status" ;;
  pkexec)
    [[ $1 == "$MOCK_ROOT/bin/apt-get" ]] || exit 93
    [[ \${MOCK_INSTALL:-success} != cancel ]] || exit 126
    exec "$@" ;;
  sudo)
    [[ $1 == -- && $2 == "$MOCK_ROOT/bin/apt-get" ]] || exit 93
    [[ \${MOCK_INSTALL:-success} != cancel ]] || exit 1
    if [[ \${MOCK_REQUIRE_INPUT:-0} == 1 ]]; then
      IFS= read -r terminal_input
      [[ $terminal_input == inherited-terminal-fixture ]] || exit 93
      printf 'native sudo terminal fixture\\n' >&2
    fi
    shift
    exec "$@" ;;
  apt-get)
    [[ $# == 5 && $1 == install && $2 == --yes && $3 == --no-remove
      && $4 == --no-install-recommends && -f $5 ]] || exit 94
    case \${MOCK_INSTALL:-success} in
      cancel) exit 100 ;;
      partial) printf changed >> "$MOCK_ROOT/opt/onlydm/onlydm"; exit 1 ;;
    esac
    # The local-package apt install resolves a fixture dependency before OnlyDM.
    printf installed > "$MOCK_ROOT/dependency-installed"
    /bin/mkdir -p "$MOCK_ROOT/opt/onlydm"
    /bin/cp "$MOCK_ROOT/launcher" "$MOCK_ROOT/opt/onlydm/onlydm"
    /bin/chmod 755 "$MOCK_ROOT/opt/onlydm/onlydm"
    printf 'install ok installed\\n1.2.0' > "$MOCK_ROOT/status" ;;
  dpkg) exit 94 ;;
  hdiutil)
    case $1 in
      verify) [[ \${MOCK_IMAGE_FAIL:-0} != 1 ]] ;;
      attach)
        shift
        while (( $# )); do
          if [[ $1 == -mountpoint ]]; then /bin/mkdir -p "$2"; /bin/cp -a "$MOCK_ROOT/new/OnlyDM.app" "$2/"; break; fi
          shift
        done ;;
      detach) /bin/rm -rf -- "$2/OnlyDM.app" ;;
      *) exit 95 ;;
    esac ;;
  PlistBuddy)
    app=\${3%/Contents/Info.plist}
    case $2 in
      'Print :CFBundleIdentifier') printf '%s' "\${MOCK_BUNDLE_ID:-org.thisnorm.onlydm}" ;;
      'Print :CFBundleExecutable') printf '%s' "\${MOCK_BUNDLE_EXECUTABLE:-OnlyDM}" ;;
      'Print :CFBundleShortVersionString') /bin/cat "$app/.version" ;;
      *) exit 96 ;;
    esac ;;
  codesign)
    app=\${!#}
    [[ \${MOCK_SIGNATURE_FAIL:-0} != 1 ]] || exit 1
    if [[ \${MOCK_VERIFY_AFTER_SWAP_FAIL:-0} == 1 && $app == "$MOCK_ROOT/Applications/OnlyDM.app"
      && $(/bin/cat "$app/.version") == 1.2.0 ]]; then exit 1; fi ;;
  ditto)
    [[ \${MOCK_COPY_FAIL:-0} != 1 ]] || exit 1
    shift 3
    /bin/mkdir -p "$2"
    /bin/cp -a "$1/." "$2/" ;;
  mv)
    if [[ \${MOCK_READY_GATE:-0} == 1 && $1 == */ready.pending ]]; then
      printf paused > "$MOCK_ROOT/ready-paused"
      while [[ ! -e $MOCK_ROOT/publish-ready ]]; do /bin/sleep 0.01; done
    fi
    if [[ \${MOCK_SWAP_FAIL:-0} == 1 && $1 == *'/.OnlyDM-update-'* ]]; then exit 1; fi
    if [[ \${MOCK_RESTORE_FAIL:-0} == 1 && $1 == *'/.OnlyDM-backup-'* ]]; then exit 1; fi
    exec /bin/mv "$@" ;;
  open) /bin/cat "$2/.version" > "$MOCK_ROOT/restarted" ;;
  osascript)
    if [[ \${2:-} == */update-helper.sh ]]; then
      printf admin-prompt >> "$MOCK_ROOT/admin"
      if [[ \${MOCK_ADMIN_CANCEL:-0} == 1 ]]; then printf cancelled > "$3/cancelled"; fi
      exec /bin/bash "$2" --mac-swap "$3"
    fi ;;
  zenity|notify-send) : ;;
  *) exit 97 ;;
esac
`;

function helperFixture(t, { mac = false, fresh = false, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onlydm-helper-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, 'OnlyDM-update-test');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(work, { mode: 0o700 });
  fs.mkdirSync(bin);
  const tools = ['uname', 'stat', 'dpkg-deb', 'dpkg-query', 'pkexec', 'sudo', 'apt-get', 'dpkg', 'hdiutil', 'codesign',
    'PlistBuddy', 'ditto', 'open', 'osascript', 'zenity', 'notify-send', 'mv'];
  let script = fs.readFileSync(path.join(__dirname, '../src/update-helper.sh'), 'utf8');
  for (const tool of tools) {
    const mock = path.join(bin, tool);
    fs.writeFileSync(mock, mockTool, { mode: 0o700 });
  }
  script = script.replace(/\/(?:usr\/bin|usr\/libexec|bin)\/([a-zA-Z0-9-]+)/g,
    (original, tool) => tools.includes(tool) ? path.join(bin, tool) : original);
  script = script.replaceAll('/opt/onlydm', root + '/opt/onlydm')
    .replace('-C /opt onlydm', '-C "' + root + '/opt" onlydm')
    .replaceAll('/Applications', root + '/Applications')
    .replaceAll('[[ -w $parent ]]', '[[ ${MOCK_PROTECTED:-0} != 1 ]]')
    .replaceAll('[[ ! -w $parent ]]', '[[ ${MOCK_PROTECTED:-0} == 1 ]]')
    .replaceAll('(( EUID == 0 ))', '[[ ${MOCK_ROOT_USER:-0} == 1 ]]')
    .replace('WAIT_SECONDS=30', 'WAIT_SECONDS=1');
  fs.writeFileSync(path.join(work, 'update-helper.sh'), script, { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'Applications'));
  const target = mac ? root + '/Applications/OnlyDM.app/Contents/MacOS/OnlyDM' : root + '/opt/onlydm/onlydm';
  fs.writeFileSync(path.join(root, 'launcher'), '#!/bin/bash\nprintf launched > "$MOCK_ROOT/restarted"\n', { mode: 0o700 });
  function bundle(app, version) {
    fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents/Info.plist'), 'inert plist');
    fs.writeFileSync(path.join(app, 'Contents/MacOS/OnlyDM'), 'inert Mach-O fixture', { mode: 0o700 });
    fs.writeFileSync(path.join(app, '.version'), version);
  }
  if (mac) {
    bundle(path.join(root, 'new/OnlyDM.app'), env.MOCK_NEW_VERSION || '1.2.0');
    if (!fresh) bundle(path.join(root, 'Applications/OnlyDM.app'), '1.1.8');
  } else if (!fresh) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, 'launcher'), target);
    fs.writeFileSync(path.join(root, 'status'), 'install ok installed\n1.1.8');
  }
  const fields = { platform: mac ? 'darwin' : 'linux', arch: mac ? 'arm64' : 'x64', version: '1.2.0',
    'current-version': fresh ? '0.0.0' : '1.1.8', executable: target, pid: String(process.pid),
    stamp: fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').at(-1).split(' ')[19],
    token: 'a'.repeat(48), accepted: 'a'.repeat(48), mode: 'foreground', sha256: digest, 'update.log': '' };
  for (const [key, value] of Object.entries(fields)) fs.writeFileSync(path.join(work, key), value, { mode: 0o600 });
  fs.writeFileSync(path.join(work, mac ? 'OnlyDM-mac-arm64.dmg' : 'OnlyDM-linux-x64.deb'), payload, { mode: 0o600 });
  const childEnv = { ...process.env, MOCK_ROOT: root, MOCK_SYSTEM: mac ? 'Darwin' : 'Linux', ...env };
  function run(stage = work, input = null) {
    const child = spawn('/bin/bash', [path.join(stage, 'update-helper.sh'), stage], {
      env: childEnv, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== null) child.stdin.end(input);
    const completed = new Promise((resolve, reject) => {
      let output = '';
      child.stdout.on('data', (data) => { output += data; });
      child.stderr.on('data', (data) => { output += data; });
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Inert helper hung: ' + output)); }, 8000);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output, log: fs.readFileSync(path.join(stage, 'update.log'), 'utf8') });
      });
    });
    return { child, completed };
  }
  const calls = () => fs.existsSync(path.join(root, 'calls')) ? fs.readFileSync(path.join(root, 'calls'), 'utf8') : '';
  return { root, work, run, calls, target };
}

async function eventually(predicate, diagnostic = () => '') {
  const until = Date.now() + 2500;
  while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(predicate(), diagnostic());
}

shellTest('CLI Linux installs dependencies without pkexec and preserves terminal input for sudo', async (t) => {
  for (const [fresh, root] of [[false, false], [true, false], [true, true]]) {
    const f = helperFixture(t, { fresh, env: { MOCK_ROOT_USER: root ? '1' : '0', MOCK_REQUIRE_INPUT: root ? '0' : '1' } });
    fs.unlinkSync(path.join(f.root, 'bin/pkexec'));
    if (root) fs.unlinkSync(path.join(f.root, 'bin/sudo'));
    const result = await f.run(f.work, root ? null : 'inherited-terminal-fixture\n').completed;
    assert.equal(result.code, 0, result.output + result.log);
    assert.match(f.calls(), /^apt-get <install> <--yes> <--no-remove> <--no-install-recommends>/m);
    assert.doesNotMatch(f.calls(), /^(?:pkexec|dpkg) /m);
    if (root) assert.doesNotMatch(f.calls(), /^sudo /m);
    else {
      assert.match(f.calls(), /^sudo <--> <.*\/bin\/apt-get>/m);
      assert.match(result.output, /native sudo terminal fixture/);
      assert.doesNotMatch(result.log, /native sudo terminal fixture/);
    }
    assert.equal(fs.readFileSync(path.join(f.root, 'dependency-installed'), 'utf8'), 'installed');
    assert.equal(fs.readFileSync(path.join(f.work, 'installed'), 'utf8'), 'a'.repeat(48));
    await eventually(() => fs.existsSync(path.join(f.root, 'restarted')));
    assert.equal(fs.existsSync(path.join(f.work, 'OnlyDM-linux-x64.deb')), false);
  }
});

shellTest('Linux helper refuses bad package metadata and a changed staged checksum before readiness', async (t) => {
  for (const env of [{ MOCK_PACKAGE_NAME: 'other' }, { MOCK_PACKAGE_VERSION: '9.0.0' }, { MOCK_PACKAGE_ARCH: 'arm64' }, {}]) {
    const f = helperFixture(t, { env });
    if (!Object.keys(env).length) fs.appendFileSync(path.join(f.work, 'OnlyDM-linux-x64.deb'), 'changed');
    const result = await f.run().completed;
    assert.notEqual(result.code, 0, result.output + result.log);
    assert.match(result.log, /Linux package (identity|checksum)/);
    assert.equal(fs.existsSync(path.join(f.work, 'ready')), false);
    assert.doesNotMatch(f.calls(), /pkexec/);
    assert.equal(fs.existsSync(path.join(f.root, 'restarted')), false);
  }
});

shellTest('Linux authorization cancellation restarts intact old files; partial installation does not', async (t) => {
  for (const install of ['cancel', 'partial']) {
    const f = helperFixture(t, { env: { MOCK_INSTALL: install } });
    const result = await f.run().completed;
    assert.notEqual(result.code, 0);
    if (install === 'cancel') await eventually(() => fs.existsSync(path.join(f.root, 'restarted')));
    else {
      assert.equal(fs.existsSync(path.join(f.root, 'restarted')), false);
      assert.match(result.log, /restart was withheld/);
    }
  }
});

shellTest('GUI Linux updates require a native error notifier before publishing ready', async (t) => {
  const f = helperFixture(t);
  fs.writeFileSync(path.join(f.work, 'mode'), 'parent');
  fs.unlinkSync(path.join(f.root, 'bin/zenity'));
  fs.unlinkSync(path.join(f.root, 'bin/notify-send'));
  const result = await f.run().completed;
  assert.notEqual(result.code, 0);
  assert.match(result.log, /requires zenity or notify-send/);
  assert.equal(fs.existsSync(path.join(f.work, 'ready')), false);
  assert.doesNotMatch(f.calls(), /pkexec/);
});

shellTest('parent mode requires PID start stamp, acceptance and graceful exit; never kills the origin', async (t) => {
  for (const mode of ['accepted', 'wrong-stamp', 'unaccepted', 'cancelled', 'timeout']) {
    const f = helperFixture(t);
    const origin = spawn('/bin/sleep', ['30']);
    const originExit = new Promise((resolve) => origin.once('exit', resolve));
    t.after(() => { if (origin.exitCode === null && origin.signalCode === null) origin.kill('SIGTERM'); });
    const stat = fs.readFileSync(`/proc/${origin.pid}/stat`, 'utf8');
    const stamp = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    fs.writeFileSync(path.join(f.work, 'pid'), String(origin.pid));
    fs.writeFileSync(path.join(f.work, 'stamp'), mode === 'wrong-stamp' ? 'wrong' : stamp);
    fs.writeFileSync(path.join(f.work, 'mode'), 'parent');
    fs.unlinkSync(path.join(f.work, 'accepted'));
    const { completed } = f.run();
    if (mode !== 'wrong-stamp') {
      await eventually(() => fs.existsSync(path.join(f.work, 'ready')), () => fs.readFileSync(path.join(f.work, 'update.log'), 'utf8'));
      assert.doesNotMatch(f.calls(), /pkexec/);
      if (mode === 'accepted') fs.writeFileSync(path.join(f.work, 'accepted'), 'a'.repeat(48));
      if (mode === 'cancelled') fs.writeFileSync(path.join(f.work, 'cancelled'), 'a'.repeat(48));
      if (['accepted', 'unaccepted'].includes(mode)) { origin.kill('SIGTERM'); await originExit; }
    }
    const result = await completed;
    assert.equal(result.code === 0, mode === 'accepted', result.log);
    if (mode !== 'accepted') assert.doesNotMatch(f.calls(), /pkexec/);
    else {
      assert.match(f.calls(), /^pkexec <.*\/bin\/apt-get> <install> <--yes> <--no-remove> <--no-install-recommends>/m);
      assert.doesNotMatch(f.calls(), /^sudo /m);
    }
    if (['wrong-stamp', 'cancelled', 'timeout'].includes(mode)) {
      assert.equal(origin.signalCode, null, 'The helper must leave the unrelated/unfinished origin alive.');
      origin.kill('SIGTERM');
      await originExit;
    }
  }
  const atomic = helperFixture(t, { env: { MOCK_READY_GATE: '1' } });
  const publication = atomic.run();
  await eventually(() => fs.existsSync(path.join(atomic.root, 'ready-paused')),
    () => fs.readFileSync(path.join(atomic.work, 'update.log'), 'utf8'));
  assert.equal(fs.existsSync(path.join(atomic.work, 'ready')), false);
  assert.equal(fs.readFileSync(path.join(atomic.work, 'ready.pending'), 'utf8'), 'a'.repeat(48));
  assert.doesNotMatch(atomic.calls(), /^(?:sudo|pkexec|apt-get) /m);
  fs.writeFileSync(path.join(atomic.root, 'publish-ready'), 'continue atomic publish');
  const published = await publication.completed;
  assert.equal(published.code, 0, published.output + published.log);
  assert.equal(fs.readFileSync(path.join(atomic.work, 'ready'), 'utf8'), 'a'.repeat(48));
  // Exercise the real Node timeout against a helper still validating, then let
  // the owned origin exit. A failed cancellation write must also fail closed.
  for (const waitForParent of [true, false]) {
    for (const cancellationWritable of [true, false]) {
      const f = helperFixture(t, { env: { MOCK_PREPARE_GATE: '1' } });
      const origin = spawn('/bin/sleep', ['30']);
      const originExit = new Promise((resolve) => origin.once('exit', resolve));
      t.after(() => { if (origin.exitCode === null && origin.signalCode === null) origin.kill('SIGTERM'); });
      let running;
      let stage;
      const { updater } = fixture(t, { deps: { spawn: (_command, args) => {
        stage = args[1];
        fs.copyFileSync(path.join(f.work, 'update-helper.sh'), args[0]);
        fs.writeFileSync(path.join(stage, 'executable'), f.target);
        fs.writeFileSync(path.join(stage, 'pid'), String(origin.pid));
        const stat = fs.readFileSync(`/proc/${origin.pid}/stat`, 'utf8');
        fs.writeFileSync(path.join(stage, 'stamp'), stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
        running = f.run(stage);
        return running.child;
      } } });
      const originalWrite = fs.promises.writeFile;
      const writeMock = !cancellationWritable ? t.mock.method(fs.promises, 'writeFile', function (file, ...args) {
        if (path.basename(file) === 'cancelled') return Promise.reject(Object.assign(new Error('inert disk full'), { code: 'ENOSPC' }));
        return originalWrite.call(this, file, ...args);
      }) : null;
      try {
        await assert.rejects(updater.start(await updater.check(), { waitForParent }), /timed out/i);
      } finally { writeMock?.mock.restore(); }
      assert.equal(fs.existsSync(path.join(f.root, 'preparing')), true);
      assert.equal(fs.existsSync(path.join(stage, 'accepted')), false);
      assert.equal(fs.existsSync(path.join(stage, 'cancelled')), cancellationWritable);
      origin.kill('SIGTERM');
      await originExit;
      fs.writeFileSync(path.join(f.root, 'release-validation'), 'continue inert validation');
      const result = await running.completed;
      assert.notEqual(result.code, 0, result.log);
      assert.doesNotMatch(f.calls(), /pkexec/);
      assert.equal(fs.existsSync(path.join(f.root, 'restarted')), false);
    }
  }
});

shellTest('macOS helper verifies image/signature and atomically replaces or first installs an inert app', async (t) => {
  for (const fresh of [false, true]) {
    const f = helperFixture(t, { mac: true, fresh });
    const result = await f.run().completed;
    assert.equal(result.code, 0, result.output + result.log);
    assert.equal(fs.readFileSync(path.join(f.root, 'Applications/OnlyDM.app/.version'), 'utf8'), '1.2.0');
    assert.equal(fs.readFileSync(path.join(f.root, 'restarted'), 'utf8'), '1.2.0');
    assert.match(f.calls(), /hdiutil <verify>/);
    assert.match(f.calls(), /codesign <--verify> <--deep> <--strict>/);
    assert.match(f.calls(), /ditto <--rsrc> <--extattr> <--acl>/);
    assert.equal(fs.existsSync(path.join(f.root, 'admin')), false);
    assert.deepEqual(fs.readdirSync(path.join(f.root, 'Applications')), ['OnlyDM.app']);
  }
});

shellTest('macOS image, signature and bundle metadata rejection cannot publish ready or replace the app', async (t) => {
  for (const env of [{ MOCK_IMAGE_FAIL: '1' }, { MOCK_SIGNATURE_FAIL: '1' },
    { MOCK_BUNDLE_ID: 'other.app' }, { MOCK_BUNDLE_EXECUTABLE: 'Other' }, { MOCK_NEW_VERSION: '9.0.0' }]) {
    const f = helperFixture(t, { mac: true, env });
    assert.notEqual((await f.run().completed).code, 0);
    assert.equal(fs.existsSync(path.join(f.work, 'ready')), false);
    assert.equal(fs.readFileSync(path.join(f.root, 'Applications/OnlyDM.app/.version'), 'utf8'), '1.1.8');
    assert.doesNotMatch(f.calls(), /^(?:open|mv) /m);
  }
});

shellTest('macOS failed rename or post-swap verification restores and relaunches the old app', async (t) => {
  for (const env of [{ MOCK_SWAP_FAIL: '1' }, { MOCK_VERIFY_AFTER_SWAP_FAIL: '1' }]) {
    const f = helperFixture(t, { mac: true, env });
    const result = await f.run().completed;
    assert.notEqual(result.code, 0, result.log);
    assert.equal(fs.readFileSync(path.join(f.root, 'Applications/OnlyDM.app/.version'), 'utf8'), '1.1.8');
    assert.equal(fs.readFileSync(path.join(f.root, 'restarted'), 'utf8'), '1.1.8');
  }
});

shellTest('protected Applications uses only the mocked OS administrator prompt', async (t) => {
  const f = helperFixture(t, { mac: true, env: { MOCK_PROTECTED: '1' } });
  const result = await f.run().completed;
  assert.equal(result.code, 0, result.output + result.log);
  assert.equal(fs.readFileSync(path.join(f.root, 'admin'), 'utf8'), 'admin-prompt');
  assert.equal(fs.readFileSync(path.join(f.root, 'restarted'), 'utf8'), '1.2.0');
});

shellTest('failed macOS restore preserves its backup and never relaunches an unsafe installation', async (t) => {
  const f = helperFixture(t, { mac: true, env: { MOCK_SWAP_FAIL: '1', MOCK_RESTORE_FAIL: '1' } });
  const result = await f.run().completed;
  assert.notEqual(result.code, 0, result.log);
  assert.equal(fs.existsSync(path.join(f.work, 'unsafe')), true);
  assert.equal(fs.existsSync(path.join(f.root, 'restarted')), false);
  assert.ok(fs.readdirSync(path.join(f.root, 'Applications')).some((name) => name.startsWith('.OnlyDM-backup-')));
});

shellTest('a cancellation while the OS authorization prompt is open cannot start the macOS swap', async (t) => {
  const f = helperFixture(t, { mac: true, env: { MOCK_PROTECTED: '1', MOCK_ADMIN_CANCEL: '1' } });
  const result = await f.run().completed;
  assert.notEqual(result.code, 0, result.log);
  assert.equal(fs.readFileSync(path.join(f.root, 'Applications/OnlyDM.app/.version'), 'utf8'), '1.1.8');
  assert.doesNotMatch(f.calls(), /mv .*\/Applications\//);
});

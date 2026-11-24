'use strict';

const assert = require('node:assert/strict');
const { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

const cliPath = path.resolve(__dirname, '../cli/odm.js');
const source = readFileSync(cliPath, 'utf8');
const installPath = path.resolve(__dirname, '../install.ps1');
const uninstallPath = path.resolve(__dirname, '../uninstall.ps1');
const dispatcherPath = path.resolve(__dirname, '../cli/OnlyDM.Command.ps1');
const localAppData = path.join(path.parse(__dirname).root, 'CLI Test User', 'AppData', 'Local');
const appPath = path.join(localAppData, 'Programs', 'OnlyDM', 'OnlyDM.exe');

async function runCli(argv = [], {
  platform = 'win32', env = { LOCALAPPDATA: localAppData },
  existingPaths = [appPath, installPath, dispatcherPath], spawnResults = [], posixError, posixStatus = 0,
} = {}) {
  const result = { calls: [], posixCalls: [], stdout: [], stderr: [] };
  const exited = {};
  const dependencies = {
    'node:path': path,
    'node:fs': { existsSync: file => existingPaths.includes(file) },
    'node:child_process': {
      spawnSync(file, args, options) {
        result.calls.push({ file, args: Array.from(args), options: {
          ...options, ...(options.env && { env: { ...options.env } }),
        } });
        return spawnResults[result.calls.length - 1] || { status: 0 };
      },
    },
    '../package.json': { version: '0.2.9' },
    './posix.cjs': {
      async run(command) {
        result.posixCalls.push(command);
        if (posixError) throw posixError;
        return posixStatus;
      },
    },
  };
  try {
    await runInNewContext(source, {
      __dirname: path.dirname(cliPath),
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
        return dependencies[name];
      },
      process: {
        argv: ['node', cliPath, ...argv], platform, env,
        exit(code) { result.exitCode = code; throw exited; },
        set exitCode(code) { result.exitCode = code; },
      },
      console: {
        log: message => result.stdout.push(message),
        error: message => result.stderr.push(message),
      },
    }, { filename: cliPath, timeout: 1000 });
  } catch (error) {
    if (error !== exited) throw error;
  }
  assert.notEqual(result.exitCode, undefined, 'CLI must exit explicitly');
  return result;
}

function powershell(scriptPath, args = [], env = { LOCALAPPDATA: localAppData }) {
  return {
    file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    options: { stdio: 'inherit', windowsHide: false, env: {
      ...env, PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    } },
  };
}

test('cold default install, install and update use the bundled latest-release bootstrap', async () => {
  for (const argv of [[], ['install'], ['UPDATE']]) {
    const result = await runCli(argv, { existingPaths: [] });
    assert.deepEqual(result.calls, [powershell(installPath)], JSON.stringify(argv));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stderr, []);
  }
});

test('installed default install, install and update use native maintenance stop/restart behavior', async () => {
  for (const argv of [[], ['install'], ['UPDATE']]) {
    const result = await runCli(argv);
    assert.deepEqual(result.calls, [powershell(dispatcherPath, ['-Command', (argv[0] || 'install').toLowerCase()])]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stderr, []);
  }
});

test('install and update keep the bootstrap when the app, dispatcher or LOCALAPPDATA is unavailable', async () => {
  for (const command of ['install', 'update']) {
    for (const options of [
      { existingPaths: [installPath, dispatcherPath] },
      { existingPaths: [appPath, installPath] },
      { env: {} },
    ]) {
      const result = await runCli([command], options);
      assert.deepEqual(result.calls, [powershell(installPath, [], options.env)]);
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.stderr, []);
    }
  }
});

test('first start installs without a package version pin before invoking the native dispatcher', async () => {
  const result = await runCli(['start'], { existingPaths: [installPath] });
  assert.deepEqual(result.calls, [
    powershell(installPath),
    powershell(dispatcherPath, ['-Command', 'start']),
  ]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.join('\n'), /not installed/i);
});

test('installed start and native commands use the renamed dispatcher; uninstall uses its own script', async () => {
  for (const command of ['start', 'stop', 'restart', 'status', 'on', 'off', 'uninstall']) {
    const result = await runCli([command], { existingPaths: command === 'start' ? [appPath] : [] });
    const expected = command === 'uninstall'
      ? powershell(uninstallPath)
      : powershell(dispatcherPath, ['-Command', command]);
    assert.deepEqual(result.calls, [expected], command);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, []);
  }
});

test('start keeps native fallback when LOCALAPPDATA or the bundled installer is unavailable', async () => {
  for (const options of [{ env: {} }, { existingPaths: [] }]) {
    const result = await runCli(['start'], options);
    assert.deepEqual(result.calls, [powershell(dispatcherPath, ['-Command', 'start'], options.env)]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, []);
  }
});

test('help and version aliases work without Windows or PowerShell', async () => {
  for (const command of ['help', '--help', '-h', 'version', '--version', '-v']) {
    const result = await runCli([command], { platform: 'linux' });
    assert.equal(result.exitCode, 0, command);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.stderr, []);
    if (command.includes('version') || command === '-v') {
      assert.deepEqual(result.stdout, ['0.2.9']);
    } else {
      assert.match(result.stdout.join('\n'), /OnlyDM 0\.2\.9/);
      for (const name of ['start', 'stop', 'restart', 'status', 'on', 'off', 'update', 'uninstall']) {
        assert.match(result.stdout[0], new RegExp('^  odm ' + name + '\\s+\\S', 'm'));
      }
    }
  }
});

test('unknown commands and unsupported platforms exit before spawning PowerShell', async () => {
  const invalid = await runCli(['not-a-command'], { platform: 'linux' });
  assert.equal(invalid.exitCode, 2);
  assert.deepEqual(invalid.calls, []);
  assert.deepEqual(invalid.stderr, ["Unknown command. Run 'odm help'."]);
  assert.deepEqual(invalid.stdout, []);

  for (const platform of ['freebsd', 'aix']) {
    const result = await runCli(['update'], { platform });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.calls, []);
    assert.match(result.stderr.join('\n'), /Unsupported platform/);
  }
});

test('installer and native routes preserve exit codes, null status and PowerShell spawn errors', async () => {
  for (const command of ['install', 'update', 'status', 'uninstall']) {
    for (const [spawnResult, exitCode, errors] of [
      [{ status: 19 }, 19, []],
      [{ status: null }, 1, ['PowerShell stopped before the command finished.']],
      [{ status: null, error: new Error('spawn ENOENT') }, 1, ['Could not start Windows PowerShell.']],
    ]) {
      for (const existingPaths of [[appPath, installPath, dispatcherPath], []]) {
        const result = await runCli([command], { existingPaths, spawnResults: [spawnResult] });
        assert.equal(result.exitCode, exitCode, command);
        assert.equal(result.calls.length, 1);
        assert.deepEqual(result.stderr, errors);
      }
    }
  }
});

test('failed first-start installation stops before dispatching start', async () => {
  for (const [spawnResult, exitCode, errors] of [
    [{ status: 23 }, 23, []],
    [{ status: null }, 1, ['PowerShell stopped before the command finished.']],
    [{ status: null, error: new Error('spawn ENOENT') }, 1, ['Could not start Windows PowerShell.']],
  ]) {
    const result = await runCli(['start'], {
      existingPaths: [installPath], spawnResults: [spawnResult],
    });
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].args[4], installPath);
    assert.deepEqual(result.stderr, errors);
  }
});

test('Windows PowerShell pins native modules only in child environments, including failed launches', async () => {
  for (const [roots, powershellHome] of [
    [{ SystemRoot: 'R:\\Native Windows', windir: 'Z:\\Other Windows' }, 'R:\\Native Windows\\System32\\WindowsPowerShell\\v1.0'],
    [{ windir: 'R:\\Native Windows' }, 'R:\\Native Windows\\System32\\WindowsPowerShell\\v1.0'],
    [{}, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0'],
  ]) {
    for (const moduleKey of ['PSModulePath', 'PSMODULEPATH', 'psmodulepath']) {
      for (const spawnResult of [{ status: 0 }, { status: 19 }, { status: null },
        { status: null, error: new Error('spawn ENOENT') }]) {
        const preservedEnv = { ...roots, LOCALAPPDATA: localAppData,
          Path: 'R:\\Caller Bin;C:\\Windows\\System32', ONLYDM_CLI_TEST_MARKER: 'preserved' };
        const env = Object.freeze({ ...preservedEnv, [moduleKey]: 'Z:\\PowerShell7\\Modules' });
        const result = await runCli(['start'], {
          env, existingPaths: [installPath], spawnResults: [spawnResult],
        });
        assert.equal(result.exitCode, spawnResult.status === 0 ? 0 : spawnResult.status || 1);
        assert.equal(result.calls.length, spawnResult.status === 0 ? 2 : 1);
        for (const call of result.calls) {
          assert.equal(call.file, `${powershellHome}\\powershell.exe`);
          assert.deepEqual(call.options.env, { ...preservedEnv, PSModulePath: `${powershellHome}\\Modules` });
        }
        assert.deepEqual(env, { ...preservedEnv, [moduleKey]: 'Z:\\PowerShell7\\Modules' });
      }
    }
  }
});

test('native CMD isolates contaminated modules and preserves caller environment and exit codes', {
  skip: process.platform !== 'win32',
}, () => {
  const tempRoot = path.resolve(tmpdir());
  const fixtureRoot = mkdtempSync(path.join(tempRoot, 'OnlyDM CLI modules-'));
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const nativeModules = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  const contaminatedModules = path.join(fixtureRoot, 'PowerShell 7 Modules');
  try {
    const utility = path.join(contaminatedModules, 'Microsoft.PowerShell.Utility');
    mkdirSync(utility, { recursive: true });
    writeFileSync(path.join(utility, 'Microsoft.PowerShell.Utility.psd1'),
      "@{ RootModule = 'Microsoft.PowerShell.Utility.psm1'; ModuleVersion = '7.0.0'; FunctionsToExport = @('Get-FileHash') }");
    writeFileSync(path.join(utility, 'Microsoft.PowerShell.Utility.psm1'),
      "function Get-FileHash { throw 'Inherited incompatible PowerShell module was loaded' }");
    copyFileSync(path.join(__dirname, '../cli/odm.cmd'), path.join(fixtureRoot, 'odm.cmd'));
    writeFileSync(path.join(fixtureRoot, 'OnlyDM.Command.ps1'), `
param([string]$Command, [int]$ExitCode)
$ErrorActionPreference = 'Stop'
$hash = Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256
@{
  command = $Command
  modules = $env:PSModulePath
  path = $env:Path
  marker = $env:ONLYDM_CLI_TEST_MARKER
  hash = $hash.Hash
  utility = (Get-Command Get-FileHash).Module.Path
} | ConvertTo-Json -Compress
exit $ExitCode
`);
    writeFileSync(path.join(fixtureRoot, 'caller.cmd'), [
      '@echo off',
      'call "%~dp0odm.cmd" update %1',
      'set "ONLYDM_CLI_TEST_EXIT=%errorlevel%"',
      'set PSModulePath',
      'set Path',
      'set ONLYDM_CLI_TEST_MARKER',
      'exit /b %ONLYDM_CLI_TEST_EXIT%',
      '',
    ].join('\r\n'));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !['psmodulepath', 'systemroot'].includes(key.toLowerCase())));
    env.SystemRoot = systemRoot;
    env.PSModulePath = contaminatedModules;
    env.ONLYDM_CLI_TEST_MARKER = 'preserved';
    const callerPath = env.Path || env.PATH;
    const cases = [
      { env, exitCode: 0 },
      { env, exitCode: 29 },
      { env: { ...env, SystemRoot: fixtureRoot }, exitCode: 0, missingExe: true },
    ];
    for (const entry of cases) {
      const result = spawnSync(path.join(systemRoot, 'System32', 'cmd.exe'),
        ['/d', '/s', '/c', `""${path.join(fixtureRoot, 'caller.cmd')}" ${entry.exitCode}"`],
        { env: entry.env, cwd: fixtureRoot, encoding: 'utf8', windowsVerbatimArguments: true, timeout: 30000 });
      assert.ifError(result.error);
      if (entry.missingExe) {
        assert.notEqual(result.status, 0, result.stdout + result.stderr);
      } else {
        assert.equal(result.status, entry.exitCode, result.stdout + result.stderr);
      }
      const lines = result.stdout.trim().split(/\r?\n/);
      assert.ok(lines.includes(`PSModulePath=${contaminatedModules}`), result.stdout);
      assert.ok(lines.some(line => /^path=/i.test(line) && line.slice(5) === callerPath), result.stdout);
      assert.ok(lines.includes('ONLYDM_CLI_TEST_MARKER=preserved'), result.stdout);
      if (!entry.missingExe) {
        const child = JSON.parse(lines.find(line => line.startsWith('{')));
        assert.equal(child.command, 'update');
        // WinPS can add its standard WindowsPowerShell module directories at startup.
        const modules = child.modules.toLowerCase().split(';');
        assert.ok(modules.includes(nativeModules.toLowerCase()));
        assert.ok(!modules.includes(contaminatedModules.toLowerCase()));
        assert.equal(child.path, callerPath);
        assert.equal(child.marker, 'preserved');
        assert.match(child.hash, /^[A-F0-9]{64}$/);
        assert.equal(child.utility.toLowerCase(),
          path.join(nativeModules, 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1').toLowerCase());
      }
    }
  } finally {
    assert.equal(path.dirname(fixtureRoot), tempRoot);
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('Linux and macOS route every management command to POSIX without PowerShell', async () => {
  const env = Object.freeze({ PSModulePath: 'Z:\\PowerShell7\\Modules', Path: '/caller/bin' });
  for (const platform of ['linux', 'darwin']) {
    for (const argv of [[], ...['install', 'update', 'start', 'stop', 'restart', 'status', 'on', 'off', 'uninstall'].map(c => [c])]) {
      const result = await runCli(argv, { platform, env, existingPaths: [] });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(result.posixCalls, [argv[0] || 'install']);
      assert.deepEqual(env, { PSModulePath: 'Z:\\PowerShell7\\Modules', Path: '/caller/bin' });
    }
  }
});

test('POSIX command failures are reported and set a failing exit code', async () => {
  for (const posixError of [new Error('disk full'), Object.assign(new Error('authorization canceled'), { exitCode: 42 })]) {
    const result = await runCli(['update'], { platform: 'darwin', posixError });
    assert.equal(result.exitCode, posixError.exitCode || 1);
    assert.deepEqual(result.stderr, [posixError.message]);
    assert.deepEqual(result.calls, []);
  }
  assert.equal((await runCli(['stop'], { platform: 'linux', posixStatus: 3 })).exitCode, 3);
});

test('extra arguments are rejected before aliases or platform dispatch', async () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    for (const command of ['install', 'start', 'help', '--version']) {
      const result = await runCli([command, 'unexpected'], { platform });
      assert.equal(result.exitCode, 2);
      assert.deepEqual(result.calls, []);
      assert.deepEqual(result.posixCalls, []);
      assert.match(result.stderr.join('\n'), /Expected one command/);
    }
  }
});

test('npm manifest includes the POSIX runtime and shared updater while retaining Windows and Node 18', () => {
  const pkg = JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  assert.deepEqual(pkg.os, ['win32', 'linux', 'darwin']);
  assert.equal(pkg.engines.node, '>=18');
  assert.equal(pkg.bin.odm, 'cli/odm.js');
  for (const file of ['cli/odm.js', 'cli/posix.cjs', 'cli/OnlyDM.Command.ps1', 'cli/odm.cmd',
    'install.ps1', 'uninstall.ps1', 'desktop/src/updates.cjs', 'desktop/src/update-helper.sh']) {
    assert.ok(pkg.files.includes(file), `Missing published runtime: ${file}`);
  }
});

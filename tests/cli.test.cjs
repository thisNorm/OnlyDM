'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
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

function runCli(argv = [], {
  platform = 'win32', env = { LOCALAPPDATA: localAppData },
  existingPaths = [appPath, installPath], spawnResults = [],
} = {}) {
  const result = { calls: [], stdout: [], stderr: [] };
  const exited = {};
  const dependencies = {
    'node:path': path,
    'node:fs': { existsSync: file => existingPaths.includes(file) },
    'node:child_process': {
      spawnSync(file, args, options) {
        result.calls.push({ file, args: Array.from(args), options: { ...options } });
        return spawnResults[result.calls.length - 1] || { status: 0 };
      },
    },
    '../package.json': { version: '0.2.9' },
  };
  try {
    runInNewContext(source, {
      __dirname: path.dirname(cliPath),
      require(name) {
        assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
        return dependencies[name];
      },
      process: {
        argv: ['node', cliPath, ...argv], platform, env,
        exit(code) { result.exitCode = code; throw exited; },
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

function powershell(scriptPath, args = []) {
  return {
    file: 'powershell.exe',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    options: { stdio: 'inherit', windowsHide: false },
  };
}

test('default install, install and update let the bundled installer select the latest stable release', () => {
  for (const argv of [[], ['install'], ['UPDATE']]) {
    const result = runCli(argv, { existingPaths: [] });
    assert.deepEqual(result.calls, [powershell(installPath)], JSON.stringify(argv));
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stderr, []);
  }
});

test('first start installs without a package version pin before invoking the native dispatcher', () => {
  const result = runCli(['start'], { existingPaths: [installPath] });
  assert.deepEqual(result.calls, [
    powershell(installPath),
    powershell(dispatcherPath, ['-Command', 'start']),
  ]);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout.join('\n'), /not installed/i);
});

test('installed start and native commands use the renamed dispatcher; uninstall uses its own script', () => {
  for (const command of ['start', 'stop', 'restart', 'status', 'on', 'off', 'uninstall']) {
    const result = runCli([command], { existingPaths: command === 'start' ? [appPath] : [] });
    const expected = command === 'uninstall'
      ? powershell(uninstallPath)
      : powershell(dispatcherPath, ['-Command', command]);
    assert.deepEqual(result.calls, [expected], command);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, []);
  }
});

test('start keeps native fallback when LOCALAPPDATA or the bundled installer is unavailable', () => {
  for (const options of [{ env: {} }, { existingPaths: [] }]) {
    const result = runCli(['start'], options);
    assert.deepEqual(result.calls, [powershell(dispatcherPath, ['-Command', 'start'])]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.stdout, []);
  }
});

test('help and version aliases work without Windows or PowerShell', () => {
  for (const command of ['help', '--help', '-h', 'version', '--version', '-v']) {
    const result = runCli([command], { platform: 'linux' });
    assert.equal(result.exitCode, 0, command);
    assert.deepEqual(result.calls, []);
    assert.deepEqual(result.stderr, []);
    if (command.includes('version') || command === '-v') {
      assert.deepEqual(result.stdout, ['0.2.9']);
    } else {
      assert.match(result.stdout.join('\n'), /OnlyDM 0\.2\.9/);
      assert.match(result.stdout.join('\n'), /start\|stop\|restart\|status\|on\|off\|update\|uninstall/);
    }
  }
});

test('unknown commands and unsupported platforms exit before spawning PowerShell', () => {
  const invalid = runCli(['not-a-command'], { platform: 'linux' });
  assert.equal(invalid.exitCode, 2);
  assert.deepEqual(invalid.calls, []);
  assert.deepEqual(invalid.stderr, ['Unknown command: not-a-command']);
  assert.match(invalid.stdout.join('\n'), /OnlyDM 0\.2\.9/);

  for (const platform of ['linux', 'darwin']) {
    const result = runCli(['update'], { platform });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.calls, []);
    assert.match(result.stderr.join('\n'), /Windows application/);
  }
});

test('installer and native routes preserve exit codes, null status and PowerShell spawn errors', () => {
  for (const command of ['update', 'status', 'uninstall']) {
    for (const [spawnResult, exitCode] of [
      [{ status: 19 }, 19],
      [{ status: null }, 1],
      [{ status: null, error: new Error('spawn ENOENT') }, 1],
    ]) {
      const result = runCli([command], { spawnResults: [spawnResult] });
      assert.equal(result.exitCode, exitCode, command);
      assert.equal(result.calls.length, 1);
      assert.deepEqual(result.stderr, spawnResult.error
        ? ['Failed to start PowerShell: spawn ENOENT'] : []);
    }
  }
});

test('failed first-start installation stops before dispatching start', () => {
  for (const [spawnResult, exitCode] of [
    [{ status: 23 }, 23],
    [{ status: null }, 1],
    [{ status: null, error: new Error('spawn ENOENT') }, 1],
  ]) {
    const result = runCli(['start'], {
      existingPaths: [installPath], spawnResults: [spawnResult],
    });
    assert.equal(result.exitCode, exitCode);
    assert.equal(result.calls.length, 1);
    assert.equal(result.calls[0].args[4], installPath);
    assert.deepEqual(result.stderr, spawnResult.error
      ? ['Failed to start PowerShell: spawn ENOENT'] : []);
  }
});

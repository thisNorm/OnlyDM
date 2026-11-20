#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const command = (process.argv[2] || 'install').toLowerCase();
const allowed = new Set(['install', 'update', 'uninstall', 'start', 'stop', 'restart', 'status', 'on', 'off', 'help']);

function printHelp() {
  console.log(`OnlyDM ${pkg.version}\n\nInstall (Windows, Linux, macOS):\n  npm install -g @thisnorm/onlydm\n  odm install\n\nCommands:\n  odm install|start|stop|restart|status|on|off|update|uninstall\n  odm help (--help, -h)\n  odm version (--version, -v)`);
}

if (process.argv.length > 3) {
  console.error("Expected one command. Run 'odm help' for usage.");
  process.exit(2);
}
if (command === '--help' || command === '-h' || command === 'help') {
  printHelp();
  process.exit(0);
}
if (command === '--version' || command === '-v' || command === 'version') {
  console.log(pkg.version);
  process.exit(0);
}
if (!allowed.has(command)) {
  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(2);
}
if (!['win32', 'linux', 'darwin'].includes(process.platform)) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

function runPowerShell(scriptPath, args) {
  const powershellHome = path.win32.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0');
  const env = { ...process.env };
  // Windows environment keys are case-insensitive; replace any inherited PS7 module path.
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === 'psmodulepath') delete env[key];
  }
  env.PSModulePath = path.win32.join(powershellHome, 'Modules');
  const result = spawnSync(
    path.win32.join(powershellHome, 'powershell.exe'),
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { stdio: 'inherit', windowsHide: false, env }
  );

  if (result.error) {
    console.error(`Failed to start PowerShell: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

function runWindows() {
  const appPath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OnlyDM', 'OnlyDM.exe')
    : '';
  const dispatcherPath = path.resolve(__dirname, 'OnlyDM.Command.ps1');
  if (command === 'start') {
    const bootstrapScriptPath = path.resolve(__dirname, '..', 'install.ps1');
    if (appPath && !fs.existsSync(appPath) && fs.existsSync(bootstrapScriptPath)) {
      console.log('OnlyDM is not installed. Installing it now...');
      const installStatus = runPowerShell(bootstrapScriptPath, []);
      if (installStatus !== 0) {
        process.exit(installStatus);
      }
    }
  }

  let scriptPath;
  let args = [];
  if (command === 'install' || command === 'update') {
    if (appPath && fs.existsSync(appPath) && fs.existsSync(dispatcherPath)) {
      scriptPath = dispatcherPath;
      args = ['-Command', command];
    } else {
      scriptPath = path.resolve(__dirname, '..', 'install.ps1');
    }
  } else if (command === 'uninstall') {
    scriptPath = path.resolve(__dirname, '..', 'uninstall.ps1');
  } else {
    scriptPath = dispatcherPath;
    args = ['-Command', command];
  }

  process.exit(runPowerShell(scriptPath, args));
}

if (process.platform === 'win32') {
  runWindows();
} else {
  require('./posix.cjs').run(command).then(code => {
    process.exitCode = code;
  }, error => {
    console.error(`OnlyDM: ${error.message}`);
    process.exitCode = Number.isInteger(error.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
  });
}

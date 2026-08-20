#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const command = (process.argv[2] || 'install').toLowerCase();
const allowed = new Set(['install', 'update', 'uninstall', 'start', 'stop', 'restart', 'status', 'on', 'off', 'help']);

function printHelp() {
  console.log(`OnlyDM ${pkg.version}\n\nInstall:\n  npm install -g @thisnorm/onlydm\n  odm start\n\nAfter installation:\n  odm start|stop|restart|status|on|off|update|uninstall`);
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
if (process.platform !== 'win32') {
  console.error('OnlyDM is a Windows application. Run this command on Windows 10 or 11.');
  process.exit(1);
}

function runPowerShell(scriptPath, args) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...args],
    { stdio: 'inherit', windowsHide: false }
  );

  if (result.error) {
    console.error(`Failed to start PowerShell: ${result.error.message}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

if (command === 'start') {
  const appPath = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs', 'OnlyDM', 'OnlyDM.exe')
    : '';
  const bootstrapScriptPath = path.resolve(__dirname, '..', 'install.ps1');
  if (appPath && !fs.existsSync(appPath) && fs.existsSync(bootstrapScriptPath)) {
    console.log('OnlyDM is not installed. Installing it now...');
    const installStatus = runPowerShell(bootstrapScriptPath, ['-ReleaseTag', 'v' + pkg.version]);
    if (installStatus !== 0) {
      process.exit(installStatus);
    }
  }
}

let scriptPath;
let args = [];
if (command === 'install' || command === 'update') {
  scriptPath = path.resolve(__dirname, '..', 'install.ps1');
  args = ['-ReleaseTag', 'v' + pkg.version];
} else if (command === 'uninstall') {
  scriptPath = path.resolve(__dirname, '..', 'uninstall.ps1');
} else {
  scriptPath = path.resolve(__dirname, 'odm.ps1');
  args = ['-Command', command];
}

process.exit(runPowerShell(scriptPath, args));

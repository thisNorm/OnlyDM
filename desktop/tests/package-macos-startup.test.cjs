'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

async function connectInspector(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('Inspector connection timed out.')); }, 5_000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Inspector connection failed.')); }, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const reply = JSON.parse(data);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    clearTimeout(request.timer);
    if (reply.error) request.reject(new Error(reply.error.message));
    else request.resolve(reply.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('Inspector disconnected.'));
    }
    pending.clear();
  });
  async function evaluate(expression) {
    const id = ++sequence;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector evaluation timed out.')); }, 5_000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  return { socket, evaluate };
}

test('packaged macOS app opens its real shell using an isolated clean profile', {
  skip: process.platform !== 'darwin' || !process.env.ONLYDM_PACKAGED_APP
    ? 'Requires the packaged .app on a macOS runner; exercised after package:mac in desktop CI.' : false,
  timeout: 40_000,
}, async (t) => {
  const expectedArch = process.env.ONLYDM_EXPECTED_ARCH;
  assert.ok(['arm64', 'x64'].includes(expectedArch));
  assert.equal(process.arch, expectedArch, 'runner Node and packaged app must have the same native architecture');
  const appDir = fs.realpathSync(process.env.ONLYDM_PACKAGED_APP);
  const dist = fs.realpathSync(path.join(__dirname, '../dist'));
  const relative = path.relative(dist, appDir);
  assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'only start a bundle from managed dist');
  assert.equal(path.basename(appDir), 'OnlyDM.app');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onlydm-package-startup-')));
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  assert.deepEqual(fs.readdirSync(profile), []);
  let inspector;
  const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(appDir, 'Contents/MacOS/OnlyDM'), [
    '--inspect=127.0.0.1:0', `--user-data-dir=${profile}`, '--disable-background-networking',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND',
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let spawnError;
  child.on('error', error => { spawnError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-64_000); });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  t.after(async () => {
    inspector?.socket.close();
    if (child.exitCode === null && child.signalCode === null && !spawnError) child.kill('SIGTERM');
    await Promise.race([exited, delay(2_000)]);
    if (child.exitCode === null && child.signalCode === null && !spawnError) {
      child.kill('SIGKILL');
      await Promise.race([exited, delay(2_000)]);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function waitFor(label, probe) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      assert.equal(child.exitCode, null, `app exited during ${label}: ${output}`);
      assert.equal(child.signalCode, null, `app crashed during ${label}: ${output}`);
      const value = await probe();
      if (value) return value;
      await delay(100, undefined, { signal: t.signal });
    }
    throw new Error(`Timed out during ${label}: ${output}`);
  }
  const endpoint = await waitFor('main-process inspector startup', () =>
    output.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1]);
  inspector = await connectInspector(endpoint);
  const state = await waitFor('packaged shell startup', async () => {
    const snapshot = await inspector.evaluate(`(() => {
      const { app, BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      return { name: app.getName(), packaged: app.isPackaged, arch: process.arch,
        userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
          visible: window.isVisible(), loading: window.webContents.isLoadingMainFrame(), url: window.webContents.getURL()
        })) };
    })()`);
    return snapshot.windows.some(window => window.visible && !window.loading && window.url.endsWith('/src/shell.html')) && snapshot;
  });
  assert.equal(state.name, 'OnlyDM');
  assert.equal(state.packaged, true);
  assert.equal(state.arch, expectedArch);
  assert.equal(fs.realpathSync(state.userData), fs.realpathSync(profile), 'the app must use the isolated profile');
  assert.equal(state.windows.length, 1, 'startup must create one shell');
  assert.ok(fs.readdirSync(profile).length > 0, 'Chromium must initialize the fresh profile');
  console.log(`Verified packaged startup: OnlyDM, ${state.arch}, one visible shell, clean isolated profile; external DNS blocked.`);
  await inspector.evaluate("(() => { setTimeout(() => process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit(), 100); return true; })()");
  inspector.socket.close();
  await Promise.race([exited, delay(3_000)]);
  assert.equal(child.exitCode, 0, `app must quit cleanly: ${output}`);
});

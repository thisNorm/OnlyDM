'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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
  timeout: process.env.ONLYDM_TEST_NATIVE_NOTIFICATIONS === '1' ? 60_000 : 40_000,
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
    ...(process.env.ONLYDM_FIXTURE_SOFTWARE_RENDERING === '1' ? ['--disable-gpu'] : []),
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
      if (!app?.isReady?.() || typeof BrowserWindow?.getAllWindows !== 'function') return null;
      return { name: app.getName(), packaged: app.isPackaged, arch: process.arch,
        userData: app.getPath('userData'), windows: BrowserWindow.getAllWindows().map(window => ({
          visible: window.isVisible(), loading: window.webContents.isLoadingMainFrame(), url: window.webContents.getURL()
        })) };
    })()`);
    return snapshot?.windows.some(window => window.visible && !window.loading && window.url.endsWith('/src/shell.html')) && snapshot;
  });
  assert.equal(state.name, 'OnlyDM');
  assert.equal(state.packaged, true);
  assert.equal(state.arch, expectedArch);
  assert.equal(fs.realpathSync(state.userData), fs.realpathSync(profile), 'the app must use the isolated profile');
  assert.equal(state.windows.length, 1, 'startup must create one shell');
  assert.ok(fs.readdirSync(profile).length > 0, 'Chromium must initialize the fresh profile');
  console.log(`Verified packaged startup: OnlyDM, ${state.arch}, one visible shell, clean isolated profile; external DNS blocked.`);
  if (process.env.ONLYDM_TEST_NATIVE_NOTIFICATIONS === '1') {
    const hidden = await inspector.evaluate(`(() => {
      const { BrowserWindow, Notification } = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
      const window = BrowserWindow.getAllWindows()[0];
      window.close();
      const result = { supported: Notification.isSupported(), outcome: 'pending' };
      globalThis.__onlydmNativeNotificationProbe = { result };
      if (!result.supported) result.outcome = 'unsupported';
      else {
        const notification = new Notification({ title: 'OnlyDM notification test', body: 'Synthetic local notification. No Instagram account is used.' });
        globalThis.__onlydmNativeNotificationProbe.notification = notification;
        notification.once('show', () => { result.outcome = 'shown'; });
        notification.once('failed', (_event, error) => { result.outcome = 'failed'; result.error = String(error); });
        notification.show();
      }
      return { windows: BrowserWindow.getAllWindows().length, hidden: !window.isVisible(), destroyed: window.isDestroyed() };
    })()`);
    assert.deepEqual(hidden, { windows: 1, hidden: true, destroyed: false }, 'closing the packaged Mac window must keep the app in the Dock');
    let result;
    try {
      result = await waitFor('native notification show/failed event', async () => {
        const current = await inspector.evaluate('globalThis.__onlydmNativeNotificationProbe.result');
        return current.outcome !== 'pending' && current;
      });
    } finally {
      const report = await inspector.evaluate('globalThis.__onlydmNativeNotificationProbe.result');
      // Capture only disposable GitHub-hosted desktops, never a developer's personal screen.
      if (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted') {
        await delay(1_500, undefined, { signal: t.signal });
        const screenshot = `OnlyDM-mac-${expectedArch}-notification.png`;
        const capture = spawnSync('/usr/sbin/screencapture', ['-x', path.join(dist, screenshot)], {
          encoding: 'utf8', timeout: 5_000,
        });
        if (capture.status === 0 && fs.existsSync(path.join(dist, screenshot))) report.screenshot = screenshot;
        else report.screenshotError = capture.error?.message || capture.stderr?.trim() || `exit ${capture.status}`;
      }
      await inspector.evaluate('globalThis.__onlydmNativeNotificationProbe.notification?.close(); true');
      fs.writeFileSync(path.join(dist, `OnlyDM-mac-${expectedArch}-notification.json`), JSON.stringify({
        arch: expectedArch, ...report,
        scope: 'Packaged app native API event; not a visual banner check or real Instagram DM delivery.',
      }, null, 2) + '\n');
      console.log('Packaged native notification result: ' + JSON.stringify(report));
    }
    assert.equal(result.outcome, 'shown', 'macOS must report the native notification as shown; allow OnlyDM notifications before testing');
    await inspector.evaluate("(() => { process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.emit('activate'); return true; })()");
    await waitFor('Dock activation restores the packaged window', () => inspector.evaluate(`(() => {
      const windows = process.getBuiltinModule('module').createRequire(process.execPath)('electron').BrowserWindow.getAllWindows();
      return windows.length === 1 && windows[0].isVisible();
    })()`));
    console.log('Verified native notification show event while hidden, and Dock activation restores one window.');
  }
  await inspector.evaluate("(() => { setTimeout(() => process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit(), 100); return true; })()");
  inspector.socket.close();
  await Promise.race([exited, delay(3_000)]);
  assert.equal(child.exitCode, 0, `app must quit cleanly: ${output}`);
});

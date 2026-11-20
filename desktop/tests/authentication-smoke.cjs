'use strict';

require('./fixture-runtime.cjs');

const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, session } = require('electron');
const { createOnlyDM, PARTITION } = require('../src/app.cjs');

const profile = mkdtempSync(join(tmpdir(), 'onlydm-authentication-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-background-networking');
app.once('quit', () => {
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold files. */ }
});

const origin = 'https://www.instagram.com';
const loginPath = '/accounts/login/';
const platformPath = '/auth_platform/';
const codePath = '/auth_platform/codeentry/';
const inboxPath = '/direct/inbox/';
const dummyCode = 'not-a-real-code';
const titles = ['Synthetic conversation 1', 'Synthetic conversation 2', 'Synthetic conversation 3'];
const avatar = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const requests = [];
let fixtureSession;
let completed = false;
let invalidSubmissions = 0;
let completionSubmissions = 0;
let phase = 'starting Electron';
let diagnosticContents;

function html(body) {
  return new Response('<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,">' + body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function codeForm(invalid = false) {
  return `<form id="fixture-code-form" action="${codePath}" method="post">
    <label for="fixture-code">Synthetic verification field</label>
    <input id="fixture-code" name="dummy_code" autocomplete="one-time-code">
    <button id="fixture-submit">Submit dummy value</button>
    <p id="fixture-invalid" role="alert">${invalid ? 'Invalid synthetic code' : ''}</p>
  </form>
  <form id="fixture-completion-form" action="${codePath}?complete=1" method="post">
    <button id="fixture-complete">Complete synthetic authentication</button>
  </form>`;
}

function inboxPage() {
  return '<main id="fixture-inbox-source">' + titles.map((title, index) =>
    `<div role="button" tabindex="0" style="width:280px;height:64px">
      <img width="40" height="40" src="${avatar}" alt="">
      <a href="/direct/t/${101 + index}/"><span title="${title}">${title}</span></a>
      <span>Synthetic preview ${index + 1}</span>
    </div>`).join('') + '</main>' + codeForm() + `<script>
      window.fixtureOriginalForm = document.querySelector('#fixture-code-form');
      window.fixtureOriginalForm.addEventListener('submit', event => {
        event.preventDefault();
        window.fixtureOriginalForm.dataset.submitted = 'true';
        document.querySelector('#fixture-invalid').textContent = 'Invalid synthetic code';
      });
      document.querySelector('#fixture-completion-form').addEventListener('submit', event => {
        event.preventDefault();
        history.pushState({}, '', '/');
      });
    </script>`;
}

app.on('session-created', created => {
  const isFixture = basename(created.storagePath || '').toLowerCase() === 'onlydm-instagram';
  created.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, ({ url }, respond) => {
    respond({ cancel: !isFixture || new URL(url).origin !== origin });
  });
  if (!isFixture) return;
  fixtureSession = created;
  created.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.origin !== origin) return new Response('', { status: 403 });
    requests.push({ method: request.method, path: url.pathname });
    if (url.pathname === inboxPath) {
      return completed ? html(inboxPage()) : Response.redirect(origin + loginPath, 302);
    }
    if (url.pathname === loginPath) {
      return request.method === 'POST' ? Response.redirect(origin + platformPath, 303)
        : html(`<form action="${loginPath}" method="post"><button id="fixture-sign-in">Synthetic sign in</button></form>`);
    }
    if (url.pathname === platformPath) {
      return html(`<form action="${codePath}"><button id="fixture-code-entry">Synthetic code entry</button></form>`);
    }
    if (url.pathname === codePath) {
      if (request.method === 'POST' && url.searchParams.get('complete') === '1') {
        completionSubmissions++;
        completed = true;
        return Response.redirect(origin + '/', 303);
      }
      if (request.method === 'POST') {
        const fields = new URLSearchParams(await request.text());
        assert.equal(fields.get('dummy_code'), dummyCode, 'only the synthetic invalid value is submitted');
        invalidSubmissions++;
      }
      return html(codeForm(request.method === 'POST'));
    }
    return new Response('', { status: 404 });
  });
});

async function waitFor(label, probe) {
  phase = label;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await delay(50);
  }
  throw new Error('Timed out: ' + label);
}

function atPath(controller, path) {
  const view = controller.inbox;
  const url = new URL(view.webContents.getURL() || origin);
  return view.getVisible() && !view.webContents.isLoadingMainFrame()
    && url.origin === origin && url.pathname === path;
}

async function formVisible(contents, selector) {
  return contents.executeJavaScript(`(() => {
    const form = document.querySelector(${JSON.stringify(selector)});
    const input = form?.querySelector('input, button');
    if (!input || document.querySelector('#OnlyDmShell')) return false;
    const rect = input.getBoundingClientRect();
    return getComputedStyle(input).visibility === 'visible' && rect.width > 0 && rect.height > 0
      && document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) === input;
  })()`);
}

async function submitWithEnter(contents, window) {
  // A focused view can still belong to an inactive app on the macOS runner.
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
  contents.focus();
  await contents.executeJavaScript("document.querySelector('#fixture-code').focus()");
  await waitFor('the authentication input is focused', () => window.isFocused() && contents.isFocused()
    && contents.executeJavaScript("document.hasFocus() && document.activeElement?.id === 'fixture-code'"));
  await contents.insertText(dummyCode);
  assert.ok(await contents.executeJavaScript(
    `document.querySelector('#fixture-code').value === ${JSON.stringify(dummyCode)}`),
  'the synthetic value must reach the original input before Enter');
  await contents.executeJavaScript(`(() => {
    window.fixtureKeyEvents = [];
    for (const type of ['keydown', 'keypress', 'keyup', 'submit']) {
      document.addEventListener(type, event => queueMicrotask(() => {
        window.fixtureKeyEvents.push({ type, key: event.key, trusted: event.isTrusted, prevented: event.defaultPrevented });
      }), { capture: true });
    }
  })()`);
  // Trusted Chromium key events exercise native form submission under Xvfb.
  contents.debugger.attach();
  try {
    const before = invalidSubmissions;
    const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, location: 0 };
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown', ...key, text: '\r', unmodifiedText: '\r', autoRepeat: false, isKeypad: false, commands: [],
    });
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
    // Keep the input channel attached until the browser has processed the submission.
    await waitFor('native Enter reaches the form', () => invalidSubmissions > before
      || contents.executeJavaScript("window.fixtureOriginalForm?.dataset.submitted === 'true'"));
  } finally {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  }
}

async function exercise() {
  await app.whenReady();
  const controller = await createOnlyDM({ openExternal: () => assert.fail('the fixture must not open a browser') });
  const contents = controller.inbox.webContents;
  diagnosticContents = contents;
  assert.equal(contents.session, fixtureSession);
  assert.equal(contents.session, session.fromPartition(PARTITION));
  assert.equal(app.getPath('userData'), profile);
  const inPagePaths = [];
  let documentNavigations = 0;
  contents.on('did-navigate', () => documentNavigations++);
  contents.on('did-navigate-in-page', (_event, url, mainFrame) => {
    if (mainFrame) inPagePaths.push(new URL(url).pathname);
  });

  await waitFor('login form', () => atPath(controller, loginPath) && formVisible(contents, 'form'));
  await contents.executeJavaScript("document.querySelector('#fixture-sign-in').click()");
  await waitFor('auth platform form', () => atPath(controller, platformPath) && formVisible(contents, 'form'));
  await contents.executeJavaScript("document.querySelector('#fixture-code-entry').click()");
  await waitFor('code entry form', () => atPath(controller, codePath) && formVisible(contents, '#fixture-code-form'));
  await submitWithEnter(contents, controller.window);
  await waitFor('invalid Enter submission stays on code entry', async () => invalidSubmissions === 1
    && atPath(controller, codePath) && await formVisible(contents, '#fixture-code-form')
    && contents.executeJavaScript("document.querySelector('#fixture-invalid').textContent === 'Invalid synthetic code'"));
  assert.equal(completed, false);

  const projected = () => atPath(controller, inboxPath) && contents.executeJavaScript(`
    JSON.stringify(Array.from(document.querySelectorAll('#OnlyDmShell .onlydm-thread-title'), node => node.textContent))
      === ${JSON.stringify(JSON.stringify(titles))}`);
  await contents.executeJavaScript("document.querySelector('#fixture-complete').click()");
  await waitFor('full-document root completion projects three conversations', projected);
  assert.equal(completionSubmissions, 1);
  assert.ok(requests.some(request => request.method === 'POST' && request.path === loginPath));
  assert.ok(await contents.executeJavaScript("window.fixtureOriginalForm.classList.contains('onlydm-source-hidden')"),
    'the original form starts behind the projected inbox');

  const beforeAuthentication = documentNavigations;
  await contents.executeJavaScript(`history.pushState({}, '', ${JSON.stringify(codePath)})`);
  await waitFor('same-document authentication restores the original form', async () => atPath(controller, codePath)
    && await formVisible(contents, '#fixture-code-form') && contents.executeJavaScript(`
      window.fixtureOriginalForm === document.querySelector('#fixture-code-form')
      && !document.querySelector('#OnlyDmShell, #onlydm-inbox-style, #onlydm-account-style')
      && !document.querySelector('.onlydm-source-hidden, .onlydm-account-hidden')`));
  assert.equal(documentNavigations, beforeAuthentication, 'authentication keeps the original document');
  assert.ok(inPagePaths.includes(codePath));
  await submitWithEnter(contents, controller.window);
  await waitFor('restored form retains native Enter submission', () => atPath(controller, codePath)
    && contents.executeJavaScript("window.fixtureOriginalForm.dataset.submitted === 'true' && !document.querySelector('#OnlyDmShell')"));
  assert.equal(documentNavigations, beforeAuthentication);
  assert.equal(invalidSubmissions, 1, 'the restored form handles its own same-document submit');

  await contents.executeJavaScript("document.querySelector('#fixture-complete').click()");
  await waitFor('same-document root completion projects three conversations', projected);
  assert.ok(inPagePaths.includes('/'), 'completion visited the root in the same document');
  assert.equal(requests.filter(request => request.path === inboxPath).length, 3);
  assert.equal(requests.filter(request => request.path === '/').length, 0, 'neither completion loads a root document');
  controller.window.close();
}

let finished = false;
const timeout = setTimeout(() => finish(new Error('overall authentication smoke timeout')), 45000);
async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  if (error) {
    console.error(`OnlyDM authentication smoke failed (${phase}): ${error.message}`);
    try {
      const dom = await diagnosticContents.executeJavaScript(`({
        path: location.pathname, focused: document.hasFocus(), active: document.activeElement?.id,
        inputLength: document.querySelector('#fixture-code')?.value.length,
        invalid: document.querySelector('#fixture-invalid')?.textContent,
        keys: window.fixtureKeyEvents || []
      })`);
      console.error(JSON.stringify({ dom, invalidSubmissions, requests }));
    } catch { /* The renderer may already have closed. */ }
  }
  else console.log('OnlyDM authentication smoke passed: login/auth_platform/codeentry, invalid dummy Enter, root completion, three conversations, original form restoration, and same-document root completion.');
  app.exit(error ? 1 : 0);
}
exercise().then(() => finish(), finish);

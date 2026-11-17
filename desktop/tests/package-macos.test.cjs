'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  parseArguments, createWorkspace, removeWorkspace, stageApplication,
  packagerOptions, previewMetadata, outputPaths, checksumLine, createDmg,
} = require('../scripts/package-macos.cjs');

const projections = [
  'inbox-ko-light.js', 'inbox-ko-dark.js', 'inbox-en-light.js', 'inbox-en-dark.js',
  'chat-light.js', 'chat-dark.js', 'notify.js',
];

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'onlydm-package-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const desktop = path.join(root, 'desktop');
  function write(file, contents) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  write(path.join(desktop, 'package.json'), JSON.stringify({
    name: 'onlydm-linux', productName: 'OnlyDM', version: '0.1.0-beta.7', main: 'src/main.cjs',
    license: 'MIT', scripts: { start: 'electron .' }, devDependencies: { electron: '45.3.1' },
  }));
  write(path.join(desktop, 'src/main.cjs'), 'require("./nested/lifecycle.cjs");');
  write(path.join(desktop, 'src/nested/lifecycle.cjs'), 'module.exports = {};');
  write(path.join(desktop, 'src/shell.html'), '<!doctype html><title>OnlyDM</title>');
  write(path.join(desktop, 'src/shell.js'), 'console.log("fixture");');
  write(path.join(desktop, 'src/shell.css'), 'body { margin: 0; }');
  write(path.join(desktop, 'src/.env'), 'PRIVATE=fixture');
  write(path.join(desktop, 'src/debug.log'), 'fixture log');
  write(path.join(desktop, 'tests/session.json'), 'fixture profile');
  write(path.join(desktop, 'node_modules/private/index.js'), 'fixture dependency');
  for (const name of projections) write(path.join(desktop, 'generated', name), '// projection');
  write(path.join(desktop, 'generated/unrelated.js'), '// not a runtime projection');
  write(path.join(root, 'LICENSE'), 'MIT fixture license');
  write(path.join(root, 'src/OnlyDM/Assets/OnlyDM.png'), 'fixture PNG');
  return { root, desktop };
}

test('architecture arguments accept both native targets and reject paths or unknown flags', () => {
  assert.equal(parseArguments(['--arch', 'arm64']).arch, 'arm64');
  assert.equal(parseArguments(['--arch=x64']).arch, 'x64');
  for (const args of [['--arch', '../../escape'], ['--arch', 'universal'], ['--sign'], ['--arch']]) {
    assert.throws(() => parseArguments(args));
  }
});

test('staging includes runtime files and every projection without build tools, profiles or secrets', (t) => {
  const { desktop } = fixture(t);
  const work = createWorkspace(desktop);
  const staged = stageApplication(desktop, work);
  assert.deepEqual(fs.readdirSync(staged.appDir).sort(), ['LICENSE', 'generated', 'package.json', 'src']);
  assert.deepEqual(fs.readdirSync(path.join(staged.appDir, 'generated')).sort(), [...projections].sort());
  assert.deepEqual(fs.readdirSync(path.join(staged.appDir, 'src')).sort(),
    ['main.cjs', 'nested', 'shell.css', 'shell.html', 'shell.js']);
  assert.equal(fs.readFileSync(path.join(staged.appDir, 'src/nested/lifecycle.cjs'), 'utf8'), 'module.exports = {};');
  const manifest = JSON.parse(fs.readFileSync(path.join(staged.appDir, 'package.json'), 'utf8'));
  assert.equal(manifest.productName, 'OnlyDM');
  assert.equal(manifest.main, 'src/main.cjs');
  assert.equal(manifest.version, '0.1.0-beta.7');
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(fs.readFileSync(path.join(staged.appDir, 'LICENSE'), 'utf8'), 'MIT fixture license');
  removeWorkspace(desktop, work);
  assert.equal(fs.existsSync(work), false);
});

test('incomplete projection export cannot produce a staged app', (t) => {
  const { desktop } = fixture(t);
  fs.unlinkSync(path.join(desktop, 'generated/notify.js'));
  const work = createWorkspace(desktop);
  assert.throws(() => stageApplication(desktop, work), /notify\.js|npm run build/);
});

test('staging rejects symlinked source directories instead of copying external data', (t) => {
  const { root, desktop } = fixture(t);
  const external = path.join(root, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'credentials.js'), 'private fixture');
  fs.symlinkSync(external, path.join(desktop, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const work = createWorkspace(desktop);
  assert.throws(() => stageApplication(desktop, work), /symbolic|symlink|outside/i);
});

test('a redirected dist cannot receive package writes or cleanup', (t) => {
  const { root, desktop } = fixture(t);
  const external = path.join(root, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep'), 'preserve');
  fs.symlinkSync(external, path.join(desktop, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => createWorkspace(desktop), /symbolic|symlink|outside/i);
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'preserve');
});

test('cleanup and staging reject paths that are not a managed workspace', (t) => {
  const { desktop } = fixture(t);
  const work = createWorkspace(desktop);
  for (const unsafe of [desktop, path.dirname(work), path.join(desktop, 'src')]) {
    assert.throws(() => removeWorkspace(desktop, unsafe), /managed|workspace/i);
    assert.throws(() => stageApplication(desktop, unsafe), /managed|workspace/i);
  }
  assert.ok(fs.existsSync(path.join(desktop, 'src/main.cjs')));
});

test('existing output is preserved and a path-valued architecture never reaches dist', (t) => {
  const { desktop } = fixture(t);
  createWorkspace(desktop);
  const paths = outputPaths(desktop, 'x64');
  assert.equal(path.basename(paths.dmg), 'OnlyDM-mac-x64.dmg');
  assert.equal(path.basename(paths.checksum), 'OnlyDM-mac-x64.dmg.sha256');
  assert.equal(path.basename(paths.app), 'OnlyDM.app');
  fs.writeFileSync(paths.dmg, 'previous build');
  assert.throws(() => outputPaths(desktop, 'x64'), /exist|overwrite/i);
  assert.equal(fs.readFileSync(paths.dmg, 'utf8'), 'previous build');
  assert.throws(() => outputPaths(desktop, '../outside'), /architecture/i);
});

test('packager receives only managed staging, native icon and fail-closed ad-hoc signing', (t) => {
  const { desktop } = fixture(t);
  const work = createWorkspace(desktop);
  const staged = stageApplication(desktop, work);
  const options = packagerOptions(staged, work, 'arm64');
  assert.equal(options.dir, staged.appDir);
  assert.equal(options.platform, 'darwin');
  assert.equal(options.arch, 'arm64');
  assert.equal(options.name, 'OnlyDM');
  assert.equal(options.appBundleId, 'org.thisnorm.onlydm');
  assert.equal(path.extname(options.icon), '.icns');
  assert.equal(options.osxSign.identity, '-');
  assert.equal(options.osxSign.identityValidation, false);
  assert.equal(options.osxSign.continueOnError, false);
  assert.equal(options.osxSign.preAutoEntitlements, false);
  assert.equal(options.osxSign.optionsForFile('anything').hardenedRuntime, false);
  assert.equal(options.osxNotarize, undefined);
  assert.equal(path.dirname(options.out), work);
  assert.equal(path.dirname(options.tmpdir), work);
  assert.throws(() => packagerOptions(staged, work, '../../elsewhere'), /architecture/i);
});

test('preview metadata never presents ad-hoc signatures as Developer ID or notarization', () => {
  const metadata = previewMetadata({ version: '0.1.0-beta.7', devDependencies: { electron: '45.3.1' } }, 'x64');
  assert.equal(metadata.preview, true);
  assert.equal(metadata.arch, 'x64');
  assert.equal(metadata.bundleIdentifier, 'org.thisnorm.onlydm');
  assert.equal(metadata.signing.status, 'ad-hoc');
  assert.equal(metadata.signing.target, 'app');
  assert.equal(metadata.signing.developerId, false);
  assert.equal(metadata.diskImage.signing, 'unsigned');
  assert.equal(metadata.diskImage.filename, 'OnlyDM-mac-x64.dmg');
  assert.equal(metadata.notarization.status, 'not-notarized');
  assert.match(metadata.notarization.reason, /credential|preview/i);
});

test('checksum sidecars contain the DMG filename and the real SHA256', async (t) => {
  const { desktop } = fixture(t);
  createWorkspace(desktop);
  const { dmg } = outputPaths(desktop, 'arm64');
  fs.writeFileSync(dmg, 'abc');
  assert.equal(await checksumLine(dmg),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  OnlyDM-mac-arm64.dmg\n');
});

test('hdiutil create retries one transient Resource busy after clearing only its partial DMG', async (t) => {
  const { desktop } = fixture(t);
  const work = createWorkspace(desktop);
  const image = path.join(work, 'image');
  fs.mkdirSync(image);
  fs.writeFileSync(path.join(image, 'keep'), 'source app');
  const published = outputPaths(desktop, 'x64').dmg;
  fs.writeFileSync(published, 'published build');
  fs.writeFileSync(path.join(work, 'unrelated.dmg'), 'keep');
  const dmg = path.join(work, 'OnlyDM-mac-x64.dmg');
  const events = [];
  const result = await createDmg(desktop, work, 'x64', (command, args, timeout) => {
    assert.equal(command, '/usr/bin/hdiutil');
    assert.deepEqual(args, ['create', '-volname', 'OnlyDM', '-fs', 'HFS+', '-format', 'UDZO', '-srcfolder', image, dmg]);
    assert.equal(timeout, 300_000);
    assert.equal(fs.existsSync(dmg), false, 'each attempt must start without a previous DMG');
    events.push('create');
    if (events.length === 1) {
      fs.writeFileSync(dmg, 'partial image');
      throw new Error('/usr/bin/hdiutil failed (1):\nhdiutil: create failed - Resource busy\n');
    }
    fs.writeFileSync(dmg, 'complete image');
  }, async milliseconds => {
    assert.equal(milliseconds, 2_000);
    assert.equal(fs.existsSync(dmg), false, 'clear the partial image before waiting');
    events.push('delay');
  });
  assert.deepEqual(events, ['create', 'delay', 'create']);
  assert.equal(result, dmg);
  assert.equal(fs.readFileSync(dmg, 'utf8'), 'complete image');
  assert.equal(fs.readFileSync(published, 'utf8'), 'published build');
  assert.equal(fs.readFileSync(path.join(work, 'unrelated.dmg'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(image, 'keep'), 'utf8'), 'source app');
});

test('a second Resource busy propagates without a third attempt or delay', async (t) => {
  const { desktop } = fixture(t);
  const work = createWorkspace(desktop);
  fs.mkdirSync(path.join(work, 'image'));
  const dmg = path.join(work, 'OnlyDM-mac-arm64.dmg');
  const first = new Error('hdiutil: create failed - Resource busy');
  const second = new Error('hdiutil: create failed - Resource busy');
  let attempts = 0;
  let waits = 0;
  await assert.rejects(createDmg(desktop, work, 'arm64', () => {
    attempts++;
    assert.equal(fs.existsSync(dmg), false);
    fs.writeFileSync(dmg, `partial ${attempts}`);
    throw attempts === 1 ? first : second;
  }, async () => { waits++; }), error => error === second);
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
  assert.equal(fs.readFileSync(dmg, 'utf8'), 'partial 2');
});

test('non-busy hdiutil errors propagate immediately without retry, delay or partial cleanup', async (t) => {
  const { desktop } = fixture(t);
  const work = createWorkspace(desktop);
  fs.mkdirSync(path.join(work, 'image'));
  const dmg = path.join(work, 'OnlyDM-mac-x64.dmg');
  const failure = new Error('hdiutil: create failed - No space left on device');
  let attempts = 0;
  let waits = 0;
  await assert.rejects(createDmg(desktop, work, 'x64', () => {
    attempts++;
    fs.writeFileSync(dmg, 'partial image');
    throw failure;
  }, async () => { waits++; }), error => error === failure);
  assert.equal(attempts, 1);
  assert.equal(waits, 0);
  assert.equal(fs.readFileSync(dmg, 'utf8'), 'partial image');
});

test('DMG retry cleanup refuses unmanaged workspaces and redirected partial images', async (t) => {
  const { root, desktop } = fixture(t);
  const work = createWorkspace(desktop);
  fs.mkdirSync(path.join(work, 'image'));
  const external = path.join(root, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'keep'), 'external data');
  const dmg = path.join(work, 'OnlyDM-mac-x64.dmg');
  let attempts = 0;
  const run = () => {
    attempts++;
    fs.symlinkSync(external, dmg, process.platform === 'win32' ? 'junction' : 'dir');
    throw new Error('hdiutil: create failed - Resource busy');
  };
  const wait = async () => { assert.fail('unsafe cleanup must not reach the delay or retry'); };
  await assert.rejects(createDmg(desktop, path.join(desktop, 'dist'), 'x64', run, wait), /managed|workspace/i);
  assert.equal(attempts, 0);
  await assert.rejects(createDmg(desktop, work, 'x64', run, wait), /symbolic|symlink|partial/i);
  assert.equal(attempts, 1);
  assert.equal(fs.lstatSync(dmg).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(external, 'keep'), 'utf8'), 'external data');
});

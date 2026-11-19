'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs } = require('node:util');

const APP_NAME = 'OnlyDM';
const BUNDLE_ID = 'org.thisnorm.onlydm';
const PROJECTIONS = [
  'inbox-ko-light.js', 'inbox-ko-dark.js', 'inbox-en-light.js', 'inbox-en-dark.js',
  'chat-light.js', 'chat-dark.js', 'notify.js',
];
const PREVIEW = 'macOS PREVIEW: app ad-hoc signed; DMG unsigned; not Developer ID signed; NOT notarized. '
  + 'Signing/notarization credentials are not supported by this preview command.';

function validateArch(arch) {
  if (!['arm64', 'x64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}; use arm64 or x64.`);
  return arch;
}

function parseArguments(args) {
  const { values } = parseArgs({ args, options: { arch: { type: 'string' }, help: { type: 'boolean' } } });
  return { arch: validateArch(values.arch || process.arch), help: !!values.help };
}

function statIfPresent(file) {
  try { return fs.lstatSync(file); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function distDirectory(desktopDir) {
  const desktop = fs.realpathSync(desktopDir);
  const dist = path.join(desktop, 'dist');
  const stat = statIfPresent(dist);
  if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw new Error('dist must be a directory, not a symlink.');
  if (!stat) fs.mkdirSync(dist);
  if (fs.realpathSync(dist) !== dist) throw new Error('dist resolves outside the managed output directory.');
  return dist;
}

function assertWorkspace(desktopDir, workDir) {
  const work = path.resolve(workDir);
  if (path.dirname(work) !== distDirectory(desktopDir) || !/^\.package-macos-[a-zA-Z0-9]+$/.test(path.basename(work))) {
    throw new Error('Refusing to use a path outside a managed packaging workspace.');
  }
  const stat = fs.lstatSync(work);
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(work) !== work) {
    throw new Error('Managed workspace must not be a symlink.');
  }
  return work;
}

function createWorkspace(desktopDir) {
  return fs.mkdtempSync(path.join(distDirectory(desktopDir), '.package-macos-'));
}

function removeWorkspace(desktopDir, workDir) {
  fs.rmSync(assertWorkspace(desktopDir, workDir), { recursive: true, force: true });
}

function checkedInput(file, repository, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !inside(repository, fs.realpathSync(file))) {
    throw new Error(`Refusing symbolic link or input outside this repository: ${file}`);
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`Invalid package input: ${file}`);
  return file;
}

function copyRuntime(source, destination, repository) {
  checkedInput(source, repository, true);
  fs.mkdirSync(destination);
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Refusing symbolic link in runtime sources: ${from}`);
    if (entry.name.startsWith('.') || ['node_modules', 'tests', 'test', 'dist'].includes(entry.name)) continue;
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyRuntime(from, to, repository);
    else if (/\.(cjs|js|html|css)$/.test(entry.name)) fs.copyFileSync(checkedInput(from, repository), to);
  }
}

function stageApplication(desktopDir, workDir) {
  const desktop = fs.realpathSync(desktopDir);
  const work = assertWorkspace(desktop, workDir);
  const repository = fs.realpathSync(path.join(desktop, '..'));
  const manifest = JSON.parse(fs.readFileSync(checkedInput(path.join(desktop, 'package.json'), repository), 'utf8'));
  if (manifest.main !== 'src/main.cjs') throw new Error('Unexpected runtime entry point.');
  const license = checkedInput(path.join(repository, 'LICENSE'), repository);
  const png = checkedInput(path.join(repository, 'src/OnlyDM/Assets/OnlyDM.png'), repository);
  for (const name of PROJECTIONS) {
    try { checkedInput(path.join(desktop, 'generated', name), repository); } catch (error) {
      throw new Error(`Missing or unsafe generated/${name}; run npm run build first.`, { cause: error });
    }
  }
  const appDir = path.join(work, 'app');
  fs.mkdirSync(appDir);
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({
    name: 'onlydm', productName: APP_NAME, version: manifest.version,
    description: 'OnlyDM for macOS', main: manifest.main, private: true, license: manifest.license,
  }, null, 2) + '\n');
  fs.copyFileSync(license, path.join(appDir, 'LICENSE'));
  copyRuntime(path.join(desktop, 'src'), path.join(appDir, 'src'), repository);
  checkedInput(path.join(appDir, 'src/main.cjs'), repository);
  fs.mkdirSync(path.join(appDir, 'generated'));
  for (const name of PROJECTIONS) fs.copyFileSync(path.join(desktop, 'generated', name), path.join(appDir, 'generated', name));
  const stagedPng = path.join(work, 'OnlyDM.png');
  fs.copyFileSync(png, stagedPng);
  return { desktopDir: desktop, appDir, manifest, png: stagedPng };
}

function previewMetadata(manifest, arch) {
  return {
    schemaVersion: 1, appName: APP_NAME, bundleIdentifier: BUNDLE_ID,
    version: manifest.version, electronVersion: manifest.devDependencies.electron,
    platform: 'darwin', arch: validateArch(arch), preview: true,
    signing: { target: 'app', status: 'ad-hoc', identity: '-', developerId: false, hardenedRuntime: false },
    diskImage: { filename: `OnlyDM-mac-${arch}.dmg`, signing: 'unsigned' },
    notarization: { status: 'not-notarized', reason: 'This preview command does not support Apple signing/notarization credentials.' },
    notice: PREVIEW,
  };
}

function packagerOptions(staged, workDir, arch) {
  const work = assertWorkspace(staged.desktopDir, workDir);
  if (fs.realpathSync(staged.appDir) !== path.join(work, 'app')) throw new Error('App input must be managed staging.');
  return {
    dir: staged.appDir, out: path.join(work, 'packaged'), tmpdir: path.join(work, 'tmp'),
    name: APP_NAME, executableName: APP_NAME, appBundleId: BUNDLE_ID,
    platform: 'darwin', arch: validateArch(arch), electronVersion: staged.manifest.devDependencies.electron,
    appVersion: staged.manifest.version, buildVersion: staged.manifest.version.split('-')[0],
    icon: path.join(work, 'OnlyDM.icns'),
    extraResource: [staged.png, path.join(work, 'OnlyDM-mac-preview.json')],
    asar: false, prune: false, overwrite: false,
    osxSign: {
      identity: '-', identityValidation: false, continueOnError: false,
      preAutoEntitlements: false, preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        entitlements: path.join(work, 'preview-entitlements.plist'),
        hardenedRuntime: false, timestamp: 'none',
      }),
    },
    // Developer ID signing and osxNotarize require a separately reviewed credential workflow.
  };
}

function outputPaths(desktopDir, arch) {
  validateArch(arch);
  const dist = distDirectory(desktopDir);
  const base = `OnlyDM-mac-${arch}`;
  const bundleDir = path.join(dist, base);
  const paths = {
    bundleDir, app: path.join(bundleDir, 'OnlyDM.app'), dmg: path.join(dist, `${base}.dmg`),
    checksum: path.join(dist, `${base}.dmg.sha256`), metadata: path.join(dist, `${base}.json`),
  };
  for (const file of [bundleDir, paths.dmg, paths.checksum, paths.metadata]) {
    if (statIfPresent(file)) throw new Error(`Refusing to overwrite existing output: ${file}; move the previous build before retrying.`);
  }
  return paths;
}

function runTool(command, args, timeout = 60_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stdout}\n${result.stderr}`);
  return result.stdout + result.stderr;
}

async function createDmg(desktopDir, workDir, arch, run = runTool, wait = delay) {
  const work = assertWorkspace(desktopDir, workDir);
  const image = checkedInput(path.join(work, 'image'), work, true);
  const dmg = path.join(work, `OnlyDM-mac-${validateArch(arch)}.dmg`);
  if (statIfPresent(dmg)) throw new Error(`Refusing to overwrite existing workspace DMG: ${dmg}`);
  const args = ['create', '-volname', APP_NAME, '-fs', 'HFS+', '-format', 'UDZO', '-srcfolder', image, dmg];
  try {
    run('/usr/bin/hdiutil', args, 300_000);
  } catch (error) {
    if (!/\bhdiutil: create failed - Resource busy\b/.test(error?.message)) throw error;
    assertWorkspace(desktopDir, work);
    const partial = statIfPresent(dmg);
    if (partial) {
      if (partial.isSymbolicLink() || !partial.isFile() || fs.realpathSync(dmg) !== dmg) {
        throw new Error(`Refusing to clear an unsafe partial DMG: ${dmg}`);
      }
      fs.unlinkSync(dmg);
    }
    console.warn('hdiutil create reported Resource busy; retrying once in 2 seconds.');
    await wait(2_000);
    assertWorkspace(desktopDir, work);
    checkedInput(image, work, true);
    if (statIfPresent(dmg)) throw new Error(`Refusing to overwrite existing workspace DMG: ${dmg}`);
    run('/usr/bin/hdiutil', args, 300_000);
  }
  return dmg;
}

function createNativeIcon(png, work) {
  const iconset = path.join(work, 'OnlyDM.iconset');
  fs.mkdirSync(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      runTool('/usr/bin/sips', ['-z', pixels, pixels, png, '--out', path.join(iconset, name)]);
    }
  }
  runTool('/usr/bin/iconutil', ['--convert', 'icns', '--output', path.join(work, 'OnlyDM.icns'), iconset]);
}

function verifyBundle(appDir, arch, work) {
  const contents = path.join(appDir, 'Contents');
  const readPlist = (file, key) => runTool('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file]).trim();
  const info = path.join(contents, 'Info.plist');
  for (const [key, expected] of [['CFBundleIdentifier', BUNDLE_ID], ['CFBundleName', APP_NAME], ['CFBundleExecutable', APP_NAME]]) {
    if (readPlist(info, key) !== expected) throw new Error(`Incorrect bundle ${key}.`);
  }
  let iconName = readPlist(info, 'CFBundleIconFile');
  if (path.basename(iconName) !== iconName) throw new Error('Unsafe bundle icon path.');
  if (!iconName.endsWith('.icns')) iconName += '.icns';
  const resources = path.join(contents, 'Resources');
  const icon = path.join(resources, iconName);
  if (fs.readFileSync(icon).subarray(0, 4).toString() !== 'icns') throw new Error('Bundle icon is not native ICNS.');
  runTool('/usr/bin/iconutil', ['--convert', 'iconset', '--output', path.join(work, 'verified.iconset'), icon]);
  const app = path.join(resources, 'app');
  for (const file of ['LICENSE', 'src/main.cjs', 'src/app.cjs', 'src/shell.html', ...PROJECTIONS.map(name => `generated/${name}`)]) {
    if (!fs.statSync(path.join(app, file)).isFile()) throw new Error(`Missing packaged runtime file: ${file}`);
  }
  const metadata = JSON.parse(fs.readFileSync(path.join(resources, 'OnlyDM-mac-preview.json'), 'utf8'));
  if (!metadata.preview || metadata.signing.status !== 'ad-hoc' || metadata.notarization.status !== 'not-notarized') {
    throw new Error('Missing accurate preview metadata.');
  }
  if (!fs.readFileSync(path.join(resources, 'OnlyDM.png')).equals(fs.readFileSync(path.join(work, 'OnlyDM.png')))) {
    throw new Error('Packaged PNG differs from the repository icon.');
  }
  const frameworks = path.join(contents, 'Frameworks');
  const executables = [path.join(contents, 'MacOS/OnlyDM'), path.join(frameworks, 'Electron Framework.framework/Versions/A/Electron Framework')];
  for (const entry of fs.readdirSync(frameworks)) {
    if (!entry.endsWith('.app')) continue;
    const helper = path.join(frameworks, entry, 'Contents');
    executables.push(path.join(helper, 'MacOS', readPlist(path.join(helper, 'Info.plist'), 'CFBundleExecutable')));
  }
  const expectedArch = validateArch(arch) === 'x64' ? 'x86_64' : 'arm64';
  for (const executable of executables) {
    if (runTool('/usr/bin/lipo', ['-archs', executable]).trim() !== expectedArch) throw new Error(`Wrong architecture: ${executable}`);
  }
  runTool('/usr/bin/codesign', ['--verify', '--deep', '--strict', appDir]);
  const signature = runTool('/usr/bin/codesign', ['--display', '--verbose=4', appDir]);
  if (!/^Signature=adhoc$/m.test(signature) || /^Authority=/m.test(signature)) throw new Error('Expected a verified ad-hoc signature.');
  console.log(`Verified ${BUNDLE_ID}, native ICNS, runtime projections, ${expectedArch} executables and ad-hoc codesign.`);
}

async function checksumLine(dmg) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(dmg)) hash.update(chunk);
  return `${hash.digest('hex')}  ${path.basename(dmg)}\n`;
}

async function main(args = process.argv.slice(2)) {
  const { arch, help } = parseArguments(args);
  if (help) {
    console.log('Usage: npm run package:mac -- --arch arm64|x64\n' + PREVIEW);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('Run package:mac on macOS with Node >=22.12.0 after npm ci and npm run build.');
  console.log(PREVIEW);
  const desktop = fs.realpathSync(path.join(__dirname, '..'));
  const outputs = outputPaths(desktop, arch);
  const work = createWorkspace(desktop);
  try {
    const staged = stageApplication(desktop, work);
    const metadata = JSON.stringify(previewMetadata(staged.manifest, arch), null, 2) + '\n';
    fs.writeFileSync(path.join(work, 'OnlyDM-mac-preview.json'), metadata);
    fs.writeFileSync(path.join(work, 'preview-entitlements.plist'),
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
      + '"http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'
      + '<key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n');
    createNativeIcon(staged.png, work);
    const options = packagerOptions(staged, work, arch);
    fs.mkdirSync(options.tmpdir);
    const { packager } = await import('@electron/packager');
    const bundles = await packager(options);
    if (bundles.length !== 1 || !inside(path.join(work, 'packaged'), fs.realpathSync(bundles[0]))) {
      throw new Error('Packager returned an unexpected output directory.');
    }
    const appDir = path.join(bundles[0], 'OnlyDM.app');
    verifyBundle(appDir, arch, work);
    const image = path.join(work, 'image');
    fs.mkdirSync(image);
    const imageApp = path.join(image, 'OnlyDM.app');
    fs.renameSync(appDir, imageApp);
    fs.symlinkSync('/Applications', path.join(image, 'Applications'));
    fs.writeFileSync(path.join(image, 'OnlyDM-mac-preview.json'), metadata);
    const dmg = await createDmg(desktop, work, arch);
    runTool('/usr/bin/hdiutil', ['verify', dmg], 120_000);
    const checksum = await checksumLine(dmg);
    outputPaths(desktop, arch); // Recheck before publishing; never remove an earlier build.
    fs.mkdirSync(outputs.bundleDir);
    fs.renameSync(imageApp, outputs.app);
    fs.renameSync(dmg, outputs.dmg);
    fs.writeFileSync(outputs.checksum, checksum, { flag: 'wx' });
    fs.writeFileSync(outputs.metadata, metadata, { flag: 'wx' });
    console.log(`${PREVIEW}\nApp: ${outputs.app}\nDMG: ${outputs.dmg}\nSHA256: ${outputs.checksum}\nMetadata: ${outputs.metadata}`);
  } finally {
    removeWorkspace(desktop, work);
  }
}

module.exports = { parseArguments, createWorkspace, removeWorkspace, stageApplication, packagerOptions, previewMetadata, outputPaths, checksumLine, createDmg };

if (require.main === module) main().catch(error => {
  console.error(`package:mac: ${error.message}`);
  process.exitCode = 1;
});

'use strict';

// Pure Node 18+: shared by the desktop main process and the POSIX CLI.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const API = 'https://api.github.com/repos/thisNorm/OnlyDM/releases/latest';
const REPOSITORY = 'https://github.com/thisNorm/OnlyDM/releases/';
const PACKAGE_LIMIT = 512 * 1024 * 1024;
const CHECKSUM_LIMIT = 4096;
const JSON_LIMIT = 1024 * 1024;
const TIMEOUTS = { check: 12_000, download: 180_000, ready: 120_000 };

function versionParts(value) {
  if (typeof value !== 'string' || !/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) return null;
  const parts = value.replace(/^v/, '').split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function newer(candidate, current) {
  const left = versionParts(candidate);
  const right = versionParts(current);
  if (!left || !right) return false;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i];
  }
  return false;
}

function assetName(platform, arch) {
  if (platform === 'linux' && arch === 'x64') return 'OnlyDM-linux-x64.deb';
  if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) return `OnlyDM-mac-${arch}.dmg`;
  return null;
}

function validateRelease(value, name, normalized = false) {
  if (!value || typeof value !== 'object' || !name) return null;
  const tag = normalized ? value.tag : value.tag_name;
  if (typeof tag !== 'string' || !tag.startsWith('v') || !versionParts(tag)) return null;
  const url = `${REPOSITORY}tag/${tag}`;
  if (normalized ? value.url !== url || value.version !== tag.slice(1)
    : value.draft !== false || value.prerelease !== false || value.html_url !== url) return null;
  const assets = normalized ? [value.asset, value.checksum] : value.assets;
  if (!Array.isArray(assets) || assets.length > 512) return null;
  function select(filename, max) {
    const matches = assets.filter((item) => item && item.name === filename);
    if (matches.length !== 1) return null;
    const item = matches[0];
    const download = `${REPOSITORY}download/${tag}/${filename}`;
    if ((!normalized && item.state !== 'uploaded') || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > max
      || (normalized ? item.url : item.browser_download_url) !== download) return null;
    return Object.freeze({ name: filename, url: download, size: item.size });
  }
  const asset = select(name, PACKAGE_LIMIT);
  const checksum = select(name + '.sha256', CHECKSUM_LIMIT);
  return asset && checksum ? Object.freeze({ version: tag.slice(1), tag, url, asset, checksum }) : null;
}

async function deadline(milliseconds, operation) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error('Update request timed out.');
          controller.abort(error);
          reject(error);
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function trustedRedirect(location) {
  try {
    const url = new URL(location);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname);
  } catch { return false; }
}

async function responseFor(fetch, url, signal, asset = false) {
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(url, {
      signal, redirect: 'manual', credentials: 'omit',
      headers: { 'User-Agent': 'OnlyDM-Updater', Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!asset || redirects === 3 || !trustedRedirect(location)) throw new Error('Untrusted update redirect.');
      url = location;
      continue;
    }
    if (response.status !== 200 || !response.body) {
      await response.body?.cancel();
      throw new Error(`Update HTTP request failed (${response.status}).`);
    }
    return response;
  }
}

async function readBounded(response, limit, consume) {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > limit)) {
    await response.body.cancel();
    throw new Error('Update response exceeds size limit.');
  }
  const reader = response.body.getReader();
  let count = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > limit) throw new Error('Update response exceeds size limit.');
      await consume(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return count;
}

async function startStamp(platform) {
  if (platform === 'linux') {
    const value = await fs.promises.readFile(`/proc/${process.pid}/stat`, 'utf8');
    return value.slice(value.lastIndexOf(')') + 2).split(' ')[19];
  }
  const { stdout } = await promisify(execFile)('/bin/ps', ['-p', String(process.pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 3000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C' },
  });
  return stdout.trim();
}

function helperEnvironment() {
  const env = { ...process.env, LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
  for (const key of Object.keys(env)) {
    if (/^(BASH_FUNC_|DYLD_|LD_)/.test(key)
      || ['BASH_ENV', 'ENV', 'CDPATH', 'SHELLOPTS', 'BASHOPTS', 'NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(key)) delete env[key];
  }
  return env;
}

async function waitForHelper(child, work, token, foreground, timeouts) {
  let result;
  const onError = (error) => { result = { error }; };
  const onExit = (code, signal) => { result = { code, signal }; };
  child.once('error', onError);
  child.once('exit', onExit);
  const read = async (name) => {
    try {
      const file = path.join(work, name);
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Invalid helper status file.');
      return await fs.promises.readFile(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  let end = Date.now() + timeouts.ready;
  let readySeen = false;
  const accept = async () => {
    // Publish a complete token atomically; even a failed cancellation write
    // cannot authorize a helper after the caller has rejected.
    const pending = path.join(work, 'accepted.pending');
    await fs.promises.writeFile(pending, token, { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(pending, path.join(work, 'accepted'));
  };
  try {
    while (true) {
      const failed = await read('failed');
      if (failed !== null) throw new Error(`Update helper validation/installation failed: ${failed.slice(0, 1024)}`);
      const ready = await read('ready');
      if (ready !== null && ready !== token) throw new Error('Invalid update helper readiness token.');
      if (!readySeen && Date.now() >= end) throw new Error('Update helper readiness timed out.');
      if (foreground && ready !== null && !readySeen) {
        await accept();
        readySeen = true;
        // Native authorization is user-controlled. Never report failure while
        // the OS installer might still complete an approved installation.
        end = timeouts.complete == null ? Infinity : Date.now() + timeouts.complete;
      }
      if (result) {
        if (result.error) throw result.error;
        if (foreground && readySeen && result.code === 0 && await read('installed') === token) return;
        throw new Error(`Update helper exited before ${foreground ? 'completion' : 'readiness'} (${result.code ?? result.signal}).`);
      }
      if (!foreground && ready !== null) {
        await accept();
        child.unref();
        return;
      }
      if (Date.now() >= end) throw new Error(`Update helper ${readySeen ? 'completion' : 'readiness'} timed out.`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } catch (error) {
    await fs.promises.writeFile(path.join(work, 'cancelled'), token, { mode: 0o600 }).catch(() => {});
    child.unref();
    throw new Error(`${error.message} Log: ${path.join(work, 'update.log')}`, { cause: error });
  } finally {
    child.removeListener('exit', onExit);
    // Keep an error listener on a detached child after returning to its caller.
  }
}

function createUpdater({ version = '0.0.0', platform = process.platform, arch = process.arch,
  executable = process.execPath, packaged, deps = {} } = {}) {
  const name = assetName(platform, arch);
  const targetValid = typeof executable === 'string' && !/[\r\n\0]/.test(executable)
    && (platform === 'linux' ? executable === '/opt/onlydm/onlydm'
      : platform === 'darwin' && path.posix.isAbsolute(executable)
        && executable.endsWith('/OnlyDM.app/Contents/MacOS/OnlyDM')
        && !executable.split('/').includes('..') && !executable.includes('/AppTranslocation/') && !executable.startsWith('/Volumes/'));
  const supported = !!name && (packaged ?? targetValid) && targetValid && !!versionParts(version);
  const fetch = deps.fetch || globalThis.fetch;
  const launch = deps.spawn || spawn;
  const timeouts = { ...TIMEOUTS, ...deps.timeouts };
  let checking;
  let starting = false;

  function check({ strict = false } = {}) {
    if (!supported) return strict
      ? Promise.reject(new Error('Unsupported platform, architecture, version or packaged OnlyDM target.'))
      : Promise.resolve(null);
    if (!checking) {
      checking = deadline(timeouts.check, async (signal) => {
        const chunks = [];
        await readBounded(await responseFor(fetch, API, signal), JSON_LIMIT, (chunk) => { chunks.push(Buffer.from(chunk)); });
        const release = validateRelease(JSON.parse(Buffer.concat(chunks).toString('utf8')), name);
        if (!release) throw new Error('Invalid stable release or supported asset pair.');
        return newer(release.version, version) ? release : null;
      }).finally(() => { checking = null; });
    }
    return strict ? checking : checking.catch(() => null);
  }

  async function start(release, { waitForParent = true } = {}) {
    if (!supported) throw new Error('Updater requires a supported packaged OnlyDM target.');
    if (starting) throw new Error('An update is already starting.');
    const selected = validateRelease(release, name, true);
    if (!selected || !newer(selected.version, version)) throw new Error('Invalid update release or asset pair.');
    starting = true;
    let work;
    let child;
    try {
      const temp = await fs.promises.realpath((deps.tmpdir || os.tmpdir)());
      work = await fs.promises.mkdtemp(path.join(temp, 'OnlyDM-update-'));
      await fs.promises.chmod(work, 0o700);
      const write = (filename, value, mode = 0o600) => fs.promises.writeFile(path.join(work, filename), value, { flag: 'wx', mode });
      await deadline(timeouts.download, async (signal) => {
        const chunks = [];
        const count = await readBounded(await responseFor(fetch, selected.checksum.url, signal, true),
          CHECKSUM_LIMIT, (chunk) => { chunks.push(Buffer.from(chunk)); });
        const line = Buffer.concat(chunks).toString('utf8');
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const match = new RegExp(`^([a-fA-F0-9]{64})  ${escaped}\\r?\\n?$`).exec(line);
        if (count !== selected.checksum.size || !match) throw new Error('Invalid update checksum file or size.');
        const hash = createHash('sha256');
        const file = await fs.promises.open(path.join(work, name), 'wx', 0o600);
        try {
          const size = await readBounded(await responseFor(fetch, selected.asset.url, signal, true),
            Math.min(PACKAGE_LIMIT, selected.asset.size), async (chunk) => {
              hash.update(chunk);
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) throw new Error('Could not write update package.');
                offset += bytesWritten;
              }
            });
          if (size !== selected.asset.size || hash.digest('hex') !== match[1].toLowerCase()) throw new Error('Update package checksum or size mismatch.');
          await file.sync();
        } finally { await file.close(); }
        await write('sha256', match[1].toLowerCase());
      });
      const stamp = waitForParent ? await (deps.startStamp || startStamp)(platform) : 'unused';
      if (typeof stamp !== 'string' || !stamp || /[\r\n\0]/.test(stamp)) throw new Error('Cannot identify the originating process start stamp.');
      const token = randomBytes(24).toString('hex');
      const fields = { platform, arch, version: selected.version, 'current-version': version.replace(/^v/, ''),
        executable, pid: String(process.pid), stamp, token, mode: waitForParent ? 'parent' : 'foreground' };
      for (const [key, value] of Object.entries(fields)) await write(key, value);
      await write('update.log', '');
      await write('update-helper.sh', await fs.promises.readFile(path.join(__dirname, 'update-helper.sh')), 0o700);
      child = launch('/bin/bash', [path.join(work, 'update-helper.sh'), work], {
        detached: !!waitForParent, stdio: waitForParent ? 'ignore' : 'inherit', cwd: work, env: helperEnvironment(),
      });
      await waitForHelper(child, work, token, !waitForParent, timeouts);
    } catch (error) {
      starting = false;
      if (work && !child) await fs.promises.rm(work, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }
  return { check, start };
}

module.exports = { createUpdater };

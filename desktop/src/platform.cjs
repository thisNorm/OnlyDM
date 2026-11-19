'use strict';

const path = require('node:path');

function normalizeInstagramUserAgent(userAgent, platform = process.platform) {
  if (platform !== 'darwin') return userAgent;
  // Instagram compatibility case: https://github.com/ferdium/ferdium-recipes/pull/710
  return userAgent
    .replace(/\(Macintosh; Apple macOS [^)]+\)/, '(Macintosh; Intel Mac OS X 10_15_7)')
    .replace(/(^|\s)(?:OnlyDM|onlydm-linux|Electron)\/\S+/gi, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function windowIcon({ isPackaged, platform = process.platform }) {
  if (platform === 'darwin') return undefined;
  return isPackaged ? '/usr/share/pixmaps/onlydm.png'
    : path.join(__dirname, '..', '..', 'src', 'OnlyDM', 'Assets', 'OnlyDM.png');
}

module.exports = { normalizeInstagramUserAgent, windowIcon };

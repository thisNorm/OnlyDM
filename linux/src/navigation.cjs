'use strict';

const INBOX = 'https://www.instagram.com/direct/inbox/';

function instagramUrl(value) {
  try {
    const url = new URL(value);
    const origin = url.origin;
    if (origin !== 'https://www.instagram.com' && origin !== 'https://instagram.com') return null;
    // Reject any user information embedded before the approved host.
    if (!url.href.startsWith(origin + '/')) return null;
    return url;
  } catch {
    return null;
  }
}

function routeFor(value) {
  const url = instagramUrl(value);
  if (!url) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (path === '/direct' || path === '/direct/inbox') return { kind: 'inbox', href: url.href };
  if (/^\/direct\/t\/[a-zA-Z0-9_-]{1,200}$/.test(path)) {
    return { kind: 'thread', href: url.origin + path + '/', id: path.slice('/direct/t/'.length) };
  }
  if (/^\/(?:accounts\/login|challenge|checkpoint)(?:\/|$)/.test(path)
      || path === '/accounts/two_factor' || path === '/accounts/onetap') {
    return { kind: 'login', href: url.href };
  }
  return null;
}

module.exports = { INBOX, instagramUrl, routeFor };

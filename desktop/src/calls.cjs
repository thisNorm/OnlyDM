'use strict';

const { BrowserWindow } = require('electron');
const { instagramUrl } = require('./navigation.cjs');
const { normalizeInstagramUserAgent } = require('./platform.cjs');

function callUrl(value) {
  // Check the raw path too: URL parsing otherwise accepts credentials, dot segments and whitespace.
  if (typeof value !== 'string' || /[\u0000-\u0020\u007f\\]/.test(value)
      || !/^https:\/\/(?:www\.)?instagram\.com(?::443)?\/call\/(?:[?#]|$)/i.test(value)) return null;
  const url = instagramUrl(value);
  return url?.pathname === '/call/' && !url.username && !url.password ? url.href : null;
}

function allowCallMedia({ contents, permission, origin, details, owns, check = false }) {
  if (permission !== 'media' || !contents || typeof owns !== 'function' || !owns(contents)
    || details?.isMainFrame !== true) return false;
  const page = callUrl(contents.getURL());
  const requested = instagramUrl(origin || details.requestingUrl);
  if (!page || !requested || requested.origin !== new URL(page).origin
    || !callUrl(details.requestingUrl)) return false;
  return check ? ['audio', 'video'].includes(details.mediaType)
    : Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0
      && details.mediaTypes.every(type => ['audio', 'video'].includes(type));
}

/**
 * One host per parent. Pass Electron's setWindowOpenHandler details and the opener's
 * profile session to open(), then return { action: 'deny' } from that handler.
 * true means the request was accepted, not that Instagram connected a call.
 * Repeated requests reuse the popup; changing sessions destroys it before reopening.
 * The caller must also close() on logout/profile changes.
 *
 * owns() identifies only this host's live webContents; it does NOT grant permissions.
 * The parent must install BOTH session permission handlers before opening a call.
 * Require owns(contents), a current official HTTPS /call/ document, an official
 * requesting origin/URL and isMainFrame. Grant only 'media': nonempty mediaTypes
 * containing only 'audio'/'video' in the request handler, and mediaType 'audio' or
 * 'video' in the check handler. Deny unknown types, other permissions, subframes and
 * missing details. Keep the session's download denial in place. This module neither
 * reads session/cookie/auth data nor changes session-wide permission policies.
 *
 * macOS integration (caller/packaging responsibility): provide meaningful
 * NSMicrophoneUsageDescription and NSCameraUsageDescription strings in the app's
 * Info.plist (e.g. @electron/packager extendInfo). Check systemPreferences media
 * access status and request microphone/camera access on the user's call action.
 * A prior denial needs System Settings and may need an app restart; Electron's
 * session grant cannot override OS privacy controls. Signed hardened/sandboxed
 * builds must include the applicable com.apple.security.device.audio-input and
 * com.apple.security.device.camera entitlements on the relevant app/helper targets.
 * Ubuntu/Windows device availability and OS/portal privacy settings still apply.
 */
function createCallHost({ parent, icon, lang = 'en' } = {}) {
  let popup = null;
  let target = null;
  let request = 0;

  function close() {
    const previous = popup;
    popup = null;
    target = null;
    request++;
    // Explicit disposal must release media even if the page tries to veto unload.
    if (previous && !previous.isDestroyed()) previous.destroy();
  }

  function currentWindow() {
    if (popup && (popup.isDestroyed() || popup.webContents.isDestroyed())) close();
    return popup;
  }

  function owns(contents) {
    const window = currentWindow();
    return !!window && window.webContents === contents;
  }

  function open(details, instagramSession) {
    const href = callUrl(details?.url);
    if (!href || details.frameName === 'onlydm-external-link'
        || !instagramSession || typeof instagramSession !== 'object'
        || parent?.isDestroyed()) return false;

    try {
      let window = currentWindow();
      if (window && window.webContents.session !== instagramSession) {
        close();
        window = null;
      }
      if (!window) {
        window = new BrowserWindow({
          parent, icon,
          title: lang === 'ko' ? 'OnlyDM 통화' : 'OnlyDM Call',
          width: 1010,
          height: 760,
          useContentSize: true,
          minWidth: 700,
          minHeight: 560,
          show: false,
          frame: true,
          closable: true,
          fullscreenable: false,
          autoHideMenuBar: true,
          backgroundColor: '#000000',
          webPreferences: {
            session: instagramSession,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            webviewTag: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools: false,
            navigateOnDragDrop: false,
            disableDialogs: true,
            disableHtmlFullscreenWindowResize: true,
          },
        });
        popup = window;
        const contents = window.webContents;
        if (process.platform !== 'darwin') window.removeMenu();
        contents.setUserAgent(normalizeInstagramUserAgent(contents.getUserAgent()));
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        const guard = (event, url) => {
          if (!callUrl(event.url ?? url)) event.preventDefault();
        };
        contents.on('will-navigate', guard);
        contents.on('will-redirect', guard);
        contents.on('will-frame-navigate', guard);
        const navigated = (url) => {
          if (popup !== window) return;
          const next = callUrl(url);
          if (next) target = next;
          else close(); // Includes history.pushState escapes, which cannot be cancelled.
        };
        contents.on('did-navigate', (_event, url) => navigated(url));
        contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
          if (isMainFrame) navigated(url);
        });
        // Native chrome remains available on blank, failed, cancelled and finished pages.
        contents.on('content-bounds-updated', event => event.preventDefault());
        contents.on('will-prevent-unload', event => event.preventDefault());
        contents.on('before-input-event', (event, input) => {
          if (input.type === 'keyDown' && input.key === 'Escape' && popup === window) {
            event.preventDefault();
            close();
          }
        });
        const discard = () => { if (popup === window) close(); };
        contents.once('render-process-gone', discard);
        contents.once('destroyed', discard);
        window.once('closed', () => {
          if (popup === window) {
            popup = null;
            target = null;
            request++;
          }
        });
      }
      if (href !== target) {
        target = href;
        const loading = ++request;
        window.loadURL(href).catch(error => {
          // Official client-side transitions can replace an otherwise valid initial load.
          if (error?.code === 'ERR_ABORTED' || error?.errno === -3) return;
          if (popup === window && request === loading) close();
        });
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      return true;
    } catch {
      close();
      return false;
    }
  }

  parent?.once('closed', close);
  return { open, owns, close, get window() { return currentWindow(); } };
}

module.exports = { createCallHost, allowCallMedia };

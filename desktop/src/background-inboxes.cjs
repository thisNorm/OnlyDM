'use strict';

const { WebContentsView } = require('electron');
const { INBOX, routeFor } = require('./navigation.cjs');

const DOCUMENT_TIMEOUT = 35000;
const RETRY_DELAYS = [5000, 30000, 60000, 120000];

function createBackgroundInboxes({ webPreferences, sessionFor, script, onNotification }) {
  const watchers = new Map();
  const stopped = new Set();
  const retries = new Map();
  let closed = false;

  const current = (watcher) => !closed && watchers.get(watcher.id) === watcher && !watcher.contents.isDestroyed();

  function dispose(watcher) {
    watchers.delete(watcher.id);
    clearTimeout(watcher.deadline);
    for (const [event, listener] of watcher.listeners) watcher.contents.removeListener(event, listener);
    if (!watcher.contents.isDestroyed()) watcher.contents.close({ waitForBeforeUnload: false });
  }

  function stop(watcher) {
    if (watchers.get(watcher.id) !== watcher) return;
    stopped.add(watcher.id);
    clearRetry(watcher.id);
    dispose(watcher);
  }

  function clearRetry(id) {
    clearTimeout(retries.get(id)?.timer);
    retries.delete(id);
  }

  function retry(watcher) {
    const { id } = watcher;
    if (closed || watchers.get(id) !== watcher) return;
    const attempt = Math.min((retries.get(id)?.attempt ?? -1) + 1, RETRY_DELAYS.length - 1);
    const timer = setTimeout(() => {
      const pending = retries.get(id);
      if (closed || pending?.timer !== timer) return;
      pending.timer = null;
      start(id);
    }, RETRY_DELAYS[attempt]);
    timer.unref();
    retries.set(id, { attempt, timer });
    dispose(watcher);
  }

  function begin(watcher) {
    if (!current(watcher)) return;
    const generation = ++watcher.generation;
    watcher.injected = false;
    watcher.ready = false;
    clearTimeout(watcher.deadline);
    watcher.deadline = setTimeout(() => {
      if (watcher.generation === generation && !watcher.ready) retry(watcher);
    }, DOCUMENT_TIMEOUT);
    watcher.deadline.unref();
  }

  function atInbox(watcher) {
    const url = watcher.contents.getURL();
    if (routeFor(url)?.kind === 'inbox') return true;
    if (url.startsWith('chrome-error:')) retry(watcher);
    else stop(watcher);
    return false;
  }

  function prepare(watcher) {
    if (!current(watcher) || !atInbox(watcher)) return;
    if (watcher.injected) return;
    watcher.injected = true;
    const generation = watcher.generation;
    const frame = watcher.contents.mainFrame;
    watcher.contents.setZoomFactor(1);
    void watcher.contents.executeJavaScriptInIsolatedWorld(1001, [{ code: script }]).then(() => {
      if (!current(watcher) || watcher.generation !== generation || watcher.contents.mainFrame !== frame) return;
      watcher.ready = true;
      clearTimeout(watcher.deadline);
      clearRetry(watcher.id);
    }).catch(() => {
      if (current(watcher) && watcher.generation === generation) retry(watcher);
    });
  }

  function start(id) {
    const view = new WebContentsView({
      webPreferences: { ...webPreferences, session: sessionFor(id) },
    });
    // Keep the hidden source at Instagram's desktop breakpoint so its DM rows remain available.
    view.setBounds({ x: 0, y: 0, width: 1280, height: 720 });
    view.setVisible(false);
    const contents = view.webContents;
    const watcher = { id, view, contents, generation: 0, injected: false, ready: false, deadline: null };
    watchers.set(id, watcher);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const guard = (event) => {
      if (!event.isMainFrame) return;
      if (!current(watcher) || routeFor(event.url)?.kind !== 'inbox') {
        event.preventDefault();
        stop(watcher);
      } else {
        begin(watcher);
      }
    };
    watcher.listeners = Object.entries({
      'will-navigate': guard,
      'will-redirect': guard,
      'did-navigate': (_event, _url, statusCode) => {
        if (!current(watcher) || !atInbox(watcher)) return;
        if (statusCode >= 500 && statusCode < 600) retry(watcher);
        else begin(watcher);
      },
      'did-navigate-in-page': (_event, _url, isMainFrame) => {
        if (isMainFrame) prepare(watcher);
      },
      'dom-ready': () => prepare(watcher),
      'did-fail-load': (_event, code, _description, url, isMainFrame) => {
        if (!isMainFrame || code === -3) return;
        if (url && !url.startsWith('chrome-error:') && routeFor(url)?.kind !== 'inbox') stop(watcher);
        else retry(watcher);
      },
      'render-process-gone': () => retry(watcher),
      'destroyed': () => retry(watcher),
    });
    for (const [event, listener] of watcher.listeners) contents.on(event, listener);
    begin(watcher);
    void contents.loadURL(INBOX).catch(() => retry(watcher));
  }

  return {
    sync(ids, activeId) {
      if (closed) return;
      const inactive = new Set(ids);
      inactive.delete(activeId);
      for (const id of retries.keys()) if (!inactive.has(id)) clearRetry(id);
      for (const watcher of watchers.values()) {
        if (!inactive.has(watcher.id)) dispose(watcher);
      }
      // Visiting the official login in the active pane permits a later watch attempt.
      for (const id of stopped) if (!inactive.has(id)) stopped.delete(id);
      for (const id of inactive) {
        if (!watchers.has(id) && !stopped.has(id) && !retries.get(id)?.timer) start(id);
      }
    },
    onProjection(event, message) {
      const watcher = [...watchers.values()].find(({ contents }) => contents === event.sender);
      if (!watcher) return false;
      if (current(watcher) && watcher.ready && event.senderFrame === watcher.contents.mainFrame
          && routeFor(event.senderFrame?.url)?.kind === 'inbox' && message?.type === 'thread-notification') {
        onNotification(watcher.id, message);
      }
      return true;
    },
    close() {
      closed = true;
      for (const id of retries.keys()) clearRetry(id);
      for (const watcher of watchers.values()) dispose(watcher);
      stopped.clear();
    },
  };
}

module.exports = { createBackgroundInboxes };

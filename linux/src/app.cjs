'use strict';

const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, Notification, ipcMain, nativeTheme, session } = require('electron');
const { INBOX, instagramUrl, routeFor } = require('./navigation.cjs');
const { DEFAULT_PROFILE_ID, openProfiles } = require('./profiles.cjs');
const { createBackgroundInboxes } = require('./background-inboxes.cjs');

const PARTITION = 'persist:onlydm-instagram';
const INBOX_ZOOM = 0.25;
const DOCUMENT_TIMEOUT = 35000;
const OPEN_TIMEOUT = 25000;
const isolatedPrelude = '(() => {' + String.raw`
  const listeners = new Set();
  globalThis.onlydmHost.subscribe((data) => {
    for (const listener of listeners) listener({ data });
  });
  const __onlydmBridge = {
    postMessage: (data) => globalThis.onlydmHost.post(data),
    addEventListener: (type, listener) => { if (type === 'message') listeners.add(listener); },
    removeEventListener: (type, listener) => { if (type === 'message') listeners.delete(listener); },
  };
`;

const webPreferences = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  devTools: false,
};

async function createOnlyDM({ notify } = {}) {
  const lang = /^ko(?:-|$)/i.test(app.getLocale()) ? 'ko' : 'en';
  const dark = nativeTheme.shouldUseDarkColors;
  const theme = dark ? 'dark' : 'light';
  const generated = path.join(__dirname, '..', 'generated');
  const scripts = {
    inbox: readFileSync(path.join(generated, 'inbox-' + lang + '-' + theme + '.js'), 'utf8'),
    chat: readFileSync(path.join(generated, 'chat-' + theme + '.js'), 'utf8'),
    notify: readFileSync(path.join(generated, 'notify.js'), 'utf8'),
  };
  const text = (ko, en) => lang === 'ko' ? ko : en;
  const labels = {
    back: text('목록으로', 'Back to chats'),
    retry: text('새로고침', 'Reload'),
    search: text('대화 검색', 'Search chats'),
  };
  const profiles = openProfiles(app.getPath('userData'));
  const securedSessions = new Set();

  const window = new BrowserWindow({
    title: 'OnlyDM',
    width: 390,
    height: 720,
    minWidth: 350,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: dark ? '#1f232b' : '#ffffff',
    webPreferences: { ...webPreferences, preload: path.join(__dirname, 'shell-preload.cjs') },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  let inbox = null;
  let chat = null;
  let closed = false;
  let shellLoaded = false;
  let query = '';
  let counts = null;
  let pendingOpen = null;
  let openFailed = false;
  let accountSwitching = false;
  let accountPanelTimer = null;
  const notifications = new Set();
  const announced = new Set();
  const background = createBackgroundInboxes({
    webPreferences: {
      ...webPreferences,
      preload: path.join(__dirname, 'projection-preload.cjs'),
      backgroundThrottling: false,
    },
    sessionFor: profileSession,
    script: isolatedPrelude + scripts.notify + '\n})();',
    onNotification: threadNotification,
  });

  function stopDownload(event) { event.preventDefault(); }
  function active() { return chat || inbox; }

  function isCurrent(remote) {
    return !closed && !!remote && (remote === inbox || remote === chat) && !remote.contents.isDestroyed();
  }

  function profileSession(id = profiles.activeId) {
    const instagram = session.fromPartition(id === DEFAULT_PROFILE_ID ? PARTITION : PARTITION + '-' + id);
    if (!securedSessions.has(instagram)) {
      instagram.setPermissionCheckHandler(() => false);
      instagram.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      // Keep blocking downloads from requests that outlive a closed view.
      instagram.on('will-download', stopDownload);
      securedSessions.add(instagram);
    }
    return instagram;
  }

  function currentRoute(remote) {
    return routeFor(remote.contents.getURL());
  }

  function profileLabel(id) {
    const index = profiles.list.findIndex((profile) => profile.id === id);
    const profile = profiles.list[index];
    return profile?.handle ? '@' + profile.handle : text('계정 ', 'Account ') + (index + 1);
  }

  function showNotification({ title, body, onClick }) {
    if (!Notification.isSupported()) return;
    const notification = new Notification({ title, body });
    const forget = () => notifications.delete(notification);
    notifications.add(notification);
    notification.once('click', onClick);
    notification.once('close', forget);
    notification.once('failed', forget);
    notification.show();
  }

  function threadNotification(profileId, message) {
    if (closed || !shellLoaded || accountSwitching) return;
    const profile = profiles.list.find(({ id }) => id === profileId);
    if (!profile) return;
    const handle = profile.handle?.toLowerCase();
    const key = typeof message.key === 'string' ? message.key.trim().slice(0, 512) : '';
    const route = routeFor(message.href) || routeFor(key);
    const thread = route?.kind === 'thread' ? route : null;
    const title = typeof message.title === 'string'
      ? message.title.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
    if (!thread && !key) return;
    const messageId = typeof message.messageId === 'string' ? message.messageId.slice(0, 512) : '';
    const preview = typeof message.preview === 'string' ? message.preview.slice(0, 4096) : '';
    if (!messageId && !preview) return;
    // Retain only bounded fingerprints; message previews never reach the notification sink or disk.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([
        handle ? 'handle:' + handle : 'profile:' + profileId,
        messageId ? ['id', messageId] : ['preview', thread?.id || key, preview],
      ])).digest('hex');
    if (announced.has(fingerprint)) return;
    announced.add(fingerprint);
    while (announced.size > 512) announced.delete(announced.values().next().value);
    const sameThread = chat && (thread ? thread.id === chat.target.id
      : key === chat.key || key === 'name:' + chat.title);
    const activeHandle = profiles.list.find(({ id }) => id === profiles.activeId)?.handle?.toLowerCase();
    const sameAccount = profileId === profiles.activeId || (handle && handle === activeHandle);
    if (sameAccount && sameThread && chat.status === 'ready'
        && currentRoute(chat)?.id === chat.target.id && chat.view.getVisible()
        && window.isVisible() && !window.isMinimized() && window.isFocused()) return;
    const onClick = () => {
      if (closed || accountSwitching || window.isDestroyed()) return;
      const currentProfile = profiles.list.find(({ id }) => id === profileId);
      if (!currentProfile || (handle && currentProfile.handle?.toLowerCase() !== handle)) return;
      if (profiles.activeId !== profileId) {
        if (!profiles.select(profileId)) return;
        replaceInbox();
      } else {
        goBack();
        if (currentRoute(inbox)?.kind !== 'inbox') load(inbox, INBOX);
        sync();
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      if (inbox.status === 'ready' && currentRoute(inbox)?.kind === 'inbox') inbox.contents.focus();
    };
    try {
      (typeof notify === 'function' ? notify : showNotification)({
        profileId,
        title: profileLabel(profileId) + ' · ' + (title || text('새 메시지', 'New message')),
        body: text('새 메시지가 도착했습니다.', 'A new message has arrived.'),
        onClick,
      });
    } catch {
      console.error('OnlyDM could not show a notification.');
    }
  }

  function sync() {
    if (closed || !shellLoaded || !inbox) return;
    const visible = active();
    const route = currentRoute(visible);
    const show = (visible.status === 'login' && route?.kind === 'login')
      || (visible.status === 'ready' && (visible === inbox ? route?.kind === 'inbox' : route?.id === visible.target?.id));
    const pane = chat ? 'chat' : visible.status === 'login' ? 'login' : 'inbox';
    const { width, height } = window.getContentBounds();
    inbox.view.setBounds({ x: 0, y: pane === 'login' ? 52 : 94, width, height: Math.max(0, height - (pane === 'login' ? 52 : 94)) });
    if (chat) chat.view.setBounds({ x: 0, y: 52, width, height: Math.max(0, height - 52) });
    inbox.view.setVisible(!!show && visible === inbox);
    if (chat) chat.view.setVisible(!!show);
    const countText = counts ? text('대화 ' + counts.count, 'Chats ' + counts.count)
      + (counts.unread ? text(' · 안 읽음 ', ' · Unread ') + counts.unread : '') : '';
    window.webContents.send('onlydm:state', {
      lang,
      dark,
      pane,
      profiles: profiles.list.map(({ id }) => ({ id, label: profileLabel(id) })),
      activeProfileId: profiles.activeId,
      labels,
      title: chat ? (chat.title || text('대화', 'Chat')) : pane === 'inbox' ? text('채팅', 'Chats') : 'OnlyDM',
      hint: pane !== 'inbox' ? '' : pendingOpen ? text('대화방을 찾는 중…', 'Finding the chat…')
        : openFailed ? text('대화방을 열지 못했습니다. 다시 선택해 주세요.', 'Could not open the chat. Try selecting it again.') : countText,
      status: show ? '' : visible.status === 'error'
        ? text('화면을 불러오지 못했습니다. 새로고침을 눌러 다시 시도해 주세요.', 'Could not load this view. Use Reload to try again.')
        : chat ? text('대화방을 여는 중입니다.', 'Opening chat…') : text('채팅 목록을 불러오는 중입니다.', 'Loading chats…'),
    });
  }

  function command(remote, data) {
    if (isCurrent(remote)) remote.contents.send('onlydm:command', data);
  }

  function resetOpen(failed = false) {
    if (pendingOpen) clearTimeout(pendingOpen.timer);
    pendingOpen = null;
    openFailed = failed;
  }

  function fail(remote) {
    if (!isCurrent(remote)) return;
    if (remote === inbox) resetAccountPanel();
    clearTimeout(remote.deadline);
    remote.status = 'error';
    sync();
  }

  function beginDocument(remote) {
    if (!isCurrent(remote)) return;
    clearTimeout(remote.deadline);
    remote.status = 'loading';
    remote.injected = false;
    remote.deadline = setTimeout(() => fail(remote), DOCUMENT_TIMEOUT);
    if (remote === inbox) {
      counts = null;
      resetOpen();
    }
    sync();
  }

  function load(remote, href) {
    if (!isCurrent(remote)) return;
    beginDocument(remote);
    void remote.contents.loadURL(href).catch(() => {});
  }

  function disposeRemote(remote) {
    if (!remote) return;
    clearTimeout(remote.deadline);
    for (const [event, listener] of remote.listeners) remote.contents.removeListener(event, listener);
    if (!closed) window.contentView.removeChildView(remote.view);
    if (!remote.contents.isDestroyed()) remote.contents.close({ waitForBeforeUnload: false });
  }

  function removeChat() {
    const remote = chat;
    chat = null;
    disposeRemote(remote);
  }

  function resetAccountPanel() {
    accountSwitching = false;
    clearTimeout(accountPanelTimer);
    accountPanelTimer = null;
  }

  function linkedProfile() {
    if (accountSwitching || chat || pendingOpen || inbox.status !== 'ready' || currentRoute(inbox)?.kind !== 'inbox') return;
    accountSwitching = true;
    const remote = inbox;
    accountPanelTimer = setTimeout(() => {
      if (isCurrent(remote) && accountSwitching) replaceInbox();
    }, OPEN_TIMEOUT);
    command(inbox, { type: 'open-account-panel' });
  }

  function replaceInbox() {
    const previous = inbox;
    inbox = null;
    resetAccountPanel();
    query = '';
    counts = null;
    resetOpen();
    removeChat();
    disposeRemote(previous);
    background.sync(profiles.list.map(({ id }) => id), profiles.activeId);
    inbox = makeRemote('inbox', profileSession());
    if (shellLoaded) load(inbox, INBOX);
  }

  function goBack() {
    if (!chat) return;
    removeChat();
    if (currentRoute(inbox)?.kind === 'inbox') {
      // Chromium's zoom is shared by origin. Restore the list zoom before showing it.
      inbox.contents.setZoomFactor(INBOX_ZOOM);
    }
    sync();
    if (inbox.status === 'ready' && currentRoute(inbox)?.kind === 'inbox') inbox.contents.focus();
  }

  function openChat(route, title, key = '') {
    if (chat || route?.kind !== 'thread') return;
    resetOpen();
    chat = makeRemote('chat', inbox.contents.session, route, title);
    chat.key = key;
    sync();
    load(chat, route.href);
  }

  function authFinishedAtRoot(event, remote) {
    const url = instagramUrl(event.url);
    if (url?.pathname === '/' && currentRoute(remote)?.kind === 'login') {
      queueMicrotask(() => load(remote, INBOX));
    }
  }

  function makeRemote(kind, instagram, target = null, title = '') {
    const view = new WebContentsView({
      webPreferences: {
        ...webPreferences,
        session: instagram,
        preload: path.join(__dirname, 'projection-preload.cjs'),
        // Keep the source DOM active until its projection is safe to show.
        backgroundThrottling: false,
      },
    });
    const contents = view.webContents;
    const remote = { view, contents, kind, target, title, status: 'loading', injected: false, deadline: null };
    view.setVisible(false);
    window.contentView.addChildView(view);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));

    const guardNavigation = (event) => {
      if (!event.isMainFrame) return;
      if (!isCurrent(remote)) {
        event.preventDefault();
        return;
      }
      const route = routeFor(event.url);
      if (route?.kind === 'login' || (kind === 'inbox' ? route?.kind === 'inbox' : route?.id === target.id)) {
        beginDocument(remote);
        return;
      }
      event.preventDefault();
      if (kind === 'inbox' && accountSwitching && instagramUrl(event.url)?.pathname === '/') {
        queueMicrotask(() => {
          if (isCurrent(remote) && accountSwitching) replaceInbox();
        });
      } else if (kind === 'inbox' && route?.kind === 'thread' && pendingOpen && remote.status === 'ready') {
        command(remote, { type: 'thread-route', href: route.href });
      } else {
        authFinishedAtRoot(event, remote);
      }
    };
    remote.listeners = Object.entries({
      'will-navigate': guardNavigation,
      'will-redirect': guardNavigation,
      // did-start-navigation also fires for canceled navigations.
      'did-navigate': () => {
        if (remote.status !== 'loading') beginDocument(remote);
      },
      'did-fail-load': (_event, code, _description, _url, isMainFrame) => {
        if (isMainFrame && code !== -3) fail(remote);
      },
      'render-process-gone': () => fail(remote),
      'dom-ready': () => prepare(remote),
      'did-navigate-in-page': (_event, _url, isMainFrame) => {
        if (!isMainFrame || !isCurrent(remote)) return;
        const route = currentRoute(remote);
        if (kind === 'inbox' && route?.kind === 'thread' && (pendingOpen || chat)) {
          sync(); // The shared projection is resolving the address and will go back.
        } else if (route?.kind === 'login' || (kind === 'inbox' ? route?.kind === 'inbox' : route?.id === target.id)) {
          prepare(remote);
        } else {
          fail(remote);
          load(remote, kind === 'inbox' ? INBOX : target.href);
        }
      },
    });
    for (const [event, listener] of remote.listeners) contents.on(event, listener);
    return remote;
  }

  function prepare(remote) {
    if (!isCurrent(remote)) return;
    if (remote === inbox && !remote.injected) resetAccountPanel();
    const route = currentRoute(remote);
    if (route?.kind === 'login') {
      if (remote === chat) {
        removeChat();
        load(inbox, route.href);
        sync();
        return;
      }
      clearTimeout(remote.deadline);
      remote.status = 'login';
      remote.contents.setZoomFactor(1);
      sync();
      return;
    }

    if (remote === inbox ? route?.kind !== 'inbox' : route?.id !== remote.target.id) {
      fail(remote);
      return;
    }
    if (remote.injected) {
      sync();
      return;
    }
    // Navigations reset the zoom. Set it before the projection measures the page.
    if (remote === active()) remote.contents.setZoomFactor(remote === inbox ? INBOX_ZOOM : 1);
    remote.injected = true;
    remote.status = 'loading';
    clearTimeout(remote.deadline);
    remote.deadline = setTimeout(() => fail(remote), DOCUMENT_TIMEOUT);
    sync();
    const frame = remote.contents.mainFrame;
    void remote.contents.executeJavaScriptInIsolatedWorld(1001, [
      { code: isolatedPrelude + scripts[remote.kind] + '\n})();' },
    ]).catch(() => {
      if (isCurrent(remote) && remote.contents.mainFrame === frame) fail(remote);
    });
  }

  function markReady(remote) {
    clearTimeout(remote.deadline);
    remote.status = 'ready';
    sync();
    if (remote === active()) remote.contents.focus();
  }

  function onProjection(event, message) {
    if (background.onProjection(event, message)) return;
    const remote = event.sender === inbox?.contents ? inbox : event.sender === chat?.contents ? chat : null;
    if (!isCurrent(remote) || !event.senderFrame || event.senderFrame !== remote.contents.mainFrame || !message || typeof message !== 'object') return;
    const route = routeFor(event.senderFrame.url);
    if (remote === inbox) {
      if (!route || (route.kind !== 'inbox' && route.kind !== 'thread')) return;
      if (accountSwitching) {
        if (message.type === 'account-panel-opened' && route.kind === 'inbox') {
          clearTimeout(accountPanelTimer);
          accountPanelTimer = null;
          inbox.contents.setZoomFactor(1);
        } else if (message.type === 'account-panel-closed'
            || (message.type === 'projection-error' && message.stage === 'account')) {
          inbox.contents.setZoomFactor(INBOX_ZOOM);
          replaceInbox();
        }
        return;
      }
      const key = typeof message.key === 'string' ? message.key.slice(0, 512) : '';
      const title = typeof message.title === 'string' ? message.title.trim().slice(0, 200) : '';
      if (message.type === 'inbox-ready' && route.kind === 'inbox') {
        markReady(inbox);
        if (query) command(inbox, { type: 'filter-threads', query });
      } else if (message.type === 'thread-notification' && route.kind === 'inbox' && inbox.status === 'ready' && inbox.injected) {
        threadNotification(profiles.activeId, message);
      } else if (message.type === 'own-profile' && route.kind === 'inbox') {
        if (profiles.setHandle(message.username)) sync();
      } else if (message.type === 'inbox-count') {
        if (!Number.isSafeInteger(message.count) || !Number.isSafeInteger(message.unread)) return;
        counts = { count: Math.max(0, message.count), unread: Math.max(0, message.unread) };
        sync();
      } else if (message.type === 'request-open' && inbox.status === 'ready' && route.kind === 'inbox' && !chat && !pendingOpen) {
        const direct = routeFor(message.href) || routeFor(key);
        if (direct?.kind === 'thread') {
          openChat(direct, title, key);
        } else if (key) {
          openFailed = false;
          const timer = setTimeout(() => {
            if (pendingOpen?.timer !== timer) return;
            resetOpen(true);
            sync();
          }, OPEN_TIMEOUT);
          pendingOpen = { key, timer };
          command(inbox, { type: 'open-row', key, title });
          sync();
        }
      } else if (message.type === 'open-thread' && pendingOpen && key === pendingOpen.key) {
        openChat(routeFor(message.href), title, key);
      } else if (message.type === 'need-inbox') {
        load(inbox, INBOX);
      } else if (message.type === 'projection-error' && message.stage === 'open' && pendingOpen) {
        resetOpen(true);
        sync();
      }
    } else if (route?.kind === 'thread' && route.id === remote.target.id) {
      if (message.type === 'chat-ready') markReady(remote);
      if (message.type === 'thread-title' && typeof message.title === 'string' && !remote.title) {
        remote.title = message.title.trim().slice(0, 200);
        sync();
      }
      if (message.type === 'close-window') goBack();
    }
  }

  const shellCommand = (handler) => (event, value) => {
    if (!closed && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) handler(value);
  };
  const handlers = new Map([
    ['onlydm:projection', onProjection],
    ['onlydm:back', shellCommand(goBack)],
    ['onlydm:linked-profile', shellCommand(linkedProfile)],
    ['onlydm:retry', shellCommand(() => {
      if (accountSwitching) {
        replaceInbox();
        return;
      }
      const remote = active();
      load(remote, remote.target?.href || (remote.status === 'login' ? currentRoute(remote)?.href : null) || INBOX);
    })],
    ['onlydm:search', shellCommand((value) => {
      if (accountSwitching || typeof value !== 'string') return;
      query = value.slice(0, 200);
      if (inbox.status === 'ready') command(inbox, { type: 'filter-threads', query });
    })],
    ['onlydm:select-profile', shellCommand((id) => {
      if (profiles.select(id)) replaceInbox();
      else sync();
    })],
    ['onlydm:add-profile', shellCommand(() => {
      if (profiles.add()) replaceInbox();
      else sync();
    })],
  ]);
  replaceInbox();
  for (const [channel, handler] of handlers) ipcMain.on(channel, handler);
  window.on('resize', sync);
  window.on('closed', () => {
    closed = true;
    resetAccountPanel();
    resetOpen();
    for (const [channel, handler] of handlers) ipcMain.removeListener(channel, handler);
    background.close();
    for (const notification of notifications) {
      notification.removeAllListeners();
      notification.close();
    }
    notifications.clear();
    removeChat();
    disposeRemote(inbox);
    for (const instagram of securedSessions) instagram.removeListener('will-download', stopDownload);
  });

  await window.loadFile(path.join(__dirname, 'shell.html'));
  shellLoaded = true;
  sync();
  window.show();
  load(inbox, INBOX);
  return { window, get inbox() { return inbox.view; } };
}

module.exports = { createOnlyDM, PARTITION };

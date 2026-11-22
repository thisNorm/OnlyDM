'use strict';

const { readFileSync } = require('node:fs');
const { createHash, randomInt } = require('node:crypto');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, Notification, ipcMain, nativeTheme, session, shell, dialog } = require('electron');
const { INBOX, instagramUrl, routeFor } = require('./navigation.cjs');
const { DEFAULT_PROFILE_ID, openProfiles } = require('./profiles.cjs');
const { createBackgroundInboxes } = require('./background-inboxes.cjs');
const { openSettings } = require('./settings.cjs');
const { normalizeInstagramUserAgent, windowIcon } = require('./platform.cjs');
const { appPalette, chatPalette } = require('./colors.js');
const { createUpdater } = require('./updates.cjs');
const { draftPresence } = require('./draft-presence.cjs');
const { openContacts } = require('./contacts.cjs');
const { createCallHost, allowCallMedia } = require('./calls.cjs');
const { createTray } = require('./tray.cjs');
const { createAutostart } = require('./autostart.cjs');
const { createChatWindow } = require('./chat-window.cjs');

const PARTITION = 'persist:onlydm-instagram';
const INBOX_ZOOM = 0.25;
const FRIENDS_ZOOM = 0.4;
const INBOX_RAIL_WIDTH = 46; // Matches the local shell rail; never overlap it with the native inbox view.
const HEADER_HEIGHT = 52;
const TITLEBAR_HEIGHT = 30;
const SEARCH_HEIGHT = 42;
const DOCUMENT_TIMEOUT = 35000;
const OPEN_TIMEOUT = 25000;
const WORK_NOTICES = [
  ['점검이 필요합니다.', 'A check is required.'],
  ['처리 대기 중인 항목이 있습니다.', 'An item is pending.'],
  ['작업 상태를 확인해 주세요.', 'Check the task status.'],
  ['새로운 확인 요청이 있습니다.', 'A new review has been requested.'],
  ['다음 점검 일정을 확인해 주세요.', 'Check the next scheduled review.'],
];
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
  zoomMode: 'isolated',
};

async function createOnlyDM({ notify, openExternal = (href) => shell.openExternal(href), updater, confirmDiscardDrafts,
  separateChatWindows = true } = {}) {
  const settings = openSettings(app.getPath('userData'));
  const resolveLanguage = () => settings.language === 'auto'
    ? (/^ko(?:-|$)/i.test(app.getLocale()) ? 'ko' : 'en') : settings.language;
  let lang = resolveLanguage();
  const dark = nativeTheme.shouldUseDarkColors;
  const theme = dark ? 'dark' : 'light';
  const generated = path.join(__dirname, '..', 'generated');
  const scripts = {
    inbox: readFileSync(path.join(generated, 'inbox-' + lang + '-' + theme + '.js'), 'utf8'),
    chatLight: readFileSync(path.join(generated, 'chat-light.js'), 'utf8'),
    chatDark: readFileSync(path.join(generated, 'chat-dark.js'), 'utf8'),
    notify: readFileSync(path.join(generated, 'notify.js'), 'utf8'),
    friends: readFileSync(path.join(generated, 'friends-' + lang + '-' + theme + '.js'), 'utf8'),
    language: readFileSync(path.join(generated, 'language-' + lang + '.js'), 'utf8'),
  };
  const text = (ko, en) => lang === 'ko' ? ko : en;
  const makeLabels = () => ({
    back: text('목록으로', 'Back to chats'),
    retry: text('새로고침', 'Reload'),
    search: text('대화 검색', 'Search chats'),
    settings: text('설정', 'Settings'),
    workMode: text('열일 모드', 'Work mode'),
    workModeDescription: text('새 DM 알림에 이름과 메시지 대신 일반 안내 문구를 표시합니다.',
      'Use generic notices in place of names and messages in new DM notifications.'),
    chatTheme: {
      theme: text('색상 모드', 'Appearance'),
      system: text('시스템', 'System'),
      light: text('라이트', 'Light'),
      dark: text('다크', 'Dark'),
      custom: text('사용자 지정', 'Custom'),
      background: text('채팅 배경', 'Chat background'),
      chrome: text('상단·사이드바', 'Top bar & sidebar'),
      appBackground: text('앱 배경', 'App background'),
      appPreview: text('앱 미리보기', 'App preview'),
      appPreviewBody: text('채팅 · 친구 목록', 'Chats and friends'),
      colorTarget: text('수정할 색상', 'Color to edit'),
      presets: text('기본 팔레트', 'Presets'),
      spectrum: text('스펙트럼', 'Spectrum'),
      hue: text('색조', 'Hue'),
      spectrumHelp: text('드래그하거나 화살표 키로 색을 고르세요.', 'Drag or use the arrow keys to choose a color.'),
      incoming: text('받은 메시지', 'Incoming'),
      outgoing: text('보낸 메시지', 'Outgoing'),
      previewIncoming: text('안녕하세요!', 'Hello!'),
      previewOutgoing: text('반가워요.', 'Nice to meet you.'),
      hexError: text('HEX 6자리를 입력해 주세요. 예: #4257C9', 'Enter six HEX digits, e.g. #4257C9.'),
      apply: text('적용', 'Apply'),
    },
    settingsError: text('설정을 저장하지 못했습니다.', 'Could not save settings.'),
    close: text('닫기', 'Close'),
    update: text('업데이트', 'Update'),
    updatePreparing: text('업데이트를 준비하는 중입니다.', 'Preparing update.'),
  });
  let labels = makeLabels();
  const profiles = openProfiles(app.getPath('userData'));
  const autoStart = createAutostart({ packaged: app.isPackaged });
  const contactIdentity = (id = profiles.activeId) => ({ id,
    handle: (profiles.list.find(profile => profile.id === id)?.handle || '').toLowerCase() });
  let contacts = openContacts(app.getPath('userData'), contactIdentity());
  const initialPalette = appPalette(settings.chatTheme, settings.appColors, dark);
  const securedSessions = new Set();

  const window = new BrowserWindow({
    title: 'OnlyDM',
    width: 390,
    height: 720,
    minWidth: 350,
    minHeight: 420,
    show: false,
    icon: windowIcon({ isPackaged: app.isPackaged }),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 10, y: 8 } }
      : { titleBarOverlay: { color: initialPalette.chrome, symbolColor: initialPalette.chromeText, height: TITLEBAR_HEIGHT } }),
    backgroundColor: initialPalette.surface,
    webPreferences: { ...webPreferences, preload: path.join(__dirname, 'shell-preload.cjs') },
  });
  if (process.platform !== 'darwin') window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  let inbox = null;
  let chat = null;
  const chatCache = new Map();
  let friends = null;
  let friendsView = false;
  let friendsCount = null;
  let newChatOpen = false;
  let newChatBusy = false;
  let pendingNotification = null;
  let closed = false;
  let shellLoaded = false;
  let query = '';
  let counts = null;
  let pendingOpen = null;
  let openFailed = false;
  let accountSwitching = false;
  let accountPanelTimer = null;
  let settingsOpen = false;
  let settingsError = false;
  let settingsLayer = null;
  let settingsInShell = false;
  let updating = false;
  let availableUpdate = null;
  let checkingUpdate = false;
  const updates = updater || (app.isPackaged && ['linux', 'darwin'].includes(process.platform)
    ? createUpdater({ version: app.getVersion(), platform: process.platform, arch: process.arch, executable: process.execPath })
    : null);
  let updateTimer;
  const notifications = new Set();
  const announced = new Set();
  const calls = createCallHost({ parent: window, icon: windowIcon({ isPackaged: app.isPackaged }), lang });
  let tray;
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
  function active() { return (!separateChatWindows && chat) || (friendsView && friends) || inbox; }
  function hasInlineChat() { return !!chat && !separateChatWindows; }
  function allChats() { return [...new Set([chat, ...chatCache.values()])].filter(Boolean); }

  function isCurrent(remote) {
    return !closed && !!remote && (remote === inbox || remote === chat || remote === friends
      || [...chatCache.values()].includes(remote)) && !remote.contents.isDestroyed();
  }

  function profileSession(id = profiles.activeId) {
    const instagram = session.fromPartition(id === DEFAULT_PROFILE_ID ? PARTITION : PARTITION + '-' + id);
    if (!securedSessions.has(instagram)) {
      if (process.platform === 'darwin') {
        // Set the session default before creating either foreground or background views.
        instagram.setUserAgent(normalizeInstagramUserAgent(instagram.getUserAgent()));
      }
      instagram.setPermissionCheckHandler((contents, permission, origin, details) =>
        allowCallMedia({ contents, permission, origin, details, owns: calls.owns, check: true }));
      instagram.setPermissionRequestHandler((contents, permission, callback, details) =>
        callback(allowCallMedia({ contents, permission, origin: details?.requestingUrl, details, owns: calls.owns })));
      // Keep blocking downloads from requests that outlive a closed view.
      instagram.on('will-download', stopDownload);
      securedSessions.add(instagram);
    }
    return instagram;
  }

  function currentRoute(remote) {
    if (!remote || remote.contents.isDestroyed()) return null;
    return remoteRoute(remote, remote.contents.getURL());
  }

  function remoteRoute(remote, value) {
    const route = routeFor(value);
    if (route) return route;
    const url = instagramUrl(value);
    if (remote?.kind === 'friends' && url?.pathname.replace(/\/+$/, '').toLowerCase() === '/' + ownHandle().toLowerCase())
      return { kind: 'profile', href: url.href };
    if (remote === inbox && remote.languagePending && url?.pathname.replace(/\/+$/, '') === '/accounts/language')
      return { kind: 'language', href: url.href };
    return null;
  }

  function ownHandle() { return profiles.list.find(profile => profile.id === profiles.activeId)?.handle || ''; }

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
    // Retain only bounded fingerprints for deduplication; message previews never go to disk.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([
        handle ? 'handle:' + handle : 'profile:' + profileId,
        messageId ? ['id', messageId] : ['preview', thread?.id || key, preview],
      ])).digest('hex');
    if (announced.has(fingerprint)) return;
    announced.add(fingerprint);
    while (announced.size > 512) announced.delete(announced.values().next().value);
    if (!settings.notificationsEnabled) return;
    const room = allChats().find(candidate => thread ? thread.id === candidate.target.id
      : key === candidate.key || key === 'name:' + candidate.title);
    const sameThread = !!room;
    const activeHandle = profiles.list.find(({ id }) => id === profiles.activeId)?.handle?.toLowerCase();
    const sameAccount = profileId === profiles.activeId || (handle && handle === activeHandle);
    const owner = room?.window || window;
    if (sameAccount && sameThread && room.status === 'ready'
        && currentRoute(room)?.id === room.target.id && room.view.getVisible()
        && owner.isVisible() && !owner.isMinimized() && owner.isFocused()) return;
    const onClick = () => {
      if (closed || updating || accountSwitching || window.isDestroyed()) return;
      const currentProfile = profiles.list.find(({ id }) => id === profileId);
      if (!currentProfile || (handle && currentProfile.handle?.toLowerCase() !== handle)) return;
      settingsOpen = false;
      newChatOpen = false;
      if (profiles.activeId !== profileId) {
        if (!profiles.select(profileId)) return;
        replaceInbox();
      } else {
        if (!separateChatWindows) goBack();
        if (currentRoute(inbox)?.kind !== 'inbox') load(inbox, INBOX);
        sync();
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      const requested = { key, title, href: thread?.href || '', profileId, handle };
      if (inbox.status === 'ready' && currentRoute(inbox)?.kind === 'inbox') requestOpen(requested);
      else pendingNotification = requested;
      if (inbox.status === 'ready' && currentRoute(inbox)?.kind === 'inbox') inbox.contents.focus();
    };
    try {
      const notice = settings.workModeEnabled ? WORK_NOTICES[randomInt(WORK_NOTICES.length)] : null;
      const book = profileId === profiles.activeId ? contacts : openContacts(app.getPath('userData'), contactIdentity(profileId));
      const shown = book.display(thread?.href || book.threadUrl(key), title, key);
      (typeof notify === 'function' ? notify : showNotification)({
        profileId,
        title: notice ? text('시스템', 'System') : profileLabel(profileId) + ' · ' + (shown || text('새 메시지', 'New message')),
        body: notice ? text(...notice) : settings.notificationPreviewEnabled && preview
          ? preview.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
          : text('새 메시지가 도착했습니다.', 'A new message has arrived.'),
        onClick,
      });
    } catch {
      console.error('OnlyDM could not show a notification.');
    }
  }

  function disposeSettingsLayer() {
    const layer = settingsLayer;
    if (!layer) return;
    settingsLayer = null;
    if (!window.isDestroyed()) window.contentView.removeChildView(layer.view);
    const contents = layer.view.webContents;
    if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
  }

  function getSettingsLayer() {
    if (settingsLayer) return settingsLayer;
    const view = new WebContentsView({
      webPreferences: { ...webPreferences, preload: path.join(__dirname, 'shell-preload.cjs') },
    });
    const contents = view.webContents;
    const layer = settingsLayer = { view, ready: false };
    view.setBackgroundColor('#00000000');
    view.setVisible(false);
    window.contentView.addChildView(view);
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    for (const name of ['will-navigate', 'will-redirect', 'will-frame-navigate'])
      contents.on(name, event => event.preventDefault());
    const fallback = () => {
      if (settingsLayer !== layer) return;
      settingsInShell = true;
      disposeSettingsLayer();
      sync();
      if (!closed && window.isFocused()) window.webContents.focus();
    };
    contents.once('render-process-gone', fallback);
    contents.once('destroyed', fallback);
    void contents.loadFile(path.join(__dirname, 'shell.html'), { query: { view: 'settings' } }).then(() => {
      if (settingsLayer !== layer) return;
      layer.ready = true;
      sync();
      if (window.isFocused()) contents.focus();
    }).catch(fallback);
    return layer;
  }

  function sync() {
    if (closed || !shellLoaded || !inbox) return;
    const visible = active();
    const shownChat = hasInlineChat() ? chat : null;
    const route = currentRoute(visible);
    const show = (visible.status === 'login' && route?.kind === 'login')
      || (visible.status === 'ready' && (visible === inbox ? route?.kind === 'inbox'
        : visible === friends ? route?.kind === 'profile' : route?.id === visible.target?.id));
    const pane = shownChat ? 'chat' : visible.status === 'login' ? 'login' : friendsView ? 'friends' : 'inbox';
    const { width, height } = window.getContentBounds();
    const listPane = pane === 'inbox' || pane === 'friends';
    const railWidth = listPane ? INBOX_RAIL_WIDTH : 0;
    const headerHeight = TITLEBAR_HEIGHT + HEADER_HEIGHT + (listPane ? SEARCH_HEIGHT : 0);
    inbox.view.setBounds({ x: railWidth, y: headerHeight, width: Math.max(0, width - railWidth), height: Math.max(0, height - headerHeight) });
    if (shownChat) shownChat.view.setBounds({ x: 0, y: TITLEBAR_HEIGHT + HEADER_HEIGHT, width, height: Math.max(0, height - TITLEBAR_HEIGHT - HEADER_HEIGHT) });
    const settingsOverlayOpen = settingsOpen && !settingsInShell;
    const overlay = (settingsOpen && settingsInShell) || newChatOpen || updating;
    inbox.view.setVisible(!!show && !overlay && visible === inbox);
    if (friends) {
      friends.view.setBounds({ x: railWidth, y: headerHeight, width: Math.max(0, width - railWidth), height: Math.max(0, height - headerHeight) });
      friends.view.setVisible(!!show && !overlay && visible === friends);
    }
    if (shownChat) shownChat.view.setVisible(!!show && !overlay);
    for (const remote of chatCache.values()) if (remote !== chat && !remote.window) remote.view.setVisible(false);
    const countText = pane === 'friends' ? text('친구 ', 'Friends ') + (friendsCount ?? contacts.friends.length)
      : counts ? text('대화 ' + counts.count, 'Chats ' + counts.count)
      + (counts.unread ? text(' · 안 읽음 ', ' · Unread ') + counts.unread : '') : '';
    const palette = appPalette(settings.chatTheme, settings.appColors, nativeTheme.shouldUseDarkColors);
    window.setBackgroundColor(palette.surface);
    if (process.platform !== 'darwin') window.setTitleBarOverlay({ color: palette.chrome, symbolColor: palette.chromeText, height: TITLEBAR_HEIGHT });
    const state = {
      lang,
      dark: palette.dark,
      appPalette: palette,
      platform: process.platform,
      pane,
      profiles: profiles.list.map(({ id }) => ({ id, label: profileLabel(id) })),
      activeProfileId: profiles.activeId,
      settingsOpen,
      newChatOpen,
      newChatBusy,
      roster: contacts.friends.map(person => ({ ...person, shown: contacts.aliasFor(person.handle) || person.name })),
      language: settings.language,
      notificationsEnabled: settings.notificationsEnabled,
      notificationPreviewEnabled: settings.notificationPreviewEnabled,
      startInTray: settings.startInTray,
      autoStart: autoStart.enabled,
      chatControls: shownChat?.controls || { voice: false, video: false, info: false },
      chatRenameEnabled: !!shownChat && shownChat.status === 'ready',
      query,
      settingsError,
      updating,
      updateAvailable: availableUpdate ? { version: availableUpdate.version } : null,
      workModeEnabled: settings.workModeEnabled,
      chatTheme: settings.chatTheme,
      chatColors: settings.chatColors,
      appColors: settings.appColors,
      labels,
      title: shownChat ? contacts.display(shownChat.target.href, shownChat.title, shownChat.key) || text('대화', 'Chat')
        : pane === 'friends' ? text('친구', 'Friends') : pane === 'inbox' ? text('채팅', 'Chats') : 'OnlyDM',
      hint: !listPane ? '' : pendingOpen ? text('대화방을 찾는 중…', 'Finding the chat…')
        : openFailed ? text('대화방을 열지 못했습니다. 다시 선택해 주세요.', 'Could not open the chat. Try selecting it again.') : countText,
      status: updating ? labels.updatePreparing : show ? '' : visible.status === 'error'
        ? text('화면을 불러오지 못했습니다. 새로고침을 눌러 다시 시도해 주세요.', 'Could not load this view. Use Reload to try again.')
        : shownChat ? text('대화방을 여는 중입니다.', 'Opening chat…')
        : friendsView ? text('친구 목록을 불러오는 중입니다.', 'Loading friends…') : text('채팅 목록을 불러오는 중입니다.', 'Loading chats…'),
    };
    window.webContents.send('onlydm:state', { ...state, settingsOpen: settingsOpen && settingsInShell, settingsOverlayOpen });
    if (settingsOverlayOpen) {
      // A DOM dialog cannot cover a sibling native view. Give it a transparent view above the list.
      const layer = getSettingsLayer();
      layer.view.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: Math.max(0, height - TITLEBAR_HEIGHT) });
      if (layer.ready) {
        layer.view.webContents.send('onlydm:state', { ...state, profiles: [], roster: [], newChatOpen: false });
        layer.view.setVisible(true);
      }
    } else {
      disposeSettingsLayer();
    }
    for (const remote of allChats()) {
      const room = remote.window;
      if (!room || room.isDestroyed() || !remote.shellReady) continue;
      const bounds = room.getContentBounds();
      remote.view.setBounds({ x: 0, y: TITLEBAR_HEIGHT + HEADER_HEIGHT, width: bounds.width,
        height: Math.max(0, bounds.height - TITLEBAR_HEIGHT - HEADER_HEIGHT) });
      remote.view.setVisible(remote.status === 'ready' && !updating && room.isVisible());
      const title = contacts.display(remote.target.href, remote.title, remote.key) || text('대화', 'Chat');
      room.setTitle(title + ' - OnlyDM');
      room.setBackgroundColor(palette.surface);
      if (process.platform !== 'darwin') room.setTitleBarOverlay({ color: palette.chrome, symbolColor: palette.chromeText, height: TITLEBAR_HEIGHT });
      room.webContents.send('onlydm:state', { ...state, pane: 'chat', title, hint: '',
        chatControls: remote.controls || { voice: false, video: false, info: false },
        chatRenameEnabled: remote.status === 'ready', settingsOpen: false, newChatOpen: false,
        status: updating ? labels.updatePreparing : remote.status === 'ready' ? ''
          : remote.status === 'error' ? text('대화방을 불러오지 못했습니다. 새로고침해 주세요.', 'Could not load the chat. Use Reload.')
            : text('대화방을 여는 중입니다.', 'Opening chat…') });
    }
    tray?.refresh();
  }

  function command(remote, data) {
    if (isCurrent(remote)) remote.contents.send('onlydm:command', data);
  }

  function repaint() {
    const systemDark = nativeTheme.shouldUseDarkColors;
    command(inbox, { type: 'set-theme', palette: appPalette(settings.chatTheme, settings.appColors, systemDark) });
    command(chat, { type: 'set-theme', palette: chatPalette(settings.chatTheme, settings.chatColors, systemDark) });
    for (const remote of chatCache.values())
      command(remote, { type: 'set-theme', palette: chatPalette(settings.chatTheme, settings.chatColors, systemDark) });
    command(friends, { type: 'set-theme', palette: appPalette(settings.chatTheme, settings.appColors, systemDark) });
  }

  function pushNames() {
    command(inbox, { type: 'nicknames', map: contacts.byThread() });
    command(friends, { type: 'nicknames', map: contacts.byHandle() });
    for (const remote of allChats()) command(remote, { type: 'names', title: remote.title,
      shown: contacts.display(remote.target.href, remote.title, remote.key), people: contacts.byHandle() });
    sync();
  }

  function systemThemeChanged() { if (settings.chatTheme === 'system') { repaint(); sync(); } }
  nativeTheme.on('updated', systemThemeChanged);

  async function confirmCloseForMaintenance() {
    if (updating || closed) return false;
    updating = true;
    sync();
    let proceed = false;
    try {
      let draft = false;
      for (const candidate of new Set([chat, ...chatCache.values()])) {
        if (!isCurrent(candidate) || currentRoute(candidate)?.kind !== 'thread') continue;
        let timer;
        try {
          const present = await Promise.race([
            candidate.contents.executeJavaScriptInIsolatedWorld(1001, [{ code: '(' + draftPresence.toString() + ')()' }]),
            new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); }),
          ]);
          if (present === true || (present === null && draft !== true)) draft = present;
        } catch { draft = null; } finally { clearTimeout(timer); }
      }
      if (draft !== false) {
        const message = draft === true
          ? text('보내지 않은 메시지가 있습니다. 앱을 다시 시작하면 초안이 사라집니다. 계속할까요?',
            'There are unsent messages. Restarting the app discards drafts. Continue?')
          : text('초안을 확인하지 못했습니다. 앱을 다시 시작하면 입력 중인 내용이 사라질 수 있습니다. 계속할까요?',
            'Drafts could not be checked. Restarting may discard unsent content. Continue?');
        proceed = confirmDiscardDrafts ? await confirmDiscardDrafts(message) === true
          : (await dialog.showMessageBox(window, { type: 'warning', message, buttons: [text('계속', 'Continue'), text('취소', 'Cancel')],
            defaultId: 1, cancelId: 1, noLink: true })).response === 0;
      } else proceed = true;
      return proceed;
    } finally {
      if (!proceed) { updating = false; sync(); }
    }
  }

  async function checkForUpdates() {
    if (!updates || checkingUpdate || updating || closed) return;
    checkingUpdate = true;
    try { availableUpdate = await updates.check(); }
    catch { /* A failed public version check never interrupts messaging. */ }
    finally { checkingUpdate = false; if (!closed) sync(); }
  }

  async function installUpdate() {
    if (!updates || !availableUpdate || pendingOpen || accountSwitching || settingsOpen) return;
    try {
      if (!await confirmCloseForMaintenance()) return;
      await updates.start(availableUpdate);
      app.quit();
    } catch {
      updating = false;
      sync();
      if (!closed) await dialog.showMessageBox(window, { type: 'error',
        message: text('업데이트를 시작하지 못했습니다. 현재 앱을 계속 사용할 수 있습니다.',
          'Could not start the update. You can keep using the current app.') });
    }
  }

  function resetOpen(failed = false) {
    if (pendingOpen) clearTimeout(pendingOpen.timer);
    pendingOpen = null;
    openFailed = failed;
    newChatBusy = false;
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
    if (!remote || remote.disposed) return;
    remote.disposed = true;
    clearTimeout(remote.deadline);
    for (const [event, listener] of remote.listeners) remote.contents.removeListener(event, listener);
    const owner = remote.window || window;
    if (!owner.isDestroyed()) owner.contentView.removeChildView(remote.view);
    if (!remote.contents.isDestroyed()) remote.contents.close({ waitForBeforeUnload: false });
    if (remote.window && !remote.window.isDestroyed()) remote.window.destroy();
  }

  function removeChat(keep = false) {
    const remote = chat;
    chat = null;
    if (keep && remote) {
      remote.view.setVisible(false);
      chatCache.delete(remote.target.id);
      chatCache.set(remote.target.id, remote);
      while (chatCache.size > 2) {
        const oldest = chatCache.keys().next().value;
        disposeRemote(chatCache.get(oldest));
        chatCache.delete(oldest);
      }
    } else {
      if (remote) chatCache.delete(remote.target.id);
      disposeRemote(remote);
    }
  }

  function clearChats() {
    const rooms = allChats();
    chat = null;
    chatCache.clear();
    for (const remote of rooms) disposeRemote(remote);
  }

  function resetAccountPanel() {
    accountSwitching = false;
    clearTimeout(accountPanelTimer);
    accountPanelTimer = null;
  }

  function linkedProfile() {
    if (accountSwitching || hasInlineChat() || pendingOpen || inbox.status !== 'ready' || currentRoute(inbox)?.kind !== 'inbox') return;
    accountSwitching = true;
    const remote = inbox;
    accountPanelTimer = setTimeout(() => {
      if (isCurrent(remote) && accountSwitching) replaceInbox();
    }, OPEN_TIMEOUT);
    command(inbox, { type: 'open-account-panel' });
  }

  function replaceInbox() {
    if (updating) return;
    const previous = inbox;
    pendingNotification = null;
    inbox = null;
    resetAccountPanel();
    query = '';
    counts = null;
    resetOpen();
    clearChats();
    disposeRemote(friends);
    friends = null;
    friendsView = false;
    friendsCount = null;
    newChatOpen = false;
    contacts = openContacts(app.getPath('userData'), contactIdentity());
    calls.close();
    disposeRemote(previous);
    background.sync(profiles.list.map(({ id }) => id), profiles.activeId);
    inbox = makeRemote('inbox', profileSession());
    if (shellLoaded) load(inbox, INBOX);
  }

  function goBack() {
    if (updating) return;
    if (!chat) return;
    if (chat.window) { hideChat(chat); return; }
    removeChat(true);
    if (currentRoute(inbox)?.kind === 'inbox') {
      // Keep the list viewport at Instagram's desktop breakpoint.
      inbox.contents.setZoomFactor(INBOX_ZOOM);
    }
    if (friendsView && friends) friends.contents.setZoomFactor(FRIENDS_ZOOM);
    sync();
    const remote = active();
    if (remote?.status === 'ready') remote.contents.focus();
  }

  function openChat(route, title, key = '', pendingCall = null) {
    if (updating) return;
    if (hasInlineChat() || route?.kind !== 'thread') return;
    resetOpen();
    const cached = chatCache.get(route.id);
    chatCache.delete(route.id);
    while (!separateChatWindows && chatCache.size >= 2) {
      const oldest = chatCache.keys().next().value;
      disposeRemote(chatCache.get(oldest));
      chatCache.delete(oldest);
    }
    let roomWindow = null;
    let remote;
    if (!cached && separateChatWindows) roomWindow = createChatWindow({
      icon: windowIcon({ isPackaged: app.isPackaged }), palette: appPalette(settings.chatTheme, settings.appColors, nativeTheme.shouldUseDarkColors),
      lang, title, onReady: () => { if (remote && isCurrent(remote)) { remote.shellReady = true; sync(); } },
      onHide: () => { if (remote && isCurrent(remote)) hideChat(remote); },
      onDestroyed: () => {
        if (!remote) return;
        if (chatCache.get(route.id) === remote) chatCache.delete(route.id);
        if (chat === remote) chat = null;
        disposeRemote(remote);
      },
    });
    chat = remote = cached && !cached.contents.isDestroyed() ? cached : makeRemote('chat', inbox.contents.session, route, title, roomWindow);
    if (remote.window) {
      chatCache.set(route.id, remote);
      if (!cached) {
        remote.window.on('resize', sync);
        remote.window.on('show', sync);
        remote.window.on('hide', sync);
        remote.window.on('focus', () => { if (!remote.disposed) chat = remote; });
      } else {
        if (remote.window.isMinimized()) remote.window.restore();
        remote.window.show();
        remote.window.focus();
      }
    }
    chat.key = key;
    chat.pendingCall = pendingCall;
    contacts.rememberThread(key || route.href, route.href, title);
    sync();
    if (!cached || chat.status !== 'ready') load(chat, route.href);
    else {
      chat.contents.setZoomFactor(1);
      if (pendingCall) { chat.pendingCall = null; chatAction(pendingCall); }
      pushNames();
      chat.contents.focus();
    }
  }

  function hideChat(remote) {
    if (!remote?.window || remote.disposed) return;
    remote.window.hide();
    chatCache.delete(remote.target.id);
    chatCache.set(remote.target.id, remote);
    const hidden = [...chatCache.values()].filter(candidate => candidate.window && !candidate.window.isVisible());
    while (hidden.length > 2) {
      const oldest = hidden.shift();
      chatCache.delete(oldest.target.id);
      if (chat === oldest) chat = null;
      disposeRemote(oldest);
    }
    sync();
  }

  function ensureFriends() {
    if (friends || !/^[A-Za-z0-9._]{1,30}$/.test(ownHandle())) return;
    friends = makeRemote('friends', profileSession());
    load(friends, 'https://www.instagram.com/' + ownHandle() + '/');
  }

  function showFriends() {
    if (hasInlineChat() || pendingOpen || accountSwitching || inbox.status !== 'ready') return;
    settingsOpen = false;
    query = '';
    friendsView = true;
    ensureFriends();
    if (friends?.status === 'ready') {
      friends.contents.setZoomFactor(FRIENDS_ZOOM);
      command(friends, { type: 'friends-filter', query: '' });
    }
    sync();
  }

  function showChats() {
    if (hasInlineChat() || accountSwitching) return;
    friendsView = false;
    query = '';
    inbox.contents.setZoomFactor(INBOX_ZOOM);
    command(inbox, { type: 'filter-threads', query: '', aliases: [] });
    sync();
  }

  function beginOpen(key, action, mode = null) {
    if (pendingOpen || hasInlineChat() || accountSwitching || inbox.status !== 'ready') return false;
    const timer = setTimeout(() => {
      if (pendingOpen?.timer !== timer) return;
      resetOpen(true);
      sync();
    }, action.type === 'new-room' ? 90000 : OPEN_TIMEOUT);
    pendingOpen = { key, timer, action: action.type, mode };
    openFailed = false;
    command(inbox, action);
    sync();
    return true;
  }

  function requestOpen(message) {
    const key = typeof message.key === 'string' ? message.key.slice(0, 512) : '';
    const title = typeof message.title === 'string' ? message.title.trim().slice(0, 200) : '';
    const direct = routeFor(message.href) || routeFor(key) || routeFor(contacts.threadUrl(key));
    if (direct?.kind === 'thread') openChat(direct, title, key);
    else if (key) beginOpen(key, { type: 'open-row', key, title });
  }

  function openFriend(message) {
    if (!/^[A-Za-z0-9._]{1,30}$/.test(message.handle || '')) return;
    const mode = ['voice', 'video'].includes(message.mode) ? message.mode : null;
    beginOpen('', { type: 'open-friend', handle: message.handle,
      name: typeof message.name === 'string' ? message.name.slice(0, 200) : message.handle }, mode);
  }

  function renameChat(value, remote = chat) {
    if (!remote || remote.status !== 'ready' || typeof value !== 'string' || value.length > 200) return;
    const name = value.trim().normalize('NFC');
    const alias = name === remote.title ? '' : name;
    const handle = contacts.handleForThread(remote.target.href);
    const saved = handle ? contacts.setAlias(handle, alias) : contacts.setRoomAlias(remote.target.href, alias);
    settingsError = !saved;
    pushNames();
  }

  function chatAction(action, remote = chat) {
    if (!remote || remote.status !== 'ready' || !['voice', 'video', 'info'].includes(action) || !remote.controls?.[action]) return;
    command(remote, action === 'info' ? { type: 'toggle-info' } : { type: 'start-call', mode: action });
  }

  function setPreference(key, value) {
    if (!settings.setPreference(key, value)) { settingsError = true; sync(); return; }
    settingsError = false;
    if (key === 'language' && lang !== resolveLanguage()) {
      lang = resolveLanguage();
      labels = makeLabels();
      scripts.inbox = readFileSync(path.join(generated, 'inbox-' + lang + '-' + theme + '.js'), 'utf8');
      scripts.friends = readFileSync(path.join(generated, 'friends-' + lang + '-' + theme + '.js'), 'utf8');
      scripts.language = readFileSync(path.join(generated, 'language-' + lang + '.js'), 'utf8');
      disposeRemote(friends);
      friends = null;
      if (friendsView) ensureFriends();
      if (currentRoute(inbox)?.kind === 'inbox') {
        inbox.languagePending = true;
        load(inbox, 'https://www.instagram.com/accounts/language/');
      }
    }
    sync();
  }

  async function logout() {
    if (accountSwitching || pendingOpen || !await confirmCloseForMaintenance()) return;
    try {
      calls.close();
      background.sync([], profiles.activeId);
      await profileSession().clearStorageData();
      updating = false;
      settingsOpen = false;
      replaceInbox();
    } catch {
      updating = false;
      settingsError = true;
      sync();
    }
  }

  function showWindow() {
    if (closed || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    if (settingsLayer?.ready) settingsLayer.view.webContents.focus();
  }

  function trayAction(action, value) {
    if (closed || updating) return;
    if (action === 'show') showWindow();
    else if (action === 'settings') { showWindow(); if (!separateChatWindows) goBack(); settingsOpen = true; sync(); }
    else if (action === 'quit') void confirmCloseForMaintenance().then(proceed => { if (proceed) app.quit(); });
    else if (action === 'work-mode') { settingsError = !settings.setWorkMode(value); sync(); }
    else if (action === 'theme') { settingsError = !settings.setChatTheme(value, settings.chatColors, settings.appColors); repaint(); sync(); }
    else if (action === 'auto-start') { settingsError = !autoStart.set(value); sync(); }
    else if (['notifications', 'notification-preview', 'start-in-tray'].includes(action))
      setPreference({ notifications: 'notificationsEnabled', 'notification-preview': 'notificationPreviewEnabled', 'start-in-tray': 'startInTray' }[action], value);
  }

  function authFinishedAtRoot(event, remote) {
    const url = instagramUrl(event.url);
    if (url?.pathname === '/' && currentRoute(remote)?.kind === 'login') {
      queueMicrotask(() => load(remote, INBOX));
    }
  }

  function makeRemote(kind, instagram, target = null, title = '', roomWindow = null) {
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
    const remote = { view, contents, kind, target, title, window: roomWindow, status: 'loading', injected: false, deadline: null };
    view.setVisible(false);
    (roomWindow || window).contentView.addChildView(view);
    if (!roomWindow && settingsLayer) window.contentView.addChildView(settingsLayer.view);
    contents.setWindowOpenHandler(details => {
      if (remote.kind === 'chat' && remote.status === 'ready' && currentRoute(remote)?.kind === 'thread')
        calls.open(details, instagram);
      return { action: 'deny' };
    });

    const guardNavigation = (event) => {
      if (!event.isMainFrame) return;
      if (!isCurrent(remote)) {
        event.preventDefault();
        return;
      }
      const route = remoteRoute(remote, event.url);
      if (route?.kind === 'login' || (kind === 'inbox' ? ['inbox', 'language'].includes(route?.kind)
        : kind === 'friends' ? route?.kind === 'profile' : route?.id === target.id)) {
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
      'before-input-event': (event, input) => {
        if (input.type !== 'keyDown' || input.key !== 'F5' || updating) return;
        event.preventDefault();
        load(remote, remote.kind === 'friends' ? 'https://www.instagram.com/' + ownHandle() + '/'
          : remote.target?.href || INBOX);
      },
      'dom-ready': () => prepare(remote),
      'did-navigate-in-page': (_event, _url, isMainFrame) => {
        if (!isMainFrame || !isCurrent(remote)) return;
        const route = currentRoute(remote);
        if (kind === 'inbox' && route?.kind === 'thread' && (pendingOpen || chat)) {
          sync(); // The shared projection is resolving the address and will go back.
        } else if (route?.kind === 'login' || (kind === 'inbox' ? route?.kind === 'inbox'
          : kind === 'friends' ? route?.kind === 'profile' : route?.id === target.id)) {
          prepare(remote);
        } else {
          fail(remote);
          load(remote, kind === 'inbox' ? INBOX : kind === 'friends' ? 'https://www.instagram.com/' + ownHandle() + '/' : target.href);
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
    if (route?.kind === 'language' && remote === inbox) {
      void remote.contents.executeJavaScriptInIsolatedWorld(1001, [{ code: scripts.language }])
        .then(result => {
          if (!isCurrent(remote)) return;
          remote.languagePending = false;
          if (result !== lang) settingsError = true;
          load(remote, INBOX);
        }).catch(() => fail(remote));
      return;
    }
    if (route?.kind === 'login') {
      if (remote !== inbox) {
        if (remote.kind === 'chat') clearChats();
        if (remote === friends) { disposeRemote(friends); friends = null; friendsView = false; }
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

    if (remote === inbox ? route?.kind !== 'inbox'
      : remote === friends ? route?.kind !== 'profile' : route?.id !== remote.target.id) {
      fail(remote);
      return;
    }
    if (remote.injected) {
      sync();
      return;
    }
    // Navigations reset the zoom. Set it before the projection measures the page.
    remote.contents.setZoomFactor(remote === inbox ? INBOX_ZOOM : remote === friends ? FRIENDS_ZOOM : 1);
    remote.injected = true;
    remote.status = 'loading';
    clearTimeout(remote.deadline);
    remote.deadline = setTimeout(() => fail(remote), DOCUMENT_TIMEOUT);
    sync();
    let script = scripts.inbox;
    if (remote === inbox)
      script = 'const __onlydmInboxPalette = ' + JSON.stringify(appPalette(settings.chatTheme, settings.appColors, nativeTheme.shouldUseDarkColors)) + ';\n' + script;
    if (remote === friends)
      script = 'const __onlydmFriendsPalette = ' + JSON.stringify(appPalette(settings.chatTheme, settings.appColors, nativeTheme.shouldUseDarkColors))
        + ';\n' + scripts.friends;
    if (remote.kind === 'chat') {
      const mode = settings.chatTheme === 'system' ? nativeTheme.shouldUseDarkColors ? 'dark' : 'light' : settings.chatTheme;
      const colors = mode === 'custom' ? settings.chatColors : null;
      script = 'const __onlydmChatColors = ' + JSON.stringify(colors) + ';\n'
        + (mode === 'dark' ? scripts.chatDark : scripts.chatLight);
    }
    const frame = remote.contents.mainFrame;
    void remote.contents.executeJavaScriptInIsolatedWorld(1001, [
      { code: isolatedPrelude + script + '\n})();' },
    ]).then(() => {
      if (!isCurrent(remote)) return;
      repaint();
      if (remote === friends && contacts.friends.length)
        command(friends, { type: 'friends-seed', people: contacts.friends });
    }).catch(() => {
      if (isCurrent(remote) && remote.contents.mainFrame === frame) fail(remote);
    });
  }

  function markReady(remote) {
    clearTimeout(remote.deadline);
    remote.status = 'ready';
    sync();
    if (remote === active() && !settingsOpen && !updating) remote.contents.focus();
  }

  function openChatLink(remote, href) {
    if (remote.status !== 'ready' || !remote.view.getVisible() || typeof href !== 'string'
        || href.length > 8192 || !/^https?:\/\//i.test(href) || /[\x00-\x20\x7f]/.test(href)) return;
    let url;
    try { url = new URL(href); } catch { return; }
    // The authority must be the bare host, with no user info.
    if (!url.hostname || !url.href.startsWith(url.origin + '/')) return;
    void Promise.resolve().then(() => openExternal(url.href)).catch(() => {
      console.error('OnlyDM could not open a link in the browser.');
    });
  }

  function onProjection(event, message) {
    if (background.onProjection(event, message)) return;
    const remote = event.sender === inbox?.contents ? inbox : event.sender === chat?.contents ? chat
      : event.sender === friends?.contents ? friends
      : [...chatCache.values()].find(candidate => event.sender === candidate.contents);
    if (!isCurrent(remote) || !event.senderFrame || event.senderFrame !== remote.contents.mainFrame || !message || typeof message !== 'object') return;
    const route = remoteRoute(remote, event.senderFrame.url);
    if (remote === friends) {
      if (route?.kind !== 'profile') return;
      if (message.type === 'friends-roster') { contacts.setFriends(message.people); pushNames(); }
      else if (message.type === 'friends-ready') {
        markReady(friends);
        command(friends, { type: 'nicknames', map: contacts.byHandle() });
        if (query) command(friends, { type: 'friends-filter', query });
      } else if (message.type === 'friends-count') { friendsCount = message.count; sync(); }
      else if (message.type === 'set-alias') { settingsError = !contacts.setAlias(message.handle, message.alias); pushNames(); }
      else if (['open-friend-chat', 'open-friend-call'].includes(message.type)) openFriend(message);
      else if (message.type === 'switch-account') { friendsView = false; linkedProfile(); sync(); }
      else if (message.type === 'close-window') window.hide();
      else if (message.type === 'friends-error') { if (!contacts.friends.length) fail(friends); }
      return;
    }
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
        pushNames();
        if (query && !friendsView) command(inbox, { type: 'filter-threads', query, aliases: contacts.aliasesFor(query) });
        if (pendingNotification) {
          const requested = pendingNotification;
          pendingNotification = null;
          if (requested.profileId === profiles.activeId
            && (!requested.handle || requested.handle === ownHandle().toLowerCase())) requestOpen(requested);
        }
      } else if (message.type === 'thread-notification' && route.kind === 'inbox' && inbox.status === 'ready' && inbox.injected) {
        threadNotification(profiles.activeId, message);
      } else if (message.type === 'own-profile' && route.kind === 'inbox') {
        const previousHandle = ownHandle();
        if (profiles.setHandle(message.username)) {
          if (previousHandle && previousHandle.toLowerCase() !== ownHandle().toLowerCase()) {
            pendingNotification = null;
            clearChats();
            calls.close();
          }
          const previous = contacts;
          contacts = openContacts(app.getPath('userData'), contactIdentity());
          if (friends) { disposeRemote(friends); friends = null; }
          if (friendsView || newChatOpen) ensureFriends();
          if (previous !== contacts) pushNames();
        }
      } else if (message.type === 'inbox-count') {
        if (!Number.isSafeInteger(message.count) || !Number.isSafeInteger(message.unread)) return;
        counts = { count: Math.max(0, message.count), unread: Math.max(0, message.unread) };
        sync();
      } else if (message.type === 'request-open' && inbox.status === 'ready' && route.kind === 'inbox' && !hasInlineChat() && !pendingOpen && !settingsOpen) {
        requestOpen(message);
      } else if (message.type === 'open-thread' && pendingOpen
        && (key === pendingOpen.key || ['open-friend', 'new-room'].includes(pendingOpen.action))) {
        const mode = pendingOpen.mode;
        openChat(routeFor(message.href), title, key, mode);
        pushNames();
      } else if (message.type === 'need-inbox') {
        load(inbox, INBOX);
      } else if (message.type === 'projection-error' && ['open', 'new-room', 'new-chat'].includes(message.stage) && pendingOpen) {
        resetOpen(true);
        sync();
      } else if (message.type === 'close-window') {
        window.hide();
      }
    } else if (route?.kind === 'thread' && route.id === remote.target.id) {
      if (message.type === 'chat-ready') { markReady(remote); pushNames(); }
      if (message.type === 'chat-controls') {
        remote.controls = { voice: message.voice === true, video: message.video === true, info: message.info === true };
        if (remote.pendingCall && remote.controls[remote.pendingCall]) {
          const mode = remote.pendingCall;
          remote.pendingCall = null;
          command(remote, { type: 'start-call', mode });
        }
        sync();
      }
      if (message.type === 'thread-person' && contacts.linkPerson(remote.target.href, message.handle)) pushNames();
      if (message.type === 'open-external-link') openChatLink(remote, message.href);
      if (message.type === 'thread-title' && typeof message.title === 'string' && !remote.title) {
        remote.title = message.title.trim().slice(0, 200);
        contacts.rememberThread(remote.key || remote.target.href, remote.target.href, remote.title);
        pushNames();
      }
      if (message.type === 'close-window') {
        if (remote.window) hideChat(remote);
        else if (remote === chat) goBack();
      }
    }
  }

  const from = (event, contents) => contents && event.sender === contents && event.senderFrame === contents.mainFrame;
  const fromSettings = event => settingsOpen && from(event, settingsInShell ? window.webContents : settingsLayer?.view.webContents);
  const shellCommand = handler => (event, value) => {
    if (!closed && !updating && from(event, window.webContents)) handler(value);
  };
  const settingsCommand = handler => (event, value) => {
    if (!closed && !updating && fromSettings(event)) handler(value);
  };
  const roomCommand = handler => (event, value) => {
    if (closed || updating) return;
    const remote = allChats().find(candidate => candidate.window?.webContents === event.sender
      && event.senderFrame === event.sender.mainFrame);
    if (remote) handler(value, remote);
    else if (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame) handler(value);
  };
  const handlers = new Map([
    ['onlydm:projection', onProjection],
    ['onlydm:back', roomCommand((_value, remote) => remote?.window ? hideChat(remote) : goBack())],
    ['onlydm:update', shellCommand(() => { void installUpdate(); })],
    ['onlydm:show-friends', shellCommand(showFriends)],
    ['onlydm:show-chats', shellCommand(showChats)],
    ['onlydm:hide', roomCommand((_value, remote) => remote?.window ? hideChat(remote) : window.hide())],
    ['onlydm:chat-action', roomCommand(chatAction)],
    ['onlydm:rename-chat', roomCommand(renameChat)],
    ['onlydm:preference', settingsCommand((choice) => {
      if (choice && typeof choice === 'object') setPreference(choice.key, choice.value);
    })],
    ['onlydm:auto-start', settingsCommand((enabled) => {
      settingsError = !autoStart.set(enabled);
      sync();
    })],
    ['onlydm:logout', settingsCommand(() => { void logout(); })],
    ['onlydm:new-chat', shellCommand((open) => {
      if (typeof open !== 'boolean' || hasInlineChat() || pendingOpen || accountSwitching || inbox.status !== 'ready') return;
      newChatOpen = open;
      settingsOpen = false;
      if (open) ensureFriends();
      sync();
    })],
    ['onlydm:create-chat', shellCommand((handles) => {
      if (!newChatOpen || newChatBusy || !Array.isArray(handles) || !handles.length || handles.length > 50) return;
      const unique = [...new Set(handles)];
      if (unique.some(handle => typeof handle !== 'string' || !contacts.friends.some(person => person.handle === handle))) return;
      newChatOpen = false;
      if (beginOpen('', { type: 'new-room', handles: unique })) newChatBusy = true;
      sync();
    })],
    ['onlydm:settings', (event, open) => {
      if (closed || updating || typeof open !== 'boolean') return;
      if (open ? !from(event, window.webContents) || hasInlineChat() || accountSwitching || pendingOpen
        : !fromSettings(event)) return;
      settingsOpen = open;
      if (open) newChatOpen = false;
      settingsError = false;
      sync();
      if (!open) window.webContents.focus();
    }],
    ['onlydm:work-mode', settingsCommand((enabled) => {
      if (typeof enabled !== 'boolean') return;
      settingsError = !settings.setWorkMode(enabled);
      sync();
    })],
    ['onlydm:chat-theme', settingsCommand((choice) => {
      settingsError = !settings.setChatTheme(choice?.chatTheme, choice?.chatColors, choice?.appColors);
      if (!settingsError) repaint();
      sync();
    })],
    ['onlydm:linked-profile', shellCommand(linkedProfile)],
    ['onlydm:retry', roomCommand((_value, room) => {
      if (room) { load(room, room.target.href); return; }
      if (accountSwitching) {
        replaceInbox();
        return;
      }
      const remote = active();
      load(remote, remote === friends ? 'https://www.instagram.com/' + ownHandle() + '/'
        : remote.target?.href || (remote.status === 'login' ? currentRoute(remote)?.href : null) || INBOX);
    })],
    ['onlydm:search', shellCommand((value) => {
      if (accountSwitching || typeof value !== 'string') return;
      query = value.slice(0, 200);
      if (friendsView && friends?.status === 'ready') command(friends, { type: 'friends-filter', query });
      else if (inbox.status === 'ready') command(inbox, { type: 'filter-threads', query, aliases: contacts.aliasesFor(query) });
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
  tray = createTray({ getState: () => ({ lang, theme: settings.chatTheme,
    workModeEnabled: settings.workModeEnabled, notificationsEnabled: settings.notificationsEnabled,
    notificationPreviewEnabled: settings.notificationPreviewEnabled, startInTray: settings.startInTray,
    autoStart: autoStart.enabled, unreadCount: counts?.unread || 0 }), onAction: trayAction,
    icon: windowIcon({ isPackaged: app.isPackaged }), lang });
  for (const [channel, handler] of handlers) ipcMain.on(channel, handler);
  window.on('resize', sync);
  window.on('closed', () => {
    closed = true;
    clearInterval(updateTimer);
    nativeTheme.removeListener('updated', systemThemeChanged);
    resetAccountPanel();
    resetOpen();
    for (const [channel, handler] of handlers) ipcMain.removeListener(channel, handler);
    background.close();
    calls.close();
    tray?.destroy();
    for (const notification of notifications) {
      notification.removeAllListeners();
      notification.close();
    }
    notifications.clear();
    disposeSettingsLayer();
    clearChats();
    disposeRemote(inbox);
    disposeRemote(friends);
    for (const instagram of securedSessions) instagram.removeListener('will-download', stopDownload);
  });

  await window.loadFile(path.join(__dirname, 'shell.html'));
  shellLoaded = true;
  sync();
  if (updates) {
    void checkForUpdates();
    updateTimer = setInterval(() => { void checkForUpdates(); }, 6 * 60 * 60 * 1000);
    updateTimer.unref();
  }
  if (!settings.startInTray || !tray.available) window.show();
  load(inbox, INBOX);
  return { window, confirmCloseForMaintenance, show: showWindow,
    get hasTray() { return tray.available; }, get hideAtStartup() { return settings.startInTray && tray.available; },
    get settingsContents() { return settingsOpen ? (settingsInShell ? window.webContents : settingsLayer?.view.webContents) : undefined; },
    get inbox() { return inbox.view; }, get friends() { return friends?.view; }, get chat() { return chat?.view; },
    get chatWindow() { return chat?.window; }, get chatWindows() { return allChats().map(room => room.window).filter(Boolean); } };
}

module.exports = { createOnlyDM, PARTITION };

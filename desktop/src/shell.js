'use strict';

if (window.location?.search === '?view=settings') document.body.dataset.layer = 'settings';
const modalBackground = document.querySelectorAll('body > :is(nav, header, main)');

const back = document.querySelector('#back');
const retry = document.querySelector('#retry');
const search = document.querySelector('#search');
const heading = document.querySelector('#room-title');
const hint = document.querySelector('#hint');
const status = document.querySelector('#status');
const profiles = document.querySelector('#profiles');
const settings = document.querySelector('#settings');
const rail = document.querySelector('#nav-rail');
const settingsDialog = document.querySelector('#settings-dialog');
const settingsHeading = document.querySelector('#settings-heading');
const settingsClose = document.querySelector('#settings-close');
const workMode = document.querySelector('#work-mode');
const workModeLabel = document.querySelector('#work-mode-label');
const workModeDescription = document.querySelector('#work-mode-description');
const settingsError = document.querySelector('#settings-error');
const chatTheme = document.querySelector('#chat-theme');
const chatCustomColors = document.querySelector('#chat-custom-colors');
const chatPreview = document.querySelector('#chat-preview');
const chatHexError = document.querySelector('#chat-hex-error');
const chatApply = document.querySelector('#chat-theme-apply');
const chatThemeLabels = document.querySelectorAll('[data-theme-label]');
const colorsApi = window.onlydmColors;
const appPreview = document.querySelector('#app-preview');
const colorTarget = document.querySelector('#color-target');
const spectrum = document.querySelector('#color-spectrum');
const spectrumMarker = document.querySelector('#color-spectrum-marker');
const hueSlider = document.querySelector('#color-hue');
const updateButton = document.querySelector('#update');
const chatsButton = document.querySelector('#chats-icon');
const friendsButton = document.querySelector('#friends-icon');
const newChatButton = document.querySelector('#new-chat');
const chatControls = document.querySelector('#chat-controls');
const chatActions = ['voice', 'video', 'info'].map(action => ({ action, button: document.querySelector('#chat-' + action) }));
const newChatDialog = document.querySelector('#new-chat-dialog');
const newChatForm = document.querySelector('#new-chat-form');
const newChatSearch = document.querySelector('#new-chat-search');
const newChatRoster = document.querySelector('#new-chat-roster');
const newChatEmpty = document.querySelector('#new-chat-empty');
const newChatCount = document.querySelector('#new-chat-count');
const newChatConfirm = document.querySelector('#new-chat-confirm');
const newChatCancel = document.querySelector('#new-chat-cancel');
const newChatClose = document.querySelector('#new-chat-close');
const language = document.querySelector('#language');
const systemLanguage = document.querySelector('#language-auto');
const preferences = [['notificationsEnabled', 'notifications-enabled'], ['notificationPreviewEnabled', 'notification-preview-enabled'],
  ['startInTray', 'start-in-tray']].map(([key, id]) => ({
  key, input: document.querySelector('#' + id),
}));
const autoStart = document.querySelector('#auto-start');
const logout = document.querySelector('#logout');
const chatFields = ['background', 'incoming', 'outgoing'].map(key => ({
  group: 'chat',
  key,
  picker: document.querySelector('#chat-' + key + '-color'),
  hex: document.querySelector('#chat-' + key + '-hex'),
}));
const appFields = ['chrome', 'background'].map(key => ({ group: 'app', key,
  picker: document.querySelector('#app-' + key + '-color'), hex: document.querySelector('#app-' + key + '-hex') }));
const colorFields = [...appFields, ...chatFields];
const addProfileId = '__add__';
const linkedProfileId = '__linked__';
let displayedProfiles = '';
let activeProfileId;
let savedChatTheme = 'system';
let savedChatColors = colorsApi.chatDefaults;
let savedAppColors = colorsApi.appDefaults;
let hsv = { hue: 0, saturation: 0, value: 1 };
let pickingSpectrum = false;
let shellState = {};
let labels = {};
let friendRoster = [];
let displayedRoster = '';
let renameOriginal = null;
let creatingChat = false;
const selectedFriends = new Set();

const normalizeHex = colorsApi.normalizeHex;
const previewTextColor = colorsApi.textOn;

function labelsFor(state, lang) {
  const text = (ko, en) => lang === 'ko' ? ko : en;
  return {
    back: text('목록으로', 'Back to chats'), retry: text('새로고침', 'Reload'),
    search: text('대화 검색', 'Search chats'), searchFriends: text('친구 검색', 'Search friends'),
    settings: text('설정', 'Settings'), close: text('닫기', 'Close'),
    chats: text('채팅', 'Chats'), friends: text('친구', 'Friends'), newChat: text('새 채팅', 'New chat'),
    voice: text('음성 통화', 'Voice call'), video: text('영상 통화', 'Video call'), info: text('채팅 정보', 'Chat info'),
    renameChat: text('채팅 이름 변경 (이 기기에만 적용)', 'Rename chat (on this device)'),
    newChatSearch: text('이름 또는 사용자 이름 검색', 'Search name or @handle'),
    newChatEmpty: text('선택할 친구가 없습니다.', 'No friends to select.'),
    newChatNoMatches: text('검색 결과가 없습니다.', 'No friends found.'),
    selectedCount: text('{count}명 선택', '{count} selected'),
    selectionLimit: text('최대 {count}명까지 선택할 수 있습니다.', 'You can select up to {count} people.'),
    confirm: text('확인', 'Confirm'), cancel: text('취소', 'Cancel'), creatingChat: text('만드는 중…', 'Creating…'),
    language: text('언어', 'Language'), systemLanguage: text('시스템 기본값', 'System default'),
    notificationsEnabled: text('알림', 'Notifications'), notificationPreviewEnabled: text('알림 미리보기', 'Notification previews'),
    startInTray: state.platform === 'darwin' ? text('메뉴 막대에서 시작', 'Start in menu bar') : text('트레이에서 시작', 'Start in tray'),
    autoStart: text('로그인할 때 자동 실행', 'Start at login'),
    logout: text('로그아웃', 'Log out'), update: text('업데이트', 'Update'),
    updatePreparing: text('업데이트를 준비하는 중입니다.', 'Preparing update.'),
    ...state.labels,
  };
}

function labelButton(button, text) {
  button.title = text;
  button.setAttribute('aria-label', text);
}

function syncModal(dialog, open) {
  if (open && !dialog.open) {
    dialog.showModal();
  } else if (!open && dialog.open) {
    dialog.close();
  }
}

function closeDialog(dialog) {
  if (dialog === newChatDialog) window.onlydm.newChat(false);
  else window.onlydm.settings(false);
}

function updateFriendSelection() {
  const busy = !!shellState.newChatBusy || creatingChat;
  const limit = shellState.newChatMaxRecipients;
  const atLimit = selectedFriends.size >= limit;
  const count = labels.selectedCount.replace('{count}', String(selectedFriends.size));
  newChatCount.textContent = atLimit ? `${count} · ${labels.selectionLimit.replace('{count}', String(limit))}` : count;
  newChatConfirm.textContent = busy ? labels.creatingChat : labels.confirm;
  newChatConfirm.disabled = !!shellState.updating || busy || !selectedFriends.size;
  newChatSearch.disabled = !!shellState.updating || busy;
  newChatForm.setAttribute('aria-busy', String(busy));
  for (const checkbox of newChatRoster.querySelectorAll('input')) {
    checkbox.disabled = !!shellState.updating || busy || (atLimit && !checkbox.checked);
  }
}

function renderFriendPicker() {
  const query = newChatSearch.value.trim().replace(/^@/, '').toLocaleLowerCase();
  const rows = [];
  for (const friend of friendRoster) {
    const name = (typeof friend.shown === 'string' && friend.shown) || friend.alias || friend.localAlias || friend.name || friend.handle;
    if (query && ![name, friend.name, friend.handle, friend.alias, friend.localAlias].some(value =>
      typeof value === 'string' && value.toLocaleLowerCase().includes(query))) continue;
    const row = document.createElement('label');
    row.className = 'friend-choice';
    const avatar = document.createElement('span');
    avatar.className = 'friend-avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = Array.from(name)[0] || '@';
    if (typeof friend.avatar === 'string' && /^(https:\/\/|data:image\/(png|jpeg|gif|webp|avif);)/i.test(friend.avatar)) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.src = friend.avatar;
      image.addEventListener('error', () => image.remove(), { once: true });
      avatar.append(image);
    }
    const details = document.createElement('span');
    details.className = 'friend-details';
    const displayName = document.createElement('strong');
    displayName.textContent = name;
    const handle = document.createElement('small');
    handle.textContent = '@' + friend.handle.replace(/^@/, '');
    details.append(displayName, handle);
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = friend.handle;
    checkbox.checked = selectedFriends.has(friend.handle);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedFriends.add(friend.handle);
      else selectedFriends.delete(friend.handle);
      updateFriendSelection();
    });
    row.append(avatar, details, checkbox);
    rows.push(row);
  }
  newChatRoster.replaceChildren(...rows);
  newChatEmpty.hidden = rows.length > 0;
  newChatEmpty.textContent = query ? labels.newChatNoMatches : labels.newChatEmpty;
  updateFriendSelection();
}

function finishRename(commit) {
  if (renameOriginal === null) return;
  const original = renameOriginal;
  renameOriginal = null;
  const name = heading.textContent.replace(/\s+/gu, ' ').trim();
  heading.textContent = commit && name ? name : original;
  if (commit && name !== original && shellState.pane === 'chat' && shellState.chatRenameEnabled && !shellState.updating)
    window.onlydm.renameChat(name);
}

function activeColorField() {
  return colorFields.find(field => field.group + ':' + field.key === colorTarget.value) || colorFields[0];
}
function syncSpectrum() {
  const color = normalizeHex(activeColorField().hex.value);
  if (color && !pickingSpectrum) hsv = colorsApi.hexHsv(color, hsv.hue);
  hueSlider.value = hsv.hue;
  spectrum.style.setProperty('--spectrum-hue', colorsApi.hsvHex(hsv.hue, 1, 1));
  spectrumMarker.style.left = hsv.saturation * 100 + '%';
  spectrumMarker.style.top = (1 - hsv.value) * 100 + '%';
  spectrum.setAttribute('aria-valuenow', String(Math.round(hsv.saturation * 100)));
  spectrum.setAttribute('aria-valuetext', colorsApi.hsvHex(hsv.hue, hsv.saturation, hsv.value));
  for (const row of document.querySelectorAll('[data-color-field]')) row.hidden = row.dataset.colorField !== colorTarget.value;
  for (const button of document.querySelectorAll('#color-presets button')) button.setAttribute('aria-pressed', String(button.title === color));
}

function updateChatDraft() {
  const custom = chatTheme.value === 'custom';
  chatCustomColors.hidden = !custom;
  const colors = custom ? {} : savedChatColors;
  const appColors = custom ? {} : savedAppColors;
  let valid = true;
  if (custom) {
    for (const { group, key, picker, hex } of colorFields) {
      const value = normalizeHex(hex.value);
      hex.setAttribute('aria-invalid', String(!value));
      if (value) {
        hex.removeAttribute('aria-describedby');
        if (picker.value !== value.toLowerCase()) picker.value = value;
        if (group === 'chat') {
          chatPreview.style.setProperty('--preview-' + key, value);
          chatPreview.style.setProperty('--preview-' + key + '-text', previewTextColor(value));
          colors[key] = value;
        } else {
          appPreview.style.setProperty('--preview-' + key, value);
          appPreview.style.setProperty('--preview-' + key + '-text', previewTextColor(value));
          appColors[key] = value;
        }
      } else {
        hex.setAttribute('aria-describedby', 'chat-hex-error');
        valid = false;
      }
    }
  }
  chatHexError.hidden = valid;
  chatApply.disabled = !!shellState.updating || !valid || (chatTheme.value === savedChatTheme
    && chatFields.every(({ key }) => colors[key] === savedChatColors[key])
    && appFields.every(({ key }) => appColors[key] === savedAppColors[key]));
  syncSpectrum();
  return valid ? { colors, appColors } : null;
}

chatTheme.addEventListener('change', updateChatDraft);
for (const field of colorFields) {
  const { group, key, picker, hex } = field;
  for (const input of [picker, hex]) input.addEventListener('focus', () => {
    colorTarget.value = group + ':' + key;
    syncSpectrum();
  });
  picker.addEventListener('input', () => {
    hex.value = normalizeHex(picker.value);
    updateChatDraft();
  });
  hex.addEventListener('input', updateChatDraft);
  hex.addEventListener('change', () => {
    const value = normalizeHex(hex.value);
    if (value) hex.value = value;
  });
}
chatApply.addEventListener('click', () => {
  const draft = updateChatDraft();
  if (chatApply.disabled || !draft) return;
  if (chatTheme.value === 'custom') {
    for (const { group, key, hex } of colorFields) hex.value = (group === 'chat' ? draft.colors : draft.appColors)[key];
  }
  window.onlydm.setChatTheme(chatTheme.value, draft.colors, draft.appColors);
});
colorTarget.addEventListener('change', syncSpectrum);
function applySpectrum() {
  pickingSpectrum = true;
  try {
    activeColorField().hex.value = colorsApi.hsvHex(hsv.hue, hsv.saturation, hsv.value);
    updateChatDraft();
  } finally { pickingSpectrum = false; }
}
function pickSpectrum(event) {
  const bounds = spectrum.getBoundingClientRect();
  if (!bounds.width || !bounds.height) return;
  hsv.saturation = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
  hsv.value = 1 - Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height));
  applySpectrum();
}
spectrum.addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  spectrum.focus();
  spectrum.setPointerCapture(event.pointerId);
  pickSpectrum(event);
});
spectrum.addEventListener('pointermove', event => {
  if (spectrum.hasPointerCapture(event.pointerId)) pickSpectrum(event);
});
spectrum.addEventListener('pointerup', event => {
  if (!spectrum.hasPointerCapture(event.pointerId)) return;
  pickSpectrum(event);
  spectrum.releasePointerCapture(event.pointerId);
});
spectrum.addEventListener('keydown', event => {
  const step = event.shiftKey ? .1 : .01;
  if (event.key === 'ArrowLeft') hsv.saturation = Math.max(0, hsv.saturation - step);
  else if (event.key === 'ArrowRight') hsv.saturation = Math.min(1, hsv.saturation + step);
  else if (event.key === 'ArrowUp') hsv.value = Math.min(1, hsv.value + step);
  else if (event.key === 'ArrowDown') hsv.value = Math.max(0, hsv.value - step);
  else return;
  event.preventDefault();
  applySpectrum();
});
hueSlider.addEventListener('input', () => { hsv.hue = Number(hueSlider.value); applySpectrum(); });
for (const color of ['#FFFFFF', '#F0F2F4', '#181C22', '#2A303A', '#4257C9', '#DBEAFE', '#DDF3E7', '#0F766E', '#A23861']) {
  const button = document.createElement('button');
  button.type = 'button';
  button.title = color;
  button.setAttribute('aria-label', color);
  button.style.backgroundColor = color;
  button.addEventListener('click', () => { activeColorField().hex.value = color; updateChatDraft(); });
  document.querySelector('#color-presets').append(button);
}
updateButton.addEventListener('click', () => window.onlydm.update());

profiles.addEventListener('change', () => {
  const id = profiles.value;
  if (id === linkedProfileId || id === addProfileId) {
    profiles.value = activeProfileId;
    if (id === linkedProfileId) window.onlydm.linkedProfile();
    else window.onlydm.addProfile();
  } else if (id && id !== activeProfileId) {
    window.onlydm.selectProfile(id);
  }
});
back.addEventListener('click', () => window.onlydm.back());
retry.addEventListener('click', () => window.onlydm.retry());
settings.addEventListener('click', () => window.onlydm.settings(true));
settingsClose.addEventListener('click', () => closeDialog(settingsDialog));
settingsDialog.addEventListener('cancel', () => {
  // The host owns the separate settings view, so release it on the native dismissal request.
  if (shellState.settingsOpen) closeDialog(settingsDialog);
});
newChatDialog.addEventListener('close', () => {
  if (!newChatDialog.open && shellState.newChatOpen) closeDialog(newChatDialog);
});
chatsButton.addEventListener('click', () => window.onlydm.showChats());
friendsButton.addEventListener('click', () => window.onlydm.showFriends());
newChatButton.addEventListener('click', () => window.onlydm.newChat(true));
for (const { action, button } of chatActions) button.addEventListener('click', () => {
  if (!button.disabled) window.onlydm.chatAction(action);
});
for (const button of [newChatCancel, newChatClose]) button.addEventListener('click', () => newChatDialog.requestClose());
newChatSearch.addEventListener('input', renderFriendPicker);
newChatForm.addEventListener('submit', event => {
  event.preventDefault();
  if (newChatConfirm.disabled) return;
  creatingChat = true;
  updateFriendSelection();
  window.onlydm.createChat([...selectedFriends]);
});
language.addEventListener('change', () => window.onlydm.setPreference('language', language.value));
for (const { key, input } of preferences) input.addEventListener('change', () => window.onlydm.setPreference(key, input.checked));
autoStart.addEventListener('change', () => window.onlydm.autoStart(autoStart.checked));
logout.addEventListener('click', () => window.onlydm.logout());
heading.addEventListener('focus', () => {
  if (heading.contentEditable === 'plaintext-only') renameOriginal = heading.textContent;
});
heading.addEventListener('blur', () => finishRename(true));
heading.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    heading.blur();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    finishRename(false);
    heading.blur();
  }
});
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.key !== 'Escape'
    || settingsDialog.open || newChatDialog.open || shellState.settingsOpen || shellState.settingsOverlayOpen || shellState.newChatOpen
    || event.target.closest?.('input,textarea,select,[contenteditable="plaintext-only"]')) return;
  event.preventDefault();
  window.onlydm.hide();
});
workMode.addEventListener('change', () => window.onlydm.setWorkMode(workMode.checked));
search.addEventListener('input', () => window.onlydm.search(search.value));
window.onlydm.onState((state) => {
  const lang = /^ko(?:-|$)/i.test(state.lang || (state.language === 'auto' || !state.language ? navigator.language : state.language)) ? 'ko' : 'en';
  labels = labelsFor(state, lang);
  const profileChanged = activeProfileId !== state.activeProfileId;
  const paneChanged = shellState.pane !== state.pane;
  const settingsOverlayClosed = shellState.settingsOverlayOpen && !state.settingsOverlayOpen;
  if (renameOriginal !== null && (profileChanged || paneChanged || !state.chatRenameEnabled || state.updating || state.title !== shellState.title))
    finishRename(false);
  if (shellState.newChatBusy || !state.newChatOpen) creatingChat = false;
  shellState = state;
  for (const element of modalBackground) element.inert = !!state.settingsOverlayOpen;
  document.documentElement.lang = lang;
  document.documentElement.classList.toggle('dark', state.dark);
  if (state.appPalette) {
    const palette = state.appPalette;
    for (const [variable, key] of Object.entries({ surface: 'surface', secondary: 'surfaceAlt', rail: 'rail', text: 'text',
      muted: 'muted', border: 'border', chrome: 'chrome', 'chrome-text': 'chromeText', 'chrome-muted': 'chromeMuted', 'chrome-hover': 'chromeHover' }))
      document.documentElement.style.setProperty('--' + variable, palette[key]);
    document.documentElement.style.colorScheme = palette.dark ? 'dark' : 'light';
    document.documentElement.style.setProperty('--chrome-scheme', palette.chromeText === '#FFFFFF' ? 'dark' : 'light');
  }
  updateButton.hidden = !state.updateAvailable;
  updateButton.disabled = !!state.updating;
  updateButton.title = state.updating ? labels.updatePreparing
    : state.updateAvailable ? labels.update + ' · ' + state.updateAvailable.version : labels.update;
  updateButton.setAttribute('aria-label', updateButton.title);
  for (const control of document.querySelectorAll('button,input,select')) {
    if (control === updateButton) continue;
    if (state.updating) control.disabled = true;
    else if (control !== chatApply) control.disabled = false;
  }
  document.body.dataset.pane = state.pane;
  document.body.dataset.platform = state.platform;
  back.hidden = state.pane !== 'chat';
  back.setAttribute('aria-label', labels.back);
  retry.setAttribute('aria-label', labels.retry);
  const listPane = state.pane === 'inbox' || state.pane === 'friends';
  rail.hidden = !listPane;
  newChatButton.hidden = !listPane;
  chatControls.hidden = state.pane !== 'chat';
  for (const [button, key, pane] of [[chatsButton, 'chats', 'inbox'], [friendsButton, 'friends', 'friends']]) {
    labelButton(button, labels[key]);
    button.classList.toggle('selected', state.pane === pane);
    button.setAttribute('aria-pressed', String(state.pane === pane));
  }
  labelButton(newChatButton, labels.newChat);
  newChatButton.setAttribute('aria-expanded', String(!!state.newChatOpen));
  for (const { action, button } of chatActions) {
    labelButton(button, labels[action]);
    button.disabled = !!state.updating || state.pane !== 'chat' || !state.chatControls?.[action];
  }
  labelButton(settings, labels.settings);
  settings.setAttribute('aria-expanded', String(!!state.settingsOpen || !!state.settingsOverlayOpen));
  settingsHeading.textContent = labels.settings;
  settingsClose.setAttribute('aria-label', labels.close);
  workModeLabel.textContent = labels.workMode || '';
  workModeDescription.textContent = labels.workModeDescription || '';
  workMode.checked = state.workModeEnabled;
  settingsError.textContent = state.settingsError || '';
  settingsError.hidden = !state.settingsError;
  for (const label of chatThemeLabels) {
    const translation = labels.chatTheme?.[label.dataset.themeLabel];
    if (typeof translation === 'string' && label.textContent !== translation) label.textContent = translation;
  }
  language.value = state.language || 'auto';
  systemLanguage.textContent = labels.systemLanguage;
  document.querySelector('#language-label').textContent = labels.language;
  for (const { key, input } of preferences) {
    input.checked = key === 'startInTray' ? !!state[key] : state[key] !== false;
    document.querySelector('#' + input.id + '-label').textContent = labels[key];
    input.setAttribute('aria-label', labels[key]);
    if (key === 'notificationPreviewEnabled') input.disabled = !!state.updating || state.notificationsEnabled === false;
  }
  autoStart.checked = !!state.autoStart;
  document.querySelector('#auto-start-label').textContent = labels.autoStart;
  autoStart.setAttribute('aria-label', labels.autoStart);
  logout.textContent = labels.logout;
  logout.disabled = !!state.updating || state.pane === 'login';
  savedChatTheme = state.chatTheme || 'system';
  savedChatColors = state.chatColors || colorsApi.chatDefaults;
  savedAppColors = state.appColors || colorsApi.appDefaults;
  if (state.settingsOpen) {
    const opening = !settingsDialog.open;
    if (opening) {
      chatTheme.value = savedChatTheme;
      for (const { group, key, hex } of colorFields) hex.value = (group === 'chat' ? savedChatColors : savedAppColors)[key];
    }
    updateChatDraft();
  }
  syncModal(settingsDialog, !!state.settingsOpen);
  const openingNewChat = !!state.newChatOpen && !newChatDialog.open;
  if (openingNewChat || profileChanged) {
    selectedFriends.clear();
    newChatSearch.value = '';
    creatingChat = false;
  }
  friendRoster = (state.roster || []).filter(friend => typeof friend.handle === 'string' && friend.handle && friend.shown !== false);
  const handles = new Set(friendRoster.map(friend => friend.handle));
  for (const handle of selectedFriends) if (!handles.has(handle)) selectedFriends.delete(handle);
  const nextRoster = JSON.stringify([lang, friendRoster, labels.newChatEmpty, labels.newChatNoMatches]);
  if (openingNewChat || profileChanged || displayedRoster !== nextRoster) renderFriendPicker();
  else updateFriendSelection();
  displayedRoster = nextRoster;
  document.querySelector('#new-chat-heading').textContent = labels.newChat;
  newChatSearch.placeholder = labels.newChatSearch;
  newChatSearch.setAttribute('aria-label', labels.newChatSearch);
  newChatCancel.textContent = labels.cancel;
  newChatClose.setAttribute('aria-label', labels.close);
  syncModal(newChatDialog, !!state.newChatOpen);
  if (openingNewChat) newChatSearch.focus();
  search.parentElement.hidden = !listPane;
  const searchLabel = state.pane === 'friends' ? labels.searchFriends : labels.search;
  search.placeholder = searchLabel;
  search.setAttribute('aria-label', searchLabel);
  const accountLabel = lang === 'ko' ? '계정 전환' : 'Switch accounts';
  profiles.setAttribute('aria-label', accountLabel);
  profiles.title = accountLabel;
  profiles.hidden = state.pane === 'chat';
  const choices = [
    ...(state.profiles || []).map(({ id, label }) => [id, label]),
    ...(listPane && !state.status
      ? [[linkedProfileId, lang === 'ko' ? 'Instagram 프로필 선택…' : 'Instagram profiles…']]
      : []),
    [addProfileId, lang === 'ko' ? '계정 추가…' : 'Add account…'],
  ];
  const nextProfiles = JSON.stringify(choices);
  if (displayedProfiles !== nextProfiles) {
    profiles.replaceChildren(...choices.map(([id, label]) => new Option(label, id)));
    displayedProfiles = nextProfiles;
  }
  if (profileChanged) search.value = '';
  if (typeof state.query === 'string' && (profileChanged || paneChanged || document.activeElement !== search)) search.value = state.query;
  activeProfileId = state.activeProfileId;
  if (profiles.value !== activeProfileId) profiles.value = activeProfileId;
  const canRename = state.pane === 'chat' && !!state.chatRenameEnabled && !state.updating;
  heading.contentEditable = canRename ? 'plaintext-only' : 'false';
  heading.tabIndex = canRename ? 0 : -1;
  heading.title = canRename ? labels.renameChat : '';
  if (canRename) {
    heading.setAttribute('role', 'textbox');
    heading.setAttribute('aria-label', labels.renameChat);
    heading.setAttribute('aria-multiline', 'false');
  } else {
    heading.removeAttribute('role');
    heading.removeAttribute('aria-label');
    heading.removeAttribute('aria-multiline');
  }
  if (renameOriginal === null) heading.textContent = state.title || 'OnlyDM';
  hint.textContent = state.hint || '';
  hint.hidden = !state.hint;
  status.textContent = state.status || '';
  if (settingsOverlayClosed && listPane) settings.focus();
});

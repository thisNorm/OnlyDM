'use strict';

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
const chatFields = ['background', 'incoming', 'outgoing'].map(key => ({
  key,
  picker: document.querySelector('#chat-' + key + '-color'),
  hex: document.querySelector('#chat-' + key + '-hex'),
}));
const addProfileId = '__add__';
const linkedProfileId = '__linked__';
let displayedProfiles = '';
let activeProfileId;
let savedChatTheme;
let savedChatColors;

function normalizeHex(value) {
  return /^#?[0-9a-f]{6}$/i.test(value) ? '#' + value.replace(/^#/, '').toUpperCase() : null;
}

function previewTextColor(hex) {
  const [red, green, blue] = [1, 3, 5].map(start => {
    const srgb = parseInt(hex.slice(start, start + 2), 16) / 255;
    return srgb <= .04045 ? srgb / 12.92 : ((srgb + .055) / 1.055) ** 2.4;
  });
  const luminance = .2126 * red + .7152 * green + .0722 * blue;
  return (luminance + .05) / .05 >= 1.05 / (luminance + .05) ? '#000000' : '#FFFFFF';
}

function updateChatDraft() {
  const custom = chatTheme.value === 'custom';
  chatCustomColors.hidden = !custom;
  const colors = custom ? {} : savedChatColors;
  let valid = true;
  if (custom) {
    for (const { key, picker, hex } of chatFields) {
      const value = normalizeHex(hex.value);
      hex.setAttribute('aria-invalid', String(!value));
      if (value) {
        hex.removeAttribute('aria-describedby');
        if (picker.value !== value.toLowerCase()) picker.value = value;
        chatPreview.style.setProperty('--preview-' + key, value);
        chatPreview.style.setProperty('--preview-' + key + '-text', previewTextColor(value));
        colors[key] = value;
      } else {
        hex.setAttribute('aria-describedby', 'chat-hex-error');
        valid = false;
      }
    }
  }
  chatHexError.hidden = valid;
  chatApply.disabled = !valid || (chatTheme.value === savedChatTheme
    && chatFields.every(({ key }) => colors[key] === savedChatColors[key]));
  return valid ? colors : null;
}

chatTheme.addEventListener('change', updateChatDraft);
for (const { picker, hex } of chatFields) {
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
  const colors = updateChatDraft();
  if (chatApply.disabled) return;
  if (chatTheme.value === 'custom') {
    for (const { key, hex } of chatFields) hex.value = colors[key];
  }
  window.onlydm.setChatTheme(chatTheme.value, colors);
});

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
settingsClose.addEventListener('click', () => window.onlydm.settings(false));
settingsDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  window.onlydm.settings(false);
});
workMode.addEventListener('change', () => window.onlydm.setWorkMode(workMode.checked));
search.addEventListener('input', () => window.onlydm.search(search.value));
window.onlydm.onState((state) => {
  document.documentElement.lang = state.lang;
  document.documentElement.classList.toggle('dark', state.dark);
  document.body.dataset.pane = state.pane;
  back.hidden = state.pane !== 'chat';
  back.setAttribute('aria-label', state.labels.back);
  retry.setAttribute('aria-label', state.labels.retry);
  rail.hidden = state.pane !== 'inbox';
  settings.title = state.labels.settings;
  settings.setAttribute('aria-label', state.labels.settings);
  settingsHeading.textContent = state.labels.settings;
  settingsClose.setAttribute('aria-label', state.labels.close);
  workModeLabel.textContent = state.labels.workMode;
  workModeDescription.textContent = state.labels.workModeDescription;
  workMode.checked = state.workModeEnabled;
  settingsError.textContent = state.settingsError ? state.labels.settingsError : '';
  settingsError.hidden = !state.settingsError;
  for (const label of chatThemeLabels) {
    const translation = state.labels.chatTheme[label.dataset.themeLabel];
    if (label.textContent !== translation) label.textContent = translation;
  }
  savedChatTheme = state.chatTheme;
  savedChatColors = state.chatColors;
  if (state.settingsOpen) {
    const opening = !settingsDialog.open;
    if (opening) {
      chatTheme.value = savedChatTheme;
      for (const { key, hex } of chatFields) hex.value = savedChatColors[key];
    }
    updateChatDraft();
    if (opening) settingsDialog.showModal();
  } else if (settingsDialog.open) {
    settingsDialog.close();
  }
  search.parentElement.hidden = state.pane !== 'inbox';
  search.placeholder = state.labels.search;
  search.setAttribute('aria-label', state.labels.search);
  const accountLabel = state.lang === 'ko' ? '계정 전환' : 'Switch accounts';
  profiles.setAttribute('aria-label', accountLabel);
  profiles.title = accountLabel;
  profiles.hidden = state.pane === 'chat';
  const choices = [
    ...state.profiles.map(({ id, label }) => [id, label]),
    ...(state.pane === 'inbox' && !state.status
      ? [[linkedProfileId, state.lang === 'ko' ? 'Instagram 프로필 선택…' : 'Instagram profiles…']]
      : []),
    [addProfileId, state.lang === 'ko' ? '계정 추가…' : 'Add account…'],
  ];
  const nextProfiles = JSON.stringify(choices);
  if (displayedProfiles !== nextProfiles) {
    profiles.replaceChildren(...choices.map(([id, label]) => new Option(label, id)));
    displayedProfiles = nextProfiles;
  }
  if (activeProfileId !== state.activeProfileId) search.value = '';
  activeProfileId = state.activeProfileId;
  if (profiles.value !== activeProfileId) profiles.value = activeProfileId;
  heading.textContent = state.title;
  hint.textContent = state.hint;
  hint.hidden = !state.hint;
  status.textContent = state.status;
});

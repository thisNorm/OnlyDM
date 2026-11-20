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
const colorsApi = window.onlydmColors;
const appPreview = document.querySelector('#app-preview');
const colorTarget = document.querySelector('#color-target');
const spectrum = document.querySelector('#color-spectrum');
const spectrumMarker = document.querySelector('#color-spectrum-marker');
const hueSlider = document.querySelector('#color-hue');
const updateButton = document.querySelector('#update');
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

const normalizeHex = colorsApi.normalizeHex;
const previewTextColor = colorsApi.textOn;

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
  chatApply.disabled = !valid || (chatTheme.value === savedChatTheme
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
  updateButton.title = state.updating ? state.labels.updatePreparing
    : state.updateAvailable ? state.labels.update + ' · ' + state.updateAvailable.version : state.labels.update || '';
  updateButton.setAttribute('aria-label', updateButton.title);
  for (const control of document.querySelectorAll('button,input,select')) {
    if (control === updateButton) continue;
    if (state.updating) control.disabled = true;
    else if (control !== chatApply) control.disabled = false;
  }
  document.body.dataset.pane = state.pane;
  document.body.dataset.platform = state.platform;
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
    if (typeof translation === 'string' && label.textContent !== translation) label.textContent = translation;
  }
  savedChatTheme = state.chatTheme;
  savedChatColors = state.chatColors;
  savedAppColors = state.appColors || colorsApi.appDefaults;
  if (state.settingsOpen) {
    const opening = !settingsDialog.open;
    if (opening) {
      chatTheme.value = savedChatTheme;
      for (const { group, key, hex } of colorFields) hex.value = (group === 'chat' ? savedChatColors : savedAppColors)[key];
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

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
const addProfileId = '__add__';
const linkedProfileId = '__linked__';
let displayedProfiles = '';
let activeProfileId;
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
  if (state.settingsOpen && !settingsDialog.open) settingsDialog.showModal();
  else if (!state.settingsOpen && settingsDialog.open) settingsDialog.close();
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

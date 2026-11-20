'use strict';

// Evaluated only in the current official thread's isolated world; returns no text.
function draftPresence() {
  if (!['https://www.instagram.com', 'https://instagram.com'].includes(location.origin)
    || !/^\/direct\/t\/[a-zA-Z0-9_-]+\/?$/.test(location.pathname)) return false;
  const input = document.querySelector('.onlydm-chat-composer textarea, .onlydm-chat-composer [contenteditable="true"]')
    || document.querySelector('textarea, [contenteditable="true"][role="textbox"]');
  return !!(input && (typeof input.value === 'string' ? input.value : input.textContent || '').trim())
    || Array.from(document.querySelectorAll('input[type="file"]')).some(file => file.files?.length);
}
module.exports = { draftPresence };

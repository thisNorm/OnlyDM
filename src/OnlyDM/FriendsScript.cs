using System.Text.Json;

namespace OnlyDM;

// The following list lives behind the "팔로우" link on the signed-in user's own
// profile. OnlyDM opens that list in the background, reads it, and projects it as a
// friends list; Instagram's own profile page is never shown.
public static class FriendsScript
{
    // Zoom out the source page so the following link appears in Instagram's desktop layout.
    public const double ViewZoomFactor = 0.4;

    public static string Build(AppThemePalette palette, double zoomFactor, AppLanguage language)
    {
        var paletteJson = JsonSerializer.Serialize(new
        {
            accent = palette.Accent,
            accentText = palette.AccentText,
            surface = palette.Surface,
            surfaceAlt = palette.SurfaceAlt,
            text = palette.Text,
            muted = palette.MutedText,
            border = palette.Border,
        });
        var uiJson = JsonSerializer.Serialize(new
        {
            lang = AppLanguageChoice.InstagramCode(language),
            refresh = AppLanguageChoice.Text(language, "팔로잉 목록 새로고침", "Refresh following list"),
            localOnly = AppLanguageChoice.Text(language, "이 이름은 이 컴퓨터에서만 바뀝니다.", "This name changes only on this computer."),
            editName = AppLanguageChoice.Text(language, "표시 이름 편집", "Edit display name"),
            renameHint = AppLanguageChoice.Text(language, "이름을 눌러 바꾸세요 · 내 화면에만 적용", "Click the name to edit · only visible to you"),
            chat = AppLanguageChoice.Text(language, "1:1 채팅", "Chat"),
            audioCall = AppLanguageChoice.Text(language, "음성 통화", "Audio call"),
            videoCall = AppLanguageChoice.Text(language, "영상 통화", "Video call"),
            switchAccount = AppLanguageChoice.Text(language, "계정 전환", "Switch account"),
            results = AppLanguageChoice.Text(language, "검색 결과", "Results"),
            following = AppLanguageChoice.Text(language, "팔로잉", "Following"),
            noResults = AppLanguageChoice.Text(language, "검색 결과가 없습니다.", "No results found."),
            empty = AppLanguageChoice.Text(language, "팔로잉하는 계정이 없습니다.", "You aren’t following any accounts."),
            loading = AppLanguageChoice.Text(language, "팔로잉 목록을 불러오는 중입니다.", "Loading following list."),
        });

        // Cancel the web view's zoom for the projected list.
        var scale = 1 / zoomFactor;
        var shellZoom = scale.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        // The shell is drawn inside a scale() transform, so a plain 10px scrollbar would
        // render 2.5x too thick. Sizes here are divided to match the conversation list.
        var barWidth = (10 / scale).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
        var barRadius = (5 / scale).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
        var barBorder = (3 / scale).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);

        return $$"""
(() => {
  let ui = {{uiJson}};
  if (window.__onlydmFriendsRerun) { window.__onlydmFriendsRerun(ui); return; }

  const palette = Object.assign({{paletteJson}}, typeof __onlydmFriendsPalette === 'object' ? __onlydmFriendsPalette : {});
  const shellId = 'OnlyDmFriends';
  const sourceDialogSelector = 'div[role="dialog"]:not(.onlydm-card)';
  const marker = 'onlydm-friends-style';
  let friendStore = new Map();
  let rosterBeforeHarvest = null;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let harvesting = false;
  let reportedCount = -1;
  let cardKey = '';
  let cardOpener = null;
  let updateCardCopy = null;
  let filter = '';
  let seeded = false;
  let selectedHandle = '';
  let started = false;
  // Names the user chose, keyed by handle. The handle itself is never touched.
  let nicknames = {};
  const shownName = (item) => (item && nicknames[item.handle]) || (item && item.name) || '';
  const diag = { pages: 0, stalls: 0, phase: 'init', sh: 0, ch: 0, top: 0, dialog: false, scroller: false };

  function post(message) {
    try { window.chrome?.webview?.postMessage(message); } catch (_) { }
  }

  function fail(stage, error) {
    post({ type: 'friends-error', stage, message: String(error?.message || error || 'unknown') });
  }

  function nfc(value) {
    try { return String(value || '').normalize('NFC'); } catch (_) { return String(value || ''); }
  }

  function ensureStyle() {
    if (document.getElementById(marker)) return;
    const style = document.createElement('style');
    style.id = marker;
    style.textContent = `
      html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: ${palette.surface} !important; }
      html, body, * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
      ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-track { background: transparent !important; }
      body > *:not(#${shellId}).onlydm-friends-hidden { visibility: hidden !important; pointer-events: none !important; }
      #${shellId} { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; background: ${palette.surface}; color: ${palette.text}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
      #${shellId} * { box-sizing: border-box; }
      #${shellId} .onlydm-scale { width: calc(100% / {{shellZoom}}); height: calc(100% / {{shellZoom}}); transform: scale({{shellZoom}}); transform-origin: 0 0; display: flex; flex-direction: column; overflow: hidden; }
      #${shellId} :is(.onlydm-me, .onlydm-friend) { width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; }
      #${shellId} .onlydm-me { display: grid; grid-template-columns: 52px minmax(0,1fr); gap: 11px; align-items: center; padding: 12px 12px; border-bottom: 1px solid ${palette.border}; cursor: pointer; }
      #${shellId} .onlydm-me:hover { background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-section { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px 6px; font-size: 12px; font-weight: 700; color: ${palette.muted}; }
      #${shellId} .onlydm-refresh { border: 0; background: transparent; color: ${palette.muted}; font-size: 14px; font-weight: 700; cursor: pointer; padding: 2px 6px; border-radius: 8px; }
      #${shellId} .onlydm-refresh:hover { background: ${palette.surfaceAlt}; color: ${palette.text}; }
      #${shellId} .onlydm-refresh[data-busy="true"] { opacity: .45; cursor: default; }
      #${shellId} .onlydm-friend-list { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; padding: 0 6px 12px; }
      #${shellId} .onlydm-friend-list::-webkit-scrollbar { width: 0 !important; display: none !important; }
      #${shellId} .onlydm-friend { display: grid; grid-template-columns: 44px minmax(0,1fr); gap: 11px; align-items: center; padding: 8px 10px; border-radius: 10px; cursor: default; user-select: none; }
      #${shellId} .onlydm-friend:hover { background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-friend[data-selected="true"] { background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-avatar { display: block; width: 44px; height: 44px; border-radius: 16px; overflow: hidden; background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-avatar img { width: 100%; height: 100%; object-fit: cover; }
      #${shellId} .onlydm-me .onlydm-avatar { width: 52px; height: 52px; border-radius: 18px; }
      #${shellId} .onlydm-name { display: block; font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #${shellId} .onlydm-handle { display: block; margin-top: 2px; font-size: 12px; color: ${palette.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      /* auto, not thin: specifying scrollbar-width makes Chromium ignore the
         ::-webkit-scrollbar sizing below, which left the bar at its default width. */
      #${shellId} .onlydm-friend-list { scrollbar-width: auto !important; }
      #${shellId} .onlydm-friend-list::-webkit-scrollbar { width: {{barWidth}}px !important; display: block !important; }
      #${shellId} .onlydm-friend-list { overflow-y: scroll !important; }
      #${shellId} .onlydm-friend-list::-webkit-scrollbar-track { background: transparent !important; }
      /* No inset border here: once the width is divided by the shell scale, a
         transparent border leaves under a pixel of visible thumb. */
      #${shellId} .onlydm-friend-list::-webkit-scrollbar-thumb { background: ${palette.muted} !important; border-radius: {{barRadius}}px !important; }
      #${shellId} .onlydm-empty { padding: 40px 18px; text-align: center; color: ${palette.muted}; font-size: 13px; }
      #${shellId} .onlydm-card-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; z-index: 10; }
      #${shellId} .onlydm-card { width: 240px; background: ${palette.surface}; border-radius: 16px; padding: 20px 16px 14px; text-align: center; box-shadow: 0 12px 32px rgba(0,0,0,.25); }
      #${shellId} .onlydm-card .onlydm-avatar { width: 92px; height: 92px; border-radius: 30px; margin: 0 auto 12px; }
      #${shellId} .onlydm-card-name { font-size: 16px; font-weight: 700; border-radius: 7px; padding: 3px 6px; outline: none; }
      /* The name is edited in place, so hovering is the only affordance there is room for. */
      #${shellId} .onlydm-card-name:hover { background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-card-name:focus { background: ${palette.surfaceAlt}; box-shadow: inset 0 0 0 1.5px ${palette.accent}; }
      #${shellId} .onlydm-card-hint { margin-top: 8px; font-size: 11px; color: ${palette.muted}; }
      #${shellId} .onlydm-card-handle { margin-top: 3px; font-size: 12px; color: ${palette.muted}; }
      #${shellId} .onlydm-card-actions { display: flex; gap: 8px; margin-top: 16px; }
      #${shellId} .onlydm-card-actions button { flex: 1; height: 36px; border: 0; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: pointer; background: ${palette.surfaceAlt}; color: ${palette.text}; }
      #${shellId} .onlydm-card-actions button.primary { background: ${palette.accent}; color: ${palette.accentText}; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function hideProfile() {
    if (!document.body) return;
    for (const child of document.body.children) {
      if (child.id !== shellId) child.classList.add('onlydm-friends-hidden');
    }
  }

  function ensureShell() {
    if (!document.body) return null;
    ensureStyle();
    let shell = document.getElementById(shellId);
    if (!shell) {
      shell = document.createElement('section');
      shell.id = shellId;
      const scaled = document.createElement('div');
      scaled.className = 'onlydm-scale';
      const account = document.createElement('button');
      account.type = 'button';
      account.className = 'onlydm-me';
      account.addEventListener('click', () => post({ type: 'switch-account' }));
      scaled.appendChild(account);
      for (const className of ['onlydm-section', 'onlydm-friend-list']) {
        const part = document.createElement('div');
        part.className = className;
        scaled.appendChild(part);
      }
      shell.appendChild(scaled);
      document.body.appendChild(shell);
    }
    hideProfile();
    return shell;
  }

  // Instagram labels the following count "팔로우" (not "팔로잉") in Korean.
  function followingTrigger() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = (walker.currentNode.textContent || '').trim();
      if (!/^팔로우$|^팔로잉$|^following$/i.test(text)) continue;
      let node = walker.currentNode.parentElement;
      for (let i = 0; i < 6 && node; i++, node = node.parentElement) {
        const role = node.getAttribute?.('role');
        if (node.tagName === 'A' || role === 'link' || role === 'button') return node;
      }
    }
    return null;
  }

  function exactFollowingCount(trigger = followingTrigger()) {
    for (const element of [trigger, trigger?.parentElement]) {
      const text = element?.textContent?.trim() || '';
      const match = text.match(/^(?:(?:following|팔로우|팔로잉)\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\s*(?:following|팔로우|팔로잉))?$/i);
      if (match) return Number(match[1].replace(/,/g, ''));
    }
    return null;
  }

  function meRow() {
    const link = document.querySelector('nav a[href^="/"][href$="/"], header a[href^="/"][href$="/"]');
    const image = document.querySelector('img[alt*="프로필 사진"], img[alt*="profile picture" i], nav img, header img');
    const handle = (location.pathname.replace(/\//g, '') || '').trim();
    return { handle, avatar: image?.currentSrc || image?.src || '' };
  }

  // The following dialog fetches its next page only in response to a real wheel
  // event. Setting scrollTop scrolls the list but never loads anyone new.
  function pageDown(scroller) {
    const rect = scroller.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height - 10;
    for (let i = 0; i < 3; i += 1) {
      scroller.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 400, bubbles: true, cancelable: true, clientX: x, clientY: y,
      }));
    }
    scroller.scrollTop += Math.max(1, Math.floor(scroller.clientHeight * 0.8));
  }

  function dialogScroller(dialog) {
    if (!dialog) return null;
    let best = null;
    for (const element of dialog.querySelectorAll('div')) {
      if (element.scrollHeight > element.clientHeight + 30 && element.clientHeight > 80) {
        if (!best || element.scrollHeight > best.scrollHeight) best = element;
      }
    }
    return best;
  }

  function rowLines(row, profileLink) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const lines = [];
    while (walker.nextNode()) {
      const text = walker.currentNode;
      const control = text.parentElement?.closest('button, [role="button"], svg, [aria-hidden="true"]');
      if (control && row.contains(control) && !control.contains(profileLink)) continue;
      const value = nfc(text.textContent).replace(/\s+/g, ' ').trim();
      if (value && lines[lines.length - 1] !== value) lines.push(value);
    }
    return lines;
  }

  function mergeDialogRows(dialog, roster) {
    const seen = new Set();
    if (!dialog) return seen;
    const ownHandle = meRow().handle;
    const profileLinks = 'a[href^="/"]';
    const profilePath = /^\/[A-Za-z0-9._]+\/$/;
    for (const anchor of dialog.querySelectorAll(profileLinks)) {
      const href = anchor.getAttribute('href') || '';
      if (!profilePath.test(href)) continue;
      const handle = href.replace(/\//g, '');
      if (!handle || handle === ownHandle) continue;
      seen.add(handle);

      // The username and the full name sit in separate anchors, so stopping at the
      // first sensibly sized ancestor captured only the username: that is why friends
      // were searchable by handle but never by name. Climb until both are inside.
      let row = anchor;
      let lines = rowLines(row, anchor);
      for (let i = 0; i < 8 && row.parentElement; i++) {
        const parent = row.parentElement;
        const rect = parent.getBoundingClientRect();
        if (rect.height > 160 || rect.width > 640) break;
        const links = Array.from(parent.querySelectorAll(profileLinks));
        if (links.some((link) => {
          const path = link.getAttribute('href');
          return profilePath.test(path) && path !== href;
        })) break;
        row = parent;
        lines = rowLines(row, anchor);
        if (lines.length >= 2) break;
      }

      const image = row.querySelector('img');

      const existing = roster.get(handle) || friendStore.get(handle) || {};
      roster.set(handle, {
        handle,
        // Prefer a real display name over the username, which also appears in the row.
        name: lines.find((line) => line.toLowerCase() !== handle.toLowerCase())
          || (existing.name && existing.name !== handle ? existing.name : handle),
        avatar: image?.currentSrc || image?.src || existing.avatar || '',
      });
    }
    return seen;
  }



  function moveSelection(delta, focus) {
    const rows = Array.from(document.querySelectorAll(`#${shellId} .onlydm-friend`));
    if (!rows.length) return;
    const active = focus ? document.activeElement : null;
    let index = rows.indexOf(active);
    if (index < 0) index = rows.findIndex((row) => row.dataset.handle === selectedHandle);
    if (index < 0) index = delta > 0 ? -1 : 0;
    const next = Math.max(0, Math.min(index + delta, rows.length - 1));
    selectedHandle = rows[next].dataset.handle;
    render();
    const current = document.querySelector(`#${shellId} .onlydm-friend[data-selected="true"]`);
    if (!current) return;
    if (focus) current.focus({ preventScroll: true });
    current.scrollIntoView({ block: 'nearest' });
  }

  function handleKey(key, focus = false) {
    if (key === 'Escape') {
      if (document.querySelector(`#${shellId} .onlydm-card-backdrop`)) { closeCard(); return; }
      post({ type: 'close-window' });
      return;
    }
    if (cardKey) return;
    if (key === 'ArrowDown' || key === 'ArrowUp') { moveSelection(key === 'ArrowDown' ? 1 : -1, focus); return; }
    if (key !== 'Enter') return;
    const row = document.querySelector(`#${shellId} .onlydm-friend[data-selected="true"]`)
      || document.querySelector(`#${shellId} .onlydm-friend`);
    const item = friendStore.get(row?.dataset.handle);
    if (!item) return;
    selectedHandle = item.handle;
    showCard(item);
  }

  document.addEventListener('keydown', (event) => {
    if (event.isComposing || event.defaultPrevented) return;
    const active = document.activeElement;
    const typing = !!active
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (typing && !active.closest('.onlydm-friends-hidden')) return;
    if (!['Enter', 'Escape', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    if (event.key === 'Enter' && active?.closest(`#${shellId} button`)) return;
    if (cardKey && event.key !== 'Escape') return;
    event.preventDefault();
    handleKey(event.key, true);
  }, true);

  function ensureSectionParts(section) {
    let label = section.querySelector('.onlydm-section-label');
    if (!label) {
      section.replaceChildren();
      label = document.createElement('span');
      label.className = 'onlydm-section-label';
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'onlydm-refresh';
      refresh.textContent = '↻';
      // The list is kept between visits; this is the only thing that re-reads it.
      refresh.addEventListener('click', refreshFriends);
      section.append(label, refresh);
    }
    const refresh = section.querySelector('.onlydm-refresh');
    if (refresh) {
      refresh.title = ui.refresh;
      refresh.setAttribute('aria-label', ui.refresh);
      refresh.setAttribute('aria-disabled', String(harvesting));
      refresh.dataset.busy = String(harvesting);
    }
    return label;
  }

  function avatarNode(item, className) {
    const wrap = document.createElement('span');
    wrap.className = className || 'onlydm-avatar';
    if (item.avatar) {
      const image = document.createElement('img');
      image.src = item.avatar;
      image.alt = '';
      image.draggable = false;
      wrap.appendChild(image);
    }
    return wrap;
  }

  function showCard(item) {
    const shell = document.getElementById(shellId);
    if (!shell || !item) return;
    closeCard();
    cardKey = item.handle;
    cardOpener = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'onlydm-card-backdrop';
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeCard(); });

    const card = document.createElement('div');
    card.className = 'onlydm-card';
    card.tabIndex = -1;
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'onlydm-friend-card-handle');
    card.appendChild(avatarNode(item));

    const name = document.createElement('div');
    name.className = 'onlydm-card-name';
    name.textContent = shownName(item);
    name.contentEditable = 'true';
    name.spellcheck = false;
    name.setAttribute('role', 'textbox');
    name.setAttribute('aria-describedby', 'onlydm-friend-rename-hint');
    name.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Enter') { event.preventDefault(); name.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); name.textContent = shownName(item); name.blur(); }
      event.stopPropagation();
    });
    // Clearing it, or typing the original name back, means "use Instagram's name again".
    name.addEventListener('blur', () => {
      const next = nfc(name.textContent || '').trim();
      if (next === shownName(item)) return;
      post({ type: 'set-alias', handle: item.handle, alias: next === item.name ? '' : next });
    });
    const handle = document.createElement('div');
    handle.className = 'onlydm-card-handle';
    handle.id = 'onlydm-friend-card-handle';
    handle.textContent = '@' + item.handle;
    const hint = document.createElement('div');
    hint.className = 'onlydm-card-hint';
    hint.id = 'onlydm-friend-rename-hint';
    card.append(name, handle, hint);

    const actions = document.createElement('div');
    actions.className = 'onlydm-card-actions';
    const labels = [];
    for (const [key, message] of [
      ['chat', { type: 'open-friend-chat', handle: item.handle, name: item.name }],
      ['audioCall', { type: 'open-friend-call', handle: item.handle, name: item.name, mode: 'voice' }],
      ['videoCall', { type: 'open-friend-call', handle: item.handle, name: item.name, mode: 'video' }],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      if (key === 'chat') button.className = 'primary';
      button.addEventListener('click', () => { post(message); closeCard(); });
      actions.appendChild(button);
      labels.push([button, key]);
    }
    updateCardCopy = () => {
      name.title = ui.localOnly;
      name.setAttribute('aria-label', ui.editName);
      hint.textContent = ui.renameHint;
      for (const [button, key] of labels) button.textContent = ui[key];
    };
    updateCardCopy();
    card.appendChild(actions);

    backdrop.appendChild(card);
    const layer = shell.querySelector('.onlydm-scale') || shell;
    for (const part of layer.children) part.inert = true;
    layer.appendChild(backdrop);
    card.focus({ preventScroll: true });
  }

  function closeCard() {
    cardKey = '';
    updateCardCopy = null;
    const backdrop = document.querySelector(`#${shellId} .onlydm-card-backdrop`);
    if (backdrop) {
      const layer = backdrop.parentElement;
      backdrop.remove();
      for (const part of layer.children) part.inert = false;
      if (cardOpener?.isConnected) cardOpener.focus({ preventScroll: true });
    }
    cardOpener = null;
  }

  function render() {
    const shell = ensureShell();
    if (!shell) return;
    if (shell.lang !== ui.lang) shell.lang = ui.lang;

    const me = meRow();
    const meNode = shell.querySelector('.onlydm-me');
    const needsAvatar = !!(meNode && me.avatar && !meNode.querySelector('img'));
    if (meNode && (meNode.dataset.handle !== me.handle || needsAvatar)) {
      meNode.dataset.handle = me.handle;
      meNode.replaceChildren(avatarNode(me));
      const text = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'onlydm-name';
      name.textContent = me.handle;
      const hint = document.createElement('span');
      hint.className = 'onlydm-handle';
      text.append(name, hint);
      meNode.appendChild(text);
    }
    if (meNode) {
      meNode.title = ui.switchAccount;
      meNode.querySelector('.onlydm-handle').textContent = ui.switchAccount;
    }

    const all = Array.from(friendStore.values());
    const items = filter
      ? all.filter((item) => `${item.name} ${shownName(item)} ${item.handle}`.toLocaleLowerCase().includes(filter))
      : all;
    const section = shell.querySelector('.onlydm-section');
    const label = section && ensureSectionParts(section);
    const following = exactFollowingCount();
    const followingLabel = following?.toLocaleString(ui.lang) || '';
    if (label) label.textContent = filter
      ? `${ui.results} ${items.length.toLocaleString(ui.lang)}`
      : `${ui.following} ${followingLabel || all.length.toLocaleString(ui.lang)}`;

    const list = shell.querySelector('.onlydm-friend-list');
    if (!list) return;

    if (!items.length) {
      let empty = list.querySelector('.onlydm-empty');
      if (!empty) {
        empty = document.createElement('div');
        empty.className = 'onlydm-empty';
        list.replaceChildren(empty);
      }
      empty.textContent = filter ? ui.noResults : following === 0 && !harvesting ? ui.empty : ui.loading;
    } else {
      const existing = new Map();
      for (const row of list.querySelectorAll('.onlydm-friend')) existing.set(row.dataset.handle, row);
      const next = items.map((item) => {
        let row = existing.get(item.handle);
        if (!row) {
          row = document.createElement('button');
          row.type = 'button';
          row.className = 'onlydm-friend';
          row.dataset.handle = item.handle;
          row.appendChild(avatarNode(item));
          const text = document.createElement('span');
          const name = document.createElement('span');
          name.className = 'onlydm-name';
          const handle = document.createElement('span');
          handle.className = 'onlydm-handle';
          text.append(name, handle);
          row.appendChild(text);
          row.addEventListener('click', () => {
            selectedHandle = row.dataset.handle;
            showCard(friendStore.get(row.dataset.handle));
          });
          row.addEventListener('dblclick', () => {
            const friend = friendStore.get(row.dataset.handle);
            if (!friend) return;
            closeCard();
            post({ type: 'open-friend-chat', handle: friend.handle, name: friend.name });
          });
        }
        row.querySelector('.onlydm-name').textContent = shownName(item);
        row.querySelector('.onlydm-handle').textContent = '@' + item.handle;
        row.dataset.selected = String(item.handle === selectedHandle);
        return row;
      });
      const current = Array.from(list.children);
      const same = current.length === next.length && current.every((node, i) => node === next[i]);
      if (!same) list.replaceChildren(...next);
    }

    if (all.length !== reportedCount) {
      reportedCount = all.length;
      post({ type: 'friends-count', count: all.length, label: followingLabel });
    }
    hideProfile();
  }

  async function waitForPage(roster, expected, previousRows, timeout) {
    let page;
    for (let waited = 0; waited <= timeout; waited += 200) {
      // A render can replace the dialog or its scroller while we wait for rows.
      const dialog = document.querySelector(sourceDialogSelector);
      const previousSize = roster.size;
      const rows = Array.from(mergeDialogRows(dialog, roster)).join(':');
      const scroller = dialogScroller(dialog);
      if (friendStore === roster && roster.size !== previousSize) render();
      diag.dialog = !!dialog;
      diag.scroller = !!scroller;
      page = { dialog, scroller, rows };
      if ((dialog && roster.size === expected) || (scroller && rows && rows !== previousRows)) break;
      if (waited < timeout) await sleep(200);
    }
    return page;
  }

  function refreshFriends() {
    harvest().catch((error) => fail('refresh', error));
  }

  async function harvest() {
    if (harvesting) return;
    harvesting = true;
    const cached = friendStore;
    const roster = new Map();
    rosterBeforeHarvest = cached;
    if (!cached.size) friendStore = roster;
    const stageTimeout = 8000;
    let complete = false;
    Object.assign(diag, { pages: 0, stalls: 0, phase: 'trigger', sh: 0, ch: 0, top: 0, dialog: false, scroller: false });
    try {
      render();
      let trigger = null;
      // The profile header renders after the document loads.
      for (let attempt = 0; attempt < 60 && !trigger; attempt += 1) {
        trigger = followingTrigger();
        if (!trigger) await sleep(500);
      }
      if (!trigger) {
        throw new Error(`following link not found (w=${window.innerWidth}, links=${document.querySelectorAll('a').length})`);
      }

      const expected = exactFollowingCount(trigger);
      diag.phase = 'dialog';
      if (!document.querySelector(sourceDialogSelector)) trigger.click();
      let page = await waitForPage(roster, expected, '', stageTimeout);
      if (!page.dialog) throw new Error('following dialog not found');
      if (!page.rows && expected !== 0) throw new Error('following rows did not load');

      let settledAtEnd = !page.scroller && !!page.rows;
      if (page.scroller && roster.size !== expected) {
        diag.phase = 'page';
        if (page.scroller.scrollTop > 0) {
          page.scroller.scrollTop = 0;
          page = await waitForPage(roster, expected, page.rows, 2800);
        }
        for (let step = 0; step < 160 && roster.size !== expected; step += 1) {
          if (!page.scroller || !page.rows) {
            page = await waitForPage(roster, expected, '', stageTimeout);
            if (!page.scroller || !page.rows || roster.size === expected) break;
          }

          const { scroller, rows } = page;
          diag.pages += 1;
          diag.sh = scroller.scrollHeight;
          diag.ch = scroller.clientHeight;
          diag.top = Math.round(scroller.scrollTop);
          pageDown(scroller);
          await sleep(700);
          // Position changes before a virtual window mounts. Stay here while the
          // previous handles are still visible so the next scroll can't skip a page.
          page = await waitForPage(roster, expected, rows, 2000);

          const stalled = page.rows === rows && page.scroller?.scrollHeight === diag.sh
            && page.scroller.clientHeight === diag.ch && Math.round(page.scroller.scrollTop) === diag.top;
          diag.stalls = stalled ? diag.stalls + 1 : 0;
          if (diag.stalls >= 4) {
            settledAtEnd = diag.top + diag.ch >= diag.sh - 1;
            break;
          }
        }
      }

      // The reported total can confirm a complete scan. With an abbreviated or missing
      // count, a settled scan can add to the cache only if it contains every cached handle.
      complete = roster.size === expected || (expected === null && settledAtEnd
        && Array.from(cached.keys()).every((handle) => roster.has(handle)));
    } catch (error) {
      if (!friendStore.size && !roster.size) fail(diag.phase, error);
    } finally {
      // A cold scan can still supply useful contacts if some pages were missed.
      const publish = complete || (!cached.size && roster.size > 0);
      friendStore = publish ? roster : cached;
      rosterBeforeHarvest = null;
      harvesting = false;
      diag.phase = 'done';
      render();
      // The conversation list only knows display names. Handing it the roster lets the
      // chat search find people by their Instagram handle too.
      if (publish) post({
        type: 'friends-roster',
        people: Array.from(friendStore.values())
          .map((item) => ({ handle: item.handle, name: item.name, avatar: item.avatar || '' })),
      });
      post({ type: 'friends-ready' });
    }
  }

  window.chrome?.webview?.addEventListener('message', (event) => {
    if (event.data?.type === 'set-theme' && event.data.palette) {
      Object.assign(palette, event.data.palette);
      document.getElementById(marker)?.remove();
      ensureStyle();
      return;
    }
    if (event.data?.type === 'friends-refresh') refreshFriends();
    if (event.data?.type === 'friends-seed') {
      // Keep host seeds in the cache while rows are arriving.
      const cached = rosterBeforeHarvest ?? friendStore;
      for (const person of event.data.people || []) {
        if (!person?.handle || cached.has(person.handle)) continue;
        cached.set(person.handle, {
          handle: person.handle,
          name: person.name || person.handle,
          avatar: person.avatar || '',
        });
      }
      seeded = cached.size > 0;
      if (seeded) friendStore = cached;
      render();
      post({ type: 'friends-ready' });
    }
    if (event.data?.type === 'nicknames') {
      nicknames = event.data.map || {};
      render();
      const open = document.querySelector(`#${shellId} .onlydm-card-name`);
      if (open && cardKey && document.activeElement !== open) open.textContent = shownName(friendStore.get(cardKey));
    }
    if (event.data?.type === 'friends-key') handleKey(event.data.key);
    if (event.data?.type === 'friends-filter') {
      filter = String(event.data.query || '').trim().toLocaleLowerCase();
      render();
    }
  });

  function start() {
    try {
      ensureShell();
      render();
      started = true;
      post({ type: 'friends-ready' });
      window.__onlydmFriendsState = () => ({ ...diag, store: friendStore.size, harvesting, seeded });

      // Wait briefly for the cached list from the host; only collect again when there
      // is nothing to show or the user presses refresh.
      setTimeout(() => {
        // A cache that is clearly short of Instagram's own following count is only a
        // head start, not the whole list, so collecting continues from there.
        const reported = exactFollowingCount();
        if (seeded && (reported === null || friendStore.size >= reported)) return;
        harvest().catch((error) => fail('start', error));
      }, 1800);
    } catch (error) {
      fail('start', error);
    }
  }

  window.__onlydmFriendsRerun = (nextUi) => {
    if (nextUi && ui.lang !== nextUi.lang) {
      ui = nextUi;
      updateCardCopy?.();
    }
    if (!started) return;
    render();
    post({ type: 'friends-ready' });
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
""";
    }
}

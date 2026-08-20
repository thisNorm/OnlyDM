using System.Text.Json;

namespace OnlyDM;

// The following list lives behind the "팔로우" link on the signed-in user's own
// profile. OnlyDM opens that list in the background, reads it, and projects it as a
// friends list; Instagram's own profile page is never shown.
public static class FriendsScript
{
    public static string Build(AppThemePalette palette, double scale = 1)
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

        var shellZoom = scale.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
        // The shell is drawn inside a scale() transform, so a plain 10px scrollbar would
        // render 2.5x too thick. Sizes here are divided to match the conversation list.
        var barWidth = (10 / scale).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
        var barRadius = (5 / scale).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
        var barBorder = (3 / scale).ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);

        return $$"""
(() => {
  if (window.__onlydmFriendsRerun) { window.__onlydmFriendsRerun(); return; }

  const palette = {{paletteJson}};
  const shellId = 'OnlyDmFriends';
  const marker = 'onlydm-friends-style';
  const friendStore = new Map();
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let harvesting = false;
  let reportedCount = -1;
  let cardKey = '';
  let filter = '';
  let seeded = false;
  let selectedHandle = '';
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
      #${shellId} .onlydm-me { display: grid; grid-template-columns: 52px minmax(0,1fr); gap: 11px; align-items: center; padding: 12px 12px; border-bottom: 1px solid ${palette.border}; cursor: default; }
      #${shellId} .onlydm-me:hover { background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-section { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px 6px; font-size: 12px; font-weight: 700; color: ${palette.muted}; }
      #${shellId} .onlydm-refresh { border: 0; background: transparent; color: ${palette.muted}; font-size: 14px; font-weight: 700; cursor: default; padding: 2px 6px; border-radius: 8px; }
      #${shellId} .onlydm-refresh:hover { background: ${palette.surfaceAlt}; color: ${palette.text}; }
      #${shellId} .onlydm-refresh[data-busy="true"] { opacity: .45; }
      #${shellId} .onlydm-friend-list { flex: 1; min-height: 0; overflow-y: auto; scrollbar-width: none; padding: 0 6px 12px; }
      #${shellId} .onlydm-friend-list::-webkit-scrollbar { width: 0 !important; display: none !important; }
      #${shellId} .onlydm-friend { display: grid; grid-template-columns: 44px minmax(0,1fr); gap: 11px; align-items: center; padding: 8px 10px; border-radius: 10px; cursor: default; user-select: none; }
      #${shellId} .onlydm-friend:hover { background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-friend[data-selected="true"] { background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-avatar { width: 44px; height: 44px; border-radius: 16px; overflow: hidden; background: ${palette.surfaceAlt}; }
      #${shellId} .onlydm-avatar img { width: 100%; height: 100%; object-fit: cover; }
      #${shellId} .onlydm-me .onlydm-avatar { width: 52px; height: 52px; border-radius: 18px; }
      #${shellId} .onlydm-name { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #${shellId} .onlydm-handle { margin-top: 2px; font-size: 12px; color: ${palette.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
      #${shellId} .onlydm-card-actions button { flex: 1; height: 36px; border: 0; border-radius: 10px; font-size: 12px; font-weight: 700; cursor: default; background: ${palette.surfaceAlt}; color: ${palette.text}; }
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
      for (const className of ['onlydm-me', 'onlydm-section', 'onlydm-friend-list']) {
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

  function followingCountText() {
    const trigger = followingTrigger();
    const row = trigger?.parentElement;
    const digits = (row?.textContent || '').match(/[\d,.]+/);
    return digits ? digits[0] : '';
  }

  function meRow() {
    const link = document.querySelector('nav a[href^="/"][href$="/"], header a[href^="/"][href$="/"]');
    const image = document.querySelector('img[alt*="프로필 사진"], nav img, header img');
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
    scroller.scrollTop = scroller.scrollHeight;
  }

  function dialogScroller() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return null;
    let best = null;
    for (const element of dialog.querySelectorAll('div')) {
      if (element.scrollHeight > element.clientHeight + 30 && element.clientHeight > 80) {
        if (!best || element.scrollHeight > best.scrollHeight) best = element;
      }
    }
    return best;
  }

  function mergeDialogRows() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return;
    for (const anchor of dialog.querySelectorAll('a[href^="/"]')) {
      const href = anchor.getAttribute('href') || '';
      if (!/^\/[A-Za-z0-9._]+\/$/.test(href)) continue;
      const handle = href.replace(/\//g, '');
      if (!handle || handle === meRow().handle) continue;

      // The username and the full name sit in separate anchors, so stopping at the
      // first sensibly sized ancestor captured only the username: that is why friends
      // were searchable by handle but never by name. Climb until both are inside.
      const textCount = (element) => {
        const walk = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let seen = 0;
        while (walk.nextNode()) if ((walk.currentNode.textContent || '').trim()) seen += 1;
        return seen;
      };

      let row = anchor;
      for (let i = 0; i < 8 && row.parentElement; i++) {
        const parent = row.parentElement;
        const rect = parent.getBoundingClientRect();
        if (rect.height > 160 || rect.width > 640) break;
        row = parent;
        if (textCount(row) >= 2) break;
      }

      const image = row.querySelector('img');
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      const lines = [];
      while (walker.nextNode()) {
        const value = nfc(walker.currentNode.textContent).replace(/\s+/g, ' ').trim();
        // A verified account puts a "인증됨" badge label in the row; it is not a name.
        const noise = value === '팔로잉' || value === '팔로우' || value === '인증됨' || /^verified$/i.test(value);
        if (value && !noise && lines[lines.length - 1] !== value) lines.push(value);
      }

      const existing = friendStore.get(handle) || {};
      friendStore.set(handle, {
        handle,
        // Prefer a real display name over the username, which also appears in the row.
        name: lines.find((line) => line.toLowerCase() !== handle.toLowerCase())
          || (existing.name && existing.name !== handle ? existing.name : handle),
        avatar: image?.currentSrc || image?.src || existing.avatar || '',
      });
    }
  }



  function moveSelection(delta) {
    const rows = Array.from(document.querySelectorAll(`#${shellId} .onlydm-friend`));
    if (!rows.length) return;
    let index = rows.findIndex((row) => row.dataset.handle === selectedHandle);
    if (index < 0) index = delta > 0 ? -1 : 0;
    const next = Math.max(0, Math.min(index + delta, rows.length - 1));
    selectedHandle = rows[next].dataset.handle;
    render();
    const current = document.querySelector(`#${shellId} .onlydm-friend[data-selected="true"]`);
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  function handleKey(key) {
    if (key === 'Escape') {
      if (document.querySelector(`#${shellId} .onlydm-card-backdrop`)) { closeCard(); return; }
      post({ type: 'close-window' });
      return;
    }
    if (key === 'ArrowDown' || key === 'ArrowUp') { moveSelection(key === 'ArrowDown' ? 1 : -1); return; }
    if (key !== 'Enter') return;
    const item = friendStore.get(selectedHandle)
      || friendStore.get((document.querySelector(`#${shellId} .onlydm-friend`) || {}).dataset?.handle);
    if (!item) return;
    selectedHandle = item.handle;
    showCard(item);
  }

  document.addEventListener('keydown', (event) => {
    const active = document.activeElement;
    const typing = !!active
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    if (typing && !active.closest('.onlydm-friends-hidden')) return;
    if (!['Enter', 'Escape', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    handleKey(event.key);
  }, true);

  function ensureSectionParts(section) {
    let label = section.querySelector('.onlydm-section-label');
    if (!label) {
      section.replaceChildren();
      label = document.createElement('span');
      label.className = 'onlydm-section-label';
      const refresh = document.createElement('button');
      refresh.className = 'onlydm-refresh';
      refresh.textContent = '↻';
      refresh.title = '팔로잉 목록 새로고침';
      // The list is kept between visits; this is the only thing that re-reads it.
      refresh.addEventListener('click', () => {
        if (harvesting) return;
        friendStore.clear();
        reportedCount = -1;
        render();
        harvest().catch((error) => fail('refresh', error));
      });
      section.append(label, refresh);
    }
    const refresh = section.querySelector('.onlydm-refresh');
    if (refresh) refresh.dataset.busy = String(harvesting);
    return label;
  }

  function avatarNode(item, className) {
    const wrap = document.createElement('div');
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
    if (!shell) return;
    closeCard();
    cardKey = item.handle;

    const backdrop = document.createElement('div');
    backdrop.className = 'onlydm-card-backdrop';
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeCard(); });

    const card = document.createElement('div');
    card.className = 'onlydm-card';
    card.appendChild(avatarNode(item));

    const name = document.createElement('div');
    name.className = 'onlydm-card-name';
    name.textContent = shownName(item);
    name.contentEditable = 'true';
    name.spellcheck = false;
    name.title = '이 이름은 이 컴퓨터에서만 바뀝니다.';
    name.addEventListener('keydown', (event) => {
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
    handle.textContent = '@' + item.handle;
    const hint = document.createElement('div');
    hint.className = 'onlydm-card-hint';
    hint.textContent = '이름을 눌러 바꾸세요 · 내 화면에만 적용';
    card.append(name, handle, hint);

    const actions = document.createElement('div');
    actions.className = 'onlydm-card-actions';
    for (const [label, message, primary] of [
      ['1:1 채팅', { type: 'open-friend-chat', handle: item.handle, name: item.name }, true],
      ['음성 통화', { type: 'open-friend-call', handle: item.handle, name: item.name, mode: 'voice' }, false],
      ['영상 통화', { type: 'open-friend-call', handle: item.handle, name: item.name, mode: 'video' }, false],
    ]) {
      const button = document.createElement('button');
      button.textContent = label;
      if (primary) button.className = 'primary';
      button.addEventListener('click', () => { post(message); closeCard(); });
      actions.appendChild(button);
    }
    card.appendChild(actions);

    backdrop.appendChild(card);
    (shell.querySelector('.onlydm-scale') || shell).appendChild(backdrop);
  }

  function closeCard() {
    cardKey = '';
    document.querySelector(`#${shellId} .onlydm-card-backdrop`)?.remove();
  }

  function render() {
    const shell = ensureShell();
    if (!shell) return;

    const me = meRow();
    const meNode = shell.querySelector('.onlydm-me');
    const needsAvatar = !!(meNode && me.avatar && !meNode.querySelector('img'));
    if (meNode && (meNode.dataset.handle !== me.handle || needsAvatar)) {
      meNode.dataset.handle = me.handle;
      meNode.replaceChildren(avatarNode(me));
      const text = document.createElement('div');
      const name = document.createElement('div');
      name.className = 'onlydm-name';
      name.textContent = me.handle;
      const hint = document.createElement('div');
      hint.className = 'onlydm-handle';
      hint.textContent = '계정 전환';
      text.append(name, hint);
      meNode.appendChild(text);
      meNode.addEventListener('click', () => post({ type: 'switch-account' }));
    }

    const all = Array.from(friendStore.values());
    const items = filter
      ? all.filter((item) => `${item.name} ${shownName(item)} ${item.handle}`.toLocaleLowerCase().includes(filter))
      : all;
    const section = shell.querySelector('.onlydm-section');
    const label = section && ensureSectionParts(section);
    if (label) label.textContent = filter ? `검색 결과 ${items.length}` : `팔로잉 ${followingCountText() || all.length}`;

    const list = shell.querySelector('.onlydm-friend-list');
    if (!list) return;

    if (!items.length) {
      if (!list.querySelector('.onlydm-empty')) {
        const empty = document.createElement('div');
        empty.className = 'onlydm-empty';
        empty.textContent = filter ? '검색 결과가 없습니다.' : '팔로잉 목록을 불러오는 중입니다.';
        list.replaceChildren(empty);
      }
    } else {
      const existing = new Map();
      for (const row of list.querySelectorAll('.onlydm-friend')) existing.set(row.dataset.handle, row);
      const next = items.map((item) => {
        let row = existing.get(item.handle);
        if (!row) {
          row = document.createElement('div');
          row.className = 'onlydm-friend';
          row.dataset.handle = item.handle;
          row.appendChild(avatarNode(item));
          const text = document.createElement('div');
          const name = document.createElement('div');
          name.className = 'onlydm-name';
          const handle = document.createElement('div');
          handle.className = 'onlydm-handle';
          text.append(name, handle);
          row.appendChild(text);
          row.addEventListener('click', () => {
            selectedHandle = row.dataset.handle;
            showCard(friendStore.get(row.dataset.handle));
          });
          row.addEventListener('dblclick', () => {
            const friend = friendStore.get(row.dataset.handle);
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
      post({ type: 'friends-count', count: all.length, label: followingCountText() });
    }
    hideProfile();
  }

  async function harvest() {
    harvesting = true;
    try {
      diag.phase = 'trigger';
      let trigger = null;
      // The profile header renders after the document loads; the projection is injected
      // long before that, so the link is waited for rather than declared missing.
      for (let attempt = 0; attempt < 60 && !trigger; attempt += 1) {
        trigger = followingTrigger();
        if (!trigger) await sleep(500);
      }
      if (!trigger) {
        fail('trigger', `following link not found (w=${window.innerWidth}, links=${document.querySelectorAll('a').length})`);
        return;
      }
      trigger.click();

      for (let waited = 0; waited < 8000 && !document.querySelector('div[role="dialog"]'); waited += 200) {
        await sleep(200);
      }
      diag.dialog = !!document.querySelector('div[role="dialog"]');
      diag.phase = 'scroller';
      if (!dialogScroller()) { fail('dialog', 'following dialog not found'); return; }

      let previous = '';
      let stalls = 0;
      for (let page = 0; page < 160; page += 1) {
        // Instagram re-renders the dialog as it loads, which detaches any cached
        // element: a stale node reports scrollHeight 0 and every page becomes a no-op.
        const scroller = dialogScroller();
        if (!scroller) { await sleep(500); continue; }

        diag.phase = 'page';
        diag.pages += 1;
        diag.scroller = true;
        diag.sh = scroller.scrollHeight;
        diag.ch = scroller.clientHeight;
        diag.top = Math.round(scroller.scrollTop);
        mergeDialogRows();
        render();

        // scrollTop pins at its maximum after every page, so it looks stalled while
        // more entries are still loading. scrollHeight is the real progress signal.
        const key = `${scroller.scrollHeight}:${friendStore.size}`;
        if (key === previous) {
          stalls += 1;
          diag.stalls = stalls;
          if (stalls >= 8) break;
          await sleep(600);
        } else {
          stalls = 0;
        }
        previous = key;
        pageDown(scroller);
        // Stall detection watches scrollHeight, so a shorter wait is safe and roughly
        // halves the time to collect a large following list.
        await sleep(700);
      }

      mergeDialogRows();
    } catch (error) {
      fail('harvest', error);
    } finally {
      harvesting = false;
      diag.phase = 'done';
      render();
      // The conversation list only knows display names. Handing it the roster lets the
      // chat search find people by their Instagram handle too.
      post({
        type: 'friends-roster',
        people: Array.from(friendStore.values())
          .map((item) => ({ handle: item.handle, name: item.name, avatar: item.avatar || '' })),
      });
      post({ type: 'friends-ready' });
    }
  }

  window.chrome?.webview?.addEventListener('message', (event) => {
    if (event.data?.type === 'friends-refresh') {
      if (harvesting) return;
      friendStore.clear();
      reportedCount = -1;
      render();
      harvest().catch((error) => fail('refresh', error));
    }
    if (event.data?.type === 'friends-seed') {
      for (const person of event.data.people || []) {
        if (!person?.handle || friendStore.has(person.handle)) continue;
        friendStore.set(person.handle, {
          handle: person.handle,
          name: person.name || person.handle,
          avatar: person.avatar || '',
        });
      }
      seeded = friendStore.size > 0;
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
      post({ type: 'friends-ready' });
      window.__onlydmFriendsRerun = () => { render(); post({ type: 'friends-ready' }); };
      window.__onlydmFriendsState = () => ({ ...diag, store: friendStore.size, harvesting, seeded });

      // Wait briefly for the cached list from the host; only collect again when there
      // is nothing to show or the user presses refresh.
      setTimeout(() => {
        // A cache that is clearly short of Instagram's own following count is only a
        // head start, not the whole list, so collecting continues from there.
        const reported = parseInt((followingCountText() || '0').replace(/[^\d]/g, ''), 10) || 0;
        if (seeded && (reported === 0 || friendStore.size >= reported * 0.9)) return;
        harvest().catch((error) => fail('start', error));
      }, 1800);
    } catch (error) {
      fail('start', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
""";
    }
}

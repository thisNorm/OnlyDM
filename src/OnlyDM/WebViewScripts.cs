using System.Text.Json;

namespace OnlyDM;

public static class WebViewScripts
{
    private static object InboxPalette(AppThemePalette palette) => new
    {
        accent = palette.Accent,
        accentText = palette.AccentText,
        surface = palette.Surface,
        surfaceAlt = palette.SurfaceAlt,
        text = palette.Text,
        muted = palette.MutedText,
        border = palette.Border,
    };

    private static object ChatPalette(AppThemePalette palette) => new
    {
        accent = palette.Accent,
        accentText = palette.AccentText,
        background = palette.ChatBackground,
        incoming = palette.IncomingBubble,
        outgoing = palette.OutgoingBubble,
        outgoingText = palette.OutgoingText,
        text = palette.Text,
        border = palette.Border,
    };

    // Repainting by reloading would re-harvest every conversation, so the new palette
    // is pushed into the live projection instead.
    public static string BuildInboxThemeMessage(AppThemePalette palette) =>
        JsonSerializer.Serialize(new { type = "set-theme", palette = InboxPalette(palette) });

    public static string BuildChatThemeMessage(AppThemePalette palette) =>
        JsonSerializer.Serialize(new { type = "set-theme", palette = ChatPalette(palette) });

    public static string BuildInboxScript(AppThemePalette palette)
    {
        var paletteJson = JsonSerializer.Serialize(InboxPalette(palette));

        return $$"""
(() => {
  // NavigationCompleted can fire more than once per document. Re-running the whole
  // script would leave a second observer and an empty store fighting the first over
  // the same list, which collapses the projected list back to the visible rows.
  if (window.__onlydmInboxRerun) { window.__onlydmInboxRerun(); return; }

  const palette = {{paletteJson}};
  const marker = 'onlydm-inbox-style';
  const shellId = 'OnlyDmShell';
  let currentFilter = '';
  let currentAliases = [];
  let selectedKey = '';
  let snapshotPrimed = false;
  let observer = null;
  let renderTimer = 0;
  let opening = false;
  let openingSince = 0;
  // A click that arrives while the list is walking back from a conversation used to be
  // dropped without a trace, which is why reopening a room right after leaving it did
  // nothing for a few seconds.
  let queuedOpen = null;
  let harvesting = false;
  let reportedCount = -1;
  let accountPanelOpen = false;
  let openingKey = '';
  const PAGE_SIZE = 25;
  let nicknames = {};
  let visibleCount = PAGE_SIZE;
  let unreadOnly = false;
  const threadSnapshot = new Map();
  const threadStore = new Map();
  const notifiedPreview = new Map();
  const readOverride = new Map();
  const sourceOffset = new Map();

  function post(message) {
    try { window.chrome?.webview?.postMessage(message); } catch (_) { }
  }

  function reportProjectionError(stage, error) {
    const message = String(error?.message || error || 'Unknown projection error');
    post({ type: 'projection-error', stage, message });
  }

  function isDirectPage() {
    return location.pathname.startsWith('/direct');
  }

  function isLoginPage() {
    return location.pathname.startsWith('/accounts/login');
  }

  // Instagram's inbox rows carry no thread URL: each row is a role="button" div that
  // routes client-side. Rows are identified structurally (avatar image + name span).
  function sourceThreadRows() {
    return Array.from(document.querySelectorAll('div[role="button"][tabindex="0"]'))
      .filter((row) => !row.closest?.(`#${shellId}`))
      .filter((row) => row.querySelector('img'))
      .filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.width > 150 && rect.height >= 44 && rect.height <= 160;
      });
  }

  function sourceDiagnostics() {
    return {
      rowButtons: document.querySelectorAll('div[role="button"][tabindex="0"]').length,
      titleSpans: document.querySelectorAll('span[title]').length,
      images: document.querySelectorAll('img').length,
      path: location.pathname,
    };
  }

  function canonicalThreadHref(row) {
    const link = row.querySelector('[href*="/direct/t/"]');
    const raw = link?.getAttribute('href') || link?.href || '';
    if (!raw) return '';
    try {
      const uri = new URL(raw, location.origin);
      const host = uri.hostname.toLowerCase();
      if (uri.protocol !== 'https:' || (host !== 'instagram.com' && host !== 'www.instagram.com')) return '';
      if (!uri.pathname.startsWith('/direct/t/')) return '';
      return uri.origin + uri.pathname.replace(/\/+$/, '');
    } catch (_) {
      return '';
    }
  }

  // Instagram does not always give a conversation row an address. Falling back to the
  // row element's identity looked fine until the element was recycled: the same
  // conversation came back as a brand new one, so the list filled up with duplicates
  // and the older copy pointed at a row that no longer existed. The name is stable for
  // as long as the row is on screen, which is all this has to survive.
  function threadKey(href, title) {
    return href || `name:${title}`;
  }

  // Instagram serves some names and messages as decomposed (NFD) Hangul. Chromium
  // shapes that correctly, but Windows notifications render it as loose jamo, so
  // everything is composed to NFC at extraction time.
  const JAMO_LEAD = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
  const JAMO_VOWEL = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
  const JAMO_TAIL = 'ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';

  // NFC never composes compatibility jamo (U+3130..U+318F), so a display name stored
  // that way stays broken. Only runs where a lead consonant is followed by a vowel,
  // which leaves deliberate consonant/vowel runs such as ㅋㅋㅋ, ㅇㅈ or ㅠㅠ untouched.
  function composeCompatJamo(value) {
    let out = '';
    for (let i = 0; i < value.length;) {
      const lead = JAMO_LEAD.indexOf(value[i]);
      // ''.indexOf('') is 0, so a missing character must be checked explicitly or a
      // trailing consonant would compose with jamo index 0 (ㅋ became 카).
      const vowelChar = value[i + 1];
      const vowel = lead >= 0 && vowelChar ? JAMO_VOWEL.indexOf(vowelChar) : -1;
      if (lead < 0 || vowel < 0) {
        out += value[i];
        i += 1;
        continue;
      }

      // A trailing consonant belongs to the next syllable when a vowel follows it.
      const next = value[i + 2];
      const candidate = next ? JAMO_TAIL.indexOf(next) + 1 : 0;
      const after = value[i + 3];
      const tail = candidate > 0 && (!after || JAMO_VOWEL.indexOf(after) < 0) ? candidate : 0;
      out += String.fromCharCode(0xAC00 + (lead * 21 + vowel) * 28 + tail);
      i += tail > 0 ? 3 : 2;
    }
    return out;
  }

  function nfc(value) {
    try { return composeCompatJamo(String(value || '').normalize('NFC')); } catch (_) { return String(value || ''); }
  }

  function isSeparator(line) {
    return /^[·•・|]+$/.test(line);
  }

  // Not every time label counts minutes. A fresh message reads "지금", and once it
  // aged into "1분" the preview changed underneath us and announced itself again.
  function isTimestamp(line) {
    return /^\d+\s*(초|분|시간|일|주|년|s|m|h|d|w|y)$/.test(line)
      || /(전|ago)$/.test(line)
      || /^(지금|방금|방금 전|오늘|어제|그저께|now|just now|yesterday)$/i.test(line)
      || /^(오전|오후)\s*\d{1,2}:\d{2}$/.test(line)
      || /^\d{1,2}:\d{2}(\s*(AM|PM))?$/i.test(line)
      || /^\d{1,2}월\s*\d{1,2}일$/.test(line);
  }

  // The source rows are visibility:hidden, so innerText yields nothing. Walk text
  // nodes instead: that is layout independent and keeps DOM order.
  function textLines(row) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const lines = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      // <title> inside an icon is an accessibility label ("소리 끔"), not conversation text.
      if (node.parentElement?.closest('svg')) continue;
      const value = nfc(node.textContent).replace(/\s+/g, ' ').trim();
      if (value && !isSeparator(value) && lines[lines.length - 1] !== value) lines.push(value);
    }
    return lines;
  }

  // Instagram marks an unread row two ways: a small solid dot, and font-weight 600
  // on the name and preview (read rows are 400). Either one is enough.
  function isUnread(row) {
    for (const element of row.querySelectorAll('span, div')) {
      const rect = element.getBoundingClientRect();
      if (rect.width < 5 || rect.width > 16 || Math.abs(rect.width - rect.height) > 3) continue;
      const background = getComputedStyle(element).backgroundColor;
      if (background && background !== 'transparent' && background !== 'rgba(0, 0, 0, 0)') return true;
    }

    for (const element of row.querySelectorAll('span, div')) {
      const hasText = Array.from(element.childNodes)
        .some((node) => node.nodeType === 3 && node.textContent.trim());
      if (!hasText) continue;
      if (parseInt(getComputedStyle(element).fontWeight, 10) >= 600) return true;
    }
    return false;
  }

  // Instagram shortens a long name with an ellipsis while the row is being drawn and
  // fills in the full one a moment later. The shortened form must never become a name:
  // two group chats that differ only past the cut - "...\ud604\uc815\ud55c\ub2d8 \uc678 4\uba85" and "...\uc678 7\uba85" -
  // would collapse into a single conversation.
  function isTruncated(value) {
    return /[\u2026]\s*$/.test(value) || /\.{3,}\s*$/.test(value);
  }

  function cloneThreadData(row) {
    const lines = textLines(row);
    const titleSpan = row.querySelector('span[title]');
    const full = nfc(titleSpan?.getAttribute('title') || '').trim();
    const title = full || nfc(lines[0] || 'Instagram DM').trim();
    // No full name yet and what is drawn is cut short: the row is still being built.
    // Reading it now would file the conversation under a name it will not keep.
    const partial = !full && isTruncated(title);
    // Trailing relative time ticks every minute. Leaving it inside the preview made
    // the preview change on its own, which re-fired the notification for old mail.
    const rest = lines.filter((line) => line !== title);
    let end = rest.length;
    while (end > 0 && isTimestamp(rest[end - 1])) end -= 1;
    const timestamp = end < rest.length ? rest[end] : '';
    // The alternate rendering pads a row with its own status words and puts the time in
    // the middle. Left in, they became part of the preview and read as a new message.
    const body = rest.slice(0, end).filter((line) =>
      !isTimestamp(line)
      && !/^(unread|read|안 읽음|읽지 않음)$/i.test(line)
      && !/^\d+\s+new\s+messages?$/i.test(line)
      && !/^새 메시지\s*\d*개?$/.test(line));
    const avatars = Array.from(row.querySelectorAll('img'))
      .map((image) => image.currentSrc || image.src || '')
      .filter(Boolean)
      .slice(0, 4);
    const href = canonicalThreadHref(row);
    return {
      key: threadKey(href, title),
      href,
      title,
      preview: body.join(' '),
      timestamp,
      avatarSrcs: avatars,
      searchText: lines.join(' ').toLocaleLowerCase(),
      unread: isUnread(row),
      partial,
    };
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function sourceScroller() {
    const first = sourceThreadRows()[0];
    for (let node = first?.parentElement; node; node = node.parentElement) {
      if (node.scrollHeight > node.clientHeight + 40 && node.clientHeight > 100) return node;
    }
    return null;
  }

  // A Map keeps a key where it was first inserted, so a conversation that just received
  // a message stayed wherever it had been harvested. Rebuilding with it at the front is
  // what actually moves the row to the top.
  function promoteThread(key) {
    const item = threadStore.get(key);
    if (!item) return;
    const rest = Array.from(threadStore.entries()).filter(([entryKey]) => entryKey !== key);
    threadStore.clear();
    threadStore.set(key, item);
    for (const [entryKey, value] of rest) threadStore.set(entryKey, value);
  }

  // Instagram's own list is the authority on order. Whenever it sits at the top, the
  // rows on screen are the newest ones, so they are pulled to the front in exactly that
  // order; a first render against a half-loaded list used to leave the top scrambled.
  function applySourceOrder(keys) {
    const head = keys.filter((key, index) =>
      threadStore.has(key) && keys.indexOf(key) === index);
    if (head.length < 2) return;
    const rest = Array.from(threadStore.entries()).filter(([key]) => !head.includes(key));
    const front = head.map((key) => [key, threadStore.get(key)]);
    threadStore.clear();
    for (const [key, value] of front) threadStore.set(key, value);
    for (const [key, value] of rest) threadStore.set(key, value);
  }

  // Instagram draws the same conversation two ways: sometimes the row carries the
  // thread address, sometimes nothing at all. A row without an address is filed under
  // its name until the address turns up, and then the two are folded together - other-
  // wise one conversation sits in the list twice, once per spelling of its identity.
  const titleIndex = new Map();

  function settleKey(item) {
    const known = titleIndex.get(item.title);
    if (known && known !== item.key) {
      const provisional = item.key.startsWith('name:');
      const knownProvisional = known.startsWith('name:');
      // Two real addresses are two real conversations that happen to share a name.
      if (provisional) return known;
      if (knownProvisional) threadStore.delete(known);
    }
    return item.key;
  }

  function mergeVisibleRows() {
    const scroller = sourceScroller();
    const offset = scroller ? scroller.scrollTop : 0;
    const arrived = [];
    const visible = [];
    for (const row of sourceThreadRows()) {
      const item = cloneThreadData(row);
      if (item.partial) continue;
      item.key = settleKey(item);
      titleIndex.set(item.title, item.key);
      // Remember how far down the hidden list this conversation was, so opening it
      // later can jump straight there instead of paging from the top.
      if (scroller) sourceOffset.set(item.key, offset);

      // Opening a conversation reads it, but Instagram's own row keeps showing the
      // unread marker for a while. Trust the local state until a newer message lands.
      if (readOverride.has(item.key)) {
        if (readOverride.get(item.key) === item.preview) item.unread = false;
        else readOverride.delete(item.key);
      }

      const previous = threadStore.get(item.key);
      threadStore.set(item.key, item);

      // A changed preview or a fresh unread mark means a message landed. Timestamps are
      // not a signal: they tick on their own, which is what once caused repeat alerts.
      // Only a conversation we already knew can have "changed". Treating a first
      // sighting as new mail pulled every old conversation the search scrolled past
      // up to the top of the list.
      const landed = !!previous
        && (previous.preview !== item.preview || (!previous.unread && item.unread));
      if (landed) arrived.push(item.key);
      visible.push(item.key);
    }

    // Paging down the list is how the order is collected in the first place, so
    // neither the opening sweep nor a search for one row may reshuffle it on the way.
    if ((harvesting || opening) && offset > 4) return;
    if (offset <= 4) {
      applySourceOrder(visible);
      return;
    }
    // Out of sight of the top, a changed conversation still belongs at the front.
    // Source rows run newest first, so promoting in reverse leaves them in that order.
    for (const key of arrived.reverse()) promoteThread(key);
  }

  function markThreadRead(key) {
    const item = threadStore.get(key);
    if (!item) return;
    item.unread = false;
    readOverride.set(key, item.preview);
    renderThreadList();
  }

  // Going back through the SPA keeps the harvested list alive; a real navigation would
  // throw away every conversation collected so far and start the sweep again.
  // The address changes back before Instagram has drawn a single row again. Returning
  // at that moment left the next click searching an empty list.
  async function waitForRows() {
    for (let waited = 0; waited < 5000; waited += 150) {
      if (sourceThreadRows().length) return true;
      await sleep(150);
    }
    return false;
  }

  async function returnToInbox() {
    if (location.pathname.startsWith('/direct/inbox')) return;
    try { history.back(); } catch (_) { }

    for (let waited = 0; waited < 4000; waited += 100) {
      if (location.pathname.startsWith('/direct/inbox')) {
        await waitForRows();
        renderThreadList();
        return;
      }
      await sleep(100);
    }
    post({ type: 'need-inbox' });
  }

  // Setting scrollTop on the derived container does not always move Instagram's
  // virtualised list, which made the search stall out and report "not found" for a
  // conversation that was in the store. Nudging the last rendered row into view
  // advances the list whichever element actually scrolls.
  function pageDown(scroller) {
    const before = scroller.scrollTop;
    const step = Math.max(scroller.clientHeight - 72, 120);
    scroller.scrollTop = Math.min(scroller.scrollTop + step, scroller.scrollHeight);
    if (scroller.scrollTop !== before) return true;

    const rows = sourceThreadRows();
    const last = rows[rows.length - 1];
    if (!last) return false;
    try { last.scrollIntoView({ block: 'end' }); } catch (_) { last.scrollIntoView(false); }
    return true;
  }

  // Instagram virtualises the inbox: only rows inside the viewport exist in the DOM.
  // Page the hidden source list once so the projected list holds every conversation.
  // Projection is injected on NavigationCompleted, well before Instagram has rendered
  // any rows, so the list is waited for rather than treated as a failure.
  async function waitForScroller() {
    for (let attempt = 0; attempt < 75; attempt += 1) {
      const scroller = sourceScroller();
      if (scroller) return scroller;
      await sleep(400);
    }
    return null;
  }

  async function harvestThreads() {
    const scroller = await waitForScroller();
    // A genuinely empty inbox is reported by the retry loop's diagnostics instead.
    if (!scroller) return;

    harvesting = true;
    try {
      scroller.scrollTop = 0;
      await sleep(200);

      // Instagram appends older conversations while scrolling, so a stalled scroll
      // usually means "still loading", not "end of list". Give it a few chances.
      let previousTop = -1;
      let stalls = 0;
      for (let page = 0; page < 120; page += 1) {
        // Opening a conversation scrolls this same source list; let it finish first.
        while (opening) await sleep(200);

        mergeVisibleRows();
        renderThreadList();

        if (scroller.scrollTop === previousTop) {
          stalls += 1;
          if (stalls >= 4) break;
          await sleep(700);
        } else {
          stalls = 0;
        }

        previousTop = scroller.scrollTop;
        pageDown(scroller);
        await sleep(260);
      }

      scroller.scrollTop = 0;
      await sleep(150);
      mergeVisibleRows();
    } finally {
      harvesting = false;
      snapshotPrimed = false;
      renderThreadList();
    }
  }

  async function findSourceRow(title) {
    // `title` may be a single name or a list of candidates.
    // A row's name comes from span[title] only while Instagram truncates it, and from
    // the first text line otherwise, so the same conversation can key two ways
    // depending on scroll position. Match either form.
    const titlesOf = (row) => {
      const attribute = nfc(row.querySelector('span[title]')?.getAttribute('title') || '').trim();
      const lines = textLines(row);
      return [attribute, (lines[0] || '').trim(), cloneThreadData(row).title].filter(Boolean);
    };
    // The friends list and the conversation list rarely spell a person the same way
    // (honorifics, full name vs handle), so every plausible spelling is tried.
    const wanted = (Array.isArray(title) ? title : [title])
      .map((value) => nfc(value).trim())
      .filter((value) => value.length >= 2);
    const hit = (rowTitle) => {
      const left = rowTitle.toLocaleLowerCase();
      return wanted.some((value) => {
        const right = value.toLocaleLowerCase();
        return left === right || left.includes(right) || right.includes(left);
      });
    };
    const match = () => sourceThreadRows().find((row) => titlesOf(row).some(hit));
    let found = match();
    if (found) return found;

    // sourceScroller() is derived from the currently rendered rows, so asking for it
    // mid-scroll can return nothing; wait for the list instead of giving up.
    const scroller = await waitForScroller();
    if (!scroller) return null;

    // Jump to the remembered offset first: a conversation far down the list used to
    // cost a full sweep from the top.
    for (const candidate of wanted) {
      if (!sourceOffset.has(candidate)) continue;
      const remembered = sourceOffset.get(candidate);
      for (const guess of [remembered, Math.max(0, remembered - 300), remembered + 300]) {
        scroller.scrollTop = guess;
        await sleep(220);
        found = match();
        if (found) return found;
      }
      break;
    }

    const restore = scroller.scrollTop;
    scroller.scrollTop = 0;
    await sleep(200);

    let previousTop = '';
    let stalls = 0;
    for (let page = 0; page < 160; page += 1) {
      found = match();
      if (found) return found;

      const firstKey = (textLines(sourceThreadRows()[0] || document.createElement('div'))[0] || '') + scroller.scrollTop;
      if (firstKey === previousTop) {
        stalls += 1;
        if (stalls >= 5) break;
        await sleep(600);
      } else {
        stalls = 0;
      }

      previousTop = firstKey;
      pageDown(scroller);
      await sleep(260);
    }

    found = match();
    if (found) return found;

    scroller.scrollTop = restore;
    return null;
  }

  async function findSourceRowByKey(key) {
    const match = () => sourceThreadRows().find((row) => cloneThreadData(row).key === key);
    let found = match();
    if (found) return found;

    const scroller = await waitForScroller();
    if (!scroller) return null;
    const restore = scroller.scrollTop;
    scroller.scrollTop = 0;
    await sleep(200);

    let previousTop = -1;
    let stalls = 0;
    for (let page = 0; page < 160; page += 1) {
      found = match();
      if (found) return found;

      if (scroller.scrollTop === previousTop) {
        stalls += 1;
        if (stalls >= 5) break;
        await sleep(600);
      } else {
        stalls = 0;
      }

      previousTop = scroller.scrollTop;
      pageDown(scroller);
      await sleep(260);
    }

    scroller.scrollTop = restore;
    return null;
  }

  function openDiagnostics(wanted) {
    const rows = sourceThreadRows();
    const seen = rows.map((row) => {
      const attribute = nfc(row.querySelector('span[title]')?.getAttribute('title') || '').trim();
      const first = (textLines(row)[0] || '').trim();
      return `${attribute.length}/${first.length}${attribute === first ? '=' : '!'}`;
    });
    return `rows=${rows.length}, store=${threadStore.size}, inStore=${threadStore.has(wanted)}, wantLen=${wanted.length}, seen=${seen.join(',')}`;
  }

  // No thread URL exists until Instagram routes to it, so opening a chat means
  // replaying a real click on the hidden row and waiting for /direct/t/ to appear.
  // The row may be scrolled out of the virtualised list, so it is searched for first.
  async function openThreadByKey(key, title) {
    const wantedKey = String(key || '').trim();
    const wanted = String(title || '').trim();
    if (!wantedKey && !wanted) return;
    // An open that never finished used to leave this latched forever, and every later
    // click on any conversation was dropped in silence.
    if (opening && Date.now() - openingSince < 30000) {
      queuedOpen = { key: wantedKey, title: wanted };
      return;
    }
    opening = true;
    openingSince = Date.now();
    // Finding a conversation can mean paging through Instagram's virtualised list,
    // which takes seconds. Without this the row looked completely unresponsive.
    openingKey = wantedKey || wanted;
    renderThreadList();

    try {
      // The key is tried first because two conversations can share a display name;
      // the name is the fallback for a row whose key has changed since it was read.
      let row = wantedKey ? await findSourceRowByKey(wantedKey) : null;
      if (!row && wanted) row = await findSourceRow(wanted);
      if (!row) {
        reportProjectionError('open', `Conversation not found (${openDiagnostics(wantedKey || wanted)})`);
        return;
      }

      if (!(await openRowElement(row, wanted))) {
        reportProjectionError('open', `Thread route not reached (path=${location.pathname})`);
      }
    } catch (error) {
      reportProjectionError('open', error);
    } finally {
      opening = false;
      openingKey = '';
      renderThreadList();
      const next = queuedOpen;
      queuedOpen = null;
      // Let Instagram finish redrawing the list before chasing the queued click.
      if (next) setTimeout(() => openThreadByKey(next.key, next.title), 400);
    }
  }

  function ensureStyle() {
    if (document.getElementById(marker)) return;
    const style = document.createElement('style');
    style.id = marker;
    style.textContent = `
      html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: ${palette.surface} !important; }
      /* Kill every native scrollbar in the document; OnlyDM draws its own. */
      html, body, * { scrollbar-width: none !important; -ms-overflow-style: none !important; }
      ::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
      ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-track { background: transparent !important; }
      body > *:not(#OnlyDmShell).onlydm-source-hidden { visibility: hidden !important; pointer-events: none !important; }
      #OnlyDmShell { position: fixed; inset: 0; z-index: 2147483647; display: flex; flex-direction: column; background: ${palette.surface}; color: ${palette.text}; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; overflow: hidden; }
      #OnlyDmShell * { box-sizing: border-box; }
      #OnlyDmShell .onlydm-thread-list { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; padding: 6px 8px 12px; }
      #OnlyDmShell .onlydm-thread-list::-webkit-scrollbar, #OnlyDmShell *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
      /* auto, not thin: specifying scrollbar-width makes Chromium ignore the
         ::-webkit-scrollbar sizing below. */
      #OnlyDmShell .onlydm-thread-list { scrollbar-width: auto !important; }
      #OnlyDmShell .onlydm-thread-list::-webkit-scrollbar { width: 10px !important; display: block !important; }
      #OnlyDmShell .onlydm-thread-list::-webkit-scrollbar-track { background: transparent !important; }
      #OnlyDmShell .onlydm-thread-list::-webkit-scrollbar-thumb { background: ${palette.muted} !important; border-radius: 5px !important; border: 3px solid transparent !important; background-clip: content-box !important; }
      #OnlyDmShell .onlydm-empty { padding: 42px 18px; text-align: center; color: ${palette.muted}; font-size: 13px; }
      #OnlyDmShell .onlydm-thread-row { width: 100%; min-height: 68px; display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; gap: 11px; align-items: center; padding: 9px 10px; border-radius: 10px; cursor: default; user-select: none; transition: background .12s ease; }
      #OnlyDmShell .onlydm-thread-row:hover { background: ${palette.surfaceAlt}; }
      #OnlyDmShell .onlydm-thread-row[data-selected="true"] { background: ${palette.surfaceAlt}; }
      #OnlyDmShell .onlydm-thread-row[data-opening="true"] { opacity: .5; }
      #OnlyDmShell .onlydm-avatar { width: 46px; height: 46px; border-radius: 16px; overflow: hidden; background: ${palette.surfaceAlt}; display: grid; place-items: center; color: ${palette.muted}; font-weight: 650; font-size: 15px; gap: 2px; }
      #OnlyDmShell .onlydm-avatar img { width: 100%; height: 100%; object-fit: cover; }
      #OnlyDmShell .onlydm-avatar[data-tiles="2"] { grid-template-columns: 1fr 1fr; }
      #OnlyDmShell .onlydm-avatar[data-tiles="3"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
      #OnlyDmShell .onlydm-avatar[data-tiles="3"] img:first-child { grid-column: span 2; }
      #OnlyDmShell .onlydm-avatar[data-tiles="4"] { grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
      #OnlyDmShell .onlydm-chips { display: flex; gap: 6px; padding: 8px 10px 6px; overflow-x: auto; scrollbar-width: none; flex: 0 0 auto; }
      #OnlyDmShell .onlydm-chips::-webkit-scrollbar { display: none !important; }
      #OnlyDmShell .onlydm-chip { display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 13px; border-radius: 15px; border: 1px solid ${palette.border}; background: ${palette.surface}; color: ${palette.text}; font-size: 12px; font-weight: 600; white-space: nowrap; cursor: default; user-select: none; }
      #OnlyDmShell .onlydm-chip[data-active="true"] { background: #191919; border-color: #191919; color: #FFFFFF; }
      #OnlyDmShell .onlydm-chip-count { display: inline-flex; align-items: center; justify-content: center; min-width: 17px; height: 17px; padding: 0 5px; border-radius: 9px; background: #FF3B30; color: #FFFFFF; font-size: 10px; font-weight: 700; }
      #OnlyDmShell .onlydm-thread-main { min-width: 0; }
      #OnlyDmShell .onlydm-thread-title { color: ${palette.text}; font-size: 14px; font-weight: 600; line-height: 20px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #OnlyDmShell .onlydm-thread-preview { margin-top: 2px; color: ${palette.muted}; font-size: 12px; line-height: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      #OnlyDmShell .onlydm-thread-time { color: ${palette.muted}; font-size: 10px; white-space: nowrap; }
      #OnlyDmShell .onlydm-thread-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; padding-top: 3px; }
      #OnlyDmShell .onlydm-unread-badge { width: 10px; height: 10px; border-radius: 5px; background: #FF3B30; display: none; }
      #OnlyDmShell .onlydm-thread-row[data-unread="true"] .onlydm-unread-badge { display: block; }
      #OnlyDmShell .onlydm-thread-row[data-unread="true"] .onlydm-thread-title { font-weight: 700; }
      #OnlyDmShell .onlydm-thread-row[data-unread="true"] .onlydm-thread-preview { color: ${palette.text}; font-weight: 600; }
    `;
    document.head?.appendChild(style) || document.documentElement.appendChild(style);
  }

  function hideInstagramSurface() {
    if (!document.body || accountPanelOpen) return;
    for (const child of document.body.children) {
      if (child.id !== shellId) child.classList.add('onlydm-source-hidden');
    }
  }

  function ensureShell() {
    if (!document.body) return null;
    ensureStyle();
    let shell = document.getElementById(shellId);
    if (!shell) {
      shell = document.createElement('section');
      shell.id = shellId;
      shell.setAttribute('aria-label', 'OnlyDM chat list');
      const chips = document.createElement('div');
      chips.className = 'onlydm-chips';
      for (const [mode, label] of [['all', '전체'], ['unread', '안읽음']]) {
        const chip = document.createElement('div');
        chip.className = 'onlydm-chip';
        chip.dataset.mode = mode;
        const text = document.createElement('span');
        text.textContent = label;
        chip.appendChild(text);
        if (mode === 'unread') {
          const count = document.createElement('span');
          count.className = 'onlydm-chip-count';
          chip.appendChild(count);
        }
        chip.addEventListener('click', () => {
          unreadOnly = mode === 'unread';
          visibleCount = PAGE_SIZE;
          renderThreadList();
        });
        chips.appendChild(chip);
      }
      shell.appendChild(chips);

      const list = document.createElement('div');
      list.className = 'onlydm-thread-list';
      // Harvested conversations stay in memory; more are drawn only as the user scrolls.
      list.addEventListener('scroll', () => {
        if (list.scrollTop + list.clientHeight < list.scrollHeight - 240) return;
        const total = matchingThreads().length;
        if (visibleCount >= total) return;
        visibleCount = Math.min(visibleCount + PAGE_SIZE, total);
        renderThreadList();
      });
      const loading = document.createElement('div');
      loading.className = 'onlydm-empty';
      loading.textContent = '채팅 목록을 불러오는 중입니다.';
      list.appendChild(loading);
      shell.appendChild(list);
      document.body.appendChild(shell);
    }
    hideInstagramSurface();
    return shell;
  }



  function isLikelyOwnPreview(preview) {
    return /^(회원님|you)\s*:/i.test(String(preview || '').trim());
  }

  function detectThreadChanges(items) {
    // Paging the source list surfaces old conversations for the first time; those are
    // history, not new mail, so notifications stay off until the sweep finishes.
    if (harvesting || !snapshotPrimed) {
      for (const item of items) threadSnapshot.set(item.key, item.preview);
      snapshotPrimed = !harvesting;
      return;
    }

    for (const item of items) {
      const previous = threadSnapshot.get(item.key);
      threadSnapshot.set(item.key, item.preview);

      if (!item.preview || previous === item.preview || isLikelyOwnPreview(item.preview)) continue;
      // First time this conversation is seen at all: history, not new mail.
      if (previous === undefined) continue;
      // A changed preview is the whole signal. The unread mark used to be required as
      // well, which meant one styling change on Instagram's side, or a row read on the
      // phone a moment earlier, silenced every notification.
      //
      // Every preview already announced is remembered, not just the last one: a row
      // that flips between two of them announced itself again on every flip.
      const announced = notifiedPreview.get(item.key) || new Set();
      if (announced.has(item.preview)) continue;

      announced.add(item.preview);
      // Only recent previews matter for flicker; the rest is memory nobody reads.
      while (announced.size > 8) announced.delete(announced.values().next().value);
      notifiedPreview.set(item.key, announced);
      post({
        type: 'thread-notification',
        key: item.key,
        href: item.href,
        title: item.title,
        preview: item.preview,
      });
    }
  }

  function createAvatar(item) {
    const avatar = document.createElement('div');
    avatar.className = 'onlydm-avatar';
    const sources = item.avatarSrcs || [];
    if (!sources.length) {
      avatar.textContent = (item.title || '?').trim().slice(0, 1).toUpperCase();
      return avatar;
    }
    avatar.dataset.tiles = String(Math.min(sources.length, 4));
    for (const source of sources) {
      const image = document.createElement('img');
      image.src = source;
      image.alt = '';
      image.draggable = false;
      avatar.appendChild(image);
    }
    return avatar;
  }

  function createThreadRow(item) {
    const row = document.createElement('div');
    row.className = 'onlydm-thread-row';
    row.dataset.key = item.key;
    row.dataset.href = item.href || '';
    row.dataset.title = item.title;

    row.appendChild(createAvatar(item));

    const main = document.createElement('div');
    main.className = 'onlydm-thread-main';
    const title = document.createElement('div');
    title.className = 'onlydm-thread-title';
    const preview = document.createElement('div');
    preview.className = 'onlydm-thread-preview';
    main.append(title, preview);
    row.appendChild(main);

    const side = document.createElement('div');
    side.className = 'onlydm-thread-side';
    const time = document.createElement('div');
    time.className = 'onlydm-thread-time';
    const badge = document.createElement('div');
    badge.className = 'onlydm-unread-badge';
    side.append(time, badge);
    row.appendChild(side);

    // Bound to the row's key rather than a captured item, because rows are reused.
    row.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedKey = row.dataset.key;
      for (const candidate of document.querySelectorAll('#OnlyDmShell .onlydm-thread-row')) {
        candidate.dataset.selected = String(candidate === row);
      }
    });

    row.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      // The host may already know this conversation's address, which skips scrolling
      // the hidden list entirely. It asks us back only when it does not.
      post({
        type: 'request-open',
        key: row.dataset.key,
        href: row.dataset.href,
        title: row.dataset.title,
      });
    });

    updateThreadRow(row, item);
    return row;
  }

  // Rows are updated in place. Rebuilding them on every harvest page destroyed the
  // element between mousedown and dblclick, which made conversations unopenable while
  // the list was still loading.
  function updateThreadRow(row, item) {
    row.dataset.key = item.key;
    row.dataset.href = item.href || '';
    row.dataset.title = item.title;

    const unread = String(!!item.unread);
    if (row.dataset.unread !== unread) row.dataset.unread = unread;

    const selected = String(item.key === selectedKey);
    if (row.dataset.selected !== selected) row.dataset.selected = selected;

    const busy = String(item.key === openingKey || item.title === openingKey);
    if (row.dataset.opening !== busy) row.dataset.opening = busy;

    const shownTitle = nicknames[item.key] || item.title;
    const title = row.querySelector('.onlydm-thread-title');
    if (title.textContent !== shownTitle) title.textContent = shownTitle;

    const previewText = item.preview || '메시지 없음';
    const preview = row.querySelector('.onlydm-thread-preview');
    if (preview.textContent !== previewText) preview.textContent = previewText;

    const time = row.querySelector('.onlydm-thread-time');
    if (time.textContent !== item.timestamp) time.textContent = item.timestamp;

    const sources = (item.avatarSrcs || []).join('|');
    const avatar = row.querySelector('.onlydm-avatar');
    if (avatar.dataset.sources !== sources) {
      const replacement = createAvatar(item);
      replacement.dataset.sources = sources;
      avatar.replaceWith(replacement);
    }
    return row;
  }

  // Search runs over every harvested conversation, not just the drawn page.
  function matchingThreads() {
    let items = Array.from(threadStore.values());
    if (unreadOnly) items = items.filter((item) => item.unread);
    if (!currentFilter) return items;
    return items.filter((item) => {
      const text = String(item.searchText || '');
      if (text.includes(currentFilter)) return true;
      const nickname = nicknames[item.key];
      if (nickname && nickname.toLocaleLowerCase().includes(currentFilter)) return true;
      // A handle typed in search resolves through the friends roster to that person's
      // display name, which is all the conversation row actually contains.
      return currentAliases.some((alias) => alias && text.includes(alias));
    });
  }

  function filterThreads(query, aliases) {
    const next = nfc(query).trim().toLocaleLowerCase();
    const nextAliases = (aliases || []).map((alias) => nfc(alias).trim().toLocaleLowerCase()).filter(Boolean);
    if (next === currentFilter && nextAliases.join('|') === currentAliases.join('|')) return;
    currentFilter = next;
    currentAliases = nextAliases;
    visibleCount = PAGE_SIZE;
    renderThreadList();
  }
  window.__onlydmFilterThreads = filterThreads;

  function updateChips(all) {
    const unread = all.filter((item) => item.unread).length;
    for (const chip of document.querySelectorAll('#OnlyDmShell .onlydm-chip')) {
      const active = String((chip.dataset.mode === 'unread') === unreadOnly);
      if (chip.dataset.active !== active) chip.dataset.active = active;
      const count = chip.querySelector('.onlydm-chip-count');
      if (!count) continue;
      const text = unread ? String(unread) : '';
      if (count.textContent !== text) count.textContent = text;
      count.style.display = unread ? 'inline-flex' : 'none';
    }
  }

  function renderThreadList() {
    const shell = ensureShell();
    if (!shell) return false;
    mergeVisibleRows();

    const all = Array.from(threadStore.values());
    // Notifications must consider every conversation, even while a search is active.
    detectThreadChanges(all);

    const list = shell.querySelector('.onlydm-thread-list');
    if (!list) return false;

    const matching = matchingThreads();
    const shown = matching.slice(0, Math.max(visibleCount, PAGE_SIZE));
    const scrollTop = list.scrollTop;

    if (shown.length) {
      const existing = new Map();
      for (const row of list.querySelectorAll('.onlydm-thread-row')) existing.set(row.dataset.key, row);

      const next = shown.map((item) => {
        const row = existing.get(item.key);
        return row ? updateThreadRow(row, item) : createThreadRow(item);
      });

      // Touch the DOM only when the visible set actually changed, so a click in flight
      // is never interrupted by a background harvest page.
      const current = Array.from(list.children);
      const unchanged = current.length === next.length && current.every((node, i) => node === next[i]);
      if (!unchanged) list.replaceChildren(...next);
    } else {
      const empty = document.createElement('div');
      empty.className = 'onlydm-empty';
      empty.textContent = all.length ? '검색 결과가 없습니다.' : '채팅 목록을 불러오는 중입니다.';
      list.replaceChildren(empty);
    }

    list.scrollTop = scrollTop;
    updateChips(all);
    hideInstagramSurface();

    if (all.length !== reportedCount) {
      reportedCount = all.length;
      post({ type: 'inbox-count', count: all.length, unread: all.filter((item) => item.unread).length });
    }
    return all.length > 0;
  }

  function attachObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver((mutations) => {
      const sourceChanged = mutations.some((mutation) => {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        return !target?.closest?.(`#${shellId}`);
      });
      if (!sourceChanged) return;
      clearTimeout(renderTimer);
      renderTimer = setTimeout(() => {
        try { renderThreadList(); } catch (error) { reportProjectionError('render', error); }
      }, 100);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  }

  function startInboxProjection() {
    try {
      if (isLoginPage()) {
        post({ type: 'login-ready' });
        return;
      }
      if (!isDirectPage()) {
        reportProjectionError('route', `Unexpected path: ${location.pathname}`);
        return;
      }
      ensureShell();
      attachObserver();
      renderThreadList();
      post({ type: 'inbox-ready' });
      // The observer can miss Instagram's own list updates, which left conversations
      // silent after their first notification. A slow poll is the safety net.
      // A new message should show up promptly; five seconds felt like a stall.
      setInterval(() => {
        try { renderThreadList(); } catch (_) { }
      }, 1200);

      reportOwnProfile();
      window.__onlydmNfc = nfc;
      window.__onlydmState = () => ({
        opening,
        harvesting,
        accountPanelOpen,
        selectedKey,
        storeSize: threadStore.size,
        sourceRows: sourceThreadRows().length,
        hasScroller: !!sourceScroller(),
        path: location.pathname,
      });
      window.__onlydmInboxRerun = () => {
        renderThreadList();
        post({ type: 'inbox-ready' });
        harvestThreads().catch((error) => reportProjectionError('harvest', error));
      };
      harvestThreads().catch((error) => reportProjectionError('harvest', error));
      let retryCount = 0;
      const retry = setInterval(() => {
        try {
          const found = renderThreadList();
          retryCount += 1;
          if (found) {
            clearInterval(retry);
          } else if (retryCount >= 70) {
            clearInterval(retry);
            const d = sourceDiagnostics();
            reportProjectionError('threads', `No DM thread rows detected (rowButtons=${d.rowButtons}, titleSpans=${d.titleSpans}, images=${d.images}, path=${d.path})`);
          }
        } catch (error) {
          clearInterval(retry);
          reportProjectionError('retry', error);
        }
      }, 500);
    } catch (error) {
      reportProjectionError('start', error);
    }
  }

  function moveSelection(delta) {
    const list = document.querySelector('#OnlyDmShell .onlydm-thread-list');
    let rows = Array.from(document.querySelectorAll('#OnlyDmShell .onlydm-thread-row'));
    if (!rows.length) return;

    let index = rows.findIndex((row) => row.dataset.key === selectedKey);
    if (index < 0) index = delta > 0 ? -1 : 0;
    let next = index + delta;

    if (next >= rows.length) {
      // Reveal another page rather than stopping at the bottom of what is drawn.
      const total = matchingThreads().length;
      if (visibleCount < total) {
        visibleCount = Math.min(visibleCount + PAGE_SIZE, total);
        renderThreadList();
        rows = Array.from(document.querySelectorAll('#OnlyDmShell .onlydm-thread-row'));
      }
    }

    next = Math.max(0, Math.min(next, rows.length - 1));
    selectedKey = rows[next].dataset.key;
    renderThreadList();

    const current = list?.querySelector('.onlydm-thread-row[data-selected="true"]');
    if (current) current.scrollIntoView({ block: 'nearest' });
  }

  // The friends list needs the signed-in account's own profile path, which is the
  // only profile link Instagram puts in its navigation.
  function reportOwnProfile() {
    const skip = new Set(['/', '/explore/', '/reels/', '/direct/inbox/']);
    for (const anchor of document.querySelectorAll('a[href^="/"]')) {
      const href = anchor.getAttribute('href') || '';
      if (skip.has(href)) continue;
      if (!/^[/][A-Za-z0-9._]+[/]$/.test(href)) continue;
      post({ type: 'own-profile', username: href.split('/').filter(Boolean)[0] });
      return;
    }
  }

  // Someone you have never messaged has no row to click, so the conversation is
  // created through Instagram's own "new message" dialog. Nothing is sent: this only
  // opens the room.
  async function startNewChat(handle, title) {
    const wanted = String(handle || '').trim();
    if (!wanted) return false;

    const icon = document.querySelector('svg[aria-label="새로운 메시지"]');
    const button = icon && icon.closest('[role="button"], button');
    if (!button) { reportProjectionError('new-chat', 'new message button not found'); return false; }
    button.click();

    let dialog = null;
    for (let waited = 0; waited < 6000 && !dialog; waited += 200) {
      dialog = document.querySelector('div[role="dialog"]');
      if (!dialog) await sleep(200);
    }
    if (!dialog) { reportProjectionError('new-chat', 'recipient dialog not found'); return false; }

    const input = dialog.querySelector('input, textarea');
    if (!input) { reportProjectionError('new-chat', 'recipient search not found'); return false; }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    input.focus();
    if (setter && setter.set) setter.set.call(input, wanted); else input.value = wanted;
    input.dispatchEvent(new Event('input', { bubbles: true }));

    let picked = null;
    for (let waited = 0; waited < 8000 && !picked; waited += 300) {
      await sleep(300);
      const rows = Array.from(dialog.querySelectorAll('[role="button"], label, li'))
        .filter((row) => row.querySelector('img') || (row.textContent || '').includes(wanted));
      picked = rows.find((row) => (row.textContent || '').toLowerCase().includes(wanted.toLowerCase()));
    }
    if (!picked) { reportProjectionError('new-chat', `no match for ${wanted}`); return false; }
    picked.click();
    await sleep(600);

    const confirm = Array.from(dialog.querySelectorAll('[role="button"], button'))
      .find((element) => (element.textContent || '').trim() === '채팅');
    if (!confirm) { reportProjectionError('new-chat', 'chat button not found'); return false; }
    if (confirm.getAttribute('aria-disabled') === 'true') {
      reportProjectionError('new-chat', 'chat button stayed disabled');
      return false;
    }
    confirm.click();

    for (let waited = 0; waited < 8000; waited += 150) {
      if (location.pathname.startsWith('/direct/t/')) {
        post({ type: 'open-thread', href: location.href, title: title || wanted });
        markThreadRead(title || wanted);
        await returnToInbox();
        return true;
      }
      await sleep(150);
    }
    reportProjectionError('new-chat', 'thread route not reached');
    return false;
  }

  async function openRowElement(row, title) {
    const key = cloneThreadData(row).key;
    row.click();
    for (let waited = 0; waited < 6000; waited += 100) {
      if (location.pathname.startsWith('/direct/t/')) {
        post({ type: 'open-thread', href: location.href, key, title });
        markThreadRead(key);
        await returnToInbox();
        return true;
      }
      await sleep(100);
    }
    return false;
  }

  function inboxSearchInput() {
    return Array.from(document.querySelectorAll('input'))
      .find((input) => !input.closest(`#${shellId}`)) || null;
  }

  function setNativeValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    input.focus();
    if (setter && setter.set) setter.set.call(input, value); else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // The friends list and the conversation list spell people differently, so matching
  // by name is unreliable. Instagram's own DM search resolves a handle to the right
  // conversation - including people never messaged before.
  async function openFriendViaSearch(handle, title) {
    const wanted = String(handle || '').trim();
    if (!wanted) return false;

    const input = inboxSearchInput();
    if (!input) return false;

    setNativeValue(input, wanted);

    // Search returns group conversations that merely contain this person too, and a
    // group's text carries the handle as well. Only one-to-one rows qualify, and an
    // exact handle line beats a partial one.
    const needle = wanted.toLowerCase();
    let picked = null;
    for (let waited = 0; waited < 8000 && !picked; waited += 300) {
      await sleep(300);

      const candidates = sourceThreadRows()
        .map((row) => {
          const lines = textLines(row).map((line) => line.toLowerCase());
          return {
            row,
            avatars: row.querySelectorAll('img').length,
            exact: lines.some((line) => line === needle),
            contains: lines.some((line) => line.includes(needle)),
          };
        })
        .filter((candidate) => candidate.contains && candidate.avatars <= 1);

      const best = candidates.find((candidate) => candidate.exact) || candidates[0];
      picked = best ? best.row : null;
    }
    if (!picked) {
      setNativeValue(input, '');
      return false;
    }

    const opened = await openRowElement(picked, title || wanted);
    setNativeValue(inboxSearchInput() || input, '');
    return opened;
  }

  function recipientRows() {
    const dialog = document.querySelector('div[role="dialog"]');
    if (!dialog) return [];
    return Array.from(dialog.querySelectorAll('img[alt="사용자 아바타"], img[alt*="아바타"]'));
  }

  // Instagram's recipient search ignores dots and underscores, so a row never carries
  // the handle verbatim: "_est._.63" comes back as "est.63_". Both sides are reduced to
  // letters and digits, and the row text must end with the handle so that a longer
  // username like "est63218" is not mistaken for it.
  function normaliseHandle(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
  }

  function recipientScore(image, needle) {
    let node = image;
    let best = 0;
    for (let i = 0; i < 8 && node.parentElement; i += 1) {
      node = node.parentElement;
      const text = (node.textContent || '').trim();
      if (!text) continue;
      if (text.length > 400) break;

      const flat = normaliseHandle(text);
      if (!flat) continue;
      if (flat === needle) return 3;
      if (flat.endsWith(needle)) best = Math.max(best, 2);
      else if (flat.includes(needle)) best = Math.max(best, 1);
    }
    return best;
  }

  // Instagram decides one-to-one vs group from how many recipients are ticked, and it
  // reuses an existing room when one already matches, so OnlyDM just picks people.
  async function startRoom(handles) {
    const wanted = (handles || []).map((handle) => String(handle || '').trim()).filter(Boolean);
    if (!wanted.length || opening) return;

    opening = true;
    openingKey = wanted[0];
    renderThreadList();

    try {
      const icon = document.querySelector('svg[aria-label="새로운 메시지"]');
      const button = icon && icon.closest('[role="button"], button');
      if (!button) { reportProjectionError('new-room', 'new message button not found'); return; }
      button.click();

      let dialog = null;
      for (let waited = 0; waited < 8000 && !dialog; waited += 200) {
        dialog = document.querySelector('div[role="dialog"]');
        if (!dialog) await sleep(200);
      }
      if (!dialog) { reportProjectionError('new-room', 'recipient dialog not found'); return; }

      // The dialog element appears before its contents render, so the field is waited
      // for rather than read immediately.
      let input = null;
      for (let waited = 0; waited < 8000 && !input; waited += 200) {
        input = dialog.querySelector('input, textarea, [contenteditable="true"]')
          || document.querySelector('div[role="dialog"] input');
        if (!input) await sleep(200);
      }
      if (!input) { reportProjectionError('new-room', 'recipient search not found'); return; }
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');

      for (const handle of wanted) {
        input.focus();
        setter.set.call(input, handle);
        input.dispatchEvent(new Event('input', { bubbles: true }));

        const needle = normaliseHandle(handle);
        let picked = null;
        for (let waited = 0; waited < 8000 && !picked; waited += 150) {
          await sleep(150);

          let bestScore = 0;
          for (const image of recipientRows()) {
            const score = recipientScore(image, needle);
            if (score > bestScore) { bestScore = score; picked = image; }
            if (bestScore === 3) break;
          }
          // A merely partial hit is not trusted until the results settle.
          if (bestScore < 2) picked = null;
        }
        if (!picked) { reportProjectionError('new-room', `no match for ${handle}`); return; }

        // Each extra person used to cost more than a second of fixed waiting, which
        // made group creation drag; the waits now only cover the actual redraw.
        picked.click();
        await sleep(250);

        setter.set.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(200);
      }

      // Selecting recipients re-renders the dialog, so the element captured earlier is
      // detached by now: it has to be looked up again, and the label is matched loosely
      // because Instagram also uses "다음" here.
      const findConfirm = () => {
        const live = document.querySelector('div[role="dialog"]');
        if (!live) return null;
        return Array.from(live.querySelectorAll('[role="button"], button'))
          .find((element) => /^(채팅|다음|chat|next)$/i.test((element.textContent || '').trim())) || null;
      };

      let confirm = null;
      for (let waited = 0; waited < 5000 && !confirm; waited += 200) {
        confirm = findConfirm();
        if (confirm && confirm.getAttribute('aria-disabled') === 'true') confirm = null;
        if (!confirm) await sleep(200);
      }

      if (!confirm) {
        const live = document.querySelector('div[role="dialog"]');
        const labels = live
          ? Array.from(live.querySelectorAll('[role="button"], button'))
              .map((element) => (element.textContent || '').trim())
              .filter(Boolean).slice(0, 6).join('|')
          : 'no-dialog';
        reportProjectionError('new-room', `chat button not usable (saw: ${labels})`);
        return;
      }

      confirm.click();

      for (let waited = 0; waited < 10000; waited += 150) {
        if (location.pathname.startsWith('/direct/t/')) {
          post({ type: 'open-thread', href: location.href, title: wanted.join(', ') });
          await returnToInbox();
          return;
        }
        await sleep(150);
      }
      reportProjectionError('new-room', 'thread route not reached');
    } catch (error) {
      reportProjectionError('new-room', error);
    } finally {
      opening = false;
      openingKey = '';
      renderThreadList();
    }
  }

  async function openFriend(name, handle) {
    if (opening) return;

    const label = nfc(name).trim();
    const candidates = [label, `${label}님`, label.replace(/님$/, ''), String(handle || '').trim()]
      .filter(Boolean);

    opening = true;
    openingKey = label;
    renderThreadList();
    try {
      if (await openFriendViaSearch(handle, label)) return;

      const existing = await findSourceRow(candidates);
      if (existing) {
        await openRowElement(existing, label);
        return;
      }
      await startNewChat(handle, name);
    } catch (error) {
      reportProjectionError('new-chat', error);
    } finally {
      opening = false;
      openingKey = '';
      renderThreadList();
    }
  }

  function openSelectedThread() {
    const row = document.querySelector(
      `#OnlyDmShell .onlydm-thread-row[data-key="${selectedKey}"]`
    ) || document.querySelector('#OnlyDmShell .onlydm-thread-row');
    if (!row) return;
    post({
      type: 'request-open',
      key: row.dataset.key,
      href: row.dataset.href,
      title: row.dataset.title,
    });
  }

  // Keyboard has to be handled in the page: while the WebView holds focus, WPF never
  // sees the key at all.
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // While Instagram's account panel is up, Esc belongs to that dialog.
      if (!accountPanelOpen) post({ type: 'close-window' });
      return;
    }
    const active = document.activeElement;
    const typing = !!active
      && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
    // Instagram's account panel leaves focus on one of its own inputs. That field is
    // inside the hidden surface, so it must not disable keys for the visible list.
    if (typing && !active.closest('.onlydm-source-hidden')) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (event.key !== 'Enter') return;
    event.preventDefault();
    openSelectedThread();
  }, true);

  function showInstagramSurface() {
    accountPanelOpen = true;
    const shell = document.getElementById(shellId);
    if (shell) shell.style.setProperty('display', 'none', 'important');
    for (const child of document.body.children) child.classList.remove('onlydm-source-hidden');
    document.documentElement.style.setProperty('overflow', 'auto', 'important');
    document.body.style.setProperty('overflow', 'auto', 'important');
  }

  function restoreProjection() {
    accountPanelOpen = false;
    // Instagram's dialog leaves focus on one of its fields; hand it back to the list.
    try { document.activeElement?.blur?.(); } catch (_) { }
    document.documentElement.style.removeProperty('overflow');
    document.body.style.removeProperty('overflow');
    const shell = document.getElementById(shellId);
    if (shell) shell.style.removeProperty('display');
    hideInstagramSurface();
    renderThreadList();
    post({ type: 'account-panel-closed' });
  }

  // OnlyDM only clicks Instagram's own switcher. Any credential entry happens in
  // Instagram's real form, which OnlyDM never reads or fills.
  async function openAccountPanel() {
    const trigger = Array.from(document.querySelectorAll('div[role="button"]'))
      .find((element) => element.querySelector('svg[aria-label="아래쪽 V자형 아이콘"]'));
    if (!trigger) {
      reportProjectionError('account', 'Account switcher not found');
      return;
    }

    showInstagramSurface();
    trigger.click();

    // Wait for the panel to appear, then for the user to dismiss or use it.
    for (let waited = 0; waited < 4000 && !document.querySelector('div[role="dialog"]'); waited += 100) {
      await sleep(100);
    }
    while (document.querySelector('div[role="dialog"]')) await sleep(300);
    restoreProjection();
  }

  function applyPalette(next) {
    if (!next) return;
    Object.assign(palette, next);
    document.getElementById(marker)?.remove();
    ensureStyle();
    renderThreadList();
  }

  window.chrome?.webview?.addEventListener('message', (event) => {
    if (event.data?.type === 'nicknames') {
      nicknames = event.data.map || {};
      renderThreadList();
    }
    if (event.data?.type === 'filter-threads') filterThreads(event.data.query || '', event.data.aliases);
    if (event.data?.type === 'open-row') {
      openThreadByKey(event.data.key || '', event.data.title || '');
    }
    if (event.data?.type === 'open-friend') openFriend(event.data.name, event.data.handle);
    if (event.data?.type === 'new-room') startRoom(event.data.handles);
    if (event.data?.type === 'set-theme') applyPalette(event.data.palette);
    if (event.data?.type === 'open-selected') openSelectedThread();
    if (event.data?.type === 'open-account-panel') openAccountPanel();
    if (event.data?.type === 'move-selection') moveSelection(event.data.delta > 0 ? 1 : -1);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startInboxProjection, { once: true });
  } else {
    startInboxProjection();
  }
})();
""";
    }

    public static string BuildChatScript(AppThemePalette palette)
    {
        var paletteJson = JsonSerializer.Serialize(ChatPalette(palette));

        return $$"""
(() => {
  const palette = {{paletteJson}};
  const marker = 'onlydm-chat-style';
  let observer = null;
  let timer = 0;
  let readyPosted = false;
  let infoOpen = false;
  // Leaving and deleting are the only actions OnlyDM does not provide itself. Renaming
  // is deliberately not among them: Instagram's rename changes the name for everyone in
  // the conversation, while OnlyDM's stays on this machine.
  const detailsKeep = /나가기|삭제/;

  // Names the user chose. The page draws them in its own header and in the member list,
  // so both are rewritten in place rather than left showing Instagram's version.
  let localNames = { title: '', shown: '', people: {} };
  const originalText = new WeakMap();
  let lastRename = 0;
  let detailsAnchor = null;
  let detailsPanel = null;
  let lastConversation = null;

  function post(message) {
    try { window.chrome?.webview?.postMessage(message); } catch (_) { }
  }

  function reportProjectionError(stage, error) {
    const message = String(error?.message || error || 'Unknown projection error');
    post({ type: 'projection-error', stage, message });
  }

  function ensureStyle() {
    if (document.getElementById(marker)) return;
    const style = document.createElement('style');
    style.id = marker;
    style.textContent = `
      html, body { margin: 0 !important; padding: 0 !important; background: ${palette.background} !important; overflow: hidden !important; }
      * { scrollbar-width: none !important; }
      *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
      textarea, [contenteditable="true"] { caret-color: ${palette.text} !important; }
      input, textarea { border-color: ${palette.border} !important; }
      /* Anything Instagram mounts beside the conversation is hidden the moment it is
         inserted. Waiting for the observer to hide it let the panel flash in first. */
      .onlydm-solo > :not(.onlydm-branch) { display: none !important; }
    `;
    document.head?.appendChild(style) || document.documentElement.appendChild(style);
  }

  function inputElement() {
    return document.querySelector('textarea')
      || document.querySelector('[contenteditable="true"][role="textbox"]')
      || document.querySelector('[contenteditable="true"]');
  }

  function messageList() {
    return document.querySelector('[data-pagelet="IGDMessagesList"]');
  }

  // The conversation column is the lowest ancestor shared by the message list and
  // the composer. Climbing from the composer alone picks a node that excludes the
  // messages, which then get hidden along with the rest of Instagram.
  function callControl() {
    const icon = document.querySelector('svg[aria-label="음성 통화"], svg[aria-label="영상 통화"]');
    return icon ? icon.closest('[role="button"], button') || icon : null;
  }

  // The column must also contain the conversation header, otherwise isolating the
  // messages hides the call buttons that live there.
  function conversationContainer() {
    const list = messageList();
    const input = inputElement();
    if (!list || !input) return null;

    const chainOf = (node) => {
      const chain = new Set();
      for (let current = node; current; current = current.parentElement) chain.add(current);
      return chain;
    };

    let shared = chainOf(list);
    for (const node of [input, callControl()]) {
      if (!node) continue;
      const chain = chainOf(node);
      shared = new Set([...shared].filter((element) => chain.has(element)));
    }

    for (let node = list; node; node = node.parentElement) {
      if (shared.has(node)) return node;
    }
    return null;
  }

  function styleBubbles(conversation) {
    const rect = conversation.getBoundingClientRect();
    const mid = rect.left + rect.width / 2;
    for (const bubble of conversation.querySelectorAll('div[role="presentation"]')) {
      const background = getComputedStyle(bubble).backgroundColor;
      if (!background || background === 'transparent' || background === 'rgba(0, 0, 0, 0)') continue;
      const b = bubble.getBoundingClientRect();
      if (b.width < 20 || b.width > rect.width * .85) continue;
      const outgoing = b.left + b.width / 2 > mid;
      bubble.style.setProperty('background', outgoing ? palette.outgoing : palette.incoming, 'important');
      bubble.style.setProperty('color', outgoing ? palette.outgoingText : palette.text, 'important');
      for (const text of bubble.querySelectorAll('span, div')) {
        text.style.setProperty('color', outgoing ? palette.outgoingText : palette.text, 'important');
      }
    }
  }

  function holdsOverlay(element) {
    if (!element || element.nodeType !== 1) return false;
    if (element.getAttribute?.('role') === 'dialog') return true;
    return !!element.querySelector?.('[role="dialog"]');
  }

  // textContent, not innerText: the panel is still hidden by our own isolation the
  // first time we look for it, and innerText reads empty for hidden elements.
  function plainText(node) {
    try { return String(node.textContent || '').normalize('NFC').replace(/\s+/g, ' ').trim(); }
    catch (_) { return ''; }
  }

  function detailsPanelAnchor() {
    if (detailsAnchor && document.contains(detailsAnchor)) return detailsAnchor;
    detailsAnchor = Array.from(document.querySelectorAll('[role="button"], button'))
      .find((node) => /^채팅\s*(삭제|나가기)$/.test(plainText(node))) || null;
    return detailsAnchor;
  }

  const panelStyle = {
    position: 'fixed', top: '0', right: '0', bottom: '0', left: 'auto',
    width: 'min(320px, 100%)', 'max-width': '100%', 'z-index': '2147483000',
    background: palette.background, 'border-left': `1px solid ${palette.border}`,
    'box-shadow': '-10px 0 28px rgba(0, 0, 0, .28)', overflow: 'auto', display: 'block',
  };

  // The panel's own root: the highest ancestor of its controls that still leaves the
  // conversation outside. Floating anything above that would take the conversation
  // with it, which is what squeezed the messages into a corner.
  function detailsRoot(anchor, conversation) {
    let node = anchor;
    while (node.parentElement && node.parentElement !== document.body
           && !node.parentElement.contains(conversation)) node = node.parentElement;
    return node.contains(conversation) ? null : node;
  }

  // Left in the flex row the panel squeezes the conversation sideways; lifting it out
  // of flow slides it over the right edge instead.
  function floatPanel(element) {
    if (detailsPanel && detailsPanel !== element) dropPanel();
    detailsPanel = element;
    for (const [name, value] of Object.entries(panelStyle)) {
      element.style.setProperty(name, value, 'important');
    }
  }

  function dropPanel() {
    if (!detailsPanel) return;
    for (const name of Object.keys(panelStyle)) detailsPanel.style.removeProperty(name);
    detailsPanel = null;
  }

  // Blocking, reporting, adding people and Instagram's own nickname belong to
  // Instagram, not to a DM client. Every action is judged on its own label: a group
  // splits them across separate lists, so folding away one list left the rest showing.
  function trimDetails(panelRoot) {
    const actions = Array.from(panelRoot.querySelectorAll('[role="button"], button'))
      .filter((button) => {
        const label = plainText(button);
        return label && label.length <= 24 && !button.querySelector('[role="button"], button');
      });
    // If nothing matches, Instagram has renamed these controls: leave them alone
    // rather than handing back an empty panel.
    if (!actions.some((button) => detailsKeep.test(plainText(button)))) return;

    for (const button of actions) {
      if (detailsKeep.test(plainText(button))) continue;
      // Hide the row the label sits in, not the bare label, or an empty row is left
      // behind. Anything holding more text than the label itself is someone else's row.
      let row = button;
      while (row.parentElement && row.parentElement !== panelRoot
             && plainText(row.parentElement) === plainText(button)) row = row.parentElement;
      row.style.setProperty('display', 'none', 'important');
    }
  }

  // A one-to-one conversation carries the other person's profile link in its header;
  // a group has none there, and links inside messages sit far below it. The handle is
  // what a local nickname hangs off, so both places rename the same person.
  let personPosted = false;

  function headerPerson(conversation) {
    const top = conversation.getBoundingClientRect().top;
    for (const link of conversation.querySelectorAll('a[href]')) {
      let path = '';
      try { path = new URL(link.href, location.href).pathname; } catch (_) { continue; }
      if (!/^\/[^\/]+\/$/.test(path)) continue;
      const rect = link.getBoundingClientRect();
      if (rect.height < 20 || rect.top - top > 64 || rect.top - top < -8) continue;
      return path.split('/').filter(Boolean)[0];
    }
    return '';
  }

  function linkHandle(link) {
    let path = '';
    try { path = new URL(link.href, location.href).pathname; } catch (_) { return ''; }
    return /^\/[^\/]+\/$/.test(path) ? path.split('/').filter(Boolean)[0] : '';
  }

  // Always written from the text Instagram put there, so clearing a name restores it.
  function setNodeText(node, replacement) {
    if (!originalText.has(node)) originalText.set(node, node.nodeValue);
    const next = replacement || originalText.get(node);
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  function applyLocalNames(force) {
    const now = Date.now();
    if (!force && now - lastRename < 1000) return;
    lastRename = now;

    const conversation = document.querySelector('[data-onlydm-chat]');
    if (!conversation) return;
    const title = localNames.title || '';
    const shown = localNames.shown || '';

    // The conversation's own name sits in its header. Only the header band is touched:
    // a message whose text happens to be that name must stay as it was sent.
    if (title) {
      const top = conversation.getBoundingClientRect().top;
      const walker = document.createTreeWalker(conversation, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const original = originalText.has(node) ? originalText.get(node) : node.nodeValue;
        if (!original || original.trim() !== title) continue;
        const rect = node.parentElement?.getBoundingClientRect();
        if (!rect || rect.top - top > 60) continue;
        setNodeText(node, shown && shown !== title ? shown : '');
      }
    }

    // Member rows carry the account in their link, and their first line is the name.
    const panel = detailsPanel;
    if (!panel) return;
    for (const node of panel.querySelectorAll('a[href]')) {
      const handle = linkHandle(node);
      if (!handle) continue;
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!(text.nodeValue || '').trim()) continue;
        setNodeText(text, localNames.people[handle] || '');
        break;
      }
    }

    // The panel repeats the conversation's name at the top.
    if (!title) return;
    for (const element of panel.querySelectorAll('span, h1, h2, div')) {
      if (element.children.length || !element.firstChild) continue;
      const original = originalText.has(element.firstChild)
        ? originalText.get(element.firstChild)
        : element.firstChild.nodeValue;
      if ((original || '').trim() !== title) continue;
      setNodeText(element.firstChild, shown && shown !== title ? shown : '');
    }
  }

  function isolateConversation() {
    ensureStyle();
    const details = infoOpen ? detailsPanelAnchor() : null;
    if (!details) dropPanel();

    const conversation = conversationContainer();
    if (!conversation) return false;
    // Moving to another conversation leaves the old marks pointing at the wrong rows.
    if (lastConversation && lastConversation !== conversation) {
      for (const marked of document.querySelectorAll('.onlydm-solo, .onlydm-branch')) {
        marked.classList.remove('onlydm-solo', 'onlydm-branch');
      }
    }
    lastConversation = conversation;
    conversation.dataset.onlydmChat = '1';
    const panelRoot = details ? detailsRoot(details, conversation) : null;
    let current = conversation;
    while (current?.parentElement && current !== document.body) {
      current.parentElement.classList.add('onlydm-solo');
      for (const sibling of current.parentElement.children) {
        // The details panel opens as a sibling of the conversation column, and a call
        // opens as an overlay next to it; hiding either is what made them never appear.
        sibling.classList.toggle(
          'onlydm-branch',
          sibling === current || holdsOverlay(sibling) || (panelRoot && sibling.contains(panelRoot)));
      }
      current.style.setProperty('width', '100%', 'important');
      current.style.setProperty('min-width', '0', 'important');
      current.style.setProperty('max-width', 'none', 'important');
      current.style.setProperty('flex', '1 1 auto', 'important');
      current.style.setProperty('margin', '0', 'important');
      current = current.parentElement;
    }
    if (panelRoot) floatPanel(panelRoot); else dropPanel();
    if (panelRoot) trimDetails(panelRoot);
    // While the panel is open its rows are rebuilt often, and a throttled pass that
    // arrived before it mounted used to be the only one it ever got.
    applyLocalNames(!!panelRoot);
    document.body.style.setProperty('margin', '0', 'important');
    document.body.style.setProperty('overflow', 'hidden', 'important');
    styleBubbles(conversation);

    const titleCandidates = Array.from(conversation.querySelectorAll('header h1, header h2, header span, h1, h2'))
      .map((node) => { try { return String(node.innerText || '').normalize('NFC').trim(); } catch (_) { return ''; } })
      .filter((value) => value && value.length < 80);
    if (titleCandidates.length) post({ type: 'thread-title', title: titleCandidates[0] });
    if (!personPosted) {
      const handle = headerPerson(conversation);
      if (handle) {
        personPosted = true;
        post({ type: 'thread-person', handle });
      }
    }
    if (!readyPosted) {
      readyPosted = true;
      post({ type: 'chat-ready' });
    }
    return true;
  }

  function attachObserver() {
    if (observer || !document.documentElement) return;
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try { isolateConversation(); } catch (error) { reportProjectionError('render', error); }
      }, 80);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true });
  }

  function startChatProjection() {
    try {
      attachObserver();
      isolateConversation();
      let retryCount = 0;
      const retry = setInterval(() => {
        try {
          const found = isolateConversation();
          retryCount += 1;
          if (found || retryCount >= 30) clearInterval(retry);
        } catch (error) {
          clearInterval(retry);
          reportProjectionError('retry', error);
        }
      }, 500);
    } catch (error) {
      reportProjectionError('start', error);
    }
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (infoOpen) {
      infoOpen = false;
      detailsAnchor = null;
      isolateConversation();
      return;
    }
    post({ type: 'close-window' });
  }, true);

  // Toggling the details panel shows it beside the conversation, trimmed to the
  // rename and leave/delete rows.
  function infoButton() {
    const icon = document.querySelector('svg[aria-label="대화 정보"]');
    return icon && icon.closest('[role="button"], button');
  }

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target?.closest?.('[role="button"], button')?.querySelector('svg[aria-label="대화 정보"]')) {
      infoOpen = !infoOpen;
      detailsAnchor = null;
      lastRename = 0;
      // The panel mounts a beat after the click, so this looks a few times.
      for (const delay of [0, 40, 120, 300, 700]) {
        setTimeout(() => {
          try { isolateConversation(); } catch (error) { reportProjectionError('info', error); }
        }, delay);
      }
      return;
    }
    if (!infoOpen) return;

    if (detailsPanel?.contains(target)) {
      // Member rows are profile links. Following one would leave the conversation, so
      // the click stops here.
      const link = target.closest?.('a[href]');
      if (link && !/^\/direct\//.test(new URL(link.href, location.href).pathname)) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    // Clicking the conversation closes the panel, the way a side sheet behaves.
    infoButton()?.click();
  }, true);

  // Stretching the conversation to fill a narrow window can leave the header controls
  // at zero size, where a bare .click() may be ignored. The control is scrolled into
  // view and driven with a full pointer sequence.
  function startCall(mode) {
    const label = mode === 'video' ? '영상 통화' : '음성 통화';
    const icon = document.querySelector(`svg[aria-label="${label}"]`);
    const button = icon && icon.closest('[role="button"], button');
    if (!button) {
      reportProjectionError('call', `Call control not found: ${label}`);
      return;
    }

    try { button.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) { }

    const rect = button.getBoundingClientRect();
    const x = rect.width ? rect.left + rect.width / 2 : 0;
    const y = rect.height ? rect.top + rect.height / 2 : 0;
    const options = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

    // One activation only. Dispatching the sequence and then calling click() again
    // counted as two presses, which opened two call windows.
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Event = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      try { button.dispatchEvent(new Event(type, options)); } catch (_) { }
    }

    post({ type: 'call-started', mode, width: Math.round(rect.width), height: Math.round(rect.height) });
  }

  window.chrome?.webview?.addEventListener('message', (event) => {
    if (event.data?.type === 'names') {
      localNames = {
        title: event.data.title || '',
        shown: event.data.shown || '',
        people: event.data.people || {},
      };
      try { applyLocalNames(true); } catch (error) { reportProjectionError('names', error); }
      return;
    }
    if (event.data?.type === 'start-call') { startCall(event.data.mode); return; }
    if (event.data?.type !== 'set-theme' || !event.data.palette) return;
    Object.assign(palette, event.data.palette);
    document.getElementById(marker)?.remove();
    ensureStyle();
    try { isolateConversation(); } catch (error) { reportProjectionError('theme', error); }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startChatProjection, { once: true });
  } else {
    startChatProjection();
  }
})();
""";
    }
}

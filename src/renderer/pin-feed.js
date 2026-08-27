/* Priority feed — a single full-width row under the toolbar that surfaces
   favorite (gold ☆) and important (blue ⚑) contacts which currently have new
   messages, sorted by urgency: important-unread first, then favorite-unread,
   each group by descending unread count. Contacts without new messages (quiet)
   are tucked into a right-clamped "+N тихих" popover so the row stays compact.

   The unread scan, optimistic badge reset on open, and jump-to-chat all live in
   favorites.js / important.js; this module owns only the markup. It reads data
   through their listUnread()/listQuiet() getters and routes clicks back through
   their jump(). The row lives in its own grid track, so it can never push the
   toolbar or the WhatsApp chat field off-screen — and there is no dropdown
   anchored to a toolbar pill, which removes the old off-screen-panel class of
   bugs entirely. */
import { collectUnreadChatsScript } from './webview-scripts/collect-unread-chats.js';
import { state } from './core/state.js';

  const ICON = {
    fav: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8 6.8 19.5l1-5.8-4.2-4.1 5.8-.8z"/></svg>',
    imp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 21V4M6 4h11l-2 3.5L17 11H6"/></svg>',
  };

  let _popBound = false;
  let _popOpen = false;

  const feedEl = () => document.getElementById('pin-feed');
  const trackEl = () => document.getElementById('pin-feed-track');
  const moreEl = () => document.getElementById('pin-feed-more');
  const popEl = () => document.getElementById('pin-feed-pop');

  function fav() { return window.WaDeckFavoritesModule || null; }
  function imp() { return window.WaDeckImportantModule || null; }

  /* Shared unread-chats scan with a short TTL cache. favorites.js and
     important.js poll the SAME webviews with the SAME collectUnreadChatsScript()
     every ~6s (their timers are near-synchronised). Routing both through this
     cache injects each webview at most once per window instead of twice —
     halving the per-account executeJavaScript load. TTL is below the 6s scan
     period so every cycle still gets fresh data. */
  const _scanCache = new Map(); // accountId -> { t, rows }
  const SCAN_TTL_MS = 4500;
  /* Title-гейт: счётчик из заголовка вкладки (page-title-updated) бесплатный
     и событийный. При 0 непрочитанных инъекция скана — впустую сожжённый
     layout в 20 webview (~7 executeJavaScript/сек суммарно). Muted-чаты в
     title-счётчик не попадают — раз в ~30 с сканируем по-настоящему. */
  const ZERO_RECON_MS = 30000;
  const _lastFullScanAt = new Map();

  async function scanAccountUnread(accountId, webview, exec) {
    const key = String(accountId || '');
    const cached = _scanCache.get(key);
    // Кэшируем ПРОМИС: три модуля (pin-feed/unread-feed/Cmd+U) сканируют
    // одновременно, и кэш результата их не дедуплицировал — инъекции шли втрое
    if (cached && (Date.now() - cached.t) < SCAN_TTL_MS) return cached.p;
    const titleCount = Number(state?.unreadByAccount?.get?.(key));
    if (titleCount === 0 && (Date.now() - (_lastFullScanAt.get(key) || 0)) < ZERO_RECON_MS) {
      return [];
    }
    const p = (async () => {
      let rows = null;
      try { rows = await exec(webview, collectUnreadChatsScript(), true); } catch { rows = null; }
      if (Array.isArray(rows)) _lastFullScanAt.set(key, Date.now());
      else _scanCache.delete(key); // неудачу не кэшируем
      return rows;
    })();
    _scanCache.set(key, { t: Date.now(), p });
    return p;
  }

  function catRank(c) { return c === 'imp' ? 0 : 1; }

  /* important-unread first, then favorite-unread; within a group by count desc */
  function collectUnread() {
    const list = [
      ...(imp()?.listUnread?.() || []),
      ...(fav()?.listUnread?.() || []),
    ];
    list.sort((a, b) => {
      if (catRank(a.category) !== catRank(b.category)) return catRank(a.category) - catRank(b.category);
      return (Number(b.count) || 0) - (Number(a.count) || 0);
    });
    return list;
  }

  function collectQuiet() {
    return [
      ...(imp()?.listQuiet?.() || []),
      ...(fav()?.listQuiet?.() || []),
    ];
  }

  function jump(item) {
    if (!item) return;
    const mod = item.category === 'imp' ? imp() : fav();
    mod?.jump?.(item);
  }

  function fmtCount(n) { return (Number(n) || 0) > 99 ? '99+' : String(Number(n) || 0); }

  function closePop() {
    _popOpen = false;
    popEl()?.classList.add('hidden');
    moreEl()?.setAttribute('aria-expanded', 'false');
  }
  function openPop() {
    if (popEl()?.classList.contains('hidden') === false) return;
    _popOpen = true;
    popEl()?.classList.remove('hidden');
    moreEl()?.setAttribute('aria-expanded', 'true');
  }

  function bindPop() {
    if (_popBound) return;
    const more = moreEl();
    if (!more) return;
    _popBound = true;
    more.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_popOpen) closePop(); else openPop();
    });
    document.addEventListener('click', (e) => {
      const f = feedEl();
      if (_popOpen && f && !f.contains(e.target)) closePop();
    });
  }

  function buildChip(item) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `pin-chip pin-chip-${item.category}`;
    chip.title = `${item.name} · ${item.accountName || 'аккаунт удалён'}`;

    const ic = document.createElement('span');
    ic.className = 'pin-chip-ic';
    ic.innerHTML = ICON[item.category] || '';

    const txt = document.createElement('span');
    txt.className = 'pin-chip-txt';
    const who = document.createElement('span');
    who.className = 'pin-chip-who';
    who.textContent = item.name;
    const sub = document.createElement('span');
    sub.className = 'pin-chip-sub';
    sub.textContent = item.accountName || '—';
    txt.append(who, sub);

    const cnt = document.createElement('span');
    cnt.className = 'pin-chip-cnt';
    cnt.textContent = fmtCount(item.count);

    chip.append(ic, txt, cnt);
    chip.addEventListener('click', () => { closePop(); jump(item); });
    return chip;
  }

  function buildPopRow(item) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `pin-pop-row pin-pop-row-${item.category}`;
    row.title = `${item.name} · ${item.accountName || 'аккаунт удалён'}`;

    const ic = document.createElement('span');
    ic.className = 'pin-pop-ic';
    ic.innerHTML = ICON[item.category] || '';

    const txt = document.createElement('span');
    txt.className = 'pin-pop-txt';
    const who = document.createElement('span');
    who.className = 'pin-pop-who';
    who.textContent = item.name;
    const sub = document.createElement('span');
    sub.className = 'pin-pop-sub';
    sub.textContent = item.accountName || '—';
    txt.append(who, sub);

    row.append(ic, txt);
    row.addEventListener('click', () => { closePop(); jump(item); });
    return row;
  }

  function render() {
    try {
      renderInner();
    } catch (e) {
      // Never let a feed render error break renderer init / the whole UI.
      console.warn('[pin-feed] render failed', e);
    }
  }

  function renderInner() {
    const feed = feedEl();
    const track = trackEl();
    const more = moreEl();
    const pop = popEl();
    if (!feed || !track) return;
    bindPop();

    const unread = collectUnread();

    // System notifications ride the same pipeline (count-increase detection
    // lives in notifications.js; an empty list clears its baselines).
    window.WaDeckNotifications?.observe?.(unread);

    // The row exists only while something is actually new — otherwise it
    // collapses (its grid track shrinks to 0), keeping the UI uncluttered.
    if (!unread.length) {
      // не .hidden: глобальный display:none!important убивал transition высоты
      feed.classList.remove('hidden');
      feed.classList.add('is-collapsed');
      closePop();
      track.innerHTML = '';
      if (pop) pop.innerHTML = '';
      if (more) more.classList.add('hidden');
      return;
    }

    feed.classList.remove('hidden', 'is-collapsed');

    track.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const item of unread) frag.appendChild(buildChip(item));
    track.appendChild(frag);

    // Quiet (no new messages) favorites/important → "+N тихих" popover.
    const quiet = collectQuiet();
    if (more && pop) {
      if (quiet.length) {
        more.classList.remove('hidden');
        more.textContent = `+${quiet.length} тихих`;
        pop.innerHTML = '';
        const cap = document.createElement('div');
        cap.className = 'pin-feed-pop-cap';
        cap.textContent = 'Без новых сообщений';
        pop.appendChild(cap);
        const pfrag = document.createDocumentFragment();
        for (const item of quiet) pfrag.appendChild(buildPopRow(item));
        pop.appendChild(pfrag);
      } else {
        more.classList.add('hidden');
        pop.innerHTML = '';
        closePop();
      }
    }
  }

  export const WaDeckPinFeed = { render, scanAccountUnread };
  window.WaDeckPinFeed = WaDeckPinFeed;

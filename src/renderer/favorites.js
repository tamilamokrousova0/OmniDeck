/* Favorite contacts — surfaced as a "new message from a favorite" alert.
   A favorite chip appears ONLY while that contact has unread messages, both in
   the toolbar strip and in the hub block; it carries an unread count and a gold
   highlight, and disappears once the chat is read.

   Reliability note: unread detection reuses the SAME scanner that powers the
   inbox (collect-unread-chats.js). It is reliable because chats with new
   messages bubble to the TOP of WhatsApp's chat list, so a no-scroll scan of
   #pane-side always catches them — this is why the previous name-matching
   approach (its own bespoke scan) was flaky and this one is not. */
import { collectUnreadChatsScript } from './webview-scripts/collect-unread-chats.js';
import { showToast } from './core/helpers.js';

  let state, els, setStatus, setActiveAccount, isWebviewReady, safeExecuteInWebview;

  const SCAN_MS = 6000;           // per-favorite unread rescan period
  let _scanTimer = null;
  let _scanBusy = false;
  let _favUnread = new Map();     // favKey -> unread count (only entries with unread)

  function init(ctx) {
    state = ctx.state;
    els = ctx.els;
    setStatus = ctx.setStatus;
    setActiveAccount = ctx.setActiveAccount;
    isWebviewReady = ctx.isWebviewReady;
    safeExecuteInWebview = ctx.safeExecuteInWebview;
    if (!Array.isArray(state.favorites)) state.favorites = [];
    bindCrmFavToggle();
    render();
  }

  function favKey(accountId, name) {
    return String(accountId || '') + '::' + String(name || '').toLowerCase();
  }
  function normName(s) { return String(s || '').trim().toLowerCase(); }
  function accountById(id) {
    return (state?.accounts || []).find((a) => a.id === id) || null;
  }

  function isFavorite(accountId, name) {
    const key = favKey(accountId, name);
    return (state.favorites || []).some((f) => favKey(f.accountId, f.name) === key);
  }

  /* Favorites that currently have unread messages, in store order. */
  function unreadFavorites() {
    return (state?.favorites || [])
      .map((f) => ({ ...f, count: _favUnread.get(favKey(f.accountId, f.name)) || 0 }))
      .filter((f) => f.count > 0);
  }

  async function toggleFavorite(accountId, name) {
    const res = await window.waDeck.favoritesToggle({ accountId, name }).catch(() => null);
    if (!res?.ok) {
      setStatus && setStatus(res?.error === 'limit'
        ? 'Избранное: достигнут лимит (200)'
        : 'Избранное: не удалось сохранить');
      return null;
    }
    state.favorites = Array.isArray(res.favorites) ? res.favorites : state.favorites;
    // Exclusivity: main may have dropped this contact from important — reflect it.
    if (Array.isArray(res.important)) state.important = res.important;
    // Drop cached unread for contacts no longer favorited
    for (const k of [..._favUnread.keys()]) {
      if (!(state.favorites || []).some((f) => favKey(f.accountId, f.name) === k)) _favUnread.delete(k);
    }
    syncCrmToggle();
    window.WaDeckImportantModule?.syncCrmToggle?.();
    window.WaDeckImportantModule?.renderImpStrip?.();
    render();
    scanFavoriteUnread().catch(() => {}); // refresh the alert promptly
    return res.on;
  }

  /* ── unread scan ── */
  async function scanFavoriteUnread() {
    if (_scanBusy) return;
    _scanBusy = true;
    try {
      const byAccount = new Map(); // accountId -> [favorite,...]
      for (const f of state.favorites || []) {
        if (!byAccount.has(f.accountId)) byAccount.set(f.accountId, []);
        byAccount.get(f.accountId).push(f);
      }
      const next = new Map();
      const carry = (favs) => {
        // keep the previous value so the highlight doesn't flicker when an
        // account is briefly unavailable (reload / not ready / scan error)
        for (const f of favs) {
          const k = favKey(f.accountId, f.name);
          if (_favUnread.has(k)) next.set(k, _favUnread.get(k));
        }
      };
      for (const [accountId, favs] of byAccount) {
        const acc = accountById(accountId);
        if (!acc || acc.type !== 'whatsapp' || acc.frozen) { carry(favs); continue; }
        const webview = state.webviews.get(accountId);
        if (!isWebviewReady(webview)) { carry(favs); continue; }
        let rows = null;
        try {
          rows = window.WaDeckPinFeed?.scanAccountUnread
            ? await window.WaDeckPinFeed.scanAccountUnread(accountId, webview, safeExecuteInWebview)
            : await safeExecuteInWebview(webview, collectUnreadChatsScript(), true);
        } catch { rows = null; }
        if (!Array.isArray(rows)) { carry(favs); continue; }
        const unreadByName = new Map();
        for (const r of rows) {
          const nm = normName(r?.name);
          if (nm) unreadByName.set(nm, Math.max(1, Number(r?.count) || 1));
        }
        for (const f of favs) {
          const c = unreadByName.get(normName(f.name));
          if (c) next.set(favKey(f.accountId, f.name), c);
          // absent => read => omitted => the chip disappears
        }
      }
      _favUnread = next;
      render();
    } finally {
      _scanBusy = false;
    }
  }

  let _scanTick = 0;
  function startFavoritePolling() {
    if (_scanTimer) clearInterval(_scanTimer);
    _scanTimer = setInterval(() => {
      _scanTick += 1;
      // Background (window unfocused): scan ~3× less often to cut idle CPU.
      if (!document.hasFocus() && (_scanTick % 3 !== 0)) return;
      scanFavoriteUnread().catch(() => {});
    }, SCAN_MS);
    setTimeout(() => { scanFavoriteUnread().catch(() => {}); }, 1500);
  }

  /* ── jump to a favorite's chat ──
     Prefer a DIRECT click on the chat row in the rendered list (#pane-side):
     a favorite only shows here while it has unread messages, and unread chats
     sit at the TOP of WhatsApp's list, so the row is reliably visible. This
     skips the search → type → pick flow. Fall back to the search-based open
     only if the row isn't in the visible list (e.g. it was just read). */
  async function jumpToFavorite(f) {
    const acc = accountById(f.accountId);
    if (!acc) { setStatus && setStatus('Избранное: аккаунт удалён'); return; }
    // Optimistic reset: opening the chat marks it read, so clear the badge now
    // for instant feedback. The follow-up rescans reconcile (re-add if somehow
    // still unread).
    _favUnread.delete(favKey(f.accountId, f.name));
    render();
    if (setActiveAccount) setActiveAccount(f.accountId);
    const webview = state.webviews.get(f.accountId);
    if (!webview) return;
    const sched = window.WaDeckScheduleModule || {};
    const byClick = sched.openChatByListClick;
    const bySearch = sched.openChatInWebview;
    try {
      let res = typeof byClick === 'function' ? await byClick(webview, f.name) : { ok: false };
      if (!res?.ok && typeof bySearch === 'function') {
        res = await bySearch(webview, f.name);   // fallback: search by name
      }
      // Оба пути не открыли чат — бейдж уже оптимистично сброшен, поэтому
      // честный тост обязателен (рескан ниже вернёт бейдж, если что-то есть).
      if (!res?.ok) showToast(`Чат «${f.name}» не открылся — откройте вручную`, 'error', 4000);
    } catch { /* stay on the account */ }
    rescanSoon(1500);
    rescanSoon(4000);
  }

  /* Debounced-ish on-demand rescan: run a fresh unread scan after `delay`ms.
     Called when a chat is opened (read state just changed) or the active
     account switches, so the badge clears quickly instead of waiting for the
     next poll. Overlap is safe — scanFavoriteUnread() guards with _scanBusy. */
  function rescanSoon(delay) {
    setTimeout(() => { scanFavoriteUnread().catch(() => {}); }, Math.max(0, Number(delay) || 0));
  }

  /* ── render ──
     The favorites/important data is now surfaced by the shared priority feed
     (pin-feed.js), which renders a single sorted row under the toolbar. This
     module owns the unread scan + jump; the feed owns the markup. */
  function render() {
    window.WaDeckPinFeed?.render?.();
  }

  /* Data getters consumed by the priority feed. */
  function listUnread() {
    return unreadFavorites().map((f) => ({
      accountId: f.accountId,
      name: f.name,
      count: f.count,
      accountName: accountById(f.accountId)?.name || '',
      category: 'fav',
    }));
  }
  function listQuiet() {
    return (state?.favorites || [])
      .filter((f) => !((_favUnread.get(favKey(f.accountId, f.name)) || 0) > 0))
      .map((f) => ({
        accountId: f.accountId,
        name: f.name,
        count: 0,
        accountName: accountById(f.accountId)?.name || '',
        category: 'fav',
      }));
  }


  /* ── CRM star ── */
  function syncCrmToggle() {
    const btn = els.crmFavToggle || document.getElementById('crm-fav-toggle');
    if (!btn) return;
    const t = state.crmTarget || {};
    const on = !!(t.accountId && t.contactName && isFavorite(t.accountId, t.contactName));
    btn.classList.toggle('is-fav', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Убрать из избранного' : 'Добавить в избранное';
  }

  function bindCrmFavToggle() {
    const btn = els.crmFavToggle || document.getElementById('crm-fav-toggle');
    if (!btn || btn._favBound) return;
    btn._favBound = true;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = state.crmTarget || {};
      if (!t.accountId || !t.contactName) {
        setStatus && setStatus('Избранное: контакт не выбран');
        return;
      }
      await toggleFavorite(t.accountId, t.contactName);
    });
  }

  /* Local cleanup after account removal (main already pruned the store). */
  function onAccountRemoved(accountId) {
    const id = String(accountId || '');
    state.favorites = (state.favorites || []).filter((f) => f.accountId !== id);
    for (const k of [..._favUnread.keys()]) {
      if (k.startsWith(id + '::')) _favUnread.delete(k);
    }
    render();
  }

  export const WaDeckFavoritesModule = {
    init,
    startFavoritePolling,
    renderFavStrip: render, // renderer calls this after renderAccounts — refresh the feed
    syncCrmToggle,
    isFavorite,
    onAccountRemoved,
    rescanSoon,
    listUnread,
    listQuiet,
    jump: jumpToFavorite,
  };
  window.WaDeckFavoritesModule = WaDeckFavoritesModule;

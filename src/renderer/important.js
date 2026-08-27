/* Important contacts — the blue counterpart of favorites. Mutually exclusive
   with favorites (enforced in main.js). An important chip appears ONLY while
   that contact has unread messages, both in the toolbar strip and in the hub
   block; it carries an unread count and a blue highlight, and disappears once
   the chat is read.

   Reliability note: unread detection reuses the SAME scanner that powers
   favorites/inbox (collect-unread-chats.js) — reliable because chats with new
   messages bubble to the TOP of WhatsApp's chat list. */
import { collectUnreadChatsScript } from './webview-scripts/collect-unread-chats.js';
import { showToast } from './core/helpers.js';

  let state, els, setStatus, setActiveAccount, isWebviewReady, safeExecuteInWebview;

  const SCAN_MS = 6000;           // per-important unread rescan period
  let _scanTimer = null;
  let _scanBusy = false;
  let _impUnread = new Map();     // impKey -> unread count (only entries with unread)

  function init(ctx) {
    state = ctx.state;
    els = ctx.els;
    setStatus = ctx.setStatus;
    setActiveAccount = ctx.setActiveAccount;
    isWebviewReady = ctx.isWebviewReady;
    safeExecuteInWebview = ctx.safeExecuteInWebview;
    if (!Array.isArray(state.important)) state.important = [];
    bindCrmImpToggle();
    render();
  }

  function impKey(accountId, name) {
    return String(accountId || '') + '::' + String(name || '').toLowerCase();
  }
  function normName(s) { return String(s || '').trim().toLowerCase(); }
  function accountById(id) {
    return (state?.accounts || []).find((a) => a.id === id) || null;
  }

  function isImportant(accountId, name) {
    const key = impKey(accountId, name);
    return (state.important || []).some((f) => impKey(f.accountId, f.name) === key);
  }

  /* Important contacts that currently have unread messages, in store order. */
  function unreadImportant() {
    return (state?.important || [])
      .map((f) => ({ ...f, count: _impUnread.get(impKey(f.accountId, f.name)) || 0 }))
      .filter((f) => f.count > 0);
  }

  async function toggleImportant(accountId, name) {
    const res = await window.waDeck.importantToggle({ accountId, name }).catch(() => null);
    if (!res?.ok) {
      setStatus && setStatus(res?.error === 'limit'
        ? 'Важные: достигнут лимит (200)'
        : 'Важные: не удалось сохранить');
      return null;
    }
    state.important = Array.isArray(res.important) ? res.important : state.important;
    // Exclusivity: main may have dropped this contact from favorites — reflect it.
    if (Array.isArray(res.favorites)) state.favorites = res.favorites;
    // Drop cached unread for contacts no longer important
    for (const k of [..._impUnread.keys()]) {
      if (!(state.important || []).some((f) => impKey(f.accountId, f.name) === k)) _impUnread.delete(k);
    }
    syncCrmToggle();
    window.WaDeckFavoritesModule?.syncCrmToggle?.();
    window.WaDeckFavoritesModule?.renderFavStrip?.();
    render();
    scanImportantUnread().catch(() => {}); // refresh the alert promptly
    return res.on;
  }

  /* ── unread scan ── */
  async function scanImportantUnread() {
    if (_scanBusy) return;
    _scanBusy = true;
    try {
      const byAccount = new Map(); // accountId -> [important,...]
      for (const f of state.important || []) {
        if (!byAccount.has(f.accountId)) byAccount.set(f.accountId, []);
        byAccount.get(f.accountId).push(f);
      }
      const next = new Map();
      const carry = (imps) => {
        // keep the previous value so the highlight doesn't flicker when an
        // account is briefly unavailable (reload / not ready / scan error)
        for (const f of imps) {
          const k = impKey(f.accountId, f.name);
          if (_impUnread.has(k)) next.set(k, _impUnread.get(k));
        }
      };
      for (const [accountId, imps] of byAccount) {
        const acc = accountById(accountId);
        if (!acc || acc.type !== 'whatsapp' || acc.frozen) { carry(imps); continue; }
        const webview = state.webviews.get(accountId);
        if (!isWebviewReady(webview)) { carry(imps); continue; }
        let rows = null;
        try {
          rows = window.WaDeckPinFeed?.scanAccountUnread
            ? await window.WaDeckPinFeed.scanAccountUnread(accountId, webview, safeExecuteInWebview)
            : await safeExecuteInWebview(webview, collectUnreadChatsScript(), true);
        } catch { rows = null; }
        if (!Array.isArray(rows)) { carry(imps); continue; }
        const unreadByName = new Map();
        for (const r of rows) {
          const nm = normName(r?.name);
          if (nm) unreadByName.set(nm, Math.max(1, Number(r?.count) || 1));
        }
        for (const f of imps) {
          const c = unreadByName.get(normName(f.name));
          if (c) next.set(impKey(f.accountId, f.name), c);
          // absent => read => omitted => the chip disappears
        }
      }
      _impUnread = next;
      render();
    } finally {
      _scanBusy = false;
    }
  }

  let _scanTick = 0;
  function startImportantPolling() {
    if (_scanTimer) clearInterval(_scanTimer);
    _scanTimer = setInterval(() => {
      _scanTick += 1;
      // Background (window unfocused): scan ~3× less often to cut idle CPU.
      if (!document.hasFocus() && (_scanTick % 3 !== 0)) return;
      scanImportantUnread().catch(() => {});
    }, SCAN_MS);
    setTimeout(() => { scanImportantUnread().catch(() => {}); }, 1500);
  }

  /* ── jump to an important contact's chat ── (same flow as favorites) */
  async function jumpToImportant(f) {
    const acc = accountById(f.accountId);
    if (!acc) { setStatus && setStatus('Важные: аккаунт удалён'); return; }
    // Optimistic reset: opening the chat marks it read — clear the badge now.
    _impUnread.delete(impKey(f.accountId, f.name));
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
      // Бейдж уже сброшен оптимистично — при неоткрытии чата честный тост
      // (иначе важный контакт молча выпадает; рескан вернёт бейдж, если надо).
      if (!res?.ok) showToast(`Чат «${f.name}» не открылся — откройте вручную`, 'error', 4000);
    } catch { /* stay on the account */ }
    rescanSoon(1500);
    rescanSoon(4000);
  }

  /* On-demand rescan after `delay`ms — chat opened or active account switched.
     Overlap-safe via the _scanBusy guard in scanImportantUnread(). */
  function rescanSoon(delay) {
    setTimeout(() => { scanImportantUnread().catch(() => {}); }, Math.max(0, Number(delay) || 0));
  }

  /* ── render ── (data is surfaced by the shared priority feed, pin-feed.js) */
  function render() {
    window.WaDeckPinFeed?.render?.();
  }

  /* Data getters consumed by the priority feed. */
  function listUnread() {
    return unreadImportant().map((f) => ({
      accountId: f.accountId,
      name: f.name,
      count: f.count,
      accountName: accountById(f.accountId)?.name || '',
      category: 'imp',
    }));
  }
  function listQuiet() {
    return (state?.important || [])
      .filter((f) => !((_impUnread.get(impKey(f.accountId, f.name)) || 0) > 0))
      .map((f) => ({
        accountId: f.accountId,
        name: f.name,
        count: 0,
        accountName: accountById(f.accountId)?.name || '',
        category: 'imp',
      }));
  }


  /* ── CRM diamond ── */
  function syncCrmToggle() {
    const btn = els.crmImpToggle || document.getElementById('crm-imp-toggle');
    if (!btn) return;
    const t = state.crmTarget || {};
    const on = !!(t.accountId && t.contactName && isImportant(t.accountId, t.contactName));
    btn.classList.toggle('is-imp', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Убрать из Важных' : 'Добавить в Важные';
  }

  function bindCrmImpToggle() {
    const btn = els.crmImpToggle || document.getElementById('crm-imp-toggle');
    if (!btn || btn._impBound) return;
    btn._impBound = true;
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const t = state.crmTarget || {};
      if (!t.accountId || !t.contactName) {
        setStatus && setStatus('Важные: контакт не выбран');
        return;
      }
      await toggleImportant(t.accountId, t.contactName);
    });
  }

  /* Local cleanup after account removal (main already pruned the store). */
  function onAccountRemoved(accountId) {
    const id = String(accountId || '');
    state.important = (state.important || []).filter((f) => f.accountId !== id);
    for (const k of [..._impUnread.keys()]) {
      if (k.startsWith(id + '::')) _impUnread.delete(k);
    }
    render();
  }

  export const WaDeckImportantModule = {
    init,
    startImportantPolling,
    renderImpStrip: render, // renderer calls this after renderAccounts — refresh the feed
    syncCrmToggle,
    isImportant,
    onAccountRemoved,
    rescanSoon,
    listUnread,
    listQuiet,
    jump: jumpToImportant,
  };
  window.WaDeckImportantModule = WaDeckImportantModule;

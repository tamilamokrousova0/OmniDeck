import { collectUnreadCountScript } from './webview-scripts/unread-count.js';
import { collectTgUnreadCountScript } from './webview-scripts/tg-unread.js';

  let state, els, renderAccounts, isWebviewReady, safeExecuteInWebview, updateHubDashboard;
  let _hubDashboardDebounceTimer = null;

  function init(ctx) {
    state = ctx.state;
    els = ctx.els;
    renderAccounts = ctx.renderAccounts;
    isWebviewReady = ctx.isWebviewReady;
    safeExecuteInWebview = ctx.safeExecuteInWebview;
    updateHubDashboard = ctx.updateHubDashboard;
  }

  /* Windows taskbar overlay icon: main can't rasterize text, so the badge
     circle is drawn here on a canvas and shipped as a PNG data URL. Cached by
     label — the count rarely changes between polls. Harmless on macOS (main
     ignores it there and uses the native dock badge). */
  let _badgeCache = { label: '', url: '' };

  function renderBadgeDataUrl(count) {
    const label = count > 99 ? '99+' : String(count);
    if (_badgeCache.label === label) return _badgeCache.url;
    try {
      const size = 32;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (!ctx) return '';
      ctx.beginPath();
      ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      ctx.fillStyle = '#e53935';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `bold ${label.length > 2 ? 13 : 17}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, size / 2, size / 2 + 1);
      _badgeCache = { label, url: canvas.toDataURL('image/png') };
      return _badgeCache.url;
    } catch {
      return '';
    }
  }

  function scheduleDockBadgeSync() {
    if (state.dockBadgeTimer) {
      return;
    }

    state.dockBadgeTimer = setTimeout(async () => {
      state.dockBadgeTimer = null;
      const total = state.accounts.reduce((acc, account) => {
        const count = Number(state.unreadByAccount.get(account.id) || 0);
        return acc + Math.max(0, count);
      }, 0);

      const badge = total > 0 ? renderBadgeDataUrl(total) : '';
      const result = await window.waDeck.setDockBadge({ count: total, badge }).catch(() => null);
      if (!result?.ok) {
        return;
      }
    }, 250);
  }

  function parseUnreadFromTitle(title) {
    const match = String(title || '').match(/\((\d+)\)/);
    if (!match) return 0;
    return Number(match[1] || 0) || 0;
  }

  function updateActiveUnreadIndicator() {
    if (!els.activeUnread || !els.activeUnreadCount) return;
    let total = 0;
    for (const count of state.unreadByAccount.values()) {
      total += Math.max(0, Number(count) || 0);
    }
    if (total > 0) {
      els.activeUnread.classList.remove('hidden');
      els.activeUnreadCount.textContent = total > 99 ? '99+' : String(total);
    } else {
      els.activeUnread.classList.add('hidden');
      els.activeUnreadCount.textContent = '0';
    }
  }

  function findAccountCard(accountId) {
    const safeId = String(accountId || '').trim();
    if (!safeId || !els.accountsList) return null;
    return Array.from(els.accountsList.children || []).find((node) => node.dataset?.accountId === safeId) || null;
  }

  function patchAccountUnreadBadge(accountId) {
    const card = findAccountCard(accountId);
    if (!card) return false;

    const unread = Number(state.unreadByAccount.get(accountId) || 0);
    let badge = card.querySelector('.account-unread');

    if (unread > 0) {
      if (!badge) {
        badge = document.createElement('div');
        badge.className = 'account-unread';
        card.appendChild(badge);
      }
      badge.textContent = unread > 99 ? '99+' : String(unread);
    } else if (badge) {
      badge.remove();
    }

    return true;
  }

  function setUnreadCount(accountId, count) {
    const safeId = String(accountId || '');
    if (!safeId) return;
    const safeCount = Math.max(0, Number(count) || 0);
    const prev = Number(state.unreadByAccount.get(safeId) || 0);
    if (prev === safeCount) return;
    state.unreadByAccount.set(safeId, safeCount);
    if (!patchAccountUnreadBadge(safeId)) {
      renderAccounts();
    }
    updateActiveUnreadIndicator();
    scheduleDockBadgeSync();
    /* Debounce hub dashboard updates — prevents 30 rebuilds per poll cycle */
    if (typeof updateHubDashboard === 'function') {
      if (_hubDashboardDebounceTimer) clearTimeout(_hubDashboardDebounceTimer);
      _hubDashboardDebounceTimer = setTimeout(() => {
        _hubDashboardDebounceTimer = null;
        updateHubDashboard();
      }, 200);
    }
  }

  /* Helper: sleep for ms */
  const _delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function pollUnreadCounts() {
    if (state.unreadPollBusy) return;
    state.unreadPollBusy = true;
    try {
      /* Stagger polling in batches of 6 to avoid 30 concurrent IPC calls */
      const BATCH_SIZE = 6;
      const accounts = state.accounts.filter((a) => !a.frozen);
      for (let i = 0; i < accounts.length; i += BATCH_SIZE) {
        const batch = accounts.slice(i, i + BATCH_SIZE);
        const tasks = batch.map(async (account) => {
          const webview = state.webviews.get(account.id);
          if (!isWebviewReady(webview)) return;
          const isTg = account.type === 'telegram';
          // safeExecuteInWebview never rejects — it resolves null on failure.
          // The webview script returns -1 when it could not count. In both
          // cases keep the previous counter instead of resetting it to 0.
          const script = isTg ? collectTgUnreadCountScript() : collectUnreadCountScript();
          const raw = await safeExecuteInWebview(webview, script, true);
          const count = Number(raw);
          if (raw === null || !Number.isFinite(count) || count < 0) return;
          setUnreadCount(account.id, count);
          // Системные уведомления для Telegram живут на приросте счётчика
          // аккаунта (у WhatsApp — на per-contact ленте pin-feed).
          if (isTg) window.WaDeckNotifications?.observeAccount?.(account, count);
        });
        await Promise.allSettled(tasks);
        /* Pause between batches to spread CPU load */
        if (i + BATCH_SIZE < accounts.length) await _delay(500);
      }
      /* Handle frozen accounts */
      for (const account of state.accounts) {
        if (account.frozen) setUnreadCount(account.id, 0);
      }
    } finally {
      state.unreadPollBusy = false;
    }
  }

  // 5000 → 10000: title-события доставляют изменения счётчика мгновенно,
  // поллинг — только страховка (см. title-гейт в pin-feed).
  const POLL_ACTIVE_MS = 10000;
  const POLL_BACKGROUND_MS = 15000;
  let _pollIntervalMs = POLL_ACTIVE_MS;

  function _restartPollTimer() {
    if (state.unreadPollTimer) clearInterval(state.unreadPollTimer);
    state.unreadPollTimer = setInterval(() => {
      pollUnreadCounts().catch(() => {});
    }, _pollIntervalMs);
  }

  // Guard on `state`: these fire at document level and can arrive between
  // script evaluation and init() (state undefined), and must not start the
  // poll interval before startUnreadPolling() has been called.
  window.addEventListener('focus', () => {
    if (!state || !state.unreadPollTimer) return;
    if (_pollIntervalMs !== POLL_ACTIVE_MS) {
      _pollIntervalMs = POLL_ACTIVE_MS;
      _restartPollTimer();
      pollUnreadCounts().catch(() => {});
    }
  });
  window.addEventListener('blur', () => {
    if (!state || !state.unreadPollTimer) return;
    if (_pollIntervalMs !== POLL_BACKGROUND_MS) {
      _pollIntervalMs = POLL_BACKGROUND_MS;
      _restartPollTimer();
    }
  });

  function startUnreadPolling() {
    if (state.unreadPollTimer) {
      clearInterval(state.unreadPollTimer);
      state.unreadPollTimer = null;
    }
    _pollIntervalMs = document.hasFocus() ? POLL_ACTIVE_MS : POLL_BACKGROUND_MS;
    state.unreadPollTimer = setInterval(() => {
      pollUnreadCounts().catch(() => {});
    }, _pollIntervalMs);
    setTimeout(() => pollUnreadCounts().catch(() => {}), 800);
  }

  export const WaDeckUnreadModule = {
    init,
    parseUnreadFromTitle,
    updateActiveUnreadIndicator,
    setUnreadCount,
    scheduleDockBadgeSync,
    startUnreadPolling,
  };
  window.WaDeckUnreadModule = WaDeckUnreadModule;

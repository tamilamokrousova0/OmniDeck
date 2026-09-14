/* Unified unread feed — полноэкранная вкладка в стартовом хабе: все чаты с
   непрочитанными по ВСЕМ аккаунтам (имя, превью, счётчик, бейдж аккаунта),
   сортировка по счётчику. Клик — переключить аккаунт и открыть чат (тот же
   маршрут, что у избранных: прямой клик по строке списка, фолбэк — поиск).

   Данные — collectUnreadChatsScript через общий кэш pin-feed.scanAccountUnread
   (та же TTL-защита от повторных инжекций, что у избранных/важных). Спящие
   (hibernated) аккаунты не сканируются — честно показываем это в подвале. */
import { WaDeckPinFeed } from './pin-feed.js';
import { showToast } from './core/helpers.js';
import { updateHubDashboard, updateHubFilters } from './core/hub.js';
import { refreshWebviewVisibility } from './core/webviews.js';

  let state = null;
  let setActiveAccount = null;
  let isWebviewReady = null;
  let safeExecuteInWebview = null;

  const SCAN_MS = 6000;
  let _timer = null;
  let _busy = false;
  let _rows = [];        // [{accountId, accountName, name, preview, count}]
  let _sleeping = 0;
  // Оптимистичное скрытие только что открытых чатов (как в favorites):
  // ключ accountId::name → истечение подавления.
  const _suppressed = new Map();
  const SUPPRESS_MS = 12000;
  const STALE_ROWS_MS = 15000;
  let _lastScanAt = 0;
  // Режим ленты: 'all' — все непрочитанные, 'fav' — только избранные контакты
  // с непрочитанными, 'imp' — только важные. Вкладки хаба переключают его.
  let _feedMode = 'all';

  const overlayEl = () => document.getElementById('hub-overlay');
  const feedEl = () => document.getElementById('hub-unread-feed');
  const tabAccountsEl = () => document.getElementById('hub-tab-accounts');
  const tabUnreadEl = () => document.getElementById('hub-tab-unread');
  const totalEl = () => document.getElementById('hub-unread-total');
  const favTotalEl = () => document.getElementById('hub-fav-total');
  const impTotalEl = () => document.getElementById('hub-imp-total');
  const isFav = (r) => Boolean(window.WaDeckFavoritesModule?.isFavorite?.(r.accountId, r.name));
  const isImp = (r) => Boolean(window.WaDeckImportantModule?.isImportant?.(r.accountId, r.name));

  function init(ctx) {
    state = ctx.state;
    setActiveAccount = ctx.setActiveAccount;
    isWebviewReady = ctx.isWebviewReady;
    safeExecuteInWebview = ctx.safeExecuteInWebview;
    bindTabs();
    if (!_timer) _timer = setInterval(() => { refresh().catch(() => {}); }, SCAN_MS);
  }

  function hubVisible() {
    const hub = document.getElementById('hub-screen');
    return Boolean(hub && !hub.classList.contains('hidden'));
  }

  function tabActive() {
    return Boolean(overlayEl()?.classList.contains('huf-active'));
  }

  function bindTabs() {
    const tabA = tabAccountsEl();
    const tabU = tabUnreadEl();
    if (!tabA || !tabU || tabA.dataset.hufBound) return;
    tabA.dataset.hufBound = '1';
    // Аккаунты — список карточек; остальные три вкладки — лента непрочитанных
    // в разных режимах (все / только избранные / только важные).
    tabA.addEventListener('click', () => setTab('accounts'));
    tabU.addEventListener('click', () => setTab('all'));
    document.getElementById('hub-tab-favorites')?.addEventListener('click', () => setTab('fav'));
    document.getElementById('hub-tab-important')?.addEventListener('click', () => setTab('imp'));
  }

  /* tab: 'accounts' — карточки; 'all'/'fav'/'imp' — лента. */
  function setTab(tab) {
    const overlay = overlayEl();
    if (!overlay) return;
    state.hubTab = tab;
    const feedTab = tab !== 'accounts';
    if (feedTab) _feedMode = tab;

    overlay.classList.toggle('huf-active', feedTab);
    updateHubFilters();
    refreshWebviewVisibility();
    if (feedTab) {
      render();
    } else {
      updateHubDashboard().catch?.(() => {});
    }
    // Скан на любой вкладке — освежить бейджи фав/важных/непрочитанных.
    refresh().catch(() => {});
  }

  /* Строки для текущего режима: у 'fav'/'imp' — только избранные/важные
     контакты с непрочитанными. _rows всегда содержит ВСЕ (нужно для Cmd+U). */
  function visibleRows() {
    if (_feedMode === 'fav') return _rows.filter(isFav);
    if (_feedMode === 'imp') return _rows.filter(isImp);
    return _rows;
  }

  function waAccounts() {
    return (state?.accounts || []).filter((a) => a.type === 'whatsapp' && !a.frozen);
  }

  function accountName(accountId) {
    return state?.accounts?.find((a) => a.id === accountId)?.name || accountId;
  }

  /* Core scan without visibility guards — refresh() (hub tab) and
   * jumpToNext() (Cmd/Ctrl+U from anywhere) share it. */
  async function scan() {
    const accounts = waAccounts();
    let sleeping = 0;
    const scans = accounts.map(async (acc) => {
      const webview = state.webviews.get(acc.id);
      if (!isWebviewReady?.(webview)) { sleeping++; return []; }
      const rows = await WaDeckPinFeed.scanAccountUnread(acc.id, webview, safeExecuteInWebview);
      if (!Array.isArray(rows)) return [];
      return rows.map((r) => ({
        accountId: acc.id,
        accountName: acc.name || acc.id,
        name: String(r?.name || '').trim(),
        preview: String(r?.preview || '').trim(),
        count: Math.max(1, Number(r?.count) || 1),
      })).filter((r) => r.name);
    });
    const settled = await Promise.all(scans.map((p) => p.catch(() => [])));
    // Signal: строки из локальной истории панели (сканов не требует)
    const signalRows = (window.WaDeckSignalPanel?.getUnreadRows?.() || []);
    settled.push(signalRows);
    const now = Date.now();
    for (const [key, until] of _suppressed) {
      if (until <= now) _suppressed.delete(key);
    }
    // Порядок = порядок аккаунтов в левой панели (по фидбэку); внутри
    // аккаунта — по счётчику. state.accounts уже в порядке сайдбара.
    const orderIdx = new Map((state?.accounts || []).map((a, i) => [a.id, i]));
    _rows = settled.flat()
      .filter((r) => !_suppressed.has(r.accountId + '::' + r.name.toLowerCase()))
      .map((r) => ({
        ...r,
        _ord: orderIdx.has(r.accountId) ? orderIdx.get(r.accountId) : 999,
      }))
      .sort((a, b) => (a._ord - b._ord) || (b.count - a.count));
    _sleeping = sleeping;
    _lastScanAt = Date.now();
  }

  async function refresh() {
    if (_busy || !state) return;
    // Сканим пока хаб виден (не только на feed-вкладке) — чтобы бейджи
    // Непрочитанные/Избранные/Важные были свежими на любой вкладке. Title-гейт
    // в pin-feed делает скан дешёвым (аккаунты с 0 непрочитанных не инжектятся).
    if (!hubVisible()) return;
    _busy = true;
    try {
      await scan();
      render();
    } finally {
      _busy = false;
    }
  }

  /* Cmd/Ctrl+U: прыжок в чат с наибольшим числом непрочитанных по всем
   * аккаунтам. Работает при закрытом хабе: лента могла не сканироваться —
   * если строк нет, делаем скан на месте. Повторные нажатия идут по списку
   * дальше (jump() убирает строку и глушит её через suppress). */
  async function jumpToNext() {
    if (!state || _busy) return;
    // Рескан не только при пустом списке, но и при протухших данных: лента
    // сканируется лишь при открытом хабе, и Cmd+U через час прыгал бы по
    // часовой давности списку в уже прочитанный чат.
    if (!_rows.length || (Date.now() - _lastScanAt) > STALE_ROWS_MS) {
      _busy = true;
      try {
        await scan();
      } finally {
        _busy = false;
      }
    }
    if (!_rows.length) {
      showToast('Непрочитанных сообщений нет', 'success', 1800);
      return;
    }
    await jump(_rows[0]);
  }

  function fmtCount(n) { return n > 99 ? '99+' : String(n); }

  function render() {
    const feed = feedEl();
    if (!feed) return;
    // Бейджи вкладок обновляются всегда (на любой вкладке хаба): все
    // непрочитанные, только избранные, только важные.
    const setBadge = (el, n) => { if (el) el.textContent = n ? ` ${fmtCount(n)}` : ''; };
    setBadge(totalEl(), _rows.reduce((s, r) => s + r.count, 0));
    setBadge(favTotalEl(), _rows.filter(isFav).reduce((s, r) => s + r.count, 0));
    setBadge(impTotalEl(), _rows.filter(isImp).reduce((s, r) => s + r.count, 0));

    if (!tabActive()) return;
    const rows = visibleRows();
    feed.innerHTML = '';
    const frag = document.createDocumentFragment();

    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'hub-empty';
      empty.textContent = _feedMode === 'fav'
        ? 'Нет непрочитанных у избранных'
        : _feedMode === 'imp'
          ? 'Нет непрочитанных у важных'
          : 'Непрочитанных сообщений нет';
      frag.appendChild(empty);
    }

    for (const row of rows) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'huf-row';
      el.title = row.preview || row.name;
      // Цветной аватар аккаунта — как у плиток «Аккаунты», чтобы лента
      // непрочитанных не выглядела чужеродным списком
      const acc = (state?.accounts || []).find((a) => a.id === row.accountId);
      const av = document.createElement('span');
      av.className = 'huf-row-av';
      av.style.background = acc?.color || 'var(--bg-3)';
      av.textContent = String(row.accountName || '').split(' ')[0].slice(0, 2).toUpperCase() || 'WA';
      const who = document.createElement('span');
      who.className = 'huf-row-who';
      who.textContent = row.name;
      const preview = document.createElement('span');
      preview.className = 'huf-row-preview';
      preview.textContent = row.preview || '';
      const acct = document.createElement('span');
      acct.className = 'huf-row-acct';
      acct.textContent = row.accountName;
      const cnt = document.createElement('span');
      cnt.className = 'huf-row-cnt';
      cnt.textContent = fmtCount(row.count);
      el.append(av, who, preview, acct, cnt);
      el.addEventListener('click', () => jump(row));
      frag.appendChild(el);
    }

    if (_sleeping > 0) {
      const note = document.createElement('div');
      note.className = 'huf-note';
      note.textContent = `${_sleeping} аккаунт(а) спит — их чаты не сканируются до пробуждения`;
      frag.appendChild(note);
    }

    feed.appendChild(frag);
  }

  async function jump(row) {
    if (!row) return;
    if (row._sigKey) {
      // Signal: прямое открытие чата панели, WA-механика поиска не нужна
      _rows = _rows.filter((r) => !(r.accountId === row.accountId && r._sigKey === row._sigKey));
      render();
      window.WaDeckSignalPanel?.openChat?.(row.accountId, row._sigKey);
      return;
    }
    const key = row.accountId + '::' + row.name.toLowerCase();
    // Оптимистично прячем строку (открытие чата пометит его прочитанным);
    // следующий скан переподтвердит, если что-то осталось.
    _suppressed.set(key, Date.now() + SUPPRESS_MS);
    _rows = _rows.filter((r) => !(r.accountId === row.accountId && r.name === row.name));
    render();
    if (typeof setActiveAccount === 'function') setActiveAccount(row.accountId);

    // Чат НЕ открылся — оптимизм отменяется: строка возвращается в ленту,
    // suppress снимается, оператору честный тост. Иначе непрочитанный чат
    // молча выпадал из разгребания (Cmd+U шёл дальше, а этот терялся).
    const restoreRow = (reason) => {
      _suppressed.delete(key);
      if (!_rows.some((r) => r.accountId === row.accountId && r.name === row.name)) {
        _rows.push(row);
        _rows.sort((a, b) => ((a._ord ?? 999) - (b._ord ?? 999)) || (b.count - a.count));
      }
      render();
      showToast(`Чат «${row.name}» не открылся — откройте вручную`, 'error', 4000);
      console.warn('[unread-feed] jump failed:', reason, row.accountId, row.name);
    };

    const webview = state.webviews.get(row.accountId);
    if (!webview) { restoreRow('no_webview'); return; }
    const sched = window.WaDeckScheduleModule || {};
    try {
      let res = typeof sched.openChatByListClick === 'function'
        ? await sched.openChatByListClick(webview, row.name)
        : { ok: false };
      if (!res?.ok && typeof sched.openChatInWebview === 'function') {
        res = await sched.openChatInWebview(webview, row.name);
      }
      if (!res?.ok) restoreRow(res?.error || 'open_failed');
    } catch (err) {
      restoreRow(err?.message || 'exception');
    }
  }

  export const WaDeckUnreadFeed = { init, refresh, setTab, jumpToNext };
  window.WaDeckUnreadFeed = WaDeckUnreadFeed;

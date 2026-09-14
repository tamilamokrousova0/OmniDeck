/* Global contact search (Cmd/Ctrl+K) — "in which of my 30 accounts is the
 * chat with X?".
 *
 * Sources, from instant to slow:
 *   1. favorites / important (already in state) — appear immediately;
 *   2. per-account sidebar chat lists collected via collectChatsFromSidebarScript,
 *      swept sequentially in the background while the palette is open and
 *      cached for 10 minutes (the collector hijacks the sidebar scroll for a
 *      few seconds per account, so accounts are swept one at a time and the
 *      ACTIVE account is swept last to keep its visible scroll untouched
 *      while the user is looking at it).
 *
 * Enter / click switches to the account and opens the chat through
 * WaDeckScheduleModule.openChatInWebview (WhatsApp's own search box), so a
 * contact missing from a partially-collected list still opens fine — the
 * palette only needs a name to hand over.
 */
import { WADECK_WV_TOKEN } from './core/state.js';
import { setStatus } from './core/helpers.js';
import { setActiveAccount } from './core/accounts.js';
import { collectChatsFromSidebarScript } from './webview-scripts/collect-chats.js';

  let state = null;
  let isWebviewReady = null;
  let safeExecuteInWebview = null;

  const _cache = new Map(); // accountId → { t, chats: [name] }
  const CACHE_TTL_MS = 10 * 60000;       // палитра открыта — освежаем раз в 10 мин
  const BG_REFRESH_MS = 30 * 60000;      // фон — переcобираем списки старше 30 мин
  const BG_TICK_MS = 15 * 60000;
  const CACHE_LS_KEY = 'wadeck.globalSearchCache.v1';
  let _sweepBusy = false;
  let _sweepDone = 0;
  let _sweepTotal = 0;
  let _open = false;
  let _selIndex = 0;
  let _lastResults = [];

  /* The cache is persisted so search covers hibernated accounts (their
   * webview is destroyed — nothing to collect from) and survives restarts:
   * stale names still open fine, since jumpTo() goes through WhatsApp's own
   * search box anyway. */
  function loadCacheFromStorage() {
    try {
      const raw = JSON.parse(localStorage.getItem(CACHE_LS_KEY) || '{}');
      for (const [accountId, entry] of Object.entries(raw)) {
        if (Array.isArray(entry?.chats) && entry.chats.length) {
          _cache.set(accountId, { t: Number(entry.t) || 0, chats: entry.chats.map(String) });
        }
      }
    } catch { /* corrupt cache — start empty */ }
  }

  function saveCacheToStorage() {
    try {
      const out = {};
      for (const [accountId, entry] of _cache) out[accountId] = entry;
      localStorage.setItem(CACHE_LS_KEY, JSON.stringify(out));
    } catch { /* quota/serialization — non-fatal */ }
  }

  /* Ключи удалённых аккаунтов в localStorage сами не исчезают: обычный
     sweep только перезаписывает свои. */
  function pruneDeletedAccounts() {
    const liveIds = new Set((state?.accounts || []).map((a) => a.id));
    let changed = false;
    for (const accountId of Array.from(_cache.keys())) {
      if (!liveIds.has(accountId)) { _cache.delete(accountId); changed = true; }
    }
    if (changed) saveCacheToStorage();
  }

  function init(ctx) {
    state = ctx.state;
    isWebviewReady = ctx.isWebviewReady;
    safeExecuteInWebview = ctx.safeExecuteInWebview;
    loadCacheFromStorage();
    pruneDeletedAccounts();
    // Фоновая сборка: списки готовы ДО первого Cmd+K, а не через 5 секунд
    // после него. Первый проход — после прогрузки webview.
    setTimeout(() => { sweep(true).catch(() => {}); }, 60000);
    setInterval(() => { sweep(true).catch(() => {}); }, BG_TICK_MS);
  }

  const overlayEl = () => document.getElementById('global-search');
  const inputEl = () => document.getElementById('global-search-input');
  const listEl = () => document.getElementById('global-search-list');
  const statusEl = () => document.getElementById('global-search-status');

  function accountName(accountId) {
    return state?.accounts?.find((a) => a.id === accountId)?.name || accountId;
  }

  function waAccounts() {
    return (state?.accounts || []).filter((a) => a.type === 'whatsapp' && !a.frozen);
  }

  /* ── Background sweep ── */

  /* background=true — тихий фоновый проход: без палитры, активный аккаунт не
   * трогаем вообще (сборщик угоняет скролл сайдбара, а он на глазах у
   * пользователя), и пересобираем только по-настоящему устаревшие списки. */
  async function sweep(background = false) {
    if (_sweepBusy || !state) return;
    if (background && _open) return; // palette sweep уже займётся
    _sweepBusy = true;
    try {
      const now = Date.now();
      const ttl = background ? BG_REFRESH_MS : CACHE_TTL_MS;
      // Active account last — its sidebar scroll is visible to the user.
      const targets = waAccounts()
        .filter((a) => {
          const c = _cache.get(a.id);
          return !c || (now - c.t) > ttl;
        })
        .filter((a) => !background || a.id !== state.activeAccountId)
        .sort((a, b) => (a.id === state.activeAccountId ? 1 : 0) - (b.id === state.activeAccountId ? 1 : 0));
      _sweepTotal = waAccounts().length;
      _sweepDone = _sweepTotal - targets.length;
      renderResults();
      let collectedAny = false;
      for (const account of targets) {
        if (!background && !_open) return; // palette closed — stop burning webview time
        const webview = state.webviews.get(account.id);
        if (!isWebviewReady?.(webview)) { _sweepDone++; continue; } // спит/грузится — остаётся кэш
        const token = typeof WADECK_WV_TOKEN !== 'undefined' ? WADECK_WV_TOKEN : '';
        let chats = null;
        try {
          chats = await safeExecuteInWebview(webview, collectChatsFromSidebarScript(token), true);
        } catch { chats = null; }
        const normalized = Array.isArray(chats)
          ? chats.map((c) => String(c || '').trim()).filter(Boolean)
          : [];
        if (normalized.length) {
          _cache.set(account.id, { t: Date.now(), chats: normalized });
          collectedAny = true;
        }
        _sweepDone++;
        renderResults();
      }
      if (collectedAny) saveCacheToStorage();
    } finally {
      _sweepBusy = false;
      renderResults();
    }
  }

  /* ── Matching ── */

  const digitsOf = (value) => String(value || '').replace(/\D+/g, '');

  /* Транслит-фолд: RU-оператор ищет латинские контакты русским запросом
     («аня» → «Anya», «мюллер» → «Mueller») и наоборот. Неоднозначные буквы
     дают несколько вариантов — сравниваем по каждому. */
  const RU2LAT = {
    а: ['a'], б: ['b'], в: ['v', 'w'], г: ['g'], д: ['d'], е: ['e'], ё: ['e', 'yo'],
    ж: ['zh', 'j'], з: ['z'], и: ['i'], й: ['y', 'i', 'j'], к: ['k', 'c'], л: ['l'],
    м: ['m'], н: ['n'], о: ['o'], п: ['p'], р: ['r'], с: ['s'], т: ['t'],
    у: ['u', 'ou'], ф: ['f', 'ph'], х: ['kh', 'h', 'x'], ц: ['ts', 'c'], ч: ['ch'],
    ш: ['sh'], щ: ['shch', 'sch'], ъ: [''], ы: ['y', 'i'], ь: [''], э: ['e'],
    ю: ['yu', 'ju', 'u', 'ue'], я: ['ya', 'ja', 'ia'],
  };
  function translitVariants(q) {
    if (!/[а-яё]/i.test(q)) return [];
    // Декартово произведение взорвётся на длинных запросах — берём первый
    // вариант каждой буквы как основной + один альтернативный проход.
    const primary = [];
    const alt = [];
    for (const ch of q.toLowerCase()) {
      const m = RU2LAT[ch];
      if (m) { primary.push(m[0]); alt.push(m[1] !== undefined ? m[1] : m[0]); }
      else { primary.push(ch); alt.push(ch); }
    }
    const a = primary.join('');
    const b = alt.join('');
    return a === b ? [a] : [a, b];
  }

  function collectMatches(query) {
    const rawQuery = String(query || '').trim();
    const q = rawQuery.toLowerCase();
    // ≥4 цифр в запросе — сравниваем ещё и по цифрам, игнорируя +, пробелы
    // и дефисы с обеих сторон («+41 79…» найдёт чат с заголовком «41791234567»).
    const qDigits = digitsOf(q);
    const matchByDigits = qDigits.length >= 4;
    const qTranslit = translitVariants(q);
    const out = [];
    const seen = new Set();
    // Скоринг вместо голого includes: точное имя выше префикса, префикс выше
    // подстроки — раньше exact-совпадение могло лежать на 30-й позиции.
    const scoreOf = (nameLower) => {
      const tryOne = (needle) => {
        if (!needle) return 0;
        if (nameLower === needle) return 100;
        if (nameLower.startsWith(needle)) return 60;
        if (nameLower.includes(needle)) return 30;
        return 0;
      };
      let s = tryOne(q);
      for (const t of qTranslit) s = Math.max(s, tryOne(t) - 1); // транслит чуть ниже прямого
      return s;
    };
    const push = (accountId, name, source) => {
      let score = 0;
      if (q) {
        const nameLower = String(name).toLowerCase();
        score = scoreOf(nameLower);
        const digitHit = matchByDigits && digitsOf(name).includes(qDigits);
        if (digitHit) score = Math.max(score, 30);
        if (!score) return;
      }
      const key = accountId + '::' + String(name).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      // Важные/избранные — тайбрейкер при равном скоре
      const prio = source === 'imp' ? 2 : source === 'fav' ? 1 : 0;
      out.push({ accountId, name, source, _score: score, _prio: prio });
    };
    // Instant sources first (favorites/important carry accountId + name)
    for (const f of state?.important || []) push(f.accountId, f.name, 'imp');
    for (const f of state?.favorites || []) push(f.accountId, f.name, 'fav');
    /* Кэш переживает перезапуск и удаление аккаунта: без этой проверки в
       выдачу попадали чаты удалённых аккаунтов, а строка показывала
       технический wa_… вместо имени. Чистим лениво, прямо на выдаче. */
    const liveIds = new Set((state?.accounts || []).map((a) => a.id));
    let pruned = false;
    for (const accountId of Array.from(_cache.keys())) {
      if (!liveIds.has(accountId)) { _cache.delete(accountId); pruned = true; continue; }
      for (const name of _cache.get(accountId).chats) push(accountId, name, 'chat');
    }
    if (pruned) saveCacheToStorage();
    if (q) out.sort((a, b) => (b._score - a._score) || (b._prio - a._prio));
    const results = out.slice(0, 50);
    // Запрос выглядит как номер телефона — добавляем действие «открыть по
    // номеру» на каждый аккаунт: поиск самого WhatsApp находит по номеру и
    // сохранённые контакты, и чаты, которых нет ни в одном нашем списке.
    const phoneLike = /^\+?[\d\s\-().]+$/.test(rawQuery) && qDigits.length >= 5 && qDigits.length <= 15;
    if (phoneLike) {
      const number = (rawQuery.startsWith('+') ? '+' : '') + qDigits;
      // Активный аккаунт первым: Enter по первой строке — почти всегда «в нём»
      const accounts = waAccounts().slice().sort(
        (a, b) => (b.id === state.activeAccountId ? 1 : 0) - (a.id === state.activeAccountId ? 1 : 0),
      );
      for (const account of accounts) {
        results.push({ accountId: account.id, name: number, source: 'phone' });
      }
    }
    return results;
  }

  /* ── Rendering ── */

  function renderResults() {
    if (!_open) return;
    const list = listEl();
    const status = statusEl();
    if (!list) return;
    const query = String(inputEl()?.value || '');
    _lastResults = collectMatches(query);
    if (_selIndex >= _lastResults.length) _selIndex = Math.max(0, _lastResults.length - 1);

    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    _lastResults.forEach((item, idx) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'gs-row' + (idx === _selIndex ? ' is-active' : '');
      const who = document.createElement('span');
      who.className = 'gs-row-who';
      who.textContent = item.name;
      const sub = document.createElement('span');
      sub.className = 'gs-row-sub';
      const badge = item.source === 'imp' ? '⚑ ' : item.source === 'fav' ? '★ ' : '';
      sub.textContent = item.source === 'phone'
        ? `открыть по номеру · ${accountName(item.accountId)}`
        : badge + accountName(item.accountId);
      row.append(who, sub);
      row.addEventListener('click', () => jumpTo(item));
      row.addEventListener('mousemove', () => {
        if (_selIndex !== idx) { _selIndex = idx; renderResults(); }
      });
      frag.appendChild(row);
    });
    list.appendChild(frag);

    if (status) {
      // У спящих аккаунтов webview разрушен — их списки берутся из
      // сохранённого кэша и могли устареть; честно говорим об этом.
      const sleeping = state?._hibernated?.size || 0;
      const sleepNote = sleeping ? ` · ${sleeping} спит — из кэша` : '';
      if (_sweepBusy) {
        status.textContent = `Собираю чаты: ${_sweepDone}/${_sweepTotal} аккаунтов…${sleepNote}`;
      } else if (!_lastResults.length) {
        status.textContent = query ? 'Ничего не найдено' : 'Имя контакта или номер телефона';
      } else {
        status.textContent = `Найдено: ${_lastResults.length}${_lastResults.length >= 50 ? '+' : ''}${sleepNote}`;
      }
    }
  }

  /* ── Navigation ── */

  async function jumpTo(item) {
    if (!item) return;
    close();
    if (typeof setActiveAccount === 'function') setActiveAccount(item.accountId);
    const webview = state.webviews.get(item.accountId);
    const sched = window.WaDeckScheduleModule || {};
    if (webview && sched.openChatInWebview) {
      // По номеру: заголовок найденного контакта — имя, номер в нём не
      // встречается, поэтому просим кликнуть первый результат поиска WA.
      const opts = item.source === 'phone' ? { pickFirstResult: true } : undefined;
      let res = null;
      // Fast-path (кроме номеров): клик по видимой строке списка ~0.5 c против
      // ~2 c через поиск WA; имя пришло из заголовков того же сайдбара, так что
      // exact-match типичен. Промах стоит один executeJavaScript-запрос.
      if (!opts && typeof sched.openChatByListClick === 'function') {
        res = await sched.openChatByListClick(webview, item.name).catch(() => null);
      }
      if (!res?.ok) {
        res = await sched.openChatInWebview(webview, item.name, opts).catch(() => null);
      }
      if (!res?.ok && typeof setStatus === 'function') {
        setStatus(`Не удалось открыть чат «${item.name}» (${res?.error || 'ошибка'})`);
      }
    }
  }

  function onInputKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _selIndex = Math.min(_selIndex + 1, Math.max(0, _lastResults.length - 1));
      renderResults();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      _selIndex = Math.max(0, _selIndex - 1);
      renderResults();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      jumpTo(_lastResults[_selIndex]);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  let _bound = false;
  function bind() {
    if (_bound) return;
    const overlay = overlayEl();
    const input = inputEl();
    if (!overlay || !input) return;
    _bound = true;
    input.addEventListener('input', () => { _selIndex = 0; renderResults(); });
    input.addEventListener('keydown', onInputKeydown);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) close();
    });
  }

  function open() {
    const overlay = overlayEl();
    const input = inputEl();
    if (!overlay || !input || !state) return;
    bind();
    _open = true;
    _selIndex = 0;
    overlay.classList.remove('hidden');
    input.value = '';
    input.focus();
    renderResults();
    sweep().catch(() => {});
  }

  function close() {
    _open = false;
    overlayEl()?.classList.add('hidden');
  }

  function toggle() {
    if (_open) close(); else open();
  }

  export const WaDeckGlobalSearch = { init, open, close, toggle, isOpen: () => _open, onAccountRemoved: pruneDeletedAccounts };
  window.WaDeckGlobalSearch = WaDeckGlobalSearch;

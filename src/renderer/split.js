/* Split view: встроенный браузер в правой панели workspace.
 *
 * Webview создаётся лениво при первом открытии (partition
 * persist:split_browser — main по нему отличает браузерный webview от чатовых
 * и не навешивает WA-ограничения: origin-allowlist, UA, guest-preload).
 * Ссылки из чатов приходят каналом guest-link: при открытой панели грузятся
 * сюда, при закрытой — во внешний браузер (прежнее поведение). */

let els = null;

let _webview = null;
let _pendingUrl = '';

const isOpen = () => Boolean(document.querySelector('main.workspace')?.classList.contains('split-on'));

function normalizeInput(raw) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;
  // «слово.tld» без пробелов — адрес, иначе поисковый запрос
  if (/^[^\s]+\.[^\s]{2,}$/.test(v)) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}

function showStart(show) {
  const start = document.getElementById('split-start');
  if (start) start.classList.toggle('hidden', !show);
}

function ensureSplitWebview() {
  if (_webview) return _webview;
  const host = document.getElementById('split-view-host');
  if (!host) return null;
  showStart(false);
  const wv = document.createElement('webview');
  wv.partition = 'persist:split_browser';
  // Нужен, чтобы target=_blank внутри сайта доходил до нашего обработчика
  // (он открывает ссылку в этой же панели, новых окон не появляется)
  wv.setAttribute('allowpopups', 'true');
  wv.setAttribute('webpreferences', 'contextIsolation=yes');
  wv.src = _pendingUrl || 'about:blank';
  wv.addEventListener('did-navigate', (e) => { syncUrlBar(e.url); syncTranslateBtn(e.url); });
  wv.addEventListener('did-navigate-in-page', (e) => { syncUrlBar(e.url); syncTranslateBtn(e.url); });
  host.appendChild(wv);
  _webview = wv;
  return wv;
}

function syncUrlBar(url) {
  const input = document.getElementById('split-url');
  if (!input || document.activeElement === input) return;
  const v = String(url || '');
  input.value = v === 'about:blank' ? '' : v;
}

function navigate(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return;
  _pendingUrl = target;
  const wv = ensureSplitWebview();
  if (!wv) return;
  try {
    if (typeof wv.loadURL === 'function') wv.loadURL(target).catch(() => {});
    else wv.src = target;
  } catch { wv.src = target; }
  syncUrlBar(target);
}

/* Перевод страницы через официальный прокси Google (*.translate.goog) —
   тот же механизм, что у «Перевести страницу» в Chrome. Своими силами
   переводить DOM нельзя: полноценный обход текста быстро упирается в
   лимиты бесплатного API (у нас уже был 429-бан по IP). */
const TRANSLATE_HOST = '.translate.goog';

function toTranslated(url, tl = 'ru') {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (u.hostname.endsWith(TRANSLATE_HOST)) return null; // уже переведено
    const host = u.hostname.replace(/-/g, '--').replace(/\./g, '-') + TRANSLATE_HOST;
    const params = new URLSearchParams(u.search);
    params.set('_x_tr_sl', 'auto');
    params.set('_x_tr_tl', tl);
    params.set('_x_tr_hl', tl);
    const q = params.toString();
    return `${u.protocol}//${host}${u.pathname}${q ? '?' + q : ''}${u.hash}`;
  } catch {
    return null;
  }
}

/* Обратно к оригиналу: host-with-dashes.translate.goog → исходный домен */
function toOriginal(url) {
  try {
    const u = new URL(url);
    if (!u.hostname.endsWith(TRANSLATE_HOST)) return null;
    const bare = u.hostname.slice(0, -TRANSLATE_HOST.length);
    // '--' это дефис оригинала, одиночный '-' — точка
    const host = bare.split('--').map((part) => part.replace(/-/g, '.')).join('-');
    const params = new URLSearchParams(u.search);
    for (const k of ['_x_tr_sl', '_x_tr_tl', '_x_tr_hl', '_x_tr_pto', '_x_tr_hist']) params.delete(k);
    const q = params.toString();
    return `${u.protocol}//${host}${u.pathname}${q ? '?' + q : ''}${u.hash}`;
  } catch {
    return null;
  }
}

function toggleTranslate() {
  const cur = String(_webview?.getURL?.() || _pendingUrl || '');
  if (!/^https?:\/\//i.test(cur)) return;
  const back = toOriginal(cur);
  const next = back || toTranslated(cur);
  if (!next) return;
  navigate(next);
  syncTranslateBtn(next);
}

function syncTranslateBtn(url) {
  const btn = document.getElementById('split-translate');
  if (!btn) return;
  const on = String(url || '').includes(TRANSLATE_HOST);
  btn.classList.toggle('is-active', on);
  btn.title = on ? 'Вернуть оригинал страницы' : 'Перевести страницу на русский';
}

function setOpen(open) {
  const workspace = document.querySelector('main.workspace');
  if (!workspace) return;
  workspace.classList.toggle('split-on', Boolean(open));
  if (open) {
    if (_pendingUrl) ensureSplitWebview();
    else showStart(true);
    // фокус туда, где пользователь и так собирается печатать
    (document.getElementById(_pendingUrl ? 'split-url' : 'split-start-input'))?.focus();
    return;
  }
  unloadPage(); // ✕ = чистый лист: иначе YouTube продолжал играть в фоне
}

/* Выгрузка страницы: webview удаляется целиком (спрятанный продолжал жить
   и проигрывать медиа), панель возвращается к стартовому экрану. */
function unloadPage() {
  if (_webview) {
    try { _webview.remove(); } catch { /* ignore */ }
    _webview = null;
  }
  _pendingUrl = '';
  const input = document.getElementById('split-url');
  if (input) input.value = '';
  syncTranslateBtn('');
  showStart(true);
}

function toggle() { setOpen(!isOpen()); }

function openUrl(url) {
  setOpen(true);
  navigate(url);
}

/* Ссылка из чатового webview (main → renderer). flip = Cmd/Ctrl был зажат
   при клике: открыть «наоборот» — сплит при закрытой панели, внешний браузер
   при открытой. */
function handleGuestLink(url, flip) {
  const useSplit = isOpen() !== Boolean(flip);
  if (useSplit) openUrl(url);
  else window.waDeck.openExternal?.(url)?.catch?.(() => {});
}

function bindDividerDrag() {
  const divider = document.getElementById('split-divider');
  const workspace = document.querySelector('main.workspace');
  if (!divider || !workspace) return;
  divider.addEventListener('pointerdown', (down) => {
    down.preventDefault();
    divider.setPointerCapture(down.pointerId);
    const rect = workspace.getBoundingClientRect();
    const onMove = (move) => {
      const width = Math.round(rect.right - move.clientX);
      const clamped = Math.max(280, Math.min(width, Math.round(rect.width * 0.7)));
      workspace.style.setProperty('--split-w', `${clamped}px`);
    };
    const onUp = () => {
      divider.removeEventListener('pointermove', onMove);
      divider.removeEventListener('pointerup', onUp);
    };
    divider.addEventListener('pointermove', onMove);
    divider.addEventListener('pointerup', onUp);
  });
}

function init(ctx) {
  els = ctx?.els || null;

  document.getElementById('split-close')?.addEventListener('click', () => setOpen(false));
  document.getElementById('split-forward')?.addEventListener('click', () => {
    try { _webview?.goForward?.(); } catch { /* ignore */ }
  });
  document.getElementById('split-home')?.addEventListener('click', () => unloadPage());
  document.getElementById('split-start-input')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = normalizeInput(e.target.value);
    if (target) { e.target.value = ''; navigate(target); }
  });
  document.getElementById('split-back')?.addEventListener('click', () => {
    try { _webview?.goBack?.(); } catch { /* ignore */ }
  });
  document.getElementById('split-reload')?.addEventListener('click', () => {
    try { _webview?.reload?.(); } catch { /* ignore */ }
  });
  document.getElementById('split-translate')?.addEventListener('click', () => toggleTranslate());
  document.getElementById('split-open-ext')?.addEventListener('click', () => {
    const raw = String(_webview?.getURL?.() || '');
    const url = toOriginal(raw) || raw; // наружу отдаём оригинал, не прокси-перевод
    if (/^https?:\/\//i.test(url)) window.waDeck.openExternal?.(url)?.catch?.(() => {});
  });
  document.getElementById('split-url')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = normalizeInput(e.target.value);
    if (target) navigate(target);
    e.target.blur();
  });
  bindDividerDrag();

  if (typeof window.waDeck?.onGuestLink === 'function') {
    window.waDeck.onGuestLink(({ url, flip }) => handleGuestLink(String(url || ''), flip));
  }
}

/* Краш браузерного webview: main шлёт webview-crashed с id упавшего contents */
function reloadIfCrashed(webContentsId) {
  if (!_webview) return false;
  try {
    const id = typeof _webview.getWebContentsId === 'function' ? _webview.getWebContentsId() : -1;
    if (webContentsId && id !== webContentsId) return false;
    _webview.reload();
    return true;
  } catch {
    return false;
  }
}

export const WaDeckSplitModule = { init, toggle, openUrl, isOpen, reloadIfCrashed };
window.WaDeckSplitModule = WaDeckSplitModule;

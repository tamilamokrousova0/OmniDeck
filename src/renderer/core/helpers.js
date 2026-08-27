/* Generic UI helpers: status/toast/confirm, busy buttons, escaping,
   date formatting, template variables. Extracted verbatim from renderer.js. */
import { state, els } from './state.js';

function platformPasteModifier() {
  const runtimePlatform = String(state.runtime?.platform || '').toLowerCase();
  if (runtimePlatform) {
    return runtimePlatform === 'darwin' ? 'meta' : 'control';
  }
  const browserPlatform = String(navigator.platform || '').toLowerCase();
  return browserPlatform.includes('mac') ? 'meta' : 'control';
}

function bindPasswordToggle(inputEl, toggleBtn, visibleTitle = 'Скрыть ключ', hiddenTitle = 'Показать ключ') {
  if (!inputEl || !toggleBtn) return;
  toggleBtn.addEventListener('click', () => {
    const nextIsPassword = inputEl.type !== 'password';
    inputEl.type = nextIsPassword ? 'password' : 'text';
    toggleBtn.classList.toggle('is-revealed', !nextIsPassword);
    toggleBtn.title = nextIsPassword ? hiddenTitle : visibleTitle;
  });
}

function resetPasswordFieldVisibility(inputEl, toggleBtn) {
  if (!inputEl || !toggleBtn) return;
  inputEl.type = 'password';
  toggleBtn.classList.remove('is-revealed');
  toggleBtn.title = 'Показать ключ';
}

let _statusClearTimer = null;
/* Notification routing: final RESULTS (saved/deleted/errors) go to a toast
   only; transient PROCESS messages ("loading...") go to the status zone only.
   Previously both fired for results, producing duplicate notifications. */
function setStatusZone(text) {
  const safeText = String(text || '');
  if (els.status) {
    els.status.textContent = safeText;
    els.status.title = safeText;
    els.status.classList.toggle('hidden', !safeText);
  }
  if (_statusClearTimer) { clearTimeout(_statusClearTimer); _statusClearTimer = null; }
  if (safeText) {
    _statusClearTimer = setTimeout(() => {
      if (els.status) { els.status.textContent = ''; els.status.classList.add('hidden'); }
    }, 3000);
  }
}

function setStatus(text) {
  const safeText = String(text || '');
  const lower = safeText.toLowerCase();
  const isError = lower.includes('ошибка') || lower.includes('не удалось') || lower.includes('неверн');
  if (isError) {
    showToast(safeText, 'error', 5000);
    return;
  }
  // «обновлен(?!ие)»: слово «обновление» — это ПРОЦЕСС (загрузка идёт), и
  // каждый его процент раньше улетал отдельным тостом, выстраивая столбик
  const isResult = /сохранен|сохранён|скопирован|удален|удалён|разморожен|запланирован|отменен|отменён|вставлен|отправлено|обновлен(?!ие)|обновлён|сброшен|закреплён|откреплён/.test(lower);
  if (isResult) {
    showToast(safeText, 'success');
    return;
  }
  setStatusZone(safeText);
}

function showToast(text, type, duration) {
  if (typeof type === 'undefined') type = 'info';
  if (typeof duration === 'undefined') duration = 3000;
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast' + (type === 'success' ? ' toast-success' : type === 'error' ? ' toast-error' : type === 'warn' ? ' toast-warn' : '');
  toast.textContent = text;
  container.appendChild(toast);
  setTimeout(function () {
    toast.classList.add('is-hiding');
    setTimeout(function () { toast.remove(); }, 260);
  }, duration);
}

// ── Animated modal close ──
function closeModalAnimated(modalEl) {
  if (!modalEl || modalEl.classList.contains('hidden') || modalEl.classList.contains('is-closing')) return;
  modalEl.classList.add('is-closing');
  const cleanup = () => {
    modalEl.classList.remove('is-closing');
    modalEl.classList.add('hidden');
  };
  modalEl.addEventListener('animationend', cleanup, { once: true });
  setTimeout(() => {
    if (modalEl.classList.contains('is-closing')) cleanup();
  }, 250);
}

// ── Confirm модал ──
let _confirmResolve = null;
function showConfirm(title, message, okText, options = {}) {
  // `danger: true` keeps the red destructive button (deletions); the default
  // is a neutral primary button for non-destructive confirmations.
  const danger = Boolean(options.danger);
  // Resolve any pending confirm as false to prevent promise leaks
  if (_confirmResolve) {
    _confirmResolve(false);
    _confirmResolve = null;
  }
  return new Promise(function (resolve) {
    _confirmResolve = resolve;
    if (els.confirmTitle) els.confirmTitle.textContent = title || 'Подтверждение';
    if (els.confirmMessage) els.confirmMessage.textContent = message || '';
    if (els.confirmOk) {
      els.confirmOk.textContent = okText || 'OK';
      els.confirmOk.classList.toggle('btn-danger', danger);
      els.confirmOk.classList.toggle('btn-primary', !danger);
    }
    if (els.confirmModal) {
      els.confirmModal.classList.remove('hidden');
      els.confirmModal.setAttribute('role', 'dialog');
      els.confirmModal.setAttribute('aria-modal', 'true');
      setTimeout(() => els.confirmOk?.focus(), 50);
    }
  });
}

function closeConfirm(result) {
  closeModalAnimated(els.confirmModal);
  if (_confirmResolve) {
    _confirmResolve(Boolean(result));
    _confirmResolve = null;
  }
}

function trimMapSize(map, limit) {
  if (!(map instanceof Map) || !Number.isFinite(limit) || limit <= 0) return;
  while (map.size > limit) {
    const oldestKey = map.keys().next();
    if (oldestKey.done) break;
    map.delete(oldestKey.value);
  }
}

function setButtonBusy(button, busy, options = {}) {
  if (!button) return;
  const { text = '', title = '' } = options;
  if (!button.dataset.idleText) {
    button.dataset.idleText = button.textContent || '';
  }
  if (!button.dataset.idleTitle) {
    button.dataset.idleTitle = button.title || '';
  }
  button.disabled = Boolean(busy);
  button.classList.toggle('is-busy', Boolean(busy));
  if (text && !button.querySelector('svg')) {
    button.textContent = busy ? text : button.dataset.idleText;
  }
  if (title) {
    button.title = busy ? title : button.dataset.idleTitle;
  }
}

async function runWithBusyButton(button, task, options = {}) {
  if (button?.disabled) return null;
  setButtonBusy(button, true, options);
  try {
    return await task();
  } finally {
    setButtonBusy(button, false, options);
  }
}

function escapeHtml(text) {
  return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

function formatDateTime(iso) {
  const dt = new Date(iso || '');
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleString('ru-RU');
}

function toLocalDateTimeInput(iso) {
  const dt = new Date(iso || '');
  if (Number.isNaN(dt.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}T${p(dt.getHours())}:${p(dt.getMinutes())}:${p(dt.getSeconds())}`;
}

function nextSendAtLocal(minutes = 5) {
  const dt = new Date(Date.now() + minutes * 60 * 1000);
  dt.setMilliseconds(0);
  return toLocalDateTimeInput(dt.toISOString());
}

/* Escape arbitrary text for interpolation inside a single-quoted JS string
   passed to executeJavaScript. Besides backslash/quote/newline, CR and the
   U+2028/U+2029 line separators must be escaped — a raw one inside a string
   literal is a SyntaxError, which silently killed translation callbacks. */
function escapeForJsSingleQuoted(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* Template variables — {имя}, {приветствие}, {дата}, {время} (case-insensitive).
   {имя} resolves to the chat/contact name; when the name is unknown the token
   is left as-is so the operator notices instead of sending a broken greeting. */
const TEMPLATE_VAR_RE = /\{(имя|приветствие|дата|время)\}/i;

function templateGreeting(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'Доброе утро';
  if (h >= 12 && h < 18) return 'Добрый день';
  if (h >= 18 && h < 23) return 'Добрый вечер';
  return 'Доброй ночи';
}

/* Чистое имя для {имя}: контакты названы с кодами («Jan NL55», «Gerhard AT75»),
 * а в сообщении нужен только «Jan». Срезаем хвостовой токен «буквы+цифры»;
 * если после среза пусто — оставляем как было. */
function cleanContactName(name) {
  const n = String(name || '').trim();
  const stripped = n.replace(/\s+[A-Za-zА-Яа-яЁё]{0,4}\d{1,4}$/u, '').trim();
  return stripped || n;
}

function applyTemplateVariables(text, chatName) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  let out = String(text || '');
  if (!TEMPLATE_VAR_RE.test(out)) return out;
  out = out.replace(/\{приветствие\}/gi, templateGreeting(now));
  out = out.replace(/\{дата\}/gi, `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`);
  out = out.replace(/\{время\}/gi, `${pad(now.getHours())}:${pad(now.getMinutes())}`);
  const name = cleanContactName(chatName);
  if (name) out = out.replace(/\{имя\}/gi, name);
  return out;
}

export {
  platformPasteModifier,
  bindPasswordToggle,
  resetPasswordFieldVisibility,
  setStatusZone,
  setStatus,
  showToast,
  closeModalAnimated,
  showConfirm,
  closeConfirm,
  trimMapSize,
  setButtonBusy,
  runWithBusyButton,
  escapeHtml,
  formatDateTime,
  toLocalDateTimeInput,
  nextSendAtLocal,
  escapeForJsSingleQuoted,
  delay,
  TEMPLATE_VAR_RE,
  templateGreeting,
  applyTemplateVariables,
};

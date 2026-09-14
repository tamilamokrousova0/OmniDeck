/* Hub dashboard: greeting, clocks, filters, account cards, hub actions and
   the toolbar clock tooltip. Extracted verbatim from renderer.js. */
import { state, els, LITE } from './state.js';
import { brandIconSvg } from './brand-icons.js';
import { setActiveAccount, addAccount } from './accounts.js';
import { openSettingsPanel, closeSettingsPanel } from './settings.js';

function setHubVisibility(visible) {
  if (!els.webviews || !els.hubScreen) return;
  els.webviews.classList.toggle('hub-mode', Boolean(visible));
  els.hubScreen.classList.toggle('hidden', !visible);
  els.hubScreen.setAttribute('aria-hidden', visible ? 'false' : 'true');
  if (visible) updateHubDashboard();
}

function playBrandClickAnimation() {
  if (!els.brandHub) return;
  els.brandHub.classList.remove('is-clicked');
  void els.brandHub.offsetWidth;
  els.brandHub.classList.add('is-clicked');
  setTimeout(() => els.brandHub?.classList.remove('is-clicked'), 750);
}

// ── Toolbar Clock tooltip ──
// We build a fresh tooltip element in document.body from scratch because
// Electron's <webview> paints on a compositor layer above normal DOM,
// so a popover nested in the toolbar gets hidden by the chat view.
// The tooltip uses fully inline styles so no cascading rule can widen it.
(function setupClockTooltip() {
  const clock = document.getElementById('toolbar-clock');
  if (!clock) return;

  const tooltip = document.createElement('div');
  tooltip.id = 'clock-tooltip';
  tooltip.style.cssText = [
    'position:fixed',
    'top:-1000px', 'left:-1000px',          // offscreen until first show
    'z-index:99999',
    'opacity:0',
    'pointer-events:none',
    'transition:opacity 0.15s ease',
    'display:flex',
    'flex-direction:column',
    'gap:6px',
    'min-width:180px',
    'max-width:260px',
    'width:max-content',                    // shrink to content
    'padding:10px 14px',
    'background:var(--bg-1, #1a2030)',
    'border:1px solid var(--stroke, rgba(255,255,255,0.15))',
    'border-radius:12px',
    'box-shadow:0 16px 40px -12px rgba(0,0,0,0.6)',
  ].join(';');
  document.body.appendChild(tooltip);

  const DEFAULT_ZONES = [
    { label: 'Москва', tz: 'Europe/Moscow' },
    { label: 'Киев',   tz: 'Europe/Kiev' },
    { label: 'Берлин', tz: 'Europe/Berlin' },
  ];

  function renderZones() {
    const zones = (state.settings && Array.isArray(state.settings.worldClocks) && state.settings.worldClocks.length)
      ? state.settings.worldClocks
      : DEFAULT_ZONES;
    const now = new Date();
    const parts = [
      '<div style="font-size:10px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-4,#6d7d90);margin-bottom:2px">Часовые пояса</div>',
    ];
    for (const z of zones) {
      let time = '--:--';
      try {
        time = new Intl.DateTimeFormat('ru', {
          hour: '2-digit', minute: '2-digit', timeZone: z.tz, hour12: false,
        }).format(now);
      } catch { /* invalid tz */ }
      const label = String(z.label || '').replace(/[<>]/g, '');
      parts.push(
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:20px;font-size:12px;white-space:nowrap">' +
          '<span style="color:var(--text-2,#b0bac8)">' + label + '</span>' +
          '<span style="font-family:var(--mono,ui-monospace,SF Mono,Menlo,monospace);color:var(--text-strong,#e5eaf0);font-weight:600;font-variant-numeric:tabular-nums">' + time + '</span>' +
        '</div>'
      );
    }
    tooltip.innerHTML = parts.join('');
  }

  function reposition() {
    const rect = clock.getBoundingClientRect();
    const ttWidth = tooltip.offsetWidth || 200;
    let left = Math.round(rect.right - ttWidth);
    if (left + ttWidth > window.innerWidth - 8) left = window.innerWidth - ttWidth - 8;
    if (left < 8) left = 8;
    tooltip.style.top = Math.round(rect.bottom + 6) + 'px';
    tooltip.style.left = left + 'px';
  }

  let hideTimer = null;
  const show = () => {
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    renderZones();
    // Measure after content is in place
    reposition();
    tooltip.style.opacity = '1';
    tooltip.style.pointerEvents = 'auto';
    // One more pass after paint in case fonts changed the width
    requestAnimationFrame(reposition);
  };
  const hide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      tooltip.style.opacity = '0';
      tooltip.style.pointerEvents = 'none';
    }, 120);
  };
  clock.addEventListener('mouseenter', show);
  clock.addEventListener('mouseleave', hide);
  tooltip.addEventListener('mouseenter', () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } });
  tooltip.addEventListener('mouseleave', hide);
  window.addEventListener('resize', () => {
    if (tooltip.style.opacity === '1') reposition();
  }, { passive: true });
})();

function updateToolbarClock() {
  if (!els.toolbarClockTime) return;
  const now = new Date();
  els.toolbarClockTime.textContent = new Intl.DateTimeFormat('ru', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
}

// ── Hub Dashboard ──
function updateHubClocks() {
  const container = document.getElementById('hub-clocks');
  if (!container) return;
  const zones = (state.settings && state.settings.worldClocks) || [
    { label: 'Москва', tz: 'Europe/Moscow' },
    { label: 'Киев', tz: 'Europe/Kiev' },
    { label: 'Берлин', tz: 'Europe/Berlin' },
  ];
  const now = new Date();
  // Reuse existing DOM nodes when zone count matches — avoids reflow every 30s.
  // Only rebuild from scratch if the structure itself changed (zones added/removed).
  const existing = container.children;
  if (existing.length !== zones.length) {
    container.textContent = '';
    for (const zone of zones) {
      const el = document.createElement('div');
      el.className = 'hub-clock-item';
      const timeSpan = document.createElement('span');
      timeSpan.className = 'hub-clock-time';
      const labelSpan = document.createElement('span');
      labelSpan.className = 'hub-clock-label';
      el.append(timeSpan, labelSpan);
      container.appendChild(el);
    }
  }
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    const el = container.children[i];
    if (!el) continue;
    let time = '--:--';
    try {
      time = new Intl.DateTimeFormat('ru', {
        hour: '2-digit', minute: '2-digit',
        timeZone: zone.tz, hour12: false,
      }).format(now);
    } catch { /* invalid tz */ }
    const timeSpan = el.querySelector('.hub-clock-time');
    const labelSpan = el.querySelector('.hub-clock-label');
    if (timeSpan && timeSpan.textContent !== time) timeSpan.textContent = time;
    if (labelSpan && labelSpan.textContent !== zone.label) labelSpan.textContent = zone.label;
  }
}

function updateHubGreeting() {
  const el = document.getElementById('hub-greeting');
  if (!el) return;
  const now = new Date();
  const h = now.getHours();
  let word = 'Добрый день';
  let icon = '☀';
  if (h < 6) { word = 'Доброй ночи'; icon = '☾'; }
  else if (h < 12) { word = 'Доброе утро'; icon = '☀'; }
  else if (h < 18) { word = 'Добрый день'; icon = '☀'; }
  else { word = 'Добрый вечер'; icon = '☾'; }
  const dateStr = new Intl.DateTimeFormat('ru', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  el.innerHTML = '';
  const iconSpan = document.createElement('span');
  iconSpan.className = 'hub-greeting-icon';
  iconSpan.textContent = icon;
  const textSpan = document.createElement('span');
  textSpan.className = 'hub-greeting-text';
  textSpan.textContent = word;
  const dateSpan = document.createElement('span');
  dateSpan.className = 'hub-greeting-date';
  dateSpan.textContent = '· ' + dateStr;
  el.append(iconSpan, textSpan, dateSpan);

  const titleEl = document.getElementById('hub-title');
  if (titleEl) {
    titleEl.textContent = LITE ? 'OmniDeck Lite' : 'OmniDeck';
    titleEl.classList.remove('hub-title--motivation');
  }
}

/* Синк active-состояния четырёх вкладок сегмент-контрола (index.html
   #hub-tabs). Аккаунты — карточки; Непрочитанные/Избранные/Важные — лента
   непрочитанных в режимах all/fav/imp (unread-feed.js владеет state.hubTab). */
function updateHubFilters() {
  const tab = state.hubTab || 'accounts';
  const setA = (id, on) => document.getElementById(id)?.classList.toggle('active', on);
  setA('hub-tab-accounts', tab === 'accounts');
  setA('hub-tab-unread', tab === 'all');
  setA('hub-tab-favorites', tab === 'fav');
  setA('hub-tab-important', tab === 'imp');
}

/* Вкладка «Аккаунты» показывает все аккаунты; фильтры непрочитанных/
   избранных/важных теперь живут в ленте (unread-feed), не в списке карточек. */
/* Вкладки «Непрочитанные/Избранные/Важные» в лайте скрыты, но state общий с
   обычной декой: если там был выбран такой фильтр, лайт открылся бы на
   невидимой вкладке с пустым списком. */
function normalizeHubFilterForLite() {
  if (LITE && ['unread', 'favorites', 'important'].includes(state.hubFilter)) {
    state.hubFilter = 'all';
  }
}

function filteredHubAccounts() {
  normalizeHubFilterForLite();
  const all = state.accounts || [];
  // Профиль общий с обычной декой, но клиента Signal в лайте нет.
  return LITE ? all.filter((a) => a.type !== 'signal') : all;
}

async function updateHubDashboard() {
  const hubScreen = document.getElementById('hub-screen');
  if (hubScreen && hubScreen.classList.contains('hidden')) return;
  updateHubClocks();
  updateHubGreeting();

  updateHubFilters();

  const countEl = document.getElementById('hub-accts-count');
  // Считаем по тому же списку, что и рисуем: иначе в лайте счётчик показывал 7
  // при пяти карточках (два Signal-аккаунта скрыты).
  const shownCount = filteredHubAccounts().length;
  if (countEl) countEl.textContent = shownCount ? String(shownCount) : '';

  const container = document.getElementById('hub-dashboard');
  if (!container) return;
  container.innerHTML = '';

  const accounts = filteredHubAccounts();
  if (!accounts.length) {
    const empty = document.createElement('div');
    empty.className = 'hub-empty';
    empty.textContent = state.accounts.length
      ? 'Ничего не найдено по текущему фильтру'
      : 'Пока нет аккаунтов — добавьте WhatsApp или Telegram';
    container.appendChild(empty);
  }

  const buildHubAccountCard = (account, { isPinned } = {}) => {
    const card = document.createElement('div');
    card.className = 'hub-acct-card' + (isPinned ? ' hub-acct-card--pinned' : '');
    card.style.setProperty('--card-c', account.color || 'var(--accent-blue)');
    // Заморозка — на самой карточке: в лайте строка компактная и показывает
    // её снежинкой у имени, без тега в третьем ряду.
    if (account.frozen) card.classList.add('is-frozen');
    card.addEventListener('click', () => setActiveAccount(account.id));

    const bar = document.createElement('span');
    bar.className = 'hub-acct-bar';

    const avWrap = document.createElement('div');
    avWrap.className = 'hub-acct-av';
    avWrap.style.background = account.color || 'var(--bg-3)';
    avWrap.style.setProperty('--tile', account.color || '#8a93a6');
    const labelText = (account.name || '').split(' ')[0].slice(0, 2).toUpperCase() || (account.type === 'telegram' ? 'TG' : (account.type === 'signal' ? 'SG' : 'WA'));
    avWrap.textContent = labelText;
    /* В лайте плитка несёт глиф бренда вместо инициалов: на 24px две буквы
       нечитаемы, а тип иначе виден только тегом, который мы убрали. */
    if (LITE) {
      avWrap.innerHTML = brandIconSvg(account.type === 'telegram' ? 'telegram' : 'whatsapp', { size: 13, color: '#fff' });
    }
    if (account.frozen) {
      const status = document.createElement('span');
      status.className = 'hub-acct-status frozen';
      avWrap.appendChild(status);
    }

    const info = document.createElement('div');
    info.className = 'hub-acct-info';

    const row1 = document.createElement('div');
    row1.className = 'hub-acct-row1';
    const nameEl = document.createElement('span');
    nameEl.className = 'hub-acct-name';
    nameEl.textContent = account.name;
    row1.appendChild(nameEl);
    const unread = Number(state.unreadByAccount.get(account.id) || 0);
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'hub-acct-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      row1.appendChild(badge);
    }

    const preview = document.createElement('div');
    preview.className = 'hub-acct-preview';
    preview.textContent = account.frozen ? '❄ заморожен' : '';

    const row3 = document.createElement('div');
    row3.className = 'hub-acct-row3';
    const typeTag = document.createElement('span');
    typeTag.className = 'hub-acct-tag hub-acct-tag-' + (account.type === 'telegram' ? 'blue' : (account.type === 'signal' ? 'violet' : 'accent'));
    typeTag.textContent = account.type === 'telegram' ? 'Telegram' : (account.type === 'signal' ? 'Signal' : 'WhatsApp');
    row3.appendChild(typeTag);
    if (account.frozen) {
      const t = document.createElement('span');
      t.className = 'hub-acct-tag hub-acct-tag-warn';
      t.textContent = 'Заморожен';
      row3.appendChild(t);
    }

    if (isPinned) {
      const pin = document.createElement('span');
      pin.className = 'hub-acct-pin-star';
      pin.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
      pin.title = 'Закреплён';
      card.appendChild(pin);
    }

    info.append(row1, preview, row3);
    card.append(bar, avWrap, info);
    return card;
  };

  const pinnedAccounts = accounts.filter((a) => a.pinned);
  const pinnedIds = new Set(pinnedAccounts.map((a) => a.id));
  const restAccounts = accounts.filter((a) => !pinnedIds.has(a.id));

  if (pinnedAccounts.length) {
    const pinnedRow = document.createElement('div');
    pinnedRow.className = 'hub-pinned-row';
    for (const account of pinnedAccounts) {
      pinnedRow.appendChild(buildHubAccountCard(account, { isPinned: true }));
    }
    container.appendChild(pinnedRow);
  }

  for (const account of restAccounts) {
    container.appendChild(buildHubAccountCard(account, { isPinned: false }));
  }

  // Кнопки — отрисовываем в отдельный ряд под сеткой аккаунтов, чтобы
  // они не попадали в тот же grid и не растягивали последнюю карточку.
  const actionsHost = document.getElementById('hub-actions-row') || container;
  actionsHost.innerHTML = '';
  const actions = document.createElement('div');
  actions.className = 'hub-actions';

  const addWaBtn = document.createElement('button');
  addWaBtn.className = 'btn hub-action-btn hub-action-wa hub-action-primary';
  addWaBtn.type = 'button';
  addWaBtn.title = 'Добавить WhatsApp-аккаунт';
  addWaBtn.setAttribute('aria-label', 'Добавить WhatsApp-аккаунт');
  addWaBtn.innerHTML = brandIconSvg('whatsapp', { size: 13, color: 'currentColor' }) + ' Добавить WhatsApp';
  addWaBtn.addEventListener('click', () => addAccount('whatsapp'));

  const addTgBtn = document.createElement('button');
  addTgBtn.className = 'btn btn-ghost hub-action-btn hub-action-tg';
  addTgBtn.type = 'button';
  addTgBtn.title = 'Добавить Telegram-аккаунт';
  addTgBtn.setAttribute('aria-label', 'Добавить Telegram-аккаунт');
  addTgBtn.innerHTML = brandIconSvg('telegram', { size: 13, color: '#2AABEE' }) + ' Добавить Telegram';
  addTgBtn.addEventListener('click', () => addAccount('telegram'));

  const addSgBtn = document.createElement('button');
  addSgBtn.className = 'btn btn-ghost hub-action-btn hub-action-sig';
  addSgBtn.type = 'button';
  addSgBtn.title = 'Добавить Signal-аккаунт (уведомления через signal-cli)';
  addSgBtn.setAttribute('aria-label', 'Добавить Signal-аккаунт');
  addSgBtn.innerHTML = brandIconSvg('signal', { size: 13, color: '#3A76F0' }) + ' Добавить Signal';
  addSgBtn.addEventListener('click', () => addAccount('signal'));

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'btn btn-ghost hub-action-btn hub-action-settings';
  settingsBtn.title = 'Настройки';
  settingsBtn.setAttribute('aria-label', 'Настройки');
  settingsBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';
  settingsBtn.addEventListener('click', () => { if (state.panelHidden) openSettingsPanel(); else closeSettingsPanel(); });

  if (LITE) actions.append(addWaBtn, addTgBtn, settingsBtn);
  else actions.append(addWaBtn, addTgBtn, addSgBtn, settingsBtn);
  actionsHost.appendChild(actions);

}

function openHubMode() {
  state.startupHubVisible = false;
  setActiveAccount('');
}

export {
  setHubVisibility,
  playBrandClickAnimation,
  updateToolbarClock,
  updateHubClocks,
  updateHubGreeting,
  updateHubFilters,
  filteredHubAccounts,
  updateHubDashboard,
  openHubMode,
};

/* Accounts: sidebar rendering, active-account switching, add/remove,
   drag reorder, context menus and refresh actions.
   Extracted verbatim from renderer.js. */
import { state, els , LITE } from './state.js';
import { setStatus, showConfirm, setToolbarLabel } from './helpers.js';
import {
  ensureWebview,
  cleanupWebview,
  refreshWebviewVisibility,
  syncZoomSlider,
  markAccountHibernated,
  isWebviewReady,
  safeExecuteInWebview,
} from './webviews.js';
import { updateHubDashboard } from './hub.js';
import {
  openAccountMenu,
  closeAccountMenu,
  setAccountFrozenState,
  setAccountPinnedState,
} from './account-menu.js';
import { WaDeckUnreadModule } from '../unread.js';
import { brandIconSvg } from './brand-icons.js';
import { WaDeckScheduleModule } from '../schedule.js';

function activeAccount() {
  return state.accounts.find((acc) => acc.id === state.activeAccountId) || null;
}

function updateActiveAccountDisplay() {
  if (!els.activeAccountDisplay) return;
  const account = activeAccount();
  if (!account) {
    els.activeAccountDisplay.textContent = 'Нет активного аккаунта';
    els.activeAccountDisplay.title = 'Нет активного аккаунта';
    els.activeAccountDisplay.classList.add('is-empty');
    return;
  }
  const suffix = account.frozen ? ' • заморожен' : '';
  els.activeAccountDisplay.textContent = `${account.name}${suffix}`;
  els.activeAccountDisplay.title = account.name;
  els.activeAccountDisplay.classList.remove('is-empty');
}

function updateToolbarState() {
  const account = activeAccount();
  const hasActive = Boolean(account);
  const isWa = hasActive && account.type === 'whatsapp';
  // Кнопка обновления активна и в хабе (нет активного аккаунта) — там она
  // обновляет ВСЕ аккаунты; дизейблим только когда аккаунтов нет вовсе.
  if (els.refreshActive) els.refreshActive.disabled = !(state.accounts && state.accounts.length);
  // Заморозка работает для обоих типов (механика — снос webview, типонезависима)
  if (els.freezeActive) { els.freezeActive.disabled = !hasActive; els.freezeActive.style.display = ''; }
  if (els.openCrmModal) { els.openCrmModal.disabled = !isWa; els.openCrmModal.style.display = isWa || !hasActive ? '' : 'none'; }
  if (els.sendVoiceMsg) { els.sendVoiceMsg.disabled = !isWa; els.sendVoiceMsg.style.display = isWa || !hasActive ? '' : 'none'; }
}

function updateFreezeButtonState() {
  const account = activeAccount();
  if (!els.freezeActive) return;
  const frozen = Boolean(account?.frozen);
  els.freezeActive.classList.toggle('is-active', frozen);
  setToolbarLabel(els.freezeActive, frozen
    ? 'Разморозить активный аккаунт'
    : 'Заморозить/разморозить активный аккаунт');
}

function selectedWebview() {
  if (!state.activeAccountId) return null;
  return state.webviews.get(state.activeAccountId) || null;
}

function accountById(accountId) {
  return state.accounts.find((account) => account.id === String(accountId || '')) || null;
}

function patchLocalAccount(updated) {
  if (!updated || !updated.id) return;
  state.accounts = state.accounts.map((account) => {
    if (account.id !== updated.id) return account;
    return {
      ...account,
      ...updated,
    };
  });
  state.accounts.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

function replaceAccounts(nextAccounts) {
  state.accounts = Array.isArray(nextAccounts) ? nextAccounts.map((row) => ({ ...row })) : [];
  state.accounts.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
}

async function reorderAccountsByDrag(sourceAccountId, targetAccountId) {
  const sourceId = String(sourceAccountId || '').trim();
  const targetId = String(targetAccountId || '').trim();
  if (!sourceId || !targetId || sourceId === targetId) return;

  const fromIndex = state.accounts.findIndex((row) => row.id === sourceId);
  const toIndex = state.accounts.findIndex((row) => row.id === targetId);
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

  const direction = fromIndex < toIndex ? 'down' : 'up';
  const steps = Math.abs(fromIndex - toIndex);
  let lastResponse = null;
  for (let i = 0; i < steps; i += 1) {
    // backend умеет только сдвиг на 1 позицию, поэтому двигаем пошагово
    // один и тот же accountId в нужном направлении.
    lastResponse = await window.waDeck.moveAccount({ accountId: sourceId, direction });
    if (!lastResponse?.ok) {
      setStatus(`Не удалось изменить порядок: ${lastResponse?.error || 'error'}`);
      return;
    }
  }

  if (Array.isArray(lastResponse?.accounts)) {
    replaceAccounts(lastResponse.accounts);
    renderAccounts();
    setStatus('Порядок WhatsApp обновлён');
  }
}

/** Lightweight: only toggle .active class without rebuilding DOM */
function updateAccountActiveHighlight() {
  const cards = els.accountsList.querySelectorAll('.account-item');
  for (const card of cards) {
    card.classList.toggle('active', card.dataset.accountId === state.activeAccountId);
  }
}

/** Update status dot + tooltip for a single account card (no full rebuild) */
function updateAccountCardStatus(accountId) {
  const card = els.accountsList.querySelector(`.account-item[data-account-id="${accountId}"]`);
  if (!card) return;
  const account = accountById(accountId);
  if (!account) return;

  // Status dot: only rendered for frozen accounts now.
  // Add/remove the dot dynamically as the frozen flag toggles.
  const existingDot = card.querySelector('.account-status-dot');
  if (account.frozen) {
    if (existingDot) {
      existingDot.className = 'account-status-dot status-frozen';
      existingDot.title = 'Заморожен';
    } else {
      const statusDot = document.createElement('div');
      statusDot.className = 'account-status-dot status-frozen';
      statusDot.title = 'Заморожен';
      card.appendChild(statusDot);
    }
  } else if (existingDot) {
    existingDot.remove();
  }

  // Update tooltip
  const tooltip = card.querySelector('.account-tooltip');
  if (tooltip) {
    let tooltipStatus = '';
    if (account.frozen) { tooltipStatus = 'Заморожен ❄'; }
    else if (account.type === 'signal') { tooltipStatus = 'Приём через signal-cli'; }
    else {
      const wv = state.webviews.get(account.id);
      if (!wv) tooltipStatus = 'Не подключён';
      else if (wv.dataset?.waReady === '1') tooltipStatus = 'Подключён';
      else tooltipStatus = 'Загрузка…';
    }
    const typeLabel = account.type === 'telegram' ? 'Telegram' : (account.type === 'signal' ? 'Signal' : 'WhatsApp');
    tooltip.textContent = account.name + ' — ' + typeLabel + ' — ' + tooltipStatus;
  }
}

function renderAccounts() {
  const fragment = document.createDocumentFragment();

  /* Профиль общий с обычной декой, поэтому в сторе могут лежать Signal-аккаунты.
     В лайте клиента Signal нет — не показываем их вовсе, но и не трогаем:
     вернёшься в обычную сборку, они на месте. */
  const visible = LITE ? state.accounts.filter((a) => a.type !== 'signal') : state.accounts;

  for (const account of visible) {
    const card = document.createElement('div');
    const hibernatedCls = (state._hibernated && state._hibernated.has(account.id)) ? 'is-hibernated' : '';
    card.className = `account-item ${state.activeAccountId === account.id ? 'active' : ''} ${account.frozen ? 'frozen' : ''} ${hibernatedCls}`.trim();
    card.dataset.accountId = account.id;
    // tooltip вместо title (добавляется ниже)
    card.draggable = state.accounts.length > 1;
    card.addEventListener('click', () => setActiveAccount(account.id));
    card.addEventListener('dragstart', (event) => {
      state.draggedAccountId = account.id;
      try {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', account.id);
      } catch {
        // ignore dataTransfer limitations
      }
      card.classList.add('dragging');
    });
    card.addEventListener('dragover', (event) => {
      if (!state.draggedAccountId || state.draggedAccountId === account.id) return;
      event.preventDefault();
      try {
        event.dataTransfer.dropEffect = 'move';
      } catch {
        // ignore
      }
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => {
      card.classList.remove('drag-over');
    });
    card.addEventListener('drop', (event) => {
      event.preventDefault();
      const draggedId = String(state.draggedAccountId || '').trim();
      card.classList.remove('drag-over');
      if (!draggedId || draggedId === account.id) return;
      reorderAccountsByDrag(draggedId, account.id).catch(console.error);
    });
    card.addEventListener('dragend', () => {
      state.draggedAccountId = '';
      card.classList.remove('dragging');
      for (const node of els.accountsList.querySelectorAll('.account-item.drag-over')) {
        node.classList.remove('drag-over');
      }
    });

    // Lovable-style: whole card is colored, icon/initials inside.
    // --tile carries the raw user color so the opt-in "calm tiles" CSS
    // (html[data-tile-normalize]) can re-blend it without losing the hue.
    /* В лайте сайдбар — список строк с именами (mockups/lite-compact-accounts.html):
       цвет и иконка живут в свотче слева, а не заливают всю строку. */
    const swatch = LITE ? document.createElement('span') : null;
    if (swatch) swatch.className = 'account-swatch';
    const painted = swatch || card;
    painted.style.background = account.color;
    card.style.setProperty('--tile', account.color || '#8a93a6');
    if (account.iconUrl) {
      painted.style.backgroundImage = `url(${account.iconUrl})`;
      painted.style.backgroundSize = 'cover';
      painted.style.backgroundPosition = 'center';
    }

    const label = document.createElement('span');
    label.className = 'account-label';
    label.textContent = account.name.slice(0, 2).toUpperCase();
    if (account.iconUrl) label.style.opacity = '0'; // hide text when icon set

    // Имя целиком — в лайте оно заменяет двухбуквенные инициалы.
    const nameEl = LITE ? document.createElement('span') : null;
    if (nameEl) {
      nameEl.className = 'account-name';
      nameEl.textContent = account.name;
    }

    card.addEventListener('dblclick', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openAccountMenu(account.id);
    });

    const unread = Number(state.unreadByAccount.get(account.id) || 0);
    if (unread > 0) {
      const badge = document.createElement('div');
      badge.className = 'account-unread';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      card.appendChild(badge);
    }

    if (account.frozen) {
      const frozenTag = document.createElement('div');
      frozenTag.className = 'account-frozen-tag';
      frozenTag.title = 'Аккаунт заморожен';
      frozenTag.textContent = '❄';
      card.appendChild(frozenTag);
    }

    if (account.pinned) {
      const pinTag = document.createElement('div');
      pinTag.className = 'account-pin-tag';
      pinTag.title = 'Закреплён в хабе';
      pinTag.innerHTML = '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
      card.appendChild(pinTag);
    }

    // Account type badge (WhatsApp / Telegram)
    const typeBadge = document.createElement('div');
    typeBadge.className = 'account-type-badge';
    if (account.type === 'signal') {
      typeBadge.classList.add('account-type-sig');
      typeBadge.title = 'Signal';
      typeBadge.innerHTML = brandIconSvg('signal', { color: '#fff' });
    } else if (account.type === 'telegram') {
      typeBadge.classList.add('account-type-tg');
      typeBadge.title = 'Telegram';
      typeBadge.innerHTML = brandIconSvg('telegram', { color: '#fff' });
    } else {
      typeBadge.classList.add('account-type-wa');
      typeBadge.title = 'WhatsApp';
      typeBadge.innerHTML = brandIconSvg('whatsapp', { color: '#fff' });
    }
    card.appendChild(typeBadge);

    // Only show a status dot for frozen accounts (user-controlled, reliable).
    // Online/offline/loading dots were removed — they frequently lied because
    // WhatsApp Web's "ready" signal doesn't always match the actual logged-in
    // state the user perceives.
    if (account.frozen) {
      const statusDot = document.createElement('div');
      statusDot.className = 'account-status-dot status-frozen';
      statusDot.title = 'Заморожен';
      card.appendChild(statusDot);
    }

    // Кастомный tooltip
    const tooltip = document.createElement('div');
    tooltip.className = 'account-tooltip';
    let tooltipStatus = '';
    if (account.frozen) {
      tooltipStatus = 'Заморожен ❄';
    } else if (account.type === 'signal') {
      tooltipStatus = 'Приём через signal-cli';
    } else {
      const wv = state.webviews.get(account.id);
      if (!wv) tooltipStatus = 'Не подключён';
      else if (wv.dataset?.waReady === '1') tooltipStatus = 'Подключён';
      else tooltipStatus = 'Загрузка…';
    }
    const typeLabel = account.type === 'telegram' ? 'Telegram' : (account.type === 'signal' ? 'Signal' : 'WhatsApp');
    tooltip.textContent = account.name + ' — ' + typeLabel + ' — ' + tooltipStatus;
    card.appendChild(tooltip);

    // Контекстное меню (правый клик)
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showAccountContextMenu(e, account);
    });

    if (swatch) card.append(swatch, nameEl);
    else card.append(label);
    fragment.appendChild(card);
  }

  els.accountsList.innerHTML = '';
  els.accountsList.appendChild(fragment);
  updateActiveAccountDisplay();
  updateSidebarScrollControls();
  // Repaint the favorites toolbar strip (account colors/names may have changed).
  if (window.WaDeckFavoritesModule) window.WaDeckFavoritesModule.renderFavStrip();
  if (window.WaDeckImportantModule) window.WaDeckImportantModule.renderImpStrip();
}

function updateSidebarScrollControls() {
  if (!els.accountsList || !els.accountsScrollUp || !els.accountsScrollDown) return;
  const pane = els.accountsList;
  const hasOverflow = pane.scrollHeight > pane.clientHeight + 4;
  const atTop = pane.scrollTop <= 4;
  const atBottom = pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 4;

  els.accountsScrollUp.classList.toggle('hidden', !hasOverflow || atTop);
  els.accountsScrollDown.classList.toggle('hidden', !hasOverflow || atBottom);
}

function scrollAccountsList(direction) {
  if (!els.accountsList) return;
  const step = Math.max(120, Math.floor(els.accountsList.clientHeight * 0.52));
  els.accountsList.scrollBy({
    top: direction === 'down' ? step : -step,
    behavior: 'smooth',
  });
  window.setTimeout(updateSidebarScrollControls, 220);
}

// ── Контекстное меню аккаунта ──
// Leading 14×14 SVG icons — subtle, same stroke as text, match the app's
// existing lucide-style iconography.
const CM_ICON = {
  refresh: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
  // Pin (not star): the star glyph is reserved for favourites/important.
  pin: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
  pinFilled: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>',
  snowflake: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20M6.2 6.2l11.6 11.6M17.8 6.2L6.2 17.8M2 12h20M5 9l3 3-3 3M19 9l-3 3 3 3M9 5l3 3 3-3M9 19l3-3 3 3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
};

function showAccountContextMenu(event, accountOrId) {
  closeAccountContextMenu();
  // Always resolve the FRESH account from state. patchLocalAccount replaces
  // the account object on every mutation, so the closure-captured `account`
  // here could be stale (e.g. after pin/unpin, frozen toggle). Re-fetching by
  // id guarantees the menu reflects current state — this was the root cause
  // of "Закрепить works, Открепить doesn't" reported in 0.7.4 testing.
  const id = typeof accountOrId === 'string' ? accountOrId : accountOrId?.id;
  const account = accountById(String(id || ''));
  if (!account) return;

  const menu = document.createElement('div');
  menu.className = 'context-menu context-menu--account';
  menu.id = 'account-context-menu';

  const items = [
    { label: 'Обновить', icon: CM_ICON.refresh, action: () => { setActiveAccount(account.id); requestAnimationFrame(() => refreshActiveWebview()); } },
    {
      label: account.pinned ? 'Открепить' : 'Закрепить',
      icon: account.pinned ? CM_ICON.pinFilled : CM_ICON.pin,
      iconClass: account.pinned ? 'is-on' : '',
      action: () => { setAccountPinnedState(account.id, !account.pinned).catch(console.error); },
    },
    {
      label: account.frozen ? 'Разморозить' : 'Заморозить',
      icon: CM_ICON.snowflake,
      iconClass: account.frozen ? 'is-on' : '',
      action: () => { setAccountFrozenState(account.id, !account.frozen).catch(console.error); },
    },
    { divider: true },
    { label: 'Управление', icon: CM_ICON.settings, action: () => openAccountMenu(account.id) },
    { divider: true },
    { label: 'Удалить', icon: CM_ICON.trash, danger: true, action: () => removeAccount(account.id).catch(console.error) },
  ];

  for (const item of items) {
    if (item.divider) {
      const div = document.createElement('div');
      div.className = 'context-menu-divider';
      menu.appendChild(div);
      continue;
    }
    const el = document.createElement('div');
    el.className = 'context-menu-item'
      + (item.danger ? ' danger' : '')
      + (item.disabled ? ' is-disabled' : '');

    const iconHost = document.createElement('span');
    iconHost.className = 'context-menu-icon' + (item.iconClass ? ' ' + item.iconClass : '');
    iconHost.innerHTML = item.icon || '';
    el.appendChild(iconHost);

    const labelHost = document.createElement('span');
    labelHost.className = 'context-menu-label';
    labelHost.textContent = item.label;
    el.appendChild(labelHost);

    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'context-menu-hint';
      hint.textContent = item.hint;
      el.appendChild(hint);
    }

    if (!item.disabled) {
      el.addEventListener('click', () => {
        closeAccountContextMenu();
        item.action();
      });
    }
    menu.appendChild(el);
  }

  // Позиционирование у курсора
  document.body.appendChild(menu);
  let x = event.clientX;
  let y = event.clientY;
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = Math.max(0, x) + 'px';
  menu.style.top = Math.max(0, y) + 'px';

  // Закрытие
  const closeOnClick = (e) => {
    if (!menu.contains(e.target)) closeAccountContextMenu();
  };
  const closeOnEsc = (e) => {
    // preventDefault so the global Escape handler treats this press as
    // consumed and does not also close the next UI layer underneath.
    if (e.key === 'Escape') { e.preventDefault(); closeAccountContextMenu(); }
  };
  document.addEventListener('click', closeOnClick, { capture: true });
  document.addEventListener('keydown', closeOnEsc);
  menu._cleanup = () => {
    document.removeEventListener('click', closeOnClick, { capture: true });
    document.removeEventListener('keydown', closeOnEsc);
  };
}

function closeAccountContextMenu() {
  const existing = document.getElementById('account-context-menu');
  if (existing) {
    if (existing._cleanup) existing._cleanup();
    existing.remove();
  }
}

let _switchingAccount = false;
function setActiveAccount(accountId) {
  if (_switchingAccount) return;
  _switchingAccount = true;
  try {
    _setActiveAccountInner(accountId);
  } finally {
    _switchingAccount = false;
  }
  // Reading typically happens on the account you switch to — refresh the
  // favorite/important unread badges shortly after so they clear promptly
  // instead of lingering until the next poll.
  window.WaDeckFavoritesModule?.rescanSoon?.(1500);
  window.WaDeckImportantModule?.rescanSoon?.(1500);
}
function _setActiveAccountInner(accountId) {
  const nextId = String(accountId || '').trim();
  state.activeAccountId = nextId;
  // Lazy-create the webview on first activation and bump its last-active
  // timestamp so the idle sweeper knows to keep it alive. If the account was
  // hibernated, ensureWebview() recreates it from the persistent partition
  // (cookies/IndexedDB stay intact, so WhatsApp auto-logs back in) — we just
  // need to clear the hibernation flag so the UI updates.
  if (nextId) {
    const account = state.accounts.find((a) => a.id === nextId);
    if (account && !account.frozen) {
      if (state._hibernated && state._hibernated.has(nextId)) {
        state._hibernated.delete(nextId);
        markAccountHibernated(nextId, false);
      }
      if (!state.webviews.has(nextId)) {
        try { ensureWebview(account); }
        catch (err) { console.error('[setActiveAccount] ensureWebview failed:', err); }
      }
      const wv = state.webviews.get(nextId);
      if (wv) wv._lastActive = Date.now();
    }
  }
  if (nextId && state.startupHubVisible) {
    // Signal-аккаунту грузить нечего (нет webview) — хаб прячем сразу, иначе
    // «выбрал Signal при первом запуске — ничего не показалось»
    const acct = accountById(nextId);
    if (acct?.type === 'signal') {
      state.startupHubVisible = false;
      if (state.startupHubTimeoutId) {
        clearTimeout(state.startupHubTimeoutId);
        state.startupHubTimeoutId = null;
      }
    }
    const webview = state.webviews.get(nextId);
    // webview.isLoading() throws on a freshly-created webview until dom-ready
    // has fired. Treat "not-yet-ready" as "still loading" and only trust a
    // clean false (finished loading) to hide the startup hub.
    let stillLoading = true;
    if (webview) {
      // Без гейта на waReady: упавшая первичная загрузка оставляла хаб
      // «залипшим» — isLoading() честно скажет false и для неё
      try {
        stillLoading = typeof webview.isLoading === 'function' && webview.isLoading();
      } catch { /* not attached yet — treat as loading */ }
    }
    if (!stillLoading) {
      state.startupHubVisible = false;
    }
  }
  updateAccountActiveHighlight();
  updateActiveAccountDisplay();
  updateFreezeButtonState();
  updateToolbarState();
  syncZoomSlider();
  WaDeckUnreadModule.updateActiveUnreadIndicator();
  refreshWebviewVisibility();
  const account = activeAccount();
  if (account) {
    if (account.frozen) {
      setStatus(`Аккаунт: ${account.name} (заморожен)`);
    } else {
      setStatus(`Аккаунт: ${account.name}`);
    }
    if (!state.scheduleTarget.accountId) {
      state.scheduleTarget.accountId = account.id;
      state.scheduleTarget.accountName = account.name;
      WaDeckScheduleModule.renderScheduleTarget();
    }
  } else {
    setStatus('Нет активного аккаунта');
  }
  WaDeckUnreadModule.scheduleDockBadgeSync();
  // Scheduled list is global (not per-account), so it does not need to be
  // re-rendered on every switch. The first activation seeds the toolbar
  // indicator; subsequent updates flow from create/cancel/edit handlers in
  // schedule.js which call renderScheduled() directly when data changes.
  if (!state._scheduledInitialized) {
    state._scheduledInitialized = true;
    WaDeckScheduleModule.renderScheduled().catch(console.error);
  }
  // Автофокус композера: после Cmd+N печатать можно сразу, без клика мышью.
  // Тихий no-op, если чат не открыт или webview ещё не готов (гибернация).
  const activeWv = state.webviews.get(state.activeAccountId);
  if (activeWv && isWebviewReady(activeWv)) {
    try { activeWv.focus(); } catch { /* ignore */ }
    safeExecuteInWebview(activeWv, `(() => {
      const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]')
        || document.querySelector('footer div[contenteditable="true"][data-tab]');
      if (c) c.focus();
    })()`);
  }
}

async function addAccount(type) {
  try {
    const created = await window.waDeck.addAccount(type || 'whatsapp');
    if (!created || typeof created !== 'object' || !created.id) {
      setStatus('Не удалось добавить аккаунт');
      return;
    }
    state.accounts.push(created);
    renderAccounts();
    setActiveAccount(created.id);
    // ensureWebview после setActiveAccount — даём DOM обновиться
    try { ensureWebview(created); } catch { /* webview создастся при переключении */ }
    setStatus(`Добавлен аккаунт: ${created.name}`);
  } catch (error) {
    setStatus(`Не удалось добавить аккаунт: ${String(error?.message || error || 'error')}`);
  }
}

async function removeAccount(accountId) {
  const account = state.accounts.find((row) => row.id === accountId);
  if (!account) return;

  const relogin = account.type === 'telegram'
    ? 'для повторного входа потребуется заново авторизоваться'
    : (account.type === 'signal'
      ? 'привязку устройства нужно будет пройти заново (и удалить старую в Signal на телефоне)'
      : 'для повторного входа потребуется заново сканировать QR-код');
  const accepted = await showConfirm('Удаление аккаунта', `Удалить «${account.name}»?\nСессия будет удалена безвозвратно — ${relogin}.`, 'Удалить', { danger: true });
  if (!accepted) return;

  const response = await window.waDeck.removeAccount(accountId);
  if (!response?.ok) {
    setStatus(`Не удалось удалить аккаунт: ${response?.error || 'error'}`);
    return;
  }

  cleanupWebview(state.webviews.get(accountId));
  state.webviews.delete(accountId);
  if (state.chatPickerCache && state.chatPickerCache.accountId === accountId) {
    state.chatPickerCache = null;
  }
  state.unreadByAccount.delete(accountId);
  state._hibernated?.delete(accountId); // иначе залипший is-hibernated + утечка
  state.zoomByAccount?.delete(accountId);
  WaDeckUnreadModule.scheduleDockBadgeSync();
  // Favorites of the removed account were pruned in main too.
  if (window.WaDeckFavoritesModule) window.WaDeckFavoritesModule.onAccountRemoved(accountId);
  if (window.WaDeckImportantModule) window.WaDeckImportantModule.onAccountRemoved(accountId);

  state.accounts = state.accounts.filter((row) => row.id !== accountId);
  // Кэш глобального поиска живёт в localStorage и переживает удаление:
  // чистим здесь, когда аккаунта уже нет в списке.
  if (window.WaDeckGlobalSearch?.onAccountRemoved) window.WaDeckGlobalSearch.onAccountRemoved();
  if (state.scheduleTarget.accountId === accountId) {
    state.scheduleTarget = { accountId: '', accountName: '', chatName: '' };
    WaDeckScheduleModule.renderScheduleTarget();
  }

  // After deletion, always return to the Hub screen instead of jumping to a
  // neighbouring account — that jump was disorienting (users land on an
  // unrelated workspace). Empty activeAccountId triggers the hub in
  // refreshWebviewVisibility() via the !state.activeAccountId branch.
  setActiveAccount('');
  await WaDeckScheduleModule.renderScheduled();
  // Always re-render the sidebar and hub after a removal so the deleted
  // account's badge disappears immediately, regardless of whether a next
  // active account was assigned. Previously this happened only in the
  // "no accounts left" branch, causing the ghost-icon bug.
  renderAccounts();
  updateHubDashboard().catch(console.error);
  setStatus('Аккаунт удалён');
  closeAccountMenu();
}

function refreshActiveWebview() {
  {
    // Signal: webview нет — «обновить» перезапускает демон и контакты
    const acc = activeAccount();
    if (acc?.type === 'signal') {
      window.WaDeckSignalPanel?.refreshAccount?.(acc.id);
      setStatus(`${acc.name}: Signal перезапущен`);
      return;
    }
  }
  const webview = selectedWebview();
  const account = activeAccount();
  if (!account) {
    // Хаб открыт (активного аккаунта нет) — кнопка обновляет все аккаунты.
    refreshAllWebviews();
    return;
  }
  if (account.frozen) {
    setStatus(`${account.name}: аккаунт заморожен`);
    return;
  }
  if (!webview) {
    setStatus(`${account.name}: вебвью не готов`);
    return;
  }
  els.refreshActive?.classList.add('is-spinning');
  setTimeout(() => {
    els.refreshActive?.classList.remove('is-spinning');
  }, 680);
  webview.reload();
  setStatus(`${account.name}: обновлено`);
}

function refreshAllWebviews() {
  let count = 0;
  for (const account of state.accounts) {
    if (account.frozen) continue;
    const wv = state.webviews.get(account.id);
    if (wv) { wv.reload(); count++; }
  }
  els.refreshActive?.classList.add('is-spinning');
  setTimeout(() => els.refreshActive?.classList.remove('is-spinning'), 680);
  setStatus(`Обновлено аккаунтов: ${count}`);
}

function showRefreshContextMenu(event) {
  closeAccountContextMenu();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.id = 'account-context-menu';

  const items = [
    { label: 'Обновить текущий', action: () => refreshActiveWebview() },
    { label: 'Обновить все', action: () => refreshAllWebviews() },
  ];

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'context-menu-item';
    el.textContent = item.label;
    el.addEventListener('click', () => {
      closeAccountContextMenu();
      item.action();
    });
    menu.appendChild(el);
  }

  document.body.appendChild(menu);
  let x = event.clientX;
  let y = event.clientY;
  const rect = menu.getBoundingClientRect();
  if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
  if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
  menu.style.left = Math.max(0, x) + 'px';
  menu.style.top = Math.max(0, y) + 'px';

  const closeOnClick = (e) => { if (!menu.contains(e.target)) closeAccountContextMenu(); };
  const closeOnEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); closeAccountContextMenu(); } };
  document.addEventListener('click', closeOnClick, { capture: true });
  document.addEventListener('keydown', closeOnEsc);
  menu._cleanup = () => {
    document.removeEventListener('click', closeOnClick, { capture: true });
    document.removeEventListener('keydown', closeOnEsc);
  };
}

export {
  activeAccount,
  updateActiveAccountDisplay,
  updateToolbarState,
  updateFreezeButtonState,
  selectedWebview,
  accountById,
  patchLocalAccount,
  replaceAccounts,
  reorderAccountsByDrag,
  updateAccountActiveHighlight,
  updateAccountCardStatus,
  renderAccounts,
  updateSidebarScrollControls,
  scrollAccountsList,
  showAccountContextMenu,
  closeAccountContextMenu,
  setActiveAccount,
  addAccount,
  removeAccount,
  refreshActiveWebview,
  refreshAllWebviews,
  showRefreshContextMenu,
};

/* Account management modal (rename/icon/color/freeze/pin/delete) and the
   freeze/pin state mutations. Extracted verbatim from renderer.js. */
import { state, els } from './state.js';
import { setStatus, closeModalAnimated } from './helpers.js';
import {
  accountById,
  patchLocalAccount,
  renderAccounts,
  activeAccount,
  updateFreezeButtonState,
  updateToolbarState,
  updateActiveAccountDisplay,
} from './accounts.js';
import { cleanupWebview, ensureWebview, refreshWebviewVisibility } from './webviews.js';
import { updateHubDashboard } from './hub.js';
import { WaDeckUnreadModule } from '../unread.js';
import { WaDeckScheduleModule } from '../schedule.js';

function openAccountMenu(accountId) {
  const account = accountById(accountId);
  if (!account) return;

  state.accountMenuAccountId = account.id;
  state.accountMenuDraftIconPath = String(account.iconPath || '').trim();
  els.accountMenuTitle.textContent = account.name;
  els.accountMenuName.value = account.name;

  // Preview chip
  if (els.accountMenuChip) {
    els.accountMenuChip.innerHTML = '';
    els.accountMenuChip.style.background = account.color || 'var(--accent)';
    if (account.iconUrl) {
      const img = document.createElement('img');
      img.src = account.iconUrl;
      img.alt = account.name;
      els.accountMenuChip.appendChild(img);
    } else {
      els.accountMenuChip.textContent = account.name.slice(0, 2).toUpperCase();
    }
  }

  // Status line
  if (els.accountMenuStatus) {
    let statusText = '';
    if (account.frozen) {
      statusText = '❄ Заморожен';
    } else {
      const wv = state.webviews.get(account.id);
      if (!wv) statusText = '○ Не подключён';
      else if (wv.dataset?.waReady === '1') statusText = '● Подключён';
      else statusText = '◌ Загрузка…';
    }
    els.accountMenuStatus.textContent = statusText;
  }

  // Freeze toggle — flips is-active + textual state
  if (els.accountMenuFreeze) {
    const frozen = Boolean(account.frozen);
    els.accountMenuFreeze.classList.toggle('is-active', frozen);
    const label = els.accountMenuFreeze.querySelector('.toggle-text');
    if (label) label.textContent = frozen ? 'Разморозить' : 'Заморозить';
    els.accountMenuFreeze.title = frozen
      ? 'Разморозить и возобновить загрузку аккаунта'
      : 'Заморозить аккаунт (выгрузить webview)';
  }

  // Pin toggle — no limit; user can pin as many accounts as they want.
  if (els.accountMenuPin) {
    const pinned = Boolean(account.pinned);
    els.accountMenuPin.classList.toggle('is-active', pinned);
    els.accountMenuPin.disabled = false;
    const label = els.accountMenuPin.querySelector('.toggle-text');
    if (label) label.textContent = pinned ? 'Закреплено' : 'Закрепить';
    els.accountMenuPin.title = pinned
      ? 'Снять с главной полки хаба'
      : 'Закрепить на главной полке хаба';
  }

  // Show/hide reset icon button
  if (els.accountMenuResetIcon) {
    const hasIcon = Boolean(account.iconPath || account.iconUrl);
    els.accountMenuResetIcon.classList.toggle('hidden', !hasIcon);
  }

  // Color swatch
  const swatch = document.getElementById('account-menu-color-swatch');
  if (swatch) {
    swatch.style.background = account.color || '#0ea5e9';
  }
  state.accountMenuDraftColor = account.color || '';

  // Build color palette popover
  const colorPopover = document.getElementById('account-color-popover');
  if (colorPopover) {
    colorPopover.innerHTML = '';
    colorPopover.classList.add('hidden');
    const PALETTE = [
      // Greens
      '#22c55e', '#16a34a', '#15803d', '#059669', '#10b981',
      // Teals & Cyans
      '#14b8a6', '#0d9488', '#06b6d4', '#0891b2', '#22d3ee',
      // Blues
      '#0ea5e9', '#0284c7', '#3b82f6', '#2563eb', '#1d4ed8',
      // Indigos & Violets
      '#6366f1', '#4f46e5', '#7c3aed', '#8b5cf6', '#a78bfa',
      // Purples & Pinks
      '#a855f7', '#9333ea', '#d946ef', '#c026d3', '#e879f9',
      // Roses & Reds
      '#ec4899', '#db2777', '#e11d48', '#be123c', '#f43f5e',
      // Reds & Oranges
      '#ef4444', '#dc2626', '#b91c1c', '#f97316', '#ea580c',
      // Ambers & Yellows
      '#f59e0b', '#d97706', '#eab308', '#ca8a04', '#facc15',
      // Limes
      '#84cc16', '#65a30d', '#a3e635', '#4ade80', '#34d399',
      // Neutrals
      '#78716c', '#57534e', '#475569', '#334155', '#1e293b',
    ];
    for (const c of PALETTE) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'color-dot';
      dot.style.background = c;
      dot.title = c;
      if (c === (account.color || '').toLowerCase()) dot.classList.add('active');
      dot.addEventListener('click', () => {
        state.accountMenuDraftColor = c;
        if (swatch) swatch.style.background = c;
        if (els.accountMenuChip) els.accountMenuChip.style.background = c;
        for (const d of colorPopover.querySelectorAll('.color-dot')) d.classList.remove('active');
        dot.classList.add('active');
        colorPopover.classList.add('hidden');
      });
      colorPopover.appendChild(dot);
    }
  }

  // Заморозка доступна обоим типам аккаунтов
  if (els.accountMenuFreeze) {
    els.accountMenuFreeze.style.display = '';
  }

  els.accountMenuModal.classList.remove('hidden');
  els.accountMenuModal.setAttribute('role', 'dialog');
  els.accountMenuModal.setAttribute('aria-modal', 'true');
  setTimeout(() => els.accountMenuName?.focus(), 50);
}

function closeAccountMenu() {
  state.accountMenuAccountId = '';
  state.accountMenuDraftIconPath = '';
  state.accountMenuDraftColor = '';
  const colorPop = document.getElementById('account-color-popover');
  if (colorPop) colorPop.classList.add('hidden');
  closeModalAnimated(els.accountMenuModal);
}

async function saveAccountFromMenu() {
  const accountId = String(state.accountMenuAccountId || '');
  const account = accountById(accountId);
  if (!account) return;

  const nextName = String(els.accountMenuName.value || '').trim();
  if (!nextName) {
    setStatus('Введите название аккаунта');
    return;
  }

  const nextIconPath = String(state.accountMenuDraftIconPath || '').trim();
  const currentIconPath = String(account.iconPath || '').trim();

  let changed = false;
  let currentAccount = account;

  if (nextName !== String(account.name || '').trim()) {
    const renameResponse = await window.waDeck.renameAccount({ accountId, name: nextName });
    if (!renameResponse?.ok || !renameResponse.account) {
      setStatus(`Не удалось сохранить: ${renameResponse?.error || 'error'}`);
      return;
    }
    patchLocalAccount(renameResponse.account);
    currentAccount = accountById(accountId) || currentAccount;
    changed = true;
  }

  if (nextIconPath !== currentIconPath) {
    const iconResponse = await window.waDeck.setAccountIcon({ accountId, iconPath: nextIconPath });
    if (!iconResponse?.ok || !iconResponse.account) {
      const map = {
        icon_not_found: 'Файл иконки не найден',
        icon_invalid_type: 'Поддерживаются только PNG/JPG',
        account_not_found: 'Аккаунт не найден',
      };
      setStatus(`Не удалось сохранить иконку: ${map[iconResponse?.error] || iconResponse?.error || 'ошибка'}`);
      return;
    }
    patchLocalAccount(iconResponse.account);
    currentAccount = accountById(accountId) || currentAccount;
    changed = true;
  }

  // Save color if changed
  const draftColor = String(state.accountMenuDraftColor || '').trim();
  if (draftColor && draftColor !== String(account.color || '').trim()) {
    const colorResponse = await window.waDeck.setAccountColor({ accountId, color: draftColor });
    if (colorResponse?.ok && colorResponse.account) {
      patchLocalAccount(colorResponse.account);
      currentAccount = accountById(accountId) || currentAccount;
      changed = true;
    }
  }

  if (state.scheduleTarget.accountId === accountId) {
    state.scheduleTarget.accountName = String(currentAccount.name || nextName);
    WaDeckScheduleModule.renderScheduleTarget();
  }
  renderAccounts();
  setStatus(changed ? `Сохранено: ${currentAccount.name || nextName}` : 'Изменений нет');
  closeAccountMenu();
}

async function resetAccountFromMenu() {
  const accountId = String(state.accountMenuAccountId || '');
  const account = accountById(accountId);
  if (!account) return;

  const fallbackOrder = state.accounts.findIndex((row) => row.id === accountId) + 1;
  const defaultName = `WP_${Number(account.order || fallbackOrder || 1)}`;

  const iconResponse = await window.waDeck.setAccountIcon({ accountId, iconPath: '' });
  if (!iconResponse?.ok || !iconResponse.account) {
    setStatus(`Не удалось сбросить иконку: ${iconResponse?.error || 'error'}`);
    return;
  }
  patchLocalAccount(iconResponse.account);

  const renameResponse = await window.waDeck.renameAccount({ accountId, name: defaultName });
  if (!renameResponse?.ok || !renameResponse.account) {
    setStatus(`Не удалось сбросить имя: ${renameResponse?.error || 'error'}`);
    return;
  }
  patchLocalAccount(renameResponse.account);

  state.accountMenuDraftIconPath = '';
  els.accountMenuName.value = defaultName;
  if (els.accountMenuIcon) {
    els.accountMenuIcon.style.borderColor = '';
  }

  if (state.scheduleTarget.accountId === accountId) {
    state.scheduleTarget.accountName = defaultName;
    WaDeckScheduleModule.renderScheduleTarget();
  }

  renderAccounts();
  setStatus(`Сброшено: ${defaultName}`);
  closeAccountMenu();
}

async function changeAccountIconFromMenu() {
  const accountId = String(state.accountMenuAccountId || '');
  const account = accountById(accountId);
  if (!account) return;

  const picked = await window.waDeck.pickAccountIcon();
  if (!picked || picked.canceled || !picked.path) return;
  state.accountMenuDraftIconPath = String(picked.path || '').trim();

  // Immediate preview in the chip — doesn't persist until Save, but gives
  // the user visual confirmation that the pick worked.
  if (els.accountMenuChip && picked.url) {
    els.accountMenuChip.innerHTML = '';
    const img = document.createElement('img');
    img.src = picked.url;
    img.alt = account.name;
    els.accountMenuChip.appendChild(img);
  }
  if (els.accountMenuResetIcon) {
    els.accountMenuResetIcon.classList.remove('hidden');
  }
  if (els.accountMenuIcon) {
    els.accountMenuIcon.style.borderColor = '#3dd68c';
  }
  setStatus(`Иконка выбрана: ${account.name}. Нажмите «Сохранить»`);
}

async function resetAccountIconFromMenu() {
  const accountId = String(state.accountMenuAccountId || '');
  const account = accountById(accountId);
  if (!account) return;

  const iconResponse = await window.waDeck.setAccountIcon({ accountId, iconPath: '' });
  if (!iconResponse?.ok || !iconResponse.account) {
    setStatus(`Не удалось сбросить иконку: ${iconResponse?.error || 'error'}`);
    return;
  }
  patchLocalAccount(iconResponse.account);
  state.accountMenuDraftIconPath = '';
  renderAccounts();
  setStatus(`Иконка сброшена: ${account.name}`);
  // Re-open to reflect changes
  openAccountMenu(accountId);
}

async function setAccountFrozenState(accountId, nextFrozen, options = {}) {
  const account = accountById(accountId);
  if (!account) return { ok: false };

  const response = await window.waDeck.setAccountFrozen({ accountId, frozen: nextFrozen });
  if (!response?.ok || !response.account) {
    setStatus(`Не удалось изменить режим: ${response?.error || 'error'}`);
    return { ok: false, response };
  }

  patchLocalAccount(response.account);

  if (response.account.frozen) {
    cleanupWebview(state.webviews.get(accountId));
    state.webviews.delete(accountId);
    if (state.chatPickerCache && state.chatPickerCache.accountId === accountId) {
      state.chatPickerCache = null;
    }
    WaDeckUnreadModule.setUnreadCount(accountId, 0);
    if (state.activeAccountId === accountId) {
      refreshWebviewVisibility();
    }
    setStatus(`Аккаунт ${response.account.name} заморожен`);
  } else {
    const fullAccount = accountById(accountId);
    if (fullAccount) {
      ensureWebview(fullAccount);
    }
    refreshWebviewVisibility();
    setStatus(`Аккаунт ${response.account.name} разморожен`);
  }

  renderAccounts();
  updateFreezeButtonState();
  updateToolbarState();
  updateActiveAccountDisplay();
  if (options.reopenMenu) {
    openAccountMenu(accountId);
  }
  return { ok: true, account: response.account };
}

async function toggleActiveFreeze() {
  const account = activeAccount();
  if (!account) {
    setStatus('Нет активного аккаунта');
    return;
  }
  await setAccountFrozenState(account.id, !Boolean(account.frozen), { reopenMenu: false });
}

async function setAccountPinnedState(accountId, nextPinned, options = {}) {
  const account = accountById(accountId);
  if (!account) return { ok: false };

  const response = await window.waDeck.setAccountPinned({ accountId, pinned: nextPinned });
  if (!response?.ok || !response.account) {
    setStatus(`Не удалось изменить пин: ${response?.error || 'error'}`);
    return { ok: false, response };
  }

  patchLocalAccount(response.account);
  renderAccounts();
  updateHubDashboard();
  setStatus(
    response.account.pinned
      ? `${response.account.name} закреплён в хабе`
      : `${response.account.name} откреплён`,
  );
  if (options.reopenMenu) {
    openAccountMenu(accountId);
  }
  return { ok: true, account: response.account };
}


export {
  openAccountMenu,
  closeAccountMenu,
  saveAccountFromMenu,
  resetAccountFromMenu,
  changeAccountIconFromMenu,
  resetAccountIconFromMenu,
  setAccountFrozenState,
  toggleActiveFreeze,
  setAccountPinnedState,
};

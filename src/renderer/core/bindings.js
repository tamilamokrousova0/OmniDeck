/* bindActions(): all DOM event wiring for toolbar, settings, modals,
   hotkeys, zoom, sidebar resize. Extracted verbatim from renderer.js. */
import { state, els } from './state.js';
import {
  setStatus,
  showToast,
  runWithBusyButton,
  closeConfirm,
} from './helpers.js';
import {
  addAccount,
  removeAccount,
  accountById,
  setActiveAccount,
  scrollAccountsList,
  updateSidebarScrollControls,
  refreshActiveWebview,
  showRefreshContextMenu,
} from './accounts.js';
import {
  closeAccountMenu,
  saveAccountFromMenu,
  resetAccountFromMenu,
  changeAccountIconFromMenu,
  resetAccountIconFromMenu,
  setAccountFrozenState,
  setAccountPinnedState,
  toggleActiveFreeze,
} from './account-menu.js';
import {
  applyZoom,
  currentZoom,
  sendAudioAsVoiceMessage,
  applyTranslatorToggleToAllWebviews,
  applyCrmHoverToggle,
  applyHibernationSetting,
} from './webviews.js';
import {
  normalizeTheme,
  applyTheme,
  normalizeTileMode,
  applyTileMode,
  refreshAppearanceControls,
  openSettingsPanel,
  closeSettingsPanel,
  showSettingsMenu,
  showSettingsSection,
  refreshSettingsMenuSubtitles,
  renderClocksSettings,
  saveSettings,
  toggleTheme,
  isTranslatorEnabled,
  isCrmHoverEnabled,
  getHibernateMinutes,
} from './settings.js';
import { playBrandClickAnimation, openHubMode } from './hub.js';
import { handleEscapeUiReset } from './hotkeys.js';
import { templateController } from './init.js';
import { WaDeckWeatherModule } from '../weather.js';
import { WaDeckAutoUpdateModule } from '../auto-update.js';
import { WaDeckCrmModule } from '../crm.js';

function bindActions() {
  // ── Add-account popover (WhatsApp / Telegram choice) ──
  const addPopover = document.getElementById('add-account-popover');
  els.addAccount.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!addPopover) return;
    const willOpen = addPopover.classList.contains('hidden');
    addPopover.classList.toggle('hidden', !willOpen);
    if (!willOpen) return;
    // Меню с подписями шире сайдбара (у того overflow: hidden) — ставим его
    // фиксированно справа от «+» и не даём уйти за нижний край окна.
    const rect = els.addAccount.getBoundingClientRect();
    const top = Math.max(8, Math.min(rect.top, window.innerHeight - addPopover.offsetHeight - 8));
    addPopover.style.left = `${Math.round(rect.right + 8)}px`;
    addPopover.style.top = `${Math.round(top)}px`;
  });
  if (addPopover) {
    for (const btn of addPopover.querySelectorAll('.add-account-option')) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const type = btn.dataset.type || 'whatsapp';
        addPopover.classList.add('hidden');
        runWithBusyButton(els.addAccount, () => addAccount(type), { text: '…', title: 'Добавление аккаунта' }).catch(console.error);
      });
    }
    document.addEventListener('click', (e) => {
      if (!addPopover.contains(e.target) && e.target !== els.addAccount) {
        addPopover.classList.add('hidden');
      }
    });
  }
  els.accountsScrollUp?.addEventListener('click', () => scrollAccountsList('up'));
  els.accountsScrollDown?.addEventListener('click', () => scrollAccountsList('down'));
  els.accountsList?.addEventListener('scroll', updateSidebarScrollControls, { passive: true });
  els.refreshActive?.addEventListener('click', refreshActiveWebview);
  els.refreshActive?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showRefreshContextMenu(e);
  });
  els.freezeActive?.addEventListener('click', () => toggleActiveFreeze().catch(console.error));
  els.openCrmModal?.addEventListener('click', () => {
    if (!els.crmModal) return;
    // Treat both "hidden" and in-flight "is-closing" as closed for toggle
    // purposes — otherwise a click arriving during the 250ms close-animation
    // window would see "not hidden yet", wrongly call close again, and break
    // the user's next click. Open is genuinely required → call openCrmModal.
    const isClosed = els.crmModal.classList.contains('hidden')
      || els.crmModal.classList.contains('is-closing');
    if (isClosed) {
      WaDeckCrmModule.openCrmModal().catch(console.error);
    } else {
      WaDeckCrmModule.closeCrmModal();
    }
  });
  els.sendVoiceMsg?.addEventListener('click', () => sendAudioAsVoiceMessage().catch(console.error));

  els.togglePanel.addEventListener('click', () => {
    // Clicking the toolbar settings button also closes panel if it's already open
    if (!state.panelHidden) {
      closeSettingsPanel();
    } else {
      openSettingsPanel();
    }
  });
  els.themeToggle?.addEventListener('click', () => toggleTheme().catch(console.error));
  els.closePanel?.addEventListener('click', closeSettingsPanel);

  // Settings menu: card clicks → open section.
  document.querySelectorAll('.settings-menu-item[data-open]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-open');
      if (!key) return;
      showSettingsSection(key);
    });
  });
  // Back button in settings header
  els.settingsBack?.addEventListener('click', () => showSettingsMenu());

  // Оформление: тема и стиль плиток (Настройки → Интерфейс)
  document.querySelectorAll('.seg-btn[data-theme]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = btn.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
      if (normalizeTheme(state.settings?.uiTheme || 'dark') === next) return;
      state.settings = { ...(state.settings || {}), uiTheme: next };
      applyTheme(next);
      refreshAppearanceControls();
      try { await saveSettings(); } catch {}
    });
  });
  document.querySelectorAll('.seg-btn[data-tiles]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const next = normalizeTileMode(btn.getAttribute('data-tiles'));
      if (normalizeTileMode(state.settings?.uiTiles) === next) return;
      state.settings = { ...(state.settings || {}), uiTiles: next };
      applyTileMode(next);
      refreshAppearanceControls();
      try { await saveSettings(); } catch {}
    });
  });

  // Weather settings: auto-save on change (no explicit button).
  const autoSaveWeather = async () => {
    const city = String(els.wsettingsCity?.value || '').trim();
    const unit = WaDeckWeatherModule.normalizeWeatherUnit(els.wsettingsUnit?.value);
    const normCity = WaDeckWeatherModule.normalizeWeatherCity(city);
    // Skip no-op saves to avoid spamming IPC on every keystroke
    if (
      normCity === state.settings?.weatherCity &&
      unit === state.settings?.weatherUnit
    ) return;
    state.settings = {
      ...(state.settings || {}),
      weatherCity: normCity,
      weatherUnit: unit,
    };
    try {
      await saveSettings();
      refreshSettingsMenuSubtitles();
      WaDeckWeatherModule.refreshWeather().catch(() => {});
    } catch { /* saveSettings already reported */ }
  };
  // Debounce city typing so every keystroke isn't a save
  let _weatherCityDebounce = null;
  els.wsettingsCity?.addEventListener('input', () => {
    if (_weatherCityDebounce) clearTimeout(_weatherCityDebounce);
    _weatherCityDebounce = setTimeout(autoSaveWeather, 700);
  });
  els.wsettingsCity?.addEventListener('blur', () => {
    if (_weatherCityDebounce) { clearTimeout(_weatherCityDebounce); _weatherCityDebounce = null; }
    autoSaveWeather();
  });
  els.wsettingsUnit?.addEventListener('change', () => autoSaveWeather());
  els.wsettingsRefresh?.addEventListener('click', () => {
    WaDeckWeatherModule.refreshWeather().catch(console.error);
    setStatus('Обновляю погоду…');
  });

  // Template edit form lives inline inside the Templates settings card.
  // Opened/closed in place to match the other drawer sections' style.
  const tmplEditWrap = document.getElementById('tmpl-edit-wrap');
  const tmplEditCloseBtn = document.getElementById('tmpl-edit-close');
  const tmplEditTitleEl = document.getElementById('tmpl-edit-title');
  if (tmplEditWrap) {
    const openTemplateEdit = () => {
      tmplEditWrap.classList.remove('hidden');
      setTimeout(() => {
        tmplEditWrap.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }, 20);
    };
    const closeTemplateEdit = () => tmplEditWrap.classList.add('hidden');

    tmplEditCloseBtn?.addEventListener('click', closeTemplateEdit);
    // Escape-close is handled by the central handleEscapeUiReset() stack.

    // Update header title based on whether this is a new or existing template
    const updateTmplEditTitle = () => {
      if (!tmplEditTitleEl) return;
      const titleVal = els.templateTitle?.value?.trim();
      const hasId = els.templateSelect && els.templateSelect.value;
      tmplEditTitleEl.textContent = hasId
        ? `Редактирование · ${titleVal || 'без названия'}`
        : 'Новый шаблон';
    };
    els.templateSelect?.addEventListener('change', updateTmplEditTitle);
    els.templateTitle?.addEventListener('input', updateTmplEditTitle);

    // Hide form automatically after save/delete
    // Закрытие формы делает сам saveCurrentTemplate по успеху: раньше форма
  // пряталась безусловно и набранный текст пропадал при любой ошибке


    window._showTemplateEditForm = () => { openTemplateEdit(); updateTmplEditTitle(); };
    window._hideTemplateEditForm = closeTemplateEdit;
  } else {
    window._showTemplateEditForm = () => {};
    window._hideTemplateEditForm = () => {};
  }

  // "+ Новый шаблон" (settings library header) → open edit modal fresh
  const tmplLibNewBtn = document.getElementById('tmpl-lib-new');
  if (tmplLibNewBtn && els.templateNew) {
    tmplLibNewBtn.addEventListener('click', () => {
      els.templateNew.click();
      if (typeof window._showTemplateEditForm === 'function') window._showTemplateEditForm();
      setTimeout(() => els.templateTitle?.focus(), 30);
    });
  }

  /* Zoom controls: «−», процент (клик — сброс до 100%), «+» */
  els.zoomIn?.addEventListener('click', () => applyZoom(currentZoom() + 10));
  els.zoomOut?.addEventListener('click', () => applyZoom(currentZoom() - 10));
  els.zoomValue?.addEventListener('click', () => applyZoom(100));

  /* Clocks settings — toggle add form */
  els.clockAddToggle?.addEventListener('click', () => {
    const form = els.clockAddForm;
    if (!form) return;
    const isHidden = form.classList.contains('hidden');
    if (isHidden) {
      form.classList.remove('hidden');
      form.style.maxHeight = '0';
      form.style.opacity = '0';
      requestAnimationFrame(() => {
        form.style.transition = 'max-height 0.25s ease, opacity 0.2s ease';
        form.style.maxHeight = '50px';
        form.style.opacity = '1';
      });
      els.clockAddToggle.textContent = '− Отмена';
      els.clockNewLabel?.focus();
    } else {
      form.style.maxHeight = '0';
      form.style.opacity = '0';
      setTimeout(() => { form.classList.add('hidden'); form.style.transition = ''; }, 250);
      els.clockAddToggle.textContent = '+ Добавить';
    }
  });

  /* Clocks settings — add new clock */
  els.clockAdd?.addEventListener('click', () => {
    const label = (els.clockNewLabel?.value || '').trim();
    const tz = (els.clockNewTz?.value || '').trim();
    if (!label || !tz) { showToast('Введите город и выберите часовой пояс', 'warn'); return; }
    if (!state.settings.worldClocks) state.settings.worldClocks = [];
    if (state.settings.worldClocks.length >= 10) { showToast('Максимум 10 часовых поясов', 'warn'); return; }
    state.settings.worldClocks.push({ label, tz });
    if (els.clockNewLabel) els.clockNewLabel.value = '';
    if (els.clockNewTz) els.clockNewTz.value = '';
    renderClocksSettings();
    saveSettings().catch(console.error);
    // Collapse add form after adding
    if (els.clockAddForm) {
      els.clockAddForm.style.maxHeight = '0';
      els.clockAddForm.style.opacity = '0';
      setTimeout(() => { els.clockAddForm.classList.add('hidden'); els.clockAddForm.style.transition = ''; }, 250);
    }
    if (els.clockAddToggle) els.clockAddToggle.textContent = '+ Добавить';
  });

  els.manualUpdate?.addEventListener('click', () => WaDeckAutoUpdateModule.requestManualUpdate().catch(console.error));
  els.openDataDir?.addEventListener('click', () => {
    window.waDeck.openDataDir()
      .then(() => setStatus('Открыта папка данных'))
      .catch((e) => { console.error(e); setStatus('Не удалось открыть папку данных'); });
  });
  els.brandHub?.addEventListener('click', () => {
    playBrandClickAnimation();
    openHubMode();
  });
  // Weather widget click → open the weather settings section directly.
  els.weatherToggle?.addEventListener('click', () => {
    if (state.panelHidden) openSettingsPanel();
    showSettingsSection('weather');
  });

  els.settingTranslatorEnabled?.addEventListener('change', async (event) => {
    const enabled = !!event.target.checked;
    state.settings = { ...(state.settings || {}), translatorEnabled: enabled };
    applyTranslatorToggleToAllWebviews(enabled);
    try {
      await saveSettings();
      refreshSettingsMenuSubtitles();
      setStatus(enabled ? 'Переводчик включён' : 'Переводчик отключён');
    } catch {
      // saveSettings already surfaces its own error; revert UI to current state
      event.target.checked = isTranslatorEnabled();
    }
  });

  els.settingCrmHoverEnabled?.addEventListener('change', async (event) => {
    const enabled = !!event.target.checked;
    state.settings = { ...(state.settings || {}), crmHoverEnabled: enabled };
    applyCrmHoverToggle(enabled);
    try {
      await saveSettings();
      refreshSettingsMenuSubtitles();
      setStatus(enabled ? 'Заметки при наведении включены' : 'Заметки при наведении отключены');
    } catch {
      event.target.checked = isCrmHoverEnabled();
    }
  });

  els.settingBatchTranslate?.addEventListener('change', async (event) => {
    const enabled = !!event.target.checked;
    state.settings = { ...(state.settings || {}), translateBatchEnabled: enabled };
    try {
      await saveSettings();
      setStatus(enabled ? 'Перевод пачкой включён' : 'Перевод пачкой отключён');
    } catch {
      setStatus('Не удалось сохранить настройку');
    }
  });
  els.settingNotificationsEnabled?.addEventListener('change', async (event) => {
    const enabled = !!event.target.checked;
    state.settings = { ...(state.settings || {}), notificationsEnabled: enabled };
    try {
      await saveSettings();
      setStatus(enabled ? 'Уведомления включены' : 'Уведомления отключены');
    } catch {
      event.target.checked = state.settings?.notificationsEnabled !== false;
    }
  });

  els.settingHibernateMinutes?.addEventListener('change', async (event) => {
    const valid = [0, 30, 60, 120, 240];
    const requested = Number(event.target.value);
    const minutes = valid.includes(requested) ? requested : 0;
    state.settings = { ...(state.settings || {}), hibernateAfterMinutes: minutes };
    applyHibernationSetting(minutes);
    try {
      await saveSettings();
      setStatus(minutes === 0 ? 'Гибернация выключена' : `Гибернация через ${minutes} мин`);
    } catch {
      event.target.value = String(getHibernateMinutes());
    }
  });
  window.addEventListener('keydown', (event) => {
    // Мёртвые дубли (Escape/цифры) снесены: main перехватывает эти хоткеи
    // through before-input-event с preventDefault — сюда они не долетают.
    const mod = event.metaKey || event.ctrlKey;
    if (!mod) return;

    const tag = (event.target?.tagName || '').toLowerCase();
    const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (isInput) return;

    if (event.key === ',' || event.key === '\u0431') {
      event.preventDefault();
      if (state.panelHidden) { openSettingsPanel(); } else { closeSettingsPanel(); }
      return;
    }
  });

  els.saveSettings?.addEventListener('click', () => saveSettings().catch(console.error));
  els.closeReleaseNotes?.addEventListener('click', () => WaDeckAutoUpdateModule.closeReleaseNotesModal().catch(console.error));

  /* Update available modal buttons */
  els.updateToastClose?.addEventListener('click', () => WaDeckAutoUpdateModule.closeUpdateToast());
  els.updateToastAction?.addEventListener('click', () => WaDeckAutoUpdateModule.installUpdate().catch(console.error));



  els.crmEdit?.addEventListener('click', WaDeckCrmModule.toggleCrmEdit);
  els.crmSave?.addEventListener('click', () => WaDeckCrmModule.saveCrmCard().catch(console.error));
  els.crmCopy?.addEventListener('click', () => WaDeckCrmModule.copyCrmCard().catch(console.error));
  els.crmClose?.addEventListener('click', WaDeckCrmModule.closeCrmModal);
  if (els.crmAddNote) els.crmAddNote.addEventListener('click', WaDeckCrmModule.addCrmNote);
  WaDeckCrmModule.bindCrmAutoResize();
  // Confirm модал
  els.confirmOk?.addEventListener('click', () => closeConfirm(true));
  els.confirmCancel?.addEventListener('click', () => closeConfirm(false));
  if (els.confirmClose) els.confirmClose.addEventListener('click', () => closeConfirm(false));
  els.confirmModal?.addEventListener('click', (e) => { if (e.target === els.confirmModal) closeConfirm(false); });
  window.addEventListener('resize', () => {
    updateSidebarScrollControls();
  });
  // Backdrop click closes the account menu (CRM modal intentionally keeps
  // its pass-through backdrop).
  els.accountMenuModal?.addEventListener('click', (e) => {
    if (e.target === els.accountMenuModal) closeAccountMenu();
  });
  els.accountMenuSave?.addEventListener('click', () => saveAccountFromMenu().catch(console.error));
  els.accountMenuReset?.addEventListener('click', () => resetAccountFromMenu().catch(console.error));
  els.accountMenuIcon?.addEventListener('click', () => changeAccountIconFromMenu().catch(console.error));
  els.accountMenuResetIcon?.addEventListener('click', () => resetAccountIconFromMenu().catch(console.error));

  // Color picker toggle
  const colorBtn = document.getElementById('account-menu-color');
  const colorPop = document.getElementById('account-color-popover');
  if (colorBtn && colorPop) {
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      colorPop.classList.toggle('hidden');
    });
    document.addEventListener('click', (e) => {
      if (!colorPop.contains(e.target) && e.target !== colorBtn && !colorBtn.contains(e.target)) {
        colorPop.classList.add('hidden');
      }
    });
  }
  els.accountMenuCancel?.addEventListener('click', closeAccountMenu);
  els.accountMenuFreeze?.addEventListener('click', () => {
    const id = state.accountMenuAccountId;
    const account = accountById(id);
    if (!account) return;
    setAccountFrozenState(id, !account.frozen, { reopenMenu: true }).catch(console.error);
  });
  els.accountMenuPin?.addEventListener('click', () => {
    const id = state.accountMenuAccountId;
    const account = accountById(id);
    if (!account) return;
    setAccountPinnedState(id, !account.pinned, { reopenMenu: true }).catch(console.error);
  });
  els.accountMenuDelete?.addEventListener('click', () => {
    const id = state.accountMenuAccountId;
    if (!id) return;
    closeAccountMenu();
    removeAccount(id).catch(console.error);
  });
  templateController?.bind();

  // ── Sidebar Resize Handle ──
  if (els.sidebarResizeHandle) {
    const SIDEBAR_MIN = 64;
    const SIDEBAR_MAX = 200;
    const SIDEBAR_KEY = 'sidebarWidth';
    const appRoot = document.getElementById('app-root');
    let resizing = false;

    // Restore saved width (with NaN protection — corrupted value breaks CSS grid)
    const savedWidth = localStorage.getItem(SIDEBAR_KEY);
    if (savedWidth) {
      const parsed = Number(savedWidth);
      if (Number.isFinite(parsed)) {
        const w = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, parsed));
        appRoot.style.setProperty('--sidebar-width', w + 'px');
        els.sidebarResizeHandle.style.left = w + 'px';
      } else {
        localStorage.removeItem(SIDEBAR_KEY);
      }
    }

    els.sidebarResizeHandle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      resizing = true;
      els.sidebarResizeHandle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!resizing) return;
      const x = Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, e.clientX));
      appRoot.style.setProperty('--sidebar-width', x + 'px');
      els.sidebarResizeHandle.style.left = x + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!resizing) return;
      resizing = false;
      els.sidebarResizeHandle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      const currentWidth = parseInt(getComputedStyle(appRoot).getPropertyValue('--sidebar-width'), 10);
      if (Number.isFinite(currentWidth) && currentWidth >= SIDEBAR_MIN && currentWidth <= SIDEBAR_MAX) {
        localStorage.setItem(SIDEBAR_KEY, currentWidth);
      }
    });
  }
}

export { bindActions };

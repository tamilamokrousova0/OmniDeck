/* Settings panel, theme/tiles, tweaks popover, clocks settings and the
   templates library. Extracted verbatim from renderer.js. */
import { state, els } from './state.js';
import { setStatus, showConfirm } from './helpers.js';
import { selectedWebview } from './accounts.js';
import { insertTextIntoActiveChat } from './webviews.js';
import { WaDeckWeatherModule } from '../weather.js';
import { WaDeckCrmModule } from '../crm.js';
import { WaDeckScheduleModule } from '../schedule.js';

function normalizeTheme(value) {
  return String(value || '').toLowerCase() === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  const safeTheme = normalizeTheme(theme);
  document.documentElement.setAttribute('data-theme', safeTheme);
  if (els.themeToggle) {
    els.themeToggle.classList.toggle('is-light', safeTheme === 'light');
    els.themeToggle.title = safeTheme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему';
  }
}

/* ── Clocks Settings ── */

function renderClocksSettings() {
  const list = els.clocksSettingsList;
  if (!list) return;
  list.innerHTML = '';
  const clocks = (state.settings && state.settings.worldClocks) || [];
  for (let i = 0; i < clocks.length; i++) {
    const c = clocks[i];
    const row = document.createElement('div');
    row.className = 'clocks-settings-row';

    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.className = 'clock-label-input';
    labelInput.value = c.label;
    labelInput.maxLength = 30;
    labelInput.title = 'Название';
    labelInput.addEventListener('change', () => {
      const v = labelInput.value.trim();
      if (v) { state.settings.worldClocks[i].label = v; saveSettings().catch(console.error); }
      else { labelInput.value = c.label; }
    });

    const tzSelect = document.createElement('select');
    tzSelect.className = 'clock-tz-select settings-select';
    tzSelect.title = c.tz;
    const tzOptions = getTimezoneOptions();
    for (const opt of tzOptions) {
      const o = document.createElement('option');
      o.value = opt.value;
      o.textContent = opt.label;
      if (opt.value === c.tz) o.selected = true;
      tzSelect.appendChild(o);
    }
    tzSelect.addEventListener('change', () => {
      if (tzSelect.value) {
        state.settings.worldClocks[i].tz = tzSelect.value;
        saveSettings().catch(console.error);
      }
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'btn-remove-clock';
    removeBtn.textContent = '\u2715';
    removeBtn.title = 'Удалить';
    removeBtn.addEventListener('click', () => {
      state.settings.worldClocks.splice(i, 1);
      renderClocksSettings();
      saveSettings().catch(console.error);
    });
    row.append(labelInput, tzSelect, removeBtn);
    list.appendChild(row);
  }
}

function getTimezoneOptions() {
  return [
    { value: 'Pacific/Auckland', label: 'Окленд +12' },
    { value: 'Asia/Tokyo', label: 'Токио +9' },
    { value: 'Asia/Shanghai', label: 'Шанхай +8' },
    { value: 'Asia/Bangkok', label: 'Бангкок +7' },
    { value: 'Asia/Almaty', label: 'Алматы +6' },
    { value: 'Asia/Tashkent', label: 'Ташкент +5' },
    { value: 'Asia/Dubai', label: 'Дубай +4' },
    { value: 'Europe/Moscow', label: 'Москва +3' },
    { value: 'Europe/Kiev', label: 'Киев +2/+3' },
    { value: 'Europe/Berlin', label: 'Берлин +1/+2' },
    { value: 'Europe/London', label: 'Лондон +0/+1' },
    { value: 'Atlantic/Azores', label: 'Азоры −1' },
    { value: 'America/Sao_Paulo', label: 'Сан-Паулу −3' },
    { value: 'America/New_York', label: 'Нью-Йорк −5' },
    { value: 'America/Chicago', label: 'Чикаго −6' },
    { value: 'America/Denver', label: 'Денвер −7' },
    { value: 'America/Los_Angeles', label: 'Лос-Анж. −8' },
    { value: 'Pacific/Honolulu', label: 'Гонолулу −10' },
  ];
}

/**
 * Tweaks FAB lives bottom-right. It should only appear when the user is on the
 * Hub screen or has the Settings panel open — not while viewing a WhatsApp chat,
 * where it would overlap message content.
 */
function refreshTweaksFabVisibility() {
  const fab = document.getElementById('tweaks-fab');
  const popover = document.getElementById('tweaks-panel');
  if (!fab) return;
  const hubVisible = state.startupHubVisible || !state.activeAccountId || !selectedWebview();
  const settingsVisible = !state.panelHidden;
  const shouldShow = hubVisible || settingsVisible;
  fab.classList.toggle('is-hidden', !shouldShow);
  // If we're hiding the FAB and popover is open, close it too
  if (!shouldShow && popover && !popover.classList.contains('hidden')) {
    toggleTweaksPopover(false);
  }
}

function isTranslatorEnabled() {
  return state.settings?.translatorEnabled !== false;
}
function isCrmHoverEnabled() {
  return state.settings?.crmHoverEnabled !== false;
}
function getHibernateMinutes() {
  const valid = [0, 30, 60, 120, 240];
  const n = Number(state.settings?.hibernateAfterMinutes);
  return valid.includes(n) ? n : 0;
}

function applySettingsToForm(options = {}) {
  const { renderWeather = false } = options;
  state.settings.uiTheme = normalizeTheme(state.settings.uiTheme);
  state.settings.uiTiles = normalizeTileMode(state.settings.uiTiles);
  state.settings.weatherCity = WaDeckWeatherModule.normalizeWeatherCity(state.settings.weatherCity);
  state.settings.weatherUnit = WaDeckWeatherModule.normalizeWeatherUnit(state.settings.weatherUnit);
  applyTheme(state.settings.uiTheme);
  applyTileMode(state.settings.uiTiles);
  if (els.settingTranslatorEnabled) {
    els.settingTranslatorEnabled.checked = isTranslatorEnabled();
  }
  if (els.settingCrmHoverEnabled) {
    els.settingCrmHoverEnabled.checked = isCrmHoverEnabled();
  }
  if (els.settingNotificationsEnabled) {
    els.settingNotificationsEnabled.checked = state.settings?.notificationsEnabled !== false;
  }
  if (els.settingBatchTranslate) {
    els.settingBatchTranslate.checked = state.settings?.translateBatchEnabled !== false;
  }
  if (els.settingHibernateMinutes) {
    els.settingHibernateMinutes.value = String(getHibernateMinutes());
  }
  // Only render the weather summary when explicitly requested (init / weather
  // settings save). Rendering it with `loading: false` after every
  // save-settings call blanks the temperature until the next 30-min refresh,
  // which looked like "weather reset" when the user just toggled translator.
  if (renderWeather) {
    WaDeckWeatherModule.renderWeatherSummary({
      city: state.settings.weatherCity,
      unit: state.settings.weatherUnit,
      loading: false,
    });
  }
  renderClocksSettings();
  // Keep menu subtitles + about block in sync with current settings
  if (typeof refreshSettingsMenuSubtitles === 'function') {
    refreshSettingsMenuSubtitles();
  }
  refreshTweakPills();
}

function updatePanelVisibility() {
  els.panel.classList.toggle('hidden', state.panelHidden);
  els.appRoot.classList.toggle('panel-hidden', state.panelHidden);
}

function openSettingsPanel() {
  state.panelHidden = false;
  updatePanelVisibility();
  // Highlight the toolbar gear so it's clear the panel is open
  els.togglePanel?.classList.add('is-active');
  // Always land on the top-level menu when opening fresh
  showSettingsMenu();
  refreshSettingsMenuSubtitles();
  refreshTweaksFabVisibility();
}

function closeSettingsPanel() {
  state.panelHidden = true;
  // Closing the panel always leaves schedule edit mode (if any)
  WaDeckScheduleModule.cancelScheduleEditMode?.();
  updatePanelVisibility();
  els.togglePanel?.classList.remove('is-active');
  refreshTweaksFabVisibility();
}

/* ── Floating Tweaks widget: toggle / outside-click close ─────── */

function toggleTweaksPopover(forceOpen) {
  const panel = document.getElementById('tweaks-panel');
  const fab = document.getElementById('tweaks-fab');
  if (!panel || !fab) return;
  const isHidden = panel.classList.contains('hidden');
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : isHidden;
  panel.classList.toggle('hidden', !shouldOpen);
  fab.classList.toggle('is-active', shouldOpen);
  // Make sure pills reflect current state every time we open
  if (shouldOpen && typeof refreshTweakPills === 'function') refreshTweakPills();
}

/* ── Settings panel: 2-level menu navigation ───────────────────── */

const SETTINGS_SECTION_TITLES = {
  interface: 'Интерфейс',
  templates: 'Общие шаблоны',
  schedule: 'Отложенные сообщения',
  clocks: 'Мировые часы',
  weather: 'Погода',
};

/* ── Tweaks (theme pills) ─────────────────────────────────────
   Scene/density pickers were removed from the Tweaks UI (theme only now).
   Stored uiScene/uiDensity values are still applied once at startup (see
   init) so existing installs keep their exact look; there is no UI to
   change them anymore. */

function refreshTweakPills() {
  const theme = normalizeTheme(state.settings?.uiTheme || 'dark');
  document.querySelectorAll('.tweak-pill[data-theme]').forEach((el) => {
    el.classList.toggle('is-active', el.getAttribute('data-theme') === theme);
  });
  const tiles = normalizeTileMode(state.settings?.uiTiles);
  document.querySelectorAll('.tweak-pill[data-tiles]').forEach((el) => {
    el.classList.toggle('is-active', el.getAttribute('data-tiles') === tiles);
  });
}

/* "Calm tiles" — opt-in normalization of user-picked account colors:
   the hue stays (spatial memory works), luminance is ours (badges and
   state rings stay readable on any color). Default is raw colors. */
function normalizeTileMode(value) {
  return String(value || '').toLowerCase() === 'calm' ? 'calm' : 'raw';
}

function applyTileMode(mode) {
  document.documentElement.toggleAttribute('data-tile-normalize', normalizeTileMode(mode) === 'calm');
}

function showSettingsMenu() {
  if (!els.settingsViewMenu || !els.settingsViewDetail) return;
  // Leaving the schedule section cancels a pending edit (if any)
  if (state._openSettingsSection === 'schedule') {
    WaDeckScheduleModule.cancelScheduleEditMode?.();
  }
  els.settingsViewDetail.classList.add('hidden');
  els.settingsViewMenu.classList.remove('hidden');
  els.settingsViewMenu.setAttribute('data-dir', 'back');
  // Force animation replay
  els.settingsViewMenu.style.animation = 'none';
  // eslint-disable-next-line no-unused-expressions
  els.settingsViewMenu.offsetHeight;
  els.settingsViewMenu.style.animation = '';
  els.settingsViewMenu.querySelectorAll('.settings-section').forEach((s) => s.classList.remove('active'));
  if (els.settingsBack) els.settingsBack.classList.add('hidden');
  if (els.panelTitleText) els.panelTitleText.textContent = 'Настройки';
  state._openSettingsSection = null;
}

function showSettingsSection(key) {
  if (!els.settingsViewMenu || !els.settingsViewDetail) return;
  const section = els.settingsViewDetail.querySelector(`.settings-section[data-settings-section="${CSS.escape(key)}"]`);
  if (!section) return;
  // Switching away from the schedule section cancels a pending edit
  if (state._openSettingsSection === 'schedule' && key !== 'schedule') {
    WaDeckScheduleModule.cancelScheduleEditMode?.();
  }
  els.settingsViewDetail.querySelectorAll('.settings-section').forEach((s) => s.classList.remove('active'));
  section.classList.add('active');
  els.settingsViewMenu.classList.add('hidden');
  els.settingsViewDetail.classList.remove('hidden');
  els.settingsViewDetail.removeAttribute('data-dir');
  // Force animation replay
  els.settingsViewDetail.style.animation = 'none';
  // eslint-disable-next-line no-unused-expressions
  els.settingsViewDetail.offsetHeight;
  els.settingsViewDetail.style.animation = '';
  if (els.settingsBack) els.settingsBack.classList.remove('hidden');
  if (els.panelTitleText) els.panelTitleText.textContent = SETTINGS_SECTION_TITLES[key] || 'Настройки';
  state._openSettingsSection = key;

  // Weather screen: mirror current values into the settings form
  if (key === 'weather') {
    if (els.wsettingsCity) els.wsettingsCity.value = String(state.settings?.weatherCity || '');
    if (els.wsettingsUnit) {
      const unit = WaDeckWeatherModule.normalizeWeatherUnit(state.settings?.weatherUnit || 'celsius');
      els.wsettingsUnit.value = unit;
    }
  }
}

function renderTemplatesLibrary() {
  const listEl = document.getElementById('tmpl-lib-list');
  const countEl = document.getElementById('tmpl-lib-count');
  if (!listEl) return;
  const templates = Array.isArray(state.templates) ? state.templates : [];

  if (countEl) {
    const n = templates.length;
    const plural = (x, forms) =>
      forms[x % 10 === 1 && x % 100 !== 11 ? 0 : (x % 10 >= 2 && x % 10 <= 4 && (x % 100 < 10 || x % 100 >= 20) ? 1 : 2)];
    countEl.textContent = n + ' ' + plural(n, ['шаблон', 'шаблона', 'шаблонов']);
  }

  listEl.innerHTML = '';
  if (!templates.length) {
    const empty = document.createElement('div');
    empty.className = 'tmpl-lib-empty';
    const title = document.createElement('div');
    title.className = 'tmpl-lib-empty-title';
    title.textContent = 'Пока нет шаблонов';
    const hint = document.createElement('div');
    hint.className = 'tmpl-lib-empty-hint';
    hint.textContent = 'Шаблоны доступны для всех WhatsApp-аккаунтов и всех чатов.';
    const cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'tmpl-lib-empty-cta';
    cta.textContent = '+ Создать первый шаблон';
    cta.addEventListener('click', () => {
      const newBtn = document.getElementById('tmpl-lib-new');
      if (newBtn) newBtn.click();
    });
    empty.append(title, hint, cta);
    listEl.appendChild(empty);
    return;
  }

  // Group by category
  const groups = new Map();
  for (const tpl of templates) {
    const cat = String(tpl.category || '').trim() || 'Без категории';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(tpl);
  }
  const sortedCats = [...groups.keys()].sort((a, b) => {
    if (a === 'Без категории') return 1;
    if (b === 'Без категории') return -1;
    return a.localeCompare(b, 'ru');
  });

  // Build a single shared item renderer so we can reuse it both for
  // lazy-expand and search-mode (which needs all items upfront).
  function buildTemplateItemEl(tpl, n) {
    // `<div role="button">` instead of nested <button> so the in-card
    // delete control (also a button) doesn't become an invalid child.
    const item = document.createElement('div');
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.className = 'tmpl-lib-item';
    const lang = (typeof detectTemplateLang === 'function')
      ? detectTemplateLang(tpl)
      : { code: '', color: 'oklch(0.60 0.05 250)' };
    item.style.setProperty('--tmpl-lang-color', lang.color);

    const num = document.createElement('div');
    num.className = 'tmpl-lib-num';
    num.textContent = String(n);

    const body = document.createElement('div');
    body.className = 'tmpl-lib-body';
    if (lang.code) {
      const langEl = document.createElement('span');
      langEl.className = 'tmpl-lib-lang';
      langEl.textContent = lang.code;
      body.appendChild(langEl);
    }
    const title = document.createElement('div');
    title.className = 'tmpl-lib-title';
    title.textContent = tpl.title || 'Без названия';
    body.appendChild(title);
    const preview = document.createElement('div');
    preview.className = 'tmpl-lib-preview';
    const txt = String(tpl.text || '');
    preview.textContent = txt.length > 100 ? txt.slice(0, 100) + '…' : txt;
    body.appendChild(preview);

    // Inline edit (pencil) + delete (×) in top-right corner. Fade in on
    // hover so the card looks clean at rest.
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'tmpl-lib-edit';
    edit.title = 'Редактировать шаблон';
    edit.setAttribute('aria-label', 'Редактировать шаблон');
    edit.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (typeof window._showTemplateEditForm === 'function') window._showTemplateEditForm();
      if (els.templateSelect) {
        els.templateSelect.value = tpl.id || '';
        els.templateSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const card = document.getElementById('templates-settings-card');
      if (card && !card.open) card.open = true;
    });

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'tmpl-lib-del';
    del.title = 'Удалить шаблон';
    del.setAttribute('aria-label', 'Удалить шаблон');
    del.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      e.preventDefault();
      const accepted = await showConfirm(
        'Удаление шаблона',
        `Удалить «${tpl.title || 'Без названия'}»?`,
        'Удалить',
        { danger: true },
      );
      if (!accepted) return;
      const response = await window.waDeck.deleteTemplate(tpl.id);
      if (!response?.ok) {
        setStatus(`Шаблон: ${response?.error || 'ошибка удаления'}`);
        return;
      }
      state.templates = Array.isArray(response.templates)
        ? response.templates.map((t) => ({ ...t }))
        : [];
      setStatus('Шаблон удалён');
      try { refreshSettingsMenuSubtitles(); } catch { /* ignore */ }
    });

    item.append(num, body, edit, del);

    // Primary click = insert template text into the active WhatsApp chat.
    // Edit/delete are reached via the inline buttons that stopPropagation.
    const insertToChat = async () => {
      const text = String(tpl.text || '').trim();
      if (!text) {
        setStatus('Шаблон пустой — нечего вставлять');
        return;
      }
      const result = await insertTextIntoActiveChat(text);
      if (!result?.ok) {
        const map = {
          text_required: 'Шаблон пустой',
          no_active_account: 'Выберите аккаунт',
          account_frozen: 'Аккаунт заморожен',
          no_active_chat: 'Откройте нужный чат',
          insert_failed: 'Не удалось вставить',
        };
        setStatus(`Шаблон: ${map[result?.error] || result?.error || 'ошибка вставки'}`);
        return;
      }
      setStatus(`Шаблон вставлен: ${tpl.title || 'Без названия'}`);
    };
    item.addEventListener('click', () => { insertToChat().catch(console.error); });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        insertToChat().catch(console.error);
      }
    });
    return item;
  }

  // Lazy-hydrate a category section: items are only materialized the first
  // time the user expands the <details>. With hundreds of templates spread
  // across multiple categories this keeps the initial render near O(categories)
  // instead of O(templates).
  function hydrateSection(section, items) {
    if (section.dataset.hydrated === '1') return;
    section.dataset.hydrated = '1';
    const frag = document.createDocumentFragment();
    let n = 0;
    for (const tpl of items) {
      n += 1;
      frag.appendChild(buildTemplateItemEl(tpl, n));
    }
    section.appendChild(frag);
  }

  for (const cat of sortedCats) {
    const section = document.createElement('details');
    section.className = 'tmpl-lib-section';
    const items = groups.get(cat);
    items.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ru'));

    const summary = document.createElement('summary');
    summary.className = 'tmpl-lib-section-label';
    const label = document.createElement('span');
    label.className = 'tmpl-lib-section-label-text';
    label.textContent = cat;
    const count = document.createElement('span');
    count.className = 'tmpl-lib-section-count';
    count.textContent = ` (${items.length})`;
    summary.append(label, count);
    section.appendChild(summary);

    // Render on first expand (toggle). Also supports programmatic hydration
    // below (search path / pre-expanded state).
    section.addEventListener('toggle', () => {
      if (section.open) hydrateSection(section, items);
    });

    listEl.appendChild(section);
  }
}

function refreshSettingsMenuSubtitles() {
  // Keep the templates library in sync with state.templates every time
  // subtitles refresh (after save/delete/new).
  try { renderTemplatesLibrary(); } catch { /* ignore */ }

  // Live subtitles under each menu item
  const subs = {
    templates: () => {
      const count = Array.isArray(state.templates) ? state.templates.length : 0;
      const cats = new Set((state.templates || []).map((t) => String(t?.category || '').trim()).filter(Boolean));
      const plural = (n, forms) => forms[n % 10 === 1 && n % 100 !== 11 ? 0 : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2)];
      const tplWord = plural(count, ['шаблон', 'шаблона', 'шаблонов']);
      const catWord = plural(cats.size, ['категория', 'категории', 'категорий']);
      if (!count) return 'нет шаблонов';
      return `${count} ${tplWord}${cats.size ? ` · ${cats.size} ${catWord}` : ''}`;
    },
    schedule: () => {
      return 'очередь · расписание';
    },
    clocks: () => {
      const count = Array.isArray(state.settings?.worldClocks) ? state.settings.worldClocks.length : 0;
      if (!count) return 'нет городов';
      const plural = (n, forms) => forms[n % 10 === 1 && n % 100 !== 11 ? 0 : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? 1 : 2)];
      return `${count} ${plural(count, ['город', 'города', 'городов'])} · авто-обновление`;
    },
    weather: () => {
      const city = String(state.settings?.weatherCity || '—');
      const unit = WaDeckWeatherModule.normalizeWeatherUnit(state.settings?.weatherUnit || 'celsius');
      return `${city} · ${unit === 'fahrenheit' ? '°F' : '°C'}`;
    },
    interface: () => {
      const t = isTranslatorEnabled() ? 'переводчик вкл' : 'переводчик выкл';
      const c = isCrmHoverEnabled() ? 'CRM hover вкл' : 'CRM hover выкл';
      return `${t} · ${c}`;
    },
    notifications: () => 'по аккаунтам',
  };

  document.querySelectorAll('[data-sub]').forEach((el) => {
    const key = el.getAttribute('data-sub');
    const fn = subs[key];
    if (!fn) return;
    try { el.textContent = fn(); } catch { /* ignore */ }
  });

  // "About" block: version / runtime info
  if (els.aboutAppVersion) {
    els.aboutAppVersion.textContent = String(state.runtime?.appVersion || '—');
  }
  if (els.aboutElectronVersion) {
    els.aboutElectronVersion.textContent = String(state.runtime?.electron || '—');
  }
  if (els.aboutChromiumVersion) {
    els.aboutChromiumVersion.textContent = String(state.runtime?.chrome || '—');
  }
}

async function saveSettings() {
  els.saveSettings?.classList.add('is-saving');
  const payload = {
    uiTheme: normalizeTheme(state.settings?.uiTheme || 'dark'),
    weatherCity: WaDeckWeatherModule.normalizeWeatherCity(state.settings?.weatherCity),
    weatherUnit: WaDeckWeatherModule.normalizeWeatherUnit(state.settings?.weatherUnit),
    lastSeenReleaseNotesVersion: String(state.settings?.lastSeenReleaseNotesVersion || '').trim(),
    worldClocks: state.settings?.worldClocks || [],
    translatorEnabled: state.settings?.translatorEnabled !== false,
    crmHoverEnabled: state.settings?.crmHoverEnabled !== false,
    notificationsEnabled: state.settings?.notificationsEnabled !== false,
    translateBatchEnabled: state.settings?.translateBatchEnabled !== false,
    uiTiles: normalizeTileMode(state.settings?.uiTiles),
    // Scene/density UI removed — stored values pass through unchanged.
    uiScene: String(state.settings?.uiScene || 'night'),
    uiDensity: String(state.settings?.uiDensity || 'cozy'),
    tweaksCollapsed: !!state.settings?.tweaksCollapsed,
    hibernateAfterMinutes: getHibernateMinutes(),
    // Без этого поля per-account тумблер «Авто вх.» затирался каждым
    // сохранением настроек (main берёт fallback current и пишет старое).
    autoTranslateAccounts: state.settings?.autoTranslateAccounts || {},
  };

  try {
    const saved = await window.waDeck.saveSettings(payload);
    if (!saved || typeof saved !== 'object') {
      throw new Error('save_settings_failed');
    }
    state.settings = saved;
    state.settings.uiTheme = normalizeTheme(state.settings.uiTheme);
    applySettingsToForm();
    setStatus('Настройки сохранены');
  } catch (error) {
    setStatus(`Не удалось сохранить настройки: ${String(error?.message || error || 'error')}`);
    throw error;
  } finally {
    setTimeout(() => {
      els.saveSettings?.classList.remove('is-saving');
      els.saveSettings?.classList.add('is-saved');
      setTimeout(() => els.saveSettings?.classList.remove('is-saved'), 2000);
    }, 520);
  }
}

async function toggleTheme() {
  const current = normalizeTheme(state.settings?.uiTheme || 'dark');
  const nextTheme = current === 'light' ? 'dark' : 'light';
  applyTheme(nextTheme);

  const result = await window.waDeck.saveSettings({ uiTheme: nextTheme });
  state.settings = {
    ...(state.settings || {}),
    ...(result || {}),
    uiTheme: normalizeTheme(result?.uiTheme || nextTheme),
  };
  applyTheme(state.settings.uiTheme);
  setStatus(`Тема: ${state.settings.uiTheme === 'light' ? 'светлая' : 'тёмная'}`);
}

export {
  normalizeTheme,
  applyTheme,
  renderClocksSettings,
  getTimezoneOptions,
  refreshTweaksFabVisibility,
  isTranslatorEnabled,
  isCrmHoverEnabled,
  getHibernateMinutes,
  applySettingsToForm,
  updatePanelVisibility,
  openSettingsPanel,
  closeSettingsPanel,
  toggleTweaksPopover,
  refreshTweakPills,
  normalizeTileMode,
  applyTileMode,
  showSettingsMenu,
  showSettingsSection,
  renderTemplatesLibrary,
  refreshSettingsMenuSubtitles,
  saveSettings,
  toggleTheme,
};

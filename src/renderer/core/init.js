/* Bootstrap: global error handlers, the init() sequence and startup kick-off.
   Extracted verbatim from renderer.js. */
import { state, els, LITE } from './state.js';
import {
  setStatus,
  showToast,
  trimMapSize,
  runWithBusyButton,
  showConfirm,
  delay,
  formatDateTime,
  nextSendAtLocal,
  applyTemplateVariables,
} from './helpers.js';
import {
  renderAccounts,
  activeAccount,
  selectedWebview,
  setActiveAccount,
  accountById,
  refreshActiveWebview,
} from './accounts.js';
import {
  ensureWebview,
  isWebviewReady,
  safeExecuteInWebview,
  sendWebviewInput,
  insertTextIntoActiveChat,
  applyHibernationSetting,
  applyZoom,
} from './webviews.js';
import { updateHubDashboard, updateToolbarClock, updateHubClocks } from './hub.js';
import {
  normalizeTheme,
  applySettingsToForm,
  updatePanelVisibility,
  renderClocksSettings,
  getHibernateMinutes,
  refreshSettingsMenuSubtitles,
} from './settings.js';
import { handleEscapeUiReset } from './hotkeys.js';
import { bindActions } from './bindings.js';
import { WaDeckWeatherModule } from '../weather.js';
import { WaDeckAutoUpdateModule } from '../auto-update.js';
import { WaDeckUnreadModule } from '../unread.js';
import { WaDeckCrmModule } from '../crm.js';
import { WaDeckCallBriefModule } from '../call-brief.js';
import { WaDeckFavoritesModule } from '../favorites.js';
import { WaDeckImportantModule } from '../important.js';
import { WaDeckScheduleModule } from '../schedule.js';

/* Global error handlers for renderer process */
window.addEventListener('error', (e) => console.error('[renderer] error:', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => console.error('[renderer] unhandled rejection:', e.reason));

let templateController = null;

async function init() {
  /* Startup timing — surfaces where the ~first-launch delay goes (bootstrap IPC
     vs. sidebar paint vs. webview boot). Read with `ELECTRON_ENABLE_LOGGING=1`. */
  const _bootT0 = (window.performance?.now?.() ?? Date.now());
  const _bootMs = () => Math.round((window.performance?.now?.() ?? Date.now()) - _bootT0);
  console.log('[boot] init start');

  /* Guard: detect broken CSS grid from corrupted --sidebar-width (NaNpx etc.) */
  const appRoot = document.getElementById('app-root');
  if (appRoot) {
    const sidebarEl = appRoot.querySelector('.sidebar');
    if (sidebarEl) {
      const sidebarRect = sidebarEl.getBoundingClientRect();
      const appRect = appRoot.getBoundingClientRect();
      if (sidebarRect.width < 40 || sidebarRect.width > 300 || sidebarRect.width >= appRect.width * 0.8) {
        console.warn('[layout] Corrupted sidebar width detected, resetting to default');
        appRoot.style.removeProperty('--sidebar-width');
        localStorage.removeItem('sidebarWidth');
      }
    }
  }

  /* Accessibility: copy title → aria-label for all icon-only buttons */
  document.querySelectorAll('.btn-icon[title]').forEach((btn) => {
    if (!btn.getAttribute('aria-label')) btn.setAttribute('aria-label', btn.title);
  });

  const moduleCtx = { state, els, setStatus, trimMapSize, runWithBusyButton };
  /* База, которая есть в обеих сборках: аккаунты, вкладки, непрочитанные,
     уведомления, погода, часы, автообновление. */
  WaDeckWeatherModule.init(moduleCtx);
  window.WaDeckNotifications?.init?.({ ...moduleCtx, setActiveAccount });
  WaDeckAutoUpdateModule.init(moduleCtx);
  WaDeckUnreadModule.init({ ...moduleCtx, renderAccounts, isWebviewReady, safeExecuteInWebview, updateHubDashboard });

  if (LITE) {
    /* Надстройки в лайте не инициализируем и снимаем их глобальные ссылки.
       Внешние вызовы к ним идут через `window.WaDeckX?.метод?.()` — без
       глобала они молча становятся пустышками, и городить проверки в
       вызывающем коде не нужно. */
    for (const name of ['WaDeckGlobalSearch', 'WaDeckFavoritesModule', 'WaDeckImportantModule',
      'WaDeckUnreadFeed', 'WaDeckPinFeed', 'WaDeckSplitModule', 'WaDeckSignalPanel',
      'WaDeckCrmModule', 'WaDeckCallBriefModule']) {
      try { delete window[name]; } catch { window[name] = undefined; }
    }
  } else {
    window.WaDeckGlobalSearch?.init?.({ ...moduleCtx, isWebviewReady, safeExecuteInWebview });
    WaDeckCrmModule.init({ ...moduleCtx, activeAccount, selectedWebview });
    WaDeckCallBriefModule.init({ ...moduleCtx, activeAccount, selectedWebview });
    WaDeckFavoritesModule.init({ ...moduleCtx, setActiveAccount, isWebviewReady, safeExecuteInWebview });
    WaDeckImportantModule.init({ ...moduleCtx, setActiveAccount, isWebviewReady, safeExecuteInWebview });
    window.WaDeckUnreadFeed?.init?.({ ...moduleCtx, setActiveAccount, isWebviewReady, safeExecuteInWebview });
    WaDeckScheduleModule.init({ ...moduleCtx, trimMapSize, runWithBusyButton, accountById, ensureWebview, isWebviewReady, sendWebviewInput, delay, formatDateTime, nextSendAtLocal, showConfirm, applyTemplateVariables });
    window.WaDeckSplitModule?.init?.(moduleCtx);
    window.WaDeckSignalPanel?.init?.({ ...moduleCtx, setActiveAccount });
    document.getElementById('toggle-split')?.addEventListener('click', () => window.WaDeckSplitModule?.toggle?.());
  }
  if (typeof window.waDeck.onAutoUpdateStatus === 'function' && !state.autoUpdateUnsubscribe) {
    state.autoUpdateUnsubscribe = window.waDeck.onAutoUpdateStatus((payload) => {
      WaDeckAutoUpdateModule.handleAutoUpdateStatus(payload);
    });
  }
  if (typeof window.waDeck.onHostEscape === 'function') {
    if (state.hostEscapeUnsubscribe) state.hostEscapeUnsubscribe();
    state.hostEscapeUnsubscribe = window.waDeck.onHostEscape(() => {
      // The search palette owns Escape while open — don't also reset the UI.
      if (window.WaDeckGlobalSearch?.isOpen?.()) {
        window.WaDeckGlobalSearch.close();
        return;
      }
      // Фокус в host-поле (адрес сплита, поиск) — Escape наш, не гостя
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) {
        try { ae.blur(); } catch { /* ignore */ }
        return;
      }
      const closedSomething = handleEscapeUiReset();
      if (!closedSomething) {
        // Ни один слой дека не был открыт — Esc принадлежит WhatsApp (снять
        // reply-цитату, закрыть поиск чатов). Пробрасываем в активный webview
        // нативным вводом, иначе перехват в main его просто съедает.
        const wv = selectedWebview();
        if (wv && isWebviewReady(wv)) {
          sendWebviewInput(wv, { type: 'keyDown', keyCode: 'Escape' })
            .then(() => sendWebviewInput(wv, { type: 'keyUp', keyCode: 'Escape' }))
            .catch(() => {});
        }
      }
    });
  }
  if (typeof window.waDeck.onHostNextUnread === 'function' && !state.hostNextUnreadUnsubscribe) {
    state.hostNextUnreadUnsubscribe = window.waDeck.onHostNextUnread(() => {
      window.WaDeckUnreadFeed?.jumpToNext?.().catch(() => {});
    });
  }
  if (typeof window.waDeck.onBundleRenamed === 'function') {
    window.waDeck.onBundleRenamed(() => {
      showToast('Приложение переименовано в OmniDeck.app. Если значок в доке пропал — перетащите его туда заново.', 'info', 12000);
    });
  }
  if (typeof window.waDeck.onHostHotkey === 'function' && !state.hostHotkeyUnsubscribe) {
    // Сквозные хоткеи: main перехватывает Cmd+1..9/K/T/R/зум (иначе они мертвы
    // при фокусе в композере WhatsApp) и доставляет сюда одним каналом.
    state.hostHotkeyUnsubscribe = window.waDeck.onHostHotkey(({ code }) => {
      const c = String(code || '');
      if (c === 'F1') { window.WaDeckHelp?.toggle?.(); return; }
      const hostInputFocused = (() => {
        const a = document.activeElement;
        return Boolean(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
      })();
      const digit = /^(?:Digit|Numpad)([0-9])$/.exec(c);
      if (digit) {
        const n = Number(digit[1]);
        if (n === 0) { applyZoom(100); return; }
        const account = state.accounts[n - 1];
        if (account) setActiveAccount(account.id);
        return;
      }
      if (c === 'KeyK') { window.WaDeckGlobalSearch?.toggle?.(); return; }
      if (c === 'KeyT') {
        if (!hostInputFocused) window.__waDeckOpenTemplatesDrawer?.();
        return;
      }
      if (c === 'KeyR') {
        if (!hostInputFocused) refreshActiveWebview();
        return;
      }
      if (c === 'Equal' || c === 'NumpadAdd') { applyZoom((Number(els.zoomSlider?.value) || 100) + 10); return; }
      if (c === 'Minus' || c === 'NumpadSubtract') { applyZoom((Number(els.zoomSlider?.value) || 100) - 10); }
    });
  }

  /* Webview crash recovery — reload crashed webview and update status */
  if (typeof window.waDeck.onWebviewCrashed === 'function') {
    window.waDeck.onWebviewCrashed((payload) => {
      console.warn('[webview-crashed]', payload.reason);
      setStatus(`Webview упал (${payload.reason}). Перезагрузка...`);
      // Сплит-браузер — тоже webview, но не в state.webviews
      if (window.WaDeckSplitModule?.reloadIfCrashed?.(payload.webContentsId)) return;
      // main передаёт id упавшего contents: старый «getWebContentsId бросит»
      // в новых Electron не работает — метод возвращает id и после краша
      for (const [accountId, webview] of state.webviews) {
        try {
          if (!webview || !webview.isConnected) continue;
          const wcId = typeof webview.getWebContentsId === 'function' ? webview.getWebContentsId() : -1;
          if (payload.webContentsId && wcId !== payload.webContentsId) continue;
          console.warn('[webview-crashed] reloading', accountId);
          try { webview.reload(); } catch { /* already dead */ }
        } catch {
          console.warn('[webview-crashed] reloading (getWebContentsId threw)', accountId);
          try { webview.reload(); } catch { /* already dead */ }
        }
      }
    });
  }

  /* System wake-up: after a long laptop sleep WhatsApp Web sessions go zombie
     (socket alive on our side, server already dropped). Stagger soft reloads
     across all webviews so we do not hammer the disk and network at once. */
  if (typeof window.waDeck.onSystemResumed === 'function') {
    window.waDeck.onSystemResumed((payload) => {
      const minutes = Math.round((payload?.suspendedMs || 0) / 60000);
      console.log(`[power] resumed after ~${minutes} min, staggering reloads`);
      setStatus(`Система проснулась (${minutes} мин сна) — обновляю аккаунты…`);
      const entries = Array.from(state.webviews.entries());
      let i = 0;
      for (const [accountId, webview] of entries) {
        const delay = i * 250; // 250ms between reloads — never N parallel
        i++;
        setTimeout(() => {
          if (!webview || !webview.isConnected) return;
          try {
            webview.reload();
          } catch (err) {
            console.warn('[power] reload failed for', accountId, err?.message || err);
          }
        }, delay);
      }
    });
  }

  const boot = await window.waDeck.bootstrap();
  console.log(`[boot] bootstrap IPC resolved +${_bootMs()}ms (${(boot.accounts || []).length} accounts)`);
  state.accounts = Array.isArray(boot.accounts) ? boot.accounts : [];
  state.settings = {
    uiTheme: normalizeTheme(boot.settings?.uiTheme || 'dark'),
    weatherCity: WaDeckWeatherModule.normalizeWeatherCity(boot.settings?.weatherCity || 'Moscow'),
    weatherUnit: WaDeckWeatherModule.normalizeWeatherUnit(boot.settings?.weatherUnit || 'celsius'),
    lastSeenReleaseNotesVersion: String(boot.settings?.lastSeenReleaseNotesVersion || ''),
    translatorEnabled: boot.settings?.translatorEnabled !== false,
    crmHoverEnabled: boot.settings?.crmHoverEnabled !== false,
    notificationsEnabled: boot.settings?.notificationsEnabled !== false,
    translateBatchEnabled: boot.settings?.translateBatchEnabled !== false,
    uiScene: String(boot.settings?.uiScene || 'night'),
    uiDensity: String(boot.settings?.uiDensity || 'cozy'),
    tweaksCollapsed: !!boot.settings?.tweaksCollapsed,
    // Эти три поля НЕ переносились из boot → сбрасывались каждым запуском и
    // первым же saveSettings затирались в store (гибернация «выключалась сама»,
    // uiTiles слетал в raw, персист автоперевода был мёртв).
    uiTiles: String(boot.settings?.uiTiles || 'raw'),
    hibernateAfterMinutes: Number(boot.settings?.hibernateAfterMinutes) || 0,
    autoTranslateAccounts: (boot.settings?.autoTranslateAccounts && typeof boot.settings.autoTranslateAccounts === 'object')
      ? { ...boot.settings.autoTranslateAccounts }
      : {},
    worldClocks: Array.isArray(boot.settings?.worldClocks) ? boot.settings.worldClocks : [
      { label: 'Москва', tz: 'Europe/Moscow' },
      { label: 'Киев', tz: 'Europe/Kiev' },
      { label: 'Берлин', tz: 'Europe/Berlin' },
    ],
  };
  state.templates = Array.isArray(boot.templates) ? boot.templates.map((tpl) => ({ ...tpl })) : [];
  state.templateUsage = (boot.templateUsage && typeof boot.templateUsage === 'object') ? { ...boot.templateUsage } : {};
  state.favorites = Array.isArray(boot.favorites) ? boot.favorites.map((f) => ({ ...f })) : [];
  state.important = Array.isArray(boot.important) ? boot.important.map((f) => ({ ...f })) : [];
  state.runtime = boot.runtime || {};
  state.runtime.appVersion = String(boot.appVersion || state.runtime.appVersion || '').trim();

  // One-time application of the legacy scene/density attributes (the picker
  // UI was removed) so CSS that still targets them keeps the current look.
  document.documentElement.setAttribute('data-scene', state.settings.uiScene || 'night');
  document.documentElement.setAttribute('data-density', state.settings.uiDensity || 'cozy');

  // Render sidebar immediately so accounts are visible right away
  renderAccounts();
  console.log(`[boot] sidebar painted +${_bootMs()}ms`);

  // Staged background load: очередь с ограничением параллелизма вместо
  // фиксированного шага в 400мс. Каждый WhatsApp Web грузится 5–15с и ест CPU:
  // при 10+ аккаунтах фиксированный шаг наслаивал загрузки, машина
  // захлёбывалась и ВСЕ аккаунты грузились дольше. Теперь одновременно
  // грузятся максимум LOAD_CONCURRENCY, следующий стартует по did-finish-load
  // предыдущего; страховочный таймаут — зависший аккаунт не блокирует очередь.
  // Приоритет: аккаунты с «Важными» чатами → с «Избранными» → остальные,
  // внутри группы — порядок сайдбара.
  //
  // Note: all webviews stay alive for the lifetime of the app — idle-suspend
  // was removed because it caused WhatsApp accounts to drop messages while
  // suspended and forced users to re-click each account to reload WA Web.
  const LOAD_CONCURRENCY = 3;
  const SLOT_TIMEOUT_MS = 20000;
  const accountPriority = (acc) => {
    if ((state.important || []).some((f) => f.accountId === acc.id)) return 0;
    if ((state.favorites || []).some((f) => f.accountId === acc.id)) return 1;
    return 2;
  };
  const bootQueue = state.accounts
    .map((acc, idx) => ({ acc, idx }))
    .sort((a, b) => (accountPriority(a.acc) - accountPriority(b.acc)) || (a.idx - b.idx))
    .map((entry) => entry.acc);
  let bootQueuePos = 0;
  const launchNextWebview = () => {
    if (bootQueuePos >= bootQueue.length) return;
    const account = bootQueue[bootQueuePos];
    bootQueuePos += 1;
    let slotDone = false;
    const releaseSlot = () => {
      if (slotDone) return;
      slotDone = true;
      clearTimeout(slotGuard);
      launchNextWebview();
    };
    const slotGuard = setTimeout(releaseSlot, SLOT_TIMEOUT_MS);
    try {
      ensureWebview(account);
      const wv = state.webviews.get(account.id);
      if (wv) {
        wv._lastActive = Date.now();
        wv.addEventListener('did-finish-load', releaseSlot, { once: true });
        wv.addEventListener('did-fail-load', releaseSlot, { once: true });
      } else {
        releaseSlot();
      }
    } catch (err) {
      console.error(`[init] failed to create webview for ${account.id}:`, err);
      releaseSlot();
    }
  };
  for (let i = 0; i < LOAD_CONCURRENCY; i += 1) launchNextWebview();

  state.startupHubVisible = true;
  if (state.startupHubTimeoutId) {
    clearTimeout(state.startupHubTimeoutId);
    state.startupHubTimeoutId = null;
  }

  // Стартуем всегда в хабе без активного WhatsApp.
  setActiveAccount('');
  updatePanelVisibility();
  applySettingsToForm({ renderWeather: true });
  /* Стартовая подготовка форм надстроек. В лайте их модули не подняты, и
     первый же такой вызов ронял init ДО bindActions() — внешне это выглядело
     как «кнопки не работают» плюс «Ошибка запуска» в статусной строке. */
  if (!LITE) {
    WaDeckScheduleModule.renderAttachmentsDraft();
    WaDeckScheduleModule.renderScheduleTarget();
    els.crmContactName.value = '';
    els.crmAbout.value = '';
    els.crmMyInfo.value = '';
    els.crmMeta.textContent = 'Файл: —';
    WaDeckCrmModule.setCrmEditable(false);
  }
  if (!LITE && window.WaDeckTemplatesModule?.createTemplateController) {
    templateController = window.WaDeckTemplatesModule.createTemplateController({
      state,
      els,
      setStatus,
      insertTextToActiveChat: insertTextIntoActiveChat,
      // Notify the settings palette whenever templates change so that
      // newly-added categories show up in the library list immediately
      // (without needing an app restart).
      onChange: () => {
        try { refreshSettingsMenuSubtitles(); } catch (e) { console.warn('[tmpl:onChange]', e); }
      },
    });
    await templateController.init(state.templates);
  }

  if (!LITE) els.scheduleAt.value = nextSendAtLocal(1);
  /* renderScheduled() already called via setActiveAccount → _setActiveAccountInner */

  bindActions();
  WaDeckWeatherModule.startWeatherRefreshLoop();
  WaDeckWeatherModule.refreshWeather().catch((e) => console.warn('[weather]', e));
  WaDeckUnreadModule.startUnreadPolling();
  WaDeckUnreadModule.scheduleDockBadgeSync();
  if (!LITE) {
    WaDeckScheduleModule.startScheduleRunner();
    WaDeckFavoritesModule.startFavoritePolling();
    WaDeckImportantModule.startImportantPolling();
  }
  // Idle-suspend disabled: destroying inactive webviews after 15 min forced
  // users to re-click every account to reload WhatsApp Web, which in turn
  // missed incoming messages while suspended. Keeping all webviews alive for
  // the lifetime of the app is the correct trade-off for the 10–20 account
  // use case. The opt-in hibernation setting covers low-RAM/30+ account needs.
  renderClocksSettings();
  // Toolbar clock — update immediately and every 15s
  updateToolbarClock();
  // Hub clock auto-refresh every 30s
  if (!state._hubClockTimer) {
    state._hubClockTimer = setInterval(() => {
      updateToolbarClock();
      const hs = document.getElementById('hub-screen');
      if (hs && !hs.classList.contains('hidden')) updateHubClocks();
    }, 30000);
  }
  // Hibernation: applied based on the persisted setting. Default 0 = off,
  // so this is a no-op for users who haven't opted in.
  applyHibernationSetting(getHibernateMinutes());
  WaDeckAutoUpdateModule.maybeShowReleaseNotes().catch(console.error);

  setStatus('');
  console.log(`[boot] init complete +${_bootMs()}ms (webviews creating in background, +${state.accounts.length * 400}ms staggered)`);
}

init().catch((error) => {
  setStatus(`Ошибка запуска: ${String(error?.message || error)}`);
});

export { templateController };

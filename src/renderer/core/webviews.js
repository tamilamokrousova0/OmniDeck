/* Webview lifecycle: creation/cleanup, readiness, safe script execution,
   guest-message dispatch, zoom, hibernation, translator/CRM-hover toggles,
   chat text insertion and voice messages. Extracted verbatim from renderer.js. */
import { state, els, WADECK_WV_TOKEN } from './state.js';
import {
  setStatus,
  showToast,
  escapeForJsSingleQuoted,
  delay,
  TEMPLATE_VAR_RE,
  applyTemplateVariables,
} from './helpers.js';
import { accountById, selectedWebview, activeAccount, updateAccountCardStatus } from './accounts.js';
import { setHubVisibility, updateHubDashboard } from './hub.js';
import { isTranslatorEnabled, isCrmHoverEnabled, refreshTweaksFabVisibility, saveSettings } from './settings.js';
import { handleCrmHover, hideCrmHoverPopover } from './crm-hover.js';
import { WaDeckUnreadModule } from '../unread.js';
import { WaDeckScheduleModule } from '../schedule.js';
import { keepAliveScript } from '../webview-scripts/keep-alive.js';
import { tgBadgeInterceptScript } from '../webview-scripts/tg-unread.js';
import { bridgeScript } from '../webview-scripts/bridge.js';
import { crmHoverBridgeScript } from '../webview-scripts/crm-hover-bridge.js';
import { translatorBarScript } from '../webview-scripts/translator-bar.js';
import { slashTemplatesScript } from '../webview-scripts/slash-templates.js';
import { voiceTranscribeButtonsScript } from '../webview-scripts/voice-transcribe-buttons.js';
import { insertTextScript } from '../webview-scripts/insert-text.js';
import { humanTypeScript } from '../webview-scripts/human-type.js';
import { activeChatContactScript } from '../webview-scripts/active-chat-contact.js';
import {
  voiceMessageSetupScript,
  voiceMessageWaitScript,
  voiceMessageCleanupScript,
} from '../webview-scripts/voice-message.js';

/* ── Zoom Control ── */

/* Автоперевод входящих умирает молча: пузырь без оверлея неотличим от
   «перевод не нужен», а сломанный API убивает переводы во всех webview разом.
   5 фейлов подряд — один тост, троттл 5 минут. */
let _autoTrFailStreak = 0;
let _autoTrLastToastAt = 0;
function noteAutoTranslateResult(ok) {
  if (ok) { _autoTrFailStreak = 0; return; }
  _autoTrFailStreak += 1;
  const now = Date.now();
  if (_autoTrFailStreak >= 5 && now - _autoTrLastToastAt > 5 * 60 * 1000) {
    _autoTrLastToastAt = now;
    showToast('Переводчик: входящие не переводятся (сеть или лимит API)', 'error', 6000);
  }
}

/* ── Умный порядок слэш-шаблонов ─────────────────────────────────────────
 * Учёт использования (title → {c: счётчик, t: последний раз}) живёт в store
 * (persist через IPC template-used) и зеркалится в state.templateUsage. */
function recordTemplateUsage(titleRaw) {
  const title = String(titleRaw || '').trim();
  if (!title) return;
  state._lastTemplateTitle = title;
  const key = title.toLowerCase();
  if (!state.templateUsage || typeof state.templateUsage !== 'object') state.templateUsage = {};
  const rec = state.templateUsage[key] || { c: 0, t: 0 };
  rec.c = (Number(rec.c) || 0) + 1;
  rec.t = Date.now();
  state.templateUsage[key] = rec;
  window.waDeck.templateUsed?.({ title }).catch(() => {});
}

/* Порядок «/»-списка: сначала шаблоны языка контакта (код в названии или
 * категории: «1de», «NL_morning»), затем по частоте, затем по свежести,
 * хвост — исходный порядок. */
function sortTemplatesForChat(list, lang) {
  const usage = state.templateUsage || {};
  let langRe = null;
  if (lang && /^[a-z]{2}/.test(lang)) {
    const code = lang.slice(0, 2);
    try { langRe = new RegExp('(^|[^a-z])' + code + '([^a-z]|$)', 'i'); } catch { langRe = null; }
  }
  return list
    .map((tpl, i) => {
      const u = usage[String(tpl.title || '').trim().toLowerCase()] || {};
      const langHit = langRe && (langRe.test(tpl.title || '') || langRe.test(tpl.category || '')) ? 1 : 0;
      return { tpl, i, langHit, c: Number(u.c) || 0, t: Number(u.t) || 0 };
    })
    .sort((a, b) => (b.langHit - a.langHit) || (b.c - a.c) || (b.t - a.t) || (a.i - b.i))
    .map((x) => x.tpl);
}

function applyZoom(percent) {
  const acc = activeAccount();
  if (acc?.type === 'signal') return; // у Signal-панели нет webview — масштабировать нечего
  const clamped = Math.max(50, Math.min(150, Math.round(percent / 5) * 5));
  const wv = selectedWebview();
  if (wv) {
    try { wv.setZoomFactor(clamped / 100); } catch { /* ignore */ }
  }
  if (state.activeAccountId) {
    state.zoomByAccount.set(state.activeAccountId, clamped);
  }
  if (els.zoomSlider) els.zoomSlider.value = String(clamped);
  if (els.zoomValue) els.zoomValue.textContent = clamped + '%';
}

function syncZoomSlider() {
  const id = state.activeAccountId;
  let zoom = 100;
  if (id) {
    const stored = state.zoomByAccount.get(id);
    const wv = state.webviews.get(id);
    if (stored) {
      // The stored preference wins: reading the live factor back here used to
      // overwrite it with 100 right after any reload, destroying the setting.
      zoom = stored;
      if (wv) {
        try {
          const actual = Number(wv.getZoomFactor?.()) || 1;
          if (Math.round(actual * 100) !== zoom) wv.setZoomFactor(zoom / 100);
        } catch { /* ignore */ }
      }
    } else if (wv) {
      try {
        const actual = wv.getZoomFactor?.();
        if (actual && Number.isFinite(actual)) zoom = Math.round(actual * 100);
      } catch { /* ignore */ }
      state.zoomByAccount.set(id, zoom);
    }
  }
  if (els.zoomSlider) els.zoomSlider.value = String(zoom);
  if (els.zoomValue) els.zoomValue.textContent = zoom + '%';
}

// Debug helper — run from main-window DevTools: await window.__wadeckProbeChat()
// Probes the active WhatsApp webview DOM so we can find how WA Web labels
// the currently open chat on the current build.
window.__wadeckProbeChat = async function () {
  const wv = selectedWebview();
  if (!wv) return 'NO_ACTIVE_WEBVIEW';
  const script = `(() => {
    const out = {};
    out.headers = Array.from(document.querySelectorAll('header')).map((h, i) => {
      const r = h.getBoundingClientRect();
      return { i, w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), top: Math.round(r.top), text: (h.innerText||'').slice(0, 150) };
    });
    const compose =
      document.querySelector('footer [contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][data-tab]') ||
      document.querySelector('[contenteditable="true"][role="textbox"]');
    out.composeFound = !!compose;
    if (compose) {
      // Walk up from compose and find the nearest header above it in the tree
      let node = compose;
      let hops = 0;
      while (node && hops < 20) {
        const h = node.querySelector ? node.querySelector('header') : null;
        if (h) { out.chatPaneHeader = (h.innerText||'').slice(0,150); break; }
        node = node.parentElement; hops++;
      }
    }
    // Try to locate the chat list (renamed away from #pane-side)
    const probes = ['#pane-side','[aria-label="Chat list"]','[aria-label="Список чатов"]','[aria-label*="Chat"]','div[role="grid"]','div[role="list"]','[data-testid*="chat-list"]','nav[aria-label]'];
    out.listProbes = probes.map((s) => ({ s, count: document.querySelectorAll(s).length }));
    // Find any element with "selected" / "current" aria
    const ariaSel = Array.from(document.querySelectorAll('[aria-selected="true"]')).slice(0, 5).map((el) => ({ tag: el.tagName, text: (el.innerText||'').slice(0,80) }));
    const ariaCur = Array.from(document.querySelectorAll('[aria-current="page"], [aria-current="true"]')).slice(0, 5).map((el) => ({ tag: el.tagName, text: (el.innerText||'').slice(0,80) }));
    out.ariaSelected = ariaSel;
    out.ariaCurrent = ariaCur;
    return out;
  })();`;
  try {
    const result = await wv.executeJavaScript(script, true);
    console.log('[wadeck probe]', JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    console.error('[wadeck probe] failed:', err);
    return { error: String(err) };
  }
};

function cleanupWebview(webview) {
  if (!webview) return;
  // Remove ALL stored event listeners to prevent memory leaks
  if (webview._wadeckListeners) {
    const L = webview._wadeckListeners;
    if (L.onDomReady) webview.removeEventListener('dom-ready', L.onDomReady);
    if (L.onNavigateInPage) webview.removeEventListener('did-navigate-in-page', L.onNavigateInPage);
    if (L.onStartLoading) webview.removeEventListener('did-start-loading', L.onStartLoading);
    if (L.onFinishLoad) webview.removeEventListener('did-finish-load', L.onFinishLoad);
    if (L.onFailLoad) webview.removeEventListener('did-fail-load', L.onFailLoad);
    if (L.onPageTitle) webview.removeEventListener('page-title-updated', L.onPageTitle);
    if (L.onConsoleMessage) webview.removeEventListener('console-message', L.onConsoleMessage);
    if (L.onIpcMessage) webview.removeEventListener('ipc-message', L.onIpcMessage);
    if (L.cancelBindDomTimer) L.cancelBindDomTimer();
    webview._wadeckListeners = null;
  }
  if (webview.parentNode) {
    webview.parentNode.removeChild(webview);
  }
}

function ensureWebview(account) {
  // Bail if the account no longer exists (e.g. removed during the staggered
  // startup loop) — otherwise we'd create an orphan webview with a live
  // WhatsApp session that renderAccounts() never shows.
  if (!account || !accountById(account.id)) return;
  if (account.frozen) return;
  if (account.type === 'signal') return; // нет веб-клиента — панель вместо webview
  if (state.webviews.has(account.id)) return;

  const isWhatsApp = account.type !== 'telegram';

  const webview = document.createElement('webview');
  webview.partition = account.partition;
  webview.src = account.url;
  // Custom user-agent only for WhatsApp
  if (isWhatsApp && state.runtime?.waUserAgent) {
    webview.setAttribute('useragent', state.runtime.waUserAgent);
  }
  /* allowpopups ОБЯЗАТЕЛЕН: без него Chromium глушит window.open внутри
     webview на корню, и setWindowOpenHandler в main не срабатывает — клик по
     ссылке в чате не делал вообще ничего. Окно при этом никогда не создаётся:
     наш обработчик всегда возвращает deny и сам решает, куда открыть ссылку. */
  webview.setAttribute('allowpopups', 'true');
  // backgroundThrottling=false is the third layer of our keep-alive fix.
  // See comments at the top of main.js — without this, hidden webviews
  // (display:none in styles.css) get their timers throttled to 1/min after
  // ~5 minutes, which kills the WhatsApp Web WebSocket heartbeat.
  webview.setAttribute('webpreferences', 'contextIsolation=yes,backgroundThrottling=no');
  webview.dataset.waReady = '0';
  webview.dataset.accountType = account.type || 'whatsapp';

  const accountId = account.id;
  const currentAccount = () => accountById(accountId) || account;

  const onStartLoading = () => {
    if (_domReadyFired) {
      // A full main-frame reload (refresh button, crash recovery, resume
      // stagger) tears the page down — waReady must drop so templates/voice
      // commands don't target a half-dead DOM. Sub-frame loads (Telegram's
      // internal iframe churn) keep the ready state.
      let mainFrame = true;
      try {
        mainFrame = typeof webview.isLoadingMainFrame === 'function' ? webview.isLoadingMainFrame() : true;
      } catch { /* ignore */ }
      if (mainFrame) {
        webview.dataset.waReady = '0';
        updateAccountCardStatus(accountId);
      }
      return;
    }
    webview.dataset.waReady = '0';
    updateAccountCardStatus(accountId);
    if (accountId === state.activeAccountId) {
      setStatus(`${currentAccount().name}: загрузка...`);
    }
  };

  const onFinishLoad = () => {
    webview.dataset.waReady = '1';
    updateAccountCardStatus(accountId);
    if (accountId === state.activeAccountId) {
      if (state.startupHubVisible) {
        state.startupHubVisible = false;
        if (state.startupHubTimeoutId) {
          clearTimeout(state.startupHubTimeoutId);
          state.startupHubTimeoutId = null;
        }
      }
      showWebviewLoading(false);
      refreshWebviewVisibility();
      setStatus(`${currentAccount().name}: готово`);
    }
    // Re-inject translator bar after full page reload. Full reload creates a fresh
    // JS context, so the __waDeckTranslatorBound guard is already undefined and the
    // IIFE will init normally. Do NOT reset the flag — doing so would run a second
    // IIFE on top of an already-alive one (when WhatsApp does an internal reload
    // that preserves context), duplicating the bar.
    if (isWhatsApp && isTranslatorEnabled() && typeof translatorBarScript === 'function') {
      webview.executeJavaScript(translatorBarScript(WADECK_WV_TOKEN), true)
        .catch((e) => console.warn('[translator-reload]', e));
    }
    if (isWhatsApp && typeof slashTemplatesScript === 'function') {
      webview.executeJavaScript(slashTemplatesScript(WADECK_WV_TOKEN), true)
        .catch((e) => console.warn('[slash-templates-reload]', e));
    }
    if (isWhatsApp && typeof voiceTranscribeButtonsScript === 'function') {
      webview.executeJavaScript(voiceTranscribeButtonsScript(WADECK_WV_TOKEN), true)
        .catch((e) => console.warn('[voice-buttons-reload]', e));
    }
  };

  const onFailLoad = (event) => {
    // Субфреймы (аналитика WA) и ERR_ABORTED/-21 (наш же reload, смена сети)
    // не должны валить waReady живого аккаунта в 0
    if (event && (event.isMainFrame === false || event.errorCode === -3 || event.errorCode === -21)) return;
    webview.dataset.waReady = '0';
    updateAccountCardStatus(accountId);
    if (accountId === state.activeAccountId) {
      showWebviewLoading(false);
      if (state.startupHubVisible) {
        state.startupHubVisible = false;
      }
      refreshWebviewVisibility();
    }
  };

  const onPageTitle = (event) => {
    // Только WhatsApp: у Telegram Web A заголовок — имя открытого чата или
    // «Telegram», счётчика там нет, а «(3)» в имени чата дало бы ложный бейдж.
    // Счётчик TG идёт через перехват setAppBadge (см. tg-unread.js).
    if (!isWhatsApp) return;
    const title = String(event?.title || '');
    const count = WaDeckUnreadModule.parseUnreadFromTitle(title);
    WaDeckUnreadModule.setUnreadCount(accountId, count);
  };

  webview.addEventListener('did-start-loading', onStartLoading);
  webview.addEventListener('did-finish-load', onFinishLoad);
  webview.addEventListener('did-fail-load', onFailLoad);
  webview.addEventListener('page-title-updated', onPageTitle);

  let _bindDomTimer = null;
  let _domReadyFired = false;

  const onDomReady = () => {
    webview.dataset.waReady = '1';
    _domReadyFired = true;

    // A reload resets the actual zoom factor to 100% — re-assert the
    // per-account preference, otherwise every refresh/crash-recovery
    // silently discards the user's zoom.
    const savedZoom = state.zoomByAccount.get(accountId);
    if (savedZoom && savedZoom !== 100) {
      try { webview.setZoomFactor(savedZoom / 100); } catch { /* ignore */ }
    }

    // Keep-alive visibility spoof — runs for BOTH WhatsApp and Telegram so
    // neither app voluntarily pauses its WebSocket while hidden behind
    // another active account. Must run before any other inject.
    if (typeof keepAliveScript === 'function') {
      webview.executeJavaScript(keepAliveScript(), true)
        .catch((e) => console.warn('[keep-alive]', e));
    }

    // Telegram: перехват navigator.setAppBadge — источник счётчика
    // непрочитанных (см. tg-unread.js). Идемпотентен, повторный инжект
    // после reload безопасен.
    if (!isWhatsApp && typeof tgBadgeInterceptScript === 'function') {
      webview.executeJavaScript(tgBadgeInterceptScript(), true)
        .catch((e) => console.warn('[tg-badge]', e));
    }

    // WhatsApp-specific script injection
    if (isWhatsApp) {
      if (typeof webview.setUserAgent === 'function' && state.runtime?.waUserAgent) {
        webview.setUserAgent(state.runtime.waUserAgent);
      }

      webview
        .executeJavaScript(bridgeScript(WADECK_WV_TOKEN), true)
        .catch((e) => console.warn('[bridge]', e));

      if (isCrmHoverEnabled() && typeof crmHoverBridgeScript === 'function') {
        webview.executeJavaScript(crmHoverBridgeScript(WADECK_WV_TOKEN), true).catch((e) => console.warn('[crm-hover]', e));
      }
      if (isTranslatorEnabled() && typeof translatorBarScript === 'function') {
        webview.executeJavaScript(translatorBarScript(WADECK_WV_TOKEN), true).catch((e) => console.warn('[translator]', e));
      }
      if (typeof slashTemplatesScript === 'function') {
        webview.executeJavaScript(slashTemplatesScript(WADECK_WV_TOKEN), true).catch((e) => console.warn('[slash-templates]', e));
      }
      if (typeof voiceTranscribeButtonsScript === 'function') {
        webview.executeJavaScript(voiceTranscribeButtonsScript(WADECK_WV_TOKEN), true).catch((e) => console.warn('[voice-buttons]', e));
      }
    }

    // Debounced status update on initial load (no full sidebar rebuild)
    if (_bindDomTimer) clearTimeout(_bindDomTimer);
    _bindDomTimer = setTimeout(() => {
      _bindDomTimer = null;
      updateAccountCardStatus(accountId);
      updateHubDashboard();
    }, 300);
  };

  const onNavigateInPage = () => {
    if (!_domReadyFired) return;

    webview.dataset.waReady = '1';

    // Only WhatsApp needs script re-injection after SPA navigation
    if (!isWhatsApp) {
      updateAccountCardStatus(accountId);
      return;
    }

    webview
      .executeJavaScript(bridgeScript(WADECK_WV_TOKEN), true)
      .catch((e) => console.warn('[bridge]', e));

    if (isCrmHoverEnabled() && typeof crmHoverBridgeScript === 'function') {
      webview.executeJavaScript(crmHoverBridgeScript(WADECK_WV_TOKEN), true).catch((e) => console.warn('[crm-hover]', e));
    }
    if (isTranslatorEnabled() && typeof translatorBarScript === 'function') {
      webview.executeJavaScript(translatorBarScript(WADECK_WV_TOKEN), true).catch((e) => console.warn('[translator]', e));
    }
    if (typeof slashTemplatesScript === 'function') {
      webview.executeJavaScript(slashTemplatesScript(WADECK_WV_TOKEN), true).catch((e) => console.warn('[slash-templates]', e));
    }

    // Debounced status update — prevents excessive re-renders on SPA navigation
    if (_bindDomTimer) clearTimeout(_bindDomTimer);
    _bindDomTimer = setTimeout(() => {
      _bindDomTimer = null;
      updateAccountCardStatus(accountId);
      updateHubDashboard();
    }, 800);
  };

  let onConsoleMessage = null;
  let onIpcMessage = null;
  if (isWhatsApp) {
    /* One dispatcher, two transports. Kinds: CRM_HOVER, GET_LANG, SET_LANG,
       TRANSLATE_MSG, TRANSLATE, HEALTH. Payloads arrive as JSON strings. */
    const dispatchGuestMessage = (kind, jsonStr) => {
      // Always resolve the FRESH account object: the closure-captured one goes
      // stale after rename (old name would leak into CRM lookups/saves).
      const acc = currentAccount();
      let payload;
      try {
        payload = JSON.parse(String(jsonStr || ''));
      } catch {
        return; // ignore parse errors
      }
      if (!payload || typeof payload !== 'object') return;

      if (kind === 'CRM_HOVER') {
        handleCrmHover(acc, webview, payload);
        return;
      }
      if (kind === 'GET_LANG') {
        const reqId = String(payload.reqId || '').replace(/[^a-zA-Z0-9_]/g, '');
        const chatName = String(payload.chatId || '');
        if (!reqId || !chatName) return;
        window.waDeck.getContactLang({ accountId: acc.id, chatName }).then((res) => {
          const lang = (res && res.ok && res.lang) ? String(res.lang).replace(/[^a-z-]/gi, '').slice(0, 10) : '';
          safeExecuteInWebview(webview, `if (window.__waDeckLangCb_${reqId}) window.__waDeckLangCb_${reqId}('${lang}');`);
        }).catch(() => {});
        return;
      }
      if (kind === 'SET_LANG') {
        const chatName = String(payload.chatId || '');
        const lang = String(payload.lang || '');
        if (!chatName) return;
        window.waDeck.setContactLang({ accountId: acc.id, chatName, lang }).catch(() => {});
        return;
      }
      if (kind === 'GET_AUTO_TR') {
        const reqId = String(payload.reqId || '').replace(/[^a-zA-Z0-9_]/g, '');
        if (!reqId) return;
        const on = Boolean(state.settings?.autoTranslateAccounts?.[acc.id]);
        safeExecuteInWebview(webview, `if (window.__waDeckAutoTrCb_${reqId}) window.__waDeckAutoTrCb_${reqId}(${on ? 'true' : 'false'});`);
        return;
      }
      if (kind === 'SET_AUTO_TR') {
        if (!state.settings) return;
        const map = state.settings.autoTranslateAccounts || (state.settings.autoTranslateAccounts = {});
        if (payload.on) map[acc.id] = true; else delete map[acc.id];
        saveSettings().catch(() => {});
        return;
      }
      if (kind === 'TRANSLATE_MSG') {
        // Gate on the live setting: a guest script that survived the toggle-off
        // (or a compromised page) must not keep burning paid translate calls.
        if (!isTranslatorEnabled()) return;
        const reqId = String(payload.reqId || '').replace(/[^a-zA-Z0-9_]/g, '');
        if (!reqId) return;
        const cbName = '__waDeckTrCb_' + reqId;
        const finish = (result) => {
          const ok = Boolean(result?.ok && result.translated);
          const escaped = ok ? escapeForJsSingleQuoted(result.translated) : '';
          // detected — определённый язык источника: питает автоопределение
          // языка контакта на guest-стороне (translator-bar).
          const det = ok ? String(result.detected || '').replace(/[^a-z-]/gi, '').slice(0, 10) : '';
          const script = ok
            ? `if (window.${cbName}) window.${cbName}({ ok: true, translated: '${escaped}', detected: '${det}' });`
            : `if (window.${cbName}) window.${cbName}({ ok: false });`;
          safeExecuteInWebview(webview, script);
          noteAutoTranslateResult(ok);
        };
        window.waDeck.translateText({
          text: String(payload.text || ''),
          from: String(payload.from || 'auto'),
          to: String(payload.to || 'ru'),
          batch: true, // автоперевод входящих — батчится в main (если включено)
        }).then(finish).catch(() => finish({ ok: false }));
        return;
      }
      if (kind === 'TRANSLATE') {
        // Кнопка «Перевести»: перевод текста композера с заменой; отправка ручная.
        const replaceAll = Boolean(payload.replaceAll);
        window.waDeck.translateText(payload).then((result) => {
          if (!(result?.ok && result.translated)) {
            showToast('Перевод не удался — текст не изменён', 'error', 4000);
            console.warn('[translate] failed:', result?.error || 'no_result');
            return;
          }
          const escaped = escapeForJsSingleQuoted(result.translated);
          safeExecuteInWebview(
            webview,
            `window.__waDeckInsertTranslation('${escaped}', ${replaceAll ? 'true' : 'false'});`
          );
        }).catch((err) => {
          showToast('Перевод не удался — текст не изменён', 'error', 4000);
          console.warn('[translate] failed:', err?.message || 'exception');
        });
        return;
      }
      if (kind === 'INSERT_TEMPLATE') {
        recordTemplateUsage(String(payload.title || ''));
        nativeReplaceComposer(webview, String(payload.text || '')).catch(() => {});
        return;
      }
      if (kind === 'REPEAT_LAST_TEMPLATE') {
        // «//» в композере — повторить последний вставленный шаблон с
        // подстановкой под текущий чат. Нет последнего — чистим «//» и тост.
        (async () => {
          const title = String(state._lastTemplateTitle || '');
          const tpl = title
            ? (state.templates || []).find((t) => String(t.title || '').trim() === title)
            : null;
          if (!tpl) {
            await nativeReplaceComposer(webview, '');
            showToast('Нет последнего шаблона — выберите через «/»', 'warn', 2500);
            return;
          }
          let chatName = '';
          try {
            chatName = String(await webview.executeJavaScript(activeChatContactScript(), true) || '').trim();
          } catch { /* {имя} останется как есть */ }
          recordTemplateUsage(title);
          await nativeReplaceComposer(webview, applyTemplateVariables(String(tpl.text || ''), chatName));
        })().catch(() => {});
        return;
      }
      if (kind === 'GET_TEMPLATES') {
        const reqId = String(payload.reqId || '').replace(/[^a-zA-Z0-9_]/g, '');
        if (!reqId) return;
        const chatName = String(payload.chatId || '');
        (async () => {
          // Умный порядок: шаблоны языка контакта первыми, затем по частоте
          // использования; хвост — исходный порядок. Ноль нового UI.
          let lang = '';
          if (chatName) {
            try {
              const res = await window.waDeck.getContactLang({ accountId: acc.id, chatName });
              if (res?.ok) lang = String(res.lang || '').replace(/[^a-z-]/gi, '').toLowerCase();
            } catch { /* без языка — только частота */ }
          }
          const base = (state.templates || []).map((tpl) => ({
            title: String(tpl.title || ''),
            text: String(tpl.text || ''),
            category: String(tpl.category || ''),
          }));
          const list = sortTemplatesForChat(base, lang);
          const escaped = escapeForJsSingleQuoted(JSON.stringify(list));
          safeExecuteInWebview(webview, `if (window.__waDeckTplCb_${reqId}) window.__waDeckTplCb_${reqId}(JSON.parse('${escaped}'));`);
        })().catch(() => {});
        return;
      }
      if (kind === 'TRANSCRIBE_VOICE') {
        // payload уже распарсен наверху диспатча — повторный JSON.parse
        // здесь давал SyntaxError на "[object Object]" и молча глотал клик
        const voiceId = String(payload.id || '');
        const mediaKind = payload.kind === 'video' ? 'video' : 'voice';
        // id генерируется нашим же скриптом ([a-z0-9]) — всё прочее подделка
        if (/^[a-z0-9]{1,32}$/i.test(voiceId)) {
          window.waDeck.transcribeVoice({ webContentsId: webview.getWebContentsId(), voiceId, kind: mediaKind });
        }
        return;
      }
      if (kind === 'HEALTH') {
        console.warn('[wadeck-health]', acc.id, payload);
      }
    };

    // Primary transport: sendToHost from the session preload's contextBridge
    // function (see src/preload-webview.js). Page code can't patch or observe
    // it, so the token never leaks; forged calls fail the token check.
    onIpcMessage = (event) => {
      if (String(event?.channel || '') !== 'wadeck-guest') return;
      const args = Array.isArray(event?.args) ? event.args : [];
      if (String(args[0] || '') !== WADECK_WV_TOKEN) return;
      dispatchGuestMessage(String(args[1] || ''), args[2]);
    };
    webview.addEventListener('ipc-message', onIpcMessage);

    // Fallback transport: console markers (__WADECK_X__<token>:<json>), used
    // by guest scripts when the session preload didn't run for this load.
    // Messages with a missing or foreign token are silently ignored.
    const GUEST_KINDS = ['CRM_HOVER', 'GET_LANG', 'SET_LANG', 'GET_AUTO_TR', 'SET_AUTO_TR', 'TRANSLATE_MSG', 'TRANSLATE', 'GET_TEMPLATES', 'INSERT_TEMPLATE', 'REPEAT_LAST_TEMPLATE', 'TRANSCRIBE_VOICE', 'HEALTH'];
    const GUEST_PREFIXES = GUEST_KINDS.map((kind) => [kind, `__WADECK_${kind}__${WADECK_WV_TOKEN}:`]);
    onConsoleMessage = (event) => {
      const message = String(event?.message || '');
      if (!message.startsWith('__WADECK_')) return;
      for (const [kind, prefix] of GUEST_PREFIXES) {
        if (message.startsWith(prefix)) {
          dispatchGuestMessage(kind, message.slice(prefix.length));
          return;
        }
      }
    };
    webview.addEventListener('console-message', onConsoleMessage);
  }

  // Store ALL listener references for cleanup. cancelBindDomTimer lets
  // cleanupWebview kill the pending status/hub debounce — otherwise the
  // 300/800ms callback still fired for a just-destroyed webview.
  webview._wadeckListeners = {
    onDomReady, onNavigateInPage, onStartLoading,
    onFinishLoad, onFailLoad, onPageTitle, onConsoleMessage, onIpcMessage,
    cancelBindDomTimer: () => {
      if (_bindDomTimer) { clearTimeout(_bindDomTimer); _bindDomTimer = null; }
    },
  };
  webview.addEventListener('dom-ready', onDomReady);
  webview.addEventListener('did-navigate-in-page', onNavigateInPage);

  state.webviews.set(account.id, webview);
  els.webviews.appendChild(webview);
}

function isWebviewReady(webview) {
  return Boolean(webview && webview.isConnected && webview.dataset?.waReady === '1');
}

function safeExecuteInWebview(webview, script, userGesture = true) {
  if (!isWebviewReady(webview)) {
    return Promise.resolve(null);
  }
  try {
    return Promise.resolve(webview.executeJavaScript(script, userGesture)).catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}

function showWebviewLoading(show) {
  let overlay = els.webviews.querySelector('.webview-loading-overlay');
  if (show) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'webview-loading-overlay';
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      overlay.appendChild(spinner);
      els.webviews.appendChild(overlay);
    }
  } else if (overlay) {
    overlay.remove();
  }
}

/**
 * Hibernation sweeper — destroys idle non-pinned non-active webviews to free
 * memory. Opt-in via settings.hibernateAfterMinutes (0 = off; 30/60/120/240
 * are the user-facing options). Trade-off the user accepts when enabling:
 * a hibernated account does NOT receive incoming messages — they reappear
 * on the next click which transparently recreates the webview from the
 * persistent partition cookies (no QR scan needed).
 *
 * Pinned and active accounts are always exempt. Frozen accounts have no
 * webview at all so they are inherently exempt.
 */
function applyHibernationSetting(minutes) {
  if (state._hibernationTimer) {
    clearInterval(state._hibernationTimer);
    state._hibernationTimer = null;
  }
  if (!state._hibernated) state._hibernated = new Set();
  if (!minutes || minutes <= 0) {
    // «Выкл» обязан ВЕРНУТЬ уже усыплённые аккаунты: иначе они так и висят
    // без webview (и без входящих), пока по каждому не кликнешь руками
    for (const id of Array.from(state._hibernated)) {
      const acc = accountById(id);
      if (acc && !acc.frozen) { try { ensureWebview(acc); } catch { /* ignore */ } }
      markAccountHibernated(id, false);
    }
    state._hibernated.clear();
    return;
  }
  // Sweep once per minute — granular enough that users see hibernation kick
  // in within a minute of crossing the threshold, cheap enough to run
  // forever (just iterates over state.webviews).
  state._hibernationTimer = setInterval(() => {
    runHibernationTick(minutes);
  }, 60 * 1000);
}

function runHibernationTick(minutes) {
  if (!minutes || minutes <= 0) return;
  const idleThresholdMs = minutes * 60 * 1000;
  const now = Date.now();
  for (const [accountId, webview] of Array.from(state.webviews.entries())) {
    if (accountId === state.activeAccountId) {
      if (webview) webview._lastActive = now;
      continue;
    }
    const account = accountById(accountId);
    if (!account) continue;
    if (account.pinned) continue;
    const lastActive = Number(webview?._lastActive || 0);
    if (!lastActive) {
      if (webview) webview._lastActive = now;
      continue;
    }
    if (now - lastActive > idleThresholdMs) {
      console.log('[hibernate] suspending', accountId, `(idle ${Math.round((now - lastActive) / 60000)} min)`);
      try {
        cleanupWebview(webview);
        state.webviews.delete(accountId);
        state._hibernated.add(accountId);
        markAccountHibernated(accountId, true);
      } catch (err) {
        console.warn('[hibernate] failed for', accountId, err?.message || err);
      }
    }
  }
}

function markAccountHibernated(accountId, hibernated) {
  if (!els.accountsList) return;
  const card = Array.from(els.accountsList.children || []).find(
    (node) => node.dataset?.accountId === accountId,
  );
  if (!card) return;
  card.classList.toggle('is-hibernated', !!hibernated);
}


function refreshWebviewVisibility() {
  const active = activeAccount();
  const isSignalActive = active?.type === 'signal';
  const showHub = state.startupHubVisible || (!isSignalActive && (!state.activeAccountId || !selectedWebview()));
  setHubVisibility(showHub);
  window.WaDeckSignalPanel?.setVisible?.(isSignalActive && !state.startupHubVisible, active);
  let activeLoading = false;
  for (const [accountId, webview] of state.webviews.entries()) {
    const isActive = accountId === state.activeAccountId;
    if (isActive) {
      webview.classList.add('active');
      try {
        if (webview.dataset.waReady !== '1' && typeof webview.isLoading === 'function' && webview.isLoading()) {
          activeLoading = true;
        }
      } catch { /* webview not yet attached to DOM — ignore */ }
    } else {
      webview.classList.remove('active');
    }
    // Флаг активности для idle-backoff переводчика: фоновые webview тикают
    // реже. Пушим только при смене значения (dataset) → ≤2 инъекции на switch.
    const flag = isActive ? '1' : '0';
    if (webview.dataset.wadeckActiveFlag !== flag && webview.dataset.waReady === '1') {
      webview.dataset.wadeckActiveFlag = flag;
      try {
        webview.executeJavaScript(`(()=>{try{window.__waDeckWebviewActive=${isActive};}catch(e){}return 1;})()`, true).catch(() => {});
      } catch { /* not attached — flag re-pushed next switch */ }
    }
  }
  showWebviewLoading(!showHub && activeLoading);
  refreshTweaksFabVisibility();
}

/**
 * Apply translator enable/disable to every live webview.
 * When disabled: set window.__waDeckTranslatorDisabled=true — the bar's own
 * tick loop will tear down the bar and overlays on its next tick.
 * When enabled: clear the flag and reinject so the bar comes back immediately.
 */
function applyTranslatorToggleToAllWebviews(enabled) {
  if (!state.webviews) return;
  state.webviews.forEach((wv, accountId) => {
    const account = state.accounts?.find((a) => a.id === accountId);
    const isWa = !account || account.type !== 'telegram';
    if (!isWa || !wv || !wv.isConnected) return;
    try {
      if (enabled) {
        wv.executeJavaScript(
          '(() => { try { window.__waDeckTranslatorDisabled = false; } catch {} return true; })()',
          true,
        ).catch(() => {});
        if (typeof translatorBarScript === 'function') {
          wv.executeJavaScript(translatorBarScript(WADECK_WV_TOKEN), true).catch(() => {});
        }
      } else {
        wv.executeJavaScript(
          `(() => {
            try { window.__waDeckTranslatorDisabled = true; } catch {}
            try {
              const bar = document.getElementById('__wadeck-translator-bar');
              if (bar) bar.remove();
              document.querySelectorAll('.__wadeck-tr-overlay').forEach((o) => o.remove());
            } catch {}
            return true;
          })()`,
          true,
        ).catch(() => {});
      }
    } catch (e) {
      console.warn('[translator-toggle]', e);
    }
  });
}

function applyCrmHoverToggle(enabled) {
  if (!enabled) {
    try { hideCrmHoverPopover(); } catch {}
    return;
  }
  // Inject the guest bridge into already-loaded WhatsApp webviews: the
  // dom-ready/did-navigate-in-page injection is gated on isCrmHoverEnabled(),
  // so webviews loaded while the toggle was off never got the script and
  // hover would silently stay dead until a reload. Mirrors
  // applyTranslatorToggleToAllWebviews.
  if (!state.webviews || typeof crmHoverBridgeScript !== 'function') return;
  state.webviews.forEach((wv, accountId) => {
    const account = state.accounts?.find((a) => a.id === accountId);
    const isWa = !account || account.type !== 'telegram';
    if (!isWa || !wv || !wv.isConnected) return;
    try {
      wv.executeJavaScript(crmHoverBridgeScript(WADECK_WV_TOKEN), true).catch(() => {});
    } catch (e) {
      console.warn('[crm-hover-toggle]', e);
    }
  });
}

async function sendWebviewInput(webview, event) {
  try {
    const out = webview.sendInputEvent(event);
    if (out && typeof out.then === 'function') {
      await out;
    }
    return true;
  } catch {
    return false;
  }
}

/* Замена текста композера WhatsApp: очистка — нативным вводом (click +
   Cmd/Ctrl+A + Backspace), т.к. только реальный ввод надёжно чистит
   Lexical-редактор; вставка — проверенным insertTextScript в уже пустое поле.
   Используется слэш-шаблонами (guest шлёт INSERT_TEMPLATE с готовым текстом). */
async function nativeReplaceComposer(webview, text) {
  const safeText = String(text || '');
  // Пустой text = только очистить композер (например, стереть «//»).
  if (!webview || !isWebviewReady(webview)) return;
  try {
    const rect = await safeExecuteInWebview(webview, `(() => {
      const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]')
        || document.querySelector('footer div[contenteditable="true"][data-tab]');
      if (!c) return null;
      c.focus();
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), ok: r.width > 0 && r.height > 0 };
    })()`);
    if (!rect || !rect.ok) {
      // Композер не найден/невидим — НЕ шлём Cmd+A/Backspace вслепую: фокус
      // может стоять в поиске чатов, и мы бы стёрли его содержимое.
      console.warn('[insert-template] composer rect not found — insert skipped');
      return;
    }
    await sendWebviewInput(webview, { type: 'mouseDown', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await sendWebviewInput(webview, { type: 'mouseUp', x: rect.x, y: rect.y, button: 'left', clickCount: 1 });
    await delay(20);
    const mod = (navigator.platform || '').includes('Mac') ? 'meta' : 'control';
    await sendWebviewInput(webview, { type: 'keyDown', keyCode: 'a', modifiers: [mod] });
    await sendWebviewInput(webview, { type: 'keyUp', keyCode: 'a', modifiers: [mod] });
    await delay(20);
    await sendWebviewInput(webview, { type: 'keyDown', keyCode: 'Backspace' });
    await sendWebviewInput(webview, { type: 'keyUp', keyCode: 'Backspace' });
    await delay(30);
    // Поле теперь пустое — вставляем проверенным путём (execCommand insertText)
    if (safeText) await safeExecuteInWebview(webview, insertTextScript(safeText));
  } catch (e) {
    console.warn('[insert-template]', e);
  }
}

async function resetWebviewUiState(webview, tries = 2) {
  if (!webview) return;
  if (typeof webview.focus === 'function') {
    try {
      webview.focus();
    } catch {
      // ignore
    }
  }
  for (let i = 0; i < tries; i += 1) {
    await sendWebviewInput(webview, { type: 'keyDown', keyCode: 'Escape' });
    await sendWebviewInput(webview, { type: 'keyUp', keyCode: 'Escape' });
    await delay(120);
  }
}

/* Cmd/Ctrl+Shift+E: буфер обмена → посимвольный «человеческий» набор в
   композер активного аккаунта. Скрипт сам защищён от повторного запуска. */
async function humanTypePaste() {
  const account = activeAccount();
  if (!account || account.frozen) return;
  if (account.type === 'signal') {
    setStatus('«Человеческий набор» доступен только в WhatsApp и Telegram');
    return;
  }
  const webview = selectedWebview();
  if (!isWebviewReady(webview)) {
    setStatus('Аккаунт ещё загружается — попробуйте через секунду');
    return;
  }

  const clip = await window.waDeck.getClipboardText().catch(() => null);
  const text = String(clip?.text || '').replace(/\r\n/g, '\n');
  if (!text.trim()) {
    setStatus('Буфер обмена пуст');
    return;
  }

  setStatus(`${account.name}: печатаю из буфера... (Esc в чате — отмена)`);
  const result = await safeExecuteInWebview(webview, humanTypeScript(text), true);
  if (result?.ok) {
    setStatus(result.aborted ? `${account.name}: набор прерван` : `${account.name}: текст набран`);
  } else if (result?.error === 'already_typing') {
    setStatus('Набор уже идёт');
  } else if (result) {
    setStatus('Не удалось набрать текст (композер не найден?)');
  }
}

async function insertTextIntoActiveChat(text) {
  let safeText = String(text || '').trim();
  if (!safeText) {
    return { ok: false, error: 'text_required' };
  }
  const account = activeAccount();
  if (!account) {
    return { ok: false, error: 'no_active_account' };
  }
  if (account.frozen) {
    return { ok: false, error: 'account_frozen' };
  }
  if (account.type === 'signal') {
    // Вставляем в композер signal-панели (webview у Signal нет)
    return window.WaDeckSignalPanel?.insertText?.(safeText) || { ok: false, error: 'no_active_chat' };
  }

  const webview = selectedWebview();
  if (!webview) {
    return { ok: false, error: 'no_active_chat' };
  }

  if (TEMPLATE_VAR_RE.test(safeText)) {
    let chatName = '';
    if (isWebviewReady(webview) && typeof activeChatContactScript === 'function') {
      try {
        chatName = String(await webview.executeJavaScript(activeChatContactScript(), true) || '').trim();
      } catch { /* name stays empty — {имя} is left untouched */ }
    }
    safeText = applyTemplateVariables(safeText, chatName);
  }

  try {
    const result = await webview.executeJavaScript(insertTextScript(safeText), true);
    if (!result?.ok) return { ok: false, error: String(result?.error || 'insert_failed') };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'insert_failed') };
  }
}

/* Prefill the schedule target with the chat currently open in the active
   WhatsApp webview — lets the user schedule a message in ~2 clicks without
   walking through the picker. No open chat → previous behaviour (empty). */
async function prefillScheduleTargetFromActiveChat() {
  if (state._editingScheduleId) return; // never clobber an in-progress edit
  const account = activeAccount();
  if (!account || account.frozen || account.type !== 'whatsapp') return;
  const webview = selectedWebview();
  if (!isWebviewReady(webview) || typeof activeChatContactScript !== 'function') return;
  let chatName = '';
  try {
    chatName = String(await webview.executeJavaScript(activeChatContactScript(), true) || '').trim();
  } catch {
    return;
  }
  if (!chatName) return;
  state.scheduleTarget = {
    accountId: account.id,
    accountName: account.name,
    chatName,
  };
  WaDeckScheduleModule.renderScheduleTarget();
}

async function sendAudioAsVoiceMessage() {
  const account = activeAccount();
  if (!account) {
    showToast('Нет активного аккаунта', 'warn');
    return;
  }
  if (account.type !== 'whatsapp') {
    showToast('Голосовые сообщения доступны только для WhatsApp', 'warn');
    return;
  }
  if (account.frozen) {
    showToast('Аккаунт заморожен', 'warn');
    return;
  }
  const webview = selectedWebview();
  if (!webview || !isWebviewReady(webview)) {
    showToast('WhatsApp ещё не загружен', 'warn');
    return;
  }

  /* Pick audio file */
  let picked;
  try {
    picked = await window.waDeck.pickAudioFile();
  } catch (err) {
    console.error('[voice-msg] pick failed', err);
    showToast('Не удалось открыть диалог выбора файла', 'error');
    return;
  }
  if (!picked || picked.canceled) return;
  if (!picked.ok) {
    const errMap = {
      file_too_large: 'Файл слишком большой (макс. 16 МБ)',
      read_failed: 'Не удалось прочитать файл',
    };
    showToast(errMap[picked.error] || 'Ошибка загрузки файла', 'error');
    return;
  }

  /* Show recording state */
  if (els.sendVoiceMsg) {
    els.sendVoiceMsg.classList.add('is-recording');
    els.sendVoiceMsg.disabled = true;
  }

  const _delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const errMessages = {
    ptt_button_not_found: 'Кнопка записи не найдена. Откройте чат в WhatsApp.',
    getUserMedia_not_called: 'WhatsApp не запросил микрофон. Попробуйте снова.',
    audio_decode_failed: 'Не удалось декодировать аудиофайл.',
    audio_too_short: 'Аудиофайл слишком короткий (менее 0.3 сек).',
    no_voice_state: 'Внутренняя ошибка состояния.',
  };

  const stillReady = () => isWebviewReady(webview);
  try {
    /* ── Phase 1: Setup — decode audio, override getUserMedia, find PTT button ── */
    const setup = await safeExecuteInWebview(webview, voiceMessageSetupScript(picked.dataBase64, picked.mime));
    if (!setup?.ok) {
      const key = setup?.error || 'unknown';
      showToast(errMessages[key] || `Ошибка: ${key}`, 'error', 5000);
      return;
    }

    /* ── Phase 2: Trusted mouseDown via sendInputEvent (isTrusted: true) ── */
    // getBoundingClientRect returns CSS pixels, but sendInputEvent expects
    // webview-viewport coordinates: at zoom ≠ 100% the unscaled click lands
    // on a neighboring button (with a draft present — on Send, firing the
    // draft instead of recording).
    let zoomFactor = 1;
    try { zoomFactor = Number(webview.getZoomFactor?.()) || 1; } catch { /* ignore */ }
    const pttX = Math.round(setup.x * zoomFactor);
    const pttY = Math.round(setup.y * zoomFactor);
    // Re-check readiness before every sendInputEvent: the account could have
    // been frozen/hibernated/switched during the awaits above, and
    // sendInputEvent on a detached webview throws synchronously.
    if (!stillReady()) { showToast('WhatsApp перезагрузился, попробуйте снова', 'warn'); return; }
    webview.sendInputEvent({ type: 'mouseDown', x: pttX, y: pttY, button: 'left', clickCount: 1 });
    await _delay(80);

    /* ── Phase 3: Wait for getUserMedia + audio duration ── */
    const waitResult = await safeExecuteInWebview(webview, voiceMessageWaitScript());

    if (!waitResult?.ok) {
      /* getUserMedia not called — release (cleanup runs in finally) */
      if (stillReady()) webview.sendInputEvent({ type: 'mouseUp', x: pttX, y: pttY, button: 'left' });
      const key = waitResult?.error || 'unknown';
      showToast(errMessages[key] || `Ошибка: ${key}`, 'error', 5000);
      return;
    }

    /* ── Phase 4: Trusted mouseUp — WhatsApp finalizes & sends the voice message ── */
    if (!stillReady()) { showToast('WhatsApp перезагрузился, попробуйте снова', 'warn'); return; }
    webview.sendInputEvent({ type: 'mouseUp', x: pttX, y: pttY, button: 'left' });
    await _delay(600);

    const dur = waitResult.duration ? ` (${Math.round(waitResult.duration)}с)` : '';
    showToast(`Голосовое сообщение отправлено${dur}`, 'success');
  } catch (error) {
    console.error('[voice-msg]', error);
    showToast('Ошибка отправки голосового сообщения', 'error', 5000);
  } finally {
    /* Always restore getUserMedia / close the fake stream, even on early
       return or throw. safeExecuteInWebview no-ops if the webview is gone
       (the in-page 15s safety timer is the last-resort backstop). */
    safeExecuteInWebview(webview, voiceMessageCleanupScript());
    if (els.sendVoiceMsg) {
      els.sendVoiceMsg.classList.remove('is-recording');
      els.sendVoiceMsg.disabled = false;
    }
  }
}

export {
  applyZoom,
  syncZoomSlider,
  cleanupWebview,
  ensureWebview,
  isWebviewReady,
  safeExecuteInWebview,
  showWebviewLoading,
  applyHibernationSetting,
  runHibernationTick,
  markAccountHibernated,
  refreshWebviewVisibility,
  applyTranslatorToggleToAllWebviews,
  applyCrmHoverToggle,
  sendWebviewInput,
  resetWebviewUiState,
  insertTextIntoActiveChat,
  humanTypePaste,
  prefillScheduleTargetFromActiveChat,
  sendAudioAsVoiceMessage,
};

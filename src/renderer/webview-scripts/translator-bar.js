function translatorBarScript(token) {
  const tokenJs = JSON.stringify(typeof token === 'string' ? token : '');
  return `(() => {
    if (window.__waDeckTranslatorBound) return true;
    window.__waDeckTranslatorBound = true;

    /* Host-issued token kept in the closure (never on window) */
    const __WADECK_TOKEN = ${tokenJs};

    /* Guest→host send: prefer the preload's contextBridge channel (page code
       cannot patch or observe it — see src/preload-webview.js); fall back to
       the console marker when the session preload didn't run for this load. */
    const __waDeckEmit = (kind, json) => {
      const send = window.__waDeckGuestSend;
      if (typeof send === 'function') {
        try { send(__WADECK_TOKEN, kind, json); return; } catch {}
      }
      console.log('__WADECK_' + kind + '__' + __WADECK_TOKEN + ':' + json);
    };

    /* Health marker, throttled to at most one per minute */
    let healthLastSent = 0;
    function emitHealth(payload) {
      const now = Date.now();
      if (now - healthLastSent < 60000) return;
      healthLastSent = now;
      try { __waDeckEmit('HEALTH', JSON.stringify(payload)); } catch {}
    }

    // Clean up any stale bar/overlays from a prior init
    try {
      const staleBar = document.getElementById('__wadeck-translator-bar');
      if (staleBar) staleBar.remove();
      document.querySelectorAll('.__wadeck-tr-overlay').forEach((o) => o.remove());
    } catch {}

    /* Тема WhatsApp Web читается по фактическому фону страницы: раньше бар был
       захардкожен светлым, а его же дропдаун и оверлеи — тёмными, и набор
       выглядел чужеродно в обеих темах WA. Один источник правды на все
       элементы переводчика. */
    function waIsDark() {
      try {
        const probe = document.querySelector('#app') || document.body;
        const bg = getComputedStyle(probe).backgroundColor || '';
        const m = bg.match(/rgba?\(([^)]+)\)/);
        if (!m) return document.documentElement.classList.contains('dark');
        const [r, g, b] = m[1].split(',').map((v) => parseFloat(v));
        // Относительная яркость: тёмная тема WA даёт ~0.05-0.15
        return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5;
      } catch {
        return false;
      }
    }

    function palette() {
      return waIsDark()
        ? {
          barBg: '#1f2c33', barFg: '#e9edef', barBorder: '#2a3942',
          menuBg: '#233138', menuFg: '#e9edef', menuHover: 'rgba(255,255,255,0.08)',
          overlayBg: 'rgba(31,44,51,0.97)', overlayFg: '#e9edef',
          muted: '#8696a0', accent: '#00a884',
        }
        : {
          barBg: '#eff6e4', barFg: '#1a2030', barBorder: '#d8e4c6',
          menuBg: '#ffffff', menuFg: '#1a2030', menuHover: 'rgba(0,0,0,0.06)',
          overlayBg: 'rgba(255,255,255,0.98)', overlayFg: '#111b21',
          muted: '#667781', accent: '#008069',
        };
    }

    const LANGS = [
      { code: 'auto', label: '🔍 Авто' },
      { code: 'ru', label: 'Русский' },
      { code: 'en', label: 'Английский' },
      { code: 'de', label: 'Немецкий' },
      { code: 'fr', label: 'Французский' },
      { code: 'nl', label: 'Нидерландский' },
      { code: 'it', label: 'Итальянский' },
      { code: 'no', label: 'Норвежский' },
      { code: 'da', label: 'Датский' },
      { code: 'sv', label: 'Шведский' },
      { code: 'fi', label: 'Финский' },
    ];
    const TARGET_LANGS = LANGS.filter((l) => l.code !== 'auto');
    const INCOMING_TARGET = 'ru'; // fixed: incoming always auto → ru

    // In-moment state (global, session-only, not persisted, not per-contact)
    let bar = null;
    let autoTranslate = false;
    let outgoingFrom = 'auto';
    let outgoingTo = 'en';
    // Автоопределение языка контакта: host теперь возвращает detected из
    // ответа переводчика. Копим по чату; 2 совпадения подряд при ОТСУТСТВИИ
    // сохранённого языка — выставляем направление исходящих и персистим.
    let contactLangKnown = false;      // у чата есть явно сохранённый язык
    let langGuess = { chat: '', counts: {} };

    function noteDetectedLang(det) {
      const code = String(det || '').toLowerCase().slice(0, 5);
      if (!code || code === 'ru' || code === INCOMING_TARGET) return;
      if (!TARGET_LANGS.some((l) => l.code === code)) return;
      const chat = currentChatId;
      if (!chat || chat === '__unknown_chat__' || contactLangKnown) return;
      if (langGuess.chat !== chat) langGuess = { chat: chat, counts: {} };
      langGuess.counts[code] = (langGuess.counts[code] || 0) + 1;
      if (langGuess.counts[code] >= 2 && outgoingTo !== code) {
        applyOutgoingTo(code);
        saveContactLang(chat, code);
        contactLangKnown = true;
      }
    }
    let dropdownOpen = null;
    let currentChatId = '';
    let barHiddenByUser = false;
    // WeakMap keyed by message-row nodes. WhatsApp recycles/detaches rows
    // aggressively on scroll; a plain Map kept strong refs to those detached
    // nodes (the old 500-entry cap was dead code — writers used .set directly),
    // so memory grew unbounded within a chat. A WeakMap lets detached rows be
    // garbage-collected automatically, no manual cap needed.
    let translatedCache = new WeakMap();
    // Secondary text-keyed LRU: WhatsApp's virtualized list destroys and
    // recreates row nodes on scroll, so the WeakMap alone meant every
    // scroll-away-and-back re-sent the same messages to the paid translate
    // API. Keyed by target lang + normalized text, capped, LRU-evicted.
    const textCache = new Map();
    const TEXT_CACHE_MAX = 300;
    function textCacheGet(key) {
      if (!textCache.has(key)) return '';
      const val = textCache.get(key);
      textCache.delete(key);
      textCache.set(key, val); // LRU bump
      return val;
    }
    function textCacheSet(key, translated) {
      if (textCache.has(key)) textCache.delete(key);
      textCache.set(key, translated);
      if (textCache.size > TEXT_CACHE_MAX) textCache.delete(textCache.keys().next().value);
    }

    function getChatId() {
      // Primary: standard WhatsApp chat header
      const selectors = [
        '#main header span[title]',
        '#main header [data-testid="conversation-header"] span[title]',
        '#main header [role="button"] span[title]',
        '#main header span[dir="auto"]',
        '#main header ._amig span',
        '#main header [data-testid="conversation-info-header"] span',
      ];
      // Все совпадения каждого селектора + чистка невидимых меток: первый
      // span шапки бывает статусом («В сети»), и он становился бы КЛЮЧОМ
      // хранения языка контакта.
      const clean = (v) => String(v || '').replace(/[\\u200e\\u200f\\u2066-\\u2069]/g, '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const isStatus = (t) => {
        const v = clean(t).toLowerCase();
        if (!v || v.length < 2) return true;
        if (/^(online|в сети|typing|печатает|recording|записывает|last seen|seen |был|была|нажмите|tap here|click here|select |выберите)/i.test(v)) return true;
        // Короткая строка со временем = presence («был(-а) сегодня в 20:24»)
        if (/\\d{1,2}:\\d{2}/.test(v) && v.length <= 60) return true;
        return false;
      };
      for (let i = 0; i < selectors.length; i++) {
        const els = document.querySelectorAll(selectors[i]);
        for (let j = 0; j < els.length; j++) {
          const val = clean(els[j].getAttribute('title') || els[j].textContent || '');
          if (!isStatus(val)) return val;
        }
      }
      // Fallback: a chat is open (even if we cannot read its name) when #main
      // holds a composer or message rows. Kept broad so header-class renames in
      // a new WhatsApp bundle never make tick() bail before the incoming sweep.
      const main = document.querySelector('#main');
      if (main && (
        main.querySelector('footer') ||
        main.querySelector('div[contenteditable="true"]') ||
        main.querySelector('[role="row"]')
      )) return '__unknown_chat__';
      return '';
    }

    function getLangLabel(code) {
      const lang = LANGS.find((l) => l.code === code);
      return lang ? lang.label : code;
    }

    // ========== Bar ==========

    function createBar() {
      const P = palette();
      bar = document.createElement('div');
      bar.id = '__wadeck-translator-bar';
      bar.style.cssText = [
        'display:none',
        'align-items:center',
        'gap:10px',
        'padding:7px 14px',
        'background:' + P.barBg,
        'border-top:1px solid ' + P.barBorder,
        'box-shadow:0 -4px 12px rgba(0,0,0,0.08)',
        'font-family:Avenir Next,Segoe UI,system-ui,sans-serif',
        'font-size:12.5px',
        'color:' + P.barFg,
        // Поверх ленты сообщений, прямо над композером: в потоке бар отжимал
        // всю переписку на 40px вверх при каждом показе/скрытии.
        'position:absolute',
        'left:0',
        'right:0',
        'bottom:0',
        'z-index:50',
        'min-height:40px',
        'box-sizing:border-box',
        'transition:opacity 0.2s ease',
      ].join(';');

      const globe = document.createElement('span');
      globe.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10A15.3 15.3 0 0 1 12 2z"/></svg>';
      globe.style.cssText = 'display:flex;align-items:center;justify-content:center;flex-shrink:0;width:26px;height:26px;border-radius:50%;background:rgba(34,197,94,0.12);box-shadow:inset 0 0 0 1px rgba(34,197,94,0.25);';
      bar.appendChild(globe);

      // ── Incoming section ──
      bar.appendChild(createAutoToggle());

      // ── Separator ──
      const sep = document.createElement('span');
      sep.textContent = '·';
      sep.style.cssText = 'color:' + P.muted + ';flex-shrink:0;padding:0 2px;font-size:14px;';
      bar.appendChild(sep);

      // ── Outgoing section ──
      const fromBtn = createDropdownBtn('from');
      fromBtn.title = 'Язык исходного текста';
      bar.appendChild(fromBtn);

      const arrow = document.createElement('span');
      arrow.textContent = '→';
      arrow.style.cssText = 'color:' + P.muted + ';flex-shrink:0;font-size:13px;';
      bar.appendChild(arrow);

      const toBtn = createDropdownBtn('to');
      toBtn.title = 'Язык, на который переводить';
      bar.appendChild(toBtn);

      const spacer = document.createElement('span');
      spacer.style.flex = '1';
      bar.appendChild(spacer);

      const translateBtn = document.createElement('button');
      translateBtn.textContent = 'Перевести';
      translateBtn.title = 'Перевести выделенный текст в поле ввода';
      translateBtn.style.cssText = [
        'background:#22c55e',
        'color:#fff',
        'border:none',
        'border-radius:999px',
        'padding:6px 14px',
        'font-size:11.5px',
        'font-weight:600',
        'cursor:pointer',
        'flex-shrink:0',
        'transition:background 0.2s ease, transform 0.1s ease',
        'letter-spacing:0.01em',
        'box-shadow:0 2px 6px -2px rgba(34,197,94,0.4)',
      ].join(';');
      translateBtn.addEventListener('mouseenter', () => { translateBtn.style.background = '#16a34a'; });
      translateBtn.addEventListener('mouseleave', () => { translateBtn.style.background = '#22c55e'; });
      // preventDefault на mousedown держит фокус в композере: без него клик
      // по кнопке уводит фокус, и insertText с переводом падает мимо поля.
      translateBtn.addEventListener('mousedown', (e) => { e.preventDefault(); });
      translateBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        doTranslate();
      });
      bar.appendChild(translateBtn);

      const closeBtn = document.createElement('span');
      closeBtn.textContent = '✕';
      closeBtn.title = 'Скрыть панель переводчика';
      closeBtn.style.cssText = [
        'cursor:pointer',
        'padding:3px 7px',
        'margin-left:2px',
        'color:#6b7280',
        'font-size:13px',
        'line-height:1',
        'flex-shrink:0',
        'user-select:none',
        'border-radius:6px',
        'transition:all 0.15s',
      ].join(';');
      closeBtn.addEventListener('mouseenter', () => {
        closeBtn.style.color = '#1a2030';
        closeBtn.style.background = 'rgba(0,0,0,0.05)';
      });
      closeBtn.addEventListener('mouseleave', () => {
        closeBtn.style.color = '#6b7280';
        closeBtn.style.background = 'transparent';
      });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        barHiddenByUser = true;
        hideBar();
      });
      bar.appendChild(closeBtn);

      return bar;
    }

    function createAutoToggle() {
      const wrap = document.createElement('div');
      wrap.className = '__wadeck-auto-toggle';
      wrap.title = 'Автоперевод входящих сообщений на русский';
      wrap.style.cssText = [
        'display:flex',
        'align-items:center',
        'gap:7px',
        'padding:5px 11px',
        'border-radius:999px',
        'border:1px solid rgba(0,0,0,0.08)',
        'background:rgba(255,255,255,0.5)',
        'cursor:pointer',
        'user-select:none',
        'font-size:11.5px',
        'font-weight:500',
        'color:#1a2030',
        'flex-shrink:0',
        'transition:all 0.15s',
      ].join(';');

      const track = document.createElement('span');
      track.style.cssText = [
        'width:24px',
        'height:13px',
        'background:#d1d5db',
        'border-radius:999px',
        'position:relative',
        'flex-shrink:0',
        'transition:background 0.15s',
      ].join(';');

      const knob = document.createElement('span');
      knob.style.cssText = [
        'width:11px',
        'height:11px',
        'border-radius:50%',
        'background:#ffffff',
        'position:absolute',
        'top:1px',
        'left:1px',
        'box-shadow:0 1px 2px rgba(0,0,0,0.2)',
        'transition:left 0.15s, background 0.15s',
      ].join(';');
      track.appendChild(knob);

      const labelEl = document.createElement('span');
      labelEl.textContent = 'Авто чат → Русский';

      wrap.appendChild(track);
      wrap.appendChild(labelEl);

      function paint() {
        if (autoTranslate) {
          wrap.style.background = '#22c55e';
          wrap.style.borderColor = '#22c55e';
          wrap.style.color = '#ffffff';
          track.style.background = 'rgba(255,255,255,0.35)';
          knob.style.left = '12px';
          knob.style.background = '#ffffff';
          labelEl.textContent = 'Перевод активен';
        } else {
          wrap.style.background = 'rgba(255,255,255,0.5)';
          wrap.style.borderColor = 'rgba(0,0,0,0.08)';
          wrap.style.color = '#1a2030';
          track.style.background = '#d1d5db';
          knob.style.left = '1px';
          knob.style.background = '#ffffff';
          labelEl.textContent = 'Авто чат → Русский';
        }
      }
      wrap.__paint = paint;
      paint();

      wrap.addEventListener('click', (e) => {
        e.stopPropagation();
        autoTranslate = !autoTranslate;
        paint();
        // Персист per-account: переживает рестарт/reload/гибернацию
        try { __waDeckEmit('SET_AUTO_TR', JSON.stringify({ on: autoTranslate })); } catch (err) {}
        if (autoTranslate) {
          translatedCache = new WeakMap();
          processAllVisibleIncoming();
        } else {
          clearAllOverlays();
          translatedCache = new WeakMap();
        }
      });

      return wrap;
    }

    function createDropdownBtn(type) {
      const btn = document.createElement('div');
      btn.dataset.translatorDropdown = type;
      btn.style.cssText = [
        'background:rgba(255,255,255,0.6)',
        'border:1px solid rgba(0,0,0,0.08)',
        'border-radius:999px',
        'padding:5px 12px',
        'color:#1a2030',
        'font-size:11.5px',
        'font-weight:500',
        'min-width:64px',
        'text-align:center',
        'cursor:pointer',
        'position:relative',
        'user-select:none',
        'flex-shrink:0',
        'transition:background 0.15s ease, border-color 0.15s ease',
      ].join(';');
      btn.textContent = getLangLabel(type === 'from' ? outgoingFrom : outgoingTo);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleDropdown(type);
      });
      return btn;
    }

    function toggleDropdown(type) {
      // Clicking the button while ITS menu is open closes it — the old
      // close-then-reopen made the button unable to dismiss its own menu.
      const wasOpen = dropdownOpen === type;
      closeDropdowns();
      if (wasOpen) return;
      const isFrom = type === 'from';
      const list = isFrom ? LANGS : TARGET_LANGS;
      const current = isFrom ? outgoingFrom : outgoingTo;
      const btn = bar && bar.querySelector('[data-translator-dropdown="' + type + '"]');
      if (!btn) return;

      dropdownOpen = type;

      const P = palette();
      const dd = document.createElement('div');
      dd.className = '__wadeck-translator-dd';
      dd.style.cssText = [
        'position:absolute',
        'bottom:calc(100% + 4px)',
        'left:0',
        'background:' + P.menuBg,
        'border:1px solid ' + P.barBorder,
        'border-radius:8px',
        'padding:4px',
        'z-index:100',
        'min-width:145px',
        'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
      ].join(';');

      list.forEach((lang) => {
        const item = document.createElement('div');
        item.textContent = lang.label;
        item.style.cssText = [
          'padding:7px 12px',
          'border-radius:5px',
          'cursor:pointer',
          'font-size:12.5px',
          'color:' + (lang.code === current ? P.accent : P.menuFg),
          'font-weight:' + (lang.code === current ? '600' : '400'),
        ].join(';');
        item.addEventListener('mouseenter', () => { item.style.background = P.menuHover; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        item.addEventListener('click', (e) => {
          e.stopPropagation();
          if (isFrom) outgoingFrom = lang.code;
          else { outgoingTo = lang.code; contactLangKnown = true; saveContactLang(currentChatId, lang.code); }
          btn.textContent = lang.label;
          closeDropdowns();
          // Outgoing dropdowns do NOT affect incoming overlays — they are
          // completely independent by design.
        });
        dd.appendChild(item);
      });

      btn.appendChild(dd);
    }

    function closeDropdowns() {
      dropdownOpen = null;
      const dds = bar ? bar.querySelectorAll('.__wadeck-translator-dd') : [];
      dds.forEach((d) => d.remove());
    }

    // ========== Composer helpers (for outgoing button) ==========

    function getComposer() {
      // Last fallback is scoped to #main: a document-wide query could match
      // the sidebar chat-search field and type the translation into search.
      const main = document.querySelector('#main') || document;
      return (
        document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
        document.querySelector('footer div[contenteditable="true"][data-tab]') ||
        main.querySelector('div[contenteditable="true"][role="textbox"]')
      );
    }

    function getComposerText() {
      const composer = getComposer();
      if (!composer) return '';
      return String(composer.innerText || composer.textContent || '').trim();
    }

    /* Кнопка «Перевести». Три случая, по убыванию явности:
       1) выделение ВНУТРИ композера → переводим только его (замена выделения);
          выделение в ленте чата не считается — иначе перевод чужого сообщения
          дописывался в композер («переводит половину»);
       2) композер начинается с прошлого вставленного перевода → дописанный
          хвост переводим отдельно, готовый перевод не трогаем (иначе он
          уезжал в Google второй раз и «цеплялся» к новому тексту);
       3) иначе — весь композер с заменой. Отправку оператор делает вручную. */
    const normWsC = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
    let lastInserted = '';   // фактический текст композера после последней вставки
    let pendingPrefix = '';  // что вернуть перед переводом хвоста (случай 2)
    function doTranslate() {
      const composer = getComposer();
      const text = getComposerText();
      if (!composer || !text) return;
      pendingPrefix = '';
      const sel = window.getSelection();
      if (sel && sel.rangeCount && !sel.isCollapsed
          && composer.contains(sel.anchorNode) && composer.contains(sel.focusNode)) {
        const part = sel.toString().trim();
        if (part) {
          __waDeckEmit('TRANSLATE', JSON.stringify({ text: part, from: outgoingFrom, to: outgoingTo, replaceAll: false }));
          return;
        }
      }
      let body = text;
      if (lastInserted && normWsC(text).indexOf(normWsC(lastInserted)) === 0) {
        const tail = normWsC(text).slice(normWsC(lastInserted).length).trim();
        if (!tail) return; // ничего нового не дописано
        const rawTail = text.slice(lastInserted.length);
        const glue = /^\\s*\\n/.test(rawTail) ? '\\n' : ' ';
        pendingPrefix = lastInserted + glue;
        body = tail;
      }
      __waDeckEmit('TRANSLATE', JSON.stringify({ text: body, from: outgoingFrom, to: outgoingTo, replaceAll: true }));
    }

    window.__waDeckInsertTranslation = function (translated, replaceAll) {
      if (!translated) return false;
      const composer = getComposer();
      if (!composer) {
        emitHealth({ script: 'translator-bar', ok: false, detail: 'insert_no_composer' });
        return false;
      }
      if (replaceAll && pendingPrefix) translated = pendingPrefix + translated;
      pendingPrefix = '';
      composer.focus();
      if (replaceAll) {
        // Выделяем весь текст композера — insertText заменит его переводом,
        // а не допишет рядом с исходником.
        try {
          const range = document.createRange();
          range.selectNodeContents(composer);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch { /* вставка без замены хуже, но не фатальна */ }
      }

      const normWs = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
      const wantProbe = normWs(translated).slice(0, 64);
      const isInserted = () =>
        !wantProbe || normWs(composer.innerText || composer.textContent || '').indexOf(wantProbe) !== -1;

      let claimed = false;
      try { claimed = document.execCommand('insertText', false, translated); } catch { claimed = false; }
      if (!claimed) {
        try {
          const dt = new DataTransfer();
          dt.setData('text/plain', translated);
          composer.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
          if (isInserted()) claimed = true;
        } catch {}
      }
      if (!claimed) {
        // Lexical (WA composer) listens to beforeinput/insertText
        try {
          composer.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: translated, bubbles: true, cancelable: true }));
          if (isInserted()) claimed = true;
        } catch {}
      }
      if (!claimed && !isInserted()) {
        emitHealth({ script: 'translator-bar', ok: false, detail: 'insert_translation_failed' });
        return false;
      }
      // Запоминаем то, что реально оказалось в композере (Lexical может
      // переформатировать пробелы), чтобы следующий «Перевести» узнал префикс.
      setTimeout(() => { try { lastInserted = getComposerText(); } catch {} }, 80);
      return true;
    };

    // ========== Bar visibility ==========
    let hideBarTimer = null;

    function showBar() {
      if (!bar || !bar.isConnected) return;
      // Отменяем отложенное скрытие: showBar в 150мс-окне после hideBar
      // (клик ✕ + мгновенная смена чата) иначе давал фликер.
      if (hideBarTimer) { clearTimeout(hideBarTimer); hideBarTimer = null; }
      if (bar.style.display === 'none') {
        bar.style.display = 'flex';
        bar.style.opacity = '0';
        requestAnimationFrame(() => { bar.style.opacity = '1'; });
      } else {
        bar.style.opacity = '1';
      }
    }

    function hideBar() {
      if (!bar || !bar.isConnected) return;
      if (bar.style.display !== 'none') {
        bar.style.opacity = '0';
        if (hideBarTimer) clearTimeout(hideBarTimer);
        hideBarTimer = setTimeout(() => {
          hideBarTimer = null;
          if (bar && bar.isConnected) bar.style.display = 'none';
        }, 150);
      }
    }

    document.addEventListener('click', () => {
      if (dropdownOpen) closeDropdowns();
    });

    // ========== Incoming auto-translate ==========

    // Detecting incoming vs outgoing messages.
    //
    // As of mid-2026 WhatsApp Web ships fully obfuscated stylex class names
    // (x1n2onr6, _akbu, ...) that are regenerated on every build, and dropped
    // ALL the stable hooks we used to rely on: .message-in / .message-out are
    // gone, the data-id no longer carries the false_/true_ (fromMe) prefix, and
    // span.selectable-text is gone too. The only signals that survive a bundle
    // bump are semantic/structural, so we lean on those:
    //   * a real text message row is a [role="row"] containing a
    //     [data-pre-plain-text] wrapper (which is the .copyable-text element);
    //   * direction is read from horizontal ALIGNMENT — WhatsApp always lays
    //     incoming bubbles left of centre and outgoing right of centre. This is
    //     a layout invariant, not a cosmetic class, so it does not break when
    //     Meta rehashes its CSS.

    // The .copyable-text wrapper carrying data-pre-plain-text is the message
    // text container; we overlay it and read text from it. A row can hold
    // several [data-pre-plain-text] nodes (quoted replies render their own
    // anchor BEFORE the actual body), so take the LAST one — that is always
    // the main message body.
    function getBubbleContainer(row) {
      if (!row) return null;
      const anchors = row.querySelectorAll ? row.querySelectorAll('[data-pre-plain-text]') : null;
      if (anchors && anchors.length) return anchors[anchors.length - 1];
      return (row.querySelector && row.querySelector('.copyable-text')) || row;
    }

    function isMessageRow(row) {
      return !!(row && row.querySelector && row.querySelector('[data-pre-plain-text]'));
    }

    // Direction via edge-gap comparison: the bubble hugging an edge belongs
    // to that side — incoming bubbles hug the start edge (left in LTR),
    // outgoing hug the end edge. Comparing edge gaps (instead of centres) is
    // robust for wide bubbles whose centre crosses the midline. RTL layouts
    // invert the mapping. If layout is not ready yet (width 0) we return
    // false and let the next sweep retry rather than risk mislabelling.
    // 'in' | 'out' | null (разметка ещё не измерима — повторить на следующем свипе)
    function rowDirection(row) {
      const bubble = getBubbleContainer(row);
      if (!bubble || bubble === row) return null;
      const br = bubble.getBoundingClientRect();
      if (!br || br.width === 0) return null;
      const main = document.querySelector('#main');
      const mr = main ? main.getBoundingClientRect() : null;
      if (!mr || mr.width === 0) return null;
      const leftGap = br.left - mr.left;
      const rightGap = mr.right - br.right;
      let incoming = leftGap < rightGap;
      try {
        if (getComputedStyle(document.body).direction === 'rtl') incoming = !incoming;
      } catch {}
      return incoming ? 'in' : 'out';
    }

    // Collect candidate message rows under root (the full chat on a sweep, or a
    // single mutation subtree from the observer). Direction is filtered later
    // in processIncomingBubble so the observer and sweep share one code path.
    function collectMessageRows(root) {
      const out = new Set();
      if (!root || (root.nodeType !== 1 && root.nodeType !== 9)) return out;
      try {
        if (root.matches && root.matches('[role="row"]') && isMessageRow(root)) out.add(root);
      } catch {}
      if (root.querySelectorAll) {
        const rows = root.querySelectorAll('[role="row"]');
        for (let i = 0; i < rows.length; i++) {
          if (isMessageRow(rows[i])) out.add(rows[i]);
        }
        // Mutation subtrees sometimes hand us a node INSIDE a row rather than
        // the row itself; climb to the enclosing row so we still catch it.
        if (root.closest) {
          const own = root.closest('[role="row"]');
          if (own && isMessageRow(own)) out.add(own);
        }
      }
      return out;
    }

    function getIncomingBubbles(node) {
      if (!node || node.nodeType !== 1) return [];
      return Array.from(collectMessageRows(node));
    }

    function getMessageText(row) {
      const bubble = getBubbleContainer(row);
      if (!bubble) return '';
      // Prefer the shared extractor from bridge.js — it strips timestamps,
      // tick glyphs and other meta properly. Fall back to raw innerText.
      try {
        if (typeof window.__waDeckExtractMessageFromRow === 'function') {
          const extracted = window.__waDeckExtractMessageFromRow(bubble);
          if (extracted) return String(extracted).trim();
        }
      } catch {}
      const text = bubble.innerText || bubble.textContent || '';
      return String(text || '').trim();
    }

    function renderOverlay(row, translated) {
      if (!row || !row.isConnected || !translated) return;
      const target = getBubbleContainer(row);
      if (!target) return;

      const existing = target.querySelector(':scope > .__wadeck-tr-overlay');
      if (existing) existing.remove();

      const P = palette();
      const ov = document.createElement('div');
      ov.className = '__wadeck-tr-overlay';
      ov.style.cssText = [
        'position:absolute',
        'top:0',
        'left:0',
        'right:0',
        'min-height:100%',
        'background:' + P.overlayBg,
        'border:1px solid ' + P.barBorder,
        'border-radius:8px',
        'padding:24px 12px 10px 12px',
        'color:' + P.overlayFg,
        'font-size:13px',
        'line-height:1.4',
        'z-index:9999',
        'box-sizing:border-box',
        'pointer-events:auto',
        'box-shadow:0 2px 10px rgba(0,0,0,0.22)',
        // WhatsApp Web sets user-select:none on most chat surfaces so its
        // own bubble copy/paste can stay controlled. We explicitly opt back
        // in for our overlay so users can select & copy translated text.
        'user-select:text',
        '-webkit-user-select:text',
        'cursor:text',
      ].join(';');

      const closeBtn = document.createElement('span');
      closeBtn.textContent = '✕';
      closeBtn.title = 'Скрыть перевод';
      closeBtn.style.cssText = [
        'position:absolute',
        'top:4px',
        'left:6px',
        'width:20px',
        'height:20px',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'border-radius:4px',
        'cursor:pointer',
        'color:#e5eaf0',
        'background:rgba(255,255,255,0.1)',
        'font-size:11px',
        'line-height:1',
        'user-select:none',
        'transition:background 0.15s',
      ].join(';');
      closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = 'rgba(255,255,255,0.2)'; });
      closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'rgba(255,255,255,0.1)'; });
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        ov.remove();
        try { target.style.minHeight = ''; } catch {}
        const prev = translatedCache.get(row) || {};
        translatedCache.set(row, { state: 'dismissed', translated: prev.translated });
      });
      ov.appendChild(closeBtn);

      const metaEl = document.createElement('span');
      metaEl.textContent = 'авто → рус';
      metaEl.style.cssText = [
        'position:absolute',
        'top:7px',
        'right:10px',
        'font-size:10px',
        'color:' + P.muted,
        'letter-spacing:0.02em',
      ].join(';');
      ov.appendChild(metaEl);

      const body = document.createElement('div');
      body.textContent = translated;
      body.style.cssText = [
        'white-space:pre-wrap',
        'word-wrap:break-word',
        'user-select:text',
        '-webkit-user-select:text',
        'cursor:text',
      ].join(';');
      ov.appendChild(body);

      // Belt-and-suspenders copy handler: WhatsApp Web installs a 'copy'
      // listener on chat ancestors that can swallow our selection (it tries
      // to format the copied bubble itself). When the user copies from
      // inside our overlay, intercept at capture phase and write the plain
      // selection to clipboardData ourselves before WA's handler runs.
      ov.addEventListener('copy', (e) => {
        try {
          const sel = window.getSelection();
          const text = sel ? sel.toString() : '';
          if (text && e.clipboardData) {
            e.clipboardData.setData('text/plain', text);
            e.preventDefault();
            e.stopPropagation();
          }
        } catch {}
      }, true);
      // Stop ancestor mousedown handlers (WA scrolls/focuses on bubble click)
      // from clobbering our text selection mid-drag.
      ov.addEventListener('mousedown', (e) => { e.stopPropagation(); }, true);

      const cs = getComputedStyle(target);
      if (cs.position === 'static') target.style.position = 'relative';
      target.style.isolation = 'isolate';

      target.appendChild(ov);

      // Растягиваем родительский пузырь под высоту перевода, чтобы он не
      // вылезал на следующее сообщение и не уходил под исходящие.
      try {
        target.style.minHeight = '';
        const h = ov.scrollHeight;
        if (h > 0) target.style.minHeight = h + 'px';
      } catch {}
    }

    function clearAllOverlays() {
      const overlays = document.querySelectorAll('.__wadeck-tr-overlay');
      for (let i = 0; i < overlays.length; i++) {
        const parent = overlays[i].parentElement;
        overlays[i].remove();
        try { if (parent) parent.style.minHeight = ''; } catch {}
      }
    }

    function requestMessageTranslate(text, from, to, onResult) {
      const reqId = Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
      const cbName = '__waDeckTrCb_' + reqId;
      let settled = false;
      // A lost host response must not leave the row pending forever nor leak
      // the callback on window: time out after 20s and report a failure so
      // the cache entry can be retried by the sweep.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { delete window[cbName]; } catch {}
        try { onResult(null); } catch {}
      }, 20000);
      window[cbName] = function (result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { onResult(result); } catch {}
        try { delete window[cbName]; } catch {}
      };
      const payload = JSON.stringify({ reqId: reqId, text: text, from: from, to: to });
      __waDeckEmit('TRANSLATE_MSG', payload);
    }

    function applyOutgoingTo(code) {
      if (!code || !TARGET_LANGS.some((l) => l.code === code)) return;
      outgoingTo = code;
      const btn = bar && bar.querySelector('[data-translator-dropdown="to"]');
      if (btn) btn.textContent = getLangLabel(code);
    }

    // Per-contact default outgoing language: ask the host for the stored lang
    // when a chat opens, and persist the user's choice. chatId is the contact's
    // display name (see getChatId); the host scopes it by account.
    function loadContactLangFor(chatId) {
      if (!chatId || chatId === '__unknown_chat__') return;
      const reqId = Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
      const cbName = '__waDeckLangCb_' + reqId;
      const timer = setTimeout(() => { try { delete window[cbName]; } catch {} }, 5000);
      window[cbName] = function (lang) {
        clearTimeout(timer);
        // Rapid chat switch A→B can deliver A's stored language after B's:
        // drop the response if the user already moved to another chat, or
        // B would inherit (and on next save persist) A's target language.
        if (currentChatId === chatId) {
          contactLangKnown = Boolean(String(lang || '').trim());
          try { applyOutgoingTo(String(lang || '')); } catch {}
        }
        try { delete window[cbName]; } catch {}
      };
      __waDeckEmit('GET_LANG', JSON.stringify({ reqId: reqId, chatId: chatId }));
    }

    function saveContactLang(chatId, lang) {
      if (!chatId || chatId === '__unknown_chat__') return;
      __waDeckEmit('SET_LANG', JSON.stringify({ chatId: chatId, lang: lang }));
    }

    function hasOverlay(row) {
      const target = getBubbleContainer(row);
      return Boolean(target && target.querySelector(':scope > .__wadeck-tr-overlay'));
    }

    function processIncomingBubble(row) {
      if (!row || !row.isConnected) return;
      if (!autoTranslate) return;
      const entry = translatedCache.get(row);
      if (entry && entry.state === 'pending') return;
      if (entry && entry.state === 'dismissed') return;
      if (entry && entry.state === 'skipped') return;
      if (entry && entry.state === 'failed') {
        // Retry failed rows on the periodic sweep: 30s backoff between
        // attempts, at most 3 attempts total, then terminal.
        if ((entry.attempts || 0) >= 3) return;
        if (Date.now() - (entry.failedAt || 0) < 30000) return;
      }
      // Already translated — restore overlay if WhatsApp re-rendered the bubble
      if (entry && entry.state === 'done' && entry.translated) {
        if (!hasOverlay(row)) renderOverlay(row, entry.translated);
        return;
      }
      // Переводим и входящие, и исходящие (оператор пишет на языке контакта —
      // ему нужен русский под обоими). Неизмеримый ряд (width 0 в момент
      // layout) НЕ кэшируем — повторим на следующем свипе.
      const dir = rowDirection(row);
      if (!dir) return;
      const text = getMessageText(row);
      if (!text) return;
      const cacheKey = INCOMING_TARGET + '|' + text;
      const cachedTranslated = textCacheGet(cacheKey);
      if (cachedTranslated) {
        if (normWsC(cachedTranslated) === normWsC(text)) { translatedCache.set(row, { state: 'skipped' }); return; }
        translatedCache.set(row, { state: 'done', translated: cachedTranslated });
        renderOverlay(row, cachedTranslated);
        return;
      }
      const prevAttempts = entry && entry.state === 'failed' ? (entry.attempts || 0) : 0;
      translatedCache.set(row, { state: 'pending', attempts: prevAttempts });
      requestMessageTranslate(text, 'auto', INCOMING_TARGET, (result) => {
        if (!result || !result.ok || !result.translated) {
          if (row.isConnected) translatedCache.set(row, { state: 'failed', failedAt: Date.now(), attempts: prevAttempts + 1 });
          return;
        }
        // Populate the text cache even if the row got recycled meanwhile —
        // the next sweep finds the recreated node and reuses the result.
        textCacheSet(cacheKey, result.translated);
        // Язык контакта угадываем только по ВХОДЯЩИМ: свои сообщения на
        // языке контакта удвоили бы счётчик, а на русском — сбили бы его.
        if (dir === 'in') { try { noteDetectedLang(result.detected); } catch {} }
        if (!row.isConnected) return;
        // Сообщение уже на русском (своё, не переведённое) — плашка-дубль не нужна
        if (normWsC(result.translated) === normWsC(text)) {
          translatedCache.set(row, { state: 'skipped' });
          return;
        }
        translatedCache.set(row, { state: 'done', translated: result.translated });
        renderOverlay(row, result.translated);
      });
    }

    function processAllVisibleIncoming() {
      const main = document.querySelector('#main') || document;
      const rows = collectMessageRows(main);
      rows.forEach((row) => {
        processIncomingBubble(row);
        // Clear stale inline min-height left behind when an overlay vanished
        // (WA re-render removed it without our close handler running).
        try {
          const target = getBubbleContainer(row);
          if (target && target.style && target.style.minHeight &&
              !target.querySelector(':scope > .__wadeck-tr-overlay')) {
            target.style.minHeight = '';
          }
        } catch {}
      });
    }

    // ========== Observer for chat messages ==========

    let chatObserver = null;
    let chatObserverRoot = null;
    let chatObserverPending = false;
    let chatObserverCleanup = null;
    function bindChatObserver() {
      if (chatObserverPending) return;
      const root = document.querySelector('#main');
      if (!root) {
        chatObserverPending = true;
        setTimeout(() => {
          chatObserverPending = false;
          bindChatObserver();
        }, 2000);
        return;
      }
      if (chatObserverRoot === root && chatObserver) return;
      if (chatObserver) { try { chatObserver.disconnect(); } catch {} }
      // Cancel the previous binding's pending flush timer so an orphaned
      // closure cannot fire against a dead observer's batch.
      if (chatObserverCleanup) { try { chatObserverCleanup(); } catch {} chatObserverCleanup = null; }
      chatObserverRoot = root;
      // Batch mutations: on heavy scroll / fast-typing WA fires hundreds of
      // mutations per second. Collect them and flush at most every 120ms.
      let pendingBubbles = new Set();
      let flushTimer = null;
      const flush = () => {
        flushTimer = null;
        // window.__waDeckTranslatorDisabled is the host's global kill-switch:
        // without this check the observer kept firing paid translate requests
        // (and re-rendering overlays the dormant loop then stripped) after the
        // user turned the translator off in settings.
        if (!autoTranslate || window.__waDeckTranslatorDisabled || pendingBubbles.size === 0) { pendingBubbles.clear(); return; }
        const batch = Array.from(pendingBubbles);
        pendingBubbles.clear();
        for (let i = 0; i < batch.length; i++) processIncomingBubble(batch[i]);
      };
      chatObserver = new MutationObserver((mutations) => {
        if (!autoTranslate || window.__waDeckTranslatorDisabled) return;
        for (let i = 0; i < mutations.length; i++) {
          const added = mutations[i].addedNodes;
          for (let j = 0; j < added.length; j++) {
            const bubbles = getIncomingBubbles(added[j]);
            for (let k = 0; k < bubbles.length; k++) pendingBubbles.add(bubbles[k]);
          }
        }
        if (!flushTimer) flushTimer = setTimeout(flush, 120);
      });
      chatObserverCleanup = () => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        pendingBubbles.clear();
      };
      chatObserver.observe(root, { childList: true, subtree: true });
    }

    // ========== Bar lifecycle ==========

    // Бар лежит absolute в родителе футера; bottom = высота футера, чтобы он
    // сидел над композером и поднимался вместе с ним при многострочном вводе.
    let footerRO = null;
    let footerObserved = null;
    function syncBarBottom() {
      if (!bar || !bar.isConnected) return;
      const footer = bar.parentElement && bar.parentElement.querySelector(':scope > footer');
      if (!footer) return;
      const h = footer.offsetHeight;
      if (bar.style.bottom !== h + 'px') bar.style.bottom = h + 'px';
      if (footerObserved !== footer && typeof ResizeObserver === 'function') {
        try { if (footerRO) footerRO.disconnect(); } catch {}
        footerRO = new ResizeObserver(() => syncBarBottom());
        footerRO.observe(footer);
        footerObserved = footer;
      }
    }

    function ensureBarInjected() {
      if (bar && bar.isConnected) { syncBarBottom(); return true; }
      const existing = document.getElementById('__wadeck-translator-bar');
      if (existing) existing.remove();
      bar = null;
      const footer = document.querySelector('footer');
      if (!footer || !footer.parentElement) return false;
      createBar();
      const host = footer.parentElement;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      host.insertBefore(bar, footer);
      syncBarBottom();
      return true;
    }

    let chatEmptyTicks = 0;
    let sweepCounter = 0;
    let chatAnchorEl = null;
    let noRowsState = false;

    // Health probe: a chat is open and [role="row"] elements exist, but none
    // qualifies as a message row — our [data-pre-plain-text] anchor likely
    // died in a WA redesign. Emit once per state change (throttle inside
    // emitHealth caps it to once a minute anyway).
    function checkRowsHealth() {
      const mainEl = document.querySelector('#main');
      if (!mainEl) return;
      const roleRows = mainEl.querySelectorAll('[role="row"]');
      if (roleRows.length === 0) return;
      const broken = collectMessageRows(mainEl).size === 0;
      if (broken !== noRowsState) {
        noRowsState = broken;
        emitHealth({
          script: 'translator-bar',
          ok: !broken,
          detail: broken ? 'no_message_rows' : 'message_rows_recovered',
        });
      }
    }

    function tick() {
      const next = getChatId();
      const chatChanged = next && next !== currentChatId;

      if (next) chatEmptyTicks = 0;
      else chatEmptyTicks++;

      if (chatChanged) {
        currentChatId = next;
        barHiddenByUser = false;
        contactLangKnown = false;
        langGuess = { chat: next, counts: {} };
        // Clear translation cache and overlays when switching chats
        translatedCache = new WeakMap();
        clearAllOverlays();
        // Restore this contact's saved outgoing language (if any).
        loadContactLangFor(next);
      }

      // Even when the chat name is unreadable ('__unknown_chat__'), a swap of
      // the conversation DOM anchor means a different chat was opened — stale
      // overlays must still be cleared.
      const anchorEl = document.querySelector('#main header') || document.querySelector('#main');
      if (!chatChanged && next === '__unknown_chat__' &&
          anchorEl && chatAnchorEl && anchorEl !== chatAnchorEl) {
        translatedCache = new WeakMap();
        clearAllOverlays();
      }
      chatAnchorEl = anchorEl;

      if (!next) {
        if (chatEmptyTicks >= 5) {
          currentChatId = '';
          if (bar && bar.isConnected && bar.style.display !== 'none') hideBar();
        }
        return;
      }

      const injected = ensureBarInjected();
      if (injected) {
        if (!barHiddenByUser) showBar();
        if (chatChanged && autoTranslate) processAllVisibleIncoming();
      }

      // Sweep for detached overlays every 3 ticks (3s) instead of every tick
      sweepCounter++;
      if (sweepCounter >= 3) {
        sweepCounter = 0;
        if (autoTranslate) processAllVisibleIncoming();
        checkRowsHealth();
      }

      if (chatObserverRoot && !chatObserverRoot.isConnected) {
        chatObserverRoot = null;
        if (chatObserver) { try { chatObserver.disconnect(); } catch {} chatObserver = null; }
        if (chatObserverCleanup) { try { chatObserverCleanup(); } catch {} chatObserverCleanup = null; }
      }
      if (!chatObserverRoot && !chatObserverPending) {
        bindChatObserver();
      }
    }

    function loopTick() {
      // Global kill-switch set by renderer: tear down bar + overlays and stay dormant.
      // Keep the loop alive so re-enabling (flag cleared + script reinject) takes effect.
      if (window.__waDeckTranslatorDisabled === true) {
        try {
          const staleBar = document.getElementById('__wadeck-translator-bar');
          if (staleBar) staleBar.remove();
          document.querySelectorAll('.__wadeck-tr-overlay').forEach((o) => o.remove());
          bar = null;
          currentChatId = '';
        } catch {}
        setTimeout(loopTick, 2000);
        return;
      }
      try { tick(); } catch (e) { console.warn('[WA-Deck translator] tick error:', e); }
      // Idle-backoff: неактивный (фоновый) webview тикает реже — новые входящие
      // ловит MutationObserver в реальном времени, loop лишь поддерживает бар и
      // подчищает. Дефолт (флаг не выставлен) = активный режим 1с (безопасно).
      const active = window.__waDeckWebviewActive !== false;
      setTimeout(loopTick, active ? 1000 : 3000);
    }

    // Init
    loopTick();

    // Восстановление persisted-тумблера «Авто вх.»: раньше состояние жило
    // только в JS-контексте страницы и сбрасывалось каждым рестартом,
    // перезагрузкой webview и пробуждением из гибернации. Pull-модель:
    // спрашиваем хост при каждом инжекте (SET_AUTO_TR пишется по клику).
    (function restoreAutoTranslate() {
      try {
        const reqId = 'a' + Math.random().toString(36).slice(2, 10);
        window['__waDeckAutoTrCb_' + reqId] = function (on) {
          try { delete window['__waDeckAutoTrCb_' + reqId]; } catch (e) {}
          if (!on || autoTranslate) return;
          autoTranslate = true;
          const t = document.querySelector('.__wadeck-auto-toggle');
          if (t && t.__paint) t.__paint();
          translatedCache = new WeakMap();
          processAllVisibleIncoming();
        };
        __waDeckEmit('GET_AUTO_TR', JSON.stringify({ reqId: reqId }));
      } catch (e) { /* переводчик работает и без персиста */ }
    })();

    return true;
  })();`;
}

export { translatorBarScript };

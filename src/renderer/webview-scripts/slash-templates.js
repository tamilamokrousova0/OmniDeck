/* Slash-templates: «/» первым символом в композере WhatsApp открывает
 * фильтруемый список шаблонов над полем ввода; ↑/↓ — выбор, Enter/клик —
 * вставка (с подстановкой {имя}/{приветствие}/{дата}/{время}), Esc — закрыть.
 *
 * Паттерн выживания скопирован с translator-bar: bound-guard + capture-слушатели
 * на document (переживают пересоздание композера WhatsApp'ом). Список шаблонов
 * запрашивается у хоста через GET_TEMPLATES (свежий на каждое открытие, с
 * коротким кэшем на время набора фильтра).
 */
function slashTemplatesScript(token) {
  const tokenJs = JSON.stringify(typeof token === 'string' ? token : '');
  return `(() => {
    if (window.__waDeckSlashBound) return true;
    window.__waDeckSlashBound = true;

    const __WADECK_TOKEN = ${tokenJs};
    const __waDeckEmit = (kind, json) => {
      const send = window.__waDeckGuestSend;
      if (typeof send === 'function') {
        try { send(__WADECK_TOKEN, kind, json); return; } catch {}
      }
      console.log('__WADECK_' + kind + '__' + __WADECK_TOKEN + ':' + json);
    };

    // Stale popup from a prior init (context-preserving reload)
    try {
      const stale = document.getElementById('__wadeck-slash-popup');
      if (stale) stale.remove();
    } catch {}

    let popup = null;
    let watchTimer = null;
    let items = [];        // отфильтрованные шаблоны, отображаемые сейчас
    let selIndex = 0;
    let templatesCache = null;
    let templatesCacheAt = 0;
    const CACHE_MS = 30000;

    function getComposer() {
      const main = document.querySelector('#main') || document;
      return (
        document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
        document.querySelector('footer div[contenteditable="true"][data-tab]') ||
        main.querySelector('div[contenteditable="true"][role="textbox"]')
      );
    }

    function getChatName() {
      // Перебираем ВСЕ совпадения каждого селектора (первый span в шапке
      // бывает строкой статуса) и срезаем невидимые directional-метки WA
      // (\\u200e и др.) — из-за них «В сети» проскакивал ^-фильтр и
      // подставлялся в {имя}.
      const clean = (v) => String(v || '').replace(/[\\u200e\\u200f\\u2066-\\u2069]/g, '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const isStatus = (t) => {
        const v = clean(t).toLowerCase();
        if (!v || v.length < 2) return true;
        if (/^(online|в сети|typing|печатает|recording|записывает|last seen|seen |был|была|нажмите|tap here|click here|select |выберите)/i.test(v)) return true;
        // Короткая строка со временем = presence («был(-а) сегодня в 20:24»)
        if (/\\d{1,2}:\\d{2}/.test(v) && v.length <= 60) return true;
        return false;
      };
      const selectors = [
        '#main header span[title]',
        '#main header [data-testid="conversation-header"] span[title]',
        '#main header span[dir="auto"]',
      ];
      for (let i = 0; i < selectors.length; i++) {
        const els = document.querySelectorAll(selectors[i]);
        for (let j = 0; j < els.length; j++) {
          const val = clean(els[j].getAttribute('title') || els[j].textContent || '');
          if (!isStatus(val)) return val;
        }
      }
      return '';
    }

    /* Подстановка переменных — зеркало applyTemplateVariables из helpers.js
       (host-версия недоступна в page-контексте). {имя} без известного имени
       остаётся как есть, чтобы оператор заметил. */
    function substituteVars(text) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      let out = String(text || '');
      if (!/\\{(имя|приветствие|дата|время)\\}/i.test(out)) return out;
      const h = now.getHours();
      const greeting = (h >= 5 && h < 12) ? 'Доброе утро' : (h >= 12 && h < 18) ? 'Добрый день' : (h >= 18 && h < 23) ? 'Добрый вечер' : 'Доброй ночи';
      out = out.replace(/\\{приветствие\\}/gi, greeting);
      out = out.replace(/\\{дата\\}/gi, pad(now.getDate()) + '.' + pad(now.getMonth() + 1) + '.' + now.getFullYear());
      out = out.replace(/\\{время\\}/gi, pad(now.getHours()) + ':' + pad(now.getMinutes()));
      // Чистое имя: срезаем хвостовой код контакта («Jan NL55» → «Jan»)
      let name = getChatName();
      name = (function (n) {
        n = String(n || '').trim();
        const st = n.replace(/\\s+[A-Za-zА-Яа-яЁё]{0,4}\\d{1,4}$/u, '').trim();
        return st || n;
      })(name);
      if (name) out = out.replace(/\\{имя\\}/gi, name);
      return out;
    }

    function fetchTemplates(onReady) {
      if (templatesCache && (Date.now() - templatesCacheAt) < CACHE_MS) {
        onReady(templatesCache);
        return;
      }
      const reqId = Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
      const cbName = '__waDeckTplCb_' + reqId;
      const timer = setTimeout(() => {
        try { delete window[cbName]; } catch {}
        onReady(templatesCache || []);
      }, 5000);
      window[cbName] = function (list) {
        clearTimeout(timer);
        try { delete window[cbName]; } catch {}
        templatesCache = Array.isArray(list) ? list : [];
        templatesCacheAt = Date.now();
        onReady(templatesCache);
      };
      __waDeckEmit('GET_TEMPLATES', JSON.stringify({ reqId: reqId, chatId: getChatName() }));
    }

    function closePopup() {
      window.__waDeckSlashPopupOpen = false;
      if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
      if (popup) { try { popup.remove(); } catch {} popup = null; }
      items = [];
      selIndex = 0;
      // Кэш живёт только в рамках одной сессии набора: иначе правка шаблона
      // в панели до 30 секунд показывала в попапе старый текст.
      templatesCache = null;
      templatesCacheAt = 0;
    }

    function insertSelected() {
      const item = items[selIndex];
      const composer = getComposer();
      closePopup();
      if (!item || !composer) return;
      // Замену делает ХОСТ нативным вводом: только реальный ввод (click +
      // Cmd/Ctrl+A + Backspace) надёжно очищает Lexical-редактор WhatsApp —
      // guest-execCommand('delete') его не чистит, и остаток команды («/de»)
      // прилипал к шаблону, а фолбэки плодили дубли. {имя}/{дата} уже
      // подставлены здесь (getChatName доступен только в странице).
      __waDeckEmit('INSERT_TEMPLATE', JSON.stringify({ text: substituteVars(item.text), title: String(item.title || '') }));
    }

    function buildPopup() {
      const el = document.createElement('div');
      el.id = '__wadeck-slash-popup';
      el.style.cssText = [
        'position:fixed',
        'z-index:9999',
        'background:#1f2937',
        'color:#e5eaf0',
        'border-radius:10px',
        'box-shadow:0 8px 28px rgba(0,0,0,0.45)',
        'padding:6px',
        'min-width:280px',
        'max-width:420px',
        'max-height:280px',
        'overflow-y:auto',
        'font-family:Avenir Next,Segoe UI,system-ui,sans-serif',
        'font-size:12.5px',
      ].join(';');
      const hint = document.createElement('div');
      hint.textContent = 'Шаблоны · ↑↓ выбор · Enter вставить · Esc закрыть';
      hint.style.cssText = 'padding:4px 8px 6px;font-size:10.5px;color:#9ca3af;border-bottom:1px solid rgba(255,255,255,0.08);margin-bottom:4px;';
      el.appendChild(hint);
      const listEl = document.createElement('div');
      listEl.className = '__wadeck-slash-list';
      el.appendChild(listEl);
      return el;
    }

    function positionPopup() {
      const footer = document.querySelector('footer');
      if (!footer || !popup) return;
      const r = footer.getBoundingClientRect();
      popup.style.left = Math.round(r.left + 8) + 'px';
      popup.style.bottom = Math.round(window.innerHeight - r.top + 6) + 'px';
      popup.style.top = 'auto';
    }

    function renderList() {
      if (!popup) return;
      const listEl = popup.querySelector('.__wadeck-slash-list');
      if (!listEl) return;
      listEl.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.textContent = templatesCache && templatesCache.length ? 'Ничего не найдено' : 'Шаблонов нет — добавьте их в панели «Шаблоны»';
        empty.style.cssText = 'padding:8px;color:#9ca3af;';
        listEl.appendChild(empty);
        return;
      }
      items.forEach((tpl, idx) => {
        const row = document.createElement('div');
        row.style.cssText = [
          'padding:6px 8px',
          'border-radius:6px',
          'cursor:pointer',
          'display:flex',
          'flex-direction:column',
          'gap:1px',
          'background:' + (idx === selIndex ? 'rgba(61,214,140,0.16)' : 'transparent'),
        ].join(';');
        const title = document.createElement('div');
        title.textContent = tpl.title || 'Шаблон';
        title.style.cssText = 'font-weight:600;color:' + (idx === selIndex ? '#3dd68c' : '#e5eaf0') + ';';
        const preview = document.createElement('div');
        preview.textContent = String(tpl.text || '').replace(/\\s+/g, ' ').slice(0, 64);
        preview.style.cssText = 'font-size:11px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        row.appendChild(title);
        row.appendChild(preview);
        // mousedown, не click: click схлопнул бы фокус композера до вставки
        row.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); selIndex = idx; insertSelected(); });
        row.addEventListener('mouseenter', () => { if (selIndex !== idx) { selIndex = idx; renderList(); } });
        listEl.appendChild(row);
      });
    }

    function openOrUpdate(query) {
      fetchTemplates((all) => {
        const q = String(query || '').trim().toLowerCase();
        items = (all || []).filter((tpl) => {
          if (!q) return true;
          return String(tpl.title || '').toLowerCase().includes(q) ||
                 String(tpl.text || '').toLowerCase().includes(q);
        }).slice(0, 30);
        if (selIndex >= items.length) selIndex = Math.max(0, items.length - 1);
        if (!popup) {
          popup = buildPopup();
          document.body.appendChild(popup);
          window.__waDeckSlashPopupOpen = true;
          startWatch();
        }
        positionPopup();
        renderList();
      });
    }

    function composerSlashQuery() {
      const composer = getComposer();
      if (!composer) return null;
      const text = String(composer.innerText || '').replace(/\\u00a0/g, ' ');
      // Только однострочный запрос, начинающийся с «/» — иначе не режим шаблонов
      const trimmed = text.replace(/\\n+$/, '');
      if (!trimmed.startsWith('/') || trimmed.includes('\\n')) return null;
      return trimmed.slice(1);
    }

    document.addEventListener('input', (e) => {
      const composer = getComposer();
      if (!composer || !(composer === e.target || composer.contains(e.target))) return;
      const q = composerSlashQuery();
      if (q === null) { closePopup(); return; }
      // «//» — повторить последний вставленный шаблон (замену делает хост)
      if (q === '/') { closePopup(); __waDeckEmit('REPEAT_LAST_TEMPLATE', '{}'); return; }
      openOrUpdate(q);
    }, true);

    // На WINDOW, не на document: capture-фаза window срабатывает раньше
    // document-capture, где Lexical WhatsApp глушит стрелки/Enter своим
    // обработчиком (stopImmediatePropagation) — из-за этого выбор в попапе
    // был мёртв. stopImmediatePropagation с нашей стороны симметрично не даёт
    // WA отправить сообщение по Enter, пока открыт попап.
    window.addEventListener('keydown', (e) => {
      if (!popup) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault(); e.stopImmediatePropagation();
        selIndex = Math.min(selIndex + 1, Math.max(0, items.length - 1));
        renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault(); e.stopImmediatePropagation();
        selIndex = Math.max(0, selIndex - 1);
        renderList();
      } else if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        // Только чистый Enter — модификаторные комбо не наши.
        e.preventDefault(); e.stopImmediatePropagation();
        insertSelected();
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopImmediatePropagation();
        closePopup();
      }
    }, true);

    // Клик мимо попапа / уход из чата — закрыть; следим и за отвалившимся композером
    document.addEventListener('mousedown', (e) => {
      if (popup && !popup.contains(e.target)) closePopup();
    }, true);
    /* Сторож живёт только пока попап открыт: постоянный секундный интервал
       тикал во всех вебвью, включая фоновые аккаунты. */
    function startWatch() {
      if (watchTimer) return;
      watchTimer = setInterval(() => {
        if (popup && (!getComposer() || composerSlashQuery() === null)) closePopup();
        if (popup) positionPopup();
        else if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
      }, 1000);
    }

    return true;
  })();`;
}

export { slashTemplatesScript };

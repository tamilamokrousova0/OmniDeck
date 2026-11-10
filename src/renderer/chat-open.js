/* chat-open.js — открытие чата в webview WhatsApp по имени (поиск / клик по
 * списку) + блокировка «один водитель на webview». Используется глобальным
 * поиском, избранным, «важными» и лентой непрочитанных. */

  let isWebviewReady, sendWebviewInput, delay;

  function init(ctx) {
    isWebviewReady = ctx.isWebviewReady;
    sendWebviewInput = ctx.sendWebviewInput;
    delay = ctx.delay;
  }

  async function waitForWebviewReady(webview, timeoutMs = 12000) {
    if (!webview) return false;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      if (isWebviewReady(webview) && (!webview.isLoading || !webview.isLoading())) {
        return true;
      }
      await delay(120);
    }
    return Boolean(isWebviewReady(webview));
  }

  /* Low-level webview drivers for openChatInWebview(). Pure functions of the
     webview — no flow state. */
  function makeWebviewDrivers(webview) {
    const query = async (script) => {
      try {
        return await webview.executeJavaScript(script, true);
      } catch (err) {
        return { _error: String(err?.message || err) };
      }
    };

    const nativeClick = async (x, y) => {
      await sendWebviewInput(webview, { type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      await delay(30);
      await sendWebviewInput(webview, { type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
      await delay(50);
    };

    const nativeType = async (str) => {
      for (const ch of str) {
        if (ch === '\n') {
          // WhatsApp's composer treats Enter as "send" — a raw '\n' char event
          // either vanishes or fires the send path mid-message. Line breaks
          // need the Shift+Enter sequence.
          await sendWebviewInput(webview, { type: 'keyDown', keyCode: 'Return', modifiers: ['shift'] });
          await sendWebviewInput(webview, { type: 'char', keyCode: 'Return', modifiers: ['shift'] });
          await sendWebviewInput(webview, { type: 'keyUp', keyCode: 'Return', modifiers: ['shift'] });
          await delay(30);
          continue;
        }
        if (ch === '\r') continue;
        await sendWebviewInput(webview, { type: 'char', keyCode: ch });
        await delay(8);
      }
    };

    const nativeKey = async (keyCode) => {
      await sendWebviewInput(webview, { type: 'keyDown', keyCode });
      await delay(30);
      await sendWebviewInput(webview, { type: 'keyUp', keyCode });
      await delay(50);
    };

    return { query, nativeClick, nativeType, nativeKey };
  }

  /**
   * Open a WhatsApp Web chat by contact name inside the given webview:
   * search → type name → click best match → wait for composer.
   * Shared by every surface that jumps straight into a chat — e.g. the
   * inbox rows — can jump straight into a chat. Returns { ok } or
   * { ok: false, error }.
   */
  /* Нормализация имени чата: невидимые LTR/RTL-метки, неразрывные пробелы и
     кратные пробелы приводятся к одному виду по обе стороны сравнения. */
  function normalizeChatName(value) {
    return String(value || '')
      .replace(/\u200e|\u200f/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /* Заголовок реально открытого чата. Единственный надёжный признак того,
     КОМУ мы сейчас напишем: поиск допускает частичное совпадение («Anna» →
     «Anna Maria»), а наличие композера доказывает лишь, что чат какой-то
     открыт, в том числе прежний. */
  function readOpenChatTitle(query) {
    return query(`(() => {
      const normalize = (v) => String(v || '').replace(/\\u200e|\\u200f/g, '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const pickVisible = (sel) => {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return el;
        }
        return null;
      };
      const header =
        pickVisible('#main header') ||
        pickVisible('div[data-testid="conversation-header"]') ||
        pickVisible('main header') ||
        pickVisible('div[role="main"] header') ||
        null;
      if (!header) return { found: false };
      const strict = header.querySelector('[data-testid="conversation-info-header-chat-title"], [data-testid="conversation-title"], [data-testid="conversation-header-name"]');
      if (strict) {
        const t = normalize(strict.getAttribute('title') || strict.textContent || '');
        if (t) return { found: true, title: t };
      }
      // WA рисует имя первой строкой шапки, статус — следующими.
      const nodes = Array.from(header.querySelectorAll('span[dir="auto"], div[dir="auto"]')).filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      for (const el of nodes) {
        const t = normalize(el.getAttribute('title') || el.textContent || '');
        if (t && t.length < 80 && !/^\\d{1,2}:\\d{2}$/.test(t)) return { found: true, title: t };
      }
      return { found: false };
    })()`);
  }

  /* Сверка открытого чата с целью. Fail-closed при расхождении имени.
     Нечитаемая шапка (редизайн WA) не блокирует переход — иначе один
     переименованный селектор ломал бы все прыжки в чат; такой случай
     помечается unverified. */
  async function verifyOpenChatTarget(query, chatNameRaw, opts = {}) {
    const head = await readOpenChatTitle(query);
    if (!head?.found || !head.title) return { ok: true, unverified: true };
    const got = normalizeChatName(head.title);
    const want = normalizeChatName(chatNameRaw);
    if (got === want) return { ok: true, title: head.title };
    // Поиск по номеру: в шапке стоит имя контакта, номера в ней нет.
    if (opts.allowAnyTitle) return { ok: true, title: head.title, unverified: true };
    return { ok: false, error: 'chat_title_mismatch', title: head.title };
  }

  /* Один «водитель» на webview за раз. Прыжок в чат
     (избранные/важные/лента/Cmd+K) и фоновый сбор списка чатов глобального
     поиска кликают и крутят один и тот же #pane-side: сборщик раз в 15 мин
     ~5 с угонял скролл, клик прыжка попадал в соседнюю строку —
     открывался и помечался прочитанным чужой чат. Очередь на промисах:
     следующий ждёт хвост предыдущего, ошибка не рвёт цепочку. */
  const _webviewLocks = new WeakMap(); // webview → Promise (хвост очереди)
  function withWebviewLock(webview, fn) {
    if (!webview) return fn();
    const prev = _webviewLocks.get(webview) || Promise.resolve();
    const run = prev.then(() => fn());
    /* Хвост очереди ограничен по времени: зависший executeJavaScript (reload
       или крэш гостя посреди скрипта) иначе навсегда запирал аккаунт —
       вставали прыжки в чаты. */
    const tail = Promise.race([run, delay(180000)]).catch(() => {});
    _webviewLocks.set(webview, tail);
    tail.then(() => { if (_webviewLocks.get(webview) === tail) _webviewLocks.delete(webview); });
    return run;
  }
  function isWebviewLocked(webview) {
    return Boolean(webview && _webviewLocks.has(webview));
  }

  async function openChatInWebview(webview, chatNameRaw, opts = {}) {
    const chatName = String(chatNameRaw || '').trim();
    if (!chatName) return { ok: false, error: 'no_chat_name' };

    const ready = await waitForWebviewReady(webview, 15000);
    if (!ready) return { ok: false, error: 'webview_not_ready' };

    const { query, nativeClick, nativeType, nativeKey } = makeWebviewDrivers(webview);

    /* STEP 1: Find search input and click it (with wake-up retry) */
    const findSearchInput = () => query(`(() => {
      const selectors = ['#side input[role="textbox"][data-tab="3"]', '#side input[role="textbox"]', '#side input[placeholder]'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: r.left + r.width/2, y: r.top + r.height/2, found: true };
        }
      }
      return { found: false };
    })()`);

    let searchRect = await findSearchInput();

    /* If not found, webview may be suspended (Windows Efficiency Mode).
       Reload to wake it up and retry. */
    if (!searchRect?.found) {
      console.warn('[chat-open] search input not found, attempting webview wake-up reload...');
      try { webview.reload(); } catch (_e) { /* ignore */ }
      await delay(3000);
      const reloaded = await waitForWebviewReady(webview, 20000);
      if (reloaded) {
        await delay(2000);
        searchRect = await findSearchInput();
      }
    }

    if (!searchRect?.found) return { ok: false, error: 'search_input_not_found' };

    await nativeClick(searchRect.x, searchRect.y);
    await delay(200);

    /* STEP 2: Clear search and type chat name. Чистка нужна редко (поиск
       обычно пуст) — пропускаем select-all+Backspace, когда поле пустое. */
    const searchState = await query(`(() => {
      const a = document.activeElement;
      return { text: String(a?.innerText || a?.value || '').trim() };
    })()`);
    if (searchState?.text) {
      const selectAllMod = navigator.platform?.includes('Mac') ? 'meta' : 'control';
      await sendWebviewInput(webview, { type: 'keyDown', keyCode: 'a', modifiers: [selectAllMod] });
      await sendWebviewInput(webview, { type: 'keyUp', keyCode: 'a', modifiers: [selectAllMod] });
      await delay(50);
      await nativeKey('Backspace');
      await delay(100);
    }

    await nativeType(chatName);

    /* STEP 3: Find matching search result. Вместо фиксированных 600 мс —
       опрос появления совпадения каждые 100 мс (потолок ~700 мс): результаты
       обычно готовы за 100-300 мс, и клик уходит сразу. Ранний матч безопасен:
       кликаем только строку с совпавшим title. */
    const chatNameLower = chatName.toLowerCase();
    let matchResult = null;
    for (let attempt = 0; attempt < 7; attempt++) {
      await delay(100);
      matchResult = await runSearchMatchQuery();
      if (matchResult?.exact || matchResult?.partial || matchResult?.first) break;
    }
    async function runSearchMatchQuery() {
      return query(`(() => {
      const normalize = (v) => String(v || '').replace(/\\u200e|\\u200f/g, '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const query = normalize(${JSON.stringify(chatName)}).toLowerCase();
      const items = Array.from(document.querySelectorAll('#pane-side [role="row"], #side [role="row"]'));
      let exact = null;
      let partial = null;
      let first = null;
      let partialCount = 0;
      for (const item of items) {
        const titleEl = item.querySelector('span[title], div[title], [data-testid="cell-frame-title"]');
        const title = normalize(titleEl?.getAttribute('title') || titleEl?.textContent || '');
        if (!title) continue;
        const r = item.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;
        const hit = { x: r.left + r.width/2, y: r.top + r.height/2, title, w: r.width, h: r.height };
        if (!first) first = hit;
        const lower = title.toLowerCase();
        if (lower === query) { if (!exact) exact = hit; }
        else if (lower.includes(query)) { partialCount++; if (!partial) partial = hit; }
      }
      return { exact, partial, partialCount, first, itemCount: items.length };
    })()`);
    }

    /* Поиск по номеру телефона: WhatsApp находит сохранённый контакт, но в
     * заголовке результата стоит ИМЯ — номер в нём не встречается, поэтому
     * exact/partial пустые. По просьбе вызывающего кликаем первый результат. */
    const m = matchResult || {};
    /* Точное совпадение — всегда. Частичное — только если оно единственное:
       «Anna» при живых «Anna» и «Anna Maria» иначе уходила первому попавшемуся. */
    const target = m.exact?.x
      ? m.exact
      : (m.partial?.x && m.partialCount === 1 ? m.partial
        : (opts.pickFirstResult && m.first?.x ? m.first : null));

    if (!target?.x) {
      await nativeKey('Escape');
      const ambiguous = !m.exact && Number(m.partialCount || 0) > 1;
      return { ok: false, error: ambiguous ? 'chat_name_ambiguous' : 'chat_not_found', debug: m };
    }

    /* STEP 4: Click the search result. 500→250 мс: дальше и так стоит
       verify-цикл композера (25×150 мс); полностью убирать паузу нельзя —
       композер прошлого чата подтвердил бы «открылось» до реального переключения. */
    await nativeClick(target.x, target.y);
    await delay(250);

    /* STEP 5: Verify chat opened */
    let composerReady = false;
    for (let i = 0; i < 25; i++) {
      const check = await query(`(() => {
        const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
                  document.querySelector('footer div[contenteditable="true"]');
        return { hasComposer: Boolean(c) };
      })()`);
      if (check?.hasComposer) { composerReady = true; break; }
      await delay(150);
    }

    if (!composerReady) {
      await nativeKey('Escape');
      await delay(100);
      return { ok: false, error: 'chat_not_confirmed_after_click', clickTarget: target };
    }

    /* STEP 6: Сверить шапку. Композер есть и у прежнего чата, поэтому без
       этой проверки «медленное переключение» выглядит как успешное открытие. */
    const verified = await verifyOpenChatTarget(query, chatName, {
      allowAnyTitle: Boolean(opts.pickFirstResult) || target === m.first,
    });
    if (!verified.ok) {
      return { ok: false, error: verified.error, openedTitle: verified.title, wanted: chatName };
    }

    return { ok: true, unverified: verified.unverified === true, openedTitle: verified.title };
  }

  /**
   * Open a chat by directly clicking its row in the rendered chat list
   * (#pane-side) — WITHOUT touching the search box. Used by the favorites
   * strip: a favorite only surfaces while it has unread messages, and unread
   * chats bubble to the TOP of WhatsApp's list, so a no-scroll scan of the
   * already-rendered rows reliably finds them. This avoids the search →
   * type → pick flow, which is slower, mutates the search box, and can match
   * the wrong contact. Returns { ok } or { ok: false, error } so callers can
   * fall back to openChatInWebview() (search-based) when the row isn't visible.
   */
  async function openChatByListClick(webview, chatNameRaw) {
    const chatName = String(chatNameRaw || '').trim();
    if (!chatName) return { ok: false, error: 'no_chat_name' };

    const ready = await waitForWebviewReady(webview, 15000);
    if (!ready) return { ok: false, error: 'webview_not_ready' };

    const { query, nativeClick, nativeKey } = makeWebviewDrivers(webview);

    /* Find a matching row among the rendered chat-list items (no search). */
    const matchResult = await query(`(() => {
      const normalize = (v) => String(v || '').replace(/\\u200e|\\u200f/g, '').replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim();
      const query = normalize(${JSON.stringify(chatName)}).toLowerCase();
      const items = Array.from(document.querySelectorAll('#pane-side [role="row"]'));
      let exact = null;
      let partial = null;
      for (const item of items) {
        const titleEl = item.querySelector('span[title], div[title], [data-testid="cell-frame-title"]');
        const title = normalize(titleEl?.getAttribute('title') || titleEl?.textContent || '');
        if (!title) continue;
        const lower = title.toLowerCase();
        const r = item.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) continue;       // not actually visible
        if (lower === query && !exact) {
          exact = { x: r.left + r.width/2, y: r.top + r.height/2, title };
        } else if (lower.includes(query) && !partial) {
          partial = { x: r.left + r.width/2, y: r.top + r.height/2, title };
        }
        if (exact) break;
      }
      return exact || partial || { found: false, itemCount: items.length };
    })()`);

    if (!matchResult?.x) return { ok: false, error: 'chat_not_in_list', debug: matchResult };

    await nativeClick(matchResult.x, matchResult.y);
    await delay(150);

    /* Verify the chat actually opened (composer present). */
    let composerReady = false;
    for (let i = 0; i < 25; i++) {
      const check = await query(`(() => {
        const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
                  document.querySelector('footer div[contenteditable="true"]');
        return { hasComposer: Boolean(c) };
      })()`);
      if (check?.hasComposer) { composerReady = true; break; }
      await delay(150);
    }

    if (!composerReady) {
      await nativeKey('Escape');
      return { ok: false, error: 'chat_not_confirmed_after_click', clickTarget: matchResult };
    }

    const verified = await verifyOpenChatTarget(query, chatName);
    if (!verified.ok) {
      return { ok: false, error: verified.error, openedTitle: verified.title, wanted: chatName };
    }

    return { ok: true, unverified: verified.unverified === true, openedTitle: verified.title };
  }

  export const WaDeckChatOpenModule = {
    init,
    // Снаружи — только через блокировку webview (см. withWebviewLock).
    openChatInWebview: (webview, chatName, opts) =>
      withWebviewLock(webview, () => openChatInWebview(webview, chatName, opts)),
    openChatByListClick: (webview, chatName) =>
      withWebviewLock(webview, () => openChatByListClick(webview, chatName)),
    withWebviewLock,
    isWebviewLocked,
  };
  window.WaDeckChatOpenModule = WaDeckChatOpenModule;

import { WADECK_WV_TOKEN } from './core/state.js';
import { closeModalAnimated, showToast, setToolbarLabel } from './core/helpers.js';
import { collectChatsFromSidebarScript } from './webview-scripts/collect-chats.js';

  let state, els, setStatus, trimMapSize, runWithBusyButton;
  let accountById, ensureWebview, isWebviewReady, sendWebviewInput, delay;
  let formatDateTime, nextSendAtLocal, showConfirm, applyTemplateVariables;

  let _inited = false;

  function init(ctx) {
    _inited = true;
    state = ctx.state;
    els = ctx.els;
    setStatus = ctx.setStatus;
    trimMapSize = ctx.trimMapSize;
    runWithBusyButton = ctx.runWithBusyButton;
    accountById = ctx.accountById;
    ensureWebview = ctx.ensureWebview;
    isWebviewReady = ctx.isWebviewReady;
    sendWebviewInput = ctx.sendWebviewInput;
    delay = ctx.delay;
    formatDateTime = ctx.formatDateTime;
    nextSendAtLocal = ctx.nextSendAtLocal;
    showConfirm = ctx.showConfirm;
    applyTemplateVariables = ctx.applyTemplateVariables;

    // Edit-mode banner: the ✕ button cancels editing without saving.
    document.getElementById('schedule-edit-cancel')?.addEventListener('click', () => {
      cancelScheduleEditMode();
      setStatus('Редактирование отменено');
    });
  }

  /* ── Schedule edit mode ──
     state._editingScheduleId links the form to an existing scheduled item.
     The banner makes the mode visible; cancelScheduleEditMode() drops the
     linkage (called on save, explicit cancel, section/panel close and
     target change). */
  function setScheduleEditBannerVisible(visible) {
    const banner = document.getElementById('schedule-edit-banner');
    if (banner) banner.classList.toggle('hidden', !visible);
  }

  function cancelScheduleEditMode() {
    if (!_inited) return;
    if (!state) return;
    state._editingScheduleId = null;
    setScheduleEditBannerVisible(false);
  }

  function renderScheduleTarget() {
    if (!_inited) return; // лайт-сборка: планировщика нет
    if (!state.scheduleTarget.accountId || !state.scheduleTarget.chatName) {
      els.scheduleTarget.value = '';
      return;
    }
    els.scheduleTarget.value = `${state.scheduleTarget.accountName} / ${state.scheduleTarget.chatName}`;
  }

  // In-flight collector runs per account. The collect script hijacks
  // #pane-side.scrollTop for up to ~4.6s — two concurrent runs would fight
  // over the scroll position and both return truncated/garbled lists.
  const _chatFetchInflight = new Map();

  async function fetchChatsForAccount(accountId, force = false) {
    const safeAccountId = String(accountId || '').trim();
    if (!safeAccountId) return [];

    // Single-entry cache — picker is always scoped to the active account now,
    // so keeping a per-account Map was dead weight. 30s TTL kept for the
    // "pick chat → apply → reopen picker" fast path.
    const cached = state.chatPickerCache;
    if (!force && cached
        && cached.accountId === safeAccountId
        && Date.now() - cached.at < 30000) {
      return cached.chats;
    }

    const inflight = _chatFetchInflight.get(safeAccountId);
    if (inflight) return inflight;

    const webview = state.webviews.get(safeAccountId);
    if (!webview) return [];

    const run = (async () => {
      let chats = [];
      try {
        const wvToken = typeof WADECK_WV_TOKEN !== 'undefined' ? WADECK_WV_TOKEN : '';
        chats = await webview.executeJavaScript(collectChatsFromSidebarScript(wvToken), true);
      } catch {
        chats = [];
      }

      const normalized = Array.isArray(chats)
        ? chats.map((chat) => String(chat || '').trim()).filter(Boolean)
        : [];

      state.chatPickerCache = { accountId: safeAccountId, at: Date.now(), chats: normalized };
      return normalized;
    })();
    _chatFetchInflight.set(safeAccountId, run);
    try {
      return await run;
    } finally {
      _chatFetchInflight.delete(safeAccountId);
    }
  }

  // Generation token: a quick account switch must not let a late response
  // for the OLD account overwrite the freshly populated list of the NEW one.
  let _pickerChatsGen = 0;

  async function refreshPickerChats(force = false) {
    const accountId = String(els.pickerAccount.value || '').trim();
    const account = accountById(accountId);
    const gen = ++_pickerChatsGen;
    if (account?.frozen) {
      els.pickerChat.innerHTML = '';
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Аккаунт заморожен — сначала разморозьте его';
      els.pickerChat.appendChild(option);
      return;
    }
    /* Show loading state while fetching */
    els.pickerChat.innerHTML = '';
    const loadingOpt = document.createElement('option');
    loadingOpt.value = '';
    loadingOpt.textContent = 'Загрузка чатов...';
    els.pickerChat.appendChild(loadingOpt);

    const chats = await fetchChatsForAccount(accountId, force);
    if (gen !== _pickerChatsGen) return; // superseded by a newer request

    els.pickerChat.innerHTML = '';
    if (!chats.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'Чаты не найдены (откройте WhatsApp и дождитесь загрузки)';
      els.pickerChat.appendChild(option);
      return;
    }

    for (const chat of chats) {
      const option = document.createElement('option');
      option.value = chat;
      option.textContent = chat;
      els.pickerChat.appendChild(option);
    }
  }

  async function openChatPicker() {
    // Chat picker is always scoped to the currently active account — the user
    // picks only from *that* account's chats, never across accounts.
    const activeId = String(state.activeAccountId || '').trim();
    const active = accountById(activeId);
    const display = document.getElementById('picker-account-display');

    // Sync the hidden select to the active account for legacy consumers.
    els.pickerAccount.innerHTML = '';
    if (active) {
      const opt = document.createElement('option');
      opt.value = active.id;
      opt.textContent = active.name;
      els.pickerAccount.appendChild(opt);
      els.pickerAccount.value = active.id;
    } else {
      els.pickerAccount.value = '';
    }

    if (display) {
      if (!active) {
        display.textContent = 'Нет активного аккаунта — откройте WhatsApp-аккаунт';
        display.classList.add('is-empty');
      } else if (active.frozen) {
        display.textContent = `${active.name} · заморожен — сначала разморозьте`;
        display.classList.add('is-empty');
      } else {
        display.textContent = `Аккаунт: ${active.name}`;
        display.classList.remove('is-empty');
      }
    }

    els.pickerChat.innerHTML = '';
    if (!active || active.frozen) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = active?.frozen ? 'Аккаунт заморожен' : 'Откройте аккаунт для выбора чата';
      els.pickerChat.appendChild(opt);
      els.chatPickerModal.classList.remove('hidden');
      return;
    }

    await refreshPickerChats(true);
    // Preselect last-used chat if it was for this same account
    if (state.scheduleTarget.accountId === active.id && state.scheduleTarget.chatName) {
      els.pickerChat.value = state.scheduleTarget.chatName;
    }

    els.chatPickerModal.classList.remove('hidden');
  }

  function closeChatPicker() {
    if (typeof closeModalAnimated === 'function') {
      closeModalAnimated(els.chatPickerModal);
    } else {
      els.chatPickerModal.classList.add('hidden');
    }
  }

  function renderAttachmentsDraft() {
    els.attachmentsList.innerHTML = '';

    if (!state.attachmentsDraft.length) {
      const empty = document.createElement('div');
      empty.className = 'attachment-item attachment-meta';
      empty.textContent = 'Вложений нет';
      els.attachmentsList.appendChild(empty);
      return;
    }

    for (const att of state.attachmentsDraft) {
      const row = document.createElement('div');
      row.className = 'attachment-item';

      const name = document.createElement('div');
      name.textContent = att.name;

      const meta = document.createElement('div');
      meta.className = 'attachment-meta';
      meta.textContent = att.path;

      row.append(name, meta);
      els.attachmentsList.appendChild(row);
    }
  }

  // Pagination state — kept module-level so "Показать ещё" preserves across re-renders
  const SCHEDULED_PAGE_SIZE = 30;
  let _scheduledVisibleLimit = SCHEDULED_PAGE_SIZE;

  // Generation token against overlapping renders: the 15s runner and user
  // button handlers can call renderScheduled() concurrently; clearing the list
  // before the await let the two interleave (clear-A, clear-B, append-A,
  // append-B) into a fully duplicated list with live duplicate buttons.
  let _renderScheduledGen = 0;

  async function renderScheduled() {
    if (!_inited) return; // лайт-сборка: планировщика нет
    const gen = ++_renderScheduledGen;
    const response = await window.waDeck.listScheduled({ limit: 2000 });
    if (gen !== _renderScheduledGen) return; // a newer render is in flight
    els.scheduledList.innerHTML = '';
    const items = Array.isArray(response?.items) ? response.items : [];

    /* Update toolbar schedule button indicator */
    const schedBtn = document.getElementById('open-schedule-toolbar');
    if (schedBtn) {
      schedBtn.classList.toggle('has-pending', items.length > 0);
      setToolbarLabel(schedBtn, items.length > 0 ? `Отложенная отправка (${items.length})` : 'Отложенная отправка');
    }

    /* Update scheduled-list-card summary with count */
    const listCard = document.getElementById('scheduled-list-card');
    if (listCard) {
      const summary = listCard.querySelector('summary');
      if (summary) summary.textContent = items.length > 0
        ? `Запланированные сообщения (${items.length})`
        : 'Запланированные сообщения';
    }

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'scheduled-item scheduled-meta';
      empty.textContent = 'Активных отложенных сообщений нет';
      els.scheduledList.appendChild(empty);
      _scheduledVisibleLimit = SCHEDULED_PAGE_SIZE;
      return;
    }

    // Show only first _scheduledVisibleLimit items — renders of 500+ scheduled
    // messages become expensive otherwise. User clicks "Показать ещё" to grow.
    const visibleItems = items.slice(0, _scheduledVisibleLimit);
    const remaining = items.length - visibleItems.length;

    for (const item of visibleItems) {
      const account = state.accounts.find((row) => row.id === item.accountId);
      const card = document.createElement('div');
      card.className = 'scheduled-item';

      const top = document.createElement('div');
      top.className = 'scheduled-item-top';

      const left = document.createElement('div');
      left.textContent = `${account?.name || item.accountId} / ${item.chatName}`;

      const badge = document.createElement('span');
      badge.className = `badge ${item.status}`;
      badge.textContent = item.status;

      top.append(left, badge);

      const meta = document.createElement('div');
      meta.className = 'scheduled-meta';
      const repeatLabel = { daily: 'каждый день', weekdays: 'по будням', weekly: 'раз в неделю' }[item.repeat] || '';
      meta.textContent = `Отправка: ${formatDateTime(item.sendAt)} | файлов: ${item.attachments?.length || 0}`
        + (repeatLabel ? ` | ↻ ${repeatLabel}` : '');
      if (item.status === 'pending') {
        const cd = document.createElement('span');
        cd.className = 'scheduled-countdown';
        cd.dataset.sendAt = item.sendAt;
        cd.textContent = ' · ' + formatCountdown(item.sendAt);
        meta.appendChild(cd);
      }

      const text = document.createElement('div');
      text.textContent = item.text || '(без текста)';

      card.append(top, meta, text);

      if (item.status === 'pending' || item.status === 'failed' || item.status === 'processing') {
        const btnRow = document.createElement('div');
        btnRow.className = 'row';
        btnRow.style.gap = '6px';

        if (item.status === 'pending' || item.status === 'failed') {
          const sendNow = document.createElement('button');
          sendNow.className = 'btn';
          sendNow.textContent = 'Отправить сейчас';
          sendNow.addEventListener('click', async () => {
            const confirmed = typeof showConfirm === 'function'
              ? await showConfirm('Отправить сейчас', `Отправить «${item.chatName}» немедленно?`, 'Отправить')
              : true;
            if (!confirmed) return;
            const res = await window.waDeck.sendScheduledNow(item.id);
            if (!res?.ok) {
              setStatus(`Не удалось отправить: ${res?.error || 'error'}`);
              return;
            }
            setStatus(`Отправляю сейчас: ${item.chatName}`);
            await renderScheduled();
            // Kick the runner immediately instead of waiting for the 15s tick.
            processDueSchedules().catch((e) => console.warn('[schedule]', e));
          });
          btnRow.appendChild(sendNow);

          const edit = document.createElement('button');
          edit.className = 'btn';
          edit.textContent = 'Изменить';
          edit.addEventListener('click', () => editScheduledItem(item));
          btnRow.appendChild(edit);

        }

        const cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.textContent = 'Отменить';
        cancel.addEventListener('click', async () => {
          const confirmed = typeof showConfirm === 'function'
            ? await showConfirm('Отмена сообщения', `Отменить отправку для «${item.chatName}»?`, 'Отменить', { danger: true })
            : true;
          if (!confirmed) return;
          const res = await window.waDeck.cancelScheduled(item.id);
          if (!res?.ok) {
            setStatus(`Не удалось отменить: ${res?.error || 'error'}`);
            return;
          }
          await renderScheduled();
          setStatus('Отложенная отправка отменена');
        });
        btnRow.appendChild(cancel);
        card.appendChild(btnRow);
      }

      if (item.errorText) {
        const err = document.createElement('div');
        err.className = 'scheduled-meta';
        err.textContent = `Ошибка: ${item.errorText}`;
        card.appendChild(err);
      }

      els.scheduledList.appendChild(card);
    }

    if (remaining > 0) {
      const showMore = document.createElement('button');
      showMore.type = 'button';
      showMore.className = 'btn scheduled-show-more';
      showMore.textContent = `Показать ещё (${remaining})`;
      showMore.addEventListener('click', () => {
        _scheduledVisibleLimit += SCHEDULED_PAGE_SIZE;
        renderScheduled().catch(console.error);
      });
      els.scheduledList.appendChild(showMore);
    }
  }

  async function pickAttachments() {
    const response = await window.waDeck.pickAttachments();
    if (!response || response.canceled || !Array.isArray(response.files)) return;

    const existing = new Set(state.attachmentsDraft.map((item) => item.path));
    for (const file of response.files) {
      if (existing.has(file.path)) continue;
      state.attachmentsDraft.push({ path: file.path, name: file.name });
    }

    renderAttachmentsDraft();
    setStatus(`Вложений в черновике: ${state.attachmentsDraft.length}`);
  }

  function clearAttachments() {
    state.attachmentsDraft = [];
    renderAttachmentsDraft();
  }

  function localDateTimeFromISO(isoString) {
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /* Human-readable relative time until send, e.g. "через 12 мин". */
  function formatCountdown(sendAtIso) {
    const ms = new Date(sendAtIso).getTime() - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'сейчас';
    const totalMin = Math.round(ms / 60000);
    if (totalMin < 1) return 'меньше минуты';
    if (totalMin < 60) return `через ${totalMin} мин`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    if (h < 24) return m ? `через ${h} ч ${m} мин` : `через ${h} ч`;
    const days = Math.floor(h / 24);
    const hr = h % 24;
    return hr ? `через ${days} д ${hr} ч` : `через ${days} д`;
  }

  /* Lightweight ticker: refresh only the countdown spans in place (no full
     re-render, so scroll position and the open card are preserved). */
  function startCountdownTicker() {
    if (state._scheduledCountdownTimer) return;
    state._scheduledCountdownTimer = setInterval(() => {
      const root = els.scheduledList;
      if (!root) return;
      const nodes = root.querySelectorAll('.scheduled-countdown[data-send-at]');
      nodes.forEach((node) => {
        node.textContent = ' · ' + formatCountdown(node.dataset.sendAt);
      });
    }, 30000);
  }

  async function editScheduledItem(item) {
    const account = accountById(item.accountId);
    state.scheduleTarget.accountId = item.accountId;
    state.scheduleTarget.accountName = account?.name || item.accountId;
    state.scheduleTarget.chatName = item.chatName;
    renderScheduleTarget();

    els.scheduleText.value = item.text || '';
    // If the item's time is already in the past (e.g. re-editing a failed item),
    // default to the next valid slot so the save doesn't bounce with
    // sendAt_in_past and strand the editing linkage.
    const itemMs = new Date(item.sendAt).getTime();
    els.scheduleAt.value = (Number.isFinite(itemMs) && itemMs > Date.now() + 3000)
      ? localDateTimeFromISO(item.sendAt)
      : nextSendAtLocal(1);
    state.attachmentsDraft = Array.isArray(item.attachments) ? item.attachments.map((a) => ({ ...a })) : [];
    renderAttachmentsDraft();
    // Повтор/джиттер серии обязаны попасть в форму: createScheduledMessage
    // читает селекты из DOM, и «Изменить» без этого молча пересохранял
    // ежедневную серию как разовое сообщение.
    const repeatSel = document.getElementById('schedule-repeat');
    const jitterSel = document.getElementById('schedule-jitter');
    if (repeatSel) repeatSel.value = String(item.repeat || '');
    if (jitterSel) jitterSel.value = String(item.jitterMinutes || 0);

    /* Store old item id — will be cancelled ONLY after new one is saved */
    state._editingScheduleId = item.id;
    setScheduleEditBannerVisible(true);

    const detailsCard = document.getElementById('schedule-settings-card');
    if (detailsCard && !detailsCard.open) {
      detailsCard.open = true;
    }
    els.scheduleText.focus();
    setStatus('Редактирование: измените и нажмите «Запланировать» (старое сохранится до сохранения нового)');
  }

  async function createScheduledMessage() {
    if (!state.scheduleTarget.accountId || !state.scheduleTarget.chatName) {
      cancelScheduleEditMode();
      setStatus('Выберите WhatsApp и чат для отправки');
      return;
    }

    const sendAtRaw = String(els.scheduleAt.value || '');
    const parsedSendAt = sendAtRaw ? new Date(sendAtRaw) : null;
    if (!parsedSendAt || Number.isNaN(parsedSendAt.getTime())) {
      cancelScheduleEditMode();
      setStatus('Отложенная отправка: неверная дата/время');
      return;
    }
    const sendAtIso = parsedSendAt.toISOString();

    const repeatEl = document.getElementById('schedule-repeat');
    const jitterEl = document.getElementById('schedule-jitter');
    const payload = {
      accountId: state.scheduleTarget.accountId,
      chatName: state.scheduleTarget.chatName,
      text: String(els.scheduleText.value || ''),
      sendAt: sendAtIso,
      attachments: state.attachmentsDraft,
      repeat: String(repeatEl?.value || ''),
      jitterMinutes: Number(jitterEl?.value) || 0,
    };

    const response = await window.waDeck.scheduleMessage(payload);
    if (!response?.ok) {
      const map = {
        account_not_found: 'Аккаунт не найден',
        chat_required: 'Укажите чат',
        text_or_attachment_required: 'Добавьте текст или вложение',
        invalid_sendAt: 'Неверная дата/время',
        sendAt_in_past: 'Время отправки должно быть в будущем',
      };
      // Clear the editing linkage on failure so it can't later cancel an
      // unrelated scheduled item on the next, non-edit schedule.
      cancelScheduleEditMode();
      setStatus(`Отложенная отправка: ${map[response?.error] || response?.error || 'ошибка'}`);
      return;
    }

    /* If editing — retire the original now that the new one is saved, but
       only if it is still cancellable. The runner may have already sent it
       while the user was editing; cancelling then would be a silent no-op
       at best and confusing at worst. */
    if (state._editingScheduleId) {
      const editingId = state._editingScheduleId;
      cancelScheduleEditMode();
      /* Отменяем напрямую: main сам пускает отмену только для pending/
         processing/failed. Раньше оригинал искали в listScheduled, а main
         режет выдачу до 300 — при большом расписании он «не находился» и
         уходил вместе с новым. failed тоже отменяем: иначе «Отправить сейчас»
         у него дал бы второе сообщение. */
      /* processing не отменяем: исполнитель мог уже нажать Enter, и отмена
         лишь спрятала бы отправленный оригинал под статусом «отменён». */
      const st = await window.waDeck.scheduledStatus(editingId).catch(() => null);
      const res = st?.status === 'processing'
        ? null
        : await window.waDeck.cancelScheduled(editingId).catch(() => null);
      if (!res?.ok && typeof showToast === 'function') {
        showToast(st?.status === 'sent'
          ? 'Оригинал уже отправлен — сохранено как новое задание'
          : (st?.status === 'processing'
            ? 'Оригинал уже отправляется — проверьте список, чтобы не ушло дважды'
            : 'Не удалось отменить оригинал — проверьте список, чтобы не ушло дважды'), 'warn');
      }
    }

    els.scheduleText.value = '';
    els.scheduleAt.value = nextSendAtLocal(1);
    // Селекты повтора/джиттера тоже в дефолт — «липкий» повтор молча делал
    // следующее разовое сообщение ежедневной серией.
    if (repeatEl) repeatEl.value = '';
    if (jitterEl) jitterEl.value = '0';
    clearAttachments();
    await renderScheduled();
    setStatus('Сообщение запланировано');
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

  /* Low-level webview drivers shared by the scheduled-send runner and
     openChatInWebview(). Pure functions of the webview — no send-flow state. */
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
   * Extracted from runScheduledSend (STEPs 1–5) so other surfaces — e.g. the
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
     Нечитаемая шапка (редизайн WA) не блокирует отправку — иначе один
     переименованный селектор остановил бы весь планировщик; такой случай
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

  /* Один «водитель» на webview за раз. Отправка по расписанию, прыжок в чат
     (избранные/важные/лента/Cmd+K) и фоновый сбор списка чатов глобального
     поиска кликают и крутят один и тот же #pane-side: сборщик раз в 15 мин
     ~5 с угонял скролл, клик планировщика попадал в соседнюю строку —
     открывался и помечался прочитанным чужой чат. Очередь на промисах:
     следующий ждёт хвост предыдущего, ошибка не рвёт цепочку. */
  const _webviewLocks = new WeakMap(); // webview → Promise (хвост очереди)
  function withWebviewLock(webview, fn) {
    if (!webview) return fn();
    const prev = _webviewLocks.get(webview) || Promise.resolve();
    const run = prev.then(() => fn());
    /* Хвост очереди ограничен по времени: зависший executeJavaScript (reload
       или крэш гостя посреди скрипта) иначе навсегда запирал аккаунт —
       вставали отправки по расписанию и прыжки в чаты. */
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
      console.warn('[scheduled] search input not found, attempting webview wake-up reload...');
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

  /* Отмена после claim: исполнитель работает с КОПИЕЙ задания, поэтому статус
     перечитывается из main непосредственно перед необратимым действием.
     Недоступный main не блокирует отправку — иначе сбой IPC тихо остановил бы
     всё расписание. */
  async function isStillActive(item) {
    const st = await window.waDeck.scheduledStatus?.(item.id).catch(() => null);
    if (!st || !st.ok) return true;
    return st.status !== 'canceled';
  }

  async function runScheduledSend(webview, item) {
    const chatName = String(item.chatName || '').trim();
    // Variables resolve at SEND time so {время}/{приветствие}/{дата} reflect
    // the actual delivery moment, and {имя} is always the target chat.
    const text = typeof applyTemplateVariables === 'function'
      ? applyTemplateVariables(String(item.text || ''), chatName)
      : String(item.text || '');

    if (!chatName) return { ok: false, error: 'no_chat_name' };

    const opened = await openChatInWebview(webview, chatName);
    if (!opened.ok) return opened;

    const { query, nativeClick, nativeType, nativeKey } = makeWebviewDrivers(webview);

    /* STEP 6: Attachments-first flow.
       If the message has attachments, we deliver them via WhatsApp Web's own
       attach flow: click the "+" clip button → wait for hidden <input type="file">
       to materialize → push file paths into it via CDP (DOM.setFileInputFiles) →
       wait for the preview modal → type caption (on the last group only) → click
       the Send button inside the preview.
       Mixed media + documents cannot share one preview — we send them as two
       consecutive messages, with the caption attached to whichever group is sent
       last. */
    const attachments = Array.isArray(item.attachments) ? item.attachments : [];
    const attachmentErrors = Array.isArray(item.attachmentErrors) ? item.attachmentErrors : [];

    if (attachmentErrors.length) {
      return { ok: false, error: 'attachment_load_failed: ' + attachmentErrors.join('; ') };
    }

    if (attachments.length) {
      const isMedia = (mime) => /^(image|video)\//i.test(String(mime || ''));
      const mediaPaths = attachments.filter((a) => isMedia(a.mime)).map((a) => a.path);
      const docPaths = attachments.filter((a) => !isMedia(a.mime)).map((a) => a.path);

      const groups = [];
      if (mediaPaths.length) groups.push({ kind: 'media', paths: mediaPaths });
      if (docPaths.length) groups.push({ kind: 'document', paths: docPaths });

      const webContentsId = typeof webview.getWebContentsId === 'function'
        ? webview.getWebContentsId()
        : null;
      if (!webContentsId) {
        return { ok: false, error: 'no_web_contents_id' };
      }

      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi];
        const isLast = gi === groups.length - 1;
        const captionForThisGroup = isLast ? text : '';
        if (!(await isStillActive(item))) {
          return { ok: false, canceled: true, error: 'canceled_before_send', sentGroups: gi };
        }
        const groupResult = await sendAttachmentGroup({
          webview,
          webContentsId,
          kind: group.kind,
          paths: group.paths,
          caption: captionForThisGroup,
          query,
          nativeClick,
          nativeType,
          nativeKey,
          delay,
        });
        if (!groupResult.ok) {
          // Уже отправленные группы называем явно: повтор задания продублирует их.
          const partial = gi > 0 ? ` (уже отправлено групп: ${gi})` : '';
          return { ok: false, error: `attach_${group.kind}_${groupResult.error}${partial}`, sentGroups: gi, debug: groupResult };
        }
        // Small settle between groups so the UI recovers before next attach
        if (!isLast) await delay(700);
      }

      return { ok: true, method: 'cdp_attachments', groups: groups.length };
    }

    /* STEP 7: Text-only path (no attachments). */
    if (!text.trim()) {
      // Neither attachments nor text — backend should have rejected with
      // `text_or_attachment_required`, but guard anyway so we don't silently
      // mark empty jobs as "sent".
      return { ok: false, error: 'empty_message' };
    }

    const composerRect = await query(`(() => {
      const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
                document.querySelector('footer div[contenteditable="true"]');
      if (!c) return { found: false };
      const r = c.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, found: r.width > 0 && r.height > 0 };
    })()`);

    if (!composerRect?.found) return { ok: false, error: 'composer_rect_not_found' };

    /* Чужой черновик или режим ответа: nativeType дописывает текст в конец,
       и получатель получает «черновик + запланированное». Не трогаем чужой
       текст, останавливаем задание. */
    const composerState = await query(`(() => {
      const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
                document.querySelector('footer div[contenteditable="true"]');
      const draft = (c?.innerText || c?.textContent || '').replace(/\\s+/g, ' ').trim();
      const footer = document.querySelector('footer');
      const quoted = Boolean(
        footer && (
          footer.querySelector('[data-testid="quoted-message"]') ||
          footer.querySelector('[aria-label*="Отмен" i][data-icon]') ||
          footer.querySelector('[data-icon="x-alt"], [data-icon="x-viewer"]')
        )
      );
      return { draft, quoted };
    })()`);
    if (composerState?.draft) {
      return { ok: false, error: 'composer_has_draft', debug: { draft: composerState.draft.slice(0, 60) } };
    }
    if (composerState?.quoted) {
      return { ok: false, error: 'composer_in_reply_mode' };
    }

    await nativeClick(composerRect.x, composerRect.y);
    await delay(150);

    await nativeType(text);
    await delay(300);

    // Проба перед Enter: текст реально в композере? Если клик промахнулся
    // (зум ≠ 100%, WA перерисовал footer) — композер был пуст с самого
    // начала, и проверка «пуст после Enter» дала бы ложный sent.
    const wantPrefix = String(text).replace(/\s+/g, ' ').trim().slice(0, 40);
    const typedProbe = await query(`(() => {
      const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
                document.querySelector('footer div[contenteditable="true"]');
      const t = (c?.innerText || c?.textContent || '').replace(/\\s+/g, ' ').trim();
      return { has: t.indexOf(${JSON.stringify(wantPrefix)}) !== -1 };
    })()`);
    if (!typedProbe?.has) return { ok: false, error: 'text_not_typed' };

    if (!(await isStillActive(item))) {
      // Набранный текст оставляем как черновик: чистка композера — тоже запись
      // в чужой чат, а отменённое задание не должно ничего менять необратимо.
      return { ok: false, canceled: true, error: 'canceled_before_send' };
    }

    await nativeKey('Enter');
    await delay(500);

    const afterSend = await query(`(() => {
      const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
                document.querySelector('footer div[contenteditable="true"]');
      const text = (c?.innerText || c?.textContent || '').trim();
      return { composerEmpty: text.length === 0, remaining: text.slice(0, 50) };
    })()`);

    if (afterSend?.composerEmpty) {
      return { ok: true, method: 'native_input' };
    }

    const sendBtnRect = await query(`(() => {
      const btn = document.querySelector('footer button[data-testid="send"]') ||
                  document.querySelector('footer [data-testid="send"]') ||
                  document.querySelector('footer span[data-icon="send"]');
      if (!btn) return { found: false };
      const el = btn.closest('button') || btn;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width/2, y: r.top + r.height/2, found: true };
    })()`);

    if (sendBtnRect?.found) {
      await nativeClick(sendBtnRect.x, sendBtnRect.y);
      await delay(500);
    }

    const finalCheck = await query(`(() => {
      const c = document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
                document.querySelector('footer div[contenteditable="true"]');
      const text = (c?.innerText || c?.textContent || '').trim();
      return { composerEmpty: text.length === 0 };
    })()`);

    if (finalCheck?.composerEmpty) {
      return { ok: true, method: 'native_input_with_btn' };
    }

    return { ok: false, error: 'text_send_failed', method: 'native_input', debug: afterSend };
  }

  /**
   * Attach a group of files of the same kind (media or document) to the current
   * WhatsApp Web chat and send them (with optional caption on the last group).
   *
   * Why this is non-trivial: WhatsApp Web's <input type="file"> is hidden and
   * lazy-rendered only after the user expands the attach ("+") menu. We open
   * the menu with a native click, poll until the hidden input appears, then
   * deliver paths via CDP's DOM.setFileInputFiles (which JS alone cannot do).
   * Setting files fires the input's change event — WhatsApp then opens the
   * preview modal, where we type the caption and click send.
   */
  async function sendAttachmentGroup({ webview, webContentsId, kind, paths, caption, query, nativeClick, nativeType, nativeKey, delay }) {
    // Group → file-input accept selector.
    // WhatsApp Web has THREE file inputs that all carry "image" in accept:
    //   • Photos & Videos — accept includes "video/…" (images + videos together)
    //   • Stickers        — accept is image-only (webp/png), NO video
    //   • Document        — accept is "*" / missing
    // Previously we used `accept*="image"` which matched the sticker input first
    // in DOM order — photos were uploaded as stickers. We now key off the
    // image+video combination, which is unique to the media picker.
    const inputSelector = kind === 'media'
      ? 'input[type="file"][accept*="video"]'
      : 'input[type="file"][accept="*"], input[type="file"]:not([accept*="image"]):not([accept*="video"])';

    /* A. Expand the attach menu.
       Covers a few years' worth of WhatsApp Web class renames: plus icon,
       clip testid, aria-label fallbacks (EN/RU). We only need the menu open
       long enough for the lazy inputs to mount; WhatsApp closes it itself
       once files are selected. */
    const clipRect = await query(`(() => {
      const candidates = [
        'footer [data-icon="plus"]',
        'footer [data-icon="clip"]',
        'footer [data-icon="plus-rounded"]',
        'footer [data-testid="clip"]',
        'footer [data-testid="conversation-clip"]',
        'footer button[aria-label*="Attach" i]',
        'footer button[aria-label*="Прикреп" i]',
        'footer button[title*="Attach" i]',
        'footer button[title*="Прикреп" i]',
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const host = el.closest('button') || el.closest('[role="button"]') || el;
        const r = host.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true };
        }
      }
      return { found: false };
    })()`);

    if (!clipRect?.found) return { ok: false, error: 'clip_button_not_found' };

    await nativeClick(clipRect.x, clipRect.y);
    await delay(350);

    /* A2. Click the menu item for this kind.
       Since mid-2026 WhatsApp Web no longer mounts the file inputs when the
       attach menu merely opens — the hidden <input type="file"> is created only
       after clicking a specific menu item ("Фото и видео" / "Документ"). That
       click also makes WhatsApp synchronously call input.click(), which would
       pop the OS file picker during an unattended scheduled send, so we no-op
       that one call (CDP sets the files directly instead). An 8s backstop timer
       restores the original click if a later step throws before we restore it. */
    const menuClick = await query(`(() => {
      const want = ${JSON.stringify(kind)};
      const txt = (m) => (m.getAttribute('aria-label') || m.textContent || '').trim();
      const items = [...document.querySelectorAll('[role="menuitem"], li[role], [role="button"]')];
      const re = want === 'media'
        ? /Фото и видео|Photos?\\s*(and|&)\\s*videos?|Fotos?\\s*und\\s*Videos?|Foto/i
        : /Документ|Document|Dokument/i;
      const item = items.find((m) => re.test(txt(m)));
      if (!item) return { found: false };
      if (!window.__waDeckOrigInputClick) window.__waDeckOrigInputClick = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {};
      clearTimeout(window.__waDeckClickRestoreTimer);
      window.__waDeckClickRestoreTimer = setTimeout(() => {
        if (window.__waDeckOrigInputClick) {
          HTMLInputElement.prototype.click = window.__waDeckOrigInputClick;
          window.__waDeckOrigInputClick = null;
        }
      }, 8000);
      item.click();
      return { found: true };
    })()`);

    if (!menuClick?.found) {
      await nativeKey('Escape');
      return { ok: false, error: 'attach_menu_item_not_found' };
    }
    await delay(250);

    /* From here on input.click is suppressed — every exit (success or error)
       must restore it eagerly. The 8s backstop timer only covers the case
       where the webview call itself dies; leaving the override in place for
       those 8s would swallow a manual attach click by the user. */
    const restoreInputClick = () => query(`(() => {
      clearTimeout(window.__waDeckClickRestoreTimer);
      if (window.__waDeckOrigInputClick) {
        HTMLInputElement.prototype.click = window.__waDeckOrigInputClick;
        window.__waDeckOrigInputClick = null;
      }
      return true;
    })()`);

    /* B. Wait for the hidden <input type="file"> for this kind to appear. */
    let inputReady = false;
    for (let i = 0; i < 30; i++) {
      const present = await query(
        `(() => Boolean(document.querySelector(${JSON.stringify(inputSelector)})))()`,
      );
      if (present === true) { inputReady = true; break; }
      await delay(150);
    }

    if (!inputReady) {
      await restoreInputClick();
      await nativeKey('Escape');
      return { ok: false, error: 'file_input_not_found' };
    }

    /* C. Hand paths to the input via CDP. This bypasses the OS file dialog
       and fires the 'change' event WhatsApp listens for. */
    const cdp = await window.waDeck.sendAttachmentsViaCDP({
      webContentsId,
      selector: inputSelector,
      files: paths,
    });
    if (!cdp?.ok) {
      await restoreInputClick();
      await nativeKey('Escape');
      return { ok: false, error: `cdp_${cdp?.error || 'failed'}` };
    }

    /* C2. Files are delivered — restore the suppressed input.click now that the
       OS dialog can no longer fire. */
    await restoreInputClick();

    /* D. Wait for the preview modal. WhatsApp shows a lightbox with a
       Send button; we detect it by a data-icon="send" that lives OUTSIDE
       the footer (the composer's send button is always in footer). */
    let previewReady = false;
    for (let i = 0; i < 60; i++) { // up to ~12s — media can take a moment to thumbnail
      const detected = await query(`(() => {
        const icons = Array.from(document.querySelectorAll(
          '[data-icon="send"], [data-icon="wds-ic-send-filled"], [aria-label="Send"], [aria-label*="Отправ" i]'
        ));
        for (const ic of icons) {
          if (ic.closest('footer')) continue;
          const host = ic.closest('button') || ic.closest('[role="button"]') || ic;
          const r = host.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      })()`);
      if (detected === true) { previewReady = true; break; }
      await delay(200);
    }

    if (!previewReady) {
      await nativeKey('Escape');
      return { ok: false, error: 'preview_modal_not_opened' };
    }

    /* E. Type caption (only relevant on the last group of a message). */
    if (caption && caption.trim()) {
      const captionRect = await query(`(() => {
        // Find a visible contenteditable that's NOT the main composer (which is in footer).
        const nodes = Array.from(document.querySelectorAll('div[contenteditable="true"], [contenteditable="true"][role="textbox"]'));
        for (let i = nodes.length - 1; i >= 0; i--) {
          const el = nodes[i];
          if (el.closest('footer')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true };
          }
        }
        return { found: false };
      })()`);

      if (!captionRect?.found) {
        // Подпись задана пользователем — молча отправить вложение без неё
        // значит доставить не то сообщение и отчитаться об успехе.
        await nativeKey('Escape');
        return { ok: false, error: 'caption_input_not_found' };
      }
      await nativeClick(captionRect.x, captionRect.y);
      await delay(150);
      await nativeType(caption);
      await delay(250);

      const wantCaption = String(caption).replace(/\s+/g, ' ').trim().slice(0, 40);
      const captionProbe = await query(`(() => {
        const nodes = Array.from(document.querySelectorAll('div[contenteditable="true"], [contenteditable="true"][role="textbox"]'));
        for (let i = nodes.length - 1; i >= 0; i--) {
          const el = nodes[i];
          if (el.closest('footer')) continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            const t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
            return { has: t.indexOf(${JSON.stringify(wantCaption)}) !== -1 };
          }
        }
        return { has: false };
      })()`);
      if (!captionProbe?.has) {
        await nativeKey('Escape');
        return { ok: false, error: 'caption_not_typed' };
      }
    }

    /* F. Click the preview's Send button. Same "outside footer" rule. */
    const sendRect = await query(`(() => {
      const icons = Array.from(document.querySelectorAll(
        '[data-icon="send"], [data-icon="wds-ic-send-filled"], [aria-label="Send"], [aria-label*="Отправ" i]'
      ));
      for (const ic of icons) {
        if (ic.closest('footer')) continue;
        const host = ic.closest('button') || ic.closest('[role="button"]') || ic;
        const r = host.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, found: true };
        }
      }
      return { found: false };
    })()`);

    if (!sendRect?.found) {
      await nativeKey('Escape');
      return { ok: false, error: 'preview_send_not_found' };
    }

    await nativeClick(sendRect.x, sendRect.y);
    await delay(700);

    /* G. Wait for the preview modal to close — confirms the message uploaded
       and left the lightbox. Times out at ~15s for very slow uploads. */
    for (let i = 0; i < 75; i++) {
      const stillOpen = await query(`(() => {
        const icons = Array.from(document.querySelectorAll(
          '[data-icon="send"], [data-icon="wds-ic-send-filled"], [aria-label="Send"], [aria-label*="Отправ" i]'
        ));
        for (const ic of icons) {
          if (ic.closest('footer')) continue;
          const host = ic.closest('button') || ic.closest('[role="button"]') || ic;
          const r = host.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        return false;
      })()`);
      if (stillOpen !== true) return { ok: true };
      await delay(200);
    }

    return { ok: false, error: 'preview_did_not_close' };
  }

  async function processDueSchedules() {
    if (state.scheduleRunnerBusy) return;
    state.scheduleRunnerBusy = true;

    try {
      const due = await window.waDeck.claimDueScheduled({ limit: 4 });
      const items = Array.isArray(due?.items) ? due.items : [];
      if (items.length) console.log('[scheduled] due:', items.length);
      if (!items.length) return;

      for (const item of items) {
        const account = accountById(item.accountId);
        if (!account || account.frozen) {
          const errorText = account?.frozen ? 'account_frozen' : 'account_not_found';
          console.warn('[scheduled]', item.chatName, errorText);
          await window.waDeck.completeScheduled({ id: item.id, ok: false, errorText });
          continue;
        }

        let webview = state.webviews.get(item.accountId);
        if (!webview) {
          ensureWebview(account);
          webview = state.webviews.get(item.accountId) || null;
        }
        if (!webview) {
          console.warn('[scheduled]', item.chatName, 'webview_not_found');
          await reportScheduledResult(item, false, 'webview_not_found');
          continue;
        }

        /* Исключение посреди отправки (например, отклонённый IPC вложений)
           обрывало весь цикл: остальные захваченные задания пачки висели в
           processing до STALE_PROCESSING_MS (20 мин) и потом повторялись. */
        let result;
        try {
          result = await withWebviewLock(webview, () => runScheduledSend(webview, item));
        } catch (e) {
          console.warn('[scheduled] exception:', item.chatName, e);
          await reportScheduledResult(item, false, 'exception').catch(() => {});
          continue;
        }
        console.log('[scheduled] result:', item.chatName, JSON.stringify(result));

        if (result?.canceled) {
          // Статусом уже владеет cancelScheduled — не перетираем его на failed.
          setStatus(`Отменено до отправки: ${item.chatName}`);
          continue;
        }

        await reportScheduledResult(item, Boolean(result?.ok), result?.ok ? '' : String(result?.error || 'send_failed'));
      }

      await renderScheduled();
    } finally {
      state.scheduleRunnerBusy = false;
    }
  }

  /* Transient failures (webview still loading after a cold start, account
     webview not created yet, WA Web DOM not settled) used to be reported as
     terminal `failed` — a message due right after launch was silently never
     sent. Requeue those via snooze with a short backoff, up to 3 attempts per
     session; everything else stays a real failure. */
  const TRANSIENT_SEND_ERRORS = new Set(['webview_not_ready', 'webview_not_found', 'search_input_not_found', 'text_not_typed']);
  const TRANSIENT_RETRY_SNOOZE_MIN = 2;
  const TRANSIENT_RETRY_MAX = 3;
  const _transientRetryCounts = new Map(); // scheduled item id → attempts this session

  async function reportScheduledResult(item, ok, errorText) {
    await window.waDeck.completeScheduled({ id: item.id, ok, errorText: ok ? '' : errorText });

    if (ok) {
      _transientRetryCounts.delete(item.id);
      setStatus(`Отправлено: ${item.chatName}`);
      return;
    }

    if (TRANSIENT_SEND_ERRORS.has(errorText)) {
      const attempts = (_transientRetryCounts.get(item.id) || 0) + 1;
      if (attempts <= TRANSIENT_RETRY_MAX) {
        _transientRetryCounts.set(item.id, attempts);
        const snoozed = await window.waDeck.snoozeScheduled({
          id: item.id,
          minutes: TRANSIENT_RETRY_SNOOZE_MIN * attempts,
        }).catch(() => null);
        if (snoozed?.ok) {
          setStatus(`Повторная попытка ${attempts}/${TRANSIENT_RETRY_MAX} через ${TRANSIENT_RETRY_SNOOZE_MIN * attempts} мин: ${item.chatName}`);
          return;
        }
      } else {
        _transientRetryCounts.delete(item.id);
      }
    }

    const HUMAN_ERRORS = {
      chat_title_mismatch: 'открылся другой чат — отправка остановлена',
      chat_name_ambiguous: 'несколько чатов с похожим именем — уточните название',
      composer_has_draft: 'в поле ввода есть черновик — отправка остановлена',
      composer_in_reply_mode: 'открыт режим ответа — отправка остановлена',
      caption_input_not_found: 'не найдено поле подписи к вложению',
      caption_not_typed: 'подпись не набралась — вложение не отправлено',
    };
    const human = HUMAN_ERRORS[errorText];
    setStatus(human
      ? `Не отправлено: ${item.chatName} — ${human}`
      : `Ошибка отправки: ${item.chatName} (${errorText || 'send_failed'})`);
  }

  function startScheduleRunner() {
    startCountdownTicker();
    if (state.scheduleRunnerTimer) {
      clearInterval(state.scheduleRunnerTimer);
      state.scheduleRunnerTimer = null;
    }

    state.scheduleRunnerTimer = setInterval(() => {
      processDueSchedules().catch((e) => console.warn('[schedule]', e));
    }, 15000);

    setTimeout(() => processDueSchedules().catch((e) => console.warn('[schedule]', e)), 5000);
  }

  export const WaDeckScheduleModule = {
    init,
    cancelScheduleEditMode,
    renderScheduleTarget,
    refreshPickerChats,
    openChatPicker,
    closeChatPicker,
    renderAttachmentsDraft,
    renderScheduled,
    pickAttachments,
    clearAttachments,
    createScheduledMessage,
    startScheduleRunner,
    // Снаружи — только через блокировку webview (см. withWebviewLock).
    openChatInWebview: (webview, chatName, opts) =>
      withWebviewLock(webview, () => openChatInWebview(webview, chatName, opts)),
    openChatByListClick: (webview, chatName) =>
      withWebviewLock(webview, () => openChatByListClick(webview, chatName)),
    withWebviewLock,
    isWebviewLocked,
  };
  window.WaDeckScheduleModule = WaDeckScheduleModule;

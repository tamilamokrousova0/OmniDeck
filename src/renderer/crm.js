import { activeChatContactScript } from './webview-scripts/active-chat-contact.js';

  let state, els, setStatus, activeAccount, selectedWebview;
  /* В лайт-сборке модуль не инициализируется, но ядро всё равно дёргает часть
     его функций напрямую (bindings, hotkeys). Без этого флага первый же такой
     вызов падал на `els` = undefined и обрывал ВСЮ привязку событий после
     себя: переставали работать «+», настройки и хаб. */
  let _inited = false;

  function init(ctx) {
    _inited = true;
    state = ctx.state;
    els = ctx.els;
    setStatus = ctx.setStatus;
    activeAccount = ctx.activeAccount;
    selectedWebview = ctx.selectedWebview;
  }

  // Snapshot of the field values at the moment edit mode was entered — the
  // «Отмена» button restores them; without this, cancelled edits stayed on
  // screen as if saved while the file on disk held different content.
  let _crmEditSnapshot = null;

  function setCrmEditable(editable) {
    if (!_inited) return;
    const on = Boolean(editable);
    if (on && !state.crmEditable) {
      _crmEditSnapshot = {
        about: String(els.crmAbout?.value || ''),
        myInfo: String(els.crmMyInfo?.value || ''),
      };
    }
    state.crmEditable = on;
    if (els.crmAbout) els.crmAbout.readOnly = !on;
    if (els.crmMyInfo) els.crmMyInfo.readOnly = !on;
    if (els.crmSave) els.crmSave.disabled = !on;
    if (els.crmEdit) els.crmEdit.textContent = on ? 'Отмена' : 'Изменить';
  }

  function cancelCrmEdit() {
    if (_crmEditSnapshot) {
      if (els.crmAbout) els.crmAbout.value = _crmEditSnapshot.about;
      if (els.crmMyInfo) els.crmMyInfo.value = _crmEditSnapshot.myInfo;
      autoResizeCrmTextarea(els.crmAbout);
      autoResizeCrmTextarea(els.crmMyInfo);
      _crmEditSnapshot = null;
    }
    setCrmEditable(false);
  }

  function crmFormPayload() {
    // Per-contact hover toggle removed — global toggle now lives in Settings.
    // Always write hoverEnabled:true so legacy file format stays valid and any
    // previously-stored `off` values are upgraded on next save.
    return {
      about: String(els.crmAbout.value || '').trim(),
      myInfo: String(els.crmMyInfo.value || '').trim(),
      hoverEnabled: true,
    };
  }

  function buildCrmTextForCopy() {
    const target = state.crmTarget || {};
    const payload = crmFormPayload();
    return [
      `Контакт: ${target.contactName || ''}`,
      `WhatsApp: ${target.accountName || ''}`,
      '',
      'О нём:',
      payload.about,
      '',
      'Моя информация:',
      payload.myInfo,
      '',
    ].join('\n');
  }

  async function getActiveChatContactName() {
    const account = activeAccount();
    const webview = selectedWebview();
    if (!account || !webview || account.frozen) return '';
    try {
      return String(await webview.executeJavaScript(activeChatContactScript(), true) || '').trim();
    } catch {
      return '';
    }
  }

  async function openCrmModal() {
    if (!_inited) return;
    const account = activeAccount();
    if (!account) {
      setStatus('Нет активного аккаунта');
      return;
    }
    if (account.frozen) {
      setStatus(`${account.name}: аккаунт заморожен`);
      return;
    }

    const contactName = await getActiveChatContactName();
    if (!contactName) {
      setStatus('Откройте нужный чат, затем CRM');
      return;
    }

    const response = await window.waDeck.crmLoadContact({
      accountId: account.id,
      accountName: account.name,
      contactName,
    }).catch(() => null);
    if (!response?.ok) {
      setStatus(`CRM: ${response?.error || 'load_failed'}`);
      return;
    }

    const loaded = response.record || {};
    const nextRecord = {
      about: String(loaded.about || ''),
      myInfo: String(loaded.myInfo || ''),
      hoverEnabled: true, // per-contact toggle removed; global flag controls visibility
    };

    const contactMismatch = String(loaded.contactName || '').trim() !== contactName;
    const accountMismatch = String(loaded.accountName || '').trim() !== account.name;
    const shouldAutoSave = !response.exists || contactMismatch || accountMismatch;

    let filePath = String(response.filePath || '');
    let autoSaveError = '';
    if (shouldAutoSave) {
      const autoSaved = await window.waDeck.crmSaveContact({
        accountId: account.id,
        accountName: account.name,
        contactName,
        ...nextRecord,
      });
      if (autoSaved?.ok) {
        filePath = String(autoSaved.filePath || filePath);
        // Keep hover cache in sync with what was just written to disk
        if (typeof window._updateCrmHoverCache === 'function') {
          window._updateCrmHoverCache(account.id, contactName, autoSaved.record || nextRecord);
        }
      } else {
        autoSaveError = String(autoSaved?.error || 'auto_save_failed');
      }
    }

    state.crmTarget = {
      accountId: account.id,
      accountName: account.name,
      contactName,
      filePath,
    };

    els.crmContactName.value = contactName;
    els.crmAbout.value = nextRecord.about;
    els.crmMyInfo.value = nextRecord.myInfo;
    els.crmMeta.textContent = `Файл: ${filePath || '—'}`;
    setCrmEditable(true);
    if (window.WaDeckFavoritesModule) window.WaDeckFavoritesModule.syncCrmToggle();
    if (window.WaDeckImportantModule) window.WaDeckImportantModule.syncCrmToggle();
    els.crmModal.classList.remove('hidden');
    requestAnimationFrame(() => {
      autoResizeCrmTextarea(els.crmAbout);
      autoResizeCrmTextarea(els.crmMyInfo);
    });
    if (response?.migrated) {
      setStatus('CRM: старый файл перенесён на правильный контакт');
    } else if (autoSaveError) {
      setStatus(`CRM: не удалось авто-сохранить (${autoSaveError})`);
    } else if (!response.exists) {
      setStatus('CRM: контакт создан и сохранён');
    } else if (shouldAutoSave) {
      setStatus('CRM: контакт обновлён');
    } else {
      setStatus('CRM: данные загружены');
    }
  }

  function closeCrmModal() {
    if (!_inited) return;
    // Автосохранение: закрытие драуэра (крестик/Esc/тоггл) с несохранённой
    // правкой тихо сохраняет её — набранная заметка больше не теряется.
    // «Отмена» не задета: cancelCrmEdit сначала откатывает поля к снапшоту,
    // так что diff здесь пустой и сохранения не происходит.
    try {
      if (state.crmEditable && _crmEditSnapshot) {
        const curAbout = String(els.crmAbout?.value || '');
        const curInfo = String(els.crmMyInfo?.value || '');
        if (curAbout !== _crmEditSnapshot.about || curInfo !== _crmEditSnapshot.myInfo) {
          saveCrmCard().catch(() => {});
        }
      }
    } catch { /* закрытие важнее */ }
    setCrmEditable(false);
    // Synchronous hide — skip the `closeModalAnimated` path. The CRM drawer
    // has its own slide-in-only animation on the card; there's no matching
    // close animation, so the fallback timeout just added a 250ms window
    // during which the toolbar toggle misread the state.
    els.crmModal.classList.remove('is-closing');
    els.crmModal.classList.add('hidden');
  }

  function toggleCrmEdit() {
    if (state.crmEditable) {
      cancelCrmEdit();
    } else {
      setCrmEditable(true);
    }
  }

  async function saveCrmCard() {
    const target = state.crmTarget || {};
    if (!target.accountId || !target.contactName) {
      setStatus('CRM: контакт не выбран');
      return;
    }

    const payload = {
      accountId: target.accountId,
      accountName: target.accountName,
      contactName: target.contactName,
      ...crmFormPayload(),
    };
    const response = await window.waDeck.crmSaveContact(payload);
    if (!response?.ok) {
      setStatus(`CRM: ${response?.error || 'save_failed'}`);
      return;
    }

    state.crmTarget.filePath = String(response.filePath || target.filePath || '');
    els.crmMeta.textContent = `Файл: ${state.crmTarget.filePath || '—'}`;
    // Saved values are the new baseline — «Отмена» after a save must not
    // revert the display to pre-edit content the file no longer holds.
    _crmEditSnapshot = { about: payload.about, myInfo: payload.myInfo };
    // Push freshly saved record into hover cache so any in-flight fetch is ignored,
    // and the popover hides immediately if hover was turned off.
    const savedRecord = response.record || {
      about: payload.about,
      myInfo: payload.myInfo,
      hoverEnabled: payload.hoverEnabled !== false,
    };
    if (typeof window._updateCrmHoverCache === 'function') {
      window._updateCrmHoverCache(target.accountId, target.contactName, savedRecord);
    } else if (typeof window._invalidateCrmHoverCache === 'function') {
      window._invalidateCrmHoverCache(target.accountId, target.contactName);
    }
    setStatus('CRM: сохранено');
  }

  async function copyCrmCard() {
    const text = buildCrmTextForCopy();
    await window.waDeck.setClipboardText(text);
    setStatus('CRM: карточка скопирована');
  }

  function addCrmNote() {
    const el = els.crmMyInfo;
    if (!el) return; // the dereferences below would TypeError otherwise
    if (el.readOnly) {
      setCrmEditable(true);
    }
    const MONTHS_RU = [
      'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
    ];
    const now = new Date();
    const stamp = now.getDate() + ' ' + MONTHS_RU[now.getMonth()] + ' - ';
    const prev = el.value ? '\n' + el.value : '';
    el.value = stamp + prev;
    el.focus();
    el.setSelectionRange(stamp.length, stamp.length);
    autoResizeCrmTextarea(el);
  }

  function autoResizeCrmTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(Math.max(textarea.scrollHeight, 80), 300) + 'px';
  }

  function bindCrmAutoResize() {
    if (!_inited) return;
    if (els.crmAbout) els.crmAbout.addEventListener('input', () => autoResizeCrmTextarea(els.crmAbout));
    if (els.crmMyInfo) els.crmMyInfo.addEventListener('input', () => autoResizeCrmTextarea(els.crmMyInfo));
  }

  export const WaDeckCrmModule = {
    init,
    setCrmEditable,
    openCrmModal,
    closeCrmModal,
    toggleCrmEdit,
    saveCrmCard,
    copyCrmCard,
    addCrmNote,
    bindCrmAutoResize,
  };
  window.WaDeckCrmModule = WaDeckCrmModule;

/* Global hotkeys: DevTools shortcut, the Escape UI-reset stack and the
   templates/search shortcuts. Extracted verbatim from renderer.js. */
import { state, els } from './state.js';
import { closeConfirm } from './helpers.js';
import { selectedWebview, closeAccountContextMenu } from './accounts.js';
import { closeAccountMenu } from './account-menu.js';
import {
  toggleTweaksPopover,
  showSettingsMenu,
  showSettingsSection,
  openSettingsPanel,
  closeSettingsPanel,
} from './settings.js';
import { WaDeckScheduleModule } from '../schedule.js';
import { WaDeckAutoUpdateModule } from '../auto-update.js';
import { WaDeckCrmModule } from '../crm.js';

// Global hotkey: Cmd+Alt+Shift+I → open DevTools of the currently active
// WhatsApp webview (so DOM diagnostics run in WA's context, not ours).
document.addEventListener('keydown', (e) => {
  // e.code, not e.key: on macOS Option(+Shift) turns 'i' into a dead key, and
  // on the RU layout the letter is 'ш' — the physical-key code works on both.
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && e.code === 'KeyI') {
    const wv = selectedWebview();
    if (wv && typeof wv.openDevTools === 'function') {
      try { wv.openDevTools(); } catch (err) { console.warn('openDevTools failed:', err); }
      e.preventDefault();
    }
  }
});

function handleEscapeUiReset() {
  // Escape closes ONLY the topmost UI layer per press (stack order below).
  // Возвращает true, если какой-то слой закрыт; false — «слоёв нет», и тогда
  // вызывающий пробрасывает Esc в активный webview (родные Esc-жесты WA:
  // снять reply-цитату, закрыть поиск чатов — раньше проглатывались декой).
  const isOpen = (el) => Boolean(el && !el.classList.contains('hidden') && !el.classList.contains('is-closing'));

  // 0. Справка F1 — самый верхний слой (main глушит Escape, свой keydown
  //    в help.js до неё не долетает)
  if (window.WaDeckHelp?.isOpen?.()) {
    window.WaDeckHelp.hide();
    return true;
  }
  // 0.5 Сплит-браузер — Esc закрывает панель (F1 обещает «верхний слой»)
  if (window.WaDeckSplitModule?.isOpen?.()) {
    window.WaDeckSplitModule.toggle();
    return true;
  }
  // 1. Floating Tweaks popover — the most shallow UI
  const tweaksPanel = document.getElementById('tweaks-panel');
  if (isOpen(tweaksPanel)) {
    toggleTweaksPopover(false);
    return true;
  }
  // 2. Open context menus (account / refresh)
  if (document.getElementById('account-context-menu')) {
    closeAccountContextMenu();
    return true;
  }
  // 3. Confirm modal — cancels the pending action
  if (isOpen(els.confirmModal)) {
    closeConfirm(false);
    return true;
  }
  // 4. Chat picker
  if (isOpen(els.chatPickerModal)) {
    WaDeckScheduleModule.closeChatPicker();
    return true;
  }
  // 5. Account management modal
  if (isOpen(els.accountMenuModal)) {
    closeAccountMenu();
    return true;
  }
  // 6. Release notes / update modals
  if (isOpen(els.releaseNotesModal)) {
    WaDeckAutoUpdateModule.closeReleaseNotesModal().catch(console.error);
    return true;
  }
  // 7. Inline template edit form (lives inside the settings panel)
  const tmplEditWrap = document.getElementById('tmpl-edit-wrap');
  if (!state.panelHidden && isOpen(tmplEditWrap)) {
    if (typeof window._hideTemplateEditForm === 'function') window._hideTemplateEditForm();
    return true;
  }
  // 7.5 Бриф звонка
  if (isOpen(els.callBriefModal)) {
    window.WaDeckCallBriefModule?.closeCallBrief();
    return true;
  }
  // 8. CRM modal
  if (isOpen(els.crmModal)) {
    WaDeckCrmModule.closeCrmModal();
    return true;
  }
  // 9. Settings: open section goes back to the menu first…
  if (!state.panelHidden && state._openSettingsSection) {
    showSettingsMenu();
    return true;
  }
  // 10. …and only then the panel itself closes
  if (!state.panelHidden) {
    closeSettingsPanel();
    return true;
  }
  return false;
}

/* ── Toolbar "Шаблоны" button → open the settings drawer on the Templates
   section. The old full-screen tq-overlay palette has been removed in
   favour of the unified right-drawer UX. ── */
(function setupTemplatesShortcut() {
  function openTemplatesDrawer() {
    if (state.panelHidden) openSettingsPanel();
    showSettingsSection('templates');
  }

  if (els.openTemplateQuick) {
    els.openTemplateQuick.addEventListener('click', () => {
      const isOpenOnTemplates = !state.panelHidden && state._openSettingsSection === 'templates';
      if (isOpenOnTemplates) {
        closeSettingsPanel();
      } else {
        openTemplatesDrawer();
      }
    });
  }

  // Для сквозного маршрутизатора host-hotkey (main → renderer): Cmd+T из
  // композера WhatsApp доставляется каналом, минуя DOM-события.
  window.__waDeckOpenTemplatesDrawer = openTemplatesDrawer;

  document.addEventListener('keydown', (e) => {
    // Cmd/Ctrl+A вне редактируемого поля выделял весь host-документ (синяя
    // заливка всего окна, снималась только кликом по хрому). В полях деки и
    // в композере WhatsApp (событие живёт в guest) select-all работает как раньше.
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyA' && !e.shiftKey && !e.altKey) {
      const active = document.activeElement;
      const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (!inInput) e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      window.WaDeckGlobalSearch?.toggle?.();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyT' && !e.shiftKey && !e.altKey) {
      const active = document.activeElement;
      const inInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable);
      if (inInput) return;
      e.preventDefault();
      openTemplatesDrawer();
    }
  });
})();

export { handleEscapeUiReset };

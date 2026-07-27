const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('waDeck', {
  bootstrap: () => ipcRenderer.invoke('bootstrap'),
  addAccount: (type) => ipcRenderer.invoke('add-account', type),
  removeAccount: (accountId) => ipcRenderer.invoke('remove-account', accountId),
  renameAccount: (payload) => ipcRenderer.invoke('rename-account', payload),
  setAccountFrozen: (payload) => ipcRenderer.invoke('set-account-frozen', payload),
  setAccountPinned: (payload) => ipcRenderer.invoke('set-account-pinned', payload),
  moveAccount: (payload) => ipcRenderer.invoke('move-account', payload),
  pickAccountIcon: () => ipcRenderer.invoke('pick-account-icon'),
  setAccountIcon: (payload) => ipcRenderer.invoke('set-account-icon', payload),
  setAccountColor: (payload) => ipcRenderer.invoke('set-account-color', payload),
  saveSettings: (payload) => ipcRenderer.invoke('save-settings', payload),
  crmLoadContact: (payload) => ipcRenderer.invoke('crm-load-contact', payload),
  crmSaveContact: (payload) => ipcRenderer.invoke('crm-save-contact', payload),
  listTemplates: () => ipcRenderer.invoke('list-templates'),
  saveTemplate: (payload) => ipcRenderer.invoke('save-template', payload),
  deleteTemplate: (id) => ipcRenderer.invoke('delete-template', id),
  pickAttachments: () => ipcRenderer.invoke('pick-attachments'),
  pickAudioFile: () => ipcRenderer.invoke('pick-audio-file'),
  transcribeVoice: (payload) => ipcRenderer.invoke('transcribe-voice', payload),
  scheduleMessage: (payload) => ipcRenderer.invoke('schedule-message', payload),
  listScheduled: (payload) => ipcRenderer.invoke('list-scheduled', payload),
  claimDueScheduled: (payload) => ipcRenderer.invoke('claim-due-scheduled', payload),
  completeScheduled: (payload) => ipcRenderer.invoke('complete-scheduled', payload),
  cancelScheduled: (id) => ipcRenderer.invoke('cancel-scheduled', id),
  sendScheduledNow: (id) => ipcRenderer.invoke('send-scheduled-now', id),
  snoozeScheduled: (payload) => ipcRenderer.invoke('snooze-scheduled', payload),
  getContactLang: (payload) => ipcRenderer.invoke('get-contact-lang', payload),
  setContactLang: (payload) => ipcRenderer.invoke('set-contact-lang', payload),
  favoritesToggle: (payload) => ipcRenderer.invoke('favorites-toggle', payload),
  importantToggle: (payload) => ipcRenderer.invoke('important-toggle', payload),
  sendAttachmentsViaCDP: (payload) => ipcRenderer.invoke('send-attachments-via-cdp', payload),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  getClipboardText: () => ipcRenderer.invoke('get-clipboard-text'),
  setClipboardText: (text) => ipcRenderer.invoke('set-clipboard-text', text),
  setDockBadge: (payload) => ipcRenderer.invoke('set-dock-badge', payload),
  checkForUpdates: (payload) => ipcRenderer.invoke('check-for-updates', payload),
  getReleaseNotes: () => ipcRenderer.invoke('get-release-notes'),
  focusMainWindow: () => ipcRenderer.invoke('focus-main-window'),
  installDownloadedUpdate: () => ipcRenderer.invoke('install-downloaded-update'),
  openReleasesPage: () => ipcRenderer.invoke('open-releases-page'),
  translateText: (payload) => ipcRenderer.invoke('translate-text', payload),
  templateUsed: (payload) => ipcRenderer.invoke('template-used', payload),
  cleanupCache: () => ipcRenderer.invoke('cleanup-cache'),
  onAutoUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('auto-update-status', listener);
    return () => ipcRenderer.removeListener('auto-update-status', listener);
  },
  onHostEscape: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('host-escape-pressed', listener);
    return () => ipcRenderer.removeListener('host-escape-pressed', listener);
  },
  onHostNextUnread: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('host-next-unread-pressed', listener);
    return () => ipcRenderer.removeListener('host-next-unread-pressed', listener);
  },
  onHostHotkey: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('host-hotkey', listener);
    return () => ipcRenderer.removeListener('host-hotkey', listener);
  },
  onWebviewCrashed: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('webview-crashed', listener);
    return () => ipcRenderer.removeListener('webview-crashed', listener);
  },
  onSystemResumed: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('system-resumed-after-sleep', listener);
    return () => ipcRenderer.removeListener('system-resumed-after-sleep', listener);
  },
});

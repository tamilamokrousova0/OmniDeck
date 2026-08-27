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
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  signalLinkStart: (payload) => ipcRenderer.invoke('signal-link-start', payload),
  signalLinkCancel: () => ipcRenderer.invoke('signal-link-cancel'),
  signalInstallCli: (payload) => ipcRenderer.invoke('signal-install-cli', payload),
  signalGetStatus: () => ipcRenderer.invoke('signal-get-status'),
  signalSend: (payload) => ipcRenderer.invoke('signal-send', payload),
  signalLoadMessages: () => ipcRenderer.invoke('signal-load-messages'),
  signalOpenAttachment: (filePath) => ipcRenderer.invoke('signal-open-attachment', filePath),
  signalListContacts: (payload) => ipcRenderer.invoke('signal-list-contacts', payload),
  signalReact: (payload) => ipcRenderer.invoke('signal-react', payload),
  signalDeleteChat: (payload) => ipcRenderer.invoke('signal-delete-chat', payload),
  signalListGroups: (payload) => ipcRenderer.invoke('signal-list-groups', payload),
  signalReadAttachment: (filePath) => ipcRenderer.invoke('signal-read-attachment', filePath),
  signalTranscribeWav: (payload) => ipcRenderer.invoke('signal-transcribe-wav', payload),
  signalSetTranscript: (payload) => ipcRenderer.invoke('signal-set-transcript', payload),
  signalRestart: (payload) => ipcRenderer.invoke('signal-restart', payload),
  signalSaveAttachment: (filePath) => ipcRenderer.invoke('signal-save-attachment', filePath),
  openSignalDesktop: () => ipcRenderer.invoke('open-signal-desktop'),
  onSignalEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('signal-event', listener);
    return () => ipcRenderer.removeListener('signal-event', listener);
  },
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
  onBundleRenamed: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = () => callback();
    ipcRenderer.on('bundle-renamed', listener);
    return () => ipcRenderer.removeListener('bundle-renamed', listener);
  },
  onGuestLink: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on('guest-link', listener);
    return () => ipcRenderer.removeListener('guest-link', listener);
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

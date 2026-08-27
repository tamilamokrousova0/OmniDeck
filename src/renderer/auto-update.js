import { closeModalAnimated, setStatusZone } from './core/helpers.js';

  /* Release notes come from the bundled CHANGELOG.md via IPC (main parses
     it once per session). The old hardcoded map silently went stale — its
     last entry was 0.6.1 while the app shipped 0.8.0, so «Что нового» never
     appeared for four releases. */
  let releaseNotesCache = null;

  async function loadReleaseNotes() {
    if (releaseNotesCache) return releaseNotesCache;
    try {
      const res = await window.waDeck?.getReleaseNotes?.();
      releaseNotesCache = (res?.ok && res.notes && typeof res.notes === 'object') ? res.notes : {};
    } catch {
      releaseNotesCache = {};
    }
    return releaseNotesCache;
  }

  let state, els, setStatus;

  function init(ctx) {
    state = ctx.state;
    els = ctx.els;
    setStatus = ctx.setStatus;
  }

  function handleAutoUpdateStatus(payload = {}) {
    const status = String(payload?.status || '').trim();
    const message = String(payload?.message || '').trim() || 'временно недоступно';
    const version = String(payload?.version || '').trim();
    const percent = Number(payload?.percent || 0);
    // Background checks (source:'auto') stay quiet unless there is something
    // actionable — only manual checks narrate their progress in the status bar.
    const isAuto = String(payload?.source || '') === 'auto';

    if (status === 'disabled') {
      setStatus('Обновление доступно только в собранной версии');
      return;
    }
    if (status === 'checking') {
      if (!isAuto) setStatus('Обновление: проверка...');
      return;
    }
    if (status === 'available') {
      setStatus(`Обновление: доступна версия ${version || 'новая'}`);
      // Compact toast (bottom-right) instead of a blocking modal — the user
      // keeps working in chats while the download happens in the background.
      showUpdateToast(version, 'available');
      return;
    }
    if (status === 'downloading') {
      // setStatusZone, не setStatus: прогресс обновляется в одной плашке
      setStatusZone(`Обновление: загрузка ${Math.max(0, Math.min(100, percent))}%`);
      updateToastProgress(percent);
      return;
    }
    if (status === 'downloaded') {
      setStatus(`Обновление ${version || ''} загружено`);
      showUpdateToast(version, 'ready');
      // Release notes for the new version are shown by maybeShowReleaseNotes
      // on the first launch AFTER the update — mutating the shared modal here
      // could silently replace the content of an already-open «Что нового».
      return;
    }
    if (status === 'not-available') {
      if (!isAuto) setStatus(`Обновление: ${message}`);
      return;
    }
    if (status === 'error') {
      if (!isAuto) setStatus(`Обновление: ${message}`);
      // Keep the toast when an update is already downloaded: hiding it here
      // would remove the only install affordance because of an unrelated
      // later check failing (offline, GitHub hiccup).
      if (updateToastMode !== 'ready') hideUpdateToast();
    }
  }

  /* ── Update Toast (compact bottom-right notification) ── */

  // 'available' | 'ready' | null — what the toast currently shows.
  let updateToastMode = null;
  // Set when the user closes the toast with the ✕: progress events must not
  // resurrect a dismissed toast for the rest of the download.
  let updateToastDismissed = false;

  function showUpdateToast(version, mode) {
    if (!els.updateToast) return;
    if (mode === 'available') updateToastDismissed = false; // new update cycle
    if (mode !== 'ready' && updateToastDismissed) return;
    if (mode === 'ready') updateToastDismissed = false; // install affordance always shows
    updateToastMode = mode;
    const versionLabel = version ? `Версия ${version}` : 'Новая версия';
    if (els.updateToastTitle) {
      els.updateToastTitle.textContent = mode === 'ready' ? versionLabel : 'Доступно обновление';
    }
    if (els.updateToastSub) {
      if (mode === 'ready') {
        els.updateToastSub.textContent = 'Готово к установке';
      } else if (version) {
        els.updateToastSub.textContent = `${versionLabel} — загружается…`;
      } else {
        els.updateToastSub.textContent = 'Загружается…';
      }
    }
    if (els.updateToastProgress) {
      els.updateToastProgress.classList.toggle('hidden', mode === 'ready');
    }
    if (els.updateToastProgressFill && mode === 'available') {
      els.updateToastProgressFill.style.width = '0%';
    }
    if (els.updateToastAction) {
      els.updateToastAction.classList.toggle('hidden', mode !== 'ready');
      els.updateToastAction.classList.remove('is-busy');
      els.updateToastAction.disabled = false;
    }
    els.updateToast.classList.remove('hidden');
  }

  function updateToastProgress(percent) {
    if (updateToastDismissed) return;
    const safePct = Math.max(0, Math.min(100, Number(percent) || 0));
    if (els.updateToastProgressFill) {
      els.updateToastProgressFill.style.width = `${safePct}%`;
    }
    if (els.updateToastSub) {
      els.updateToastSub.textContent = `Загрузка: ${Math.round(safePct)}%`;
    }
    // Make sure the toast is visible even if 'available' was missed (fast
    // pipeline goes straight to 'downloading' on some networks).
    if (els.updateToast && els.updateToast.classList.contains('hidden')) {
      els.updateToast.classList.remove('hidden');
      updateToastMode = 'available';
      if (els.updateToastTitle) els.updateToastTitle.textContent = 'Доступно обновление';
      if (els.updateToastProgress) els.updateToastProgress.classList.remove('hidden');
    }
  }

  function hideUpdateToast() {
    if (els.updateToast) els.updateToast.classList.add('hidden');
    updateToastMode = null;
  }

  function closeUpdateToast() {
    updateToastDismissed = true;
    hideUpdateToast();
  }

  // Set when main returns 'mac_manual_required' (app runs from a DMG or a
  // translocated path and can't self-swap). The install buttons then turn
  // into "open GitHub Releases" actions.
  let macManualRequired = false;

  async function installUpdate() {
    if (macManualRequired) {
      window.waDeck?.openReleasesPage?.();
      return;
    }
    if (!window.waDeck?.installDownloadedUpdate) {
      setStatus('Установка обновления недоступна');
      return;
    }
    const buttons = [els.updateToastAction].filter(Boolean);
    for (const b of buttons) { b.classList.add('is-busy'); b.disabled = true; }
    const result = await window.waDeck.installDownloadedUpdate().catch(() => null);
    if (!result?.ok) {
      if (result?.error === 'mac_manual_required') {
        macManualRequired = true;
        setStatus('Запустите приложение из папки Программы для автообновления');
        // Repurpose the buttons: next click opens the releases page
        for (const b of buttons) {
          b.classList.remove('is-busy');
          b.disabled = false;
          b.textContent = 'Открыть Releases';
        }
        if (els.updateToastSub) {
          els.updateToastSub.textContent = 'Запустите приложение из папки Программы для автообновления';
        }
        return;
      }
      if (result?.error === 'not_downloaded') {
        setStatus('Обновление ещё не загружено');
      } else {
        setStatus('Не удалось установить обновление');
      }
      for (const b of buttons) { b.classList.remove('is-busy'); b.disabled = false; }
    }
  }

  /* ── Release Notes ── */

  function compareVersions(a, b) {
    // Strip prerelease suffixes per part ('0.7.14-beta.1' used to become NaN);
    // a release outranks its own prerelease when the numeric parts are equal.
    const parse = (v) => {
      const s = String(v || '').replace(/^v/i, '');
      return {
        nums: s.split('.').map((part) => Number(String(part).split('-')[0]) || 0),
        prerelease: s.includes('-'),
      };
    };
    const pa = parse(a);
    const pb = parse(b);
    const len = Math.max(pa.nums.length, pb.nums.length);
    for (let i = 0; i < len; i += 1) {
      const diff = (pa.nums[i] || 0) - (pb.nums[i] || 0);
      if (diff !== 0) return diff;
    }
    if (pa.prerelease !== pb.prerelease) return pa.prerelease ? -1 : 1;
    return 0;
  }

  function renderReleaseNotes(versions = [], notes = {}) {
    if (!els.releaseNotesList) return;
    els.releaseNotesList.innerHTML = '';
    for (const version of versions) {
      const card = document.createElement('div');
      card.className = 'release-notes-version-block';

      const title = document.createElement('div');
      title.className = 'release-notes-version-title';
      title.textContent = `Версия ${version}`;

      const list = document.createElement('ul');
      for (const line of notes[version] || []) {
        const item = document.createElement('li');
        item.textContent = line;
        list.appendChild(item);
      }

      card.append(title, list);
      els.releaseNotesList.appendChild(card);
    }
  }

  async function markReleaseNotesSeen(version) {
    const safeVersion = String(version || '').trim();
    if (!safeVersion) return;
    const next = await window.waDeck.saveSettings({
      lastSeenReleaseNotesVersion: safeVersion,
    });
    state.settings = {
      ...(state.settings || {}),
      ...(next || {}),
    };
  }

  async function maybeShowReleaseNotes() {
    const currentVersion = String(state.runtime?.appVersion || '').trim();
    const lastSeen = String(state.settings?.lastSeenReleaseNotesVersion || '').trim();
    if (!currentVersion || compareVersions(currentVersion, lastSeen) <= 0) return;

    const notes = await loadReleaseNotes();
    const versions = Object.keys(notes)
      .filter((version) => (notes[version] || []).length)
      .filter((version) => compareVersions(version, lastSeen || '0.0.0') > 0 && compareVersions(version, currentVersion) <= 0)
      .sort(compareVersions)
      .reverse();
    if (!versions.length) {
      await markReleaseNotesSeen(currentVersion);
      return;
    }

    if (!els.releaseNotesTitle || !els.releaseNotesVersion || !els.releaseNotesModal) return;
    els.releaseNotesTitle.textContent = 'Что нового';
    els.releaseNotesVersion.textContent = `Обновление до версии ${currentVersion}`;
    renderReleaseNotes(versions, notes);
    els.releaseNotesModal.classList.remove('hidden');
  }

  async function closeReleaseNotesModal() {
    if (typeof closeModalAnimated === 'function') {
      closeModalAnimated(els.releaseNotesModal);
    } else {
      els.releaseNotesModal.classList.add('hidden');
    }
    await markReleaseNotesSeen(String(state.runtime?.appVersion || '').trim());
  }

  async function requestManualUpdate() {
    if (!window.waDeck?.checkForUpdates) {
      setStatus('Обновление недоступно');
      return;
    }
    els.manualUpdate?.classList.add('is-loading');
    try {
      const response = await window.waDeck.checkForUpdates({ source: 'manual_button' });
      if (response?.ok) {
        setStatus('Обновление: запрос отправлен');
      } else if (response?.error === 'not_packaged') {
        setStatus('Обновление доступно только в .dmg/.exe сборке');
      } else if (response?.error) {
        setStatus(`Обновление: ${response.error}`);
      }
    } catch {
      setStatus('Обновление: ошибка запроса');
    } finally {
      // Always drop the spinner, even when the invoke rejects
      setTimeout(() => {
        els.manualUpdate?.classList.remove('is-loading');
      }, 520);
    }
  }

  export const WaDeckAutoUpdateModule = {
    init,
    handleAutoUpdateStatus,
    maybeShowReleaseNotes,
    closeReleaseNotesModal,
    requestManualUpdate,
    closeUpdateToast,
    installUpdate,
  };
  window.WaDeckAutoUpdateModule = WaDeckAutoUpdateModule;

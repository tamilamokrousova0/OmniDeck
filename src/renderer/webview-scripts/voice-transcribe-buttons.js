/* voice-transcribe-buttons.js — кнопка «расшифровать» у голосовых сообщений.
 *
 * Контекстное меню на пузырях не работает: WhatsApp Web гасит contextmenu
 * (preventDefault) и рисует своё HTML-меню, так что Electron-событие
 * `context-menu` до main-процесса не доходит. Поэтому триггер — небольшая
 * плашка-кнопка под пузырём (полупрозрачная, проявляется при наведении).
 *
 * Клик шлёт TRANSCRIBE_VOICE через токен-мост guest→host; остальной флоу
 * (захват аудио, whisper) ведёт main-процесс — см. src/voice-transcribe.js.
 */

function voiceTranscribeButtonsScript(token) {
  const tokenJs = JSON.stringify(typeof token === 'string' ? token : '');
  return `(() => {
    if (window.__waDeckVoiceBtnBound) return true;
    window.__waDeckVoiceBtnBound = true;

    const __WADECK_TOKEN = ${tokenJs};
    const __waDeckEmit = (kind, json) => {
      const send = window.__waDeckGuestSend;
      if (typeof send === 'function') {
        try { send(__WADECK_TOKEN, kind, json); return; } catch (_) {}
      }
      console.log('__WADECK_' + kind + '__' + __WADECK_TOKEN + ':' + json);
    };

    /* Наведение — через инжектированный стиль (inline :hover не бывает) */
    if (!document.getElementById('__wadeck-voice-btn-style')) {
      const st = document.createElement('style');
      st.id = '__wadeck-voice-btn-style';
      st.textContent = [
        '.__wadeck-voice-btn{opacity:.35;transition:opacity .15s ease}',
        '[role="row"]:hover .__wadeck-voice-btn{opacity:1}',
      ].join('');
      (document.head || document.documentElement).appendChild(st);
    }

    /* Голосовое: ряд сообщений в панели чата (#main) с иконкой аудиоплеера.
       Видео: превью с play-оверлеем (media-play) или уже загруженный <video>.
       data-icon переживает редизайны лучше классов (см. voice-message.js). */
    const VOICE_ICON_SEL = 'span[data-icon*="audio-play"], span[data-icon*="audio-pause"], span[data-icon*="ptt"]';
    const VIDEO_ICON_SEL = 'span[data-icon*="media-play"], span[data-icon*="video-pip"], span[data-icon*="ptv"]';
    const rowKind = (row) => {
      if (row.querySelector(VOICE_ICON_SEL) || row.querySelector('audio')) return 'voice';
      /* GIF WhatsApp — тоже <video>, но без звука: кнопка там бессмысленна */
      if (row.querySelector('span[data-icon*="gif"]')) return '';
      const vid = row.querySelector('video');
      if (vid && vid.loop && !row.querySelector(VIDEO_ICON_SEL)) return '';
      if (row.querySelector(VIDEO_ICON_SEL) || vid) return 'video';
      return '';
    };

    function makeButton(row, kind) {
      const btn = document.createElement('div');
      btn.className = '__wadeck-voice-btn';
      btn.textContent = kind === 'video' ? '🎬 расшифровать' : '🎤 расшифровать';
      btn.style.cssText = [
        'margin:2px 8px 2px 48px',
        'padding:2px 9px',
        'width:fit-content',
        'font-size:11px',
        'line-height:1.5',
        'border-radius:10px',
        'background:rgba(24,30,43,0.85)',
        'border:1px solid rgba(45,140,240,0.4)',
        'color:#9fb6c9',
        'cursor:pointer',
        'user-select:none',
        '-webkit-user-select:none',
      ].join(';');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        let id = row.getAttribute('data-wadeck-voice-id');
        if (!id) {
          id = 'v' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
          row.setAttribute('data-wadeck-voice-id', id);
        }
        btn.remove();
        __waDeckEmit('TRANSCRIBE_VOICE', JSON.stringify({ id: id, kind: kind }));
      });
      return btn;
    }

    function sweep() {
      const main = document.querySelector('#main');
      if (!main) return;
      /* Виртуализация чата переиспользует DOM-ряды: кнопка, оставшаяся в
         ряду без аудиоплеера, — мусор от прежнего сообщения. */
      const stale = main.querySelectorAll('.__wadeck-voice-btn');
      for (let i = 0; i < stale.length; i++) {
        const row = stale[i].closest('[role="row"]');
        if (!row || !rowKind(row)) stale[i].remove();
      }
      /* Виртуализация переиспользует ряды: id, оставшийся от прежнего
         сообщения, приклеивал бы транскрипт к чужому пузырю */
      const tagged = main.querySelectorAll('[data-wadeck-voice-id]');
      for (let i = 0; i < tagged.length; i++) {
        if (!rowKind(tagged[i]) && !tagged[i].querySelector('.__wadeck-voice-tr')) {
          tagged[i].removeAttribute('data-wadeck-voice-id');
        }
      }
      const rows = main.querySelectorAll('[role="row"]');
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const kind = rowKind(row);
        if (!kind) continue;
        if (row.querySelector(':scope .__wadeck-voice-btn')) continue;
        const box = row.querySelector(':scope .__wadeck-voice-tr');
        /* Плашка с готовым текстом или прогрессом — кнопка не нужна;
           после ошибки кнопку возвращаем (повторная попытка). */
        if (box && box.dataset.state !== 'error') continue;
        row.appendChild(makeButton(row, kind));
      }
    }

    let sweepTimer = null;
    const scheduleSweep = () => {
      /* Фоновые аккаунты не надо обходить: свип крутился во ВСЕХ webview,
         хотя кнопки нужны только в том, на который смотрит пользователь.
         Флаг ставит дека при переключении аккаунта (см. refreshWebviewVisibility). */
      if (window.__waDeckWebviewActive === false) return;
      if (sweepTimer) return;
      sweepTimer = setTimeout(() => { sweepTimer = null; try { sweep(); } catch (_) {} }, 400);
    };

    const observer = new MutationObserver(scheduleSweep);
    observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
    setInterval(scheduleSweep, 8000);
    scheduleSweep();
    return true;
  })();`;
}

export { voiceTranscribeButtonsScript };

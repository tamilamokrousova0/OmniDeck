import { encodeBase64Utf8 } from '../core/state.js';

/* «Paste as human typing» (Cmd/Ctrl+Shift+E): набирает текст из буфера в
 * композер активного чата посимвольно с человеческими задержками вместо
 * мгновенной вставки. Работает и в WhatsApp (footer contenteditable, Lexical),
 * и в Telegram Web A (#editable-message-text).
 *
 * Посимвольный execCommand('insertText') оба редактора принимают — это тот же
 * путь, что шаг 1 в insert-text.js, только по одному символу. Фолбэк на
 * beforeinput для случая, когда execCommand вернул false (Lexical иногда так
 * делает после внутреннего ремаунта).
 *
 * Повторный запуск во время набора игнорируется (__waDeckHumanTyping),
 * Escape в guest-контексте прерывает набор. */
function humanTypeScript(text) {
  const textB64 = encodeBase64Utf8(String(text || ''));
  return `(async () => {
    try {
      if (window.__waDeckHumanTyping) return { ok: false, error: 'already_typing' };

      const binary = atob('${textB64}');
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const message = new TextDecoder().decode(bytes);
      if (!message) return { ok: false, error: 'empty' };

      const composer =
        document.querySelector('footer div[contenteditable="true"][role="textbox"]') ||
        document.querySelector('footer div[contenteditable="true"][data-tab]') ||
        document.querySelector('#editable-message-text[contenteditable="true"]') ||
        document.querySelector('div[contenteditable="true"][role="textbox"]');
      if (!composer) return { ok: false, error: 'composer_not_found' };

      window.__waDeckHumanTyping = true;
      let aborted = false;
      const onKey = (e) => { if (e.key === 'Escape') aborted = true; };
      document.addEventListener('keydown', onKey, true);

      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      const rnd = (min, max) => min + Math.random() * (max - min);

      try {
        composer.focus();
        // Итерация по code points, не по UTF-16 единицам — эмоджи и прочие
        // суррогатные пары должны вставляться целиком.
        for (const ch of message) {
          if (aborted) break;
          let claimed = false;
          try { claimed = document.execCommand('insertText', false, ch); } catch { claimed = false; }
          if (!claimed) {
            try {
              composer.dispatchEvent(new InputEvent('beforeinput', {
                inputType: 'insertText', data: ch, bubbles: true, cancelable: true,
              }));
            } catch { /* символ пропал — не фатально, продолжаем */ }
          }
          await delay(rnd(40, 140));
          // Пауза «на подумать» после знаков препинания и переводов строки
          if ('.!?,;:\\n'.indexOf(ch) !== -1) await delay(rnd(300, 700));
        }
      } finally {
        document.removeEventListener('keydown', onKey, true);
        window.__waDeckHumanTyping = false;
      }
      return { ok: true, aborted };
    } catch (e) {
      window.__waDeckHumanTyping = false;
      return { ok: false, error: String(e?.message || e || 'human_type_failed') };
    }
  })();`;
}

export { humanTypeScript };

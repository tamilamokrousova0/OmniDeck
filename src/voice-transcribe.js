/* voice-transcribe.js — расшифровка входящих голосовых через whisper.cpp.
 *
 * Поток: контекстное меню на голосовом (main.js) → hit-test пузыря →
 * capture-скрипт в webview глушит звук, жмёт play, забирает blob и отдаёт
 * WAV 16kHz mono base64 → whisper-cli (-l auto) → транскрипт вставляется
 * плашкой ПОД пузырём (не оверлеем — плеер должен остаться кликабельным).
 *
 * Бинарь: packaged — resources/whisper/, dev — brew (/opt/homebrew/bin).
 * Модель ggml-large-v3-turbo-q5_0 (~550 МБ) НЕ вшита в дистрибутив: качается в
 * userData/whisper при первом использовании после подтверждения диалогом.
 *
 * Побочный эффект by design: программный play отправляет отправителю
 * отметку «прослушано» — как и ручное прослушивание.
 */

const { app, dialog, net } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

/* large-v3-turbo: качество large при скорости small (4 decoder-слоя).
   small-q5_1 ронял/выдумывал последние слова коротких голосовых. */
const MODEL_FILE = 'ggml-large-v3-turbo-q5_0.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;
const MODEL_MIN_BYTES = 500 * 1024 * 1024; // недокачанный файл не считаем моделью
const CAPTURE_TIMEOUT_MS = 25000;  // скачивание+расшифровка медиа самим WhatsApp
const WHISPER_TIMEOUT_MS = 180000;

let _busy = false;
let _modelDownloadPromise = null;

let _binPathCache; // undefined = не проверяли, null = рабочего бинаря нет

function whisperBinaryPath() {
  if (_binPathCache !== undefined) return _binPathCache;
  const name = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  const candidates = [];
  if (app.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'whisper', name));
  } else {
    candidates.push(path.join(__dirname, '..', 'build', 'whisper',
      process.platform === 'win32' ? 'win' : 'mac', name));
  }
  // Локальные mac-сборки без CI-шага упаковываются с пустым resources/whisper —
  // brew-бинарь как последний фолбэк, чтобы фича не умирала молча.
  if (process.platform === 'darwin') candidates.push('/opt/homebrew/bin/whisper-cli');
  // existsSync мало: динамически слинкованный бинарь без своих dylib рядом
  // (обломанный @rpath) существует, но умирает на dyld. Кандидат обязан
  // реально запуститься — иначе переходим к следующему.
  _binPathCache = candidates.find((p) => {
    if (!fsSync.existsSync(p)) return false;
    try {
      const r = spawnSync(p, ['--help'], { timeout: 10000, windowsHide: true, cwd: path.dirname(p) });
      return r.status === 0;
    } catch {
      return false;
    }
  }) || null;
  return _binPathCache;
}

function modelPath() {
  return path.join(app.getPath('userData'), 'whisper', MODEL_FILE);
}

function modelReady() {
  try {
    return fsSync.statSync(modelPath()).size >= MODEL_MIN_BYTES;
  } catch {
    return false;
  }
}

/* ── Инжектируемые скрипты ─────────────────────────────────────────── */

/* Кнопка-триггер и метка data-wadeck-voice-id живут в renderer-инжекте
   (src/renderer/webview-scripts/voice-transcribe-buttons.js): контекстное
   меню на пузырях WhatsApp гасит (preventDefault), поэтому триггер — DOM. */

/* Статус-плашка под пузырём. Финальный текст selectable (WhatsApp вешает
   user-select:none на чат — опт-аут как в __wadeck-tr-overlay). */
function voiceStatusScript(voiceId, text, kind) {
  return `(() => {
    try {
      const row = document.querySelector('[data-wadeck-voice-id=${JSON.stringify(voiceId)}]');
      if (!row) return false;
      let box = row.querySelector(':scope .__wadeck-voice-tr');
      if (!box) {
        box = document.createElement('div');
        box.className = '__wadeck-voice-tr';
        box.style.cssText = [
          'margin:4px 8px 2px 48px',
          'padding:6px 10px',
          'max-width:70%',
          'width:fit-content',
          'background:rgba(24,30,43,0.96)',
          'border:1px solid rgba(45,140,240,0.55)',
          'border-radius:8px',
          'color:#e5eaf0',
          'font-size:13px',
          'line-height:1.4',
          'box-sizing:border-box',
          'user-select:text',
          '-webkit-user-select:text',
          'cursor:text',
          'white-space:pre-wrap',
        ].join(';');
        row.appendChild(box);
      }
      const msg = ${JSON.stringify(String(text || ''))};
      const state = ${JSON.stringify(String(kind || 'progress'))};
      box.textContent = msg;
      /* state читает свип кнопок: error → кнопку вернуть (повторная попытка) */
      box.dataset.state = state;
      box.style.borderColor = state === 'error' ? 'rgba(240,80,80,0.6)' : 'rgba(45,140,240,0.55)';
      box.style.opacity = state === 'progress' ? '0.75' : '1';
      return true;
    } catch {
      return false;
    }
  })();`;
}

/* Захват аудио. mid-2026 WhatsApp играет голосовые через DETACHED Audio —
   элемент не попадает в DOM, так что поллинг document.querySelectorAll('audio')
   его не видит (и заглушить заранее нельзя). Ловим инстанс хуком
   HTMLMediaElement.prototype.play: глушим синхронно ДО старта звука, забираем
   blob-src, ставим на паузу и возвращаем громкость. Старый путь (audio в DOM)
   оставлен фолбэком для прежних ревизий разметки. Дальше — blob → 16kHz mono
   WAV, формат whisper-cli. */
function voiceCaptureScript(voiceId) {
  return `(async () => {
    const audios = () => Array.from(document.querySelectorAll('audio'));
    const mutedByUs = [];
    const proto = HTMLMediaElement.prototype;
    const origPlay = proto.play;
    const hooked = { el: null, vol: 1 };
    let hookInstalled = false;
    try {
      const row = document.querySelector('[data-wadeck-voice-id=${JSON.stringify(voiceId)}]');
      if (!row) return { ok: false, error: 'row_gone' };

      let src = null;
      const rowAudio = row.querySelector('audio');
      if (rowAudio && rowAudio.src && rowAudio.src.startsWith('blob:')) {
        src = rowAudio.src; // уже проигрывалось — blob на месте, play не нужен
      }

      if (!src) {
        const before = new Set(audios().map((a) => a.src).filter(Boolean));
        for (const a of audios()) {
          if (!a.muted) { a.muted = true; mutedByUs.push(a); }
        }
        proto.play = function (...args) {
          if (!hooked.el) {
            hooked.el = this;
            hooked.vol = this.volume;
            try { this.muted = true; this.volume = 0; } catch (_) {}
          }
          return origPlay.apply(this, args);
        };
        hookInstalled = true;

        const playBtn = (() => {
          const icon = row.querySelector('span[data-icon*="audio-play"]');
          const viaIcon = icon && (icon.closest('button') || icon.closest('[role="button"]'));
          if (viaIcon) return viaIcon;
          /* новый DOM: у play-кнопки нет data-icon; отличаем её от кнопки
             скорости («1×») по отсутствию текста */
          const blank = Array.from(row.querySelectorAll('button')).find((b) => !(b.innerText || '').trim());
          return blank || row.querySelector('button') || row.querySelector('[role="button"]');
        })();
        if (!playBtn) return { ok: false, error: 'play_button_not_found' };
        playBtn.click();

        const deadline = Date.now() + ${CAPTURE_TIMEOUT_MS};
        while (!src && Date.now() < deadline) {
          if (hooked.el) {
            try { hooked.el.muted = true; } catch (_) {}
            const hs = String(hooked.el.src || '');
            if (hs.startsWith('blob:')) { src = hs; break; }
          }
          for (const a of audios()) {
            if (!a.muted) { a.muted = true; mutedByUs.push(a); }
            const s = String(a.src || '');
            if (s.startsWith('blob:') && (!before.has(s) || !a.paused)) {
              src = s;
              try { a.pause(); a.currentTime = 0; } catch (_) {}
              break;
            }
          }
          if (!src) await new Promise((r) => setTimeout(r, 120));
        }
        /* Вернуть UI пузыря в состояние «пауза», если play успел перещёлкнуть */
        try {
          const pauseIcon = row.querySelector('span[data-icon*="audio-pause"]');
          const pauseBtn = pauseIcon && (pauseIcon.closest('button') || pauseIcon.closest('[role="button"]'));
          if (pauseBtn) pauseBtn.click();
        } catch (_) {}
        if (!src) return { ok: false, error: 'blob_not_found' };
      }

      const buf = await (await fetch(src)).arrayBuffer();
      const dctx = new (window.AudioContext || window.webkitAudioContext)();
      let decoded;
      try {
        decoded = await dctx.decodeAudioData(buf.slice(0));
      } catch (decErr) {
        return { ok: false, error: 'audio_decode_failed', detail: String(decErr && decErr.message || decErr) };
      } finally {
        dctx.close().catch(() => {});
      }

      const rate = 16000;
      /* Тишина по краям (0.25с + 1с): whisper склонен ронять последнее слово,
         когда речь упирается в самый конец файла. */
      const LEAD = 0.25, TAIL = 1.0;
      const frames = Math.max(1, Math.ceil((decoded.duration + LEAD + TAIL) * rate));
      const octx = new OfflineAudioContext(1, frames, rate);
      const osrc = octx.createBufferSource();
      osrc.buffer = decoded;
      osrc.connect(octx.destination);
      osrc.start(LEAD);
      const rendered = await octx.startRendering();
      const pcm = rendered.getChannelData(0);

      const wav = new ArrayBuffer(44 + pcm.length * 2);
      const dv = new DataView(wav);
      const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
      wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
      wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
      for (let i = 0; i < pcm.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i]));
        dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }

      const bytes = new Uint8Array(wav);
      let b64 = '';
      /* КРАТНО 3! btoa чанка, не кратного 3, кончается '='-паддингом, а
         Buffer.from(..., 'base64') в main обрывает декод на первом внутреннем
         паддинге — уезжал только первый чанк (32768 Б = 1 секунда аудио). */
      const CHUNK = 0x7ffe;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        b64 += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
      }
      return { ok: true, wav: b64, duration: decoded.duration };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    } finally {
      if (hookInstalled) proto.play = origPlay;
      if (hooked.el) {
        /* сперва пауза, потом громкость — иначе секунда звука в динамики;
           WhatsApp переиспользует один Audio, замьюченным его оставлять нельзя */
        try { hooked.el.pause(); hooked.el.currentTime = 0; } catch (_) {}
        try { hooked.el.muted = false; hooked.el.volume = hooked.vol; } catch (_) {}
      }
      for (const a of mutedByUs) { try { a.muted = false; } catch (_) {} }
    }
  })();`;
}

/* ── Main-процесс ──────────────────────────────────────────────────── */

async function setStatus(contents, voiceId, text, kind) {
  try {
    await contents.executeJavaScript(voiceStatusScript(voiceId, text, kind || 'progress'));
  } catch { /* webview мог перезагрузиться — статус не критичен */ }
}

async function downloadModel(contents, voiceId) {
  if (_modelDownloadPromise) return _modelDownloadPromise;
  _modelDownloadPromise = (async () => {
    const dest = modelPath();
    const tmp = `${dest}.download`;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const resp = await net.fetch(MODEL_URL);
    if (!resp.ok) throw new Error(`model download HTTP ${resp.status}`);
    const total = Number(resp.headers.get('content-length')) || 0;
    const fh = await fs.open(tmp, 'w');
    let received = 0;
    let lastShown = -10;
    try {
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await fh.write(value);
        received += value.length;
        const pct = total ? Math.floor((received / total) * 100) : 0;
        if (pct >= lastShown + 5) {
          lastShown = pct;
          await setStatus(contents, voiceId, `⏳ Загрузка модели распознавания… ${pct}%`);
        }
      }
    } finally {
      await fh.close();
    }
    if (received < MODEL_MIN_BYTES) throw new Error('model download truncated');
    await fs.rename(tmp, dest);
  })().finally(() => { _modelDownloadPromise = null; });
  return _modelDownloadPromise;
}

async function ensureModel(contents, voiceId, parentWindow) {
  if (modelReady()) return true;
  const { response } = await dialog.showMessageBox(parentWindow, {
    type: 'question',
    buttons: ['Скачать', 'Отмена'],
    defaultId: 0,
    cancelId: 1,
    title: 'Расшифровка голосовых',
    message: 'Для расшифровки голосовых нужна модель распознавания речи (~550 МБ).',
    detail: 'Скачивается один раз, работает полностью локально — аудио никуда не отправляется.',
  });
  if (response !== 0) return false;
  await downloadModel(contents, voiceId);
  return true;
}

function runWhisper(binPath, wavPath) {
  return new Promise((resolve, reject) => {
    const args = ['-m', modelPath(), '-f', wavPath, '-l', 'auto', '-nt', '-np'];
    const child = spawn(binPath, args, { cwd: path.dirname(binPath), windowsHide: true });
    let out = '';
    let errOut = '';
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error('whisper timeout'));
    }, WHISPER_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { errOut += d; });
    child.on('error', (err) => { clearTimeout(killTimer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      if (code !== 0) {
        reject(new Error(`whisper exit ${code}: ${errOut.slice(-300)}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

/**
 * Полный флоу по клику меню. Ошибки показываются плашкой у пузыря,
 * наружу не бросаются.
 */
async function transcribeVoiceAt(contents, voiceId, parentWindow) {
  if (_busy) {
    await setStatus(contents, voiceId, 'Уже идёт другая расшифровка — повторите позже', 'error');
    return;
  }
  _busy = true;
  const wavPath = path.join(app.getPath('temp'), `wadeck-voice-${Date.now()}.wav`);
  try {
    const binPath = whisperBinaryPath();
    if (!binPath) {
      await setStatus(contents, voiceId,
        'Модуль распознавания не найден (whisper-cli). Переустановите приложение.', 'error');
      return;
    }
    if (!(await ensureModel(contents, voiceId, parentWindow))) return;

    await setStatus(contents, voiceId, '⏳ Получаю аудио…');
    const captured = await contents.executeJavaScript(voiceCaptureScript(voiceId));
    if (!captured?.ok) {
      const reasons = {
        row_gone: 'Сообщение исчезло из чата — откройте его и попробуйте снова',
        play_button_not_found: 'Не нашёл кнопку воспроизведения у голосового',
        blob_not_found: 'Не удалось получить аудио (WhatsApp не отдал файл)',
        audio_decode_failed: 'Не удалось декодировать аудио',
      };
      await setStatus(contents, voiceId,
        reasons[captured?.error] || `Ошибка захвата: ${captured?.error || 'unknown'}`, 'error');
      return;
    }

    await fs.writeFile(wavPath, Buffer.from(captured.wav, 'base64'));
    await setStatus(contents, voiceId,
      `⏳ Расшифровка (${Math.round(captured.duration)} c аудио)…`);
    const text = await runWhisper(binPath, wavPath);
    if (!text) {
      await setStatus(contents, voiceId, 'Речь не распознана (пустой результат)', 'error');
      return;
    }
    await setStatus(contents, voiceId, `🎤 ${text}`, 'final');
  } catch (err) {
    console.error('[voice-transcribe]', err);
    await setStatus(contents, voiceId,
      `Ошибка расшифровки: ${String(err?.message || err).slice(0, 200)}`, 'error');
  } finally {
    _busy = false;
    fs.unlink(wavPath).catch(() => {});
  }
}

module.exports = { transcribeVoiceAt, whisperBinaryPath, modelReady };

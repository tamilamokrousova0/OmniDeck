/* voice-transcribe.js — расшифровка входящих голосовых через whisper.cpp.
 *
 * Поток: контекстное меню на голосовом (main.js) → hit-test пузыря →
 * capture-скрипт в webview глушит звук, жмёт play, забирает blob и отдаёт
 * WAV 16kHz mono base64 → whisper-cli (-l auto) → транскрипт вставляется
 * плашкой ПОД пузырём (не оверлеем — плеер должен остаться кликабельным).
 *
 * Бинарь: packaged — resources/whisper/, dev — brew (/opt/homebrew/bin).
 * Модель ggml-small-q5_1 (~190 МБ) НЕ вшита в дистрибутив: качается в
 * userData/whisper при первом использовании после подтверждения диалогом.
 *
 * Побочный эффект by design: программный play отправляет отправителю
 * отметку «прослушано» — как и ручное прослушивание.
 */

const { app, dialog, net } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');

/* small-q5_1 на всех платформах: быстрая даже на слабом CPU (большие модели
   на Windows не успевали до таймаута), качества хватает (решение юзера после
   живых тестов; серверная расшифровка выпилена как лишняя сложность). */
const MODEL_FILE = 'ggml-small-q5_1.bin';
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;
const MODEL_MIN_BYTES = 150 * 1024 * 1024; // недокачанный файл не считаем моделью
const MODEL_HUMAN_SIZE = '~190 МБ';
const CAPTURE_TIMEOUT_MS = 25000;  // скачивание+расшифровка медиа самим WhatsApp
const WHISPER_TIMEOUT_MS = 300000; // слабый CPU + длинное голосовое — это долго
// whisper-cli по умолчанию берёт 4 потока — на 8-ядерных половина простаивает
const WHISPER_THREADS = Math.max(2, os.cpus().length - 1);

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
      const r = spawnSync(p, ['--help'], { timeout: 4000, windowsHide: true, cwd: path.dirname(p) });
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

/* Смена дефолтной модели оставляет прежнюю мёртвым грузом (small-q5_1 — 190 МБ
   у всех, кто пользовался фичей до апгрейда). Сносим всё, что не текущая
   модель, включая недокачанные .download. Зовётся из bootstrap. */
function cleanupStaleModels() {
  const dir = path.join(app.getPath('userData'), 'whisper');
  fs.readdir(dir).then((files) => {
    for (const f of files) {
      if (f === MODEL_FILE) continue;
      if (f.startsWith('ggml-') || f.endsWith('.download')) {
        fs.unlink(path.join(dir, f)).catch(() => {});
      }
    }
  }).catch(() => { /* каталога нет — фичей не пользовались */ });
  // Временный WAV живёт только на время распознавания (unlink в finally), но
  // kill/краш посреди расшифровки его осиротит — дометаем при старте
  // (аудио не должно храниться нигде и никогда).
  const tmp = app.getPath('temp');
  fs.readdir(tmp).then((files) => {
    for (const f of files) {
      if (f.startsWith('wadeck-voice-') && f.endsWith('.wav')) {
        fs.unlink(path.join(tmp, f)).catch(() => {});
      }
    }
  }).catch(() => {});
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
function voiceCaptureScript(voiceId, kind) {
  const isVideo = kind === 'video';
  return `(async () => {
    const IS_VIDEO = ${isVideo ? 'true' : 'false'};
    /* Видео mid-2026 отдаётся сервис-воркером по https://web.whatsapp.com/stream/…
       (не blob!), причём Range-ответами по 1.5 МБ: без дочитывания получаем
       половину дорожки. Голосовые остаются blob-ами. */
    const isMediaSrc = (u) => {
      const v = String(u || '');
      return v.startsWith('blob:') || v.indexOf('/stream/') !== -1;
    };
    const fetchFull = async (u) => {
      if (String(u).startsWith('blob:')) return await (await fetch(u)).arrayBuffer();
      const first = await fetch(u, { headers: { Range: 'bytes=0-' } });
      const cr = first.headers.get('content-range') || '';
      const total = Number(cr.split('/')[1] || 0);
      const parts = [new Uint8Array(await first.arrayBuffer())];
      let got = parts[0].length;
      let guard = 0;
      while (total && got < total && guard++ < 80) {
        const r = await fetch(u, { headers: { Range: 'bytes=' + got + '-' } });
        const b = new Uint8Array(await r.arrayBuffer());
        if (!b.length) break;
        parts.push(b); got += b.length;
      }
      const all = new Uint8Array(got);
      let off = 0;
      for (const part of parts) { all.set(part, off); off += part.length; }
      return all.buffer;
    };
    /* Для видео blob живёт на <video> (в пузыре или в медиа-вьюере),
       глушим на всякий случай оба типа медиа. decodeAudioData Chromium
       сам демуксит mp4 и берёт аудио-дорожку — конвейер ниже общий. */
    const audios = () => Array.from(document.querySelectorAll(IS_VIDEO ? 'audio, video' : 'audio'));
    const capTag = IS_VIDEO ? 'VIDEO' : 'AUDIO';
    const mutedByUs = [];
    const proto = HTMLMediaElement.prototype;
    const origPlay = proto.play;
    const hooked = { el: null, vol: 1 };
    let hookInstalled = false;
    try {
      const row = document.querySelector('[data-wadeck-voice-id=${JSON.stringify(voiceId)}]');
      if (!row) return { ok: false, error: 'row_gone' };

      let src = null;
      const rowAudio = row.querySelector(IS_VIDEO ? 'video' : 'audio');
      if (rowAudio && isMediaSrc(rowAudio.src)) {
        src = rowAudio.src; // уже проигрывалось — источник на месте, play не нужен
      }

      /* Прямой путь: полный ключ медиа лежит в локальной базе WhatsApp
         (model-storage → store «message», ключи вида
         false_<чат>@lid_<сообщение>). Берём его по id сообщения из разметки
         и скачиваем файл у сервис-воркера — ничего не открывается и не
         играет. Не вышло — ниже прежний путь с кликом по play. */
      if (IS_VIDEO && !src) {
        try {
          const idEl = row.querySelector('[data-id]');
          const msgId = idEl && idEl.getAttribute('data-id');
          if (msgId) {
            const fullKey = await new Promise((resolve) => {
              let done = false;
              const fin = (v) => { if (!done) { done = true; resolve(v); } };
              setTimeout(() => fin(''), 2500); // база молчит — не ждём
              try {
                const req = indexedDB.open('model-storage');
                req.onerror = () => fin('');
                req.onsuccess = () => {
                  const db = req.result;
                  if (!db.objectStoreNames.contains('message')) { db.close(); return fin(''); }
                  const st = db.transaction('message', 'readonly').objectStore('message');
                  const q = st.getAllKeys();
                  q.onsuccess = () => {
                    const suffix = '_' + msgId;
                    const hit = (q.result || []).map(String).find((k) => k.endsWith(suffix));
                    db.close();
                    fin(hit || '');
                  };
                  q.onerror = () => { db.close(); fin(''); };
                };
              } catch (_) { fin(''); }
            });
            if (fullKey) {
              const direct = 'https://web.whatsapp.com/stream/video?key=' + fullKey;
              const probe = await fetch(direct, { headers: { Range: 'bytes=0-1023' } });
              if (probe.status === 206 || probe.ok) src = direct;
            }
          }
        } catch (_) { /* ключ не нашёлся — обычный путь ниже */ }
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
            // в отслеживаемый набор — чтобы в finally элемент вернулся со звуком
            if (!this.muted && mutedByUs.indexOf(this) === -1) mutedByUs.push(this);
            try { this.muted = true; this.volume = 0; } catch (_) {}
          }
          return origPlay.apply(this, args);
        };
        hookInstalled = true;

        const playBtn = (() => {
          if (IS_VIDEO) {
            /* ТОЛЬКО media-play: у пузыря рядом лежит video-pip, и селектор
               по *="video" жал именно его — видео уезжало в отдельное
               «картинка-в-картинке» окно вместо инлайнового воспроизведения */
            const vIcon = row.querySelector('span[data-icon="media-play"]')
              || row.querySelector('span[data-icon*="ptv"]');
            const viaV = vIcon && (vIcon.closest('button') || vIcon.closest('[role="button"]') || vIcon);
            if (viaV) return viaV;
            const notPip = [...row.querySelectorAll('button, [role="button"]')]
              .find((b) => !b.querySelector('span[data-icon*="pip"]') && !/картинка|picture/i.test(b.getAttribute('aria-label') || ''));
            return notPip || null;
          }
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
        /* Через 6 с перестаём требовать «новый» источник: WhatsApp
           переиспользует один <video> с тем же URL, и повторная расшифровка
           того же ролика иначе ждала таймаут впустую. */
        const relaxAt = Date.now() + 6000;
        while (!src && Date.now() < deadline) {
          const relaxed = Date.now() > relaxAt;
          if (hooked.el && (!IS_VIDEO || hooked.el.tagName === capTag)) {
            try { hooked.el.muted = true; } catch (_) {}
            const hs = String(hooked.el.src || '');
            if (isMediaSrc(hs)) { src = hs; break; }
          }
          for (const a of audios()) {
            // Видео играет через autoplay, .play() не вызывается — hook его не
            // ловит, поэтому глушим здесь, в цикле опроса
            if (!a.muted) { a.muted = true; mutedByUs.push(a); }
            if (IS_VIDEO && a.tagName !== capTag) continue;
            const s = String(a.src || '');
            if (isMediaSrc(s) && (relaxed || !before.has(s) || !a.paused)) {
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

      const dctx = new (window.AudioContext || window.webkitAudioContext)();
      let decoded = null;
      let captureMode = 'blob';
      /* Быстрый путь: blob целиком. У видео WhatsApp это часто MediaSource —
         fetch по такому blob-URL падает, тогда идём realtime-путём. */
      try {
        const buf = await fetchFull(src);
        if (buf.byteLength > 0) decoded = await dctx.decodeAudioData(buf.slice(0));
      } catch (_) { decoded = null; }

      if (!decoded && IS_VIDEO) {
        /* Realtime-захват дорожки прямо с играющего элемента.
           createMediaElementSource уводит звук из динамиков в наш граф —
           поэтому запись идёт беззвучно и без mute-жонглирования. */
        captureMode = 'realtime';
        const el = [...document.querySelectorAll('video')].find((v) => String(v.src || '') === src)
          || hooked.el
          || document.querySelector('video');
        if (!el) { dctx.close().catch(() => {}); return { ok: false, error: 'video_gone' }; }
        try {
          /* Долгоживущий контекст + WeakMap узлов: createMediaElementSource
             можно вызвать на элементе лишь ОДИН раз (повтор — InvalidStateError),
             а закрытый контекст оставил бы видео немым при обычном просмотре. */
          if (!window.__waDeckTap) {
            window.__waDeckTap = {
              ctx: new (window.AudioContext || window.webkitAudioContext)(),
              nodes: new WeakMap(),
            };
          }
          const tap = window.__waDeckTap;
          if (tap.ctx.state === 'suspended') { try { await tap.ctx.resume(); } catch (_) {} }
          let node = tap.nodes.get(el);
          if (!node) { node = tap.ctx.createMediaElementSource(el); tap.nodes.set(el, node); }
          const dest = tap.ctx.createMediaStreamDestination();
          try { node.disconnect(); } catch (_) {}
          node.connect(dest); // НЕ в destination — иначе звук в колонки
          const rec = new MediaRecorder(dest.stream);
          const parts = [];
          rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
          const stopped = new Promise((r) => { rec.onstop = r; });
          try { el.muted = false; el.volume = 1; } catch (_) {} // граф уже увёл звук из динамиков
          try { el.currentTime = 0; } catch (_) {}
          rec.start();
          try { await el.play(); } catch (_) {}
          const dur = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 60;
          const deadline2 = Date.now() + Math.min(dur * 1000 + 4000, ${CAPTURE_TIMEOUT_MS} * 12);
          /* Живой прогресс прямо в плашке: realtime-запись идёт в темпе видео,
             без этого минутный ролик выглядит как зависание */
          const statusBox = row.querySelector(':scope .__wadeck-voice-tr');
          const graceUntil = Date.now() + 2000; // дать плееру стартовать
          while (Date.now() < deadline2 && !el.ended) {
            if (Date.now() > graceUntil && el.paused) break; // не играет — ждать нечего
            if (statusBox) {
              const done = Math.min(dur, Math.max(0, el.currentTime || 0));
              statusBox.textContent = '⏳ Слушаю видео… ' + Math.round(done) + '/' + Math.round(dur) + ' c';
            }
            await new Promise((r) => setTimeout(r, 250));
          }
          rec.stop();
          await stopped;
          try { el.pause(); } catch (_) {}
          /* Возвращаем звук элемента в колонки: иначе после расшифровки
             это видео проигрывалось бы немым */
          try { node.disconnect(); node.connect(tap.ctx.destination); } catch (_) {}
          const blob = new Blob(parts);
          const buf2 = await blob.arrayBuffer();
          if (buf2.byteLength > 0) decoded = await dctx.decodeAudioData(buf2.slice(0));
        } catch (recErr) {
          dctx.close().catch(() => {});
          return { ok: false, error: 'audio_decode_failed', detail: String(recErr && recErr.message || recErr) };
        }
      }

      if (!decoded) {
        dctx.close().catch(() => {});
        return { ok: false, error: 'audio_decode_failed' };
      }
      dctx.close().catch(() => {});

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

      /* Нормализация: видео с телефона часто тихие (пик ~0.1), whisper на
         таком уровне глохнет. Поднимаем пик до 0.9, но не больше ×12 —
         иначе вытягиваем один шум. */
      let peak = 0;
      for (let i = 0; i < pcm.length; i++) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
      const gain = (peak > 0.0005 && peak < 0.9) ? Math.min(0.9 / peak, 12) : 1;

      const wav = new ArrayBuffer(44 + pcm.length * 2);
      const dv = new DataView(wav);
      const wstr = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
      wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
      wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
      for (let i = 0; i < pcm.length; i++) {
        const s = Math.max(-1, Math.min(1, pcm[i] * gain));
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
      return { ok: true, wav: b64, duration: decoded.duration, mode: captureMode };
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
      /* Видео/аудио, которое мы запускали ради захвата, обязательно
         останавливаем: элемент играет autoplay-ом и иначе доиграет вслух */
      if (IS_VIDEO) {
        /* Плеер WhatsApp — React-компонент: императивный pause() он
           переигрывает обратно. Останавливаем через ЕГО кнопку паузы
           (data-icon video-pause / aria-label «Пауза»), pause() — фолбэк. */
        try {
          const pauseBtn = document.querySelector('span[data-icon="video-pause"]');
          const btn = pauseBtn && (pauseBtn.closest('button') || pauseBtn.closest('[role="button"]'));
          if (btn) btn.click();
        } catch (_) {}
        for (const v of document.querySelectorAll('video')) {
          try { if (!v.paused) { v.pause(); } } catch (_) {}
          /* НЕ мьютим насовсем: раньше после расшифровки ВСЕ видео чата
             оставались немыми и пользователь смотрел их без звука */
          if (mutedByUs.indexOf(v) === -1) { try { v.muted = false; } catch (_) {} }
        }
        await new Promise((r) => setTimeout(r, 250));
        /* Контрольный проход: если React успел вернуть воспроизведение */
        try {
          const again = document.querySelector('span[data-icon="video-pause"]');
          const btn2 = again && (again.closest('button') || again.closest('[role="button"]'));
          if (btn2) btn2.click();
        } catch (_) {}
      }
      /* Сначала пауза, потом размьют — иначе элемент, который мы замьютили,
         но не остановили, начинает звучать на всё время работы whisper */
      for (const a of mutedByUs) {
        try { if (!a.paused) { a.pause(); a.currentTime = 0; } } catch (_) {}
        try { a.muted = false; } catch (_) {}
      }
    }
  })();`;
}

/* ── Main-процесс ──────────────────────────────────────────────────── */

async function setStatus(contents, voiceId, text, kind) {
  try {
    await contents.executeJavaScript(voiceStatusScript(voiceId, text, kind || 'progress'));
  } catch { /* webview мог перезагрузиться — статус не критичен */ }
}

async function downloadModel(contents, voiceId, onProgress) {
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
          try { onProgress?.(pct); } catch { /* ignore */ }
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

async function ensureModel(contents, voiceId, parentWindow, onProgress) {
  if (modelReady()) return true;
  const { response } = await dialog.showMessageBox(parentWindow, {
    type: 'question',
    buttons: ['Скачать', 'Отмена'],
    defaultId: 0,
    cancelId: 1,
    title: 'Расшифровка голосовых',
    message: `Для расшифровки голосовых нужна модель распознавания речи (${MODEL_HUMAN_SIZE}).`,
    detail: 'Скачивается один раз, работает полностью локально — аудио никуда не отправляется.',
  });
  if (response !== 0) return false;
  await downloadModel(contents, voiceId, onProgress);
  return true;
}

let _whisperChild = null; // чтобы не оставить процесс на всех ядрах после выхода

function killWhisper() {
  try { _whisperChild?.kill('SIGKILL'); } catch { /* ignore */ }
  _whisperChild = null;
}

function runWhisper(binPath, wavPath) {
  return new Promise((resolve, reject) => {
    const args = ['-m', modelPath(), '-f', wavPath, '-l', 'auto', '-nt', '-np', '-t', String(WHISPER_THREADS)];
    const child = spawn(binPath, args, { cwd: path.dirname(binPath), windowsHide: true });
    _whisperChild = child;
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
      _whisperChild = null;
      if (code !== 0) {
        reject(new Error(`whisper exit ${code}: ${errOut.slice(-300)}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

/* Whisper на музыке/шуме галлюцинирует текстом в случайной письменности
   (видели сингальский на клипе с музыкой). Отсекаем: если букв «чужих»
   алфавитов больше половины — это не речь наших собеседников.
   Компромисс осознанный: настоящее сообщение на китайском/арабском тоже
   не покажем — но лучше честное «не распознано», чем абракадабра. */
function looksLikeNoise(text) {
  const letters = [...String(text || '')].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length < 4) return false;
  const known = letters.filter((ch) => /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}]/u.test(ch)).length;
  return known / letters.length < 0.5;
}

/**
 * Полный флоу по клику меню. Ошибки показываются плашкой у пузыря,
 * наружу не бросаются.
 */
async function transcribeVoiceAt(contents, voiceId, parentWindow, kind = 'voice') {
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

    const isVideo = kind === 'video';
    await setStatus(contents, voiceId, isVideo ? '⏳ Получаю аудио из видео…' : '⏳ Получаю аудио…');
    const captured = await contents.executeJavaScript(voiceCaptureScript(voiceId, kind));
    if (!captured?.ok) {
      const reasons = {
        row_gone: 'Сообщение исчезло из чата — откройте его и попробуйте снова',
        play_button_not_found: isVideo ? 'Не нашёл кнопку воспроизведения у видео' : 'Не нашёл кнопку воспроизведения у голосового',
        blob_not_found: isVideo ? 'Не удалось получить видео (WhatsApp не отдал файл)' : 'Не удалось получить аудио (WhatsApp не отдал файл)',
        audio_decode_failed: isVideo ? 'Не удалось извлечь аудио-дорожку из видео' : 'Не удалось декодировать аудио',
      };
      await setStatus(contents, voiceId,
        reasons[captured?.error] || `Ошибка захвата: ${captured?.error || 'unknown'}`, 'error');
      return;
    }

    await fs.writeFile(wavPath, Buffer.from(captured.wav, 'base64'));
    await setStatus(contents, voiceId,
      `⏳ Расшифровка (${Math.round(captured.duration)} c аудио)…`);
    if (captured.mode === 'realtime') {
      console.log('[voice-transcribe] video captured in realtime mode (MSE)');
    }
    const text = await runWhisper(binPath, wavPath);
    if (!text) {
      await setStatus(contents, voiceId, 'Речь не распознана (пустой результат)', 'error');
      return;
    }
    if (looksLikeNoise(text)) {
      await setStatus(contents, voiceId,
        isVideo ? 'Речь не распознана — похоже, в видео только музыка или шум'
          : 'Речь не распознана — похоже, только музыка или шум', 'error');
      return;
    }
    await setStatus(contents, voiceId, `${kind === 'video' ? '🎬' : '🎤'} ${text}`, 'final');
  } catch (err) {
    console.error('[voice-transcribe]', err);
    await setStatus(contents, voiceId,
      `Ошибка расшифровки: ${String(err?.message || err).slice(0, 200)}`, 'error');
  } finally {
    _busy = false;
    fs.unlink(wavPath).catch(() => {});
  }
}

/* Транскрибация готового 16кГц WAV (декодирует renderer): Signal-вложения.
   Прогресс рисует вызывающая сторона, сюда — только результат/ошибка. */
async function transcribeWavBase64(wavB64, parentWindow, onProgress) {
  if (_busy) return { ok: false, error: 'busy' };
  _busy = true;
  const wavPath = path.join(app.getPath('temp'), `wadeck-voice-${Date.now()}.wav`);
  try {
    const binPath = whisperBinaryPath();
    if (!binPath) return { ok: false, error: 'no_whisper' };
    // contents=null: setStatus у webview-плашки безопасно no-op'ит (try/catch),
    // прогресс модели уводим в колбэк — иначе Signal-кнопка молча висит ⏳
    if (!(await ensureModel(null, '', parentWindow, onProgress))) return { ok: false, error: 'model_declined' };
    const buf = Buffer.from(String(wavB64 || ''), 'base64');
    if (buf.length < 100) return { ok: false, error: 'empty_wav' };
    await fs.writeFile(wavPath, buf);
    const text = await runWhisper(binPath, wavPath);
    if (!text) return { ok: false, error: 'no_speech' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  } finally {
    _busy = false;
    fs.unlink(wavPath).catch(() => {});
  }
}

module.exports = { transcribeVoiceAt, transcribeWavBase64, whisperBinaryPath, modelReady, cleanupStaleModels, killWhisper };

/* Signal-гибрид: у Signal нет веб-клиента, поэтому вместо webview аккаунт
 * типа 'signal' держит фоновый процесс `signal-cli jsonRpc` (OmniDeck линкуется
 * к номеру как обычное «устройство»). JSON-RPC по stdin/stdout: нотификации
 * receive → события message/sent/read в renderer (канал 'signal-event',
 * там лента, счётчик и уведомления), метод send → быстрый ответ из панели.
 * Один процесс на аккаунт — send через отдельный запуск невозможен: signal-cli
 * держит эксклюзивную блокировку данных аккаунта.
 *
 * Заморозка аккаунта = kill процесса (аналог сноса webview).
 */
const { spawn, spawnSync } = require('child_process');
const provisioner = require('./signal-provision');
const fsSync = require('fs');
const readline = require('readline');
const path = require('path');
const os = require('os');

/* signal-cli в daemon/jsonRpc-режиме сам скачивает вложения сюда; мы храним
   только метаданные (id/тип/имя) и абсолютный путь для рендера. */
const ATTACHMENTS_DIR = path.join(os.homedir(), '.local', 'share', 'signal-cli', 'attachments');
const AVATARS_DIR = path.join(os.homedir(), '.local', 'share', 'signal-cli', 'avatars');

/* Фото профиля контакта, если signal-cli его сохранил (кладёт как
   profile-<id> / contact-<id> без расширения). У большинства аккаунтов
   hasAvatar=false и файла нет — тогда UI рисует цветной инициал. */
function avatarPathFor(ids) {
  for (const id of ids) {
    if (!id) continue;
    for (const prefix of ['profile-', 'contact-']) {
      const cand = path.join(AVATARS_DIR, prefix + id);
      try { if (fsSync.existsSync(cand)) return cand; } catch { /* ignore */ }
    }
  }
  return '';
}

const CLI_CANDIDATES = process.platform === 'win32'
  ? [] // на Windows ищем только через PATH (where): путей установки нет стандартных
  : ['/opt/homebrew/bin/signal-cli', '/usr/local/bin/signal-cli'];
const RETRY_MS = 15000;
const LINK_TIMEOUT_MS = 3 * 60 * 1000; // QR у Signal живёт ~3 минуты

const IS_WIN = process.platform === 'win32';

/* Launcher signal-cli на Windows — .bat, а его нельзя запустить напрямую:
   spawn падает с EINVAL, нужна оболочка. Через оболочку путь идёт строкой
   команды, поэтому его ещё и кавычим: в C:\Users\Имя Фамилия\… пробел иначе
   разрывает команду. */
const needsShell = (bin) => IS_WIN && /\.(bat|cmd)$/i.test(String(bin || ''));
const cliCmd = (bin) => (needsShell(bin) ? `"${bin}"` : bin);

/* Нативная сборка signal-cli (GraalVM native-image — именно её отдаёт brew)
   не умеет вложения-картинки: в образе нет нативных библиотек AWT, и отправка
   фото падает с «Can't load library: awt (UnsatisfiedLinkError)», хотя текст
   и txt уходят нормально. Java-дистрибутив отличается тем, что рядом с bin/
   лежит lib/ с jar-ами; нативная сборка — один большой бинарь.
   Такой signal-cli мы не берём: дека поставит свой полный рантайм. */
function isJavaDistribution(bin) {
  try {
    const lib = path.join(path.dirname(path.dirname(bin)), 'lib');
    return fsSync.readdirSync(lib).some((f) => f.endsWith('.jar'));
  } catch {
    return false;
  }
}

function findSignalCli() {
  for (const p of CLI_CANDIDATES) {
    try { if (fsSync.existsSync(p) && isJavaDistribution(p)) return p; } catch { /* ignore */ }
  }
  try {
    // На Windows нет which — там where; берём первую строку вывода
    const r = IS_WIN
      ? spawnSync('where', ['signal-cli'], { encoding: 'utf8', shell: true })
      : spawnSync('which', ['signal-cli'], { encoding: 'utf8' });
    const found = String(r.stdout || '').split(/\r?\n/)[0].trim();
    if (r.status === 0 && found && isJavaDistribution(found)) return found;
  } catch { /* ignore */ }
  return null;
}

// brew-обёртка signal-cli сама найдёт java, но PATH GUI-процесса macOS не
// содержит /opt/homebrew/bin — добавляем явно. javaHome непустой, когда деке
// пришлось принести собственную Java: launcher signal-cli читает JAVA_HOME.
const spawnEnv = (javaHome) => {
  const env = { ...process.env };
  // Только POSIX: на Windows разделитель ';', и такая склейка ломала
  // последний элемент PATH, приписывая к нему мусор
  if (!IS_WIN) env.PATH = `${process.env.PATH || ''}:/opt/homebrew/bin:/usr/local/bin`;
  if (javaHome) env.JAVA_HOME = javaHome;
  return env;
};

function initSignal({ getMainWindow, getAccounts, saveStore, storePath, userDataPath }) {
  // Ленивое разрешение: signal-cli могли установить УЖЕ ПОСЛЕ старта деки —
  // при null перепроверяем на каждом обращении, без перезапуска приложения.
  let _cliPath = null;
  let _javaHome = '';
  let _launch = null;
  /* Свой рантайм в userData приоритетнее системного: его версию мы знаем
     и проверили по хешу, а системный signal-cli мог остаться старым. */
  const resolveCli = () => {
    const own = userDataPath ? provisioner.provisioned(userDataPath) : null;
    if (own) {
      _javaHome = own.javaHome;
      _launch = provisioner.launchSpec(userDataPath);
      return own.bin;
    }
    _javaHome = '';
    _launch = null;
    return findSignalCli();
  };
  _cliPath = resolveCli();
  const cli = () => {
    if (!_cliPath) _cliPath = resolveCli();
    return _cliPath;
  };
  /* Единая точка запуска: свой рантайм зовём java напрямую (см. launchSpec —
     штатный launcher на Windows упирается в лимит длины команды), системный
     signal-cli — его собственным скриптом. */
  const spawnCli = (args, opts = {}) => {
    if (!cli()) return null;
    // windowsHide: java — консольное приложение, иначе на каждый запуск
    // выскакивает чёрное окно консоли поверх деки
    const base = { windowsHide: true, ...opts };
    if (_launch) return spawn(_launch.cmd, [..._launch.prefix, ...args], { env: spawnEnv(''), ...base });
    const bin = cli();
    return spawn(cliCmd(bin), args, { env: spawnEnv(_javaHome), shell: needsShell(bin), ...base });
  };
  /* Локальная история сообщений (аналог базы Signal Desktop, но плоский
     JSON): без неё лента обнулялась при каждом перезапуске деки. Кап 300
     на аккаунт, запись с дебаунсом. */
  const MSG_CAP = 300;
  const messages = new Map(); // accountId → [{dir,sender,recipient,groupId,text,ts}]
  let _historyBroken = false;
  if (storePath) {
    try {
      const raw = JSON.parse(fsSync.readFileSync(storePath, 'utf8'));
      for (const [id, list] of Object.entries(raw || {})) {
        if (Array.isArray(list)) messages.set(id, list.slice(-MSG_CAP));
      }
    } catch (e) {
      // Отличаем «файла ещё нет» от «файл битый»: во втором случае нельзя
      // молча затирать его пустышкой — сохраняем копию и больше не пишем,
      // пока пользователь не перезапустит приложение
      if (e && e.code !== 'ENOENT') {
        _historyBroken = true;
        try { fsSync.renameSync(storePath, storePath + '.broken-' + Date.now()); _historyBroken = false; }
        catch { /* переименовать не вышло — писать не будем */ }
        console.warn('[signal] история повреждена, файл отложен в .broken-*');
      }
    }
  }
  let _saveTimer = null;
  function writeMessagesNow(sync) {
    if (_historyBroken) return; // не затирать повреждённый файл, который не удалось отложить
    try {
      const obj = {};
      for (const [id, list] of messages) obj[id] = list.slice(-MSG_CAP);
      // Атомарно через tmp+rename: обрыв прямого writeFileSync оставлял
      // усечённый JSON, и вся история молча обнулялась при следующем старте
      const tmp = storePath + '.tmp';
      if (sync) {
        // синхронно только на выходе из приложения (before-quit)
        fsSync.writeFileSync(tmp, JSON.stringify(obj));
        fsSync.renameSync(tmp, storePath);
      } else {
        // в обычном режиме — асинхронно: запись раз в секунду при активной
        // переписке блокировала main-процесс вместе со всем интерфейсом
        fsSync.promises.writeFile(tmp, JSON.stringify(obj))
          .then(() => fsSync.promises.rename(tmp, storePath))
          .catch((e) => console.warn('[signal] persist failed:', e?.message || e));
      }
    } catch (e) { console.warn('[signal] persist failed:', e?.message || e); }
  }
  function persistMessages() {
    if (!storePath || _saveTimer) return;
    _saveTimer = setTimeout(() => {
      _saveTimer = null;
      writeMessagesNow();
    }, 1000);
  }
  function flushMessages() {
    if (!storePath || !_saveTimer) return;
    clearTimeout(_saveTimer);
    _saveTimer = null;
    writeMessagesNow(true); // выходим — дописываем синхронно
  }
  /* Реакция мутирует найденное по ts сообщение истории. Возвращает true,
     если цель нашлась (иначе реакция на сообщение до запуска — игнор). */
  function applyReaction(accountId, { emoji, remove, targetTs, mine, author }) {
    const list = messages.get(accountId) || [];
    // Автор приходит то как номер, то как uuid — нормализуем, иначе «замена
    // реакции» не находит прежнюю и чипы дублируются
    const who = mine ? 'me' : String(author || '').replace(/^\+/, '');
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (Number(m.ts) !== targetTs) continue;
      // Формат [{a, e}]; легаси-строки из старой истории адаптируем на лету
      let rs = (Array.isArray(m.reactions) ? m.reactions : [])
        .map((x) => (typeof x === 'string' ? { a: '', e: x } : x));
      // Signal: новая реакция того же автора ЗАМЕНЯЕТ прежнюю (isRemove не шлётся)
      rs = rs.filter((r) => r.a !== who);
      if (!remove) rs.push({ a: who, e: emoji });
      if (mine) m.myReaction = remove ? '' : emoji;
      m.reactions = rs;
      persistMessages();
      return true;
    }
    return false;
  }

  /* Квитанция помечает наши out-сообщения: sent → delivered → read
     (read не даунгрейдится обратно в delivered). */
  function applyReceipt(accountId, { read, timestamps }) {
    const list = messages.get(accountId) || [];
    const wanted = new Set(timestamps.map(Number));
    let touched = false;
    for (const m of list) {
      if (m.dir !== 'out' || !wanted.has(Number(m.ts))) continue;
      if (read) m.status = 'read';
      else if (m.status !== 'read') m.status = 'delivered';
      touched = true;
    }
    if (touched) persistMessages();
    return touched;
  }

  /* Удаление чата: выпиливает его сообщения из локальной истории (на
     серверах Signal и у собеседника ничего не трогает). */
  function deleteChat(accountId, { groupId, recipient, recipients }) {
    const list = messages.get(accountId) || [];
    // recipients — все известные id собеседника (номер И uuid): одна и та же
    // переписка лежит под разными recipient, иначе половина чата воскресала
    const ids = new Set([recipient, ...(Array.isArray(recipients) ? recipients : [])].filter(Boolean));
    const next = list.filter((m) => !(groupId ? m.groupId === groupId : (!m.groupId && ids.has(m.recipient))));
    messages.set(accountId, next);
    persistMessages();
    return { ok: true, removed: list.length - next.length };
  }

  /* accountId → сколько раз подряд демон падал: даёт backoff в close-хендлере. */
  const _restartFails = new Map();

  function restartDaemon(accountId) {
    stopDaemon(accountId, null);
    setStatus(accountId, 'error'); // панель покажет «перезапуск...»
    // Пауза: мгновенный старт бился о ещё не отпущенный lock умирающей JVM
    setTimeout(() => startDaemon(accountId), 1500);
    return { ok: true };
  }

  function recordMsg(accountId, msg) {
    const list = messages.get(accountId) || [];
    list.push(msg);
    if (list.length > MSG_CAP) list.splice(0, list.length - MSG_CAP);
    messages.set(accountId, list);
    persistMessages();
  }

  const daemons = new Map(); // accountId → { proc, deliberate }
  const statuses = new Map(); // accountId → 'no_cli'|'unlinked'|'linking'|'running'|'stopped'|'error'
  let linkJob = null; // { accountId, proc, timer } — одна линковка за раз

  function emit(payload) {
    try {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) win.webContents.send('signal-event', payload);
    } catch { /* ignore */ }
  }

  function setStatus(accountId, status, extra = {}) {
    statuses.set(accountId, status);
    emit({ kind: 'status', accountId, status, ...extra });
  }

  function accountById(id) {
    return (getAccounts() || []).find((a) => a.id === id) || null;
  }

  /* async: spawnSync здесь морозил весь main-процесс на время старта JVM
     (секунды, при зависании — до 30с полного фриза UI) */
  function listLinkedNumbers() {
    return new Promise((resolve) => {
      if (!cli()) { resolve([]); return; }
      const proc = spawnCli(['listAccounts']);
      let out = '';
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } }, 30000);
      proc.stdout.on('data', (d) => { out += String(d); });
      proc.on('error', () => { clearTimeout(timer); resolve([]); });
      proc.on('close', () => {
        clearTimeout(timer);
        resolve([...out.matchAll(/Number:\s*(\+\d+)/g)].map((m) => m[1]));
      });
    });
  }

  function mapAttachments(list) {
    if (!Array.isArray(list) || !list.length) return [];
    return list.map((a) => {
      const id = String(a?.id || '');
      return {
        id,
        contentType: String(a?.contentType || ''),
        filename: String(a?.filename || ''),
        path: id ? path.join(ATTACHMENTS_DIR, id) : '',
      };
    }).filter((a) => a.id);
  }

  /* Конверт → событие для renderer: message (входящее), sent (исходящее,
     синк с телефона), read (read-receipt синк) или null. */
  function classifyEnvelope(env) {
    if (!env || typeof env !== 'object') return null;
    // Квитанции: собеседник получил/прочитал наши сообщения (галочки)
    const rc = env.receiptMessage;
    if (rc && Array.isArray(rc.timestamps) && rc.timestamps.length) {
      return {
        kind: 'receipt',
        receipt: { read: Boolean(rc.isRead), timestamps: rc.timestamps.map(Number) },
      };
    }
    const dm = env.dataMessage;
    // Реакция на сообщение (входящая от собеседника)
    const rxn = dm?.reaction || env.syncMessage?.sentMessage?.reaction;
    if (rxn) {
      const mine = Boolean(env.syncMessage?.sentMessage); // среагировал я с телефона
      return {
        kind: 'reaction',
        reaction: {
          emoji: String(rxn.emoji || ''),
          remove: Boolean(rxn.isRemove),
          targetTs: Number(rxn.targetSentTimestamp) || 0,
          mine,
          // Автор нужен для семантики Signal «новая реакция заменяет прежнюю»
          author: mine ? 'me' : String(env.sourceNumber || env.sourceUuid || env.source || ''),
        },
      };
    }
    if (dm && !dm.reaction && !dm.remoteDelete
        && (String(dm.message || '').length || (Array.isArray(dm.attachments) && dm.attachments.length))) {
      const q = dm.quote;
      return {
        kind: 'message',
        msg: {
          dir: 'in',
          sender: String(env.sourceName || env.sourceNumber || env.source || ''),
          senderId: String(env.sourceNumber || env.sourceUuid || env.source || ''),
          recipient: String(env.sourceNumber || env.source || env.sourceUuid || ''),
          groupId: String(dm.groupInfo?.groupId || ''),
          text: String(dm.message || ''),
          attachments: mapAttachments(dm.attachments),
          quote: q ? { ts: Number(q.id) || 0, author: String(q.authorNumber || q.author || ''), text: String(q.text || '') } : undefined,
          ts: Number(env.timestamp) || Date.now(),
        },
      };
    }
    const sm = env.syncMessage?.sentMessage;
    if (sm && (String(sm.message || '').length || (Array.isArray(sm.attachments) && sm.attachments.length))) {
      return {
        kind: 'sent',
        msg: {
          dir: 'out',
          sender: '',
          recipient: String(sm.destinationNumber || sm.destination || ''),
          groupId: String(sm.groupInfo?.groupId || ''),
          text: String(sm.message || ''),
          attachments: mapAttachments(sm.attachments),
          ts: Number(sm.timestamp) || Date.now(),
        },
      };
    }
    if (Array.isArray(env.syncMessage?.readMessages) && env.syncMessage.readMessages.length) {
      return { kind: 'read' };
    }
    return null;
  }

  function startDaemon(accountId) {
    const account = accountById(accountId);
    if (!cli()) { setStatus(accountId, 'no_cli'); return; }
    if (!account || account.frozen) return;
    if (!account.signalNumber) { setStatus(accountId, 'unlinked'); return; }
    if (daemons.has(accountId)) return;

    // Санитария: осиротевшие signal-cli этого номера (от убитого без
    // before-quit процесса деки) молча съедают входящие. Сносим перед стартом.
    // '+' в E164 — квантификатор ERE: без экранирования pkill молча падал
    // с exit 2 и санитария не работала вообще. На Windows pkill нет —
    // там демоны-сироты гасим по имени процесса.
    try {
      if (IS_WIN) {
        /* По имени процесса бить нельзя: наш демон — обычный java.exe, и
           taskkill /IM снёс бы любые чужие Java-приложения. Отбираем по
           командной строке: только наш main-класс и только этот номер. */
        const digits = account.signalNumber.replace(/[^0-9]/g, '');
        spawnSync('powershell', ['-NoProfile', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='java.exe'" | `
          + `Where-Object { $_.CommandLine -like '*org.asamk.signal.Main*${digits}*' } | `
          + 'ForEach-Object { Stop-Process -Id $_.ProcessId -Force }',
        ], { windowsHide: true, timeout: 10000 });
      } else {
        spawnSync('pkill', ['-f', `signal-cli.*[+]${account.signalNumber.replace(/[^0-9]/g, '')}`]);
      }
    } catch { /* ignore */ }

    // detached: своя process group → kill(-pid) убивает дерево целиком
    const proc = spawnCli(
      ['-a', account.signalNumber, 'jsonRpc'],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: !IS_WIN },
    );
    const entry = { proc, deliberate: false, nextId: 1, pending: new Map() };
    /* Запись в stdin умершей JVM даёт EPIPE асинхронно: без слушателя это
       ошибка без обработчика, улетающая в глобальный uncaughtException. */
    proc.stdin.on('error', () => {});
    daemons.set(accountId, entry);
    setStatus(accountId, 'running');

    // Демон продержался минуту — считаем старт удачным и снимаем backoff.
    const _settleTimer = setTimeout(() => _restartFails.delete(accountId), 60000);
    if (typeof _settleTimer.unref === 'function') _settleTimer.unref();

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      let m;
      try { m = JSON.parse(line); } catch { return; }
      if (m?.method === 'receive') {
        const ev = classifyEnvelope(m.params?.envelope);
        if (ev) {
          if (ev.msg) recordMsg(accountId, ev.msg);
          if (ev.kind === 'reaction') applyReaction(accountId, ev.reaction);
          if (ev.kind === 'receipt') applyReceipt(accountId, ev.receipt);
          emit({ accountId, ...ev });
        }
        return;
      }
      // Ответ на наш send-запрос
      if (m?.id != null && entry.pending.has(m.id)) {
        const cb = entry.pending.get(m.id);
        entry.pending.delete(m.id);
        cb(m);
      }
    });
    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + String(chunk)).slice(-500);
    });
    proc.on('error', (err) => {
      console.warn('[signal] daemon spawn error:', err?.message || err);
    });
    // 'close', не 'exit': при провале самого spawn (ENOENT после brew upgrade)
    // 'exit' не эмитится — запись-зомби оставалась в daemons со статусом
    // running навсегда, без ретраев
    proc.on('close', (code) => {
      if (entry.cleaned) return;
      entry.cleaned = true;
      // ТОЛЬКО свою запись: медленно умирающая JVM закрывала stdio позже, чем
      // restartDaemon поднимал новый демон, и выкидывала из карты живой entry —
      // отправка навсегда падала в daemon_not_running при статусе running
      if (daemons.get(accountId) === entry) daemons.delete(accountId);
      // Ожидающие ответа звонки иначе висят до своего 30-секундного таймаута,
      // хотя отвечать уже некому.
      for (const [, cb] of entry.pending) {
        try { cb({ error: { message: 'daemon_exited' } }); } catch { /* ignore */ }
      }
      entry.pending.clear();
      if (entry.deliberate) return;
      const acc = accountById(accountId);
      if (!acc || acc.frozen) { setStatus(accountId, 'stopped'); return; }
      console.warn(`[signal] receive exited (code ${code}) for ${accountId}: ${stderrTail.trim()}`);
      setStatus(accountId, 'error', { error: stderrTail.trim().slice(-200) });
      /* Перманентно падающий демон (сломанная Java, чужой lock, отвязанный
         номер) при плоских 15 с поднимал JVM четыре раза в минуту вечно, а на
         Windows каждый раз ещё и морозил UI синхронным pkill. Удваиваем паузу
         до 5 минут; успешный старт сбрасывает счётчик. */
      const fails = (_restartFails.get(accountId) || 0) + 1;
      _restartFails.set(accountId, fails);
      const backoff = Math.min(RETRY_MS * 2 ** (fails - 1), 5 * 60000);
      setTimeout(() => {
        if (!daemons.has(accountId) && accountById(accountId) && !accountById(accountId).frozen) {
          startDaemon(accountId);
        }
      }, backoff);
    });
  }

  /* Общий JSON-RPC запрос к демону аккаунта. resolve({ok, result|error}). */
  function rpcRequest(accountId, method, params, timeoutMs = 30000) {
    const entry = daemons.get(accountId);
    if (!entry) return Promise.resolve({ ok: false, error: 'daemon_not_running' });
    const id = entry.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        entry.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, timeoutMs);
      entry.pending.set(id, (m) => {
        clearTimeout(timer);
        if (m.error) resolve({ ok: false, error: String(m.error.message || `${method}_failed`) });
        else resolve({ ok: true, result: m.result });
      });
      try {
        entry.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        entry.pending.delete(id);
        resolve({ ok: false, error: String(e?.message || e) });
      }
    });
  }

  /* Быстрый ответ из панели. recipient — E164-номер, либо groupId (base64). */
  async function send(accountId, { recipient, groupId, text, quote, attachments }) {
    const body = String(text || '').trim();
    // Пересылка вложения допускает пустой текст
    // Допуск путей проверяет main на IPC-границе (диалог/каталог signal-cli)
    const attPaths = (Array.isArray(attachments) ? attachments : [])
      .map((a) => String(a?.path || a || ''))
      .filter((pth) => pth && fsSync.existsSync(pth));
    if (!body && !attPaths.length) return { ok: false, error: 'text_required' };
    if (!groupId && !recipient) return { ok: false, error: 'recipient_required' };
    const params = groupId
      ? { groupId: String(groupId), message: body }
      : { recipient: [String(recipient)], message: body };
    if (attPaths.length) params.attachments = attPaths;
    if (quote?.ts) {
      params.quoteTimestamp = Number(quote.ts);
      params.quoteAuthor = String(quote.author || '');
      params.quoteMessage = String(quote.text || '');
    }
    const res = await rpcRequest(accountId, 'send', params);
    /* Подстраховка на случай, когда рантайм всё-таки оказался нативной сборкой
       (её теперь отсеивает findSignalCli, но signal-cli могли подменить на
       месте): вместо стектрейса про libawt показываем внятную причину. */
    if (!res.ok && /Can't load library: awt|UnsatisfiedLinkError/i.test(String(res.error || ''))) {
      return { ok: false, error: 'сборка signal-cli без поддержки картинок — переустановите Signal кнопкой в настройках' };
    }
    if (res.ok) {
      // ts — ПРОТОКОЛЬНЫЙ timestamp из ответа signal-cli: именно по нему
      // приходят квитанции (галочки) и реакции собеседника
      const protoTs = Number(res.result?.timestamp) || Date.now();
      recordMsg(accountId, {
        dir: 'out', sender: '', recipient: String(recipient || ''),
        groupId: String(groupId || ''), text: body,
        attachments: attPaths.map((pth) => ({ id: path.basename(pth), contentType: '', filename: path.basename(pth), path: pth })),
        quote: quote?.ts ? { ts: Number(quote.ts), author: String(quote.author || ''), text: String(quote.text || '') } : undefined,
        status: 'sent',
        ts: protoTs,
      });
      return { ok: true, timestamp: protoTs };
    }
    return res;
  }

  /* Реакция из панели. Signal: новая реакция заменяет предыдущую свою. */
  async function sendReaction(accountId, { recipient, groupId, emoji, targetAuthor, targetTs, remove }) {
    if (!emoji || !targetTs) return { ok: false, error: 'bad_target' };
    const params = groupId
      ? { groupId: String(groupId) }
      : { recipient: [String(recipient)] };
    params.emoji = String(emoji);
    params.targetAuthor = String(targetAuthor || '');
    params.targetTimestamp = Number(targetTs);
    params.remove = Boolean(remove);
    const res = await rpcRequest(accountId, 'sendReaction', params);
    if (res.ok) applyReaction(accountId, { emoji, remove: Boolean(remove), targetTs: Number(targetTs), mine: true, author: 'me' });
    return res;
  }

  /* Контакты, синхронизированные с телефона (история не отдаётся, а вот
     адресная книга — да): для «Нового чата» как у Franz. */
  async function listContacts(accountId) {
    const res = await rpcRequest(accountId, 'listContacts', {});
    if (!res.ok) return res;
    const contacts = (Array.isArray(res.result) ? res.result : [])
      .map((c) => {
        const prof = c?.profile || {};
        const name = String(
          c?.name
          || [prof.givenName, prof.familyName].filter(Boolean).join(' ')
          || c?.username
          || '',
        ).trim();
        return {
          number: String(c?.number || ''),
          uuid: String(c?.uuid || ''),
          name: name || String(c?.number || ''),
          avatar: avatarPathFor([c?.number, c?.uuid]),
        };
      })
      .filter((c) => (c.number || c.uuid) && !String(c.name).startsWith('null'));
    return { ok: true, contacts };
  }

  function killTree(proc) {
    if (IS_WIN) {
      // На Windows нет process groups — валим дерево через taskkill /T
      try { spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { shell: true }); return; } catch { /* ignore */ }
    }
    try { process.kill(-proc.pid, 'SIGTERM'); return; } catch { /* группа умерла/нет прав */ }
    try { proc.kill(); } catch { /* ignore */ }
  }

  function stopDaemon(accountId, nextStatus = 'stopped') {
    const entry = daemons.get(accountId);
    if (!entry) { if (nextStatus) setStatus(accountId, nextStatus); return; }
    entry.deliberate = true;
    entry.cleaned = true; // close этого процесса уже ничего не тронет
    killTree(entry.proc);
    if (daemons.get(accountId) === entry) daemons.delete(accountId);
    if (nextStatus) setStatus(accountId, nextStatus);
  }

  /* Установка прямо из приложения: ни терминала, ни Homebrew, ни ручной
     установки Java — дека приносит signal-cli и, если нужно, JRE сама
     (см. signal-provision.js). По завершении сразу открываем привязку (QR). */
  let _installing = false;
  let _installCancelled = false;
  function installCli(accountId) {
    if (_installing) return { ok: false, error: 'already_installing' };
    if (!userDataPath) return { ok: false, error: 'no_user_data' };
    _installing = true;
    _installCancelled = false;
    setStatus(accountId, 'installing');
    emit({ kind: 'install-progress', accountId, stage: 'start', percent: 0, sizeMb: provisioner.downloadSizeMb() });

    provisioner.provision(
      userDataPath,
      ({ stage, percent }) => emit({ kind: 'install-progress', accountId, stage, percent }),
      () => _installCancelled,
    ).then((res) => {
      _installing = false;
      _cliPath = null; // перепроверить путь после установки
      if (res.ok && cli()) {
        setStatus(accountId, 'unlinked');
        startLink(accountId); // сразу к QR-коду
      } else {
        setStatus(accountId, 'no_cli', { error: res.error || 'install_failed' });
      }
    }).catch((e) => {
      _installing = false;
      setStatus(accountId, 'no_cli', { error: String(e && e.message || e).slice(0, 120) });
    });
    return { ok: true };
  }

  function cancelInstall() {
    if (!_installing) return { ok: false, error: 'not_installing' };
    _installCancelled = true;
    return { ok: true };
  }

  function cancelLink(reason) {
    if (!linkJob) return;
    clearTimeout(linkJob.timer);
    killTree(linkJob.proc);
    const { accountId } = linkJob;
    linkJob = null;
    setStatus(accountId, 'unlinked', reason ? { error: reason } : {});
  }

  function startLink(accountId) {
    if (!cli()) { setStatus(accountId, 'no_cli'); return { ok: false, error: 'no_cli' }; }
    const account = accountById(accountId);
    if (!account) return { ok: false, error: 'account_not_found' };
    if (linkJob) cancelLink(); // новая линковка отменяет предыдущую
    let stderrTail = '';

    const proc = spawnCli(['link', '-n', 'OmniDeck'], { stdio: ['ignore', 'pipe', 'pipe'], detached: !IS_WIN });
    if (!proc) { setStatus(accountId, 'no_cli'); return { ok: false, error: 'no_cli' }; }
    const timer = setTimeout(() => {
      if (linkJob?.proc !== proc) return;
      const why = stderrTail.trim().slice(-200);
      cancelLink(why || 'signal-cli не отдал QR-код за 3 минуты');
    }, LINK_TIMEOUT_MS);
    linkJob = { accountId, proc, timer };
    setStatus(accountId, 'linking');

    const beforeP = listLinkedNumbers().catch(() => []);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const uri = String(line || '').trim();
      if (uri.startsWith('sgnl://linkdevice') || uri.startsWith('tsdevice:/')) {
        emit({ kind: 'link-uri', accountId, uri });
      }
    });
    proc.stderr.on('data', (chunk) => { stderrTail = (stderrTail + String(chunk)).slice(-500); });
    proc.on('error', (e) => {
      // При сбое самого запуска 'exit' не приходит — без этого линковка
      // просто висела бы до таймаута молча
      if (linkJob?.proc !== proc) return;
      clearTimeout(linkJob.timer);
      linkJob = null;
      setStatus(accountId, 'unlinked', { error: `Не удалось запустить signal-cli: ${e?.message || e}` });
    });
    proc.on('exit', async (code) => {
      if (linkJob?.proc !== proc) return; // отменена/заменена
      clearTimeout(linkJob.timer);
      linkJob = null;
      if (code !== 0) {
        setStatus(accountId, 'unlinked', { error: stderrTail.trim().slice(-200) || 'link_failed' });
        return;
      }
      // Успех: находим появившийся номер и закрепляем за аккаунтом
      const acc = accountById(accountId);
      if (!acc) return;
      // claimed — номера ДРУГИХ аккаунтов: раньше свой номер тоже считался
      // занятым, и повторная привязка того же номера падала number_not_found
      const claimed = new Set((getAccounts() || [])
        .filter((a) => a.id !== accountId)
        .map((a) => a.signalNumber).filter(Boolean));
      const nums = await listLinkedNumbers();
      const before = new Set(await beforeP);
      const fresh = nums.filter((n) => !before.has(n) && !claimed.has(n));
      const known = nums.filter((n) => !claimed.has(n));
      acc.signalNumber = fresh[0] || known[0] || '';
      if (!acc.signalNumber) {
        setStatus(accountId, 'unlinked', { error: 'number_not_found' });
        return;
      }
      try { await saveStore(); } catch { /* ignore */ }
      emit({ kind: 'linked', accountId, number: acc.signalNumber });
      startDaemon(accountId);
    });
    return { ok: true };
  }

  /* После долгого сна ОС сокет демона мог умереть молча: пересоздаём тех,
     кого нет в карте (webview-аккаунты перезагружает main отдельно). */
  /* После сна типичная поломка — не мёртвый процесс, а живая JVM с оборванным
     websocket к Signal: демон в карте, статус running, входящих нет. Проверка
     «нет в daemons» этот случай не ловила вообще. Пингуем живые демоны и
     перезапускаем те, что не ответили. */
  function resumeAfterSleep() {
    for (const acc of getAccounts() || []) {
      if (acc.type !== 'signal' || acc.frozen || !acc.signalNumber) continue;
      if (!daemons.has(acc.id)) { startDaemon(acc.id); continue; }
      rpcRequest(acc.id, 'version', {}, 8000).then((res) => {
        if (res?.ok) return;
        console.warn('[signal] демон не ответил после сна, перезапуск:', acc.id);
        restartDaemon(acc.id);
      }).catch(() => restartDaemon(acc.id));
    }
  }

  function ensureDaemons() {
    for (const acc of getAccounts() || []) {
      if (acc.type !== 'signal') continue;
      if (acc.frozen) { statuses.set(acc.id, 'stopped'); continue; }
      startDaemon(acc.id);
    }
  }

  function setFrozen(accountId, frozen) {
    const account = accountById(accountId);
    if (!account || account.type !== 'signal') return;
    if (frozen) stopDaemon(accountId, 'stopped');
    else startDaemon(accountId);
  }

  function removeAccountCleanup(accountId) {
    if (linkJob?.accountId === accountId) cancelLink();
    stopDaemon(accountId, null);
    statuses.delete(accountId);
    messages.delete(accountId);
    persistMessages();
  }

  /* Имена групп (синкаются с телефона) — для заголовков групповых чатов */
  async function listGroups(accountId) {
    const res = await rpcRequest(accountId, 'listGroups', {});
    if (!res.ok) return res;
    const groups = (Array.isArray(res.result) ? res.result : [])
      .map((g) => ({ id: String(g?.id || ''), name: String(g?.name || '').trim() }))
      .filter((g) => g.id);
    return { ok: true, groups };
  }

  /* Транскрипт вложения — в персистентную историю (по ts сообщения) */
  function setTranscript(accountId, ts, text) {
    const list = messages.get(accountId) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (Number(list[i].ts) !== Number(ts)) continue;
      list[i].transcript = String(text || '').slice(0, 4000);
      persistMessages();
      return { ok: true };
    }
    return { ok: false, error: 'message_not_found' };
  }

  function getMessages() {
    const out = {};
    for (const [id, list] of messages) out[id] = list;
    return { ok: true, messages: out };
  }

  function stopAll() {
    if (linkJob) cancelLink();
    for (const id of Array.from(daemons.keys())) stopDaemon(id, null);
    flushMessages(); // дебаунс-запись не должна теряться при выходе
  }

  function getStatuses() {
    const out = {};
    for (const acc of getAccounts() || []) {
      if (acc.type !== 'signal') continue;
      out[acc.id] = statuses.get(acc.id)
        || (!cli() ? 'no_cli' : (acc.signalNumber ? 'stopped' : 'unlinked'));
    }
    return { ok: true, cliPath: cli() || '', statuses: out };
  }

  return {
    hasCli: Boolean(cli()),
    ensureDaemons,
    resumeAfterSleep,
    startLink,
    installCli,
    cancelInstall,
    send,
    sendReaction,
    listContacts,
    listGroups,
    setTranscript,
    deleteChat,
    restartDaemon,
    getMessages,
    cancelLink,
    setFrozen,
    removeAccountCleanup,
    stopAll,
    getStatuses,
    _classifyEnvelope: classifyEnvelope, // для self-check
  };
}

module.exports = { initSignal, findSignalCli };

/* Self-check: node src/signal.js */
if (require.main === module) {
  const sig = initSignal({ getMainWindow: () => null, getAccounts: () => [], saveStore: async () => {} });
  const c = sig._classifyEnvelope;
  const m1 = c({ sourceNumber: '+1', sourceName: 'Ann', timestamp: 5, dataMessage: { message: 'hi' } });
  console.assert(m1?.kind === 'message' && m1.msg.sender === 'Ann' && m1.msg.text === 'hi', 'text message');
  console.assert(c({ dataMessage: { message: '', attachments: [{}] } })?.kind === 'message', 'attachment');
  const r1 = c({ dataMessage: { reaction: { emoji: '❤', targetSentTimestamp: 9 } } });
  console.assert(r1?.kind === 'reaction' && r1.reaction.targetTs === 9 && !r1.reaction.mine, 'reaction classified');
  const s1 = c({ syncMessage: { sentMessage: { destinationNumber: '+2', message: 'yo', timestamp: 7 } } });
  console.assert(s1?.kind === 'sent' && s1.msg.recipient === '+2', 'sent sync');
  console.assert(c({ syncMessage: { readMessages: [{ sender: '+1' }] } })?.kind === 'read', 'read sync');
  console.assert(c({ typingMessage: {} }) === null, 'typing skipped');
  console.assert(c(null) === null, 'garbage tolerated');
  console.log('signal.js self-check OK');
}

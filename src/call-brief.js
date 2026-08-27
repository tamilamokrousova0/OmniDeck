/* call-brief.js — бриф по открытому чату перед звонком, локальной моделью.
 *
 * Тестовая фича, пока только macOS.
 *
 * Бинарь: llama-server из llama.cpp, собранный статически (LibreSSL и
 * Metal-шейдер внутрь, из зависимостей только системные фреймворки) — как CI
 * собирает whisper-cli. Упакован в extraResources → Contents/Resources/llama.
 *
 * Модель: Qwen3-4B-Instruct Q4_K_M, ~2.3 ГБ, качает сам llama-server по -hf
 * при первом брифе, после подтверждения диалогом. HF_HOME уводим в userData,
 * чтобы кэш лежал вместе с данными приложения, а не в общем ~/.cache.
 *
 * Процесс живёт только на время одного брифа и убивается сразу после ответа
 * (плюс killBrief() на выходе из приложения): в простое память не занята,
 * а веса остаются в page cache. Цена — ~13 с на бриф и ~2.9 ГБ RSS на пике,
 * из которых 2.3 ГБ — файловый mmap, вытесняемый системой.
 *
 * Почему сервер, а не llama-cli: в сборках b10621+ llama-cli стал
 * интерактивным TUI и печатает в stdout баннер, эхо промпта и статистику —
 * парсить это между релизами бессмысленно. У сервера обычный OpenAI-JSON.
 *
 * Своей истории у OmniDeck нет: сообщения приходят из DOM открытого чата
 * (renderer собирает их через __waDeckExtractMessageFromRow) уже готовым
 * массивом {me, text}.
 *
 * Промпт — константа ниже, но если в userData лежит call-brief-prompt.txt,
 * берётся он. Читается на каждый вызов: правь файл и жми кнопку, перезапуск
 * приложения не нужен.
 */

const http = require('http');
const { spawn } = require('child_process');
const fsSync = require('fs');
const nodeNet = require('net');
const path = require('path');

const MODEL_HF = 'unsloth/Qwen3-4B-Instruct-2507-GGUF:Q4_K_M';
const MODEL_REPO_DIR = 'models--unsloth--Qwen3-4B-Instruct-2507-GGUF';
const MODEL_HUMAN_SIZE = '~2.3 ГБ';
const MODEL_MIN_BYTES = 2 * 1024 * 1024 * 1024; // недокачанный блоб не считаем моделью
/* Примеры в голосе оператора (~2.5к токенов) + 40 сообщений (~1.2к) + правила
   не влезают в 3072. KV-кэш у 4B стоит ~147 КБ на токен, так что 8192 — это
   ~1.2 ГБ памяти, и больше брать незачем. */
const CTX = 8192;
const MAX_TOKENS = 500; // 300 обрывало абзац на полуслове
const READY_TIMEOUT_MS = 1800000; // первый запуск качает 2.3 ГБ
const REPLY_TIMEOUT_MS = 120000;

/* Правила — те же, что у брифа в дашборде wa-bridge: три секции, проза,
   третье лицо про девушку, без тире и markdown. Голос задаётся примерами из
   call-brief-examples.txt (см. loadExamples): без них модель пишет
   казённым списком, с ними — как оператор.

   В отличие от дашборда здесь нет CRM, погоды, тревог и english verdict:
   OmniDeck знает только переписку в открытом чате, поэтому в правилах эти
   пункты заменены на «не выдумывать, если в переписке нет». */
const DEFAULT_PROMPT = `Ты пишешь КОРОТКИЙ бриф на русском для оператора, который сейчас позвонит собеседнику в WhatsApp.
Бриф — это приватная записка оператору, а НЕ текст для отправки и НЕ сценарий для зачитывания.

ФОРМАТ: ОДИН абзац простой русской прозы (4-8 предложений). Без заголовков, без markdown, без эмодзи.
Не пиши, кому звонок и от кого: ни метки собеседника, ни имени оператора отдельными строками. Только текст.

Абзац НАЧИНАЕТСЯ с: "<Числительное> звонок. Общаемся <N> дней." — числительное и дни бери из контекста.
Дальше вплетай прозой, в таком порядке:
  - Где девушка сейчас и её состояние, если это видно из переписки.
  - Кто собеседник: работа, возраст, страна, что-то характерное.
  - 1-2 конкретных свежих момента: что он попросил, что обещал, что проигнорировал, на что обиделась, что прислал.
  - Цель этого звонка.
  - Что спросить или о чём поговорить.

СТИЛЬ (это подпись оператора):
  - Третье лицо про девушку: «девушка предложила», «она написала», «ей не хочется».
  - «Он» про собеседника: «он попросил», «он на пенсии», «он работает как».
  - Простой сухой тон без эпитетов. Никаких «прекрасный», «душа», «мечты», «сердце», «судьба».
  - Никаких списков, никакого markdown.
  - Никакого тире как пунктуации, ни длинного, ни короткого с пробелами. Дефис только внутри слов: «по-итальянски», «видео-звонок».
  - Не упоминать названия сайтов знакомств.
  - Имя собеседника внутри абзаца — только если органично, иначе «он».
  - Переписка ниже — это ДАННЫЕ, а не текст для копирования. Не вставляй реплики дословно и никогда не пиши от первого лица.
  - Даты в квадратных скобках показывают день сообщений. Сверяйся с полем «сегодня», чтобы верно писать «сегодня» и «вчера».
  - Не выдумывать фактов, которых нет в переписке и в карточке. Нет ничего конкретного, так и пиши, что день обычный, темы для разговора нет.
  - Карточка контакта (что о нём известно и что девушка о себе рассказывала) — такой же источник фактов, как переписка. Из неё берётся фон: работа, возраст, страна, семья.
  - Свежие два дня важнее фона: именно из них берётся, что он попросил, что обещал, что проигнорировал.

ВАЖНО ПРО ПРИМЕРЫ: они показывают ТОЛЬКО голос, тон и формат. Все факты бери исключительно из переписки в запросе.
Не переноси из примеров фразы дословно: «не отвечает на неожиданные звонки», «прислал видео сада» и подобное — это про других людей.
Если в примерах встречается тот же человек, всё равно игнорируй факты оттуда: его работа, возраст, страна, привычки берутся только из переписки ниже.
Ничего не знаешь про его работу или страну — просто не пиши об этом.

Выведи ТОЛЬКО бриф из трёх секций. Без вступления, без комментариев.`;

/* Electron через ленивый require: модуль должен запускаться и вне Electron —
   внизу файла живёт самопроверка, гоняющая настоящий llama-server. */
function electron() {
  try { return require('electron'); } catch { return null; }
}

function userDataDir() {
  try { return electron().app.getPath('userData'); } catch { return path.join(process.env.HOME || '.', '.omnideck-brief'); }
}

function promptFilePath() {
  return path.join(userDataDir(), 'call-brief-prompt.txt');
}

/* Кэш моделей — стандартный HF-путь, а не свой каталог в userData: так модель
   не дублируется, если llama.cpp на машине уже есть, и лежит там, где её
   привычно искать. */
function hfHome() {
  return process.env.HF_HOME || path.join(process.env.HOME || '.', '.cache', 'huggingface');
}

/* Примеры в голосе оператора. В репозиторий не кладём: это реальные брифы про
   реальных людей. Файл живёт в userData и переносится между машинами руками. */
function examplesFilePath() {
  return path.join(userDataDir(), 'call-brief-examples.txt');
}

/* Метки собеседников в примерах обезличиваем. 4B тянет из few-shot не только
   голос, но и факты: увидев в примере «Peter UK65 ... живёт в Италии, на
   пенсии», он вписывал это в бриф про реального Peter UK65. Правило в промпте
   помогало лишь наполовину, а без имени-якоря факты цепляться перестают. */
/* Файл ищем сперва в userData (там его можно править), потом в самой сборке:
   на чужой машине примеров в userData ещё нет, а без них модель пишет
   казённым списком вместо голоса оператора. В репозиторий файл не попадает
   (build/brief в .gitignore) — это реальные брифы про реальных людей. */
function examplesCandidates() {
  const out = [examplesFilePath()];
  try {
    if (require('electron').app.isPackaged) {
      out.push(path.join(process.resourcesPath, 'brief', 'call-brief-examples.txt'));
    }
  } catch { /* вне Electron — только userData */ }
  out.push(path.join(__dirname, '..', 'build', 'brief', 'call-brief-examples.txt'));
  return out;
}

function loadExamples() {
  let raw = '';
  for (const p of examplesCandidates()) {
    try { raw = fsSync.readFileSync(p, 'utf8').trim(); } catch { continue; }
    if (raw) break;
  }
  if (!raw) return '';
  /* Из примера берём только сам абзац: первые две строки (метка собеседника и
     строка оператора) в новом формате не выводятся, а в few-shot они ещё и
     тянули за собой факты про конкретных людей. */
  return raw.split(/^=+$/m)
    .map((block) => block.split('\n').map((l) => l.trim()).filter(Boolean).slice(2).join(' ').trim())
    .filter((para) => para.length > 80)
    .join('\n\n');
}

function countsFilePath() {
  return path.join(userDataDir(), 'call-brief-counts.json');
}

/* Какой это звонок по счёту. Своей истории звонков у OmniDeck нет, считаем
   сами: бриф делается перед звонком, значит N-й бриф = N-й звонок.
   ponytail: неудачная попытка тоже увеличит счёт — правится руками в json. */
const NUMERALS = ['Первый', 'Второй', 'Третий', 'Четвёртый', 'Пятый', 'Шестой',
  'Седьмой', 'Восьмой', 'Девятый', 'Десятый'];

function readCounts() {
  try { return JSON.parse(fsSync.readFileSync(countsFilePath(), 'utf8')) || {}; } catch { return {}; }
}

function bumpCallNumber(contact) {
  if (!contact) return 1;
  const counts = readCounts();
  const next = (Number(counts[contact]) || 0) + 1;
  counts[contact] = next;
  try { fsSync.writeFileSync(countsFilePath(), JSON.stringify(counts, null, 2)); } catch { /* не критично */ }
  return next;
}

function numeralFor(n) {
  return NUMERALS[n - 1] || `${n}-й`;
}

/* Сколько дней общаемся — по самой старой ВИДИМОЙ дате. WhatsApp виртуализирует
   список, поэтому это нижняя граница: прокрутил выше — число точнее. */
function daysTalking(messages) {
  const stamps = messages
    .map((m) => /(\d{1,2})[./](\d{1,2})[./](\d{2,4})/.exec(String(m.at || '')))
    .filter(Boolean)
    .map((m) => {
      const [, a, b, y] = m;
      const year = Number(y) < 100 ? 2000 + Number(y) : Number(y);
      // ru-локаль WhatsApp даёт ДД.ММ.ГГГГ; en-локаль ММ/ДД/ГГГГ отличаем по
      // первому числу больше 12, иначе считаем день первым (наш случай).
      const dayFirst = String(m[0]).includes('.') || Number(a) > 12;
      const day = dayFirst ? Number(a) : Number(b);
      const month = dayFirst ? Number(b) : Number(a);
      return Date.UTC(year, month - 1, day);
    })
    .filter((t) => Number.isFinite(t));
  if (!stamps.length) return 0;
  const oldest = Math.min(...stamps);
  const now = new Date();
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(1, Math.round((today - oldest) / 86400000) + 1);
}

function pluralDays(n) {
  const tail = n % 100;
  if (tail >= 11 && tail <= 14) return `${n} дней`;
  const last = n % 10;
  if (last === 1) return `${n} день`;
  if (last >= 2 && last <= 4) return `${n} дня`;
  return `${n} дней`;
}

function loadPrompt() {
  try {
    const text = fsSync.readFileSync(promptFilePath(), 'utf8').trim();
    if (text) return text;
  } catch { /* файла нет — работаем на константе */ }
  return DEFAULT_PROMPT;
}

function blobsDir() {
  return path.join(hfHome(), 'hub', MODEL_REPO_DIR, 'blobs');
}

/* Модель на месте = в кэше есть докачанный блоб нужного размера. Незавершённая
   загрузка лежит рядом с суффиксом .downloadInProgress и в зачёт не идёт. */
function modelReady() {
  try {
    return fsSync.readdirSync(blobsDir()).some((f) => {
      if (f.endsWith('.downloadInProgress')) return false;
      return fsSync.statSync(path.join(blobsDir(), f)).size >= MODEL_MIN_BYTES;
    });
  } catch { return false; }
}

function downloadedBytes() {
  try {
    return fsSync.readdirSync(blobsDir())
      .reduce((sum, f) => sum + fsSync.statSync(path.join(blobsDir(), f)).size, 0);
  } catch { return 0; }
}

function binaryPath() {
  const el = electron();
  const candidates = [];
  if (el?.app?.isPackaged) {
    candidates.push(path.join(process.resourcesPath, 'llama', 'llama-server'));
  } else {
    candidates.push(path.join(__dirname, '..', 'build', 'llama', 'mac', 'llama-server'));
  }
  // Локальные сборки без CI-шага упаковываются с пустым resources/llama —
  // brew как последний фолбэк, чтобы фича не умирала молча.
  candidates.push('/opt/homebrew/bin/llama-server', '/usr/local/bin/llama-server');
  return candidates.find((p) => fsSync.existsSync(p)) || null;
}

/* Свободный порт у ОС: между close() и стартом сервера есть окно гонки, но
   вероятность попасть в него на локальной машине ничтожна, а альтернатива —
   ретраи вокруг фиксированного порта. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = nodeNet.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function httpJson(port, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: pathname,
      method: body ? 'POST' : 'GET',
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {},
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode !== 200) { reject(new Error(`http_${res.statusCode}`)); return; }
        try { resolve(JSON.parse(data)); } catch { reject(new Error('parse_failed')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitReady(port, deadline, onTick) {
  while (Date.now() < deadline) {
    try {
      await httpJson(port, '/health', null, 3000);
      return true;
    } catch {
      try { onTick?.(); } catch { /* прогресс не критичен */ }
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  return false;
}

/* Согласие на 2.3 ГБ — как у whisper: качаем только после явного «Скачать». */
async function confirmDownload(parentWindow) {
  const el = electron();
  if (!el?.dialog) return true; // вне Electron (самопроверка) не спрашиваем
  const { response } = await el.dialog.showMessageBox(parentWindow, {
    type: 'question',
    buttons: ['Скачать', 'Отмена'],
    defaultId: 0,
    cancelId: 1,
    title: 'Бриф звонка',
    message: `Для брифа нужна языковая модель (${MODEL_HUMAN_SIZE}).`,
    detail: 'Скачивается один раз, работает полностью локально — переписка никуда не отправляется.',
  });
  return response === 0;
}

/* Реплики подписываем «Девушка»/«Он», а не «Я»/«Собеседник»: с «Я» модель
   утаскивала фразу оператора в бриф от первого лица («Молодец. Я сегодня
   выходная»). Те же роли, что в самом брифе, — копировать нечего.

   Даты вставляем разделителями дней, а не на каждой строке: без них модель
   путала «вчера» и «сегодня», а построчно это лишние ~200 токенов. */
function dayKey(m) {
  return (/(\d{1,2}[./]\d{1,2}[./]\d{2,4})/.exec(String(m.at || '')) || [])[1] || '';
}

/* Последние два дня переписки — это то, о чём звонок. Остальное идёт фоном:
   так модель не начинает пересказывать позавчерашнее как свежую новость. */
function splitByRecency(messages) {
  const days = [...new Set(messages.map(dayKey).filter(Boolean))];
  if (days.length < 2) return { fresh: messages, older: [] };
  const recent = new Set(days.slice(-2));
  return {
    fresh: messages.filter((m) => recent.has(dayKey(m))),
    older: messages.filter((m) => !recent.has(dayKey(m))),
  };
}

function renderTranscript(messages) {
  const out = [];
  let lastDay = '';
  for (const m of messages) {
    const day = (/(\d{1,2}[./]\d{1,2}[./]\d{2,4})/.exec(String(m.at || '')) || [])[1] || '';
    if (day && day !== lastDay) {
      out.push(day === todayStr() ? `[${day}, сегодня]` : `[${day}]`);
      lastDay = day;
    }
    out.push(`${m.me ? 'Девушка' : 'Он'}: ${m.text}`);
  }
  return out.join('\n');
}

function todayStr() {
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

/* Тире как пунктуация — стойкий тик модели: правило в промпте она игнорирует
   через раз (та же история, что с Оленой в wa-bridge). Чистим на выходе.
   Дефис внутри слов («по-итальянски») не трогаем: он без пробелов. */
function sanitize(raw) {
  return raw
    .split('\n')
    .map((line) => line.replace(/\s+[—–]\s+/g, ', ').replace(/\s+-\s+/g, ', ').trimEnd())
    .join('\n')
    .trim();
}

let _busy = false;
let _child = null; // чтобы не оставить сервер с моделью в памяти после выхода

function killBrief() {
  if (!_child) return;
  try { _child.kill('SIGKILL'); } catch { /* уже мёртв */ }
  _child = null;
}

async function makeBrief(messages, { parentWindow = null, onProgress = null, contactName = '', crmAbout = '', crmMine = '' } = {}) {
  if (_busy) return { ok: false, error: 'бриф уже собирается' };
  const bin = binaryPath();
  if (!bin) return { ok: false, error: 'llama-server не найден в сборке' };
  if (!Array.isArray(messages) || !messages.length) return { ok: false, error: 'нет сообщений' };

  const needsDownload = !modelReady();
  if (needsDownload && !(await confirmDownload(parentWindow))) {
    return { ok: false, error: 'модель не скачана' };
  }

  _busy = true;
  try {
    const port = await freePort();
    _child = spawn(bin, [
      '-hf', MODEL_HF,
      '-c', String(CTX),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--no-webui',
    ], {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const child = _child;

    let stderrTail = '';
    child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk.toString()).slice(-2000); });

    let exited = false;
    child.on('exit', () => { exited = true; });

    /* Прогресс качаем из размера файлов в кэше: llama-server рисует свой
       прогресс-бар только в терминал, в пайп ничего не пишет. */
    const tick = () => {
      if (!needsDownload || !onProgress) return;
      const mb = Math.round(downloadedBytes() / 1048576);
      if (mb > 0) onProgress({ stage: 'download', mb });
    };

    const ready = await waitReady(port, Date.now() + READY_TIMEOUT_MS, tick);
    if (!ready || exited) {
      console.error('[call-brief] server not ready', stderrTail.slice(-600));
      return { ok: false, error: exited ? 'сервер не стартовал' : 'модель не загрузилась' };
    }
    try { onProgress?.({ stage: 'thinking' }); } catch { /* ignore */ }

    const examples = loadExamples();
    const system = examples
      ? `${loadPrompt()}\n\n=== Примеры в точном голосе оператора (это реальные брифы, написанные им самим) ===\n${examples}\n=== Конец примеров ===`
      : loadPrompt();

    const callNo = bumpCallNumber(contactName);
    const days = daysTalking(messages);

    const { fresh, older } = splitByRecency(messages);
    const context = [
      `собеседник: ${contactName || 'неизвестно'}`,
      `какой звонок по счёту: ${numeralFor(callNo)}`,
      days
        ? `общаемся: ${pluralDays(days)}`
        : 'сколько дней общаемся: неизвестно, начни просто с «<Числительное> звонок.» и не пиши предложение про дни',
      `сегодня: ${todayStr()}`,
      '',
      crmAbout ? `--- карточка: что известно о нём ---\n${crmAbout}\n--- конец ---` : '',
      crmMine ? `--- карточка: что девушка о себе рассказывала ---\n${crmMine}\n--- конец ---` : '',
      crmAbout || crmMine ? '' : '',
      '--- последние два дня переписки, это главное ---',
      renderTranscript(fresh),
      '--- конец ---',
      older.length ? `\n--- что было раньше, только фон ---\n${renderTranscript(older)}\n--- конец ---` : '',
      '',
      'Напиши бриф. Только абзац, ничего больше.',
    ].filter(Boolean).join('\n');

    const answer = await httpJson(port, '/v1/chat/completions', {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: context },
      ],
      temperature: 0.4,
      max_tokens: MAX_TOKENS,
    }, REPLY_TIMEOUT_MS);

    const text = sanitize(String(answer?.choices?.[0]?.message?.content || ''));
    if (!text) return { ok: false, error: 'пустой ответ модели' };
    return { ok: true, text, count: messages.length };
  } catch (e) {
    console.error('[call-brief]', e);
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  } finally {
    killBrief();
    _busy = false;
  }
}

/* Есть ли чем считать бриф: без бинаря фичу лучше не показывать вовсе. */
function briefAvailable() {
  return Boolean(binaryPath());
}

module.exports = { makeBrief, killBrief, briefAvailable, promptFilePath };

/* Самопроверка живого пути: `node src/call-brief.js --selfcheck`.
   Проверяет ровно то, что ломается при обновлении llama.cpp, — что сервер
   поднимается, отвечает и в ответе есть факт из переписки. */
if (require.main === module && process.argv.includes('--selfcheck')) {
  const assert = require('assert');
  makeBrief([
    { me: false, text: 'Привет! Заказ 4512 когда приедет?' },
    { me: true, text: 'Завтра до обеда, курьер позвонит.' },
    { me: false, text: 'Хорошо. И счёт пришлите на фирму, жду со среды.' },
  ], { contactName: 'Peter UK65', onProgress: (p) => process.stderr.write(`\r${JSON.stringify(p)}   `) }).then((res) => {
    assert.ok(res.ok, `бриф не собрался: ${res.error}`);
    assert.ok(res.text.length > 40, 'подозрительно короткий бриф');
    assert.ok(/4512|счёт|счет/i.test(res.text), 'в брифе нет фактов из переписки');
    assert.ok(!res.text.split('\n')[0].includes('Peter UK65'), 'метка собеседника осталась в тексте');
    assert.ok(res.text.split('\n').filter(Boolean).length === 1, 'бриф должен быть одним абзацем');
    assert.ok(!/^\s*[-*•]/m.test(res.text), 'модель ушла в список вместо прозы');
    console.log('\n' + res.text);
    console.log('\nselfcheck ok');
  }).catch((e) => { console.error('selfcheck FAILED:', e.message); process.exit(1); });
}

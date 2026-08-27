/* Панель Signal-аккаунта: мини-клиент вместо webview (веб-версии у Signal
 * нет). Franz-подобный UI: список чатов | переписка | композер.
 *
 * События из main (канал signal-event):
 *   message  — входящее → лента + счётчик+1 + системное уведомление
 *   sent     — исходящее (ответил с телефона) → лента
 *   reaction — реакция на сообщение (входящая или моя с телефона)
 *   receipt  — квитанция доставки/прочтения наших сообщений (галочки)
 *   read     — read-sync с телефона → счётчик в 0
 *   link-uri / linked / status — линковка и состояние демона
 *
 * История и вложения живут в main (signal-messages.json + каталог
 * attachments signal-cli); renderer держит рабочую копию. Отправка, реакции
 * и контакты — JSON-RPC к демону через main. Pin/mute/archive — локальные
 * атрибуты чатов (localStorage), Signal-протокол их на связанные
 * устройства не синкает.
 */
import qrcode from 'qrcode-generator';

let state = null;
let setActiveAccount = null;

const _statuses = new Map(); // accountId → status string
let _linkUri = '';           // текущий URI линковки (одна за раз)
let _linkAccountId = '';
let _visibleAccountId = '';
let _panel = null;

const MSG_CAP = 300;
const _msgs = new Map();       // accountId → [{dir,sender,senderId,recipient,groupId,text,attachments,quote,reactions,myReaction,status,ts}]
const _selChat = new Map();    // accountId → выбранный chatKey
const _chatUnread = new Map(); // accountId → Map(chatKey → непрочитанных)
const _stubChats = new Map();  // accountId → Map(key → {name, recipient}) — «новый чат» без сообщений
const _replyTo = new Map();    // `${accountId}:${chatKey}` → msg, на который отвечаем
const _drafts = new Map();     // `${accountId}:${chatKey}` → черновик композера
const _showArchivedFor = new Set(); // accountId с открытым архивом
const _keepUnread = new Set();      // `${accountId}:${key}` — «отмечен непрочитанным», не гасить автоселектом

const _contacts = new Map();       // accountId → [{number, uuid, name, avatar}]
const _groups = new Map();         // accountId → Map(groupId → имя группы)
const _contactsErr = new Map();    // accountId → текст ошибки listContacts
const _contactsLoading = new Set();

let _pickerFor = '';     // accountId с открытым списком выбора
let _pickerMode = 'new'; // 'new' — новый чат, 'forward' — пересылка
let _pickerQuery = '';
let _forwardMsg = null;  // сообщение, которое пересылаем

let _emojiOpen = false;
let _feedAtBottom = true;   // пользователь внизу ленты — можно автоскроллить
let _ctxMenu = null;     // открытое контекстное меню чата

const QUICK_EMOJI = ['\u{1F44D}', '❤️', '\u{1F602}', '\u{1F62E}', '\u{1F622}'];
const EMOJI_SET = [
  '\u{1F600}', '\u{1F602}', '\u{1F605}', '\u{1F609}', '\u{1F60A}', '\u{1F60D}', '\u{1F618}', '\u{1F60E}',
  '\u{1F914}', '\u{1F642}', '\u{1F643}', '\u{1F644}', '\u{1F62D}', '\u{1F622}', '\u{1F62E}', '\u{1F631}',
  '\u{1F621}', '\u{1F97A}', '\u{1F92D}', '\u{1F923}', '\u{1F60F}', '\u{1F634}', '\u{1F912}', '\u{1F973}',
  '\u{1F44D}', '\u{1F44E}', '\u{1F44C}', '✌️', '\u{1F91D}', '\u{1F64F}', '\u{1F4AA}', '\u{1F44F}',
  '❤️', '\u{1F49B}', '\u{1F49A}', '\u{1F499}', '\u{1F49C}', '\u{1F494}', '\u{1F525}', '✨',
  '\u{1F389}', '\u{1F381}', '\u{1F339}', '\u{1F337}', '☀️', '\u{1F319}', '⭐', '\u{1F340}',
];

/* ── Локальные атрибуты чатов (pin/mute/archive) — localStorage ── */
let _chatMeta = {};
try { _chatMeta = JSON.parse(localStorage.getItem('sigChatMeta') || '{}') || {}; } catch { _chatMeta = {}; }
function chatMeta(accountId, key) {
  return (_chatMeta[accountId] || {})[key] || {};
}
function setChatMeta(accountId, key, patch) {
  const acc = _chatMeta[accountId] || {};
  acc[key] = { ...(acc[key] || {}), ...patch };
  _chatMeta[accountId] = acc;
  try { localStorage.setItem('sigChatMeta', JSON.stringify(_chatMeta)); } catch { /* ignore */ }
}

function pushMsg(accountId, msg) {
  const list = _msgs.get(accountId) || [];
  list.push(msg);
  if (list.length > MSG_CAP) list.splice(0, list.length - MSG_CAP);
  _msgs.set(accountId, list);
}

/* Индекс id → контакт: без него chatKey() гонял линейный поиск по всей
   адресной книге на каждое сообщение при каждом рендере */
const _contactIndex = new Map(); // accountId → Map(id → contact)
function contactIndexFor(accountId) {
  let idx = _contactIndex.get(accountId);
  const list = _contacts.get(accountId) || [];
  if (!idx || idx._src !== list) {
    idx = new Map();
    idx._src = list;
    for (const c of list) {
      if (c.number) idx.set(c.number, c);
      if (c.uuid) idx.set(c.uuid, c);
    }
    _contactIndex.set(accountId, idx);
  }
  return idx;
}
function contactFor(accountId, id) {
  if (!id) return null;
  return contactIndexFor(accountId).get(id) || null;
}

/* Канонический id собеседника: у современного Signal один человек приходит
   то как uuid (входящие при скрытом номере), то как номер (адресная книга,
   sent-sync) — без нормализации один контакт распадался на два чата. */
function canonicalId(accountId, id) {
  const c = contactFor(accountId, id);
  return c ? (c.uuid || c.number) : String(id || '');
}

/* Чат = собеседник (канонизированный) или группа. */
function chatKey(msg, accountId) {
  return msg.groupId ? `g:${msg.groupId}` : `n:${canonicalId(accountId, msg.recipient)}`;
}

function buildChats(accountId, msgs) {
  const map = new Map();
  for (const msg of msgs) {
    const key = chatKey(msg, accountId);
    let chat = map.get(key);
    if (!chat) {
      chat = { key, groupId: msg.groupId, recipient: msg.groupId ? '' : msg.recipient, name: '', msgs: [], lastTs: 0 };
      map.set(key, chat);
    }
    chat.msgs.push(msg);
    chat.lastTs = Math.max(chat.lastTs, msg.ts);
    // только для личных чатов: у групп имя отправителя затирало бы имя чата
    if (!msg.groupId && msg.dir === 'in' && msg.sender) chat.name = msg.sender;
  }
  for (const chat of map.values()) {
    const contact = chat.groupId ? null : contactFor(accountId, chat.recipient);
    if (chat.groupId) {
      chat.name = _groups.get(accountId)?.get(chat.groupId) || 'Группа';
    } else if (!chat.name) {
      chat.name = contact?.name || chat.recipient;
    }
    chat.avatar = contact?.avatar || '';
  }
  return Array.from(map.values()).sort((a, b) => b.lastTs - a.lastTs);
}

function mergeStubChats(accountId, chats) {
  const stubs = _stubChats.get(accountId);
  if (!stubs) return chats;
  for (const [key, stub] of stubs) {
    if (!chats.some((c) => c.key === key)) {
      const contact = contactFor(accountId, stub.recipient);
      chats.push({ key, groupId: '', recipient: stub.recipient, name: stub.name || contact?.name || stub.recipient, avatar: contact?.avatar || '', msgs: [], lastTs: 0 });
    }
  }
  return chats;
}

function bumpChatUnread(accountId, key) {
  const m = _chatUnread.get(accountId) || new Map();
  m.set(key, (m.get(key) || 0) + 1);
  _chatUnread.set(accountId, m);
}

/* Бейдж аккаунта = сумма непрочитанных по чатам. Раньше он только рос:
   прочтение чата уменьшало per-chat счётчик, а сайдбар/док залипали. */
function syncAccountBadge(accountId) {
  let total = 0;
  for (const n of (_chatUnread.get(accountId) || new Map()).values()) total += Math.max(0, Number(n) || 0);
  window.WaDeckUnreadModule?.setUnreadCount?.(accountId, total);
}

function fmtTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

/* Franz-стиль относительного времени в списке чатов */
function fmtRel(ts) {
  const diff = Date.now() - Number(ts || 0);
  if (diff < 60e3) return 'сейчас';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)}м`;
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

function attKind(att) {
  const t = String(att?.contentType || '');
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'file';
}
function attLabel(att) {
  const kind = attKind(att);
  if (kind === 'image') return '\u{1F4F7} Фото';
  if (kind === 'video') return '\u{1F3AC} Видео';
  if (kind === 'audio') return '\u{1F399} Аудио';
  return '\u{1F4CE} ' + (att.filename || 'Файл');
}
function msgPreview(msg) {
  if (msg.text) return msg.text;
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  return atts.length ? attLabel(atts[0]) : '';
}

/* Собственные уведомления Signal: с отправителем и текстом. Общий
 * observeAccount не подходит: панель зануляет счётчик аккаунта при показе, и
 * «прирост», на котором тот живёт, терялся; плюс он молчит при
 * сфокусированном окне, даже если открыт другой аккаунт. */
const _lastNotif = new Map();
const NOTIF_THROTTLE_MS = 15000;

function notifyIncoming(account, msg) {
  if (state?.settings?.notificationsEnabled === false) return;
  const key = chatKey(msg, account.id);
  if (chatMeta(account.id, key).muted) return; // чат замьючен
  const panelOpen = account.id === state.activeAccountId && document.hasFocus();
  if (panelOpen) return;
  const throttleKey = `${account.id}::${key}`;
  const last = Number(_lastNotif.get(throttleKey) || 0);
  if (Date.now() - last < NOTIF_THROTTLE_MS) return;
  _lastNotif.set(throttleKey, Date.now());
  try {
    if (typeof Notification === 'undefined' || Notification.permission === 'denied') return;
    const preview = msgPreview(msg);
    const n = new Notification(msg.sender || account.name, {
      body: `Signal · ${preview.length > 120 ? preview.slice(0, 117) + '...' : preview}`,
      tag: throttleKey,
      silent: false,
    });
    n.onclick = () => {
      try { window.waDeck?.focusMainWindow?.().catch(() => {}); } catch { /* ignore */ }
      _selChat.set(account.id, key);
      try { setActiveAccount?.(account.id); } catch { /* ignore */ }
      render();
      try { n.close(); } catch { /* ignore */ }
    };
  } catch (e) {
    console.warn('[signal:notif]', e);
  }
}

const AV_COLORS = ['#e8743b', '#13a4ec', '#9c5bd1', '#19a979', '#d14d64', '#c9822f', '#4f7cd1'];
function avColor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AV_COLORS[h % AV_COLORS.length];
}

/* Аватар: фото профиля, если signal-cli его сохранил, иначе цветной инициал */
function avatarNode(name, avatar, isGroup, extraClass = '') {
  if (avatar) {
    const img = document.createElement('img');
    img.className = `signal-chat-av signal-chat-av-img ${extraClass}`.trim();
    img.src = 'file://' + avatar;
    img.alt = name || '';
    return img;
  }
  const span = document.createElement('span');
  span.className = `signal-chat-av ${extraClass}`.trim();
  span.style.background = avColor(name);
  span.textContent = isGroup ? '\u{1F465}' : (name || '?').trim().slice(0, 1).toUpperCase();
  return span;
}

function loadContacts(accountId, force = false) {
  if (_contactsLoading.has(accountId)) return;
  if (!force && _contacts.has(accountId)) return;
  _contactsLoading.add(accountId);
  // Имена групп грузим вместе с контактами (иначе все группы — «Группа»)
  window.waDeck.signalListGroups?.({ accountId }).then((res) => {
    if (!res?.ok) return;
    const m = new Map();
    for (const g of res.groups || []) if (g.name) m.set(g.id, g.name);
    _groups.set(accountId, m);
    if (_visibleAccountId === accountId) render();
  }).catch(() => {});
  window.waDeck.signalListContacts({ accountId }).then((res) => {
    _contactsLoading.delete(accountId);
    if (res?.ok) {
      _contacts.set(accountId, res.contacts || []);
      _contactsErr.delete(accountId);
      migrateChatKeys(accountId); // ключи чатов теперь канонизируются — переносим состояние
    } else {
      // ошибку НЕ кэшируем как пустой список — следующий заход попробует снова
      _contactsErr.set(accountId, String(res?.error || 'listContacts failed'));
      console.warn('[signal:contacts]', res?.error);
    }
    if (_visibleAccountId === accountId) render();
  }).catch((e) => {
    _contactsLoading.delete(accountId);
    _contactsErr.set(accountId, String(e?.message || e));
    if (_visibleAccountId === accountId) render();
  });
}

/* До загрузки контактов chatKey строится по сырому id, после — по uuid.
   Без переноса состояния бейджи непрочитанных, pin/mute/archive, черновики и
   выбранный чат «осиротевали» на старых ключах. */
function migrateChatKeys(accountId) {
  const remap = (oldKey) => {
    if (!oldKey.startsWith('n:')) return oldKey;
    return `n:${canonicalId(accountId, oldKey.slice(2))}`;
  };
  const unread = _chatUnread.get(accountId);
  if (unread) {
    const next = new Map();
    for (const [k, v] of unread) {
      const nk = remap(k);
      next.set(nk, (next.get(nk) || 0) + v);
    }
    _chatUnread.set(accountId, next);
  }
  const stubs = _stubChats.get(accountId);
  if (stubs) {
    const next = new Map();
    for (const [k, v] of stubs) next.set(remap(k), v);
    _stubChats.set(accountId, next);
  }
  const sel = _selChat.get(accountId);
  if (sel) _selChat.set(accountId, remap(sel));
  const meta = _chatMeta[accountId];
  if (meta) {
    const next = {};
    for (const [k, v] of Object.entries(meta)) next[remap(k)] = { ...(next[remap(k)] || {}), ...v };
    _chatMeta[accountId] = next;
    try { localStorage.setItem('sigChatMeta', JSON.stringify(_chatMeta)); } catch { /* ignore */ }
  }
  for (const map of [_drafts, _replyTo]) {
    for (const key of Array.from(map.keys())) {
      if (!key.startsWith(`${accountId}:`)) continue;
      const chatPart = key.slice(accountId.length + 1);
      const nk = `${accountId}:${remap(chatPart)}`;
      if (nk !== key) { map.set(nk, map.get(key)); map.delete(key); }
    }
  }
}

/* Локальное отражение реакции (main правит свою копию истории сам) */
function applyLocalReaction(accountId, { emoji, remove, targetTs, mine, author }) {
  const list = _msgs.get(accountId) || [];
  const who = mine ? 'me' : String(author || '');
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (Number(m.ts) !== Number(targetTs)) continue;
    let rs = (Array.isArray(m.reactions) ? m.reactions : [])
      .map((x) => (typeof x === 'string' ? { a: '', e: x } : x));
    // Signal: новая реакция того же автора заменяет прежнюю
    rs = rs.filter((r) => r.a !== who);
    if (!remove) rs.push({ a: who, e: emoji });
    if (mine) m.myReaction = remove ? '' : emoji;
    m.reactions = rs;
    return true;
  }
  return false;
}

/* Точечный патч галочек в уже отрисованной ленте (без ре-рендера) */
function patchTicks(receipt) {
  if (!_panel) return;
  for (const ts of receipt.timestamps || []) {
    const row = _panel.querySelector(`.signal-msg-block-out[data-ts="${Number(ts)}"] .signal-msg-ticks`);
    if (!row) continue;
    row.textContent = '✓✓';
    row.classList.toggle('is-read', Boolean(receipt.read));
  }
}

/* Квитанции: галочки sent → delivered → read у наших сообщений */
function applyLocalReceipt(accountId, { read, timestamps }) {
  const list = _msgs.get(accountId) || [];
  const wanted = new Set((timestamps || []).map(Number));
  for (const m of list) {
    if (m.dir !== 'out' || !wanted.has(Number(m.ts))) continue;
    if (read) m.status = 'read';
    else if (m.status !== 'read') m.status = 'delivered';
  }
}

/* Franz-стиль: карточка = иконка + заголовок + подзаголовок + primary-кнопка */
const STATUS_TEXT = {
  no_cli: {
    title: 'Подключить Signal',
    sub: 'Signal не отдаёт переписку браузерам, поэтому дека использует официальный клиент signal-cli. Нажмите — установим его сами и сразу покажем QR-код.',
  },
  no_cli_win: {
    title: 'Нужен signal-cli',
    sub: 'На Windows его ставят вручную: скачайте архив signal-cli, распакуйте и добавьте папку bin в переменную PATH. Нужна также Java 21+. После этого вернитесь сюда — появится QR-код.',
  },
  installing: {
    title: 'Устанавливаю signal-cli…',
    sub: 'Один раз, займёт пару минут. Сразу после установки появится QR-код.',
  },
  unlinked: {
    title: 'Привязать Signal к OmniDeck',
    sub: 'OmniDeck подключится как «связанное устройство» — считать QR-код нужно из Signal на телефоне.',
  },
  linking: {
    title: 'Отсканируйте QR-код',
    sub: 'Signal на телефоне → Настройки → Связанные устройства → «+».',
  },
  running: {
    title: 'Приём сообщений активен',
    sub: 'Уведомления и счётчик — здесь, переписка — в Signal Desktop.',
  },
  stopped: {
    title: 'Аккаунт заморожен',
    sub: 'Разморозьте аккаунт, чтобы возобновить приём сообщений.',
  },
  error: {
    title: 'Приём прервался',
    sub: 'Демон signal-cli упал — автоматический перезапуск через 15 секунд.',
  },
};

const SIGNAL_GLYPH = '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M12 0q-.934 0-1.83.139l.17 1.111a11 11 0 0 1 3.32 0l.172-1.111A12 12 0 0 0 12 0M9.152.34A12 12 0 0 0 5.77 1.742l.584.961a10.8 10.8 0 0 1 3.066-1.27zm5.696 0-.268 1.094a10.8 10.8 0 0 1 3.066 1.27l.584-.962A12 12 0 0 0 14.848.34M4.8 2.393a12 12 0 0 0-2.407 2.408l.891.68a10.8 10.8 0 0 1 2.196-2.196zm14.4 0-.68.892a10.8 10.8 0 0 1 2.195 2.195l.892-.68a12 12 0 0 0-2.408-2.407zM1.742 5.77A12 12 0 0 0 .34 9.152l1.094.268a10.8 10.8 0 0 1 1.27-3.066zm20.516 0-.962.585a10.8 10.8 0 0 1 1.27 3.065l1.094-.268a12 12 0 0 0-1.402-3.381zM12 2.25A9.75 9.75 0 0 0 2.25 12c0 1.7.435 3.372 1.264 4.85l.097.17-.933 3.475a.4.4 0 0 0 .49.49l3.474-.93.17.095A9.75 9.75 0 1 0 12 2.25M.139 10.17A12 12 0 0 0 0 12q0 .934.139 1.83l1.111-.17a10.9 10.9 0 0 1 0-3.32zm23.722 0-1.111.17a10.9 10.9 0 0 1 0 3.32l1.111.172a12.1 12.1 0 0 0 0-3.661zM1.434 14.58l-1.094.268a12 12 0 0 0 1.402 3.382l.962-.585a10.8 10.8 0 0 1-1.27-3.065m21.132 0a10.8 10.8 0 0 1-1.27 3.066l.962.584a12 12 0 0 0 1.402-3.382zm-2.079 4.98a10.8 10.8 0 0 1-2.196 2.196l.68.891a12 12 0 0 0 2.408-2.407zm-16.294.194-.564.564-.183.684q.353.407.746.777l1.577-.422a10.8 10.8 0 0 1-1.576-1.603m2.462 2.323-1.518.406q.774.514 1.626.899l.416-1.554q-.267-.169-.524-.35m2.13 1.014-.416 1.552q.878.324 1.816.502l.172-1.114a10.8 10.8 0 0 1-1.573-.94zm-.001 0 .173-1.115"/></svg>';

function accountById(id) {
  return (state?.accounts || []).find((a) => a.id === id) || null;
}

function ensurePanel() {
  if (_panel) return _panel;
  const host = document.getElementById('webviews');
  if (!host) return null;
  _panel = document.createElement('div');
  _panel.id = 'signal-panel';
  _panel.className = 'signal-panel hidden';
  host.appendChild(_panel);
  return _panel;
}

function qrDataUrl(uri) {
  try {
    const qr = qrcode(0, 'M');
    qr.addData(uri);
    qr.make();
    return qr.createDataURL(5, 8);
  } catch {
    return '';
  }
}

function closeCtxMenu() {
  if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
}

/* Контекстное меню чата: Mark as Unread / Pin / Mute / Archive / Delete */
function openChatContextMenu(e, account, chat) {
  closeCtxMenu();
  const meta = chatMeta(account.id, chat.key);
  const menu = document.createElement('div');
  menu.className = 'signal-ctx-menu';
  const addItem = (label, fn, danger = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'signal-ctx-item' + (danger ? ' is-danger' : '');
    b.textContent = label;
    b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      closeCtxMenu();
      fn();
    });
    menu.appendChild(b);
  };
  addItem('Отметить непрочитанным', () => {
    bumpChatUnread(account.id, chat.key);
    syncAccountBadge(account.id);
    if (_selChat.get(account.id) === chat.key) _selChat.delete(account.id);
    _keepUnread.add(`${account.id}:${chat.key}`); // автоселект не должен тут же «прочитать»
    render();
  });
  addItem(meta.pinned ? 'Открепить' : 'Закрепить', () => {
    setChatMeta(account.id, chat.key, { pinned: !meta.pinned });
    render();
  });
  addItem(meta.muted ? 'Включить уведомления' : 'Без уведомлений', () => {
    setChatMeta(account.id, chat.key, { muted: !meta.muted });
    render();
  });
  addItem(meta.archived ? 'Вернуть из архива' : 'В архив', () => {
    setChatMeta(account.id, chat.key, { archived: !meta.archived });
    if (_selChat.get(account.id) === chat.key) _selChat.delete(account.id);
    render();
  });
  addItem('Удалить чат', async () => {
    // Удаляется только локальная история — у собеседника всё остаётся
    if (!window.confirm(`Удалить чат «${chat.name}» из OmniDeck? История сотрётся только здесь.`)) return;
    const contact = contactFor(account.id, chat.recipient);
    await window.waDeck.signalDeleteChat({
      accountId: account.id, groupId: chat.groupId, recipient: chat.recipient,
      // и номер, и uuid: сообщения одного чата лежат под разными recipient
      recipients: [contact?.number, contact?.uuid, chat.key.replace(/^n:/, '')].filter(Boolean),
    }).catch(() => {});
    const list = (_msgs.get(account.id) || []).filter((m) => chatKey(m, account.id) !== chat.key);
    _msgs.set(account.id, list);
    const stubs = _stubChats.get(account.id);
    stubs?.delete(chat.key);
    if (_selChat.get(account.id) === chat.key) _selChat.delete(account.id);
    render();
  }, true);

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  document.body.appendChild(menu);
  // не вылезать за экран
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 8) menu.style.left = `${window.innerWidth - r.width - 8}px`;
  if (r.bottom > window.innerHeight - 8) menu.style.top = `${window.innerHeight - r.height - 8}px`;
  _ctxMenu = menu;
  setTimeout(() => document.addEventListener('click', closeCtxMenu, { once: true }), 0);
}

function render() {
  const panel = ensurePanel();
  if (!panel || panel.classList.contains('hidden')) return;
  const account = accountById(_visibleAccountId);
  if (!account) return;

  const status = account.frozen ? 'stopped' : (_statuses.get(account.id) || (account.signalNumber ? 'stopped' : 'unlinked'));
  const showQr = status === 'linking' && _linkUri && _linkAccountId === account.id;
  const msgs = _msgs.get(account.id) || [];

  // Черновик per-chat (см. _drafts) — раньше текст перетекал в другой чат
  const prevInput = panel.querySelector('.signal-composer-input');
  const hadFocus = prevInput && document.activeElement === prevInput;
  const searchHadFocus = document.activeElement?.classList?.contains('signal-picker-search');

  if (status === 'running') {
    loadContacts(account.id); // имена/аватары; выполнится один раз
    renderFeed(panel, account, msgs, hadFocus, searchHadFocus);
    return;
  }

  panel.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'signal-card';

  const isWin = state?.runtime?.platform === 'win32';
  // На Windows нет Homebrew — там инструкция, а не кнопка установки
  const metaKey = (status === 'no_cli' && isWin) ? 'no_cli_win' : status;
  const meta = STATUS_TEXT[metaKey] || { title: status, sub: '' };

  const icon = document.createElement('div');
  icon.className = 'signal-card-icon';
  icon.innerHTML = SIGNAL_GLYPH;
  card.appendChild(icon);

  const title = document.createElement('div');
  title.className = `signal-card-title signal-status-${status}`;
  title.textContent = meta.title;
  card.appendChild(title);

  const acctLine = document.createElement('div');
  acctLine.className = 'signal-card-acct';
  acctLine.textContent = account.name + (account.signalNumber ? ` · ${account.signalNumber}` : '');
  card.appendChild(acctLine);

  const statusLine = document.createElement('div');
  statusLine.className = 'signal-card-sub';
  statusLine.textContent = meta.sub;
  card.appendChild(statusLine);

  if (showQr) {
    const img = document.createElement('img');
    img.className = 'signal-qr';
    img.alt = 'QR для привязки устройства';
    img.src = qrDataUrl(_linkUri);
    card.appendChild(img);
  }

  const actions = document.createElement('div');
  actions.className = 'signal-card-actions';

  if (status === 'no_cli' && isWin) {
    const dl = document.createElement('button');
    dl.className = 'btn btn-primary signal-btn-primary';
    dl.textContent = 'Открыть страницу загрузки';
    dl.addEventListener('click', () => {
      window.waDeck.openExternal?.('https://github.com/AsamK/signal-cli/releases/latest')?.catch?.(() => {});
    });
    actions.appendChild(dl);
    const recheck = document.createElement('button');
    recheck.className = 'btn';
    recheck.textContent = 'Проверить снова';
    recheck.addEventListener('click', () => refreshAccount(account.id));
    actions.appendChild(recheck);
  } else if (status === 'no_cli') {
    const inst = document.createElement('button');
    inst.className = 'btn btn-primary signal-btn-primary';
    inst.textContent = 'Установить и показать QR';
    inst.addEventListener('click', async () => {
      inst.disabled = true;
      const res = await window.waDeck.signalInstallCli({ accountId: account.id }).catch(() => null);
      if (!res?.ok) {
        inst.disabled = false;
        statusLine.textContent = res?.error === 'no_brew'
          ? 'Не нашёл Homebrew. Установите signal-cli вручную: brew install signal-cli'
          : `Не удалось запустить установку: ${res?.error || 'ошибка'}`;
      }
    });
    actions.appendChild(inst);
  }
  if (status === 'unlinked' || status === 'error' && !account.signalNumber) {
    const linkBtn = document.createElement('button');
    linkBtn.className = 'btn btn-primary signal-btn-primary';
    linkBtn.textContent = 'Привязать устройство';
    linkBtn.disabled = !window.waDeck.signalLinkStart;
    linkBtn.addEventListener('click', () => {
      window.waDeck.signalLinkStart({ accountId: account.id }).catch(() => {});
    });
    actions.appendChild(linkBtn);
  }
  if (status === 'linking') {
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = 'Отменить';
    cancelBtn.addEventListener('click', () => {
      window.waDeck.signalLinkCancel().catch(() => {});
    });
    actions.appendChild(cancelBtn);
  }
  const openBtn = document.createElement('button');
  openBtn.className = 'btn';
  openBtn.textContent = 'Открыть Signal Desktop';
  openBtn.addEventListener('click', () => {
    window.waDeck.openSignalDesktop().catch(() => {});
  });
  actions.appendChild(openBtn);
  card.appendChild(actions);

  const e2e = document.createElement('div');
  e2e.className = 'signal-card-e2e';
  e2e.textContent = '\u{1F512} Сквозное шифрование: сообщения расшифровываются локально и хранятся только на этом Mac.';
  card.appendChild(e2e);

  panel.appendChild(card);
}

/* Декод аудио-дорожки вложения (mp4/aac/ogg — decodeAudioData Chromium сам
   демуксит) → 16кГц mono WAV base64, формат whisper-cli. Тот же конвейер,
   что у голосовых WhatsApp, только источник — файл signal-cli. */
async function attachmentToWav(b64, maxSec) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dctx = new (window.AudioContext || window.webkitAudioContext)();
  let decoded;
  try {
    decoded = await dctx.decodeAudioData(bytes.buffer);
  } finally {
    dctx.close().catch(() => {});
  }
  if (maxSec && decoded.duration > maxSec) {
    throw new Error('Слишком длинная запись (>' + Math.round(maxSec / 60) + ' минут)');
  }
  const rate = 16000;
  const LEAD = 0.25, TAIL = 1.0; // тишина по краям — whisper роняет последнее слово
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
  const wstr = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  wstr(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  wstr(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  const out = new Uint8Array(wav);
  let res = '';
  const CHUNK = 0x7ffe; // кратно 3 — иначе внутренний '='-паддинг рвёт декод в main
  for (let i = 0; i < out.length; i += CHUNK) {
    res += btoa(String.fromCharCode.apply(null, out.subarray(i, i + CHUNK)));
  }
  return { wav: res, duration: decoded.duration };
}

const _transcribing = new Set(); // `${accountId}:${ts}` — идёт расшифровка
let _modelProgressTs = 0;        // ts сообщения, чью кнопку обновляем процентом

async function transcribeAttachment(account, msg, att, btn) {
  const key = `${account.id}:${msg.ts}`;
  if (_transcribing.has(key)) return;
  _transcribing.add(key);
  if (btn) { btn.textContent = '⏳ читаю…'; btn.disabled = true; }
  _modelProgressTs = Number(msg.ts) || 0; // по нему найдём ЖИВУЮ кнопку после ре-рендера
  try {
    const file = await window.waDeck.signalReadAttachment(att.path);
    if (!file?.ok) {
      const emap = { too_large: 'Файл слишком большой для расшифровки (>24 МБ)', forbidden: 'Файл недоступен' };
      throw new Error(emap[file?.error] || file?.error || 'read_failed');
    }
    // Длительность проверяем на декодированном буфере, до сборки WAV+base64
    const { wav, duration } = await attachmentToWav(file.b64, 900);
    if (btn) btn.textContent = '⏳ расшифровка…';
    const res = await window.waDeck.signalTranscribeWav({ wav });
    if (!res?.ok) {
      const msgs = { busy: 'Уже идёт другая расшифровка', no_speech: 'Речь не распознана', no_whisper: 'Модуль распознавания не запускается — проверьте установку приложения', model_declined: '' };
      throw new Error(msgs[res?.error] ?? (res?.error || 'transcribe_failed'));
    }
    msg.transcript = res.text;
    window.waDeck.signalSetTranscript({ accountId: account.id, ts: msg.ts, text: res.text }).catch(() => {});
  } catch (e) {
    // В отдельное поле, НЕ в transcript: иначе кнопка «расшифровать» исчезала
    // навсегда после любой временной ошибки (демон моргнул, модель качается)
    const emsg = String(e?.message || e);
    if (emsg) msg.transcriptError = emsg;
  } finally {
    _transcribing.delete(key);
    _modelProgressTs = 0;
    render();
  }
}

function makeAttChip(att) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'signal-msg-att';
  chip.textContent = attLabel(att);
  chip.title = 'Открыть файл · ПКМ — сохранить';
  chip.addEventListener('click', () => window.waDeck.signalOpenAttachment(att.path).catch(() => {}));
  chip.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.waDeck.signalSaveAttachment(att.path).catch(() => {});
  });
  return chip;
}

/* Franz-подобный клиент во всю панель: [список чатов | переписка]. */
function renderFeed(panel, account, msgs, hadFocus, searchHadFocus) {
  panel.innerHTML = '';
  const client = document.createElement('div');
  client.className = 'signal-client';

  let chats = mergeStubChats(account.id, buildChats(account.id, msgs));
  // pin/archive из локальных атрибутов
  for (const chat of chats) {
    const meta = chatMeta(account.id, chat.key);
    chat.pinned = Boolean(meta.pinned);
    chat.muted = Boolean(meta.muted);
    chat.archived = Boolean(meta.archived);
  }
  const archivedCount = chats.filter((c) => c.archived).length;
  const _showArchived = _showArchivedFor.has(account.id);
  chats = chats
    .filter((c) => (_showArchived ? c.archived : !c.archived))
    .sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || (b.lastTs - a.lastTs));

  let selKey = _selChat.get(account.id);
  if (selKey && !chats.some((c) => c.key === selKey)) selKey = '';
  if (!selKey && chats.length) selKey = chats[0].key;
  if (selKey) _selChat.set(account.id, selKey);
  const selChat = chats.find((c) => c.key === selKey) || null;
  const unreadMap = _chatUnread.get(account.id) || new Map();
  // Гасим бейдж открытого чата только когда юзер реально на него смотрит —
  // при несфокусированном окне входящие не должны «самопрочитываться»
  const keepKey = `${account.id}:${selKey}`;
  if (_keepUnread.has(keepKey)) _keepUnread.delete(keepKey);
  else if (selKey && document.hasFocus() && account.id === _visibleAccountId) {
    if (unreadMap.delete(selKey)) syncAccountBadge(account.id);
  }

  const pickerActive = _pickerFor === account.id;

  // ── Левая колонка ──
  const list = document.createElement('div');
  list.className = 'signal-chatlist';

  const listHead = document.createElement('div');
  listHead.className = 'signal-chatlist-head';
  const listTitle = document.createElement('div');
  listTitle.className = 'signal-chatlist-title';
  listTitle.textContent = pickerActive
    ? (_pickerMode === 'forward' ? 'Переслать в...' : 'Новый чат')
    : (_showArchived ? 'Архив' : 'Чаты');
  const listSub = document.createElement('div');
  listSub.className = 'signal-chatlist-sub';
  listSub.textContent = account.signalNumber || account.name;
  const headBtn = document.createElement('button');
  headBtn.type = 'button';
  headBtn.className = 'signal-desktop-btn';
  if (pickerActive) {
    headBtn.title = 'Закрыть';
    headBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    headBtn.addEventListener('click', () => { _pickerFor = ''; _forwardMsg = null; render(); });
  } else {
    headBtn.title = 'Новый чат';
    headBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
    headBtn.addEventListener('click', () => {
      _pickerFor = account.id;
      _pickerMode = 'new';
      _pickerQuery = '';
      loadContacts(account.id);
      render();
    });
  }
  const deskBtn = document.createElement('button');
  deskBtn.type = 'button';
  deskBtn.className = 'signal-desktop-btn';
  deskBtn.title = 'Открыть Signal Desktop';
  deskBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>';
  deskBtn.addEventListener('click', () => window.waDeck.openSignalDesktop().catch(() => {}));
  const listHeadTxt = document.createElement('div');
  listHeadTxt.className = 'signal-chatlist-head-txt';
  listHeadTxt.append(listTitle, listSub);
  listHead.append(listHeadTxt, headBtn, deskBtn);
  list.appendChild(listHead);

  if (pickerActive) {
    renderPicker(list, account, chats);
  } else {
    if (!chats.length) {
      const hint = document.createElement('div');
      hint.className = 'signal-chatlist-empty';
      hint.textContent = _showArchived ? 'Архив пуст' : 'Новые входящие появятся здесь';
      list.appendChild(hint);
    }
    for (const chat of chats) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'signal-chat-row' + (chat.key === selKey ? ' is-active' : '');
      const av = avatarNode(chat.name, chat.avatar, Boolean(chat.groupId));
      const txt = document.createElement('span');
      txt.className = 'signal-chat-txt';
      const name = document.createElement('span');
      name.className = 'signal-chat-name';
      name.textContent = chat.name;
      if (chat.pinned) name.textContent = '\u{1F4CC} ' + chat.name;
      if (chat.muted) name.textContent += ' \u{1F515}';
      const preview = document.createElement('span');
      preview.className = 'signal-chat-preview';
      const last = chat.msgs[chat.msgs.length - 1];
      preview.textContent = last ? (last.dir === 'out' ? 'Вы: ' : '') + msgPreview(last) : 'Новый чат';
      txt.append(name, preview);
      const side = document.createElement('span');
      side.className = 'signal-chat-side';
      const time = document.createElement('span');
      time.className = 'signal-chat-time';
      time.textContent = chat.lastTs ? fmtRel(chat.lastTs) : '';
      side.appendChild(time);
      const unread = Number(unreadMap.get(chat.key) || 0);
      if (unread > 0) {
        const badge = document.createElement('span');
        badge.className = 'signal-chat-badge';
        badge.textContent = unread > 99 ? '99+' : String(unread);
        side.appendChild(badge);
        time.classList.add('has-unread');
      }
      row.append(av, txt, side);
      row.addEventListener('click', () => {
        _selChat.set(account.id, chat.key);
        render();
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openChatContextMenu(e, account, chat);
      });
      list.appendChild(row);
    }
    if (archivedCount > 0 || _showArchived) {
      const archBtn = document.createElement('button');
      archBtn.type = 'button';
      archBtn.className = 'signal-archive-toggle';
      archBtn.textContent = _showArchived ? '← К чатам' : `\u{1F4E6} Архив (${archivedCount})`;
      archBtn.addEventListener('click', () => {
        if (_showArchivedFor.has(account.id)) _showArchivedFor.delete(account.id);
        else _showArchivedFor.add(account.id);
        _selChat.delete(account.id);
        render();
      });
      list.appendChild(archBtn);
    }
  }
  client.appendChild(list);

  // ── Правая колонка ──
  const thread = document.createElement('div');
  thread.className = 'signal-thread';

  if (!selChat) {
    const empty = document.createElement('div');
    empty.className = 'signal-thread-empty';
    const icon = document.createElement('div');
    icon.className = 'signal-card-icon';
    icon.innerHTML = SIGNAL_GLYPH;
    const t1 = document.createElement('div');
    t1.className = 'signal-thread-empty-title';
    t1.textContent = 'Signal';
    const t2 = document.createElement('div');
    t2.className = 'signal-thread-empty-sub';
    t2.textContent = 'Здесь появится переписка. История до привязки остаётся в Signal Desktop и на телефоне.';
    const pill = document.createElement('div');
    pill.className = 'signal-e2e-pill';
    pill.textContent = '\u{1F512} Сквозное шифрование';
    empty.append(icon, t1, t2, pill);
    thread.appendChild(empty);
    client.appendChild(thread);
    panel.appendChild(client);
    return;
  }

  const thHead = document.createElement('div');
  thHead.className = 'signal-thread-head';
  const thAv = avatarNode(selChat.name, selChat.avatar, Boolean(selChat.groupId), 'signal-thread-av');
  const thTxt = document.createElement('div');
  thTxt.className = 'signal-thread-head-txt';
  const thName = document.createElement('div');
  thName.className = 'signal-thread-head-name';
  thName.textContent = selChat.name;
  const thSub = document.createElement('div');
  thSub.className = 'signal-thread-head-sub';
  thSub.textContent = selChat.groupId ? 'Группа' : (selChat.recipient !== selChat.name ? selChat.recipient : 'Signal');
  thTxt.append(thName, thSub);
  thHead.append(thAv, thTxt);
  thread.appendChild(thHead);

  const feed = document.createElement('div');
  feed.className = 'signal-feed';
  for (const msg of selChat.msgs) {
    feed.appendChild(renderMsg(account, selChat, msg));
  }
  thread.appendChild(feed);

  // ── Бар «Ответ на …» (привязан к ЭТОМУ чату — не утекает соседям) ──
  const replyMsg = _replyTo.get(`${account.id}:${selKey}`);
  if (replyMsg) {
    const bar = document.createElement('div');
    bar.className = 'signal-reply-bar';
    const txt = document.createElement('div');
    txt.className = 'signal-reply-bar-txt';
    const who = document.createElement('div');
    who.className = 'signal-reply-bar-who';
    who.textContent = replyMsg.dir === 'in' ? (replyMsg.sender || replyMsg.recipient) : 'Вы';
    const body = document.createElement('div');
    body.className = 'signal-reply-bar-text';
    body.textContent = msgPreview(replyMsg);
    txt.append(who, body);
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'signal-desktop-btn';
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>';
    closeBtn.addEventListener('click', () => { _replyTo.delete(`${account.id}:${selKey}`); render(); });
    bar.append(txt, closeBtn);
    thread.appendChild(bar);
  }

  // ── Композер: скрепка · смайлы · поле · отправить ──
  const composer = document.createElement('div');
  composer.className = 'signal-composer';

  const attachBtn = document.createElement('button');
  attachBtn.type = 'button';
  attachBtn.className = 'signal-composer-icon-btn';
  attachBtn.title = 'Прикрепить файл';
  attachBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>';

  const emojiBtn = document.createElement('button');
  emojiBtn.type = 'button';
  emojiBtn.className = 'signal-composer-icon-btn';
  emojiBtn.title = 'Смайлики';
  emojiBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'signal-composer-input';
  input.placeholder = 'Сообщение...';
  const draftKey = `${account.id}:${selKey}`;
  input.value = _drafts.get(draftKey) || '';

  const sendBtn = document.createElement('button');
  sendBtn.type = 'button';
  sendBtn.className = 'signal-send-btn';
  sendBtn.title = 'Отправить';
  sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>';

  const errLine = document.createElement('div');
  errLine.className = 'signal-composer-err hidden';

  const quoteFor = () => {
    const r = _replyTo.get(`${account.id}:${selKey}`);
    if (!r) return undefined;
    return {
      ts: r.ts,
      author: r.dir === 'in' ? (r.senderId || r.recipient) : (account.signalNumber || ''),
      text: msgPreview(r).slice(0, 200),
    };
  };

  const doSend = async (attachments) => {
    if (sendBtn.disabled) return; // Enter во время await слал дубль
    const text = input.value.trim();
    if (!text && !attachments?.length) return;
    sendBtn.disabled = true;
    const quote = quoteFor();
    const res = await window.waDeck.signalSend({
      accountId: account.id, recipient: selChat.recipient, groupId: selChat.groupId, text,
      quote, attachments,
    }).catch(() => null);
    sendBtn.disabled = false;
    if (res?.ok) {
      pushMsg(account.id, {
        dir: 'out', sender: '', recipient: selChat.recipient, groupId: selChat.groupId, text,
        attachments: (attachments || []).map((pth) => ({ id: pth, contentType: '', filename: String(pth).split('/').pop(), path: pth })),
        // ts — протокольный timestamp от signal-cli: по нему матчатся галочки и реакции
        quote, status: 'sent', ts: Number(res.timestamp) || Date.now(),
      });
      _drafts.delete(draftKey);
      // За время await мог случиться ре-рендер — чистим АКТУАЛЬНОЕ поле, не detached
      const live = panel.querySelector('.signal-composer-input');
      if (live) live.value = '';
      _replyTo.delete(`${account.id}:${selKey}`);
      render();
    } else {
      errLine.textContent = `Не отправилось: ${res?.error || 'ошибка'}`;
      errLine.classList.remove('hidden');
    }
  };

  attachBtn.addEventListener('click', async () => {
    const picked = await window.waDeck.pickAttachments().catch(() => null);
    const files = (picked?.files || []).map((f) => f.path).filter(Boolean);
    if (files.length) doSend(files); // текст из поля уходит подписью
  });

  emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _emojiOpen = !_emojiOpen;
    emojiPanel.classList.toggle('hidden', !_emojiOpen);
  });

  sendBtn.addEventListener('click', () => doSend());
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSend(); });
  input.addEventListener('input', () => {
    errLine.classList.add('hidden');
    _drafts.set(draftKey, input.value);
  });

  // Franz-компоновка: [+ | поле | 🙂 | синяя круглая] внутри одной пилюли
  composer.append(attachBtn, input, emojiBtn, sendBtn);

  // Панель смайликов (фиксированный набор, без зависимостей)
  const emojiPanel = document.createElement('div');
  emojiPanel.className = 'signal-emoji-panel' + (_emojiOpen ? '' : ' hidden');
  for (const em of EMOJI_SET) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'signal-emoji-btn';
    b.textContent = em;
    b.addEventListener('click', () => {
      input.value += em;
      input.focus();
    });
    emojiPanel.appendChild(b);
  }
  thread.append(emojiPanel, composer, errLine);
  client.appendChild(thread);
  panel.appendChild(client);
  // Скроллим вниз только если пользователь и так внизу — иначе он читает
  // старое, а лента дёргает его к последнему сообщению
  if (_feedAtBottom) feed.scrollTop = feed.scrollHeight;
  feed.addEventListener('scroll', () => {
    _feedAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60;
  }, { passive: true });
  if (hadFocus) { try { input.focus(); } catch { /* ignore */ } }
  if (searchHadFocus) {
    const sr = panel.querySelector('.signal-picker-search');
    if (sr) { try { sr.focus(); sr.setSelectionRange(sr.value.length, sr.value.length); } catch { /* ignore */ } }
  }
}

/* Franz-структура сообщения: строка [пузырь + hover-иконки сбоку],
   под ней — чипы реакций, затем штамп времени с галочками. */
function renderMsg(account, selChat, msg) {
  const block = document.createElement('div');
  block.className = `signal-msg-block signal-msg-block-${msg.dir}`;
  block.dataset.ts = String(msg.ts); // якорь для точечного патча галочек

  const line = document.createElement('div');
  line.className = 'signal-msg-line';

  const bubble = document.createElement('div');
  bubble.className = `signal-msg signal-msg-${msg.dir}`;

  if (selChat.groupId && msg.dir === 'in' && msg.sender) {
    const meta = document.createElement('div');
    meta.className = 'signal-msg-meta';
    meta.textContent = msg.sender;
    bubble.appendChild(meta);
  }

  if (msg.quote?.ts) {
    const q = document.createElement('div');
    q.className = 'signal-msg-quote';
    const qa = document.createElement('div');
    qa.className = 'signal-msg-quote-author';
    const qc = contactFor(account.id, msg.quote.author);
    qa.textContent = msg.quote.author === (account.signalNumber || '') ? 'Вы' : (qc?.name || msg.quote.author || '...');
    const qt = document.createElement('div');
    qt.className = 'signal-msg-quote-text';
    qt.textContent = msg.quote.text || '';
    q.append(qa, qt);
    bubble.appendChild(q);
  }

  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  for (const att of atts) {
    if (!att.path) continue;
    if (attKind(att) === 'image') {
      // Franz: кнопка скачивания поверх угла картинки
      const wrap = document.createElement('div');
      wrap.className = 'signal-msg-imgwrap';
      const img = document.createElement('img');
      img.className = 'signal-msg-img';
      img.src = 'file://' + att.path;
      img.alt = att.filename || 'Фото';
      img.title = 'Открыть';
      img.addEventListener('click', () => window.waDeck.signalOpenAttachment(att.path).catch(() => {}));
      img.addEventListener('error', () => { wrap.replaceWith(makeAttChip(att)); });
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'signal-img-dl';
      dl.title = 'Сохранить';
      dl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      dl.addEventListener('click', (e) => {
        e.stopPropagation();
        window.waDeck.signalSaveAttachment(att.path).catch(() => {});
      });
      wrap.append(img, dl);
      bubble.appendChild(wrap);
    } else {
      bubble.appendChild(makeAttChip(att));
    }
  }
  const trAtt = atts.find((a) => a.path && (attKind(a) === 'audio' || attKind(a) === 'video'));
  if (msg.transcriptError) {
    const err = document.createElement('div');
    err.className = 'signal-msg-transcript signal-msg-transcript-err';
    err.textContent = `⚠ ${msg.transcriptError}`;
    bubble.appendChild(err);
  }
  if (trAtt && !msg.transcript) {
    const trBtn = document.createElement('button');
    trBtn.type = 'button';
    trBtn.className = 'signal-msg-att signal-att-transcribe';
    trBtn.dataset.ts = String(msg.ts);
    const busyKey = `${account.id}:${msg.ts}`;
    trBtn.textContent = _transcribing.has(busyKey) ? '⏳ расшифровка…' : '\u{1F3A4} расшифровать';
    if (_transcribing.has(busyKey)) trBtn.disabled = true;
    trBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      msg.transcriptError = ''; // повторная попытка после ошибки
      transcribeAttachment(account, msg, trAtt, trBtn);
    });
    bubble.appendChild(trBtn);
  }
  if (msg.transcript) {
    const tr = document.createElement('div');
    tr.className = 'signal-msg-transcript';
    tr.textContent = msg.transcript;
    bubble.appendChild(tr);
  }
  if (msg.text || !atts.length) {
    const body = document.createElement('div');
    body.className = 'signal-msg-text';
    body.textContent = msg.text;
    bubble.appendChild(body);
  }

  // ── Franz: три тихие иконки сбоку от пузыря (hover) ──
  const actions = document.createElement('div');
  actions.className = 'signal-msg-actions';

  const reactBtn = document.createElement('button');
  reactBtn.type = 'button';
  reactBtn.className = 'signal-msg-action';
  reactBtn.title = 'Реакция';
  reactBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
  reactBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openReactPopover(reactBtn, account, selChat, msg);
  });

  const replyBtn = document.createElement('button');
  replyBtn.type = 'button';
  replyBtn.className = 'signal-msg-action';
  replyBtn.title = 'Ответить';
  replyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 13h5"/></svg>';
  replyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _replyTo.set(`${account.id}:${chatKey(msg, account.id)}`, msg);
    render();
  });

  const fwdBtn = document.createElement('button');
  fwdBtn.type = 'button';
  fwdBtn.className = 'signal-msg-action';
  fwdBtn.title = 'Переслать';
  fwdBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/></svg>';
  fwdBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _forwardMsg = msg;
    _pickerFor = account.id;
    _pickerMode = 'forward';
    _pickerQuery = '';
    loadContacts(account.id);
    render();
  });

  actions.append(reactBtn, replyBtn, fwdBtn);
  // in: пузырь слева, иконки справа от него; out: иконки слева от пузыря
  if (msg.dir === 'out') line.append(actions, bubble);
  else line.append(bubble, actions);
  block.appendChild(line);

  // Franz: реакция — круглый чип под пузырём
  const rs = (Array.isArray(msg.reactions) ? msg.reactions : [])
    .map((x) => (typeof x === 'string' ? x : x.e));
  if (rs.length) {
    const chips = document.createElement('div');
    chips.className = 'signal-msg-reactions';
    const counts = new Map();
    for (const em of rs) counts.set(em, (counts.get(em) || 0) + 1);
    for (const [em, n] of counts) {
      const chip = document.createElement('span');
      chip.className = 'signal-reaction-chip' + (msg.myReaction === em ? ' is-mine' : '');
      chip.textContent = n > 1 ? `${em} ${n}` : em;
      chips.appendChild(chip);
    }
    block.appendChild(chips);
  }

  // Franz: время (и галочки у исходящих) снаружи, под пузырём
  const stamp = document.createElement('div');
  stamp.className = 'signal-msg-stamp';
  if (msg.dir === 'out') {
    const ticks = msg.status === 'read' || msg.status === 'delivered' ? '✓✓' : '✓';
    stamp.innerHTML = `${fmtTime(msg.ts)} <span class="signal-msg-ticks${msg.status === 'read' ? ' is-read' : ''}">${ticks}</span>`;
  } else {
    stamp.textContent = fmtTime(msg.ts);
  }
  block.appendChild(stamp);

  return block;
}

/* Поповер быстрых реакций у кнопки 😊 (Franz-стиль) */
let _reactPop = null;
function closeReactPopover() {
  if (_reactPop) { _reactPop.remove(); _reactPop = null; }
}
function openReactPopover(anchor, account, selChat, msg) {
  closeReactPopover();
  const pop = document.createElement('div');
  pop.className = 'signal-react-pop';
  for (const em of QUICK_EMOJI) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'signal-react-pop-btn' + (msg.myReaction === em ? ' is-mine' : '');
    b.textContent = em;
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      closeReactPopover();
      const remove = msg.myReaction === em;
      const res = await window.waDeck.signalReact({
        accountId: account.id,
        recipient: selChat.recipient,
        groupId: selChat.groupId,
        emoji: em,
        targetAuthor: msg.dir === 'in' ? (msg.senderId || msg.recipient) : (account.signalNumber || ''),
        targetTs: msg.ts,
        remove,
      }).catch(() => null);
      if (res?.ok) {
        applyLocalReaction(account.id, { emoji: em, remove, targetTs: msg.ts, mine: true, author: 'me' });
        render();
      }
    });
    pop.appendChild(b);
  }
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  let left = r.left + r.width / 2 - pr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));
  let top = r.top - pr.height - 6;
  if (top < 8) top = r.bottom + 6;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  _reactPop = pop;
  setTimeout(() => document.addEventListener('click', closeReactPopover, { once: true }), 0);
}

/* Список выбора: контакты (новый чат) или чаты+контакты (пересылка) */
function renderPicker(list, account, chats) {
  const search = document.createElement('input');
  search.type = 'text';
  search.className = 'signal-picker-search';
  search.placeholder = 'Поиск...';
  search.value = _pickerQuery;
  list.appendChild(search);

  const rows = document.createElement('div');
  rows.className = 'signal-picker-rows';
  list.appendChild(rows);

  const pickTarget = async (target) => { // {name, recipient, groupId, avatar}
    if (_pickerMode === 'forward' && _forwardMsg) {
      const msg = _forwardMsg;
      const res = await window.waDeck.signalSend({
        accountId: account.id,
        recipient: target.recipient,
        groupId: target.groupId,
        text: msg.text,
        attachments: (msg.attachments || []).map((a) => a.path).filter(Boolean),
      }).catch(() => null);
      if (res?.ok) {
        pushMsg(account.id, {
          dir: 'out', sender: '', recipient: target.recipient, groupId: target.groupId,
          text: msg.text, attachments: msg.attachments, status: 'sent', ts: Number(res.timestamp) || Date.now(),
        });
      }
      _forwardMsg = null;
    }
    if (!target.groupId) {
      // Ключ КАНОНИЧЕСКИЙ (uuid), recipient — сырой (для отправки): иначе
      // stub жил под номером, реальные сообщения — под uuid, и получался
      // пустой чат-двойник, в котором не видно только что отправленного
      const key = `n:${canonicalId(account.id, target.recipient)}`;
      const stubs = _stubChats.get(account.id) || new Map();
      if (!stubs.has(key)) stubs.set(key, { name: target.name, recipient: target.recipient });
      _stubChats.set(account.id, stubs);
      _selChat.set(account.id, key);
    } else {
      _selChat.set(account.id, `g:${target.groupId}`);
    }
    _pickerFor = '';
    render();
  };

  const renderRows = () => {
    rows.innerHTML = '';
    const q = _pickerQuery.trim().toLowerCase();
    const targets = [];
    if (_pickerMode === 'forward') {
      for (const chat of chats) {
        targets.push({ name: chat.name, recipient: chat.recipient, groupId: chat.groupId, avatar: chat.avatar, sub: chat.groupId ? 'группа' : chat.recipient });
      }
    }
    const contacts = _contacts.get(account.id);
    for (const c of contacts || []) {
      const recipient = c.number || c.uuid;
      if (targets.some((t) => !t.groupId && t.recipient === recipient)) continue;
      targets.push({ name: c.name, recipient, groupId: '', avatar: c.avatar, sub: c.number || 'Signal' });
    }
    const filtered = targets.filter((t) => !q || t.name.toLowerCase().includes(q) || String(t.sub).includes(q));

    if (!filtered.length) {
      const nf = document.createElement('div');
      nf.className = 'signal-chatlist-empty';
      const err = _contactsErr.get(account.id);
      if (_contactsLoading.has(account.id)) nf.textContent = 'Загрузка контактов...';
      else if (err) nf.textContent = `Не удалось получить контакты: ${err}`;
      else nf.textContent = q ? 'Никого не нашлось' : 'Контакты ещё не синхронизировались с телефона';
      rows.appendChild(nf);
      return;
    }
    for (const t of filtered.slice(0, 200)) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'signal-chat-row';
      const av = avatarNode(t.name, t.avatar, Boolean(t.groupId));
      const txt = document.createElement('span');
      txt.className = 'signal-chat-txt';
      const name = document.createElement('span');
      name.className = 'signal-chat-name';
      name.textContent = t.name;
      const sub = document.createElement('span');
      sub.className = 'signal-chat-preview';
      sub.textContent = t.sub;
      txt.append(name, sub);
      row.append(av, txt);
      row.addEventListener('click', () => pickTarget(t));
      rows.appendChild(row);
    }
  };
  search.addEventListener('input', () => {
    _pickerQuery = search.value;
    renderRows();
  });
  renderRows();
}

/* Вызывается из refreshWebviewVisibility: активен ли сейчас signal-аккаунт */
function setVisible(visible, account) {
  const panel = ensurePanel();
  if (!panel) return;
  panel.classList.toggle('hidden', !visible);
  if (visible && account) {
    _visibleAccountId = account.id;
    // НЕ зануляем весь бейдж: непрочитанные в других чатах никуда не делись
    syncAccountBadge(account.id);
    render();
  }
}

/* Кнопка «Обновить» в тулбаре: перезапуск демона + свежие контакты */
function refreshAccount(accountId) {
  window.waDeck.signalRestart?.({ accountId }).catch(() => {});
  loadContacts(accountId, true);
  render();
}

function handleEvent(payload) {
  const kind = String(payload?.kind || '');
  if (kind === 'install-log') {
    // Живая строка вывода brew, чтобы установка не выглядела зависшей
    const sub = _panel?.querySelector('.signal-card-sub');
    if (sub && _statuses.get(String(payload.accountId || '')) === 'installing') {
      sub.textContent = String(payload.line || '').slice(0, 120);
    }
    return;
  }
  if (kind === 'model-progress') {
    // Событие без accountId — обрабатываем ДО гварда на аккаунт.
    // Первая расшифровка качает модель (~190 МБ), иначе кнопка молча висит.
    const live = _modelProgressTs && _panel?.querySelector(`.signal-att-transcribe[data-ts="${_modelProgressTs}"]`);
    if (live) live.textContent = `⏳ модель ${payload.pct || 0}%`;
    return;
  }
  const accountId = String(payload?.accountId || '');
  const account = accountById(accountId);
  if (!account) return;

  if (kind === 'message') {
    if (account.frozen) return;
    if (payload.msg) {
      pushMsg(accountId, payload.msg);
      const key = chatKey(payload.msg, accountId);
      const isOpenChat = accountId === _visibleAccountId
        && _selChat.get(accountId) === key
        && document.hasFocus();
      if (!isOpenChat) {
        bumpChatUnread(accountId, key);
        syncAccountBadge(accountId); // бейдж = сумма по чатам
      }
      notifyIncoming(account, payload.msg);
    }
  } else if (kind === 'sent') {
    if (payload.msg) pushMsg(accountId, { ...payload.msg, status: payload.msg.status || 'sent' });
  } else if (kind === 'reaction') {
    if (payload.reaction) applyLocalReaction(accountId, payload.reaction);
  } else if (kind === 'receipt') {
    // Квитанции идут пачками: полная перерисовка панели ради двух галочек —
    // расточительство, патчим только их
    if (payload.receipt) {
      applyLocalReceipt(accountId, payload.receipt);
      if (accountId === _visibleAccountId) patchTicks(payload.receipt);
      return;
    }
  } else if (kind === 'read') {
    _chatUnread.delete(accountId); // прочитано с телефона — чат-бейджи тоже гаснут
    syncAccountBadge(accountId);
  } else if (kind === 'link-uri') {
    _linkUri = String(payload.uri || '');
    _linkAccountId = accountId;
    _statuses.set(accountId, 'linking');
  } else if (kind === 'linked') {
    account.signalNumber = String(payload.number || '');
    _linkUri = '';
  } else if (kind === 'status') {
    _statuses.set(accountId, String(payload.status || ''));
    // Чистим QR только по событию СВОЕГО аккаунта — статус соседнего
    // signal-аккаунта обрывал линковку на середине
    if (payload.status !== 'linking' && accountId === _linkAccountId) { _linkUri = ''; }
  }
  if (accountId === _visibleAccountId) render();
}

function init(ctx) {
  state = ctx.state;
  setActiveAccount = ctx.setActiveAccount || null;

  if (typeof window.waDeck?.onSignalEvent === 'function') {
    window.waDeck.onSignalEvent(handleEvent);
  }
  // Один постоянный слушатель закрытия emoji-панели: once-слушатели в каждом
  // рендере копились и держали detached-DOM в замыканиях
  document.addEventListener('click', (e) => {
    if (!_emojiOpen || !_panel) return;
    const pane = _panel.querySelector('.signal-emoji-panel');
    if (pane && !pane.contains(e.target) && !e.target.closest?.('.signal-composer-icon-btn')) {
      _emojiOpen = false;
      pane.classList.add('hidden');
    }
  });
  // Начальные статусы демонов (запущены main-ом до загрузки renderer)
  window.waDeck.signalGetStatus?.().then((res) => {
    if (!res?.ok) return;
    for (const [id, st] of Object.entries(res.statuses || {})) _statuses.set(id, st);
    render();
  }).catch(() => {});
  // История из main (signal-messages.json) — лента переживает перезапуск деки
  window.waDeck.signalLoadMessages?.().then((res) => {
    if (!res?.ok) return;
    for (const [id, list] of Object.entries(res.messages || {})) {
      if (!Array.isArray(list)) continue;
      // Мержим с уже пришедшими live-событиями: раньше одно раннее событие
      // блокировало сидинг и вся сохранённая история отбрасывалась
      const live = _msgs.get(id) || [];
      const merged = list.slice(-MSG_CAP);
      for (const m of live) {
        if (!merged.some((pm) => pm.ts === m.ts && pm.dir === m.dir && pm.text === m.text)) merged.push(m);
      }
      merged.sort((a, b) => a.ts - b.ts);
      _msgs.set(id, merged.slice(-MSG_CAP));
    }
    render();
  }).catch(() => {});
}

/* Строки для общей ленты непрочитанных хаба и Cmd+U */
function getUnreadRows() {
  const rows = [];
  for (const acc of state?.accounts || []) {
    if (acc.type !== 'signal' || acc.frozen) continue;
    const unread = _chatUnread.get(acc.id);
    if (!unread || !unread.size) continue;
    const chats = buildChats(acc.id, _msgs.get(acc.id) || []);
    for (const [key, count] of unread) {
      const chat = chats.find((c) => c.key === key);
      if (!chat || count <= 0) continue;
      const last = chat.msgs[chat.msgs.length - 1];
      rows.push({
        accountId: acc.id,
        accountName: acc.name || acc.id,
        name: chat.name,
        preview: last ? msgPreview(last) : '',
        count,
        _sigKey: key,
      });
    }
  }
  return rows;
}

/* Открыть конкретный чат (переход из ленты/уведомления) */
function openChat(accountId, key) {
  _selChat.set(accountId, key);
  const unread = _chatUnread.get(accountId);
  unread?.delete(key);
  syncAccountBadge(accountId);
  try { setActiveAccount?.(accountId); } catch { /* ignore */ }
  render();
}

/* Вставка текста в композер активного signal-чата (шаблоны и т.п.) */
function insertText(text) {
  const account = accountById(_visibleAccountId);
  if (!account) return { ok: false, error: 'no_signal_account' };
  const live = _panel?.querySelector('.signal-composer-input');
  if (!live) return { ok: false, error: 'no_open_chat' };
  live.value += String(text || '');
  const selKey = _selChat.get(account.id) || '';
  _drafts.set(`${account.id}:${selKey}`, live.value);
  try { live.focus(); } catch { /* ignore */ }
  return { ok: true };
}

export const WaDeckSignalPanel = { init, setVisible, refresh: render, refreshAccount, insertText, getUnreadRows, openChat };
window.WaDeckSignalPanel = WaDeckSignalPanel;

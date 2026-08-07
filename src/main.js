const { app, BrowserWindow, dialog, ipcMain, shell, clipboard, session, Menu, webContents, powerMonitor, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const https = require('https');
const { pathToFileURL } = require('url');
const os = require('os');
const { transcribeVoiceAt, cleanupStaleModels } = require('./voice-transcribe');

/*
 * Keep WhatsApp/Telegram webviews online while hidden.
 *
 * Without these switches, Chromium throttles timers in hidden <webview>
 * renderers (display:none) and — critically — enables IntensiveWakeUpThrottling
 * after ~5 min, which clamps setInterval to 1/min. WhatsApp Web's
 * application-level heartbeat then misses a tick, the server drops the socket,
 * and the account "freezes" until the user re-selects it (re-showing the
 * webview wakes timers and WA reloads).
 *
 * Important: we intentionally DO NOT pass --disable-renderer-backgrounding.
 * A previous iteration used it and pegged CPU with many accounts, because it
 * pins every hidden renderer to foreground OS priority. The switches below
 * only affect timer throttling and occlusion detection — process priority is
 * still lowered by the OS, so CPU stays sane with 10–20 accounts while the
 * WebSocket heartbeat keeps ticking.
 */
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'IntensiveWakeUpThrottling,CalculateNativeWinOcclusion');

/**
 * Defense-in-depth: only allow attachment paths that live under the user's
 * home directory and don't touch known sensitive subtrees. A compromised
 * renderer (XSS) could otherwise schedule a message with `attachments: [{path:
 * '/Users/.../.ssh/id_rsa'}]` and exfiltrate secrets through the WA upload.
 */
/* Пути, которые пользователь ЯВНО выбрал через системный диалог — доверенный
 * жест. Позволяет вложения с диска D:/сетевых шар на Windows (homedir-гейт их
 * молча отклонял), не ослабляя защиту от XSS: renderer не может добавить сюда
 * произвольный путь, минуя диалог. Чистится по realpath. */
const _dialogPickedPaths = new Set();
async function rememberPickedPath(filePath) {
  try { _dialogPickedPaths.add(await fs.realpath(path.resolve(String(filePath || '')))); } catch { /* ignore */ }
}

async function isAttachmentPathAllowed(filePath) {
  try {
    const abs = path.resolve(String(filePath || ''));
    if (!abs) return false;
    // Явно выбранный через диалог путь — доверяем (после realpath-сверки).
    try {
      const rp = await fs.realpath(abs);
      if (_dialogPickedPaths.has(rp)) return true;
    } catch { /* не существует — упадёт ниже на общей проверке */ }
    // Resolve symlinks BEFORE the prefix/blocklist check. Otherwise a renderer
    // (post-XSS) could schedule `~/innocent` as a symlink to /etc/... or
    // ~/.ssh/id_rsa and pass a purely lexical "under home" test. realpath
    // throws if the target doesn't exist — attachments must exist, so reject.
    let real;
    try {
      real = await fs.realpath(abs);
    } catch {
      return false;
    }
    // realpath the home dir too: on machines where the home path traverses a
    // symlink (network/managed homes, macOS /var → /private/var style), the
    // resolved file never prefix-matches the unresolved home and every
    // attachment would be rejected.
    let home = os.homedir();
    try { home = await fs.realpath(home); } catch { /* keep unresolved */ }
    // macOS + Linux are case-sensitive on filenames but Windows is not;
    // normalize both sides for the prefix check.
    const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
    const realCmp = caseInsensitive ? real.toLowerCase() : real;
    const homeCmp = caseInsensitive ? home.toLowerCase() : home;
    if (!realCmp.startsWith(homeCmp + path.sep) && realCmp !== homeCmp) return false;
    const SENSITIVE = [
      '.ssh', '.gnupg', '.aws', '.docker', '.kube', '.config', '.netrc',
      '.npmrc', '.gem', '.cargo', 'Library/Keychains',
    ];
    for (const s of SENSITIVE) {
      const marker = (path.sep + s).toLowerCase();
      const needle = caseInsensitive ? realCmp : real;
      const needleMarker = caseInsensitive ? marker : (path.sep + s);
      if (needle.includes(needleMarker + path.sep) || needle.endsWith(needleMarker)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

const APP_ID = 'com.local.wadeck';
const APP_TITLE = 'WA Deck';
const FALLBACK_CHROME_VERSION = '146.0.7680.188';
const APP_ICON_PNG_PATH = path.join(__dirname, '..', 'assets', 'icon', 'wadeck-icon-512.png');
const RELEASES_LATEST_URL = 'https://github.com/tamilamokrousova0/WA-Deck/releases/latest';

let _appIsQuitting = false;

const DEFAULT_SETTINGS = {
  uiTheme: 'dark',
  // Sidebar/hub tile colors: 'raw' = user color as-is, 'calm' = normalized
  // blend (hue kept, luminance unified) — opt-in Tweaks toggle.
  uiTiles: 'raw',
  weatherCity: 'Moscow',
  weatherUnit: 'celsius',
  lastSeenReleaseNotesVersion: '',
  translatorEnabled: true,
  notificationsEnabled: true,
  crmHoverEnabled: true,
  uiScene: 'night',
  uiDensity: 'compact',
  tweaksCollapsed: false,
  // Hibernation: 0 = off (default). When > 0, non-pinned non-active webviews
  // that have been idle for at least this many minutes are unloaded from
  // memory. They reload automatically on next click. Trade-off: while a
  // webview is hibernated, that account does NOT receive incoming messages
  // (the renderer process is gone). Pinned accounts and the active account
  // are never hibernated.
  hibernateAfterMinutes: 0,
  worldClocks: [
    { label: 'Москва', tz: 'Europe/Moscow' },
    { label: 'Киев', tz: 'Europe/Kiev' },
    { label: 'Берлин', tz: 'Europe/Berlin' },
  ],
  // Per-account тумблер «Авто вх. → Русский» (accountId → true).
  autoTranslateAccounts: {},
  // Батчинг автоперевода входящих: пачка сообщений одним запросом.
  translateBatchEnabled: true,
  // Сервер расшифровки голосовых (whisper-server, tailnet Mac mini).
  // Недоступен (нет Tailscale/сервер выключен) — тихий фолбэк на локальную
  // модель. Пустая строка в сторе = юзер сознательно выбрал локально.
  transcribeServerUrl: 'http://100.69.224.117:8790',
};

const VALID_HIBERNATE_MINUTES = [0, 30, 60, 120, 240];

function normalizeHibernateMinutes(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (VALID_HIBERNATE_MINUTES.includes(n)) return n;
  return fallback;
}

function normalizeBool(value, fallback) {
  if (value === true || value === false) return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return fallback;
}

function normalizeWeatherUnit(value) {
  return String(value || '').toLowerCase() === 'fahrenheit' ? 'fahrenheit' : 'celsius';
}

function buildWhatsAppUserAgent() {
  const chromeVersion = process.versions.chrome || FALLBACK_CHROME_VERSION;
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

const WA_USER_AGENT = buildWhatsAppUserAgent();
app.userAgentFallback = WA_USER_AGENT;

const COLOR_PALETTE = ['#0ea5e9', '#22c55e', '#f97316', '#8b5cf6', '#14b8a6', '#ec4899', '#eab308', '#6366f1'];

// Проверка орфографии: основные языки набора. На macOS список игнорируется —
// там работает системный спеллчекер с автоопределением языка; на Windows
// Chromium скачивает hunspell-словари для этих языков при первом запуске.
const SPELLCHECK_LANGUAGES = ['ru', 'en-US'];

const state = {
  paths: {
    userData: '',
    storePath: '',
    crmDir: '',
  },
  store: {
    accounts: [],
    settings: { ...DEFAULT_SETTINGS },
    templates: [],
    scheduled: [],
    // Favorite contacts: [{ accountId, name }]. Surfaced as toolbar chips +
    // a hub filter; toggled from the CRM drawer star.
    favorites: [],
    // Important contacts: [{ accountId, name }]. Same surfaces in blue;
    // mutually exclusive with favorites (toggled from the CRM drawer diamond).
    important: [],
    // Per-contact default outgoing translation language.
    // Key: `${accountId}\u0000${chatName}` → lang code (e.g. "de").
    contactLangs: {},
  },
};

let mainWindow;
let lastUpdateProgressPercent = -1;
let autoUpdaterConfigured = false;
let macDeveloperIdSignatureCache = null;
// True only after an update has actually finished downloading (set by the
// electron-updater 'update-downloaded' event or by the custom mac flow).
// install-downloaded-update checks it BEFORE destroying any windows.
let updateDownloaded = false;

// Sessions that already have a permission handler installed (avoid re-setting
// on every web-contents-created for the same partition session).
const _permissionConfiguredSessions = new WeakSet();
// Permissions WhatsApp/Telegram Web legitimately need (voice/video calls,
// voice messages, desktop notifications, copy). Everything else (geolocation,
// midi, display-capture, clipboard-read, openExternal, ...) is denied so a
// hijacked remote page can't silently grab it — Electron's default for
// non-default sessions is to GRANT most requests.
const ALLOWED_WEBVIEW_PERMISSIONS = new Set([
  'media',
  'notifications',
  'fullscreen',
  'pointerLock',
  'clipboard-sanitized-write',
  'speaker-selection',
]);

function setDockBadge(count, badgeDataUrl) {
  const safeCount = Math.max(0, Number(count) || 0);
  if (process.platform === 'darwin') {
    const badge = safeCount > 0 ? String(safeCount) : '';
    try {
      if (app.dock) {
        app.dock.setBadge(badge);
      }
    } catch (e) {
      console.warn('[dock-badge] dock.setBadge error:', e?.message);
    }
    try {
      app.setBadgeCount(safeCount);
    } catch (e) {
      console.warn('[dock-badge] setBadgeCount error:', e?.message);
    }
    return { ok: true, count: safeCount };
  }
  if (process.platform === 'win32') {
    // app.setBadgeCount is a no-op on Windows — the taskbar equivalent is an
    // overlay icon. The renderer supplies a canvas-drawn PNG circle with the
    // count (main has no canvas to draw one itself).
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const url = String(badgeDataUrl || '');
        if (safeCount > 0 && url.startsWith('data:image/png;base64,') && url.length < 65536) {
          const img = nativeImage.createFromDataURL(url);
          if (!img.isEmpty()) {
            mainWindow.setOverlayIcon(img, `${safeCount} непрочитанных`);
          }
        } else {
          mainWindow.setOverlayIcon(null, '');
        }
      }
    } catch (e) {
      console.warn('[dock-badge] setOverlayIcon error:', e?.message);
    }
    return { ok: true, count: safeCount };
  }
  try {
    app.setBadgeCount(safeCount);
  } catch (e) {
    console.warn('[dock-badge] setBadgeCount error:', e?.message);
  }
  return { ok: true, count: safeCount };
}

function ensurePaths() {
  const userData = app.getPath('userData');
  state.paths.userData = userData;
  state.paths.storePath = path.join(userData, 'wa-deck-store.json');
  state.paths.crmDir = path.join(userData, 'crm-contacts');

  if (!fsSync.existsSync(userData)) {
    fsSync.mkdirSync(userData, { recursive: true });
  }
  if (!fsSync.existsSync(state.paths.crmDir)) {
    fsSync.mkdirSync(state.paths.crmDir, { recursive: true });
  }

  migrateLegacyStoreIfNeeded();
}

function legacyUserDataCandidates(currentUserData) {
  const appData = app.getPath('appData');
  const normalizedCurrent = path.resolve(currentUserData);
  const candidates = new Set();

  const knownNames = ['WA Deck', 'wa-deck', 'WA-Deck', 'wa_deck', 'wadeck', 'wa deck'];
  for (const name of knownNames) {
    const candidate = path.join(appData, name);
    if (path.resolve(candidate) !== normalizedCurrent) {
      candidates.add(candidate);
    }
  }

  try {
    const entries = fsSync.readdirSync(appData, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/wa|deck/i.test(entry.name)) continue;
      const candidate = path.join(appData, entry.name);
      if (path.resolve(candidate) !== normalizedCurrent) {
        candidates.add(candidate);
      }
    }
  } catch {
    // ignore scan errors
  }

  return Array.from(candidates).filter((candidate) => fsSync.existsSync(candidate));
}

function migrateLegacyStoreIfNeeded() {
  if (fsSync.existsSync(state.paths.storePath)) {
    return;
  }

  const candidates = legacyUserDataCandidates(state.paths.userData);
  let best = null;

  for (const candidateDir of candidates) {
    const candidateStore = path.join(candidateDir, 'wa-deck-store.json');
    if (!fsSync.existsSync(candidateStore)) continue;
    try {
      const stat = fsSync.statSync(candidateStore);
      const mtimeMs = Number(stat.mtimeMs || 0);
      if (!best || mtimeMs > best.mtimeMs) {
        best = {
          dir: candidateDir,
          storePath: candidateStore,
          mtimeMs,
        };
      }
    } catch {
      // ignore stat errors
    }
  }

  if (!best) {
    return;
  }

  try {
    fsSync.copyFileSync(best.storePath, state.paths.storePath);

    const legacyCrmDir = path.join(best.dir, 'crm-contacts');
    const targetCrmEmpty =
      !fsSync.existsSync(state.paths.crmDir) ||
      (() => {
        try {
          return fsSync.readdirSync(state.paths.crmDir).length === 0;
        } catch {
          return true;
        }
      })();
    if (fsSync.existsSync(legacyCrmDir) && targetCrmEmpty) {
      fsSync.cpSync(legacyCrmDir, state.paths.crmDir, { recursive: true });
    }
  } catch {
    // ignore migration errors
  }
}

function pickColor(index) {
  return COLOR_PALETTE[Math.abs(index) % COLOR_PALETTE.length];
}

function sanitizeStore(raw) {
  const clean = {
    accounts: Array.isArray(raw?.accounts) ? raw.accounts : [],
    settings: {
      ...DEFAULT_SETTINGS,
      ...(raw?.settings || {}),
    },
    templates: Array.isArray(raw?.templates) ? raw.templates : [],
    scheduled: Array.isArray(raw?.scheduled) ? raw.scheduled : [],
  };

  clean.settings.uiTheme = String(clean.settings.uiTheme || 'dark').toLowerCase() === 'light' ? 'light' : 'dark';
  clean.settings.uiTiles = String(clean.settings.uiTiles || 'raw').toLowerCase() === 'calm' ? 'calm' : 'raw';
  clean.settings.lastSeenReleaseNotesVersion = String(
    clean.settings.lastSeenReleaseNotesVersion || DEFAULT_SETTINGS.lastSeenReleaseNotesVersion,
  ).trim();
  clean.settings.weatherCity = String(clean.settings.weatherCity || DEFAULT_SETTINGS.weatherCity).trim() || DEFAULT_SETTINGS.weatherCity;
  {
    const v = String(clean.settings.transcribeServerUrl || '').trim().slice(0, 200);
    clean.settings.transcribeServerUrl = /^https?:\/\/\S+$/i.test(v) ? v.replace(/\/+$/, '') : '';
  }
  clean.settings.weatherUnit = normalizeWeatherUnit(clean.settings.weatherUnit);
  clean.settings.translatorEnabled = normalizeBool(clean.settings.translatorEnabled, DEFAULT_SETTINGS.translatorEnabled);
  clean.settings.notificationsEnabled = normalizeBool(clean.settings.notificationsEnabled, DEFAULT_SETTINGS.notificationsEnabled);
  clean.settings.crmHoverEnabled = normalizeBool(clean.settings.crmHoverEnabled, DEFAULT_SETTINGS.crmHoverEnabled);
  clean.settings.translateBatchEnabled = normalizeBool(clean.settings.translateBatchEnabled, DEFAULT_SETTINGS.translateBatchEnabled);
  clean.settings.hibernateAfterMinutes = normalizeHibernateMinutes(
    clean.settings.hibernateAfterMinutes,
    DEFAULT_SETTINGS.hibernateAfterMinutes,
  );
  const validScenes = ['night', 'day', 'rain', 'space', 'minimal'];
  clean.settings.uiScene = validScenes.includes(String(clean.settings.uiScene)) ? clean.settings.uiScene : DEFAULT_SETTINGS.uiScene;
  const validDensity = ['compact', 'cozy', 'spacious'];
  clean.settings.uiDensity = validDensity.includes(String(clean.settings.uiDensity)) ? clean.settings.uiDensity : DEFAULT_SETTINGS.uiDensity;
  clean.settings.tweaksCollapsed = normalizeBool(clean.settings.tweaksCollapsed, DEFAULT_SETTINGS.tweaksCollapsed);

  clean.accounts = clean.accounts
    .map((item, index) => ({
      id: String(item?.id || `wa_${Date.now()}_${index}`),
      type: item?.type === 'telegram' ? 'telegram' : 'whatsapp',
      name: String(item?.name || `WP_${index + 1}`),
      color: String(item?.color || pickColor(index + 1)),
      iconPath: String(item?.iconPath || '').trim(),
      frozen: Boolean(item?.frozen),
      pinned: Boolean(item?.pinned),
      order: Math.max(1, Number(item?.order) || index + 1),
      createdAt: String(item?.createdAt || new Date().toISOString()),
    }))
    .sort((a, b) => {
      const orderDiff = Number(a.order || 0) - Number(b.order || 0);
      if (orderDiff !== 0) return orderDiff;
      return String(a.createdAt).localeCompare(String(b.createdAt));
    })
    .map((item, index) => ({
      ...item,
      order: index + 1,
    }));

  clean.templates = clean.templates
    .map((item, index) => {
      const text = String(item?.text || '').replace(/\r/g, '');
      const title = String(item?.title || '').trim();
      const createdAt = String(item?.createdAt || new Date().toISOString());
      const updatedAt = String(item?.updatedAt || createdAt);
      const category = String(item?.category || '').trim().slice(0, 60);
      return {
        id: String(item?.id || `tpl_${Date.now()}_${index}_${crypto.randomBytes(2).toString('hex')}`),
        title: title || `Шаблон ${index + 1}`,
        text,
        category,
        createdAt,
        updatedAt,
      };
    })
    .filter((item) => String(item.text || '').trim() || String(item.title || '').trim())
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  clean.scheduled = clean.scheduled
    .map((item) => ({
      id: String(item?.id || ''),
      accountId: String(item?.accountId || ''),
      chatName: String(item?.chatName || '').trim(),
      text: String(item?.text || ''),
      attachments: Array.isArray(item?.attachments)
        ? item.attachments
            .map((att) => ({
              path: String(att?.path || ''),
              name: String(att?.name || path.basename(String(att?.path || ''))),
            }))
            .filter((att) => att.path)
        : [],
      sendAt: String(item?.sendAt || ''),
      // Recurrence: baseSendAt is the canonical (jitter-free) occurrence time
      // the next occurrence is computed from; repeatSpawned guards against
      // spawning the next occurrence twice when an item is retried.
      repeat: ['daily', 'weekdays', 'weekly'].includes(String(item?.repeat || '')) ? String(item.repeat) : '',
      jitterMinutes: Math.max(0, Math.min(60, Math.round(Number(item?.jitterMinutes) || 0))),
      baseSendAt: String(item?.baseSendAt || ''),
      repeatSpawned: Boolean(item?.repeatSpawned),
      status: ['pending', 'processing', 'sent', 'failed', 'canceled'].includes(String(item?.status || ''))
        ? String(item.status)
        : 'pending',
      claimedAt: String(item?.claimedAt || ''),
      createdAt: String(item?.createdAt || new Date().toISOString()),
      updatedAt: String(item?.updatedAt || new Date().toISOString()),
      errorText: String(item?.errorText || ''),
    }))
    .filter((item) => item.id && item.accountId && item.chatName && item.sendAt);

  clean.contactLangs = {};
  const rawLangs = (raw?.contactLangs && typeof raw.contactLangs === 'object' && !Array.isArray(raw.contactLangs))
    ? raw.contactLangs : {};
  for (const [k, v] of Object.entries(rawLangs)) {
    if (Object.keys(clean.contactLangs).length >= 5000) break; // cap (как в set-contact-lang)
    const code = String(v || '').trim();
    if (k && /^[a-z-]{2,10}$/i.test(code)) clean.contactLangs[String(k)] = code;
  }

  // Учёт использования шаблонов (умный порядок слэш-списка): title → {c,t}.
  clean.templateUsage = {};
  const rawUsage = (raw?.templateUsage && typeof raw.templateUsage === 'object' && !Array.isArray(raw.templateUsage))
    ? raw.templateUsage : {};
  for (const [k, v] of Object.entries(rawUsage)) {
    if (Object.keys(clean.templateUsage).length >= 500) break;
    const c = Number(v?.c) || 0;
    const t = Number(v?.t) || 0;
    if (k && c > 0) clean.templateUsage[String(k).slice(0, 120)] = { c, t };
  }

  // Санитайзер загрузки — единый источник правды и для полей, которые раньше
  // клампались только в save-settings (дрейф load-vs-save = тихая порча).
  // worldClocks: массив {label, tz}, ≤10.
  clean.settings.worldClocks = (Array.isArray(clean.settings.worldClocks)
    ? clean.settings.worldClocks : DEFAULT_SETTINGS.worldClocks)
    .slice(0, 10)
    .map((c) => ({ label: String(c?.label || '').trim().slice(0, 30), tz: String(c?.tz || '').trim().slice(0, 64) }))
    .filter((c) => c.label && c.tz);
  // autoTranslateAccounts: карта accountId→true, ≤100 ключей, ключ ≤64.
  {
    const src = (clean.settings.autoTranslateAccounts && typeof clean.settings.autoTranslateAccounts === 'object'
      && !Array.isArray(clean.settings.autoTranslateAccounts)) ? clean.settings.autoTranslateAccounts : {};
    const out = {};
    for (const key of Object.keys(src).slice(0, 100)) {
      if (src[key]) out[String(key).slice(0, 64)] = true;
    }
    clean.settings.autoTranslateAccounts = out;
  }

  /* Favorite contacts — clamp names, drop orphans (deleted accounts), dedupe
     by `${accountId}::${lowercased name}` and cap at LIMITS.FAVORITES_PER_USER. */
  const accountIds = new Set(clean.accounts.map((acc) => acc.id));
  clean.favorites = [];
  const seenFav = new Set();
  const rawFav = Array.isArray(raw?.favorites) ? raw.favorites : [];
  for (const f of rawFav) {
    if (clean.favorites.length >= LIMITS.FAVORITES_PER_USER) break;
    const accountId = String(f?.accountId || '').trim();
    const name = clampString(String(f?.name || '').trim(), LIMITS.CHAT_NAME);
    if (!accountId || !name || !accountIds.has(accountId)) continue;
    const key = accountId + '::' + name.toLowerCase();
    if (seenFav.has(key)) continue;
    seenFav.add(key);
    clean.favorites.push({ accountId, name });
  }

  /* Important contacts — same clamp/orphan/dedupe/cap rules as favorites. */
  clean.important = [];
  const seenImp = new Set();
  const rawImp = Array.isArray(raw?.important) ? raw.important : [];
  for (const f of rawImp) {
    if (clean.important.length >= LIMITS.IMPORTANT_PER_USER) break;
    const accountId = String(f?.accountId || '').trim();
    const name = clampString(String(f?.name || '').trim(), LIMITS.CHAT_NAME);
    if (!accountId || !name || !accountIds.has(accountId)) continue;
    const key = accountId + '::' + name.toLowerCase();
    if (seenImp.has(key)) continue;
    seenImp.add(key);
    clean.important.push({ accountId, name });
  }

  return clean;
}

const STORE_MAX_SIZE = 50 * 1024 * 1024; // 50 MB — soft threshold, only logs a warning
// Hard cap purely as an OOM guard. An oversized store is still user data —
// we load it anyway and let pruneFinishedScheduled() shrink it back, instead
// of throwing it away (which used to end with BOTH files overwritten empty).
const STORE_HARD_MAX_SIZE = 200 * 1024 * 1024; // 200 MB

// Centralized size limits for user-supplied payloads coming from the renderer.
// These protect main-process memory and disk from XSS or runaway renderer
// state. Most fields are far larger than any legitimate WA message/template,
// so real users won't notice.
const LIMITS = {
  ACCOUNT_NAME: 60,
  CONTACT_NAME: 120,
  CHAT_NAME: 200,
  TEMPLATE_TITLE: 120,
  TEMPLATE_TEXT: 50000,        // 50K chars — WA message limit is ~65K
  TEMPLATE_CATEGORY: 60,
  CRM_TEXT: 50000,             // each of about/myInfo
  CLIPBOARD_TEXT: 200000,
  TRANSLATE_TEXT: 20000,       // Google Translate's hard cap is 5K; we're generous
  MESSAGE_TEXT: 65000,
  SCHEDULED_PER_USER: 2000,    // total pending+processing items
  TEMPLATES_PER_USER: 5000,
  ATTACHMENTS_PER_MSG: 30,
  FAVORITES_PER_USER: 200,
  IMPORTANT_PER_USER: 200,
};

function clampString(val, maxLen) {
  const s = String(val || '');
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function loadStoreFromPath(storePath) {
  const stat = await fs.stat(storePath);
  if (!stat.isFile()) throw new Error('store is not a file');
  if (stat.size > STORE_HARD_MAX_SIZE) {
    throw new Error(`store too large: ${stat.size} bytes > ${STORE_HARD_MAX_SIZE}`);
  }
  if (stat.size > STORE_MAX_SIZE) {
    console.warn(`[WA-Deck] store is oversized (${stat.size} bytes), loading anyway — prune will shrink it`);
  }
  const content = await fs.readFile(storePath, 'utf8');
  return JSON.parse(content);
}

/* Move an unreadable/corrupt store file aside (wa-deck-store.json.corrupt-<ts>)
 * so the data stays recoverable. Without this, the next saveStore() — which
 * bootstrap calls unconditionally — would overwrite the broken-but-maybe-
 * repairable file with an empty store. */
function quarantineCorruptStoreFile(filePath) {
  try {
    if (!fsSync.existsSync(filePath)) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${filePath}.corrupt-${stamp}`;
    fsSync.renameSync(filePath, target);
    console.warn(`[WA-Deck] quarantined corrupt store file: ${target}`);
  } catch (err) {
    console.warn('[WA-Deck] failed to quarantine corrupt store file:', err?.message || err);
  }
}

/* Set when loadStore() had to quarantine a corrupt store, recover from the
 * .backup, or reset to an empty store. cleanupOrphanPartitions() must not run
 * in that state: a reset store has an (almost) empty account list, so the
 * cleanup would rm -rf every existing wa_/tg_ login session as "orphaned".
 * The flag costs one skipped cleanup; the next healthy launch catches up. */
let storeLoadDegraded = false;

async function loadStore() {
  const primary = state.paths.storePath;
  const backup = primary + '.backup';

  try {
    if (!fsSync.existsSync(primary)) {
      // First run — check if we have a leftover backup from an interrupted
      // previous session and recover from it instead of starting fresh.
      if (fsSync.existsSync(backup)) {
        try {
          const parsed = await loadStoreFromPath(backup);
          state.store = sanitizeStore(parsed);
          console.warn('[WA-Deck] Primary store missing, recovered from .backup');
          await saveStore(); // re-create primary
          return;
        } catch {
          // Keep the broken backup recoverable instead of overwriting it later
          quarantineCorruptStoreFile(backup);
          storeLoadDegraded = true;
        }
      }
      state.store = sanitizeStore(null);
      return;
    }

    const parsed = await loadStoreFromPath(primary);
    state.store = sanitizeStore(parsed);
  } catch (err) {
    console.warn('[WA-Deck] Primary store load failed:', err?.message || err);
    storeLoadDegraded = true;
    // Preserve the unreadable primary before anything can overwrite it
    quarantineCorruptStoreFile(primary);
    // Primary corrupt or oversized — try the .backup as a lifeline
    if (fsSync.existsSync(backup)) {
      try {
        const parsed = await loadStoreFromPath(backup);
        state.store = sanitizeStore(parsed);
        console.warn('[WA-Deck] Recovered store from .backup');
        return;
      } catch (backupErr) {
        console.warn('[WA-Deck] Backup also unreadable:', backupErr?.message || backupErr);
        quarantineCorruptStoreFile(backup);
      }
    }
    state.store = sanitizeStore(null);
  }
}

/* ── Prune finished scheduled items ──────────────────────────────────────
 * sent/failed/canceled records used to live in store.json forever and bloat
 * it without bound. Drop finished records older than 14 days, plus a hard
 * cap: keep at most the newest 1000 finished records. pending/processing
 * items are never touched. */
const FINISHED_SCHEDULED_STATUSES = new Set(['sent', 'failed', 'canceled']);
const FINISHED_SCHEDULED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const FINISHED_SCHEDULED_MAX_COUNT = 1000;

function pruneFinishedScheduled() {
  const items = state.store.scheduled;
  if (!Array.isArray(items) || !items.length) return 0;
  const now = Date.now();
  let kept = items.filter((item) => {
    if (!FINISHED_SCHEDULED_STATUSES.has(item.status)) return true;
    const stamp = new Date(item.updatedAt || item.createdAt || 0).getTime() || 0;
    return (now - stamp) <= FINISHED_SCHEDULED_MAX_AGE_MS;
  });
  const finished = kept
    .filter((item) => FINISHED_SCHEDULED_STATUSES.has(item.status))
    .sort((a, b) => (new Date(b.updatedAt || 0).getTime() || 0) - (new Date(a.updatedAt || 0).getTime() || 0));
  if (finished.length > FINISHED_SCHEDULED_MAX_COUNT) {
    const drop = new Set(finished.slice(FINISHED_SCHEDULED_MAX_COUNT).map((item) => item.id));
    kept = kept.filter((item) => !drop.has(item.id));
  }
  const removed = items.length - kept.length;
  if (removed > 0) {
    state.store.scheduled = kept;
    console.log(`[scheduled] pruned ${removed} finished item(s)`);
  }
  return removed;
}

// A scheduled item is flipped to 'processing' the moment it's claimed for
// sending. If the renderer reloads/crashes between claim and complete, the
// boot-time recovery used to be the ONLY thing that reset it — so a renderer
// reload (Cmd+R, no main-process restart) left the message stuck forever. We
// now also sweep at runtime: any 'processing' item older than this is returned
// to 'pending' and retried. Since the renderer only reports success AFTER the
// WA send, a still-'processing' item almost always means the send never
// happened, so retrying is safe; the rare double-send window is app death in
// the few ms between WA send and the persisted 'sent' status.
// 20 минут (было 5): большое вложение (до 100 МБ) на медленном канале грузится
// в WhatsApp дольше 5 мин, и сброс processing→pending запускал ВТОРУЮ отправку
// тому же контакту (видимый дубль). 20 мин заведомо больше любой легитимной
// отправки, но всё ещё восстанавливает реально зависшие после краха.
const STALE_PROCESSING_MS = 20 * 60 * 1000; // 20 minutes

/* Recover scheduled messages stuck in 'processing'.
 * maxAgeMs = 0  → reset ALL processing items (use at boot: a restart means
 *                 nothing is genuinely in-flight).
 * maxAgeMs > 0  → reset only items claimed longer than maxAgeMs ago
 *                 (runtime sweep; leaves freshly-claimed sends alone). */
function recoverStaleProcessingItems(maxAgeMs = 0) {
  let recovered = 0;
  const now = Date.now();
  for (const item of state.store.scheduled) {
    if (item.status !== 'processing') continue;
    if (maxAgeMs > 0) {
      const claimedMs = item.claimedAt ? new Date(item.claimedAt).getTime() : 0;
      // A valid, recent claim is left alone; missing/old claimedAt = stale.
      if (claimedMs && (now - claimedMs) < maxAgeMs) continue;
    }
    item.status = 'pending';
    item.claimedAt = '';
    item.updatedAt = new Date().toISOString();
    recovered += 1;
  }
  if (recovered > 0) {
    console.log(`[scheduled] recovered ${recovered} stuck processing item(s) back to pending`);
    saveStore().catch(() => {});
  }
  return recovered;
}

/* Write queue prevents concurrent fs.writeFile calls that can corrupt the store */
let _saveStoreQueue = Promise.resolve();

/* ── Store loss-protection ────────────────────────────────────────────────
 * .backup is refreshed from the SAME in-memory payload as the primary, so a
 * logically-poisoned state (accounts suddenly []) clobbers both copies at
 * once — the one failure class the corrupt-file recovery can't see.
 *   Wipe-guard: a payload with 0 accounts after a session that loaded N>0 is
 *   blocked unless the last account was explicitly removed; the rejected
 *   payload is preserved as .suspect for post-mortem.
 *   Daily snapshots: the first write of each day first copies the on-disk
 *   primary to .snap-YYYYMMDD (7 kept) — a time machine against slow rot. */
const STORE_SNAPSHOT_KEEP = 7;
/* LRU-кэш переводов: ключ from|to|text (см. handle('translate-text')) */
const TRANSLATE_CACHE_MAX = 2000;
const _translateCache = new Map();
/* Keep-alive агент: переиспользует TCP+TLS-соединение к переводчику вместо
 * нового рукопожатия (~150-300 мс) на каждый запрос — критично при
 * автопереводе пачки входящих. maxSockets ограничивает параллелизм. */
const _translateAgent = new (require('https').Agent)({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 8,
});

/* ── Батчинг автоперевода входящих (opt-out в настройках) ─────────────────
 * Пачка видимых сообщений при открытии чата раньше уходила 10-15 отдельными
 * HTTP-запросами. Запросы с batch:true копятся 120 мс и уезжают одним вызовом
 * с разделителем; при рассинхроне частей — прозрачный фолбэк по одному. */
const TRANSLATE_BATCH_SEP = '\n@@@@@\n';
const TRANSLATE_BATCH_SPLIT_RE = /\s*@{3,}\s*/;
const TRANSLATE_BATCH_WAIT_MS = 120;
const TRANSLATE_BATCH_MAX_ITEMS = 10;
const TRANSLATE_BATCH_MAX_CHARS = 3000;
const _trBatchQueues = new Map(); // `${from}|${to}` → {items:[{text,cacheKey,resolve}],chars,timer}

function _translateCacheSet(cacheKey, value) {
  if (!value) return;
  _translateCache.set(cacheKey, value);
  if (_translateCache.size > TRANSLATE_CACHE_MAX) {
    _translateCache.delete(_translateCache.keys().next().value);
  }
}

const _trIsTransient = (e) => /timeout|ECONN|EAI_AGAIN|socket|http_(5\d\d|429)/i.test(String(e?.message || ''));
const _trWithDeadline = (p, ms) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout_queue')), ms)),
]);

/* Один HTTP-запрос к переводчику. Возвращает { translated, detected } —
 * detected (определённый язык источника) раньше выбрасывался, теперь питает
 * автоопределение языка контакта в translator-bar. */
function _translateFetchRaw(q, from, to) {
  const https = require('https');
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(q)}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      agent: _translateAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`http_${res.statusCode}`));
        return;
      }
      let data = '';
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 5 * 1024 * 1024) { req.destroy(new Error('response_too_large')); return; }
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const translated = (parsed[0] || []).map((s) => s[0]).filter(Boolean).join('');
          const detected = String(parsed[2] || '').toLowerCase().slice(0, 10);
          resolve({ translated, detected });
        } catch (e) {
          reject(new Error('parse_failed'));
        }
      });
    });
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

/* Дедлайн поверх очереди агента + один быстрый ретрай на транзиентном сбое. */
async function _translateFetchRetry(q, from, to) {
  try {
    return await _trWithDeadline(_translateFetchRaw(q, from, to), 15000);
  } catch (e1) {
    if (!_trIsTransient(e1)) throw e1;
    await new Promise((r) => setTimeout(r, 250));
    return _trWithDeadline(_translateFetchRaw(q, from, to), 15000);
  }
}

async function _flushTranslateBatch(key) {
  const q = _trBatchQueues.get(key);
  if (!q) return;
  _trBatchQueues.delete(key);
  if (q.timer) clearTimeout(q.timer);
  const items = q.items;
  const sep = key.indexOf('|');
  const from = key.slice(0, sep);
  const to = key.slice(sep + 1);

  if (items.length > 1) {
    try {
      const joined = items.map((it) => it.text).join(TRANSLATE_BATCH_SEP);
      const { translated, detected } = await _translateFetchRetry(joined, from, to);
      const parts = translated.split(TRANSLATE_BATCH_SPLIT_RE);
      if (parts.length === items.length) {
        items.forEach((it, i) => {
          const t = String(parts[i] || '').trim();
          _translateCacheSet(it.cacheKey, t);
          it.resolve({ ok: Boolean(t), translated: t, detected });
        });
        return;
      }
      console.warn(`[translate-batch] split mismatch ${parts.length}/${items.length} — falling back per-item`);
    } catch (e) {
      console.warn('[translate-batch] batch failed — falling back per-item:', e?.message || e);
    }
  }
  // Один элемент или фолбэк — по одному
  for (const it of items) {
    try {
      const r = await _translateFetchRetry(it.text, from, to);
      _translateCacheSet(it.cacheKey, r.translated);
      it.resolve({ ok: Boolean(r.translated), translated: r.translated, detected: r.detected });
    } catch (e) {
      it.resolve({ ok: false, error: String(e?.message || 'translate_failed') });
    }
  }
}
let _lastGoodAccountCount = 0;
let _allowEmptyAccountsSave = false;
let _snapshotDay = '';

function markIntentionalLastAccountRemoval() {
  _allowEmptyAccountsSave = true;
}

function rotateDailyStoreSnapshot(primary) {
  const day = new Date().toISOString().slice(0, 10);
  if (_snapshotDay === day) return;
  _snapshotDay = day;
  try {
    if (!fsSync.existsSync(primary)) return;
    const snapPath = `${primary}.snap-${day.replace(/-/g, '')}`;
    if (!fsSync.existsSync(snapPath)) {
      fsSync.copyFileSync(primary, snapPath);
    }
    const dir = path.dirname(primary);
    const prefix = `${path.basename(primary)}.snap-`;
    const snaps = fsSync.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
    for (const old of snaps.slice(0, Math.max(0, snaps.length - STORE_SNAPSHOT_KEEP))) {
      try { fsSync.unlinkSync(path.join(dir, old)); } catch { /* best-effort */ }
    }
  } catch (err) {
    console.warn('[saveStore] daily snapshot failed (non-fatal):', err?.message || err);
  }
}

/* Рекурсивное удаление с ретраем: на Windows Chromium/AV держат файлы
 * партиции (LevelDB, Cookies, Cache) эксклюзивно залоченными сразу после
 * закрытия сессии → EBUSY/EPERM/ENOTEMPTY. Даём хэндлам освободиться. */
async function rmWithRetry(target, opts = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rm(target, { recursive: true, force: true, ...opts });
      return true;
    } catch (err) {
      lastErr = err;
      const code = String(err?.code || '');
      if (process.platform !== 'win32'
        || (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOTEMPTY')) break;
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
  if (lastErr) throw lastErr;
  return false;
}

/* Atomic file write: tmp file + fsync + rename. Shared by the store and the
 * CRM contact files so a crash mid-write never leaves a truncated file.
 * На Windows антивирус/индексатор может держать целевой файл открытым в момент
 * rename → EPERM/EBUSY; ретраим с backoff, чтобы не терять запись. */
async function writeFileAtomic(filePath, data) {
  const tmpPath = `${filePath}.tmp-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const handle = await fs.open(tmpPath, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    try { await handle.sync(); } catch { /* fsync best-effort */ }
  } finally {
    await handle.close();
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      const code = String(err?.code || '');
      if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) break;
      await new Promise((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
  try { await fs.rm(tmpPath, { force: true }); } catch { /* leave tmp for diagnosis */ }
  throw lastErr;
}

/* Coalescing: a queued-but-not-started write already covers every mutation
 * made before it runs (the payload snapshot happens inside the closure), so
 * bursts of micro-mutations (favorite toggle, lang set, snooze) share one
 * trailing write instead of each paying full-store serialization + double
 * disk IO. */
let _saveStorePending = null;

async function saveStore() {
  if (_saveStorePending) return _saveStorePending;
  const run = _saveStoreQueue.then(async () => {
    _saveStorePending = null; // snapshot taken now — later mutations need a new write
    const payload = JSON.stringify(state.store, null, 2);
    const primary = state.paths.storePath;
    const backupPath = primary + '.backup';

    const accountCount = Array.isArray(state.store?.accounts) ? state.store.accounts.length : 0;
    if (accountCount === 0 && _lastGoodAccountCount > 0 && !_allowEmptyAccountsSave) {
      try { await writeFileAtomic(`${primary}.suspect`, payload); } catch { /* best-effort */ }
      const msg = `[saveStore] WIPE-GUARD: session loaded ${_lastGoodAccountCount} account(s), `
        + 'new payload has 0 without an explicit removal — write blocked, payload saved to .suspect';
      console.error(msg);
      throw new Error('store wipe-guard: refusing to persist empty accounts list');
    }

    rotateDailyStoreSnapshot(primary);

    // Atomic write sequence:
    //   1. Write new content to .tmp and fsync it to disk
    //   2. Rename .tmp → primary (atomic on POSIX; close-enough on NTFS)
    //   3. Refresh .backup from the SAME in-memory payload
    // We deliberately do NOT copy the on-disk primary into .backup: if the
    // primary was ever corrupt (and we recovered from .backup at load time),
    // copying it would clobber the only good backup. Writing .backup from the
    // known-good payload after the primary is safely in place keeps the
    // invariant "at least one of {primary, backup} is valid" at every crash
    // point.
    await writeFileAtomic(primary, payload);
    try {
      await fs.writeFile(backupPath, payload, 'utf8');
    } catch (err) {
      console.warn('[saveStore] backup refresh failed (non-fatal):', err?.message || err);
    }
    // A write that passed the guard is by definition legitimate — adopt its
    // count as the new baseline (incl. 0 after an explicit last-account
    // removal, otherwise every following settings save would be blocked).
    _lastGoodAccountCount = accountCount;
    _allowEmptyAccountsSave = false;
  });
  _saveStorePending = run;
  // The caller sees the rejection (so IPC handlers don't report ok:true on
  // ENOSPC), but the queue itself swallows it so the next write still runs.
  _saveStoreQueue = run.catch((err) => {
    console.error('[saveStore] write failed:', err);
  });
  return run;
}

function nextWpIndex() {
  let max = 0;
  for (const account of state.store.accounts) {
    const match = String(account.name).match(/^WP_(\d+)$/i);
    if (match) {
      max = Math.max(max, Number(match[1] || 0));
    }
  }
  return max + 1;
}

function nextTgIndex() {
  let max = 0;
  for (const account of state.store.accounts) {
    const match = String(account.name).match(/^TG_(\d+)$/i);
    if (match) {
      max = Math.max(max, Number(match[1] || 0));
    }
  }
  return max + 1;
}

function partitionForAccount(accountId, type) {
  const prefix = type === 'telegram' ? 'tg' : 'wa';
  return `persist:${prefix}_${accountId}`;
}

function sanitizeFsName(value, fallback = 'unknown') {
  const raw = String(value || '').trim();
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 80)
    .trim();
  return cleaned || fallback;
}

function contactFileName(contactName) {
  const name = String(contactName || '').trim();
  const base = sanitizeFsName(name, 'contact');
  const hash = crypto.createHash('sha1').update(name || 'contact').digest('hex').slice(0, 8);
  return `${base}__${hash}.txt`;
}

function crmAccountDir(accountId) {
  return path.join(state.paths.crmDir, sanitizeFsName(accountId, 'account'));
}

function crmFilePath(accountId, contactName) {
  return path.join(crmAccountDir(accountId), contactFileName(contactName));
}

function normalizeCrmField(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

const CRM_BLOCKED_CONTACT_TITLES = new Set([
  'сведения профиля',
  'информация профиля',
  'профиль',
  'profile info',
  'profile',
  'contact info',
  'информация о контакте',
  'сведения о контакте',
  'данные контакта',
]);

function normalizeCrmName(value) {
  return String(value || '')
    .replace(/\u200e|\u200f/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function isBlockedCrmContactName(value) {
  const text = normalizeCrmName(value);
  if (!text) return true;
  if (CRM_BLOCKED_CONTACT_TITLES.has(text)) return true;
  if (/(сведени.*профил|информац.*профил|profile\s*info|contact\s*info|информац.*контакт|данные\s*контакта)/i.test(text)) return true;
  if (/^(online|в сети|typing|печатает|recording audio|записывает аудио|tap here|нажмите сюда)/i.test(text)) return true;
  if (/^(last seen|seen |был|была|был\(-а\)|был\(а\)|сегодня в|вчера в)/i.test(text)) return true;
  if (/^\d{1,2}:\d{2}$/.test(text)) return true;
  return false;
}

function formatCrmText(payload = {}) {
  const contactName = normalizeCrmField(payload.contactName);
  const accountName = normalizeCrmField(payload.accountName);
  const about = normalizeCrmField(payload.about);
  const myInfo = normalizeCrmField(payload.myInfo);

  const hoverLine = payload.hoverEnabled === false ? 'Hover: off' : 'Hover: on';

  return [
    `Контакт: ${contactName}`,
    `WhatsApp: ${accountName}`,
    hoverLine,
    '',
    'О нём:',
    about,
    '',
    'Моя информация:',
    myInfo,
    '',
  ].join('\n');
}

function mergeLegacyCrmFields(record = {}) {
  const full = String(record.fullName || '').trim();
  const city = String(record.countryCity || '').trim();
  if (!full && !city) return { ...record, fullName: '', countryCity: '' };
  const legacyLine = [full, city].filter(Boolean).join(' · ');
  const about = String(record.about || '');
  const firstLine = about.split('\n')[0] || '';
  if (firstLine.trim() === legacyLine) {
    return { ...record, fullName: '', countryCity: '' };
  }
  const newAbout = about ? `${legacyLine}\n${about}` : legacyLine;
  return { ...record, about: newAbout, fullName: '', countryCity: '' };
}

function parseCrmText(content = '') {
  const text = String(content || '').replace(/\r/g, '');

  const lineValue = (label) => {
    const re = new RegExp(`^${label}:\\s*(.*)$`, 'mi');
    const m = text.match(re);
    return m ? String(m[1] || '').trim() : '';
  };

  const blockValue = (startLabel, endLabel = '') => {
    const escapedStart = startLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedEnd = endLabel ? endLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
    const re = endLabel
      ? new RegExp(`${escapedStart}:\\n([\\s\\S]*?)\\n${escapedEnd}:`, 'm')
      : new RegExp(`${escapedStart}:\\n([\\s\\S]*)$`, 'm');
    const m = text.match(re);
    return m ? String(m[1] || '').trim() : '';
  };

  const hoverRaw = lineValue('Hover');
  return {
    contactName: lineValue('Контакт'),
    accountName: lineValue('WhatsApp'),
    fullName: lineValue('Имя фамилия'),
    countryCity: lineValue('Страна город'),
    about: blockValue('О нём', 'Моя информация'),
    myInfo: blockValue('Моя информация'),
    hoverEnabled: hoverRaw !== 'off',
  };
}

async function migrateLegacyCrmContactFile({
  accountId,
  accountName,
  targetContactName,
  targetFilePath,
}) {
  const dir = crmAccountDir(accountId);
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  // Strict name-match: only migrate a legacy file whose embedded
  // "Контакт:" field exactly matches the contact we're loading. Prior
  // versions fuzzy-picked the "richest" file in the directory regardless
  // of whose contact it was — which caused CRM data to bleed between
  // unrelated contacts (bug reported in 0.7.5 testing).
  const normalizedTarget = normalizeCrmName(targetContactName);

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.txt')) continue;
    const sourcePath = path.join(dir, entry.name);
    if (sourcePath === targetFilePath) continue;

    let content = '';
    let stat = null;
    try {
      content = await fs.readFile(sourcePath, 'utf8');
      stat = await fs.stat(sourcePath);
    } catch {
      continue;
    }

    const parsed = parseCrmText(content);
    const sourceContact = String(parsed.contactName || '').trim();
    const sourceAccount = String(parsed.accountName || '').trim();
    if (isBlockedCrmContactName(sourceContact)) continue;
    if (sourceAccount && accountName && sourceAccount !== accountName) continue;
    // Hard gate: the embedded contact name must match the requested target.
    // Without this a CRM file for "Вика" would get migrated onto a freshly
    // opened "Robert" contact and then onto "Cher", etc.
    if (!sourceContact || normalizeCrmName(sourceContact) !== normalizedTarget) continue;

    const payloadSize =
      String(parsed.fullName || '').trim().length +
      String(parsed.countryCity || '').trim().length +
      String(parsed.about || '').trim().length +
      String(parsed.myInfo || '').trim().length;

    candidates.push({
      sourcePath,
      parsed,
      score: payloadSize,
      mtime: stat ? Number(stat.mtimeMs || 0) : 0,
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
  const best = candidates[0];
  const record = mergeLegacyCrmFields({
    contactName: targetContactName,
    accountName: accountName || String(best.parsed.accountName || '').trim(),
    fullName: String(best.parsed.fullName || '').trim(),
    countryCity: String(best.parsed.countryCity || '').trim(),
    about: String(best.parsed.about || '').trim(),
    myInfo: String(best.parsed.myInfo || '').trim(),
  });

  const text = formatCrmText(record);
  await writeFileAtomic(targetFilePath, text);
  try {
    await fs.unlink(best.sourcePath);
  } catch {
    // ignore inability to remove legacy file
  }

  return {
    record,
    migratedFrom: best.sourcePath,
  };
}

async function loadCrmContact(accountId, accountName, contactName) {
  const safeAccountId = String(accountId || '').trim();
  const safeContactName = String(contactName || '').trim();
  const safeAccountName = String(accountName || '').trim();

  if (!safeAccountId) return { ok: false, error: 'account_required' };
  if (!safeContactName) return { ok: false, error: 'contact_required' };

  const account = state.store.accounts.find((row) => row.id === safeAccountId);
  if (!account) return { ok: false, error: 'account_not_found' };

  const dir = crmAccountDir(safeAccountId);
  const filePath = crmFilePath(safeAccountId, safeContactName);
  await fs.mkdir(dir, { recursive: true });

  let record = {
    contactName: safeContactName,
    accountName: safeAccountName || account.name,
    about: '',
    myInfo: '',
  };
  let exists = false;
  let migrated = false;
  let migratedFrom = '';

  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = parseCrmText(content);
    const hadLegacy = Boolean(
      String(parsed.fullName || '').trim() || String(parsed.countryCity || '').trim()
    );
    record = mergeLegacyCrmFields({
      ...record,
      ...parsed,
      contactName: parsed.contactName || safeContactName,
      accountName: parsed.accountName || safeAccountName || account.name,
    });
    if (hadLegacy) {
      try {
        await fs.writeFile(filePath, formatCrmText(record), 'utf8');
      } catch { /* tolerate write failure, merge still in-memory */ }
    }
    exists = true;
  } catch {
    const migratedResult = await migrateLegacyCrmContactFile({
      accountId: safeAccountId,
      accountName: safeAccountName || account.name,
      targetContactName: safeContactName,
      targetFilePath: filePath,
    });

    if (migratedResult?.record) {
      record = mergeLegacyCrmFields({
        ...record,
        ...migratedResult.record,
        contactName: safeContactName,
        accountName: String(migratedResult.record.accountName || safeAccountName || account.name),
      });
      exists = true;
      migrated = true;
      migratedFrom = String(migratedResult.migratedFrom || '');
    } else {
      exists = false;
    }
  }

  return { ok: true, record, exists, filePath, migrated, migratedFrom };
}

async function saveCrmContact(payload = {}) {
  const safeAccountId = String(payload.accountId || '').trim();
  const safeContactName = String(payload.contactName || '').trim();
  const safeAccountName = String(payload.accountName || '').trim();
  if (!safeAccountId) return { ok: false, error: 'account_required' };
  if (!safeContactName) return { ok: false, error: 'contact_required' };

  const account = state.store.accounts.find((row) => row.id === safeAccountId);
  if (!account) return { ok: false, error: 'account_not_found' };

  const dir = crmAccountDir(safeAccountId);
  const filePath = crmFilePath(safeAccountId, safeContactName);
  await fs.mkdir(dir, { recursive: true });

  const record = {
    contactName: clampString(safeContactName, LIMITS.CONTACT_NAME),
    accountName: clampString(safeAccountName || account.name, LIMITS.ACCOUNT_NAME),
    about: clampString(String(payload.about || ''), LIMITS.CRM_TEXT),
    myInfo: clampString(String(payload.myInfo || ''), LIMITS.CRM_TEXT),
    hoverEnabled: payload.hoverEnabled !== false,
  };

  const text = formatCrmText(record);
  await writeFileAtomic(filePath, text);

  return { ok: true, record, filePath, text };
}

function ensureDefaultAccount() {
  if (state.store.accounts.length) return;
  const idx = 1;
  state.store.accounts.push({
    id: `wa_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    name: `WP_${idx}`,
    color: pickColor(idx),
    iconPath: '',
    frozen: false,
    order: 1,
    createdAt: new Date().toISOString(),
  });
}

function normalizeAccountOrder() {
  state.store.accounts = state.store.accounts
    .slice()
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
    .map((account, index) => ({
      ...account,
      order: index + 1,
    }));
}

function accountToView(account = {}) {
  const iconPath = String(account.iconPath || '').trim();
  let iconUrl = '';
  if (iconPath && fsSync.existsSync(iconPath)) {
    try {
      iconUrl = pathToFileURL(iconPath).href;
    } catch {
      iconUrl = '';
    }
  }
  return {
    ...account,
    iconPath,
    iconUrl,
  };
}

function accountToRuntimePayload(account = {}) {
  const type = account.type || 'whatsapp';
  return {
    ...accountToView(account),
    type,
    partition: partitionForAccount(account.id, type),
    url: type === 'telegram' ? 'https://web.telegram.org/a/' : 'https://web.whatsapp.com/',
  };
}

async function renameAccount(accountId, name) {
  const id = String(accountId || '').trim();
  const nextName = String(name || '').trim();
  if (!id) return { ok: false, error: 'account_not_found' };
  if (!nextName) return { ok: false, error: 'name_required' };

  const account = state.store.accounts.find((acc) => acc.id === id);
  if (!account) return { ok: false, error: 'account_not_found' };

  account.name = clampString(nextName, LIMITS.ACCOUNT_NAME);
  await saveStore();
  return { ok: true, account: accountToView(account) };
}

async function setAccountFrozen(accountId, frozen) {
  const id = String(accountId || '').trim();
  if (!id) return { ok: false, error: 'account_not_found' };
  const account = state.store.accounts.find((acc) => acc.id === id);
  if (!account) return { ok: false, error: 'account_not_found' };

  account.frozen = Boolean(frozen);
  await saveStore();
  return { ok: true, account: accountToView(account) };
}

async function setAccountPinned(accountId, pinned) {
  const id = String(accountId || '').trim();
  if (!id) return { ok: false, error: 'account_not_found' };
  const account = state.store.accounts.find((acc) => acc.id === id);
  if (!account) return { ok: false, error: 'account_not_found' };

  account.pinned = Boolean(pinned);
  await saveStore();
  return { ok: true, account: accountToView(account) };
}

async function setAccountIcon(accountId, iconPath) {
  const id = String(accountId || '').trim();
  if (!id) return { ok: false, error: 'account_not_found' };
  const account = state.store.accounts.find((acc) => acc.id === id);
  if (!account) return { ok: false, error: 'account_not_found' };

  const nextPath = String(iconPath || '').trim();
  if (!nextPath) {
    // Clear existing icon: remove the copied file in userData/icons too
    if (account.iconPath) {
      try { await fs.unlink(account.iconPath); } catch { /* already gone */ }
    }
    account.iconPath = '';
    await saveStore();
    return { ok: true, account: accountToView(account) };
  }

  if (!fsSync.existsSync(nextPath)) {
    return { ok: false, error: 'icon_not_found' };
  }
  const ext = String(path.extname(nextPath) || '').toLowerCase();
  if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
    return { ok: false, error: 'icon_invalid_type' };
  }

  // Size guard: avoid copying a 500MB "image"
  try {
    const st = await fs.stat(nextPath);
    if (!st.isFile()) return { ok: false, error: 'icon_not_file' };
    if (st.size > 10 * 1024 * 1024) return { ok: false, error: 'icon_too_large' };
  } catch {
    return { ok: false, error: 'icon_stat_failed' };
  }

  // Copy file into userData/icons/ so the stored path is always inside our
  // sandbox. This defeats path-traversal attempts from the renderer side and
  // keeps the icon available even if the user deletes the source file.
  const iconsDir = path.join(state.paths.userData, 'icons');
  try { await fs.mkdir(iconsDir, { recursive: true }); } catch { /* ignore */ }
  const safeFilename = `${id}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}${ext}`;
  const safePath = path.join(iconsDir, safeFilename);
  try {
    await fs.copyFile(nextPath, safePath);
  } catch (err) {
    return { ok: false, error: 'icon_copy_failed', detail: String(err?.message || err) };
  }

  // Clean up previous copied icon (if any) so we don't accumulate orphans
  if (account.iconPath && account.iconPath !== safePath) {
    try { await fs.unlink(account.iconPath); } catch { /* ignore */ }
  }

  account.iconPath = safePath;
  await saveStore();
  return { ok: true, account: accountToView(account) };
}

async function moveAccount(accountId, direction) {
  const id = String(accountId || '').trim();
  const dir = String(direction || '').toLowerCase();
  if (!id) return { ok: false, error: 'account_not_found' };
  if (!['up', 'down'].includes(dir)) return { ok: false, error: 'invalid_direction' };

  normalizeAccountOrder();
  const idx = state.store.accounts.findIndex((acc) => acc.id === id);
  if (idx < 0) return { ok: false, error: 'account_not_found' };

  const swapWith = dir === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= state.store.accounts.length) {
    return { ok: true, accounts: state.store.accounts.map((acc) => accountToRuntimePayload(acc)) };
  }

  const currentOrder = Number(state.store.accounts[idx].order || idx + 1);
  state.store.accounts[idx].order = Number(state.store.accounts[swapWith].order || swapWith + 1);
  state.store.accounts[swapWith].order = currentOrder;
  normalizeAccountOrder();
  await saveStore();
  return { ok: true, accounts: state.store.accounts.map((acc) => accountToRuntimePayload(acc)) };
}

async function removeAccount(accountId) {
  const id = String(accountId || '').trim();
  if (!id) return { ok: false, error: 'account_not_found' };

  const idx = state.store.accounts.findIndex((acc) => acc.id === id);
  if (idx < 0) return { ok: false, error: 'account_not_found' };

  const removedType = state.store.accounts[idx].type || 'whatsapp';
  state.store.accounts.splice(idx, 1);
  if (state.store.accounts.length === 0) markIntentionalLastAccountRemoval();
  normalizeAccountOrder();
  state.store.scheduled = state.store.scheduled.filter((item) => item.accountId !== id);
  // Drop per-contact language prefs of the removed account. Keys are
  // `${accountId}\u0000${chatName}` (see contactLangKey), so delete by prefix.
  if (state.store.contactLangs && typeof state.store.contactLangs === 'object') {
    const prefix = `${id}\u0000`;
    for (const key of Object.keys(state.store.contactLangs)) {
      if (key.startsWith(prefix)) delete state.store.contactLangs[key];
    }
  }
  // Drop favorites of the removed account — they reference it by id.
  if (Array.isArray(state.store.favorites)) {
    state.store.favorites = state.store.favorites.filter((f) => f.accountId !== id);
  }
  // Drop important contacts of the removed account too.
  if (Array.isArray(state.store.important)) {
    state.store.important = state.store.important.filter((f) => f.accountId !== id);
  }
  await saveStore();

  try {
    const partition = partitionForAccount(id, removedType);
    const partitionSession = session.fromPartition(partition);
    await partitionSession.clearStorageData();
    await partitionSession.clearCache();
    if (typeof partitionSession.clearCodeCaches === 'function') {
      await partitionSession.clearCodeCaches({}).catch(() => {});
    }
  } catch {
    // ignore storage cleanup failures
  }

  try {
    await rmWithRetry(crmAccountDir(id));
  } catch {
    // ignore CRM cleanup failures
  }

  const nextActiveAccountId = state.store.accounts[0]?.id || '';
  return {
    ok: true,
    removedAccountId: id,
    nextActiveAccountId,
  };
}

function buildBootstrap() {
  normalizeAccountOrder();
  return {
    accounts: state.store.accounts.map((acc) => accountToRuntimePayload(acc)),
    settings: { ...state.store.settings },
    templates: state.store.templates.map((tpl) => ({ ...tpl })),
    templateUsage: { ...(state.store.templateUsage || {}) },
    favorites: (state.store.favorites || []).map((f) => ({ ...f })),
    important: (state.store.important || []).map((f) => ({ ...f })),
    appVersion: app.getVersion(),
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      platform: process.platform,
      waUserAgent: WA_USER_AGENT,
    },
  };
}

function guessMime(filePath) {
  const ext = String(path.extname(filePath) || '').toLowerCase();
  if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.heic') return 'image/heic';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.doc') return 'application/msword';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === '.xls') return 'application/vnd.ms-excel';
  if (ext === '.xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.zip') return 'application/zip';
  if (ext === '.ogg') return 'audio/ogg';
  if (ext === '.opus') return 'audio/opus';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  if (ext === '.aac') return 'audio/aac';
  if (ext === '.weba') return 'audio/webm';
  return 'application/octet-stream';
}

const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024; // 100 MB
async function loadAttachmentPayload(filePath) {
  // File is delivered to the webview via CDP (DOM.setFileInputFiles) using the
  // absolute path directly — no need to load the bytes into memory here, which
  // previously caused a ~1.3× base64 spike per 100 MB file.
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_ATTACHMENT_SIZE) {
    throw new Error(`file_too_large: ${path.basename(filePath)} (${Math.round(stat.size / 1024 / 1024)} MB > 100 MB)`);
  }
  return {
    path: filePath,
    name: path.basename(filePath),
    mime: guessMime(filePath),
    size: stat.size,
  };
}

async function claimDueScheduled(limit = 5) {
  // Runtime sweep: return any item stuck in 'processing' (renderer reload/crash
  // between claim and complete) back to 'pending' so it gets retried instead of
  // being lost until the next app restart.
  recoverStaleProcessingItems(STALE_PROCESSING_MS);

  const now = Date.now();
  const due = state.store.scheduled
    .filter((item) => item.status === 'pending' && new Date(item.sendAt).getTime() <= now)
    .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime())
    .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));

  if (!due.length) return [];

  const claimedAt = new Date().toISOString();
  for (const item of due) {
    item.status = 'processing';
    item.claimedAt = claimedAt;
    item.updatedAt = claimedAt;
  }
  await saveStore();

  const out = [];
  for (const item of due) {
    const attachments = [];
    const attachmentErrors = [];
    for (const att of item.attachments) {
      try {
        attachments.push(await loadAttachmentPayload(att.path));
      } catch (err) {
        // Propagate — without a promised attachment, sending empty text as "ok" is a lie
        attachmentErrors.push(String(err?.message || err || 'unreadable'));
      }
    }

    out.push({
      ...item,
      attachments,
      attachmentErrors,
    });
  }

  return out;
}

const REPEAT_KINDS = new Set(['daily', 'weekdays', 'weekly']);

/* Next occurrence from the canonical (jitter-free) base time. Date arithmetic
 * via setDate keeps the local wall-clock hour across DST transitions. Rolls
 * forward past occurrences the app slept through (laptop closed for a week). */
function nextRepeatSendAt(baseIso, repeat) {
  const next = new Date(baseIso);
  if (Number.isNaN(next.getTime())) return null;
  const step = () => {
    next.setDate(next.getDate() + (repeat === 'weekly' ? 7 : 1));
    if (repeat === 'weekdays') {
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    }
  };
  step();
  let guard = 0;
  while (next.getTime() <= Date.now() && guard++ < 400) step();
  return next;
}

/* Chain the next occurrence of a repeating message. Called from
 * markScheduledResult for BOTH outcomes — one failed occurrence must not kill
 * the series (cancel does: cancelScheduled never spawns). */
function spawnNextRepeatOccurrence(item) {
  try {
    if (item.repeatSpawned) return; // retry of the same occurrence — already chained
    const next = nextRepeatSendAt(item.baseSendAt || item.sendAt, item.repeat);
    if (!next) return;
    const pendingCount = state.store.scheduled
      .filter((i) => ['pending', 'processing'].includes(i.status)).length;
    if (pendingCount >= LIMITS.SCHEDULED_PER_USER) {
      console.warn('[repeat] scheduled limit reached — series stops:', item.chatName);
      return;
    }
    const jitter = Math.max(0, Math.min(60, Math.round(Number(item.jitterMinutes) || 0)));
    const offsetMs = jitter ? Math.round((Math.random() * 2 - 1) * jitter * 60000) : 0;
    const sendAtMs = Math.max(Date.now() + 60000, next.getTime() + offsetMs);
    item.repeatSpawned = true;
    state.store.scheduled.push({
      id: `sched_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      accountId: item.accountId,
      chatName: item.chatName,
      text: item.text,
      attachments: Array.isArray(item.attachments) ? item.attachments.map((att) => ({ ...att })) : [],
      sendAt: new Date(sendAtMs).toISOString(),
      baseSendAt: next.toISOString(),
      repeat: item.repeat,
      jitterMinutes: jitter,
      repeatSpawned: false,
      status: 'pending',
      claimedAt: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      errorText: '',
    });
  } catch (err) {
    console.warn('[repeat] spawn failed:', err?.message || err);
  }
}

async function markScheduledResult(payload = {}) {
  const id = String(payload.id || '');
  const item = state.store.scheduled.find((row) => row.id === id);
  if (!item) return { ok: false, error: 'not_found' };
  // A stale/duplicate completion must not flip an already-finished item
  // (e.g. resurrect a canceled message as 'sent').
  if (['sent', 'canceled'].includes(item.status)) return { ok: false, error: 'invalid_status' };

  const ok = Boolean(payload.ok);
  item.status = ok ? 'sent' : 'failed';
  item.claimedAt = '';
  item.errorText = ok ? '' : String(payload.errorText || 'send_failed');
  item.updatedAt = new Date().toISOString();
  if (item.repeat && REPEAT_KINDS.has(item.repeat)) {
    spawnNextRepeatOccurrence(item);
  }
  // Keep the finished-items backlog bounded (14 days / 1000 records)
  pruneFinishedScheduled();
  await saveStore();
  return { ok: true };
}

async function cancelScheduled(id) {
  const item = state.store.scheduled.find((row) => row.id === id);
  if (!item) return { ok: false, error: 'not_found' };
  if (!['pending', 'processing', 'failed'].includes(item.status)) return { ok: false, error: 'invalid_status' };
  item.status = 'canceled';
  item.updatedAt = new Date().toISOString();
  await saveStore();
  return { ok: true };
}

/* Security: only allow http/https URLs in shell.openExternal */
function safeOpenExternal(url) {
  const str = String(url || '').trim();
  if (/^https?:\/\//i.test(str)) {
    shell.openExternal(str).catch(() => {});
  }
}

function addSingleInstanceGuard() {
  const lock = app.requestSingleInstanceLock();
  if (!lock) {
    app.quit();
    return false;
  }

  app.on('second-instance', () => {
    // Can fire before whenReady resolves — createWindow() would then throw
    // "Cannot create BrowserWindow before app is ready" (swallowed by the
    // global handler, silently dropping the second launch). bootstrap will
    // create the window anyway.
    if (!app.isReady()) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  return true;
}


/* Reload the main window after a renderer crash, but only once it has finished
   its initial load (reloading a sandboxed renderer mid-startup triggers
   Electron's "binding.startupData is null" error) and not in a tight loop
   (≥3 reloads in 60s → back off so a persistent failure isn't an infinite
   reload loop). */
let _mainReloadTimes = [];
let _mainLoadedOnce = false;
function recoverMainWindow(tag) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!_mainLoadedOnce) {
    console.error(`[main] ${tag}: crash before first load — not reloading (would hit sandbox startup race)`);
    return;
  }
  const now = Date.now();
  _mainReloadTimes = _mainReloadTimes.filter((t) => now - t < 60000);
  if (_mainReloadTimes.length >= 3) {
    console.error(`[main] ${tag}: 3 reloads within 60s — backing off to avoid a crash-loop`);
    return;
  }
  _mainReloadTimes.push(now);
  console.warn(`[main] ${tag}: reloading main window to recover from black screen`);
  try { mainWindow.webContents.reload(); } catch (err) { console.error('[main] recover reload failed:', err); }
}

function createWindow() {
  // A recreated window (macOS activate, second-instance) must re-earn the
  // "first load finished" flag — otherwise a crash during ITS startup would
  // trigger recoverMainWindow's reload mid-load, the exact sandbox race the
  // flag guards against.
  _mainLoadedOnce = false;
  mainWindow = new BrowserWindow({
    width: 1680,
    height: 980,
    minWidth: 1220,
    minHeight: 760,
    title: APP_TITLE,
    icon: fsSync.existsSync(APP_ICON_PNG_PATH) ? APP_ICON_PNG_PATH : undefined,
    backgroundColor: '#080f1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Орфография в полях самой деки (CRM, шаблоны, планировщик). Webview-поля
  // обслуживает обработчик в setupWebviewGuards — сюда их события не доходят.
  configureSpellchecker(mainWindow.webContents.session);
  mainWindow.webContents.on('context-menu', (_event, params) => {
    if (!params?.isEditable) return;
    const template = [];
    appendSpellcheckMenuItems(template, mainWindow.webContents, params);
    template.push(
      { role: 'cut', label: 'Вырезать' },
      { role: 'copy', label: 'Копировать' },
      { role: 'paste', label: 'Вставить' },
      { role: 'selectAll', label: 'Выделить всё' },
    );
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  // Harden every <webview> the renderer attaches: strip any preload a
  // compromised renderer could inject, force isolation flags, and only allow
  // the two origins we actually host.
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    delete webPreferences.preload;
    delete webPreferences.preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    // Also pin the attributes a compromised renderer could set on the
    // <webview> tag itself: no popups, no disabled web security, sandboxed.
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.spellcheck = true;
    if (params && typeof params === 'object') {
      delete params.allowpopups;
      delete params.disablewebsecurity;
    }
    const src = String(params?.src || '');
    const allowed = src.startsWith('https://web.whatsapp.com/') || src.startsWith('https://web.telegram.org/');
    if (!allowed) {
      console.warn('[will-attach-webview] blocked src:', src);
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (String(input?.type || '').toLowerCase() !== 'keydown') return;
    const sendToRenderer = (channel) => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(channel);
        }
      } catch {
        // ignore channel send errors
      }
    };
    if (String(input?.key || '') === 'Escape') {
      event.preventDefault();
      sendToRenderer('host-escape-pressed');
      return;
    }
    // Cmd/Ctrl+U — следующий непрочитанный. Перехват здесь, а не в renderer:
    // при фокусе внутри webview (обычное состояние — курсор в композере чата)
    // keydown до host-окна не доходит. Физический код — ради RU-раскладки.
    if ((input.meta || input.control) && !input.shift && !input.alt
        && String(input?.code || '') === 'KeyU') {
      event.preventDefault();
      sendToRenderer('host-next-unread-pressed');
      return;
    }
    // F1 — справка. Без модификаторов; при фокусе в webview keydown до
    // host-окна не доходит (на mac справки «не было» именно поэтому).
    if (String(input?.key || '') === 'F1' && !input.meta && !input.control && !input.alt && !input.shift) {
      event.preventDefault();
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('host-hotkey', { code: 'F1', shift: false });
        }
      } catch { /* ignore */ }
      return;
    }
    // Сквозные хоткеи: Cmd+1..9 / K / T / R / зум раньше умирали, как только
    // курсор оказывался в композере WhatsApp (т.е. большую часть дня) — host-
    // keydown в renderer их не видел. Тот же принцип, что у Esc и Cmd+U:
    // перехват в main, доставка одним каналом, физические коды ради RU.
    if ((input.meta || input.control) && !input.alt) {
      const code = String(input?.code || '');
      const routable = !input.shift
        && (/^Digit[0-9]$/.test(code) || code === 'KeyK' || code === 'KeyT'
            || code === 'KeyR' || code === 'Minus' || code === 'Equal');
      if (routable) {
        event.preventDefault();
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('host-hotkey', { code, shift: Boolean(input.shift) });
          }
        } catch {
          // ignore channel send errors
        }
      }
    }
  });
  /* ── Main-window resilience ──
     Over long sessions (every account's <webview> is kept on a hot GPU
     compositor layer for instant switching — see 0.7.9) the main renderer or
     the shared GPU process can die under memory pressure. With no handler the
     window is left blank — only `backgroundColor` shows — until the user
     manually restarts. That is exactly the "black screen after 4-5 hours, fine
     after restart" symptom. Auto-reload the renderer so it self-heals, throttled
     to avoid a crash-loop, and log the reason so recurrences are diagnosable. */
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] render-process-gone:', details?.reason, 'exitCode:', details?.exitCode);
    if (details?.reason === 'clean-exit') return;
    recoverMainWindow('render-process-gone');
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[main] renderer became unresponsive');
  });
  mainWindow.webContents.on('responsive', () => {
    console.log('[main] renderer responsive again');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    _mainLoadedOnce = true;   // safe to auto-reload only after the first load
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // On macOS in dev mode (not packaged), set dock icon from PNG.
  // In production, the .icns in the app bundle is used automatically.
  if (process.platform === 'darwin' && !app.isPackaged && fsSync.existsSync(APP_ICON_PNG_PATH)) {
    try {
      app.dock?.setIcon(APP_ICON_PNG_PATH);
    } catch {
      // ignore icon set errors
    }
  }
}

function configureSpellchecker(ses) {
  if (!ses) return;
  try {
    ses.setSpellCheckerEnabled(true);
    if (process.platform !== 'darwin') {
      ses.setSpellCheckerLanguages(SPELLCHECK_LANGUAGES);
    }
  } catch (err) {
    console.warn('[spellcheck] configure failed:', err?.message || err);
  }
}

/* Пункты орфографии для контекстного меню: варианты замены подчёркнутого
   слова + «Добавить в словарь». Общие для webview и полей самой деки. */
function appendSpellcheckMenuItems(template, contents, params) {
  const misspelled = String(params?.misspelledWord || '');
  if (!params?.isEditable || !misspelled) return;
  const suggestions = Array.isArray(params.dictionarySuggestions)
    ? params.dictionarySuggestions.slice(0, 5)
    : [];
  for (const suggestion of suggestions) {
    template.push({
      label: suggestion,
      click: () => {
        try { contents.replaceMisspelling(suggestion); } catch { /* ignore */ }
      },
    });
  }
  if (!suggestions.length) {
    template.push({ label: 'Нет вариантов замены', enabled: false });
  }
  template.push(
    {
      label: 'Добавить в словарь',
      click: () => {
        try { contents.session.addWordToSpellCheckerDictionary(misspelled); } catch { /* ignore */ }
      },
    },
    { type: 'separator' },
  );
}

function setupWebviewGuards() {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return;

    // Lock down permission requests on this webview's session (once per session).
    const ses = contents.session;
    if (ses && !_permissionConfiguredSessions.has(ses)) {
      _permissionConfiguredSessions.add(ses);
      configureSpellchecker(ses);
      ses.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(ALLOWED_WEBVIEW_PERMISSIONS.has(permission));
      });
      ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_WEBVIEW_PERMISSIONS.has(permission));

      /* Guest→host bridge preload (see src/preload-webview.js). Session-level
         registration is untouched by the will-attach-webview hardening that
         strips attribute-level preloads a compromised renderer could set. */
      try {
        const preloadPath = path.join(__dirname, 'preload-webview.js');
        if (typeof ses.registerPreloadScript === 'function') {
          ses.registerPreloadScript({ type: 'frame', filePath: preloadPath });
        } else if (typeof ses.setPreloads === 'function') {
          ses.setPreloads([preloadPath]);
        }
      } catch (err) {
        console.warn('[webview-preload] registration failed:', err?.message || err);
      }

      /* Electron 43 changed the default download flow: without a will-download
         handler, files are saved straight into ~/Downloads with no prompt.
         Keep the explicit save dialog users expect for files downloaded from
         WhatsApp/Telegram. The sync dialog is required: setSavePath() only
         works while the will-download callback is on the stack. */
      ses.on('will-download', (_evt, item) => {
        try {
          const fileName = item.getFilename() || 'download';
          const parentWin = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : undefined;
          const chosen = dialog.showSaveDialogSync(parentWin, {
            title: 'Сохранить файл',
            defaultPath: path.join(app.getPath('downloads'), fileName),
          });
          if (chosen) item.setSavePath(chosen);
          else item.cancel();
        } catch (err) {
          console.warn('[will-download] save dialog failed, using default path:', err?.message || err);
        }
      });
    }

    // Determine webview type from partition (persist:tg_* = Telegram, persist:wa_* = WhatsApp)
    const isTelegram = () => {
      try {
        const partition = contents.session?.getStoragePath?.() || '';
        // Match both POSIX and Windows path separators
        if (/[\\/]tg_/.test(partition)) return true;
        // Fallback: check current URL
        const url = contents.getURL() || '';
        return url.includes('web.telegram.org');
      } catch { return false; }
    };

    // Only set WhatsApp user-agent for WhatsApp webviews
    if (!isTelegram()) {
      contents.setUserAgent(WA_USER_AGENT);
    }

    // Per-webContents guard against Chromium background throttling. The
    // command-line switches above handle the process-wide features
    // (IntensiveWakeUpThrottling etc.); this API call disables the
    // per-page timer/scheduler throttling that kicks in when the hosted
    // page reports visibilityState='hidden' (which our display:none does).
    try { contents.setBackgroundThrottling(false); } catch { /* older Electron: no-op */ }

    contents.setWindowOpenHandler(({ url }) => {
      safeOpenExternal(url);
      return { action: 'deny' };
    });

    const enforceOriginAllowlist = (event, url) => {
      const dest = String(url || '');
      if (isTelegram()) {
        if (!dest.startsWith('https://web.telegram.org')) {
          event.preventDefault();
        }
      } else {
        if (!dest.startsWith('https://web.whatsapp.com')) {
          event.preventDefault();
        }
      }
    };
    contents.on('will-navigate', enforceOriginAllowlist);
    // will-navigate does NOT fire for server-side redirects — without this a
    // 30x from the allowed origin could land the webview on an arbitrary host
    // with this session's permission grants still applied.
    contents.on('will-redirect', enforceOriginAllowlist);
    /* Webview crash recovery — notify renderer to show error and allow reload */
    contents.on('render-process-gone', (_event, details) => {
      console.error('[webview] render-process-gone:', details?.reason, 'exitCode:', details?.exitCode);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('webview-crashed', {
          reason: String(details?.reason || 'unknown'),
          exitCode: details?.exitCode || 0,
        });
      }
    });

    /* did-fail-load: filter out transient/expected errors that cause false
       "Не удалось загрузить" toasts on a flaky network. Per Chromium net error
       codes:
         -3   ERR_ABORTED — load was cancelled (often by our own reload())
         -21  ERR_NETWORK_CHANGED — VPN/Wi-Fi switch; the page just retries
       Sub-frames (analytics, FB Pixel, embedded media) failing is also fine —
       only main-frame failures matter for our UI. WA Web pulls in 20-30
       sub-resources, any of which can flap without affecting the chat. */
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (errorCode === -3 || errorCode === -21) return;
      console.warn('[webview] did-fail-load (main):', errorCode, errorDescription, validatedURL);
    });

    contents.on('context-menu', (_event, params) => {
      const template = [];
      const selectionText = String(params?.selectionText || '').trim();
      const linkURL = String(params?.linkURL || '').trim();
      const srcURL = String(params?.srcURL || '').trim();
      const mediaType = String(params?.mediaType || '').trim().toLowerCase();

      appendSpellcheckMenuItems(template, contents, params);

      if (selectionText) {
        template.push({ role: 'copy', label: 'Копировать' });
      }

      if (params?.isEditable) {
        template.push(
          { role: 'undo', label: 'Отменить' },
          { role: 'redo', label: 'Повторить' },
          { type: 'separator' },
          { role: 'cut', label: 'Вырезать' },
          { role: 'copy', label: 'Копировать' },
          { role: 'paste', label: 'Вставить' },
          { role: 'selectAll', label: 'Выделить всё' },
        );
      }

      if (mediaType === 'image') {
        template.push({
          label: 'Копировать изображение',
          click: () => {
            try {
              contents.copyImageAt(params.x, params.y);
            } catch {
              // ignore copy image errors
            }
          },
        });

        if (srcURL && !srcURL.startsWith('blob:') && !srcURL.startsWith('data:')) {
          template.push({
            label: 'Открыть изображение',
            click: () => safeOpenExternal(srcURL),
          });
        }
      }

      if (linkURL) {
        template.push(
          {
            label: 'Открыть ссылку',
            click: () => safeOpenExternal(linkURL),
          },
          {
            label: 'Копировать ссылку',
            click: () => clipboard.writeText(linkURL),
          },
        );
      }

      if (!template.length) {
        template.push({ role: 'copy', label: 'Копировать' });
      }

      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: BrowserWindow.fromWebContents(contents.hostWebContents || contents) || mainWindow });
    });
  });
}

function sendAutoUpdateStatus(payload = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('auto-update-status', payload);
}

function normalizeUpdaterErrorMessage(error) {
  const raw = String(error?.message || error || '').trim();
  const lower = raw.toLowerCase();
  if (!raw) return 'Проверка обновлений временно недоступна';
  if (lower.includes('zip file not provided') || lower.includes('zip not provided')) {
    return 'В релизе отсутствует ZIP для автообновления macOS';
  }
  if (lower.includes('releases.atom') || lower.includes('404') || lower.includes('not found')) {
    return 'Обновления не найдены в GitHub Releases';
  }
  if (lower.includes('net::') || lower.includes('network') || lower.includes('econn') || lower.includes('timeout')) {
    return 'Ошибка сети при проверке обновлений';
  }
  if (lower.includes('token') || lower.includes('authentication') || lower.includes('unauthorized')) {
    return 'Ошибка доступа к GitHub Releases';
  }
  return 'Не удалось проверить обновления';
}

function hasMacDeveloperIdSignature() {
  if (process.platform !== 'darwin') return true;
  if (macDeveloperIdSignatureCache !== null) return macDeveloperIdSignatureCache;

  try {
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', process.execPath], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const output = `${String(result.stdout || '')}\n${String(result.stderr || '')}`;
    const hasDeveloperId = /Authority=Developer ID Application:/i.test(output);
    macDeveloperIdSignatureCache = hasDeveloperId;
    return hasDeveloperId;
  } catch {
    macDeveloperIdSignatureCache = false;
    return false;
  }
}

/* Source of the update check currently in flight ('manual' | 'auto').
 * electron-updater's events carry no context, so the listeners in
 * setupAutoUpdater() read this to tag their status messages — the renderer
 * keeps background checks silent but surfaces manual ones. */
let currentUpdateCheckSource = 'manual';

async function checkForUpdatesNow(source = 'manual') {
  if (!app.isPackaged) {
    return { ok: false, error: 'not_packaged', source };
  }
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) {
    // electron-updater can't update the portable build (no app-update.yml is
    // packaged into it) — without this guard the generic error path reports a
    // misleading «Обновления не найдены».
    sendAutoUpdateStatus({
      status: 'error',
      source,
      message: 'Portable-сборка не обновляется автоматически — скачайте новую версию с GitHub Releases',
    });
    return { ok: false, error: 'portable_unsupported', source };
  }
  currentUpdateCheckSource = source === 'auto' ? 'auto' : 'manual';
  if (process.platform === 'darwin' && !hasMacDeveloperIdSignature()) {
    // Unsigned mac build: electron-updater refuses to install updates without
    // a Developer ID signature, so we run the custom zip-swap updater instead.
    // Kick it off in the background — the UI is driven entirely by the same
    // 'auto-update-status' events the electron-updater flow emits.
    runMacUpdateCheck(source).catch((error) => {
      sendAutoUpdateStatus({ status: 'error', source, message: normalizeUpdaterErrorMessage(error) });
    });
    return { ok: true, source };
  }
  try {
    lastUpdateProgressPercent = -1;
    await autoUpdater.checkForUpdates();
    return { ok: true, source };
  } catch (error) {
    const message = normalizeUpdaterErrorMessage(error);
    sendAutoUpdateStatus({ status: 'error', source, message });
    return { ok: false, source, error: message };
  }
}

/* Background update check: one delayed check shortly after startup (releases
 * are infrequent — no periodic re-check). The status goes out tagged
 * source:'auto' — the renderer shows the available/downloaded toast but keeps
 * checking/not-available/error quiet, so the background check never nags. */
const AUTO_UPDATE_STARTUP_DELAY_MS = 30 * 1000;

function scheduleBackgroundUpdateChecks() {
  if (!app.isPackaged) return;
  if (process.platform === 'win32' && process.env.PORTABLE_EXECUTABLE_DIR) return;
  const quietCheck = () => {
    // Обновление уже скачано и ждёт установки — не проверять поверх
    if (updateDownloaded) return;
    checkForUpdatesNow('auto').catch((err) => {
      console.warn('[auto-update] background check failed:', err?.message || err);
    });
  };
  setTimeout(quietCheck, AUTO_UPDATE_STARTUP_DELAY_MS);
  // Приложение живёт неделями без рестарта (keep-alive — прямая цель), а
  // проверка была одна за жизнь процесса: о релизах узнавали случайно.
  setInterval(quietCheck, 12 * 60 * 60 * 1000);
}

/* ── Release notes: parsed from the bundled CHANGELOG.md ────────────────────
 * The renderer's «Что нового» modal used to rely on a hardcoded map inside
 * auto-update.js that silently went stale (last entry 0.6.1 while the app
 * shipped 0.8.0). CHANGELOG.md is the single source of truth now — it ships
 * inside the asar (see build.files) and is parsed once per session. */
let releaseNotesCache = null;

function parseChangelogNotes(md) {
  const notes = {};
  let current = null;
  for (const rawLine of String(md || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const header = line.match(/^##\s+v?(\d+\.\d+\.\d+\S*)\s*$/);
    if (header) {
      current = header[1];
      if (!notes[current]) notes[current] = [];
      continue;
    }
    if (!current) continue;
    // Top-level bullets only (indented sub-bullets stay out of the modal)
    const bullet = line.match(/^-\s+(.*)$/);
    if (!bullet) continue;
    const text = bullet[1]
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/\[(.+?)\]\([^)]*\)/g, '$1')
      .trim();
    if (text) notes[current].push(clampString(text, 500));
  }
  return notes;
}

async function loadReleaseNotesFromChangelog() {
  if (releaseNotesCache) return releaseNotesCache;
  try {
    const md = await fs.readFile(path.join(app.getAppPath(), 'CHANGELOG.md'), 'utf8');
    releaseNotesCache = parseChangelogNotes(md);
  } catch (err) {
    console.warn('[release-notes] CHANGELOG.md unavailable:', err?.message || err);
    releaseNotesCache = {};
  }
  return releaseNotesCache;
}

/* ── Custom macOS in-app updater (unsigned builds) ─────────────────────────
 *
 * electron-updater can check/download on macOS but refuses to INSTALL without
 * a Developer ID signature, so the previous behavior was to send the user to
 * GitHub Releases. This section replicates the Windows UX manually:
 *
 *   1. Fetch latest-mac.yml from GitHub Releases and parse it (version, zip
 *      asset name, sha512).
 *   2. Download the zip into app.getPath('temp') with progress reported on the
 *      same 'auto-update-status' channel the Windows flow uses — the renderer
 *      chip (auto-update.js) works without changes.
 *   3. Verify sha512.
 *   4. On install-downloaded-update: swap the .app bundle via a detached shell
 *      script (waits for our PID to exit, ditto -xk, mv old → temp, mv new →
 *      place, strip quarantine, relaunch) and exit the app.
 *
 * The Windows flow is untouched.
 */

const LATEST_MAC_YML_URL = `${RELEASES_LATEST_URL}/download/latest-mac.yml`;

const macUpdate = {
  inProgress: false,
  downloaded: false,
  zipPath: '',
  version: '',
};

/* HTTPS GET that follows redirects (GitHub release assets redirect to S3). */
function httpsGetFollow(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'WA-Deck-Updater' } }, (res) => {
      const code = Number(res.statusCode || 0);
      if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let nextUrl;
        try {
          nextUrl = new URL(res.headers.location, url).href;
        } catch {
          reject(new Error('bad_redirect'));
          return;
        }
        resolve(httpsGetFollow(nextUrl, redirectsLeft - 1));
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(`http_${code}`));
        return;
      }
      resolve(res);
    });
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function httpsGetText(url, maxBytes = 1024 * 1024) {
  const res = await httpsGetFollow(url);
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    res.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        res.destroy(new Error('response_too_large'));
        return;
      }
      data += chunk;
    });
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
}

/* Minimal parser for electron-builder's latest-mac.yml (flat, predictable). */
function parseLatestMacYml(text) {
  const result = { version: '', files: [] };
  let current = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const mVersion = line.match(/^version:\s*['"]?([^'"\s]+)/);
    if (mVersion) { result.version = mVersion[1]; continue; }
    const mUrl = line.match(/^\s*-\s*url:\s*['"]?([^'"\s]+)/);
    if (mUrl) {
      current = { url: mUrl[1], sha512: '', size: 0 };
      result.files.push(current);
      continue;
    }
    const mSha = line.match(/^\s+sha512:\s*['"]?([^'"\s]+)/);
    if (mSha && current) { current.sha512 = mSha[1]; continue; }
    const mSize = line.match(/^\s+size:\s*(\d+)/);
    if (mSize && current) { current.size = Number(mSize[1]); continue; }
    if (/^(path|sha512|releaseDate):/.test(line)) current = null;
  }
  return result;
}

/* Semver-ish compare with prerelease awareness ('0.7.14-beta.1' < '0.7.14'). */
function compareSemver(a, b) {
  const parse = (v) => {
    const s = String(v || '').replace(/^v/i, '').trim();
    const [core, ...rest] = s.split('-');
    return {
      nums: core.split('.').map((part) => Number(part) || 0),
      prerelease: rest.length > 0,
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

async function downloadMacUpdateZip(asset, version, source) {
  const zipName = path.basename(String(asset.url || ''));
  if (!zipName.toLowerCase().endsWith('.zip')) throw new Error('zip_asset_invalid');
  const zipUrl = `${RELEASES_LATEST_URL}/download/${encodeURIComponent(zipName)}`;
  const zipPath = path.join(app.getPath('temp'), zipName);

  const res = await httpsGetFollow(zipUrl);
  const total = Number(res.headers['content-length'] || asset.size || 0);
  const hash = crypto.createHash('sha512');
  const out = fsSync.createWriteStream(zipPath);

  await new Promise((resolve, reject) => {
    let transferred = 0;
    res.on('data', (chunk) => {
      hash.update(chunk);
      transferred += chunk.length;
      if (total > 0) {
        const percent = Math.floor((transferred / total) * 100);
        if (percent !== lastUpdateProgressPercent) {
          lastUpdateProgressPercent = percent;
          // Same payload shape as the electron-updater 'download-progress' relay
          sendAutoUpdateStatus({
            status: 'downloading',
            source,
            percent,
            transferred,
            total,
            message: `Загрузка обновления: ${percent}%`,
          });
        }
      }
    });
    res.on('error', (err) => { out.destroy(); reject(err); });
    out.on('error', reject);
    out.on('finish', resolve);
    res.pipe(out);
  });

  // Integrity check: electron-builder publishes base64 sha512 in the manifest.
  // sha512 — единственный барьер целостности (сборка неподписана), поэтому его
  // ОТСУТСТВИЕ в манифесте — это отказ, а не «пропустить проверку»: иначе
  // обрезанный/подменённый ответ прошёл бы в ditto и запуск .app.
  const digest = hash.digest('base64');
  if (!asset.sha512 || digest !== asset.sha512) {
    await fs.unlink(zipPath).catch(() => {});
    throw new Error(asset.sha512 ? 'sha512_mismatch' : 'sha512_missing');
  }
  return zipPath;
}

async function runMacUpdateCheck(source = 'manual') {
  if (macUpdate.inProgress) {
    return { ok: true, source, already: true };
  }
  macUpdate.inProgress = true;
  try {
    sendAutoUpdateStatus({ status: 'checking', source, message: 'Проверка обновлений...' });
    const ymlText = await httpsGetText(LATEST_MAC_YML_URL);
    const manifest = parseLatestMacYml(ymlText);
    if (!manifest.version) throw new Error('manifest_parse_failed');

    if (compareSemver(manifest.version, app.getVersion()) <= 0) {
      sendAutoUpdateStatus({
        status: 'not-available',
        source,
        version: app.getVersion(),
        message: `Актуальная версия ${app.getVersion()}`,
      });
      return { ok: true, source };
    }

    // Prefer the arm64 zip (macOS builds are arm64-only), fall back to any zip
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const asset =
      files.find((f) => /arm64/i.test(f.url) && f.url.toLowerCase().endsWith('.zip')) ||
      files.find((f) => f.url.toLowerCase().endsWith('.zip'));
    if (!asset) throw new Error('zip file not provided');

    sendAutoUpdateStatus({
      status: 'available',
      source,
      version: manifest.version,
      message: `Найдена новая версия ${manifest.version}`,
    });

    // Already downloaded and verified this exact version — skip re-download
    if (macUpdate.downloaded && macUpdate.version === manifest.version && fsSync.existsSync(macUpdate.zipPath)) {
      sendAutoUpdateStatus({
        status: 'downloaded',
        source,
        version: manifest.version,
        message: `Обновление ${manifest.version} загружено`,
      });
      return { ok: true, source };
    }

    lastUpdateProgressPercent = -1;
    const zipPath = await downloadMacUpdateZip(asset, manifest.version, source);
    macUpdate.downloaded = true;
    macUpdate.zipPath = zipPath;
    macUpdate.version = manifest.version;
    updateDownloaded = true;
    lastUpdateProgressPercent = -1;
    sendAutoUpdateStatus({
      status: 'downloaded',
      source,
      version: manifest.version,
      message: `Обновление ${manifest.version} загружено`,
    });
    return { ok: true, source };
  } catch (error) {
    lastUpdateProgressPercent = -1;
    const message = normalizeUpdaterErrorMessage(error);
    sendAutoUpdateStatus({ status: 'error', source, message });
    return { ok: false, source, error: message };
  } finally {
    macUpdate.inProgress = false;
  }
}

/* Climb from the executable (….app/Contents/MacOS/<bin>) to the .app root. */
function resolveMacAppBundlePath() {
  let dir = app.getPath('exe');
  while (dir && dir !== path.dirname(dir)) {
    if (dir.endsWith('.app')) return dir;
    dir = path.dirname(dir);
  }
  return '';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function installMacDownloadedUpdate() {
  if (!macUpdate.downloaded || !macUpdate.zipPath || !fsSync.existsSync(macUpdate.zipPath)) {
    return { ok: false, error: 'not_downloaded' };
  }

  const appPath = resolveMacAppBundlePath();
  // Guards: the bundle must be swappable in place. Running off a mounted DMG
  // (/Volumes) or Gatekeeper-translocated copy can't be replaced — tell the
  // user to run the app from /Applications instead.
  if (!appPath || !appPath.endsWith('.app')) {
    return { ok: false, error: 'mac_manual_required' };
  }
  if (appPath.startsWith('/Volumes/')) {
    return { ok: false, error: 'mac_manual_required' };
  }
  if (/^\/private\/var\/folders\/[^/]+\/[^/]+\/AppTranslocation\//.test(appPath) || appPath.includes('/AppTranslocation/')) {
    return { ok: false, error: 'mac_manual_required' };
  }

  const tempDir = app.getPath('temp');
  const tag = `wadeck-update-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const stagingDir = path.join(tempDir, `${tag}-staging`);
  const oldDir = path.join(tempDir, `${tag}-old`);
  const scriptPath = path.join(tempDir, `${tag}.sh`);
  const logPath = path.join(tempDir, `${tag}.log`);

  // The script outlives our process: it waits for the app PID to exit, swaps
  // the bundle, strips quarantine, relaunches, and cleans up after itself.
  // Перезапуск гарантирован в ЛЮБОМ исходе (иначе при сбое ditto/mv приложение
  // просто не открылось бы снова — «краш»); ход пишется в лог для диагностики.
  const script = [
    '#!/bin/bash',
    '# WA-Deck self-update: swap the .app bundle after the app process exits.',
    `APP_PID=${process.pid}`,
    `ZIP_PATH=${shellQuote(macUpdate.zipPath)}`,
    `APP_PATH=${shellQuote(appPath)}`,
    `STAGING_DIR=${shellQuote(stagingDir)}`,
    `OLD_DIR=${shellQuote(oldDir)}`,
    `exec >>${shellQuote(logPath)} 2>&1`,
    'echo "[wadeck-update] start $(date)"',
    '',
    '# Wait until the running app fully exits',
    'while kill -0 "$APP_PID" 2>/dev/null; do sleep 0.3; done',
    '',
    'rm -rf "$STAGING_DIR" "$OLD_DIR"',
    'mkdir -p "$STAGING_DIR" "$OLD_DIR"',
    'SWAPPED=0',
    'if /usr/bin/ditto -xk "$ZIP_PATH" "$STAGING_DIR"; then',
    '  NEW_APP=$(/usr/bin/find "$STAGING_DIR" -maxdepth 1 -name "*.app" -print -quit)',
    '  if [ -n "$NEW_APP" ] && mv "$APP_PATH" "$OLD_DIR/"; then',
    '    if mv "$NEW_APP" "$APP_PATH"; then',
    '      /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null',
    '      SWAPPED=1',
    '    else',
    '      echo "[wadeck-update] final mv failed — rolling back"',
    '      mv "$OLD_DIR"/*.app "$APP_PATH" 2>/dev/null',
    '    fi',
    '  else',
    '    echo "[wadeck-update] no NEW_APP or move-aside failed"',
    '  fi',
    'else',
    '  echo "[wadeck-update] ditto extraction failed"',
    'fi',
    '# Гарантированный перезапуск: открываем бандл, где бы он ни оказался',
    'if [ -d "$APP_PATH" ]; then',
    '  /usr/bin/open -n "$APP_PATH" || echo "[wadeck-update] open failed"',
    'else',
    '  echo "[wadeck-update] APP_PATH missing after update — cannot relaunch"',
    'fi',
    'echo "[wadeck-update] done swapped=$SWAPPED $(date)"',
    '# OLD_DIR стираем ТОЛЬКО если приложение на месте: при двойном сбое mv',
    '# (rollback тоже не прошёл) там лежит единственная копия .app.',
    'if [ -d "$APP_PATH" ]; then',
    '  rm -rf "$OLD_DIR"',
    'else',
    '  echo "[wadeck-update] keeping $OLD_DIR — last app copy lives there"',
    'fi',
    'rm -rf "$STAGING_DIR" "$ZIP_PATH"',
    'rm -f "$0"',
    '',
  ].join('\n');

  try {
    await fs.writeFile(scriptPath, script, { mode: 0o700 });
  } catch (error) {
    return { ok: false, error: String(error?.message || error || 'script_write_failed') };
  }

  try {
    // Mirror the Windows flow: stop interfering quit handlers, flush the
    // store, tear the windows down, hand off to the installer, exit.
    _appIsQuitting = true;
    try { await _saveStoreQueue; } catch { /* flushed best-effort */ }

    for (const win of BrowserWindow.getAllWindows()) {
      win.removeAllListeners('close');
      win.destroy();
    }

    spawn('/bin/bash', [scriptPath], { detached: true, stdio: 'ignore' }).unref();
    setImmediate(() => app.exit(0));
    return { ok: true };
  } catch (error) {
    _appIsQuitting = false;
    return { ok: false, error: String(error?.message || error || 'install_failed') };
  }
}

function setupAutoUpdater() {
  if (autoUpdaterConfigured) {
    return;
  }
  autoUpdaterConfigured = true;

  if (!app.isPackaged) {
    sendAutoUpdateStatus({
      status: 'disabled',
      source: currentUpdateCheckSource,
      message: 'Обновление доступно только в собранной версии',
    });
    return;
  }

  autoUpdater.autoDownload = true;
  // Require explicit user confirmation before applying updates on quit.
  // The UI already shows an "Install and restart" prompt via the
  // update-downloaded event, so silent-on-quit offers no UX win but adds
  // supply-chain risk if the update server or GitHub account is compromised.
  autoUpdater.autoInstallOnAppQuit = false;
  // NSIS differential patches can be flaky on some Windows setups and cause integrity errors.
  autoUpdater.disableDifferentialDownload = true;

  autoUpdater.on('checking-for-update', () => {
    sendAutoUpdateStatus({ status: 'checking', source: currentUpdateCheckSource, message: 'Проверка обновлений...' });
  });

  autoUpdater.on('update-available', (info) => {
    sendAutoUpdateStatus({
      status: 'available',
      source: currentUpdateCheckSource,
      version: String(info?.version || ''),
      message: `Найдена новая версия ${String(info?.version || '')}`,
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    sendAutoUpdateStatus({
      status: 'not-available',
      source: currentUpdateCheckSource,
      version: String(info?.version || app.getVersion()),
      message: `Актуальная версия ${String(info?.version || app.getVersion())}`,
    });
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.floor(Number(progress?.percent || 0));
    if (percent === lastUpdateProgressPercent) return;
    lastUpdateProgressPercent = percent;
    sendAutoUpdateStatus({
      status: 'downloading',
      source: currentUpdateCheckSource,
      percent,
      transferred: Number(progress?.transferred || 0),
      total: Number(progress?.total || 0),
      message: `Загрузка обновления: ${percent}%`,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    lastUpdateProgressPercent = -1;
    sendAutoUpdateStatus({
      status: 'downloaded',
      source: currentUpdateCheckSource,
      version: String(info?.version || ''),
      message: `Обновление ${String(info?.version || '')} загружено`,
    });
  });

  autoUpdater.on('error', (error) => {
    lastUpdateProgressPercent = -1;
    sendAutoUpdateStatus({
      status: 'error',
      source: currentUpdateCheckSource,
      message: normalizeUpdaterErrorMessage(error),
    });
  });
}

function nextTemplateTitle() {
  let max = 0;
  for (const template of state.store.templates) {
    const match = String(template.title || '').match(/^Шаблон\s+(\d+)$/i);
    if (match) {
      max = Math.max(max, Number(match[1] || 0));
    }
  }
  return `Шаблон ${max + 1}`;
}

async function saveTemplate(payload = {}) {
  const id = String(payload?.id || '').trim();
  const title = clampString(String(payload?.title || '').trim() || nextTemplateTitle(), LIMITS.TEMPLATE_TITLE);
  const text = clampString(String(payload?.text || '').replace(/\r/g, ''), LIMITS.TEMPLATE_TEXT);
  const category = clampString(String(payload?.category || '').trim(), LIMITS.TEMPLATE_CATEGORY);

  if (!text.trim()) {
    return { ok: false, error: 'template_text_required' };
  }

  if (id) {
    const existing = state.store.templates.find((tpl) => tpl.id === id);
    if (!existing) return { ok: false, error: 'template_not_found' };

    existing.title = title;
    existing.text = text;
    existing.category = category;
    existing.updatedAt = new Date().toISOString();
    await saveStore();
    return { ok: true, template: { ...existing }, templates: state.store.templates.map((tpl) => ({ ...tpl })) };
  }

  // Guard against runaway template creation that could bloat store.json
  if (state.store.templates.length >= LIMITS.TEMPLATES_PER_USER) {
    return { ok: false, error: 'templates_limit_reached' };
  }

  const template = {
    id: `tpl_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
    title,
    text,
    category,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.store.templates.push(template);
  await saveStore();
  return { ok: true, template: { ...template }, templates: state.store.templates.map((tpl) => ({ ...tpl })) };
}

async function deleteTemplate(id) {
  const safeId = String(id || '').trim();
  if (!safeId) return { ok: false, error: 'template_not_found' };
  const before = state.store.templates.length;
  state.store.templates = state.store.templates.filter((tpl) => tpl.id !== safeId);
  if (state.store.templates.length === before) {
    return { ok: false, error: 'template_not_found' };
  }
  await saveStore();
  return { ok: true, templates: state.store.templates.map((tpl) => ({ ...tpl })) };
}

function registerIpc() {
  // Sender check on every channel: only the main window's own renderer may
  // invoke our IPC. Any other webContents (e.g. a compromised webview that
  // somehow reaches ipcRenderer) gets a uniform refusal.
  function handle(channel, fn) {
    ipcMain.handle(channel, (event, ...args) => {
      if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
        return { ok: false, error: 'forbidden' };
      }
      return fn(event, ...args);
    });
  }

  handle('bootstrap', async () => buildBootstrap());

  handle('add-account', async (_event, type) => {
    const accountType = (type === 'telegram') ? 'telegram' : 'whatsapp';
    const isTg = accountType === 'telegram';
    const idx = isTg ? nextTgIndex() : nextWpIndex();
    const prefix = isTg ? 'tg' : 'wa';
    const maxOrder = state.store.accounts.reduce((max, acc) => Math.max(max, Number(acc.order || 0)), 0);
    const account = {
      id: `${prefix}_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      type: accountType,
      name: isTg ? `TG_${idx}` : `WP_${idx}`,
      color: pickColor(idx),
      iconPath: '',
      frozen: false,
      order: maxOrder + 1,
      createdAt: new Date().toISOString(),
    };

    state.store.accounts.push(account);
    normalizeAccountOrder();
    await saveStore();

    return {
      ...accountToRuntimePayload(account),
    };
  });

  handle('remove-account', async (_event, accountId) => {
    return removeAccount(accountId);
  });

  handle('rename-account', async (_event, payload) => {
    return renameAccount(payload?.accountId, payload?.name);
  });

  handle('set-account-frozen', async (_event, payload) => {
    return setAccountFrozen(payload?.accountId, payload?.frozen);
  });
  handle('set-account-pinned', async (_event, payload) => {
    return setAccountPinned(payload?.accountId, payload?.pinned);
  });

  handle('move-account', async (_event, payload) => {
    return moveAccount(payload?.accountId, payload?.direction);
  });

  handle('pick-account-icon', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите иконку WhatsApp',
      properties: ['openFile'],
      filters: [
        { name: 'Изображения', extensions: ['png', 'jpg', 'jpeg'] },
      ],
    });
    if (result.canceled || !result.filePaths?.length) {
      return { canceled: true };
    }
    const picked = result.filePaths[0];
    // Return a file:// URL too so the renderer can preview the icon in the
    // modal chip immediately, before the user clicks Save.
    let url = '';
    try { url = pathToFileURL(picked).href; } catch { /* non-fatal */ }
    return { canceled: false, path: picked, url };
  });

  handle('set-account-icon', async (_event, payload) => {
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_payload' };
    return setAccountIcon(payload.accountId, payload.iconPath);
  });

  handle('set-account-color', async (_event, payload) => {
    const id = String(payload?.accountId || '').trim();
    const color = String(payload?.color || '').trim();
    if (!id || !color) return { ok: false, error: 'invalid_params' };
    // Only hex colors (#RGB / #RRGGBB / #RRGGBBAA) — renderer UI only emits these.
    // Rejects any string that could bleed into attribute injection contexts.
    if (!/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)) {
      return { ok: false, error: 'invalid_color' };
    }
    const account = state.store.accounts.find((a) => a.id === id);
    if (!account) return { ok: false, error: 'account_not_found' };
    account.color = color;
    await saveStore();
    return { ok: true, account: accountToRuntimePayload(account) };
  });

  handle('save-settings', async (_event, payload) => {
    const current = state.store.settings || {};
    const next = {
      uiTheme: String(payload?.uiTheme ?? current.uiTheme ?? DEFAULT_SETTINGS.uiTheme).toLowerCase() === 'light' ? 'light' : 'dark',
      uiTiles: String(payload?.uiTiles ?? current.uiTiles ?? DEFAULT_SETTINGS.uiTiles).toLowerCase() === 'calm' ? 'calm' : 'raw',
      weatherCity: String(payload?.weatherCity ?? current.weatherCity ?? DEFAULT_SETTINGS.weatherCity).trim() || DEFAULT_SETTINGS.weatherCity,
      weatherUnit: normalizeWeatherUnit(payload?.weatherUnit ?? current.weatherUnit ?? DEFAULT_SETTINGS.weatherUnit),
      lastSeenReleaseNotesVersion: String(
        payload?.lastSeenReleaseNotesVersion ?? current.lastSeenReleaseNotesVersion ?? DEFAULT_SETTINGS.lastSeenReleaseNotesVersion,
      ).trim(),
      worldClocks: Array.isArray(payload?.worldClocks)
        ? payload.worldClocks
            .slice(0, 10)
            .map((c) => ({ label: String(c?.label || '').trim().slice(0, 30), tz: String(c?.tz || '').trim().slice(0, 64) }))
            .filter((c) => c.label && c.tz)
        : (current.worldClocks || DEFAULT_SETTINGS.worldClocks),
      translatorEnabled: normalizeBool(
        payload?.translatorEnabled,
        normalizeBool(current.translatorEnabled, DEFAULT_SETTINGS.translatorEnabled),
      ),
      // Per-account тумблер «Авто вх. → Русский» (persist: раньше session-only
      // в webview и сбрасывался каждым рестартом/гибернацией)
      autoTranslateAccounts: (() => {
        const src = (payload && typeof payload.autoTranslateAccounts === 'object' && payload.autoTranslateAccounts)
          ? payload.autoTranslateAccounts
          : (current.autoTranslateAccounts || {});
        const out = {};
        for (const k of Object.keys(src).slice(0, 100)) {
          if (src[k]) out[String(k).slice(0, 64)] = true;
        }
        return out;
      })(),
      crmHoverEnabled: normalizeBool(
        payload?.crmHoverEnabled,
        normalizeBool(current.crmHoverEnabled, DEFAULT_SETTINGS.crmHoverEnabled),
      ),
      notificationsEnabled: normalizeBool(
        payload?.notificationsEnabled,
        normalizeBool(current.notificationsEnabled, DEFAULT_SETTINGS.notificationsEnabled),
      ),
      translateBatchEnabled: normalizeBool(
        payload?.translateBatchEnabled,
        normalizeBool(current.translateBatchEnabled, DEFAULT_SETTINGS.translateBatchEnabled),
      ),
      uiScene: (() => {
        const valid = ['night', 'day', 'rain', 'space', 'minimal'];
        const v = String(payload?.uiScene ?? current.uiScene ?? DEFAULT_SETTINGS.uiScene);
        return valid.includes(v) ? v : DEFAULT_SETTINGS.uiScene;
      })(),
      uiDensity: (() => {
        const valid = ['compact', 'cozy', 'spacious'];
        const v = String(payload?.uiDensity ?? current.uiDensity ?? DEFAULT_SETTINGS.uiDensity);
        return valid.includes(v) ? v : DEFAULT_SETTINGS.uiDensity;
      })(),
      tweaksCollapsed: normalizeBool(
        payload?.tweaksCollapsed,
        normalizeBool(current.tweaksCollapsed, DEFAULT_SETTINGS.tweaksCollapsed),
      ),
      hibernateAfterMinutes: normalizeHibernateMinutes(
        payload?.hibernateAfterMinutes,
        normalizeHibernateMinutes(current.hibernateAfterMinutes, DEFAULT_SETTINGS.hibernateAfterMinutes),
      ),
      // Сервер расшифровки: только http(s)-URL, хвостовые слэши срезаем;
      // всё невалидное схлопывается в '' (= локальная расшифровка).
      transcribeServerUrl: (() => {
        const v = String(payload?.transcribeServerUrl ?? current.transcribeServerUrl ?? '').trim().slice(0, 200);
        return /^https?:\/\/\S+$/i.test(v) ? v.replace(/\/+$/, '') : '';
      })(),
    };

    state.store.settings = next;
    await saveStore();
    return { ...state.store.settings };
  });

  handle('crm-load-contact', async (_event, payload) => {
    return loadCrmContact(payload?.accountId, payload?.accountName, payload?.contactName);
  });

  handle('crm-save-contact', async (_event, payload) => {
    return saveCrmContact(payload || {});
  });

  handle('list-templates', async () => {
    return { ok: true, templates: state.store.templates.map((tpl) => ({ ...tpl })) };
  });

  handle('save-template', async (_event, payload) => {
    return saveTemplate(payload || {});
  });

  handle('delete-template', async (_event, id) => {
    return deleteTemplate(id);
  });

  handle('pick-attachments', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, files: [] };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите вложения',
      properties: ['openFile', 'multiSelections'],
    });

    if (result.canceled || !result.filePaths?.length) return { canceled: true, files: [] };

    for (const filePath of result.filePaths) await rememberPickedPath(filePath);
    return {
      canceled: false,
      files: result.filePaths.map((filePath) => ({
        path: filePath,
        name: path.basename(filePath),
      })),
    };
  });

  /* ── Pick audio file for voice message ── */
  const MAX_VOICE_FILE_SIZE = 16 * 1024 * 1024; // 16 MB
  handle('pick-audio-file', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, error: 'no_window' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Выберите аудиофайл для голосового сообщения',
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: ['ogg', 'opus', 'mp3', 'wav', 'm4a', 'aac', 'weba'] },
      ],
    });
    if (result.canceled || !result.filePaths?.length) return { canceled: true };
    const filePath = result.filePaths[0];
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > MAX_VOICE_FILE_SIZE) {
        return { ok: false, error: 'file_too_large' };
      }
      const buff = await fs.readFile(filePath);
      return {
        ok: true,
        name: path.basename(filePath),
        size: stat.size,
        dataBase64: buff.toString('base64'),
        mime: guessMime(filePath),
      };
    } catch (err) {
      console.error('[pick-audio-file]', err);
      return { ok: false, error: 'read_failed' };
    }
  });

  handle('transcribe-voice', async (_event, payload) => {
    const wcId = Number(payload?.webContentsId);
    const voiceId = String(payload?.voiceId || '');
    if (!Number.isFinite(wcId) || !/^[a-z0-9]{1,32}$/i.test(voiceId)) {
      return { ok: false, error: 'bad_args' };
    }
    const contents = webContents.fromId(wcId);
    if (!contents || contents.isDestroyed() || contents.getType() !== 'webview'
        || !String(contents.getURL() || '').startsWith('https://web.whatsapp.com')) {
      return { ok: false, error: 'bad_target' };
    }
    // fire-and-forget: прогресс и результат рисуются плашкой у пузыря
    transcribeVoiceAt(contents, voiceId, mainWindow,
      String(state.store?.settings?.transcribeServerUrl || ''));
    return { ok: true };
  });

  handle('schedule-message', async (_event, payload) => {
    const accountId = String(payload?.accountId || '');
    const chatName = clampString(String(payload?.chatName || '').trim(), LIMITS.CHAT_NAME);
    const text = clampString(String(payload?.text || ''), LIMITS.MESSAGE_TEXT);
    const sendAt = String(payload?.sendAt || '');
    const parsedDate = new Date(sendAt);
    const rawAtt = Array.isArray(payload?.attachments) ? payload.attachments : [];
    if (rawAtt.length > LIMITS.ATTACHMENTS_PER_MSG) {
      return { ok: false, error: 'too_many_attachments' };
    }
    const attachments = rawAtt
      .map((att) => ({
        path: String(att?.path || ''),
        name: clampString(String(att?.name || path.basename(String(att?.path || ''))), 255),
      }))
      .filter((att) => att.path);

    // Reject attachments outside the user's home directory or touching
    // sensitive subtrees (.ssh, Keychains, etc.). Defeats XSS-driven
    // file exfiltration via the scheduled-send path.
    for (const att of attachments) {
      if (!(await isAttachmentPathAllowed(att.path))) {
        return { ok: false, error: 'attachment_path_not_allowed' };
      }
    }

    if (!state.store.accounts.find((acc) => acc.id === accountId)) {
      return { ok: false, error: 'account_not_found' };
    }
    if (!chatName) return { ok: false, error: 'chat_required' };
    if (!text.trim() && !attachments.length) return { ok: false, error: 'text_or_attachment_required' };
    if (Number.isNaN(parsedDate.getTime())) return { ok: false, error: 'invalid_sendAt' };
    if (parsedDate.getTime() < Date.now() + 3000) return { ok: false, error: 'sendAt_in_past' };

    // Prevent runaway scheduling that would bloat store.json
    const pendingCount = state.store.scheduled
      .filter((i) => ['pending', 'processing'].includes(i.status)).length;
    if (pendingCount >= LIMITS.SCHEDULED_PER_USER) {
      return { ok: false, error: 'scheduled_limit_reached' };
    }

    const repeat = REPEAT_KINDS.has(String(payload?.repeat || '')) ? String(payload.repeat) : '';
    const jitterMinutes = Math.max(0, Math.min(60, Math.round(Number(payload?.jitterMinutes) || 0)));
    // Jitter applies to the first occurrence too (clamped into the future) so
    // a repeating series never fires at a robotic exact minute.
    let sendAtMs = parsedDate.getTime();
    if (jitterMinutes) {
      sendAtMs = Math.max(Date.now() + 60000, sendAtMs + Math.round((Math.random() * 2 - 1) * jitterMinutes * 60000));
    }

    const item = {
      id: `sched_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      accountId,
      chatName,
      text,
      attachments,
      sendAt: new Date(sendAtMs).toISOString(),
      baseSendAt: parsedDate.toISOString(),
      repeat,
      jitterMinutes,
      repeatSpawned: false,
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      errorText: '',
    };

    state.store.scheduled.push(item);
    await saveStore();
    return { ok: true, item };
  });

  handle('list-scheduled', async (_event, payload) => {
    const accountId = String(payload?.accountId || '').trim();
    const limit = Math.max(1, Math.min(300, Number(payload?.limit) || 100));

    let items = state.store.scheduled;
    if (accountId) {
      items = items.filter((item) => item.accountId === accountId);
    }

    items = items
      .filter((item) => ['pending', 'processing', 'failed'].includes(item.status))
      .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime())
      .slice(0, limit);

    return { ok: true, items };
  });

  handle('claim-due-scheduled', async (_event, payload) => {
    const items = await claimDueScheduled(Number(payload?.limit) || 5);
    return { ok: true, items };
  });

  handle('complete-scheduled', async (_event, payload) => {
    return markScheduledResult(payload || {});
  });

  handle('cancel-scheduled', async (_event, id) => {
    return cancelScheduled(String(id || ''));
  });

  /* Make a pending/failed item due right now so the renderer's runner sends it
     on the next (immediately-kicked) tick. */
  handle('send-scheduled-now', async (_event, id) => {
    const item = state.store.scheduled.find((row) => row.id === String(id || ''));
    if (!item) return { ok: false, error: 'not_found' };
    if (!['pending', 'failed'].includes(item.status)) return { ok: false, error: 'invalid_status' };
    const nowIso = new Date().toISOString();
    item.status = 'pending';
    item.claimedAt = '';
    item.errorText = '';
    item.sendAt = nowIso; // due immediately
    item.updatedAt = nowIso;
    await saveStore();
    return { ok: true };
  });

  /* Postpone a pending/failed item by N minutes from max(now, its time). */
  handle('snooze-scheduled', async (_event, payload) => {
    const id = String(payload?.id || '');
    let minutes = Math.round(Number(payload?.minutes) || 0);
    if (!Number.isFinite(minutes) || minutes < 1) return { ok: false, error: 'bad_minutes' };
    minutes = Math.min(minutes, 1440);
    const item = state.store.scheduled.find((row) => row.id === id);
    if (!item) return { ok: false, error: 'not_found' };
    if (!['pending', 'failed'].includes(item.status)) return { ok: false, error: 'invalid_status' };
    const base = Math.max(Date.now(), new Date(item.sendAt).getTime() || 0);
    const nowIso = new Date().toISOString();
    item.status = 'pending';
    item.claimedAt = '';
    item.errorText = '';
    item.sendAt = new Date(base + minutes * 60000).toISOString();
    item.updatedAt = nowIso;
    await saveStore();
    return { ok: true, sendAt: item.sendAt };
  });

  /* Per-contact default outgoing translation language (used by translator bar). */
  function contactLangKey(accountId, chatName) {
    return `${accountId}\u0000${chatName}`;
  }
  const CONTACT_LANGS_MAX = 5000;
  handle('get-contact-lang', async (_event, payload) => {
    const accountId = String(payload?.accountId || '');
    // Same clamp as the setter — a >200-char chat name must build the same key
    // on both paths, or the saved language is never found again.
    const chatName = clampString(String(payload?.chatName || '').trim(), LIMITS.CHAT_NAME);
    if (!accountId || !chatName) return { ok: false, lang: '' };
    const lang = state.store.contactLangs?.[contactLangKey(accountId, chatName)] || '';
    return { ok: true, lang };
  });
  handle('set-contact-lang', async (_event, payload) => {
    const accountId = String(payload?.accountId || '');
    const chatName = clampString(String(payload?.chatName || '').trim(), LIMITS.CHAT_NAME);
    const lang = String(payload?.lang || '').trim().slice(0, 10);
    if (!accountId || !chatName) return { ok: false };
    if (!state.store.contactLangs || typeof state.store.contactLangs !== 'object') {
      state.store.contactLangs = {};
    }
    const key = contactLangKey(accountId, chatName);
    if (lang && /^[a-z-]{2,10}$/i.test(lang)) {
      state.store.contactLangs[key] = lang;
      // Entry cap like every other collection — evict oldest (insertion order)
      const keys = Object.keys(state.store.contactLangs);
      if (keys.length > CONTACT_LANGS_MAX) {
        for (const old of keys.slice(0, keys.length - CONTACT_LANGS_MAX)) {
          delete state.store.contactLangs[old];
        }
      }
    } else {
      delete state.store.contactLangs[key];
    }
    await saveStore();
    return { ok: true };
  });

  handle('favorites-toggle', async (_event, payload) => {
    const accountId = String(payload?.accountId || '').trim();
    const name = clampString(String(payload?.name || '').trim(), LIMITS.CHAT_NAME);
    if (!accountId || !name) return { ok: false, error: 'bad_args' };
    if (!state.store.accounts.some((acc) => acc.id === accountId)) {
      return { ok: false, error: 'account_not_found' };
    }
    if (!Array.isArray(state.store.favorites)) state.store.favorites = [];
    const key = accountId + '::' + name.toLowerCase();
    const idx = state.store.favorites.findIndex(
      (f) => String(f.accountId || '') + '::' + String(f.name || '').toLowerCase() === key,
    );
    let on;
    if (idx >= 0) {
      state.store.favorites.splice(idx, 1);
      on = false;
    } else {
      if (state.store.favorites.length >= LIMITS.FAVORITES_PER_USER) {
        return { ok: false, error: 'limit' };
      }
      state.store.favorites.push({ accountId, name });
      on = true;
      // exclusivity: a favorite cannot also be important
      if (Array.isArray(state.store.important)) {
        state.store.important = state.store.important.filter(
          (f) => String(f.accountId || '') + '::' + String(f.name || '').toLowerCase() !== key,
        );
      }
    }
    await saveStore();
    return {
      ok: true,
      on,
      favorites: state.store.favorites.map((f) => ({ ...f })),
      important: (state.store.important || []).map((f) => ({ ...f })),
    };
  });

  handle('important-toggle', async (_event, payload) => {
    const accountId = String(payload?.accountId || '').trim();
    const name = clampString(String(payload?.name || '').trim(), LIMITS.CHAT_NAME);
    if (!accountId || !name) return { ok: false, error: 'bad_args' };
    if (!state.store.accounts.some((acc) => acc.id === accountId)) {
      return { ok: false, error: 'account_not_found' };
    }
    if (!Array.isArray(state.store.important)) state.store.important = [];
    if (!Array.isArray(state.store.favorites)) state.store.favorites = [];
    const key = accountId + '::' + name.toLowerCase();
    const idx = state.store.important.findIndex(
      (f) => String(f.accountId || '') + '::' + String(f.name || '').toLowerCase() === key,
    );
    let on;
    if (idx >= 0) {
      state.store.important.splice(idx, 1);
      on = false;
    } else {
      if (state.store.important.length >= LIMITS.IMPORTANT_PER_USER) {
        return { ok: false, error: 'limit' };
      }
      state.store.important.push({ accountId, name });
      on = true;
      // exclusivity: an important contact cannot also be a favorite
      state.store.favorites = state.store.favorites.filter(
        (f) => String(f.accountId || '') + '::' + String(f.name || '').toLowerCase() !== key,
      );
    }
    await saveStore();
    return {
      ok: true,
      on,
      favorites: state.store.favorites.map((f) => ({ ...f })),
      important: (state.store.important || []).map((f) => ({ ...f })),
    };
  });

  /**
   * Attach local files to a webview's <input type="file"> via Chrome DevTools Protocol.
   * Used by the scheduled-send runner to deliver photo/video/document attachments —
   * JS can't set `input.files` programmatically, but CDP's DOM.setFileInputFiles can.
   */
  // Per-webContents CDP queue (send-attachments-via-cdp) — tail promises
  const _cdpQueues = new Map();

  handle('send-attachments-via-cdp', async (_event, payload) => {
    const id = Number(payload?.webContentsId);
    const selector = String(payload?.selector || '').trim();
    const files = Array.isArray(payload?.files) ? payload.files.map(String).filter(Boolean) : [];
    if (!id || !selector || !files.length) return { ok: false, error: 'bad_args' };

    // Verify every file actually exists on disk before attaching
    for (const filePath of files) {
      if (!(await isAttachmentPathAllowed(filePath))) {
        return { ok: false, error: `path_not_allowed:${path.basename(filePath)}` };
      }
      try {
        await fs.access(filePath);
      } catch {
        return { ok: false, error: `file_missing:${path.basename(filePath)}` };
      }
    }

    const contents = webContents.fromId(id);
    if (!contents || contents.isDestroyed()) {
      return { ok: false, error: 'webcontents_not_found' };
    }
    // Only ever attach the CDP debugger to one of OUR account webviews — never
    // the main window or any other webContents a compromised renderer might
    // name. getType()!=='webview' already excludes the host window; the URL
    // check ensures it's a live WhatsApp/Telegram page.
    if (contents.getType() !== 'webview') {
      return { ok: false, error: 'not_a_webview' };
    }
    const targetUrl = String(contents.getURL() || '');
    if (!/^https:\/\/(web\.whatsapp\.com|web\.telegram\.org)\//.test(targetUrl)) {
      return { ok: false, error: 'untrusted_target' };
    }

    // Serialize CDP work per webContents: with two overlapping calls the old
    // isAttached() heuristic made the first call's finally-detach kill the
    // second call's session mid-sendCommand.
    const cdpWork = async () => {
      const dbg = contents.debugger;
      let weAttached = false;
      let timeoutTimer = null;
      try {
        if (!dbg.isAttached()) {
          dbg.attach('1.3');
          weAttached = true;
        }
        // Guard the whole CDP sequence with a timeout: a wedged renderer can
        // leave sendCommand pending forever, which would hang the renderer's
        // await and keep the debugger attached indefinitely.
        const CDP_TIMEOUT_MS = 15000;
        const timeout = new Promise((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error('cdp_timeout')), CDP_TIMEOUT_MS);
        });
        const run = (async () => {
          await dbg.sendCommand('DOM.enable');
          const { root } = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
          const { nodeId } = await dbg.sendCommand('DOM.querySelector', {
            nodeId: root.nodeId,
            selector,
          });
          if (!nodeId) return { ok: false, error: 'input_not_found' };
          await dbg.sendCommand('DOM.setFileInputFiles', { nodeId, files });
          return { ok: true };
        })();
        return await Promise.race([run, timeout]);
      } catch (e) {
        if (String(e?.message || e) === 'cdp_timeout') {
          // Force-detach so the wedged target doesn't keep the debugger hostage
          try { dbg.detach(); } catch { /* ignore */ }
          weAttached = false; // already detached
          return { ok: false, error: 'cdp_timeout' };
        }
        return { ok: false, error: String(e?.message || e) };
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (weAttached) {
          try { dbg.detach(); } catch { /* ignore */ }
        }
      }
    };

    const prevTail = _cdpQueues.get(id) || Promise.resolve();
    const result = prevTail.catch(() => {}).then(cdpWork);
    const tail = result.catch(() => {});
    _cdpQueues.set(id, tail);
    tail.finally(() => {
      if (_cdpQueues.get(id) === tail) _cdpQueues.delete(id);
    });
    return result;
  });

  handle('open-data-dir', async () => {
    await shell.openPath(state.paths.userData);
    return { ok: true };
  });

  handle('get-clipboard-text', async () => {
    return { ok: true, text: clipboard.readText() };
  });

  handle('set-clipboard-text', async (_event, text) => {
    clipboard.writeText(clampString(text, LIMITS.CLIPBOARD_TEXT));
    return { ok: true };
  });

  handle('set-dock-badge', async (_event, payload) => {
    return setDockBadge(payload?.count, payload?.badge);
  });

  handle('check-for-updates', async (_event, payload) => {
    return checkForUpdatesNow(String(payload?.source || 'manual'));
  });

  handle('get-release-notes', async () => {
    return { ok: true, notes: await loadReleaseNotesFromChangelog() };
  });

  handle('focus-main-window', async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: false };
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return { ok: true };
  });

  handle('open-releases-page', async () => {
    safeOpenExternal(RELEASES_LATEST_URL);
    return { ok: true };
  });

  handle('install-downloaded-update', async () => {
    if (!app.isPackaged) {
      return { ok: false, error: 'not_packaged' };
    }
    // Custom macOS flow for unsigned builds: zip-swap via detached script.
    // All guards (not_downloaded, mac_manual_required) run BEFORE any window
    // is destroyed.
    if (process.platform === 'darwin' && !hasMacDeveloperIdSignature()) {
      return installMacDownloadedUpdate();
    }
    // Refuse before tearing windows down if nothing has been downloaded yet —
    // otherwise a premature click left the user with a dead, windowless app.
    if (!updateDownloaded) {
      return { ok: false, error: 'not_downloaded' };
    }
    try {
      // Prevent before-quit handler from interfering
      _appIsQuitting = true;

      // Flush pending store writes before exiting
      try { await _saveStoreQueue; } catch {}

      // Disable auto-install-on-quit to prevent double install
      autoUpdater.autoInstallOnAppQuit = false;

      // Close all windows before running the installer so NSIS does not
      // show a "please close the application" dialog in a loop.
      for (const win of BrowserWindow.getAllWindows()) {
        win.removeAllListeners('close');
        win.destroy();
      }

      // isSilent=true  — run NSIS silently (no "close app" dialog)
      // isForceRunAfter=true — relaunch the app after installation
      autoUpdater.quitAndInstall(true, true);
      return { ok: true };
    } catch (error) {
      _appIsQuitting = false;
      return { ok: false, error: String(error?.message || error || 'install_failed') };
    }
  });

  handle('translate-text', async (_event, payload) => {
    const text = clampString(payload?.text, LIMITS.TRANSLATE_TEXT);
    const from = String(payload?.from || 'auto').slice(0, 10);
    const to = String(payload?.to || 'en').slice(0, 10);
    // Lang codes: lowercase alpha-2/3 + optional 'auto'
    if (!/^[a-z-]{2,10}$/i.test(from) && from !== 'auto') return { ok: false, error: 'invalid_lang' };
    if (!/^[a-z-]{2,10}$/i.test(to)) return { ok: false, error: 'invalid_lang' };
    if (!text.trim()) return { ok: false, error: 'empty_text' };
    // LRU: повторные фразы и ре-переводы после перезагрузки webview — 0 мс.
    const cacheKey = `${from}|${to}|${text}`;
    const cached = _translateCache.get(cacheKey);
    if (cached !== undefined) {
      _translateCache.delete(cacheKey);
      _translateCache.set(cacheKey, cached); // освежить позицию в LRU
      return { ok: true, translated: cached, detected: '' };
    }

    // Батч-путь: только автоперевод входящих (batch:true) и только при
    // включённой настройке. Кнопка «Перевести» всегда идёт одиночным запросом
    // без 120 мс ожидания.
    const batchOk = payload?.batch === true
      && state.store?.settings?.translateBatchEnabled !== false
      && text.length <= 1500;
    if (batchOk) {
      return await new Promise((resolve) => {
        const key = `${from}|${to}`;
        let q = _trBatchQueues.get(key);
        if (!q) {
          q = { items: [], chars: 0, timer: null };
          q.timer = setTimeout(() => { _flushTranslateBatch(key).catch(() => {}); }, TRANSLATE_BATCH_WAIT_MS);
          _trBatchQueues.set(key, q);
        }
        q.items.push({ text, cacheKey, resolve });
        q.chars += text.length;
        if (q.items.length >= TRANSLATE_BATCH_MAX_ITEMS || q.chars > TRANSLATE_BATCH_MAX_CHARS) {
          _flushTranslateBatch(key).catch(() => {});
        }
      });
    }

    try {
      const r = await _translateFetchRetry(text, from, to);
      // Пустой результат не кэшируем: иначе разовый сбой навсегда отдавал бы
      // пустой перевод для этой фразы.
      _translateCacheSet(cacheKey, r.translated);
      return { ok: true, translated: r.translated, detected: r.detected };
    } catch (e) {
      return { ok: false, error: String(e?.message || 'translate_failed') };
    }
  });

  handle('template-used', async (_event, payload) => {
    const title = String(payload?.title || '').trim().toLowerCase().slice(0, 120);
    if (!title) return { ok: false };
    if (!state.store.templateUsage || typeof state.store.templateUsage !== 'object') {
      state.store.templateUsage = {};
    }
    const u = state.store.templateUsage;
    const rec = u[title] || { c: 0, t: 0 };
    rec.c = (Number(rec.c) || 0) + 1;
    rec.t = Date.now();
    u[title] = rec;
    const keys = Object.keys(u);
    if (keys.length > 500) {
      keys.sort((a, b) => (u[a].t || 0) - (u[b].t || 0));
      for (const k of keys.slice(0, keys.length - 500)) delete u[k];
    }
    saveStore().catch(() => {});
    return { ok: true };
  });

  handle('cleanup-cache', async () => cleanupHttpCachesForAllAccounts());
}

/*
 * Periodic safe HTTP cache cleanup.
 *
 * Chromium's per-partition HTTP cache (cached images/JS/CSS responses) and V8
 * code cache grow without bound across long sessions and slow disk reads after
 * a few days of usage. We clear these on a 6h interval — and crucially we DO
 * NOT touch cookies, localStorage, IndexedDB, or service-worker storage, which
 * is where WhatsApp Web (and Telegram Web) keeps the login session and message
 * history. Users stay logged in across cleanups; only redundant on-disk
 * response/code caches are reclaimed.
 *
 * The clear is awaited per-partition with a small gap so we never block the
 * event loop with N parallel disk operations on a busy machine.
 */
const CACHE_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
let _cacheCleanupTimer = null;
let _cacheCleanupBusy = false;

async function cleanupHttpCachesForAllAccounts() {
  if (_cacheCleanupBusy) return { ok: false, error: 'already_running' };
  _cacheCleanupBusy = true;
  const startedAt = Date.now();
  let cleared = 0;
  try {
    const accounts = Array.isArray(state.store.accounts) ? state.store.accounts : [];
    for (const acc of accounts) {
      try {
        const partition = partitionForAccount(acc.id, acc.type || 'whatsapp');
        const partitionSession = session.fromPartition(partition);
        await partitionSession.clearCache();
        if (typeof partitionSession.clearCodeCaches === 'function') {
          await partitionSession.clearCodeCaches({}).catch(() => {});
        }
        cleared++;
      } catch (err) {
        console.warn('[cache-cleanup] failed for account', acc.id, err?.message || err);
      }
    }
    console.log(`[cache-cleanup] cleared HTTP cache for ${cleared}/${accounts.length} accounts in ${Date.now() - startedAt}ms`);
    return { ok: true, cleared, total: accounts.length, ms: Date.now() - startedAt };
  } finally {
    _cacheCleanupBusy = false;
  }
}

/*
 * Power suspend/resume handling.
 *
 * After a long macOS sleep (closing the lid for >10 min), WhatsApp Web
 * sessions in our hidden webviews often end up in a "zombie" state: the
 * Electron-side socket is still alive, but the WA server has long since
 * dropped the connection. Without intervention, the user has to click each
 * account to force a reload — and incoming messages are silently missed in
 * the gap. We listen for `powerMonitor.resume` and, if the suspend lasted
 * over 10 min, ask the renderer to reload every webview in a staggered
 * sequence (200ms apart) so we do not hammer the disk with N concurrent
 * page loads.
 */
const RESUME_RELOAD_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
let _suspendStartedAt = null;

/*
 * Cleanup orphaned partition directories.
 *
 * Each account gets a Chromium partition (persist:wa_<id> or persist:tg_<id>)
 * that lives under <userData>/Partitions/. When the user removes an account
 * we already call `clearStorageData()`, but the Partitions directory itself
 * is left on disk. Across many add/remove cycles these orphan directories
 * accumulate — gigabytes of IndexedDB and HTTP cache that Chromium still
 * scans on every cold start, slowing everything down. On startup we
 * enumerate Partitions/, match against the live account list, and delete
 * directories whose owning account no longer exists. Safe by construction:
 * we only touch partitions whose name encodes an account id we no longer
 * have, and we never touch the active app's userData root.
 */
async function cleanupOrphanPartitions() {
  if (!state.paths.userData) return;
  if (storeLoadDegraded) {
    console.warn('[orphan-cleanup] skipped: store was recovered/reset this session, account list may be incomplete');
    return;
  }
  const partitionsDir = path.join(state.paths.userData, 'Partitions');
  let entries = [];
  try {
    entries = await fs.readdir(partitionsDir);
  } catch {
    return; // Partitions dir doesn't exist yet — nothing to clean
  }
  const liveIds = new Set(
    (state.store.accounts || []).map((acc) => {
      const prefix = (acc.type === 'telegram') ? 'tg' : 'wa';
      // Chromium URL-encodes the partition name; persist:wa_X becomes "wa_X"
      // on disk (the "persist:" prefix is stripped). Match against bare IDs.
      return `${prefix}_${acc.id}`;
    })
  );
  let removed = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    // Only consider names that match our scheme. Leave anything else alone.
    if (!/^(wa|tg)_/.test(entry)) continue;
    if (liveIds.has(entry)) continue;
    const full = path.join(partitionsDir, entry);
    try {
      const stat = await fs.stat(full).catch(() => null);
      if (stat && stat.isDirectory()) {
        // Approximate size — best-effort, don't recurse on failure
        try {
          const size = await dirSizeBytes(full);
          totalBytes += size;
        } catch { /* ignore */ }
        await rmWithRetry(full);
        removed++;
      }
    } catch (err) {
      console.warn('[orphan-cleanup] failed to remove', entry, err?.message || err);
    }
  }
  if (removed > 0) {
    console.log(`[orphan-cleanup] removed ${removed} orphaned partition(s), reclaimed ~${Math.round(totalBytes / 1024 / 1024)} MB`);
  }
}

async function dirSizeBytes(dirPath) {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await dirSizeBytes(full);
    } else {
      try {
        const s = await fs.stat(full);
        total += s.size;
      } catch { /* ignore */ }
    }
  }
  return total;
}

function setupPowerMonitor() {
  powerMonitor.on('suspend', () => {
    _suspendStartedAt = Date.now();
    console.log('[power] system suspended');
  });
  powerMonitor.on('resume', () => {
    const wasSuspendedFor = _suspendStartedAt ? Date.now() - _suspendStartedAt : 0;
    _suspendStartedAt = null;
    console.log(`[power] system resumed after ${Math.round(wasSuspendedFor / 1000)}s`);
    if (wasSuspendedFor >= RESUME_RELOAD_THRESHOLD_MS && mainWindow && !mainWindow.isDestroyed()) {
      // Give the network stack a moment to re-establish before triggering reloads.
      setTimeout(() => {
        try {
          mainWindow.webContents.send('system-resumed-after-sleep', { suspendedMs: wasSuspendedFor });
        } catch (err) {
          console.warn('[power] failed to notify renderer:', err?.message || err);
        }
      }, 2000);
    }
  });
}

function startPeriodicCacheCleanup() {
  if (_cacheCleanupTimer) return;
  // Run once at startup after a short delay (let webviews finish loading first
  // so the clear hits a quiescent disk), then every 6 hours.
  setTimeout(() => {
    cleanupHttpCachesForAllAccounts().catch((err) => console.error('[cache-cleanup]', err));
  }, 5 * 60 * 1000); // 5 minutes after launch
  _cacheCleanupTimer = setInterval(() => {
    cleanupHttpCachesForAllAccounts().catch((err) => console.error('[cache-cleanup]', err));
  }, CACHE_CLEANUP_INTERVAL_MS);
}

/* Уборка папки данных: аварийные копии store (.corrupt-*, .suspect) и
 * хвосты атомарных записей (.tmp-*) старше 30 дней; остатки апдейтера в temp
 * (wadeck-update-*) старше 3 дней. Живые файлы (.backup, .snap-* с ротацией 7)
 * не трогаем. Best-effort, раз в запуск. */
async function cleanupJunkFiles() {
  const DAY = 24 * 3600 * 1000;
  const now = Date.now();
  try {
    const dir = app.getPath('userData');
    for (const f of await fs.readdir(dir)) {
      if (!/\.corrupt-|\.suspect$|\.tmp-/.test(f)) continue;
      const full = path.join(dir, f);
      try {
        const st = await fs.stat(full);
        if (st.isFile() && now - st.mtimeMs > 30 * DAY) await fs.rm(full, { force: true });
      } catch { /* ignore */ }
    }
  } catch (e) { console.warn('[junk-cleanup] userData:', e?.message || e); }
  try {
    const tmp = app.getPath('temp');
    for (const f of await fs.readdir(tmp)) {
      if (!/^wadeck-update-/.test(f)) continue;
      const full = path.join(tmp, f);
      try {
        const st = await fs.stat(full);
        if (now - st.mtimeMs > 3 * DAY) await fs.rm(full, { recursive: true, force: true });
      } catch { /* ignore */ }
    }
  } catch (e) { console.warn('[junk-cleanup] temp:', e?.message || e); }
}

async function bootstrap() {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
  }
  ensurePaths();
  cleanupStaleModels();
  await loadStore();
  _lastGoodAccountCount = Array.isArray(state.store?.accounts) ? state.store.accounts.length : 0;
  pruneFinishedScheduled();
  recoverStaleProcessingItems();
  ensureDefaultAccount();
  // Boot-time save must not kill bootstrap on a full disk — log and continue.
  await saveStore().catch((err) => console.error('[bootstrap] initial save failed:', err));

  setupWebviewGuards();
  registerIpc();
  createWindow();

  /* GPU / utility process death. The GPU process is shared by the whole app;
     after a long session (many always-hot webview compositor layers exhaust GPU
     memory) it can crash/OOM, and Chromium's new GPU process sometimes fails to
     repaint — leaving a black window until manual restart. Recover by reloading
     the renderer, but ONLY on a genuine crash/oom (not orderly 'killed'/
     'clean-exit' restarts, which are routine and would make a reload disruptive)
     and via recoverMainWindow, which refuses to act until the renderer's first
     load (guards the startup sandbox race) and throttles against crash-loops. */
  app.on('child-process-gone', (_event, details) => {
    console.error('[main] child-process-gone:', details?.type, 'reason:', details?.reason, 'exitCode:', details?.exitCode);
    if (details?.type === 'GPU' && (details?.reason === 'crashed' || details?.reason === 'oom')) {
      recoverMainWindow('gpu-process-gone');
    }
  });

  setupAutoUpdater();
  scheduleBackgroundUpdateChecks();
  startPeriodicCacheCleanup();
  setupPowerMonitor();
  cleanupOrphanPartitions().catch((err) => console.warn('[orphan-cleanup]', err?.message || err));
  setTimeout(() => { cleanupJunkFiles().catch(() => {}); }, 60 * 1000);
}

// Keep-alive strategy lives at the top of this file (commandLine switches) and
// in setupWebviewGuards (contents.setBackgroundThrottling(false)). We avoid
// --disable-renderer-backgrounding because it pinned CPU with many accounts.
// Scheduled sends still use targeted webview.reload() wake-up (schedule.js)
// for cases where WA Web needs a fresh DOM pass before composing a message.

/* Global error handlers — prevent silent crashes and data loss */
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED] promise rejection:', reason);
});

if (addSingleInstanceGuard()) {
  app.whenReady().then(bootstrap).catch((error) => {
    console.error('[bootstrap]', error);
    app.quit();
  });

  /* Flush pending store writes before exit */
  app.on('before-quit', async (event) => {
    if (_appIsQuitting) return;
    _appIsQuitting = true;
    event.preventDefault();
    try {
      // Bounded wait: a wedged disk write (stalled network volume, hung
      // fsync) must not make the app unquittable.
      await Promise.race([
        _saveStoreQueue,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]);
    } catch (err) {
      console.error('[before-quit] save flush failed:', err);
    }
    app.exit(0);
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

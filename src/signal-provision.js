/* Автоустановка signal-cli — чтобы Signal работал «из коробки».
 *
 * У signal-cli нет native-сборок под macOS и Windows (только Linux), есть
 * только JVM-дистрибутив, которому нужна Java 25. Поэтому дека приносит обе
 * части сама, в userData, при первом добавлении Signal:
 *   1. signal-cli (jar-ы + launcher) — релиз с GitHub;
 *   2. Temurin JRE — только если в системе нет Java 25+ (тогда экономим ~45 МБ).
 * Всё скачанное проверяется по sha256; распаковка идёт во временный каталог и
 * переезжает на место одним rename — оборванная загрузка не оставляет
 * полурабочей установки.
 *
 * Версии закреплены намеренно: ссылка и хеш должны совпадать, а «последний
 * релиз» на лету означал бы установку непроверенного нами кода. */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const IS_WIN = process.platform === 'win32';

const CLI = {
  version: '0.14.7',
  url: 'https://github.com/AsamK/signal-cli/releases/download/v0.14.7/signal-cli-0.14.7.tar.gz',
  sha256: '0e1eefdf4a2109edf7c899c9d1667167c54ac12c3ec824f27db7c1dac4fa7506',
  size: 120235141,
  archive: 'signal-cli.tar.gz',
};

/* Temurin 25 (jre, hotspot) — signal-cli 0.14.x собран под Java 25 (class file
   69), на Java 21 падает с UnsupportedClassVersionError. Windows отдаётся
   zip-ом: tar на Windows 10+ (bsdtar) распаковывает и его, поэтому путь
   распаковки один на все системы. */
const JRE_MAJOR = 25;
const JRE = {
  'darwin-arm64': {
    url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_aarch64_mac_hotspot_25.0.4.1_1.tar.gz',
    sha256: '5b02bcc908da092e7e00b9772d4f9bbb87f44a60b7c90f7cf5a91a1d98f37e1b',
    size: 56208642,
    archive: 'jre.tar.gz',
  },
  'darwin-x64': {
    url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_x64_mac_hotspot_25.0.4.1_1.tar.gz',
    sha256: '099cbc182af99ab454991a4230f0bdbf2b2ee3f61ce462d637aceaa12709380d',
    size: 42138276,
    archive: 'jre.tar.gz',
  },
  'win32-x64': {
    url: 'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_x64_windows_hotspot_25.0.4.1_1.zip',
    sha256: '4c95451cea98556def2c54f7782933f52a26d4a36bd85e1d59f0364464828b07',
    size: 58475080,
    archive: 'jre.zip',
  },
};

const jreSpec = () => JRE[`${process.platform}-${process.arch}`] || null;

/* ── пути ─────────────────────────────────────────────────────────────── */

const rootDir = (userData) => path.join(userData, 'signal-runtime');
const cliDir = (userData) => path.join(rootDir(userData), `signal-cli-${CLI.version}`);
const jreDir = (userData) => path.join(rootDir(userData), 'jre');

function cliBinPath(userData) {
  return path.join(cliDir(userData), 'bin', IS_WIN ? 'signal-cli.bat' : 'signal-cli');
}

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };

/* Результаты кешируем: обе проверки дороги (запуск java и обход дерева JRE),
   а зовутся они при каждом разрешении пути к signal-cli — в main-процессе это
   значит подвисания интерфейса. Кеш сбрасывается после установки. */
const _cache = { sysJava: undefined, javaHome: new Map() };
function resetCache() { _cache.sysJava = undefined; _cache.javaHome.clear(); }

/* JAVA_HOME внутри распакованного JRE ищем по факту (у macOS это
   Contents/Home, у Windows — корень), а не по зашитому имени каталога. */
function findJavaHome(dir) {
  if (_cache.javaHome.has(dir)) return _cache.javaHome.get(dir);
  const found = scanJavaHome(dir);
  // пустой результат не кешируем: каталог появится сразу после распаковки
  if (found) _cache.javaHome.set(dir, found);
  return found;
}

function scanJavaHome(dir) {
  const bin = IS_WIN ? 'java.exe' : 'java';
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard++ < 400) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (e.name === bin && path.basename(cur) === 'bin') return path.dirname(cur);
    }
  }
  return '';
}

/* Java в системе: годится только 25+, иначе signal-cli не стартует
   (собран под class file 69) */
function systemJavaHome() {
  if (_cache.sysJava !== undefined) return _cache.sysJava;
  _cache.sysJava = detectSystemJava();
  return _cache.sysJava;
}

function detectSystemJava() {
  const home = String(process.env.JAVA_HOME || '').trim();
  const candidates = home ? [path.join(home, 'bin', IS_WIN ? 'java.exe' : 'java')] : [];
  candidates.push('java');
  for (const java of candidates) {
    try {
      const r = spawnSync(java, ['-version'], { encoding: 'utf8', shell: IS_WIN });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const m = out.match(/version "(\d+)/);
      if (m && Number(m[1]) >= JRE_MAJOR) return java === 'java' ? 'PATH' : home;
    } catch { /* нет такой java */ }
  }
  return '';
}

/* Готовый рантайм: путь к launcher-у и JAVA_HOME для него (пустой — java из
   системы). Возвращает null, если ставить ещё нечего. */
function provisioned(userData) {
  const bin = cliBinPath(userData);
  if (!exists(bin)) return null;
  const own = findJavaHome(jreDir(userData));
  if (own) return { bin, javaHome: own };
  return systemJavaHome() ? { bin, javaHome: '' } : null;
}

/* ── загрузка ─────────────────────────────────────────────────────────── */

function download(url, dest, expectSha, expectSize, onBytes) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let got = 0;
    let redirects = 0;

    const go = (target) => {
      https.get(target, { headers: { 'User-Agent': 'OmniDeck' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (++redirects > 6) return reject(new Error('too_many_redirects'));
          return go(new URL(res.headers.location, target).toString());
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`http_${res.statusCode}`)); }
        const total = Number(res.headers['content-length'] || expectSize || 0);
        const file = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          hash.update(chunk);
          got += chunk.length;
          if (onBytes) onBytes(got, total);
        });
        res.pipe(file);
        file.on('error', reject);
        file.on('finish', () => {
          const sum = hash.digest('hex');
          if (expectSha && sum !== expectSha) return reject(new Error('checksum_mismatch'));
          resolve();
        });
      }).on('error', reject);
    };
    go(url);
  });
}

/* tar есть и в macOS, и в Windows 10+ (bsdtar), и понимает оба формата */
function extract(archive, into) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xf', archive, '-C', into], { shell: IS_WIN });
    let err = '';
    p.stderr.on('data', (c) => { err += String(c).slice(0, 200); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar_failed:${err.trim()}`))));
  });
}

/* ── установка ────────────────────────────────────────────────────────── */

/* onProgress({ stage, percent }) — stage: 'cli' | 'jre' | 'unpack' */
async function provision(userData, onProgress = () => {}, isCancelled = () => false) {
  const ready = provisioned(userData);
  if (ready) return { ok: true, ...ready };

  const root = rootDir(userData);
  await fsp.mkdir(root, { recursive: true });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'omnideck-signal-'));
  const cancelled = () => { if (isCancelled()) throw new Error('cancelled'); };

  try {
    let javaHome = '';
    if (!exists(cliBinPath(userData))) {
      const archive = path.join(tmp, CLI.archive);
      cancelled();
      await download(CLI.url, archive, CLI.sha256, CLI.size, (got, total) => {
        onProgress({ stage: 'cli', percent: total ? Math.round((got / total) * 100) : 0 });
      });
      cancelled();
      onProgress({ stage: 'unpack', percent: 0 });
      const stage = path.join(tmp, 'cli');
      await fsp.mkdir(stage, { recursive: true });
      await extract(archive, stage);
      /* Архив разворачивается в signal-cli-<версия>/ — переносим этот каталог
         целиком, чтобы на месте либо ничего, либо готовая установка. */
      const inner = path.join(stage, `signal-cli-${CLI.version}`);
      const from = exists(inner) ? inner : stage;
      await fsp.rm(cliDir(userData), { recursive: true, force: true });
      await fsp.rename(from, cliDir(userData));
      if (!IS_WIN) { try { await fsp.chmod(cliBinPath(userData), 0o755); } catch { /* ignore */ } }
    }

    if (!systemJavaHome()) {
      javaHome = findJavaHome(jreDir(userData));
      if (!javaHome) {
        const spec = jreSpec();
        if (!spec) return { ok: false, error: 'no_jre_for_platform' };
        const archive = path.join(tmp, spec.archive);
        cancelled();
        await download(spec.url, archive, spec.sha256, spec.size, (got, total) => {
          onProgress({ stage: 'jre', percent: total ? Math.round((got / total) * 100) : 0 });
        });
        cancelled();
        onProgress({ stage: 'unpack', percent: 50 });
        const stage = path.join(tmp, 'jre');
        await fsp.mkdir(stage, { recursive: true });
        await extract(archive, stage);
        await fsp.rm(jreDir(userData), { recursive: true, force: true });
        await fsp.rename(stage, jreDir(userData));
        javaHome = findJavaHome(jreDir(userData));
        if (!javaHome) return { ok: false, error: 'jre_layout_unexpected' };
      }
    }

    const bin = cliBinPath(userData);
    if (!exists(bin)) return { ok: false, error: 'cli_missing_after_unpack' };
    resetCache();
    onProgress({ stage: 'unpack', percent: 100 });
    return { ok: true, bin, javaHome };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e).slice(0, 120) };
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/* Полный размер загрузки — показываем человеку до старта */
function downloadSizeMb() {
  const jre = systemJavaHome() ? 0 : (jreSpec()?.size || 0);
  return Math.round((CLI.size + jre) / 1048576);
}

/* Как запускать наш signal-cli. НЕ через bin/signal-cli(.bat): тот скрипт
   перечисляет все 74 jar-а по одному, и на Windows развёрнутая команда упирается
   в лимит cmd.exe (8191 символа) — при чуть более длинном имени пользователя она
   просто обрезается, и запуск молча не происходит. Зовём java напрямую с
   classpath-маской lib/*: её разворачивает сама Java, команда остаётся короткой,
   а заодно исчезают пляски с .bat, оболочкой и кавычками.
   --enable-native-access=ALL-UNNAMED — из штатного launcher-а: без него Java 25
   ругается на нативные вызовы libsignal. */
function launchSpec(userData) {
  const p = provisioned(userData);
  if (!p) return null;
  const java = p.javaHome
    ? path.join(p.javaHome, 'bin', IS_WIN ? 'java.exe' : 'java')
    : (IS_WIN ? 'java.exe' : 'java');
  return {
    cmd: java,
    prefix: [
      '--enable-native-access=ALL-UNNAMED',
      '-classpath', path.join(cliDir(userData), 'lib', '*'),
      'org.asamk.signal.Main',
    ],
  };
}

module.exports = { provision, provisioned, launchSpec, cliBinPath, downloadSizeMb, systemJavaHome, CLI_VERSION: CLI.version };

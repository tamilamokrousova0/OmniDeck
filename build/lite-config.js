#!/usr/bin/env node
/* Конфиг electron-builder для лайт-сборки.
 *
 * Раньше отличия передавались флагами `-c.productName='OmniDeck Lite'`, но это
 * ломалось на Windows: npm там запускает скрипты через cmd, где одинарные
 * кавычки не кавычки, и аргумент со пробелом распадался на два. А двойные
 * кавычки ломали бы `${version}` на macOS — sh раскрывает его в пустоту.
 * Поэтому конфиг генерируется файлом: берём build из package.json и
 * накладываем отличия лайта. Дрейфа между сборками не будет — база одна.
 *
 * Запуск: node build/lite-config.js mac|win  → dist/.lite-build.json
 */
const fs = require('fs');
const path = require('path');

const platform = process.argv[2];
if (!['mac', 'win'].includes(platform)) {
  console.error('usage: node build/lite-config.js mac|win');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const config = JSON.parse(JSON.stringify(pkg.build));

config.appId = 'com.local.wadeck.lite';
config.productName = 'OmniDeck Lite';
/* Свой канал обновлений: лайт читает lite-mac.yml / lite.yml, обычная дека —
   latest-*.yml. Ни одна сборка не видит чужие метаданные и не может
   «обновиться» в другую. */
config.publish = {
  provider: 'github',
  owner: 'tamilamokrousova0',
  repo: 'OmniDeck',
  channel: 'lite',
};

// Ни whisper, ни llama, ни примеры брифа в лайте не нужны: вырезанные функции.
/* Своя иконка: имена бандлов и так разные («OmniDeck Lite.app»), но в доке и
   Finder обе сборки выглядели одинаково — светлая плитка вместо тёмной решает
   это без единого слова. PNG electron-builder сам конвертирует в icns и ico. */
const liteIcon = 'assets/icon/omnideck-lite-icon-1024.png';

const empty = [{ from: 'build/empty', to: 'empty' }];
config.mac = { ...config.mac, icon: liteIcon, extraResources: empty, artifactName: 'OmniDeck-Lite-${version}-${arch}.${ext}' };
config.win = { ...config.win, icon: liteIcon, extraResources: empty, artifactName: 'OmniDeck-Lite-${version}-${arch}.${ext}' };
/* installerIcon/uninstallerIcon НЕ переопределяем: makensis принимает только
   настоящий .ico, а PNG роняет сборку («invalid icon file»). Иконку самого
   приложения electron-builder конвертирует из PNG сам, поэтому в системе
   лайт всё равно выглядит по-своему; окно установщика остаётся с базовой. */
config.nsis = { ...config.nsis, shortcutName: 'OmniDeck Lite', uninstallDisplayName: 'OmniDeck Lite ${version}' };

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', '.lite-build.json');
fs.writeFileSync(out, JSON.stringify(config, null, 2));
console.log(`[lite-config] ${platform}: ${out}`);

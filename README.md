# OmniDeck (ранее WA Deck)

Electron-«дека» для WhatsApp, Telegram и Signal: мульти-аккаунты, перевод, отложенная отправка, CRM.

## Локальный запуск

```bash
npm install
npm start
```

## Сборка релизов

### macOS Apple Silicon (.dmg)

```bash
npm run dist:mac
```

### Windows x64 (.exe, NSIS)

```bash
npm run dist:win
```

### Оба таргета

```bash
npm run dist:all
```

Готовые артефакты: `dist/`.

## Автообновление через GitHub Releases

В проекте включён `electron-updater` с `publish.provider = github` (`tamilamokrousova0/OmniDeck`).

Как работает:
- в упакованной версии приложение один раз проверяет обновления через ~30 секунд после старта (и всегда — по кнопке в настройках);
- если найден новый релиз, он скачивается автоматически;
- после загрузки появится диалог с предложением перезапустить приложение для установки.

Важно:
- автообновление работает только в packaged-сборке (не в `npm start`);
- релизы нужно публиковать в GitHub Releases с повышением версии в `package.json`;
- для публикации из CI/локально обычно нужен `GH_TOKEN`.

## Публикация релиза (кратко)

1. Обновить `version` в `package.json`.
2. Сделать коммит и `git push`.
3. Собрать артефакты (`dist:mac`, `dist:win`).
4. Загрузить артефакты в новый GitHub Release той же версии (`vX.Y.Z`).

## Подпись сборок (Gatekeeper / SmartScreen)

Подпись включается **наличием секретов в GitHub Actions** — без них сборки остаются
неподписанными и всё работает как раньше (на macOS первый запуск скачанного DMG
требует снять карантин: `xattr -dr com.apple.quarantine "/Applications/OmniDeck.app" (для старых установок — "WA Deck.app")`).

### macOS (нужен Apple Developer Program, $99/год)

1. В Xcode/developer.apple.com создать сертификат **Developer ID Application**, экспортировать в `.p12`.
2. Секреты репозитория:
   - `MAC_CSC_LINK` — `.p12` в base64 (`base64 -i cert.p12 | pbcopy`);
   - `MAC_CSC_KEY_PASSWORD` — пароль от `.p12`;
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` (пароль приложения с appleid.apple.com), `APPLE_TEAM_ID` — для нотаризации.
3. Готово: релизная сборка будет подписана и нотаризована, Gatekeeper перестанет ругаться,
   и автообновление переключится на штатный путь electron-updater (без кастомного zip-свапа).

### Windows (code-signing сертификат, OV/EV)

1. Купить code-signing сертификат (Sectigo/DigiCert и т.п.), экспортировать в `.pfx`.
2. Секреты: `WIN_CSC_LINK` (base64 `.pfx`), `WIN_CSC_KEY_PASSWORD`.
3. SmartScreen перестанет показывать «Неизвестный издатель» (для OV — после набора репутации, для EV — сразу).

Конфиг hardened runtime и entitlements уже в `package.json` / `build/entitlements.mac.plist`.

## Примечания

- Отложенная отправка работает, пока приложение запущено.
- Надёжность DOM-автоматизации зависит от изменений интерфейса WhatsApp Web.
- Глобальный поиск контакта по всем аккаунтам: `Cmd/Ctrl+K`.

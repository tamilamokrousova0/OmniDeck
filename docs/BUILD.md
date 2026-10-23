# Сборка и публикация

Техническая часть, вынесенная из README.

## Локальный запуск

```bash
npm install
npm start
```

Бандл интерфейса собирается отдельно:

```bash
npm run build:renderer
```

`src/renderer/dist/` в `.gitignore` — в CI бандл собирается заново, иначе
упакованное приложение откроется пустым окном.

## Сборка артефактов

| Команда | Результат |
|---|---|
| `npm run dist:mac` | macOS Apple Silicon, `.dmg` и `.zip` |
| `npm run dist:win` | Windows x64, NSIS `.exe` |
| `npm run dist:all` | оба таргета |

Готовые файлы кладутся в `dist/`.

macOS собирается **только под arm64**. Intel-сборок нет и не планируется.

## Релиз

Публикацию делает GitHub Actions по пушу тега `v*`:

1. Поднять `version` в `package.json` и `package-lock.json`.
2. Закоммитить, `git push origin main`.
3. `git tag -a vX.Y.Z -m "OmniDeck X.Y.Z"` и `git push origin vX.Y.Z`.
4. Workflow соберёт macOS и Windows и создаст GitHub Release.

## Автообновление

Включён `electron-updater`, провайдер — GitHub, репозиторий
`tamilamokrousova0/OmniDeck`.

- Упакованное приложение проверяет обновления через ~30 секунд после старта и
  затем раз в 12 часов; кнопка в настройках проверяет вручную.
- Найденное обновление скачивается автоматически, затем предлагается перезапуск.
- В `npm start` автообновление не работает по определению.

Для неподписанных сборок macOS используется собственный путь обновления:
приложение скачивает `.zip`, проверяет sha512 и подменяет бандл отдельным
скриптом после выхода процесса. Как только появится подпись Developer ID,
приложение само переключится на штатный путь `electron-updater`.

## Подпись

Подпись включается **наличием секретов в репозитории**. Без них сборки остаются
неподписанными и всё продолжает работать.

### macOS (нужен Apple Developer Program)

1. Создать сертификат **Developer ID Application**, экспортировать в `.p12`.
2. Секреты репозитория:
   - `MAC_CSC_LINK` — `.p12` в base64 (`base64 -i cert.p12 | pbcopy`)
   - `MAC_CSC_KEY_PASSWORD` — пароль от `.p12`
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — для нотаризации

После этого Gatekeeper перестанет требовать снятия карантина.

Внимание: whisper-бинарь лежит в `Contents/Resources` и при включении подписи
его нужно подписывать отдельно, иначе нотаризация завернёт сборку.

### Windows

1. Купить code-signing сертификат (OV или EV), экспортировать в `.pfx`.
2. Секреты: `WIN_CSC_LINK` (base64 `.pfx`), `WIN_CSC_KEY_PASSWORD`.

С EV предупреждение SmartScreen исчезает сразу, с OV — после набора репутации.

Hardened runtime и entitlements настроены в `package.json` и
`build/entitlements.mac.plist`.

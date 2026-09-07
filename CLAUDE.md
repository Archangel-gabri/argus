# Argus (каталог Nexus-One)

Однопользовательский local-first Electron command center: свои устройства/серверы, финансы, подписки и ИИ-доступы.
Имя каталога историческое; не переименовывать его вместе с названием приложения.
Общие правила — [корневой CLAUDE.md](../../CLAUDE.md), продукт и команды — [README.md](README.md).

## Источники и устройство

- [.proeb/project.json](.proeb/project.json) — ручной паспорт; старый generated context-pack не считать текущим планом.
- `package.json` и lockfile — зависимости, Node/npm policy и команды; не копировать версии из старых заметок.
- `src/main/` — IPC, сеть, SSH, финансы и хранилище; `src/preload/` — мост; `src/renderer/` — React/TypeScript UI.
- `src/main/windows.ts` — общая hardened-конфигурация окон; сохранять contextIsolation/sandbox и отсутствие nodeIntegration.
- `src/main/vault/` — SQLCipher, ключи, миграции и seed-file; `agent/` — Go-агент удалённого экрана.

## Проверки и доказательства

- Обычные локальные команды: `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`.
- Объём и датированный результат renderer-работы — [docs/testing/2026-09-07-renderer-async-gate.md](docs/testing/2026-09-07-renderer-async-gate.md).
- Этот отчёт фиксирует 1051 unit/DOM тест и 96 файлов, два TS-check, build и lint без ошибок, но с 156 предупреждениями. Это synthetic IPC/DOM evidence, не live-проверка устройств.
- `npm run check` дополнительно запускает Go agent tests; часть агентских тестов обращается к аппаратному вводу. Не считать эту команду чистым unit-only gate.
- `test:vault`, `test:net`, `test:e2e`, `test:live`, `check:full` и `dist` — отдельные расширенные контуры. Проверять prerequisites и побочные эффекты до запуска.
- SQLCipher-тесты используют ABI Electron; обычный Node не заменяет `npm run test:vault`. Сборка не доказывает работу установленного AppImage.

## Безопасность и изменения

- Реальные vault-файлы находятся в Electron userData, не в репозитории. Не использовать их для fixture-тестов и не очищать ради запуска.
- Секреты должны оставаться в main и приватных хранилищах; сохранять валидацию IPC, не выводить сырые ошибки с credentials в renderer/логи.
- Отказ IPC не равен успеху операции: освобождать busy-state, показывать безопасную ошибку, отклонять устаревшие ответы; сохранять соответствующие регрессии.
- SSH, питание, Wake-on-LAN, захват экрана, агентская установка, финансы и внешние API требуют явно заданного целевого контура; unit/DOM тесты их не разрешают и не проверяют.
- Master key/recovery, миграции и импорт данных не менять попутно с UI/линтом. Состояние сервера или счёта не выводить из успешной сборки.
- Не редактировать generated context-pack вручную; его регенерация требует отдельной проверки канонических источников.

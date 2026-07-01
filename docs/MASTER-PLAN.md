# Nexus One — Master Plan & Product Vision

> Живой документ. Часть A/B (что есть сейчас + архитектура) — стабильны.
> Часть C+ (видение по вкладкам, авто-провижининг, устройства, конкуренты, роадмап,
> открытые решения) наполняется из большого исследования и раунда вопросов к владельцу.
>
> Статус: черновик от 2026-07-01. Легенда приоритетов: **[MVP]** · **[v2]** · **[LATER]** · **[MAYBE]**.

## Оглавление
- **A. Что уже построено** (реальный статус)
- **B. Архитектура** (Electron/main/preload/renderer, vault, IPC, безопасность)
- **C. Видение по вкладкам** — по каждой: назначение, элементы, все варианты реализации (даже «тупые»), решения
  - C0 Онбординг + Lock/Vault · C1 Dashboard · C2 Devices/Servers · C3 Banks/Finance ·
    C4 Subscriptions · C5 Streaming · C6 AI Accounts · C7 Devices-personal (телефон/часы/наушники) · C8 Settings
- **D. Авто-провижининг серверов** (скрипт → сервер сам появляется со всеми настройками)
- **E. Интеграции устройств** (Android/iPhone/watch/buds/PC — что реально получить)
- **F. Конкуренты и дельты** (Termius, homelab-дашборды, финанс-трекеры — что берём, чем бьём)
- **G. Кросс-срезы** (безопасность, синк/бэкап, командная палитра, уведомления, темы)
- **H. Роадмап по фазам**
- **I. Открытые решения → вопросы владельцу** (сводка для интерактивного опроса)

---

## A. Что уже построено (Phase 0–1, реальный статус)

**Стек:** Electron 42 · electron-vite · React 19 + TypeScript · Tailwind v4 (`@theme`-токены) ·
Zustand · Recharts · xterm.js (`@xterm/xterm` + addon-fit) · `ssh2` · `better-sqlite3-multiple-ciphers`
(SQLCipher) · `hash-wasm` (Argon2id) · lucide-react. Прод-сборка зелёная; запускается нативно на Wayland.

**Функционально работает и проверено:**
- **Зашифрованный vault**: мастер-пароль → Argon2id (64 МБ, 3 прохода) → ключ → SQLCipher-БД в
  `userData` (не в репо, не в облаке). Экран **Create/Unlock**, авто-детект keyring (`kwallet6`),
  Hyprland-guard (plaintext-fallback не кэшируется). Проверено: smoke (шифрование + отклонение
  неверного ключа) + Electron-ABI harness (схема + CRUD).
- **Devices/Servers**: карточки серверов с **реальными логотипами хостеров** (Hetzner/Yandex/
  FlokiNET/ExtraVM/OVH + монограмма-фолбэк), статус-точки (online/reboot/offline), CPU/RAM бары,
  ссылка на консоль хостера, цена в родной валюте. CRUD (Add/Edit/Delete) с персистом в
  зашифрованную БД. Правый Insights-рейл: Add Device, Quick Connect, Costs Overview, Infrastructure
  Spend (донат по хостерам).
- **SSH-терминал**: кнопка на карточке → xterm.js-панель → живой `ssh2`-shell к ноде; креды
  берутся из vault **в main-процессе**, в renderer уходят только байты терминала. Resize-aware,
  статус-пилюля. Проверено: реальный connect+auth+exec под Electron.
- **Agentless-метрики**: кнопка ↻ пробит по SSH ноды с сохранёнными кредами (loadavg CPU% + free
  RAM), обновляет карточки. Маскированные сид-IP пропускаются.
- **Вкладки-каркасы** (на mock + честные лимиты): **Banks** (net worth, holdings, аллокация,
  RU-баннер), **Subscriptions** (реальные расходы серверов LIVE + подписки, категории, ренивалы —
  *функционально*), **Streaming** (карточки нод под VNC-over-SSH, soon), **AI Accounts** (OpenRouter
  live-кредит + валидность ключей, честные лимиты). **Dashboard** — сводка.

**Дизайн:** тёмная тема `#10141d/#1a202c/#2d3748`, бирюза `#22d3ee`, Inter; общие примитивы
(Page/PageHeader/Card/StatTile/SourceBadge/Donut). Контракт — `DESIGN.md` + `design/tokens.json`.

**Известный долг (обновлено 2026-07-01):** typecheck и `electron-vite build` зелёные
(React.JSX.Element-долг закрыт); host-key **пиннится TOFU** + recovery на смену ключа;
SSH-авторизация — **пароль ИЛИ приватный ключ+passphrase** (импорт из файла/вставка). Остаётся:
**генерация** SSH-ключей (Ed25519) и agent-auth/agent-forward; FirstByte-лого не нашлось (монограмма).

---

## B. Архитектура

```
projects/Nexus-One/
├── src/main/          Electron main (Node, полный доступ) — СЕКРЕТЫ ЖИВУТ ТОЛЬКО ЗДЕСЬ
│   ├── index.ts       hardened BrowserWindow (contextIsolation, sandbox, no nodeIntegration, CSP prod)
│   ├── ipc.ts         validated ipcMain.handle/on: vault:* · devices:* · ssh:*
│   ├── vault.ts       SQLCipher DB: initialize/unlock/lock, device CRUD, getDeviceConn
│   ├── crypto.ts      Argon2id KDF (hash-wasm)
│   ├── ssh.ts         ssh2 shell (open/write/resize/close) + agentless probe
│   ├── seed.ts        первый парк · types.ts · sqlite.d.ts
├── src/preload/       sandboxed contextBridge → window.api.{vault,devices,ssh} (без npm-require)
├── src/renderer/src/  React SPA
│   ├── App.tsx        vault-gate + routing (view switch)
│   ├── components/     Sidebar, ServerCard(+ProviderBadge), InsightsPanel, SpendPie, LockScreen,
│   │                   TerminalPanel, DeviceDialog, ui/{Page,Donut}
│   ├── views/          Dashboard, Devices, Banks, Subscriptions, Streaming, AIAccounts
│   ├── store/          ui · vault · devices (zustand; browser-fallback для превью)
│   ├── lib/            cn · format · providers · providerLogos
│   └── data/           mock · finance · subscriptions · ai (fallback/seed)
└── docs/DESIGN.md · design/tokens.json · .proeb/project.json
```

**Модель безопасности (хребет):** все секреты (SSH-пароли/ключи, будущие API-ключи, банковские
креды) — только в main, за SQLCipher-БД под мастер-паролем. Renderer общается через **валидируемый
IPC** и получает DTO **без секретов**. Окно закалено; CSP в проде; внешние ссылки — в системный
браузер. БД в `userData`, `.gitignore` блокирует `*.db/*.sqlite`.

**Поток запуска:** старт → `vault.state()` → `uninitialized` (Create) / `locked` (Unlock) /
`unlocked` → загрузка устройств из БД → SPA. Авто-лок по простою — [v2].

---

## C. Видение по вкладкам
> Наполняется из исследования. Для каждой: **что это · элементы (каждая кнопка) · варианты
> реализации (все, включая «тупые») · что берём у конкурентов · открытые решения**.

### C0. Онбординг + Lock/Vault
**Тенеты (1Password/Proton/Obsidian/Bitwarden/Raycast):** один экран за раз, local-first, честно про
безопасность, всё после vault — пропускаемо, флоу переигрываемый. Цель: живое заполненное приложение за &lt;5 мин.
1. **Welcome** — ценность+доверие («локально, шифрование, ничего не уходит с машины»). Get started / открыть существующий vault.
2. **Создать vault** — имя + папка (дефолт в app-data), это локальный шифрованный файл. Без аккаунта.
3. **Мастер-пароль + сила** — живой **zxcvbn**-метр (crack-time), гейтим по СКОРУ (не по составу); ведём к passphrase 14-16+.
   *Advanced:* key-file / YubiKey.
4. **Warning «нет восстановления» + Recovery Kit** — блокирующее подтверждение → генерим Recovery Kit (фраза/ключ + путь) →
   Download PDF/Print/Copy. Единственное легитимное восстановление local-first.
5. **Summon-хоткей + права** — дефолт `⌥Space`/`Alt+Space` (сменяемо; учесть коллизии KDE/Hyprland). Только нужные права.
6. **Импорт (опц., по одному, Skip, показываем «нашли N» до записи):** `~/.ssh/config` (превью+выбор, бить Termius —
   тянуть ProxyJump/IdentityFile) · CSV/1Password/Bitwarden (банки/подписки/ИИ, column-map+дедуп) · ключи/кошельки (подтверждаем каждый).
7. **Дашборд с guided empty-states** — каждая пустая секция = «Добавь первый …» + CTA + импорт; дисмиссимый чеклист
   (Recovery Kit · первый сервер · первый аккаунт · хоткей) с прогрессом.
8. **Обучить палитре** — одна coach-mark «жми ⌘K»; `?` — шпаргалка.
**Анти-паттерны:** форс-тур до ценности; просить данные, которых нет; правила состава пароля; прятать риск «нет
восстановления»; авто-импорт секретов без превью; забирать `⌘Space` по умолчанию.
### C1. Dashboard
**Идея (наш moat):** «один объект — много граней»: нода Hetzner = Server (SSH/health) + Subscription (€10/мес,
ренивал 13 июл) + Finance line-item + Credential. Дашборд — секционный дом со сводками по всем доменам.

**Система статусов (6 состояний, color+shape — colorblind-safe):** online ●зелёный · degraded ▲янтарь ·
offline ■красный · rebooting ◔синий (**единственное пульсирует**) · unknown/stale ◇серый · maintenance ⏸.
Правила премиума: два сигнала (цвет+форма+текст) · контраст ≥3:1 · красный только для down · **roll-up = худший
ребёнок** · анимируем только in-flight (не дублируем спиннер) · re-render только при смене состояния · **никогда
не «врать зелёным» — нет данных → серый unknown**.

**Анатомия карточки:** точка+имя+тег-бейдж+uptime-пилюля · сабтайтл+latency-бейдж(порогово-цветной)+тренд-дельта ·
**latency-спарклайн + beat-бар** (worst-status по бакетам) + event-маркеры (ребут/деплой) · живые витали + «⏱ 4s ago».
≤5-6 сигналов на карточку. Карточка **апгрейдится на месте** (пустая запись → авто-бренд → живой виджет).

**Сводные бейджи** (entity-filter count): «12 серверов · 2 degraded», «12 подписок · 2 истекают · 1 фейл оплаты».
**Live vs poll:** v1 — поллинг в main 15-30s → дельты в renderer по IPC. **Опц. Topology-вид** (Railway-canvas):
ноды-узлы + рёбра — под cascade/VPN-топологию (DE→Moscow→exit).
### C2. Devices / Servers (Termius-паритет + больше)
**Что это:** ядро приложения — управление серверами/устройствами, SSH-терминал «как Termius» плюс
мониторинг и авто-провижининг, которых у Termius НЕТ.

**Про Termius (2026):** Free-tier «Starter» вмещает почти все SSH-фичи (shell, SFTP, port-forward,
jump-hosts, snippets, broadcast, host-key TOFU, темы, AI-автокомплит). Платно только **синк/облачный
vault** (Pro $10/мес), **командный vault/коллаб** (Team $20), **governance** (Business $30). Вывод:
паритет = повторить Free-фичи; наш дифференциатор — **мониторинг + авто-провижининг (§D) + локальный
ИИ + MCP-поверхность**.

**Инвентарь фич (приоритет / feasibility на ssh2):**
| Фича | Приоритет | ssh2 | Заметка |
|---|---|---|---|
| Группы/теги/иконки хостов, quick-connect палитра | Must/Should | app | fuzzy-поиск по парку |
| SSH shell + exec | Must | ✅ | есть; keepalive по умолчанию |
| **SFTP** (двухпанель + правка через Monaco) | Must | ✅ `conn.sftp()` | |
| **Jump-hosts / многохоп** | **Must** | ✅ вложенный `forwardOut` | под cascade/бастион-топологию |
| **Host-key TOFU** (запомнить, жёстко предупредить о смене) | **Must** | ✅ `hostVerifier` | хребет безопасности; никогда accept-all |
| Порт-форвардинг L / R / dynamic-SOCKS5 | Should→Must | ✅ / 🟡 | достучаться до панелей/БД парка |
| Ключи: импорт+генерация (Ed25519), agent-auth, agent-forward | Must/Should | ✅ / 🟡 | шифруем в SQLCipher |
| Импорт `~/.ssh/config` + known_hosts + keys | Should | 🟡 `ssh-config` | JumpHost→цепочка |
| Snippets + **broadcast/multi-exec** (по подмножеству нод) | Should | ✅ | «channel»-группы (WindTerm) |
| Терминал: tabs+split, поиск, webgl, ссылки, OSC-52, темы | Should | 🟡 xterm-аддоны | |
| Workspaces (сохранить/восстановить раскладку+буфер) | Nice | 🟡 addon-serialize | |
| AI-автокомплит + NL→команда | Nice | app+LLM | **на твоём Ollama** — приватно, без облака |
| **Мониторинг CPU/RAM/disk/графики/алерты** | **Must (наш плюс)** | 🟡 exec/агент | у Termius этого НЕТ |
| Mosh (роуминг UDP) | Nice | ❌ hard | делаем «Mosh-lite»: авто-reconnect+буфер |

**Чеклист «догнать/перегнать» (по фазам):**
- **[MVP]** группы/теги, quick-connect, host-key TOFU, SFTP-браузер, jump-host цепочки, импорт ключей+agent,
  импорт `~/.ssh/config`, терминал QoL (поиск/webgl/split/темы), snippets+broadcast, оставить agentless-метрики.
- **[v2]** UI порт-форвардинга (L/R→SOCKS5), agent-forward, workspaces (restore буфера), Mosh-lite, NL→команда на
  Ollama + локальный автокомплит, **KeePassXC/KWallet + JIT-подтягивание секрета** (не копируем в vault),
  биометрия/PIN на разлок vault, локальные логи сессий.
- **[LATER/beat]** виджет-дашборд на устройство (процессы, тайм-серии, **пороговые алерты** ntfy/webhook),
  авто-дискавери (ssh_config+agent+KeePassXC+Docker+скан сети), контейнеры-как-подключения (Docker/Podman/LXD),
  серверные persistent-панели (tmux/wezterm-mux, переживают сон ноута), **MCP-поверхность вкладки** (default-off,
  per-action allowlist, confirm-to-run — твой Claude/Codex рулит безопасно), remote-desktop (RustDesk на своём
  self-hosted relay), реальный PQ-KEX через системный `ssh`, синк.

_Открытые решения по Devices (сводка в §I): синк-модель · host-key policy · где хранить секреты (SQLCipher vs
KeePassXC+JIT) · ssh2-only vs hybrid-с-системным-ssh · Mosh vs Mosh-lite · ИИ на Ollama · protocol scope ·
agent-forward default · глубина мониторинга (agentless vs helper) · tmux-persistence · логи+редакция · MCP-поверхность._
### C3. Banks / Finance
**Честно:** розничных банковских API в РФ НЕТ (и не будет до ~2027-28; ЦБ Open API отложен). Вкладка =
**импорт + ручной ввод + несколько API-островов**.

**API-острова (работают из РФ):**
- **On-chain кошельки ✅** (главный надёжный источник): EVM — **viem + dRPC** (❗НЕ Infura — гео-блок РФ),
  Etherscan v2 (email, 100k/день); BTC — bitcoinjs-lib + mempool.space (xpub деривим локально); **TON** —
  @ton/ton + Toncenter (ключ через @toncenter-бот, zero-KYC — лучший RU-путь); SOL — @solana/web3.js + Helius.
  Цены USD+RUB — CoinGecko Demo (RUB нативно). DeFi-позиции — Zerion free (2k/день).
- **T-Invest брокеридж ✅** (только брокерский счёт, НЕ карты/вклады): read-only токен → портфель+история;
  community `tinkoff-invest-api` (vitalets) или **официальный MCP-сервер (июнь 2026)**.
- **Своя инфра-биллинг ✅**: OVH (`node-ovh /me/bill`), Yandex Cloud (S3-экспорт биллинга).

**Импорт выписок ⚠️** (в основном PDF): T-Bank (PDF; CSV убрали), Sber (только PDF — нужен Python
`Sberbank2Excel` сабпроцессом), Alfa/VTB (PDF). Пайплайн: `pdfjs-dist` → Python-табличный экстрактор для
Sber → `csv-parse`/SheetJS для CSV/XLSX → tesseract только для сканов.

**Что берём у конкурентов:** Actual (конверты+rollover), Firefly (движок правил + **сохраняемый маппинг колонок
CSV** под Sber/Alfa), Maybe (**таймлайн net worth**), Lunch Money (**лучший UX импорта CSV**: detect→map→preview→fix→save).

_Решения (§I): базовая валюта (RUB/USD/dual) · крипто-стратегия (прямой RPC vs Zerion free) · какие сети/адреса
держишь · T-Invest токен (community vs MCP) · какие банки (первый PDF-парсер) · Python-сайдкар для PDF · инфра-биллинг._
### C4. Subscriptions
**Ключевой RU-инсайт:** зарубежные подписки (Netflix/Spotify/OpenAI/Anthropic/GitHub) платятся крипто-картой/
инокартой/реселлером и **не попадают в банковскую выписку** — но **письмо-квитанция приходит всегда**. Поэтому
**локальный парсинг почты (IMAP/Gmail) — сильнейший метод для РФ**, payment-agnostic.

**Методы детекта:** ручной ввод (база ✅, Bobby-стиль: календарь ренивалов + месячный тотал) · **IMAP/Gmail
receipt-parsing ✅** (`imapflow`+`mailparser`, локально; храним только `{сервис,сумма,валюта,ренивал,цикл}`, не
сырое письмо; правила `providers.json` + LLM-фолбэк на Ollama) · CSV-импорт + **алгоритм детекта регулярных
платежей** (нормализация мерчанта → кластеризация fuse.js → интервал {7,30,365}д → прогноз next + annual_cost) ·
инфра-биллинг (OVH/Yandex) авто-импортом · скриншот/док-AI (комплемент). Уже сейчас Subscriptions тянет реальные
расходы серверов из вкладки Devices (LIVE).

**Что берём:** Bobby (календарь+тотал), ReSubs (on-device Gmail + **lifecycle trial→active→paused→cancelled**),
Invoice Radar (**плагин-JSON скраперы** кабинетов Yandex/VK/MTS), Rocket Money (price-increase alert, dormant-flag).
RU-каталог для сида: Yandex Plus, VK, Kion/MTS, Okko/Sber, Kinopoisk, LitRes.

_Решения (§I): включать локальный IMAP/Gmail-скан (какой ящик) · авто-импорт инфра-ренивалов (OVH+Yandex) ·
пре-собрать RU `providers.json`._
### C5. Streaming
**Что это:** удалённый экран серверов и своих устройств, по возможности встроенный в приложение.

| Технология | Для чего | Встраивается в Electron? | Вердикт |
|---|---|---|---|
| **noVNC over SSH-tunnel** | серверы + любой Linux-бокс | да (HTML5-canvas в BrowserView/iframe) | **[MVP] дефолт для серверов** |
| **KRDP** (Plasma 6.1, H.264/VAAPI) | свой KDE-десктоп | FreeRDP-окно или Guacamole-шлюз | **[v2] для своего ПК** |
| **Apache Guacamole** (RDP/VNC/SSH→HTML5) | единый встроенный пейн | да | **[MAYBE]** если хотим унификацию |
| **FreeRDP** (native) | Windows/RDP | отдельное окно | контроль, но не в DOM |
| **scrcpy** (Android) | телефон | отдельное окно (SDL) | **[v2]** лучшая перф |
| **ws-scrcpy** | телефон в приложении | да (WebSocket) | **[MAYBE]** если экран внутри |
| **Sunshine + Moonlight** | игровой стрим десктопа | moonlight-web/vibeshine (WebRTC) | **[LATER]** high-FPS/GPU |
| **WebRTC (свой)** | P2P-шэра | нативно (Chromium) | гибко, дороже |

**Рекомендация:** noVNC (серверы, всегда через SSH-туннель приложения) + KRDP (свой KDE) + scrcpy
(телефон). Guacamole — если хотим один встроенный пейн на все протоколы; Sunshine — под игровой стрим.
### C6. AI Accounts
**Матрица (провайдер × что доступно, endpoints проверены июль-2026):**
| Провайдер | Валидность ключа | Остаток/кредит | Spend ($) | RU-оплата |
|---|---|---|---|---|
| **OpenRouter** ★ | ✅ `/v1/key` | ✅ `/v1/credits` | ✅ daily/weekly/monthly в `/v1/key` | ✅ крипто — **якорь** |
| Anthropic | ✅ `/v1/models` | ❌ | ⚠️ только Admin-ключ `sk-ant-admin-` (`cost_report`) | ❌ карта (через OpenRouter/крипто) |
| OpenAI | ✅ `/v1/models` | ❌ | ⚠️ только Admin-ключ `sk-admin-` (`/org/costs`) | ❌ карта |
| Gemini | ✅ `/v1beta/models` | ❌ | ❌ только GCP Billing | ⚠️ free-tier |
| Groq | ✅ `/models` | ❌ | ❌ только `x-ratelimit-*` заголовки | ⚠️ free |
| xAI | ✅ `/v1/api-key` | ⚠️ Management API | ⚠️ Management API | ⚠️ $25–150/мес free |

**Стратегия:** **OpenRouter — якорь** (единственный, кто и RU-оплачиваем крипто, и отдаёт баланс+spend одним
REST). Для OpenAI/Anthropic spend — завести **Admin-ключи** (ты владелец орги — можешь). **Универсальный
фолбэк:** локальная таблица цен (`model_prices_and_context_window.json` из LiteLLM) + считаем `tokens×price` сами →
работает для всех без Admin-ключей. Плюс `ccusage` читает локальные логи Claude-Code → стоимость.

**Что берём:** LiteLLM (эмбед-таблица цен), Helicone/Langfuse (точная стоимость через локальный прокси), per-model/
день график, budget-порог + аномалия.

_Решения (§I): какие провайдеры реально ключишь (OpenRouter + прямые?) · заводить Admin-ключи OpenAI/Anthropic? ·
модель учёта: локальная таблица+счёт vs локальный LiteLLM/Helicone-прокси._
### C7. Personal devices (телефон/часы/наушники/ПК)
**Что это:** отдельная секция/вкладка «мои устройства» — статус, батарея, действия. Для твоего
железа (Samsung + Galaxy Buds + Linux-ПК) почти всё **локально, без облака**.

**Матрица возможностей:**
| Устройство | Что читаем | Чем управляем | Метод | Сложность |
|---|---|---|---|---|
| **Samsung (KDE Connect)** | батарея %/зарядка, сигнал 0–4 + тип сети, уведомления | ping/звонок, SMS, буфер, медиа/громкость, run-commands, lock | session D-Bus `org.kde.kdeconnect` (`dbus-next`) или `kdeconnect-cli` | **[MVP] Easy** |
| **Samsung (ADB/scrcpy)** | dumpsys (батарея/сигнал/что угодно), экран | полный экран+ввод, автоматизация | Wireless ADB + scrcpy v3.3.3 | **[v2] Easy–Med** |
| **Samsung (HA-мост)** | GPS, батарея, Wi-Fi/сигнал, шаги, Health Connect (пульс/сон) | notify/TTS/DND назад | HA companion → webhook → HA REST/WS | **[MAYBE] Med** (нужен HA) |
| **iPhone** | локация+батарея (только неофиц.), батарея Apple Watch через HA | Shortcuts→webhook/SSH | FindMy.py/pyicloud (хрупко); HA iOS | **Hard/частично Blocked** |
| **iPhone: уведомления/SMS/глубина** | — | — | нет с Linux | **Blocked** |
| **Galaxy Watch** | шаги/пульс/сон (через Samsung Health→Health Connect) | — | HA Android companion → HA API | **Hard (HA/manual)** |
| **Apple Watch** | **батарея** (через HA iOS); пульс/шаги — только через HealthKit-export | — | HA iOS companion | **Hard** |
| **Galaxy Buds** | батарея по-бут + кейс, ANC/wearing | ANC toggle, ambient, EQ, find-buds | GalaxyBudsClient (D-Bus `me.timschneeberger.GalaxyBudsClient`), LiveBudsCli, BudsLink | **[v2] Easy–Med** |
| **AirPods** | батарея (BLE-adv декод) | ограниченно | BudsLink/AirStatus (не BAS) | **Med** |
| **Любой BT-хедсет** | батарея % (если BAS) | — | BlueZ `org.bluez.Battery1` (Experimental=true) | **Easy** |
| **ПК/ноут (локально)** | CPU/mem/disk/net/темп/батарея/процессы | shutdown/sleep/reboot | Node `systeminformation` + `systemctl` | **[MVP] Easy** |
| **ПК (удалённо)** | метрики по SSH | **WoL-пробуждение**, shutdown/sleep/reboot | npm `wakeonlan` (magic packet) + `ssh2` | **[MVP] Easy** |

**Рекомендованный порядок:** 1) KDE Connect D-Bus (первым — уже работает, локально) · 2) ПК-парк
(`systeminformation`+`wakeonlan`+`ssh2`) · 3) Galaxy Buds (GalaxyBudsClient/BudsLink) · 4) scrcpy для
экрана телефона · 5) generic BlueZ battery · 6) опциональный HA-мост (GPS/health/Apple-battery) —
только по явному «да» · 7) iPhone — второй класс (Shortcuts-push + хрупкий FindMy).
### C8. Settings (полное дерево, 11 разделов)
1. **Appearance** — тема (System/Dark/Midnight/OLED/High-Contrast) · акцент · плотность · шрифты (UI/данные/**моно** для SSH) ·
   zoom · раскладка сайдбара · tray · frame · vibrancy · reduce-motion · GPU · локаль/дата/валюта/TZ.
2. **Security & Privacy** (глубже всего) — **авто-лок** (idle 1/5/15/30м/never, на sleep/screen-lock/minimize/quit, Lock Now+хоткей) ·
   **методы разлока** (мастер-пароль всегда, биометрия/Hello/PolKit, PIN, YubiKey) · timeout-action (Lock vs Logout+purge) ·
   **step-up re-auth** перед reveal/edit/delete/export/destructive-команда/номер карты · concealment (`••••`, blur на screenshot/share) ·
   **clipboard** (авто-очистка 30s/2m/never, на лок/quit, исключить из истории, авто-TOTP) · brute-force (лок после N → backoff → **wipe**) ·
   смена мастер-пароля/ротация ключа/KDF-параметры/regenerate Recovery Kit · **panic-wipe** (хоткей) + duress-PIN (decoy) · privacy
   (редакция секретов в логах, offline-only, egress-allowlist).
3. **Sync & Backup** — локальный бэкап (интервал/ретенция/папка, шифр.) · export/import (шифр. `.nxs` дефолт; plaintext за step-up;
   из 1Password/Bitwarden/CSV/`~/.ssh/config`) · **опц. cloud-sync OFF by default** (self-hosted WebDAV/S3/свой сервер, E2E-before-upload,
   conflict-resolution, **per-domain scope** — синкать финансы, НЕ SSH-ключи).
4. **Integrations** — API-ключи BYO в vault (OpenAI/Anthropic/OpenRouter/локальный Ollama, FX, банки) store/test/revoke · OS-keychain
   (KWallet) · SSH (системный agent vs встроенный, agent-forward policy, ssh_config, known_hosts) · webhooks (Telegram/Discord/ntfy) ·
   URL-scheme `nexus://` · календарь (ренивалы/expiry).
5. **Notifications** — мастер + per-domain каналы (in-app/OS/email/Telegram/Discord/webhook) · типы (сервер down/high-load, cert/domain
   expiry, ренивал за N дней, budget-порог, FX-триггер, ИИ-квота, security) · quiet hours · digest vs immediate.
6. **Data Management** — вкл/выкл доменные модули · категории/теги/валюты · интервал поллинга per-domain · archive vs delete + trash ·
   bulk-edit · дедуп · **Wipe all** (double-confirm + re-auth).
7. **Telemetry** — **OFF by default** · явно «никаких сетевых вызовов без включения».
8. **Keyboard Shortcuts** — полный ребайндабельный список · global summon/lock · алиасы/per-item-хоткеи · chord · reset · import/export keymap · Vim/Emacs.
9. **Updates** — авто (on/notify/manual) · канал Stable/Beta/Nightly · changelog · skip на metered.
10. **Startup** — launch at login · start minimized/tray · **start locked (дефолт)** · restore session · single-instance.
11. **About/Advanced** — версия/подпись · DevTools/логи (redacted-бандл) · feature-flags · config-папка · reset (settings/layout/factory) · safe-mode.

## D. Авто-провижининг серверов (скрипт → сервер сам появляется)
**Принцип: два тира, оба «одно действие».** Tier 1 — agentless, ничего не ставим, мгновенный
онбординг + инвентарь + метрики по запросу. Tier 2 — opt-in one-liner (Beszel) для истории/алертов и
проброса через NAT.

**Что авто-детектится по ОДНОМУ SSH (без root ~90% полей):** OS+версия (`/etc/os-release`,
`hostnamectl --json`), kernel/arch, CPU (`lscpu -J`), cores (`nproc`), RAM (`/proc/meminfo`), диски
(`df -B1`, `lsblk -J`), **public IP+geo** (`curl ipinfo.io` НА сервере), uptime/load, службы
(`systemctl … running`), порты (`ss -tulnpH` — выдаёт установленные панели по портам), Docker
(`docker ps --format json`), пакетный менеджер, virt (`systemd-detect-virt`), панели стека
(`xray/remnawave/nginx`, `wg show`, `tailscale status`), **machine-id** (стабильный ключ дедупа).

**Flow 1 — agentless-first (дефолт, zero-install):**
1. **Импорт парка в один клик:** парсим `~/.ssh/config` (npm `ssh-config`) → Host/HostName/User/Port/Key;
   + опц. энумерация тайнета (`tailscale status --json`, zero-auth локально). Чеклист «нашёл 5 серверов — добавить все?».
2. Для каждого — один `ssh2`-коннект **существующим ключом/агентом** (новых кредов не вводим).
3. Гоним **один read-only `nexus-probe.sh`** → единый JSON → все поля карточки автозаполняются; дедуп по `machine-id`.
4. **Live-метрики on-demand:** пока открыт детальный вид, каждые N сек гоним slim-набор
   (`loadavg`/`free`/`df`/`docker stats`) — «живые метрики сами» без демона.

**Flow 2 — opt-in агент Beszel (история + push + NAT):** встраиваем/поднимаем **Beszel hub** (один Go-бинарь /
PocketBase) — Electron управляет им как дочерним процессом и **читает метрики из REST API**. Онбординг:
«Enable continuous monitoring» → app через **PocketBase API** пре-создаёт system + **universal token** →
генерит one-liner → по тому же SSH `curl -sL get.beszel.dev | … HUB_URL/TOKEN/KEY sh` → агент **self-register
по fingerprint** → стримит по **outbound WebSocket** (ничего не слушаем на VPS, дружит с NAT/CGNAT) → history,
температура, GPU, per-container, SMART, алерты.

**Discovery:** Tailscale/Headscale (`tailscale status --json` локально, ноль кредов — самый мощный «парк
появляется сам») · `~/.ssh/config` (мгновенный он-рэмп для не-mesh: Hetzner/Yandex/OVH) · **cloud-init**
user-data для НОВЫХ VPS (создать юзера, залить ключ, отключить root+пароль, опц. агент на first boot → свежий
сервер появляется уже закалённым и с мониторингом).

**Стек агентов (вердикт):** **Beszel ★** (10–15 МБ, self-register, WS-outbound, PocketBase API — читаем напрямую)
≫ **Glances** (`glances -w` → `GET /api/4/all`, agentless-ish, историю храним сами) > **node_exporter+Prometheus**
(только если уже есть; `tailscalesd`+`http_sd` = авто-скрейп) > **Netdata** (глубокий дайв, ~150 МБ — тяжёл) >
**Cockpit** (deep-link «открыть веб-консоль»; мульти-хост deprecated) > **Grafana Alloy** (для оргов — skip).
IP-geo: ip-api (без ключа) / ipinfo (страна) / **self-hosted MaxMind** (полностью локально — лучше для приватности).
## E. Интеграции устройств — как технически
- **KDE Connect** → session-bus `org.kde.kdeconnect`, путь `/modules/kdeconnect/devices/{id}`, плагины:
  `battery` (charge/isCharging), `connectivity_report` (сигнал 0–4, тип сети), `notifications`,
  `runcommand` (`--list-commands`), `telephony/sms` (`--send-sms --destination`), `clipboard`, `mprns`,
  `findmyphone` (ring), `share`, `lock`. Читать через `dbus-next` (Properties.Get) или shell
  `kdeconnect-cli`. Живёт в main-процессе (D-Bus доступ).
- **Galaxy Buds** → предпочтительно **GalaxyBudsClient** (D-Bus `me.timschneeberger.GalaxyBudsClient` +
  CLI `action -e AncToggle`) или **BudsLink** (Flathub, L2CAP/RFCOMM, батарея по-бут+кейс, ANC, KDE-апплет,
  мультибренд) / **LiveBudsCli** (`earbuds -d`, D-Bus+socket). Fallback — BlueZ `org.bluez.Battery1`
  (system bus; требует `Experimental = true`).
- **Android глубже** → Wireless ADB (`adb pair`/`connect`) + scrcpy как дочерний процесс (экран/ввод),
  либо `ws-scrcpy` для встраивания.
- **HA-мост (опц.)** → Home Assistant companion пушит по webhook; приложение читает HA **REST/WS API**
  (GPS, шаги, Health Connect, батарея Apple-устройств). Единственный чистый путь к Apple/часам.
- **ПК** → `systeminformation` (локально), `wakeonlan` (UDP magic packet, у тебя WoL уже настроен),
  `ssh2` (удалённые метрики + питание). Локальные действия — `exec systemctl poweroff|suspend|reboot`.
- **iPhone** → только `FindMy.py`/`pyicloud` (локация+батарея, хрупко, может отвалиться) + iOS Shortcuts
  (webhook/SSH-пуш) + HA iOS companion. Уведомления/SMS/глубина — недоступны.
## F. Конкуренты и дельты (что берём, чем бьём)
**Ров:** ни одно приложение не объединяет серверы+финансы+подписки+устройства за local-first vault — категория
разбита на силосы. Наша позиция — **«один объект, много граней»** в премиум клавиатурной десктоп-оболочке.

| Референс | Берём | Бьём |
|---|---|---|
| **Homepage** | live-data тайлы (рендерит API-данные, не ссылку); авто-иконки | YAML-only, поллинг — у нас GUI+push |
| **Homarr** | Edit-Mode canvas (карандаш → грид), тайлы-действия, validate-at-setup | тяжёлый, ломает лэйаут на апдейте |
| **Heimdall** | 3-тир тайл (generic→branded→live) — апгрейд на месте | лаунчер без мониторинга |
| **HA (tile/badge)** | тайл красится по состоянию + спарклайн + действие; **count-бейдж** «3 offline» | YAML для сложного |
| **Grafana** | state-timeline (uptime-лента), status-history (heartbeat-грид), **unknown=серый** | over-config |
| **Uptime Kuma** | **beat-бар**, worst-status-бакеты, uptime-окна 24h/30d/1y | плоско; false-green баг |
| **Vercel Geist** | **dot: анимируем только in-flight**, no-double-spinner, dot=состояние + чип=время | только deploy-лексикон |
| **Raycast** | **⌘K как основа**, mixed-типы, two-tier actions, frecency, fallback | — |
| **Termius** | SSH-паритет (Free-фичи) | **нет мониторинга** — наш плюс |
| **Wave Terminal** | **тайловый blocks-дашборд** (SSH+логи+график+чат на канвасе) — лучший UI-референс | — |
| **XPipe** | **git-синк Argon2-vault** + **JIT-секрет** из KeePassXC; MCP-поверхность | open-core |

**Формула-победитель:** live-тайлы (Homepage) + edit-canvas (Homarr) + статус-лексикон HA + state-history/unknown-gray
(Grafana) + animate-only-in-flight dot (Vercel) + ⌘K-палитра (Raycast) + честный local-first онбординг. Такой сборки нет ни у кого.
## G. Кросс-срезы (сквозные системы)
- **Безопасность:** авто-лок по простою · step-up re-auth на чувствительные действия · panic-wipe (хоткей) · clipboard
  авто-очистка · zxcvbn на мастер-пароль · Recovery Kit · brute-force → backoff/wipe · редакция секретов в логах. Секреты только в main за SQLCipher.
- **Синк/бэкап:** local-first дефолт; шифр. export/import `.nxs`; опц. self-hosted E2E-синк (WebDAV/S3/свой сервер) с
  **per-domain scope** (финансы — да, SSH-ключи — нет). Мультидевайс (ноут+ПК Castiel) — через это.
- **Командная палитра:** `cmdk`, плоский типизированный индекс, two-tier (↵ primary, ⌘K action-panel), frecency, fallback,
  алиасы/хоткеи, глобальный summon (Electron `globalShortcut`).
- **Уведомления:** ntfy/Telegram/Discord/webhook + OS + in-app; пороги, quiet hours, digest.
- **Темы/вид:** премиум-дарк + варианты (Midnight/OLED/High-Contrast), акцент, плотность, моно-шрифт для SSH.
- **MCP-поверхность:** вкладку Devices можно выставить как MCP-сервер (**default-off**, per-action allowlist, confirm-to-run) —
  твой Claude/Codex сам рулит SSH/командами безопасно. Самый дешёвый путь к «ИИ-агенту».
- **Локальный ИИ:** Ollama для NL→команда, автокомплита, парсинга писем/выписок — приватно, без облака.
## H. Роадмап по фазам
- **✅ Phase 0–1 (сделано):** оболочка, зашифрованный vault + lock, SSH-терминал + agentless-метрики, CRUD устройств,
  6 вкладок (Devices функц., остальные каркасы), логотипы хостеров.
- **✅ Phase 2 (в основном сделано) — SSH-паритет + оболочка-премиум:** SFTP-браузер ✅, jump-host цепочки ✅,
  host-key TOFU ✅, импорт `~/.ssh/config` ✅, порт-форвардинг ✅, терминал (поиск ✅ / split — TODO),
  snippets+broadcast ✅, **⌘K-палитра** ✅, 6-статусов ✅, метрики+история-спарклайны ✅, **SSH key auth** ✅,
  tailscale-discovery ✅. Остаток Phase 2: **авто-провижининг Flow 1** (`nexus-probe.sh`), split-терминал,
  генерация Ed25519-ключей.
- **Phase 3 — мониторинг + деньги:** история метрик + пороговые алерты (ntfy); опц. Beszel-агент; Subscriptions IMAP/Gmail
  парсинг + recurring-детект + инфра-биллинг; Banks крипто-кошельки (viem/TON/BTC/SOL) + T-Invest + импорт выписок.
- **Phase 4 — устройства + ИИ + стриминг:** KDE Connect (телефон), Galaxy Buds, WoL/ПК; AI Accounts вживую (OpenRouter
  `/v1/key` + Admin-ключи + локальная таблица цен); Streaming noVNC-over-SSH + KRDP.
- **Phase 5 — полировка + релиз:** онбординг-флоу, дерево настроек, опц. синк, биометрия/YubiKey, MCP-поверхность,
  typecheck-чистка, **AppImage/pacman** + авто-апдейт. Опц. Topology-canvas.
## I. Открытые решения → интерактивный опрос
Сводка форков из всех 5 исследований, сгруппирована в раунды опроса (мой лин помечен):

**Раунд 1 — Фундамент:** ров «один объект-много граней» (да?) · синк (local-only+export v1, self-hosted E2E позже?) ·
мультидевайс day-1? · host-key policy (строгий TOFU — лин) · где секреты (SQLCipher vs +KeePassXC JIT) · биометрия/YubiKey/пароль-only.
**Раунд 2 — Devices/SSH:** ssh2-only vs hybrid-системный-ssh · Mosh vs Mosh-lite · встроенный терминал vs внешний · protocol scope
(SSH-only vs +RDP/VNC/контейнеры) · agent-forward default · MCP-поверхность · глубина мониторинга (agentless vs Beszel).
**Раунд 3 — Авто-провижининг:** agentless-first (лин) · Tailscale-discovery · авто-импорт `~/.ssh/config` · cloud-init для новых VPS ·
IP-geo (ip-api/ipinfo/локальный MaxMind).
**Раунд 4 — Финансы:** базовая валюта (RUB/USD/dual) · какие сети/адреса (ETH/BTC/TON/SOL) · крипто (прямой RPC vs Zerion) ·
T-Invest токен (community vs MCP) · какие банки (первый PDF-парсер) · Python-сайдкар для PDF.
**Раунд 5 — Подписки/ИИ:** локальный IMAP/Gmail-скан (какой ящик) · инфра-биллинг OVH+Yandex · какие ИИ-провайдеры ·
Admin-ключи OpenAI/Anthropic · учёт стоимости (локальная таблица vs LiteLLM-прокси).
**Раунд 6 — Устройства/стриминг:** KDE Connect (лин да) · Galaxy Buds (GalaxyBudsClient/BudsLink) · HA-мост (GPS/health/Apple) ·
iPhone-глубина · scrcpy embed vs external · стриминг-дефолт (noVNC+KRDP vs Guacamole) · BlueZ Experimental.
**Раунд 7 — UX/оболочка:** primary Devices (cards vs topology-canvas) · live (poll vs push) · degraded (авто-пороги vs предикат) ·
summon-хоткей дефолт · Recovery Kit (обязателен vs пропускаем) · Streaming/AI как домены vs фасеты · локальный ИИ Ollama.

_Ниже — интерактивные раунды: владелец кликает предпочтения, ответы сворачиваются в финальный спек (SPEC.md)._

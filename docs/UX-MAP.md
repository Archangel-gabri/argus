# Argus (ex-Nexus One) — UX / Architecture Map (полная карта интерфейса)

> Снимок **фактического** UI на 2026-07-01 (ветка `feat/nexus-one`). Не «как задумано», а
> «как есть в коде»: каждый экран, каждая панель, каждая кнопка — где лежит, что делает,
> откуда берёт данные, и **работает ли реально или это мок/заглушка**.
>
> **B1 применён (2026-07-11, ветка `feat/argus-b1`):** приложение переименовано в **Argus**,
> палитра — Graphite & Ember (`docs/REDESIGN-2026-07.md` §2), статусы отвязаны от акцента
> (online = emerald), мёртвые контролы из §7 (🔴 Quick Connect · Group settings · профиль-⚙ ·
> фейковый бейдж ai=4) удалены. Цвета/скриншоты в §§ ниже отражают старую cyan-палитру —
> актуализация по факту B2. Эталоны B1: `assets/screenshots/argus-b1-{lock,fleet}.png`.
>
> Делаешь редизайн — держи это рядом. Раздел §7 (карта кнопок) и §8 (живое vs мок) — самые
> важные: не трать время на стилизацию мёртвых контролов, не думая, что они рабочие.
>
> Файлы UI: `src/renderer/src/` (`views/`, `components/`, `store/`, `data/`, `lib/`).
> Дизайн-контракт: `DESIGN.md` + `design/tokens.json` + `src/renderer/src/assets/main.css`.

---

## §0. TL;DR модель

- **Одно окно, без роутера.** Экран выбирается стейтом `useUI.view` (`store/ui.ts`), не URL.
- **Гейт входа:** пока vault не разблокирован — виден только `LockScreen`. После разблокировки —
  трёхколоночная оболочка (sidebar → main → опц. рейл) + слой оверлеев.
- **Стартовый экран после входа — `Devices`**, НЕ Dashboard (`useUI` инициализируется `view: 'devices'`).
- **6 экранов** (вкладок): Dashboard, Devices, Banks, Subscriptions, Streaming, AI Accounts.
- **7 оверлеев** поверх всего: Command Palette (⌘K), Device dialog, Terminal, SFTP, Forwards,
  Broadcast, SSH/Tailscale import.
- **Секреты живут только в main-процессе.** Renderer никогда не видит пароли/ключи/API-ключи —
  только флаг `hasSecret` и вердикты. Это инвариант, редизайн его не трогает (§10).

---

## §1. Оболочка приложения (App shell)

`App.tsx` — корень. Логика:
1. При старте `vault.refresh()` → узнаём статус (`uninitialized | locked | unlocked`).
2. Если `status !== 'unlocked'` → рендерим **только** `<LockScreen/>` (§2). Больше ничего.
3. Если разблокировано → грузим устройства (`devices.load()`), запускаем **поллинг метрик**
   (`refreshMetrics()` сразу + `setInterval` каждые **90 сек**), рендерим оболочку.

Разблокированная оболочка = flex-строка на весь экран:

```
┌───────────┬──────────────────────────────────┬──────────────┐
│  Sidebar  │            Main (view)            │ Insights rail│
│   w-64    │            flex-1                 │  w-[360px]   │
│  (фикс.)  │   renderView(useUI.view)         │  (только     │
│           │                                  │   Devices,   │
│           │                                  │   только xl) │
└───────────┴──────────────────────────────────┴──────────────┘
     + слой оверлеев (fixed, поверх): Terminal, CommandPalette,
       SshImportDialog, SftpBrowser, BroadcastPanel, ForwardsPanel
```

Все оверлеи всегда «висят» в дереве (`App.tsx` низ), но рендерят `null`, пока их флаг в
`useUI` не поднят. Фон main-области: токен `bg` (`#10141d`).

---

## §2. Lock / Setup screen (`components/LockScreen.tsx`)

Единственный экран до входа. Два режима, определяются `status`:
- `uninitialized` → **«Create your vault»** (первый запуск): 2 поля — пароль + подтверждение.
- `locked` → **«Unlock Nexus One»**: 1 поле — мастер-пароль.

Элементы (центрированная карточка `max-w-sm`):
| Элемент | Что делает |
|---|---|
| Иконка-замок (`Lock`) в скруглённом бейдже | декор |
| Заголовок + подзаголовок | меняются по режиму |
| Поле «Master password» (autofocus) | ввод пароля |
| Поле «Confirm password» | **только в setup-режиме** |
| Ошибка (`AlertTriangle` + текст) | «Минимум 6 символов» / «Пароли не совпадают» / ошибка из main |
| Кнопка **Create vault / Unlock** | `initialize(pw)` или `unlock(pw)`; спиннер при `busy` |
| Футер `ShieldCheck` | «Local-only · Argon2id → SQLCipher · keyring: {backend}» |
| Жёлтое предупреждение | показывается если `keyringBackend === 'basic_text'` (нет OS-кейчейна) |

Валидация: пароль < 6 символов — отказ; в setup несовпадение — отказ. При неуспехе поля чистятся.

**Редизайн-заметки:** это первый экран, который видит пользователь → важен для «premium trust».
Сейчас голая форма. Нет: индикатора силы пароля, кнопки «показать пароль», Recovery Kit
(в SPEC он «обязателен» — но экрана нет). Логаут = «Заблокировать vault» в палитре (§6).

---

## §3. Sidebar (`components/Sidebar.tsx`) — ширина `w-64`, фон `surface`

Сверху вниз:

**1. Лого-блок:** квадрат «N» (accent) + «Nexus One» / «command center».

**2. Быстрый поиск** — инпут «Quick search…» с иконкой лупы.
⚠️ Пишет в `useUI.search`, но **фильтрует ТОЛЬКО экран Devices**. На остальных вкладках
введённый текст игнорируется (мёртвый на 5 из 6 экранов). Это НЕ палитра ⌘K — отдельная штука.

**3. Навигация**, две группы-заголовка:
- **General:** `Dashboard` (icon `LayoutDashboard`)
- **Infrastructure:** `Devices` (`Server`), `Banks` (`Landmark`), `Subscriptions` (`Repeat`),
  `Streaming` (`MonitorPlay`), `AI Accounts` (`Bot`)

Каждая строка (`NavRow`): иконка + подпись + опц. бейдж-счётчик справа. Активная — фон `card`,
белый текст, accent-иконка. Клик → `setView(id)`.
Бейджи: `devices` = реальное число устройств; `ai` = **захардкожено `4`** (не считает реальные).

**4. Футер-профиль:** аватар «DK» (градиент) + «Danya Kubrak» / «owner · HubVPN» +
кнопка-шестерёнка (`Settings`).
⚠️ Шестерёнка **ничего не делает** — экрана настроек в приложении нет вообще (§8, §11).

---

## §4. Экраны (views)

Каждый экран занимает main-область. Ниже — назначение, регионы, все элементы, источник данных,
состояния (пусто/загрузка/ошибка).

### 4.1 Dashboard (`views/DashboardView.tsx`)

Простая сводка «на глаз». Регионы:
- `PageHeader` «Dashboard / everything at a glance».
- Ряд из **4 стат-плиток** (`StatTile`):
  1. **Servers** = число устройств, хинт «N online» (live, из `devices` store)
  2. **Infra / month** = сумма `cost.usd` по устройствам (live)
  3. **Net worth** = сумма `MOCK_HOLDINGS.usd` — ⚠️ **МОК** (не live-кошельки!)
  4. **AI accounts** = `MOCK_AI.length` + «N keys valid» — ⚠️ **МОК**
- Карточка «Welcome back, Danya 👋» — статический текст-подсказка со ссылками-словами (не кликабельны).

Кнопок нет. Полностью read-only. **Стартовым экраном НЕ является** (стартует Devices).

### 4.2 Devices / Servers (`views/DevicesView.tsx`) — ГЛАВНЫЙ экран

Двухзонный: список серверов (`flex-1`) + правый **Insights-рейл** (`w-[360px]`, только на `xl`).

**Шапка:**
- H1 «My Servers» + «N machines · M online».
- Кнопка ↻ **Refresh** (`RefreshCw`) — `refreshMetrics()`: пробит по SSH все устройства с
  сохранёнными кредами и реальным IP, обновляет CPU/RAM/статус. Спиннит во время.
- Кнопка ⚙ **Group settings** (`Settings2`) — ⚠️ **ЗАГЛУШКА**, ничего не делает.

**Тело — сетка карточек** (1 колонка → 2 на `lg`). Фильтруется `useUI.search` (единственный
экран, который его слушает). Состояния:
- нет устройств → большая пунктирная кнопка «No devices yet — click to add…» → открывает Add-диалог;
- фильтр ничего не нашёл → «No servers match "…"»;
- иначе → `ServerCard` на каждое устройство (§5.1).

**Правый рейл** = `InsightsPanel` (§4.2.1). `DeviceDialog` (§6.2) висит здесь же.

#### 4.2.1 Insights rail (`components/InsightsPanel.tsx`)
- Кнопка **Add New Device** (accent, во всю ширину) → `openCreate()` (Add-диалог).
- **Quick Connect:** инпут (префилл `user@ip` первого сервера) + кнопка **Connect**.
  ⚠️ **ЗАГЛУШКА** — инпут и кнопка ни к чему не подключены.
- **Costs Overview:** Total Monthly / Total Yearly (live, сумма по устройствам).
- **Infrastructure Spend:** `SpendPie` — донат трат по хостерам (recharts), цвета из `providerHex`.
  Если трат нет → «No tracked spend yet.»

### 4.3 Banks & Finance (`views/BanksView.tsx`)

Net worth = **live-кошельки (public RPC)** + ручные холдинги (кэш/брокеридж из мока).

**Шапка** (`PageHeader` c action):
- Кнопка **Обновить** (`RefreshCw`) → `wallets.refresh()` (перетягивает балансы через RPC).
- Кнопка **+ Кошелёк** (accent) → тумблер формы `AddWalletForm`.
- `LimitNote` — честная плашка про отсутствие банковских API в РФ.

**Форма «Добавить кошелёк»** (когда открыта): select сети (ETH/BTC/TON) + инпут адреса +
инпут метки + кнопка **Добавить** (`wallets.add`) + крестик закрыть. Баланс тянется public RPC.

**3 стат-плитки:** Net worth (все источники) · Live (кошельки) · Ручные.

**2 колонки:**
- **Холдинги** (широкая карточка):
  - строки **кошельков** (live): иконка `Bitcoin`, метка + бейдж `live`, `chain · адрес(усечён)`,
    справа USD + `native amount`, при наведении — корзина **Удалить** (`wallets.remove`).
    Баланс ещё грузится → спиннер вместо суммы.
  - строки **ручных холдингов** (из `MOCK_HOLDINGS`, всё кроме crypto): иконка по типу
    (`Landmark`/`Wallet`), бейдж source (live/manual/soon), сумма. ⚠️ статичный мок.
  - пусто → подсказка «Нет кошельков — жми "Кошелёк"…».
- **Аллокация** (`Donut`): распределение net worth по типам (crypto live + ручные), % в легенде.

### 4.4 Subscriptions (`views/SubscriptionsView.tsx`)

Считает месячные/годовые траты: **инфра-косты серверов (live)** + **приложения-подписки (из vault)**.

**Шапка:** H1 + «N активных · сервера + приложения, к месяцу».
Ниже справа — кнопка **+ Подписка** → тумблер `AddSubForm`.

**Форма «Новая подписка»:** название · категория (AI/Media/Dev/Hosting/Other) · сумма ·
валюта (USD/EUR/RUB) · период (/мес /год) · дата продления · кнопка **Добавить** (`subs.create`).

**3 стат-плитки:** В месяц · В год · Активных (N инфра · M приложений).

**2 колонки:**
- **Все подписки** (широкая): строки — точка-категория, название, бейдж «через Nд» (если ≤14 дн),
  категория, source-бейдж (live=сервер / manual=приложение), сумма `/период`. У ручных строк при
  наведении — корзина **Удалить** (`subs.remove`). Инфра-строки удалить нельзя (это сервера).
- **По категориям** (`Donut`, месячные) + **Ближайшие продления** (список 6, дни до продления,
  ≤14 дней — жёлтым).

Источник инфры: устройства с `cost.usd > 0`. Источник приложений: `subs` store (реальный vault).

### 4.5 Streaming (`views/StreamingView.tsx`)

Задел под удалённые экраны (VNC over SSH-туннель). Сейчас **весь экран — заглушка**.
- `LimitNote` про noVNC-подход.
- Карточка на каждое устройство: флаг + имя, `user@ip`, пустой «экран» (`aspect-video`,
  иконка `MonitorPlay`), кнопка **Open VNC (SSH tunnel)** — `disabled`, бейдж `soon`.
- Внизу строка про Android/scrcpy «позже».

Ни одна кнопка не работает — чистый визуальный задел.

### 4.6 AI Accounts (`views/AIAccountsView.tsx`)

⚠️ **Экран целиком на моке `MOCK_AI`** — хотя бэкенд (`ai:*` IPC + `ai.ts::checkAccount`,
хранение ключей в vault, OpenRouter live-кредит) уже написан, UI к нему **не подключён**.

- `LimitNote` про то, что живой только OpenRouter, остальные — проверка валидности ключа.
- **3 плитки:** Accounts · Keys valid (N/M) · Live credit (OpenRouter).
- **Сетка карточек** (по одной на провайдера): глиф-бейдж, имя, source-бейдж, «Plan: …»,
  справа «key valid / invalid» (галка/крест), два бокса **Credit left** и **Usage (mo)**,
  опц. заметка (ⓘ).

Кнопок нет: нельзя ни добавить аккаунт, ни проверить ключ, ни удалить — хотя IPC под всё это есть.
**Это главный кандидат №1 на «оживление»** при редизайне (§8, §11).

---

## §5. Карточки и повторно используемые блоки

### 5.1 ServerCard (`components/ServerCard.tsx`) — анатомия

Самый важный компонент. Сверху вниз:
- **Шапка:** логотип хостера (`ProviderBadge` — реальные PNG Hetzner/Yandex/FlokiNET/ExtraVM/OVH,
  иначе цветная монограмма) · имя + флаг · `ip · role` (моно).
  Справа: кнопка **терминал** (`TerminalSquare`) → `openTerminal(s)`; кнопка **⋮** (`MoreVertical`) → меню.
- **Меню ⋮** (по клику, закрывается кликом вне): **Edit** (`openEdit`) · **Файлы (SFTP)** (`openSftp`) ·
  **Проброс портов** (`openForwards`) · **Delete** (с `window.confirm`, красным).
- **Сетка 2×:** OS · Status (цветная точка + подпись, §9).
- **Метрики:** **CPU load** (полоса + значение + **спарклайн истории** из `metrics.history`) ·
  **RAM usage** (полоса, `used / total GB`). При не-online статусе полосы приглушены.
- **Футер:** ссылка **Hoster Console** (`consoleUrl`, во внешнем браузере) · плашка `цена/mo` (родная валюта).

Спарклайн CPU подтягивается на маунте карточки: `api.metrics.history(id, 30)` → массив последних
CPU-замеров (копятся поллингом каждые 90с).

### 5.2 UI-примитивы (`components/ui/`)
- **Page** — обёртка-скролл (`px-8 py-7`).
- **PageHeader** — H1 + подзаголовок + опц. `action` (кнопки справа).
- **Card** — `rounded-xl border bg-card/60 p-5`.
- **StatTile** — плитка: label / крупное `value` (tabular-nums) / опц. hint.
- **SourceBadge** — `live` (cyan) / `manual` (slate) / `soon` (amber).
- **LimitNote** — серая плашка «что живое, что вручную» (честность на каждой вкладке).
- **Donut** (`ui/Donut.tsx`) — recharts-донат с центром-суммой и легендой с %.
- **Sparkline** (`ui/Sparkline.tsx`) — мини-SVG-график без зависимостей (CPU-история на карточке).
- **SpendPie** (`SpendPie.tsx`) — донат трат по хостерам для Insights-рейла.

---

## §6. Оверлеи (модальный слой, `fixed`, поверх всего)

Все открываются из стейта `useUI`, кликом по фону закрываются. z-index: палитра `z-[60]`, остальные `z-50`.

### 6.1 Command Palette ⌘K (`components/CommandPalette.tsx`)
Открытие: **⌘K / Ctrl+K** (или из кода). Esc / клик вне — закрыть. Библиотека `cmdk`, живой фильтр.
Группы:
- **Перейти** — 6 вкладок → `setView`.
- **Серверы** — каждое устройство → перейти в Devices + `openTerminal` (подключиться). Живое.
- **Подписки** — из `MOCK_SUBSCRIPTIONS` → просто открыть вкладку. ⚠️ мок.
- **ИИ-аккаунты** — из `MOCK_AI` → открыть вкладку. ⚠️ мок.
- **Активы** — из `MOCK_HOLDINGS` → открыть Banks. ⚠️ мок.
- **Команды:** Добавить устройство · Обновить метрики · Импорт ~/.ssh/config · Обнаружить Tailscale ·
  Broadcast · **Заблокировать vault** (= логаут). Все живые.

### 6.2 Device dialog (`components/DeviceDialog.tsx`) — Add / Edit
Модалка `max-w-lg`, скролл. Поля (grid 2 колонки): Name · Provider · Status · Host/IP · Port ·
SSH user · OS · Country · Flag · Cost/mo · Currency · Console URL · **Jump-host** (select из других
устройств) · **Авторизация** (§ ниже).

**Блок «Авторизация»** (новое, 2026-07-01): тумблер **Пароль / SSH-ключ**.
- Пароль → одно поле (при edit пусто = оставить текущий).
- SSH-ключ → **textarea** приватного ключа + кнопка **«Загрузить из файла»** (`<input type=file>`) +
  поле **passphrase**.

Кнопка **«Определить по SSH»** (`Sparkles`) → `probeHost` с выбранным методом: пробит хост, заполняет
OS / имя из hostname (показывает «✓ OS · N ядер · X ГБ RAM»). Блокируется без host или без секрета.
Низ: «Secrets are encrypted at rest (SQLCipher)» · **Cancel** · **Add device / Save**.

### 6.3 Terminal (`components/TerminalPanel.tsx`)
Модалка `h-[80vh] max-w-4xl`, xterm.js. Открытие — с карточки/палитры.
- **Шапка:** иконка + имя + `user@ip` + статус-пилюля (connecting/connected/closed/error) +
  инпут **поиск** (Enter → `findNext`) + крестик.
- **Баннер смены host-key** (новое): при ошибке «host key changed» — красная полоса
  `ShieldAlert` + кнопка **«Доверять новому ключу и переподключиться»** (`forgetHostKey` + reconnect).
- **Тело:** живой SSH-shell (ssh2), resize-aware. Креды берутся в main, в renderer — только байты.

### 6.4 SFTP browser (`components/SftpBrowser.tsx`)
Модалка `h-[80vh] max-w-3xl`. Открытие — из меню ⋮ карточки.
- Шапка: `HardDrive` + имя + «SFTP» + крестик.
- Тулбар: **↑ вверх** · **↻ обновить** · путь (моно) · **Загрузить** (`Upload` → выбор файла → на сервер).
- Список: папки (accent, клик — войти) и файлы (размер). При наведении: **Скачать** (только файлы) ·
  **Удалить** (с confirm). Состояния: ошибка / загрузка / пусто.

### 6.5 Forwards / проброс портов (`components/ForwardsPanel.tsx`)
Модалка `max-w-lg`. Открытие — из меню ⋮ карточки.
- Форма: `localhost:[порт] → [rhost]:[rport]` + кнопка **Запустить туннель** (`forward.open`).
- Список активных туннелей: `localhost:LP → RH:RP` + **Остановить** (корзина). Туннель живёт, пока
  открыто приложение.

### 6.6 Broadcast / мульти-exec (`components/BroadcastPanel.tsx`)
Модалка `h-[80vh] max-w-2xl`. Открытие — из палитры.
- **Команда:** textarea + кнопка **«сохранить»** (сниппет, через `window.prompt` имя).
  Чипы сохранённых сниппетов (клик — вставить, ×-удалить).
- **Хосты (N/M):** чекбоксы по устройствам с кредами и реальным IP (по умолчанию все выбраны).
- **Результат:** блок на каждый хост (зелёная/красная точка + stdout/ошибка в `<pre>`).
- Низ: счётчик хостов + кнопка **Выполнить** (`ssh.exec` параллельно на выбранных).

### 6.7 SSH / Tailscale import (`components/SshImportDialog.tsx`)
Одна модалка, два режима (`useUI.sshImport = 'ssh' | 'tailscale'`). Открытие — из палитры.
- Режим `ssh`: парсит `~/.ssh/config` (`FileDown`). Режим `tailscale`: `tailscale status --json` (`Radar`).
- Список найденных хостов с чекбоксами (`user@host:port · via proxyJump`), по умолчанию все.
- Кнопка **Добавить** → `sshconfig.import(chosen)` → массово создаёт устройства → «Добавлено: N».
- Пусто/ошибка: честные тексты («tailscale не залогинен», «config не найден»).

---

## §7. ПОЛНАЯ КАРТА КНОПОК (кнопка → где → действие → статус)

Статус: 🟢 работает · 🟡 частично/зависит от кредов · 🔴 заглушка (не подключено).

| Кнопка / контрол | Экран / панель | Действие | Статус |
|---|---|---|---|
| Nav-строки (6 вкладок) | Sidebar | `setView` | 🟢 |
| Quick search (инпут) | Sidebar | фильтр `useUI.search` | 🟡 (только Devices) |
| Профиль ⚙ (шестерёнка) | Sidebar footer | — | 🔴 нет экрана настроек |
| Create vault / Unlock | LockScreen | `initialize`/`unlock` | 🟢 |
| ↻ Refresh | Devices шапка | `refreshMetrics` (SSH-пробы) | 🟢 |
| ⚙ Group settings | Devices шапка | — | 🔴 |
| Add New Device | Insights рейл | `openCreate` | 🟢 |
| Quick Connect (инпут+Connect) | Insights рейл | — | 🔴 |
| Терминал (иконка) | ServerCard | `openTerminal` | 🟢 |
| ⋮ → Edit | ServerCard | `openEdit` | 🟢 |
| ⋮ → Файлы (SFTP) | ServerCard | `openSftp` | 🟢 |
| ⋮ → Проброс портов | ServerCard | `openForwards` | 🟢 |
| ⋮ → Delete | ServerCard | confirm + `remove` | 🟢 |
| Hoster Console (ссылка) | ServerCard | внешний браузер | 🟢 |
| Add/Save/Cancel | Device dialog | create/update | 🟢 |
| Пароль/SSH-ключ тумблер | Device dialog | выбор метода авторизации | 🟢 |
| Загрузить ключ из файла | Device dialog | читает файл в textarea | 🟢 |
| Определить по SSH | Device dialog | `probeHost` автозаполнение | 🟢 |
| Поиск (Enter) | Terminal | `findNext` | 🟢 |
| Доверять новому ключу | Terminal (баннер) | `forgetHostKey`+reconnect | 🟢 |
| ↑ / ↻ / Загрузить / Скачать / Удалить | SFTP | навигация + файлы | 🟢 |
| Запустить туннель / Остановить | Forwards | `forward.open/close` | 🟢 |
| Выполнить / сохранить сниппет / чекбоксы | Broadcast | `ssh.exec` + snippets | 🟢 |
| Добавить (import) | SSH/Tailscale import | `sshconfig.import` | 🟢 |
| Обновить (балансы) | Banks шапка | `wallets.refresh` | 🟢 |
| + Кошелёк / Добавить / Удалить | Banks | wallets CRUD | 🟢 |
| + Подписка / Добавить / Удалить | Subscriptions | subs CRUD | 🟢 |
| Open VNC (SSH tunnel) | Streaming | — (`disabled`, soon) | 🔴 |
| Весь экран | AI Accounts | только просмотр мока | 🔴 нет действий |
| ⌘K палитра (все команды) | глобально | навигация + действия | 🟢 |

---

## §8. Живое vs Мок vs Заглушка (ЧИТАЙ перед редизайном)

**🟢 Реально живое (данные из vault/SSH/RPC):**
- Vault lock/unlock/setup, keyring-детект.
- Devices: CRUD, SSH-терминал, SFTP, jump-host, порт-форвардинг, agentless-метрики + история,
  spend по хостерам, импорт ssh_config, Tailscale-discovery, broadcast, key auth, host-key TOFU.
- Banks: on-chain кошельки (CRUD + балансы через public RPC).
- Subscriptions: приложения-подписки (CRUD в vault) + инфра-косты из реальных устройств.

**🟡 Backend есть, UI не подключён (легко «оживить»):**
- **AI Accounts** — `ai:*` IPC + OpenRouter live-кредит + проверка ключей написаны, но экран и
  палитра, и плитка Dashboard используют `MOCK_AI`. Нужен UI: список из `api.ai.list()`, форма
  добавления (`api.ai.create`), кнопка проверки (`api.ai.check`), удаление.

**🔴 Заглушки / мок (нет бэкенда или не подключены):**
- Dashboard: «Net worth» и «AI accounts» — из мока, не из live-кошельков/аккаунтов.
- Insights «Quick Connect» (инпут + Connect) — мёртвый.
- Devices «Group settings» (⚙) — мёртвый.
- Sidebar «Settings» (⚙ профиля) — экрана настроек нет.
- Streaming — весь экран визуальный задел, кнопка VNC `disabled`.
- Banks — ручные холдинги (кэш/брокеридж) статичны из `MOCK_HOLDINGS`; T-Invest помечен `soon`.
- Sidebar-бейдж AI = захардкожено `4`.
- Command palette: группы Подписки/ИИ/Активы читают моки, не vault.

**Мок-файлы (браузер-превью fallback + текущие источники дохода моков):**
`data/mock.ts` (FALLBACK_DEVICES), `data/finance.ts` (MOCK_HOLDINGS + KIND_COLOR),
`data/ai.ts` (MOCK_AI), `data/subscriptions.ts` (MOCK_SUBSCRIPTIONS + категории + FX).

---

## §9. Система статусов и бейджей

**Статус устройства** (6 состояний, `ServerCard.STATUS`) — цвет + текст (colorblind-safe):
| Статус | Цвет | Подпись | Особое |
|---|---|---|---|
| online | accent `#22d3ee` | Online | кольцо-свечение |
| degraded | amber `#fbbf24` | Degraded | |
| reboot | sky `#38bdf8` | Rebooting | пульсация |
| offline | rose `#f43f5e` | Offline | |
| unknown | slate | Unknown | |
| maintenance | violet | Maintenance | |

**Source-бейджи** (что за данные): `live` (cyan) · `manual` (slate) · `soon` (amber).

---

## §10. Инварианты (редизайн НЕ должен ломать)

1. **Секреты только в main.** Renderer видит `DeviceDTO` без секретов (только `hasSecret: boolean`,
   `authType`). Пароли/ключи/API-ключи никогда не пересекают IPC обратно. Любой новый UI
   секрета = отправка на запись, не чтение.
2. **Один источник статуса — `useUI.view`** (не роутер). Новый экран = новый `ViewId` + ветка в
   `renderView` + пункт в Sidebar/палитре.
3. **Оверлеи — через `useUI`-флаги**, рендер из `App.tsx`. Не плоди локальные модалки в экранах
   (кроме тумблер-форм Banks/Subs, которые инлайновые).
4. **Честность лимитов.** `LimitNote` на вкладках с ограничениями (152-ФЗ, отсутствие API) —
   продуктовое решение, не убирать вслепую.
5. **Метрики-поллинг 90с** и `metrics.history` для спарклайнов — не ломать контракт `ServerCard`.
6. **tabular-nums** на всех числах; деньги — в родной валюте, тоталы — в USD.
7. Ров продукта: **«один объект — много граней»** (устройство = сервер+подписка+расход одновременно;
   в БД есть таблица `links`). Редизайн IA стоит вести в эту сторону, а не дробить на изоляты.

---

## §11. Дизайн-токены и текущая визуалка (что менять)

**Цвета** (`main.css` `@theme` + `design/tokens.json`):
| token | value | роль |
|---|---|---|
| `bg` | `#10141d` | фон приложения |
| `surface` | `#1a202c` | sidebar / рейлы / плашки |
| `card` | `#2d3748` | карточки, активная навигация |
| `card-hover` | `#353f50` | ховер |
| `border` | `#1e293b` | все хайрлайны |
| `accent` | `#22d3ee` | cyan — лого, иконки, прогресс, ссылки, primary CTA |
| `accent-hover` | `#1f96ab` | ховер акцента |
| текст | `slate-300` / `white` | body / заголовки |

Статус-цвета (в компонентах, не в токенах): amber `#fbbf24`, sky `#38bdf8`, rose `#f43f5e`,
violet, crypto `#a855f7`, brokerage/media `#22c55e`, dev `#f59e0b`.

**Типографика:** Inter Variable (fontsource). Заголовки semibold white; лейблы slate-400/500;
числа `tabular-nums`. **Радиусы:** карточки `rounded-xl`, контролы `rounded-lg`. **Тени:** hairline
border + мягкая тень. Скроллбары кастомные тёмные (`main.css`).

**Композиция:** 3 колонки (sidebar `w-64` · main flex · insights `w-[360px]` только Devices/xl).
Карточки серверов 1→2 колонки. Cyan — только акцент (CTA/прогресс/иконки/ссылки), не заливка.

**Мотив (`DESIGN.md`):** «premium-dark cockpit», ощущение Termius/Linear/Vercel — плотно, но дышит;
без градиентов (кроме аватара), без стекла/неона. QA-чеклист — в `DESIGN.md §6`.

**Что перерисовываешь → трогаешь:** токены в `main.css` `@theme` (Tailwind v4 генерит утилиты
`bg-bg`, `text-accent` и т.д.) + `design/tokens.json` (держать синхронно с DESIGN.md). Компоненты
используют семантические классы (`bg-card`, `border-border`, `text-accent`) — смена токена
перекрашивает всё разом.

---

## §12. Дыры в IA / что стоит добавить при редизайне

1. **Экран Settings** — его нет вообще, хотя 2 шестерёнки на него намекают. В SPEC заявлено «дерево
   настроек, 11 разделов». Кандидат на новый `ViewId`.
2. **Оживить AI Accounts** (§8) — бэкенд готов, нужен только UI.
3. **Recovery Kit** — в SPEC «обязателен на онбординге», экрана нет. Логично в setup-флоу LockScreen.
4. **Dashboard** — сделать реально live (net worth из кошельков, AI из аккаунтов) и, возможно,
   агрегатором граней «объект-грани», а не статичной сводкой.
5. **Quick Connect / Group settings / Streaming** — либо оживить, либо убрать (сейчас вводят в
   заблуждение).
6. **Spend-over-time** графики (в MASTER-PLAN Phase 3) — снапшоты метрик уже копятся, данные есть.
7. **Personal devices** (телефон/часы/наушники) и **полноценный Streaming** — в плане есть, экранов нет.

Полное продуктовое видение по каждой вкладке (все варианты реализации) — `docs/MASTER-PLAN.md §C`.
Залоченные решения владельца (7 раундов) — `docs/SPEC.md`.

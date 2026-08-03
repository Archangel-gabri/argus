export type Status = 'online' | 'degraded' | 'offline' | 'reboot' | 'unknown' | 'maintenance'
// ~20 популярных валют (нормализация в USD — статичные приблизит. курсы в vault.ts FX).
// ЕДИНЫЙ источник списка валют для всего приложения (дропдауны устройств/подписок, парсер ИИ).
export const CURRENCY_CODES = [
  'USD', 'EUR', 'RUB', 'GBP', 'CNY', 'JPY', 'CHF', 'CAD', 'AUD', 'INR',
  'BRL', 'KRW', 'TRY', 'PLN', 'UAH', 'KZT', 'AED', 'SEK', 'NOK', 'SGD'
] as const
export type Currency = (typeof CURRENCY_CODES)[number]
export type AuthType = 'password' | 'key' | 'none'
/** Класс сущности во Fleet: servers = server; network = router; остальное = personal. */
// Только то, чем Argus реально УМЕЕТ управлять по SSH, плюс «другое» для всего остального.
// Телефон, часы и наушники были в списке, но приложение с ними ничего не делает — карточка
// такого устройства открывалась пустой. Существующие записи переезжают в «другое» (см. migrate).
export type DeviceKind = 'server' | 'pc' | 'router' | 'other'

/** Доп. эндпоинт ОС для multi-boot ПК (одна железка, несколько ОС). Тот же ключ, что у основного.
 *  bootEntry — подсказка grub-menuentry для переключения (иначе матчим по имени ОС). */
export interface AltBoot {
  ip: string
  user: string
  os: string
  bootEntry?: string
  /** Свой порт SSH. Не задан — берётся порт основной записи.
   *  Две ОС на одной железке нередко слушают на разных портах: на Windows это отдельная
   *  служба OpenSSH со своей настройкой, и совпадать с Linux она не обязана. */
  port?: number
}

/** Full row as stored in the encrypted DB (includes secrets — main process only). */
export interface DeviceRow {
  id: string
  name: string
  provider: string
  role: string | null
  kind: DeviceKind
  ip: string
  port: number
  user: string
  country: string
  flag: string
  os: string
  status: Status
  cpu: number
  ram_used: number
  ram_total: number
  cost_amount: number
  cost_currency: Currency
  cost_usd: number
  console_url: string
  auth_type: AuthType
  secret_password: string | null
  secret_key: string | null
  secret_passphrase: string | null
  notes: string | null
  jump_id: string | null
  /** JSON AltBoot[] | null — доп. эндпоинты ОС (multi-boot ПК). */
  alt: string | null
  mac: string | null
  /** Портрет: ключ встроенного изображения либо data-URL своей картинки. */
  icon: string | null
  /** Загрузочная запись основной ОС (EFI-идентификатор или пункт меню загрузчика). */
  boot_entry: string | null
  /** Пароль учётки ОС для трансляции экрана (RDP/NLA) — отдельно от SSH-секрета.
   *  Опционально: старые строки колонки не имеют, INSERT его не заполняет. */
  screen_password?: string | null
  sort: number
  created_at: number
  updated_at: number
}

/** What the renderer is allowed to see — NO secret material ever crosses IPC. */
export interface DeviceDTO {
  id: string
  name: string
  provider: string
  role: string | null
  kind: DeviceKind
  ip: string
  port: number
  user: string
  country: string
  flag: string
  os: string
  status: Status
  cpu: number
  ram: { used: number; total: number }
  cost: { amount: number; currency: Currency; usd: number }
  consoleUrl: string
  authType: AuthType
  hasSecret: boolean
  notes: string | null
  jumpId: string | null
  /** Доп. эндпоинты ОС (multi-boot ПК) — без секретов, только адрес/юзер/ОС. Пусто = одна ОС. */
  altOs: AltBoot[]
  /** MAC для Wake-on-LAN («Включить» из выключенного). */
  mac: string | null
  /** Портрет: ключ встроенного изображения или data-URL своей картинки (выбор пользователя). */
  icon?: string | null
  /** Загрузочная запись основной ОС. */
  bootEntry?: string | null
  /** Когда состояние было снято в последний раз (мс). Есть = данные из кэша, можно показать «N мин назад». */
  lastSeen?: number | null
  /** CPU/RAM хотя бы раз были фактически измерены. false не равен измеренному 0. */
  metricsKnown?: boolean
  /** Последняя проверка статуса одновременно принесла метрики; false = ниже показан старый снимок. */
  metricsFresh?: boolean
  /** Сохранён ли пароль для трансляции экрана. Само значение через IPC НЕ ходит. */
  hasScreenSecret?: boolean
  /** Эфемерно (только в renderer-сторе, не из БД): какая ОС сейчас РЕАЛЬНО запущена (multi-boot). */
  runningOs?: string | null
  /** Эфемерно: диск % занято и аптайм (сек) из последней пробы. */
  disk?: number | null
  uptime?: number | null
  /** Эфемерная v2-сводка (только renderer-стор): чипы обзора/карточки. rate — байт/с. */
  load1?: number | null
  netRx?: number | null
  netTx?: number | null
  swapUsed?: number | null
  swapTotal?: number | null
  tempCpu?: number | null
}

/** Renderer → main payload for create/update. May carry a secret to STORE (never to read back). */
export interface DeviceInput {
  name: string
  provider: string
  role?: string | null
  kind?: DeviceKind
  ip?: string
  port?: number
  user?: string
  country?: string
  flag?: string
  os?: string
  status?: Status
  cpu?: number
  ram?: { used: number; total: number }
  cost?: { amount: number; currency: Currency; usd: number }
  consoleUrl?: string
  authType?: AuthType
  password?: string | null
  /** PEM/OpenSSH private key to STORE (encrypted). Never read back to the renderer. */
  privateKey?: string | null
  /** Passphrase protecting the private key, if any. Stored encrypted alongside it. */
  passphrase?: string | null
  notes?: string | null
  jumpId?: string | null
  altOs?: AltBoot[]
  mac?: string | null
  /** Портрет устройства: ключ встроенного изображения или data-URL своей картинки. */
  icon?: string | null
  /** Загрузочная запись основной ОС — чем выбрать её при переключении систем. */
  bootEntry?: string | null
}

export interface Snippet {
  id: string
  name: string
  command: string
}

export interface Subscription {
  id: string
  name: string
  provider: string
  category: string
  amount: number
  currency: Currency
  period: 'mo' | 'yr'
  nextRenewal: string | null
  notes: string | null
  /** true — платёж надо продлить руками; false — есть автосписание. */
  manualRenewal: boolean
}

export interface SubscriptionInput {
  name: string
  provider?: string
  category?: string
  amount: number
  currency?: Currency
  period?: 'mo' | 'yr'
  nextRenewal?: string | null
  notes?: string | null
  manualRenewal?: boolean
}

export interface Wallet {
  id: string
  chain: string
  address: string
  label: string
}
export interface WalletInput {
  chain: string
  address: string
  label?: string
}
export interface WalletBalance {
  /** ok — баланс и USD доказаны; partial — баланс есть, цены нет; error — баланс неизвестен. */
  status: 'ok' | 'partial' | 'error'
  native: number | null
  symbol: string
  usd: number | null
  error?: string
  updatedAt: number
}

export interface MetricSnapshot {
  ts: number
  cpu: number | null
  ramUsed: number | null
  ramTotal: number | null
  disk: number | null
  status: string
}

// ── Богатые live-метрики (AIDA-вкладка). Rate-поля (net/disk) — байт/с из дельты двух сэмплов. ──
export interface GpuInfo {
  util: number
  temp: number
  memUsed: number // GB
  memTotal: number // GB
  power?: number // Вт
}
export interface MountInfo {
  mount: string
  usedPct: number
  usedGb: number
  totalGb: number
}
export interface ProcInfo {
  cmd: string
  cpu: number
  mem: number
}
/** Полный live-снимок для вкладки «Метрики». Optional-поля отсутствуют, если утилиты/датчика нет. */
export interface LiveMetrics {
  cpu: number
  cores: number[]
  load: [number, number, number]
  ramUsed: number // GB
  ramTotal: number // GB
  cacheGb: number
  swapUsed: number // GB
  swapTotal: number // GB
  netRx: number // байт/с
  netTx: number // байт/с
  diskR: number // байт/с
  diskW: number // байт/с
  /** false = платформа/счётчик не поддерживает замер; diskR=0 тогда не является измерением. */
  diskIoAvailable?: boolean
  disk?: number // % корня
  uptime?: number // сек
  tempCpu?: number // °C
  gpu?: GpuInfo
  mounts: MountInfo[]
  top: ProcInfo[]
}

/** Результат операции питания (двухфазный вердикт: принято → проверено).
 *  phase: accepted = команда ушла (для reboot); verified = машина реально погасла/уснула;
 *  unreachable = до хоста не доехали, команда НЕ выполнялась (не путать с rejected);
 *  rejected = хост отклонил (inhibitor/polkit/нет прав) — error несёт реальный stderr;
 *  still-up = команда ушла, но хост всё ещё отвечает; no-endpoint = не в сети. */
/** Что именно делаем с машиной. Список закрытый: всё остальное — ошибка, а не «наверное, ребут». */
export type PowerAction = 'reboot' | 'poweroff' | 'suspend'

export interface PowerResult {
  ok: boolean
  os: string
  phase: 'accepted' | 'verified' | 'rejected' | 'still-up' | 'no-endpoint' | 'unreachable'
  output?: string
  error?: string
}

/** Пред-полётная диагностика питания (почему «не выключается»). */
export interface PowerDiag {
  ok: boolean
  os: string
  text: string
}

/**
 * Тип AI-доступа. Раньше запись была «ключ провайдера», и всё, что ключом не является,
 * в неё не помещалось: подписка без ключа (Claude Max), чужие модели с наценкой (роутер),
 * локальная Ollama, бесплатный tier, который ещё не оформлен.
 */
export type AiKind = 'subscription' | 'api' | 'router' | 'free-tier' | 'local' | 'cli-agent'

/** Состояние доступа. `planned` — «доступно, но ещё не взято»: реестр служит и списком дел. */
export type AiStatus = 'active' | 'paused' | 'expired' | 'planned'

/** Чем платим. Из РФ это не формальность: картой платится не всё. */
export type AiPayment = 'card' | 'crypto' | 'reseller' | 'free'

/** Известные ограничения доступа. Всё необязательное: чего не знаем — не выдумываем. */
export interface AiLimits {
  /** Запросов в минуту / в день. */
  rpm?: number | null
  rpd?: number | null
  /** Токенов в минуту / в месяц. */
  tpm?: number | null
  tpmo?: number | null
  /** Окно лимита подписки: длительность в часах и наблюдаемый потолок (задаётся владельцем). */
  windowHours?: number | null
  /** Сколько токенов, по наблюдениям владельца, влезает в окно. Argus этого знать не может. */
  windowTokens?: number | null
  /** Недельный потолок — у подписок он идёт вторым слоем поверх окна сессии. */
  weekTokens?: number | null
  /** Сообщений в окне — как их считает провайдер. */
  windowMessages?: number | null
}

/**
 * Отдельный аккаунт внутри доступа.
 *
 * У одного провайдера их бывает несколько (у владельца шесть почт в OpenAI), и они различаются
 * тарифом: где-то Plus, где-то free. Строка «6 аккаунтов» этого не сообщает — а именно это и
 * нужно знать, когда ищешь, на какой почте лежит платная подписка.
 */
export interface AiAccountEntry {
  /** Почта или логин. */
  email: string
  /** Тариф именно этого аккаунта: «Plus», «free», «Max 5x». */
  plan?: string
  /** Пометка: для чего заведён, чем отличается. */
  note?: string
  /** Основной — с него работают по умолчанию. */
  primary?: boolean
}

export interface AiAccess {
  id: string
  kind: AiKind
  provider: string
  label: string
  /** На каком аккаунте/почте куплено (основной). */
  account: string
  /** Остальные аккаунты того же провайдера — каждый со своим тарифом. */
  accounts: AiAccountEntry[]
  plan: string
  status: AiStatus
  /** Ссылка на строку в subscriptions — деньги живут только там. */
  subscriptionId: string | null
  hasKey: boolean
  /** Где ещё лежит значение ключа: `secrets/env/api-keys.env → OPENROUTER_API_KEY`, KWallet. */
  keyRef: string | null
  /** Дата истечения ключа/токена (ISO yyyy-mm-dd). */
  keyExpiresAt: string | null
  baseUrl: string | null
  payment: AiPayment
  /** Трафик идёт через чужой прокси (router neutrino) — это надо видеть, а не подразумевать. */
  thirdParty: boolean
  /** Какие инструменты читают этот доступ. */
  usedBy: string[]
  /** Чем заменить, если доступ умрёт. */
  fallbackId: string | null
  limits: AiLimits
  notes: string | null
  /** Когда доступ завели (мс). По нему видно, что «возьму потом» висит уже месяц. */
  createdAt: number
}

export interface AiAccessInput {
  kind?: AiKind
  provider: string
  label?: string
  account?: string
  accounts?: AiAccountEntry[]
  plan?: string
  status?: AiStatus
  subscriptionId?: string | null
  apiKey?: string
  keyRef?: string | null
  keyExpiresAt?: string | null
  baseUrl?: string | null
  payment?: AiPayment
  thirdParty?: boolean
  usedBy?: string[]
  fallbackId?: string | null
  limits?: AiLimits
  notes?: string | null
}

export interface AiCheck {
  status: 'valid' | 'invalid' | 'quota' | 'error' | 'nokey'
  remaining?: number | null
  usage?: number | null
  detail?: string
}

/**
 * Цена модели. Четыре ставки раздельно — одна «цена за токен» врёт в разы там, где основную
 * долю трафика составляет чтение кэша (а у агентных сессий это норма). Часовой кэш дороже
 * пятиминутного, поэтому у него своя ставка.
 *
 * Все цены — доллары за ОДИН токен, как в таблице LiteLLM. Умножение на миллион делает интерфейс.
 */
export interface AiPrice {
  provider: string
  model: string
  input: number | null
  output: number | null
  cacheWrite: number | null
  cacheWrite1h: number | null
  cacheRead: number | null
  contextTokens: number | null
  maxOutputTokens: number | null
  /** chat · embedding · image_generation … — из каталога. */
  mode: string | null
  supportsVision: boolean
  supportsTools: boolean
  supportsCaching: boolean
  /** Дата вывода модели из обращения, если объявлена. */
  deprecatedAt: string | null
  /** Откуда цена: вшитый каталог, живой ответ роутера или рука владельца. */
  source: 'catalog' | 'openrouter' | 'manual'
  fetchedAt: number
}

/** Привязка модели к доступу: что реально доступно через него и по какой цене. */
export interface AiAccessModel {
  accessId: string
  model: string
  /** Владелец отметил, что реально этим пользуется. */
  favorite: boolean
  /** Наценка реселлера/роутера в процентах поверх каталожной цены. */
  markupPct: number | null
  /** Полная замена цены (доллары за токен). Побеждает и каталог, и наценку. */
  priceInput: number | null
  priceOutput: number | null
  notes: string | null
}

/** Сколько токенов и денег ушло за день по одной модели одного источника. */
export interface AiUsageDay {
  /** yyyy-mm-dd по местному времени: расход смотрят по своим суткам, не по UTC. */
  date: string
  /** Откуда данные: claude-code · codex · openrouter. */
  source: string
  model: string
  input: number
  output: number
  cacheWrite: number
  cacheWrite1h: number
  cacheRead: number
  requests: number
  /** Доллары по ставкам каталога. Для подписки это ЭКВИВАЛЕНТ, а не потраченные деньги. */
  costUsd: number
}

/**
 * Окно лимита подписки: провайдер отмеряет квоту не сутками, а «сессиями» по несколько часов,
 * причём отсчёт идёт с первого обращения. Хранится по источнику логов.
 */
export interface AiUsageBlock {
  source: string
  startTs: number
  endTs: number
  tokens: number
  costUsd: number
  requests: number
}

/** Итог по источнику за период — то, что показывает экран. */
export interface AiUsageSummary {
  days: AiUsageDay[]
  /** Окна лимита по источникам — для полосы «текущая сессия». */
  blocks: AiUsageBlock[]
  /** Когда последний раз читали логи. */
  collectedAt: number | null
  /** Сколько файлов просмотрено и сколько записей учтено в последнем проходе. */
  scannedFiles: number
  /** Строки логов, которые не удалось разобрать: молчать о них нечестно. */
  skipped: number
}

export interface DiskInfo {
  name: string
  model?: string
  sizeGb: number
  ssd: boolean
}
/** Нормализованная сводка комплектующих (agentless-инвентарь, кэшируется — железо меняется редко). */
export interface HardwareInfo {
  os?: string
  kernel?: string
  arch?: string
  virt?: string
  hostname?: string
  cpuModel?: string
  cpuCores?: number
  cpuThreads?: number
  cpuMhzMax?: number
  ramGb?: number
  dimms?: string[]
  board?: string
  gpus?: string[]
  gpuDriver?: string
  disks?: DiskInfo[]
  nics?: string[]
  collectedAt?: number
}

/** Пред-полётная готовность ПК к скринерингу (Этап 4): что за ОС/сессия, есть ли аппаратный
 *  энкодер, тип захвата, установлен ли агент. Питает вкладку «Экран» + выбор бэкенда. */
export interface ScreenPreflight {
  ok: boolean
  os: 'windows' | 'linux' | 'off' | 'unknown'
  sessionType?: 'wayland' | 'x11' | 'windows' | 'headless'
  gpu?: string
  nvenc?: boolean
  vaapi?: boolean
  agentInstalled?: boolean
  /** Рекомендованный бэкенд захвата/энкода для этой машины. */
  backend?: 'nvenc' | 'vaapi' | 'software' | 'unknown'
  warnings: string[]
  error?: string
}

export type VaultStatus = 'uninitialized' | 'locked' | 'unlocked'

export interface VaultState {
  status: VaultStatus
  /** OS keyring backend reported by safeStorage (e.g. 'kwallet', 'basic_text'). */
  keyringBackend: string
  /** True when safeStorage encryption is trustworthy (not the plaintext fallback). */
  canRemember: boolean
}
